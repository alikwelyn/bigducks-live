import { expect, it, vi } from 'vitest';
import { releasePlayback } from './watch-teardown.js';

const video = () => ({ style: {}, srcObject: { id: 'stream' }, pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn() });

it('fully detaches the previous stream so its last frame cannot survive a teardown', () => {
  const element = video(); const canvas = { style: { display: 'none' } };
  releasePlayback({ video: element, canvas });
  expect(element.pause).toHaveBeenCalledOnce();
  expect(element.srcObject).toBeNull();
  expect(element.removeAttribute).toHaveBeenCalledWith('src');
  expect(element.load).toHaveBeenCalledOnce();
  expect(element.style.display).toBe('none');
  expect(canvas.style.display).toBe('block');
});

it('tolerates a teardown with missing elements or a paused media element', () => {
  expect(() => releasePlayback({})).not.toThrow();
  const element = video();
  element.pause = () => { throw new Error('already detached'); };
  expect(() => releasePlayback({ video: element })).not.toThrow();
  expect(element.srcObject).toBeNull();
});

it('releases a native video element that has no MediaStream attached', () => {
  const element = video(); element.srcObject = null;
  releasePlayback({ video: element, canvas: null });
  expect(element.load).toHaveBeenCalledOnce();
  expect(element.removeAttribute).toHaveBeenCalledWith('src');
});
