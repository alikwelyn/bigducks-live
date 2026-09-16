import { afterEach, expect, it, vi } from 'vitest';
import { createBroadcaster } from './media.js';
import { decodePacket, AUDIO, VIDEO_KEYFRAME } from './protocol.js';

afterEach(() => vi.unstubAllGlobals());
it('drops already encoded audio and video while the socket is congested or stopped', async () => {
  class Encoder {
    encodeQueueSize = 0;
    constructor(callbacks) { this.callbacks = callbacks; }
    static async isConfigSupported(config) { return { supported: true, config }; }
    configure() {} encode() {} close() {}
  }
  vi.stubGlobal('VideoEncoder', Encoder); vi.stubGlobal('AudioEncoder', Encoder);
  vi.stubGlobal('MediaStreamTrackProcessor', class {
    constructor({ track }) {
      let first = track.kind === 'video'; let resolve;
      this.readable = { getReader: () => ({
        read: () => { if (first) { first = false; return Promise.resolve({ value: { displayWidth: 1280, displayHeight: 720, close() {} } }); } return new Promise((done) => { resolve = done; }); },
        cancel: () => { resolve?.({ done: true }); return Promise.resolve(); },
      }) };
    }
  });
  const video = { kind: 'video', getSettings: () => ({ width: 1280, height: 720 }), addEventListener() {} };
  const audio = { kind: 'audio', getSettings: () => ({ sampleRate: 48000, channelCount: 2 }) };
  const stream = { getVideoTracks: () => [video], getAudioTracks: () => [audio] };
  const ws = { readyState: 1, bufferedAmount: 300000, send: vi.fn() };
  const broadcaster = await createBroadcaster({ ws, stream, audio: true, stopTracks: false, profile: { width: 1280, height: 720, fps: 30, bitrate: 2500000 } });
  const chunk = { type: 'key', timestamp: 123, byteLength: 1, copyTo(bytes) { bytes[0] = 1; } };
  broadcaster.audioEncoder.callbacks.output(chunk);
  broadcaster.encoder.callbacks.output(chunk);
  expect(ws.send).not.toHaveBeenCalled();
  ws.bufferedAmount = 0;
  broadcaster.encoder.callbacks.output({ ...chunk, type: 'delta' });
  expect(ws.send).not.toHaveBeenCalled();
  broadcaster.audioEncoder.callbacks.output(chunk);
  broadcaster.encoder.callbacks.output(chunk);
  expect(ws.send.mock.calls.map(([raw]) => decodePacket(raw).type)).toEqual([AUDIO, VIDEO_KEYFRAME]);
  broadcaster.stop();
  broadcaster.audioEncoder.callbacks.output(chunk);
  expect(ws.send).toHaveBeenCalledTimes(2);
});
