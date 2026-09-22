// bigducks-rs - preload das janelas do Discord (modelo Vencord).
//
// Roda ANTES dos scripts da pagina, com sandbox desligado, entao tem `require`.
// Injeta o bridge do renderer no mundo principal com webFrame.executeJavaScript
// e, em seguida, encadeia o preload original do Discord (sem ele a janela nao
// funciona).
//
// Aqui tambem mora o gancho que descobre QUAL tela/janela o usuario escolheu no
// modal. O `discord_voice` e um ARQUIVO JS que envolve o addon nativo
// (require('./discord_voice.node')) e expoe createOwnStreamConnectionWithOptions
// / setDesktopSource / presentNativeScreenSharePicker. Em runtime o objeto vem
// diferente a cada chamada e o nativeModules e congelado, entao decorar o meu
// objeto nunca funcionou. A saida e decorar o que SAI do carregador do Node
// (Module._load): assim toda copia ja nasce decorada, inclusive a que o Discord
// guarda.

"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");

const PORT = Number(process.env.BIGDUCKS_PORT) || 8791;

// ------------------------------------------------------------------ relato --

function report(name, data) {
  const text = String(data == null ? "" : data);
  try {
    const query = "name=" + encodeURIComponent(name) + "&data=" + encodeURIComponent(text);
    const request = http.get("http://127.0.0.1:" + PORT + "/bridge-event?" + query, (response) => response.resume());
    request.on("error", () => {});
    request.setTimeout(1500, () => request.destroy());
  } catch (_) {}
  try { console.log("[bigducks-rs]", name, text); } catch (_) {}
}

// Traduz o que o Discord manda para o formato que o motor entende.
//
// O log mostrou dois formatos:
//   type=window        -> sourceId e o handle da janela (HWND)
//   type=screen-handle -> sourceId e o handle do MONITOR (HMONITOR)
// Por isso o valor vai tipado: sem isso, um handle de monitor cairia no
// fallback numerico e viraria "uma janela" qualquer.
function sourceValue(id, type) {
  const text = String(id == null ? "" : id).trim();
  if (!text) return "";
  if (/^(screen|window|application|camera)[:-]/i.test(text)) return text;
  const kind = String(type || "").toLowerCase();
  if (kind.includes("window")) return "window:" + text;
  if (kind.includes("screen")) return "screen-handle:" + text;
  return text;
}

// Manda a fonte escolhida pro motor Rust (que passa a capturar exatamente ela).
function sendSource(value) {
  if (value == null || value === "") return;
  const text = String(value);
  report("source-escolhida", text.slice(0, 120));
  try {
    const request = http.get("http://127.0.0.1:" + PORT + "/source?value=" + encodeURIComponent(text), (response) => response.resume());
    request.on("error", () => {});
    request.setTimeout(1500, () => request.destroy());
  } catch (_) {}
}

// O painel de qualidade do Discord chega em chamadas nativas. A gente le os
// numeros e repassa pro motor, entao a UI nativa vira o controle da NOSSA
// captura.
//
// O log mostrou tres armadilhas, todas tratadas aqui:
//   1. o modal de fonte manda tamanho de MINIATURA (130x130) junto com a fonte;
//   2. existe bitrate de VOZ (encodingVoiceBitRate=128000) que nao e o da live;
//   3. remoteSinkWantsXxx e o que o ESPECTADOR quer, nao a nossa configuracao.
// As chaves boas sao encodingVideoWidth/Height/FrameRate/MaxBitRate.
function extractSettings(object, depth, out) {
  const result = out || {};
  const consider = (key, value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
    const name = String(key).toLowerCase();
    if (/voice|audio/.test(name)) return;
    if (name.indexOf("remotesinkwants") === 0) return;
    if (name === "encodingvideowidth") { result.width = value; return; }
    if (name === "encodingvideoheight") { result.height = value; return; }
    if (name === "encodingvideoframerate" || name === "capturevideoframerate") { result.fps = value; return; }
    if (name === "encodingvideomaxbitrate") { result.bitrate = value; return; }
    if (name === "encodingvideobitrate") { if (result.bitrate == null) result.bitrate = value; return; }
    if (/width/.test(name)) { if (value >= 480) result.width = value; return; }
    if (/height/.test(name)) { if (value >= 270) result.height = value; return; }
    if (/fps|frame_?rate/.test(name)) { if (result.fps == null) result.fps = value; return; }
    if (/bitrate/.test(name)) { if (result.bitrate == null || value > result.bitrate) result.bitrate = value; }
  };

  try {
    if (object == null || typeof object !== "object" || depth > 2) return result;
    for (const key of Object.keys(object)) {
      let value;
      try { value = object[key]; } catch (_) { continue; }
      if (value !== null && typeof value === "object") {
        extractSettings(value, depth + 1, result);
        continue;
      }
      consider(key, value);
    }
  } catch (_) {}
  return result;
}

