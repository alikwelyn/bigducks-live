import { afterEach, expect, it, vi } from 'vitest';
import { createUsageReporter } from './usage-meter.js';

afterEach(() => vi.useRealTimers());

it('reports only the increase since the previous sample', async () => {
  vi.useFakeTimers();
  const values = [1000, 1500, 1500, 4000];
  let index = 0;
  const send = vi.fn();
  const reporter = createUsageReporter({ send, sample: async () => values[Math.min(index++, values.length - 1)] });
  reporter.start();
  // The first sample establishes the baseline and is not reported, so the first
  // interval of a session is never counted.
  for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(30_000);
  expect(send.mock.calls.map(([bytes]) => bytes)).toEqual([500, 2500]);
  reporter.stop();
});

it('treats a counter that restarted as a reset instead of reporting it', async () => {
  vi.useFakeTimers();
  const values = [9000, 100];
  let index = 0;
  const send = vi.fn();
  const reporter = createUsageReporter({ send, sample: async () => values[Math.min(index++, values.length - 1)] });
  reporter.start();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(send).not.toHaveBeenCalled();
  reporter.stop();
});

it('survives a failing sample and stops cleanly', async () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const reporter = createUsageReporter({ send, sample: async () => { throw new Error('no stats'); } });
  reporter.start();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(send).not.toHaveBeenCalled();
  reporter.stop();
  expect(reporter.running).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(send).not.toHaveBeenCalled();
});
