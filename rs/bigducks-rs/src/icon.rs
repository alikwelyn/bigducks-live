//! Icone da bandeja: o MESMO desenho do exe (`imgs/big-ducks.png`), decodificado
//! em runtime e com um "ponto de estado" no canto para dizer, de relance:
//! verde = relay conectado, ambar = sem canal de voz, azul = so' o bridge local,
//! vermelho = bridge nao instalado, roxo = atualizacao pronta.

use std::sync::OnceLock;

use image::{imageops::FilterType, RgbaImage};
use tray_icon::Icon;

use crate::status::{Relay, Update};

const LOGO_PNG: &[u8] = include_bytes!("../../../imgs/big-ducks.png");
const SIZE: u32 = 32;

fn base_logo() -> &'static RgbaImage {
    static BASE: OnceLock<RgbaImage> = OnceLock::new();
    BASE.get_or_init(|| {
        let decoded = image::load_from_memory(LOGO_PNG).expect("logo embutido invalido");
        decoded.resize_exact(SIZE, SIZE, FilterType::Lanczos3).to_rgba8()
    })
}

/// Cor do ponto de estado.
fn state_color(installed: bool, relay: Relay, update: Update) -> [u8; 3] {
    if matches!(update, Update::Staged | Update::Installing) {
        return [0x8b, 0x5c, 0xf6];
    }
    if !installed {
        return [0xed, 0x42, 0x45];
    }
    match relay {
        Relay::Connected => [0x23, 0xa5, 0x5a],
        Relay::NoVoice => [0xfe, 0xa1, 0x1c],
        Relay::Local => [0x58, 0x65, 0xf2],
        Relay::Unknown => [0x80, 0x8a, 0x9a],
    }
}

/// Monta o icone da bandeja para o estado atual.
pub fn tray_icon(installed: bool, relay: Relay, update: Update) -> Option<Icon> {
    let mut pixels = base_logo().clone();
    let color = state_color(installed, relay, update);
    draw_status_dot(&mut pixels, color);
    let (width, height) = pixels.dimensions();
    Icon::from_rgba(pixels.into_raw(), width, height).ok()
}

/// Circulo na parte inferior-direita, com um anel branco pra destacar.
fn draw_status_dot(image: &mut RgbaImage, color: [u8; 3]) {
    let size = image.width() as f32;
    let center = (size - 9.0, size - 9.0);
    let radius = 6.5_f32;
    let ring = 1.5_f32;
    for y in 0..image.height() {
        for x in 0..image.width() {
            let dx = x as f32 + 0.5 - center.0;
            let dy = y as f32 + 0.5 - center.1;
            let distance = (dx * dx + dy * dy).sqrt();
            let (rgb, alpha) = if distance <= radius - ring {
                (color, 1.0_f32)
            } else if distance <= radius {
                ([0xff, 0xff, 0xff], 1.0_f32)
            } else {
                continue;
            };
            blend(image, x, y, rgb, alpha);
        }
    }
}

fn blend(image: &mut RgbaImage, x: u32, y: u32, rgb: [u8; 3], alpha: f32) {
    let pixel = image.get_pixel_mut(x, y);
    let base = pixel.0;
    for channel in 0..3 {
        let mixed = rgb[channel] as f32 * alpha + base[channel] as f32 * (1.0 - alpha);
        pixel.0[channel] = mixed.round().clamp(0.0, 255.0) as u8;
    }
    pixel.0[3] = 255;
}
