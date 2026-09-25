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
  const ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  const VIDEO_GUARD = '2026-08-video-guard';
  const log = (...args) => console.log('[bd-rs]', ...args);

  const __bdQuality = true;
  let hubSocket = null;
  let hubId = null;
  let peer = null;
  // Cada publicador mantém um PeerConnection por viewer; cada viewer mantém
  // um por publicador. Ufrag identifica a negociacao; `from` estavel identifica
  // o participante e impede que ICE/answers de pares diferentes se misturem.
  const peers = new Map();          // ufrag local -> PeerConnection de envio
  const creatingPublisherPeers = new Set(); // evita PCs duplicados em requests concorrentes
  const incomingPeers = new Map(); // peer remoto+ufrag -> PeerConnection de recepcao
  const incomingByPublisher = new Map(); // ID remoto -> chave do PC de recepcao ativo
  const answeredUfrags = new Map(); // peer+ufrag da oferta -> answer SDP (dedupe)
  const acceptingUfrags = new Set(); // evita duas offers simultaneas criarem PCs duplicados
  const pendingIce = new Map();     // peer+ufrag -> candidates antes da descricao
  const receivedStreams = new Map(); // publisher ID -> stream/player tile
  const routeKey = (from, ufrag) => String(from || 'unknown') + '\u0000' + String(ufrag || 'unknown');
  let publishGeneration = 0;
  let publisherStopTimer = null;
  let feedWatchEnabled = false;
  const PUBLISHER_IDENTITY_RETRY_MS = 1200;
  const PUBLISHER_IDENTITY_RETRY_LIMIT = 15;
  const PUBLISHER_STOP_GRACE_MS = 2500;
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
  function queueIceCandidate(queueByUfrag, ufrag, candidate) {
    if (!ufrag || !candidate) return;
    const queue = queueByUfrag.get(ufrag) || [];
    if (queue.length < 128) queue.push(candidate);
    queueByUfrag.set(ufrag, queue);
    while (queueByUfrag.size > 8) {
      queueByUfrag.delete(queueByUfrag.keys().next().value);
    }
  }
  let publishing = null;      // MediaStream vindo do Discord
  let publisherDiscordUserId = '';
  let publisherIdentityTimer = null;
  let receiving = null;       // MediaStream recebido (P2P)
  let p2pReceiving = false;
  let feedSocket = null;
  let feedTrack = null;
  let feedWriter = null;
  let feedCanvas = null;
  let feedCtx = null;
  let frames = 0;
  let rendered = false;
  let receivingHasFrame = false;
  const observedFrameStreams = new WeakMap();
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

  const hiddenStreamErrors = new Map();
  const streamErrorPattern = /2012|transmiss[aã]o\s+n[aã]o\s+iniciou|problemas?\s+com\s+sua\s+transmiss[aã]o|n[aã]o\s+foi\s+poss[ií]vel|tente\s+novamente|algo\s+deu\s+errado|n[aã]o\s+consegui|conex[aã]o\s+perdida|unable\s+to\s+load|something\s+went\s+wrong|stream\s+error/i;

  function rectanglesOverlap(a, b) {
    if (!a || !b) return false;
    return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
  }

  function visibleRect(element) {
    try {
      if (!element || !element.isConnected) return null;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
      const rect = element.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1 ? rect : null;
    } catch {
      return null;
    }
  }

  function restoreHiddenStreamErrors(video = null) {
    for (const [node, original] of hiddenStreamErrors) {
      if (video) original.videos.delete(video);
      if (video && original.videos.size) continue;
      try {
        if (node.isConnected
          && node.style.getPropertyValue('display') === 'none'
          && node.style.getPropertyPriority('display') === 'important') {
          if (original.display) node.style.setProperty('display', original.display, original.priority);
          else node.style.removeProperty('display');
        }
      } catch {}
      hiddenStreamErrors.delete(node);
    }
    if (!video) hiddenStreamErrors.clear();
  }

  // O aviso de erro pode estar num portal ou numa camada irmã do <video>, fora
  // dos seis ancestrais que o Discord costuma usar. Varre a raiz real do vídeo
  // e o documento, mas só toca em texto de erro visível que sobrepõe esse player.
  function hideStreamError(video) {
    try {
      if (!video || !receivingStreamsHaveFrame()) return 0;
      const videoRect = visibleRect(video);
      if (!videoRect) return 0;
      const roots = [];
      const root = video.getRootNode && video.getRootNode();
      if (root && typeof root.querySelectorAll === 'function') roots.push(root);
      if (document && !roots.includes(document)) roots.push(document);

      const selector = 'div,span,p,h1,h2,h3,h4,button,[role="alert"],[class*="streamError"],[class*="stream-error"],[class*="videoError"],[class*="errorMessage"]';
      const targets = new Set();
      for (const searchRoot of roots) {
        for (const node of searchRoot.querySelectorAll(selector)) {
          if (node === video || node.contains(video)) continue;
          const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
          if (!streamErrorPattern.test(text)) continue;
          let target = node;
          let rect = visibleRect(target);
          if (!rect || !rectanglesOverlap(rect, videoRect)) continue;

          // Sobe até o bloco de erro mais externo, sem nunca esconder o tile
          // que contém o próprio vídeo nem uma camada maior que o player.
          for (let depth = 0; depth < 7 && target.parentElement; depth += 1) {
            const parent = target.parentElement;
            if (parent.contains(video)) break;
            const parentText = String(parent.textContent || '').replace(/\s+/g, ' ').trim();
            const parentRect = visibleRect(parent);
            if (!streamErrorPattern.test(parentText) || !parentRect
              || !rectanglesOverlap(parentRect, videoRect)
              || parentRect.width * parentRect.height > videoRect.width * videoRect.height * 4) break;
            target = parent;
            rect = parentRect;
          }
          targets.add(target);
        }
      }

      for (const target of targets) {
        if (!hiddenStreamErrors.has(target)) {
          hiddenStreamErrors.set(target, {
            display: target.style.getPropertyValue('display'),
            priority: target.style.getPropertyPriority('display'),
            videos: new Set(),
          });
        }
        hiddenStreamErrors.get(target).videos.add(video);
        target.style.setProperty('display', 'none', 'important');
      }
      if (targets.size) reportOnce('error-hidden', { hidden: targets.size, scope: 'player-overlap' });
      return targets.size;
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
  function coverWithVideo(target, stream = receiving, hasFrame = receivingHasFrame) {
    if (!target) return false;
    if (hasFrame) {
      hideStreamError(target);
      reportOnce("player-ok", { width: target.videoWidth, height: target.videoHeight });
    } else {
      reportOnce("player-attached", { width: Math.round(target.getBoundingClientRect().width) });
    }
    return true;
  }


  function markFirstDecodedFrame(video, stream, metadata, publisherKey) {
    const item = Array.from(receivedStreams.values()).find((entry) => entry.stream === stream);
    if ((!item && receiving !== stream) || video.srcObject !== stream) return;
    if (item) item.hasFrame = true;
    if (receiving === stream) receivingHasFrame = true;
    const detail = {
      width: video.videoWidth,
      height: video.videoHeight,
      publisher: publisherKey || 'single',
      mediaTime: metadata && Number.isFinite(metadata.mediaTime)
        ? Number(metadata.mediaTime.toFixed(2))
        : Number(video.currentTime.toFixed(2)),
    };
    reportOnce("video-first-frame", detail);
    hideStreamError(video);
    reportOnce(video === injectedVideo ? "player-ok" : "mini-player-ok", {
      width: video.videoWidth,
      height: video.videoHeight,
    });
  }


  // Diz se o video esta REALMENTE tocando (e nao so com srcObject setado).
  function reportVideoHealth(video, stream = receiving, publisherKey = null) {
    if (!stream) return;
    for (const afterMs of [1500, 5000, 10000]) {
      setTimeout(() => {
        try {
          reportOnce("video-health", {
            afterMs,
            readyState: video.readyState,
            paused: video.paused,
            width: video.videoWidth,
            height: video.videoHeight,
            publisher: publisherKey || 'single',
            time: Number(video.currentTime.toFixed(2)),
          });
        } catch {}
      }, afterMs);
    }
    if (typeof video.requestVideoFrameCallback === 'function'
      && observedFrameStreams.get(video) !== stream) {
      observedFrameStreams.set(video, stream);
      video.requestVideoFrameCallback((_, metadata) => markFirstDecodedFrame(video, stream, metadata, publisherKey));
    } else if (typeof video.requestVideoFrameCallback !== 'function'
      && observedFrameStreams.get(video) !== stream) {
      observedFrameStreams.set(video, stream);
      const detectDecodedFrame = () => {
        if (video.srcObject !== stream) return;
        if (video.readyState >= 2 && video.videoWidth > 0 && !video.paused) {
          markFirstDecodedFrame(video, stream, null, publisherKey);
        } else {
          requestAnimationFrame(detectDecodedFrame);
        }
      };
      requestAnimationFrame(detectDecodedFrame);
    }
  }

  // O bridge nunca cria janela/painel próprio: todas as trilhas entram nos
  // players nativos que o Discord já montou. Isso evita uma segunda UI e deixa
  // a seleção/miniplayer sob controle do próprio Discord.

  function removeReceivedStream(publisherKey) {
    const key = String(publisherKey || '');
    if (!key || !receivedStreams.delete(key)) return;
    detachNativePublisher(key);
    const remaining = receivedStreams.entries().next();
    if (!remaining.done) {
      const [nextKey, item] = remaining.value;
      receiving = item.stream;
      receivingHasFrame = !!item.hasFrame;
      p2pReceiving = true;
      rendered = true;
      installSrcObjectHook();
      tryInjectNative();
      return;
    }
    receiving = null;
    p2pReceiving = false;
    receivingHasFrame = false;
    rendered = false;
    injectedVideo = null;
    restoreHiddenStreamErrors();
  }

  function closeIncomingPeer(entry, reason) {
    if (!entry) return;
    const key = entry.routeKey;
    if (key && incomingPeers.get(key) === entry) incomingPeers.delete(key);
    if (incomingByPublisher.get(entry.publisherKey) === key) incomingByPublisher.delete(entry.publisherKey);
    if (key) {
      answeredUfrags.delete(key);
      pendingIce.delete(key);
    }
    try { entry.pc.close(); } catch {}
    const hasReplacement = Array.from(incomingPeers.values()).some((other) =>
      other.publisherKey === entry.publisherKey && other.pc.connectionState !== 'closed');
    if (!hasReplacement) removeReceivedStream(entry.publisherKey);
    report('remote-peer-closed', { peer: entry.from || 'unknown', reason });
  }

  function closePublisherPeer(entry) {
    if (!entry) return;
    if (entry.localUfrag && peers.get(entry.localUfrag) === entry) peers.delete(entry.localUfrag);
    try { entry.pc.close(); } catch {}
    if (peer === entry.pc) {
      peer = Array.from(peers.values()).find((other) => other.pc.connectionState !== 'closed')?.pc
        || Array.from(incomingPeers.values()).find((other) => other.pc.connectionState !== 'closed')?.pc
        || null;
    }
  }

  function showFeed(stream) {
    if (receiving !== stream) receivingHasFrame = false;
    receiving = stream;
    rendered = true;
    report('rendered', { source: 'feed', state: 'track-attached' });
    tryInjectNative();
  }

  // ------------------------------------------------- hook no srcObject -----
  //
  // Em vez de adivinhar qual <video> e o player, a gente INTERCEPTA a atribuicao
  // de srcObject. Quando o Discord montar o player dele e apontar pro stream
  // (que esta bloqueado), o nosso stream entra no lugar - no elemento certo,
  // sem chute. So age quando existe um stream P2P ativo; fora disso passa reto.

  let srcObjectHooked = false;
  let nativeSrcObjectSet = null;

  // O Discord usa <video> pequeno tanto para thumbnails comuns quanto para o
  // mini-player persistente. So o segundo recebe o stream P2P.
  const pendingVideos = new Set();

  function playerSized(video) {
    try {
      const rect = video.getBoundingClientRect();
      return rect.width >= 300 && rect.height >= 170;
    } catch {
      return false;
    }
  }

  function videoVisible(video) {
    try {
      const rect = video.getBoundingClientRect();
      const style = getComputedStyle(video);
      return rect.width >= 2 && rect.height >= 2
        && style.display !== 'none' && style.visibility !== 'hidden';
    } catch {
      return false;
    }
  }

  function isPersistentMiniPlayer(video) {
    try {
      const rect = video.getBoundingClientRect();
      if (rect.width < 96 || rect.height < 54) return false;
      let element = video.parentElement;
      for (let depth = 0; element && depth < 9; depth += 1, element = element.parentElement) {
        const className = typeof element.className === 'string' ? element.className : '';
        const identity = [
          className,
          element.id || '',
          element.getAttribute('aria-label') || '',
          element.getAttribute('data-testid') || '',
          element.getAttribute('data-list-item-id') || '',
        ].join(' ');
        if (/(?:picture.?in.?picture|\bpip\b|mini.?player|floating.?player|stream.?popout|video.?popout)/i.test(identity)) {
          return true;
        }

        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        const overlayPosition = style.position === 'fixed' || style.position === 'absolute';
        const stacked = style.zIndex !== 'auto' && Number(style.zIndex) > 0;
        const compact = bounds.width >= rect.width && bounds.height >= rect.height
          && bounds.width <= Math.min(window.innerWidth * 0.65, 760)
          && bounds.height <= Math.min(window.innerHeight * 0.65, 540);
        if (overlayPosition && stacked && compact) return true;
      }
    } catch {}
    return false;
  }

  function canAttachNativePlayer(video) {
    return playerSized(video) || isPersistentMiniPlayer(video);
  }

  const nativeBindings = new Map();
  const ambiguousNativeVideos = new WeakSet();

  function addIdentityValue(ids, value, key) {
    if (typeof value !== 'string') return;
    if (/(?:owner|user|participant).*id|^(?:id|streamid|streamkey)$/i.test(key)) {
      const direct = validDiscordUserId(value);
      if (direct) ids.add(direct);
      if (/stream/i.test(key)) {
        for (const part of value.split(/[^0-9]+/)) {
          const id = validDiscordUserId(part);
          if (id) ids.add(id);
        }
      }
    }
  }

  function collectNativeOwnerIds(video) {
    const ids = new Set();
    const seen = new WeakSet();
    let visited = 0;
    const inspect = (value, depth, keyHint = '') => {
      if (typeof value === 'string') {
        addIdentityValue(ids, value, keyHint);
        return;
      }
      if (!value || typeof value !== 'object' || depth > 4 || seen.has(value) || ++visited > 120) return;
      seen.add(value);
      let names;
      try { names = Object.keys(value).slice(0, 40); } catch { return; }
      for (const name of names) {
        if (!/(?:owner|user|participant|stream|props|video|media|rtc|direct|children|source)/i.test(name)) continue;
        let child;
        try { child = value[name]; } catch { continue; }
        addIdentityValue(ids, child, name);
        if (child && typeof child === 'object') inspect(child, depth + 1, name);
      }
    };

    try {
      let element = video;
      for (let depth = 0; element && depth < 7; depth += 1, element = element.parentElement) {
        for (const name of ['data-user-id', 'data-owner-id', 'data-stream-id', 'data-stream-key']) {
          addIdentityValue(ids, element.getAttribute(name), name.slice(5));
        }
        let names = [];
        try { names = Object.getOwnPropertyNames(element); } catch {}
        for (const name of names) {
          if (name.startsWith('__reactProps$')) {
            try { inspect(element[name], 0, 'props'); } catch {}
          } else if (name.startsWith('__reactFiber$')) {
            let fiber;
            try { fiber = element[name]; } catch {}
            for (let level = 0; fiber && level < 14; level += 1) {
              try { inspect(fiber.memoizedProps, 0, 'props'); } catch {}
              try { inspect(fiber.pendingProps, 0, 'props'); } catch {}
              fiber = fiber.return;
            }
          }
        }
      }
    } catch {}
    return ids;
  }

  function receivedItemForVideo(video) {
    if (!receivedStreams.size && receiving) {
      return { key: 'feed', stream: receiving, hasFrame: receivingHasFrame };
    }
    const current = video && video.srcObject;
    for (const [key, item] of receivedStreams) {
      if (item.stream === current) return { key, ...item };
    }
    const ownerIds = collectNativeOwnerIds(video);
    if (receivedStreams.size === 1) {
      const [key, item] = receivedStreams.entries().next().value;
      if (item.publisherUserId && ownerIds.size && !ownerIds.has(item.publisherUserId)) return null;
      return { key, ...item };
    }
    const matches = Array.from(receivedStreams, ([key, item]) =>
      item.publisherUserId && ownerIds.has(item.publisherUserId) ? { key, ...item } : null
    ).filter(Boolean);
    if (matches.length === 1) return matches[0];
    if (receivedStreams.size > 1 && !ambiguousNativeVideos.has(video)) {
      ambiguousNativeVideos.add(video);
      reportOnce('native-stream-owner-unmatched', {
        streams: receivedStreams.size,
        identifiedOwners: Array.from(receivedStreams.values()).filter((item) => item.publisherUserId).length,
        videoOwners: ownerIds.size,
        video: describeVideo(video),
      });
    }
    return null;
  }

  function receivedItemForStream(stream) {
    for (const [key, item] of receivedStreams) {
      if (item.stream === stream) return { key, ...item };
    }
    return null;
  }

  function receivingStreamsHaveFrame() {
    if (!receivedStreams.size) return !!(receiving && receivingHasFrame);
    return Array.from(receivedStreams.values()).some((item) => item.hasFrame);
  }

  function detachNativePublisher(publisherKey) {
    for (const [video, binding] of Array.from(nativeBindings)) {
      if (binding.publisherKey !== publisherKey) continue;
      nativeBindings.delete(video);
      restoreHiddenStreamErrors(video);
      if (!video.isConnected) continue;
      try {
        if (video.srcObject === binding.stream && nativeSrcObjectSet) {
          nativeSrcObjectSet.call(video, binding.originalSource || null);
        }
      } catch {}
    }
  }

  function pruneNativeBindings() {
    for (const [video] of nativeBindings) {
      if (!video.isConnected) {
        nativeBindings.delete(video);
        restoreHiddenStreamErrors(video);
      }
    }
  }

  function retryPendingVideos() {
    if (!receivedStreams.size || !pendingVideos.size) return;
    for (const video of Array.from(pendingVideos)) {
      if (!video.isConnected) { pendingVideos.delete(video); continue; }
      if (!canAttachNativePlayer(video)) continue;
      const item = receivedItemForVideo(video);
      if (!item) continue;
      pendingVideos.delete(video);
      try {
        video.srcObject = item.stream;
        video.play().catch(() => {});
        if (injectedVideo !== video) {
          const keepCurrent = injectedVideo && injectedVideo.isConnected && videoVisible(injectedVideo);
          if (!keepCurrent || playerSized(video)) injectedVideo = video;
        }
        if (injectedVideo === video) {
          reportOnce(playerSized(video) ? "player-sized-late" : "mini-player-attached", describeVideo(video));
          reportVideoHealth(video, item.stream, item.key);
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
      nativeSrcObjectSet = originalSet;
      Object.defineProperty(proto, "srcObject", {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
          return originalGet ? originalGet.call(this) : undefined;
        },
        set(value) {
          try {
            if (!this || this.tagName !== 'VIDEO' || !receivedStreams.size) {
              return originalSet.call(this, value);
            }
            if (value === null || value === undefined) {
              pendingVideos.delete(this);
              nativeBindings.delete(this);
              return originalSet.call(this, value);
            }
            const isStream = typeof MediaStream !== 'undefined' && value instanceof MediaStream;
            if (!isStream) return originalSet.call(this, value);

            const item = receivedItemForStream(value) || receivedItemForVideo(this);
            if (!item) {
              pendingVideos.add(this);
              return originalSet.call(this, value);
            }
            if (!canAttachNativePlayer(this)) {
              pendingVideos.add(this);
              return originalSet.call(this, value);
            }

            pendingVideos.delete(this);
            const currentSource = originalGet ? originalGet.call(this) : null;
            const previous = nativeBindings.get(this);
            const originalSource = value !== item.stream
              ? value
              : (previous && previous.publisherKey === item.key
                ? previous.originalSource
                : (currentSource === item.stream ? null : currentSource));
            nativeBindings.set(this, {
              publisherKey: item.key,
              stream: item.stream,
              originalSource,
            });
            if (value !== item.stream) {
              reportOnce(isPersistentMiniPlayer(this) ? 'mini-player-hook' : 'srcobject-hook', describeVideo(this));
            }
            if (injectedVideo !== this) {
              const keepCurrent = injectedVideo && injectedVideo.isConnected && videoVisible(injectedVideo);
              if (!keepCurrent || playerSized(this)) injectedVideo = this;
            }
            if (injectedVideo === this) reportVideoHealth(this, item.stream, item.key);
            coverWithVideo(this, item.stream, item.hasFrame);
            return originalSet.call(this, item.stream);
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
  // Cada MediaStream P2P e vinculado ao video do Discord cujo ownerId casa
  // com o publisher. Com mais de um publisher, nao adivinhamos por ordem.

  let injectedVideo = null;

  function findStreamVideo() {
    let best = null;
    let bestArea = 0;
    try {
      for (const video of document.querySelectorAll('video')) {
        const rect = video.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (!playerSized(video)) continue;
        if (area > bestArea) { bestArea = area; best = video; }
      }
      if (best) return best;
      for (const video of document.querySelectorAll('video')) {
        if (isPersistentMiniPlayer(video)) return video;
      }
    } catch {}
    return best;
  }

  function findNativePlayerVideos() {
    const targets = [];
    try {
      for (const video of document.querySelectorAll('video')) {
        if (videoVisible(video) && canAttachNativePlayer(video)) targets.push(video);
      }
    } catch {}
    return targets;
  }

  function tryInjectNative() {
    if (!receiving && !receivedStreams.size) return false;
    const targets = findNativePlayerVideos();
    if (!targets.length) return false;
    let attached = false;
    for (const video of targets) {
      try {
        const item = receivedItemForVideo(video);
        if (!item) continue;
        if (video.srcObject !== item.stream) {
          video.srcObject = item.stream;
          video.play().catch(() => {});
          const rect = video.getBoundingClientRect();
          const mini = isPersistentMiniPlayer(video);
          report(mini ? 'native-mini-inject' : 'native-inject', {
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            publisher: item.key,
          });
        }
        const keepCurrent = injectedVideo && injectedVideo.isConnected && videoVisible(injectedVideo);
        if (!keepCurrent || playerSized(video)) injectedVideo = video;
        coverWithVideo(video, item.stream, item.hasFrame);
        if (video === injectedVideo) {
          reportVideoHealth(video, item.stream, item.key);
        }
        attached = true;
      } catch {}
    }
    return attached;
  }

  function showStream(stream, source, publisherKey, publisherId, publisherUserId = '') {
    const key = String(publisherKey || publisherId || 'unknown');
    const previous = receivedStreams.get(key);
    const item = {
      stream,
      publisherId: publisherId || key,
      publisherUserId: validDiscordUserId(publisherUserId),
      hasFrame: previous && previous.stream === stream ? previous.hasFrame : false,
    };
    receivedStreams.set(key, item);
    if (receiving !== stream) receivingHasFrame = item.hasFrame;
    p2pReceiving = true;
    receiving = stream;
    rendered = true;
    report('rendered', { source, state: 'track-attached', peer: item.publisherId, streams: receivedStreams.size });
    log('stream de', source, '- aguardando o player do Discord');
    installSrcObjectHook();
    tryInjectNative();
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (injectedVideo || tries >= 20) {
        clearInterval(timer);
      } else {
        tryInjectNative();
      }
    }, 500);
  }

  function updateReceivedPublisherIdentity(publisherKey, publisherUserId) {
    const key = String(publisherKey || '');
    const userId = validDiscordUserId(publisherUserId);
    if (!key || !userId) return 0;
    let routes = 0;
    for (const entry of incomingPeers.values()) {
      if (String(entry.publisherKey) !== key) continue;
      entry.publisherUserId = userId;
      routes += 1;
    }
    const item = receivedStreams.get(key);
    if (item) item.publisherUserId = userId;
    const matched = routes + (item ? 1 : 0);
    if (matched) {
      report('publisher-identity-updated', { streams: item ? 1 : 0, routes });
      retryPendingVideos();
      tryInjectNative();
    }
    return matched;
  }

  function hasIncomingPublisher(publisherKey) {
    const key = String(publisherKey || '');
    return Array.from(incomingPeers.values()).some((entry) => {
      if (String(entry.publisherKey) !== key || !entry.pc) return false;
      return ['new', 'connecting', 'connected'].includes(entry.pc.connectionState);
    });
  }

  function closePanel() {
    paused = true;
    rendered = false;
    try { if (feedWriter) feedWriter.close(); } catch {}
    try { if (feedTrack) feedTrack.stop(); } catch {}
    feedWriter = null;
    feedTrack = null;
    try { if (feedSocket) feedSocket.close(); } catch {}
    feedSocket = null;
    report('renderer-stopped', {});
  }

  // ------------------------------------------------- feed RGBA (fallback) --

  function ensureFeedTrack() {
    if (feedTrack) return feedTrack;
    try {
      // A trilha precisa continuar entregando quadros enquanto o WebRTC a le.
      // MediaStreamTrackGenerator.write() pode ficar pendente neste Electron;
      // captureStream acompanha o canvas sem bloquear o handler do WebSocket.
      feedCanvas = document.createElement('canvas');
      feedCtx = feedCanvas.getContext('2d', { alpha: false });
      if (!feedCtx) throw new Error('canvas 2D indisponivel');
      // Um quadro da trilha para cada quadro recebido; o teto vem da UI nativa.
      feedTrack = feedCanvas.captureStream(0).getVideoTracks()[0];
      if (!feedTrack) throw new Error('captureStream sem trilha de video');
      feedTrack.onmute = () => report('feed-track', { state: 'muted' });
      feedTrack.onunmute = () => report('feed-track', { state: 'unmuted' });
      report('feed-track', { state: 'created', label: feedTrack.label });
    } catch (error) {
      log('track falhou', error);
      return null;
    }
    return feedTrack;
  }

  function connectFeed() {
    if (paused || (!feedPublishing && !feedWatchEnabled)) return;
    if (feedSocket && feedSocket.readyState <= 1) return;
    const socket = new WebSocket(FEED);
    feedSocket = socket;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => report('feed-socket', { state: 'open' });
    socket.onclose = (event) => {
      report('feed-socket', { state: 'closed', code: event.code });
      if (feedSocket === socket) {
        feedSocket = null;
        if (feedPublishing || feedWatchEnabled) setTimeout(connectFeed, 3000);
      }
    };
    socket.onerror = () => report('feed-socket', { state: 'error' });
    socket.onmessage = async (event) => {
      if (decoding) return;
      if (p2pReceiving && !publishing && !feedPublishing) return; // P2P tem prioridade apenas para quem recebe
      decoding = true;
      try {
        const buffer = event.data;
        const view = new DataView(buffer);
        const width = view.getUint32(0, true);
        const height = view.getUint32(4, true);
        const timestamp = Number(view.getBigUint64(8, true));
        const pixels = new Uint8Array(buffer.slice(16));
        if (pixels.byteLength !== width * height * 4) throw new Error('frame RGBA incompleto');
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
          feedTrack.requestFrame();
        }
        if (!rendered && !feedPublishing) {
          showFeed(new MediaStream([feedTrack]));
        }
        frames += 1;
        if (frames === 1) report('feed-first-frame', { width, height, bytes: pixels.byteLength });
      } catch (error) {
        log('frame falhou', error);
        reportOnce('feed-frame-failed', { error: String((error && error.message) || error).slice(0, 120) });
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

  function validDiscordUserId(value) {
    return typeof value === 'string' && /^\d{5,25}$/.test(value) ? value : '';
  }

  function discordUserIdFrom(value, depth = 0, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || depth > 2 || seen.has(value)) return '';
    seen.add(value);
    if (isProxyLike(value)) return '';
    for (const method of ['getCurrentUserId', 'getCurrentUser']) {
      try {
        if (typeof value[method] !== 'function') continue;
        const result = value[method]();
        const id = validDiscordUserId(typeof result === 'string' ? result : result && result.id);
        if (id) return id;
      } catch {}
    }
    let children = [];
    try {
      const names = Object.keys(value).slice(0, 24);
      children = names
        .filter((name) => /user|account|default/i.test(name))
        .map((name) => value[name]);
    } catch {}
    for (const child of children) {
      const id = discordUserIdFrom(child, depth + 1, seen);
      if (id) return id;
    }
    return '';
  }

  function findDiscordUserId() {
    if (publisherDiscordUserId) return publisherDiscordUserId;
    try {
      const store = findStreamStore();
      const active = store && store.getCurrentUserActiveStream();
      const ownerId = validDiscordUserId(active && active.ownerId);
      if (ownerId) return publisherDiscordUserId = ownerId;
    } catch {}
    const require = webpackRequire();
    if (!require || !require.c) return '';
    for (const id of Object.keys(require.c)) {
      let exports;
      try { exports = require.c[id] && require.c[id].exports; } catch { continue; }
      if (!exports || typeof exports !== 'object' || isProxyLike(exports)) continue;
      const candidates = [exports];
      try {
        if (Object.keys(exports).length <= 24) candidates.push(...Object.values(exports));
        if (exports.default) candidates.push(exports.default);
      } catch {}
      for (const candidate of candidates) {
        const userId = discordUserIdFrom(candidate);
        if (userId) return publisherDiscordUserId = userId;
      }
    }
    return '';
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
    if (publishing && feedPublishing) {
      cancelPendingPublisherStop();
      return true;
    }
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
    schedulePublisherStop("store");
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
        globalThis.__bdHubId = Number(hubId);
        report('bridge-ready', { client: 'discord' });
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
        setTimeout(() => {
          if (publishing) announcePublisherReady();
          if (!hasLiveViewerPeer()) send({ type: 'request-offer' });
        }, 1500);
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

  // O painel do Discord manda setTransportOptions repetidas vezes e CADA peer
  // novo reaplica o bitrate (ensurePublisherPeer -> applyBitrate). Reportar a
  // cada chamada enchia o hub de "bitrate" (dezenas por segundo, puro ruido -
  // ninguem consome). So sai um report quando o valor muda de verdade e, no
  // maximo, 1 por segundo.
  let reportedBitrate = -1;
  let reportedFps = -1;
  let lastBitrateReportAt = 0;

  function reportBitrate() {
    const value = Math.round(streamBitrate);
    const fps = Math.round(streamFps);
    if (value === reportedBitrate && fps === reportedFps) return;
    const now = Date.now();
    if (lastBitrateReportAt && now - lastBitrateReportAt < 1000) return;
    reportedBitrate = value;
    reportedFps = fps;
    lastBitrateReportAt = now;
    report("bitrate", { bitrate: value, fps });
  }

  async function applyBitrate(bitrate, fps) {
    if (!bitrate || bitrate < 100_000) return;
    streamBitrate = bitrate;
    if (fps && fps > 0) streamFps = Math.min(1000, Math.round(fps));
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
      reportBitrate();
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

  function cancelPendingPublisherStop() {
    if (!publisherStopTimer) return;
    clearTimeout(publisherStopTimer);
    publisherStopTimer = null;
    report('publisher-stop-cancelled', {});
  }

  function schedulePublisherStop(reason) {
    if (!publishingNative && !publishing) return;
    if (publisherStopTimer) return;
    publisherStopTimer = setTimeout(() => {
      publisherStopTimer = null;
      forceStopPublishing(reason);
    }, PUBLISHER_STOP_GRACE_MS);
    report('publisher-stop-pending', { reason, graceMs: PUBLISHER_STOP_GRACE_MS });
  }

  function forceStopPublishing(reason = 'lifecycle') {
    cancelPendingPublisherStop();
    if (publisherIdentityTimer) clearTimeout(publisherIdentityTimer);
    publisherIdentityTimer = null;
    publishGeneration += 1;
    if (!publishingNative && !publishing) return;
    send({ type: 'publisher-stopped' });
    publishingNative = false;
    feedPublishing = false;
    publishing = null;
    publisherDiscordUserId = '';
    for (const entry of peers.values()) { try { if (entry.pc) entry.pc.close(); } catch {} }
    peers.clear();
    peer = Array.from(incomingPeers.values()).find((entry) => entry.pc && entry.pc.connectionState !== 'closed')?.pc || null;
    try { if (feedTrack) feedTrack.stop(); } catch {}
    feedTrack = null;
    feedCanvas = null;
    feedCtx = null;
    try { if (feedSocket) feedSocket.close(); } catch {}
    feedSocket = null;
    report('native-stopped', { via: reason });
  }

  async function onHub(message) {
    if (message.type === 'stream-start') {
      if (isMyLifecycle(message)) {
        cancelPendingPublisherStop();
        report('lifecycle-accepted', 'start');
        void publishFeed();
      }
      return;
    }
    if (message.type === 'stream-stop') {
      if (isMyLifecycle(message)) {
        report('lifecycle-accepted', 'stop');
        schedulePublisherStop('lifecycle');
      }
      return;
    }
    if (message.type === 'remote-ready') {
      // A ponte pro relay (re)conectou. Este cliente pode transmitir e receber
      // ao mesmo tempo; pede as ofertas de todos os publicadores ativos.
      if (!hasLiveViewerPeer()) send({ type: 'request-offer' });
      return;
    }
    if (message.type === 'publisher-ready') {
      const publisherKey = String(message.from || '');
      const publisherUserId = validDiscordUserId(message.publisherUserId);
      const updated = publisherUserId
        ? updateReceivedPublisherIdentity(publisherKey, publisherUserId)
        : 0;
      if (publisherKey && !updated && !hasIncomingPublisher(publisherKey)) {
        send({ type: 'request-offer' });
      }
      return;
    }
    if (message.type === 'publisher-stopped') {
      const publisherId = String(message.from || '');
      for (const entry of Array.from(incomingPeers.values())) {
        if (String(entry.from || '') === publisherId) closeIncomingPeer(entry, 'publisher-stopped');
      }
      return;
    }
    if (message.type === 'peer-disconnected') {
      const publisherId = String(message.peer || '');
      for (const entry of Array.from(incomingPeers.values())) {
        if (String(entry.from || '') === publisherId) closeIncomingPeer(entry, 'peer-disconnected');
      }
      for (const entry of Array.from(peers.values())) {
        if (String(entry.from || '') === publisherId) closePublisherPeer(entry);
      }
      return;
    }
    if (message.type === 'settings') {
      await applyBitrate(message.bitrate, message.fps);
      return;
    }
    if (message.type === 'offer') {
      await acceptOffer(message.sdp, message.from, message.publisherUserId);
    } else if (message.type === 'answer') {
      // O identificador de roteamento fica fora do SDP. Versoes antigas o
      // anexavam como atributo no fim; Chromium rejeita esse SDP malformado.
      const ufrag = message.offerUfrag || extractOfferUfrag(message.sdp);
      let entry = ufrag ? peers.get(ufrag) : null;
      if (!entry && ufrag) {
        report('stale-answer', { ufrag });
        return;
      }
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
          const cleanSdp = message.sdp.replace(/\r?\na=x-bd-offer-ufrag:[^\r\n]*(?=\r?\n|$)/g, '');
          await entry.pc.setRemoteDescription({ type: 'answer', sdp: cleanSdp });
          entry.answered = true;
          if (message.from) entry.from = message.from;
          report('answer-accepted', { ufrag: ufrag || 'none' });
          // No answer, a=ice-ufrag: e o ufrag DO VIEWER - chaveia os ICE dele.
          entry.viewerUfrag = extractUfrag(message.sdp);
          const pendingKey = routeKey(message.from, entry.viewerUfrag);
          const pending = pendingIce.get(pendingKey) || [];
          pendingIce.delete(pendingKey);
          for (const c of pending) { try { await entry.pc.addIceCandidate(c); } catch {} }
        } catch (error) {
          log('answer falhou', String(error).slice(0, 120));
          reportOnce('answer-failed', { error: String(error).slice(0, 250) });
        }
      }
    } else if (message.type === 'ice') {
      const ufrag = candidateUfrag(message.candidate);
      // Primeiro roteia candidatos dos publicadores para o PeerConnection de
      // recepcao correspondente; em seguida tenta o par de envio por viewerUfrag.
      const incomingKey = ufrag ? routeKey(message.from, ufrag) : null;
      const incoming = incomingKey ? incomingPeers.get(incomingKey) : null;
      if (incoming) {
        if (!incoming.pc.remoteDescription) {
          queueIceCandidate(pendingIce, incomingKey, message.candidate);
          return;
        }
        try {
          await incoming.pc.addIceCandidate(message.candidate);
        } catch (error) {
          reportOnce('viewer-ice-failed', {
            ufrag: ufrag || 'none',
            error: String((error && error.message) || error).slice(0, 120),
          });
        }
        return;
      }

      let target = null;
      for (const e of peers.values()) {
        if (e.viewerUfrag && ufrag && e.viewerUfrag === ufrag
          && String(e.from || '') === String(message.from || '')) { target = e; break; }
      }
      if (!target) {
        if (ufrag) queueIceCandidate(pendingIce, routeKey(message.from, ufrag), message.candidate);
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
      // Oferta dedicada por viewer. Nao reutilize uma oferta broadcast: duas
      // respostas simultaneas nao podem negociar sobre o mesmo PeerConnection.
      if (!publishing) return;
      if (!message.from || String(message.from) === String(hubId)) return;
      void ensurePublisherPeer(message.from).catch((error) => log('request-offer', String(error).slice(0, 120)));
    }
  }

  // ----------------------------------------------------------- webrtc ------

  async function createPeer() {
    try {
      const ready = globalThis.__bdIceServersReady;
      if (ready && typeof ready.then === 'function') {
        await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 6500))]);
      }
    } catch {}
    const configuredIce = Array.isArray(globalThis.__bdIceServers)
      ? globalThis.__bdIceServers.filter((server) => server && server.urls)
      : [];
    const pc = new RTCPeerConnection({ iceServers: [...ICE, ...configuredIce], iceTransportPolicy: 'all' });
    pc.onicecandidate = (event) => { if (event.candidate) send({ type: 'ice', candidate: event.candidate }); };
    pc.ontrack = (event) => {
      report('p2p-track', {
        kind: event.track.kind,
        readyState: event.track.readyState,
        muted: event.track.muted,
        peer: pc.__bdEntry && pc.__bdEntry.from || 'unknown',
      });
      const entry = pc.__bdEntry;
      showStream(
        event.streams[0] || new MediaStream([event.track]),
        'p2p',
        entry && entry.publisherKey,
        entry && entry.from,
        entry && entry.publisherUserId
      );
    };
    pc.onconnectionstatechange = () => {
      log('peer', pc.connectionState);
      report('p2p-state', {
        connection: pc.connectionState,
        ice: pc.iceConnectionState,
        signaling: pc.signalingState,
        peer: pc.__bdEntry && pc.__bdEntry.from || 'unknown',
      });
      if (pc.connectionState === 'connected') {
        const active = pc.__bdEntry;
        if (active && active.publisherKey) {
          for (const old of Array.from(incomingPeers.values())) {
            if (old !== active && old.publisherKey === active.publisherKey) {
              closeIncomingPeer(old, 'replacement-connected');
            }
          }
          incomingByPublisher.set(active.publisherKey, active.routeKey);
        }
      }
    };
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      report('p2p-ice-state', { state });
      if (state === 'connected' || state === 'completed' || state === 'failed') {
        reportIcePath(pc, state);
      }
      if (state !== 'failed') return;

      const publisherEntry = Array.from(peers.values()).find((entry) => entry.pc === pc);
      const viewerEntry = Array.from(incomingPeers.values()).find((entry) => entry.pc === pc);
      if (publisherEntry && publishing) {
        void restartPublisherPeer(publisherEntry);
      } else if (viewerEntry && !pc.__bdOfferRetryRequested) {
        pc.__bdOfferRetryRequested = true;
        send({ type: 'request-offer' });
      }
    };
    return pc;
  }

  async function reportIcePath(pc, phase) {
    try {
      const stats = await pc.getStats();
      const pairs = Array.from(stats.values()).filter((item) => item.type === 'candidate-pair');
      const pair = pairs.find((item) => item.state === 'succeeded' && (item.nominated || item.selected))
        || pairs.find((item) => item.state === 'succeeded')
        || pairs.find((item) => item.state === 'in-progress')
        || pairs.find((item) => item.state === 'failed');
      const local = pair && stats.get(pair.localCandidateId);
      const remote = pair && stats.get(pair.remoteCandidateId);
      report('p2p-path', {
        phase,
        pair: pair ? pair.state : 'none',
        nominated: !!(pair && (pair.nominated || pair.selected)),
        localType: local && local.candidateType || 'unknown',
        remoteType: remote && remote.candidateType || 'unknown',
        protocol: local && local.protocol || remote && remote.protocol || 'unknown',
        rttMs: pair && Number.isFinite(pair.currentRoundTripTime)
          ? Math.round(pair.currentRoundTripTime * 1000) : null,
        sentBytes: pair && Number.isFinite(pair.bytesSent) ? pair.bytesSent : 0,
        receivedBytes: pair && Number.isFinite(pair.bytesReceived) ? pair.bytesReceived : 0,
      });
    } catch {}
  }

  async function restartPublisherPeer(entry) {
    if (!publishing || !entry || entry.restarting || entry.iceRestarts >= 1
      || entry.pc.connectionState === 'closed') return;
    entry.restarting = true;
    const oldUfrag = entry.localUfrag;
    try {
      entry.pc.restartIce();
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      const newUfrag = extractUfrag(entry.pc.localDescription && entry.pc.localDescription.sdp);
      if (!newUfrag) throw new Error('ICE restart sem ufrag');
      if (oldUfrag) peers.delete(oldUfrag);
      entry.localUfrag = newUfrag;
      entry.sdp = entry.pc.localDescription.sdp;
      entry.answered = false;
      entry.viewerUfrag = null;
      entry.iceRestarts += 1;
      peers.set(newUfrag, entry);
      send({ type: 'offer', sdp: entry.sdp, publisherUserId: publisherDiscordUserId || undefined });
      report('p2p-ice-restart', { attempt: entry.iceRestarts, result: 'offer-sent' });
    } catch (error) {
      report('p2p-ice-restart', {
        attempt: entry.iceRestarts || 1,
        result: 'failed',
        error: String((error && error.message) || error).slice(0, 120),
      });
    } finally {
      entry.restarting = false;
    }
  }

  function hasLiveViewerPeer() {
    return Array.from(incomingPeers.values()).some((entry) => {
      const state = entry.pc && entry.pc.connectionState;
      return state === 'new' || state === 'connecting' || state === 'connected';
    });
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
            sendEncodings: [{ maxBitrate: streamBitrate, maxFramerate: streamFps || 30 }],
          });
        } catch { pc.addTrack(track, stream); }
      } else {
        pc.addTrack(track, stream);
      }
    }
  }

  function announcePublisherReady() {
    const userId = publisherDiscordUserId || findDiscordUserId();
    if (userId) publisherDiscordUserId = userId;
    send({
      type: 'publisher-ready',
      ...(publisherDiscordUserId ? { publisherUserId: publisherDiscordUserId } : {}),
    });
    return publisherDiscordUserId;
  }

  function retryPublisherIdentity(generation, attempt = 1) {
    if (publisherIdentityTimer) clearTimeout(publisherIdentityTimer);
    publisherIdentityTimer = setTimeout(() => {
      publisherIdentityTimer = null;
      if (generation !== publishGeneration || !publishing) return;
      const userId = publisherDiscordUserId || findDiscordUserId();
      if (userId) {
        publisherDiscordUserId = userId;
        announcePublisherReady();
        report('publisher-identity-ready', { late: true, attempt });
        return;
      }
      if (attempt >= PUBLISHER_IDENTITY_RETRY_LIMIT) {
        reportOnce('publisher-identity-unavailable', { attempts: attempt });
        return;
      }
      retryPublisherIdentity(generation, attempt + 1);
    }, PUBLISHER_IDENTITY_RETRY_MS);
  }

  async function publish(stream) {
    cancelPendingPublisherStop();
    if (publisherIdentityTimer) clearTimeout(publisherIdentityTimer);
    publisherIdentityTimer = null;
    const replacing = !!publishing;
    publishing = stream;
    publishGeneration += 1;
    const generation = publishGeneration;
    if (!publisherDiscordUserId) publisherDiscordUserId = findDiscordUserId();
    if (replacing) {
      const byKind = new Map();
      for (const track of stream.getTracks()) {
        const list = byKind.get(track.kind) || [];
        list.push(track);
        byKind.set(track.kind, list);
      }
      for (const entry of peers.values()) {
        const pc = entry.pc;
        if (!pc || pc.connectionState === 'closed') continue;
        const nextByKind = new Map();
        const transceivers = pc.getTransceivers();
        for (const sender of pc.getSenders()) {
          const transceiver = transceivers.find((item) => item.sender === sender);
          const kind = sender.track && sender.track.kind
            || transceiver && transceiver.receiver && transceiver.receiver.track.kind;
          if (kind !== 'video' && kind !== 'audio') continue;
          const tracks = byKind.get(kind) || [];
          const index = nextByKind.get(kind) || 0;
          nextByKind.set(kind, index + 1);
          const replacement = tracks[index] || null;
          if (sender.track === replacement) continue;
          try { await sender.replaceTrack(replacement); }
          catch (error) {
            reportOnce('replace-track-failed', {
              kind,
              error: String((error && error.message) || error).slice(0, 120),
            });
          }
        }
      }
    }
    // A disponibilidade e anunciada; cada viewer pede sua oferta dedicada.
    // Assim viewers simultaneos nunca respondem sobre o mesmo PeerConnection.
    const publisherUserId = announcePublisherReady();
    if (!publisherUserId) retryPublisherIdentity(generation);
    log('publicando', stream.getVideoTracks()[0] && stream.getVideoTracks()[0].label);
    return true;
  }

  // Cria (ou reenvia a oferta de) um peer de publicacao. NUNCA destrói peers
  // answered/vivos - recriar por request-offer era o loop infinito.
  async function ensurePublisherPeer(from) {
    if (!publishing || !from) return;
    const viewerId = String(from);
    const generation = publishGeneration;
    if (creatingPublisherPeers.has(viewerId)) return;
    creatingPublisherPeers.add(viewerId);
    try {
      // Um peer independente por viewer.
      for (const entry of peers.values()) {
        if (String(entry.from) === viewerId) {
          if (entry.pc.iceConnectionState === 'failed') {
            void restartPublisherPeer(entry);
            return;
          }
          if (!entry.answered && entry.pc.connectionState !== 'closed') {
            send({ type: 'offer', sdp: entry.sdp, publisherUserId: publisherDiscordUserId || undefined });
          }
          return;
        }
      }
      const pc = await createPeer();
      if (generation !== publishGeneration || !publishing) {
        pc.close();
        return;
      }
      addStreamTracks(pc, publishing);
      await applyBitrate(streamBitrate, streamFps);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (generation !== publishGeneration || !publishing) {
        pc.close();
        return;
      }
      const ufrag = extractUfrag(pc.localDescription.sdp);
      if (!ufrag) throw new Error('oferta sem ICE ufrag');
      const entry = {
        pc,
        from,
        answered: false,
        sdp: pc.localDescription.sdp,
        localUfrag: ufrag,
        iceRestarts: 0,
        restarting: false,
      };
      pc.__bdEntry = entry;
      peers.set(ufrag, entry);
      if (!peer || peer.connectionState === 'closed') peer = pc;
      send({ type: 'offer', sdp: pc.localDescription.sdp, publisherUserId: publisherDiscordUserId || undefined });
    } finally {
      creatingPublisherPeers.delete(viewerId);
    }
  }

  async function acceptOffer(sdp, from, publisherUserId = '') {
    const ufrag = extractUfrag(sdp);
    if (!ufrag) {
      reportOnce('accept-offer-failed', { peer: from || 'unknown', error: 'oferta sem ICE ufrag' });
      return;
    }
    const publisherKey = String(from || ufrag || 'unknown');
    const key = routeKey(from, ufrag);
    // Oferta repetida do mesmo remetente: reenvia a answer sem criar outro PC.
    if (answeredUfrags.has(key)) {
      const cached = answeredUfrags.get(key);
      if (cached) send({ type: 'answer', sdp: cached, offerUfrag: ufrag });
      return;
    }
    if (acceptingUfrags.has(key)) return;
    acceptingUfrags.add(key);
    try {
      const previousKey = incomingByPublisher.get(publisherKey);
      if (previousKey === key && incomingPeers.has(key)) return;
      const viewerPeer = await createPeer();
      const entry = {
        pc: viewerPeer,
        from,
        publisherKey,
        publisherUserId: validDiscordUserId(publisherUserId),
        remoteUfrag: ufrag,
        routeKey: key,
        answered: false,
      };
      viewerPeer.__bdEntry = entry;
      incomingPeers.set(key, entry);
      incomingByPublisher.set(publisherKey, key);
      if (!peer || peer.connectionState === 'closed') peer = viewerPeer;
      await viewerPeer.setRemoteDescription({ type: 'offer', sdp });
      const pending = pendingIce.get(key) || [];
      pendingIce.delete(key);
      for (const candidate of pending) {
        try { await viewerPeer.addIceCandidate(candidate); }
        catch (error) {
          reportOnce('viewer-ice-failed', {
            ufrag: ufrag || 'none',
            error: String((error && error.message) || error).slice(0, 120),
          });
        }
      }
      const answer = await viewerPeer.createAnswer();
      await viewerPeer.setLocalDescription(answer);
      // O ufrag do publisher vai no envelope de sinalizacao, nao dentro do SDP.
      const answerSdp = viewerPeer.localDescription.sdp;
      send({ type: 'answer', sdp: answerSdp, offerUfrag: ufrag });
      entry.answered = true;
      answeredUfrags.set(key, answerSdp);
      if (answeredUfrags.size > 64) answeredUfrags.delete(answeredUfrags.keys().next().value);
      reportOnce("offer-accepted", { ufrag: ufrag || "none", peer: from || 'unknown' });
    } catch (error) {
      const entry = incomingPeers.get(key);
      if (entry) closeIncomingPeer(entry, 'offer-failed');
      reportOnce("accept-offer-failed", {
        peer: from || 'unknown',
        error: String((error && error.message) || error).slice(0, 120),
      });
    } finally {
      acceptingUfrags.delete(key);
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
    watch: () => { paused = false; feedWatchEnabled = true; connectFeed(); return true; },
    stop,
    restart: () => { paused = false; feedWatchEnabled = true; connectHub(); connectFeed(); },
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

  let lastFeedStatsFrames = 0;
  let lastFeedStatsAt = Date.now();
  setInterval(() => {
    if (rendered) report('stats', { frames });
    if (feedPublishing) {
      const now = Date.now();
      report('feed-stats', { frames, fps: Math.round((frames - lastFeedStatsFrames) * 1000 / Math.max(1, now - lastFeedStatsAt)) });
      lastFeedStatsFrames = frames;
      lastFeedStatsAt = now;
      const entry = Array.from(peers.values()).find((item) => item.answered && item.pc.connectionState !== 'closed');
      if (entry) {
        entry.pc.getStats().then((stats) => {
          for (const item of stats.values()) {
            if (item.type === 'outbound-rtp' && item.kind === 'video') {
              report('p2p-send-stats', {
                frames: item.framesSent,
                encoded: item.framesEncoded,
                fps: item.framesPerSecond,
                bytes: item.bytesSent,
                limit: item.qualityLimitationReason,
              });
              break;
            }
          }
        }).catch(() => {});
      }
    } else if (peer && receiving && peer.connectionState !== 'closed') {
      peer.getStats().then((stats) => {
        for (const item of stats.values()) {
          if (item.type === 'inbound-rtp' && item.kind === 'video') {
            report('p2p-recv-stats', {
              decoded: item.framesDecoded,
              fps: item.framesPerSecond,
              bytes: item.bytesReceived,
              lost: item.packetsLost,
            });
            break;
          }
        }
      }).catch(() => {});
    }
  }, 10000);
  // Revarre os players nativos para cobrir navegacao e o mini-player criado
  // depois do handshake, sem montar um segundo painel fora da UI do Discord.
  setInterval(() => {
    positionCover();
    retryPendingVideos();
    if (receivedStreams.size || receiving) tryInjectNative();
    pruneNativeBindings();
    flushOnce();
  }, 1200);
  // O erro 2012 pode ser renderizado depois da injecao. Limpa somente a camada
  // que sobrepoe um video ja ligado a uma stream P2P com frame decodificado.
  setInterval(() => {
    if (!receivingStreamsHaveFrame()) return;
    try {
      for (const [video, binding] of nativeBindings) {
        const item = receivedStreams.get(binding.publisherKey);
        if ((!item && binding.publisherKey === 'feed' && receivingHasFrame) || (item && item.hasFrame)) {
          hideStreamError(video);
        }
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
