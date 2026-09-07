import { AUDIO, decodePacket, VIDEO_KEYFRAME, VIDEO_DELTA } from '../../../shared/protocol.js';

const VIDEO_BUFFER_MS = 80;
const MAX_VIDEO_FRAMES = 12;

export function createPlayer(canvas) {
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  let decoder;
  let audioDecoder;
  let audioContext;
  let nextAudioTime = 0;
  let configured = false;
  let hasKeyframe = false;
  let videoBase = null;
  let lastTimestamp = -Infinity;
  let animationFrame = null;
  const frames = [];

  const clearFrames = () => {
    while (frames.length) frames.shift().frame.close();
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    animationFrame = null;
  };

  const clearCanvas = () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 1;
    canvas.height = 1;
  };

  const paint = (frame) => {
    const width = frame.displayWidth || frame.codedWidth;
    const height = frame.displayHeight || frame.codedHeight;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    context.drawImage(frame, 0, 0, canvas.width, canvas.height);
    frame.close();
  };

  const tick = () => {
    animationFrame = null;
    const now = performance.now();
    let chosen;
    while (frames.length && frames[0].showAt <= now) {
      chosen?.frame.close();
      chosen = frames.shift();
    }
    if (chosen) paint(chosen.frame);
    if (frames.length) animationFrame = requestAnimationFrame(tick);
  };

  const scheduleFrame = (frame) => {
    const now = performance.now();
    const timestamp = (frame.timestamp || 0) / 1000;
    if (videoBase === null || timestamp < lastTimestamp) {
      clearFrames();
      videoBase = now + VIDEO_BUFFER_MS - timestamp;
    }
    lastTimestamp = timestamp;
    let showAt = videoBase + timestamp;
    if (showAt < now - VIDEO_BUFFER_MS) {
      clearFrames();
      videoBase = now + VIDEO_BUFFER_MS - timestamp;
      showAt = videoBase + timestamp;
    }
    frames.push({ frame, showAt });
    while (frames.length > MAX_VIDEO_FRAMES) frames.shift().frame.close();
    if (animationFrame === null) animationFrame = requestAnimationFrame(tick);
  };

  return {
    configure({ codec }) {
      clearFrames();
      clearCanvas();
      if (decoder && decoder.state !== 'closed') decoder.close();
      if (audioDecoder && audioDecoder.state !== 'closed') audioDecoder.close();
      audioContext?.close();
      hasKeyframe = false;
      videoBase = null;
      lastTimestamp = -Infinity;
      decoder = new VideoDecoder({ output: scheduleFrame, error() { hasKeyframe = false; } });
      decoder.configure({ codec, optimizeForLatency: true });
      if (typeof AudioDecoder === 'function') {
        audioContext = new AudioContext({ latencyHint: 'interactive' });
        nextAudioTime = 0;
        audioDecoder = new AudioDecoder({ output(audioData) {
          const buffer = audioContext.createBuffer(audioData.numberOfChannels, audioData.numberOfFrames, audioData.sampleRate);
          for (let channel = 0; channel < audioData.numberOfChannels; channel++) audioData.copyTo(buffer.getChannelData(channel), { planeIndex: channel, format: 'f32-planar' });
          const source = audioContext.createBufferSource(); source.buffer = buffer; source.connect(audioContext.destination);
          const liveEdge = audioContext.currentTime + 0.08;
          if (nextAudioTime < audioContext.currentTime || nextAudioTime > audioContext.currentTime + 0.32) nextAudioTime = liveEdge;
          nextAudioTime = Math.max(nextAudioTime, liveEdge); source.start(nextAudioTime); nextAudioTime += buffer.duration; audioData.close();
        }, error() {} });
        audioDecoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
      }
      configured = true;
    },
    push(raw) {
      if (!configured) return;
      const packet = decodePacket(raw);
      if (packet.type === AUDIO) {
        if (audioDecoder?.state === 'configured') audioDecoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: packet.clock * 1000, data: packet.payload }));
        return;
      }
      if (packet.type === VIDEO_KEYFRAME) hasKeyframe = true;
      if (packet.type === VIDEO_DELTA && !hasKeyframe) return;
      try {
        decoder.decode(new EncodedVideoChunk({ type: packet.type === VIDEO_KEYFRAME ? 'key' : 'delta', timestamp: packet.clock * 1000, data: packet.payload }));
      } catch { hasKeyframe = false; }
    },
    close() {
      clearFrames();
      clearCanvas();
      if (decoder && decoder.state !== 'closed') decoder.close();
      if (audioDecoder && audioDecoder.state !== 'closed') audioDecoder.close();
      audioContext?.close();
      configured = false;
    },
  };
}
