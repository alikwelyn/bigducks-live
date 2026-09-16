// Leaving srcObject null is not enough: a previously attached source attribute
// survives teardown and the last decoded frame can stay visible after "Voltar".
export function releasePlayback({ video, canvas } = {}) {
  if (video) {
    try { video.pause?.(); } catch { /* media element already detached */ }
    try { video.srcObject = null; } catch { /* media element already detached */ }
    try { video.removeAttribute?.('src'); } catch { /* attribute already removed */ }
    try { video.load?.(); } catch { /* media element already detached */ }
    if (video.style) video.style.display = 'none';
  }
  if (canvas?.style) canvas.style.display = 'block';
}
