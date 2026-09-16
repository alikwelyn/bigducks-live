import { expect, it } from 'vitest';
import { connectionStats } from './connection-stats.js';

it('reports interval jitter buffer delay, not the misleading lifetime average', () => {
  const initial = connectionStats(new Map([['v', { id: 'v', type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 100, jitterBufferEmittedCount: 1000, totalDecodeTime: 5, framesDecoded: 1000 }]]));
  const sample = connectionStats(new Map([
    ['v', { id: 'v', type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 220, jitterBufferEmittedCount: 1002, totalDecodeTime: 5.04, framesDecoded: 1002, framesPerSecond: 1 }],
    ['a', { id: 'a', type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: 2, jitterBufferEmittedCount: 100 }],
    ['transport', { type: 'transport', selectedCandidatePairId: 'selected' }],
    ['selected', { type: 'candidate-pair', currentRoundTripTime: 0.042 }],
  ]), initial.previous);
  expect(initial.videoBufferMs).toBeNull();
  expect(sample.videoBufferMs).toBe(60_000);
  expect(sample.decodeMs).toBeCloseTo(20);
  expect(sample.rttMs).toBeCloseTo(42);
  expect(sample.videoFps).toBe(1);
  expect(sample.audioBufferMs).toBeNull();
});

it('does not invent latency when counters are absent, reset, or no frames were emitted', () => {
  const first = connectionStats(new Map([['v', { type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 100, jitterBufferEmittedCount: 100 }]]));
  for (const report of [{}, { jitterBufferDelay: 1, jitterBufferEmittedCount: 2 }, { jitterBufferDelay: 100, jitterBufferEmittedCount: 100 }]) {
    const sample = connectionStats(new Map([['v', { type: 'inbound-rtp', kind: 'video', ...report }]]), first.previous);
    expect(sample.videoBufferMs).toBeNull();
  }
  const snapshot = connectionStats(new Map([['v', { type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 1, jitterBufferEmittedCount: 1, address: 'private-address', token: 'secret' }]]));
  expect(JSON.stringify([...snapshot.previous])).not.toContain('secret');
  expect(JSON.stringify([...snapshot.previous])).not.toContain('private-address');
});
