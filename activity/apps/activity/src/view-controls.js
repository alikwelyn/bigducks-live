export function createViewControls(view, video) {
  const toolbar = view.querySelector('.watch-controls');
  const zoom = document.createElement('button'); zoom.className = 'player-action'; zoom.type = 'button';
  zoom.textContent = 'Ampliar legendas'; zoom.setAttribute('aria-pressed', 'false');
  zoom.title = 'Amplia a imagem mantendo a parte inferior visível; pode cortar as laterais.';
  const fullscreen = document.createElement('button'); fullscreen.className = 'player-action'; fullscreen.type = 'button'; fullscreen.textContent = 'Tela cheia';
  const notice = document.createElement('span'); notice.className = 'view-notice'; notice.setAttribute('role', 'status');
  toolbar.append(zoom, fullscreen, notice);
  let timer;
  let noticeTimer;
  let scale = 1;
  const stage = view.querySelector('.stage');
  let bounds = { width: 0, height: 0 };
  const positionZoom = () => {
    const canvas = stage.querySelector('canvas');
    const nativeVideo = video.style.display !== 'none' && video.videoWidth > 0;
    const width = (nativeVideo ? video.videoWidth : canvas?.width) || 16;
    const height = (nativeVideo ? video.videoHeight : canvas?.height) || 9;
    const fittedHeight = Math.min(bounds.height, bounds.width * height / width);
    view.style.setProperty('--zoom-origin', `${(bounds.height + fittedHeight) / 2}px`);
  };
  const observer = new ResizeObserver(([entry]) => { bounds = entry.contentRect; positionZoom(); });
  observer.observe(stage);
  video.addEventListener('resize', positionZoom);
  video.addEventListener('loadedmetadata', positionZoom);
  view.addEventListener('media-frame', positionZoom, true);
  const reveal = () => {
    clearTimeout(timer); view.classList.add('controls-visible');
    timer = setTimeout(() => {
      if (!view.contains(document.activeElement) && !view.querySelector('details[open]')) view.classList.remove('controls-visible');
    }, 2500);
  };
  zoom.onclick = () => {
    positionZoom();
    scale = scale === 1 ? 1.25 : scale === 1.25 ? 1.5 : 1;
    view.style.setProperty('--video-zoom', scale);
    view.classList.toggle('video-zoomed', scale > 1);
    zoom.textContent = scale === 1 ? 'Ampliar legendas' : `Zoom ${Math.round(scale * 100)}%`;
    zoom.setAttribute('aria-pressed', String(scale > 1));
    reveal();
  };
  fullscreen.onclick = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (view.requestFullscreen) await view.requestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else throw new Error('unsupported');
    } catch {
      notice.textContent = 'Use a tela cheia do Discord; no celular, gire a tela.';
      clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice.textContent = ''; }, 6000);
    }
    reveal();
  };
  document.addEventListener('fullscreenchange', () => { fullscreen.textContent = document.fullscreenElement ? 'Sair da tela cheia' : 'Tela cheia'; reveal(); });
  view.addEventListener('pointermove', reveal);
  view.addEventListener('pointerdown', reveal);
  view.addEventListener('focusin', reveal);
  view.addEventListener('focusout', reveal);
  return { reveal, reset() {
    scale = 1; view.style.setProperty('--video-zoom', 1); view.classList.remove('video-zoomed');
    zoom.textContent = 'Ampliar legendas'; zoom.setAttribute('aria-pressed', 'false'); notice.textContent = ''; reveal();
  } };
}