function sendSettings(object, label) {
  try {
    const found = extractSettings(object, 0);
    const keys = Object.keys(found);
    if (!keys.length) return;
    report("settings-lidas", label + " " + JSON.stringify(found));
    const query = keys.map((key) => key + "=" + found[key]).join("&");
    const request = http.get("http://127.0.0.1:" + PORT + "/settings?" + query, (response) => response.resume());
    request.on("error", () => {});
    request.setTimeout(1500, () => request.destroy());
  } catch (_) {}
}

// Resumo curto e a prova de ciclo, pra caber no log.
function brief(value) {
  try {
    if (value == null) return String(value);
    if (typeof value !== "object") return String(value).slice(0, 80);
    const parts = [];
    for (const key of Object.keys(value).slice(0, 8)) {
      let item;
      try { item = value[key]; } catch (_) { item = "?"; }
      parts.push(key + "=" + (item !== null && typeof item === "object" ? "[obj]" : String(item).slice(0, 40)));
    }
    return "{" + parts.join(",") + "}";
  } catch (_) {
    return "?";
  }
}

// -------------------------------------------------------------- decoracao --

function decorateConnection(connection) {
  if (!connection || typeof connection !== "object") return connection;

  try {
    if (typeof connection.setDesktopSource === "function" && !connection.__bdSource) {
      const original = connection.setDesktopSource;
      connection.setDesktopSource = function (id, videoHook, type) {
        report("setDesktopSource", "id=" + String(id).slice(0, 90) + " type=" + String(type) + " hook=" + brief(videoHook));
        sendSource(sourceValue(id, type));
        return original.apply(this, arguments);
      };
      connection.__bdSource = true;
    }
  } catch (_) {}

  try {
    if (typeof connection.setDesktopSourceWithOptions === "function" && !connection.__bdOptions) {
      const original = connection.setDesktopSourceWithOptions;
      connection.setDesktopSourceWithOptions = function (options) {
        let id = null;
        try {
          id = options && (options.id != null ? options.id
            : options.sourceId != null ? options.sourceId
            : options.desktopSourceId);
        } catch (_) {}
        report("setDesktopSourceWithOptions", brief(options));
        sendSource(sourceValue(id, options && options.type));
        sendSettings(options, "captura");
        return original.apply(this, arguments);
      };
      connection.__bdOptions = true;
    }
  } catch (_) {}

  // Bitrate e resolucao da transmissao viajam por aqui quando voce mexe no
  // painel de qualidade.
  for (const name of ["setTransportOptions", "setGoLiveDevices"]) {
    try {
      if (typeof connection[name] !== "function" || connection["__bd_" + name]) continue;
      const original = connection[name];
      connection[name] = function (options) {
        report(name, brief(options));
        sendSettings(options, name);
        return original.apply(this, arguments);
      };
      connection["__bd_" + name] = true;
    } catch (_) {}
  }

  return connection;
}

