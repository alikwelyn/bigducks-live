import { expect, it } from 'vitest';
import { EdgeRoom } from './worker.js';

function socket(member) {
  return { messages: [], deserializeAttachment: () => member, serializeAttachment: (value) => { member = value; }, send(value) { this.messages.push(JSON.parse(value)); } };
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
