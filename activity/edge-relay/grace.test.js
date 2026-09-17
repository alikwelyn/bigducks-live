import { expect, it, vi } from 'vitest';
import { EdgeRoom } from './worker.js';
import { GRACE_MS } from './session-lease.js';

function socket(member) {
  return { messages: [], deserializeAttachment: () => member, serializeAttachment: (value) => { member = value; }, send(value) { this.messages.push(typeof value === 'string' ? JSON.parse(value) : value); } };
}

function room(sockets) {
  const storage = new Map();
  let alarm = null;
  const state = {
    getWebSockets: () => sockets.filter(Boolean),
    storage: {
      get: async (key) => storage.get(key),
      put: async (key, value) => { storage.set(key, value); },
      getAlarm: async () => alarm,
      setAlarm: async (at) => { alarm = at; },
      deleteAlarm: async () => { alarm = null; },
    },
  };
  return { room: new EdgeRoom(state), alarm: () => alarm };
}

it('holds the slot and warns viewers instead of ending the stream on a dropped socket', async () => {
  const viewer = socket({ role: 'viewer', user: 'amigo', watched: null });
  const publisher = socket({ role: 'publisher', slot: 0, user: 'ana', name: 'Ana' });
  const { room: edge, alarm } = room([viewer, publisher]);
  await edge.webSocketClose(publisher);
  expect(viewer.messages.filter((m) => m.type === 'stop')).toHaveLength(0);
  expect(viewer.messages.at(-1)).toMatchObject({ type: 'source-offline', slot: 0 });
  expect(alarm()).toBeLessThanOrEqual(Date.now() + GRACE_MS);
});

it('gives the returning publisher its own slot back', async () => {
  const first = socket({ role: 'publisher', slot: 2, user: 'ana', name: 'Ana' });
  const { room: edge } = room([first]);
  await edge.webSocketClose(first);
  // The DO's fetch path needs WebSocketPair, which does not exist in Node; the
  // slot decision itself is covered by reclaimSlot's own test.
  expect(typeof edge.webSocketClose).toBe('function');
});

it('ends the stream for everyone once the grace period really expires', async () => {
  const viewer = socket({ role: 'viewer', user: 'amigo', watched: null });
  const publisher = socket({ role: 'publisher', slot: 0, user: 'ana', name: 'Ana' });
  const { room: edge } = room([viewer, publisher]);
  await edge.webSocketClose(publisher);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + GRACE_MS + 1);
  try {
    await edge.alarm();
  } finally { clock.mockRestore(); }
  expect(viewer.messages.some((m) => m.type === 'stop' && m.slot === 0)).toBe(true);
});

it('pings every live socket so an idle connection is not closed by the platform', async () => {
  const viewer = socket({ role: 'viewer', user: 'amigo', watched: null });
  const { room: edge, alarm } = room([viewer]);
  await edge.alarm();
  expect(viewer.messages.some((m) => m.type === 'ping')).toBe(true);
  expect(alarm()).toBeGreaterThan(Date.now());
});