function decorate(engine) {
  if (!engine || engine.__bigducks) return engine;
  try { engine.__bigducks = true; } catch (_) {}

  const decorated = [];

  for (const name of ["createOwnStreamConnectionWithOptions", "createVoiceConnectionWithOptions"]) {
    try {
      const original = engine[name];
      if (typeof original === "function" && !original.__bdWrapped) {
        const wrapped = function () {
          return decorateConnection(original.apply(this, arguments));
        };
        wrapped.__bdWrapped = true;
        engine[name] = wrapped;
        decorated.push(name);
      }
    } catch (_) {}
  }

  for (const name of ["presentNativeScreenSharePicker", "presentDesktopSourcePicker"]) {
    try {
      const original = engine[name];
      if (typeof original === "function" && !original.__bdPicker) {
        const wrapped = function () {
          report("picker", name);
          let result;
          try { result = original.apply(this, arguments); } catch (error) { throw error; }
          try {
            Promise.resolve(result).then((value) => {
              if (value != null) {
                report("picker-result", brief(value));
                sendSource(value);
              }
            }).catch(() => {});
          } catch (_) {}
          return result;
        };
        wrapped.__bdPicker = true;
        engine[name] = wrapped;
        decorated.push(name);
      }
    } catch (_) {}
  }

  report("engine-decorado", decorated.join(",") || "(nenhum metodo reconhecido)");
  return engine;
}

// Toda copia do modulo que sair do carregador ja sai decorada.
function looksLikeVoiceEngine(value) {
  return !!value && typeof value === "object"
    && (typeof value.createVoiceConnectionWithOptions === "function"
      || typeof value.createOwnStreamConnectionWithOptions === "function");
}

function installModuleHook() {
  let Module = null;
  try { Module = require("module"); } catch (_) {}
  if (!Module || typeof Module._load !== "function") {
    report("hook-falhou", "sem require('module')");
    return false;
  }
  if (Module._load.__bdHooked) return true;
  const originalLoad = Module._load;
  const hooked = function (request) {
    const result = originalLoad.apply(this, arguments);
    try {
      if (typeof request === "string" && /discord_voice/i.test(request) && looksLikeVoiceEngine(result)) {
        return decorate(result);
      }
    } catch (_) {}
    return result;
  };
  hooked.__bdHooked = true;
  Module._load = hooked;
  return true;
}

// ------------------------------------------------------------------ inicio --

try {
  report("hook", installModuleHook() ? "Module._load instalado" : "Module._load indisponivel");
} catch (error) {
  report("hook-erro", error && error.message);
}

