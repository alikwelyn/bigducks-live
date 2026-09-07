import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createRelayServer } from './server.js';
import { issueToken } from './tokens.js';

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
  it('validates capture access and redeems short-lived invitations only once', async () => {
    const server = await start();
    const base = `http://127.0.0.1:${server.port}`;
    const publisher = issueToken({ room: 'room', user: 'pub', role: 'publisher' }, secret);
    const viewer = issueToken({ room: 'room', user: 'view', role: 'viewer' }, secret);
    const expired = issueToken({ room: 'room', user: 'pub', role: 'publisher' }, secret, -1);
    const call = (path, token, body) => fetch(base + path, { method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    for (const token of ['', viewer, expired, 'invalid']) expect((await call('/api/capture-session', token)).status).toBe(401);
    expect((await call('/api/capture-session', publisher)).status).toBe(200);
    const inviteResponse = await call('/api/share-link', publisher);
    expect(inviteResponse.status).toBe(200);
    const { code } = await inviteResponse.json();
    expect(code).toMatch(/^[a-f0-9]{64}$/);
    expect(code).not.toContain(publisher);
    const redeemed = await call('/api/share-redeem', '', { code });
    expect(redeemed.status).toBe(200);
    expect((await redeemed.json()).token).toBe(publisher);
    expect((await call('/api/share-redeem', '', { code })).status).toBe(401);
    expect((await call('/api/share-link', viewer)).status).toBe(401);
  });

  it('expires unredeemed invitations without revoking the publisher session', async () => {
    const server = await start(); const base = `http://127.0.0.1:${server.port}`;
    const token = issueToken({ room: 'room', user: 'pub', role: 'publisher' }, secret, 21600);
    const invite = await (await fetch(base + '/api/share-link', { method: 'POST', headers: { authorization: `Bearer ${token}` } })).json();
    const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 121000);
    try {
      expect((await fetch(base + '/api/share-redeem', { method: 'POST', body: JSON.stringify({ code: invite.code }) })).status).toBe(401);
      expect((await fetch(base + '/api/capture-session', { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    } finally { clock.mockRestore(); }
  });

  it('limits requests and bodies without exposing credentials or blocking Discord origins', async () => {
    const server = await start({ origin: 'https://stream.skillup.com.br', clientId: '123', apiRateLimit: 5 });
    const base = `http://127.0.0.1:${server.port}`;
    const health = await fetch(base + '/healthz');
    expect(health.headers.get('referrer-policy')).toBe('no-referrer');
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    expect(health.headers.get('x-robots-tag')).toContain('noindex');
    expect((await fetch(base + '/api/session', { method: 'POST', headers: { origin: 'https://evil.test' }, body: '{}' })).status).toBe(403);
    expect((await fetch(base + '/api/session', { method: 'POST', body: JSON.stringify({ padding: 'x'.repeat(17000) }) })).status).toBe(413);
    const session = { room: 'r', user: 'u', role: 'viewer' };
    expect((await fetch(base + '/api/session', { method: 'POST', headers: { origin: 'https://123.discordsays.com' }, body: JSON.stringify(session) })).status).toBe(200);
    for (let i = 0; i < 5; i++) await fetch(base + '/api/session', { method: 'POST', body: '{}' });
    const limited = await fetch(base + '/api/session', { method: 'POST', body: '{}' });
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60');
    expect((await fetch(base + '/healthz')).status).toBe(200);
  });

  it('does not issue production sessions based on a caller-supplied Discord identity', async () => {
    const server = await start({ allowDevSessions: false });
    const response = await fetch(`http://127.0.0.1:${server.port}/api/session`, { method: 'POST', body: JSON.stringify({ room: 'private', role: 'publisher', user: 'pretend-discord-user' }) });
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty('token');
  });

  it('rejects other signed capability types for SFU and ICE', async () => {
    const server = await start();
    const base = `http://127.0.0.1:${server.port}`;
    const token = issueToken({ type: 'oauth', role: 'viewer', room: 'r', user: 'u' }, secret);
    expect((await fetch(base + '/api/sfu/session', { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await fetch(base + '/api/ice', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('binds OAuth callback to browser state and prevents external redirects', async () => {
    const server = await start({ clientId: '123', clientSecret: 'secret', origin: 'https://stream.skillup.com.br' });
    const base = `http://127.0.0.1:${server.port}`;
    const response = await fetch(base + '/api/discord/authorize?redirect=//evil.test', { redirect: 'manual' });
    const state = new URL(response.headers.get('location')).searchParams.get('state');
    expect(response.headers.get('set-cookie')).toMatch(/oauth_state=.*HttpOnly.*Secure.*SameSite=Lax/);
    expect((await fetch(base + '/api/discord/callback?state=' + encodeURIComponent(state) + '&code=fake', { redirect: 'manual' })).status).toBe(400);
  });
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
    expect((await fetch(`${base}/api/ice`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
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
