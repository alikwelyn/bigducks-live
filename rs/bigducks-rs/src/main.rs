//! bigducks-rs
//!
//! Dois papeis no mesmo binario:
//!   1. motor de captura + hub de sinalizacao P2P (o app de bandeja no Windows)
//!   2. relay de sinalizacao (`--relay`, roda num servidor Linux/Dokploy)
//!
//! Rotas do motor:
//!   GET  /            painel de teste no navegador
//!   GET  /ws          frames RGBA crus (captura do proprio exe)
//!   GET  /hub         hub de sinalizacao (o bridge do Discord conecta aqui)
//!   GET  /hub/<sala>  relay por sala (segredo validado)
//!   GET  /bridge.js   o bridge completo (media bridge + camada P2P)
//!
//! Rotas do relay (auto-update):
//!   GET  /release.json        manifest da ultima versao
//!   GET  /bigducks-rs.exe     o executavel novo
//!
//! Sem `--console` o exe e' buildado com `windows_subsystem = "windows"` (nenhum
//! terminal) e TODO o diagnostico vai para `%LOCALAPPDATA%\DiscordStream\engine.log`.

#![cfg_attr(windows, windows_subsystem = "windows")]

mod capture;
mod install;
mod logging;
mod status;

#[cfg(windows)]
mod autostart;
#[cfg(windows)]
mod discord;
#[cfg(windows)]
mod icon;
#[cfg(windows)]
mod platform;
#[cfg(windows)]
mod tray;
#[cfg(windows)]
mod update;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path as AxumPath, Query, State,
    },
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use tokio::sync::broadcast;

use capture::{parse_selection, Capturer, Selection};

static NEXT_HUB_ID: AtomicU64 = AtomicU64::new(1);

/// Config embutida: e' o que permite mandar SO o .exe pro amigo. Na primeira
/// execucao o motor escreve `remote-hub.txt` no diretorio de dados com isto, e o
/// preload passa a conectar o relay.
const DEFAULT_RELAY: &str = "wss://desjanjador.skillup.com.br/hub";
/// Troque por um valor seu: o relay so aceita quem apresentar o mesmo segredo.
const DEFAULT_SECRET: &str = "troque-este-segredo-por-um-seu";
/// Sala fixa (linha 2 do remote-hub.txt): o relay funciona mesmo sem a store do
/// canal de voz (o caso conhecido). O grupo inteiro usa a mesma - e se o
/// renderer achar o canal de voz, a sala dinamica dele tem prioridade.
const DEFAULT_ROOM: &str = "bigducks";
/// Nome do executavel no manifesto de release.
const RELEASE_ASSET: &str = "bigducks-rs.exe";

/// O bridge do renderer servido pelo exe (o mesmo arquivo vai embutido no
/// instalador, que o coloca em DiscordStream/bigducks_rs_renderer.js).
const BRIDGE_JS: &str = include_str!("../web/renderer.js");

/// Plugins opcionais (bypass de Nitro etc). So e servido com `--nitro`: e patch
/// de cliente, entao fica isolado do bridge de video, que e estavel.
const PLUGINS_JS: &str = include_str!("../web/plugins.js");

struct Frame {
    width: u32,
    height: u32,
    timestamp_us: u64,
    data: Vec<u8>,
}

struct HubMessage {
    from: u64,
    text: String,
    /// Sala (id do canal de voz). Vazio = entrega pra todos (uso local).
    room: String,
}

/// Resolucao/fps/bitrate da live. O painel de qualidade do Discord manda nisso
/// (via preload), entao muda ao vivo - sem reiniciar nada.
#[derive(Clone, Copy)]
struct Settings {
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 720,
            fps: 20,
            bitrate: 12_000_000,
        }
    }
}

#[derive(Clone)]
struct AppState {
    frames: broadcast::Sender<Arc<Frame>>,
    hub: broadcast::Sender<Arc<HubMessage>>,
    settings: Arc<Mutex<Settings>>,
    capture_started: Arc<AtomicBool>,
    selection: Arc<Mutex<Selection>>,
    nitro: bool,
    // Teto de captura. O painel do Discord agora libera 1440p (e pede 4K em
    // algumas builds) - sem teto, a captura xcap + o downscale ficam em ~14 MB
    // por frame. O fps ja e' limitado em /settings; isto limita a resolucao,
    // proporcionalmente (nao distorce).
    max_width: u32,
    max_height: u32,
    /// Modo relay: sem captura, so sinalizacao, e exige o segredo.
    relay: bool,
    secret: String,
    /// Estado compartilhado com a bandeja/auto-update (so' usado no desktop).
    status: status::Shared,
    /// Diretorio de onde o relay serve o manifest e o exe (auto-update).
    release_dir: PathBuf,
}

