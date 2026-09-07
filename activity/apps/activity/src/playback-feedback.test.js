import { afterEach, expect, it, vi } from 'vitest';
import { createPlaybackFeedback } from './playback-feedback.js';
class Element extends EventTarget {
  children = [];
  append(...nodes) { this.children.push(...nodes); }
  setAttribute() {}
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('keeps loading until a frame arrives and exposes retry after timeout', () => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { createElement: () => new Element() });
  const container = new Element(), video = new Element(), canvas = new Element();
  let frame;
  video.requestVideoFrameCallback = (fn) => { frame = fn; return 1; };
  video.cancelVideoFrameCallback = vi.fn();
  const retry = vi.fn();
  const feedback = createPlaybackFeedback(container, video, canvas, retry);
  const panel = container.children[0];
  feedback.show('Conectando', 'thumbnail');
  video.dispatchEvent(new Event('playing'));
  expect(panel.hidden).toBe(false);
  frame();
  expect(panel.hidden).toBe(true);
  feedback.show('Reconectando');
  vi.advanceTimersByTime(15000);
  const button = panel.children[1].children[2];
  expect(button.hidden).toBe(false);
  button.onclick(); expect(retry).toHaveBeenCalledOnce();
  canvas.dispatchEvent(new Event('media-frame'));
  expect(panel.hidden).toBe(true);
  feedback.hide();
});
