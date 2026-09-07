import { afterEach, expect, it, vi } from 'vitest';
import { monitorQuality, nextQuality } from './automatic-quality.js';
afterEach(() => vi.useRealTimers());
it('reduces on congestion and recovers only after sustained healthy samples', () => {
  let state = { level: 2, healthy: 0 };
  state = nextQuality(state, true);
  expect(state.level).toBe(1);
  for (let i = 0; i < 5; i++) state = nextQuality(state, false);
  expect(state.level).toBe(1);
  expect(nextQuality(state, false).level).toBe(2);
});
it('applies sender limits and stops polling after close', async () => {
  vi.useFakeTimers();
  const sender = { track: { kind: 'video', getSettings: () => ({ width: 2560, height: 1440 }) }, getParameters: () => ({ encodings: [{}] }), setParameters: vi.fn().mockResolvedValue() };
  const peer = { getSenders: () => [sender], getStats: vi.fn().mockResolvedValue(new Map([['video', { type: 'outbound-rtp', kind: 'video', qualityLimitationReason: 'bandwidth' }]])) };
  const stop = monitorQuality(peer, { width: 1280, height: 720, bitrate: 2500000, fps: 30 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(sender.setParameters).toHaveBeenCalledWith({ encodings: [{ scaleResolutionDownBy: 3, maxBitrate: 1500000, maxFramerate: 25 }] });
  stop();
  await vi.advanceTimersByTimeAsync(10000);
  expect(peer.getStats).toHaveBeenCalledOnce();
});
it('never exceeds the economical ceiling or minimum', () => {
  expect(nextQuality({ level: 2, healthy: 6 }, false).level).toBe(2);
  expect(nextQuality({ level: 0, healthy: 0 }, true).level).toBe(0);
});
