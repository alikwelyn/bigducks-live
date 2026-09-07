import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createRelayServer } from '../relay/server.js';

const secret = 'smoke-secret-012345678901234567890123';
const server = createRelayServer({ secret, allowDevSessions: true });
await server.listen(0);
try {
  const base = `http://127.0.0.1:${server.port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.sfuEnabled, false);
  assert.equal((await fetch(`${base}/api/sfu/session`, { method: 'POST' })).status, 401);
  const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: 'smoke', user: 'publisher', role: 'publisher' }) });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${token}`);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.close();
  console.log('activity relay smoke: OK');
} finally {
  await server.close();
}
