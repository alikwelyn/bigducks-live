export const MAX_PUBLISHERS = 3;
export const MAX_VIEWERS = 25;
export const MAX_BUFFERED_BYTES = 256 * 1024;

export function allocatePublisherSlot(usedSlots, limit = MAX_PUBLISHERS) {
  const used = new Set(usedSlots);
  for (let slot = 0; slot < limit; slot++) if (!used.has(slot)) return slot;
  return null;
}

export function selectWatchedSlot(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 255) throw new Error('invalid stream slot');
  return slot;
}
