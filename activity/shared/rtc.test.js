import { afterEach, describe, expect, it, vi } from 'vitest';
import { ICE_DEFAULT, FALLBACK_MS, MAX_P2P_PEERS, shouldAcceptPeer, shouldFallback, fetchIceServers } from './rtc.js';
afterEach(() => vi.unstubAllGlobals());

describe('direct RTC transport', () => {
  it('keeps ICE credentials out of URLs by using the Authorization header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ iceServers: [{ urls: 'stun:example.test' }] })));
    vi.stubGlobal('fetch', fetchImpl);
    await fetchIceServers('/.proxy', 'private-room-token');
    expect(fetchImpl).toHaveBeenCalledWith('/.proxy/api/ice', { headers: { authorization: 'Bearer private-room-token' } });
  });
  it('caps the direct fan-out but still lets a known viewer replace its own peer', () => {
    expect(shouldAcceptPeer({ size: 0 })).toBe(true);
    expect(shouldAcceptPeer({ size: MAX_P2P_PEERS - 1 })).toBe(true);
    expect(shouldAcceptPeer({ size: MAX_P2P_PEERS })).toBe(false);
    expect(shouldAcceptPeer({ size: MAX_P2P_PEERS, known: true })).toBe(true);
    expect(shouldAcceptPeer({})).toBe(true);
  });

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
