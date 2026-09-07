const H264_LEVELS = [
  ['1e', 1620, 40500], ['1f', 3600, 108000], ['20', 5120, 216000],
  ['28', 8192, 245760], ['2a', 8704, 522240], ['32', 22080, 589824],
];
const H264_PROFILES = ['6400', '4d40', '42e0'];
export const MAX_WIDTH = 1920;
export const MAX_HEIGHT = 1080;

const even = (value) => Math.max(2, value - (value % 2));

export function fitWithin(width, height) {
  const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
  return { width: even(Math.round(width * scale)), height: even(Math.round(height * scale)) };
}

export function captureConstraints({ fps = 30, width, height, audio = false } = {}) {
  return {
    video: {
      ...(width ? { width: { ideal: width, max: width } } : {}),
      ...(height ? { height: { ideal: height, max: height } } : {}),
      frameRate: { ideal: fps, max: fps },
    },
    audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
  };
}

export function h264Level(width, height, fps) {
  const frameSize = Math.ceil(width / 16) * Math.ceil(height / 16);
  const level = H264_LEVELS.find(([, maxFrameSize, maxMacroblocks]) => frameSize <= maxFrameSize && frameSize * fps <= maxMacroblocks);
  return level?.[0] ?? '32';
}

export function codecCandidates(width, height, fps) {
  const level = h264Level(width, height, fps);
  const h264 = H264_PROFILES.flatMap((profile) => {
    const codec = `avc1.${profile}${level}`;
    return [{ codec, avc: { format: 'annexb' } }, { codec }];
  });
  return [...h264, { codec: 'vp8' }];
}

export function audioConstraints() {
  return { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
}

import { AUDIO, VIDEO_DELTA, VIDEO_KEYFRAME, encodePacket } from './protocol.js';

export async function createBroadcaster({ ws, profile, audio = false, stream = null, slot = 0, onStatus = () => {}, onEnd = () => {} }) {
  if (!stream) stream = await navigator.mediaDevices.getDisplayMedia({ ...captureConstraints({ fps: profile.fps, width: profile.width, height: profile.height, audio }) });
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('screen capture returned no video track');
  track.contentHint = 'text';
  await track.applyConstraints?.({ width: { ideal: profile.width, max: profile.width }, height: { ideal: profile.height, max: profile.height }, frameRate: { ideal: profile.fps, max: profile.fps } });
  const settings = track.getSettings();
  const size = fitWithin(settings.width || profile.width, settings.height || profile.height);
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const payload = new Uint8Array(chunk.byteLength);
      chunk.copyTo(payload);
      ws.send(encodePacket({ slot, type: chunk.type === 'key' ? VIDEO_KEYFRAME : VIDEO_DELTA, sentAt: Date.now(), clock: chunk.timestamp, payload }));
    },
    error: (error) => onEnd(error),
  });
  const codec = codecCandidates(size.width, size.height, profile.fps)[0];
  encoder.configure({ codec: codec.codec, width: size.width, height: size.height, framerate: profile.fps, bitrate: profile.bitrate, latencyMode: 'realtime', avc: codec.avc });
  let stopped = false;
  let forceKeyframe = true;
  let lastKeyframeAt = 0;
  let reader;
  let audioEncoder;
  let audioReader;
  const audioTrack = stream.getAudioTracks()[0];
  if (audio && audioTrack && typeof AudioEncoder === 'function' && typeof MediaStreamTrackProcessor === 'function') {
    audioEncoder = new AudioEncoder({
      output: (chunk) => {
        const payload = new Uint8Array(chunk.byteLength);
        chunk.copyTo(payload);
        ws.send(encodePacket({ slot, type: AUDIO, sentAt: Date.now(), clock: chunk.timestamp, payload }));
      },
      error: (error) => onEnd(error),
    });
    audioEncoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 96_000 });
    const audioProcessor = new MediaStreamTrackProcessor({ track: audioTrack });
    audioReader = audioProcessor.readable.getReader();
    void (async () => {
      try {
        while (!stopped) {
          const { done, value } = await audioReader.read();
          if (done) break;
          if (audioEncoder.encodeQueueSize < 4) audioEncoder.encode(value);
          value.close();
        }
      } catch (error) { if (!stopped) onEnd(error); }
    })();
  }

  const processor = typeof MediaStreamTrackProcessor === 'function' ? new MediaStreamTrackProcessor({ track }) : null;
  const pump = async () => {
    if (!processor) return;
    reader = processor.readable.getReader();
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        if (encoder.encodeQueueSize > 2 || ws.bufferedAmount > 256 * 1024) { value.close(); continue; }
        const now = Date.now();
        const keyFrame = forceKeyframe || now - lastKeyframeAt >= 3000;
        encoder.encode(value, { keyFrame });
        if (keyFrame) lastKeyframeAt = now;
        forceKeyframe = false;
        value.close();
      }
    } catch (error) { if (!stopped) onEnd(error); }
  };
  track.addEventListener('ended', () => { if (!stopped) onEnd(new Error('capture ended')); });
  onStatus({ codec: codec.codec, ...size, fps: profile.fps });
  void pump();
  return { stream, encoder, audioEncoder, requestKeyframe() { forceKeyframe = true; }, stop() { stopped = true; reader?.cancel(); audioReader?.cancel(); encoder.close(); audioEncoder?.close(); stream.getTracks().forEach((item) => item.stop()); } };
}
