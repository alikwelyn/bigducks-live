import { expect, it, vi } from 'vitest';
import { rosterNames, rosterText, watchRoster } from './channel-roster.js';

it('prefers the nickname, then the display name, then the handle', () => {
  expect(rosterNames([
    { nick: 'Ana', user: { global_name: 'Ana Global', username: 'ana' } },
    { user: { global_name: 'Bruno', username: 'bruno' } },
    { user: { username: 'carla' } },
    { user: { id: '42' } },
    { user: {} },
    null,
  ])).toEqual(['Ana', 'Bruno', 'carla', '42']);
});

it('summarises the channel and caps a long list', () => {
  expect(rosterText([])).toBe('');
  expect(rosterText(null)).toBe('');
  expect(rosterText([{ nick: 'Ana' }, { nick: 'Bruno' }])).toBe('No canal (2): Ana, Bruno');
  const many = Array.from({ length: 9 }, (_, index) => ({ nick: `P${index}` }));
  expect(rosterText(many, 6)).toBe('No canal (9): P0, P1, P2, P3, P4, P5 +3');
});

it('reads the roster once, refreshes on voice updates and can be stopped', async () => {
  const handlers = new Map();
  const sdk = {
    channelId: 'canal-1',
    commands: { getChannel: vi.fn().mockResolvedValue({ voice_states: [{ nick: 'Ana' }] }) },
    subscribe: vi.fn(async (event, handler) => { handlers.set(event, handler); }),
    unsubscribe: vi.fn(async () => {}),
  };
  const onChange = vi.fn();
  const stop = await watchRoster({ sdk, onChange });
  expect(onChange).toHaveBeenCalledWith('No canal (1): Ana', expect.any(Array));
  handlers.get('VOICE_STATE_UPDATE')();
  await vi.waitFor(() => expect(sdk.commands.getChannel).toHaveBeenCalledTimes(2));
  stop();
  expect(sdk.unsubscribe).toHaveBeenCalledWith('VOICE_STATE_UPDATE', expect.any(Function));
});

it('stays out of the way when there is no channel or no SDK support', async () => {
  expect(typeof await watchRoster({ sdk: { channelId: null, commands: {} } })).toBe('function');
  const sdk = { channelId: 'c', commands: {}, subscribe: vi.fn() };
  const onChange = vi.fn();
  const stop = await watchRoster({ sdk, onChange });
  expect(onChange).not.toHaveBeenCalled();
  stop();
});
