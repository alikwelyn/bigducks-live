import { allocatePublisherSlot, MAX_BUFFERED_BYTES, MAX_VIEWERS, selectWatchedSlot } from './room-state.js';
import { verifyEdgeToken } from './token.js';
import { updateStreamSource } from '../shared/source-update.js';
import { updateAudience, audienceFor, clearAudience } from '../shared/sfu-audience.js';
import { addUsage, clampReportedBytes, freshUsage, usageSummary, METER_MIN_INTERVAL_MS } from './usage.js';

const INTERNAL_CLAIMS = 'x-bigducks-edge-claims';
const USAGE_PERSIST_MS = 60_000;
const USAGE_NOTIFY_MS = 30_000;

function attachment(socket) {
  try { return socket.deserializeAttachment(); } catch { return null; }
}

function send(socket, message) {
  try { socket.send(typeof message === 'string' || message instanceof ArrayBuffer ? message : JSON.stringify(message)); return true; } catch { return false; }
}

export class EdgeRoom {
  constructor(state) {
    this.state = state;
    this.usage = freshUsage();
    this.usageLoaded = false;
  }

  // Accounting must never interfere with media: every storage access is optional
  // and failures are swallowed.
  async loadUsage() {
    if (this.usageLoaded) return;
    this.usageLoaded = true;
    try {
      const stored = await this.state.storage?.get?.('usage');
      if (stored && stored.month === this.usage.month) this.usage = addUsage(stored, { relay: this.usage.relayBytes, sfu: this.usage.sfuBytes });
    } catch { /* keep the in-memory figure */ }
  }

  async recordUsage(delta) {
    const now = Date.now();
    await this.loadUsage();
    this.usage = addUsage(this.usage, { ...delta, now });
    if (!this.usagePersistedAt || now - this.usagePersistedAt > USAGE_PERSIST_MS) {
      this.usagePersistedAt = now;
      try { await this.state.storage?.put?.('usage', this.usage); } catch { /* not fatal */ }
    }
    if (!this.usageNotifiedAt || now - this.usageNotifiedAt > USAGE_NOTIFY_MS) {
      this.usageNotifiedAt = now;
      this.notifyUsage();
    }
  }

  notifyUsage() {
    const summary = usageSummary(this.usage);
    for (const publisher of this.sockets('publisher')) send(publisher, { type: 'usage', ...summary });
  }

  sockets(role) {
    return this.state.getWebSockets().filter((socket) => attachment(socket)?.role === role);
  }

  publisher(slot) {
    return this.sockets('publisher').find((socket) => attachment(socket)?.slot === slot);
  }

  notifyAudience(exclude = null) {
    const viewers = this.sockets('viewer').filter((socket) => socket !== exclude).map(attachment);
    for (const publisher of this.sockets('publisher')) {
      const member = attachment(publisher);
      send(publisher, { type: 'sfu-audience', slot: member.slot, count: viewers.filter((viewer) => viewer.sfuSlot === member.slot).length });
      send(publisher, { type: 'relay-audience', slot: member.slot, count: viewers.filter((viewer) => viewer.watched === member.slot).length });
      const message = { type: 'audience', slot: member.slot, viewers: audienceFor(viewers, member.slot) };
      send(publisher, message);
      for (const viewer of this.sockets('viewer')) if (viewer !== exclude) send(viewer, message);
    }
  }

