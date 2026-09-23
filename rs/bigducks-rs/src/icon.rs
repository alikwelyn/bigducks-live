//! Icone da bandeja: o MESMO desenho do exe (`imgs/big-ducks.png`), decodificado
//! em runtime e com um "ponto de estado" no canto para dizer, de relance.
//!
//! As cores sao VIVIDAS (saturadas) pra sobreviver a 16 px numa barra escura -
//! nada da paleta suave do Discord. A legenda completa vai no tooltip da bandeja
//! (ver `status::tooltip`): verde = relay conectado, ambar = sem canal de voz,
//! azul = so' o bridge local, vermelho = bridge nao instalado, roxo = atualizando,
//! cinza = ainda sem noticia. O rotulo em palavras (`status::state_label`) usa a
//! MESMA precedencia de `state_color` pra que a cor nunca seja o unico canal.

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

/// Cor VIVIDA do ponto de estado (saturada, legivel a 16 px numa barra escura).
///
/// A precedencia aqui tem que casar com `status::state_label` (o texto do
/// tooltip): roxo vence tudo, depois o bridge ausente, depois o relay. Os seis
/// tons sao escolhidos pra nao se confundirem entre si nem com o logo (o cinza
/// e' o unico dessaturado, de proposito, pra dizer "ainda nao sei").
fn state_color(installed: bool, relay: Relay, update: Update) -> [u8; 3] {
    if matches!(update, Update::Staged | Update::Installing) {
        return [0xb4, 0x4c, 0xff]; // roxo
    }
    if !installed {
        return [0xff, 0x2e, 0x3a]; // vermelho
    }
    match relay {
        Relay::Connected => [0x1b, 0xff, 0x6b], // verde
        Relay::NoVoice => [0xff, 0xb3, 0x00],   // ambar
        Relay::Local => [0x2e, 0x7b, 0xff],     // azul
        Relay::Unknown => [0x9a, 0xa4, 0xb2],   // cinza
    }
}

/// Monta o icone da bandeja para o estado atual.
///
/// NUNCA deve devolver `None` na pratica: se a conversao do logo falhar, cai num
/// icone solido de fallback - um `None` virava uma entrada VAZIA na bandeja (o
/// "icone sem bitmap" do bug). O `tray.rs` tambem recusa criar a entrada sem
/// bitmap, entao este caminho e' a ultima linha de defesa.
pub fn tray_icon(installed: bool, relay: Relay, update: Update) -> Option<Icon> {
    let mut pixels = base_logo().clone();
    let color = state_color(installed, relay, update);
    draw_status_dot(&mut pixels, color);
    let (width, height) = pixels.dimensions();
    match Icon::from_rgba(pixels.into_raw(), width, height) {
        Ok(icon) => Some(icon),
        Err(error) => {
            crate::log_warn!(
                "icone: from_rgba com o logo falhou ({error}) - usando fallback solido"
            );
            solid_icon(color)
        }
    }
}

/// Fallback: bloco solido escuro com o mesmo ponto de estado. So' usado se o
/// logo embutido nao puder virar `Icon` (nao deve acontecer).
fn solid_icon(color: [u8; 3]) -> Option<Icon> {
    let mut pixels = RgbaImage::new(SIZE, SIZE);
    for pixel in pixels.pixels_mut() {
        pixel.0 = [0x1e, 0x1f, 0x22, 0xff];
    }
    draw_status_dot(&mut pixels, color);
    Icon::from_rgba(pixels.into_raw(), SIZE, SIZE).ok()
}

/// Circulo na parte inferior-direita, com um anel branco pra destacar.
///
/// O anel e' mais grosso que antes (2 px em vez de 1.5) pra o ponto "saltar" em
/// qualquer fundo (barra clara ou escura) sem depender do logo por baixo.
fn draw_status_dot(image: &mut RgbaImage, color: [u8; 3]) {
    let size = image.width() as f32;
    let center = (size - 9.0, size - 9.0);
    let radius = 7.0_f32;
    let ring = 2.0_f32;
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
