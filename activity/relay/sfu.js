import { issueToken, verifyToken } from './tokens.js';

const API_ORIGIN = 'https://rtc.live.cloudflare.com/v1/apps';
const MAX_SDP_LENGTH = 1_000_000;
const MEDIA_TTL_SECONDS = 6 * 60 * 60;

function description(value, expectedType) {
  if (!value || value.type !== expectedType || typeof value.sdp !== 'string' || !value.sdp || value.sdp.length > MAX_SDP_LENGTH) throw new Error(`invalid ${expectedType} session description`);
  return { type: expectedType, sdp: value.sdp };
}

function localTracks(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) throw new Error('invalid local tracks');
  return value.map((track) => {
    if (!track || typeof track.mid !== 'string' || !track.mid || typeof track.trackName !== 'string' || !track.trackName || !['audio', 'video'].includes(track.kind)) throw new Error('invalid local track');
    return { location: 'local', mid: track.mid, trackName: track.trackName, kind: track.kind };
  });
}

export function createSfuGateway({ appId = '', appSecret = '', secret, fetchImpl = globalThis.fetch } = {}) {
  const enabled = Boolean(appId && appSecret);
  const sessions = new Map();
  const creations = new Map();
  const base = `${API_ORIGIN}/${encodeURIComponent(appId)}`;

  const call = async (path, { method = 'POST', body } = {}) => {
    if (!enabled) throw new Error('Cloudflare Realtime SFU is not configured');
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${appSecret}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let result;
    try { result = await response.json(); } catch { throw new Error(`Cloudflare Realtime returned ${response.status}`); }
    if (!response.ok || result?.errorCode) throw new Error(result?.errorDescription || `Cloudflare Realtime returned ${response.status}`);
    return result;
  };

  const ownSession = (claims, sessionId, role = claims.role) => {
    const owner = sessions.get(sessionId);
    if (!owner || owner.room !== claims.room || owner.user !== claims.user || owner.role !== role) throw new Error('invalid SFU session owner');
    return owner;
  };

  return {
    enabled,
    async createSession(claims) {
      if (!enabled) throw new Error('Cloudflare Realtime SFU is not configured');
      if (!claims?.room || !claims?.user || !['publisher', 'viewer'].includes(claims.role)) throw new Error('invalid SFU claims');
      const now = Date.now();
      for (const [id, owner] of sessions) if (owner.createdAt < now - MEDIA_TTL_SECONDS * 1000) sessions.delete(id);
      const ownerKey = `${claims.room}:${claims.user}:${claims.role}`;
      const recent = (creations.get(ownerKey) || []).filter((createdAt) => createdAt > now - 60_000);
      if (recent.length >= 10) throw new Error('SFU session rate limit reached');
      recent.push(now); creations.set(ownerKey, recent);
      const result = await call('/sessions/new');
      if (typeof result.sessionId !== 'string' || !result.sessionId) throw new Error('Cloudflare Realtime returned no session');
      sessions.set(result.sessionId, { room: claims.room, user: claims.user, role: claims.role, createdAt: now });
      return { sessionId: result.sessionId };
    },
    async publish(claims, input) {
      if (claims.role !== 'publisher') throw new Error('publisher role required');
      ownSession(claims, input?.sessionId, 'publisher');
      const offeredTracks = localTracks(input.tracks);
      const result = await call(`/sessions/${encodeURIComponent(input.sessionId)}/tracks/new`, { body: { sessionDescription: description(input.sessionDescription, 'offer'), tracks: offeredTracks.map(({ kind: _kind, ...track }) => track) } });
      const published = offeredTracks.map((track) => {
        const resolved = result.tracks?.find((item) => item.mid === track.mid) || track;
        if (resolved.errorCode) throw new Error(resolved.errorDescription || 'track publication failed');
        return { trackName: resolved.trackName || track.trackName, kind: track.kind };
      });
      const mediaToken = issueToken({ type: 'sfu-media', room: claims.room, sourceSessionId: input.sessionId, tracks: published }, secret, MEDIA_TTL_SECONDS);
      return { sessionDescription: result.sessionDescription, mediaToken, tracks: published };
    },
    async subscribe(claims, input) {
      if (claims.role !== 'viewer') throw new Error('viewer role required');
      ownSession(claims, input?.sessionId, 'viewer');
      const media = verifyToken(input?.mediaToken, secret);
      if (media.type !== 'sfu-media' || media.room !== claims.room) throw new Error('media capability room mismatch');
      if (!Array.isArray(media.tracks) || !media.tracks.length || typeof media.sourceSessionId !== 'string') throw new Error('invalid media capability');
      const tracks = media.tracks.map((track) => ({ location: 'remote', sessionId: media.sourceSessionId, trackName: track.trackName }));
      return call(`/sessions/${encodeURIComponent(input.sessionId)}/tracks/new`, { body: { tracks } });
    },
    async renegotiate(claims, input) {
      ownSession(claims, input?.sessionId);
      return call(`/sessions/${encodeURIComponent(input.sessionId)}/renegotiate`, { method: 'PUT', body: { sessionDescription: description(input.sessionDescription, 'answer') } });
    },
    async closeTracks(claims, input) {
      ownSession(claims, input?.sessionId);
      const mids = Array.isArray(input?.mids) ? input.mids.filter((mid) => typeof mid === 'string' && mid).slice(0, 2) : [];
      if (!mids.length) return {};
      return call(`/sessions/${encodeURIComponent(input.sessionId)}/tracks/close`, { method: 'PUT', body: { tracks: mids.map((mid) => ({ mid })), force: true } });
    },
  };
}
