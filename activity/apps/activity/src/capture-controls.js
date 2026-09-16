export const DEFAULT_AUDIO_TITLE = 'O áudio do sistema é autorizado no seletor do navegador ao iniciar a transmissão.';
export const LIVE_AUDIO_TITLE = 'O áudio foi definido ao iniciar. Para transmitir sem som, encerre a transmissão e inicie de novo com esta opção desmarcada.';

// The transmitted audio track is synthesised by the continuity module, so the
// checkbox cannot change a live stream. Disabling it prevents a streamer from
// believing they muted themselves when they did not.
export function applyCaptureControls({ start, stop, switch: switchButton, audio } = {}, { live = false, starting = false, switching = false } = {}) {
  if (start) { start.hidden = live; start.disabled = !live && starting; }
  if (stop) { stop.hidden = !live; stop.disabled = false; }
  if (switchButton) { switchButton.hidden = !live; switchButton.disabled = live && switching; }
  if (audio) { audio.disabled = live; audio.title = live ? LIVE_AUDIO_TITLE : DEFAULT_AUDIO_TITLE; }
}
