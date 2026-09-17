// Cloudflare closes a WebSocket when nothing travels in either direction, so the
// room has to produce traffic on its own: a backgrounded capture tab has its
// timers throttled by the browser and cannot be relied on to keep itself alive.
export const KEEPALIVE_MS = 30_000;
// A publisher that vanishes is not necessarily gone: a phone changing network or
// a laptop sleeping looks identical to a closed tab for a few seconds.
export const GRACE_MS = 60_000;

export function isLeaseExpired(lease, now = Date.now()) {
  return Boolean(lease) && Number(lease.until) <= now;
}

// Keeps one lease per user so a returning publisher can take its own slot back.
export function upsertLease(leases, { user, slot, name, avatar, until }) {
  const next = new Map(leases);
  for (const [key, lease] of next) if (lease.user === user) next.delete(key);
  next.set(String(slot), { user, slot, name, avatar, until });
  return next;
}

export function findLeaseForUser(leases, user) {
  for (const lease of leases.values()) if (lease.user === user) return lease;
  return null;
}

export function dropExpiredLeases(leases, now = Date.now()) {
  const kept = new Map();
  const expired = [];
  for (const [key, lease] of leases) {
    if (isLeaseExpired(lease, now)) expired.push(lease);
    else kept.set(key, lease);
  }
  return { kept, expired };
}

// The next wake is whichever comes first: the keepalive tick or the end of a lease.
export function nextWakeAt({ now = Date.now(), leases = new Map(), hasSockets = false } = {}) {
  const candidates = [];
  if (hasSockets) candidates.push(now + KEEPALIVE_MS);
  for (const lease of leases.values()) candidates.push(Number(lease.until));
  return candidates.length ? Math.min(...candidates) : null;
}

// A returning publisher takes its reserved slot back when it is still free;
// otherwise it competes for whatever is available.
export function reclaimSlot({ leases, taken = [], user, allocate }) {
  const lease = findLeaseForUser(leases, user);
  if (lease && !taken.includes(lease.slot)) return { slot: lease.slot, lease };
  return { slot: allocate(taken), lease: null };
}
