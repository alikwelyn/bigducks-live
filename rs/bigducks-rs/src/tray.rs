//! Bandeja (icone + menu) na thread principal.
//!
//! Mantem o runtime tokio vivo: o servidor axum roda em tarefas do runtime, e a
//! thread principal so' bombeia mensagens do Win32 (que e' o que faz o menu da
//! bandeja funcionar). O icone reflete o estado do app (bridge/relay/stream) e a
//! cada ~2s a bandeja le' o `status` compartilhado e mostra os baloes pendentes.
//!
//! Detalhe de API: `tray_icon`/`muda` guardam `Rc<RefCell<..>>` internamente, ou
//! seja NAO sao `Send`/`Sync`. Por isso os itens de menu e o `TrayIcon` ficam NA
//! thread principal: o handler de cliques so' usa ids (que sao `Send`) e o
//! `status` compartilhado; a atualizacao visual roda no timer da thread principal.

use std::time::Duration;

use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{TrayIcon, TrayIconBuilder};

use crate::logging;
use crate::status::{Relay, Shared, Update};
use crate::{autostart, discord, icon, install, platform};

/// Bandeja construida + o item de autostart (o refresh sincroniza o checkbox).
struct TrayUi {
    tray: TrayIcon,
    autostart_item: CheckMenuItem,
    check_update_item: MenuItem,
}

/// Monta a bandeja do zero. Devolve o erro como `String` sem encerrar nada -
/// quem chama decide o que fazer. Registra os ids desta montagem no handler
/// global de cliques (a cada retentativa os ids mudam junto com o menu).
fn build_tray(status: &Shared, port: u16) -> Result<TrayUi, String> {
    let menu = Menu::new();
    let diagnostics = MenuItem::new("Diagnóstico de conexão", true, None);
    let view_log = MenuItem::new("Ver log", true, None);
    let check_update = MenuItem::new("Verificar atualizações", true, None);
    // "Reiniciar Discord" tambem REINSTALA o bridge: pra quem recebeu o exe,
    // "reinstalar" e' detalhe interno - um item so' resolve os dois casos.
    let restart_discord = MenuItem::new("Reiniciar Discord", true, None);
    let autostart_item =
        CheckMenuItem::new("Iniciar com o Windows", true, autostart::is_enabled(), None);
    let quit = MenuItem::new("Sair", true, None);
    let _ = menu.append_items(&[
        &diagnostics,
        &view_log,
        &check_update,
        &PredefinedMenuItem::separator(),
        &restart_discord,
        &autostart_item,
        &PredefinedMenuItem::separator(),
        &quit,
    ]);

    let initial = {
        let guard = status.lock().ok();
        let (installed, relay, update) = guard
            .map(|state| (state.bridge_installed, state.relay, state.update))
            .unwrap_or((false, Relay::Unknown, Update::Idle));
        icon::tray_icon(installed, relay, update)
    };

    let mut builder = TrayIconBuilder::new()
        .with_id("Desjanjador")
        .with_menu(Box::new(menu))
        // Clique ESQUERDO nao faz nada (nao abre menu, nao abre nada): o menu so'
        // aparece no botao direito, que e' o que todo mundo espera no Windows.
        .with_menu_on_left_click(false)
        .with_tooltip("Desjanjador");
    // SEM BITMAP NAO CRIAMOS A ENTRADA. O `TrayIconBuilder::build()` aceita ser
    // chamado sem icone e cria um icone VAZIO na area de notificacao - era o
    // "icone sem icone" do bug dos dois icones. Aqui, se o bitmap faltar, devolve
    // Err: o `run()` loga ALTO e tenta de novo - nunca aparece entrada vazia.
    let icon = initial.ok_or_else(|| {
        "sem bitmap para o icone da bandeja (Icon indisponivel) - nao crio entrada vazia"
            .to_string()
    })?;
    builder = builder.with_icon(icon);
    let tray = builder.build().map_err(|error| error.to_string())?;

    // Handler de cliques: so' ids + status compartilhado (Send + Sync).
    let diagnostics_id = diagnostics.id().clone();
    let log_id = view_log.id().clone();
    let update_id = check_update.id().clone();
    let restart_id = restart_discord.id().clone();
    let autostart_id = autostart_item.id().clone();
    let quit_id = quit.id().clone();

    let handler_status = status.clone();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let id = event.id();
        if id == &diagnostics_id {
            platform::open_target(&format!("http://127.0.0.1:{port}/webrtc-test"));
        } else if id == &log_id {
            platform::open_target(&logging::log_path().to_string_lossy());
        } else if id == &update_id {
            let status = handler_status.clone();
            std::thread::spawn(move || crate::update::trigger_manual_check(&status));
        } else if id == &restart_id {
            let status = handler_status.clone();
            std::thread::spawn(move || restart_discord_app(status));
        } else if id == &autostart_id {
            toggle_autostart(&handler_status);
        } else if id == &quit_id {
            crate::log_info!("bandeja: sair");
            crate::logging::cleanup_logs();
            // Libera o mutex do guard ANTES de sair: um reinicio imediato do app
            // nao esbarra no mutex de uma instancia que ja esta morrendo.
            crate::single_instance::release();
            std::process::exit(0);
        }
    }));

    Ok(TrayUi {
        tray,
        autostart_item,
        check_update_item: check_update,
    })
}