// ------------------------------------------- patch ANTES de a pagina rodar ---
//
// O `webFrame.executeJavaScript` e ASSINCRONO: chega depois dos scripts da
// pagina - foi por isso que os modulos sempre apareceram como "TARDE" e o nosso
// push nunca era chamado. Aqui o gancho e instalado SINCRONAMENTE, ainda no
// preload, no mesmo global da pagina (esse cliente roda sem contextIsolation).
//
// O runtime do webpack faz:
//     self.webpackChunkdiscord_app = self.webpackChunkdiscord_app || []
//     push([[ids], { modulos }])        <- os modulos passam por aqui ANTES de
//                                          serem registrados e executados
// E o webpackJsonpCallback ainda ENVOLVE o nosso push em vez de descarta-lo,
// entao todo chunk, pra sempre, passa por nos antes de existir.
function installEarlyPatch() {
  const g = globalThis;
  if (g.__bdEarlyPatched) return;
  g.__bdEarlyPatched = true;

  function normalize(source) {
    let text = String(source).trim();
    let isAsync = false;
    if (/^async\s/.test(text)) { isAsync = true; text = text.slice(6).trim(); }
    if (/^function\b/.test(text) || text.charAt(0) === "(") return (isAsync ? "async " : "") + text;
    const shorthand = text.match(/^([A-Za-z_$][\w$]*|\d[\w$]*)\s*\(/);
    if (shorthand) {
      const named = /^[A-Za-z_$]/.test(shorthand[1]);
      return (isAsync ? "async function " : "function ") + (named ? shorthand[1] : "") + text.slice(text.indexOf("("));
    }
    return (isAsync ? "async " : "") + text;
  }

  function allowAll(source) {
    const at = source.indexOf("PRESET_AUTO");
    if (at < 0) return null;
    const ifAt = source.lastIndexOf("if(", at);
    if (ifAt < 0) return null;
    return source.slice(0, ifAt) + "return !0;" + source.slice(ifAt);
  }

  function forceMaxAllowed(source) {
    const simple = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)=+(\w+)\?\.maxResolution&&(\w+)=+\3\?\.maxFPS/;
    if (!simple.test(source)) return null;
    return source.replace(simple, "$1=!0");
  }

  function grantStreamPerk(source) {
    const perk = source.match(/([A-Za-z_$][\w$]*)=new [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.w\.STREAM_HIGH_QUALITY\)/);
    if (!perk) return null;
    const name = perk[1];
    let touched = false;
    const patched = source.replace(
      /(\[\w+\.\w+\.TIER_[01]\]:new \w+\(\w+\.\w+\.TIER_[01],\[[^\]]*?)(\])/g,
      function (all, head, tail) {
        if (new RegExp("[,\\[]" + name + "[,\\]]").test(all)) return all;
        touched = true;
        return head + "," + name + tail;
      }
    );
    return touched ? patched : null;
  }

  const RULES = [
    { needle: '"canStreamWithSettings"', mutate: allowAll },
    { needle: "stream-settings-fps-", mutate: forceMaxAllowed },
    { needle: "STREAM_HIGH_QUALITY", mutate: grantStreamPerk },
  ];

  function patchModules(modules) {
    if (!modules || typeof modules !== "object") return 0;
    let patched = 0;
    for (const id of Object.keys(modules)) {
      const factory = modules[id];
      if (typeof factory !== "function") continue;
      let source;
      try { source = Function.prototype.toString.call(factory); } catch (_) { continue; }
      for (const rule of RULES) {
        if (source.indexOf(rule.needle) === -1) continue;
        const rewritten = rule.mutate(source);
        if (!rewritten || rewritten === source) continue;
        try {
          modules[id] = new Function("return (" + normalize(rewritten) + ")")();
          patched += 1;
          // report() manda pro motor (aparece no run.cmd) e tambem pro console
          report("nitro-chunk", "modulo " + id + " " + rule.needle + " (antes de executar)");
        } catch (_) {}
        break;
      }
    }
    return patched;
  }

  try {
    const list = Array.isArray(g.webpackChunkdiscord_app) ? g.webpackChunkdiscord_app : [];
    const originalPush = list.push.bind(list);
    list.push = function (data) {
      try { patchModules(data && data[1]); } catch (_) {}
      return originalPush(data);
    };
    list.__bdEarly = true;
    g.webpackChunkdiscord_app = list;
    console.log("[bigducks-rs] nitro: gancho do chunk instalado antes da pagina");
  } catch (error) {
    console.error("[bigducks-rs] nitro: gancho falhou:", error && error.message);
  }
}

try {
  installEarlyPatch();
} catch (_) {}

