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

export function captureConstraints({ fps = 30, audio = false } = {}) {
  return {
    video: { frameRate: { ideal: fps, max: fps } },
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

export async function createBroadcaster({ ws, profile, audio = false, stream = null, onStatus = () => {}, onEnd = () => {} }) {
  if (!stream) stream = await navigator.mediaDevices.getDisplayMedia({ ...captureConstraints({ fps: profile.fps, audio }) });
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('screen capture returned no video track');
  track.contentHint = 'text';
  const settings = track.getSettings();
  const size = fitWithin(settings.width || profile.width, settings.height || profile.height);
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const payload = new Uint8Array(chunk.byteLength);
      chunk.copyTo(payload);
      ws.send({ type: chunk.type === 'key' ? 1 : 2, payload, metadata });
    },
    error: (error) => onEnd(error),
  });
  const codec = codecCandidates(size.width, size.height, profile.fps)[0];
  encoder.configure({ codec: codec.codec, width: size.width, height: size.height, framerate: profile.fps, bitrate: profile.bitrate, latencyMode: 'realtime', avc: codec.avc });
  track.addEventListener('ended', () => { encoder.close(); onEnd(new Error('capture ended')); });
  onStatus({ codec: codec.codec, ...size, fps: profile.fps });
  return { stream, encoder, stop() { encoder.close(); stream.getTracks().forEach((item) => item.stop()); } };
}
