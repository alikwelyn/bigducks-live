import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createRelayServer } from './server.js';

const secret = 'test-secret-012345678901234567890123';
const servers = [];

afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

async function start() {
  const server = createRelayServer({ secret, allowDevSessions: true });
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
    expect((await response.json()).token).toEqual(expect.any(String));
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
