//! Guard de instancia unica (Windows).
//!
//! O autostart (`HKCU\...\Run`) sobe o app no login; se o usuario TAMBEM der
//! dois cliques no exe, o SEGUNDO processo criava a propria bandeja (dois icones
//! na area de notificacao, um deles sem bitmap) e ainda falhava ao abrir a porta
//! 8791. Nada aqui e' um PID file (que fica velho se o processo morre): e' um
//! MUTEX NOMEADO do Windows - um objeto do kernel que existe enquanto o ultimo
//! handle estiver aberto e some sozinho quando o dono termina.
//!
//! Quem NAO for o primeiro sai na hora, antes de injetar no Discord ou criar a
//! bandeja. O `release()` fecha o handle nos caminhos de saida (inclusive o
//! "Sair" da bandeja); o Windows tambem libera sozinho quando o processo morre,
//! entao reabrir o app sempre funciona.

use std::ffi::c_void;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::CreateMutexW;

/// Nome do MUTEX do kernel. `Local\` = por SESSAO: cada usuario logado tem a sua
/// instancia (o autostart e' por usuario, `HKCU`). `Global\` misturaria sessoes.
pub const MUTEX_NAME: &str = "Local\\Desjanjador.bigducks-rs";

struct Guard {
    handle: *mut c_void,
}

// O handle e' um objeto do kernel (um inteiro); nao ha estado Rust por tras, so
// precisamos manter o valor vivo. Por isso e' seguro manda-lo para o global.
unsafe impl Send for Guard {}

static GUARD: std::sync::Mutex<Option<Guard>> = std::sync::Mutex::new(None);

/// O que aconteceu ao tentar virar a instancia unica.
pub enum Status {
    /// Somos o unico processo; o guard esta ativo (handle aberto).
    First,
    /// Ja existe outra instancia; traz os pids candidatos para o log.
    AlreadyRunning(Vec<u32>),
    /// Nao deu para criar o mutex: seguimos sem o guard, avisando.
    Failed(String),
}

/// Cria (ou abre) o mutex nomeado. Se ele JA EXISTIA, outra instancia esta
/// rodando e este processo novo NAO pode criar bandeja, injetar nem abrir porta.
pub fn acquire() -> Status {
    let name = wide(MUTEX_NAME);
    // binitialowner = 0: NAO tomamos posse do mutex (nao usamos como trava de
    // secao critica) - so' mantemos o handle para o NOME existir.
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
        return Status::Failed(format!(
            "CreateMutexW falhou (erro {})",
            unsafe { GetLastError() }
        ));
    }
    // GetLastError() tem que ser lido LOGO apos a chamada (antes de qualquer
    // outro win32), senao perde o ERROR_ALREADY_EXISTS.
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        // O nome ja pertence a outra instancia; o nosso handle novo e' apenas um
        // espelho - fecha-lo nao libera o mutex dela.
        unsafe { CloseHandle(handle) };
        return Status::AlreadyRunning(other_instance_pids());
    }
    if let Ok(mut slot) = GUARD.lock() {
        *slot = Some(Guard { handle });
    }
    Status::First
}

/// Fecha o handle do mutex. Chamado nos caminhos de saida (inclusive o "Sair" da
/// bandeja). Idempotente.
pub fn release() {
    if let Ok(mut slot) = GUARD.lock() {
        if let Some(guard) = slot.take() {
            if !guard.handle.is_null() {
                unsafe { CloseHandle(guard.handle) };
            }
        }
    }
}

/// Pids de outros processos com o MESMO nome de executavel que o nosso (so' para
/// o log: o mutex ja' decidiu que existe outra instancia, isto diz QUAL).
fn other_instance_pids() -> Vec<u32> {
    let own_pid = std::process::id();
    let target = own_exe_name();
    let mut pids = Vec::new();

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot as isize == -1 {
        return pids;
    }
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while ok {
        let name = utf16_field(&entry.szExeFile);
        let pid = entry.th32ProcessID;
        if pid != own_pid && name.eq_ignore_ascii_case(&target) {
            pids.push(pid);
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    pids
}

fn own_exe_name() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.file_name().map(|name| name.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "Desjanjador.exe".to_string())
}

fn wide(value: &str) -> Vec<u16> {
    let mut buffer: Vec<u16> = value.encode_utf16().collect();
    buffer.push(0);
    buffer
}

fn utf16_field(field: &[u16]) -> String {
    let length = field.iter().position(|unit| *unit == 0).unwrap_or(field.len());
    String::from_utf16_lossy(&field[..length])
}
