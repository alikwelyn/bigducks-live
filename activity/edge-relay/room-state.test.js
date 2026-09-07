import { describe, expect, it } from 'vitest';
import { allocatePublisherSlot, selectWatchedSlot } from './room-state.js';

describe('edge room state', () => {
  it('allocates at most three publisher slots', () => {
    expect(allocatePublisherSlot([])).toBe(0);
    expect(allocatePublisherSlot([0, 2])).toBe(1);
    expect(allocatePublisherSlot([0, 1, 2])).toBeNull();
  });

  it('keeps exactly one watched stream', () => {
    expect(selectWatchedSlot(0)).toBe(0);
    expect(selectWatchedSlot(2)).toBe(2);
    expect(() => selectWatchedSlot(256)).toThrow(/slot/i);
  });
});
