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
const crypto = require("crypto");

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

// ------------------------------------------------- primitivas compartilhadas --
//
// O preload roda ANTES dos scripts da pagina e no MESMO global (sandbox: false,
// sem contextIsolation). Estas primitivas ficam prontas aqui para o renderer e
// os plugins consumirem depois - por isso moram no preload, e nao no arquivo
// que as usa.

// Envolve target[method] para chamar cb(returnValue, thisArg, args) DEPOIS do
// original. Com opts.replace, o retorno de cb substitui o resultado. O wrapper e
// marcado (__bdAfter) para a reinjecao ser idempotente.
globalThis.__bdWrap = globalThis.__bdWrap || (function () {
  const warned = new Set();
  function after(target, method, cb, opts) {
    if (!target || typeof target[method] !== "function") {
      const key = String(method);
      if (!warned.has(key)) {
        warned.add(key);
        console.log("[bigducks-rs] __bdWrap.after:", key, "nao e funcao (ignorado)");
      }
      return target ? target[method] : undefined;
    }
    const original = target[method];
    if (original.__bdAfter) return original; // ja embrulhado
    const replace = !!(opts && opts.replace);
    const wrapper = function () {
      const args = Array.prototype.slice.call(arguments);
      const value = original.apply(this, args);
      let next;
      try { next = cb(value, this, args); } catch (_) { return value; }
      return replace ? next : value;
    };
    wrapper.__bdAfter = true;
    try { target[method] = wrapper; } catch (_) { return original; }
    return target[method];
  }
  return { after: after };
})();

// Varredura por CORPO de funcao no require.c do webpack (nao pela fonte da
// factory): acha um export sem depender de id/offset de build.
globalThis.__bdWebpack = globalThis.__bdWebpack || (function () {
  let cached = null;
  function getRequire() {
    if (cached && cached.c) return cached;
    try {
      const chunk = globalThis.webpackChunkdiscord_app;
      if (!chunk || typeof chunk.push !== "function") return null;
      const returned = chunk.push([[Symbol("bd-getbybody")], {}, (require) => require]);
      if (returned && returned.c) { cached = returned; return cached; }
    } catch (_) {}
    return null;
  }
  // Indice corpo->export montado UMA vez por tamanho de cache e reusado por
  // qualquer predicado. O consumidor (plugins.js) pode chamar getByBody varias
  // vezes por sessao; reconstruir a varredura (Object.getOwnPropertyNames +
  // Function.prototype.toString de CADA export) a cada chamada era o custo
  // repetido. Com o indice, o trabalho pesado roda na primeira vez e as demais
  // so casam o predicado - e nada e varrido no hot path do poll.
  let bodyIndex = null;
  let bodyIndexSize = -1;

  function buildBodyIndex(require) {
    const index = [];
    for (const id of Object.keys(require.c)) {
      let exports;
      try { exports = require.c[id] && require.c[id].exports; } catch (_) { continue; }
      if (!exports || (typeof exports !== "object" && typeof exports !== "function")) continue;
      let names;
      try { names = Object.getOwnPropertyNames(exports); } catch (_) { continue; }
      for (const key of names) {
        let fn;
        try { fn = exports[key]; } catch (_) { continue; }
        if (typeof fn !== "function") continue;
        let body;
        try { body = Function.prototype.toString.call(fn); } catch (_) { continue; }
        index.push({ id: id, key: key, exports: exports, fn: fn, body: body });
      }
    }
    return index;
  }

  function getByBody(pred) {
    const require = getRequire();
    if (!require || !require.c) {
      console.log("[bigducks-rs] __bdWebpack.getByBody: webpack ainda nao esta pronto");
      return null;
    }
    let size = -1;
    try { size = Object.keys(require.c).length; } catch (_) {}
    if (!bodyIndex || size !== bodyIndexSize) {
      bodyIndex = buildBodyIndex(require);
      bodyIndexSize = size;
    }
    for (const entry of bodyIndex) {
      let hit = false;
      try { hit = !!pred(entry.body, entry.key, entry.exports); } catch (_) { hit = false; }
      if (hit) return { fn: entry.fn, key: entry.key, id: entry.id, exports: entry.exports };
    }
    return null;
  }
  return { getByBody: getByBody, getRequire: getRequire };
})();

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

// ---------------------------------------------------------------- ciclo de vida da live ----
//
// A store de stream do Discord nao e capturavel nessa build (getCurrentUserActiveStream
// nao esta nos exports - "capturados=0" no log). Entao o gatilho de publicar/parar o
// P2P passa a ser o que o PRELOAD ja ve de graca:
//
//   START: setDesktopSourceWithOptions com id nao-vazio (a fonte foi escolhida no modal)
//   STOP : setTransportOptions com encodingVideoWidth=0 (o Discord zera a live)
//
// O motor roteia a mensagem pra janela certa (data = pid do renderer): so a janela
// que transmite publica, e o loop de P2P inteiro funciona SEM a store.

