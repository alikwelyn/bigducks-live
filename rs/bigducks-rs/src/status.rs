//! Estado compartilhado entre o servidor (axum), a bandeja e o auto-update.
//!
//! A bandeja le' isto a cada ~2s para escolher o icone/tooltip e para mostrar
//! baloes. O servidor escreve aqui o que o preload reporta via `/bridge-event`
//! (nomes como `hub-remoto`), e o update escreve o estado da atualizacao.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Legenda das cores do ponto da bandeja: vai na 2a linha do tooltip pra que o
/// usuario decodifique a cor sem perguntar. Os rotulos casam com `state_label`
/// (e, por tabela, com `icon::state_color`).
///
/// Fica curto de proposito: o `szTip` do Windows e' `[u16; 128]`, entao o
/// tooltip inteiro tem que caber em ~127 caracteres pra legenda nao ser cortada.
const LEGEND: &str =
    "verde:conectado|ambar:sem voz|azul:local|vermelho:sem bridge|roxo:atualizando|cinza:aguardando";

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
    UpToDate,
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
    /// Executavel baixado e verificado, aguardando a thread principal trocar.
    pub staged_update: Option<PathBuf>,
    pub autostart: bool,
    /// Por que (nao) vamos reiniciar o Discord por causa da injecao. Vem da
    /// comparacao carimbo-da-injecao x inicio do processo (ver src/discord.rs).
    pub restart_note: String,
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
            staged_update: None,
            autostart: false,
            restart_note: String::new(),
            balloon: None,
        }
    }
}

impl Status {
    /// Enfileira um balao (o ultimo pedido vence enquanto a bandeja nao mostrar).
    pub fn notify(&mut self, title: impl Into<String>, body: impl Into<String>) {
        self.balloon = Some((title.into(), body.into()));
    }

    /// Texto curto mostrado no item do menu e no tooltip durante a checagem.
    pub fn update_label(&self) -> &'static str {
        match self.update {
            Update::Idle => "Verificar atualizações",
            Update::Checking => "Verificando atualizações…",
            Update::Staged if self.streaming => "Atualização baixada — aguardando live",
            Update::Staged => "Atualização pronta — aplicando",
            Update::Installing => "Instalando atualização…",
            Update::UpToDate => "Já está atualizado",
            Update::Failed => "Falha na atualização — tentar de novo",
        }
    }

    /// Rotulo do estado em palavras, seguindo a MESMA precedencia de
    /// `icon::state_color` (atualizacao > bridge ausente > relay).
    fn state_label(&self) -> &'static str {
        if matches!(self.update, Update::Staged | Update::Installing) {
            return "atualizando";
        }
        if !self.bridge_installed {
            return "sem bridge";
        }
        match self.relay {
            Relay::Connected => "relay conectado",
            Relay::NoVoice => "sem canal de voz",
            Relay::Local => "so local",
            Relay::Unknown => "aguardando",
        }
    }

    /// Texto do tooltip: 1a linha = app + estado atual EM PALAVRAS (cor
    /// redundante); 2a linha = legenda das cores do ponto.
    pub fn tooltip(&self) -> String {
        if self.update != Update::Idle {
            let detail = if self.update_detail.is_empty() {
                self.update_label()
            } else {
                &self.update_detail
            };
            return format!("Desjanjador - {detail}");
        }
        let streaming = if self.streaming {
            " | TRANSMITINDO"
        } else {
            ""
        };
        let restart = if self.restart_note.is_empty() {
            String::new()
        } else {
            format!(" | {}", self.restart_note)
        };
        format!(
            "Desjanjador - {}{streaming}{restart}\n{LEGEND}",
            self.state_label()
        )
    }
}

pub type Shared = Arc<Mutex<Status>>;

pub fn shared() -> Shared {
    Arc::new(Mutex::new(Status::default()))
}