// ------------------------------------------------- hub remoto (Fase 1) -----
//
// Le `DiscordStream/remote-hub.txt`: uma linha `<url> <sala>`, por exemplo
//     wss://meu-relay.fly.dev/hub sala-do-alk
// Se o arquivo existir, o preload abre um WebSocket pro relay e faz ponte com o
// hub local: o que este Discord manda vai pro outro PC e vice-versa. Passa SO
// sinalizacao (offer/answer/ice - alguns KB); o video continua P2P, DTLS, sem
// passar por servidor nenhum.
//
// Detalhe que importa: o `from` das mensagens remotas e' reescrito pra uma faixa
// alta (900000+). Sem isso o relay local descarta a mensagem como se fosse dele
// mesmo - os dois PCs numeram os peers como 1, 2, 3...
function bridgeRemoteHub() {
  let fs;
  let path;
  try {
    fs = require("fs");
    path = require("path");
  } catch (_) {
    return;
  }
  let line = "";
  try {
    const file = path.join(__dirname, "remote-hub.txt");
    if (!fs.existsSync(file)) return;
    line = String(fs.readFileSync(file, "utf8")).split(/\r?\n/)[0].trim();
  } catch (_) {
    return;
  }
  if (!line) return;
  if (typeof WebSocket !== "function") {
    report("hub-remoto-erro", "Node sem WebSocket global");
    return;
  }

  const parts = line.split(/\s+/);
  const hubUrl = parts[0];
  const secret = parts[1] || "";
  const localUrl = "ws://127.0.0.1:" + PORT + "/hub";

  let local = null;
  let remote = null;
  let seq = 0;
  let room = "";

  // A SALA vem do Discord: o renderer publica o canal de voz atual em
  // globalThis.__bdRoom. Quem esta na mesma call cai na mesma sala - nada pra
  // configurar. Sem canal de voz, nao ha relay (nao teria com quem falar).
  let webFrame = null;
  try { webFrame = require("electron/renderer").webFrame; } catch (_) {}
  if (!webFrame) { try { webFrame = require("electron").webFrame; } catch (_) {} }
  const readRoom = () => {
    if (!webFrame || typeof webFrame.executeJavaScript !== "function") return Promise.resolve("");
    return webFrame.executeJavaScript("globalThis.__bdRoom || ''").then((v) => String(v || "")).catch(() => "");
  };
  const remoteUrl = () => {
    if (!room) return "";
    return hubUrl + "/" + encodeURIComponent(room) + (secret ? "?secret=" + encodeURIComponent(secret) : "");
  };

  const sendLocal = (text) => { try { if (local && local.readyState === 1) local.send(text); } catch (_) {} };
  const sendRemote = (text) => { try { if (remote && remote.readyState === 1) remote.send(text); } catch (_) {} };

  const connectLocal = () => {
    try {
      local = new WebSocket(localUrl);
    } catch (_) {
      setTimeout(connectLocal, 3000);
      return;
    }
    local.onopen = () => report("hub-remoto", "local conectado | relay: " + hubUrl);
    local.onmessage = (event) => {
      const text = String(event.data || "");
      // 900000+ = veio do remoto; nao devolve pro remoto (evita eco infinito)
      if (/"from":9\d{5},/.test(text)) return;
      sendRemote(text);
    };
    local.onclose = () => setTimeout(connectLocal, 3000);
    local.onerror = () => {};
  };

  const connectRemote = () => {
    const url = remoteUrl();
    if (!url) return;
    try {
      remote = new WebSocket(url);
    } catch (_) {
      setTimeout(connectRemote, 5000);
      return;
    }
    remote.onopen = () => report("hub-remoto", "remoto conectado (sala " + room + ")");
    remote.onmessage = (event) => {
      const text = String(event.data || "");
      seq += 1;
      const rewritten = text.replace(/^\{"from":\d+,/, '{"from":' + (900000 + seq) + ",");
      sendLocal(rewritten);
    };
    remote.onclose = () => setTimeout(() => { if (remoteUrl()) connectRemote(); }, 5000);
    remote.onerror = () => {};
  };

  const syncRoom = () => {
    readRoom().then((id) => {
      if (id === room) return;
      room = id;
      if (!room) {
        report("hub-remoto", "sem canal de voz - relay parado");
        try { if (remote) remote.close(); } catch (_) {}
        remote = null;
        return;
      }
      report("hub-remoto", "entrou na sala " + room);
      connectRemote();
    });
  };

  connectLocal();
  setInterval(syncRoom, 3000);
  syncRoom();
}

try {
  bridgeRemoteHub();
} catch (_) {}

// ------------------------------------------------- esconder o banner --------
//
// O banner roxo "Transmita em resolucao HD com Nitro" no Go Live picker e
// renderizado pelo Discord com classes CSS moduladas (hash aleatorio). Nao
// da pra acertar o seletor sem saber o hash. Mas o CONTEUDO e sempre o mesmo:
// tem um botao "Obter o Nitro" e um texto sobre "HD" ou "4k". Um MutationObserver
// leve que procura o texto e esconde o ancestral e mais confiavel que CSS.
function hideNitroBanner() {
  try {
    const TEXTS = ["Transmita em resolu", "Stream in HD", "Unlock 4k", "Obter o Nitro", "Get Nitro"];
    const observer = new MutationObserver(function () {
      try {
        // Procura apenas dentro de modais e dialogs (onde o picker de stream vive)
        const dialogs = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="layer"]');
        for (const dialog of dialogs) {
          const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const text = node.textContent || "";
            for (const t of TEXTS) {
              if (text.includes(t)) {
                // Sobe ate achar o container com background de gradiente
                let banner = node.parentElement;
                for (let i = 0; i < 6 && banner; i++) {
                  banner = banner.parentElement;
                  if (!banner) break;
                  const style = getComputedStyle(banner);
                  if (style.backgroundImage && style.backgroundImage.includes("gradient")) {
                    banner.style.display = "none";
                    break;
                  }
                  // Ou se for um container com classe de upsell
                  if (banner.className && typeof banner.className === "string"
                    && /upsell|premium|nitro/i.test(banner.className)) {
                    banner.style.display = "none";
                    break;
                  }
                }
                break;
              }
            }
          }
        }
      } catch (_) {}
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}
}

// Roda depois que o DOM esta disponivel (o preload roda antes do DOM existir)
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", hideNitroBanner);
} else {
  hideNitroBanner();
}

