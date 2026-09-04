import { describe, expect, it } from 'vitest';
import { ICE_DEFAULT, FALLBACK_MS, shouldFallback } from './rtc.js';

describe('direct RTC transport', () => {
  it('has a public STUN fallback and bounded activation deadline', () => {
    expect(ICE_DEFAULT[0].urls).toMatch(/^stun:/);
    expect(FALLBACK_MS).toBe(8000);
  });

  it('falls back until a real frame activates RTC', () => {
    expect(shouldFallback({ state: 'connected', gotFrame: false, elapsed: 8001 })).toBe(true);
    expect(shouldFallback({ state: 'connected', gotFrame: true, elapsed: 1000 })).toBe(false);
    expect(shouldFallback({ state: 'failed', gotFrame: false, elapsed: 100 })).toBe(true);
  });
});
