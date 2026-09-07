export const ICE_DEFAULT = [{ urls: 'stun:stun.l.google.com:19302' }];
export const FALLBACK_MS = 8000;

export function shouldFallback({ state, gotFrame, elapsed }) {
  return !gotFrame && (['failed', 'closed', 'disconnected'].includes(state) || elapsed >= FALLBACK_MS);
}

export async function fetchIceServers(base = '', token = '') {
  try {
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    const response = await fetch(`${base}/api/ice${query}`);
    const body = response.ok ? await response.json() : null;
    return Array.isArray(body?.iceServers) && body.iceServers.length ? body.iceServers : ICE_DEFAULT;
  } catch {
    return ICE_DEFAULT;
  }
}

export function createPeer({ iceServers = ICE_DEFAULT, onIce, onState, onTrack } = {}) {
  if (typeof RTCPeerConnection !== 'function') throw new Error('WebRTC is not supported');
  const peer = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
  peer.addEventListener('icecandidate', ({ candidate }) => candidate && onIce?.(candidate.toJSON?.() ?? candidate));
  peer.addEventListener('connectionstatechange', () => onState?.(peer.connectionState));
  peer.addEventListener('iceconnectionstatechange', () => peer.iceConnectionState === 'failed' && onState?.('failed'));
  peer.addEventListener('track', (event) => onTrack?.(event));
  return peer;
}

export async function tuneSenders(peer, { bitrate, fps, source = 'screen' } = {}) {
  for (const sender of peer.getSenders()) {
    if (!sender.track) continue;
    const parameters = sender.getParameters();
    parameters.encodings ??= [{}];
    if (sender.track.kind === 'video') {
      parameters.degradationPreference = source === 'screen' ? 'maintain-resolution' : 'maintain-framerate';
      for (const encoding of parameters.encodings) {
        if (bitrate) encoding.maxBitrate = bitrate;
        if (fps) encoding.maxFramerate = fps;
      }
    }
    try { await sender.setParameters(parameters); } catch { /* browser may reject optional tuning */ }
  }
}