  clearAudience(slot) {
    for (const viewer of this.sockets('viewer')) {
      const member = attachment(viewer);
      clearAudience(member, slot);
      viewer.serializeAttachment(member);
    }
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
    const member = { role: claims.role, user: claims.user, name: String(claims.name || claims.user).slice(0, 80), avatar: typeof claims.avatar === 'string' ? claims.avatar : '', slot, watched: null, stream: null };
    server.serializeAttachment(member);
    this.state.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    const member = attachment(socket);
    if (!member) return socket.close(1008, 'missing session');

    if (message instanceof ArrayBuffer) {
      if (member.role !== 'publisher' || message.byteLength < 18 || new Uint8Array(message, 0, 1)[0] !== member.slot) return;
      let delivered = 0;
      for (const viewer of this.sockets('viewer')) {
        const viewerState = attachment(viewer);
        if (viewerState?.watched === member.slot && (viewer.bufferedAmount ?? 0) < MAX_BUFFERED_BYTES && send(viewer, message)) delivered += 1;
      }
      if (delivered) void this.recordUsage({ relay: message.byteLength * delivered }).catch(() => {});
      return;
    }

    if (typeof message !== 'string' || message.length > 64 * 1024) return socket.close(1003, 'invalid control');
    let control;
    try { control = JSON.parse(message); } catch { return socket.close(1003, 'invalid control'); }
    if (!control || typeof control.type !== 'string') return socket.close(1003, 'invalid control');
    if (member.role === 'viewer') {
      // Kept next to the audience fields so one notify covers both and no duplicate
      // message carries the pre-change count.
      if (['watch', 'fallback-want'].includes(control.type)) member.watched = selectWatchedSlot(control.slot);
      else if (['sfu-watch', 'rtc-active'].includes(control.type)) member.watched = null;
      else if (control.type === 'unwatch' && member.watched === control.slot) member.watched = null;
    }
    if (updateAudience(member, control)) {
      socket.serializeAttachment(member);
      this.notifyAudience();
    }

    if (control.type === 'hello') {
      if (member.role === 'publisher') {
        send(socket, { type: 'joined', slot: member.slot, name: member.name, edge: true });
        // Without this the studio shows 0,00 GB after an eviction until media flows.
        await this.loadUsage();
        send(socket, { type: 'usage', ...usageSummary(this.usage) });
      }
      else {
        for (const publisher of this.sockets('publisher')) {
          const publisherState = attachment(publisher);
          if (publisherState?.stream) send(socket, publisherState.stream);
        }
        this.notifyAudience();
        send(socket, { type: 'room-ready' });
      }
      return;
    }

    if (member.role === 'publisher' && ['start', 'stop'].includes(control.type)) {
      const outgoing = { ...control, slot: member.slot, name: member.name, avatar: member.avatar, userId: member.user };
      member.stream = control.type === 'start' ? outgoing : null;
      if (control.type === 'stop') this.clearAudience(member.slot);
      socket.serializeAttachment(member);
      for (const viewer of this.sockets('viewer')) send(viewer, outgoing);
      this.notifyAudience();
      return;
    }

    if (control.type === 'source-update') {
      const outgoing = updateStreamSource(member, control);
      if (outgoing) {
        socket.serializeAttachment(member);
        for (const viewer of this.sockets('viewer')) send(viewer, outgoing);
      }
      return;
    }

    if (member.role === 'publisher' && control.type === 'thumbnail') {
      if (typeof control.data !== 'string' || control.data.length > 60_000 || !control.data.startsWith('data:image/jpeg;base64,')) return;
      const outgoing = { type: 'thumbnail', slot: member.slot, data: control.data };
      if (member.stream) { member.stream.thumbnail = control.data; socket.serializeAttachment(member); }
      for (const viewer of this.sockets('viewer')) send(viewer, outgoing);
      return;
    }

    if (member.role === 'viewer' && control.type === 'meter') {
      // Best-effort, self-reported and clamped: visibility, never enforcement.
      const now = Date.now();
      if (member.meterAt && now - member.meterAt < METER_MIN_INTERVAL_MS) return;
      const bytes = clampReportedBytes(control.bytes);
      member.meterAt = now;
      socket.serializeAttachment(member);
      if (bytes) void this.recordUsage({ sfu: bytes }).catch(() => {});
      return;
    }
    if (member.role === 'viewer' && control.type === 'sfu-watch') {
      // Moving to an SFU subscription ends the relay subscription, so the encoder can idle.
      socket.serializeAttachment(member);
      return;
    }
    if (member.role === 'viewer' && control.type === 'watch') {
      socket.serializeAttachment(member);
      const publisher = this.publisher(member.watched);
      if (publisher) send(publisher, { type: 'need-keyframe', slot: member.watched, viewer: member.user });
      return;
    }
    if (member.role === 'viewer' && control.type === 'unwatch') {
      socket.serializeAttachment(member);
      return;
    }
    if (member.role === 'viewer' && control.type === 'fallback-want') {
      socket.serializeAttachment(member);
      const publisher = this.publisher(member.watched);
      if (publisher) send(publisher, { type: 'fallback-want', slot: member.watched, viewer: member.user });
      return;
    }
    if (member.role === 'publisher' && ['fallback-ready', 'fallback-failed'].includes(control.type)) {
      const target = this.sockets('viewer').find((viewer) => attachment(viewer)?.user === control.viewer);
      if (target) send(target, { ...control, slot: member.slot, viewer: control.viewer });
      return;
    }
    if (member.role === 'viewer' && control.type === 'rtc-active') {
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
    if (member?.role === 'viewer') this.notifyAudience(socket);
    if (member?.role === 'publisher') {
      this.clearAudience(member.slot);
      for (const viewer of this.sockets('viewer')) send(viewer, { type: 'stop', slot: member.slot, name: member.name });
    }
  }

  async webSocketError(socket) {
    await this.webSocketClose(socket);
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
