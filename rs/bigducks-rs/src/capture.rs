//! Screen capture for bigducks-rs.
//!
//! Suporta duas fontes escolhidas no modal do Discord:
//!   screen:<displayId>:<index>  -> aquele monitor
//!   window:<handle>             -> aquela janela
//! O resto (downscale) e um box filter puro em Rust, sem compilador C.

use anyhow::{anyhow, Result};
#[cfg(windows)]
use std::time::Duration;
use std::time::Instant;
use xcap::{Monitor, Window};

#[cfg(windows)]
mod continuous {
    use std::sync::mpsc::{self, Receiver, SyncSender};
    use std::time::Duration;
    use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
    use windows_capture::frame::Frame;
    use windows_capture::graphics_capture_api::InternalCaptureControl;
    use windows_capture::settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    };
    use windows_capture::window::Window;

    type RawFrame = (Vec<u8>, u32, u32);

    struct FrameHandler {
        tx: SyncSender<RawFrame>,
    }

    impl GraphicsCaptureApiHandler for FrameHandler {
        type Flags = SyncSender<RawFrame>;
        type Error = String;

        fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
            Ok(Self { tx: ctx.flags })
        }

        fn on_frame_arrived(
            &mut self,
            frame: &mut Frame,
            _control: InternalCaptureControl,
        ) -> Result<(), Self::Error> {
            let width = frame.width();
            let height = frame.height();
            let buffer = frame.buffer().map_err(|error| error.to_string())?;
            let mut packed = Vec::new();
            let pixels = buffer.as_nopadding_buffer(&mut packed).to_vec();
            // A captura nao espera WebSocket/codificador: descarta quadros antigos.
            let _ = self.tx.try_send((pixels, width, height));
            Ok(())
        }
    }

    pub struct WindowCapture {
        control: Option<CaptureControl<FrameHandler, String>>,
        rx: Receiver<RawFrame>,
        last: Option<RawFrame>,
    }

    impl WindowCapture {
        pub fn start(id: u32) -> Result<Self, String> {
            let (tx, rx) = mpsc::sync_channel(2);
            let window = Window::from_raw_hwnd(id as usize as *mut std::ffi::c_void);
            let settings = Settings::new(
                window,
                CursorCaptureSettings::Default,
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Rgba8,
                tx,
            );
            let control =
                FrameHandler::start_free_threaded(settings).map_err(|error| error.to_string())?;
            Ok(Self {
                control: Some(control),
                rx,
                last: None,
            })
        }

        pub fn next_frame(&mut self) -> Option<RawFrame> {
            if self
                .control
                .as_ref()
                .is_some_and(|control| control.is_finished())
            {
                return None;
            }
            if self.last.is_none() {
                self.last = self.rx.recv_timeout(Duration::from_millis(100)).ok();
            }
            while let Ok(newest) = self.rx.try_recv() {
                self.last = Some(newest);
            }
            self.last.clone()
        }

        pub fn is_finished(&self) -> bool {
            self.control
                .as_ref()
                .is_some_and(|control| control.is_finished())
        }

        pub fn stop(&mut self) {
            if let Some(control) = self.control.take() {
                let _ = control.stop();
            }
        }
    }

    impl Drop for WindowCapture {
        fn drop(&mut self) {
            self.stop();
        }
    }
}

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
        _ => value.trim().parse::<u32>().ok().map(|number| {
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
pub struct Capturer {
    cached_window: Option<(u32, Window)>,
    cached_process: Option<(u32, Window)>,
    #[cfg(windows)]
    continuous_window: Option<(u32, continuous::WindowCapture)>,
    #[cfg(windows)]
    continuous_failed: Option<(u32, Instant)>,
    stats_at: Instant,
    stats_frames: u64,
    source_time_us: u128,
    scale_time_us: u128,
}

impl Capturer {
    pub fn new() -> Result<Self> {
        Ok(Self {
            cached_window: None,
            cached_process: None,
            #[cfg(windows)]
            continuous_window: None,
            #[cfg(windows)]
            continuous_failed: None,
            stats_at: Instant::now(),
            stats_frames: 0,
            source_time_us: 0,
            scale_time_us: 0,
        })
    }

    /// Devolve (RGBA, largura, altura) da fonte escolhida.
    fn source_image(&mut self, selection: &Selection) -> Result<(Vec<u8>, u32, u32)> {
        #[cfg(windows)]
        if !matches!(selection, Selection::Window(_)) {
            self.continuous_window = None;
        }
        match selection {
            Selection::Window(id) => {
                #[cfg(windows)]
                {
                    if self.continuous_window.as_ref().map(|(current, _)| current) != Some(id) {
                        self.continuous_window = None;
                        let cooling_down =
                            self.continuous_failed
                                .as_ref()
                                .is_some_and(|(failed_id, at)| {
                                    failed_id == id && at.elapsed() < Duration::from_secs(5)
                                });
                        if !cooling_down {
                            match continuous::WindowCapture::start(*id) {
                                Ok(capture) => {
                                    crate::logging::write_line(&format!(
                                        "capture: WGC continuo iniciado para janela {id}"
                                    ));
                                    self.continuous_window = Some((*id, capture));
                                    self.continuous_failed = None;
                                }
                                Err(error) => {
                                    crate::logging::write_line(&format!(
                                        "capture: WGC continuo indisponivel ({error}); usando GDI"
                                    ));
                                    self.continuous_failed = Some((*id, Instant::now()));
                                }
                            }
                        }
                    }
                    if let Some((_, capture)) = &mut self.continuous_window {
                        if let Some(frame) = capture.next_frame() {
                            return Ok(frame);
                        }
                        if capture.is_finished() {
                            self.continuous_window = None;
                            self.continuous_failed = Some((*id, Instant::now()));
                            crate::logging::write_line(
                                "capture: WGC continuo encerrou; usando GDI temporariamente",
                            );
                        }
                    }
                }
                if self.cached_window.as_ref().map(|(current, _)| current) != Some(id) {
                    self.cached_window = Window::all()?
                        .into_iter()
                        .find(|window| window.id().ok() == Some(*id))
                        .map(|window| (*id, window));
                }
                if let Some((_, window)) = &self.cached_window {
                    if let Ok(image) = window.capture_image() {
                        let (width, height) = (image.width(), image.height());
                        return Ok((image.into_raw(), width, height));
                    }
                    self.cached_window = None;
                }
                // Janela sumiu/fechou: cai no monitor principal.
                let monitors = Monitor::all()?;
                let monitor = monitors
                    .into_iter()
                    .next()
                    .ok_or_else(|| anyhow!("no monitor"))?;
                let image = monitor.capture_image()?;
                let (width, height) = (image.width(), image.height());
                Ok((image.into_raw(), width, height))
            }
            Selection::Process(pid) => {
                if self.cached_process.as_ref().map(|(current, _)| current) != Some(pid) {
                    self.cached_process = Window::all()?
                        .into_iter()
                        .find(|window| window.pid().ok() == Some(*pid))
                        .map(|window| (*pid, window));
                }
                if let Some((_, window)) = &self.cached_process {
                    if let Ok(image) = window.capture_image() {
                        let (width, height) = (image.width(), image.height());
                        return Ok((image.into_raw(), width, height));
                    }
                    self.cached_process = None;
                }
                // Nao achou a janela: monitor principal.
                let monitors = Monitor::all()?;
                let monitor = monitors
                    .into_iter()
                    .next()
                    .ok_or_else(|| anyhow!("no monitor"))?;
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
    pub fn capture(&mut self, selection: &Selection, width: u32, height: u32) -> Result<Vec<u8>> {
        let started = Instant::now();
        let (raw, source_width, source_height) = self.source_image(selection)?;
        self.source_time_us += started.elapsed().as_micros();
        let scale_started = Instant::now();
        let result = if source_width == width && source_height == height {
            raw
        } else if source_width.abs_diff(width) * 10 < source_width
            && source_height.abs_diff(height) * 10 < source_height
        {
            scale_rgba_nearest(&raw, source_width, source_height, width, height)
        } else {
            scale_rgba(&raw, source_width, source_height, width, height)
        };
        self.scale_time_us += scale_started.elapsed().as_micros();
        self.stats_frames += 1;
        if self.stats_at.elapsed().as_secs() >= 10 {
            crate::logging::write_line(&format!(
                "capture-etapas: fonte {}x{} -> {}x{}, origem {:.1} ms, escala {:.1} ms",
                source_width,
                source_height,
                width,
                height,
                self.source_time_us as f64 / self.stats_frames as f64 / 1000.0,
                self.scale_time_us as f64 / self.stats_frames as f64 / 1000.0,
            ));
            self.stats_at = Instant::now();
            self.stats_frames = 0;
            self.source_time_us = 0;
            self.scale_time_us = 0;
        }
        Ok(result)
    }
}

fn scale_rgba_nearest(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
    let mut out = vec![0u8; dw as usize * dh as usize * 4];
    for y in 0..dh as usize {
        let source_row = (y * sh as usize / dh as usize) * sw as usize * 4;
        let output_row = y * dw as usize * 4;
        for x in 0..dw as usize {
            let source = source_row + (x * sw as usize / dw as usize) * 4;
            let output = output_row + x * 4;
            out[output..output + 4].copy_from_slice(&src[source..source + 4]);
        }
    }
    out
}

fn scale_rgba(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
    use fast_image_resize::{images::Image, PixelType, Resizer};

    let Ok(source) = Image::from_vec_u8(sw, sh, src.to_vec(), PixelType::U8x4) else {
        return scale_rgba_nearest(src, sw, sh, dw, dh);
    };
    let mut destination = Image::new(dw, dh, PixelType::U8x4);
    if Resizer::new()
        .resize(&source, &mut destination, None)
        .is_ok()
    {
        destination.buffer().to_vec()
    } else {
        scale_rgba_nearest(src, sw, sh, dw, dh)
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
    let (width, height) = (
        (rect.right - rect.left) as u32,
        (rect.bottom - rect.top) as u32,
    );
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
