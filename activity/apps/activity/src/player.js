import { AUDIO, decodePacket, VIDEO_KEYFRAME, VIDEO_DELTA } from '../../../shared/protocol.js';

export function createPlayer(canvas) {
  const context = canvas.getContext('2d');
  let decoder;
  let audioDecoder;
  let audioContext;
  let nextAudioTime = 0;
  let configured = false;
  let width = 0;
  let height = 0;
  let hasKeyframe = false;
  let queued = 0;
  const pending = [];
  const flush = () => {
    while (pending.length && queued < 2) {
      const packet = pending.shift();
      queued += 1;
      decoder.decode(packet);
    }
  };
  return {
    configure({ codec, width: nextWidth, height: nextHeight }) {
      decoder?.close();
      width = nextWidth; height = nextHeight;
      decoder = new VideoDecoder({ output(frame) { canvas.width = width; canvas.height = height; context.drawImage(frame, 0, 0, width, height); frame.close(); queued = Math.max(0, queued - 1); flush(); }, error() { hasKeyframe = false; } });
      decoder.configure({ codec, optimizeForLatency: true });
      if (typeof AudioDecoder === 'function') {
        audioContext = new AudioContext();
        audioDecoder = new AudioDecoder({ output(audioData) {
          const buffer = audioContext.createBuffer(audioData.numberOfChannels, audioData.numberOfFrames, audioData.sampleRate);
          for (let channel = 0; channel < audioData.numberOfChannels; channel++) audioData.copyTo(buffer.getChannelData(channel), { planeIndex: channel, format: 'f32-planar' });
          const source = audioContext.createBufferSource(); source.buffer = buffer; source.connect(audioContext.destination);
          nextAudioTime = Math.max(nextAudioTime, audioContext.currentTime + 0.04); source.start(nextAudioTime); nextAudioTime += buffer.duration; audioData.close();
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
      pending.push(new EncodedVideoChunk({ type: packet.type === VIDEO_KEYFRAME ? 'key' : 'delta', timestamp: packet.clock * 1000, data: packet.payload }));
      flush();
    },
    close() { decoder?.close(); audioDecoder?.close(); audioContext?.close(); pending.length = 0; },
  };
}
