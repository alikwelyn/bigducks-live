//! Estado compartilhado entre o servidor (axum), a bandeja e o auto-update.
//!
//! A bandeja le' isto a cada ~2s para escolher o icone/tooltip e para mostrar
//! baloes. O servidor escreve aqui o que o preload reporta via `/bridge-event`
//! (nomes como `hub-remoto`), e o update escreve o estado da atualizacao.

use std::sync::{Arc, Mutex};

/// Estado do relay P2P, derivado do que o preload reporta.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Relay {
    /// Sem nenhuma noticia ainda (bridge nem subiu).
    Unknown,
    /// Bridge local conectado, mas ainda sem o relay remoto.
    Local,
    /// Sem canal de voz - o relay remoto fica parado de proposito.
    NoVoice,
    /// Relay remoto conectado (welcome recebido) - caminho pronto pro P2P.
    Connected,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Update {
    Idle,
    Checking,
    /// Nova versao baixada e pronta para trocar.
    Staged,
    Installing,
    Failed,
}

pub struct Status {
    /// A injecao no app.asar foi aplicada.
    pub bridge_installed: bool,
    /// O bridge ja reportou vida (hook/preload rodando no Discord).
    pub bridge_loaded: bool,
    pub relay: Relay,
    /// Ultima linha reportada pelo preload (diagnostico curto).
    pub detail: String,
    pub streaming: bool,
    pub update: Update,
    pub update_detail: String,
    pub autostart: bool,
    /// Balao pendente: a bandeja consome e mostra (titulo, corpo).
    pub balloon: Option<(String, String)>,
}

impl Default for Status {
    fn default() -> Self {
        Self {
            bridge_installed: false,
            bridge_loaded: false,
            relay: Relay::Unknown,
            detail: String::new(),
            streaming: false,
            update: Update::Idle,
            update_detail: String::new(),
            autostart: false,
            balloon: None,
        }
    }
}

impl Status {
    /// Enfileira um balao (o ultimo pedido vence enquanto a bandeja nao mostrar).
    pub fn notify(&mut self, title: impl Into<String>, body: impl Into<String>) {
        self.balloon = Some((title.into(), body.into()));
    }

    /// Texto curto do tooltip.
    pub fn tooltip(&self) -> String {
        let relay = match self.relay {
            Relay::Connected => "relay conectado",
            Relay::NoVoice => "sem canal de voz",
            Relay::Local => "relay remoto parado",
            Relay::Unknown => "aguardando o Discord",
        };
        let bridge = if self.bridge_installed {
            "bridge instalado"
        } else {
            "bridge NAO instalado"
        };
        let streaming = if self.streaming { " | TRANSMITINDO" } else { "" };
        let update = match self.update {
            Update::Staged => " | atualizacao pronta",
            Update::Checking => " | checando atualizacao",
            Update::Installing => " | instalando atualizacao",
            Update::Failed => " | update falhou",
            Update::Idle => "",
        };
        format!("DiscordStream - {bridge}, {relay}{streaming}{update}")
    }
}

pub type Shared = Arc<Mutex<Status>>;

pub fn shared() -> Shared {
    Arc::new(Mutex::new(Status::default()))
}
