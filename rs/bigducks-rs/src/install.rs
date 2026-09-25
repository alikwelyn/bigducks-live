//! Injecao automatica no Discord original (modelo Vencord).
//!
//! O Discord carrega `resources/app.asar`. Se esse caminho for uma PASTA com
//! `package.json` + `index.js`, o Electron executa esse `index.js` no processo
//! principal. A gente usa isso: move o asar original para
//! `DiscordStream/injection-backups/` e coloca no lugar um `index.js` que
//! carrega o nosso bridge e depois o asar original.
//!
//! Resultado: o Discord sobe ja com o bridge ativo. Nada de colar no console.
//!
//! O `install()` devolve um relatorio (`installed`/`flavours`/`stamp`). A decisao
//! de reiniciar o Discord NAO vem de o JS ter mudado de bytes nesta execucao: quem
//! decide e' o carimbo da injecao comparado com a hora de inicio do processo (ver
//! `src/discord.rs`).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};

const MAIN_BRIDGE: &str = include_str!("../web/main-bridge.js");
const PRELOAD: &str = include_str!("../web/preload.js");
const RENDERER_BRIDGE: &str = include_str!("../web/renderer.js");
const MARKER: &str = "bigducks-rs stub v1";
const INSTALLS: [&str; 4] = [
    "Discord",
    "DiscordCanary",
    "DiscordPTB",
    "DiscordDevelopment",
];

/// Resultado de uma rodada de instalacao.
pub struct InstallReport {
    pub lines: Vec<String>,
    /// Pelo menos uma instalacao do Discord tem o bridge.
    pub installed: bool,
    /// Sabores (Discord/Canary/...) que receberam a injecao.
    pub flavours: Vec<String>,
    /// Instante em que a injecao foi (re)afirmada nesta rodada (o carimbo).
    pub stamp: Option<SystemTime>,
}

pub fn data_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("DiscordStream")
}

/// Arquivo que registra QUANDO a injecao foi (re)afirmada por ultimo, em unix
/// segundos. Fica SEPARADO do `write_if_changed`: mesmo quando o JS nao muda
/// nenhum byte, a injecao foi reescrita no disco nesta execucao - e e' isso que
/// decide se um Discord que ja esta rodando subiu ANTES (leu o asar velho) ou
/// DEPOIS (ja' tem o bridge) dela.
const STAMP_FILE: &str = "injected-at.txt";

/// `%LOCALAPPDATA%\DiscordStream\injected-at.txt`.
pub fn stamp_path() -> PathBuf {
    data_dir().join(STAMP_FILE)
}

/// Grava o carimbo da injecao (unix segundos) e devolve o instante gravado.
pub fn write_stamp() -> Result<SystemTime> {
    let now = SystemTime::now();
    let seconds = now
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_secs())
        .unwrap_or(0);
    let path = stamp_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("criar {}", parent.display()))?;
    }
    fs::write(&path, format!("{seconds}\n"))
        .with_context(|| format!("escrever {}", path.display()))?;
    Ok(now)
}

/// Le o carimbo da injecao (unix segundos). `None` = nunca injetamos aqui.
pub fn read_stamp() -> Option<SystemTime> {
    let text = fs::read_to_string(stamp_path()).ok()?;
    let seconds: u64 = text.trim().parse().ok()?;
    Some(UNIX_EPOCH + Duration::from_secs(seconds))
}

/// `18:05:40Z` (UTC, sem dependencia externa) - usado nas decisoes de reinicio.
pub fn fmt_time(time: SystemTime) -> String {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_secs())
        .unwrap_or(0);
    let rem = seconds % 86_400;
    format!(
        "{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn js_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Escreve so' quando o conteudo muda.
fn write_if_changed(path: &Path, contents: &[u8]) -> Result<()> {
    if let Ok(existing) = fs::read(path) {
        if existing == contents {
            return Ok(());
        }
    }
    fs::write(path, contents).with_context(|| format!("escrever {}", path.display()))?;
    Ok(())
}

/// Grava os arquivos do bridge no diretorio de dados (so' quando o conteudo muda).
fn write_bridges(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir).with_context(|| format!("criar {}", dir.display()))?;
    write_if_changed(&dir.join("bigducks_rs_bridge.js"), MAIN_BRIDGE.as_bytes())?;
    write_if_changed(&dir.join("bigducks_rs_preload.js"), PRELOAD.as_bytes())?;
    write_if_changed(
        &dir.join("bigducks_rs_renderer.js"),
        RENDERER_BRIDGE.as_bytes(),
    )?;
    Ok(())
}

/// Encontra a instalacao mais recente (app-x.y.z) de cada sabor presente.
fn latest_apps() -> Vec<(String, PathBuf, String)> {
    let base = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string()));
    let mut found = Vec::new();
    for name in INSTALLS {
        let root = base.join(name);
        if !root.is_dir() {
            continue;
        }
        let mut best: Option<(Vec<u64>, PathBuf, String)> = None;
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            let Some(version_text) = dir_name.strip_prefix("app-") else {
                continue;
            };
            let version: Vec<u64> = version_text
                .split('.')
                .map_while(|part| part.parse::<u64>().ok())
                .collect();
            if version.is_empty() {
                continue;
            }
            let path = entry.path();
            if !path.join("resources").is_dir() {
                continue;
            }
            if best
                .as_ref()
                .map_or(true, |(current, _, _)| &version > current)
            {
                best = Some((version, path, version_text.to_string()));
            }
        }
        if let Some((_, path, version)) = best {
            found.push((name.to_string(), path, version));
        }
    }
    found
}

