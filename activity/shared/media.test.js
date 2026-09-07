import { describe, expect, it, vi } from 'vitest';
import { codecCandidates, fitWithin, frameDisplaySize, captureConstraints, captureMonitor, h264Level, selectVideoConfig } from './media.js';

describe('media capture helpers', () => {
  it('requests monitor capture and optional system audio', () => {
    expect(captureConstraints({ audio: true })).toMatchObject({ video: { displaySurface: 'monitor' }, systemAudio: 'include', surfaceSwitching: 'exclude' });
    expect(captureConstraints({ audio: false })).toMatchObject({ audio: false, systemAudio: 'exclude' });
  });
  it('rejects windows, tabs and unverifiable surfaces and releases all captured tracks', async () => {
    for (const displaySurface of ['window', 'browser', undefined]) {
      const video = { getSettings: () => ({ displaySurface }), stop: vi.fn() }; const audio = { stop: vi.fn() };
      const devices = { getDisplayMedia: vi.fn().mockResolvedValue({ getVideoTracks: () => [video], getTracks: () => [video, audio] }) };
      await expect(captureMonitor({ audio: true }, devices)).rejects.toThrow('Selecione Tela inteira');
      expect(video.stop).toHaveBeenCalledOnce(); expect(audio.stop).toHaveBeenCalledOnce();
    }
  });
  it('accepts a monitor even when the browser does not supply system audio', async () => {
    const stream = { getVideoTracks: () => [{ getSettings: () => ({ displaySurface: 'monitor' }) }] };
    expect(await captureMonitor({ audio: true }, { getDisplayMedia: async () => stream })).toBe(stream);
  });
  it('fits capture dimensions without cropping', () => {
    expect(fitWithin(2560, 1440)).toEqual({ width: 1920, height: 1080 });
    expect(fitWithin(1280, 720)).toEqual({ width: 1280, height: 720 });
  });

  it('creates screen or window capture constraints with optional audio', () => {
    expect(captureConstraints({ fps: 60, width: 1280, height: 720, audio: false })).toMatchObject({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, max: 60 } }, audio: false });
    expect(captureConstraints({ fps: 30, audio: true }).audio).toMatchObject({ echoCancellation: false, noiseSuppression: false });
  });

  it('requests system sound and excludes capture of its own browser surface', () => {
    const constraints = captureConstraints({ fps: 30, audio: true });
    expect(constraints).toMatchObject({
      audio: { restrictOwnAudio: true },
      systemAudio: 'include',
      windowAudio: 'exclude',
      selfBrowserSurface: 'exclude',
    });
  });

  it('selects an H264 level and fallback codecs for the requested size', () => {
    expect(h264Level(1920, 1080, 60)).toBe('2a');
    expect(codecCandidates(1920, 1080, 60)[0]).toMatchObject({ codec: 'avc1.64002a' });
    expect(codecCandidates(1920, 1080, 60).at(-1)).toMatchObject({ codec: 'vp8' });
  });

  it('uses actual frame dimensions instead of stale track settings', () => {
    expect(frameDisplaySize({ displayWidth: 1918, displayHeight: 947 }, { width: 1920, height: 1080 })).toEqual({ width: 1918, height: 947 });
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