try {
  let webFrame = null;
  try { webFrame = require("electron/renderer").webFrame; } catch (_) {}
  if (!webFrame) {
    try { webFrame = require("electron").webFrame; } catch (_) {}
  }

  if (webFrame && typeof webFrame.executeJavaScript === "function") {
    const rendererPath = path.join(__dirname, "bigducks_rs_renderer.js");
    const source = fs.readFileSync(rendererPath, "utf8");
    webFrame.executeJavaScript(source).catch((error) => {
      console.error("[bigducks-rs] renderer inject falhou:", error && error.message);
    });
    // Plugins opcionais (--nitro). Vem por aqui de proposito: o fetch da PAGINA
    // esbarra na CSP do Discord; o http do Node nao. Sem a flag a rota responde
    // 404 e nada e injetado.
    loadPlugins(webFrame);
  }
} catch (error) {
  console.error("[bigducks-rs] preload falhou:", error && error.message);
}

function loadPlugins(webFrame) {
  const attempts = 24;
  let attempt = 0;
  let done = false;

  const tryOnce = () => {
    if (done) return;
    attempt += 1;
    const request = http.get("http://127.0.0.1:" + PORT + "/plugins.js", (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        return; // --nitro desligado: nao insiste
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        // O valor da ULTIMA expressao volta pelo executeJavaScript: o plugin
        // expoe quantos patches aplicou, entao da pra parar de tentar quando
        // ele ja pegou (antes ficava tentando 24x a toa).
        const probe = "\n; (window.__bdNitroState ? window.__bdNitroState.patched > 0 : false)";
        webFrame.executeJavaScript(body + probe)
          .then((patched) => {
            if (patched) {
              done = true;
              report("plugins-ok", "patch aplicado na tentativa " + attempt);
            } else {
              report("plugins-injetados", "tentativa " + attempt + " (sem patch ainda)");
            }
          })
          .catch((error) => report("plugins-erro", error && error.message));
      });
    });
    request.on("error", () => {});
    request.setTimeout(2000, () => request.destroy());
    // TIMING: o runtime do webpack aparece antes dos chunks com os modulos que a
    // gente precisa (327649, 405916, 158045, 248174). Com retry de 6s a gente
    // chegava na tentativa 2 e eles JA tinham executado ("TARDE" no log). Agora
    // as primeiras tentativas sao rapidas (~150ms) pra pegar o runtime no ar e
    // hookar o push ANTES desses chunks - depois desacelera.
    const delay = attempt < 40 ? 150 : 6000;
    if (!done && attempt < attempts) setTimeout(tryOnce, delay);
  };

  tryOnce();
}

// Preload original do Discord: precisa rodar, senao o cliente quebra.
try {
  const original = process.env.BIGDUCKS_ORIGINAL_PRELOAD;
  if (original) require(original);
} catch (error) {
  console.error("[bigducks-rs] preload original falhou:", error && error.message);
}
