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

/// Nosso proprio pid. NUNCA e' candidato: nem para diagnostico, nem para
/// WM_CLOSE. O caminho deste repo (`D:\discord\rs\bigducks-rs\dist\...`) contem
/// "discord", entao qualquer casamento por CAMINHO acertaria o proprio motor.
fn own_pid() -> u32 {
    std::process::id()
}

/// O nome do arquivo executavel e' de uma das familias do Discord?
///
/// Comparacao SEMPRE pelo NOME do arquivo (`szExeFile`), case-insensitive (do
/// jeito que o Windows trata nome de arquivo). NUNCA pelo diretorio pai.
fn is_discord_exe(name: &str) -> bool {
    NAMES.iter().any(|candidate| candidate.eq_ignore_ascii_case(name))
}

/// Resultado de um scan: os candidatos verificados + a identidade do NOSSO
/// processo (para logar explicitamente que ele foi ignorado).
struct Scan {
    /// Processos do Discord de verdade (nome exato, nunca o nosso).
    candidates: Vec<Instance>,
    /// (pid, nome, caminho) do nosso processo.
    own: (u32, String, Option<PathBuf>),
}

fn scan() -> Scan {
    let our_pid = own_pid();
    let mut candidates = Vec::new();
    let mut own_name = String::new();
    let mut own_path = None;

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot as isize == -1 {
        return Scan {
            candidates,
            own: (our_pid, own_name, own_path),
        };
    }

    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while ok {
        let name = utf16_field(&entry.szExeFile);
        let pid = entry.th32ProcessID;
        if pid == our_pid {
            // Pulado EXPLICITAMENTE: e' o nosso proprio exe (que vive num
            // caminho com "discord" e por isso jamais pode ser alvo).
            own_name = name;
            own_path = process_path(pid);
        } else if is_discord_exe(&name) {
            candidates.push(Instance {
                name,
                pid,
                path: process_path(pid),
                started: process_started(pid),
            });
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe {
        CloseHandle(snapshot);
    }
    Scan {
        candidates,
        own: (our_pid, own_name, own_path),
    }
}

/// Todos os processos das familias do Discord que estao rodando (o nosso
/// proprio processo e' sempre descartado).
pub fn running() -> Vec<Instance> {
    scan().candidates
}

pub fn is_running() -> bool {
    !running().is_empty()
}

/// Caminho do processo, ou "?" quando nao conseguimos ler.
fn path_text(instance: &Instance) -> String {
    instance
        .path
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "?".to_string())
}

/// Uma linha de candidato com TUDO (nome, pid, caminho) + veredito, para um
/// casamento errado ser impossivel de nao ver.
fn candidate_line(instance: &Instance, verdict: &str) -> String {
    format!(
        "discord: candidato nome={} pid={} caminho={} -> {verdict}",
        instance.name,
        instance.pid,
        path_text(instance),
    )
}

/// Linha explicita de que o nosso proprio processo foi ignorado.
fn own_ignored_line(own: &(u32, String, Option<PathBuf>)) -> String {
    let name = if own.1.is_empty() { "?" } else { own.1.as_str() };
    let path = own
        .2
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "?".to_string());
    format!(
        "discord: ignorando o proprio processo pid={} (nome={name}, caminho={path})",
        own.0
    )
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
    let scan = scan();
    let mut lines = Vec::new();
    // Primeiro de tudo: prova que o nosso proprio processo NAO entrou na lista.
    lines.push(own_ignored_line(&scan.own));

    let instances = scan.candidates;
    if instances.is_empty() {
        lines.push("discord: nenhum processo rodando - nada para reiniciar".to_string());
        return Decision {
            lines,
            stale: false,
            note: "Discord fechado - nada a reiniciar".to_string(),
        };
    }

    let injected = stamp
        .map(crate::install::fmt_time)
        .unwrap_or_else(|| "sem carimbo".to_string());
    let mut stale_count = 0usize;

    for instance in &instances {
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
        // Nome, pid, caminho COMPLETO e veredito - um match errado salta aos olhos.
        lines.push(format!(
            "discord: candidato nome={} pid={} caminho={} started={started} injetado={injected} -> {verdict}",
            instance.name,
            instance.pid,
            path_text(instance),
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
    let scan = scan();
    let instances = scan.candidates;
    let mut report = Vec::new();
    // Deixa registrado que o nosso proprio processo nunca entrou na lista.
    report.push(own_ignored_line(&scan.own));
    if instances.is_empty() {
        report.push("Discord nao esta aberto - nada para reiniciar".to_string());
        return Ok(report);
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

    // Loga CADA candidato verificado (nome, pid, caminho completo) antes de agir.
    for instance in &instances {
        report.push(candidate_line(instance, "fechando para reiniciar"));
    }
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
        // Registra a TENTATIVA antes de tentar: se o spawn travar/morrer, o log
        // ja mostra qual executavel estava sendo reaberto.
        log_info!("discord: tentando reabrir {}", path.display());
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

/// Ponteiro + tamanho da lista de pids, passada ao callback do `EnumWindows`
/// (o `LPARAM` e' um unico `isize`, entao a fatia vai por um struct `repr(C)`).
#[repr(C)]
struct CloseList {
    pids: *const u32,
    len: usize,
}

/// Manda `WM_CLOSE` para as janelas de topo dos pids VERIFICADOS.
///
/// CAUSA do bug "o app fecha a si mesmo com o Discord aberto": antes o `LPARAM`
/// era o BUFFER da fatia reinterpretado como `&Vec<u32>`. O `Vec::contains` lia
/// os pids como se fossem o cabecalho de um Vec (ptr/len/cap) e dereferenciava
/// um ponteiro-lixo -> STATUS_ACCESS_VIOLATION (0xC0000005) e o processo morria
/// silenciosamente aqui, exatamente quando havia Discord para fechar (este era o
/// unico caminho que chamava `post_close`). Agora passa-se um `CloseList` de
/// verdade, que o callback remonta como fatia. NUNCA mais "fingir" um tipo.
fn post_close(pids: &[u32]) {
    let list = CloseList {
        pids: pids.as_ptr(),
        len: pids.len(),
    };
    log_info!("discord: WM_CLOSE para os pids verificados {pids:?}");
    unsafe {
        EnumWindows(
            Some(enum_close_callback),
            &list as *const CloseList as isize as LPARAM,
        );
    }
}

unsafe extern "system" fn enum_close_callback(window: HWND, lparam: LPARAM) -> BOOL {
    let list = unsafe { &*(lparam as *const CloseList) };
    if list.pids.is_null() || list.len == 0 {
        return 1;
    }
    let pids = unsafe { std::slice::from_raw_parts(list.pids, list.len) };
    let mut pid: u32 = 0;
    unsafe {
        GetWindowThreadProcessId(window, &mut pid);
    }
    // So janelas de um candidato VERIFICADO - e NUNCA a nossa propria (a janela
    // escondida do balao vive no nosso processo).
    if pid != 0 && pid != own_pid() && pids.contains(&pid) {
        log_info!("discord: WM_CLOSE -> janela do pid verificado {pid}");
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
