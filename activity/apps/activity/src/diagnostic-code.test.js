import { expect, it } from 'vitest';
import { CODES, codeForSessionError, codeLabel, withCode } from './diagnostic-code.js';

it('keeps the published meaning of every code frozen', () => {
  // A code that changes meaning becomes misinformation once people quote it.
  expect(CODES).toMatchObject({
    SFU_ACTIVE: 0x0, RELAY_ACTIVE: 0x1, P2P_ACTIVE: 0x2,
    SFU_TIMEOUT: 0x3, SFU_LOST: 0x4, RELAY_STALL: 0x5, SOCKET_CLOSED: 0x6, ROOM_TIMEOUT: 0x7,
    GUILD_REQUIRED: 0x8, GUILD_UNVERIFIABLE: 0x9, DISCORD_AUTH: 0xa,
    CAPTURE_DENIED: 0xb, CAPTURE_ENDED: 0xc, CAPTURE_FAILED: 0xd, PUBLISH_FAILED: 0xe, RELAY_UNAVAILABLE: 0xf,
    SFU_FAILED: 0x10, SESSION_UNKNOWN: 0x11,
  });
  expect(new Set(Object.values(CODES)).size).toBe(Object.values(CODES).length);
});

it('formats a code in the shape people will read out loud', () => {
  expect(codeLabel(0x0)).toBe('0x0');
  expect(codeLabel(0xf)).toBe('0xF');
  expect(codeLabel(0xb)).toBe('0xB');
  expect(codeLabel(0x10)).toBe('0x10');
  expect(codeLabel(undefined)).toBe('');
  expect(codeLabel(1.5)).toBe('');
});

it('appends the code to a message without inventing one', () => {
  expect(withCode('Transmissão interrompida', 0xc)).toBe('Transmissão interrompida (0xC)');
  expect(withCode('Transmissão interrompida')).toBe('Transmissão interrompida');
});

it('maps a refused session to the code the user should report', () => {
  expect(codeForSessionError({ code: 'guild_required' })).toBe(0x8);
  expect(codeForSessionError({ code: 'guild_unverifiable' })).toBe(0x9);
  expect(codeForSessionError({ code: 'discord_failed' })).toBe(0xa);
  expect(codeForSessionError({ code: 'http_500' })).toBeUndefined();
});
