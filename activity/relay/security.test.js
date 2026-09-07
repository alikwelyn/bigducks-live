import { expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { createLimiter, readJsonBody, safeRedirect, validRoomClaims, allowedOrigin } from './security.js';

it('accepts only room capabilities with bounded identities and valid roles', () => {
  expect(validRoomClaims({ room: 'r', user: 'u', role: 'publisher' })).toBe(true);
  for (const claims of [null, {}, { room: 'r', user: '', role: 'viewer' }, { room: 'r', user: 'u', role: 'admin' }, { type: 'sfu-media', room: 'r', user: 'u', role: 'viewer' }]) expect(validRoomClaims(claims)).toBe(false);
});
it('only allows local share or root OAuth redirects', () => {
  expect(safeRedirect('/share?capture=1&external=1')).toBe('/share?capture=1&external=1');
  for (const value of ['//evil.test', '/\\evil.test', '/%5cevil.test', 'https://evil.test', '/other', '/share\r\nX: y']) expect(safeRedirect(value)).toBe('/share');
});
it('bounds limiter memory and resets expired buckets', () => {
  const allow = createLimiter({ limit: 2, interval: 1000, maxKeys: 2 });
  expect(allow('a', 0)).toBe(true); expect(allow('a', 0)).toBe(true); expect(allow('a', 0)).toBe(false);
  expect(allow('b', 0)).toBe(true); expect(allow('c', 0)).toBe(false);
  expect(allow('c', 1001)).toBe(true); expect(allow('a', 1001)).toBe(true);
});
it('counts streamed JSON bytes and rejects invalid bodies', async () => {
  const ok = new PassThrough(); const result = readJsonBody(ok, 50); ok.end('{"room":"a"}'); expect(await result).toEqual({ room: 'a' });
  const large = new PassThrough(); const failed = readJsonBody(large, 10); large.end('{"a":"ééé"}'); await expect(failed).rejects.toMatchObject({ status: 413 });
  const invalid = new PassThrough(); const bad = readJsonBody(invalid, 50); invalid.end('null'); await expect(bad).rejects.toMatchObject({ status: 400 });
});
it('allows configured app origins without trusting spoofed suffixes', () => {
  const config = { origin: 'https://stream.skillup.com.br', clientId: '123' };
  for (const origin of [undefined, 'https://stream.skillup.com.br', 'https://123.discordsays.com']) expect(allowedOrigin(origin, config)).toBe(true);
  for (const origin of ['null', 'https://evil.test', 'https://123.discordsays.com.evil.test', 'https://456.discordsays.com']) expect(allowedOrigin(origin, config)).toBe(false);
});
