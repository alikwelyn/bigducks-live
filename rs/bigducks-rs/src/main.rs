//! bigducks-rs
//!
//! Dois papeis no mesmo binario:
//!   1. motor de captura (marco 1) - tela -> WebSocket local
//!   2. hub de sinalizacao P2P - troca SDP/ICE entre os bridges dos Discords
//!      (por enquanto localhost; e o ponto unico onde a sinalizacao remota entra)
//!
//! Rotas:
//!   GET  /            painel de teste no navegador
//!   GET  /ws          frames RGBA crus (captura do proprio exe)
//!   GET  /hub         hub de sinalizacao (o bridge do Discord conecta aqui)
//!   GET  /bridge.js   o bridge completo (media bridge + camada P2P)

mod capture;
mod install;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::http::{HeaderMap, HeaderValue};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
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
}

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
                eprintln!("capture init failed: {error}");
                return;
            }
        };
        let mut announced = (0u32, 0u32, 0u32);
        loop {
            let started = Instant::now();
            let settings = state_settings
                .lock()
                .map(|guard| *guard)
                .unwrap_or_default();
            if (settings.width, settings.height, settings.fps) != announced {
                announced = (settings.width, settings.height, settings.fps);
                println!(
                    "capture: {}x{} @ {} fps",
                    settings.width, settings.height, settings.fps
                );
            }
            let interval = Duration::from_micros(1_000_000 / settings.fps.max(1) as u64);
            let selection = state_selection.lock().map(|guard| guard.clone()).unwrap_or_default();
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
                Err(error) => eprintln!("capture failed: {error}"),
            }
            let elapsed = started.elapsed();
            if elapsed < interval {
                std::thread::sleep(interval - elapsed);
            }
        }
    });
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut width = 1280u32;
    let mut height = 720u32;
    let mut fps = 15u32;
    let mut port = 8791u16;
    let mut install_only = false;
    let mut uninstall = false;
    let mut nitro = false;
    let mut relay = false;
    let mut max_width = 1920u32;
    let mut max_height = 1080u32;

    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--width" if i + 1 < args.len() => {
                width = args[i + 1].parse()?;
                i += 2;
            }
            "--height" if i + 1 < args.len() => {
                height = args[i + 1].parse()?;
                i += 2;
            }
            "--fps" if i + 1 < args.len() => {
                fps = args[i + 1].parse()?;
                i += 2;
            }
            "--port" if i + 1 < args.len() => {
                port = args[i + 1].parse()?;
                i += 2;
            }
            "--install" => {
                install_only = true;
                i += 1;
            }
            "--uninstall" => {
                uninstall = true;
                i += 1;
            }
            "--nitro" => {
                nitro = true;
                i += 1;
            }
            // Modo RELAY: so sinalizacao. Escuta em 0.0.0.0 e nao captura nada -
            // serve pra hospedar o rendezvous (o /hub) num servidor pequeno.
            "--relay" => {
                relay = true;
                i += 1;
            }
            "--max-width" if i + 1 < args.len() => {
                max_width = args[i + 1].parse()?;
                i += 2;
            }
            "--max-height" if i + 1 < args.len() => {
                max_height = args[i + 1].parse()?;
                i += 2;
            }
            other => {
                eprintln!("ignoring unknown argument: {other}");
                i += 1;
            }
        }
    }
    if fps == 0 {
        fps = 15;
    }

    if uninstall {
        for line in install::uninstall()? {
            println!("uninstall: {line}");
        }
        return Ok(());
    }

    match install::install() {
        Ok(lines) => {
            for line in lines {
                println!("inject: {line}");
            }
        }
        Err(error) => eprintln!("inject failed: {error}"),
    }
    if install_only {
        return Ok(());
    }

    let (tx, _rx) = broadcast::channel::<Arc<Frame>>(2);
    let (hub_tx, _hub_rx) = broadcast::channel::<Arc<HubMessage>>(64);
    let state = AppState {
        frames: tx.clone(),
        hub: hub_tx,
        settings: Arc::new(Mutex::new(Settings {
            width,
            height,
            fps,
            bitrate: 12_000_000,
        })),
        capture_started: Arc::new(AtomicBool::new(false)),
        selection: Arc::new(Mutex::new(Selection::default())),
        nitro,
        max_width,
        max_height,
        relay,
        secret: DEFAULT_SECRET.to_string(),
    };

    // Config embutida -> arquivo que o preload le. Assim basta mandar o .exe:
    // ele instala o bridge e escreve isto na primeira execucao.
    if !relay {
        let dir = install::data_dir();
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("remote-hub.txt");
        if !file.exists() {
            let _ = std::fs::write(&file, format!("{DEFAULT_RELAY} {DEFAULT_SECRET}\n"));
            println!("relay configurado: {DEFAULT_RELAY} (sala = canal de voz do Discord)");
        }
    }

    let app = Router::new()
        .route("/", get(page))
        .route("/ws", get(ws_handler))
        .route("/hub", get(hub_handler))
        .route("/hub/{room}", get(hub_handler))
        .route("/bridge.js", get(bridge_js))
        .route("/plugins.js", get(plugins_js))
        .route("/test-publish", get(test_publish))
        .route("/source", get(set_source))
        .route("/settings", get(set_settings))
        .route("/bridge-event", get(bridge_event))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(if relay { ("0.0.0.0", port) } else { ("127.0.0.1", port) }).await?;
    if relay {
        println!("bigducks-rs RELAY (so sinalizacao) em 0.0.0.0:{port}");
        println!("  hub P2P:   ws://SEU_HOST:{port}/hub      <- os motores conectam aqui");
        println!("  nada de video/audio passa por aqui: so offer/answer/ice (alguns KB)");
        axum::serve(listener, app).await?;
        return Ok(());
    }
    println!("bigducks-rs ouvindo em http://127.0.0.1:{port}/");
    println!("  painel:    http://127.0.0.1:{port}/");
    println!("  captura:   ws://127.0.0.1:{port}/ws");
    println!("  hub P2P:   ws://127.0.0.1:{port}/hub");
    println!("  bridge:    http://127.0.0.1:{port}/bridge.js");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn page() -> Html<&'static str> {
    Html(PAGE)
}

