import crypto from 'node:crypto';

const encoder = new TextEncoder();
const toBase64 = (bytes) => Buffer.from(bytes).toString('base64url');
const fromBase64 = (value) => Buffer.from(value, 'base64url');

export function issueToken(claims, secret, ttlSeconds = 300, now = Math.floor(Date.now() / 1000)) {
  if (!secret || secret.length < 32) throw new Error('session secret must have at least 32 characters');
  const body = { ...claims, iat: now, exp: now + ttlSeconds };
  const encoded = toBase64(encoder.encode(JSON.stringify(body)));
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest();
  return `${encoded}.${toBase64(signature)}`;
}

export function verifyToken(token, secret, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || !secret) throw new Error('invalid token');
  const [encoded, supplied] = token.split('.');
  if (!encoded || !supplied || token.split('.').length !== 2) throw new Error('invalid token');
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest();
  const actual = fromBase64(supplied);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error('invalid token signature');
  let claims;
  try { claims = JSON.parse(fromBase64(encoded).toString('utf8')); } catch { throw new Error('invalid token body'); }
  if (!Number.isInteger(claims.exp) || claims.exp <= now) throw new Error('token expired');
  return claims;
}
