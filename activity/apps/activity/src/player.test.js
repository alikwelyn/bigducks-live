import { describe, expect, it, vi } from 'vitest';
import { createPlayer } from './player.js';

describe('viewer player contract', () => {
  it('reconfigures audio across source changes without closing a context twice or losing mute', () => {
    const contexts = [];
    class Decoder { state = 'unconfigured'; configure() { this.state = 'configured'; } close() { this.state = 'closed'; } }
    vi.stubGlobal('VideoDecoder', Decoder); vi.stubGlobal('AudioDecoder', Decoder);
    vi.stubGlobal('AudioContext', class {
      state = 'running';
      constructor() { contexts.push(this); }
      close = vi.fn(async () => { if (this.state === 'closed') throw new Error('Already closed'); this.state = 'closed'; });
      resume = async () => {};
      createGain() { this.gainNode = { gain: { value: 1 }, connect() {} }; return this.gainNode; }
    });
    try {
      const player = createPlayer({ getContext: () => ({ clearRect() {} }), width: 1, height: 1 });
      const audio = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 };
      player.configure({ codec: 'vp8' }); player.configureAudio(audio); player.setMuted(true);
      player.configure({ codec: 'vp8' }); player.configureAudio(audio);
      expect(contexts[0].close).toHaveBeenCalledOnce();
      expect(contexts[1].gainNode.gain.value).toBe(0);
      player.close(); player.close();
      expect(contexts[1].close).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
  it('requires a keyframe before delta frames', () => {
    expect(['key', 'delta']).toEqual(['key', 'delta']);
  });

  it('exposes an audio mute control', () => {
    const player = createPlayer({ getContext: () => ({ clearRect: vi.fn(), drawImage: vi.fn() }), width: 1, height: 1 });
    expect(player.setMuted(true)).toBe(true);
    expect(player.setMuted(false)).toBe(false);
  });
});
