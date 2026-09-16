// Informational accounting only. Nothing here may block, throttle or stop a
// stream: the owner asked for visibility, not a limit.
export const MAX_REPORTED_BYTES = 8 * 1024 * 1024;

export function monthKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 7);
}

// A client-reported figure is a hint, never a fact: drop nonsense and clamp
// so one message cannot inflate the month in a single step.
export function clampReportedBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_REPORTED_BYTES);
}

export function gigabytes(bytes) {
  return Math.round((Math.max(0, bytes) / 1e9) * 100) / 100;
}

export function freshUsage(now = Date.now()) {
  return { month: monthKey(now), relayBytes: 0, sfuBytes: 0, updatedAt: now };
}

export function addUsage(usage, { relay = 0, sfu = 0, now = Date.now() } = {}) {
  // A new month starts a new total, so the figure never mixes billing periods.
  const base = usage && usage.month === monthKey(now) ? usage : freshUsage(now);
  return { month: base.month, relayBytes: base.relayBytes + Math.max(0, relay), sfuBytes: base.sfuBytes + Math.max(0, sfu), updatedAt: now };
}

export function usageSummary(usage, now = Date.now()) {
  const total = usage && usage.month === monthKey(now) ? usage : freshUsage(now);
  const bytes = total.relayBytes + total.sfuBytes;
  return { month: total.month, bytes, gigabytes: gigabytes(bytes) };
}
