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

/// Roda a bandeja na thread atual (bloqueia ate' "Sair").
pub fn run(status: Shared) {
    platform::create_balloon_window();

    let menu = Menu::new();
    let view_log = MenuItem::new("Ver log", true, None);
    // "Reiniciar Discord" tambem REINSTALA o bridge: pra quem recebeu o exe,
    // "reinstalar" e' detalhe interno - um item so' resolve os dois casos.
    let restart_discord = MenuItem::new("Reiniciar Discord", true, None);
    let autostart_item =
        CheckMenuItem::new("Iniciar com o Windows", true, autostart::is_enabled(), None);
    let quit = MenuItem::new("Sair", true, None);
    let _ = menu.append_items(&[
        &view_log,
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
        .with_id("bigducks-rs")
        .with_menu(Box::new(menu))
        // Clique ESQUERDO nao faz nada (nao abre menu, nao abre nada): o menu so'
        // aparece no botao direito, que e' o que todo mundo espera no Windows.
        .with_menu_on_left_click(false)
        .with_tooltip("DiscordStream");
    if let Some(icon) = initial {
        builder = builder.with_icon(icon);
    }
    let tray = match builder.build() {
        Ok(tray) => tray,
        Err(error) => {
            crate::log_warn!("bandeja: nao consegui criar o icone: {error}");
            return;
        }
    };

    // Handler de cliques: so' ids + status compartilhado (Send + Sync).
    let log_id = view_log.id().clone();
    let restart_id = restart_discord.id().clone();
    let autostart_id = autostart_item.id().clone();
    let quit_id = quit.id().clone();

    let handler_status = status.clone();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let id = event.id();
        if id == &log_id {
            platform::open_target(&logging::log_path().to_string_lossy());
        } else if id == &restart_id {
            let status = handler_status.clone();
            std::thread::spawn(move || restart_discord_app(status));
        } else if id == &autostart_id {
            toggle_autostart(&handler_status);
        } else if id == &quit_id {
            crate::log_info!("bandeja: sair");
            std::process::exit(0);
        }
    }));

    // Timer da thread principal: atualiza icone/tooltip/checkbox e mostra baloes.
    platform::pump_messages(Duration::from_millis(2000), move || {
        refresh(&tray, &autostart_item, &status);
    });
    crate::log_info!("bandeja: loop de mensagens terminou");
}

/// Le' o status e aplica no icone/tooltip; consome o balao pendente.
fn refresh(tray: &TrayIcon, autostart_item: &CheckMenuItem, status: &Shared) {
    let snapshot = status.lock().ok().map(|state| {
        (
            state.bridge_installed,
            state.relay,
            state.update,
            state.tooltip(),
            state.balloon.clone(),
        )
    });
    let Some((installed, relay, update, tooltip, balloon)) = snapshot else {
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
            let _ = tray.set_icon(Some(icon));
        }
        let _ = tray.set_tooltip(Some(tooltip.clone()));
    }
    let wanted = autostart::is_enabled();
    if autostart_item.is_checked() != wanted {
        let _ = autostart_item.set_checked(wanted);
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
        state.notify("Reiniciando o Discord", "Fechando e reabrindo para aplicar o bridge.");
    }
    match discord::restart() {
        Ok(report) => {
            for line in &report {
                crate::log_info!("reiniciar-discord: {line}");
            }
            if let Ok(mut state) = status.lock() {
                state.notify("Discord reiniciado", report.first().cloned().unwrap_or_default());
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
