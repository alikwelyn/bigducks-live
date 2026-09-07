const encoder = new TextEncoder();

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function verifyEdgeToken(token, secret, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || typeof secret !== 'string' || !secret) throw new Error('invalid token');
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('invalid token');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(parts[0])));
  let supplied;
  try { supplied = decodeBase64Url(parts[1]); } catch { throw new Error('invalid token signature'); }
  if (!equalBytes(expected, supplied)) throw new Error('invalid token signature');
  let claims;
  try { claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0]))); } catch { throw new Error('invalid token body'); }
  if (!Number.isInteger(claims.exp) || claims.exp <= now) throw new Error('token expired');
  if (typeof claims.room !== 'string' || !claims.room || typeof claims.user !== 'string' || !['publisher', 'viewer'].includes(claims.role)) throw new Error('invalid token claims');
  return claims;
}
