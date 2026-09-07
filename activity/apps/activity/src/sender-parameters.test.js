import { expect, it, vi } from 'vitest';
import { updateSender } from './sender-parameters.js';

it('serializes changes using fresh parameters and recovers after a rejected update', async () => {
  let parameters = { encodings: [{}] };
  let finish;
  const sender = { getParameters: vi.fn(() => structuredClone(parameters)), setParameters: vi.fn(async (value) => {
    if (!finish) await new Promise((resolve) => { finish = resolve; });
    parameters = value;
  }) };
  const first = updateSender(sender, (p) => { p.encodings[0].maxBitrate = 40_000; });
  const second = updateSender(sender, (p) => { p.encodings[0].maxFramerate = 1; });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(sender.getParameters).toHaveBeenCalledTimes(1);
  finish();
  await Promise.all([first, second]);
  expect(parameters.encodings[0]).toEqual({ maxBitrate: 40_000, maxFramerate: 1 });
  sender.setParameters.mockRejectedValueOnce(new Error('unsupported'));
  await expect(updateSender(sender, () => {})).rejects.toThrow('unsupported');
  await updateSender(sender, (p) => { p.encodings[0].maxFramerate = 30; });
  expect(parameters.encodings[0].maxFramerate).toBe(30);
});
