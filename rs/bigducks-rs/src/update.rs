//! Auto-update espelhando o sistema do app Go (internal/update): versao + manifest
//! JSON servido pelo NOSSO relay, download do .exe, troca do binario em execucao
//! (rename -> .old, poe o novo no lugar, reabre, apaga o .old no proximo boot).
//!
//! Diferenca consciente: o Go assina o manifest com Ed25519 (chave no GitHub).
//! Aqui o mesmo relay que serve o arquivo serve o manifest, entao a integridade
//! e' garantida por SHA-256 + tamanho (sem PKI). O swap e' silencioso e avisado
//! pela bandeja; nunca acontece no meio de uma transmissao (espera o proximo ciclo).

use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::logging;
use crate::platform;
use crate::status::{Shared, Update};

/// Base padrao do relay (o mesmo host do `wss://.../hub`).
pub const RELEASE_BASE: &str = "https://desjanjador.skillup.com.br";
const MANIFEST_PATH: &str = "/release.json";
pub const ASSET_NAME: &str = "Desjanjador.exe";
const CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);

/// Retorna a URL base do relay/update (permite override por env var ou arquivo local).
pub fn release_base() -> String {
    if let Ok(val) = std::env::var("BIGDUCKS_UPDATE_URL") {
        let trimmed = val.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    let override_file = logging::data_dir().join("update-url.txt");
    if let Ok(val) = std::fs::read_to_string(&override_file) {
        let trimmed = val.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    RELEASE_BASE.to_string()
}

/// Flags de CreateProcess para reabrir o app destacado, sem herdar console.
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const DETACHED_PROCESS: u32 = 0x0000_0008;

/// Manifest servido em `/release.json` pelo relay.
#[derive(Clone, Debug, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default = "default_asset")]
    pub asset: String,
    pub size: u64,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub notes: Option<String>,
}

fn default_asset() -> String {
    ASSET_NAME.to_string()
}

pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Versao alvo e' mais nova que a atual?
pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(next), Some(present)) => next > present,
        _ => false,
    }
}

fn parse_version(value: &str) -> Option<(u64, u64, u64)> {
    let trimmed = value.trim().trim_start_matches('v');
    let mut parts = trimmed.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

fn manifest_url() -> String {
    format!("{}{MANIFEST_PATH}", release_base())
}

fn asset_url(manifest: &Manifest) -> String {
    format!("{}/{}", release_base(), manifest.asset.trim_start_matches('/'))
}

/// Baixa e compara o manifest. `Ok(None)` quando ja estamos na ultima versao.
pub fn check() -> Result<Option<Manifest>> {
    let url = manifest_url();
    let response = match ureq::get(&url).timeout(Duration::from_secs(30)).call() {
        Ok(response) => response,
        Err(ureq::Error::Status(code, _)) => {
            log_update(&format!("manifest indisponivel (HTTP {code}) em {url}"));
            return Ok(None);
        }
        Err(error) => return Err(anyhow::anyhow!("GET {url}: {error}")),
    };
    let body = response.into_string().context("ler o manifest")?;
    let manifest: Manifest =
        serde_json::from_str(&body).with_context(|| format!("parse do manifest: {body}"))?;
    if is_newer(&manifest.version, current_version()) {
        log_update(&format!(
            "nova versao {} (atual {})",
            manifest.version,
            current_version()
        ));
        Ok(Some(manifest))
    } else {
        log_update(&format!("atualizado (versao {})", current_version()));
        Ok(None)
    }
}

/// Baixa o executavel, confere SHA-256/tamanho e deixa pronto em disco.
pub fn stage(manifest: &Manifest) -> Result<PathBuf> {
    if manifest.size == 0 || manifest.size > 100 * 1024 * 1024 {
        bail!("tamanho de update invalido: {}", manifest.size);
    }
    let url = asset_url(manifest);
    let response = ureq::get(&url)
        .timeout(Duration::from_secs(300))
        .call()
        .with_context(|| format!("GET {url}"))?;
    let mut reader = response.into_reader().take(manifest.size + 1);
    let mut bytes = Vec::with_capacity(manifest.size as usize);
    reader.read_to_end(&mut bytes).context("baixar o executavel")?;
    if bytes.len() as u64 != manifest.size {
        bail!(
            "tamanho diferente do manifest ({} != {})",
            bytes.len(),
            manifest.size
        );
    }
    if !manifest.sha256.is_empty() {
        let digest = hex(&Sha256::digest(&bytes));
        if !digest.eq_ignore_ascii_case(&manifest.sha256) {
            bail!("SHA-256 nao confere com o manifest");
        }
    }

    let directory = logging::data_dir().join("updates");
    std::fs::create_dir_all(&directory).context("criar diretorio de updates")?;
    let staged = directory.join(format!("{ASSET_NAME}-{}.exe", manifest.version));
    std::fs::write(&staged, &bytes).context("gravar o update")?;
    log_update(&format!("{} baixado e verificado", staged.display()));
    Ok(staged)
}

/// Troca o binario em execucao pelo baixado e reabre o app.
pub fn apply(staged: &PathBuf) -> Result<()> {
    let target = platform::exe_path();
    let directory = target
        .parent()
        .map(PathBuf::from)
        .context("descobrir o diretorio do executavel")?;
    let incoming = directory.join(".bigducks-incoming.exe");
    let backup = directory.join(format!(
        "{}.old",
        target
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "Desjanjador.exe".to_string())
    ));

    std::fs::copy(staged, &incoming).context("preparar o novo executavel")?;
    let _ = std::fs::remove_file(&backup);
    // Renomear um exe EM EXECUCAO e' permitido no Windows (so' apagar/sobrescrever
    // nao e'). Por isso o binario atual vira `.old` e o novo entra no lugar.
    std::fs::rename(&target, &backup)
        .with_context(|| format!("renomear {} -> {}", target.display(), backup.display()))?;
    if let Err(error) = std::fs::rename(&incoming, &target) {
        let _ = std::fs::rename(&backup, &target);
        return Err(error).context("mover o novo executavel para o lugar");
    }
    log_update(&format!("trocado por {}; reabrindo", staged.display()));

    // O processo NOVO reabre ENQUANTO este ainda esta vivo. Sem liberar antes, o
    // guard de instancia unica faria o processo novo detectar "outra instancia"
    // e SAIR na hora - o app nao voltaria depois do update. Libera o mutex agora
    // e, se a reabertura falhar, retoma o guard (o app continua rodando aqui).
    crate::single_instance::release();

    let mut command = std::process::Command::new(&target);
    if let Some(parent) = target.parent() {
        command.current_dir(parent);
    }
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    if let Err(error) = command.spawn() {
        let _ = crate::single_instance::acquire();
        return Err(error).context("reabrir o app atualizado");
    }
    Ok(())
}

