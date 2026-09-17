import { expect, it, vi } from 'vitest';
import { createReconnecter } from './relay-reconnect.js';

const immediate = { sleep: async () => {} };

it('backs off, then hands the new connection to the caller', async () => {
  const connect = vi.fn().mockRejectedValueOnce(new Error('nope')).mockRejectedValueOnce(new Error('nope')).mockResolvedValue('socket');
  const onOpen = vi.fn().mockResolvedValue();
  const onAttempt = vi.fn();
  const reconnecter = createReconnecter({ connect, onOpen, onAttempt, ...immediate });
  reconnecter.start();
  await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('socket'));
  expect(connect).toHaveBeenCalledTimes(3);
  expect(onAttempt.mock.calls.map(([, wait]) => wait)).toEqual([1000, 2000, 4000]);
  expect(reconnecter.running).toBe(false);
});

it('gives up after the last attempt instead of retrying forever', async () => {
  const connect = vi.fn().mockRejectedValue(new Error('offline'));
  const onGiveUp = vi.fn();
  const reconnecter = createReconnecter({ connect, onGiveUp, attempts: 3, ...immediate });
  reconnecter.start();
  await vi.waitFor(() => expect(onGiveUp).toHaveBeenCalledOnce());
  expect(connect).toHaveBeenCalledTimes(3);
});

it('stops immediately when the session ends, and never runs twice at once', () => {
  const connect = vi.fn().mockResolvedValue('socket');
  const onOpen = vi.fn().mockResolvedValue();
  const reconnecter = createReconnecter({ connect, onOpen, ...immediate });
  reconnecter.start();
  reconnecter.start();
  reconnecter.stop();
  expect(reconnecter.running).toBe(false);
  expect(reconnecter.delayFor(1)).toBe(1000);
  expect(reconnecter.delayFor(9)).toBe(15_000);
});
