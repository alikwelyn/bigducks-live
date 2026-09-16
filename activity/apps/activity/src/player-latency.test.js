import { afterEach, expect, it, vi } from 'vitest';
import { createPlayer } from './player.js';
import { encodePacket, VIDEO_KEYFRAME, VIDEO_DELTA, AUDIO } from '../../../shared/protocol.js';

const packet = (type, clock = 0) => encodePacket({ slot: 0, type, sentAt: 0, clock, payload: new Uint8Array([1]) });
function harness() {
  const decoders = [];
  class Decoder {
    state = 'unconfigured'; decodeQueueSize = 0; chunks = [];
    constructor(callbacks) { this.callbacks = callbacks; decoders.push(this); }
    configure() { this.state = 'configured'; }
    decode(chunk) { this.chunks.push(chunk); this.decodeQueueSize++; }
    reset() { this.decodeQueueSize = 0; this.state = 'unconfigured'; }
    close() { this.state = 'closed'; }
  }
  vi.stubGlobal('VideoDecoder', Decoder);
  vi.stubGlobal('EncodedVideoChunk', class { constructor(input) { Object.assign(this, input); } });
  vi.stubGlobal('EncodedAudioChunk', class { constructor(input) { Object.assign(this, input); } });
  let now = 0; const frames = new Map(); let frameId = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (fn) => { frames.set(++frameId, fn); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id) => frames.delete(id));
  const painted = [];
  const canvas = { width: 1, height: 1, style: {}, getContext: () => ({ clearRect() {}, drawImage(frame) { painted.push(frame.timestamp); } }) };
  const onResync = vi.fn();
  const player = createPlayer(canvas, { onResync });
  player.configure({ codec: 'vp8' });
  return { player, decoder: decoders[0], decoders, Decoder, onResync, painted, tick(time) { now = time; const work = [...frames.values()]; frames.clear(); work.forEach((fn) => fn()); } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('bounds pending encoded video and recovers only at a keyframe under overload', () => {
  const { player, decoder, onResync } = harness();
  player.push(packet(VIDEO_KEYFRAME));
  for (let i = 1; i <= 200; i++) player.push(packet(VIDEO_DELTA, i * 33000));
  expect(decoder.decodeQueueSize).toBeLessThanOrEqual(4);
  expect(onResync).toHaveBeenCalledOnce();
  const admitted = decoder.chunks.length;
  player.push(packet(VIDEO_DELTA, 7000000));
  expect(decoder.chunks).toHaveLength(admitted);
  player.push(packet(VIDEO_KEYFRAME, 8000000));
  expect(decoder.chunks.at(-1).timestamp).toBe(8000000);
  player.close();
});

it('bounds pending audio without waiting for video recovery', () => {
  const { player, Decoder, decoders } = harness();
  vi.stubGlobal('AudioDecoder', Decoder);
  vi.stubGlobal('AudioContext', class {
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  });
  player.configureAudio({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
  const audio = decoders.at(-1);
  for (let i = 0; i < 200; i++) player.push(packet(AUDIO, i * 20000));
  expect(audio.decodeQueueSize).toBeLessThanOrEqual(8);
  expect(audio.chunks.at(-1).timestamp).toBe(199 * 20000);
  player.close();
});

it('rebases a forward timestamp jump instead of presenting a minute in the future', () => {
  const { player, decoder, tick, painted } = harness();
  const old = { timestamp: 0, displayWidth: 640, displayHeight: 360, close: vi.fn() };
  const current = { timestamp: 60_000_000, displayWidth: 640, displayHeight: 360, close: vi.fn() };
  decoder.callbacks.output(old);
  decoder.callbacks.output(current);
  tick(100);
  expect(painted).toEqual([60_000_000]);
  expect(old.close).toHaveBeenCalledOnce();
  expect(current.close).toHaveBeenCalledOnce();
  player.close();
});