/// Remove o `.old` deixado pela atualizacao anterior (so' da pra apagar depois
/// que o processo que o segurava terminou).
pub fn cleanup_old() {
    let target = platform::exe_path();
    let _ = std::fs::remove_file(PathBuf::from(format!("{}.old", target.display())));
    // Tambem limpa restos de um swap interrompido.
    if let Some(directory) = target.parent() {
        let _ = std::fs::remove_file(directory.join(".bigducks-incoming.exe"));
    }
}

/// Thread de checagem: uma vez no boot (com atraso curto) e depois a cada 4h.
pub fn spawn_checker(status: Shared) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        loop {
            run_once(&status, false);
            std::thread::sleep(CHECK_INTERVAL);
        }
    });
}

/// Dispara checagem manual (ex: acionada pelo menu da bandeja).
pub fn trigger_manual_check(status: &Shared) {
    run_once(status, true);
}

fn run_once(status: &Shared, manual: bool) {
    set_update(status, Update::Checking, "checando atualizacao");
    if manual {
        notify(status, "Desjanjador", "Verificando atualizações...");
    }
    match check() {
        Ok(Some(manifest)) => {
            let note = manifest.notes.clone().unwrap_or_default();
            log_update(&format!("baixando {} {note}", manifest.version));
            set_update(status, Update::Checking, &format!("baixando v{}", manifest.version));
            match stage(&manifest) {
                Ok(staged) => {
                    set_update(
                        status,
                        Update::Staged,
                        &format!("v{} pronta para instalar", manifest.version),
                    );
                    notify(
                        status,
                        "Atualização baixada",
                        &format!("Desjanjador v{} será instalado silenciosamente em instantes", manifest.version),
                    );
                    if applying_now(status) {
                        set_update(status, Update::Installing, "instalando atualizacao");
                        match apply(&staged) {
                            Ok(()) => {
                                log_update("atualizacao aplicada; encerrando para reabrir");
                                std::process::exit(0);
                            }
                            Err(error) => {
                                log_update(&format!("falha ao aplicar: {error:#}"));
                                set_update(status, Update::Failed, &format!("{error:#}"));
                                notify(status, "Falha na atualizacao", &format!("{error:#}"));
                            }
                        }
                    } else {
                        log_update("transmissao ativa - update aplicado no proximo ciclo");
                    }
                }
                Err(error) => {
                    log_update(&format!("falha no download: {error:#}"));
                    set_update(status, Update::Failed, &format!("{error:#}"));
                    if manual {
                        notify(status, "Falha no download", &format!("{error:#}"));
                    }
                }
            }
        }
        Ok(None) => {
            set_update(status, Update::Idle, "");
            if manual {
                notify(
                    status,
                    "Desjanjador atualizado",
                    &format!("Você já está na versão mais recente (v{}).", current_version()),
                );
            }
        }
        Err(error) => {
            log_update(&format!("checagem falhou: {error:#}"));
            set_update(status, Update::Failed, &format!("{error:#}"));
            if manual {
                notify(status, "Erro ao verificar atualização", &format!("{error:#}"));
            }
        }
    }
}

fn applying_now(status: &Shared) -> bool {
    status
        .lock()
        .map(|guard| !guard.streaming)
        .unwrap_or(true)
}

fn set_update(status: &Shared, state: Update, detail: &str) {
    if let Ok(mut guard) = status.lock() {
        guard.update = state;
        guard.update_detail = detail.to_string();
    }
}

fn notify(status: &Shared, title: &str, body: &str) {
    if let Ok(mut guard) = status.lock() {
        guard.notify(title, body);
    }
}

fn log_update(message: &str) {
    crate::log_info!("update: {message}");
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}
