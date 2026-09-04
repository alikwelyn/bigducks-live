import { describe, expect, it } from 'vitest';
import { issueToken, verifyToken } from './tokens.js';

describe('session tokens', () => {
  it('signs and verifies scoped tokens', () => {
    const secret = 'secret-012345678901234567890123456789';
    const token = issueToken({ room: 'room-a', role: 'viewer', user: 'user-a' }, secret, 60, 1000);
    expect(verifyToken(token, secret, 1001)).toMatchObject({ room: 'room-a', role: 'viewer', user: 'user-a' });
  });

  it('rejects a changed, wrong-secret, or expired token', () => {
    const secret = 'secret-012345678901234567890123456789';
    const token = issueToken({ room: 'room-a', role: 'publisher' }, secret, 10, 1000);
    expect(() => verifyToken(`${token}x`, secret, 1001)).toThrow(/invalid/i);
    expect(() => verifyToken(token, 'wrong-secret-012345678901234567890', 1001)).toThrow(/invalid/i);
    expect(() => verifyToken(token, secret, 1011)).toThrow(/expired/i);
  });
});
