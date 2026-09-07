import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { decodePacket, parseControl, stringifyControl } from '../shared/protocol.js';
import { RoomRegistry } from './rooms.js';
import { issueToken, verifyToken } from './tokens.js';

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

export function createRelayServer({ secret, clientId = '', clientSecret = '', allowDevSessions = false, maxViewers = 25, iceServers = [] } = {}) {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must have at least 32 characters');
  const rooms = new RoomRegistry({ maxViewers });
  const staticRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/activity');
  const httpServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://relay.local');
    if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { ok: true });
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/share' || url.pathname.startsWith('/assets/'))) {
      const relative = url.pathname === '/' || url.pathname === '/share' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(staticRoot, relative);
      if (file.startsWith(staticRoot) && fs.existsSync(file)) {
        response.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html' });
        return fs.createReadStream(file).pipe(response);
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/config') return json(response, 200, { clientId });
    if (request.method === 'GET' && url.pathname === '/api/discord/authorize') {
      if (!clientId || !clientSecret) return json(response, 503, { error: 'Discord OAuth is not configured' });
      const redirect = url.searchParams.get('redirect') || '/share';
      const state = issueToken({ type: 'oauth', redirect: redirect.startsWith('/') ? redirect : '/share' }, secret);
      const params = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: `${process.env.PUBLIC_ORIGIN || url.origin}/api/discord/callback`, scope: 'identify', state });
      response.writeHead(302, { location: `https://discord.com/oauth2/authorize?${params}` }); return response.end();
    }
    if (request.method === 'GET' && url.pathname === '/api/discord/callback') {
      try {
        const state = verifyToken(url.searchParams.get('state'), secret);
        if (state.type !== 'oauth') throw new Error('invalid OAuth state');
        const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: `${process.env.PUBLIC_ORIGIN || url.origin}/api/discord/callback` });
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params });
        const token = await tokenResponse.json();
        if (!tokenResponse.ok || typeof token.access_token !== 'string') throw new Error('Discord authorization failed');
        response.writeHead(302, { 'set-cookie': `discord_access_token=${encodeURIComponent(token.access_token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600`, location: state.redirect }); return response.end();
      } catch { return json(response, 400, { error: 'invalid Discord callback' }); }
    }
    if (request.method === 'GET' && url.pathname === '/api/ice') return json(response, 200, { iceServers });
    if (request.method === 'POST' && url.pathname === '/api/discord/token') {
      if (!clientId || !clientSecret) return json(response, 503, { error: 'Discord OAuth is not configured' });
      let body = '';
      for await (const chunk of request) body += chunk;
      try {
        const input = JSON.parse(body);
        if (typeof input.code !== 'string' || input.code.length < 8) throw new Error('invalid authorization code');
        const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code: input.code });
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params });
        const token = await tokenResponse.json();
        if (!tokenResponse.ok || typeof token.access_token !== 'string') return json(response, 401, { error: 'Discord authorization failed' });
        return json(response, 200, { access_token: token.access_token });
      } catch (error) { return json(response, 400, { error: error.message }); }
    }
    if (request.method === 'POST' && url.pathname === '/api/session') {
      let body = '';
      for await (const chunk of request) body += chunk;
      try {
        const input = JSON.parse(body);
        if (!['publisher', 'viewer'].includes(input.role) || typeof input.room !== 'string') throw new Error('invalid session');
        let user = input.user;
        if (!allowDevSessions) {
          const bearer = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1] || request.headers.cookie?.match(/(?:^|; )discord_access_token=([^;]+)/)?.[1];
          if (!bearer) return json(response, 401, { error: 'Discord authentication required' });
          const discordResponse = await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${bearer}` } });
          const discordUser = await discordResponse.json();
          if (!discordResponse.ok || typeof discordUser.id !== 'string') return json(response, 401, { error: 'Discord authentication failed' });
          user = discordUser.id;
        }
        if (typeof user !== 'string' || !user) throw new Error('invalid user');
        const token = issueToken({ room: input.room, role: input.role, user }, secret);
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
        if (claims.role === 'publisher' && ['start', 'stop'].includes(message.type)) {
          for (const viewer of rooms.get(claims.room)?.viewers.values() ?? []) if (viewer.socket.readyState === 1) viewer.socket.send(stringifyControl(message));
          return;
        }
        if (claims.role === 'viewer' && message.type === 'watch') {
          rooms.watch(claims.room, claims.user, message.slot);
          rooms.get(claims.room)?.publisher?.socket?.send(stringifyControl({ type: 'need-keyframe', slot: message.slot, viewer: claims.user }));
          return;
        }
        if (claims.role === 'viewer' && message.type === 'unwatch') return rooms.unwatch(claims.room, claims.user, message.slot);
        if (['rtc-want', 'rtc', 'rtc-active', 'rtc-bye'].includes(message.type)) {
          const target = claims.role === 'viewer'
            ? rooms.get(claims.room)?.publisher?.socket
            : rooms.get(claims.room)?.viewers.get(message.viewer)?.socket;
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
    listen(port = 0) { return new Promise((resolve) => httpServer.listen(port, '0.0.0.0', resolve)); },
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
  const { loadConfig } = await import('./config.js');
  const config = loadConfig();
  const server = createRelayServer(config);
  server.listen(config.port).then(() => console.log(`relay listening on ${server.port}`));
}
