import { expect, it } from 'vitest';
import { EdgeRoom } from './worker.js';
import { MAX_REPORTED_BYTES } from './usage.js';

function socket(member) {
  return { messages: [], deserializeAttachment: () => member, serializeAttachment: (value) => { member = value; }, send(value) { this.messages.push(typeof value === 'string' ? JSON.parse(value) : value); } };
}

it('keeps viewers and publication credentials when a window closes and the next source resumes', async () => {
  const publisher = socket({ role: 'publisher', slot: 0, user: 'owner' });
  const viewer = socket({ role: 'viewer', user: 'friend' });
  const room = new EdgeRoom({ getWebSockets: () => [publisher, viewer] });
  const send = (client, control) => room.webSocketMessage(client, JSON.stringify(control));
  await send(publisher, { type: 'start', transport: 'sfu', mediaToken: 'original', width: 1280, height: 720 });
  await send(viewer, { type: 'sfu-watch', slot: 0 });
  await send(publisher, { type: 'source-update', slot: 2, mediaToken: 'tampered', transport: 'relay', waiting: true, width: 1280, height: 720, fps: 1 });
  expect(viewer.messages.at(-1)).toMatchObject({ type: 'source-update', slot: 0, waiting: true });
  expect(viewer.deserializeAttachment().sfuSlot).toBe(0);
  await send(publisher, { type: 'source-update', waiting: false, width: 1920, height: 1080, fps: 30 });
  viewer.messages.length = 0;
  await send(viewer, { type: 'hello' });
  expect(viewer.messages[0]).toMatchObject({ type: 'start', transport: 'sfu', mediaToken: 'original', waiting: false, width: 1920 });
  await send(viewer, { type: 'source-update', width: 1 });
  expect(publisher.deserializeAttachment().stream.width).toBe(1920);
});

it('counts SFU demand across switching, unwatching, fallback and disconnect without subscribing to relay media', async () => {
  const first = socket({ role: 'publisher', slot: 0 });
  const second = socket({ role: 'publisher', slot: 1 });
  const a = socket({ role: 'viewer', user: 'a', watched: null });
  const b = socket({ role: 'viewer', user: 'b', watched: null });
  const room = new EdgeRoom({ getWebSockets: () => [first, second, a, b] });
  const control = (client, type, slot) => room.webSocketMessage(client, JSON.stringify({ type, slot }));
  await control(first, 'start', 0);
  expect(first.messages.findLast((message) => message.type === 'sfu-audience').count).toBe(0);
  await control(a, 'sfu-watch', 0);
  await control(b, 'sfu-watch', 0);
  expect(first.messages.findLast((message) => message.type === 'sfu-audience').count).toBe(2);
  expect(a.deserializeAttachment().watched).toBeNull();
  expect(first.messages.findLast((message) => message.type === 'audience').viewers.map((viewer) => viewer.id)).toEqual(['a', 'b']);
  await control(a, 'sfu-watch', 1);
  expect(first.messages.findLast((message) => message.type === 'sfu-audience').count).toBe(1);
  expect(second.messages.findLast((message) => message.type === 'sfu-audience').count).toBe(1);
  await control(a, 'unwatch', 0);
  expect(a.deserializeAttachment().sfuSlot).toBe(1);
  await control(a, 'unwatch', 1);
  expect(second.messages.findLast((message) => message.type === 'sfu-audience').count).toBe(0);
  await control(b, 'fallback-want', 0);
  expect(first.messages.findLast((message) => message.type === 'sfu-audience').count).toBe(0);
  expect(first.messages.findLast((message) => message.type === 'audience').viewers.map((viewer) => viewer.id)).toEqual(['b']);
  await control(b, 'sfu-watch', 0);
  await room.webSocketClose(b);
  expect(first.messages.findLast((message) => message.type === 'sfu-audience').count).toBe(0);
  await control(a, 'sfu-watch', 1);
  await control(second, 'stop', 1);
  expect(a.deserializeAttachment().audienceSlot).toBeNull();
  await control(second, 'start', 1);
  expect(second.messages.findLast((message) => message.type === 'sfu-audience').count).toBe(0);
  a.messages.length = 0;
  await control(a, 'hello');
  expect(a.messages.at(-1).type).toBe('room-ready');
  expect(a.messages.some((message) => message.type === 'start')).toBe(true);
});

it('confirms an empty room only after processing the viewer hello', async () => {
  const viewer = socket({ role: 'viewer', user: 'viewer' });
  const room = new EdgeRoom({ getWebSockets: () => [viewer] });
  expect(viewer.messages).toEqual([]);
  await room.webSocketMessage(viewer, JSON.stringify({ type: 'hello' }));
  expect(viewer.messages).toEqual([{ type: 'room-ready' }]);
});