let lastSeenEncWidth = -1;
let lifecycleStarted = false;
let pendingStop = null;

function streamLifecycle(state) {
  if (state === "start" && pendingStop) {
    clearTimeout(pendingStop);
    pendingStop = null;
  }
  lifecycleStarted = state === "start" ? true : (state === "stop" ? false : lifecycleStarted);
  try {
    const request = http.get(
      "http://127.0.0.1:" + PORT + "/bridge-event?name=stream-" + state + "&data=" + encodeURIComponent(String(process.pid)),
      (response) => response.resume()
    );
    request.on("error", () => {});
    request.setTimeout(1500, () => request.destroy());
  } catch (_) {}
  report("stream-lifecycle", state);
}

function detectStreamLifecycle(object, label) {
  try {
    if (!object || typeof object !== "object" || label !== "setTransportOptions") return;
    for (const key of Object.keys(object)) {
      if (!/^encodingvideowidth$/i.test(key)) continue;
      const width = Number(object[key]);
      if (!Number.isFinite(width)) return;
      const was = lastSeenEncWidth;
      lastSeenEncWidth = width;
      if (width > 0) {
        // RENEGOCIACAO: o Discord zera e reconfigura em seguida (medido no log:
        // width=0 com fps=120, e logo depois as opcoes reais). Cancela qualquer
        // stop pendente - so e "fim de live" se o 0 PERSISTIR.
        if (pendingStop) { clearTimeout(pendingStop); pendingStop = null; }
        if (width !== was && lifecycleStarted) {
          // reconfiguracao mudou o tamanho: nada a fazer, o start ja saiu.
        }
        return;
      }
      // Discord can hold width=0 through a slow quality renegotiation. Keep
      // the feed alive until that state has persisted for a full 30 seconds.
      if (lifecycleStarted) {
        if (pendingStop) clearTimeout(pendingStop);
        pendingStop = setTimeout(() => {
          pendingStop = null;
          streamLifecycle("stop");
        }, 30000);
      }
      return;
    }
  } catch (_) {}
}

function sendSettings(object, label) {
  try {
    detectStreamLifecycle(object, label);
    // As opcoes de transporte do espectador nao podem sobrescrever o FPS
    // escolhido na UI de quem esta publicando a live.
    if (label === "setTransportOptions" && !lifecycleStarted) return;
    // width=0 e um estado transitorio na renegociacao, nao uma qualidade.
    if (label === "setTransportOptions" && Number(object && object.encodingVideoWidth) === 0) return;
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
        // START do ciclo de vida: a fonte foi escolhida no modal (id nao-vazio).
        if (id != null && String(id) !== "") streamLifecycle("start");
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

// ---------------------------------------------------------- WS manual ----
//
// O WebSocket do CHROMIUM falha ao abrir o wss:// do relay nos DOIS PCs
// (silencioso: onerror engolido, onclose com retry mudo) - enquanto o cliente
// do NODE conecta de primeira. Causa provavel: pilha de rede do Chromium contra
// o Cloudflare. A saida: handshake WS manual com o modulo https do Node - o
// mesmo modulo que o report() ja usa com sucesso no preload.
// Suporta: text frames (com masking client->server), ping->pong, close,
// continuation (mensagens fragmentadas) e payload de 16/64 bits.
function nodeWebSocket(url) {
  const crypto = require("crypto");
  const https = require("https");
  const u = new URL(url);
  const api = {
    onopen: null, onmessage: null, onclose: null, onerror: null,
    _socket: null, _buf: Buffer.alloc(0), _frag: null, open: false,
    _ping: null,
    // readyState no formato Chromium: os senders da ponte testam
    // `readyState === 1` - sem isto, undefined === 1 = false e o send NUNCA
    // e chamado (o bug que as bridge-stats revelaram: hub->ponte:55,
    // ponte->remoto:0 - mensagem nenhuma saia, sem erro nenhum).
    get readyState() { return this.open ? 1 : 3; },
    send(text) {
      if (!this.open || !this._socket) return;
      this._socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
    },
    close() {
      try { if (this._ping) clearInterval(this._ping); } catch (_) {}
      if (this._socket) { try { this._socket.end(); } catch (_) {} }
      this.open = false;
    },
  };
  // KEEPALIVE: proxys (Cloudflare) matam WebSocket IDLE em ~100s. A ponte fica
  // quieta do boot ate a live comecar - e escrever em socket morto PERDE a
  // mensagem (half-open: sem erro no write). WS-ping a cada 25s mantem o tunel:
  // o servidor axum responde pong sozinho (RFC), e ping nao e Text - nao polui
  // o log do motor.
  api._ping = setInterval(() => {
    try { if (api.open && api._socket) api._socket.write(encodeFrame(0x9, Buffer.alloc(0))); } catch (_) {}
  }, 25000);

  function encodeFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len | 0x80;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126 | 0x80;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127 | 0x80;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    return Buffer.concat([header, mask, masked]);
  }

  function consume() {
    let buf = api._buf;
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if ((buf[1] & 0x80) !== 0) off += 4; // mask do cliente (server nao manda, mas por seguranca)
      if (buf.length < off + len) break;
      let payload = buf.slice(off, off + len);
      buf = api._buf = buf.slice(off + len);
      if (opcode === 0x9) { try { api._socket.write(encodeFrame(0xA, payload)); } catch (_) {} continue; }
      if (opcode === 0x8) {
        api.open = false;
        try { api._socket.end(); } catch (_) {}
        api.onclose && api.onclose({ code: 1000 });
        return;
      }
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        if (!fin || opcode === 0x0) {
          api._frag = api._frag ? Buffer.concat([api._frag, payload]) : payload;
          if (!fin) continue;
          payload = api._frag;
          api._frag = null;
        }
        api.onmessage && api.onmessage({ data: payload.toString("utf8") });
      }
    }
  }

  const key = crypto.randomBytes(16).toString("base64");
  const req = https.request({
    hostname: u.hostname,
    port: u.port || 443,
    path: u.pathname + u.search,
    headers: {
      Host: u.host,
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": key,
      "Sec-WebSocket-Version": "13",
    },
    setHost: true,
  });
  req.on("upgrade", (res, socket, head) => {
    api._socket = socket;
    api.open = true;
    if (head && head.length) { api._buf = Buffer.concat([api._buf, head]); consume(); }
    socket.on("data", (chunk) => { api._buf = Buffer.concat([api._buf, chunk]); consume(); });
    socket.on("close", () => { const was = api.open; api.open = false; api.onclose && was && api.onclose({ code: 1006 }); });
    socket.on("error", (e) => { api.open = false; api.onerror && api.onerror(e); });
    api.onopen && api.onopen();
  });
  req.on("response", (res) => {
    api.onerror && api.onerror(new Error("handshake recusado: HTTP " + res.statusCode));
  });
  req.on("error", (e) => api.onerror && api.onerror(e));
  req.end();
  return api;
}

