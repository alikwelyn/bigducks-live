import { monitorQuality } from './automatic-quality.js';
import { updateSender } from './sender-parameters.js';
const CONNECTION_TIMEOUT_MS = 10_000;

export async function sfuRequest({ apiBase = '', token, operation, body, fetchImpl = globalThis.fetch, keepalive = false }) {
  const response = await fetchImpl(`${apiBase}/api/sfu/${operation}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    // A closing page would otherwise have this request dropped before it is sent.
    ...(keepalive ? { keepalive: true } : {}),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`SFU proxy returned ${response.status}`); }
  if (!response.ok) throw new Error(result?.error || `SFU proxy returned ${response.status}`);
  return result;
}

function createPeer(RTCPeerConnectionClass, iceServers) {
  return new RTCPeerConnectionClass({ iceServers: iceServers?.length ? iceServers : [{ urls: 'stun:stun.cloudflare.com:3478' }], bundlePolicy: 'max-bundle' });
}

function waitForConnection(peer, timeoutMs = CONNECTION_TIMEOUT_MS) {
  if (peer.connectionState === 'connected' || ['connected', 'completed'].includes(peer.iceConnectionState)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Cloudflare SFU connection timeout')), timeoutMs);
    const finish = (error) => {
      clearTimeout(timeout);
      peer.removeEventListener?.('connectionstatechange', check);
      peer.removeEventListener?.('iceconnectionstatechange', check);
      error ? reject(error) : resolve();
    };
    const check = () => {
      if (peer.connectionState === 'connected' || ['connected', 'completed'].includes(peer.iceConnectionState)) finish();
      else if (peer.connectionState === 'failed' || peer.iceConnectionState === 'failed') finish(new Error('Cloudflare SFU connection failed'));
    };
    peer.addEventListener('connectionstatechange', check);
    peer.addEventListener('iceconnectionstatechange', check);
  });
}

function monitorConnection(peer, onDisconnect = () => {}) {
  let disconnectedTimer;
  let notified = false;
  const notify = () => { if (!notified) { notified = true; onDisconnect(); } };
  const check = () => {
    clearTimeout(disconnectedTimer);
    if (peer.connectionState === 'failed' || peer.iceConnectionState === 'failed') notify();
    else if (peer.connectionState === 'disconnected' || peer.iceConnectionState === 'disconnected') disconnectedTimer = setTimeout(notify, 3000);
  };
  peer.addEventListener('connectionstatechange', check);
  peer.addEventListener('iceconnectionstatechange', check);
  return () => { clearTimeout(disconnectedTimer); peer.removeEventListener?.('connectionstatechange', check); peer.removeEventListener?.('iceconnectionstatechange', check); };
}

function videoEncoding(track, profile) {
  const settings = track.getSettings?.() || {};
  const scaleResolutionDownBy = Math.max(1, (settings.width || profile.width) / profile.width, (settings.height || profile.height) / profile.height);
  return { maxBitrate: profile.bitrate, maxFramerate: profile.fps, scaleResolutionDownBy };
}

// Simulcast lets the SFU hand each viewer the layer their connection can carry,
// instead of degrading the single stream for everybody. The publisher pays for it
// with upload: three layers instead of one.
export const SIMULCAST_LAYERS = [
  { rid: 'h', bitrateScale: 1, scaleFactor: 1, fpsScale: 1 },
  { rid: 'm', bitrateScale: 0.5, scaleFactor: 2, fpsScale: 1 },
  { rid: 'l', bitrateScale: 0.25, scaleFactor: 4, fpsScale: 0.6 },
];

export function videoEncodings(track, profile, { simulcast = true } = {}) {
  const base = videoEncoding(track, profile);
  if (!simulcast) return [base];
  return SIMULCAST_LAYERS.map(({ rid, bitrateScale, scaleFactor, fpsScale }) => ({
    rid,
    maxBitrate: Math.max(40_000, Math.round(base.maxBitrate * bitrateScale)),
    maxFramerate: Math.max(1, Math.round(base.maxFramerate * fpsScale)),
    scaleResolutionDownBy: base.scaleResolutionDownBy * scaleFactor,
  }));
}

// setParameters must not carry rid, and each layer keeps its own budget.
function applyEncoding(encoding, wanted) {
  const { rid, ...rest } = wanted;
  Object.assign(encoding, rest);
}

async function limitVideoSender(sender, profile) {
  if (!sender?.setParameters) return;
  const parameters = sender.getParameters?.() || {};
  if (!parameters.encodings?.length) parameters.encodings = [{}];
  parameters.encodings[0].maxBitrate = profile.bitrate;
  parameters.encodings[0].maxFramerate = profile.fps;
  parameters.degradationPreference = 'maintain-resolution';
  try { await sender.setParameters(parameters); } catch { /* browser applies its own congestion control */ }
}

export async function createSfuPublisher({ stream, profile, token, apiBase = '', iceServers = [], fetchImpl = globalThis.fetch, RTCPeerConnectionClass = RTCPeerConnection, timeoutMs, onDisconnect, simulcast = true } = {}) {
  const { sessionId } = await sfuRequest({ apiBase, token, operation: 'session', fetchImpl });
  const peer = createPeer(RTCPeerConnectionClass, iceServers);
  const encodingsFor = (track, shape) => (track.kind === 'video' ? videoEncodings(track, shape, { simulcast }) : undefined);
  try {
    const transceivers = stream.getTracks().map((track) => {
      const sendEncodings = encodingsFor(track, profile);
      return peer.addTransceiver(track, sendEncodings ? { direction: 'sendonly', sendEncodings } : { direction: 'sendonly' });
    });
    for (const { sender } of transceivers) if (sender.track?.kind === 'video') await limitVideoSender(sender, profile);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const tracks = transceivers.map(({ mid, sender }) => ({ mid, trackName: sender.track.id, kind: sender.track.kind }));
    const published = await sfuRequest({ apiBase, token, operation: 'publish', fetchImpl, body: { sessionId, sessionDescription: { type: 'offer', sdp: offer.sdp }, tracks } });
    await peer.setRemoteDescription(published.sessionDescription);
    await waitForConnection(peer, timeoutMs);
    const stopMonitoring = monitorConnection(peer, onDisconnect);
    let stopQuality = profile.automatic && !simulcast ? monitorQuality(peer, profile) : () => {};
    let closed = false;
    let audienceRevision = 0;
    let audienceMode;
    let audiencePending;
    return {
      peer,
      sessionId,
      mediaToken: published.mediaToken,
      tracks: published.tracks,
      async replaceVideoTrack(track) {
        if (closed) throw new Error('Publisher closed');
        const sender = transceivers.find(({ sender }) => sender.track?.kind === 'video')?.sender;
        if (!sender) throw new Error('Video sender unavailable');
        stopQuality();
        await sender.replaceTrack(track);
        const active = audienceMode;
        audienceMode = undefined;
        // The source is already replaced: a rejected browser bitrate hint must
        // not make the caller stop the track that is now being transmitted.
        await this.setAudience(active === false ? 0 : 1).catch(() => {});
      },
      async setAudience(count) {
        const active = count > 0;
        if (audienceMode === active) return audiencePending;
        audienceMode = active;
        const revision = ++audienceRevision;
        stopQuality();
        audiencePending = Promise.all(transceivers.map(({ sender }) => updateSender(sender, (parameters) => {
          if (closed || revision !== audienceRevision) return false;
          if (!parameters.encodings?.length) throw new Error('Sender encodings unavailable');
          const idle = count === 0;
          const wanted = sender.track.kind === 'video'
            ? videoEncodings(sender.track, idle ? { width: 320, height: 180, bitrate: 40_000, fps: 1 } : profile, { simulcast })
            : null;
          for (const [index, encoding] of parameters.encodings.entries()) {
            if (wanted) applyEncoding(encoding, wanted[index] ?? wanted[wanted.length - 1]);
            else encoding.maxBitrate = idle ? 6_000 : 96_000;
          }
        }))).then(() => {
          // With simulcast the SFU already picks a layer per viewer; pinning sender
          // parameters here would flatten the layers it chooses between.
          if (!closed && revision === audienceRevision && active && profile.automatic && !simulcast) stopQuality = monitorQuality(peer, profile);
        }).catch((error) => {
          if (revision === audienceRevision) audienceMode = undefined;
          throw error;
        });
        return audiencePending;
      },
      close() {
        closed = true;
        const mids = transceivers.map(({ mid }) => mid).filter(Boolean);
        void sfuRequest({ apiBase, token, operation: 'close', fetchImpl, keepalive: true, body: { sessionId, mids } }).catch(() => {});
        stopMonitoring();
        stopQuality();
        peer.close();
      },
    };
  } catch (error) {
    peer.close();
    throw error;
  }
}

export async function createSfuViewer({ mediaToken, video, token, apiBase = '', iceServers = [], fetchImpl = globalThis.fetch, RTCPeerConnectionClass = RTCPeerConnection, MediaStreamClass = MediaStream, timeoutMs, onDisconnect, isCurrent = () => true } = {}) {
  const checkCurrent = () => { if (!isCurrent()) throw new Error('Subscription replaced'); };
  const { sessionId } = await sfuRequest({ apiBase, token, operation: 'session', fetchImpl });
  checkCurrent();
  const peer = createPeer(RTCPeerConnectionClass, iceServers);
  const media = new MediaStreamClass();
  const receivedMids = [];
  let resolveVideoTrack;
  let rejectVideoTrack;
  const videoTrackReceived = new Promise((resolve, reject) => { resolveVideoTrack = resolve; rejectVideoTrack = reject; });
  void videoTrackReceived.catch(() => {});
  let videoTrackTimeout;
  video.srcObject = media;
  peer.addEventListener('track', ({ transceiver, track }) => {
    if (!isCurrent()) { track.stop?.(); return; }
    if (transceiver?.mid) receivedMids.push(transceiver.mid);
    media.addTrack(track);
    if (track.kind === 'video') { clearTimeout(videoTrackTimeout); resolveVideoTrack(track); }
    void video.play?.().catch(() => {});
  });
  try {
    const pulled = await sfuRequest({ apiBase, token, operation: 'subscribe', fetchImpl, body: { sessionId, mediaToken } });
    checkCurrent();
    if (!pulled.sessionDescription) throw new Error('Cloudflare SFU returned no subscription offer');
    videoTrackTimeout = setTimeout(() => rejectVideoTrack(new Error('Cloudflare SFU video timeout')), timeoutMs || CONNECTION_TIMEOUT_MS);
    await peer.setRemoteDescription(pulled.sessionDescription);
    checkCurrent();
    if (pulled.requiresImmediateRenegotiation) {
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await sfuRequest({ apiBase, token, operation: 'renegotiate', fetchImpl, body: { sessionId, sessionDescription: { type: 'answer', sdp: answer.sdp } } });
    }
    await waitForConnection(peer, timeoutMs);
    await videoTrackReceived;
    checkCurrent();
    await video.play?.().catch(() => {});
    const stopMonitoring = monitorConnection(peer, onDisconnect);
    return {
      peer,
      sessionId,
      media,
      close() {
        const mids = [...new Set(receivedMids)];
        void sfuRequest({ apiBase, token, operation: 'close', fetchImpl, keepalive: true, body: { sessionId, mids } }).catch(() => {});
        stopMonitoring();
        peer.close();
        for (const track of media.getTracks()) track.stop?.();
        if (video.srcObject === media) { video.pause?.(); video.srcObject = null; }
      },
    };
  } catch (error) {
    clearTimeout(videoTrackTimeout);
    peer.close();
    for (const track of media.getTracks()) track.stop?.();
    if (video.srcObject === media) video.srcObject = null;
    throw error;
  }
}
