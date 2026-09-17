import { connectionStats } from './connection-stats.js';
import { codeLabel } from './diagnostic-code.js';

const SAMPLE_MS = 5000;
const LABELS = { videoBufferMs: 'Buffer de vídeo', audioBufferMs: 'Buffer de áudio', decodeMs: 'Decodificação/quadro', rttMs: 'Ida e volta', videoFps: 'Quadros por segundo' };

function format(key, value) {
  if (value === null || value === undefined) return '—';
  if (key === 'videoFps') return `${value.toFixed(1)} fps`;
  return `${Math.round(value)} ms`;
}

// Reports only aggregated counters; never surfaces addresses, SDP or identities.
export function createConnectionPanel(container, reconnect) {
  const details = document.createElement('details'); details.className = 'connection-panel';
  const summary = document.createElement('summary');
  const report = document.createElement('div'); report.className = 'connection-report'; report.setAttribute('role', 'status');
  const retry = document.createElement('button'); retry.className = 'player-action'; retry.type = 'button';
  retry.textContent = 'Reconectar agora'; retry.disabled = true; retry.onclick = () => reconnect();
  details.append(summary, report); container.append(details, retry);
  let transport = 'Aguardando';
  let peer = null;
  let timer;
  let active = 0;
  let previous = new Map();
  const paint = (label, stats) => {
    if (!stats) { report.textContent = 'Aguardando a primeira medição…'; return; }
    const parts = Object.entries(LABELS).map(([key, name]) => `${name}: ${format(key, stats[key])}`);
    report.textContent = `${label} · ${parts.join(' · ')}`;
  };
  const stopTimer = () => { clearTimeout(timer); timer = undefined; };
  const sample = async () => {
    const token = active;
    let stats = null;
    try {
      const reports = await peer.getStats();
      if (token === active) { stats = connectionStats(reports, previous); previous = stats.previous; }
    } catch { stats = null; }
    if (token !== active) return;
    if (stats) paint(transport, stats);
    schedule();
  };
  const schedule = () => { stopTimer(); if (details.open && peer) timer = setTimeout(sample, SAMPLE_MS); };
  details.addEventListener('toggle', () => { if (details.open) void sample(); else stopTimer(); });
  const clear = () => {
    active += 1; stopTimer(); peer = null; previous = new Map();
    transport = 'Aguardando'; summary.textContent = 'Conexão'; report.textContent = ''; retry.disabled = true;
  };
  const set = (label, connection, code) => {
    active += 1; stopTimer(); previous = new Map(); transport = label; peer = connection || null;
    const suffix = codeLabel(code);
    summary.textContent = suffix ? `Conexão: ${label} · ${suffix}` : `Conexão: ${label}`;
    report.textContent = ''; retry.disabled = false;
    if (details.open && peer) void sample();
  };
  clear();
  return { element: details, set, clear };
}