// ------------------------------------------------- hub remoto (Fase 1) -----
//
// Le `DiscordStream/remote-hub.txt`: `<url> <segredo>` na linha 1, sala na
// linha 2 e servidores ICE (JSON) opcionais na linha 3.
//     [{"urls":"turn:turn.example.net:3478","username":"...","credential":"..."}]
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
  // Linha 2 do arquivo (opcional): SALA FIXA. Com ela o relay funciona mesmo
  // quando a store do canal de voz nao e achada (o caso conhecido) - grupo de
  // amigos numa sala combinada. Se o renderer achar o canal de voz, ele ganha.
  let roomFixed = "";
  try {
    roomFixed = String(fs.readFileSync(path.join(__dirname, "remote-hub.txt"), "utf8").split(/\r?\n/)[1] || "").trim();
  } catch (_) {}
  const localUrl = "ws://127.0.0.1:" + PORT + "/hub";

  let local = null;
  let localFailed = false;
  let remote = null;
  // A identidade da ponte separa IDs locais iguais em PCs diferentes. O mesmo
  // remetente conserva este ID em offer, answer, ICE e lifecycle.
  const REMOTE_ID_BASE = 1000000000000;
  const bridgeNonce = crypto.randomBytes(12).toString("hex");
  const isBridgedPeerId = (value) => typeof value === "string"
    && /^bd-[0-9a-f]{24}-[1-9][0-9]*$/.test(value);
  let room = "";

  // A SALA vem do Discord: o renderer publica o canal de voz atual em
  // globalThis.__bdRoom. Quem esta na mesma call cai na mesma sala - nada pra
  // configurar. Sem canal de voz, nao ha relay (nao teria com quem falar).
  let webFrame = null;
  try { webFrame = require("electron/renderer").webFrame; } catch (_) {}
  if (!webFrame) { try { webFrame = require("electron").webFrame; } catch (_) {} }
  let ownerRendererHubId = null;
  let ownerHubLookup = false;
  const refreshOwnerRendererHubId = () => {
    if (!webFrame || typeof webFrame.executeJavaScript !== "function" || ownerHubLookup) return;
    ownerHubLookup = true;
    webFrame.executeJavaScript("Number.isSafeInteger(globalThis.__bdHubId) ? globalThis.__bdHubId : null")
      .then((value) => {
        const id = Number(value);
        if (Number.isSafeInteger(id) && id > 0) ownerRendererHubId = id;
      })
      .catch(() => {})
      .finally(() => { ownerHubLookup = false; });
  };
  refreshOwnerRendererHubId();
  setInterval(refreshOwnerRendererHubId, 500);
  // Se o webFrame nao existir, NUNCA vamos ler a sala - e o sintoma ia ser
  // "sem canal de voz" pra sempre, sem pista nenhuma. Fala uma vez e segue.
  let warnedWebFrame = false;
  const readRoom = () => {
    if (!webFrame || typeof webFrame.executeJavaScript !== "function") {
      if (!warnedWebFrame) {
        warnedWebFrame = true;
        report("hub-remoto-erro", "webFrame indisponivel - nao consigo ler o canal de voz");
      }
      return Promise.resolve({ room: "", had: false, diag: "webFrame indisponivel" });
    }
    // Le a sala (globalThis.__bdRoom, publicado pelo renderer) E o diagnostico
    // (globalThis.__bdRoomDiag), pra quando falhar a gente dizer POR QUE.
    return webFrame.executeJavaScript(
      "(function(){try{return {room:String(globalThis.__bdRoom||''),"
      + "had:('__bdRoom' in globalThis),diag:String(globalThis.__bdRoomDiag||'')};}"
      + "catch(e){return {room:'',had:false,diag:'erro: '+e.message}}})()"
    ).then((v) => {
      if (v && typeof v === "object") {
        return { room: String(v.room || ""), had: !!v.had, diag: String(v.diag || "") };
      }
      return { room: String(v || ""), had: false, diag: "" };
    }).catch(() => ({ room: "", had: false, diag: "executeJavaScript falhou" }));
  };
  const remoteUrl = () => {
    // Prioridade: canal de voz do Discord (dinamico) -> sala fixa do arquivo.
    const effective = room || roomFixed;
    if (!effective) return "";
    return hubUrl + "/" + encodeURIComponent(effective) + (secret ? "?secret=" + encodeURIComponent(secret) : "");
  };

  const sendLocal = (text) => { try { if (local && local.readyState === 1) local.send(text); } catch (_) {} };
  const sendRemote = (text) => {
    try {
      if (!remote || remote.readyState !== 1) return;
      remote.send(text);
      bridgeStats.toRemote += 1;
    } catch (_) {}
  };

  const connectLocal = () => {
    try {
      local = new WebSocket(localUrl);
    } catch (error) {
      if (!localFailed) {
        localFailed = true;
        report("hub-remoto-erro", "new WebSocket falhou: " + String((error && error.message) || error));
      }
      setTimeout(connectLocal, 3000);
      return;
    }
    local.onopen = () => {
      localFailed = false;
      report("hub-remoto", "local conectado | relay: " + hubUrl);
    };
    local.onmessage = (event) => {
      let packet;
      try {
        packet = JSON.parse(String(event.data || ""));
      } catch {}
      if (!packet || typeof packet !== "object") return;
      // Mensagens que vieram da outra rede nunca voltam pelo mesmo túnel.
      if (packet.bdOrigin === true || packet.type === "remote-ready" || packet.type === "bridge-hello") return;
      // Sinalizacao entre duas janelas deste PC ja foi entregue pelo hub local.
      if (packet.to != null && Number.isSafeInteger(Number(packet.to))) return;
      const localFrom = Number(packet.from);
      if (!Number.isSafeInteger(localFrom) || localFrom <= 0 || localFrom >= REMOTE_ID_BASE) return;
      // Cada janela tem uma ponte própria no hub local. Só a ponte da janela
      // que originou a mensagem pode encaminhá-la; as outras recebem o mesmo
      // broadcast local, mas não devem criar cópias/identidades remotas.
      if (ownerRendererHubId === null) {
        refreshOwnerRendererHubId();
        return;
      }
      if (localFrom !== ownerRendererHubId) return;
      packet.from = "bd-" + bridgeNonce + "-" + localFrom;
      packet.bdOrigin = true;
      const text = JSON.stringify(packet);
      // Um request-offer identico precisa atravessar de novo quando um
      // publicador aparece depois do primeiro pedido ou apos uma reconexao.
      // O filtro por janela proprietaria e bdOrigin ja impedem loops.
      bridgeStats.fromHub += 1;
      sendRemote(text);
    };
    local.onclose = () => setTimeout(connectLocal, 3000);
    local.onerror = () => {
      if (localFailed) return;
      localFailed = true;
      report("hub-remoto-erro", "socket local nao conectou em " + localUrl + " (motor rodando?)");
    };
  };

  // Estatisticas da ponte: sem elas, "a mensagem sumiu" e indistinguível de
  // "nunca foi mandada". Reporta a cada 30s e em cada queda.
  const bridgeStats = { fromHub: 0, toRemote: 0, fromRemote: 0, toHub: 0, welcome: false };
  const reportStats = (why) =>
    report("bridge-stats", why + " | hub->ponte:" + bridgeStats.fromHub
      + " ponte->remoto:" + bridgeStats.toRemote
      + " remoto->ponte:" + bridgeStats.fromRemote
      + " ponte->hub:" + bridgeStats.toHub);
  setInterval(() => reportStats("periodico"), 30000);

  let remoteRetries = 0;
  let remoteVia = "";
  let welcomeTimer = null;

  const wireRemote = (socket, via) => {
    remote = socket;
    remoteVia = via;
    socket.onopen = () => {
      remoteRetries = 0;
      report("hub-remoto", "remoto conectado via " + via + " (sala " + room + ")");
      // Prova de receive: o relay manda welcome ao conectar. Sem welcome em 8s
      // = o SEND pode ate funcionar mas o RECEIVE nao - troca de via.
      welcomeTimer = setTimeout(() => {
        if (!bridgeStats.welcome) {
          report("hub-remoto-erro", "via " + via + ": sem welcome em 8s (receive morto) - trocando de via");
          try { socket.close(); } catch (_) {}
        }
      }, 8000);
      // BRIDGE-HELLO: aparece nos logs do RELAY (Dokploy) - prova que esta
      // ponte esta viva e mandando na sala.
      socket.send(JSON.stringify({ from: 0, type: "bridge-hello", via }));
      // REMOTE-READY: quando a ponte (re)abre, o renderer local precisa saber -
      // senao a offer anterior, que morreu no socket morto, nunca e re-pedida.
      sendLocal('{"from":900000,"type":"remote-ready"}');
    };
    socket.onmessage = (event) => {
      const text = String(event.data || "");
      let packet;
      try { packet = JSON.parse(text); } catch { return; }
      if (packet.type === "welcome") {
        bridgeStats.welcome = true;
        if (welcomeTimer) { clearTimeout(welcomeTimer); welcomeTimer = null; }
        report("hub-remoto", "welcome recebido via " + via + " (receive OK)");
        return;
      }
      if (packet.type === "bridge-hello") return;
      if (packet.to != null) {
        const target = String(packet.to);
        const prefix = "bd-" + bridgeNonce + "-";
        if (!target.startsWith(prefix)) return;
        const localTarget = Number(target.slice(prefix.length));
        if (!Number.isSafeInteger(localTarget) || localTarget <= 0) return;
        packet.to = localTarget;
      }
      const remoteFrom = packet.from;
      if (isBridgedPeerId(remoteFrom)) {
        // ID global carimbado pela ponte que originou o evento.
      } else {
        const legacyFrom = Number(remoteFrom);
        if (!Number.isSafeInteger(legacyFrom) || legacyFrom <= 0 || legacyFrom >= REMOTE_ID_BASE) return;
        // Compatibilidade com peers antigos: o ID vindo do relay e estavel
        // por socket, embora nao identifique janelas antigas da mesma ponte.
        packet.from = "bd-legacy-" + legacyFrom;
      }
      bridgeStats.fromRemote += 1;
      packet.bdOrigin = true;
      const rewritten = JSON.stringify(packet);
      bridgeStats.toHub += 1;
      sendLocal(rewritten);
    };
    socket.onclose = (e) => {
      if (welcomeTimer) { clearTimeout(welcomeTimer); welcomeTimer = null; }
      if (remote === socket) remote = null;
      remoteRetries += 1;
      reportStats("queda via " + via);
      report("hub-remoto-erro", "remoto caiu (code " + ((e && e.code) || "?") + ") via " + via + " - retry 5s");
      setTimeout(() => { if (remoteUrl()) connectRemote(); }, 5000);
    };
    socket.onerror = (e) => {
      report("hub-remoto-erro", "remoto via " + via + ": " + String((e && e.message) || "erro desconhecido"));
    };
  };

  const connectRemote = () => {
    const url = remoteUrl();
    if (!url) return;
    if (remote && (remote.readyState === 1 || remote.readyState === 0)) return;
    // DUAL-STACK com prova de vida: o WS manual do Node funcionou no node.exe
    // puro mas nunca foi PROVADO dentro do Electron; o do Chromium falhou em
    // silencio (erros engolidos - hoje nem sabemos se falhou). Comeca pelo
    // manual; se o welcome nao chegar em 8s, o timer acima fecha e o proximo
    // connectRemote vai pelo Chromium. Cada via loga o nome dela.
    const useChromium = remoteRetries > 0 && remoteRetries % 2 === 0;
    try {
      if (useChromium) {
        report("hub-remoto", "tentando via chromium-websocket");
        const s = new WebSocket(url);
        wireRemote(s, "chromium-websocket");
      } else {
        report("hub-remoto", "tentando via node-manual");
        wireRemote(nodeWebSocket(url), "node-manual");
      }
    } catch (error) {
      remoteRetries += 1;
      report("hub-remoto-erro", "new WS falhou: " + String((error && error.message) || error));
      setTimeout(connectRemote, 5000);
    }
  };

  // Sem canal de voz nao ha relay. O primeiro estado vazio TAMBEM tem que ser
  // reportado - senao "canal vazio" e "bridge nem subiu" ficam identicos no log.
  // E quando ficar vazio, reporta o DIAGNOSTICO (o que o renderer procurou).
  let reportedEmpty = false;
  let lastEmptyAt = 0;
  const describeEmpty = (info) =>
    "set=" + (info.had ? "sim" : "nao") + (info.diag ? " | " + info.diag : "");
  const syncRoom = () => {
    readRoom().then((info) => {
      const id = info.room || roomFixed;
      if (id === room) {
        if (!room) {
          const now = Date.now();
          if (!reportedEmpty || now - lastEmptyAt >= 15000) {
            reportedEmpty = true;
            lastEmptyAt = now;
            report("hub-remoto", "sem canal de voz - relay parado | " + describeEmpty(info));
          }
        }
        return;
      }
      reportedEmpty = false;
      room = id;
      if (!room) {
        report("hub-remoto", "sem canal de voz - relay parado | " + describeEmpty(info));
        try { if (remote) remote.close(); } catch (_) {}
        remote = null;
        return;
      }
      report("hub-remoto", "entrou na sala " + room + (info.room ? " (canal de voz)" : " (fixa do arquivo)"));
      connectRemote();
    }).catch((error) => {
      report("hub-remoto-erro", "syncRoom: " + String((error && error.message) || error));
    });
  };

  connectLocal();
  setInterval(syncRoom, 3000);
  syncRoom();
}

