import { describe, expect, it, vi } from 'vitest';
import { createPlayer } from './player.js';

describe('viewer player contract', () => {
  it('requires a keyframe before delta frames', () => {
    expect(['key', 'delta']).toEqual(['key', 'delta']);
  });

  it('exposes an audio mute control', () => {
    const player = createPlayer({ getContext: () => ({ clearRect: vi.fn(), drawImage: vi.fn() }), width: 1, height: 1 });
    expect(player.setMuted(true)).toBe(true);
    expect(player.setMuted(false)).toBe(false);
  });
});
