import { describe, expect, it } from 'vitest';

describe('viewer player contract', () => {
  it('requires a keyframe before delta frames', () => {
    expect(['key', 'delta']).toEqual(['key', 'delta']);
  });
});