it('reports the relay-only audience so an idle encoder can be stopped', async () => {
  const publisher = socket({ role: 'publisher', slot: 0 });
  const sfuViewer = socket({ role: 'viewer', user: 'sfu', watched: null });
  const relayViewer = socket({ role: 'viewer', user: 'relay', watched: null });
  const room = new EdgeRoom({ getWebSockets: () => [publisher, sfuViewer, relayViewer] });
  const control = (client, type, slot) => room.webSocketMessage(client, JSON.stringify({ type, slot }));
  const relayCount = () => publisher.messages.findLast((message) => message.type === 'relay-audience')?.count;
  const relayMessages = () => publisher.messages.filter((message) => message.type === 'relay-audience').length;
  await control(publisher, 'start', 0);
  expect(relayCount()).toBe(0);
  await control(sfuViewer, 'sfu-watch', 0);
  expect(relayCount()).toBe(0);
  await control(relayViewer, 'fallback-want', 0);
  expect(relayCount()).toBe(1);
  await control(relayViewer, 'sfu-watch', 0);
  expect(relayCount()).toBe(0);
  await control(relayViewer, 'fallback-want', 0);
  expect(relayCount()).toBe(1);
  await control(relayViewer, 'unwatch', 0);
  expect(relayCount()).toBe(0);
  publisher.messages.length = 0;
  await control(relayViewer, 'fallback-want', 0);
  expect(relayCount()).toBe(1);
  expect(relayMessages()).toBe(1);
  await control(publisher, 'stop', 0);
  expect(relayCount()).toBe(0);
  await room.webSocketClose(relayViewer);
  expect(relayCount()).toBe(0);
});

it('reports an informational monthly figure without ever blocking media', async () => {
  const stored = {};
  const publisher = socket({ role: 'publisher', slot: 0 });
  const viewer = socket({ role: 'viewer', user: 'friend', watched: null });
  const room = new EdgeRoom({ getWebSockets: () => [publisher, viewer], storage: { get: async (key) => stored[key], put: async (key, value) => { stored[key] = value; } } });
  const control = (client, payload) => room.webSocketMessage(client, JSON.stringify(payload));
  await control(publisher, { type: 'hello' });
  expect(publisher.messages.findLast((message) => message.type === 'usage')).toMatchObject({ gigabytes: 0 });
  await control(publisher, { type: 'start', slot: 0 });
  await control(viewer, { type: 'fallback-want', slot: 0 });
  const frame = new ArrayBuffer(1000);
  new Uint8Array(frame)[0] = 0;
  await room.webSocketMessage(publisher, frame);
  await control(viewer, { type: 'meter', bytes: 4_000_000 });
  // Same second: the report is rate-gated, so this second one is ignored.
  await control(viewer, { type: 'meter', bytes: 4_000_000 });
  await control(viewer, { type: 'meter', bytes: -5 });
  // The report is throttled, so ask again the way a reconnect would.
  publisher.messages.length = 0;
  await control(publisher, { type: 'hello' });
  const summary = publisher.messages.findLast((message) => message.type === 'usage');
  expect(summary).toMatchObject({ bytes: 4_001_000, gigabytes: expect.any(Number) });
  expect(viewer.messages.some((message) => message.type === 'usage')).toBe(false);
});

it('clamps an absurd self-report and shows a stored total before any media flows', async () => {
  const stored = { usage: { month: new Date().toISOString().slice(0, 7), relayBytes: 1_000_000_000, sfuBytes: 0, updatedAt: Date.now() } };
  const publisher = socket({ role: 'publisher', slot: 0 });
  const viewer = socket({ role: 'viewer', user: 'friend', watched: null });
  const room = new EdgeRoom({ getWebSockets: () => [publisher, viewer], storage: { get: async (key) => stored[key], put: async (key, value) => { stored[key] = value; } } });
  const control = (client, payload) => room.webSocketMessage(client, JSON.stringify(payload));
  // The owner checks the figure before starting: storage must be read eagerly.
  await control(publisher, { type: 'hello' });
  expect(publisher.messages.findLast((message) => message.type === 'usage')).toMatchObject({ bytes: 1_000_000_000, gigabytes: 1 });
  await control(viewer, { type: 'meter', bytes: MAX_REPORTED_BYTES * 10 });
  await control(publisher, { type: 'hello' });
  expect(publisher.messages.findLast((message) => message.type === 'usage').bytes).toBe(1_000_000_000 + MAX_REPORTED_BYTES);
});
