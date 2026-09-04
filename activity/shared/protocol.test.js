import { describe, expect, it } from 'vitest';
import {
  AUDIO,
  VIDEO_DELTA,
  VIDEO_KEYFRAME,
  decodePacket,
  encodePacket,
  parseControl,
  stringifyControl,
} from './protocol.js';

describe('media protocol', () => {
  it.each([VIDEO_KEYFRAME, VIDEO_DELTA, AUDIO])('round trips packet type %s', (type) => {
    const payload = new Uint8Array([1, 2, 255, 0]);
    const encoded = encodePacket({ slot: 3, type, sentAt: 1234, clock: 5678, payload });
    expect(decodePacket(encoded)).toEqual({ slot: 3, type, sentAt: 1234, clock: 5678, payload });
  });

  it('rejects truncated and unknown packets', () => {
    expect(() => decodePacket(new Uint8Array(17))).toThrow(/truncated/i);
    const packet = encodePacket({ slot: 0, type: VIDEO_DELTA, sentAt: 1, clock: 2, payload: new Uint8Array() });
    packet[1] = 99;
    expect(() => decodePacket(packet)).toThrow(/media type/i);
  });

  it('round trips bounded control messages', () => {
    const message = { type: 'watch', room: 'room-a', slot: 1 };
    expect(parseControl(stringifyControl(message))).toEqual(message);
  });

  it('rejects oversized control messages', () => {
    expect(() => parseControl(JSON.stringify({ type: 'x', value: 'a'.repeat(70_000) }))).toThrow(/large/i);
  });
});
