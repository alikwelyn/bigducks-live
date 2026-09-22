//! Autostart no login via `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
//!
//! Sem admin: e' a chave do usuario. Regras:
//!   * habilita ja na PRIMEIRA execucao (padrao), para o motor subir antes do
//!     Discord ler o `app.asar` (a ordem importa por causa da injecao);
//!   * nunca grava um caminho temporario (build/teste);
//!   * a bandeja mostra e alterna o estado atual.

use std::path::PathBuf;

use anyhow::{Context, Result};
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

use crate::platform;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "BigDucksRS";

fn run_key() -> Result<RegKey> {
    RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(RUN_KEY)
        .map(|(key, _)| key)
        .context("abrir a chave Run do usuario")
}

/// Linha de comando registrada (entre aspas, com `--startup`).
pub fn command_line() -> String {
    format!("\"{}\" --startup", platform::exe_path().display())
}

fn exe_path() -> PathBuf {
    platform::exe_path()
}

/// Valor atual do registro, se existir.
pub fn current() -> Option<String> {
    let key = run_key().ok()?;
    key.get_value::<String, _>(VALUE_NAME).ok()
}

/// Esta ligado? (valor presente e nao vazio)
pub fn is_enabled() -> bool {
    current().map(|value| !value.trim().is_empty()).unwrap_or(false)
}

/// O valor registrado aponta para ESTE executavel?
pub fn matches_current() -> bool {
    match current() {
        Some(value) => {
            let target = exe_path().to_string_lossy().to_lowercase();
            value.to_lowercase().contains(&target)
        }
        None => false,
    }
}

/// Liga/desliga o autostart.
pub fn set_enabled(enabled: bool) -> Result<()> {
    let key = run_key()?;
    if enabled {
        let path = exe_path();
        if platform::is_temp_path(&path) {
            anyhow::bail!("recusando registrar autostart para caminho temporario: {}", path.display());
        }
        key.set_value(VALUE_NAME, &command_line())
            .context("gravar valor de autostart")?;
    } else {
        match key.delete_value(VALUE_NAME) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("remover valor de autostart"),
        }
    }
    Ok(())
}

/// Liga o autostart na primeira execucao, se ainda nao estiver ligado, e
/// aponta para o executavel atual se o caminho registrado estiver velho.
/// Devolve o estado final (ligado/desligado).
pub fn ensure_enabled_first_run() -> bool {
    if is_enabled() && matches_current() {
        return true;
    }
    if platform::is_temp_path(&exe_path()) {
        return is_enabled();
    }
    match set_enabled(true) {
        Ok(()) => true,
        Err(error) => {
            crate::log_warn!("autostart: nao consegui habilitar: {error:#}");
            is_enabled()
        }
    }
}
