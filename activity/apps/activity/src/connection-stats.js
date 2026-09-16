const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const maxKnown = (left, right) => right === null ? left : left === null ? right : Math.max(left, right);

function intervalDelay(current, before, total, count) {
  if (!before || ![current[total], before[total], current[count], before[count]].every(finite)) return null;
  const emitted = current[count] - before[count];
  const duration = current[total] - before[total];
  return emitted > 0 && duration >= 0 ? 1000 * duration / emitted : null;
}

// Receiver-local measurements, not a claim of end-to-end capture latency.
// Only retain counters: do not retain candidate IPs, SDP, credentials or user IDs.
export function connectionStats(reports, previous = new Map()) {
  const result = { previous: new Map(), videoBufferMs: null, audioBufferMs: null, decodeMs: null, videoFps: null, rttMs: null };
  for (const [id, report] of reports) {
    if (report.type === 'transport' && report.selectedCandidatePairId) {
      const pair = reports.get(report.selectedCandidatePairId);
      if (finite(pair?.currentRoundTripTime)) result.rttMs = maxKnown(result.rttMs, pair.currentRoundTripTime * 1000);
    }
    if (report.type !== 'inbound-rtp' || report.isRemote) continue;
    const kind = report.kind || report.mediaType;
    if (!['audio', 'video'].includes(kind)) continue;
    const counters = { jitterBufferDelay: report.jitterBufferDelay, jitterBufferEmittedCount: report.jitterBufferEmittedCount, totalDecodeTime: report.totalDecodeTime, framesDecoded: report.framesDecoded };
    const before = previous.get(id);
    result.previous.set(id, counters);
    const key = kind === 'video' ? 'videoBufferMs' : 'audioBufferMs';
    result[key] = maxKnown(result[key], intervalDelay(counters, before, 'jitterBufferDelay', 'jitterBufferEmittedCount'));
    if (kind === 'video') {
      result.decodeMs = maxKnown(result.decodeMs, intervalDelay(counters, before, 'totalDecodeTime', 'framesDecoded'));
      if (finite(report.framesPerSecond)) result.videoFps = maxKnown(result.videoFps, report.framesPerSecond);
    }
  }
  return result;
}
