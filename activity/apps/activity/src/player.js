import { decodePacket, VIDEO_KEYFRAME, VIDEO_DELTA } from '../../../shared/protocol.js';

export function createPlayer(canvas) {
  const context = canvas.getContext('2d');
  let decoder;
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
      configured = true;
    },
    push(raw) {
      if (!configured) return;
      const packet = decodePacket(raw);
      if (packet.type === VIDEO_KEYFRAME) hasKeyframe = true;
      if (packet.type === VIDEO_DELTA && !hasKeyframe) return;
      pending.push(new EncodedVideoChunk({ type: packet.type === VIDEO_KEYFRAME ? 'key' : 'delta', timestamp: packet.clock * 1000, data: packet.payload }));
      flush();
    },
    close() { decoder?.close(); pending.length = 0; },
  };
}
