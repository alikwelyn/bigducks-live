import { expect, it } from 'vitest';
import { GRACE_MS, KEEPALIVE_MS, dropExpiredLeases, findLeaseForUser, isLeaseExpired, nextWakeAt, reclaimSlot, upsertLease } from './session-lease.js';

it('keeps one lease per user so a returning publisher reclaims its slot', () => {
  let leases = new Map();
  leases = upsertLease(leases, { user: 'ana', slot: 2, name: 'Ana', until: 1000 });
  expect(findLeaseForUser(leases, 'ana')).toMatchObject({ slot: 2 });
  leases = upsertLease(leases, { user: 'ana', slot: 0, name: 'Ana', until: 2000 });
  expect(leases.size).toBe(1);
  expect(findLeaseForUser(leases, 'ana')).toMatchObject({ slot: 0 });
  expect(findLeaseForUser(leases, 'bruno')).toBeNull();
});

it('expires a lease only after its deadline', () => {
  const lease = { user: 'ana', slot: 0, until: 1000 };
  expect(isLeaseExpired(lease, 999)).toBe(false);
  expect(isLeaseExpired(lease, 1000)).toBe(true);
  expect(isLeaseExpired(null)).toBe(false);
});

it('separates expired leases and reports the next wake', () => {
  const leases = new Map([['0', { user: 'ana', slot: 0, until: 1000 }], ['1', { user: 'bruno', slot: 1, until: 5000 }]]);
  const { kept, expired } = dropExpiredLeases(leases, 2000);
  expect(expired.map((lease) => lease.user)).toEqual(['ana']);
  expect([...kept.keys()]).toEqual(['1']);
});

it('wakes for the keepalive while a socket is connected, and for leases otherwise', () => {
  const now = 1_000_000;
  expect(nextWakeAt({ now, leases: new Map(), hasSockets: true })).toBe(now + KEEPALIVE_MS);
  expect(nextWakeAt({ now, leases: new Map([['0', { user: 'a', slot: 0, until: now + 500 }]]), hasSockets: false })).toBe(now + 500);
  const both = nextWakeAt({ now, leases: new Map([['0', { user: 'a', slot: 0, until: now + KEEPALIVE_MS * 2 }]]), hasSockets: true });
  expect(both).toBe(now + KEEPALIVE_MS);
  expect(nextWakeAt({ now, leases: new Map(), hasSockets: false })).toBeNull();
  expect(GRACE_MS).toBeGreaterThan(KEEPALIVE_MS);
});

it('returns the reserved slot to its owner and falls back to allocation', () => {
  const leases = new Map([['2', { user: 'ana', slot: 2, until: Date.now() + 1000 }]]);
  const allocate = (taken) => [0, 1, 2, 3].find((slot) => !taken.includes(slot)) ?? null;
  expect(reclaimSlot({ leases, taken: [0], user: 'ana', allocate })).toMatchObject({ slot: 2 });
  expect(reclaimSlot({ leases, taken: [0, 2], user: 'ana', allocate })).toMatchObject({ slot: 1, lease: null });
  expect(reclaimSlot({ leases, taken: [0], user: 'bruno', allocate })).toMatchObject({ slot: 1, lease: null });
  expect(reclaimSlot({ leases: new Map(), taken: [0, 1, 2], user: 'ana', allocate })).toMatchObject({ slot: 3 });
  expect(reclaimSlot({ leases: new Map(), taken: [0, 1, 2, 3], user: 'ana', allocate })).toMatchObject({ slot: null });
});
