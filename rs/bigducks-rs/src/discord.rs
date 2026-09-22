//! Reinicio automatico do Discord.
//!
//! O `app.asar` so' e' lido quando o Discord INICIA. Entao, se a gente (re)escreveu
//! a injecao nesta execucao e o Discord ja esta aberto, ele continuaria sem o
//! bridge. Aqui a gente fecha o Discord com educacao (WM_CLOSE nas janelas de
//! topo de cada processo) e reabre os MESMOS executaveis que estavam rodando.
//!
//! O Discord restaura o estado ao reabrir, por isso isso e' seguro - e o usuario
//! e' avisado por balao (sem prompt).

use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use std::os::windows::process::CommandExt;
use windows_sys::Win32::Foundation::{CloseHandle, BOOL, FILETIME, HWND, LPARAM};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, WaitForSingleObject,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowThreadProcessId, PostMessageW, WM_CLOSE,
};

use crate::log_info;

const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const DETACHED_PROCESS: u32 = 0x0000_0008;

const NAMES: [&str; 4] = [
    "Discord.exe",
    "DiscordCanary.exe",
    "DiscordPTB.exe",
    "DiscordDevelopment.exe",
];

#[derive(Clone, Debug)]
pub struct Instance {
    pub name: String,
    pub pid: u32,
    pub path: Option<PathBuf>,
    /// Instante em que o processo comecou (UTC). `None` = nao conseguimos ler.
    pub started: Option<SystemTime>,
}

/// Todos os processos das familias do Discord que estao rodando.
pub fn running() -> Vec<Instance> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot as isize == -1 {
        return Vec::new();
    }
    let mut found = Vec::new();
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while ok {
        let name = utf16_field(&entry.szExeFile);
        if NAMES.iter().any(|candidate| candidate.eq_ignore_ascii_case(&name)) {
            found.push(Instance {
                name,
                pid: entry.th32ProcessID,
                path: process_path(entry.th32ProcessID),
                started: process_started(entry.th32ProcessID),
            });
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe {
        CloseHandle(snapshot);
    }
    found
}

pub fn is_running() -> bool {
    !running().is_empty()
}

/// Veredito da verificacao de reinicio: uma linha por processo do Discord.
#[derive(Clone, Debug)]
pub struct Decision {
    /// Uma linha por processo, pronta pro log (uma por processo).
    pub lines: Vec<String>,
    /// Existe um Discord rodando ANTES do carimbo da injecao (codigo velho).
    pub stale: bool,
    /// Resumo curto: vai direto pro tooltip da bandeja.
    pub note: String,
}

/// Compara cada processo do Discord com o carimbo da injecao.
///
/// Regra: o asar so' e' lido quando o Discord INICIA. Entao um Discord que
/// comecou ANTES do carimbo esta rodando o codigo de antes -> VELHO, reiniciar.
/// Se comecou DEPOIS, ja' leu a injecao atual -> ok, deixar quieto (nada de
/// reinicio desnecessario). O que conta e' a HORA, nao se o JS mudou de bytes.
pub fn check(stamp: Option<SystemTime>) -> Decision {
    let instances = running();
    if instances.is_empty() {
        return Decision {
            lines: vec!["discord: nenhum processo rodando - nada para reiniciar".to_string()],
            stale: false,
            note: "Discord fechado - nada a reiniciar".to_string(),
        };
    }

    let injected = stamp
        .map(crate::install::fmt_time)
        .unwrap_or_else(|| "sem carimbo".to_string());
    let mut lines = Vec::with_capacity(instances.len());
    let mut stale_count = 0usize;

    for instance in &instances {
        let flavour = instance.name.trim_end_matches(".exe").to_lowercase();
        let started = instance
            .started
            .map(crate::install::fmt_time)
            .unwrap_or_else(|| "?".to_string());
        let verdict = match (instance.started, stamp) {
            (Some(start), Some(stamp_time)) if start >= stamp_time => "ok, ja tem o bridge",
            (Some(_), Some(_)) => {
                stale_count += 1;
                "VELHO, reiniciando"
            }
            (Some(_), None) => {
                stale_count += 1;
                "sem carimbo da injecao, reiniciando"
            }
            (None, _) => {
                stale_count += 1;
                "sem hora de inicio, reiniciando"
            }
        };
        lines.push(format!(
            "discord: {flavour} pid={} started={started} injetado={injected} -> {verdict}",
            instance.pid
        ));
    }

    let stale = stale_count > 0;
    let note = if stale {
        format!(
            "Discord com injecao velha ({stale_count}/{}) - reiniciar",
            instances.len()
        )
    } else {
        format!("Discord ja tem o bridge ({} processo(s))", instances.len())
    };
    Decision { lines, stale, note }
}

/// Fecha (educadamente) e reabre todos os Discords que estao rodando.
pub fn restart() -> Result<Vec<String>> {
    let instances = running();
    if instances.is_empty() {
        return Ok(vec!["Discord nao esta aberto - nada para reiniciar".to_string()]);
    }

    let mut paths: Vec<PathBuf> = Vec::new();
    for instance in &instances {
        if let Some(path) = &instance.path {
            if !paths.iter().any(|existing| same_path(existing, path)) {
                paths.push(path.clone());
            }
        }
    }

    let mut names: Vec<String> = Vec::new();
    for instance in &instances {
        if !names.iter().any(|name| name.eq_ignore_ascii_case(&instance.name)) {
            names.push(instance.name.clone());
        }
    }

    let mut report = Vec::new();
    report.push(format!(
        "fechando {} processos ({})",
        instances.len(),
        names.join(", ")
    ));
    log_info!("discord: fechando {} processos ({} executaveis)", instances.len(), paths.len());

    let pids: Vec<u32> = instances.iter().map(|instance| instance.pid).collect();
    post_close(&pids);

    if wait_for_exit(&pids, Duration::from_secs(20)) {
        report.push("Discord fechou sozinho (WM_CLOSE)".to_string());
        log_info!("discord: todos sairam apos WM_CLOSE");
    } else {
        log_info!("discord: alguns processos nao sairam apos 20s - forcando");
        for pid in &pids {
            if pid_alive(*pid) {
                force_kill(*pid);
            }
        }
        let _ = wait_for_exit(&pids, Duration::from_secs(5));
        report.push("Discord forcado a fechar (nao respondeu ao WM_CLOSE)".to_string());
    }

    for path in &paths {
        match relaunch(path) {
            Ok(pid) => {
                report.push(format!("reaberto {} (pid {pid})", path.display()));
                log_info!("discord: reaberto {} (pid {pid})", path.display());
            }
            Err(error) => {
                report.push(format!("falha ao reabrir {}: {error}", path.display()));
                log_info!("discord: falha ao reabrir {}: {error:#}", path.display());
            }
        }
    }

    if paths.is_empty() {
        report.push("nenhum caminho de executavel encontrado - reabra o Discord manualmente".to_string());
    }
    Ok(report)
}

fn same_path(left: &PathBuf, right: &PathBuf) -> bool {
    left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
}

fn relaunch(path: &PathBuf) -> Result<u32> {
    let mut command = std::process::Command::new(path);
    if let Some(directory) = path.parent() {
        command.current_dir(directory);
    }
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    let child = command.spawn()?;
    Ok(child.id())
}

fn post_close(pids: &[u32]) {
    let pointer = pids as *const [u32] as *const Vec<u32>;
    unsafe {
        EnumWindows(Some(enum_close_callback), pointer as isize as LPARAM);
    }
}

unsafe extern "system" fn enum_close_callback(window: HWND, lparam: LPARAM) -> BOOL {
    let pids = unsafe { &*(lparam as *const Vec<u32>) };
    let mut pid: u32 = 0;
    unsafe {
        GetWindowThreadProcessId(window, &mut pid);
    }
    if pid != 0 && pids.contains(&pid) {
        unsafe {
            PostMessageW(window, WM_CLOSE, 0, 0);
        }
    }
    1
}

fn wait_for_exit(pids: &[u32], timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if pids.iter().all(|pid| !pid_alive(*pid)) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    pids.iter().all(|pid| !pid_alive(*pid))
}

fn pid_alive(pid: u32) -> bool {
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return false;
        }
        let result = WaitForSingleObject(handle, 0);
        CloseHandle(handle);
        // WAIT_TIMEOUT (258) = ainda vivo; WAIT_OBJECT_0 (0) = terminou.
        result != 0
    }
}

