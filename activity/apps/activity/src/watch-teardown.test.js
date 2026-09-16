import { expect, it, vi } from 'vitest';
import { releasePlayback } from './watch-teardown.js';

const video = () => ({ style: {}, srcObject: { id: 'stream' }, pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn() });

it('detaches the stream, drops the source and returns the stage to the canvas', () => {
  const element = video(); const canvas = { style: { display: 'none' } };
  releasePlayback({ video: element, canvas });
  expect(element.pause).toHaveBeenCalledOnce();
  expect(element.srcObject).toBeNull();
  expect(element.removeAttribute).toHaveBeenCalledWith('src');
  expect(element.load).toHaveBeenCalledOnce();
  expect(element.style.display).toBe('none');
  expect(canvas.style.display).toBe('block');
});

it('drops the source before reloading it', () => {
  const element = video();
  releasePlayback({ video: element });
  expect(element.removeAttribute.mock.invocationCallOrder[0]).toBeLessThan(element.load.mock.invocationCallOrder[0]);
});

it('keeps going when one step fails instead of leaving the stream attached', () => {
  const element = video();
  element.pause = () => { throw new Error('already detached'); };
  expect(() => releasePlayback({ video: element })).not.toThrow();
  expect(element.srcObject).toBeNull();
  expect(element.removeAttribute).toHaveBeenCalledWith('src');
  expect(element.load).toHaveBeenCalledOnce();
});

it('tolerates missing elements and elements without the media API', () => {
  expect(() => releasePlayback({})).not.toThrow();
  const bare = { style: {} };
  expect(() => releasePlayback({ video: bare })).not.toThrow();
  expect(bare.style.display).toBe('none');
});
