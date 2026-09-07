import { DiscordSDK } from '@discord/embedded-app-sdk';
import { profileFor } from '../../../shared/adaptation.js';
import { createPeer, fetchIceServers } from '../../../shared/rtc.js';
import { createBroadcaster } from '../../../shared/media.js';
import { createPlayer } from './player.js';
import './styles.css';

const root = document.querySelector('#app');
const captureMode = new URLSearchParams(location.search).get('capture') === '1';

async function authenticateDiscord() {
  const config = await fetch('/api/config').then((response) => response.json());
  if (!config.clientId) return { accessToken: '', user: crypto.randomUUID(), instance: 'demo' };
  const sdk = new DiscordSDK(config.clientId);
  await sdk.ready();
  const { code } = await sdk.commands.authorize({ client_id: config.clientId, response_type: 'code', state: crypto.randomUUID(), prompt: 'none', scope: ['identify', 'applications.commands'] });
  const { access_token: accessToken } = await fetch('/api/discord/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }).then((response) => response.json());
  const auth = await sdk.commands.authenticate({ access_token: accessToken });
  return { accessToken, user: auth.user.id, instance: sdk.instanceId || 'activity' };
}

function renderCapture() {
  root.innerHTML = `<div class="shell"><div class="card"><h1>Transmitir tela</h1><p class="muted">Escolha a fonte e a qualidade. A captura acontece somente no seu navegador.</p><div class="toolbar"><button class="primary" id="start">Escolher tela ou janela</button><label class="field">Qualidade<select id="quality"><option value="720p60">720p / 60 FPS</option><option value="1080p30">1080p / 30 FPS</option><option value="1080p60">1080p / 60 FPS</option><option value="adaptive">Adaptativo</option></select></label><label><input id="audio" type="checkbox"> áudio do sistema</label></div><div id="status" class="status"></div><div class="metrics"><span id="source">Fonte: —</span><span id="fps">FPS: —</span><span id="bitrate">Bitrate: —</span></div></div></div>`;
  document.querySelector('#start').onclick = async () => {
    const status = document.querySelector('#status');
    try {
      const identity = await authenticateDiscord();
      const quality = document.querySelector('#quality').value;
      const profile = profileFor(quality === 'adaptive' ? '720p60' : quality);
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: profile.fps, max: profile.fps } }, audio: document.querySelector('#audio').checked });
      const params = new URLSearchParams(location.search);
      const sessionResponse = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json', ...(identity.accessToken ? { authorization: `Bearer ${identity.accessToken}` } : {}) }, body: JSON.stringify({ room: params.get('room') || identity.instance, user: identity.user, role: 'publisher' }) });
      if (!sessionResponse.ok) throw new Error('relay session unavailable');
      const { token } = await sessionResponse.json();
      const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
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
      socket.send(JSON.stringify({ type: 'start', slot: 0, codec: 'avc1.64002a', width: profile.width, height: profile.height, fps: profile.fps }));
      broadcaster = await createBroadcaster({ ws: socket, profile, audio: document.querySelector('#audio').checked, stream, onStatus: ({ codec, width, height, fps }) => { document.querySelector('#source').textContent = `Fonte: ${width}×${height}`; document.querySelector('#fps').textContent = `Codec: ${codec} / ${fps} FPS`; }, onEnd: () => { status.textContent = 'Captura encerrada.'; } });
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
  document.querySelector('#publish').onclick = () => { location.href = `${location.pathname}?capture=1`; };
  const canvas = document.createElement('canvas');
  document.querySelector('.stage').replaceChildren(canvas);
  const player = createPlayer(canvas);
  const directVideo = document.createElement('video');
  directVideo.autoplay = true; directVideo.playsInline = true; directVideo.controls = true; directVideo.style.display = 'none'; directVideo.style.width = '100%'; directVideo.style.height = '100%';
  document.querySelector('.stage').append(directVideo);
  let directPeer;
  const params = new URLSearchParams(location.search);
  if (params.get('room')) {
    authenticateDiscord().then((identity) => fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json', ...(identity.accessToken ? { authorization: `Bearer ${identity.accessToken}` } : {}) }, body: JSON.stringify({ room: params.get('room') || identity.instance, user: identity.user, role: 'viewer' }) })).then((response) => response.json()).then(({ token }) => {
      const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data);
        if (message.type !== 'start') return;
        player.configure({ codec: message.codec || 'avc1.64002a', width: message.width || 1920, height: message.height || 1080 });
        const item = document.createElement('div'); item.className = 'stream'; item.innerHTML = `<span>Stream ao vivo · ${message.width}×${message.height} / ${message.fps} FPS</span><button>Assistir</button>`;
        item.querySelector('button').onclick = () => { socket.send(JSON.stringify({ type: 'watch', slot: message.slot })); socket.send(JSON.stringify({ type: 'rtc-want', slot: message.slot })); document.querySelector('#status').textContent = 'Recebendo transmissão pelo relay/WebRTC…'; };
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
    }).catch(() => { document.querySelector('#status').textContent = 'Não foi possível conectar à sala.'; });
  } else {
    document.querySelector('#status').textContent = 'Sala pronta. Acesso privado pela call do Discord.';
  }
}

(captureMode ? renderCapture : renderViewer)();