/// Procura o `require("....asar")` do stub atual, para preservar o app original.
fn existing_backup(index: &Path) -> Option<String> {
    let text = fs::read_to_string(index).ok()?;
    for line in text.lines() {
        let Some(start) = line.find("require(\"") else {
            continue;
        };
        let rest = &line[start + "require(\"".len()..];
        let Some(end) = rest.find('"') else {
            continue;
        };
        let path = &rest[..end];
        if path.ends_with(".asar") {
            return Some(path.to_string());
        }
    }
    None
}

fn stub_contents(bridge: &Path, backup: &str) -> (Vec<u8>, Vec<u8>) {
    let package = b"{\"name\":\"discord\",\"main\":\"index.js\",\"version\":\"1.0.0\"}".to_vec();
    let index = format!(
        "// {MARKER}\ntry {{ require(\"{}\"); }} catch (error) {{ console.error(\"[bigducks-rs]\", error && error.message); }}\nrequire(\"{backup}\");\n",
        js_path(bridge)
    )
    .into_bytes();
    (package, index)
}

fn write_stub_files(stub_dir: &Path, bridge: &Path, backup: &str) -> Result<()> {
    fs::create_dir_all(stub_dir)?;
    let (package, index) = stub_contents(bridge, backup);
    write_if_changed(&stub_dir.join("package.json"), &package)?;
    write_if_changed(&stub_dir.join("index.js"), &index)?;
    Ok(())
}

/// Instala (ou atualiza) o bridge em todas as instalacoes presentes.
pub fn install() -> Result<InstallReport> {
    let data = data_dir();
    write_bridges(&data)?;
    let bridge = data.join("bigducks_rs_bridge.js");
    let backup_dir = data.join("injection-backups");
    fs::create_dir_all(&backup_dir)?;

    let mut report = Vec::new();
    let mut installed = false;
    let mut flavours = Vec::new();
    for (flavour, app_dir, version) in latest_apps() {
        let resources = app_dir.join("resources");
        let asar = resources.join("app.asar");
        let stub_dir = resources.join("app.asar");

        if asar.is_file() {
            let backup = backup_dir.join(format!("{flavour}-{version}.asar"));
            if !backup.exists() {
                fs::copy(&asar, &backup)
                    .with_context(|| format!("backup de {}", asar.display()))?;
            }
            fs::remove_file(&asar).with_context(|| format!("remover {}", asar.display()))?;
            write_stub_files(&stub_dir, &bridge, &js_path(&backup))?;
            // Converteu asar -> pasta: injecao aplicada.
            installed = true;
            flavours.push(flavour.clone());
            report.push(format!(
                "{flavour} {version}: injetado (asar guardado em {})",
                backup.display()
            ));
        } else if asar.is_dir() {
            let index = stub_dir.join("index.js");
            let backup = existing_backup(&index).ok_or_else(|| {
                anyhow::anyhow!(
                    "{} ja e uma pasta mas nao tem backup do app original; deixando intacto",
                    asar.display()
                )
            });
            match backup {
                Ok(backup) => {
                    write_stub_files(&stub_dir, &bridge, &backup)?;
                    installed = true;
                    flavours.push(flavour.clone());
                    report.push(format!("{flavour} {version}: atualizado"));
                }
                Err(error) => report.push(format!("{flavour} {version}: ignorado ({error})")),
            }
        } else {
            report.push(format!("{flavour} {version}: app.asar nao encontrado"));
        }
    }
    if report.is_empty() {
        report.push("nenhuma instalacao do Discord encontrada".to_string());
    }

    // Carimbo: SEMPRE que a injecao foi aplicada (mesmo sem mudar um byte),
    // registra o instante. E' a base da decisao de reiniciar um Discord que ja'
    // esta rodando (ver src/discord.rs).
    let stamp = if installed {
        match write_stamp() {
            Ok(stamp) => {
                report.push(format!(
                    "injecao carimbada em {} (injected-at.txt)",
                    fmt_time(stamp)
                ));
                Some(stamp)
            }
            Err(error) => {
                report.push(format!("carimbo da injecao falhou: {error:#}"));
                read_stamp()
            }
        }
    } else {
        None
    };

    Ok(InstallReport {
        lines: report,
        installed,
        flavours,
        stamp,
    })
}

/// Remove o stub e devolve o app.asar original.
pub fn uninstall() -> Result<Vec<String>> {
    let data = data_dir();
    let mut report = Vec::new();
    for (flavour, app_dir, version) in latest_apps() {
        let stub_dir = app_dir.join("resources").join("app.asar");
        if !stub_dir.is_dir() {
            report.push(format!("{flavour} {version}: sem stub"));
            continue;
        }
        let index = stub_dir.join("index.js");
        let Some(backup) = existing_backup(&index) else {
            report.push(format!("{flavour} {version}: backup nao encontrado"));
            continue;
        };
        let backup_path = PathBuf::from(backup.replace("\\\\", "\\"));
        if !backup_path.exists() {
            report.push(format!(
                "{flavour} {version}: arquivo de backup ausente ({backup})"
            ));
            continue;
        }
        fs::remove_dir_all(&stub_dir)?;
        fs::copy(&backup_path, &stub_dir)?;
        report.push(format!("{flavour} {version}: restaurado"));
    }
    let _ = fs::remove_file(data.join("bigducks_rs_bridge.js"));
    let _ = fs::remove_file(data.join("bigducks_rs_preload.js"));
    let _ = fs::remove_file(data.join("bigducks_rs_renderer.js"));
    Ok(report)
}
