import '../../../shared/rtc.js';
import '../../../shared/adaptation.js';
import './styles.css';

const root = document.querySelector('#app');
const captureMode = new URLSearchParams(location.search).get('capture') === '1';

function renderCapture() {
  root.innerHTML = `<div class="shell"><div class="card"><h1>Transmitir tela</h1><p class="muted">Escolha a fonte e a qualidade. A captura acontece somente no seu navegador.</p><div class="toolbar"><button class="primary" id="start">Escolher tela ou janela</button><label class="field">Qualidade<select id="quality"><option value="720p60">720p / 60 FPS</option><option value="1080p30">1080p / 30 FPS</option><option value="1080p60">1080p / 60 FPS</option><option value="adaptive">Adaptativo</option></select></label><label><input id="audio" type="checkbox"> áudio do sistema</label></div><div id="status" class="status"></div><div class="metrics"><span id="source">Fonte: —</span><span id="fps">FPS: —</span><span id="bitrate">Bitrate: —</span></div></div></div>`;
  document.querySelector('#start').onclick = async () => {
    const status = document.querySelector('#status');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60, max: 60 } }, audio: document.querySelector('#audio').checked });
      const settings = stream.getVideoTracks()[0]?.getSettings() ?? {};
      document.querySelector('#source').textContent = `Fonte: ${settings.displaySurface ?? 'selecionada'}`;
      document.querySelector('#fps').textContent = `FPS alvo: ${document.querySelector('#quality').value}`;
      status.textContent = 'Captura pronta. Conecte esta página ao relay para iniciar a transmissão.';
      stream.getVideoTracks()[0]?.addEventListener('ended', () => { status.textContent = 'Captura encerrada.'; });
    } catch (error) { status.textContent = error?.name === 'NotAllowedError' ? 'Permissão de captura cancelada.' : 'Não foi possível iniciar a captura.'; }
  };
}

function renderViewer() {
  root.innerHTML = `<div class="shell"><div class="card"><h1>BIG DUCKS Stream</h1><p class="muted">Transmissão ao vivo dentro do Discord, com fallback automático.</p><div id="status" class="status">Conectando à sala…</div><div class="toolbar"><button id="publish" class="primary">Transmitir minha tela</button><label class="field">Qualidade<select id="quality"><option>Adaptativo</option><option>720p / 60 FPS</option><option>1080p / 30 FPS</option><option>1080p / 60 FPS</option></select></label></div><section class="streams" id="streams"><div class="stream"><span>Nenhuma transmissão ativa</span></div></section><div class="stage"><span class="muted">Selecione uma transmissão para assistir</span></div></div></div>`;
  document.querySelector('#publish').onclick = () => { location.href = `${location.pathname}?capture=1`; };
  document.querySelector('#status').textContent = 'Sala pronta. Acesso privado pela call do Discord.';
}

(captureMode ? renderCapture : renderViewer)();
