import { afterEach, expect, it, vi } from 'vitest';
import { createConnectionPanel } from './connection-panel.js';
class Element extends EventTarget {
  children = []; open = false;
  constructor(tag = 'div') { super(); this.tag = tag; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute() {}
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('shows actual transport, samples only while open and ignores late results from another live', async () => {
  vi.useFakeTimers(); vi.stubGlobal('document', { createElement: (tag) => new Element(tag) });
  const container = new Element(); const reconnect = vi.fn();
  const panel = createConnectionPanel(container, reconnect);
  let resolveOld;
  const peer = { getStats: vi.fn(() => new Promise((resolve) => { resolveOld = resolve; })) };
  panel.set('Cloudflare SFU', peer);
  const [details, retry] = container.children;
  const [summary, report] = details.children;
  expect(summary.textContent).toContain('Cloudflare SFU');
  expect(peer.getStats).not.toHaveBeenCalled();
  details.open = true; details.dispatchEvent(new Event('toggle'));
  expect(peer.getStats).toHaveBeenCalledOnce();
  let resolveNew;
  const fresh = { getStats: vi.fn(() => new Promise((resolve) => { resolveNew = resolve; })) };
  panel.set('Relay WebSocket', fresh);
  resolveOld(new Map([['v', { type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 100, jitterBufferEmittedCount: 1 }]]));
  await Promise.resolve(); await Promise.resolve();
  expect(summary.textContent).toContain('Relay WebSocket');
  expect(report.textContent).not.toContain('Buffer de vídeo: 100');
  resolveNew(new Map([['v', { type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 200, jitterBufferEmittedCount: 1 }]]));
  await Promise.resolve(); await Promise.resolve();
  expect(report.textContent).toContain('Relay WebSocket');
  retry.onclick(); expect(reconnect).toHaveBeenCalledOnce();
  panel.clear();
  await vi.advanceTimersByTimeAsync(6000);
  expect(peer.getStats).toHaveBeenCalledOnce();
  expect(fresh.getStats).toHaveBeenCalledOnce();
  expect(retry.disabled).toBe(true);
});
