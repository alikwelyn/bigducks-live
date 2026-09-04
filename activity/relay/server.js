import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { decodePacket, parseControl, stringifyControl } from '../shared/protocol.js';
import { RoomRegistry } from './rooms.js';
import { issueToken, verifyToken } from './tokens.js';

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

export function createRelayServer({ secret, allowDevSessions = false, maxViewers = 25, iceServers = [] } = {}) {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must have at least 32 characters');
  const rooms = new RoomRegistry({ maxViewers });
  const httpServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://relay.local');
    if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { ok: true });
    if (request.method === 'GET' && url.pathname === '/api/ice') return json(response, 200, { iceServers });
    if (request.method === 'POST' && url.pathname === '/api/session') {
      if (!allowDevSessions) return json(response, 403, { error: 'Discord session verification is required' });
      let body = '';
      for await (const chunk of request) body += chunk;
      try {
        const input = JSON.parse(body);
        if (!['publisher', 'viewer'].includes(input.role) || typeof input.room !== 'string' || typeof input.user !== 'string') throw new Error('invalid session');
        const token = issueToken({ room: input.room, role: input.role, user: input.user }, secret);
        return json(response, 200, { token, room: input.room, role: input.role });
      } catch (error) { return json(response, 400, { error: error.message }); }
    }
    json(response, 404, { error: 'not found' });
  });
  const websocket = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (request, socket, head) => {
    try {
      const token = new URL(request.url, 'http://relay.local').searchParams.get('token');
      const claims = verifyToken(token, secret);
      websocket.handleUpgrade(request, socket, head, (client) => {
        websocket.emit('connection', client, request, claims);
      });
    } catch {
      socket.destroy();
    }
  });
  websocket.on('connection', (client, _request, claims) => {
    let member;
    try { member = rooms.join(claims.room, claims.role, claims.user, client); } catch { client.close(1008, 'room unavailable'); return; }
    client.on('message', (data, binary) => {
      try {
        if (binary) {
          if (claims.role !== 'publisher') return;
          const packet = decodePacket(data);
          for (const viewer of rooms.viewersFor(claims.room, packet.slot)) {
            if (viewer.socket.readyState === 1 && viewer.socket.bufferedAmount < 2 * 1024 * 1024) viewer.socket.send(data, { binary: true });
          }
          return;
        }
        const message = parseControl(data);
        if (claims.role === 'viewer' && message.type === 'watch') {
          rooms.watch(claims.room, claims.user, message.slot);
          rooms.get(claims.room)?.publisher?.socket?.send(stringifyControl({ type: 'need-keyframe', slot: message.slot, viewer: claims.user }));
          return;
        }
        if (claims.role === 'viewer' && message.type === 'unwatch') return rooms.unwatch(claims.room, claims.user, message.slot);
        if (message.type === 'rtc' || message.type === 'rtc-active' || message.type === 'rtc-bye') {
          const target = typeof message.viewer === 'string' ? rooms.get(claims.room)?.viewers.get(message.viewer)?.socket : rooms.get(claims.room)?.publisher?.socket;
          if (target?.readyState === 1) target.send(stringifyControl({ ...message, viewer: claims.role === 'viewer' ? claims.user : message.viewer }));
        }
      } catch { client.close(1003, 'invalid message'); }
    });
    client.on('close', () => rooms.leave(member));
  });
  return {
    rooms,
    httpServer,
    get port() { return httpServer.address()?.port; },
    listen(port = 0) { return new Promise((resolve) => httpServer.listen(port, '127.0.0.1', resolve)); },
    close() {
      for (const client of websocket.clients) client.terminate();
      return new Promise((resolve, reject) => {
        websocket.close();
        httpServer.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createRelayServer({ secret: process.env.SESSION_SECRET, allowDevSessions: process.env.NODE_ENV !== 'production' });
  server.listen(Number(process.env.PORT) || 3001).then(() => console.log(`relay listening on ${server.port}`));
}
