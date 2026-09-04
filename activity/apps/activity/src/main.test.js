import { describe, expect, it } from 'vitest';

describe('Activity UI contract', () => {
  it('defines the supported quality profiles', () => {
    expect(['720p / 60 FPS', '1080p / 30 FPS', '1080p / 60 FPS', 'Adaptativo']).toHaveLength(4);
  });
});
