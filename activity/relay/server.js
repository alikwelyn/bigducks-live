import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { decodePacket, parseControl, stringifyControl } from '../shared/protocol.js';
import { RoomRegistry } from './rooms.js';
import { issueToken, verifyToken } from './tokens.js';
import { createSfuGateway } from './sfu.js';
import { updateAudience, audienceFor, clearAudience } from '../shared/sfu-audience.js';
import { allowedOrigin, createLimiter, readJsonBody, safeRedirect, validRoomClaims } from './security.js';

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

export function createRelayServer({ secret, origin = '', clientId = '', clientSecret = '', allowDevSessions = false, maxViewers = 25, maxPublishers = 3, turnKeyId = '', turnKeySecret = '', iceServers = [], sfuAppId = '', sfuAppSecret = '', sfuFetch = globalThis.fetch, apiRateLimit = 600 } = {}) {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must have at least 32 characters');
  const rooms = new RoomRegistry({ maxViewers, maxPublishers });
  const sfu = createSfuGateway({ appId: sfuAppId, appSecret: sfuAppSecret, secret, fetchImpl: sfuFetch });
  const apiAllowed = createLimiter({ limit: apiRateLimit });
  const shareAllowed = createLimiter({ limit: 10 });
  const invitations = new Map();
  const roomClaims = (token, role) => {
    const claims = verifyToken(token, secret);
    if (!validRoomClaims(claims) || (role && claims.role !== role)) throw new Error('invalid room session');
    return claims;
  };
  let turnCache = null;
  const resolveIceServers = async () => {
    if (!turnKeyId || !turnKeySecret) return iceServers;
    if (turnCache?.expiresAt > Date.now()) return turnCache.iceServers;
    const turnResponse = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(turnKeyId)}/credentials/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${turnKeySecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: 3600 }),
    });
    if (!turnResponse.ok) throw new Error(`TURN credentials failed: ${turnResponse.status}`);
    const body = await turnResponse.json();
    const urls = Array.isArray(body?.iceServers?.urls) ? body.iceServers.urls.filter((url) => !url.includes(':53')) : [];
    if (!urls.length || !body.iceServers.username || !body.iceServers.credential) throw new Error('invalid TURN credentials');
    const resolved = [
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls, username: body.iceServers.username, credential: body.iceServers.credential },
    ];
    turnCache = { iceServers: resolved, expiresAt: Date.now() + 50 * 60 * 1000 };
    return resolved;
  };
  const staticRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/activity');
  const httpServer = http.createServer(async (request, response) => {
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-robots-tag', 'noindex, nofollow, noarchive');
    response.setHeader('cache-control', 'no-store');
    try {
    const url = new URL(request.url, 'http://relay.local');
    let inputBody = {};
    if (url.pathname.startsWith('/api/') && (request.method === 'POST' || url.pathname.startsWith('/api/discord/'))) {
      if (!allowedOrigin(request.headers.origin, { origin, clientId, allowDevSessions })) { request.resume(); return json(response, 403, { error: 'request origin not allowed' }); }
      // Do not trust client-controlled forwarding headers. Behind Traefik this is an aggregate guard.
      if (!apiAllowed(request.socket.remoteAddress || 'unknown')) { request.resume(); response.setHeader('retry-after', '60'); return json(response, 429, { error: 'too many requests' }); }
      if (request.method === 'POST') inputBody = await readJsonBody(request, url.pathname.startsWith('/api/sfu/') ? 1_200_000 : 16_384);
    }
    if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { ok: true });
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/share' || url.pathname.startsWith('/assets/'))) {
      const relative = url.pathname === '/' || url.pathname === '/share' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(staticRoot, relative);
      if (file.startsWith(staticRoot + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        response.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html' });
        return fs.createReadStream(file).pipe(response);
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/config') return json(response, 200, { clientId, publicOrigin: origin, sfuEnabled: sfu.enabled });
    if (request.method === 'POST' && ['/api/capture-session', '/api/share-link'].includes(url.pathname)) {
      const token = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
      let claims;
      try { claims = roomClaims(token, 'publisher'); } catch { return json(response, 401, { error: 'valid publisher invitation required' }); }
      if (url.pathname === '/api/capture-session') return json(response, 200, { ok: true });
      if (!shareAllowed(claims.user)) { response.setHeader('retry-after', '60'); return json(response, 429, { error: 'too many invitations' }); }
      const now = Date.now();
      for (const [code, invite] of invitations) if (invite.expires <= now) invitations.delete(code);
      if (invitations.size >= 1000) return json(response, 503, { error: 'invitation capacity reached' });
      const code = crypto.randomBytes(32).toString('hex');
      invitations.set(code, { token, expires: Math.min(now + 120_000, claims.exp * 1000) });
      return json(response, 200, { code, expiresIn: 120 });
    }
    if (request.method === 'POST' && url.pathname === '/api/share-redeem') {
      const code = inputBody.code;
      if (typeof code !== 'string' || !/^[a-f0-9]{64}$/.test(code)) return json(response, 401, { error: 'invalid or expired invitation' });
      const invite = invitations.get(code);
      invitations.delete(code);
      if (!invite || invite.expires <= Date.now()) return json(response, 401, { error: 'invalid or expired invitation' });
      try { roomClaims(invite.token, 'publisher'); } catch { return json(response, 401, { error: 'invalid or expired invitation' }); }
      return json(response, 200, { token: invite.token });
    }
    if (request.method === 'POST' && url.pathname.startsWith('/api/sfu/')) {
      const bearer = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
      if (!bearer) return json(response, 401, { error: 'SFU session authentication required' });
      let claims;
      try { claims = roomClaims(bearer); } catch { return json(response, 401, { error: 'invalid SFU session' }); }
      const body = inputBody;
      try {
        const operation = url.pathname.slice('/api/sfu/'.length);
        const result = operation === 'session' ? await sfu.createSession(claims)
          : operation === 'publish' ? await sfu.publish(claims, body)
            : operation === 'subscribe' ? await sfu.subscribe(claims, body)
              : operation === 'renegotiate' ? await sfu.renegotiate(claims, body)
                : operation === 'close' ? await sfu.closeTracks(claims, body)
                  : null;
        if (!result) return json(response, 404, { error: 'unknown SFU operation' });
        return json(response, 200, result);
      } catch (error) {
        const message = String(error?.message || 'SFU operation failed');
        const status = message.includes('not configured') ? 503 : message.includes('rate limit') ? 429 : /role|required|owner|room/.test(message) ? 403 : message.startsWith('Cloudflare Realtime') || message.includes('publication failed') ? 502 : 400;
        return json(response, status, { error: message });
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/discord/authorize') {
      if (!clientId || !clientSecret) return json(response, 503, { error: 'Discord OAuth is not configured' });
      const redirect = safeRedirect(url.searchParams.get('redirect'));
      const nonce = crypto.randomBytes(32).toString('hex');
      const state = issueToken({ type: 'oauth', redirect, nonce }, secret);
      response.setHeader('set-cookie', `oauth_state=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/api/discord; Max-Age=300`);
      const params = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: `${origin || url.origin}/api/discord/callback`, scope: 'identify', state });
      response.writeHead(302, { location: `https://discord.com/oauth2/authorize?${params}` }); return response.end();
    }
    if (request.method === 'GET' && url.pathname === '/api/discord/callback') {
      try {
        const state = verifyToken(url.searchParams.get('state'), secret);
        const nonce = request.headers.cookie?.match(/(?:^|;\s*)oauth_state=([^;]+)/)?.[1];
        if (state.type !== 'oauth' || !nonce || state.nonce !== nonce) throw new Error('invalid OAuth state');
        response.setHeader('set-cookie', 'oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/api/discord; Max-Age=0');
        const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: `${origin || url.origin}/api/discord/callback` });
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params });
        const token = await tokenResponse.json();
        if (!tokenResponse.ok || typeof token.access_token !== 'string') throw new Error('Discord authorization failed');
        response.writeHead(302, { 'set-cookie': [`discord_access_token=${encodeURIComponent(token.access_token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600`, 'oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/api/discord; Max-Age=0'], location: safeRedirect(state.redirect) }); return response.end();
      } catch { return json(response, 400, { error: 'invalid Discord callback' }); }
    }
    if (request.method === 'GET' && url.pathname === '/api/ice') {
      try {
        roomClaims(request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1] || url.searchParams.get('token'));
        return json(response, 200, { iceServers: await resolveIceServers() });
      } catch (error) {
        return json(response, error.message.startsWith('TURN credentials') ? 502 : 401, { error: 'ICE configuration unavailable' });
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/discord/token') {
      if (!clientId || !clientSecret) return json(response, 503, { error: 'Discord OAuth is not configured' });
      try {
        const input = inputBody;
        if (typeof input.code !== 'string' || input.code.length < 8) throw new Error('invalid authorization code');
        const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code: input.code });
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params });
        const token = await tokenResponse.json();
        if (!tokenResponse.ok || typeof token.access_token !== 'string') return json(response, 401, { error: 'Discord authorization failed' });
        return json(response, 200, { access_token: token.access_token });
      } catch (error) { return json(response, 400, { error: error.message }); }
    }
    if (request.method === 'POST' && url.pathname === '/api/session') {
      try {
        const input = inputBody;
        if (!validRoomClaims({ room: input.room, user: 'pending-auth', role: input.role })) throw new Error('invalid session');
        let user = input.user;
        let name = input.name || input.user;
        let avatar = '';
        if (!allowDevSessions) {
          const bearer = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1] || request.headers.cookie?.match(/(?:^|; )discord_access_token=([^;]+)/)?.[1];
          if (!bearer) return json(response, 401, { error: 'Discord authentication required' });
          const discordResponse = await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${bearer}` } });
          const discordUser = await discordResponse.json();
          if (!discordResponse.ok || typeof discordUser.id !== 'string') return json(response, 401, { error: 'Discord authentication failed' });
          user = discordUser.id;
          name = discordUser.global_name || discordUser.username || discordUser.id;
          if (discordUser.avatar) avatar = `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=128`;
        }
        if (!validRoomClaims({ room: input.room, role: input.role, user })) throw new Error('invalid user');
        const token = issueToken({ room: input.room, role: input.role, user, name: String(name || user).slice(0, 80), avatar }, secret, 6 * 60 * 60);
        return json(response, 200, { token, room: input.room, role: input.role });
      } catch (error) { return json(response, 400, { error: error.message }); }
    }
    json(response, 404, { error: 'not found' });
    } catch (error) {
      if (!response.headersSent) json(response, error.status || 400, { error: error.status ? error.message : 'invalid request' });
      else response.end();
    }
  });
  httpServer.requestTimeout = 30_000;
  httpServer.headersTimeout = 15_000;
  const websocket = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url, 'http://relay.local');
      if (url.pathname !== '/ws') throw new Error('invalid websocket path');
      const claims = roomClaims(url.searchParams.get('token'));
      websocket.handleUpgrade(request, socket, head, (client) => {
        websocket.emit('connection', client, request, claims);
      });
    } catch {
      socket.destroy();
    }
  });
  websocket.on('connection', (client, _request, claims) => {
    const notifyAudience = () => {
      const room = rooms.get(claims.room);
      for (const publisher of room?.publishers.values() ?? []) {
        if (publisher.socket?.readyState === 1) publisher.socket.send(stringifyControl({ type: 'sfu-audience', slot: publisher.slot,
          count: [...room.viewers.values()].filter((viewer) => viewer.sfuSlot === publisher.slot && viewer.socket?.readyState === 1).length }));
        const outgoing = stringifyControl({ type: 'audience', slot: publisher.slot, viewers: audienceFor([...room.viewers.values()].filter((viewer) => viewer.socket?.readyState === 1), publisher.slot) });
        if (publisher.socket?.readyState === 1) publisher.socket.send(outgoing);
        for (const viewer of room.viewers.values()) if (viewer.socket?.readyState === 1) viewer.socket.send(outgoing);
      }
    };
    let member;
    try { member = rooms.join(claims.room, claims.role, claims.user, client, claims.name); member.avatar = claims.avatar || ''; } catch { client.close(1008, 'room unavailable'); return; }
    if (claims.role === 'publisher') client.send(stringifyControl({ type: 'joined', slot: member.slot, name: member.name }));
    if (claims.role === 'viewer') {
      for (const publisher of rooms.get(claims.room)?.publishers.values() ?? []) {
        if (publisher.stream) client.send(stringifyControl({ ...publisher.stream, slot: publisher.slot, name: publisher.name }));
      }
    }
    client.on('message', (data, binary) => {
      try {
        if (binary) {
          if (claims.role !== 'publisher') return;
          const packet = decodePacket(data);
          if (packet.slot !== member.slot) throw new Error('invalid publisher slot');
          for (const viewer of rooms.viewersFor(claims.room, member.slot)) {
            if (viewer.socket.readyState === 1 && viewer.socket.bufferedAmount < 256 * 1024) viewer.socket.send(data, { binary: true });
          }
          return;
        }
        const message = parseControl(data);
        if (updateAudience(member, message)) notifyAudience();
        if (message.type === 'hello') {
          if (claims.role === 'publisher') client.send(stringifyControl({ type: 'joined', slot: member.slot, name: member.name }));
          else {
            for (const publisher of rooms.get(claims.room)?.publishers.values() ?? []) if (publisher.stream) client.send(stringifyControl({ ...publisher.stream, slot: publisher.slot, name: publisher.name }));
            notifyAudience();
          }
          return;
        }
        if (claims.role === 'publisher' && ['start', 'stop'].includes(message.type)) {
          const outgoing = { ...message, slot: member.slot, name: member.name, avatar: member.avatar, userId: claims.user };
          member.stream = message.type === 'start' ? outgoing : null;
          if (message.type === 'stop') for (const viewer of rooms.get(claims.room)?.viewers.values() ?? []) clearAudience(viewer, member.slot);
          notifyAudience();
          for (const viewer of rooms.get(claims.room)?.viewers.values() ?? []) if (viewer.socket.readyState === 1) viewer.socket.send(stringifyControl(outgoing));
          return;
        }
        if (claims.role === 'publisher' && message.type === 'thumbnail') {
          if (typeof message.data !== 'string' || message.data.length > 60_000 || !message.data.startsWith('data:image/jpeg;base64,')) return;
          const outgoing = { type: 'thumbnail', slot: member.slot, data: message.data };
          if (member.stream) member.stream.thumbnail = message.data;
          for (const viewer of rooms.get(claims.room)?.viewers.values() ?? []) if (viewer.socket.readyState === 1) viewer.socket.send(stringifyControl(outgoing));
          return;
        }
        if (claims.role === 'viewer' && message.type === 'watch') {
          rooms.watch(claims.room, claims.user, message.slot);
          rooms.publisherForSlot(claims.room, message.slot)?.socket?.send(stringifyControl({ type: 'need-keyframe', slot: message.slot, viewer: claims.user }));
          return;
        }
        if (claims.role === 'viewer' && message.type === 'unwatch') return rooms.unwatch(claims.room, claims.user, message.slot);
        if (claims.role === 'viewer' && message.type === 'fallback-want') {
          rooms.watch(claims.room, claims.user, message.slot);
          rooms.publisherForSlot(claims.room, message.slot)?.socket?.send(stringifyControl({ type: 'fallback-want', slot: message.slot, viewer: claims.user }));
          return;
        }
        if (claims.role === 'publisher' && ['fallback-ready', 'fallback-failed'].includes(message.type)) {
          const target = rooms.get(claims.room)?.viewers.get(message.viewer)?.socket;
          if (target?.readyState === 1) target.send(stringifyControl({ ...message, slot: member.slot, viewer: message.viewer }));
          return;
        }
        if (claims.role === 'viewer' && message.type === 'rtc-active') rooms.unwatch(claims.room, claims.user, message.slot);
        if (['rtc-want', 'rtc', 'rtc-active', 'rtc-bye'].includes(message.type)) {
          const watchedSlot = rooms.viewersFor(claims.room).find((viewer) => viewer.id === claims.user)?.slot;
          const target = claims.role === 'viewer'
            ? rooms.publisherForSlot(claims.room, message.slot ?? watchedSlot)?.socket
            : rooms.get(claims.room)?.viewers.get(message.viewer)?.socket;
          if (target?.readyState === 1) target.send(stringifyControl({ ...message, viewer: claims.role === 'viewer' ? claims.user : message.viewer }));
        }
      } catch { client.close(1003, 'invalid message'); }
    });
    client.on('close', () => {
      if (member.role === 'publisher') {
        for (const viewer of rooms.get(claims.room)?.viewers.values() ?? []) clearAudience(viewer, member.slot);
        const stopped = stringifyControl({ type: 'stop', slot: member.slot, name: member.name });
        for (const viewer of rooms.get(claims.room)?.viewers.values() ?? []) if (viewer.socket.readyState === 1) viewer.socket.send(stopped);
      }
      rooms.leave(member);
      notifyAudience();
    });
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