fn force_kill(pid: u32) {
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() {
            windows_sys::Win32::System::Threading::TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }
}

fn process_path(pid: u32) -> Option<PathBuf> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buffer = [0u16; 1024];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size);
        CloseHandle(handle);
        if ok == 0 || size == 0 {
            return None;
        }
        Some(PathBuf::from(String::from_utf16_lossy(&buffer[..size as usize])))
    }
}

/// Instante de criacao do processo (UTC), via `GetProcessTimes`.
fn process_started(pid: u32) -> Option<SystemTime> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut creation: FILETIME = std::mem::zeroed();
        let mut exit: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        let ok = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        Some(filetime_to_systemtime(creation))
    }
}

/// `FILETIME` (100ns desde 1601-01-01 UTC) -> `SystemTime` (unix).
fn filetime_to_systemtime(filetime: FILETIME) -> SystemTime {
    /// Segundos entre 1601-01-01 e 1970-01-01 (a epoca do FILETIME e a do unix).
    const TICKS_1601_TO_1970: u64 = 116_444_736_000_000_000;
    let ticks = ((filetime.dwHighDateTime as u64) << 32) | filetime.dwLowDateTime as u64;
    let unix_ticks = ticks.saturating_sub(TICKS_1601_TO_1970);
    let seconds = unix_ticks / 10_000_000;
    let nanos = ((unix_ticks % 10_000_000) * 100) as u32;
    UNIX_EPOCH + Duration::new(seconds, nanos)
}

fn utf16_field(field: &[u16]) -> String {
    let length = field.iter().position(|unit| *unit == 0).unwrap_or(field.len());
    String::from_utf16_lossy(&field[..length])
}
