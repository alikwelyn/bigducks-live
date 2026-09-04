import { profileFor } from '../../../shared/adaptation.js';
import { createBroadcaster } from '../../../shared/media.js';
import './styles.css';

const root = document.querySelector('#app');
const captureMode = new URLSearchParams(location.search).get('capture') === '1';

function renderCapture() {
  root.innerHTML = `<div class="shell"><div class="card"><h1>Transmitir tela</h1><p class="muted">Escolha a fonte e a qualidade. A captura acontece somente no seu navegador.</p><div class="toolbar"><button class="primary" id="start">Escolher tela ou janela</button><label class="field">Qualidade<select id="quality"><option value="720p60">720p / 60 FPS</option><option value="1080p30">1080p / 30 FPS</option><option value="1080p60">1080p / 60 FPS</option><option value="adaptive">Adaptativo</option></select></label><label><input id="audio" type="checkbox"> áudio do sistema</label></div><div id="status" class="status"></div><div class="metrics"><span id="source">Fonte: —</span><span id="fps">FPS: —</span><span id="bitrate">Bitrate: —</span></div></div></div>`;
  document.querySelector('#start').onclick = async () => {
    const status = document.querySelector('#status');
    try {
      const quality = document.querySelector('#quality').value;
      const profile = profileFor(quality === 'adaptive' ? '720p60' : quality);
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: profile.fps, max: profile.fps } }, audio: document.querySelector('#audio').checked });
      const params = new URLSearchParams(location.search);
      const sessionResponse = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: params.get('room') || 'demo', user: params.get('user') || crypto.randomUUID(), role: 'publisher' }) });
      if (!sessionResponse.ok) throw new Error('relay session unavailable');
      const { token } = await sessionResponse.json();
      const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      const broadcaster = await createBroadcaster({ ws: socket, profile, audio: document.querySelector('#audio').checked, stream, onStatus: ({ codec, width, height, fps }) => { document.querySelector('#source').textContent = `Fonte: ${width}×${height}`; document.querySelector('#fps').textContent = `Codec: ${codec} / ${fps} FPS`; }, onEnd: () => { status.textContent = 'Captura encerrada.'; } });
      status.textContent = 'Transmitindo. Mantenha esta página aberta.';
      window.addEventListener('beforeunload', () => { broadcaster.stop(); socket.close(); }, { once: true });
    } catch (error) { status.textContent = error?.name === 'NotAllowedError' ? 'Permissão de captura cancelada.' : 'Não foi possível iniciar a captura.'; }
  };
}

function renderViewer() {
  root.innerHTML = `<div class="shell"><div class="card"><h1>BIG DUCKS Stream</h1><p class="muted">Transmissão ao vivo dentro do Discord, com fallback automático.</p><div id="status" class="status">Conectando à sala…</div><div class="toolbar"><button id="publish" class="primary">Transmitir minha tela</button><label class="field">Qualidade<select id="quality"><option>Adaptativo</option><option>720p / 60 FPS</option><option>1080p / 30 FPS</option><option>1080p / 60 FPS</option></select></label></div><section class="streams" id="streams"><div class="stream"><span>Nenhuma transmissão ativa</span></div></section><div class="stage"><span class="muted">Selecione uma transmissão para assistir</span></div></div></div>`;
  document.querySelector('#publish').onclick = () => { location.href = `${location.pathname}?capture=1`; };
  document.querySelector('#status').textContent = 'Sala pronta. Acesso privado pela call do Discord.';
}

(captureMode ? renderCapture : renderViewer)();
