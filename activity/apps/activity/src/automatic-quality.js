import { updateSender } from './sender-parameters.js';

export function nextQuality(state, congested) {
  if (congested) return { level: Math.max(0, state.level - 1), healthy: 0 };
  const healthy = state.healthy + 1;
  return healthy >= 6 ? { level: Math.min(2, state.level + 1), healthy: 0 } : { ...state, healthy };
}

export function monitorQuality(peer, profile) {
  let state = { level: 2, healthy: 0 };
  let stopped = false;
  let timer;
  const sample = async () => {
    try {
      const stats = await peer.getStats();
      let outbound;
      stats.forEach((report) => { if (report.type === 'outbound-rtp' && (report.kind || report.mediaType) === 'video' && !report.isRemote) outbound = report; });
      if (outbound && !stopped) {
        const next = nextQuality(state, ['bandwidth', 'cpu'].includes(outbound.qualityLimitationReason));
        if (next.level !== state.level) {
          for (const sender of peer.getSenders()) {
            if (sender.track?.kind !== 'video' || stopped) continue;
            await updateSender(sender, (p) => {
              if (stopped || !p.encodings?.length) return false;
              const settings = sender.track.getSettings();
              const base = Math.max(1, (settings.width || profile.width) / profile.width, (settings.height || profile.height) / profile.height);
              const factor = [2, 1.5, 1][next.level];
              p.encodings[0].scaleResolutionDownBy = base * factor;
              p.encodings[0].maxBitrate = Math.round(profile.bitrate * [0.3, 0.6, 1][next.level]);
              p.encodings[0].maxFramerate = Math.min(profile.fps, [20, 25, 30][next.level]);
            });
          }
        }
        state = next;
      }
    } catch { /* stats or encoder changes can be unavailable during renegotiation */ }
    if (!stopped) timer = setTimeout(sample, 5000);
  };
  timer = setTimeout(sample, 5000);
  return () => { stopped = true; clearTimeout(timer); };
}
