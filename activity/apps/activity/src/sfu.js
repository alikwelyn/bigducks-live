const CONNECTION_TIMEOUT_MS = 10_000;

export async function sfuRequest({ apiBase = '', token, operation, body, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(`${apiBase}/api/sfu/${operation}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
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

async function limitVideoSender(sender, profile) {
  if (!sender?.setParameters) return;
  const parameters = sender.getParameters?.() || {};
  if (!parameters.encodings?.length) parameters.encodings = [{}];
  parameters.encodings[0].maxBitrate = profile.bitrate;
  parameters.encodings[0].maxFramerate = profile.fps;
  parameters.degradationPreference = 'maintain-resolution';
  try { await sender.setParameters(parameters); } catch { /* browser applies its own congestion control */ }
}

export async function createSfuPublisher({ stream, profile, token, apiBase = '', iceServers = [], fetchImpl = globalThis.fetch, RTCPeerConnectionClass = RTCPeerConnection, timeoutMs, onDisconnect } = {}) {
  const { sessionId } = await sfuRequest({ apiBase, token, operation: 'session', fetchImpl });
  const peer = createPeer(RTCPeerConnectionClass, iceServers);
  try {
    const transceivers = stream.getTracks().map((track) => peer.addTransceiver(track, track.kind === 'video'
      ? { direction: 'sendonly', sendEncodings: [videoEncoding(track, profile)] }
      : { direction: 'sendonly' }));
    for (const { sender } of transceivers) if (sender.track?.kind === 'video') await limitVideoSender(sender, profile);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const tracks = transceivers.map(({ mid, sender }) => ({ mid, trackName: sender.track.id, kind: sender.track.kind }));
    const published = await sfuRequest({ apiBase, token, operation: 'publish', fetchImpl, body: { sessionId, sessionDescription: { type: 'offer', sdp: offer.sdp }, tracks } });
    await peer.setRemoteDescription(published.sessionDescription);
    await waitForConnection(peer, timeoutMs);
    const stopMonitoring = monitorConnection(peer, onDisconnect);
    return {
      peer,
      sessionId,
      mediaToken: published.mediaToken,
      tracks: published.tracks,
      close() {
        const mids = transceivers.map(({ mid }) => mid).filter(Boolean);
        void sfuRequest({ apiBase, token, operation: 'close', fetchImpl, body: { sessionId, mids } }).catch(() => {});
        stopMonitoring();
        peer.close();
      },
    };
  } catch (error) {
    peer.close();
    throw error;
  }
}

export async function createSfuViewer({ mediaToken, video, token, apiBase = '', iceServers = [], fetchImpl = globalThis.fetch, RTCPeerConnectionClass = RTCPeerConnection, MediaStreamClass = MediaStream, timeoutMs, onDisconnect } = {}) {
  const { sessionId } = await sfuRequest({ apiBase, token, operation: 'session', fetchImpl });
  const peer = createPeer(RTCPeerConnectionClass, iceServers);
  const media = new MediaStreamClass();
  const receivedMids = [];
  let resolveVideoTrack;
  let rejectVideoTrack;
  const videoTrackReceived = new Promise((resolve, reject) => { resolveVideoTrack = resolve; rejectVideoTrack = reject; });
  let videoTrackTimeout;
  video.srcObject = media;
  peer.addEventListener('track', ({ transceiver, track }) => {
    if (transceiver?.mid) receivedMids.push(transceiver.mid);
    media.addTrack(track);
    if (track.kind === 'video') { clearTimeout(videoTrackTimeout); resolveVideoTrack(track); }
    void video.play?.().catch(() => {});
  });
  try {
    const pulled = await sfuRequest({ apiBase, token, operation: 'subscribe', fetchImpl, body: { sessionId, mediaToken } });
    if (!pulled.sessionDescription) throw new Error('Cloudflare SFU returned no subscription offer');
    videoTrackTimeout = setTimeout(() => rejectVideoTrack(new Error('Cloudflare SFU video timeout')), timeoutMs || CONNECTION_TIMEOUT_MS);
    await peer.setRemoteDescription(pulled.sessionDescription);
    if (pulled.requiresImmediateRenegotiation) {
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await sfuRequest({ apiBase, token, operation: 'renegotiate', fetchImpl, body: { sessionId, sessionDescription: { type: 'answer', sdp: answer.sdp } } });
    }
    await waitForConnection(peer, timeoutMs);
    await videoTrackReceived;
    await video.play?.().catch(() => {});
    const stopMonitoring = monitorConnection(peer, onDisconnect);
    return {
      peer,
      sessionId,
      media,
      close() {
        const mids = [...new Set(receivedMids)];
        void sfuRequest({ apiBase, token, operation: 'close', fetchImpl, body: { sessionId, mids } }).catch(() => {});
        stopMonitoring();
        peer.close();
        for (const track of media.getTracks()) track.stop?.();
        video.pause?.();
        video.srcObject = null;
      },
    };
  } catch (error) {
    clearTimeout(videoTrackTimeout);
    peer.close();
    video.srcObject = null;
    throw error;
  }
}
