(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ui = {
    mode: $('hub-mode'), hubHelp: $('hub-help'), session: $('session-code'), localPair: $('local-pair'),
    networkState: $('network-state'), networkNotice: $('network-notice'),
    connect: $('connect-test'), disconnect: $('disconnect-test'),
    signaling: $('check-signaling'), host: $('check-host'), srflx: $('check-srflx'),
    relay: $('check-relay'), ice: $('check-ice'), channel: $('check-channel'),
    route: $('check-route'), restart: $('check-restart'), connectionMs: $('connection-ms'),
    iceRtt: $('ice-rtt'), dcRtt: $('dc-rtt'), routeDetails: $('route-details'),
    restartButton: $('restart-ice'), copyReport: $('copy-report'),
    preset: $('media-preset'), mediaState: $('media-state'), synthetic: $('send-synthetic'),
    rustCapture: $('send-rust-capture'), stopMedia: $('stop-media'),
    remoteVideo: $('remote-video'), videoState: $('video-state'), sourceFps: $('source-fps'),
    encodeFps: $('encode-fps'), decodeFps: $('decode-fps'), packetsLost: $('packets-lost'),
    mediaNotice: $('media-notice'), e2eState: $('e2e-state'), e2eNotice: $('e2e-notice'),
    bridgeCount: $('bridge-count'), e2eTrack: $('e2e-track'), e2eFrame: $('e2e-frame'),
    e2eRoute: $('e2e-route'), e2eLog: $('e2e-log'),
  };

  const state = {
    config: null,
    signaling: null,
    hubId: null,
    peerId: null,
    session: '',
    pc: null,
    dc: null,
    initiator: false,
    makingOffer: false,
    pendingIce: [],
    negotiationPending: false,
    candidateCounts: { host: 0, srflx: 0, relay: 0 },
    connectedAt: 0,
    connectionTimer: 0,
    statsTimer: 0,
    pingTimer: 0,
    nextPing: 0,
    pendingPings: new Map(),
    restartRun: null,
    monitor: null,
    monitorId: null,
    monitorRetry: 0,
    bridgeIds: new Set(),
    e2eEvents: [],
    media: null,
    mediaSender: null,
    mediaTimer: 0,
    mediaSocket: null,
    sourceFrames: 0,
    sourceFpsAt: 0,
    sourceFpsFrames: 0,
    decodeFrames: 0,
    decodeFpsAt: 0,
    decodeFpsFrames: 0,
    observedRemoteStreams: new WeakSet(),
    lastRoute: null,
    report: {},
  };

  const defaults = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];

  function setStatus(node, text, tone) {
    node.textContent = text;
    node.classList.remove('good', 'warn-text', 'bad');
    if (tone) node.classList.add(tone);
  }

  function setReport(key, value) {
    state.report[key] = value;
  }

  function makeSessionCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    ui.session.value = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
    return ui.session.value;
  }

  function cleanSessionCode() {
    return ui.session.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
  }

  function localHubUrl() {
    return `ws://127.0.0.1:${location.port || '8791'}/hub`;
  }

  function remoteHubUrl() {
    const config = state.config;
    if (!config || !config.hubUrl || !config.room) throw new Error('Relay remoto não configurado neste Desjanjador.');
    const url = new URL(config.hubUrl);
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('URL de sinalização inválida.');
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(config.room)}`;
    if (config.secret) url.searchParams.set('secret', config.secret);
    return url.toString();
  }

  async function loadConfig() {
    ui.mode.add(new Option('Local — somente neste PC', 'local'));
    const params = new URLSearchParams(location.search);
    const requestedMode = params.get('mode');
    const sharedCode = params.get('code');
    if (sharedCode) ui.session.value = sharedCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
    try {
      const response = await fetch('/test-config', { cache: 'no-store' });
      if (!response.ok) throw new Error('configuração local indisponível');
      state.config = await response.json();
      try {
        const iceResponse = await fetch('/ice-config', { cache: 'no-store' });
        if (iceResponse.ok) {
          const iceConfig = await iceResponse.json();
          if (Array.isArray(iceConfig.iceServers)) {
            const merged = [...(state.config.iceServers || []), ...iceConfig.iceServers];
            state.config.iceServers = merged.filter((server, index) =>
              merged.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(server)) === index);
          }
          state.config.turnAvailable = iceConfig.turnAvailable === true;
          state.config.turnStatus = String(iceConfig.turnStatus || 'unknown');
        }
      } catch {}
      if (state.config.hubUrl && state.config.room) {
        ui.mode.add(new Option('Relay — entre redes/dispositivos', 'remote'));
        ui.mode.value = 'remote';
        ui.hubHelp.textContent = 'Sinalização usa o relay configurado; mídia continua P2P (ou TURN se necessário).';
      } else {
        ui.hubHelp.textContent = 'Relay remoto não configurado; modo local testa somente neste PC.';
      }
    } catch {
      state.config = null;
      ui.hubHelp.textContent = 'Configuração remota indisponível; use duas abas neste PC para o teste local.';
    }
    if (requestedMode === 'local' || params.get('pair') === '1') {
      ui.mode.value = 'local';
    } else if (requestedMode === 'remote' && Array.from(ui.mode.options).some((option) => option.value === 'remote')) {
      ui.mode.value = 'remote';
    }
    updateModeNotice();
    if (params.get('pair') === '1' && ui.mode.value === 'local' && ui.session.value.length >= 4) {
      window.setTimeout(() => void connectTest(), 0);
    }
  }

  function updateModeNotice() {
    if (ui.mode.value === 'local') {
      ui.networkNotice.textContent = 'Modo local: conecta abas neste PC, mas não testa NAT/Internet. Para isso, selecione Relay e use redes diferentes.';
      ui.hubHelp.textContent = 'Use “Abrir par local” para iniciar duas abas neste PC. Não mede NAT/Internet.';
      ui.localPair.hidden = false;
    } else {
      ui.networkNotice.textContent = 'Modo relay: o servidor encaminha somente signaling. O vídeo/DataChannel tentam conexão direta; TURN é usado somente se selecionado pelo ICE.';
      ui.hubHelp.textContent = 'Use o mesmo código nos dois dispositivos. O relay/senha nunca aparece no relatório.';
      ui.localPair.hidden = true;
    }
  }

  function selectedIceServers() {
    if (ui.mode.value === 'local') return [];
    const configured = state.config && Array.isArray(state.config.iceServers) ? state.config.iceServers : [];
    return [...defaults, ...configured];
  }

  function signal(kind, payload = {}, to = state.peerId) {
    const socket = state.signaling;
    if (!socket || socket.readyState !== WebSocket.OPEN || state.hubId == null) return false;
    socket.send(JSON.stringify({
      from: state.hubId,
      type: 'diag-signal',
      data: { session: state.session, to, kind, ...payload },
    }));
    return true;
  }

  function isForThisSession(message) {
    if (!message || message.type !== 'diag-signal' || !message.data) return false;
    const data = message.data;
    if (data.session !== state.session) return false;
    if (data.to != null && Number(data.to) !== Number(state.hubId)) return false;
    return Number(message.from) !== Number(state.hubId);
  }

  function safePeer(message) {
    const id = Number(message.from);
    if (!Number.isFinite(id) || id <= 0) return false;
    if (state.peerId != null && Number(state.peerId) !== id) return false;
    state.peerId = id;
    state.initiator = Number(state.hubId) < id;
    return true;
  }

  function setCandidateCount(type) {
    const key = type === 'host' || type === 'srflx' || type === 'relay' ? type : null;
    if (!key) return;
    state.candidateCounts[key] += 1;
    ui.host.textContent = String(state.candidateCounts.host);
    ui.srflx.textContent = String(state.candidateCounts.srflx);
    ui.relay.textContent = state.candidateCounts.relay ? `${state.candidateCounts.relay} detectado(s)` : 'Não detectado';
    if (key === 'srflx') setStatus(ui.srflx, `${state.candidateCounts.srflx} detectado(s)`, 'good');
    if (key === 'relay') setStatus(ui.relay, `${state.candidateCounts.relay} detectado(s)`, 'good');
  }

  function createPeerConnection() {
    const pc = new RTCPeerConnection({
      iceServers: selectedIceServers(),
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    state.pc = pc;
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        setCandidateCount(event.candidate.type);
        signal('ice', { candidate: event.candidate.toJSON() });
      } else {
        setStatus(ui.signaling, 'Gathering concluído', 'good');
      }
    };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'gathering') setStatus(ui.signaling, 'Coletando candidates…');
    };
    pc.oniceconnectionstatechange = () => {
      const ice = pc.iceConnectionState;
      setReport('iceState', ice);
      if (ice === 'connected' || ice === 'completed') {
        setStatus(ui.ice, ice === 'completed' ? 'Conectado (completo)' : 'Conectado', 'good');
        if (!state.connectedAt) {
          state.connectedAt = performance.now();
          ui.connectionMs.textContent = `${Math.round(state.connectedAt - state.connectionTimer)} ms`;
          setReport('connectionMs', Math.round(state.connectedAt - state.connectionTimer));
        }
        finishRestartIfReady();
      } else if (ice === 'checking') {
        setStatus(ui.ice, 'Verificando rota…', 'warn-text');
        if (state.restartRun) state.restartRun.sawChecking = true;
      } else if (ice === 'failed' || ice === 'disconnected') {
        setStatus(ui.ice, ice === 'failed' ? 'Falhou' : 'Desconectado', 'bad');
        setStatus(ui.networkState, 'Sem caminho ICE ativo', 'bad');
        ui.networkNotice.textContent = 'A sinalização chegou, mas o ICE não conectou. STUN pode ser bloqueado ou a rede pode exigir TURN.';
      } else {
        setStatus(ui.ice, 'Aguardando conexão');
      }
      updateRouteStats();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setStatus(ui.networkState, 'Conectado', 'good');
      if (pc.connectionState === 'failed') setStatus(ui.networkState, 'Conexão falhou', 'bad');
    };
    pc.ondatachannel = (event) => attachDataChannel(event.channel);
    pc.ontrack = (event) => attachRemoteTrack(event);
    pc.onicecandidateerror = (event) => {
      // Nunca exibir URL/hostname/endereços do erro do candidate.
      const code = Number(event.errorCode) || 0;
      if (code) ui.networkNotice.textContent = `Um servidor ICE respondeu com erro ${code}; o endereço foi omitido.`;
    };
    return pc;
  }

  function attachDataChannel(channel) {
    state.dc = channel;
    channel.onopen = () => {
      setStatus(ui.channel, 'Aberto', 'good');
      setStatus(ui.networkState, 'ICE + DataChannel conectados', 'good');
      ui.restartButton.disabled = false;
      ui.synthetic.disabled = false;
      ui.rustCapture.disabled = false;
      setReport('dataChannel', 'open');
      state.pingTimer = window.setInterval(sendPing, 1000);
      startStatsPolling();
    };
    channel.onclose = () => {
      setStatus(ui.channel, 'Fechado', 'bad');
      ui.restartButton.disabled = true;
      ui.synthetic.disabled = true;
      ui.rustCapture.disabled = true;
      setReport('dataChannel', 'closed');
    };
    channel.onerror = () => setStatus(ui.channel, 'Erro', 'bad');
    channel.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'ping') {
        try { channel.send(JSON.stringify({ type: 'pong', id: message.id, sentAt: message.sentAt })); } catch {}
      } else if (message.type === 'pong' && state.pendingPings.has(message.id)) {
        const sentAt = state.pendingPings.get(message.id);
        state.pendingPings.delete(message.id);
        const rtt = Math.max(0, Math.round(performance.now() - sentAt));
        ui.dcRtt.textContent = `${rtt} ms`;
        setReport('dataChannelRttMs', rtt);
      }
    };
  }

  function sendPing() {
    const channel = state.dc;
    if (!channel || channel.readyState !== 'open' || channel.bufferedAmount > 32_000) return;
    const id = ++state.nextPing;
    const sentAt = performance.now();
    state.pendingPings.set(id, sentAt);
    if (state.pendingPings.size > 10) state.pendingPings.delete(state.pendingPings.keys().next().value);
    try { channel.send(JSON.stringify({ type: 'ping', id, sentAt })); } catch {}
  }

  async function attachRemoteTrack(event) {
    const stream = event.streams && event.streams[0]
      ? event.streams[0]
      : new MediaStream([event.track]);
    ui.remoteVideo.srcObject = stream;
    ui.remoteVideo.play().catch(() => {});
    setStatus(ui.videoState, 'Track anexada; aguardando frame');
    setStatus(ui.mediaState, 'Track recebida; aguardando decode', 'warn-text');
    event.track.onended = () => setStatus(ui.videoState, 'Track encerrada', 'warn-text');
    if (!state.observedRemoteStreams.has(stream)) {
      state.observedRemoteStreams.add(stream);
      if ('requestVideoFrameCallback' in ui.remoteVideo) {
        const watchFrame = () => {
          if (ui.remoteVideo.srcObject !== stream) return;
          ui.remoteVideo.requestVideoFrameCallback((_, metadata) => {
            state.decodeFrames += 1;
            const now = performance.now();
            if (state.decodeFpsAt) {
              const seconds = (now - state.decodeFpsAt) / 1000;
              if (seconds >= 0.8) {
                const fps = Math.round((state.decodeFrames - state.decodeFpsFrames) / seconds);
                ui.decodeFps.textContent = String(fps);
                setReport('decodeFps', fps);
                state.decodeFpsAt = now;
                state.decodeFpsFrames = state.decodeFrames;
              }
            } else {
              state.decodeFpsAt = now;
              state.decodeFpsFrames = state.decodeFrames;
            }
            setStatus(ui.videoState, `${ui.remoteVideo.videoWidth}×${ui.remoteVideo.videoHeight} · primeiro frame recebido`, 'good');
            setStatus(ui.mediaState, 'Vídeo decodificado', 'good');
            if (metadata && Number.isFinite(metadata.mediaTime)) setReport('lastVideoTime', Number(metadata.mediaTime.toFixed(2)));
            watchFrame();
          });
        };
        watchFrame();
      } else {
        ui.remoteVideo.onplaying = () => {
          setStatus(ui.videoState, `${ui.remoteVideo.videoWidth}×${ui.remoteVideo.videoHeight} · reproduzindo`, 'good');
          setStatus(ui.mediaState, 'Vídeo reproduzindo', 'good');
        };
      }
    }
  }

  function acceptPeer(message) {
    const firstPeer = state.peerId == null;
    if (!isForThisSession(message) || !safePeer(message)) return;
    if (firstPeer) {
      setStatus(ui.networkState, 'Peer encontrado; negociando ICE…', 'warn-text');
      ui.networkNotice.textContent = 'Peer encontrado. Iniciando oferta e coleta de candidates ICE.';
    }
    const { kind } = message.data;
    const data = message.data;
    if (kind === 'hello') {
      if (state.initiator) void makeOffer(false);
      return;
    }
    if (kind === 'offer') {
      state.peerId = Number(message.from);
      void acceptOffer(data.sdp);
    } else if (kind === 'answer') {
      void acceptAnswer(data.sdp);
    } else if (kind === 'ice') {
      addRemoteCandidate(data.candidate);
    } else if (kind === 'renegotiate' && state.initiator) {
      void requestRenegotiation();
    } else if (kind === 'restart-request') {
      if (state.initiator) void restartIce();
    }
  }

  async function makeOffer(iceRestart) {
    const pc = state.pc;
    if (!pc || !state.initiator || state.peerId == null) return;
    if (state.makingOffer || pc.signalingState !== 'stable') {
      if (!iceRestart) state.negotiationPending = true;
      return;
    }
    state.negotiationPending = false;
    state.makingOffer = true;
    try {
      if (!state.dc) attachDataChannel(pc.createDataChannel('desjanjador-diagnostic', { ordered: true }));
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await pc.setLocalDescription(offer);
      signal('offer', { sdp: pc.localDescription.sdp });
    } catch (error) {
      setStatus(ui.signaling, `Oferta falhou: ${String(error.message || error).slice(0, 70)}`, 'bad');
    } finally {
      state.makingOffer = false;
    }
  }

  async function requestRenegotiation() {
    if (!state.pc) return;
    if (!state.initiator) {
      signal('renegotiate');
      return;
    }
    state.negotiationPending = true;
    await makeOffer(false);
  }

  async function acceptOffer(sdp) {
    const pc = state.pc;
    if (!pc || typeof sdp !== 'string') return;
    try {
      if (pc.signalingState !== 'stable') {
        setStatus(ui.signaling, 'Oferta concorrente ignorada', 'warn-text');
        return;
      }
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await flushRemoteCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      signal('answer', { sdp: pc.localDescription.sdp });
      setStatus(ui.signaling, 'Oferta/respondida', 'good');
    } catch (error) {
      setStatus(ui.signaling, `Oferta inválida: ${String(error.message || error).slice(0, 70)}`, 'bad');
    }
  }

  async function acceptAnswer(sdp) {
    const pc = state.pc;
    if (!pc || typeof sdp !== 'string' || pc.signalingState !== 'have-local-offer') return;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp });
      await flushRemoteCandidates();
      setStatus(ui.signaling, 'Answer recebida', 'good');
      if (state.negotiationPending) void makeOffer(false);
    } catch (error) {
      setStatus(ui.signaling, `Answer inválida: ${String(error.message || error).slice(0, 70)}`, 'bad');
    }
  }

  async function addRemoteCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object' || !state.pc) return;
    if (!state.pc.remoteDescription) {
      state.pendingIce.push(candidate);
      return;
    }
    try { await state.pc.addIceCandidate(candidate); } catch { /* candidate fora de ordem/ufrag antiga */ }
  }

  async function flushRemoteCandidates() {
    const queue = state.pendingIce.splice(0);
    for (const candidate of queue) {
      try { await state.pc.addIceCandidate(candidate); } catch { /* desc pode ter sido renegociada */ }
    }
  }

  function buildSignalUrl() {
    return ui.mode.value === 'remote' ? remoteHubUrl() : localHubUrl();
  }

  function openLocalPair() {
    if (ui.mode.value !== 'local') return;
    const code = makeSessionCode();
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('mode', 'local');
    url.searchParams.set('code', code);
    url.searchParams.set('pair', '1');

    const peerTab = window.open(url.toString(), '_blank');
    if (peerTab) peerTab.opener = null;
    void connectTest();
    ui.networkNotice.textContent = peerTab
      ? 'Par local aberto. As duas abas usam o mesmo código e o hub local; isso testa signaling e mídia no PC, não NAT/Internet.'
      : 'O navegador bloqueou a nova aba. Esta aba já está conectando; abra /webrtc-test em outra aba deste PC e use o código exibido.';
  }

  function resetNetworkUi() {
    state.candidateCounts = { host: 0, srflx: 0, relay: 0 };
    state.connectedAt = 0;
    state.connectionTimer = performance.now();
    state.lastRoute = null;
    ui.host.textContent = '0';
    ui.srflx.textContent = '0';
    ui.relay.textContent = 'Não detectado';
    setStatus(ui.signaling, 'Aguardando');
    setStatus(ui.ice, 'Aguardando');
    setStatus(ui.channel, 'Aguardando');
    setStatus(ui.route, '—');
    setStatus(ui.restart, 'Não testado');
    ui.connectionMs.textContent = '—';
    ui.iceRtt.textContent = '—';
    ui.dcRtt.textContent = '—';
    ui.routeDetails.textContent = '—';
    ui.restartButton.disabled = true;
    ui.synthetic.disabled = true;
    ui.rustCapture.disabled = true;
    setStatus(ui.networkState, 'Conectando sinalização…');
  }

  async function connectTest() {
    const session = cleanSessionCode();
    if (session.length < 4) {
      setStatus(ui.networkNotice, 'Use um código de pelo menos 4 caracteres.', 'bad');
      return;
    }
    if (!('RTCPeerConnection' in window)) {
      setStatus(ui.networkNotice, 'Este navegador não oferece RTCPeerConnection.', 'bad');
      return;
    }
    if (state.signaling || state.pc) disconnectTest();
    state.session = session;
    state.peerId = null;
    state.pendingIce = [];
    state.initiator = false;
    state.makingOffer = false;
    resetNetworkUi();
    ui.connect.disabled = true;
    ui.disconnect.disabled = false;
    if (ui.mode.value === 'local') {
      ui.networkNotice.textContent = 'Sinalização local conectada. Esse modo só valida loopback, SDP, DataChannel e vídeo; não valida NAT real.';
    }
    try {
      const pc = createPeerConnection();
      const socket = new WebSocket(buildSignalUrl());
      state.signaling = socket;
      socket.onopen = () => setStatus(ui.signaling, 'WebSocket aberto; aguardando welcome…');
      socket.onmessage = (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'welcome') {
          state.hubId = Number(message.id);
          setStatus(ui.signaling, 'Conectado ao hub', 'good');
          setStatus(ui.networkState, 'Aguardando segundo peer…', 'warn-text');
          ui.networkNotice.textContent = ui.mode.value === 'remote'
            ? 'Relay de signaling conectado. Abra o teste no outro dispositivo com o mesmo modo e código para iniciar ICE.'
            : 'Hub local conectado. Abra uma segunda aba neste computador com o mesmo modo e código para iniciar ICE.';
          signal('hello', { role: 'diagnostic' }, null);
          return;
        }
        acceptPeer(message);
      };
      socket.onerror = () => {
        setStatus(ui.signaling, 'WebSocket/sinalização falhou', 'bad');
        setStatus(ui.networkState, 'Não conectou ao hub', 'bad');
        ui.networkNotice.textContent = ui.mode.value === 'remote'
          ? 'Falha ao acessar o relay configurado. Verifique internet, segredo e URL.'
          : 'Falha no hub local. Verifique se o Desjanjador continua aberto.';
      };
      socket.onclose = (event) => {
        if (state.signaling !== socket) return;
        setStatus(ui.signaling, `Fechado (${event.code || 'sem código'})`, 'bad');
        if (state.pc && state.pc.connectionState !== 'connected') setStatus(ui.networkState, 'Sinalização encerrada', 'bad');
      };
      state.statsTimer = window.setInterval(updateRouteStats, 1500);
      state.connectionTimer = performance.now();
      state.report = { mode: ui.mode.value, iceServersConfigured: selectedIceServers().length };
      setReport('signaling', 'connecting');
      void pc;
    } catch (error) {
      setStatus(ui.signaling, `Não conectou: ${String(error.message || error).slice(0, 80)}`, 'bad');
      ui.connect.disabled = false;
      ui.disconnect.disabled = true;
    }
  }

  function disconnectTest() {
    stopMedia(false);
    clearInterval(state.statsTimer);
    clearInterval(state.pingTimer);
    clearTimeout(state.restartRun && state.restartRun.timeout);
    state.restartRun = null;
    state.pendingPings.clear();
    try { if (state.dc) state.dc.close(); } catch {}
    try { if (state.pc) state.pc.close(); } catch {}
    try { if (state.signaling) state.signaling.close(); } catch {}
    state.dc = null;
    state.pc = null;
    state.signaling = null;
    state.hubId = null;
    state.peerId = null;
    ui.remoteVideo.srcObject = null;
    setStatus(ui.videoState, 'Nenhum frame');
    ui.encodeFps.textContent = '—';
    ui.decodeFps.textContent = '—';
    ui.packetsLost.textContent = '—';
    ui.connect.disabled = false;
    ui.disconnect.disabled = true;
    ui.restartButton.disabled = true;
    ui.synthetic.disabled = true;
    ui.rustCapture.disabled = true;
    setStatus(ui.networkState, 'Desconectado');
    setStatus(ui.mediaState, 'Aguardando conexão ICE');
    setStatus(ui.channel, 'Aguardando');
    setStatus(ui.ice, 'Aguardando');
  }

  function getLocalUfrag() {
    const sdp = state.pc && state.pc.localDescription && state.pc.localDescription.sdp || '';
    return (sdp.match(/^a=ice-ufrag:(.+)$/m) || [])[1] || '';
  }

  async function restartIce() {
    if (!state.pc || !state.dc || state.dc.readyState !== 'open') return;
    if (!state.initiator) {
      signal('restart-request');
      state.restartRun = { oldUfrag: '', started: performance.now(), sawChecking: false };
      setStatus(ui.restart, 'Solicitado ao peer ofertante…', 'warn-text');
      state.restartRun.timeout = window.setTimeout(() => finishRestart(false), 15_000);
      return;
    }
    if (state.pc.signalingState !== 'stable' || state.makingOffer) {
      setStatus(ui.restart, 'Aguarde a negociação atual terminar.', 'warn-text');
      return;
    }
    state.restartRun = { oldUfrag: getLocalUfrag(), started: performance.now(), sawChecking: false };
    setStatus(ui.restart, 'Em andamento…', 'warn-text');
    state.restartRun.timeout = window.setTimeout(() => finishRestart(false), 15_000);
    try {
      state.pc.restartIce();
      await makeOffer(true);
    } catch {
      finishRestart(false);
    }
  }

  function finishRestart(ok) {
    const run = state.restartRun;
    if (!run) return;
    clearTimeout(run.timeout);
    state.restartRun = null;
    const elapsed = Math.round(performance.now() - run.started);
    setStatus(ui.restart, ok ? `Concluído · ${elapsed} ms` : 'Falhou / expirou', ok ? 'good' : 'bad');
    setReport('iceRestart', ok ? 'ok' : 'failed');
    setReport('iceRestartMs', elapsed);
    if (!ok) ui.networkNotice.textContent = 'O ICE restart não recuperou a sessão em 15 s. A troca de rede/peer pode exigir uma nova conexão.';
  }

  function finishRestartIfReady() {
    const run = state.restartRun;
    if (!run || !state.pc || state.pc.iceConnectionState !== 'connected' && state.pc.iceConnectionState !== 'completed') return;
    const newUfrag = getLocalUfrag();
    if (state.initiator && run.oldUfrag && newUfrag === run.oldUfrag && !run.sawChecking) return;
    if (performance.now() - run.started < 600) return;
    finishRestart(!!(state.dc && state.dc.readyState === 'open'));
  }

  function getSelectedPair(stats) {
    const reports = Array.from(stats.values());
    const transport = reports.find((item) => item.type === 'transport' && item.selectedCandidatePairId);
    if (transport) {
      const selected = stats.get(transport.selectedCandidatePairId);
      if (selected) return selected;
    }
    return reports.find((item) => item.type === 'candidate-pair' && (item.selected || item.nominated) && item.state === 'succeeded')
      || reports.find((item) => item.type === 'candidate-pair' && item.state === 'succeeded')
      || null;
  }

  function addressFamily(candidate) {
    const address = candidate && (candidate.address || candidate.ip) || '';
    if (!address) return '—';
    return address.includes(':') ? 'IPv6' : 'IPv4';
  }

  async function updateRouteStats() {
    const pc = state.pc;
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      const pair = getSelectedPair(stats);
      if (pair) {
        const local = stats.get(pair.localCandidateId);
        const remote = stats.get(pair.remoteCandidateId);
        const localType = local && local.candidateType || 'unknown';
        const remoteType = remote && remote.candidateType || 'unknown';
        const protocol = local && local.protocol || remote && remote.protocol || '—';
        const family = addressFamily(local);
        const route = localType === 'relay' || remoteType === 'relay' ? 'TURN relay' : 'Direta';
        ui.route.textContent = route;
        ui.routeDetails.textContent = `${family} · ${protocol.toUpperCase()}`;
        setStatus(ui.route, route, route === 'TURN relay' ? 'warn-text' : 'good');
        if (Number.isFinite(pair.currentRoundTripTime)) {
          const rtt = Math.round(pair.currentRoundTripTime * 1000);
          ui.iceRtt.textContent = `${rtt} ms`;
          setReport('iceRttMs', rtt);
        }
        state.lastRoute = { route, localType, remoteType, protocol, family };
        setReport('route', state.lastRoute);
      }

      for (const item of stats.values()) {
        if (item.type === 'outbound-rtp' && item.kind === 'video' && item.ssrc != null) {
          if (Number.isFinite(item.framesPerSecond)) ui.encodeFps.textContent = `${Math.round(item.framesPerSecond)} FPS`;
          else if (Number.isFinite(item.framesEncoded)) ui.encodeFps.textContent = `${item.framesEncoded} frames encoded`;
          if (Number.isFinite(item.framesEncoded)) setReport('framesEncoded', item.framesEncoded);
          break;
        }
      }
      for (const item of stats.values()) {
        if (item.type === 'inbound-rtp' && item.kind === 'video') {
          const decoded = Number(item.framesDecoded) || 0;
          if (Number.isFinite(item.framesPerSecond)) ui.decodeFps.textContent = `${Math.round(item.framesPerSecond)} FPS`;
          if (Number.isFinite(item.packetsLost)) {
            ui.packetsLost.textContent = String(item.packetsLost);
            setReport('packetsLost', item.packetsLost);
          }
          setReport('framesDecoded', decoded);
          break;
        }
      }
    } catch {}
  }

  function startStatsPolling() {
    if (state.statsTimer) clearInterval(state.statsTimer);
    state.statsTimer = window.setInterval(updateRouteStats, 1500);
    void updateRouteStats();
  }

  function selectedPreset() {
    const [resolution, rawFps, rawBitrate] = ui.preset.value.split(':');
    const [width, height] = String(resolution || '').split('x').map(Number);
    const fps = Number(rawFps);
    const bitrate = Number(rawBitrate);
    if (![width, height, fps, bitrate].every(Number.isFinite) || width <= 0 || height <= 0 || fps <= 0 || bitrate <= 0) {
      throw new Error('Perfil de captura inválido. Selecione outra resolução/FPS.');
    }
    return { width, height, fps, bitrate };
  }

  function drawTestFrame(ctx, canvas, frame, fps) {
    const now = performance.now();
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#182c54');
    gradient.addColorStop(1, '#09111c');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const unit = Math.max(18, Math.floor(canvas.width / 32));
    const x = Math.floor((Math.sin(now / 700) + 1) * (canvas.width - unit * 2) / 2);
    ctx.fillStyle = '#90a8ff';
    ctx.fillRect(x, Math.floor(canvas.height * 0.56), unit, unit);
    ctx.fillStyle = '#f0f4fc';
    ctx.font = `600 ${Math.max(20, Math.floor(canvas.width / 24))}px Segoe UI, sans-serif`;
    ctx.fillText('Desjanjador · vídeo sintético', Math.floor(canvas.width * 0.05), Math.floor(canvas.height * 0.28));
    ctx.font = `${Math.max(14, Math.floor(canvas.width / 55))}px Consolas, monospace`;
    ctx.fillText(`${canvas.width}×${canvas.height} · alvo ${fps} FPS · frame ${frame}`, Math.floor(canvas.width * 0.05), Math.floor(canvas.height * 0.37));
    ctx.fillText(new Date().toLocaleTimeString(), Math.floor(canvas.width * 0.05), Math.floor(canvas.height * 0.45));
  }

  function startSynthetic() {
    stopMedia(false);
    try {
      const { width, height, fps, bitrate } = selectedPreset();
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx || !canvas.captureStream) throw new Error('Canvas captureStream indisponível.');
      let frame = 0;
      drawTestFrame(ctx, canvas, frame, fps);
      const stream = canvas.captureStream(fps);
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('Não foi possível criar a track de vídeo.');
      state.media = { track, stream, canvas, synthetic: true };
      state.mediaSender = state.pc.addTrack(track, stream);
      const params = state.mediaSender.getParameters();
      params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = bitrate;
      params.encodings[0].maxFramerate = fps;
      void state.mediaSender.setParameters(params).catch(() => {});
      state.sourceFrames = 0;
      state.sourceFpsAt = performance.now();
      state.sourceFpsFrames = 0;
      state.mediaTimer = window.setInterval(() => {
        frame += 1;
        drawTestFrame(ctx, canvas, frame, fps);
        state.sourceFrames += 1;
        updateSourceFps();
      }, Math.max(8, Math.round(1000 / fps)));
      track.onended = () => setStatus(ui.mediaState, 'Fonte encerrada', 'warn-text');
      void requestRenegotiation();
      ui.stopMedia.disabled = false;
      ui.synthetic.disabled = true;
      ui.rustCapture.disabled = true;
      setStatus(ui.mediaState, `Sintético ${width}×${height} @ ${fps} FPS`, 'warn-text');
      ui.mediaNotice.textContent = 'Canvas local para testar encode, ICE, transporte e decode. Não captura sua tela nem altera a configuração nativa do Discord.';
    } catch (error) {
      setStatus(ui.mediaState, String(error.message || error), 'bad');
    }
  }

  function updateSourceFps() {
    const now = performance.now();
    const seconds = (now - state.sourceFpsAt) / 1000;
    if (seconds < 0.9) return;
    const fps = Math.round((state.sourceFrames - state.sourceFpsFrames) / seconds);
    ui.sourceFps.textContent = `${fps} FPS`;
    setReport('sourceFps', fps);
    state.sourceFpsAt = now;
    state.sourceFpsFrames = state.sourceFrames;
  }

  function startRustCapture() {
    stopMedia(false);
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx || !canvas.captureStream) throw new Error('Canvas captureStream indisponível.');
      let stream = canvas.captureStream(0);
      let track = stream.getVideoTracks()[0];
      if (!track || typeof track.requestFrame !== 'function') {
        stream.getTracks().forEach((item) => item.stop());
        stream = canvas.captureStream(60);
        track = stream.getVideoTracks()[0];
      }
      if (!track) throw new Error('Não foi possível criar a track da captura.');
      state.media = { track, stream, canvas, ctx, rust: true };
      state.mediaSender = state.pc.addTrack(track, stream);
      const params = state.mediaSender.getParameters();
      params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = 12_000_000;
      params.encodings[0].maxFramerate = 120;
      void state.mediaSender.setParameters(params).catch(() => {});
      const socket = new WebSocket(`ws://127.0.0.1:${location.port || '8791'}/ws`);
      state.mediaSocket = socket;
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        setStatus(ui.mediaState, 'Feed local conectado; aguardando captura…', 'warn-text');
        ui.mediaNotice.textContent = 'Usa a fonte e as configurações atuais do Desjanjador. Não altere qualidade aqui enquanto uma live nativa estiver ativa.';
      };
      socket.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer) || event.data.byteLength < 16) return;
        try {
          const view = new DataView(event.data);
          const width = view.getUint32(0, true);
          const height = view.getUint32(4, true);
          if (!width || !height || width > 7680 || height > 4320) return;
          const expectedBytes = width * height * 4;
          if (event.data.byteLength - 16 !== expectedBytes) return;
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
          }
          const pixels = new Uint8ClampedArray(event.data, 16, expectedBytes);
          ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
          if (typeof track.requestFrame === 'function') track.requestFrame();
          state.sourceFrames += 1;
          updateSourceFps();
          setStatus(ui.mediaState, `Captura ${width}×${height}; enviando…`, 'warn-text');
        } catch (error) {
          setStatus(ui.mediaState, `Frame local inválido: ${String(error.message || error).slice(0, 60)}`, 'bad');
        }
      };
      socket.onerror = () => setStatus(ui.mediaState, 'Falha ao abrir o feed local /ws', 'bad');
      void requestRenegotiation();
      ui.stopMedia.disabled = false;
      ui.synthetic.disabled = true;
      ui.rustCapture.disabled = true;
      setStatus(ui.mediaState, 'Captura iniciada; aguardando primeiro frame…');
    } catch (error) {
      setStatus(ui.mediaState, String(error.message || error), 'bad');
      stopMedia(false);
    }
  }

  function stopMedia(restoreButtons = true) {
    clearInterval(state.mediaTimer);
    state.mediaTimer = 0;
    try { if (state.mediaSocket) state.mediaSocket.close(); } catch {}
    state.mediaSocket = null;
    if (state.mediaSender && state.pc) {
      try { state.pc.removeTrack(state.mediaSender); } catch {}
    }
    try {
      if (state.media && state.media.stream) state.media.stream.getTracks().forEach((track) => track.stop());
    } catch {}
    state.media = null;
    state.mediaSender = null;
    ui.stopMedia.disabled = true;
    if (restoreButtons && state.dc && state.dc.readyState === 'open') {
      ui.synthetic.disabled = false;
      ui.rustCapture.disabled = false;
      setStatus(ui.mediaState, 'Mídia parada');
      void requestRenegotiation();
    } else if (!restoreButtons) {
      ui.synthetic.disabled = true;
      ui.rustCapture.disabled = true;
    }
  }

  async function copyReport() {
    const report = {
      timestamp: new Date().toISOString(),
      mode: state.report.mode || ui.mode.value,
      signaling: ui.signaling.textContent,
      candidates: { ...state.candidateCounts },
      ice: ui.ice.textContent,
      route: state.lastRoute || null,
      connectionMs: state.report.connectionMs || null,
      iceRttMs: state.report.iceRttMs || null,
      dataChannelRttMs: state.report.dataChannelRttMs || null,
      iceRestart: state.report.iceRestart || 'not-tested',
      media: {
        sourceFps: state.report.sourceFps || null,
        encodeFps: ui.encodeFps.textContent,
        decodeFps: ui.decodeFps.textContent,
        framesEncoded: state.report.framesEncoded || null,
        framesDecoded: state.report.framesDecoded || null,
        packetsLost: state.report.packetsLost || 0,
      },
      discord: {
        bridgeCount: state.bridgeIds.size,
        track: ui.e2eTrack.textContent,
        firstFrame: ui.e2eFrame.textContent,
        route: ui.e2eRoute.textContent,
        events: state.e2eEvents.slice(-30),
      },
      privacy: 'Sem IP, endereços de candidate, segredo do relay ou credenciais ICE. O código temporário de sessão foi omitido.',
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      ui.networkNotice.textContent = 'Relatório sanitizado copiado.';
    } catch {
      ui.networkNotice.textContent = 'Clipboard indisponível. Abra a página por http://127.0.0.1 para liberar a cópia segura.';
    }
  }

  const E2E_TYPES = new Set([
    'bridge-ready', 'p2p-state', 'p2p-ice-state', 'p2p-path', 'p2p-track',
    'rendered', 'video-first-frame', 'player-attached', 'player-ok', 'video-health',
    'p2p-send-stats', 'p2p-recv-stats', 'settings', 'bitrate', 'stream-start', 'stream-stop',
    'feed-stats', 'feed-socket', 'feed-track', 'lifecycle-accepted',
  ]);

  function safeEventSummary(type, data) {
    const d = data && typeof data === 'object' ? data : {};
    switch (type) {
      case 'bridge-ready': return 'bridge Discord pronto';
      case 'p2p-state': return `P2P ${String(d.connection || '—')} · ICE ${String(d.ice || '—')}`;
      case 'p2p-ice-state': return `ICE ${String(d.state || '—')}`;
      case 'p2p-path': return `${String(d.phase || 'rota')} · ${String(d.localType || '?')} → ${String(d.remoteType || '?')} · ${String(d.protocol || '?').toUpperCase()}${Number.isFinite(d.rttMs) ? ` · ${d.rttMs} ms` : ''}`;
      case 'p2p-track': return `track ${String(d.kind || '?')} · ${String(d.readyState || '?')}${d.muted ? ' · muted' : ''}`;
      case 'rendered': return `track anexada ao player (${String(d.source || '—')})`;
      case 'video-first-frame': return `primeiro frame ${Number(d.width) || 0}×${Number(d.height) || 0}`;
      case 'player-attached': return `player encontrado; largura ${Number(d.width) || 0}px; aguardando decode`;
      case 'player-ok': return `player reproduzindo ${Number(d.width) || 0}×${Number(d.height) || 0}`;
      case 'video-health': return `vídeo ${Number(d.width) || 0}×${Number(d.height) || 0} · readyState ${Number(d.readyState) || 0} · ${d.paused ? 'pausado' : 'tocando'}`;
      case 'p2p-send-stats': return `envio ${Number(d.fps) || 0} FPS · ${Number(d.encoded) || 0} frames · limite ${String(d.limit || '—')}`;
      case 'p2p-recv-stats': return `recepção ${Number(d.fps) || 0} FPS · ${Number(d.decoded) || 0} decodificados · perda ${Number(d.lost) || 0}`;
      case 'settings': return `configuração ${Number(d.width) || 0}×${Number(d.height) || 0} @ ${Number(d.fps) || 0} FPS · ${Math.round((Number(d.bitrate) || 0) / 1_000_000)} Mbps`;
      case 'bitrate': return `bitrate ${Math.round((Number(d.bitrate) || 0) / 1_000_000)} Mbps · ${Number(d.fps) || 0} FPS`;
      case 'stream-start': return 'ciclo de stream iniciado';
      case 'stream-stop': return 'ciclo de stream encerrado';
      case 'feed-stats': return `feed local ${Number(d.fps) || 0} FPS · ${Number(d.frames) || 0} frames`;
      case 'feed-socket': return `feed local ${String(d.state || '—')}`;
      case 'feed-track': return `feed track ${String(d.state || '—')}`;
      case 'lifecycle-accepted': return `ciclo aceito: ${String(data || '—')}`;
      default: return type;
    }
  }

  function updateE2e(type, data, from) {
    const d = data && typeof data === 'object' ? data : {};
    if (type === 'bridge-ready' && from > 0) {
      state.bridgeIds.add(from);
      ui.bridgeCount.textContent = String(state.bridgeIds.size);
      setStatus(ui.e2eState, 'Bridge Discord conectado', 'good');
      ui.e2eNotice.textContent = 'Bridge ativo. Inicie ou alterne uma live pela UI nativa para acompanhar track, rota e primeiro frame.';
    }
    if (type === 'p2p-track' || type === 'rendered') {
      ui.e2eTrack.textContent = type === 'rendered' ? 'Anexada ao player; aguardando decode' : `${d.kind || 'vídeo'} · ${d.readyState || 'track live'}`;
      setStatus(ui.e2eTrack, ui.e2eTrack.textContent, 'warn-text');
    }
    if (type === 'video-first-frame' || type === 'player-ok') {
      ui.e2eFrame.textContent = `${Number(d.width) || 0}×${Number(d.height) || 0} · decodificado`;
      setStatus(ui.e2eFrame, ui.e2eFrame.textContent, 'good');
      setStatus(ui.e2eState, 'Vídeo decodificado no player Discord', 'good');
    }
    if (type === 'video-health' && Number(d.readyState) >= 2 && Number(d.width) > 0) {
      ui.e2eFrame.textContent = `${Number(d.width)}×${Number(d.height)} · tocando`;
      setStatus(ui.e2eFrame, ui.e2eFrame.textContent, 'good');
    }
    if (type === 'p2p-path') {
      ui.e2eRoute.textContent = `${d.localType || '?'} → ${d.remoteType || '?'} · ${String(d.protocol || '?').toUpperCase()}`;
    }
    if (type === 'p2p-state') {
      if (d.connection === 'failed') setStatus(ui.e2eState, 'P2P falhou; verifique rota ICE', 'bad');
      else if (d.connection === 'connected') setStatus(ui.e2eState, 'P2P conectado; aguardando frame decodificado');
    }
    if (type === 'p2p-ice-state' && (d.state === 'failed' || d.state === 'disconnected')) {
      setStatus(ui.e2eState, `ICE ${d.state}`, 'bad');
    }
  }

  function appendE2eEvent(type, data, from) {
    const time = new Date().toLocaleTimeString();
    const summary = safeEventSummary(type, data);
    const entry = { time, type, summary };
    state.e2eEvents.push(entry);
    if (state.e2eEvents.length > 100) state.e2eEvents.shift();
    if (ui.e2eLog.querySelector('.event-empty')) ui.e2eLog.replaceChildren();
    const row = document.createElement('div');
    row.textContent = `${time} · #${from} · ${summary}`;
    ui.e2eLog.appendChild(row);
    while (ui.e2eLog.childElementCount > 100) ui.e2eLog.firstElementChild.remove();
    ui.e2eLog.scrollTop = ui.e2eLog.scrollHeight;
  }

  function connectMonitor() {
    if (state.monitor && (state.monitor.readyState === WebSocket.CONNECTING || state.monitor.readyState === WebSocket.OPEN)) return;
    let monitor;
    try { monitor = new WebSocket(localHubUrl()); } catch { retryMonitor(); return; }
    state.monitor = monitor;
    monitor.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'welcome') {
        state.monitorId = Number(message.id);
        state.monitorRetry = 0;
        setStatus(ui.e2eState, 'Monitor local conectado');
        return;
      }
      const from = Number(message.from) || 0;
      if (from >= 900000 || !E2E_TYPES.has(message.type)) return;
      updateE2e(message.type, message.data, from);
      appendE2eEvent(message.type, message.data, from);
    };
    monitor.onclose = retryMonitor;
    monitor.onerror = () => {
      setStatus(ui.e2eState, 'Monitor local desconectado', 'warn-text');
      try { monitor.close(); } catch {}
    };
  }

  function retryMonitor() {
    if (state.monitorRetry) return;
    state.monitorRetry = window.setTimeout(() => {
      state.monitorRetry = 0;
      connectMonitor();
    }, 3000);
  }

  function clearE2e() {
    state.e2eEvents = [];
    state.bridgeIds.clear();
    ui.bridgeCount.textContent = '0';
    ui.e2eTrack.textContent = '—';
    ui.e2eFrame.textContent = '—';
    ui.e2eRoute.textContent = '—';
    const empty = document.createElement('span');
    empty.className = 'event-empty';
    empty.textContent = 'Eventos limpos; aguardando novas mensagens.';
    ui.e2eLog.replaceChildren(empty);
  }

  $('generate-code').addEventListener('click', makeSessionCode);
  $('local-pair').addEventListener('click', openLocalPair);
  $('connect-test').addEventListener('click', () => void connectTest());
  $('disconnect-test').addEventListener('click', disconnectTest);
  $('restart-ice').addEventListener('click', () => void restartIce());
  $('send-synthetic').addEventListener('click', startSynthetic);
  $('send-rust-capture').addEventListener('click', startRustCapture);
  $('stop-media').addEventListener('click', () => stopMedia(true));
  $('copy-report').addEventListener('click', () => void copyReport());
  $('clear-e2e').addEventListener('click', clearE2e);
  ui.mode.addEventListener('change', updateModeNotice);
  ui.session.addEventListener('input', () => { ui.session.value = cleanSessionCode(); });
  window.addEventListener('beforeunload', () => {
    stopMedia(false);
    try { if (state.pc) state.pc.close(); } catch {}
    try { if (state.signaling) state.signaling.close(); } catch {}
    try { if (state.monitor) state.monitor.close(); } catch {}
  });

  makeSessionCode();
  setStatus(ui.e2eState, 'Conectando monitor local…');
  connectMonitor();
  void loadConfig();
})();
