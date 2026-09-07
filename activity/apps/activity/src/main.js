import { DiscordSDK } from '@discord/embedded-app-sdk';
import { profileFor } from '../../../shared/adaptation.js';
import { createPeer, FALLBACK_MS, fetchIceServers, tuneSenders } from '../../../shared/rtc.js';
import { createBroadcaster } from '../../../shared/media.js';
import { createPlayer } from './player.js';
import './styles.css';

const root = document.querySelector('#app');
const pageParams = new URLSearchParams(location.search);
const inDiscord = pageParams.has('frame_id');
const apiBase = inDiscord ? '/.proxy' : '';
const apiUrl = (path) => `${apiBase}${path}`;
const captureMode = pageParams.get('capture') === '1';

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

function renderCapture() {
  root.innerHTML = `<div class="shell"><div class="card"><h1>Transmitir tela</h1><p class="muted">Configure a transmissão e mantenha esta aba aberta.</p><div class="toolbar"><button class="primary" id="start">Escolher tela ou janela</button><button class="danger" id="stop" hidden>Parar transmissão</button><label class="field">Qualidade<select id="quality"><option value="720p30">720p / 30 FPS (recomendado)</option><option value="720p60">720p / 60 FPS</option><option value="1080p30">1080p / 30 FPS</option><option value="1080p60">1080p / 60 FPS</option><option value="adaptive">Adaptativo</option></select></label><label><input id="audio" type="checkbox"> áudio do sistema</label></div><div id="status" class="status">Pronto para transmitir.</div><div class="metrics"><span id="source">Fonte: —</span><span id="fps">FPS: —</span><span id="bitrate">Bitrate: —</span></div><video id="preview" class="preview" autoplay muted playsinline hidden></video></div></div>`;
  document.querySelector('#start').onclick = async () => {
    const status = document.querySelector('#status');
    try {
      const quality = document.querySelector('#quality').value;
      const profile = profileFor(quality === 'adaptive' ? '720p30' : quality);
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: profile.width, max: profile.width }, height: { ideal: profile.height, max: profile.height }, frameRate: { ideal: profile.fps, max: profile.fps } }, audio: document.querySelector('#audio').checked });
      const params = new URLSearchParams(location.search);
      let token = params.get('t');
      if (!token) {
        const identity = await authenticateDiscord();
        const sessionResponse = await fetch(apiUrl('/api/session'), { method: 'POST', headers: { 'content-type': 'application/json', ...(identity.accessToken ? { authorization: `Bearer ${identity.accessToken}` } : {}) }, body: JSON.stringify({ room: params.get('room') || identity.instance, user: identity.user, role: 'publisher' }) });
        if (!sessionResponse.ok) throw new Error('relay session unavailable');
        ({ token } = await sessionResponse.json());
      }
      const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}${apiUrl('/ws')}?token=${encodeURIComponent(token)}`);
      socket.binaryType = 'arraybuffer';
      const joined = new Promise((resolve) => socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data);
        if (message.type === 'joined') resolve(message);
      }));
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      const { slot } = await joined;
      const peers = new Map();
      let broadcaster;
      let stopped = false;
      const stopBroadcast = (message = 'Transmissão encerrada.') => {
        if (stopped) return;
        stopped = true;
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop', slot }));
        broadcaster?.stop();
        for (const { peer } of peers.values()) peer.close();
        socket.close();
        stream.getTracks().forEach((track) => track.stop());
        const preview = document.querySelector('#preview'); preview.srcObject = null; preview.hidden = true;
        document.querySelector('#start').hidden = false; document.querySelector('#stop').hidden = true;
        status.textContent = message;
      };
      socket.addEventListener('message', async (event) => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data);
        if (message.type === 'need-keyframe') { broadcaster?.requestKeyframe(); return; }
        if (message.type !== 'rtc-want') return;
        peers.get(message.viewer)?.peer.close();
        const outbound = [];
        let offerSent = false;
        const peer = createPeer({ iceServers: await fetchIceServers(), onIce: (candidate) => { if (offerSent) socket.send(JSON.stringify({ type: 'rtc', viewer: message.viewer, slot, candidate })); else outbound.push(candidate); }, onState: (state) => { if (['failed', 'closed', 'disconnected'].includes(state)) { peer.close(); peers.delete(message.viewer); } } });
        const entry = { peer, pendingCandidates: [] };
        peers.set(message.viewer, entry);
        for (const track of stream.getTracks()) peer.addTrack(track, stream);
        await tuneSenders(peer, { bitrate: profile.bitrate, fps: profile.fps });
        const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
        socket.send(JSON.stringify({ type: 'rtc', viewer: message.viewer, slot, description: peer.localDescription }));
        offerSent = true;
        for (const candidate of outbound) socket.send(JSON.stringify({ type: 'rtc', viewer: message.viewer, slot, candidate }));
      });
      broadcaster = await createBroadcaster({ ws: socket, profile, audio: document.querySelector('#audio').checked, stream, slot, onStatus: ({ codec, width, height, fps }) => { socket.send(JSON.stringify({ type: 'start', slot, codec, width, height, fps })); document.querySelector('#source').textContent = `Fonte: ${width}×${height}`; document.querySelector('#fps').textContent = `Codec: ${codec} / ${fps} FPS`; document.querySelector('#bitrate').textContent = `Bitrate alvo: ${(profile.bitrate / 1_000_000).toFixed(1)} Mbps`; }, onEnd: () => stopBroadcast('Captura encerrada.') });
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
      document.querySelector('#start').hidden = true; document.querySelector('#stop').hidden = false;
      document.querySelector('#stop').onclick = () => stopBroadcast();
      status.textContent = 'Transmitindo. Mantenha esta página aberta.';
      window.addEventListener('beforeunload', () => stopBroadcast(), { once: true });
    } catch (error) { status.textContent = error?.name === 'NotAllowedError' ? 'Permissão de captura cancelada.' : 'Não foi possível iniciar a captura.'; }
  };
}

async function renderViewer() {
  root.innerHTML = `<div class="shell"><div class="card"><div class="toolbar compact"><button id="publish" class="primary">Transmitir minha tela</button><span id="status" class="status">Conectando à sala…</span></div><section class="streams" id="streams"><div class="stream"><span>Nenhuma transmissão ativa</span></div></section><div class="stage"><span class="muted">Selecione uma transmissão para assistir</span></div></div></div>`;
  const identityPromise = authenticateDiscord();
  document.querySelector('#publish').onclick = async () => {
    try {
      const identity = await identityPromise;
      const response = await fetch(apiUrl('/api/session'), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${identity.accessToken}` }, body: JSON.stringify({ room: identity.instance, user: identity.user, role: 'publisher' }) });
      if (!response.ok) throw new Error('Não foi possível criar a transmissão');
      const { token } = await response.json();
      const url = `${identity.publicOrigin}/share?capture=1&external=1&t=${encodeURIComponent(token)}`;
      const result = await identity.sdk?.commands.openExternalLink({ url });
      if (!identity.sdk) window.open(url, '_blank', 'noopener');
      if (result?.opened === false) throw new Error('Abertura recusada');
      document.querySelector('#status').textContent = 'A página de transmissão foi aberta no navegador.';
    } catch (error) {
      document.querySelector('#status').textContent = `Não foi possível abrir o navegador: ${error.message}`;
    }
  };
  const canvas = document.createElement('canvas');
  document.querySelector('.stage').replaceChildren(canvas);
  const player = createPlayer(canvas);
  const directVideo = document.createElement('video');
  directVideo.autoplay = true; directVideo.playsInline = true; directVideo.controls = true; directVideo.style.display = 'none'; directVideo.style.width = '100%'; directVideo.style.height = '100%';
  document.querySelector('.stage').append(directVideo);
  let directPeer;
  let directPending = [];
  let rtcSlot = null;
  let rtcActive = false;
  let rtcTimer;
  identityPromise.then((identity) => fetch(apiUrl('/api/session'), { method: 'POST', headers: { 'content-type': 'application/json', ...(identity.accessToken ? { authorization: `Bearer ${identity.accessToken}` } : {}) }, body: JSON.stringify({ room: identity.instance, user: identity.user, role: 'viewer' }) })).then((response) => {
    if (!response.ok) throw new Error('Discord session unavailable');
    return response.json();
  }).then(({ token }) => {
      const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}${apiUrl('/ws')}?token=${encodeURIComponent(token)}`);
      socket.binaryType = 'arraybuffer';
      const availableStreams = new Map();
      let selectedSlot = null;
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
      const renderStreams = () => {
        const container = document.querySelector('#streams');
        if (!availableStreams.size) { container.innerHTML = '<div class="stream"><span>Nenhuma transmissão ativa</span></div>'; return; }
        container.replaceChildren(...[...availableStreams.values()].map((message) => {
          const item = document.createElement('div'); item.className = 'stream';
          const label = document.createElement('span'); label.textContent = `${message.name} · ${message.width}×${message.height} / ${message.fps} FPS`;
          const button = document.createElement('button'); button.textContent = selectedSlot === message.slot ? 'Assistindo' : 'Assistir';
          button.onclick = () => {
            if (selectedSlot !== null && selectedSlot !== message.slot) socket.send(JSON.stringify({ type: 'unwatch', slot: selectedSlot }));
            stopRtc();
            selectedSlot = message.slot;
            const stage = document.querySelector('.stage');
            stage.replaceChildren(canvas, directVideo);
            canvas.style.display = 'block'; directVideo.style.display = 'none';
            player.configure({ codec: message.codec || 'avc1.64002a', width: message.width || 1920, height: message.height || 1080 });
            socket.send(JSON.stringify({ type: 'watch', slot: message.slot }));
            socket.send(JSON.stringify({ type: 'rtc-want', slot: message.slot }));
            rtcSlot = message.slot;
            rtcTimer = setTimeout(() => { if (!rtcActive) stopRtc(); }, FALLBACK_MS);
            document.querySelector('#status').textContent = `Assistindo ${message.name} pelo relay enquanto o P2P conecta…`;
            renderStreams();
          };
          item.append(label, button); return item;
        }));
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data);
        if (message.type === 'start') availableStreams.set(message.slot, message);
        if (message.type === 'stop') {
          availableStreams.delete(message.slot);
          if (selectedSlot === message.slot) {
            stopRtc();
            selectedSlot = null;
            player.close();
            directVideo.removeAttribute('src'); directVideo.load();
            document.querySelector('.stage').innerHTML = '<span class="muted">Selecione uma transmissão para assistir</span>';
            document.querySelector('#status').textContent = 'Transmissão encerrada.';
          }
        }
        if (message.type === 'start' || message.type === 'stop') renderStreams();
      };
      socket.addEventListener('message', async (event) => {
        if (typeof event.data !== 'string') { if (!rtcActive) player.push(event.data); return; }
        const message = JSON.parse(event.data);
        if (message.type !== 'rtc' || message.slot !== selectedSlot) return;
        try {
          if (!directPeer) {
            const outbound = [];
            let answerSent = false;
            directPeer = createPeer({ iceServers: await fetchIceServers(apiBase), onIce: (candidate) => { if (answerSent) socket.send(JSON.stringify({ type: 'rtc', slot: selectedSlot, candidate })); else outbound.push(candidate); }, onTrack: ({ streams }) => {
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
    }).catch((error) => { document.querySelector('#status').textContent = `Não foi possível conectar à sala: ${error.message}`; });
}

(captureMode ? renderCapture : renderViewer)();