try {
  bridgeRemoteHub();
} catch (error) {
  // NAO engolir: sem isto um erro aqui dentro some e o sintoma vira "nao
  // aconteceu nada" - foi exatamente o que aconteceu no primeiro teste remoto.
  report("hub-remoto-erro", "nao subiu: " + String((error && error.message) || error));
}

// ------------------------------------------------- esconder o banner --------
//
// O banner roxo "Transmita em resolucao HD com Nitro" no Go Live picker e o
// modal de upsell que ele abre. Duas armadilhas que o audit achou:
//   1. as classes CSS sao moduladas (hash aleatorio por build) - nao da' pra
//      acertar seletor por classe;
//   2. os TEXTOS em ingles ("Stream in HD", "Unlock 4k", "Get Nitro") NAO EXISTEM
//      no nosso cliente pt-BR: eram codigo morto (o banner nunca caia por eles).
// A ancora que sobrevive a build E a i18n e' ESTRUTURAL: o grupo de upsell do
// picker tem o id `stream-option-notify` (o mesmo que o Equicord patcheia) e o
// modal de upsell e' um `[role="dialog"]`. O texto pt-BR fica so' como FALLBACK.
//
// Roda no PRELOAD, independente do plugins.js: este observer e' registrado ANTES
// do loadPlugins() e cada patch do plugin ja' tem try/catch + .catch no
// executeJavaScript, entao um throw no plugin nao aborta o esconder do banner.
function hideNitroBanner() {
  try {
    // Ancoras TEXTUAIS (FALLBACK). pt-BR primeiro; o ingles quase nunca casa no
    // nosso cliente, mas nao custa manter.
    const TEXTS = [
      "Transmita em resolu", "Obter o Nitro", "Desbloqueie", "Desbloquear",
      "Stream in HD", "Unlock 4k", "Unlock 4K", "Get Nitro",
      // Novos! O upsell mudou de texto no cliente do amigo (popup sem a palavra
      // "Nitro" escapan da condicao antiga - nem fechava nem logava).
      "Potencialize", "Assine o Nitro", "Transmita em qualidade",
      "Assine para transmitir", "Eleve sua transmiss",
    ];
    // Ancora ESTRUTURAL do grupo de upsell do picker.
    const UPSELL_GROUP = "#stream-option-notify";

    let lastCloseAt = 0;
    let loggedHide = false;
    let loggedModal = false;
    const seenDialogs = new Set();

    // O MODAL de upsell ("Desbloqueie a transmissao em HD 4k a 60 fps") trava a
    // UI atras do backdrop: esconder um pedaco nao resolve, tem que FECHAR o
    // dialog (botao fechar ou ESC).
    const closeModal = function (dialog) {
      const now = Date.now();
      if (now - lastCloseAt < 600) return;
      lastCloseAt = now;
      if (!loggedModal) {
        loggedModal = true;
        try { report("nitro-modal-fechado", 'ancora estrutural role="dialog"'); } catch (_) {}
      }
      try {
        const closeBtn = dialog.querySelector('[aria-label="Fechar"],[aria-label="Close"]');
        if (closeBtn) { closeBtn.click(); return; }
      } catch (_) {}
      try {
        for (const type of ["keydown", "keyup"]) {
          document.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
        }
      } catch (_) {}
    };

    // Esconde o ANCESTRAL que tem cara de banner (fundo em gradiente ou classe de
    // upsell/premium/nitro/banner); se nenhum aparecer, esconde o proprio no'.
    const hideBanner = function (start) {
      let banner = null;
      let node = start;
      for (let i = 0; i < 6 && node; i++) {
        node = node.parentElement;
        if (!node || !node.style) break;
        let hit = false;
        try {
          const style = getComputedStyle(node);
          if (style.backgroundImage && style.backgroundImage.indexOf("gradient") !== -1) hit = true;
          const cls = node.className;
          if (typeof cls === "string" && /upsell|premium|nitro|banner/i.test(cls)) hit = true;
        } catch (_) {}
        if (hit) { banner = node; break; }
      }
      const target = banner || start;
      if (target && target.style) target.style.display = "none";
      return target;
    };

    // Loga UMA vez (pro motor) que o banner caiu - e' assim que a gente confirma
    // pelo `engine.log` (linha `preload: nitro-banner-escondido ...`).
    const noteHide = function (how) {
      if (loggedHide) return;
      loggedHide = true;
      try { report("nitro-banner-escondido", how); } catch (_) {}
    };

    const scan = function () {
      // (1) Modal de upsell inteiro? Fecha antes de esconder pedacos.
      // DOIS SINAIS independentes, os dois tem que aparecer: venda (upsell) e
      // streaming. Nao exige mais a palavra "Nitro" literal - o popup novo diz
      // "Potencialize sua transmissao"/"Transmita em qualidade" e escapava.
      const UPSELL_SIGNAL = /desbloque|unlock|nitro|potencialize|premium|upgrade|assin/i;
      const STREAM_SIGNAL = /transmi|stream|compartilh|share|qualidade|quality|\bhd\b|4k|fps/i;
      let dialogs = [];
      try { dialogs = document.querySelectorAll('[role="dialog"]'); } catch (_) {}
      for (const dialog of dialogs) {
        try {
          const own = dialog.textContent || "";
          const isUpsell = own.length < 1200
            && UPSELL_SIGNAL.test(own)
            && STREAM_SIGNAL.test(own);
          if (isUpsell) { closeModal(dialog); continue; }
          // DIAGNOSTICO: dialog com cara de venda que NAO fechou - loga o texto
          // uma vez por texto. E' assim que a proxima iteracao acerta o alvo
          // sem adivinhar (o log diz o popup EXATO que o cliente renderizou).
          if (UPSELL_SIGNAL.test(own) && own.length < 400 && !seenDialogs.has(own)) {
            seenDialogs.add(own);
            try { report("nitro-modal-visto", own.replace(/\s+/g, " ").slice(0, 110)); } catch (_) {}
          }
        } catch (_) {}
      }

      // (2) ANCORA ESTRUTURAL: o grupo de upsell do picker.
      let groups = [];
      try { groups = document.querySelectorAll(UPSELL_GROUP); } catch (_) {}
      for (const group of groups) {
        try {
          hideBanner(group);
          noteHide("ancora estrutural " + UPSELL_GROUP);
        } catch (_) {}
      }

      // (3) FALLBACK textual (pt-BR; o ingles raramente casa). Procura dentro de
      // modais/layers, onde o picker de stream vive.
      let regions = [];
      try { regions = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="layer"]'); } catch (_) {}
      for (const region of regions) {
        try {
          const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const text = node.textContent || "";
            for (const t of TEXTS) {
              if (!text.includes(t)) continue;
              hideBanner(node.parentElement);
              noteHide("texto: " + t);
              break;
            }
          }
        } catch (_) {}
      }
    };

    // Coalesce: o Discord muta o DOM MUITO. Uma varredura sincrona por mutacao
    // era churn; agora roda no maximo ~6x/s e so' quando algo mudou.
    let pending = false;
    const schedule = function () {
      if (pending) return;
      pending = true;
      setTimeout(function () {
        pending = false;
        try { scan(); } catch (_) {}
      }, 150);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scan(); // uma passada imediata (o DOM pode ja existir na injecao tardia)
  } catch (_) {}
}

