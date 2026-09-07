import { DiscordSDK } from '@discord/embedded-app-sdk';
import { profileFor } from '../../../shared/adaptation.js';
import { createPeer, FALLBACK_MS, fetchIceServers, tuneSenders } from '../../../shared/rtc.js';
import { captureMonitor, createBroadcaster, fitWithin } from '../../../shared/media.js';
import { createPlayer } from './player.js';
import { connectRelaySocket } from './relay-socket.js';
import { createSfuPublisher, createSfuViewer } from './sfu.js';
import { createPlaybackFeedback } from './playback-feedback.js';
import { createAudience } from './audience.js';
import { createViewControls } from './view-controls.js';
import { createRoomState } from './room-state.js';
import { createCaptureContinuity } from './capture-continuity.js';
import { pageMode, captureSession, createShareLink } from './access.js';
import './styles.css';

const root = document.querySelector('#app');
const mode = pageMode(new URL(location.href), window.self !== window.top);
const inDiscord = mode === 'viewer';
const apiBase = inDiscord ? '/.proxy' : '';
const apiUrl = (path) => `${apiBase}${path}`;
document.documentElement.classList.toggle('discord-mode', inDiscord);
document.body.classList.toggle('discord-mode', inDiscord);

async function authenticateDiscord() {
  const params = new URLSearchParams(location.search);
  if (params.get('external') === '1') return { accessToken: '', user: '', instance: params.get('room') || 'external', sdk: null, publicOrigin: location.origin };
  const config = await fetch(apiUrl('/api/config')).then((response) => response.json());
  if (!config.clientId) return { accessToken: '', user: crypto.randomUUID(), instance: 'demo', sdk: null, publicOrigin: location.origin };
  const sdk = new DiscordSDK(config.clientId);
  await sdk.ready();
  const { code } = await sdk.commands.authorize({ client_id: config.clientId, response_type: 'code', state: crypto.randomUUID(), prompt: 'none', scope: ['identify', 'applications.commands'] });
  const { access_token: accessToken } = await fetch(apiUrl('/api/discord/token'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }).then((response) => response.json());
  const auth = await sdk.commands.authenticate({ access_token: accessToken });
  return { accessToken, user: auth.user.id, instance: sdk.instanceId || 'activity', sdk, publicOrigin: config.publicOrigin || location.origin };
}

