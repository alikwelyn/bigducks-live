import { allocatePublisherSlot, MAX_BUFFERED_BYTES, MAX_VIEWERS, selectWatchedSlot } from './room-state.js';
import { verifyEdgeToken } from './token.js';

const INTERNAL_CLAIMS = 'x-bigducks-edge-claims';

function attachment(socket) {
  try { return socket.deserializeAttachment(); } catch { return null; }
}

function send(socket, message) {
  try { socket.send(typeof message === 'string' || message instanceof ArrayBuffer ? message : JSON.stringify(message)); } catch { /* disconnected */ }
}

export class EdgeRoom {
  constructor(state) {
    this.state = state;
  }

  sockets(role) {
    return this.state.getWebSockets().filter((socket) => attachment(socket)?.role === role);
  }

  publisher(slot) {
    return this.sockets('publisher').find((socket) => attachment(socket)?.slot === slot);
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    let claims;
    try { claims = JSON.parse(request.headers.get(INTERNAL_CLAIMS) || ''); } catch { return new Response('Unauthorized', { status: 401 }); }

    const publishers = this.sockets('publisher');
    const viewers = this.sockets('viewer');
    let slot = null;
    if (claims.role === 'publisher') {
      slot = allocatePublisherSlot(publishers.map((socket) => attachment(socket).slot));
      if (slot === null) return new Response('Publisher limit reached', { status: 429 });
    } else if (viewers.length >= MAX_VIEWERS) return new Response('Viewer limit reached', { status: 429 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const member = { role: claims.role, user: claims.user, name: String(claims.name || claims.user).slice(0, 80), slot, watched: null, stream: null };
    server.serializeAttachment(member);
    this.state.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    const member = attachment(socket);
    if (!member) return socket.close(1008, 'missing session');

    if (message instanceof ArrayBuffer) {
      if (member.role !== 'publisher' || message.byteLength < 18 || new Uint8Array(message, 0, 1)[0] !== member.slot) return;
      for (const viewer of this.sockets('viewer')) {
        const viewerState = attachment(viewer);
        if (viewerState?.watched === member.slot && (viewer.bufferedAmount ?? 0) < MAX_BUFFERED_BYTES) send(viewer, message);
      }
      return;
    }

    if (typeof message !== 'string' || message.length > 64 * 1024) return socket.close(1003, 'invalid control');
    let control;
    try { control = JSON.parse(message); } catch { return socket.close(1003, 'invalid control'); }
    if (!control || typeof control.type !== 'string') return socket.close(1003, 'invalid control');

    if (control.type === 'hello') {
      if (member.role === 'publisher') send(socket, { type: 'joined', slot: member.slot, name: member.name, edge: true });
      else {
        for (const publisher of this.sockets('publisher')) {
          const publisherState = attachment(publisher);
          if (publisherState?.stream) send(socket, publisherState.stream);
        }
      }
      return;
    }

    if (member.role === 'publisher' && ['start', 'stop'].includes(control.type)) {
      const outgoing = { ...control, slot: member.slot, name: member.name };
      member.stream = control.type === 'start' ? outgoing : null;
      socket.serializeAttachment(member);
      for (const viewer of this.sockets('viewer')) send(viewer, outgoing);
      return;
    }

    if (member.role === 'viewer' && control.type === 'watch') {
      member.watched = selectWatchedSlot(control.slot);
      socket.serializeAttachment(member);
      const publisher = this.publisher(member.watched);
      if (publisher) send(publisher, { type: 'need-keyframe', slot: member.watched, viewer: member.user });
      return;
    }
    if (member.role === 'viewer' && control.type === 'unwatch') {
      if (member.watched === control.slot) member.watched = null;
      socket.serializeAttachment(member);
      return;
    }
    if (member.role === 'viewer' && control.type === 'rtc-active') {
      member.watched = null;
      socket.serializeAttachment(member);
    }

    if (['rtc-want', 'rtc', 'rtc-active', 'rtc-bye'].includes(control.type)) {
      if (member.role === 'viewer') {
        const target = this.publisher(control.slot ?? member.watched);
        if (target) send(target, { ...control, viewer: member.user });
      } else {
        const target = this.sockets('viewer').find((viewer) => attachment(viewer)?.user === control.viewer);
        if (target) send(target, { ...control, slot: member.slot, viewer: control.viewer });
      }
    }
  }

  async webSocketClose(socket) {
    const member = attachment(socket);
    if (member?.role === 'publisher') {
      for (const viewer of this.sockets('viewer')) send(viewer, { type: 'stop', slot: member.slot, name: member.name });
    }
  }

  async webSocketError(socket) {
    try { socket.close(1011, 'edge relay error'); } catch { /* already closed */ }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/^\/\.proxy(?=\/)/, '');
    if (pathname === '/edge/healthz' || pathname === '/healthz') return Response.json({ ok: true, relay: 'cloudflare-edge' });
    if (!['/edge/ws', '/ws'].includes(pathname) || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Not found', { status: 404 });
    try {
      const claims = await verifyEdgeToken(url.searchParams.get('token'), env.SESSION_SECRET);
      const id = env.ROOMS.idFromName(claims.room);
      const headers = new Headers(request.headers);
      headers.set(INTERNAL_CLAIMS, JSON.stringify(claims));
      return env.ROOMS.get(id).fetch(new Request(request, { headers }));
    } catch {
      return new Response('Unauthorized', { status: 401 });
    }
  },
};