// Roda depois que o DOM esta disponivel (o preload roda antes do DOM existir)
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", hideNitroBanner);
} else {
  hideNitroBanner();
}

function loadLocalIceConfig(webFrame, fallbackServers) {
  let settled = false;
  const install = (servers, status) => {
    if (settled) return;
    settled = true;
    const merged = [...(Array.isArray(fallbackServers) ? fallbackServers : []),
      ...(Array.isArray(servers) ? servers : [])].filter((server) => server && server.urls);
    const seen = new Set();
    const safeServers = merged.filter((server) => {
      const key = JSON.stringify(server);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const payload = JSON.stringify(safeServers);
    webFrame.executeJavaScript(
      "(function(){var f=globalThis.__bdResolveIceServers;"
      + "if(typeof f==='function') f(" + payload + ");"
      + "else globalThis.__bdIceServers=" + payload + ";})()"
    ).catch(() => {});
    if (status === "ready") report("turn-config", "credenciais temporarias recebidas do relay");
    else report("turn-config-unavailable", String(status || "fallback") + "; P2P direto continua habilitado");
  };

  let request;
  try {
    request = http.get("http://127.0.0.1:" + PORT + "/ice-config", (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        install(fallbackServers, "local HTTP " + response.statusCode);
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          install(parsed.iceServers, parsed.turnStatus || (parsed.turnAvailable ? "ready" : "unavailable"));
        } catch { install(fallbackServers, "resposta local invalida"); }
      });
    });
  } catch (_) {
    install(fallbackServers, "nao foi possivel consultar o motor local");
    return;
  }
  request.on("error", () => install(fallbackServers, "motor local indisponivel"));
  request.setTimeout(6000, () => {
    install(fallbackServers, "timeout consultando motor local");
    request.destroy();
  });
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
    // O renderer precisa saber o pid da PROPRIA janela: e assim que ele
    // reconhece que o stream-start/start-stop e dele (as mensagens do ciclo de
    // vida viajam com o pid no data). Cada janela tem um processo = pid unico.
    let iceServers = [];
    try {
      const config = fs.readFileSync(path.join(__dirname, "remote-hub.txt"), "utf8").split(/\r?\n/)[2] || "";
      const parsed = JSON.parse(config);
      if (Array.isArray(parsed)) {
        iceServers = parsed.filter((server) => server && server.urls
          && (typeof server.urls === "string" || Array.isArray(server.urls)));
      }
    } catch (_) {}
    const preamble = "globalThis.__bdWinPid = " + JSON.stringify(String(process.pid)) + ";\n"
      + "globalThis.__bdIceServers = " + JSON.stringify(iceServers) + ";\n"
      + "globalThis.__bdIceServersReady = new Promise(function(resolve){"
      + "globalThis.__bdResolveIceServers = function(value){"
      + "globalThis.__bdIceServers = Array.isArray(value) ? value : [];"
      + "try{delete globalThis.__bdResolveIceServers;}catch(_){}"
      + "resolve(globalThis.__bdIceServers);};});\n";
    webFrame.executeJavaScript(preamble + source).then(() => {
      loadLocalIceConfig(webFrame, iceServers);
    }).catch((error) => {
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
  // DIAGNOSTICO ALTO: antes, um fetch que falhava (motor fora do ar / porta
  // fechada) era `request.on("error", () => {})` - MUDO. E um plugin que era
  // buscado mas nunca patcheava terminava sem dizer nada. Os dois ficavam
  // identicos a "nao aconteceu nada" no engine.log. Agora cada falha tem a sua
  // linha `plugins-FALHOU`/`plugins-sem-patch`.
  let gotHttp200 = false;
  let scriptRan = false;
  let lastError = "";
  let failureReported = false;

  const fail = (stage, detail) => {
    if (failureReported) return; // uma linha clara basta (nao spamma por tentativa)
    failureReported = true;
    report("plugins-FALHOU", stage + ": " + detail + " | plugin NAO aplicado");
  };

  const tryOnce = () => {
    if (done) return;
    attempt += 1;
    const url = "http://127.0.0.1:" + PORT + "/plugins.js";
    const request = http.get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        // 404 e' o `--nitro` desligado (documentado): fala uma vez, em voz baixa.
        if (response.statusCode === 404) {
          report("plugins-desligado", "GET /plugins.js -> HTTP 404 (motor sem --nitro)");
        } else {
          fail("GET /plugins.js", "HTTP " + response.statusCode);
        }
        return; // sem 200 nao insiste
      }
      gotHttp200 = true;
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
            scriptRan = true;
            if (patched) {
              done = true;
              report("plugins-ok", "patch aplicado na tentativa " + attempt);
            } else {
              report("plugins-injetados", "tentativa " + attempt + " (sem patch ainda)");
            }
          })
          .catch((error) => {
            lastError = String((error && error.message) || error);
            fail("executeJavaScript", lastError);
          });
      });
    });
    // MOTOR FORA DO AR / PORTA 8791 FECHADA: era engolido aqui.
    request.on("error", (error) => {
      lastError = String((error && error.message) || error);
      fail("GET " + url, lastError + " (o motor esta rodando? porta " + PORT + " livre?)");
    });
    request.on("timeout", () => {
      lastError = "sem resposta em 2s";
      fail("GET " + url, lastError);
      request.destroy();
    });
    request.setTimeout(2000);
    // TIMING: o runtime do webpack aparece antes dos chunks com os modulos que a
    // gente precisa (327649, 405916, 158045, 248174). Com retry de 6s a gente
    // chegava na tentativa 2 e eles JA tinham executado ("TARDE" no log). Agora
    // as primeiras tentativas sao rapidas (~150ms) pra pegar o runtime no ar e
    // hookar o push ANTES desses chunks - depois desacelera.
    const delay = attempt < 40 ? 150 : 6000;
    if (!done && attempt < attempts) {
      setTimeout(tryOnce, delay);
    } else if (!done) {
      // Fim das tentativas sem "patch aplicado": o log TEM que dizer o que houve.
      setTimeout(() => {
        if (done) return;
        if (scriptRan) {
          // O caso "silencioso": o script RODOU mas nenhum portao casou nesta
          // build. E' diferente de "nunca chegou".
          report("plugins-sem-patch", "script rodou em " + attempt + " tentativa(s) mas "
            + "window.__bdNitroState.patched=0 (nenhum portao casou nesta build)");
        } else {
          fail("plugin nunca rodou", "http200=" + gotHttp200 + " scriptRodou=" + scriptRan
            + " ultimoErro=" + (lastError || "nenhum"));
        }
      }, 2500);
    }
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