// --------------------------------------------------------------------- args --

struct Args {
    width: u32,
    height: u32,
    fps: u32,
    port: u16,
    max_width: u32,
    max_height: u32,
    install_only: bool,
    uninstall: bool,
    nitro: bool,
    relay: bool,
    console: bool,
    no_install: bool,
    no_update: bool,
    release_dir: PathBuf,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 720,
            fps: 30,
            port: 8791,
            max_width: 1920,
            max_height: 1080,
            install_only: false,
            uninstall: false,
            nitro: true,
            relay: false,
            console: false,
            no_install: false,
            no_update: false,
            release_dir: default_release_dir(),
        }
    }
}

fn default_release_dir() -> PathBuf {
    std::env::var("BIGDUCKS_RELEASE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("releases"))
}

impl Args {
    fn parse() -> Self {
        let mut args = Args::default();
        let argv: Vec<String> = std::env::args().collect();
        let mut i = 1;
        while i < argv.len() {
            let take = |index: usize| argv.get(index).cloned();
            match argv[i].as_str() {
                "--width" => {
                    if let Some(value) = take(i + 1).and_then(|v| v.parse().ok()) {
                        args.width = value;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                "--height" => {
                    if let Some(value) = take(i + 1).and_then(|v| v.parse().ok()) {
                        args.height = value;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                "--fps" => {
                    if let Some(value) = take(i + 1).and_then(|v| v.parse().ok()) {
                        args.fps = value;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                "--port" => {
                    if let Some(value) = take(i + 1).and_then(|v| v.parse().ok()) {
                        args.port = value;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                "--max-width" => {
                    if let Some(value) = take(i + 1).and_then(|v| v.parse().ok()) {
                        args.max_width = value;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                "--max-height" => {
                    if let Some(value) = take(i + 1).and_then(|v| v.parse().ok()) {
                        args.max_height = value;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                "--release-dir" => {
                    if let Some(value) = take(i + 1) {
                        args.release_dir = PathBuf::from(value);
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                "--install" => {
                    args.install_only = true;
                    i += 1;
                }
                "--uninstall" => {
                    args.uninstall = true;
                    i += 1;
                }
                "--nitro" => {
                    args.nitro = true;
                    i += 1;
                }
                // Desliga so os patches de UI/qualidade. O bridge de video continua.
                "--no-nitro" => {
                    args.nitro = false;
                    i += 1;
                }
                // Modo RELAY: so sinalizacao. Escuta em 0.0.0.0 e nao captura nada.
                "--relay" => {
                    args.relay = true;
                    i += 1;
                }
                // Nao mexe no app.asar (dev/teste): util para subir a bandeja sem
                // alterar o Discord da maquina.
                "--no-install" => {
                    args.no_install = true;
                    i += 1;
                }
                // Desliga o auto-update (dev/teste).
                "--no-update" => {
                    args.no_update = true;
                    i += 1;
                }
                // Console de diagnostico (AttachConsole/AllocConsole).
                "--console" => {
                    args.console = true;
                    i += 1;
                }
                // Marcador colocado pelo autostart; sem efeito proprio.
                "--startup" => i += 1,
                other => {
                    logging::write_line(&format!("ignoring unknown argument: {other}"));
                    i += 1;
                }
            }
        }
        if args.fps == 0 {
            args.fps = 15;
        }
        args
    }
}

// --------------------------------------------------------------------- main --

fn main() {
    let args = Args::parse();

    #[cfg(windows)]
    if args.console {
        platform::attach_console();
    }

    logging::init(args.console);
    logging::write_line(&format!(
        "bigducks-rs {} iniciando (pid {}) | log: {}",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
        logging::log_path().display()
    ));

    if let Err(error) = run(args) {
        logging::write_line(&format!("WARN [ERRO] {error:#}"));
        std::process::exit(1);
    }
}

fn run(args: Args) -> anyhow::Result<()> {
    if args.uninstall {
        for line in install::uninstall()? {
            logging::write_line(&format!("uninstall: {line}"));
        }
        return Ok(());
    }

    let report = if args.no_install {
        None
    } else {
        match install::install() {
            Ok(report) => {
                for line in &report.lines {
                    logging::write_line(&format!("inject: {line}"));
                }
                if !report.flavours.is_empty() {
                    logging::write_line(&format!(
                        "inject: bridge presente em {}",
                        report.flavours.join(", ")
                    ));
                }
                Some(report)
            }
            Err(error) => {
                logging::write_line(&format!("WARN inject failed: {error:#}"));
                None
            }
        }
    };
    if args.install_only {
        return Ok(());
    }

    if args.relay {
        let state = build_state(&args, true);
        return relay_serve(state, args.port);
    }

    #[cfg(windows)]
    {
        desktop_main(args, report);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (args, report);
        anyhow::bail!("o modo desktop so' existe no Windows; use --relay neste servidor")
    }
}

/// Config embutida -> arquivo que o preload le. Assim basta mandar o .exe:
/// ele instala o bridge e escreve isto na primeira execucao.
fn configure_relay_file() {
    let dir = install::data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("remote-hub.txt");
    if !file.exists() {
        let _ = std::fs::write(
            &file,
            format!("{DEFAULT_RELAY} {DEFAULT_SECRET}\n{DEFAULT_ROOM}\n"),
        );
        logging::write_line(&format!(
            "relay configurado: {DEFAULT_RELAY} (sala fixa '{DEFAULT_ROOM}' - o canal de voz tem prioridade quando e achado)"
        ));
    } else {
        // Arquivo antigo (uma linha so): acrescenta a sala fixa, uma vez.
        let contents = std::fs::read_to_string(&file).unwrap_or_default();
        if contents.lines().count() < 2 {
            let trimmed = contents.trim_end();
            let separator = if trimmed.ends_with('\n') { "" } else { "\n" };
            let _ = std::fs::write(&file, format!("{trimmed}{separator}{DEFAULT_ROOM}\n"));
        }
    }
}

fn build_state(args: &Args, relay: bool) -> AppState {
    if !relay {
        configure_relay_file();
    }
    let (tx, _rx) = broadcast::channel::<Arc<Frame>>(2);
    let (hub_tx, _hub_rx) = broadcast::channel::<Arc<HubMessage>>(512);
    AppState {
        frames: tx,
        hub: hub_tx,
        settings: Arc::new(Mutex::new(Settings {
            width: args.width,
            height: args.height,
            fps: args.fps,
            bitrate: 12_000_000,
        })),
        capture_started: Arc::new(AtomicBool::new(false)),
        selection: Arc::new(Mutex::new(Selection::default())),
        nitro: args.nitro,
        max_width: args.max_width,
        max_height: args.max_height,
        relay,
        secret: DEFAULT_SECRET.to_string(),
        status: status::shared(),
        release_dir: args.release_dir.clone(),
    }
}

fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(page))
        .route("/ws", get(ws_handler))
        .route("/hub", get(hub_handler))
        .route("/hub/{room}", get(hub_room_handler))
        .route("/bridge.js", get(bridge_js))
        .route("/plugins.js", get(plugins_js))
        .route("/test-publish", get(test_publish))
        .route("/source", get(set_source))
        .route("/settings", get(set_settings))
        .route("/bridge-event", get(bridge_event))
        // Auto-update: o usuario so' joga o exe novo (e opcionalmente o
        // release.json ou version.txt) no diretorio apontado por --release-dir.
        .route("/release.json", get(release_manifest))
        .route("/bigducks-rs.exe", get(release_asset))
        .route("/release/{file}", get(release_file))
        .with_state(state)
}

/// Relay: servidor de sinalizacao puro (Linux/Dokploy). Bloqueia.
fn relay_serve(state: AppState, port: u16) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async move {
        let app = router(state);
        let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
        logging::write_line(&format!("bigducks-rs RELAY (so sinalizacao) em 0.0.0.0:{port}"));
        logging::write_line(&format!(
            "  hub P2P:   ws://SEU_HOST:{port}/hub      <- os motores conectam aqui"
        ));
        logging::write_line("  nada de video/audio passa por aqui: so offer/answer/ice (alguns KB)");
        logging::write_line(&format!(
            "  update:    https://SEU_HOST/release.json + /{RELEASE_ASSET} (dir: {})",
            std::env::var("BIGDUCKS_RELEASE_DIR").unwrap_or_else(|_| "releases".into())
        ));
        axum::serve(listener, app).await?;
        Ok::<(), anyhow::Error>(())
    })
}

/// App de bandeja no Windows: servidor em threads do runtime + tray na main.
#[cfg(windows)]
fn desktop_main(args: Args, report: Option<install::InstallReport>) {
    let port = args.port;
    let state = build_state(&args, false);

    if let Some(report) = &report {
        if let Ok(mut status) = state.status.lock() {
            status.bridge_installed = report.installed;
        }
    }

    // Autostart ligado ja na primeira execucao (sem admin). Tambem garante a
    // ORDEM: com ele, o asar e' reescrito antes do Discord ler.
    let autostart_on = autostart::ensure_enabled_first_run();
    if let Ok(mut status) = state.status.lock() {
        status.autostart = autostart_on;
    }
    logging::write_line(&format!("autostart (HKCU Run): {}", if autostart_on { "ligado" } else { "desligado" }));

    // Runtime tokio vive nas threads de trabalho; a main so' bombeia mensagens.
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            logging::write_line(&format!("WARN nao consegui criar o runtime: {error}"));
            return;
        }
    };

    let server_state = state.clone();
    runtime.spawn(async move {
        let app = router(server_state);
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => {
                logging::write_line(&format!("bigducks-rs ouvindo em http://127.0.0.1:{port}/"));
                logging::write_line(&format!("  painel:    http://127.0.0.1:{port}/"));
                logging::write_line(&format!("  captura:   ws://127.0.0.1:{port}/ws"));
                logging::write_line(&format!("  hub P2P:   ws://127.0.0.1:{port}/hub"));
                if let Err(error) = axum::serve(listener, app).await {
                    logging::write_line(&format!("WARN servidor parou: {error}"));
                }
            }
            Err(error) => {
                logging::write_line(&format!(
                    "WARN nao consegui abrir a porta {port}: {error} (ja existe outro motor rodando?)"
                ));
            }
        }
    });

    // Se a injecao MUDOU nesta execucao e o Discord ja esta aberto, ele so' vai
    // ler o asar quando reiniciar: fecha com educacao e reabre os mesmos exes.
    if let Some(report) = report {
        if report.changed && discord::is_running() {
            logging::write_line("injecao mudou e o Discord esta aberto: reiniciando para aplicar");
            if let Ok(mut status) = state.status.lock() {
                status.notify(
                    "Aplicando o bridge no Discord",
                    "O Discord vai reiniciar para carregar a injecao.",
                );
            }
            let status = state.status.clone();
            std::thread::spawn(move || match discord::restart() {
                Ok(lines) => {
                    for line in lines {
                        logging::write_line(&format!("reiniciar-discord: {line}"));
                    }
                    if let Ok(mut status) = status.lock() {
                        status.notify("Discord reiniciado", "A injecao ja esta ativa.");
                    }
                }
                Err(error) => {
                    logging::write_line(&format!("WARN reiniciar Discord falhou: {error:#}"));
                    if let Ok(mut status) = status.lock() {
                        status.notify("Falha ao reiniciar o Discord", &format!("{error:#}"));
                    }
                }
            });
        }
    }

    // Auto-update: limpa o `.old` da rodada anterior e checa em background.
    update::cleanup_old();
    if !args.no_update {
        update::spawn_checker(state.status.clone());
    } else {
        logging::write_line("auto-update desligado (--no-update)");
    }

    // Bandeja na thread principal; bloqueia ate' "Sair".
    tray::run(port, state.status.clone());
    logging::write_line("bandeja encerrada");
    std::process::exit(0);
}

// ---------------------------------------------------------------- handlers --

async fn page(State(state): State<AppState>) -> impl IntoResponse {
    // RELAY: pagina de status simples - o painel de canvas so existe no motor.
    // Abrir o painel do relay disparava o /ws e o loop de captura morria a
    // 60fps dentro do container (sem display nenhum) - era o "capture failed:
    // Connection closed" em loop nos logs do Dokploy.
    if state.relay {
        return Html(
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>bigducks relay</title></head><body style=\"font:14px system-ui;background:#0b0b0b;color:#57f287;padding:40px\">RELAY de sinalizacao ativo. Nenhuma midia passa por aqui.</body></html>",
        ).into_response();
    }
    Html(PAGE).into_response()
}

async fn bridge_js() -> impl IntoResponse {
    (
        [("content-type", "application/javascript; charset=utf-8")],
        BRIDGE_JS,
    )
}

/// Plugins de UI/qualidade: vem LIGADOS por padrao (quem recebe so o .exe nao
/// tem como passar flag). `--no-nitro` responde 404 e o renderer nao carrega
/// nada - o bridge de video segue sem nenhum patch extra.
async fn plugins_js(State(state): State<AppState>) -> axum::response::Response {
    if state.nitro {
        (
            [("content-type", "application/javascript; charset=utf-8")],
            PLUGINS_JS,
        )
            .into_response()
    } else {
        (StatusCode::NOT_FOUND, "plugins off").into_response()
    }
}

/// Comando de teste: manda um dos bridges publicar um stream de teste (canvas)
/// e o outro assistir. Serve para validar o P2P de ponta a ponta sem clique.
///   GET /test-publish?publisher=<id-do-hub>
/// O id aparece no log do motor como `hub: peer N conectado`.
async fn test_publish(State(state): State<AppState>, Query(query): Query<TestPublishQuery>) -> String {
    let publisher = query.publisher.unwrap_or_else(|| "1".to_string());
    let message = format!("{{\"type\":\"test-publish\",\"publisher\":\"{publisher}\"}}");
    let _ = state.hub.send(Arc::new(HubMessage {
        from: 0,
        text: message,
        room: String::new(),
    }));
    format!("test-publish enviado (publisher={publisher})")
}

/// O bridge manda aqui o `sourceId` escolhido no modal do Discord
/// (`screen:0:1`, `window:123456`). A captura passa a usar essa fonte.
async fn set_source(State(state): State<AppState>, Query(query): Query<SourceQuery>) -> impl IntoResponse {
    let mut headers = HeaderMap::new();
    headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    // Janela vem como PID; tela vem como sourceId.
    if let Some(pid) = query.pid.as_deref().and_then(|v| v.parse::<u32>().ok()) {
        if let Ok(mut guard) = state.selection.lock() {
            *guard = Selection::Process(pid);
        }
        logging::write_line(&format!("fonte selecionada: processo {pid}"));
        return (headers, format!("ok: Process({pid})"));
    }
    let value = query.value.unwrap_or_default();
    let message = match parse_selection(&value) {
        Some(selection) => {
            if let Ok(mut guard) = state.selection.lock() {
                *guard = selection.clone();
            }
            logging::write_line(&format!("source selecionada: {value} -> {selection:?}"));
            format!("ok: {selection:?}")
        }
        None => format!("ignorado: {value}"),
    };
    (headers, message)
}

#[derive(serde::Deserialize)]
struct SourceQuery {
    value: Option<String>,
    pid: Option<String>,
}

/// O preload reporta aqui o que ele ve - inclusive a fonte escolhida no modal do
/// Discord. Assim tudo aparece no log do motor.
///
/// stream-start/stream-stop sao o CICLO DE VIDA da live sem a store: o preload
/// ve a fonte escolhida e o reset, e aqui a mensagem vira broadcast no hub -
/// o renderer da janela certa (data = pid) publica/para o P2P.
async fn bridge_event(
    State(state): State<AppState>,
    Query(query): Query<EventQuery>,
) -> impl IntoResponse {
    let name = query.name.unwrap_or_default();
    let data = query.data.unwrap_or_default();
    if matches!(name.as_str(), "stream-start" | "stream-stop") && !data.is_empty() {
        let message = format!("{{\"type\":\"{name}\",\"data\":\"{data}\"}}");
        let _ = state.hub.send(Arc::new(HubMessage {
            from: 0,
            text: message,
            room: String::new(),
        }));
    }
    update_status(&state, &name, &data);
    logging::write_line(&format!("preload: {name} {data}"));
    (
        [(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "ok",
    )
}

/// Traduz o que o preload reporta no estado que a bandeja mostra.
fn update_status(state: &AppState, name: &str, data: &str) {
    let Ok(mut status) = state.status.lock() else {
        return;
    };
    match name {
        "hook" | "engine-decorado" | "hook-erro" | "plugins-ok" => status.bridge_loaded = true,
        "hub-remoto" => {
            if data.contains("remoto conectado") || data.contains("welcome recebido") {
                status.relay = status::Relay::Connected;
            } else if data.contains("sem canal de voz") {
                status.relay = status::Relay::NoVoice;
            } else if data.contains("local conectado") {
                if matches!(status.relay, status::Relay::Unknown) {
                    status.relay = status::Relay::Local;
                }
            }
        }
        "stream-start" => status.streaming = true,
        "stream-stop" => status.streaming = false,
        _ => {}
    }
    if !data.is_empty() {
        status.detail = format!("{name}: {data}");
    }
}

#[derive(serde::Deserialize)]
struct EventQuery {
    name: Option<String>,
    data: Option<String>,
}

#[derive(serde::Deserialize)]
struct SettingsQuery {
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<u32>,
    bitrate: Option<u32>,
}

/// O painel de qualidade do Discord cai aqui: o preload le o que o cliente
/// manda (resolucao/fps/bitrate) e repassa. A captura muda ao vivo; o bitrate
/// vai pro renderer pelo hub, que e quem tem a conexao WebRTC.
async fn set_settings(
    State(state): State<AppState>,
    Query(query): Query<SettingsQuery>,
) -> impl IntoResponse {
    let mut headers = HeaderMap::new();
    headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));

    let mut current = Settings::default();
    let mut changed = false;
    let mut bitrate_changed = false;
    if let Ok(mut guard) = state.settings.lock() {
        let before = *guard;
        if let Some(width) = query.width {
            guard.width = width;
        }
        if let Some(height) = query.height {
            guard.height = height;
        }
        // Teto proporcional: 2560x1440 -> 1920x1080 (mesmo 16:9, sem distorcer).
        let scale = f64::min(
            1.0,
            f64::min(
                state.max_width as f64 / guard.width.max(1) as f64,
                state.max_height as f64 / guard.height.max(1) as f64,
            ),
        );
        if scale < 1.0 {
            guard.width = (((guard.width as f64 * scale) as u32).max(2)) & !1;
            guard.height = (((guard.height as f64 * scale) as u32).max(2)) & !1;
        }
        if let Some(fps) = query.fps {
            guard.fps = fps.clamp(1, 60);
        }
        if let Some(bitrate) = query.bitrate {
            guard.bitrate = bitrate;
        }
        current = *guard;
        // O Discord manda setTransportOptions a torto e a direito: so vale
        // avisar (e mexer no WebRTC) quando algo mudou de verdade.
        changed = current.width != before.width
            || current.height != before.height
            || current.fps != before.fps;
        bitrate_changed = current.bitrate != before.bitrate;
    }

    if bitrate_changed || changed {
        // Mensagem completa (nao so o bitrate): o renderer precisa do fps pra
        // maxFramerate do sender (era fixo em 30 e prendia o 60) e da resolucao
        // pra o viewer saber o que vem pela frente.
        let message = format!(
            "{{\"type\":\"settings\",\"bitrate\":{},\"fps\":{},\"width\":{},\"height\":{}}}",
            current.bitrate, current.fps, current.width, current.height
        );
        let _ = state.hub.send(Arc::new(HubMessage {
            from: 0,
            text: message,
            room: String::new(),
        }));
    }

    if changed || bitrate_changed {
        logging::write_line(&format!(
            "qualidade: {}x{} @ {} fps, {} Mbps",
            current.width,
            current.height,
            current.fps,
            current.bitrate / 1_000_000
        ));
    }
    (headers, "ok")
}

#[derive(serde::Deserialize)]
struct TestPublishQuery {
    publisher: Option<String>,
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    // RELAY nao captura nada (nem tem display): recusa o feed antes do upgrade.
    if state.relay {
        return (StatusCode::NOT_FOUND, "relay: sem feed").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state)).into_response()
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    start_capture(&state);
    let mut frames = state.frames.subscribe();
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Text(text))) => logging::write_line(&format!("feed <- {text}")),
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            frame = frames.recv() => {
                match frame {
                    Ok(frame) => {
                        let mut buffer = Vec::with_capacity(16 + frame.data.len());
                        buffer.extend_from_slice(&frame.width.to_le_bytes());
                        buffer.extend_from_slice(&frame.height.to_le_bytes());
                        buffer.extend_from_slice(&frame.timestamp_us.to_le_bytes());
                        buffer.extend_from_slice(&frame.data);
                        if socket.send(Message::Binary(buffer.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    }
}

/// Hub LOCAL (`/hub`, mesma maquina): sem sala e sem segredo.
///
/// Nao pode ser o mesmo handler da sala: a rota `/hub` nao tem `{room}`, entao
/// um `Path<String>` ali faz o axum recusar a extracao e derrubar a conexao
/// ANTES do upgrade - foi o que quebrou o P2P inteiro quando as salas entraram.
async fn hub_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_hub(socket, state, String::new()))
        .into_response()
}

/// Relay por sala (`/hub/<sala>?secret=...`).
///
/// No modo relay o segredo e' obrigatorio: sem ele o servidor recusa a conexao.
/// A sala vem do PATH (e o cliente a deriva do canal de voz do Discord).
async fn hub_room_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    AxumPath(room): AxumPath<String>,
    Query(query): Query<RoomQuery>,
) -> impl IntoResponse {
    if state.relay && !state.secret.is_empty() {
        let presented = query.secret.clone().unwrap_or_default();
        if presented != state.secret {
            logging::write_line("hub: conexao recusada (segredo invalido)");
            return (StatusCode::UNAUTHORIZED, "segredo invalido").into_response();
        }
    }
    ws.on_upgrade(move |socket| handle_hub(socket, state, room)).into_response()
}

#[derive(serde::Deserialize)]
struct RoomQuery {
    secret: Option<String>,
}

/// Relay de sinalizacao: tudo que um peer manda vai para os outros peers.
/// Os proprios bridges ignoram mensagens com o seu proprio `id`, entao o relay
/// nao precisa de roteamento.
async fn handle_hub(mut socket: WebSocket, state: AppState, room: String) {
    let id = NEXT_HUB_ID.fetch_add(1, Ordering::Relaxed);
    let mut incoming = state.hub.subscribe();
    let welcome = format!("{{\"type\":\"welcome\",\"id\":{id}}}");
    if socket.send(Message::Text(welcome.into())).await.is_err() {
        return;
    }
    logging::write_line(&format!(
        "hub: peer {id} conectado{}",
        if room.is_empty() {
            String::new()
        } else {
            format!(" (sala {room})")
        }
    ));
    loop {
        tokio::select! {
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        // Loga o que os bridges mandam, mas corta payloads grandes
                        // (SDP/ICE tem varios KB e poluem o terminal).
                        let preview = if text.len() > 240 {
                            let end = (0..=240)
                                .rev()
                                .find(|&i| text.is_char_boundary(i))
                                .unwrap_or(0);
                            format!("{}... (+{}B)", &text[..end], text.len() - end)
                        } else {
                            text.to_string()
                        };
                        logging::write_line(&format!("hub[{id}] <- {preview}"));
                        let _ = state.hub.send(Arc::new(HubMessage {
                            from: id,
                            text: text.to_string(),
                            room: room.clone(),
                        }));
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            relayed = incoming.recv() => {
                match relayed {
                    Ok(message) => {
                        if message.from == id {
                            continue;
                        }
                        // Sala: so entrega pra quem esta na mesma. Vazio = todos
                        // (e' o caso do hub local, entre os Discords da maquina).
                        if !message.room.is_empty() && message.room != room {
                            continue;
                        }
                        if socket.send(Message::Text(message.text.clone().into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    }
    logging::write_line(&format!("hub: peer {id} saiu"));
}

// ----------------------------------------------------------- auto-update ----

/// SHA-256 em hex (integridade do manifest de release) - sem dependencia extra.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}

/// `GET /release.json`: serve o manifest do diretorio de releases. Se ele nao
/// existir, gera na hora a partir do exe + `version.txt` - assim basta jogar o
/// executavel novo no diretorio.
async fn release_manifest(State(state): State<AppState>) -> axum::response::Response {
    let manifest = state.release_dir.join("release.json");
    if let Ok(bytes) = std::fs::read(&manifest) {
        return (
            [("content-type", "application/json; charset=utf-8")],
            bytes,
        )
            .into_response();
    }

    let exe = state.release_dir.join(RELEASE_ASSET);
    let version_file = state.release_dir.join("version.txt");
    match (std::fs::read(&exe), std::fs::read_to_string(&version_file)) {
        (Ok(data), Ok(version)) if !version.trim().is_empty() => {
            let version = version.trim().trim_start_matches('v').to_string();
            let body = serde_json::json!({
                "version": version,
                "asset": RELEASE_ASSET,
                "size": data.len(),
                "sha256": sha256_hex(&data),
            })
            .to_string();
            (
                [("content-type", "application/json; charset=utf-8")],
                body,
            )
                .into_response()
        }
        _ => (
            StatusCode::NOT_FOUND,
            format!(
                "release.json ausente em {} (coloque release.json, ou {RELEASE_ASSET} + version.txt)",
                state.release_dir.display()
            ),
        )
            .into_response(),
    }
}

async fn release_asset(State(state): State<AppState>) -> axum::response::Response {
    serve_release_file(&state.release_dir, RELEASE_ASSET)
}

async fn release_file(
    State(state): State<AppState>,
    AxumPath(file): AxumPath<String>,
) -> axum::response::Response {
    // Sem path traversal: so um nome simples de arquivo.
    if file.contains("..") || file.contains('/') || file.contains('\\') {
        return (StatusCode::BAD_REQUEST, "nome invalido").into_response();
    }
    serve_release_file(&state.release_dir, &file)
}

fn serve_release_file(directory: &Path, name: &str) -> axum::response::Response {
    match std::fs::read(directory.join(name)) {
        Ok(data) => (
            [("content-type", "application/octet-stream")],
            data,
        )
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "arquivo ausente").into_response(),
    }
}

// -------------------------------------------------------------- captura ----

/// A captura so comeca quando alguem realmente assina o feed (`/ws`). Assim o
/// motor nao gasta CPU nem aparece nada na tela enquanto ninguem compartilha.
fn start_capture(state: &AppState) {
    if state.capture_started.swap(true, Ordering::SeqCst) {
        return;
    }
    let tx = state.frames.clone();
    let state_selection = state.selection.clone();
    let state_settings = state.settings.clone();
    std::thread::spawn(move || {
        let capturer = match Capturer::new() {
            Ok(capturer) => capturer,
            Err(error) => {
                logging::write_line(&format!("capture init failed: {error}"));
                return;
            }
        };
        let mut announced = (0u32, 0u32, 0u32);
        let mut consecutive_errors: u32 = 0;
        let mut last_error_log: Option<Instant> = None;
        loop {
            let started = Instant::now();
            let settings = state_settings
                .lock()
                .map(|guard| *guard)
                .unwrap_or_default();
            if (settings.width, settings.height, settings.fps) != announced {
                announced = (settings.width, settings.height, settings.fps);
                logging::write_line(&format!(
                    "capture: {}x{} @ {} fps",
                    settings.width, settings.height, settings.fps
                ));
            }
            let interval = Duration::from_micros(1_000_000 / settings.fps.max(1) as u64);
            let selection = state_selection
                .lock()
                .map(|guard| guard.clone())
                .unwrap_or_default();
            match capturer.capture(&selection, settings.width, settings.height) {
                Ok(data) => {
                    let timestamp_us = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_micros() as u64)
                        .unwrap_or(0);
                    let _ = tx.send(Arc::new(Frame {
                        width: settings.width,
                        height: settings.height,
                        timestamp_us,
                        data,
                    }));
                }
                Err(error) => {
                    consecutive_errors += 1;
                    // Backoff + log limitado: display sumiu (monitor desligado,
                    // janela fechada, container sem tela) nao pode virar 60
                    // erros/segundo eternos (era o log do relay no Dokploy).
                    let should_log = last_error_log
                        .map(|last| last.elapsed() >= Duration::from_secs(10))
                        .unwrap_or(true);
                    if should_log {
                        last_error_log = Some(Instant::now());
                        logging::write_line(&format!(
                            "capture failed (x{consecutive_errors}): {error}"
                        ));
                    }
                    let backoff = Duration::from_millis(
                        (200u64 * consecutive_errors as u64).min(3_000),
                    );
                    std::thread::sleep(backoff);
                    // Sempre `continue`: o contador de erros NAO pode ser zerado
                    // aqui, senao ele volta pra 1 a cada volta do loop e o
                    // backoff nunca cresce (era o caso: 15 erros/s eternos no
                    // relay do Dokploy). Ele so zera quando um frame SAI.
                    continue;
                }
            }
            consecutive_errors = 0;
            let elapsed = started.elapsed();
            if elapsed < interval {
                std::thread::sleep(interval - elapsed);
            }
        }
    });
}

const PAGE: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><title>bigducks-rs</title>
<style>html,body{margin:0;height:100%;background:#0b0b0b;overflow:hidden}
canvas{display:block;width:100vw;height:100vh;object-fit:contain}
#bar{position:fixed;top:0;left:0;right:0;display:flex;gap:8px;align-items:center;padding:6px 10px;background:rgba(20,21,26,.92);font:12px/1 system-ui,sans-serif;color:#dbdee1;z-index:9}
#bar button{all:unset;cursor:pointer;padding:5px 10px;border-radius:6px;background:#2b2d31;color:#dbdee1;font:12px system-ui,sans-serif}
#bar button:hover{background:#3c4270}
#bar button.on{background:#5865f2;color:#fff}
#state{margin-left:auto;color:#949ba4}
</style>
</head><body>
<div id="bar">
  <span>qualidade da captura:</span>
  <button data-w="1280" data-h="720"  data-fps="30" data-b="2500000">720p30</button>
  <button data-w="1280" data-h="720"  data-fps="60" data-b="5000000">720p60</button>
  <button data-w="1920" data-h="1080" data-fps="30" data-b="6000000">1080p30</button>
  <button data-w="1920" data-h="1080" data-fps="60" data-b="9000000">1080p60</button>
  <button data-w="2560" data-h="1440" data-fps="60" data-b="12000000">1440p60</button>
  <span id="state">(a UI do Discord muda isso ao vivo quando voce mexe no painel dela)</span>
</div>
<canvas id="screen"></canvas>
<script>
const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d', { alpha: false });
let decoding = false;

// Presets: mandam pro /settings e viram a qualidade da captura E do P2P
// (bitrate via hub). Funciona mesmo quando a UI do Discord trava/modal.
const state = document.getElementById('state');
for (const b of document.querySelectorAll('#bar button')) {
  b.onclick = async () => {
    const q = `width=${b.dataset.w}&height=${b.dataset.h}&fps=${b.dataset.fps}&bitrate=${b.dataset.b}`;
    try {
      await fetch('/settings?' + q);
      document.querySelectorAll('#bar button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      state.textContent = 'aplicado: ' + b.textContent;
    } catch (e) { state.textContent = 'falhou: ' + e; }
  };
}

const socket = new WebSocket(`ws://${location.host}/ws`);
socket.binaryType = 'arraybuffer';
socket.onmessage = (event) => {
  if (decoding) return;
  decoding = true;
  try {
    const buffer = event.data;
    const view = new DataView(buffer);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    const timestamp = Number(view.getBigUint64(8, true));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const pixels = new Uint8Array(buffer.slice(16));
    const frame = new VideoFrame(pixels, { format: 'RGBA', codedWidth: width, codedHeight: height, timestamp });
    ctx.drawImage(frame, 0, 0);
    frame.close();
  } catch (error) {
    console.error('frame failed', error);
  }
  decoding = false;
};
</script></body></html>
"#;
