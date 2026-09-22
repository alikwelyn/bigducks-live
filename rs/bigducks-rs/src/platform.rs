//! Utilitarios Win32 do app de desktop.
//!
//! Tudo aqui e' Windows-only. Reune o que o resto do app precisa:
//!   * console opcional (`--console`) para depurar sem perder os prints;
//!   * abrir URL/arquivo no shell (painel, log);
//!   * balao da bandeja (`Shell_NotifyIconW`);
//!   * o "loop de mensagens" da thread principal.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::Duration;

use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Console::{
    AllocConsole, AttachConsole, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE,
    STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Shell::{
    Shell_NotifyIconW, ShellExecuteW, NIF_ICON, NIF_INFO, NIF_TIP, NIIF_INFO, NIM_ADD, NIM_DELETE,
    NOTIFYICONDATAW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, LoadIconW, RegisterClassW,
    TranslateMessage, WNDCLASSW, IDI_APPLICATION, MSG, SW_SHOWNORMAL, WM_TIMER,
};

/// `HINSTANCE`/`HWND` nulos em windows-sys 0.59 sao ponteiros void.
const NULL_HANDLE: *mut core::ffi::c_void = std::ptr::null_mut();

/// A thread principal cria esta janela escondida; ela e' o alvo dos baloes.
static BALLOON_WINDOW: AtomicIsize = AtomicIsize::new(0);

/// Caminho do executavel atual.
pub fn exe_path() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("bigducks-rs.exe"))
}

/// Um caminho parece temporario? Usado para NUNCA registrar autostart apontando
/// para um diretorio de build/teste.
pub fn is_temp_path(path: &Path) -> bool {
    let text = path.to_string_lossy().to_lowercase();
    if text.contains("\\temp\\") || text.contains("\\tmp\\") {
        return true;
    }
    let temp = std::env::temp_dir().to_string_lossy().to_lowercase();
    !temp.is_empty() && text.starts_with(&temp)
}

pub fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    let mut buffer: Vec<u16> = value.as_ref().encode_wide().collect();
    buffer.push(0);
    buffer
}

/// Anexa o console do processo pai ou cria um novo. Reaponta os handles padrao
/// do Rust para o console recem-criado (senao o stdout fica em lugar nenhum).
pub fn attach_console() {
    unsafe {
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            let _ = AllocConsole();
        }
        let out = CreateFileW(
            wide("CONOUT$").as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            NULL_HANDLE,
        );
        if !out.is_null() && out as isize != -1 {
            SetStdHandle(STD_OUTPUT_HANDLE, out);
            SetStdHandle(STD_ERROR_HANDLE, out);
        }
        let input = CreateFileW(
            wide("CONIN$").as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            NULL_HANDLE,
        );
        if !input.is_null() && input as isize != -1 {
            SetStdHandle(STD_INPUT_HANDLE, input);
        }
    }
}

/// Abre uma URL ou arquivo com o programa padrao (ShellExecuteW "open").
pub fn open_target(target: &str) {
    unsafe {
        let operation = wide("open");
        let file = wide(target);
        ShellExecuteW(
            NULL_HANDLE,
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
    }
}

/// Cria a janela escondida usada para mostrar os baloes (chamada na thread
/// principal, antes de qualquer balao).
pub fn create_balloon_window() {
    unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        let class_name = wide("DiscordStreamBalloon");
        let mut window_class: WNDCLASSW = std::mem::zeroed();
        window_class.lpfnWndProc = Some(DefWindowProcW);
        window_class.hInstance = instance;
        window_class.lpszClassName = class_name.as_ptr();
        // Se ja existir (segunda chamada), RegisterClassW falha e seguimos - a
        // classe continua registrada.
        RegisterClassW(&window_class);
        let window_name = wide("DiscordStream");
        let handle = CreateWindowExW(
            0,
            class_name.as_ptr(),
            window_name.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            NULL_HANDLE,
            NULL_HANDLE,
            instance,
            std::ptr::null(),
        );
        if !handle.is_null() {
            BALLOON_WINDOW.store(handle as isize, Ordering::SeqCst);
        }
    }
}

/// Mostra um balao na area de notificacao. Se a janela ainda nao existir, so'
/// ignora (o texto ja foi para o log).
pub fn balloon(title: &str, body: &str) {
    let handle = BALLOON_WINDOW.load(Ordering::SeqCst) as *mut core::ffi::c_void;
    if handle.is_null() {
        return;
    }
    let mut data: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    data.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    data.hWnd = handle;
    data.uID = 1;
    data.uFlags = NIF_ICON | NIF_TIP | NIF_INFO;
    data.hIcon = unsafe { LoadIconW(NULL_HANDLE, IDI_APPLICATION) };
    fill_utf16(&mut data.szTip, "DiscordStream");
    fill_utf16(&mut data.szInfoTitle, title);
    fill_utf16(&mut data.szInfo, body);
    data.dwInfoFlags = NIIF_INFO;
    unsafe {
        Shell_NotifyIconW(NIM_ADD, &data);
    }
    // O icone temporario so existe para o balao; remove depois que o Windows
    // ja mostrou a notificacao.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(10));
        let handle = BALLOON_WINDOW.load(Ordering::SeqCst) as *mut core::ffi::c_void;
        if handle.is_null() {
            return;
        }
        let mut data: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
        data.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        data.hWnd = handle;
        data.uID = 1;
        unsafe {
            Shell_NotifyIconW(NIM_DELETE, &data);
        }
    });
}

fn fill_utf16(destination: &mut [u16], value: &str) {
    let encoded: Vec<u16> = value.encode_utf16().take(destination.len().saturating_sub(1)).collect();
    destination[..encoded.len()].copy_from_slice(&encoded);
}

/// Bombeia mensagens na thread atual chamando `on_timer` a cada `interval`.
/// Roda ate' `stop` virar verdadeiro (o loop de bandeja tambem para com WM_QUIT).
pub fn pump_messages(interval: Duration, mut on_timer: impl FnMut()) {
    unsafe {
        let milliseconds = interval.as_millis().max(1) as u32;
        let timer = windows_sys::Win32::UI::WindowsAndMessaging::SetTimer(
            NULL_HANDLE,
            1,
            milliseconds,
            None,
        );
        let mut message: MSG = std::mem::zeroed();
        loop {
            let result = GetMessageW(&mut message, NULL_HANDLE, 0, 0);
            if result <= 0 {
                break;
            }
            if message.message == WM_TIMER {
                on_timer();
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        let _ = timer;
    }
}