/// Roda a bandeja na thread atual (bloqueia ate' "Sair").
///
/// HARD REQUIREMENT: uma falha ao criar o icone NAO pode derrubar o app. Antes,
/// `build()` falhando fazia esta funcao retornar, o `desktop_main` seguia para
/// `std::process::exit(0)` e o processo inteiro sumia em silencio. Agora o erro
/// e' registrado ALTO e o app continua rodando "sem bandeja" (headless),
/// tentando recriar o icone de tempo em tempo.
pub fn run(status: Shared, port: u16) {
    platform::create_balloon_window();

    let mut ui = match build_tray(&status, port) {
        Ok(ui) => {
            crate::log_info!("bandeja: icone criado (id Desjanjador)");
            Some(ui)
        }
        Err(error) => {
            crate::log_warn!(
                "bandeja: FALHA ao criar o icone: {error} - seguindo SEM bandeja \
                 (headless) e tentando de novo a cada 30s"
            );
            None
        }
    };

    let mut next_retry = std::time::Instant::now() + Duration::from_secs(30);
    platform::pump_messages(Duration::from_millis(2000), move || {
        if ui.is_none() && std::time::Instant::now() >= next_retry {
            next_retry = std::time::Instant::now() + Duration::from_secs(30);
            match build_tray(&status, port) {
                Ok(fresh) => {
                    crate::log_info!("bandeja: icone criado na retentativa - seguindo normal");
                    ui = Some(fresh);
                }
                Err(error) => {
                    crate::log_warn!("bandeja: ainda sem icone ({error}) - seguindo headless")
                }
            }
        }
        if let Some(staged) = take_ready_update(&status) {
            // O icone precisa ser removido antes do exe novo registrar a propria
            // bandeja; isso evita sobreposicao durante o auto-update.
            drop(ui.take());
            platform::balloon(
                "Instalando atualização",
                "A troca será concluída agora e o Desjanjador vai reabrir.",
            );
            match crate::update::apply(&staged) {
                Ok(()) => {
                    crate::log_info!("update: aplicado; encerrando a instancia antiga");
                    platform::quit_message();
                    return;
                }
                Err(error) => {
                    crate::log_warn!("update: falha ao aplicar: {error:#}");
                    if let Ok(mut state) = status.lock() {
                        state.update = Update::Failed;
                        state.update_detail = format!("Falha ao instalar atualização: {error:#}");
                        state.staged_update = None;
                        state.notify("Falha na atualização", &format!("{error:#}"));
                    }
                    ui = match build_tray(&status, port) {
                        Ok(fresh) => Some(fresh),
                        Err(build_error) => {
                            crate::log_warn!("bandeja: falha ao recriar o icone ({build_error})");
                            None
                        }
                    };
                }
            }
        }
        if let Some(ui) = ui.as_ref() {
            refresh(ui, &status);
        }
    });
    crate::log_info!("bandeja: loop de mensagens terminou");
}

/// Le' o status e aplica no icone/tooltip; consome o balao pendente.
fn take_ready_update(status: &Shared) -> Option<std::path::PathBuf> {
    let Ok(mut state) = status.lock() else {
        return None;
    };
    if state.streaming || state.update != Update::Staged {
        return None;
    }
    let staged = state.staged_update.take()?;
    state.update = Update::Installing;
    state.update_detail = "Instalando atualização…".to_string();
    Some(staged)
}