function renderCapture(token) {
  const tabId = crypto.randomUUID();
  const tabChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('bigducks-stream-capture') : null;
  let activeStop = null;
  let activeSwitch = null;
  tabChannel?.addEventListener('message', ({ data }) => {
    if (data?.type === 'replace' && data.tabId !== tabId) {
      activeStop?.('Transmissão substituída por outra aba.');
      setTimeout(() => window.close(), 100);
    }
  });
  tabChannel?.postMessage({ type: 'replace', tabId });
  root.innerHTML = `<div class="shell capture-shell"><div class="card capture-card"><span class="eyebrow">BIG DUCKS · ESTÚDIO</span><h1>Compartilhe com seu canal</h1><p class="muted">Compartilhe o monitor do jogo. Seus amigos assistem pelo Discord.</p><div class="toolbar"><div class="capture-actions"><button class="primary" id="start">Compartilhar tela inteira</button><button class="danger" id="stop" hidden>Parar transmissão</button><button id="switch-source" hidden>Trocar monitor</button></div><details class="capture-settings"><summary>Fonte, qualidade e áudio</summary><p>Compartilhamento de tela inteira</p><small>Selecione o monitor do jogo. A live acompanha a mudança entre o cliente e a partida do LoL. Todo o monitor fica visível; o som pode incluir outros aplicativos.</small><label class="field">Qualidade<select id="quality"><option value="adaptive">Automático — recomendado</option><option value="720p30">720p / 30 FPS (recomendado)</option><option value="720p60">720p / 60 FPS</option><option value="1080p30">1080p / 30 FPS</option><option value="1080p60">1080p / 60 FPS</option></select></label><label title="Autorize o áudio do sistema no seletor do navegador. Outros aplicativos também podem ser ouvidos."><input id="audio" type="checkbox" checked> compartilhar áudio do sistema</label><small class="muted">Automático: até 720p/30. 1080p e 60 FPS consomem mais dados. Autorize o áudio também no seletor do navegador.</small></details></div><div id="status" class="status">Pronto para transmitir.</div><div class="metrics"><span id="source">Fonte: —</span><span id="fps">FPS: —</span><span id="bitrate">Bitrate: —</span><span id="audio-state">Áudio: aguardando</span></div><video id="preview" class="preview" autoplay muted playsinline hidden></video></div></div>`;
  const startButton = document.querySelector('#start');
  const stopButton = document.querySelector('#stop');
  const switchButton = document.querySelector('#switch-source');
  const status = document.querySelector('#status');
  const captureAudience = createAudience(document.querySelector('.capture-card'));
  let starting = false;
  const startCapture = async () => {
    if (starting) return;
    let captured;
    starting = true;
    startButton.disabled = true;
    switchButton.disabled = true;
    try {
      const quality = document.querySelector('#quality').value;
      const profile = { ...profileFor(quality === 'adaptive' ? '720p30' : quality), automatic: quality === 'adaptive' };
      status.textContent = 'Selecione Tela inteira, escolha o monitor do jogo e autorize o áudio…';
      let stream = await captureMonitor({ fps: profile.fps, audio: document.querySelector('#audio').checked });
      captured = stream;
      status.textContent = 'Conectando sua transmissão…';
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) videoTrack.contentHint = 'detail';
      const runtimeConfig = await fetch(apiUrl('/api/config')).then((response) => response.json()).catch(() => ({}));
      const socket = await connectRelaySocket({ apiBase, token });
      const joined = new Promise((resolve) => socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data);
        if (message.type === 'joined') resolve(message);
      }));
      socket.send(JSON.stringify({ type: 'hello' }));
      const { slot } = await joined;
      const peers = new Map();
      let broadcaster;
      let relayStarting;
      let relayMedia;
      let sfuPublisher;
      let continuity;
      let sfuAudience = null;
      const updateAudience = async () => {
        if (!sfuPublisher || sfuAudience === null || stopped) return;
        const count = sfuAudience;
        try {
          await sfuPublisher.setAudience(count);
          if (stopped || count !== sfuAudience) return;
          if (!continuity?.waiting) status.textContent = count === 0 ? 'Economia de banda ativa. Mantenha esta página aberta.' : 'Transmitindo. Mantenha esta página aberta.';
          document.querySelector('#bitrate').textContent = count === 0 ? 'Economia: vídeo até 40 kbps / 1 FPS' : `Bitrate máximo: ${(profile.bitrate / 1_000_000).toFixed(1)} Mbps`;
        } catch {
          if (!stopped) status.textContent = 'Transmitindo; não foi possível ajustar a economia de banda neste navegador.';
        }
      };
      let thumbnailTimer;
      let stopped = false;
      const stopBroadcast = (message = 'Transmissão encerrada.') => {
        if (stopped) return;
        stopped = true;
        starting = false;
        stopButton.disabled = true; stopButton.hidden = true;
        switchButton.disabled = true; switchButton.hidden = true;
        startButton.disabled = false; startButton.hidden = false;
        const preview = document.querySelector('#preview'); preview.srcObject = null; preview.hidden = true;
        status.textContent = message;
        captureAudience.update([]);
        activeStop = null;
        activeSwitch = null;
        continuity?.close();
        clearInterval(thumbnailTimer);
        try { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop', slot })); } catch { /* socket already unavailable */ }
        for (const track of stream.getTracks()) { try { track.enabled = false; track.stop(); } catch { /* track already stopped */ } }
        try { broadcaster?.stop(); } catch { /* encoder already closed */ }
        try { sfuPublisher?.close(); } catch { /* SFU already closed */ }
        for (const { peer } of peers.values()) { try { peer.close(); } catch { /* peer already closed */ } }
        try { socket.close(); } catch { /* socket already closed */ }
      };
      socket.addEventListener('close', () => stopBroadcast('Conexão com a sala encerrada. Inicie a transmissão novamente.'));
      const ensureRelay = () => {
        if (broadcaster) return Promise.resolve(relayMedia);
        if (relayStarting) return relayStarting;
        relayStarting = createBroadcaster({ ws: socket, profile, audio: true, stream, slot, stopTracks: false, onStatus: (media) => { relayMedia = media; }, onEnd: (error) => { if (!sfuPublisher && !continuity?.waiting) stopBroadcast(error?.message || 'Captura encerrada.'); } })
          .then((value) => { if (stopped) value.stop(); else broadcaster = value; return relayMedia; })
          .catch((error) => { relayStarting = null; throw error; });
        return relayStarting;
      };
      socket.addEventListener('message', async (event) => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data);
        if (message.type === 'audience' && message.slot === slot) { captureAudience.update(message.viewers); return; }
        if (message.type === 'sfu-audience' && message.slot === slot && Number.isInteger(message.count) && message.count >= 0) {
          sfuAudience = message.count;
          await updateAudience();
          return;
        }
        if (message.type === 'need-keyframe') { broadcaster?.requestKeyframe(); return; }
        if (message.type === 'fallback-want') {
          try {
            await ensureRelay();
            broadcaster?.requestKeyframe();
            socket.send(JSON.stringify({ type: 'fallback-ready', slot, viewer: message.viewer, ...relayMedia }));
          } catch { socket.send(JSON.stringify({ type: 'fallback-failed', slot, viewer: message.viewer })); }
          return;
        }
        if (message.type !== 'rtc-want') return;
        peers.get(message.viewer)?.peer.close();
        const outbound = [];
        let offerSent = false;
        const peer = createPeer({ iceServers: await fetchIceServers('', token), onIce: (candidate) => { if (offerSent) socket.send(JSON.stringify({ type: 'rtc', viewer: message.viewer, slot, candidate })); else outbound.push(candidate); }, onState: (state) => { if (['failed', 'closed', 'disconnected'].includes(state)) { peer.close(); peers.delete(message.viewer); } } });
        const entry = { peer, pendingCandidates: [] };
        peers.set(message.viewer, entry);
        for (const track of stream.getTracks()) peer.addTrack(track, stream);
        await tuneSenders(peer, { bitrate: profile.bitrate, fps: profile.fps });
        const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
        socket.send(JSON.stringify({ type: 'rtc', viewer: message.viewer, slot, description: peer.localDescription }));
        offerSent = true;
        for (const candidate of outbound) socket.send(JSON.stringify({ type: 'rtc', viewer: message.viewer, slot, candidate }));
      });
      continuity = createCaptureContinuity(stream, {
        onReplace: async (track) => {
          if (sfuPublisher) await sfuPublisher.replaceVideoTrack(track);
          for (const { peer } of peers.values()) {
            const sender = peer.getSenders().find((sender) => sender.track?.kind === 'video');
            try { await sender?.replaceTrack(track); } catch { peer.close(); }
          }
        },
        onWaiting: () => {
          status.textContent = 'O compartilhamento foi interrompido. Sua live continua: selecione o monitor novamente.';
          switchButton.textContent = 'Selecionar monitor';
          switchButton.hidden = false; switchButton.disabled = starting;
        },
        onChanged: async ({ source, waiting }) => {
          if (stopped) return;
          const settings = source.getVideoTracks()[0].getSettings();
          const size = fitWithin(settings.width || profile.width, settings.height || profile.height, profile.width, profile.height);
          if (broadcaster || relayStarting) {
            await relayStarting?.catch(() => {});
            broadcaster?.stop(); broadcaster = null; relayStarting = null;
            await ensureRelay(); broadcaster?.requestKeyframe();
          }
          if (stopped) return;
          const hasAudio = source.getAudioTracks().length > 0;
          socket.send(JSON.stringify({ type: 'source-update', slot, ...size, fps: waiting ? 1 : profile.fps, waiting, relayMedia,
            audioConfig: hasAudio ? { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 } : null }));
          document.querySelector('#preview').srcObject = stream;
          document.querySelector('#source').textContent = waiting ? 'Fonte: aguardando monitor' : `Fonte: ${size.width}×${size.height}`;
          document.querySelector('#audio-state').textContent = hasAudio ? 'Áudio do sistema: ativado' : 'Sem áudio do sistema. Para ativar, troque o monitor e autorize o áudio no seletor.';
          if (!waiting) { status.textContent = 'Fonte atualizada. Seus amigos continuam na mesma live.'; switchButton.textContent = 'Trocar monitor'; }
        },
        onError: () => { status.textContent = 'Não foi possível atualizar a fonte. Selecione o monitor novamente.'; },
      });
      stream = continuity.stream;
      activeSwitch = async () => {
        if (switchButton.disabled || stopped) return;
        switchButton.disabled = true;
        try {
          const next = await captureMonitor({ fps: profile.fps, audio: document.querySelector('#audio').checked });
          await continuity.replace(next);
        } catch (error) {
          if (!stopped) status.textContent = error?.name === 'NotAllowedError'
            ? 'Seleção cancelada. A live foi mantida; você pode escolher outra fonte.'
            : `Não foi possível trocar a fonte: ${error?.message || 'tente novamente'}`;
        } finally { if (!stopped) switchButton.disabled = false; }
      };
      activeStop = stopBroadcast;
      if (runtimeConfig.sfuEnabled) {
        try {
          const iceServers = await fetchIceServers('', token).catch(() => [{ urls: 'stun:stun.cloudflare.com:3478' }]);
          sfuPublisher = await createSfuPublisher({ stream, profile, token, iceServers });
          if (stopped) { sfuPublisher.close(); return; }
          await sfuPublisher.replaceVideoTrack(stream.getVideoTracks()[0]);
        } catch { sfuPublisher?.close(); sfuPublisher = null; }
      }
      if (!sfuPublisher) await ensureRelay();
      const videoSettings = stream.getVideoTracks()[0]?.getSettings?.() || {};
      const audioSettings = continuity.source.getAudioTracks()[0]?.getSettings?.();
      const audioConfig = audioSettings ? { codec: 'opus', sampleRate: audioSettings.sampleRate || 48_000, numberOfChannels: Math.max(1, Math.min(2, audioSettings.channelCount || 2)) } : null;
      const sfuSize = fitWithin(videoSettings.width || profile.width, videoSettings.height || profile.height, profile.width, profile.height);
      const media = sfuPublisher ? { codec: 'webrtc', ...sfuSize, fps: Math.min(videoSettings.frameRate || profile.fps, profile.fps), audioConfig } : relayMedia;
      socket.send(JSON.stringify({ type: 'start', slot, transport: sfuPublisher ? 'sfu' : 'relay', mediaToken: sfuPublisher?.mediaToken, ...media, waiting: continuity.waiting }));
      document.querySelector('#audio-state').textContent = media.audioConfig ? `Áudio da fonte: Opus ${media.audioConfig.numberOfChannels === 1 ? 'mono' : 'estéreo'}` : document.querySelector('#audio').checked ? 'Sem áudio: clique em Trocar monitor e autorize o áudio do sistema no seletor. O suporte depende do navegador.' : 'Áudio: desativado';
      document.querySelector('#source').textContent = `Fonte: ${media.width}×${media.height}`;
      document.querySelector('#fps').textContent = `${sfuPublisher ? 'Cloudflare SFU' : `Codec: ${media.codec}`} / ${Math.round(media.fps)} FPS`;
      document.querySelector('#bitrate').textContent = `Bitrate máximo: ${(profile.bitrate / 1_000_000).toFixed(1)} Mbps`;
      socket.addEventListener('message', async (event) => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data);
        if (message.type !== 'rtc') return;
        const entry = peers.get(message.viewer);
        if (!entry) return;
        if (message.description) {
          await entry.peer.setRemoteDescription(message.description);
          for (const candidate of entry.pendingCandidates.splice(0)) await entry.peer.addIceCandidate(candidate);
        }
        if (message.candidate) {
          if (entry.peer.remoteDescription) await entry.peer.addIceCandidate(message.candidate);
          else entry.pendingCandidates.push(message.candidate);
        }
      });
      const preview = document.querySelector('#preview'); preview.srcObject = stream; preview.hidden = false;
      const thumbnailCanvas = document.createElement('canvas'); thumbnailCanvas.width = 320; thumbnailCanvas.height = 180;
      const sendThumbnail = () => {
        if (stopped || socket.readyState !== WebSocket.OPEN || preview.readyState < 2) return;
        const context = thumbnailCanvas.getContext('2d');
        context.drawImage(preview, 0, 0, thumbnailCanvas.width, thumbnailCanvas.height);
        socket.send(JSON.stringify({ type: 'thumbnail', slot, data: thumbnailCanvas.toDataURL('image/jpeg', 0.45) }));
      };
      preview.addEventListener('loadeddata', sendThumbnail, { once: true });
      thumbnailTimer = setInterval(sendThumbnail, 3000);
      startButton.hidden = true; startButton.disabled = false;
      stopButton.hidden = false; stopButton.disabled = false;
      switchButton.hidden = false; switchButton.disabled = false;
      starting = false;
      status.textContent = continuity.waiting ? 'O compartilhamento foi interrompido. Selecione o monitor novamente.' : 'Transmitindo. Mantenha esta página aberta.';
      void updateAudience();
      window.addEventListener('beforeunload', () => stopBroadcast(), { once: true });
    } catch (error) {
      activeStop?.();
      captured?.getTracks().forEach((track) => track.stop());
      starting = false;
      startButton.disabled = false;
      switchButton.disabled = false;
      status.textContent = error?.name === 'NotAllowedError' ? 'Permissão de captura cancelada.' : `Não foi possível iniciar: ${error?.message || 'erro desconhecido'}`;
    }
  };
  startButton.onclick = () => startCapture();
  stopButton.onclick = () => activeStop?.();
  switchButton.onclick = () => activeSwitch?.();
}

