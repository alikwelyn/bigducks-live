// One canonical teardown reset for the viewer stage, shared by every path that
// hides the native video element, so the element state and the canvas
// visibility cannot drift apart between branches.
//
// Teardown only: it always pauses and detaches. Do not call it while a native
// or SFU stream must keep rendering.
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
