//! Logging do motor.
//!
//! Sem `--console` (o caso do amigo que so da dois cliques) o exe e' buildado
//! como `windows_subsystem = "windows"`: NENHUM console existe, entao TODO
//! diagnostico que antes ia pro terminal passa a ir para um arquivo rotativo em
//! `%LOCALAPPDATA%\DiscordStream\engine.log` (2 MB x 3 arquivos:
//! `engine.log`, `engine.log.1`, `engine.log.2`).
//!
//! Com `--console` o `platform::attach_console` cria/anexa um console e o mesmo
//! texto tambem aparece na tela - os prints de diagnostico (que sempre foram a
//! forma de depurar este motor) continuam disponiveis.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// Tamanho maximo de cada arquivo de log (512 KB mantem o disco limpo).
const MAX_BYTES: u64 = 512 * 1024;
/// Quantos arquivos manter no total (engine.log + .1).
const MAX_FILES: usize = 2;

struct Logger {
    path: PathBuf,
    console: bool,
    file: Option<File>,
    bytes: u64,
}

static LOGGER: OnceLock<Mutex<Logger>> = OnceLock::new();

/// `%LOCALAPPDATA%\DiscordStream` (o mesmo diretorio de dados da injecao).
pub fn data_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("DiscordStream")
}

/// Caminho do log principal.
pub fn log_path() -> PathBuf {
    data_dir().join("engine.log")
}

/// Limpa arquivos de log antigos/rotacionados para nao acumular no disco.
pub fn cleanup_logs() {
    let base = log_path();
    for i in 1..=5 {
        let old = PathBuf::from(format!("{}.{}", base.display(), i));
        let _ = fs::remove_file(old);
    }
}

/// Liga o log em arquivo. Idempotente. `console` so controla a copia no terminal.
pub fn init(console: bool) {
    cleanup_logs();
    let path = log_path();
    let _ = fs::create_dir_all(data_dir());
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok();
    let bytes = file
        .as_ref()
        .and_then(|handle| handle.metadata().ok())
        .map(|meta| meta.len())
        .unwrap_or(0);
    let logger = Logger {
        path,
        console,
        file,
        bytes,
    };
    let _ = LOGGER.set(Mutex::new(logger));
    // Arquivo grande de uma sessao anterior: roda a rotacao uma vez no boot.
    if let Some(handle) = LOGGER.get() {
        if let Ok(mut guard) = handle.lock() {
            if guard.bytes >= MAX_BYTES {
                guard.rotate();
            }
        }
    }
}

/// Escreve uma linha (com timestamp UTC) no arquivo e, se ligado, no console.
///
/// NUNCA perde a linha: se o log ainda nao foi inicializado (um panic ou um
/// argumento invalido ANTES do `init`) escreve direto no `engine.log`. Num exe
/// `windows_subsystem = "windows"` o stderr NAO existe, entao jogar a mensagem
/// para la era o mesmo que descarta-la - e era assim que um panic sumia sem
/// deixar rastro.
pub fn write_line(text: &str) {
    let stamp = timestamp();
    let line = format!("{stamp} {text}");
    if let Some(handle) = LOGGER.get() {
        if let Ok(mut guard) = handle.lock() {
            guard.write(&line);
            return;
        }
    }
    let _ = fs::create_dir_all(data_dir());
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = writeln!(file, "{line}");
    } else {
        let _ = writeln!(std::io::stderr(), "{line}");
    }
}

impl Logger {
    fn write(&mut self, line: &str) {
        if self.console {
            let _ = writeln!(std::io::stderr(), "{line}");
        }
        if self.file.is_none() {
            self.file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)
                .ok();
            self.bytes = self
                .file
                .as_ref()
                .and_then(|handle| handle.metadata().ok())
                .map(|meta| meta.len())
                .unwrap_or(0);
        }
        let text = format!("{line}\n");
        let mut failed = false;
        if let Some(file) = self.file.as_mut() {
            if file.write_all(text.as_bytes()).is_err() || file.flush().is_err() {
                failed = true;
            } else {
                self.bytes += text.len() as u64;
            }
        } else {
            failed = true;
        }
        if failed {
            self.file = None;
        }
        if self.bytes >= MAX_BYTES {
            self.rotate();
        }
    }

    /// engine.log -> engine.log.1 -> engine.log.2 (o mais antigo sai).
    fn rotate(&mut self) {
        drop(self.file.take());
        let _ = fs::remove_file(self.indexed(MAX_FILES - 1));
        for index in (1..MAX_FILES - 1).rev() {
            let _ = fs::rename(self.indexed(index), self.indexed(index + 1));
        }
        let _ = fs::rename(&self.path, self.indexed(1));
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .ok();
        self.bytes = 0;
    }

    fn indexed(&self, index: usize) -> PathBuf {
        PathBuf::from(format!("{}.{}", self.path.display(), index))
    }
}

/// `2026-09-22T23:18:39Z` sem dependencia externa.
fn timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or(0);
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Algoritmo civil_from_days (Howard Hinnant) - dias desde 1970-01-01.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Loga uma linha `INFO`.
#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => { $crate::logging::write_line(&format!($($arg)*)) };
}

/// Loga uma linha `WARN`.
#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => { $crate::logging::write_line(&format!("WARN {}", format!($($arg)*))) };
}
