import { afterEach, expect, it, vi } from 'vitest';
import { createCaptureContinuity } from './capture-continuity.js';

class Track extends EventTarget {
  constructor(kind = 'video') { super(); this.kind = kind; this.readyState = 'live'; }
  stop() { this.readyState = 'ended'; }
}
class Stream {
  constructor(tracks = [new Track()]) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  addTrack(track) { this.tracks.push(track); }
  removeTrack(track) { this.tracks = this.tracks.filter(t => t !== track); }
}
class Audio {
  createMediaStreamDestination() { return { stream: new Stream([new Track('audio')]) }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  async resume() {}
  async close() {}
}
function setup(initial = new Stream(), options = {}) {
  vi.stubGlobal('MediaStream', Stream);
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ fillRect() {}, fillText() {} }), captureStream: () => new Stream() }) });
  return createCaptureContinuity(initial, { AudioContextClass: Audio, ...options });
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('keeps audio and output stream stable through source end, placeholder and game replacement', async () => {
  vi.useFakeTimers();
  const client = new Stream([new Track(), new Track('audio')]);
  const onReplace = vi.fn(); const onWaiting = vi.fn();
  const continuity = setup(client, { onReplace, onWaiting });
  const output = continuity.stream; const audio = output.getAudioTracks()[0];
  client.getVideoTracks()[0].stop(); client.getVideoTracks()[0].dispatchEvent(new Event('ended'));
  await vi.waitFor(() => expect(onReplace).toHaveBeenCalledOnce());
  expect(continuity.waiting).toBe(true);
  expect(onWaiting).toHaveBeenCalledOnce();
  const game = new Stream();
  await continuity.replace(game);
  expect(continuity.stream).toBe(output);
  expect(output.getAudioTracks()[0]).toBe(audio);
  expect(output.getVideoTracks()[0]).toBe(game.getVideoTracks()[0]);
  expect(continuity.waiting).toBe(false);
  expect(client.getAudioTracks()[0].readyState).toBe('ended');
  expect(vi.getTimerCount()).toBe(0);
  continuity.close();
  expect(audio.readyState).toBe('ended');
});

it('preserves the previous source on failed replacement and stops a late picker result after closing', async () => {
  const original = new Stream();
  const continuity = setup(original, { onReplace: async () => { throw new Error('replace failed'); } });
  const failed = new Stream();
  await expect(continuity.replace(failed)).rejects.toThrow('replace failed');
  expect(original.getVideoTracks()[0].readyState).toBe('live');
  expect(failed.getVideoTracks()[0].readyState).toBe('ended');
  continuity.close();
  const late = new Stream();
  expect(await continuity.replace(late)).toBe(false);
  expect(late.getVideoTracks()[0].readyState).toBe('ended');
});
