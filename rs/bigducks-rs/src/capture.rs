//! Screen capture for bigducks-rs.
//!
//! Suporta duas fontes escolhidas no modal do Discord:
//!   screen:<displayId>:<index>  -> aquele monitor
//!   window:<handle>             -> aquela janela
//! O resto (downscale) e um box filter puro em Rust, sem compilador C.

use anyhow::{anyhow, Result};
use xcap::{Monitor, Window};

/// O que capturar. Vem do `sourceId` que o Discord manda no STREAM_START.
#[derive(Clone, Debug)]
pub enum Selection {
    Monitor(usize),
    Window(u32),
    // O Discord manda o PID quando voce compartilha uma JANELA/aplicativo.
    Process(u32),
    // Handle de monitor (HMONITOR no Windows) - e o que o modal manda quando
    // voce escolhe uma TELA.
    Screen(u32),
}

impl Default for Selection {
    fn default() -> Self {
        Selection::Monitor(0)
    }
}

/// Interpreta o `sourceId` do Discord.
///
/// Formato do Electron: `screen:<displayId>:<indice>` e `window:<handle>`.
pub fn parse_selection(value: &str) -> Option<Selection> {
    let parts: Vec<&str> = value.split(':').collect();
    match parts.first().copied() {
        Some("screen") => Some(Selection::Monitor(screen_index(&parts))),
        // "window:123456" -> handle da janela (HWND no Windows)
        Some("window") => parts
            .get(1)
            .and_then(|piece| piece.parse::<u32>().ok())
            .map(Selection::Window),
        // Handle de monitor (HMONITOR no Windows): e o formato que o modal do
        // Discord manda pra TELA. Traduzido pro monitor do xcap pelo retangulo.
        Some("screen-handle") => parts
            .get(1)
            .and_then(|piece| piece.parse::<u32>().ok())
            .map(Selection::Screen),
        // Fallback: o Discord as vezes manda o id cru (so o numero). Numero
        // pequeno e indice de monitor; numero grande e handle de janela (HWND).
        _ => value
            .trim()
            .parse::<u32>()
            .ok()
            .map(|number| {
                if number < 16 {
                    Selection::Monitor(number as usize)
                } else {
                    Selection::Window(number)
                }
            }),
    }
}

/// O indice do monitor pode estar no meio (`screen:1:0`) ou no fim
/// (`screen:0:1`). Escolhe o segmento que parece um indice plausivel.
fn screen_index(parts: &[&str]) -> usize {
    let parse = |piece: Option<&&str>| piece.and_then(|p| p.parse::<usize>().ok());
    match (parse(parts.get(1)), parse(parts.last())) {
        (_, Some(last)) if last != 0 && last < 16 => last,
        (Some(middle), _) if middle < 16 => middle,
        _ => 0,
    }
}

/// A captura nao guarda mais tamanho fixo: o alvo vem a cada chamada, porque o
/// painel do Discord pode mudar a qualidade (resolucao/fps) ao vivo.
pub struct Capturer;

impl Capturer {
    pub fn new() -> Result<Self> {
        Ok(Self)
    }

