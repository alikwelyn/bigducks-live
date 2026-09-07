export function createPlaybackFeedback(container, video, canvas, retry) {
  const panel = document.createElement('div');
  panel.className = 'playback-feedback'; panel.hidden = true;
  const image = document.createElement('img'); image.className = 'loading-thumbnail'; image.alt = '';
  const content = document.createElement('div'); content.className = 'loading-content';
  const spinner = document.createElement('span'); spinner.className = 'loading-spinner'; spinner.ariaHidden = 'true';
  const label = document.createElement('p'); label.setAttribute('role', 'status'); label.setAttribute('aria-live', 'polite');
  const button = document.createElement('button'); button.textContent = 'Tentar novamente'; button.onclick = retry;
  content.append(spinner, label, button); panel.append(image, content); container.append(panel);
  let timeout; let frame;
  const clear = () => { clearTimeout(timeout); if (frame != null) video.cancelVideoFrameCallback?.(frame); frame = null; };
  const ready = () => { clear(); panel.hidden = true; };
  const show = (text, thumbnail) => {
    clear(); panel.hidden = false; label.textContent = text; button.hidden = true; spinner.hidden = false;
    image.hidden = !thumbnail; if (thumbnail) image.src = thumbnail;
    timeout = setTimeout(() => { label.textContent = 'A transmissão está demorando a responder.'; button.hidden = false; spinner.hidden = true; }, 15000);
  };
  const playing = () => {
    if (video.requestVideoFrameCallback) frame = video.requestVideoFrameCallback(ready);
    else if (video.readyState >= 2) ready();
  };
  video.addEventListener('playing', playing);
  video.addEventListener('waiting', () => { if (!container.hidden) show('Reconectando à transmissão…'); });
  canvas.addEventListener('media-frame', ready);
  return { show, ready, hide() { clear(); panel.hidden = true; } };
}
