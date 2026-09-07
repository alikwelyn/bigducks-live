import { describe, expect, it } from 'vitest';
import { codecCandidates, fitWithin, captureConstraints, h264Level, selectVideoConfig } from './media.js';

describe('media capture helpers', () => {
  it('fits capture dimensions without cropping', () => {
    expect(fitWithin(2560, 1440)).toEqual({ width: 1920, height: 1080 });
    expect(fitWithin(1280, 720)).toEqual({ width: 1280, height: 720 });
  });

  it('creates screen or window capture constraints with optional audio', () => {
    expect(captureConstraints({ fps: 60, width: 1280, height: 720, audio: false })).toMatchObject({ video: { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 60, max: 60 } }, audio: false });
    expect(captureConstraints({ fps: 30, audio: true }).audio).toMatchObject({ echoCancellation: false, noiseSuppression: false });
  });

  it('selects an H264 level and fallback codecs for the requested size', () => {
    expect(h264Level(1920, 1080, 60)).toBe('2a');
    expect(codecCandidates(1920, 1080, 60)[0]).toMatchObject({ codec: 'avc1.64002a' });
    expect(codecCandidates(1920, 1080, 60).at(-1)).toMatchObject({ codec: 'vp8' });
  });

  it('falls back to the first video configuration supported by the browser', async () => {
    const checked = [];
    const config = await selectVideoConfig({ width: 1920, height: 1080, fps: 60, bitrate: 4_000_000 }, async (candidate) => {
      checked.push(candidate.codec);
      return { supported: candidate.codec === 'vp8', config: candidate };
    });
    expect(config.codec).toBe('vp8');
    expect(checked).toContain('avc1.64002a');
  });
});
