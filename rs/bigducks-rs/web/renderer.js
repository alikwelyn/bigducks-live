// bigducks-rs - bridge do renderer (modelo Vencord, sem patch em store vivo).
//
// O que faz:
//   1. libera o botao "Compartilhar tela" com UM override do experimento (Flux)
//   2. pendura no getDisplayMedia: quando o Discord captura a tela, a MESMA
//      trilha vai por P2P (WebRTC) para o outro cliente
//   3. o outro cliente recebe e mostra no painel
//
// Regras:
//   - nada de monkey-patch em prototipo de store (foi o que quebrou o Discord)
//   - o webpack e consultado UMA vez para achar o dispatcher; nunca em loop
//   - nada aparece na tela antes do primeiro frame

(() => {
  if (globalThis.__BD_RS__) return;

  const HUB = 'ws://127.0.0.1:8791/hub';
  const FEED = 'ws://127.0.0.1:8791/ws';
  const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
  const VIDEO_GUARD = '2026-08-video-guard';
  const log = (...args) => console.log('[bd-rs]', ...args);

  const __bdQuality = true;
  let hubSocket = null;
  let hubId = null;
  let peer = null;
  // Mesh: um peer POR espectador, roteado pelo ufrag ICE (cada oferta tem um
  // a=ice-ufrag: proprio e cada candidato carrega usernameFragment). O relay e
  // broadcast - quem casa o ufrag responde; os outros ignoram. Sem isso, N
  // espectadores respondem para UM peer e so um conecta (os demais ficam pretos).
  const peers = new Map();          // ufrag -> { pc, from|null, answered, sdp, viewerUfrag }
  const answeredUfrags = new Map(); // viewer: ufrag -> answer sdp (dedupe)
  const pendingIce = new Map();     // ufrag do viewer -> candidates antes do answer
  const MAX_PEERS = 8;
  function extractUfrag(sdp) {
    const m = typeof sdp === 'string' ? sdp.match(/a=ice-ufrag:(\S+)/) : null;
    return m ? m[1] : null;
  }
  // Ufrag da OFERTA original (o viewer ecoa em a=x-bd-offer-ufrag:).
  function extractOfferUfrag(sdp) {
    const m = typeof sdp === 'string' ? sdp.match(/a=x-bd-offer-ufrag:(\S+)/) : null;
    return m ? m[1] : null;
  }
  function candidateUfrag(candidate) {
    if (!candidate) return null;
    if (candidate.usernameFragment) return candidate.usernameFragment;
    const m = String(candidate.candidate || '').match(/ ufrag (\S+)/);
    return m ? m[1] : null;
  }
  let publishing = null;      // MediaStream vindo do Discord
  let receiving = null;       // MediaStream recebido (P2P)
  let p2pReceiving = false;
  let feedSocket = null;
  let panel = null;
  let videoEl = null;
  let feedTrack = null;
  let feedWriter = null;
  let feedCanvas = null;
  let feedCtx = null;
  let frames = 0;
  let rendered = false;
  let decoding = false;
  let paused = false;
  let unlockTries = 0;
  let unlocked = false;

  // ------------------------------------------------- webpack (sem push!) --
  //
  // NUNCA chamar webpackChunkdiscord_app.push()/pop() aqui. Nesta build o push
  // E o webpackJsonpCallback: o array nao recebe a entrada, entao o pop() remove
  // um chunk REAL e o global chega a ficar indefinido (era a origem da tela
  // cinza). A gente so ENVOLVE o push e observa - nunca injeta nada.

  let wreq = null;
  const BOOT = {
    readyState: document.readyState,
    hadWebpack: !!globalThis.webpackChunkdiscord_app,
    at: performance.now(),
  };

  (function hookWebpack() {
    const KEY = "webpackChunkdiscord_app";
    const observe = (value) => {
      try {
        const originalPush = value.push;
        if (typeof originalPush !== "function") return;
        value.push = function (chunk) {
          try {
            // Captura as FABRICAS antes de serem registradas/executadas (mesma
            // tecnica do plugins.js / HANDOFF 6.4): a store de stream e a do
            // canal de voz sao chunks LAZY, podem nascer depois de qualquer
            // varredura do cache.
            try { captureFactories(chunk && chunk[1]); } catch {}
            if (!wreq && Array.isArray(chunk) && typeof chunk[2] === "function") {
              const originalCallback = chunk[2];
              chunk[2] = function (require) {
                try { if (!wreq && require && require.c) wreq = require; } catch {}
                return originalCallback.apply(this, arguments);
              };
            }
          } catch {}
          return originalPush.apply(this, arguments);
        };
      } catch {}
    };
    try {
      if (globalThis[KEY]) { observe(globalThis[KEY]); return; }
      let stored;
      Object.defineProperty(globalThis, KEY, {
        configurable: true,
        get() { return stored; },
        set(value) { stored = value; observe(value); },
      });
    } catch {}
  })();

  function webpackRequire() {
    if (wreq && wreq.c) return wreq;
    try {
      const chunk = globalThis.webpackChunkdiscord_app;
      if (!chunk || typeof chunk.push !== "function") return null;
      // O push do Discord E o webpackJsonpCallback e DEVOLVE o require.
      // NUNCA damos pop(): o push nao acrescenta nada ao array, entao o pop
      // remove um chunk REAL - foi isso que deixou o global indefinido e
      // quebrou o renderer (tela cinza).
      const returned = chunk.push([[Symbol("bd-rs")], {}, (require) => require]);
      if (returned && returned.c) {
        wreq = returned;
        return wreq;
      }
    } catch {}
    return (wreq && wreq.c) ? wreq : null;
  }

  // O dispatcher do Flux nao e o export do modulo: ele fica DENTRO do exports
  // (ex.: exports.FluxDispatcher). Por isso a varredura em Object.values.
  function findDispatcher() {
    const require = webpackRequire();
    if (!require || !require.c) return null;
    for (const id of Object.keys(require.c)) {
      let exports;
      try { exports = require.c[id] && require.c[id].exports; } catch { continue; }
      if (!exports || typeof exports !== "object") continue;
      let values;
      try { values = Object.values(exports); } catch { continue; }
      for (const value of values) {
        try {
          if (value && typeof value === "object" && typeof value.dispatch === "function" && typeof value.subscribe === "function") return value;
          // Shape alternativo (o que o unlock manual acha no note): o dispatcher
          // real tem _actionHandlers._orderedActionHandlers - e existe casos
          // (minificado/lazy) em que o subscribe nao aparece como function.
          if (value && typeof value === "object" && typeof value.dispatch === "function"
            && value._actionHandlers && value._actionHandlers._orderedActionHandlers) return value;
        } catch {}
      }
      for (const candidate of [exports, exports.default]) {
        try {
          if (candidate && typeof candidate === "object" && typeof candidate.dispatch === "function" && typeof candidate.subscribe === "function") return candidate;
        } catch {}
      }
    }
    return null;
  }

  // ------------------------------------- rewrite do /apex/experiments ------
  //
  // O guard vem do servidor: GET /apex/experiments devolve
  //   "2026-08-video-guard": { variantId: 2 }   (variacoes 1 e 2 = videoEnabled:false)
  // Reescrevemos a RESPOSTA antes de qualquer consumidor ler. Nao depende de
  // webpack. O botao do Go Live le exatamente esse valor:
  //     h = !useConfig({ location: "RTCConnection" }).videoEnabled

  let rewrites = 0;

  function rewriteApex(text) {
    if (typeof text !== "string" || text.indexOf(VIDEO_GUARD) === -1) return null;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") return null;
      let changed = false;
      for (const key of Object.keys(parsed)) {
        if (key !== VIDEO_GUARD) continue;
        parsed[key] = { variantId: 0 };
        changed = true;
      }
      if (!changed) return null;
      rewrites += 1;
      report("experiment-rewrite", { count: rewrites });
      return JSON.stringify(parsed);
    } catch {
      return null;
    }
  }

  let experimentsHooked = false;

  function installExperimentsRewrite() {
    if (experimentsHooked) return true;
    let installed = false;

    try {
      const XHR = globalThis.XMLHttpRequest;
      if (XHR && XHR.prototype) {
        const originalOpen = XHR.prototype.open;
        const originalSend = XHR.prototype.send;
        XHR.prototype.open = function (method, url) {
          try { this.__bdUrl = String(url || ""); } catch {}
          return originalOpen.apply(this, arguments);
        };
        XHR.prototype.send = function () {
          try {
            if (this.__bdUrl && (this.__bdUrl.indexOf("/apex") !== -1 || this.__bdUrl.indexOf("experiment") !== -1)) {
              this.addEventListener("readystatechange", function () {
                if (this.readyState !== 4) return;
                try {
                  const body = this.responseText;
                  if (typeof body !== "string" || body.indexOf(VIDEO_GUARD) === -1) return;
                  report("apex-hit-xhr", { url: String(this.__bdUrl || "").slice(0, 120) });
                  const next = rewriteApex(body);
                  if (next === null) return;
                  const type = this.responseType;
                  if (type === "" || type === "text") {
                    Object.defineProperty(this, "responseText", { configurable: true, get: () => next });
                    Object.defineProperty(this, "response", { configurable: true, get: () => next });
                  } else if (type === "json") {
                    Object.defineProperty(this, "response", { configurable: true, get: () => JSON.parse(next) });
                  }
                } catch {}
              });
            }
          } catch {}
          return originalSend.apply(this, arguments);
        };
        installed = true;
      }
    } catch {}

    try {
      const originalFetch = globalThis.fetch;
      if (typeof originalFetch === "function") {
        globalThis.fetch = function (input, init) {
          let url = "";
          try {
            url = typeof input === "string" ? input : (input && input.url) || "";
          } catch {}
          const promise = originalFetch.apply(this, arguments);
          const looksInteresting = url.indexOf("/apex") !== -1 || url.indexOf("experiment") !== -1 || url.indexOf("/api/") !== -1;
          if (!looksInteresting) return promise;
          return promise.then((response) => {
            try {
              return response.clone().text().then((text) => {
                if (text.indexOf(VIDEO_GUARD) === -1) return response;
                report("apex-hit", { url: url.slice(0, 120) });
                const next = rewriteApex(text);
                if (next === null) return response;
                return new Response(next, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                });
              }).catch(() => response);
            } catch {
              return response;
            }
          });
        };
        installed = true;
      }
    } catch {}

    experimentsHooked = installed;
    return installed;
  }

  // ----------------------------------------------------------- unlock ------

  // O servidor marca as contas brasileiras com o experimento 2026-08-video-guard
  // (videoEnabled:false), e o botao do Go Live le exatamente esse valor:
  //     h = !useConfig({ location: "RTCConnection" }).videoEnabled
  // Um unico override resolve. Nada de patchear store vivo.
  function unlock() {
    if (unlocked) return true;
    unlockTries += 1;
    const dispatcher = findDispatcher();
    if (!dispatcher) return false;
    let ok = false;
    // variantId 0 E -1: o teste manual no note liberou com -1 (sem variante) -
    // e ha caminho (cache de experimento ja carregado com variante bloqueada)
    // em que 0 nao pega. Mandar os dois tipos com os dois valores custa nada
    // e cobre os dois caminhos.
    for (const type of ['APEX_EXPERIMENT_SESSION_OVERRIDE_CREATE', 'APEX_EXPERIMENT_OVERRIDE_CREATE']) {
      for (const variantId of [0, -1]) {
        try {
          dispatcher.dispatch({ type, experimentName: VIDEO_GUARD, variantId });
          ok = true;
        } catch {}
      }
    }
    if (ok) {
      unlocked = true;
      report('unlock', { tries: unlockTries, via: 'dispatch' });
      log('botao Go Live liberado (override do experimento)');
    }
    return ok;
  }

  // A selecao do modal do Discord vem no STREAM_START (sourceId). Repassamos
  // pro motor Rust, que passa a capturar exatamente aquela tela/janela.
  let streamStartWatched = false;

  // O nome da acao muda entre versoes do cliente, e no teste o STREAM_START nao
  // chegou. Assinamos as plausiveis e so agimos quando o payload traz mesmo a
  // fonte escolhida.
  const STREAM_ACTIONS = ["STREAM_START", "STREAM_CREATE", "STREAM_UPDATE", "STREAM_SET_SOURCE", "CALL_UPDATE"];

  function feedSelectedSource(sourceId, pid) {
    try {
      if (sourceId) {
        lastSourceSent = String(sourceId);
        fetch("http://127.0.0.1:8791/source?value=" + encodeURIComponent(sourceId)).catch(() => {});
      } else if (pid) {
        // Compartilhar JANELA/app: o Discord manda o PID, nao o sourceId.
        fetch("http://127.0.0.1:8791/source?pid=" + encodeURIComponent(pid)).catch(() => {});
      }
    } catch {}
  }

  function watchStreamStart() {
    if (streamStartWatched) return true;
    const dispatcher = findDispatcher();
    if (!dispatcher || typeof dispatcher.subscribe !== "function") return false;
    try {
      for (const action of STREAM_ACTIONS) {
        dispatcher.subscribe(action, (payload) => {
          try {
            const sourceId = payload && (payload.sourceId || payload.streamSourceId);
            const pid = payload && payload.pid;
            if (!sourceId && !pid) return;
            reportOnce("stream-start", {
              action,
              sourceId: String(sourceId || "").slice(0, 60),
              pid: pid ? String(pid) : "",
              keys: payload ? Object.keys(payload).slice(0, 12).join(",") : "",
            });
            feedSelectedSource(sourceId, pid);
          } catch {}
        });
      }
      streamStartWatched = true;
      return true;
    } catch {
      return false;
    }
  }

  // Tenta esconder o aviso de erro (2012) que fica por cima do player.
  function hideStreamError(video) {
    try {
      let container = video;
      for (let i = 0; i < 4 && container.parentElement; i += 1) container = container.parentElement;
      const pattern = /2012|n[aã]o foi poss[ií]vel|tente novamente|algo deu errado|n[aã]o consegui|conex[aã]o perdida/i;
      let hidden = 0;
      for (const node of container.querySelectorAll("div,span,p,h1,h2,h3,button")) {
        if (node === video || node.contains(video)) continue;
        let own = "";
        for (const child of node.childNodes) {
          if (child.nodeType === 3) own += child.textContent;
        }
        if (!own.trim() || !pattern.test(own)) continue;
        let target = node;
        for (let i = 0; i < 3 && target.parentElement && target.parentElement !== container; i += 1) {
          target = target.parentElement;
        }
        target.style.display = "none";
        hidden += 1;
      }
      if (hidden) reportOnce("error-hidden", { hidden });
      return hidden;
    } catch {
      return 0;
    }
  }

  // -------------------------------------------------- cobrir a area -------
  //
  // O hook no srcObject acerta o player do Discord (o log mostrou 583x328,
  // visivel), mas o Discord desenha a camada de erro "2012" POR CIMA dele.
  // Entao posicionamos um video nosso exatamente sobre esse retangulo, com
  // z-index alto: fica no lugar certo e tapa o erro.

  let coverEl = null;
  let coverTarget = null;
  let coverStream = null;

  function removeCover() {
    if (!coverEl) return;
    try { coverEl.remove(); } catch {}
    coverEl = null;
    coverTarget = null;
    coverStream = null;
    // Libera o pos-processamento: se o cara saiu da live, a gente para de cobrir.
    if (injectedVideo && !injectedVideo.isConnected) injectedVideo = null;
    report("cover-removed", {});
  }

  function positionCover() {
    if (!coverEl || !coverTarget) return;
    try {
      if (!coverTarget.isConnected) { removeCover(); return; }
      const rect = coverTarget.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      coverEl.style.left = Math.round(rect.left) + "px";
      coverEl.style.top = Math.round(rect.top) + "px";
      coverEl.style.width = Math.round(rect.width) + "px";
      coverEl.style.height = Math.round(rect.height) + "px";
    } catch {}
  }

  // COBERTURA REMOVIDA de proposito.
  //
  // A cobertura existia so pra tapar o aviso de 2012 enquanto a trilha nativa
  // vinha vazia. Agora o player do Discord recebe os NOSSOS frames de verdade
  // (video-health readyState:4), entao ele mostra o video sozinho - grande
  // quando focado, mini quando voce navega. Criar um video por cima so gerava
  // DOIS videos na tela.
  //
  // O que sobra aqui: esconder o texto de erro, se ele aparecer.
  function coverWithVideo(target) {
    if (!target) return false;
    hideStreamError(target);
    reportOnce("player-ok", { width: target.videoWidth });
    return true;
  }


  // Diz se o video esta REALMENTE tocando (e nao so com srcObject setado).
  function reportVideoHealth(video) {
    setTimeout(() => {
      try {
        reportOnce("video-health", {
          readyState: video.readyState,
          paused: video.paused,
          width: video.videoWidth,
          height: video.videoHeight,
          time: Number(video.currentTime.toFixed(2)),
        });
      } catch {}
    }, 1500);
  }

  // ------------------------------------------------------------- painel ----

  function ensurePanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:88px',
      'width:520px', 'height:320px', 'min-width:240px', 'min-height:150px',
      'z-index:2147483646', 'background:#000', 'border:1px solid #2b2d31',
      'border-radius:10px', 'overflow:hidden', 'resize:both',
      'box-shadow:0 12px 40px rgba(0,0,0,.65)',
    ].join(';');

    const bar = document.createElement('div');
    bar.style.cssText = 'height:28px;display:flex;align-items:center;justify-content:space-between;padding:0 4px 0 10px;background:#1e1f22;color:#dbdee1;font:12px/1 system-ui,sans-serif;cursor:move;user-select:none';
    const title = document.createElement('span');
    title.textContent = 'bigducks-rs';
    const close = document.createElement('button');
    close.textContent = 'x';
    close.style.cssText = 'all:unset;cursor:pointer;padding:2px 8px;border-radius:4px;color:#dbdee1';
    close.addEventListener('click', () => closePanel());
    bar.appendChild(title);
    bar.appendChild(close);

    videoEl = document.createElement('video');
    videoEl.autoplay = true;
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.style.cssText = 'width:100%;height:calc(100% - 28px);object-fit:contain;background:#000;display:block';

    panel.appendChild(bar);
    panel.appendChild(videoEl);
    document.body.appendChild(panel);
  }

  function showFeed(stream) {
    receiving = stream;
    ensurePanel();
    if (videoEl) { videoEl.srcObject = stream; videoEl.play().catch(() => {}); }
    rendered = true;
    report('rendered', { source: 'feed' });
  }

  // ------------------------------------------------- hook no srcObject -----
  //
  // Em vez de adivinhar qual <video> e o player, a gente INTERCEPTA a atribuicao
  // de srcObject. Quando o Discord montar o player dele e apontar pro stream
  // (que esta bloqueado), o nosso stream entra no lugar - no elemento certo,
  // sem chute. So age quando existe um stream P2P ativo; fora disso passa reto.

  let srcObjectHooked = false;

  // O Discord usa <video> pequeno pra miniatura da live (240x135) e pro PiP.
  // Trocar o stream ali fazia aparecer uma janelinha a mais na tela; so mexemos
  // em elementos do tamanho de um player de verdade. Os pequenos ficam na lista
  // e sao retentados caso cresçam (janela redimensionada).
  const pendingVideos = new Set();

  function playerSized(video) {
    try {
      const rect = video.getBoundingClientRect();
      return rect.width >= 300 && rect.height >= 170;
    } catch {
      return false;
    }
  }

  function retryPendingVideos() {
    if (!receiving || !pendingVideos.size) return;
    for (const video of Array.from(pendingVideos)) {
      if (!video.isConnected) { pendingVideos.delete(video); continue; }
      if (!playerSized(video)) continue;
      pendingVideos.delete(video);
      try {
        video.srcObject = receiving;
        video.play().catch(() => {});
        if (injectedVideo !== video) {
          injectedVideo = video;
          if (panel) hidePanel();
          reportOnce("player-sized-late", describeVideo(video));
          reportVideoHealth(video);
        }
      } catch {}
    }
  }

  function installSrcObjectHook() {
    if (srcObjectHooked) return true;
    try {
      const proto = HTMLMediaElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "srcObject");
      if (!descriptor || typeof descriptor.set !== "function") return false;
      const originalSet = descriptor.set;
      const originalGet = descriptor.get;
      Object.defineProperty(proto, "srcObject", {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
          return originalGet ? originalGet.call(this) : undefined;
        },
        set(value) {
          try {
            if (receiving && this && this.tagName === "VIDEO") {
              // O video do NOSSO painel fallback: o hook nunca mexe nele -
              // trocar o srcObject dele gerava hidePanel -> ensurePanel -> hide
              // em LOOP (o spam de panel-hidden que inundava o hub).
              if (this === videoEl) return originalSet.call(this, value);
              const isStream = typeof MediaStream !== "undefined" && value instanceof MediaStream;
              const isClearing = value === null || value === undefined;
              // Troca o stream do Discord pelo nosso; deixa o "limpar" passar.
              if (isStream || (!isClearing && value != null)) {
                if (!playerSized(this)) {
                  // Miniatura/PiP: guarda pra tentar de novo se virar player.
                  pendingVideos.add(this);
                } else {
                  if (value !== receiving) {
                    reportOnce("srcobject-hook", describeVideo(this));
                  }
                  if (injectedVideo !== this) {
                    injectedVideo = this;
                    if (panel) hidePanel();
                    reportVideoHealth(this);
                  }
                  coverWithVideo(this, receiving);
                  return originalSet.call(this, receiving);
                }
              }
            }
          } catch {}
          return originalSet.call(this, value);
        },
      });
      srcObjectHooked = true;
      return true;
    } catch {
      return false;
    }
  }

  // Ajuda a saber ONDE estamos injetando (tamanho do video e dos pais).
  function describeVideo(video) {
    try {
      const rect = video.getBoundingClientRect();
      const chain = [];
      let element = video.parentElement;
      for (let i = 0; i < 6 && element; i += 1) {
        const parentRect = element.getBoundingClientRect();
        chain.push(Math.round(parentRect.width) + "x" + Math.round(parentRect.height));
        element = element.parentElement;
      }
      const hidden = rect.width < 2 || rect.height < 2;
      return {
        video: Math.round(rect.width) + "x" + Math.round(rect.height),
        hidden,
        parents: chain.join(" > "),
      };
    } catch {
      return {};
    }
  }

  // ------------------------------------------------- player NATIVO -------
  //
  // O Discord renderiza o stream num <video> comum. Quando o P2P chega, a
  // gente injeta o nosso stream NESSE <video>: o video aparece no proprio
  // player do Discord (nome, controles, tela cheia), nao numa janelinha.
  // A janelinha vira so fallback, para quando nao existe player aberto.

  let injectedVideo = null;

  function findStreamVideo() {
    let best = null;
    let bestArea = 0;
    try {
      for (const video of document.querySelectorAll('video')) {
        const rect = video.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (rect.width < 320 || rect.height < 200) continue;
        if (area > bestArea) { bestArea = area; best = video; }
      }
    } catch {}
    return best;
  }

  function tryInjectNative() {
    if (!receiving) return false;
    const video = findStreamVideo();
    if (!video) return false;
    try {
      if (video.srcObject !== receiving) {
        video.srcObject = receiving;
        video.play().catch(() => {});
        report('native-inject', { width: Math.round(video.getBoundingClientRect().width) });
      }
      injectedVideo = video;
      if (panel) hidePanel();
      coverWithVideo(video, receiving);
      reportVideoHealth(video);
      return true;
    } catch {
      return false;
    }
  }

  // A janelinha e so fallback: se o player do Discord aparecer DEPOIS (o usuario
  // so clica na live mais tarde), ela sai de cena.
  function hidePanel() {
    if (!panel) return;
    try { if (videoEl) videoEl.srcObject = null; } catch {}
    panel.remove();
    panel = null;
    videoEl = null;
    // reportOnce: o caminho antigo reportava TODA chamada - com o ciclo de vida
    // reaberto o hide entrava em loop e o spam enchia o broadcast do hub
    // (buffer 64), derrubando answer/ICE reais por lag.
    reportOnce("panel-hidden", {});
  }

  function showPanel(stream) {
    ensurePanel();
    if (videoEl) {
      videoEl.srcObject = stream;
      videoEl.play().catch(() => {});
    }
    rendered = true;
  }

  function showStream(stream, source) {
    p2pReceiving = true;
    receiving = stream;
    rendered = true;
    report('rendered', { source });
    log('stream de', source, '- aguardando o player do Discord');
    installSrcObjectHook();
    // O usuario precisa clicar na live para o Discord montar o <video>; damos
    // alguns segundos de chance e so entao caímos na janelinha.
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (injectedVideo || tries >= 10) {
        clearInterval(timer);
        if (!injectedVideo) {
          log('player nativo nao encontrado; usando a janelinha');
          showPanel(stream);
        }
      }
    }, 500);
  }

  function closePanel() {
    paused = true;
    rendered = false;
    try { if (feedWriter) feedWriter.close(); } catch {}
    try { if (feedTrack) feedTrack.stop(); } catch {}
    feedWriter = null;
    feedTrack = null;
    if (panel) { panel.remove(); panel = null; videoEl = null; }
    try { if (feedSocket) feedSocket.close(); } catch {}
    feedSocket = null;
    report('panel-closed', {});
  }

  // ------------------------------------------------- feed RGBA (fallback) --

  function ensureFeedTrack() {
    if (feedTrack) return feedTrack;
    try {
      if (typeof MediaStreamTrackGenerator === 'function') {
        feedTrack = new MediaStreamTrackGenerator({ kind: 'video' });
        feedWriter = feedTrack.writable.getWriter();
      } else {
        feedCanvas = document.createElement('canvas');
        feedCtx = feedCanvas.getContext('2d', { alpha: false });
        feedTrack = feedCanvas.captureStream(30).getVideoTracks()[0];
      }
    } catch (error) {
      log('track falhou', error);
      return null;
    }
    return feedTrack;
  }

  function connectFeed() {
    if (paused) return;
    if (feedSocket && feedSocket.readyState <= 1) return;
    feedSocket = new WebSocket(FEED);
    feedSocket.binaryType = 'arraybuffer';
    feedSocket.onclose = () => setTimeout(connectFeed, 3000);
    feedSocket.onerror = () => {};
    feedSocket.onmessage = async (event) => {
      if (decoding || p2pReceiving) return; // P2P tem prioridade
      decoding = true;
      try {
        const buffer = event.data;
        const view = new DataView(buffer);
        const width = view.getUint32(0, true);
        const height = view.getUint32(4, true);
        const timestamp = Number(view.getBigUint64(8, true));
        const pixels = new Uint8Array(buffer.slice(16));
        if (!ensureFeedTrack()) return;
        if (feedWriter) {
          const frame = new VideoFrame(pixels, { format: 'RGBA', codedWidth: width, codedHeight: height, timestamp });
          await feedWriter.write(frame);
          frame.close();
        } else if (feedCtx) {
          if (feedCanvas.width !== width || feedCanvas.height !== height) {
            feedCanvas.width = width;
            feedCanvas.height = height;
          }
          feedCtx.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height), 0, 0);
        }
        if (!rendered && !feedPublishing) {
          showFeed(new MediaStream([feedTrack]));
        }
        frames += 1;
      } catch (error) {
        log('frame falhou', error);
      }
      decoding = false;
    };
  }

  // ------------------------------------------------- captura NATIVA -------
  //
  // No Windows o Discord captura pelo motor NATIVO - nao passa por
  // getDisplayMedia (o hook acima so serve para o cliente web).
  //
  // Mas o proprio cliente TEM a trilha da nossa tela: e por isso que quem
  // transmite "ve a propria live". O player nativo faz exatamente isto:
  //
  //     const { streamId } = props;            // componente "DirectVideo"
  //     window.createDiscordStream(streamId)   // -> MediaStream
  //
  // Entao a gente pega o stream ativo do usuario atual na store e publica a
  // MESMA trilha por P2P.

  // O Discord exporta Proxies que devolvem "funcao" para QUALQUER propriedade
  // (o de i18n e o mais famoso). Sem filtrar isso, a varredura acha o proxy e
  // a gente acaba lendo lixo. Truque do Vencord: testar uma chave improvavel.
  function isProxyLike(value) {
    try {
      if (value == null) return true;
      if (value === globalThis || value === document || value === document.documentElement) return true;
      const tag = value[Symbol.toStringTag];
      if (tag === "IntlMessagesProxy" || tag === "DOMTokenList") return true;
      const probeKey = "__bd_probe__" + Math.random().toString(36).slice(2);
      if (value[probeKey] !== undefined) {
        try { delete value[probeKey]; } catch {}
        return true;
      }
    } catch {}
    return false;
  }

  // Precisa parecer mesmo um stream do Discord (tem dono e id), senao e lixo.
  function looksLikeStream(stream) {
    if (stream == null) return false;
    if (typeof stream === "string") return stream.length > 0;
    if (typeof stream !== "object") return false;
    if (isProxyLike(stream)) return false;
    try {
      return ("ownerId" in stream) || ("streamId" in stream) || ("id" in stream) || ("streamKey" in stream);
    } catch {
      return false;
    }
  }

  // O Discord nao guarda o streamId no objeto do stream: ele DERIVA
  //   streamKey = [streamType, guildId, channelId, ownerId].join(":")
  // (modulo 652896 do bundle). O player nativo usa esse valor.
  function streamKeyOf(stream) {
    try {
      const type = stream.streamType;
      const guild = stream.guildId;
      const channel = stream.channelId;
      const owner = stream.ownerId;
      if (!type) return null;
      if (guild) return [type, guild, channel, owner].join(":");
      if (channel) return [type, channel, owner].join(":");
    } catch {}
    return null;
  }

  // ---- captura as FABRICAS do webpack (o modulo pode nascer DEPOIS) ---------
  //
  // A varredura do cache (require.c) so enxerga modulos JA EXECUTADOS. A store
  // de stream ativo e um chunk LAZY: numa rodada real o boot viu 69 modulos
  // ("engine-scan scanned:69") e a store nunca apareceu - porque ela so e
  // carregada quando a UI de call abre, muito depois do scan de boot. Entao,
  // alem de varrer o cache A CADA poll (sem cachear o "nao achei"), a gente
  // REUSA o mecanismo que ja funciona no plugins.js (HANDOFF 6.4): um gancho no
  // push do webpack, instalado antes dos chunks rodarem. Quando chega uma fabrica
  // cujo codigo cita a assinatura, ela e EMBRULHADA - e no momento em que executa
  // a gente guarda os exports. Assim o objeto fica acessivel mesmo sem aparecer
  // na varredura.
  const STORE_SIGNATURE = "getCurrentUserActiveStream";
  const VOICE_SIGNATURE = "getVoiceChannelId";
  // A engine de midia tambem e chunk LAZY: a fabrica que cita o picker nativo e
  // capturada no push, igual a store e a do canal de voz.
  const ENGINE_SIGNATURE = "presentNativeScreenSharePicker";

  function capture() {
    try {
      return globalThis.__bdCapture || (globalThis.__bdCapture = {
        store: { ids: [], candidates: [] },
        voice: { ids: [], candidates: [] },
        engine: { ids: [], candidates: [] },
      });
    } catch { return null; }
  }

  // Acha a store de stream ativo dentro de um namespace webpack. `trusted` =
  // veio de uma fabrica que CITA a assinatura: pula o filtro de proxy, porque a
  // store real pode vir embrulhada e o isProxyLike a descartaria.
  function findStoreIn(value, depth, trusted) {
    if (!value || typeof value !== "object" || depth > 2) return null;
    if (!trusted && isProxyLike(value)) return null;
    try {
      if (typeof value.getCurrentUserActiveStream === "function"
        && typeof value.getAllActiveStreams === "function") return value;
    } catch {}
    let values;
    try { values = [value.default].concat(Object.values(value)); } catch { values = []; }
    for (const child of values) {
      if (!child || typeof child !== "object") continue;
      const hit = findStoreIn(child, depth + 1, trusted);
      if (hit) return hit;
    }
    return null;
  }

  // Idem para a store do canal de voz (o id que vira a SALA do relay).
  function findVoiceIn(value, depth, trusted) {
    if (!value || typeof value !== "object" || depth > 2) return null;
    if (!trusted && isProxyLike(value)) return null;
    try {
      if (typeof value.getVoiceChannelId === "function") return value;
      if (typeof value.getCurrentVoiceChannelId === "function") return value;
    } catch {}
    let values;
    try { values = [value.default].concat(Object.values(value)); } catch { values = []; }
    for (const child of values) {
      if (!child || typeof child !== "object") continue;
      const hit = findVoiceIn(child, depth + 1, trusted);
      if (hit) return hit;
    }
    return null;
  }

  // A engine nativa de midia tem um dos dois formatos abaixo (HANDOFF 4.1).
  // Guarda barata: so vale para objeto/funcao - primitivo nem chega aqui.
  function engineCandidateOf(value) {
    try {
      if (typeof value.presentNativeScreenSharePicker === "function") return true;
      if (typeof value.getScreenPreviews === "function"
        && typeof value.addDirectVideoOutputSink === "function") return true;
    } catch {}
    return false;
  }

  // Acha a engine de midia dentro de um namespace webpack (mesma varredura da
  // store/voz: `trusted` pula o filtro de proxy).
  function findEngineIn(value, depth, trusted) {
    if (!value || typeof value !== "object" || depth > 2) return null;
    if (!trusted && isProxyLike(value)) return null;
    if (engineCandidateOf(value)) return value;
    let values;
    try { values = [value.default].concat(Object.values(value)); } catch { values = []; }
    for (const child of values) {
      if (!child || typeof child !== "object") continue;
      const hit = findEngineIn(child, depth + 1, trusted);
      if (hit) return hit;
    }
    return null;
  }

  // Roda no PUSH, ANTES de o modulo ser registrado e executado.
  function captureFactories(modules) {
    if (!modules || typeof modules !== "object") return;
    const reg = capture();
    if (!reg) return;
    for (const id of Object.keys(modules)) {
      const factory = modules[id];
      if (typeof factory !== "function" || factory.__bdCaptured) continue;
      let source;
      try { source = Function.prototype.toString.call(factory); } catch { continue; }
      const wantsStore = source.indexOf(STORE_SIGNATURE) !== -1;
      const wantsVoice = source.indexOf(VOICE_SIGNATURE) !== -1;
      const wantsEngine = source.indexOf(ENGINE_SIGNATURE) !== -1;
      if (!wantsStore && !wantsVoice && !wantsEngine) continue;

      if (wantsStore && reg.store.ids.indexOf(id) === -1) reg.store.ids.push(id);
      if (wantsVoice && reg.voice.ids.indexOf(id) === -1) reg.voice.ids.push(id);
      if (wantsEngine && reg.engine.ids.indexOf(id) === -1) reg.engine.ids.push(id);
      report("store-factory", { module: String(id), store: wantsStore, voice: wantsVoice, engine: wantsEngine });

      // Embrulha mantendo a assinatura (module, exports, require): no retorno a
      // gente le os exports NA HORA da execucao da fabrica.
      try {
        modules[id] = function (module, exports, require) {
          const result = factory.apply(this, arguments);
          try {
            if (wantsStore) {
              const hit = findStoreIn(exports, 0, true) || findStoreIn(result, 0, true);
              if (hit && reg.store.candidates.indexOf(hit) === -1) {
                reg.store.candidates.push(hit);
                report("store-captured", { module: String(id), via: "execucao" });
              }
            }
            if (wantsVoice) {
              const hit = findVoiceIn(exports, 0, true) || findVoiceIn(result, 0, true);
              if (hit && reg.voice.candidates.indexOf(hit) === -1) {
                reg.voice.candidates.push(hit);
                report("voice-captured", { module: String(id), via: "execucao" });
              }
            }
            if (wantsEngine) {
              const hit = findEngineIn(exports, 0, true) || findEngineIn(result, 0, true);
              if (hit && reg.engine.candidates.indexOf(hit) === -1) {
                reg.engine.candidates.push(hit);
                report("engine-captured", { module: String(id), via: "execucao" });
              }
            }
          } catch {}
          return result;
        };
        modules[id].__bdCaptured = true;
      } catch {}
    }
  }

  let lastStoreScan = { scanned: 0, cache: 0, ids: 0, captured: 0, found: false, error: "" };
  let lastStoreScanAt = 0;

  // (a) NAO ha cache aqui: e re-rodada a CADA poll. (b) os candidatos capturados
  // na execucao da fabrica vem primeiro; se nada, varre o cache executado.
  function findStreamStore() {
    lastStoreScanAt = Date.now();
    lastStoreScan = { scanned: 0, cache: 0, ids: 0, captured: 0, found: false, error: "" };

    const reg = capture();
    if (reg) {
      lastStoreScan.ids = reg.store.ids.length;
      lastStoreScan.captured = reg.store.candidates.length;
      for (const candidate of reg.store.candidates) {
        const hit = findStoreIn(candidate, 0, true);
        if (hit) { lastStoreScan.found = true; return hit; }
      }
    }

    const require = webpackRequire();
    if (!require || !require.c) { lastStoreScan.error = "no-webpack"; return null; }
    const ids = Object.keys(require.c);
    lastStoreScan.cache = ids.length;
    for (const id of ids) {
      let exports;
      try { exports = require.c[id] && require.c[id].exports; } catch { continue; }
      if (!exports || typeof exports !== "object") continue;
      if (isProxyLike(exports)) continue;
      lastStoreScan.scanned += 1;
      const hit = findStoreIn(exports, 0, false);
      if (hit) { lastStoreScan.found = true; return hit; }
    }
    // (c) ultimo recurso: os ids vistos no push - o modulo pode ter executado
    // entre a varredura e agora.
    if (reg && reg.store.ids.length) {
      for (const id of reg.store.ids) {
        try {
          const mod = require.c && require.c[id];
          const hit = mod && findStoreIn(mod.exports, 0, true);
          if (hit) { lastStoreScan.found = true; return hit; }
        } catch {}
      }
    }
    return null;
  }

  // (c) resumo do que foi procurado e visto - pra falha ser diagnosticavel pelo
  // log do motor sozinho (antes era um "no-store" mudo).
  function storeScanSummary() {
    const s = lastStoreScan;
    return "scanned=" + s.scanned + " cache=" + s.cache + " fabricas=" + s.ids
      + " capturados=" + s.captured + " found=" + s.found + (s.error ? " err=" + s.error : "");
  }

  // (a)+(c): garante uma varredura por poll mesmo quando o tryNativeCapture sai
  // cedo, e reporta o resumo - na mudanca de estado e, enquanto NAO achar, a cada
  // 10s (pra uma falha ser diagnosticavel so pelo log do motor).
  let lastStoreDiagAt = 0;
  let lastStoreFound = false;
  function pollStore() {
    // Se o tryNativeCapture varreu agora, aproveita; senao varre aqui.
    if (Date.now() - lastStoreScanAt > 2500) { try { findStreamStore(); } catch {} }
    const found = lastStoreScan.found;
    const now = Date.now();
    if (found !== lastStoreFound) {
      lastStoreFound = found;
      lastStoreDiagAt = now;
      report("store-scan", { summary: storeScanSummary(), publishingNative });
      return;
    }
    if (!found && now - lastStoreDiagAt >= 10000) {
      lastStoreDiagAt = now;
      report("store-scan", { summary: storeScanSummary(), publishingNative });
    }
  }

  // Modulo nativo de voz do Discord (a MESMA engine que o cliente usa).
  function nativeVoiceModule() {
    try {
      const native = globalThis.DiscordNative && globalThis.DiscordNative.nativeModules;
      if (native && typeof native.requireModule === "function") {
        return native.requireModule("discord_voice");
      }
    } catch {}
    return null;
  }

  let publishingNative = false;
  let lastNativeTry = 0;
  let feedPublishing = false;

  // A trilha nativa do Discord (createDiscordStream) vem VAZIA quando a live
  // esta bloqueada (readyState 0, sem frames). Entao a fonte do video passa a
  // ser a captura do motor Rust: ela vira uma MediaStream e vai por P2P.
  // O gatilho continua sendo o botao "Compartilhar tela" do Discord.
  async function publishFeed() {
    if (publishing) return false;
    const track = ensureFeedTrack();
    if (!track) return false;
    feedPublishing = true;
    publishingNative = true;
    connectFeed();
    report("native-trigger-feed", {});
    await publish(new MediaStream([track]));
    return true;
  }
  let lastPollState = "";

  // Reporta cada mudanca de estado do poll (em vez de repetir a cada tique).
  function notePoll(state) {
    if (state === lastPollState) return;
    lastPollState = state;
    console.log("[bd-rs] poll:", state);
    report("native-poll", { state, publishingNative });
  }

  // Quando a live termina (ou o usuario troca de tela), libera tudo pra poder
  // compartilhar de novo sem reiniciar o Discord.
  function checkStreamStopped() {
    if (!publishingNative) return;
    // SEM STORE NAO HA DECISAO: store ausente (o caso conhecido) e diferente de
    // "live encerrada". O bug anterior tratava stream=null como fim de live e
    // MATAVA o publicador 2s depois do handshake (o native-stopped do log -
    // exatamente quando a store nunca e achada). So para quando a store EXISTE
    // e diz explicitamente que nao ha stream ativo.
    let store = null;
    try { store = findStreamStore(); } catch { return; }
    if (!store) return;
    let stream = null;
    try { stream = store.getCurrentUserActiveStream(); } catch { return; }
    if (stream) return;
    forceStopPublishing();
    report("native-stopped", { via: "store" });
  }

  // ------------------------------------------------- fonte escolhida ------
  //
  // Qual tela/janela o usuario escolheu no modal vive no estado do proprio
  // Discord (o ApplicationSwitchingManager guarda um Map `streams` com
  // { type, sourceId, source }). Ler dali e read-only: nao patcheia nada.
  // Sem isso o motor capturaria sempre o monitor principal.

  let sourceManager = null;
  let lastSourceSent = "";
  let lastSourceScan = 0;
  let mediaEngineWrapped = false;
  let deepScanned = false;

  // "screen:0:1", "window:132956", "application:..." - a assinatura da fonte.
  const SOURCE_ID = /^(?:screen|window|application|camera):[0-9A-Za-z:_-]{1,40}$/;

  function looksLikeSourceId(value) {
    return typeof value === "string" && SOURCE_ID.test(value);
  }

  // Valores de um namespace webpack, mas com TETO. `Object.values(exports)` num
  // modulo cujo export e um mapa de dados gigante (i18n, assets, config) vira
  // dezenas de milhares de "candidatos" e e o que fazia o contador da varredura
  // explodir. Um modulo de engine tem poucos exports - acima do teto a gente so
  // olha `exports` e `exports.default` (onde a engine vive) e NAO materializa o
  // mapa inteiro.
  const EXPORT_VALUE_CAP = 32;
  function exportValues(exports) {
    const out = [exports, undefined];
    try { out[1] = exports.default; } catch { out[1] = undefined; }
    try {
      const names = Object.keys(exports);
      if (names.length <= EXPORT_VALUE_CAP) {
        for (const name of names) {
          let value;
          try { value = exports[name]; } catch { continue; }
          out.push(value);
        }
      }
    } catch {}
    return out;
  }

  // Procura um sourceId dentro de um valor (objeto, array, Map), com limites.
  function findSourceIn(value, depth) {
    if (value == null || depth > 3) return "";
    if (looksLikeSourceId(value)) return value;
    if (typeof value !== "object") return "";
    try {
      if (value instanceof Map) {
        for (const entry of value.values()) {
          const found = findSourceIn(entry, depth + 1);
          if (found) return found;
        }
        return "";
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = findSourceIn(item, depth + 1);
          if (found) return found;
        }
        return "";
      }
      for (const key of Object.keys(value)) {
        let item;
        try { item = value[key]; } catch { continue; }
        const found = findSourceIn(item, depth + 1);
        if (found) return found;
      }
    } catch {}
    return "";
  }

  function useSource(sourceId) {
    const value = String(sourceId || "");
    if (!value || value === lastSourceSent) return;
    lastSourceSent = value;
    report("source-found", { sourceId: value });
    fetch("http://127.0.0.1:8791/source?value=" + encodeURIComponent(value)).catch(() => {});
  }

  // A engine nativa de midia e quem recebe o sourceId escolhido no modal.
  //
  // CUSTO: cada linha da varredura e um MODULO do cache do webpack (require.c).
  // O cache sai de ~63 modulos no boot para ~37.000 depois que o bundle carrega
  // (HANDOFF 6.1) - entao varrer ele A CADA poll de 2.5s era o desperdicio que
  // levava o contador a dezenas de milhares. Aqui: (a) a varredura do cache roda
  // UMA vez por sessao; (b) so entra na conta o registro que passa pela guarda
  // barata (export objeto/funcao, nao-Proxy) - string/mapa de dados nunca conta;
  // (c) o chunk LAZY da engine, se existir, ja vem capturado no push do webpack
  // (captureFactories -> reg.engine), igual a store e a do canal de voz.
  let registryWalked = false;

  function findMediaEngine() {
    let scanned = 0;
    let marked = 0;
    let found = null;

    // (1) candidatos capturados no push - O(tens), sem tocar no cache.
    const reg = capture();
    if (reg && reg.engine && reg.engine.candidates.length) {
      scanned = reg.engine.candidates.length;
      for (const candidate of reg.engine.candidates) {
        if (!engineCandidateOf(candidate)) continue;
        marked += 1;
        if (!found) found = candidate;
      }
      if (found) { reportOnce("engine-scan", { scanned, marked, via: "captura" }); return found; }
    }

    const require = webpackRequire();
    if (!require || !require.c) return null;
    if (registryWalked) return null;
    registryWalked = true;

    for (const id of Object.keys(require.c)) {
      let exports;
      try { exports = require.c[id] && require.c[id].exports; } catch { continue; }
      // GUARDA BARATA: um registro so e olhado - e so ENTRA NA CONTA - se o
      // export for um modulo de verdade (objeto/funcao). Primitivo (string,
      // numero) e Proxy sao pulados SEM contar.
      if (!exports || (typeof exports !== "object" && typeof exports !== "function")) continue;
      if (isProxyLike(exports)) continue;
      scanned += 1; // UMA vez por modulo REAL - nao por valor exportado
      for (const candidate of exportValues(exports)) {
        if (!candidate || typeof candidate !== "object" || isProxyLike(candidate)) continue;
        if (!engineCandidateOf(candidate)) continue;
        marked += 1;
        if (!found) found = candidate;
      }
    }
    // Reporta mesmo quando nao acha: e o que diz se o problema e o filtro ou a
    // ausencia do modulo.
    reportOnce("engine-scan", { scanned, marked });
    if (found) return found;
    // Segunda passada (uma vez por sessao): procura pelo NOME dos metodos, caso
    // a versao do cliente tenha renomeado o modulo.
    if (deepScanned) return null;
    deepScanned = true;
    for (const id of Object.keys(require.c)) {
      let exports;
      try { exports = require.c[id] && require.c[id].exports; } catch { continue; }
      if (!exports || (typeof exports !== "object" && typeof exports !== "function")) continue;
      if (isProxyLike(exports)) continue;
      for (const candidate of exportValues(exports)) {
        if (!candidate || typeof candidate !== "object" || isProxyLike(candidate)) continue;
        let own;
        try { own = Object.getOwnPropertyNames(candidate); } catch { continue; }
        const hit = own.find((name) =>
          /DirectVideoOutputSink|ScreenSharePicker|NextVideoOutputFrame|OwnStreamConnection|ScreenPreview/i.test(name));
        if (hit) { reportOnce("engine-deep", { hit }); return candidate; }
      }
    }
    reportOnce("engine-deep", { hit: "" });
    return null;
  }

  // Embrulha os metodos da engine SO pra ler os argumentos (o retorno passa
  // igual): e por aqui que o sourceId entra quando a captura comeca.
  function wrapMediaEngine() {
    if (mediaEngineWrapped) return true;
    const engine = findMediaEngine();
    if (!engine) return false;
    let names;
    try { names = Object.keys(engine); } catch { return false; }
    let wrapped = 0;
    for (const name of names) {
      let fn;
      try { fn = engine[name]; } catch { continue; }
      if (typeof fn !== "function") continue;
      if (!/stream|capture|source|screen|share/i.test(name)) continue;
      engine[name] = function () {
        const args = Array.prototype.slice.call(arguments);
        try {
          const flat = args.map((arg) => (arg && typeof arg === "object")
            ? JSON.stringify(arg).slice(0, 220)
            : String(arg).slice(0, 60));
          reportOnce("engine-call", { name: String(name).slice(0, 32), args: flat.join(" | ") });
          for (const arg of args) {
            const found = findSourceIn(arg, 0);
            if (found) { useSource(found); break; }
          }
        } catch {}
        return fn.apply(this, arguments);
      };
      wrapped += 1;
    }
    mediaEngineWrapped = true;
    if (wrapped) reportOnce("engine-wrapped", { wrapped });
    return wrapped > 0;
  }

  // Toda acao do Flux passa por dispatch. So observamos (e repassamos igual):
  // e a unica via que nao depende de adivinhar o nome da acao.
  let dispatchWrapped = false;

  function wrapDispatch() {
    if (dispatchWrapped) return true;
    const dispatcher = findDispatcher();
    if (!dispatcher || typeof dispatcher.dispatch !== "function") return false;
    const original = dispatcher.dispatch;
    const sampledTypes = new Set();
    const wrapper = function (action) {
      try {
        const type = action && action.type;
        // Prova de vida: os primeiros tipos que passam por aqui. Se nenhum
        // aparecer, o wrapper nao esta no caminho do dispatch.
        if (type && sampledTypes.size < 20 && !sampledTypes.has(String(type))) {
          sampledTypes.add(String(type));
          reportOnce("actions-sample", {
            count: sampledTypes.size,
            types: Array.from(sampledTypes).join(","),
          });
        }
        if (type && /STREAM|SCREEN|CAPTURE|SHARE|CLIP|RTC/i.test(String(type))) {
          const found = findSourceIn(action, 0);
          reportOnce("action-seen", {
            type: String(type).slice(0, 40),
            source: found || "",
            keys: Object.keys(action).slice(0, 14).join(","),
            sample: JSON.stringify(action).slice(0, 200),
          });
          if (found) useSource(found);
        }
      } catch {}
      return original.apply(this, arguments);
    };
    // A atribuicao pode falhar em silencio (propriedade nao-gravavel), e ai a
    // gente acharia que observa tudo sem observar nada. Confere a cada tentativa.
    let ok = false;
    try {
      dispatcher.dispatch = wrapper;
      ok = dispatcher.dispatch === wrapper;
    } catch {}
    if (!ok) {
      try {
        Object.defineProperty(dispatcher, "dispatch", { value: wrapper, configurable: true, writable: true });
        ok = dispatcher.dispatch === wrapper;
      } catch {}
    }
    if (!ok) {
      try {
        const proto = Object.getPrototypeOf(dispatcher);
        proto.dispatch = wrapper;
        ok = proto.dispatch === wrapper;
      } catch {}
    }
    if (!ok) {
      reportOnce("dispatch-wrap-failed", { frozen: Object.isFrozen(dispatcher) });
      return false;
    }
    dispatchWrapped = true;
    reportOnce("dispatch-wrapped", {});
    return true;
  }

  const CAPTURE_METHODS = [
    "addDirectVideoOutputSink", "removeDirectVideoOutputSink",
    "createOwnStreamConnectionWithOptions", "getNextVideoOutputFrame",
    "presentNativeScreenSharePicker", "setDesktopSource", "setVideoSource",
    "setScreenShareSource", "startScreenShare", "createStream",
  ];

  // Atribuicao em binding nativo costuma ser nao-gravavel e falhar EM SILENCIO -
  // exatamente o que aconteceu com o dispatch. Entao confere, e so diz que
  // embrulhou quando o objeto realmente aponta pro wrapper.
  function assignMethod(target, name, wrapper) {
    try {
      target[name] = wrapper;
      if (target[name] === wrapper) return true;
    } catch {}
    try {
      Object.defineProperty(target, name, { value: wrapper, configurable: true, writable: true });
      if (target[name] === wrapper) return true;
    } catch {}
    try {
      const proto = Object.getPrototypeOf(target);
      if (proto && proto !== Object.prototype) {
        Object.defineProperty(proto, name, { value: wrapper, configurable: true, writable: true });
        if (proto[name] === wrapper) return true;
      }
    } catch {}
    return false;
  }

  // Quantas vezes cada metodo ja foi lido (limita o custo dos que rodam em loop).
  const callCounts = new Map();

  // Embrulha um modulo nativo so pra LER os argumentos (a chamada passa igual).
  function wrapCaptureModule(module, label) {
    const names = new Set();
    try {
      for (const name of Object.getOwnPropertyNames(module)) names.add(name);
      let proto = Object.getPrototypeOf(module);
      for (let i = 0; i < 3 && proto && proto !== Object.prototype; i += 1) {
        for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
        proto = Object.getPrototypeOf(proto);
      }
    } catch {}
    const list = Array.from(names);
    const capture = list.filter((name) => {
      try { return typeof module[name] === "function"; } catch { return false; }
    }).filter((name) => /video|stream|capture|source|screen|share|desktop|media|frame/i.test(name));
    // Em pedacos: o motor corta linha grande no log e a lista sumia na truncagem.
    const parts = Math.ceil(capture.length / 8) || 1;
    for (let i = 0; i < parts; i += 1) {
      reportOnce("module-capture-names", {
        module: label,
        part: i + 1,
        of: parts,
        names: capture.slice(i * 8, i * 8 + 8).join(","),
      });
    }

    if (module.__bdWrapped) return false;
    let wrapped = 0;
    let attempted = 0;
    for (const name of list) {
      let fn;
      try { fn = module[name]; } catch { continue; }
      if (typeof fn !== "function") continue;
      if (!CAPTURE_METHODS.includes(name) && !/stream|capture|source|screen|share/i.test(name)) continue;
      attempted += 1;
      const wrapper = function () {
        const args = Array.prototype.slice.call(arguments);
        try {
          // Metodo de captura pode ser chamado em loop (getNextVideoOutputFrame
          // a 30-60fps). Ler os argumentos so nas primeiras vezes: o sourceId,
          // se vier, vem na primeira.
          const seen = callCounts.get(name) || 0;
          if (seen < 3) {
            callCounts.set(name, seen + 1);
            reportOnce("module-call", {
              module: label,
              name: String(name).slice(0, 32),
              args: args.map((arg) => (arg && typeof arg === "object")
                ? JSON.stringify(arg).slice(0, 180)
                : String(arg).slice(0, 60)).join(" | "),
            });
            for (const arg of args) {
              const found = findSourceIn(arg, 0);
              if (found) { useSource(found); break; }
            }
          }
        } catch {}
        return fn.apply(this, arguments);
      };
      if (assignMethod(module, name, wrapper)) wrapped += 1;
    }
    try { module.__bdWrapped = true; } catch {}
    reportOnce("module-wrapped", {
      module: label,
      wrapped,
      attempted,
      frozen: Object.isFrozen(module),
      extensible: Object.isExtensible(module),
    });
    return wrapped > 0;
  }

  // A PORTA. Em vez de embrulhar o modulo que NOS pedimos (que vem como proxy
  // novo a cada chamada - por isso nunca pegava nada), embrulhamos a propria
  // funcao que o Discord chama pra obter o proxy dele. O que sai daqui ja e o
  // objeto que ele guarda e usa, entao as chamadas passam pelo nosso wrapper.
  let requireModuleWrapped = false;

  function wrapRequireModule() {
    if (requireModuleWrapped) return true;
    const native = globalThis.DiscordNative && globalThis.DiscordNative.nativeModules;
    if (!native || typeof native.requireModule !== "function") {
      reportOnce("require-unavailable", {
        hasNative: !!globalThis.DiscordNative,
        hasModules: !!native,
      });
      return false;
    }
    const original = native.requireModule;
    const wrapper = function (name) {
      const module = original.apply(this, arguments);
      try {
        if (module && typeof name === "string" && /voice|media|video|screen|capture/i.test(name)) {
          wrapCaptureModule(module, name);
        }
      } catch {}
      return module;
    };
    if (!assignMethod(native, "requireModule", wrapper)) {
      reportOnce("require-wrap-failed", {
        frozen: Object.isFrozen(native),
        extensible: Object.isExtensible(native),
      });
      return false;
    }
    requireModuleWrapped = true;
    reportOnce("require-wrapped", {});
    return true;
  }

  // A captura de tela pode morar num modulo irmao (discord_media e o candidato).
  const SIBLING_MODULES = ["discord_media", "discord_utils", "discord_overlay2"];

  let voiceWrapped = false;

  function wrapVoiceModule() {
    if (voiceWrapped) return true;
    const voice = nativeVoiceModule();
    if (!voice) {
      reportOnce("voice-unavailable", {
        hasNative: !!globalThis.DiscordNative,
        hasModules: !!(globalThis.DiscordNative && globalThis.DiscordNative.nativeModules),
      });
      return false;
    }
    // O requireModule devolve o MESMO objeto a cada chamada? Se devolver um proxy
    // novo a cada vez, patchear nao adianta nada - e isso decide a via.
    try {
      reportOnce("voice-identity", { same: nativeVoiceModule() === voice });
    } catch {}
    wrapCaptureModule(voice, "discord_voice");
    try {
      const native = globalThis.DiscordNative && globalThis.DiscordNative.nativeModules;
      if (native && typeof native.requireModule === "function") {
        for (const name of SIBLING_MODULES) {
          let module;
          try { module = native.requireModule(name); } catch { module = null; }
          if (module) wrapCaptureModule(module, name);
        }
      }
    } catch {}
    voiceWrapped = true;
    return true;
  }

  // Ultimo recurso: varre os exports atras de uma string com cara de sourceId.
  function scanExportsForSource() {
    const require = webpackRequire();
    if (!require || !require.c) return "";
    for (const id of Object.keys(require.c)) {
      let exports;
      try { exports = require.c[id] && require.c[id].exports; } catch { continue; }
      if (!exports || typeof exports !== "object") continue;
      for (const candidate of exportValues(exports)) {
        if (!candidate || typeof candidate !== "object" || isProxyLike(candidate)) continue;
        let names;
        try { names = Object.keys(candidate); } catch { continue; }
        for (const name of names) {
          let value;
          try { value = candidate[name]; } catch { continue; }
          if (looksLikeSourceId(value)) { sourceManager = candidate; return value; }
          if (value instanceof Map) {
            const found = findSourceIn(value, 0);
            if (found) { sourceManager = candidate; return found; }
          }
        }
      }
    }
    return "";
  }

  function findStreamSourceId() {
    if (sourceManager) {
      const cached = findSourceIn(sourceManager, 0);
      if (cached) return cached;
      sourceManager = null;
    }
    // A varredura dos modulos custa caro: no maximo uma a cada 5s.
    const now = Date.now();
    if (now - lastSourceScan < 5000) return "";
    lastSourceScan = now;
    return scanExportsForSource();
  }

  function tryNativeCapture() {
    if (publishingNative || publishing) return;
    if (typeof globalThis.createDiscordStream !== "function") return;
    const now = Date.now();
    if (now - lastNativeTry < 700) return;
    lastNativeTry = now;

    const store = findStreamStore();
    if (!store) { notePoll("no-store " + storeScanSummary()); return; }
    // eslint-disable-next-line no-unused-vars
    let stream = null;
    try { stream = store.getCurrentUserActiveStream(); } catch (error) { notePoll("stream-error:" + (error && error.message)); return; }
    if (!stream) { notePoll("store-ok-no-stream"); return; }
    notePoll("stream:" + Object.keys(stream).slice(0, 10).join(","));
    try {
      if (!looksLikeStream(stream)) { notePoll("stream-invalid:" + Object.keys(stream).slice(0, 10).join(",")); return; }
    } catch (error) {
      reportOnce("native-looks-error", { error: String(error && error.message).slice(0, 140) });
      return;
    }

    const candidates = [];
    const derived = streamKeyOf(stream);
    if (derived) candidates.push(["streamKey(derivado)", derived]);
    for (const key of ["streamId", "id", "streamKey", "rtcStreamId"]) {
      try {
        const value = stream[key];
        if (typeof value === "string" && value.length > 0) candidates.push([key, value]);
      } catch {}
    }
    if (!candidates.length) {
      reportOnce("native-capture-nokey", { keys: Object.keys(stream).slice(0, 14).join(",") });
      return;
    }

    reportOnce("native-detected", {
      derived: derived || "(sem streamKey)",
      candidates: candidates.map((c) => c[0]).join(","),
      createStream: typeof globalThis.createDiscordStream,
    });
    // Manda pro motor a tela/janela que o usuario escolheu no modal. Tres vias:
    // a engine nativa, o modulo de voz e o estado do cliente.
    wrapMediaEngine();
    wrapDispatch();
    wrapVoiceModule();
    const chosen = findStreamSourceId();
    if (chosen) {
      useSource(chosen);
    } else {
      reportOnce("source-missing", {});
    }
    // Gatilho nativo confirmado: a live comecou. Publica a captura do motor.
    void publishFeed();
    return;

    // eslint-disable-next-line no-unreachable
    const voice = nativeVoiceModule();
    if (typeof globalThis.createDiscordStream !== "function") {
      reportOnce("native-no-createstream", {});
      return;
    }
    for (const [key, value] of candidates) {
      // Reporta ANTES de chamar: se a chamada nativa travar, a gente ve onde parou.
      reportOnce("native-attempt-start", { key, value: String(value).slice(0, 48) });
      try {
        if (voice && typeof voice.addDirectVideoOutputSink === "function") {
          try { voice.addDirectVideoOutputSink(value); } catch (error) {
            reportOnce("native-sink-failed", { error: String(error && error.message).slice(0, 80) });
          }
        }
        const media = globalThis.createDiscordStream(value);
        const tracks = media && media.getVideoTracks ? media.getVideoTracks().length : -1;
        reportOnce("native-attempt-result", { key, media: typeof media, tracks });
        if (tracks > 0) {
          publishingNative = true;
          report("native-capture", { key, tracks: media.getTracks().length });
          log("capturando a propria live via", key);
          publish(media);
          return;
        }
      } catch (error) {
        reportOnce("native-try-failed", { key, error: String(error && error.message).slice(0, 120) });
      }
    }
    // Ultimo recurso: a propria previa do Discord e um <video> com a trilha.
    const preview = findStreamVideo();
    if (preview && preview.srcObject && preview.srcObject.getVideoTracks &&
        preview.srcObject.getVideoTracks().length > 0) {
      publishingNative = true;
      report("native-capture-preview", { tracks: preview.srcObject.getTracks().length });
      log("capturando a partir da previa do Discord");
      publish(preview.srcObject);
      return;
    }
    reportOnce("native-capture-failed", { tried: candidates.map((c) => c[0] + "=" + String(c[1]).slice(0, 40)).join(" | ") });
  }

  function activeStreamInfo() {
    try {
      const store = findStreamStore();
      if (!store) return "no-store " + storeScanSummary();
      const stream = store.getCurrentUserActiveStream();
      if (!stream) return "no-stream";
      return Object.keys(stream).slice(0, 14).join(",");
    } catch {
      return "error";
    }
  }

  // ------------------------------------------------------------- hub -------

  function connectHub() {
    if (hubSocket && hubSocket.readyState <= 1) return;
    hubSocket = new WebSocket(HUB);
    hubSocket.onopen = () => {
      log('hub conectado');
      setTimeout(() => report('probe', probe()), 1500);
    };
    hubSocket.onmessage = (event) => {
      let message = null;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'welcome') {
        const previousHubId = hubId;
        hubId = message.id;
        // A identidade do hub mudou (reconexao / troca de servico de voz): o
        // override do APEX pode ter sido resetado e o botao do Go Live travado
        // de novo. Re-arma o latch - o poll de 2s ja chama unlock() de novo
        // (nenhum timer novo aqui).
        if (previousHubId !== null && previousHubId !== hubId && unlocked) {
          unlocked = false;
          log('unlock re-armado (hub ' + previousHubId + ' -> ' + hubId + ')');
        }
        // Se alguem ja estiver transmitindo, pede a oferta de novo (senao quem
        // abre o Discord depois do inicio da live perderia o stream). Pede so
        // se NAO ha peer vivo recebendo - pedir sempre realimentava o loop.
        setTimeout(() => { if (!publishing && !hasLiveViewerPeer()) send({ type: 'request-offer' }); }, 1500);
        return;
      }
      if (message.from && hubId !== null && message.from === hubId) return;
      onHub(message).catch((error) => log('hub handler', error));
    };
    hubSocket.onclose = () => setTimeout(connectHub, 3000);
    hubSocket.onerror = () => {};
  }

  function send(message) {
    try {
      if (hubSocket && hubSocket.readyState === 1) {
        hubSocket.send(JSON.stringify(Object.assign({ from: hubId }, message)));
        return true;
      }
    } catch {}
    return false;
  }

  function report(type, data) {
    send({ type, data });
  }

  const reportedOnce = new Set();
  const pendingOnce = new Map();

  // Evita inundar o log com o mesmo aviso a cada 2 segundos.
  //
  // Um aviso "uma vez so" que roda no boot era perdido pra sempre: no boot o
  // socket do hub ainda nao abriu. Agora ele fica na fila e sai quando o socket
  // conectar (ver flushOnce) - sem duplicar.
  function reportOnce(type, data) {
    const key = type + ":" + JSON.stringify(data || {});
    if (reportedOnce.has(key)) return;
    pendingOnce.set(key, { type, data });
    flushOnce();
  }

  function flushOnce() {
    if (!hubSocket || hubSocket.readyState !== 1) return;
    for (const [key, payload] of Array.from(pendingOnce)) {
      if (send(payload)) {
        pendingOnce.delete(key);
        reportedOnce.add(key);
      }
    }
  }

  // Bitrate da live. O painel de qualidade do Discord manda o valor (preload ->
  // motor -> hub) e a gente aplica no sender, ao vivo.
  let streamBitrate = 12_000_000;
  let streamFps = 30;

  async function applyBitrate(bitrate, fps) {
    if (!bitrate || bitrate < 100_000) return;
    streamBitrate = bitrate;
    if (fps && fps > 0) streamFps = Math.min(120, Math.round(fps));
    try {
      const targets = new Set();
      if (peer && typeof peer.getSenders === "function") targets.add(peer);
      for (const entry of peers.values()) if (entry.pc) targets.add(entry.pc);
      for (const pc of targets) {
        for (const sender of pc.getSenders()) {
          if (!sender.track || sender.track.kind !== "video") continue;
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
          params.encodings[0].maxBitrate = streamBitrate;
          // O fps vem do painel/UI (era fixo em 30 aqui - prendia o 60).
          params.encodings[0].maxFramerate = streamFps;
          params.degradationPreference = "maintain-resolution";
          await sender.setParameters(params);
        }
      }
      report("bitrate", { bitrate: streamBitrate, fps: streamFps });
    } catch (error) {
      // Transitorio (sender ainda sem getParameters): a proxima settings message
      // reaplica. Nao e fatal - os encodings ja nascem certos na oferta.
      reportOnce("bitrate-failed", { error: String(error && error.message).slice(0, 120) });
    }
  }

  // Um stream-start/stop com o NOSSO pid e o ciclo de vida da live SEM a store:
  // o preload ve a fonte escolhida (setDesktopSourceWithOptions) e o reset
  // (encodingVideoWidth=0), o motor roteia e so a janela certa age.
  function isMyLifecycle(message) {
    return String(message.data || "") !== ""
      && String(message.data) === String(globalThis.__bdWinPid || "");
  }

  function forceStopPublishing() {
    if (!publishingNative && !publishing) return;
    publishingNative = false;
    feedPublishing = false;
    publishing = null;
    for (const entry of peers.values()) { try { if (entry.pc) entry.pc.close(); } catch {} }
    peers.clear();
    try { if (peer) peer.close(); } catch {}
    peer = null;
    try { if (feedSocket) feedSocket.close(); } catch {}
    feedSocket = null;
    report('native-stopped', { via: 'lifecycle' });
  }

  async function onHub(message) {
    if (message.type === 'stream-start') {
      if (isMyLifecycle(message)) { report('lifecycle-accepted', 'start'); void publishFeed(); }
      return;
    }
    if (message.type === 'stream-stop') {
      if (isMyLifecycle(message)) { report('lifecycle-accepted', 'stop'); forceStopPublishing(); }
      return;
    }
    if (message.type === 'remote-ready') {
      // A ponte pro relay (re)conectou. Se nao estou publicando, peco a oferta
      // de novo - a anterior pode ter morrido dentro do tunel morto.
      if (!publishing && !hasLiveViewerPeer()) send({ type: 'request-offer' });
      return;
    }
    if (message.type === 'settings') {
      await applyBitrate(message.bitrate, message.fps);
      return;
    }
    if (message.type === 'offer') {
      await acceptOffer(message.sdp);
    } else if (message.type === 'answer') {
      // Mesh: casa o answer com o peer dono da oferta. O viewer ecoa o ufrag da
      // oferta (a=x-bd-offer-ufrag:); sem eco (viewer antigo), casa pelo from ou
      // pelo primeiro peer aberto. Answers de outros espectadores caem fora.
      const ufrag = extractOfferUfrag(message.sdp);
      let entry = ufrag ? peers.get(ufrag) : null;
      if (!entry) {
        for (const e of peers.values()) {
          if (e.answered) continue;
          if (e.from !== null && message.from && String(e.from) === String(message.from)) { entry = e; break; }
        }
        if (!entry) {
          for (const e of peers.values()) { if (e.from === null && !e.answered) { entry = e; break; } }
        }
      }
      if (entry && !entry.answered) {
        try {
          await entry.pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
          entry.answered = true;
          // No answer, a=ice-ufrag: e o ufrag DO VIEWER - chaveia os ICE dele.
          entry.viewerUfrag = extractUfrag(message.sdp);
          const pending = pendingIce.get(entry.viewerUfrag) || [];
          pendingIce.delete(entry.viewerUfrag);
          for (const c of pending) { try { await entry.pc.addIceCandidate(c); } catch {} }
        } catch (error) {
          log('answer falhou', String(error).slice(0, 120));
        }
      }
    } else if (message.type === 'ice') {
      // Roteia o candidato para o peer do viewer (answer pode chegar depois;
      // pendentes entram quando o answer chegar).
      const ufrag = candidateUfrag(message.candidate);
      let target = null;
      for (const e of peers.values()) {
        if (e.viewerUfrag && ufrag && e.viewerUfrag === ufrag) { target = e; break; }
      }
      if (!target) {
        if (!pendingIce.has(ufrag)) pendingIce.set(ufrag, []);
        if (ufrag) pendingIce.get(ufrag).push(message.candidate);
      } else if (message.candidate) {
        try { await target.pc.addIceCandidate(message.candidate); } catch {}
      }
    } else if (message.type === 'test-publish') {
      const isPublisher = String(message.publisher) === String(hubId);
      if (isPublisher) {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const ctx2 = canvas.getContext('2d');
        let t = 0;
        setInterval(() => {
          ctx2.fillStyle = '#101014';
          ctx2.fillRect(0, 0, 640, 360);
          ctx2.fillStyle = '#5865f2';
          ctx2.fillRect(((t * 9) % 680) - 40, 150, 80, 60);
          ctx2.fillStyle = '#ffffff';
          ctx2.font = '26px monospace';
          ctx2.fillText('BIG DUCKS TEST ' + t, 20, 60);
          t += 1;
        }, 100);
        await publish(canvas.captureStream(15));
        report('test-publishing', { publisher: hubId });
      } else {
        p2pReceiving = false;
        receiving = null;
        report('test-watching', { viewer: hubId });
      }
    } else if (message.type === 'request-offer') {
      // Nunca destrua peers vivos por causa de um request-offer: reenviar a
      // oferta existente ou abrir UM peer novo para quem pediu. Recriar em
      // cascade era o loop (cada novo viewer matava as conexoes dos outros).
      if (!publishing) return;
      void ensurePublisherPeer(message.from || null).catch((error) => log('request-offer', String(error).slice(0, 120)));
    }
  }

  // ----------------------------------------------------------- webrtc ------

  function createPeer() {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    pc.onicecandidate = (event) => { if (event.candidate) send({ type: 'ice', candidate: event.candidate }); };
    pc.ontrack = (event) => showStream(event.streams[0] || new MediaStream([event.track]), 'p2p');
    pc.onconnectionstatechange = () => log('peer', pc.connectionState);
    return pc;
  }

  function hasLiveViewerPeer() {
    const state = peer ? peer.connectionState : 'closed';
    return state === 'new' || state === 'connecting' || state === 'connected';
  }

  function addStreamTracks(pc, stream) {
    for (const track of stream.getTracks()) {
      try {
        // Tela e conteudo de detalhe: evita o encoder "borrar" para economizar.
        if (track.kind === "video") track.contentHint = "detail";
      } catch {}
      // Video entra por addTransceiver com os ENCODINGS na OFERTA - o
      // applyBitrate pos-negociacao falhava ("getParameters() has never been
      // called") quando chegava antes da negociação (o bitrate-failed do log).
      if (track.kind === "video") {
        try {
          pc.addTransceiver(track, {
            direction: "sendonly",
            streams: [stream],
            sendEncodings: [{ maxBitrate: streamBitrate, maxFramerate: Math.min(120, streamFps || 30) }],
          });
        } catch { pc.addTrack(track, stream); }
      } else {
        pc.addTrack(track, stream);
      }
    }
  }

  async function publish(stream) {
    publishing = stream;
    // Peer inicial "aberto" (from=null): a oferta vai em broadcast e o PRIMEIRO
    // answer legitimo assume o peer. Espectadores seguintes pedem offer e
    // recebem peers proprios (mesh). Nada de peer unico para todos.
    await ensurePublisherPeer(null);
    log('publicando', stream.getVideoTracks()[0] && stream.getVideoTracks()[0].label);
    return true;
  }

  // Cria (ou reenvia a oferta de) um peer de publicacao. NUNCA destrói peers
  // answered/vivos - recriar por request-offer era o loop infinito.
  async function ensurePublisherPeer(from) {
    if (!publishing) return;
    // 1. Espectador que ja tem peer vivo: so reenvia a oferta (dedupe no
    // viewer responde com a mesma answer sem resetar nada).
    for (const entry of peers.values()) {
      if (entry.from !== null && from !== null && String(entry.from) === String(from)) {
        if (!entry.answered && entry.pc.connectionState !== 'closed') {
          send({ type: 'offer', sdp: entry.sdp });
        }
        return;
      }
    }
    // 2. Reutiliza peer de oferta pendente sem dono (oferta perdida no tunel).
    for (const entry of peers.values()) {
      if (entry.from === null && !entry.answered && entry.pc.connectionState !== 'closed') {
        entry.from = from;
        send({ type: 'offer', sdp: entry.sdp });
        return;
      }
    }
    // 3. Peer novo. Limite duro: sem espaco, reenvia a ultima oferta viva.
    if (peers.size >= MAX_PEERS) {
      for (const entry of peers.values()) {
        if (entry.pc.connectionState !== 'closed') { send({ type: 'offer', sdp: entry.sdp }); return; }
      }
      return;
    }
    const pc = createPeer();
    addStreamTracks(pc, publishing);
    await applyBitrate(streamBitrate, streamFps);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const ufrag = extractUfrag(pc.localDescription.sdp);
    if (ufrag) peers.set(ufrag, { pc, from: from || null, answered: false, sdp: pc.localDescription.sdp });
    if (!peer) peer = pc;
    send({ type: 'offer', sdp: pc.localDescription.sdp });
  }

  async function acceptOffer(sdp) {
    if (publishing) return; // quem publica nao aceita
    try { if (feedSocket) feedSocket.close(); } catch {}
    feedSocket = null;
    const ufrag = extractUfrag(sdp);
    // Oferta repetida (mesmo ufrag): re-responde com a MESMA answer sem tocar
    // no peer - reconectar de novo zeraria frames e reativava o loop.
    if (ufrag && answeredUfrags.has(ufrag)) {
      send({ type: 'answer', sdp: answeredUfrags.get(ufrag) });
      return;
    }
    if (peer) { try { peer.close(); } catch {} }
    peer = createPeer();
    await peer.setRemoteDescription({ type: 'offer', sdp });
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    // Eco do ufrag da oferta: o publisher mesh casa o answer com o peer certo
    // (o a=ice-ufrag: do answer e o ufrag DO VIEWER, inutil para rotear).
    const answerSdp = ufrag
      ? peer.localDescription.sdp + '\r\na=x-bd-offer-ufrag:' + ufrag
      : peer.localDescription.sdp;
    send({ type: 'answer', sdp: answerSdp });
    if (ufrag) {
      answeredUfrags.set(ufrag, answerSdp);
      if (answeredUfrags.size > 8) answeredUfrags.delete(answeredUfrags.keys().next().value);
    }
  }

  // --------------------------------------------------------- captura -------

  // O clique nativo em "Compartilhar tela" passa por getDisplayMedia. Pegamos a
  // MESMA trilha que o Discord capturou e publicamos por P2P. O envio pelo
  // servidor do Discord pode falhar (2012) - irrelevante, o video vai por P2P.
  function hookCapture() {
    const media = navigator.mediaDevices;
    if (!media || typeof media.getDisplayMedia !== 'function' || media.__bdHooked) return;
    const original = media.getDisplayMedia.bind(media);
    media.getDisplayMedia = function (constraints) {
      return original(constraints).then((stream) => {
        try {
          report('capture', { tracks: stream.getTracks().length });
          publish(stream).catch((error) => log('publish falhou', error));
        } catch (error) {
          log('hook capture', error);
        }
        return stream;
      });
    };
    media.__bdHooked = true;
    log('hook em getDisplayMedia ativo');
  }

  function webpackProbe() {
    const out = { seen: !!wreq, global: !!(globalThis.webpackChunkdiscord_app) };
    try {
      const require = webpackRequire();
      out.requireOk = !!require;
      if (require && require.c) out.cacheSize = Object.keys(require.c).length;
    } catch (error) {
      out.error = String(error && error.message);
    }
    return out;
  }

  // Le o valor REAL que o botao do Go Live consulta:
  //     !useConfig({ location: "RTCConnection" }).videoEnabled
  // Se voltar true, o botao aparece.
  function readVideoEnabled() {
    try {
      const require = webpackRequire();
      if (!require || !require.c) return "no-webpack";
      for (const id of Object.keys(require.c)) {
        let exports;
        try { exports = require.c[id] && require.c[id].exports; } catch { continue; }
        if (!exports || typeof exports !== "object") continue;
        let values = [];
        try { values = [exports, exports.default].concat(Object.values(exports)); } catch { continue; }
        for (const candidate of values) {
          if (!candidate || typeof candidate !== "object") continue;
          if (typeof candidate.getConfig !== "function") continue;
          try {
            const config = candidate.getConfig({ location: "RTCConnection" });
            if (config && typeof config === "object" && "videoEnabled" in config) {
              return config.videoEnabled === true;
            }
          } catch {}
        }
      }
      return "not-found";
    } catch {
      return "error";
    }
  }

  function probe() {
    const voice = (() => {
      try {
        const native = globalThis.DiscordNative && globalThis.DiscordNative.nativeModules;
        return native && native.requireModule ? native.requireModule('discord_voice') : null;
      } catch { return null; }
    })();
    const report_ = {
      unlocked,
      unlockTries,
      hook: !!(navigator.mediaDevices && navigator.mediaDevices.__bdHooked),
      hub: hubSocket ? hubSocket.readyState : -1,
      feed: feedSocket ? feedSocket.readyState : -1,
      frames,
      rendered,
      publishing: !!publishing,
      receiving: !!receiving,
      peer: peer ? peer.connectionState : 'none',
      hasWebpack: !!globalThis.webpackChunkdiscord_app,
      webpackPush: !!(globalThis.webpackChunkdiscord_app && globalThis.webpackChunkdiscord_app.push),
      // O gancho do CDP (mundo principal, antes da pagina) chegou a instalar?
      // Se for false e os patches vierem "TARDE", o problema e a INJECAO.
      earlyHook: !!globalThis.__bdEarlyPatched,
      dispatcherFound: !!findDispatcher(),
      wp: webpackProbe(),
      boot: BOOT,
      experimentsHooked: experimentsHooked,
      publishingNative: publishingNative,
      activeStream: activeStreamInfo(),
      videoEnabled: readVideoEnabled(),
      rewrites: rewrites,
      hasNativeVoice: !!voice,
      hasCreateDiscordStream: typeof globalThis.createDiscordStream === 'function',
      readyState: document.readyState,
    };
    log('probe', JSON.stringify(report_));
    return report_;
  }

  function stop() {
    paused = true;
    removeCover();
    closePanel();
    for (const entry of peers.values()) { try { if (entry.pc) entry.pc.close(); } catch {} }
    peers.clear();
    try { if (peer) peer.close(); } catch {}
    peer = null;
    publishing = null;
    try { if (hubSocket) hubSocket.close(); } catch {}
    hubSocket = null;
  }

  globalThis.__BD_RS__ = {
    probe,
    unlock,
    status: () => probe(),
    watch: () => { paused = false; connectFeed(); return true; },
    stop,
    restart: () => { paused = false; connectHub(); connectFeed(); },
    publish: () => publish(publishing),
  };

  // ------------------------------------------------------------ boot -------

  // A SALA do relay e' o canal de voz - o Discord e' a fonte da verdade: quem
  // esta na mesma call cai na mesma sala, sem configurar nada. O preload le
  // isto (globalThis.__bdRoom) e monta a URL do relay.
  let voiceStore = null;
  let voiceScan = { scanned: 0, cache: 0, ids: 0, captured: 0, error: "" };
  // Um id de canal do Discord e sempre um snowflake numerico. Exigir isso evita
  // aceitar lixo (um Proxy devolve "function ..." pra qualquer chave, por ex.).
  const SNOWFLAKE = /^\d{5,25}$/;

  function voiceMethodOf(store) {
    for (const name of ["getVoiceChannelId", "getCurrentVoiceChannelId"]) {
      try { if (typeof store[name] === "function") return name; } catch (_) {}
    }
    return "";
  }
  function voiceIdOf(store) {
    const method = voiceMethodOf(store);
    if (!method) return null;
    try { return { method, id: String(store[method]() || "") }; }
    catch (_) { return null; }
  }

  // O modulo do canal de voz e um chunk LAZY (igual a store de stream): captura
  // na execucao da fabrica, depois cache, depois varredura - e PREFERE uma store
  // que de fato devolve um canal (senao a primeira que aparecesse podia ser uma
  // que sempre responde vazio, e a sala nunca subia).
  function findVoiceChannelStore() {
    voiceScan = { scanned: 0, cache: 0, ids: 0, captured: 0, error: "" };
    let fallback = null;

    const consider = (hit) => {
      if (!hit) return null;
      const probe = voiceIdOf(hit);
      if (probe && SNOWFLAKE.test(probe.id)) { voiceStore = hit; return hit; }
      if (!fallback) fallback = hit;
      return null;
    };

    const reg = capture();
    if (reg) {
      voiceScan.ids = reg.voice.ids.length;
      voiceScan.captured = reg.voice.candidates.length;
      for (const candidate of reg.voice.candidates) {
        const hit = consider(findVoiceIn(candidate, 0, true));
        if (hit) return hit;
      }
    }
    // Cache so vale enquanto ele ainda reporta sala; senao deixa achar outra.
    if (voiceStore) {
      const probe = voiceIdOf(voiceStore);
      if (probe && SNOWFLAKE.test(probe.id)) return voiceStore;
    }

    const require = webpackRequire();
    if (!require || !require.c) { voiceScan.error = "no-webpack"; return fallback; }
    voiceScan.cache = Object.keys(require.c).length;
    for (const id of Object.keys(require.c)) {
      let exports;
      try { exports = require.c[id] && require.c[id].exports; } catch (_) { continue; }
      if (!exports || typeof exports !== "object") continue;
      if (isProxyLike(exports)) continue;
      voiceScan.scanned += 1;
      const hit = consider(findVoiceIn(exports, 0, false));
      if (hit) return hit;
    }
    if (reg && reg.voice.ids.length) {
      for (const id of reg.voice.ids) {
        try {
          const mod = require.c && require.c[id];
          const hit = consider(mod && findVoiceIn(mod.exports, 0, true));
          if (hit) return hit;
        } catch (_) {}
      }
    }
    if (fallback) voiceStore = fallback;
    return fallback;
  }

  // Publica globalThis.__bdRoom (o preload le daqui) e NUNCA falha em silencio:
  // grava tambem __bdRoomDiag com o que foi procurado, pra quando der errado.
  let lastRoomDiag = "";
  let lastRoomDiagAt = 0;
  function reportRoomDiag(diag) {
    const now = Date.now();
    if (diag === lastRoomDiag && now - lastRoomDiagAt < 15000) return;
    lastRoomDiag = diag;
    lastRoomDiagAt = now;
    report("voice-room-diag", { diag });
  }

  function publishRoom() {
    try {
      const store = findVoiceChannelStore();
      if (!store) {
        const diag = "store ausente | scanned=" + voiceScan.scanned + " cache=" + voiceScan.cache
          + " fabricas=" + voiceScan.ids + " capturados=" + voiceScan.captured
          + (voiceScan.error ? " err=" + voiceScan.error : "");
        if (globalThis.__bdRoomDiag !== diag) globalThis.__bdRoomDiag = diag;
        reportRoomDiag(diag);
        return;
      }
      const probe = voiceIdOf(store);
      if (!probe || !probe.method) { reportRoomDiag("store achada sem metodo de canal"); return; }
      // So publica se for um snowflake de verdade - string vazia = fora da call.
      const id = SNOWFLAKE.test(probe.id) ? probe.id : "";
      if (globalThis.__bdRoom !== id) {
        globalThis.__bdRoom = id;
        report("voice-room", { room: id || "(vazio)", method: probe.method, raw: probe.id.slice(0, 40) });
      }
      globalThis.__bdRoomDiag = id ? (probe.method + " -> " + id) : (probe.method + " -> vazio");
    } catch (error) {
      reportOnce("voice-room-erro", { error: String((error && error.message) || error).slice(0, 120) });
    }
  }

  function boot() {
    // O preload roda em varias janelas; so a do cliente interessa.
    if (!/^https:\/\/(?:(?:canary|ptb)\.)?discord\.com\//.test(location.href)) {
      log('janela ignorada', location.href.slice(0, 60));
      return;
    }
    installExperimentsRewrite();
    installSrcObjectHook();
    connectHub();
    // O feed do motor Rust NAO e conectado aqui de proposito: nada deve
    // aparecer na tela ate alguem compartilhar de verdade (P2P) ou ate
    // alguem pedir explicitamente com __BD_RS__.watch().
    hookCapture();
    // Plugins opcionais (--nitro). Sem a flag a rota responde 404 e nada roda,
    // entao o bridge de video continua sem patch nenhum em store/React.
    fetch("http://127.0.0.1:8791/plugins.js")
      .then((response) => (response.ok ? response.text() : ""))
      .then((code) => {
        if (!code) return;
        try {
          (0, eval)(code);
          report("plugins", "carregado");
        } catch (error) {
          reportOnce("plugins-failed", { error: String(error && error.message).slice(0, 120) });
        }
      })
      .catch(() => {});
    // O dispatcher so aparece depois que o Discord carrega; tenta algumas vezes
    // e para. O override em si acontece UMA vez. No note o dispatcher demorou
    // mais que 12x2.5s pra nascer (o usuario precisou colar na mao) - agora sao
    // 60 tentativas de 2.5s (2.5 min), e mesmo depois do fim do loop o poll de
    // 2s chama unlock de novo enquanto unlocked=false.
    let bootTries = 0;
    const timer = setInterval(() => {
      wrapRequireModule();
      watchStreamStart();
      wrapMediaEngine();
      wrapDispatch();
      wrapVoiceModule();
      bootTries += 1;
      if ((unlocked && requireModuleWrapped && mediaEngineWrapped && dispatchWrapped) || bootTries >= 60) { clearInterval(timer); return; }
      unlock();
    }, 2500);
    unlock();
    watchStreamStart();
    // Estas precisam estar prontas ANTES do primeiro compartilhamento, senao a
    // escolha do modal passa batido. A PORTA vem primeiro: e por ela que o
    // proprio Discord pede o modulo.
    wrapRequireModule();
    wrapMediaEngine();
    wrapDispatch();
    wrapVoiceModule();
  }

  setInterval(() => { if (rendered) report('stats', { frames }); }, 10000);
  // Reposiciona a cobertura, da uma segunda chance aos videos pequenos que
  // cresceram (janela redimensionada) e escoa os avisos "uma vez so" que
  // ficaram na fila esperando o socket do hub.
  setInterval(() => { positionCover(); retryPendingVideos(); flushOnce(); }, 1200);
  // O erro 2012 ("nao foi possivel transmitir") e renderizado PELO Discord
  // DEPOIS da injecao - esconder so no momento do hook nao basta. Enquanto
  // existir stream ativo, limpa o aviso continuamente: o video que fica por
  // baixo e o nosso (P2P), o aviso e lixo do envio nativo que falhou no
  // servidor - irrelevante por design.
  setInterval(() => {
    if (!receiving) return;
    try {
      const video = (injectedVideo && injectedVideo.isConnected) ? injectedVideo : findStreamVideo();
      if (video) hideStreamError(video);
      for (const video of pendingVideos) {
        if (video.isConnected) hideStreamError(video);
      }
    } catch {}
  }, 2000);
  // Enquanto o usuario estiver com uma live ativa, pega a propria trilha e publica.
  setInterval(() => {
    try {
      publishRoom();
      checkStreamStopped();
      tryNativeCapture();
      // Sem dispatcher/unlock ate agora? Segue tentando - no note o dispatcher
      // nasceu tarde demais e o botao nunca destravou sozinho.
      if (!unlocked) unlock();
    } catch (error) {
      reportOnce("native-poll-error", { error: String((error && (error.stack || error.message)) || error).slice(0, 200) });
    }
    // (a) varredura da store por poll + resumo periodico no log do motor.
    try { pollStore(); } catch (_) {}
  }, 2000);

  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else window.addEventListener('DOMContentLoaded', boot, { once: true });
  log('pronto');
})();
