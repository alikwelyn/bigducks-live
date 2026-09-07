import { describe, expect, it } from 'vitest';
import { PROFILES, chooseAdaptiveProfile, profileFor } from './adaptation.js';

describe('quality adaptation', () => {
  it('exposes the selectable profiles with a low-latency default', () => {
    expect(PROFILES.map(({ name }) => name)).toEqual(['720p30', '720p60', '1080p30', '1080p60']);
    expect(profileFor('720p30')).toMatchObject({ width: 1280, height: 720, fps: 30, bitrate: 2_500_000 });
    expect(profileFor('1080p30')).toMatchObject({ width: 1920, height: 1080, fps: 30 });
  });

  it('downgrades under loss and latency, then recovers gradually', () => {
    expect(chooseAdaptiveProfile('1080p60', { loss: 0.12, rtt: 450, encodeQueue: 3 })).toBe('720p60');
    expect(chooseAdaptiveProfile('720p30', { loss: 0, rtt: 40, encodeQueue: 0, healthyForMs: 12000 })).toBe('720p60');
    expect(chooseAdaptiveProfile('720p60', { loss: 0, rtt: 40, encodeQueue: 0, healthyForMs: 12000 })).toBe('1080p30');
    expect(chooseAdaptiveProfile('1080p30', { loss: 0, rtt: 40, encodeQueue: 0, healthyForMs: 12000 })).toBe('1080p60');
  });
});