async fn bridge_js() -> impl IntoResponse {
    (
        [("content-type", "application/javascript; charset=utf-8")],
        BRIDGE_JS,
    )
}

/// Plugins opcionais: so existe com `--nitro`. Sem a flag responde 404 e o
/// renderer nao carrega nada - o bridge de video segue sem nenhum patch extra.
async fn plugins_js(State(state): State<AppState>) -> axum::response::Response {
    use axum::response::IntoResponse as _;
    if state.nitro {
        (
            [("content-type", "application/javascript; charset=utf-8")],
            PLUGINS_JS,
        )
            .into_response()
    } else {
        (axum::http::StatusCode::NOT_FOUND, "plugins off").into_response()
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
        println!("fonte selecionada: processo {pid}");
        return (headers, format!("ok: Process({pid})"));
    }
    let value = query.value.unwrap_or_default();
    let message = match parse_selection(&value) {
        Some(selection) => {
            if let Ok(mut guard) = state.selection.lock() {
                *guard = selection.clone();
            }
            println!("source selecionada: {value} -> {selection:?}");
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

/// O preload (processo de renderizacao) reporta aqui o que ele ve - inclusive a
/// fonte escolhida no modal do Discord. Assim tudo aparece no log do motor.
async fn bridge_event(Query(query): Query<EventQuery>) -> impl IntoResponse {
    println!(
        "preload: {} {}",
        query.name.unwrap_or_default(),
        query.data.unwrap_or_default()
    );
    (
        [(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "ok",
    )
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

    if bitrate_changed {
        let message = format!("{{\"type\":\"settings\",\"bitrate\":{}}}", current.bitrate);
        let _ = state.hub.send(Arc::new(HubMessage {
            from: 0,
            text: message,
            room: String::new(),
        }));
    }

    if changed || bitrate_changed {
        println!(
            "qualidade: {}x{} @ {} fps, {} Mbps",
            current.width,
            current.height,
            current.fps,
            current.bitrate / 1_000_000
        );
    }
    (headers, "ok")
}

#[derive(serde::Deserialize)]
struct TestPublishQuery {
    publisher: Option<String>,
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    start_capture(&state);
    let mut frames = state.frames.subscribe();
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Text(text))) => println!("feed <- {text}"),
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

/// Hub local (`/hub`) e relay por sala (`/hub/<sala>?secret=...`).
///
/// No modo relay o segredo e' obrigatorio: sem ele o servidor recusa a conexao.
/// A sala vem do PATH (e o cliente a deriva do canal de voz do Discord).
async fn hub_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(room): Path<String>,
    Query(query): Query<RoomQuery>,
) -> impl IntoResponse {
    if state.relay && !state.secret.is_empty() {
        let presented = query.secret.clone().unwrap_or_default();
        if presented != state.secret {
            println!("hub: conexao recusada (segredo invalido)");
            return (axum::http::StatusCode::UNAUTHORIZED, "segredo invalido").into_response();
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
    println!("hub: peer {id} conectado{}", if room.is_empty() { String::new() } else { format!(" (sala {room})") });
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
                        println!("hub[{id}] <- {preview}");
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
    println!("hub: peer {id} saiu");
}

const PAGE: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><title>bigducks-rs</title>
<style>html,body{margin:0;height:100%;background:#0b0b0b}canvas{display:block;width:100vw;height:100vh;object-fit:contain}</style>
</head><body>
<canvas id="screen"></canvas>
<script>
const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d', { alpha: false });
let decoding = false;
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
