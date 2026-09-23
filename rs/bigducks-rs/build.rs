//! Build script: gera o icone multi-tamanho (16/24/32/48/64/256) a partir do
//! MESMO logo que o app Go usa (`imgs/big-ducks.png`, ver `internal/brand/brand.go`)
//! e embute no `.exe` via `winresource`.
//!
//! O ICO e montado a mao (mesma tecnica do `buildICO` do Go): cada frame e um PNG
//! RGBA 32bpp. Assim o exe e a bandeja usam exatamente o mesmo desenho.
//!
//! So roda no Windows: no container Linux do relay o arquivo nem e copiado.

#[cfg(not(windows))]
fn main() {}

#[cfg(windows)]
fn main() {
    imp::run();
}

#[cfg(windows)]
mod imp {
    use std::env;
    use std::fs;
    use std::path::PathBuf;

    /// Logo compartilhado com o lado Go, relativo a este projeto (`rs/bigducks-rs`).
    const LOGO_RELATIVE: &str = "../../imgs/big-ducks.png";
    const SIZES: [u32; 6] = [16, 24, 32, 48, 64, 256];

    pub fn run() {
        let manifest_dir =
            PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
        let logo = manifest_dir.join(LOGO_RELATIVE);
        println!("cargo:rerun-if-changed={}", logo.display());
        println!("cargo:rerun-if-changed=build.rs");

        let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
        let ico_path = out_dir.join("big-ducks.ico");

        match fs::read(&logo) {
            Ok(png) => match build_ico(&png, &SIZES) {
                Ok(ico) => {
                    if let Err(error) = fs::write(&ico_path, &ico) {
                        println!(
                            "cargo:warning=nao consegui escrever {}: {error}",
                            ico_path.display()
                        );
                    }
                }
                Err(error) => println!("cargo:warning=nao consegui montar o .ico: {error}"),
            },
            Err(error) => println!(
                "cargo:warning=logo {} nao encontrado: {error}",
                logo.display()
            ),
        }

        if ico_path.exists() {
            let mut resource = winresource::WindowsResource::new();
            resource.set_icon(ico_path.to_str().expect("ico path"));
            resource.set("ProductName", "Desjanjador");
            resource.set("FileDescription", "Desjanjador - ponte de compartilhamento de tela");
            resource.set("CompanyName", "Desjanjador");
            resource.set("OriginalFilename", "Desjanjador.exe");
            if let Err(error) = resource.compile() {
                println!("cargo:warning=winresource nao embutiu o icone: {error}");
            }
        }
    }

    /// Monta um ICO multi-tamanho com frames PNG (mesma tecnica do Go `buildICO`).
    fn build_ico(source: &[u8], sizes: &[u32]) -> Result<Vec<u8>, String> {
        use image::codecs::png::PngEncoder;
        use image::{imageops::FilterType, ImageEncoder};

        let decoded = image::load_from_memory(source).map_err(|error| error.to_string())?;

        let mut frames: Vec<Vec<u8>> = Vec::with_capacity(sizes.len());
        for &size in sizes {
            if size == 0 || size > 256 {
                return Err(format!("tamanho de icone invalido: {size}"));
            }
            let resized = decoded
                .resize_exact(size, size, FilterType::Lanczos3)
                .to_rgba8();
            let mut encoded = Vec::new();
            PngEncoder::new(&mut encoded)
                .write_image(resized.as_raw(), size, size, image::ExtendedColorType::Rgba8)
                .map_err(|error| format!("encode {size}px: {error}"))?;
            frames.push(encoded);
        }

        const HEADER_SIZE: usize = 6;
        let directory_size = frames.len() * 16;
        let total = HEADER_SIZE + directory_size + frames.iter().map(Vec::len).sum::<usize>();
        let mut icon = vec![0u8; total];

        icon[2..4].copy_from_slice(&1u16.to_le_bytes()); // tipo: 1 = ICON
        icon[4..6].copy_from_slice(&(frames.len() as u16).to_le_bytes());

        let mut offset = HEADER_SIZE + directory_size;
        for (index, frame) in frames.iter().enumerate() {
            let size = sizes[index];
            let entry = &mut icon[HEADER_SIZE + index * 16..HEADER_SIZE + (index + 1) * 16];
            // 256 e' codificado como 0 no diretorio (byte unico).
            entry[0] = if size >= 256 { 0 } else { size as u8 };
            entry[1] = if size >= 256 { 0 } else { size as u8 };
            entry[2] = 0; // cores da paleta
            entry[3] = 0; // reservado
            entry[4..6].copy_from_slice(&1u16.to_le_bytes());
            entry[6..8].copy_from_slice(&32u16.to_le_bytes()); // 32bpp
            entry[8..12].copy_from_slice(&(frame.len() as u32).to_le_bytes());
            entry[12..16].copy_from_slice(&(offset as u32).to_le_bytes());
            icon[offset..offset + frame.len()].copy_from_slice(frame);
            offset += frame.len();
        }

        Ok(icon)
    }
}
