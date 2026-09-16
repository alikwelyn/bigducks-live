import { afterEach, expect, it, vi } from 'vitest';
import { createStallWatchdog } from './stall-watchdog.js';

afterEach(() => vi.useRealTimers());

function harness(values) {
  vi.useFakeTimers();
  let index = 0;
  const onStall = vi.fn();
  const watchdog = createStallWatchdog({ onStall, sample: async () => new Map([['video', values[Math.min(index++, values.length - 1)]]]) });
  return { watchdog, onStall };
}

it('recovers a connected-but-frozen stream once and reports progress again after', async () => {
  const { watchdog, onStall } = harness([1000, 1000, 1000, 1000, 5000, 5000, 5000, 5000]);
  watchdog.start();
  await vi.advanceTimersByTimeAsync(2000);
  expect(onStall).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(6000);
  expect(onStall).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(4000);
  expect(onStall).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10000);
  expect(onStall).toHaveBeenCalledTimes(2);
  watchdog.stop();
});

it('never triggers when counters keep advancing, and stops sampling when closed', async () => {
  const { watchdog, onStall } = harness([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  watchdog.start();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(onStall).not.toHaveBeenCalled();
  watchdog.stop();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(onStall).not.toHaveBeenCalled();
});

it('does not treat missing counters as a stall forever', async () => {
  vi.useFakeTimers();
  const onStall = vi.fn();
  const watchdog = createStallWatchdog({ onStall, sample: async () => new Map() });
  watchdog.start();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(onStall).not.toHaveBeenCalled();
  watchdog.stop();
});