fn refresh(ui: &TrayUi, status: &Shared) {
    let snapshot = status.lock().ok().map(|state| {
        (
            state.bridge_installed,
            state.relay,
            state.update,
            state.update_label(),
            state.tooltip(),
            state.balloon.clone(),
        )
    });
    let Some((installed, relay, update, update_label, tooltip, balloon)) = snapshot else {
        return;
    };

    // So' mexe na bandeja quando o estado MUDA: recriar o icone 32x32 e chamar
    // set_tooltip/set_checked a cada 2s era churn puro (alocacao + chamadas Win32).
    static LAST_KEY: std::sync::OnceLock<std::sync::Mutex<String>> = std::sync::OnceLock::new();
    let key = format!("{installed}|{relay:?}|{update:?}|{tooltip}");
    let changed = LAST_KEY
        .get_or_init(|| std::sync::Mutex::new(String::new()))
        .lock()
        .map(|mut last| {
            let changed = *last != key;
            if changed {
                *last = key.clone();
            }
            changed
        })
        .unwrap_or(true);
    if changed {
        if let Some(icon) = icon::tray_icon(installed, relay, update) {
            let _ = ui.tray.set_icon(Some(icon));
        }
        let _ = ui.tray.set_tooltip(Some(tooltip.clone()));
    }
    static LAST_UPDATE_LABEL: std::sync::OnceLock<std::sync::Mutex<String>> =
        std::sync::OnceLock::new();
    if let Ok(mut last) = LAST_UPDATE_LABEL
        .get_or_init(|| std::sync::Mutex::new(String::new()))
        .lock()
    {
        if *last != update_label {
            ui.check_update_item.set_text(update_label);
            *last = update_label.to_string();
        }
    }
    ui.check_update_item.set_enabled(!matches!(
        update,
        Update::Checking | Update::Staged | Update::Installing
    ));
    let wanted = autostart::is_enabled();
    if ui.autostart_item.is_checked() != wanted {
        let _ = ui.autostart_item.set_checked(wanted);
    }

    if let Some((title, body)) = balloon {
        platform::balloon(&title, &body);
        if let Ok(mut state) = status.lock() {
            state.balloon = None;
        }
    }
}

/// Reinicia o Discord pra aplicar o bridge - e REINSTALA a injecao antes, porque
/// pro usuario existe uma acao so' ("reiniciar" = "faz funcionar de novo").
fn restart_discord_app(status: Shared) {
    crate::log_info!("bandeja: reiniciar Discord (reinjetando o bridge antes)");
    match install::install() {
        Ok(report) => {
            for line in &report.lines {
                crate::log_info!("reiniciar: {line}");
            }
            if let Ok(mut state) = status.lock() {
                state.bridge_installed = report.installed;
            }
            if !report.installed {
                if let Ok(mut state) = status.lock() {
                    state.notify(
                        "Discord nao encontrado",
                        "Nao achei nenhuma instalacao do Discord para injetar.",
                    );
                }
                return;
            }
        }
        Err(error) => {
            crate::log_warn!("reiniciar: injecao falhou: {error:#}");
            if let Ok(mut state) = status.lock() {
                state.notify("Falha ao reinstalar a injecao", &format!("{error:#}"));
            }
            return;
        }
    }
    if let Ok(mut state) = status.lock() {
        state.notify(
            "Reiniciando o Discord",
            "Fechando e reabrindo para aplicar o bridge.",
        );
    }
    match discord::restart() {
        Ok(report) => {
            for line in &report {
                crate::log_info!("reiniciar-discord: {line}");
            }
            if let Ok(mut state) = status.lock() {
                state.notify(
                    "Discord reiniciado",
                    report.first().cloned().unwrap_or_default(),
                );
            }
        }
        Err(error) => {
            crate::log_warn!("reiniciar Discord falhou: {error:#}");
            if let Ok(mut state) = status.lock() {
                state.notify("Falha ao reiniciar o Discord", &format!("{error:#}"));
            }
        }
    }
}

/// Alterna "Iniciar com o Windows". O checkbox e' sincronizado no proximo
/// refresh (thread principal), que le' o registro.
fn toggle_autostart(status: &Shared) {
    let want = !autostart::is_enabled();
    match autostart::set_enabled(want) {
        Ok(()) => {
            let enabled = autostart::is_enabled();
            crate::log_info!("bandeja: iniciar com o Windows = {enabled}");
            if let Ok(mut state) = status.lock() {
                state.autostart = enabled;
                state.notify(
                    "Iniciar com o Windows",
                    if enabled { "Ativado." } else { "Desativado." },
                );
            }
        }
        Err(error) => {
            crate::log_warn!("autostart: {error:#}");
            if let Ok(mut state) = status.lock() {
                state.notify("Nao consegui mudar o autostart", &format!("{error:#}"));
            }
        }
    }
}
