import { describe, expect, it } from 'vitest';
import { issueToken } from '../relay/tokens.js';
import { verifyEdgeToken } from './token.js';

const secret = 'edge-test-secret-012345678901234567890';

describe('edge relay token verification', () => {
  it('accepts a valid room session', async () => {
    const token = issueToken({ room: 'call-1', role: 'viewer', user: '42', name: 'Duck' }, secret, 60, 100);
    await expect(verifyEdgeToken(token, secret, 120)).resolves.toMatchObject({ room: 'call-1', role: 'viewer', user: '42', name: 'Duck' });
  });

  it('rejects a signed capability that is not a room session', async () => {
    const media = issueToken({ type: 'sfu-media', room: 'call-1', user: '42', role: 'viewer' }, secret, 60, 100);
    const oauth = issueToken({ type: 'oauth', room: 'call-1', user: '42', role: 'viewer' }, secret, 60, 100);
    await expect(verifyEdgeToken(media, secret, 120)).rejects.toThrow(/claims/i);
    await expect(verifyEdgeToken(oauth, secret, 120)).rejects.toThrow(/claims/i);
  });

  it('rejects expired, modified, and malformed tokens', async () => {
    const token = issueToken({ room: 'call-1', role: 'publisher', user: '42' }, secret, 10, 100);
    await expect(verifyEdgeToken(token, secret, 111)).rejects.toThrow(/expired/i);
    await expect(verifyEdgeToken(`${token.slice(0, -1)}x`, secret, 105)).rejects.toThrow(/signature/i);
    await expect(verifyEdgeToken('invalid', secret, 105)).rejects.toThrow(/token/i);
  });
});