    /// Devolve (RGBA, largura, altura) da fonte escolhida.
    fn source_image(&self, selection: &Selection) -> Result<(Vec<u8>, u32, u32)> {
        match selection {
            Selection::Window(id) => {
                for window in Window::all()? {
                    let matches = window.id().map(|current| current == *id).unwrap_or(false);
                    if !matches {
                        continue;
                    }
                    if let Ok(image) = window.capture_image() {
                        let (width, height) = (image.width(), image.height());
                        return Ok((image.into_raw(), width, height));
                    }
                    break;
                }
                // Janela sumiu/fechou: cai no monitor principal.
                let monitors = Monitor::all()?;
                let monitor = monitors.into_iter().next().ok_or_else(|| anyhow!("no monitor"))?;
                let image = monitor.capture_image()?;
                let (width, height) = (image.width(), image.height());
                Ok((image.into_raw(), width, height))
            }
            Selection::Process(pid) => {
                for window in Window::all()? {
                    if window.pid().map(|current| current == *pid).unwrap_or(false) {
                        if let Ok(image) = window.capture_image() {
                            let (width, height) = (image.width(), image.height());
                            return Ok((image.into_raw(), width, height));
                        }
                    }
                }
                // Nao achou a janela: monitor principal.
                let monitors = Monitor::all()?;
                let monitor = monitors.into_iter().next().ok_or_else(|| anyhow!("no monitor"))?;
                let image = monitor.capture_image()?;
                let (width, height) = (image.width(), image.height());
                Ok((image.into_raw(), width, height))
            }
            Selection::Monitor(index) => {
                let monitors = Monitor::all()?;
                let monitor = monitors
                    .get(*index)
                    .or_else(|| monitors.first())
                    .ok_or_else(|| anyhow!("no monitor"))?;
                let image = monitor.capture_image()?;
                let (width, height) = (image.width(), image.height());
                Ok((image.into_raw(), width, height))
            }
            // Tela escolhida no modal: o Discord manda o HMONITOR, nao o indice.
            Selection::Screen(handle) => {
                let index = monitor_index_from_handle(*handle).unwrap_or(0);
                let monitors = Monitor::all()?;
                let monitor = monitors
                    .get(index)
                    .or_else(|| monitors.first())
                    .ok_or_else(|| anyhow!("no monitor"))?;
                let image = monitor.capture_image()?;
                let (width, height) = (image.width(), image.height());
                Ok((image.into_raw(), width, height))
            }
        }
    }

    /// Captura a fonte escolhida e devolve RGBA no tamanho alvo.
    pub fn capture(&self, selection: &Selection, width: u32, height: u32) -> Result<Vec<u8>> {
        let (raw, source_width, source_height) = self.source_image(selection)?;
        if source_width == width && source_height == height {
            return Ok(raw);
        }
        Ok(scale_rgba(&raw, source_width, source_height, width, height))
    }
}

/// Traduz o handle de monitor do Discord (HMONITOR) para o indice do xcap,
/// casando pelo retangulo do monitor.
#[cfg(windows)]
fn monitor_index_from_handle(handle: u32) -> Option<usize> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITORINFO};

    let mut info: MONITORINFO = unsafe { zeroed() };
    info.cbSize = size_of::<MONITORINFO>() as u32;
    let ok = unsafe { GetMonitorInfoW(handle as *mut core::ffi::c_void, &mut info) };
    if ok == 0 {
        return None;
    }
    let rect = info.rcMonitor;
    let (left, top) = (rect.left, rect.top);
    let (width, height) = ((rect.right - rect.left) as u32, (rect.bottom - rect.top) as u32);
    for (index, monitor) in Monitor::all().ok()?.iter().enumerate() {
        let same = monitor.x().ok() == Some(left)
            && monitor.y().ok() == Some(top)
            && monitor.width().ok() == Some(width)
            && monitor.height().ok() == Some(height);
        if same {
            return Some(index);
        }
    }
    None
}

#[cfg(not(windows))]
fn monitor_index_from_handle(_handle: u32) -> Option<usize> {
    None
}

/// Box-filter downscale from `sw x sh` to `dw x dh`, always producing opaque RGBA.
pub fn scale_rgba(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
    let mut out = vec![0u8; (dw as usize) * (dh as usize) * 4];
    for y in 0..dh {
        let sy0 = y * sh / dh;
        let sy1 = ((y + 1) * sh / dh).max(sy0 + 1).min(sh);
        for x in 0..dw {
            let sx0 = x * sw / dw;
            let sx1 = ((x + 1) * sw / dw).max(sx0 + 1).min(sw);
            let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
            for sy in sy0..sy1 {
                let row = (sy * sw) as usize * 4;
                for sx in sx0..sx1 {
                    let i = row + (sx as usize) * 4;
                    r += src[i] as u32;
                    g += src[i + 1] as u32;
                    b += src[i + 2] as u32;
                    n += 1;
                }
            }
            let n = n.max(1);
            let o = ((y * dw + x) as usize) * 4;
            out[o] = (r / n) as u8;
            out[o + 1] = (g / n) as u8;
            out[o + 2] = (b / n) as u8;
            out[o + 3] = 255;
        }
    }
    out
}