async function renderViewer() {
  root.innerHTML = `<div class="shell"><div class="card viewer-shell"><section id="browse-view" class="browse-view"><header class="viewer-heading"><div><span class="eyebrow">BIG DUCKS · SEU CANAL</span><h1>Ao vivo com seus amigos</h1><p class="muted">Escolha uma live e entre. Sem sair do Discord.</p></div><button id="publish" class="primary">Transmitir minha tela</button></header><div id="status" class="status">Conectando à sala…</div><div class="streams" id="streams" aria-busy="true"></div></section><section id="watch-view" class="watch-view" hidden><header class="watch-header"><button id="back-to-streams" class="back-button" type="button">← Voltar</button><span class="live-badge watch-live">AO VIVO</span><img id="watch-avatar" class="avatar" alt=""><strong id="watch-name">Transmissão</strong><span class="watch-spacer"></span></header><footer class="watch-controls"><span class="live-caption">TRANSMISSÃO AO VIVO</span><button id="mute-live" class="player-action" type="button">🔊 Áudio</button><input id="live-volume" aria-label="Volume da transmissão" type="range" min="0" max="100" value="100"></footer><div class="stage"><span class="muted">Carregando transmissão…</span></div></section></div></div>`;
  let viewerUserId = '';
  const roomUi = createRoomState({ status: document.querySelector('#status'), container: document.querySelector('#streams'), publish: document.querySelector('#publish'), retry: () => location.reload() });
  const identityPromise = authenticateDiscord().then((identity) => { viewerUserId = identity.user; return identity; });
  document.querySelector('#publish').onclick = async () => {
    try {
      const identity = await identityPromise;
      const response = await fetch(apiUrl('/api/session'), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${identity.accessToken}` }, body: JSON.stringify({ room: identity.instance, user: identity.user, role: 'publisher' }) });
      if (!response.ok) throw new Error('Não foi possível criar a transmissão');
      const { token } = await response.json();
      const url = await createShareLink({ publicOrigin: identity.publicOrigin, apiBase, token });
      const result = await identity.sdk?.commands.openExternalLink({ url });
      if (!identity.sdk) window.open(url, '_blank', 'noopener');
      if (result?.opened === false) throw new Error('Abertura recusada');
      document.querySelector('#status').textContent = 'A página de transmissão foi aberta no navegador.';
    } catch (error) {
      document.querySelector('#status').textContent = `Não foi possível abrir o navegador: ${error.message}`;
    }
  };
  const viewerShell = document.querySelector('.viewer-shell');
  const browseView = document.querySelector('#browse-view');
  const watchView = document.querySelector('#watch-view');
  const watchName = document.querySelector('#watch-name');
  const watchAvatar = document.querySelector('#watch-avatar');
  const watchAudience = createAudience(document.querySelector('.watch-header'));
  const muteButton = document.querySelector('#mute-live');
  let retryWatch = () => {};
  let muted = false;
  let playbackLocked = false;
  const showWatchView = (stream) => {
    watchName.textContent = stream?.name || 'Transmissão';
    watchAvatar.src = stream?.avatar || '';
    watchAvatar.hidden = !stream?.avatar;
    browseView.hidden = true;
    watchView.hidden = false;
    viewerShell.classList.add('watching');
    viewControls.reset();
  };
  const showBrowseView = () => { watchView.hidden = true; browseView.hidden = false; viewerShell.classList.remove('watching'); watchAudience.close(); };
  const canvas = document.createElement('canvas');
  document.querySelector('.stage').replaceChildren(canvas);
  const player = createPlayer(canvas);
  const directVideo = document.createElement('video');
  directVideo.autoplay = true; directVideo.playsInline = true; directVideo.controls = false; directVideo.style.display = 'none'; directVideo.style.width = '100%'; directVideo.style.height = '100%'; directVideo.style.objectFit = 'contain';
  const setPlaybackMuted = (value, locked = playbackLocked) => {
    muted = Boolean(value);
    playbackLocked = locked;
    player.setMuted(muted);
    directVideo.muted = muted;
    muteButton.disabled = playbackLocked;
    muteButton.textContent = playbackLocked ? '🔇 Sua live sem retorno' : muted ? '🔇 Ativar áudio' : '🔊 Áudio';
    muteButton.title = playbackLocked ? 'Evita que o áudio reproduzido seja recapturado e gere eco.' : '';
  };
  muteButton.onclick = () => { if (!playbackLocked) setPlaybackMuted(!muted, false); };
  document.querySelector('.stage').append(directVideo);
  const viewControls = createViewControls(watchView, directVideo);
  const feedback = createPlaybackFeedback(watchView, directVideo, canvas, () => retryWatch());
  document.querySelector('#live-volume').oninput = (event) => {
    const volume = Number(event.target.value) / 100;
    directVideo.volume = volume;
    player.setVolume?.(volume);
    if (!playbackLocked) setPlaybackMuted(volume === 0, false);
  };
  let directPeer;
  let sfuViewer;
  let relayFallbackActive = false;
  let directPending = [];
  let rtcSlot = null;
  let rtcActive = false;
  let rtcTimer;
  identityPromise.then((identity) => fetch(apiUrl('/api/session'), { method: 'POST', headers: { 'content-type': 'application/json', ...(identity.accessToken ? { authorization: `Bearer ${identity.accessToken}` } : {}) }, body: JSON.stringify({ room: identity.instance, user: identity.user, role: 'viewer' }) })).then((response) => {
    if (!response.ok) throw new Error('Discord session unavailable');
    return response.json();
  }).then(async ({ token }) => {
      roomUi.progress('Buscando as transmissões do canal…');
      const socket = await connectRelaySocket({ apiBase, token });
      if (roomUi.phase === 'error') { socket.close(); return; }
      const availableStreams = new Map();
      const audiences = new Map();
      let selectedSlot = null;
      let watchRevision = 0;
      const stopSfu = () => {
        watchRevision++;
        const active = sfuViewer; sfuViewer = null;
        try { active?.close(); } catch { /* already closed */ }
        relayFallbackActive = false;
      };
      const stopRtc = ({ resumeRelay = false } = {}) => {
        clearTimeout(rtcTimer);
        if (rtcSlot !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'rtc-bye', slot: rtcSlot }));
        const peer = directPeer; directPeer = null; peer?.close(); directPending = [];
        directVideo.pause(); directVideo.srcObject = null; directVideo.style.display = 'none';
        canvas.style.display = 'block';
        const wasActive = rtcActive; rtcActive = false; rtcSlot = null;
        if (resumeRelay && wasActive && selectedSlot !== null) {
          const stream = availableStreams.get(selectedSlot);
          if (stream) player.configure({ codec: stream.codec || 'avc1.64002a' });
          socket.send(JSON.stringify({ type: 'watch', slot: selectedSlot }));
          document.querySelector('#status').textContent = 'P2P interrompido; usando relay.';
        }
      };
      const stopWatching = (statusText = 'Você parou de assistir.') => {
        if (selectedSlot !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'unwatch', slot: selectedSlot }));
        feedback.hide();
        stopRtc(); stopSfu(); selectedSlot = null; player.close();
        document.querySelector('.stage').innerHTML = '<span class="muted">Carregando transmissão…</span>';
        document.querySelector('#status').textContent = statusText;
        showBrowseView();
        renderStreams();
      };
      document.querySelector('#back-to-streams').onclick = () => stopWatching();
      socket.addEventListener('close', () => { stopWatching(); availableStreams.clear(); roomUi.fail('A conexão com a sala foi interrompida. Tente novamente para buscar as lives atuais.'); });
      window.addEventListener('beforeunload', () => { stopWatching(); socket.close(); }, { once: true });
      const renderStreams = () => {
        const container = document.querySelector('#streams');
        if (!roomUi.render(availableStreams.size)) return;
        const focusedSlot = document.activeElement?.closest?.('.stream-card')?.dataset.slot;
        container.replaceChildren(...[...availableStreams.values()].map((message) => {
          const item = document.createElement('article'); item.className = `stream-card${selectedSlot === message.slot ? ' active' : ''}`; item.tabIndex = 0; item.role = 'button'; item.ariaLabel = `Assistir à transmissão de ${message.name}`;
          item.dataset.slot = String(message.slot);
          if (message.newUntil > Date.now()) item.classList.add('new-live');
          const thumbnail = document.createElement('div'); thumbnail.className = 'stream-thumb';
          if (message.thumbnail) { const image = document.createElement('img'); image.src = message.thumbnail; image.alt = `Prévia da transmissão de ${message.name}`; thumbnail.append(image); }
          else { const empty = document.createElement('span'); empty.textContent = 'Aguardando prévia'; thumbnail.append(empty); }
          const live = document.createElement('span'); live.className = 'live-badge'; live.textContent = message.waiting ? 'TROCANDO FONTE' : 'AO VIVO'; thumbnail.append(live);
          const details = document.createElement('div'); details.className = 'stream-details';
          const identity = document.createElement('div'); identity.className = 'stream-identity';
          if (message.avatar) { const avatar = document.createElement('img'); avatar.className = 'avatar'; avatar.src = message.avatar; avatar.alt = ''; identity.append(avatar); }
          else { const avatar = document.createElement('span'); avatar.className = 'avatar fallback'; avatar.textContent = (message.name || '?').slice(0, 1).toUpperCase(); identity.append(avatar); }
          const text = document.createElement('div'); const name = document.createElement('strong'); name.textContent = message.name; const meta = document.createElement('small'); meta.textContent = `${message.width}×${message.height} · ${Math.round(message.fps)} FPS${message.audioConfig ? ' · Com áudio' : ' · Sem áudio'}${message.transport === 'sfu' ? ' · Edge SFU' : ''}`; text.append(name, meta); identity.append(text);
          if (message.userId === viewerUserId) name.textContent = `${message.name} · Sua live`;
          const count = document.createElement('small'); count.dataset.viewerCount = ''; count.textContent = `${(audiences.get(message.slot) || []).length} assistindo`; text.append(count);
          const openStream = async () => {
            if (selectedSlot === message.slot) { stopWatching(); return; }
            if (selectedSlot !== null) socket.send(JSON.stringify({ type: 'unwatch', slot: selectedSlot }));
            stopRtc(); stopSfu(); player.close();
            selectedSlot = message.slot;
            watchAudience.update(audiences.get(message.slot));
            retryWatch = () => { stopWatching(); void openStream(); };
            feedback.show(`Conectando à live de ${message.name}…`, message.thumbnail);
            const stage = document.querySelector('.stage');
            stage.replaceChildren(canvas, directVideo);
            const watchingOwnStream = Boolean(viewerUserId) && message.userId === viewerUserId;
            setPlaybackMuted(watchingOwnStream, watchingOwnStream);
            showWatchView(message);
            renderStreams();
            if (message.transport === 'sfu' && message.mediaToken) {
              const revision = watchRevision;
              const isCurrent = () => revision === watchRevision && selectedSlot === message.slot;
              socket.send(JSON.stringify({ type: 'sfu-watch', slot: message.slot }));
              canvas.style.display = 'none'; directVideo.style.display = 'block';
              document.querySelector('#status').textContent = `Conectando à transmissão de ${message.name} pela Cloudflare…`;
              let fallbackRequested = false;
              const requestFallback = () => {
                if (fallbackRequested || !isCurrent()) return;
                fallbackRequested = true;
                stopSfu();
                directVideo.style.display = 'none'; canvas.style.display = 'block';
                socket.send(JSON.stringify({ type: 'fallback-want', slot: message.slot }));
                document.querySelector('#status').textContent = 'Ativando relay de compatibilidade…';
              };
              try {
                const iceServers = await fetchIceServers(apiBase, token).catch(() => [{ urls: 'stun:stun.cloudflare.com:3478' }]);
                if (!isCurrent()) return;
                const viewed = await createSfuViewer({ mediaToken: message.mediaToken, video: directVideo, token, apiBase, iceServers, onDisconnect: requestFallback, isCurrent });
                if (!isCurrent()) { viewed.close(); return; }
                sfuViewer = viewed;
                document.querySelector('#status').textContent = `Assistindo ${message.name} pela Cloudflare SFU.`;
                return;
              } catch {
                requestFallback();
                return;
              }
            }
            canvas.style.display = 'block'; directVideo.style.display = 'none';
            player.configure({ codec: message.codec || 'avc1.64002a', width: message.width || 1920, height: message.height || 1080 });
            player.configureAudio(message.audioConfig);
            relayFallbackActive = true;
            socket.send(JSON.stringify({ type: 'watch', slot: message.slot }));
            socket.send(JSON.stringify({ type: 'rtc-want', slot: message.slot }));
            rtcSlot = message.slot;
            rtcTimer = setTimeout(() => { if (!rtcActive) stopRtc(); }, FALLBACK_MS);
            document.querySelector('#status').textContent = `Assistindo à transmissão de ${message.name} pelo relay.`;
          };
          item.onclick = openStream;
          item.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openStream(); } };
          details.append(identity); item.append(thumbnail, details); return item;
        }));
        if (focusedSlot !== undefined) [...container.querySelectorAll('.stream-card')].find((card) => card.dataset.slot === focusedSlot)?.focus({ preventScroll: true });
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data);
        if (roomUi.phase === 'error') return;
        if (message.type === 'room-ready') { roomUi.ready(); renderStreams(); return; }
        if (message.type === 'source-update' && availableStreams.has(message.slot)) {
          const stream = availableStreams.get(message.slot);
          Object.assign(stream, message, { type: 'start' });
          if (selectedSlot === message.slot) {
            if (relayFallbackActive && !rtcActive && message.relayMedia) {
              player.configure(message.relayMedia);
              player.configureAudio(message.relayMedia.audioConfig);
              socket.send(JSON.stringify({ type: 'watch', slot: message.slot }));
            }
            document.querySelector('#status').textContent = message.waiting ? 'A live continua. Aguardando o streamer compartilhar o monitor…' : 'Fonte atualizada. A transmissão continua.';
          }
          renderStreams();
          return;
        }
        if (message.type === 'start') {
          const newlyLive = roomUi.phase === 'ready' && !availableStreams.has(message.slot);
          if (newlyLive) {
            message.newUntil = Date.now() + 10_000;
            roomUi.announce(message.name || 'Um amigo', () => availableStreams.size);
            setTimeout(() => {
              const card = [...document.querySelectorAll('.stream-card')].find((item) => item.dataset.slot === String(message.slot));
              card?.classList.remove('new-live');
            }, 10_000);
          }
          availableStreams.set(message.slot, message);
          if (selectedSlot === message.slot && viewerUserId && message.userId === viewerUserId) setPlaybackMuted(true, true);
        }
        if (message.type === 'thumbnail' && availableStreams.has(message.slot)) {
          availableStreams.get(message.slot).thumbnail = message.data;
          const card = [...document.querySelectorAll('.stream-card')].find((item) => item.dataset.slot === String(message.slot));
          if (card) {
            const thumb = card.querySelector('.stream-thumb');
            let image = thumb.querySelector('img');
            if (!image) { thumb.querySelector('span:not(.live-badge)')?.remove(); image = document.createElement('img'); image.alt = `Prévia da transmissão de ${availableStreams.get(message.slot).name}`; thumb.prepend(image); }
            image.src = message.data;
          }
        }
        if (message.type === 'audience') {
          audiences.set(message.slot, message.viewers || []);
          if (selectedSlot === message.slot) watchAudience.update(message.viewers);
          const card = [...document.querySelectorAll('.stream-card')].find((item) => item.dataset.slot === String(message.slot));
          const count = card?.querySelector('[data-viewer-count]');
          if (count) count.textContent = `${(message.viewers || []).length} assistindo`;
        }
        if (message.type === 'fallback-ready' && selectedSlot === message.slot) {
          stopSfu();
          const stage = document.querySelector('.stage');
          stage.replaceChildren(canvas, directVideo);
          directVideo.style.display = 'none'; canvas.style.display = 'block';
          player.configure({ codec: message.codec || 'avc1.64002a', width: message.width || 1920, height: message.height || 1080 });
          player.configureAudio(message.audioConfig);
          relayFallbackActive = true;
          socket.send(JSON.stringify({ type: 'watch', slot: message.slot }));
          document.querySelector('#status').textContent = 'Assistindo pelo relay de compatibilidade.';
        }
        if (message.type === 'fallback-failed' && selectedSlot === message.slot) stopWatching('Não foi possível reproduzir esta transmissão.');
        if (message.type === 'stop') {
          availableStreams.delete(message.slot);
          audiences.delete(message.slot);
          if (playbackLocked && ![...availableStreams.values()].some((stream) => stream.userId === viewerUserId)) setPlaybackMuted(true, false);
          if (selectedSlot === message.slot) {
            feedback.hide();
            stopRtc(); stopSfu();
            selectedSlot = null;
            player.close();
            directVideo.removeAttribute('src'); directVideo.load();
            document.querySelector('.stage').innerHTML = '<span class="muted">Carregando transmissão…</span>';
            document.querySelector('#status').textContent = 'Transmissão encerrada.';
            showBrowseView();
          }
        }
        if (message.type === 'start' || message.type === 'stop') renderStreams();
      };
      socket.addEventListener('message', async (event) => {
        if (typeof event.data !== 'string') { if (relayFallbackActive && !rtcActive) player.push(event.data); return; }
        const message = JSON.parse(event.data);
        if (message.type !== 'rtc' || message.slot !== selectedSlot) return;
        try {
          if (!directPeer) {
            const outbound = [];
            let answerSent = false;
            directPeer = createPeer({ iceServers: await fetchIceServers(apiBase, token), onIce: (candidate) => { if (answerSent) socket.send(JSON.stringify({ type: 'rtc', slot: selectedSlot, candidate })); else outbound.push(candidate); }, onTrack: ({ streams }) => {
              if (!streams[0]) return;
              directVideo.srcObject = streams[0];
              const activate = () => {
                if (rtcActive || !directPeer) return;
                rtcActive = true; clearTimeout(rtcTimer);
                player.close(); canvas.style.display = 'none'; directVideo.style.display = 'block';
                socket.send(JSON.stringify({ type: 'rtc-active', slot: selectedSlot }));
                document.querySelector('#status').textContent = 'Conexão direta P2P ativa.';
              };
              directVideo.play().catch(() => {});
              if (typeof directVideo.requestVideoFrameCallback === 'function') directVideo.requestVideoFrameCallback(activate);
              else directVideo.addEventListener('loadeddata', activate, { once: true });
            }, onState: (state) => { if (['failed', 'closed', 'disconnected'].includes(state) && directPeer) stopRtc({ resumeRelay: true }); } });
            directPeer._sendAnswer = async () => {
              const answer = await directPeer.createAnswer(); await directPeer.setLocalDescription(answer);
              socket.send(JSON.stringify({ type: 'rtc', slot: selectedSlot, description: directPeer.localDescription }));
              answerSent = true;
              for (const candidate of outbound) socket.send(JSON.stringify({ type: 'rtc', slot: selectedSlot, candidate }));
            };
          }
          if (message.description) {
            await directPeer.setRemoteDescription(message.description);
            for (const candidate of directPending.splice(0)) await directPeer.addIceCandidate(candidate);
            await directPeer._sendAnswer();
          }
          if (message.candidate) {
            if (directPeer.remoteDescription) await directPeer.addIceCandidate(message.candidate);
            else directPending.push(message.candidate);
          }
        } catch { stopRtc(); }
      });
      socket.send(JSON.stringify({ type: 'hello' }));
    }).catch(() => { roomUi.fail(); });
}

function renderAccessMessage(title, message) {
  root.innerHTML = '<main class="shell capture-shell"><section class="card capture-card"><span class="eyebrow">BIG DUCKS · DISCORD ACTIVITY</span><h1></h1><p class="muted" role="status"></p></section></main>';
  root.querySelector('h1').textContent = title;
  root.querySelector('p').textContent = message;
}

async function boot() {
  if (mode === 'viewer') return renderViewer();
  if (mode !== 'capture') {
    renderAccessMessage('Abra pelo Discord', 'Entre no canal de voz do seu servidor e abra a Activity BIG DUCKS. As transmissões não são listadas neste endereço público.');
    return;
  }
  renderAccessMessage('Verificando seu convite…', 'A captura só será liberada após a validação do acesso.');
  try {
    let storage;
    try { storage = window.sessionStorage; } catch { /* use in-memory session only */ }
    const token = await captureSession({ url: new URL(location.href), storage, replaceUrl: (url) => history.replaceState(null, '', url) });
    renderCapture(token);
  } catch {
    renderAccessMessage('Convite ausente ou expirado', 'Abra a Activity no Discord e clique em Transmitir minha tela para gerar um novo link. Se acabou de abrir um convite, confira sua conexão e tente novamente pelo Discord.');
  }
}
void boot();
