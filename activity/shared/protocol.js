export const VIDEO_KEYFRAME = 1;
export const VIDEO_DELTA = 2;
export const AUDIO = 3;

export const PACKET_HEADER_BYTES = 18;
export const MAX_CONTROL_BYTES = 64 * 1024;
export const MEDIA_TYPES = new Set([VIDEO_KEYFRAME, VIDEO_DELTA, AUDIO]);

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('payload must be Uint8Array or ArrayBuffer');
}

function assertUInt8(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError(`${name} must be an unsigned byte`);
}

function assertUInt64(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
}

export function encodePacket({ slot, type, sentAt, clock, payload }) {
  assertUInt8(slot, 'slot');
  assertUInt8(type, 'media type');
  if (!MEDIA_TYPES.has(type)) throw new RangeError(`unknown media type ${type}`);
  assertUInt64(sentAt, 'sentAt');
  assertUInt64(clock, 'clock');
  const bytes = asBytes(payload);
  const packet = new Uint8Array(PACKET_HEADER_BYTES + bytes.byteLength);
  const view = new DataView(packet.buffer);
  packet[0] = slot;
  packet[1] = type;
  view.setBigUint64(2, BigInt(sentAt));
  view.setBigUint64(10, BigInt(clock));
  packet.set(bytes, PACKET_HEADER_BYTES);
  return packet;
}

export function decodePacket(value) {
  const packet = asBytes(value);
  if (packet.byteLength < PACKET_HEADER_BYTES) throw new RangeError('truncated media packet');
  const type = packet[1];
  if (!MEDIA_TYPES.has(type)) throw new RangeError(`unknown media type ${type}`);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const sentAt = Number(view.getBigUint64(2));
  const clock = Number(view.getBigUint64(10));
  return { slot: packet[0], type, sentAt, clock, payload: packet.slice(PACKET_HEADER_BYTES) };
}

export function stringifyControl(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
    throw new TypeError('control message requires a type');
  }
  const encoded = JSON.stringify(message);
  if (new TextEncoder().encode(encoded).byteLength > MAX_CONTROL_BYTES) throw new RangeError('control message is too large');
  return encoded;
}

export function parseControl(value) {
  const encoded = typeof value === 'string' ? value : new TextDecoder().decode(asBytes(value));
  if (new TextEncoder().encode(encoded).byteLength > MAX_CONTROL_BYTES) throw new RangeError('control message is too large');
  let message;
  try {
    message = JSON.parse(encoded);
  } catch {
    throw new SyntaxError('invalid control message JSON');
  }
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
    throw new TypeError('control message requires a type');
  }
  return message;
}
