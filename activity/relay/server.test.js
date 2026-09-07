import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createRelayServer } from './server.js';

const secret = 'test-secret-012345678901234567890123';
const servers = [];

afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

async function start(options = {}) {
  const server = createRelayServer({ secret, allowDevSessions: true, ...options });
  await server.listen(0);
  servers.push(server);
  return server;
}

describe('relay server', () => {
  it('provides health and session tokens', async () => {
    const server = await start();
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: 'a', user: 'u', role: 'viewer' }) });
    expect(response.status).toBe(200);
    const { token } = await response.json();
    expect(token).toEqual(expect.any(String));
    expect((await fetch(`${base}/api/ice`)).status).toBe(401);
    const iceResponse = await fetch(`${base}/api/ice?token=${encodeURIComponent(token)}`);
    expect(iceResponse.status).toBe(200);
    expect(await iceResponse.json()).toEqual({ iceServers: [] });
  });

  it('proxies authenticated SFU operations without exposing credentials', async () => {
    const sfuFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 's-pub' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tracks: [{ mid: '0', trackName: 'screen' }], sessionDescription: { type: 'answer', sdp: 'answer' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 's-view' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tracks: [{ mid: '0', trackName: 'screen' }], requiresImmediateRenegotiation: true, sessionDescription: { type: 'offer', sdp: 'offer' } }), { status: 200 }));
    const server = await start({ sfuAppId: 'app', sfuAppSecret: 'private-secret', sfuFetch });
    const base = `http://127.0.0.1:${server.port}`;
    const sessionToken = async (role, user) => (await (await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: 'a', user, role }) })).json()).token;
    const publisherToken = await sessionToken('publisher', 'pub');
    expect((await fetch(`${base}/api/sfu/session`, { method: 'POST' })).status).toBe(401);
    const publisherSession = await (await fetch(`${base}/api/sfu/session`, { method: 'POST', headers: { authorization: `Bearer ${publisherToken}` } })).json();
    const published = await (await fetch(`${base}/api/sfu/publish`, { method: 'POST', headers: { authorization: `Bearer ${publisherToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: publisherSession.sessionId, sessionDescription: { type: 'offer', sdp: 'offer' }, tracks: [{ mid: '0', trackName: 'screen', kind: 'video' }] }) })).json();
    expect(published.mediaToken).toEqual(expect.any(String));
    expect(JSON.stringify(published)).not.toContain('private-secret');
    const viewerToken = await sessionToken('viewer', 'view');
    const viewerSession = await (await fetch(`${base}/api/sfu/session`, { method: 'POST', headers: { authorization: `Bearer ${viewerToken}` } })).json();
    const subscribed = await (await fetch(`${base}/api/sfu/subscribe`, { method: 'POST', headers: { authorization: `Bearer ${viewerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: viewerSession.sessionId, mediaToken: published.mediaToken }) })).json();
    expect(subscribed.sessionDescription).toEqual({ type: 'offer', sdp: 'offer' });
  });

  it('routes targeted compatibility fallback between viewer and publisher', async () => {
    const server = await start();
    const base = `http://127.0.0.1:${server.port}`;
    const session = async (role, user) => (await (await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: 'fallback-room', user, role }) })).json()).token;
    const [publisherToken, viewerToken] = await Promise.all([session('publisher', 'pub'), session('viewer', 'view')]);
    const publisher = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${publisherToken}`);
    const viewer = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${viewerToken}`);
    await Promise.all([new Promise((resolve) => publisher.once('open', resolve)), new Promise((resolve) => viewer.once('open', resolve))]);
    const waitFor = (socket, type) => new Promise((resolve) => {
      const onMessage = (data, binary) => {
        if (binary) return;
        const message = JSON.parse(data.toString());
        if (message.type === type) { socket.off('message', onMessage); resolve(message); }
      };
      socket.on('message', onMessage);
    });
    const wanted = waitFor(publisher, 'fallback-want');
    viewer.send(JSON.stringify({ type: 'fallback-want', slot: 0 }));
    expect(await wanted).toMatchObject({ type: 'fallback-want', viewer: 'view', slot: 0 });
    const ready = waitFor(viewer, 'fallback-ready');
    publisher.send(JSON.stringify({ type: 'fallback-ready', viewer: 'view', slot: 0, codec: 'vp8' }));
    expect(await ready).toMatchObject({ type: 'fallback-ready', viewer: 'view', slot: 0, codec: 'vp8' });
  });

  it('relays watched binary media between publisher and viewer', async () => {
    const server = await start();
    const base = `http://127.0.0.1:${server.port}`;
    const session = async (role, user) => (await (await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: 'a', user, role }) })).json()).token;
    const [publisherToken, viewerToken] = await Promise.all([session('publisher', 'pub'), session('viewer', 'view')]);
    const publisher = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${publisherToken}`);
    const viewer = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${viewerToken}`);
    await Promise.all([new Promise((resolve) => publisher.once('open', resolve)), new Promise((resolve) => viewer.once('open', resolve))]);
    viewer.send(JSON.stringify({ type: 'watch', slot: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const received = new Promise((resolve) => viewer.once('message', (data, binary) => resolve({ data, binary })));
    publisher.send(Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 9, 8]));
    const result = await received;
    expect(result.binary).toBe(true);
    expect([...result.data]).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 9, 8]);
  });
});
