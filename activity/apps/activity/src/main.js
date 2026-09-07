import { DiscordSDK } from '@discord/embedded-app-sdk';
import { profileFor } from '../../../shared/adaptation.js';
import { createPeer, fetchIceServers } from '../../../shared/rtc.js';
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
  root.innerHTML = `<div class="shell"><div class="card"><h1>Transmitir tela</h1><p class="muted">Escolha a fonte e a qualidade. A captura acontece somente no seu navegador.</p><div class="toolbar"><button class="primary" id="start">Escolher tela ou janela</button><label class="field">Qualidade<select id="quality"><option value="720p60">720p / 60 FPS</option><option value="1080p30">1080p / 30 FPS</option><option value="1080p60">1080p / 60 FPS</option><option value="adaptive">Adaptativo</option></select></label><label><input id="audio" type="checkbox"> áudio do sistema</label></div><div id="status" class="status"></div><div class="metrics"><span id="source">Fonte: —</span><span id="fps">FPS: —</span><span id="bitrate">Bitrate: —</span></div></div></div>`;
  document.querySelector('#start').onclick = async () => {
    const status = document.querySelector('#status');
    try {
      const quality = document.querySelector('#quality').value;
      const profile = profileFor(quality === 'adaptive' ? '720p60' : quality);
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
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      const peers = new Map();
      let broadcaster;
      socket.addEventListener('message', async (event) => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data);
        if (message.type === 'need-keyframe') { broadcaster?.requestKeyframe(); return; }
        if (message.type !== 'rtc-want') return;
        const peer = createPeer({ iceServers: await fetchIceServers(), onIce: (candidate) => socket.send(JSON.stringify({ type: 'rtc', viewer: message.viewer, candidate })), onState: (state) => { if (['failed', 'closed'].includes(state)) peers.delete(message.viewer); } });
        peers.set(message.viewer, peer);
        for (const track of stream.getTracks()) peer.addTrack(track, stream);
        const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
        socket.send(JSON.stringify({ type: 'rtc', viewer: message.viewer, description: peer.localDescription }));
      });
      broadcaster = await createBroadcaster({ ws: socket, profile, audio: document.querySelector('#audio').checked, stream, onStatus: ({ codec, width, height, fps }) => { socket.send(JSON.stringify({ type: 'start', slot: 0, codec, width, height, fps })); document.querySelector('#source').textContent = `Fonte: ${width}×${height}`; document.querySelector('#fps').textContent = `Codec: ${codec} / ${fps} FPS`; }, onEnd: () => { status.textContent = 'Captura encerrada.'; } });
      socket.addEventListener('message', async (event) => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data);
        if (message.type !== 'rtc') return;
        const peer = peers.get(message.viewer);
        if (peer && message.description) await peer.setRemoteDescription(message.description);
        if (peer && message.candidate) await peer.addIceCandidate(message.candidate);
      });
      status.textContent = 'Transmitindo. Mantenha esta página aberta.';
      window.addEventListener('beforeunload', () => { broadcaster.stop(); for (const peer of peers.values()) peer.close(); socket.close(); }, { once: true });
    } catch (error) { status.textContent = error?.name === 'NotAllowedError' ? 'Permissão de captura cancelada.' : 'Não foi possível iniciar a captura.'; }
  };
}

async function renderViewer() {
  root.innerHTML = `<div class="shell"><div class="card"><h1>BIG DUCKS Stream</h1><p class="muted">Transmissão ao vivo dentro do Discord, com fallback automático.</p><div id="status" class="status">Conectando à sala…</div><div class="toolbar"><button id="publish" class="primary">Transmitir minha tela</button><label class="field">Qualidade<select id="quality"><option>Adaptativo</option><option>720p / 60 FPS</option><option>1080p / 30 FPS</option><option>1080p / 60 FPS</option></select></label></div><section class="streams" id="streams"><div class="stream"><span>Nenhuma transmissão ativa</span></div></section><div class="stage"><span class="muted">Selecione uma transmissão para assistir</span></div></div></div>`;
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
  identityPromise.then((identity) => fetch(apiUrl('/api/session'), { method: 'POST', headers: { 'content-type': 'application/json', ...(identity.accessToken ? { authorization: `Bearer ${identity.accessToken}` } : {}) }, body: JSON.stringify({ room: identity.instance, user: identity.user, role: 'viewer' }) })).then((response) => {
    if (!response.ok) throw new Error('Discord session unavailable');
    return response.json();
  }).then(({ token }) => {
      const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}${apiUrl('/ws')}?token=${encodeURIComponent(token)}`);
      socket.binaryType = 'arraybuffer';
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data);
        if (message.type !== 'start') return;
        player.configure({ codec: message.codec || 'avc1.64002a', width: message.width || 1920, height: message.height || 1080 });
        const item = document.createElement('div'); item.className = 'stream'; item.innerHTML = `<span>Stream ao vivo · ${message.width}×${message.height} / ${message.fps} FPS</span><button>Assistir</button>`;
        item.querySelector('button').onclick = () => { socket.send(JSON.stringify({ type: 'watch', slot: message.slot })); document.querySelector('#status').textContent = 'Recebendo transmissão pelo relay/WebRTC…'; };
        document.querySelector('#streams').replaceChildren(item);
      };
      socket.addEventListener('message', async (event) => {
        if (typeof event.data !== 'string') { player.push(event.data); return; }
        const message = JSON.parse(event.data);
        if (message.type !== 'rtc') return;
        if (!directPeer) {
          directPeer = createPeer({ iceServers: await fetchIceServers(), onIce: (candidate) => socket.send(JSON.stringify({ type: 'rtc', candidate })), onTrack: ({ streams }) => { if (streams[0]) { directVideo.srcObject = streams[0]; directVideo.style.display = 'block'; canvas.style.display = 'none'; document.querySelector('#status').textContent = 'Conexão direta WebRTC ativa.'; } }, onState: (state) => { if (['failed', 'closed', 'disconnected'].includes(state)) { directVideo.style.display = 'none'; canvas.style.display = 'block'; document.querySelector('#status').textContent = 'WebRTC indisponível; usando relay.'; } } });
        }
        if (message.description) { await directPeer.setRemoteDescription(message.description); const answer = await directPeer.createAnswer(); await directPeer.setLocalDescription(answer); socket.send(JSON.stringify({ type: 'rtc', description: directPeer.localDescription })); }
        if (message.candidate) await directPeer.addIceCandidate(message.candidate);
      });
    }).catch((error) => { document.querySelector('#status').textContent = `Não foi possível conectar à sala: ${error.message}`; });
}

(captureMode ? renderCapture : renderViewer)();
