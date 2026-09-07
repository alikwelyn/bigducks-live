import { describe, expect, it, vi } from 'vitest';
import { issueToken } from './tokens.js';
import { createSfuGateway } from './sfu.js';

const secret = 'test-secret-012345678901234567890123';
const publisher = { room: 'room-a', user: 'pub', role: 'publisher' };
const viewer = { room: 'room-a', user: 'view', role: 'viewer' };

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Cloudflare Realtime SFU gateway', () => {
  it('creates sessions and keeps the app secret on the server', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ sessionId: 's-pub' }, 201));
    const gateway = createSfuGateway({ appId: 'app-id', appSecret: 'app-secret', secret, fetchImpl });
    expect(await gateway.createSession(publisher)).toEqual({ sessionId: 's-pub' });
    expect(fetchImpl).toHaveBeenCalledWith('https://rtc.live.cloudflare.com/v1/apps/app-id/sessions/new', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer app-secret' }) }));
  });

  it('signs published tracks and only subscribes viewers from the same room', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ sessionId: 's-pub' }, 201))
      .mockResolvedValueOnce(response({ tracks: [{ mid: '0', trackName: 'video-track' }, { mid: '1', trackName: 'audio-track' }], sessionDescription: { type: 'answer', sdp: 'answer' } }))
      .mockResolvedValueOnce(response({ sessionId: 's-view' }, 201))
      .mockResolvedValueOnce(response({ tracks: [{ mid: '0', trackName: 'video-track' }, { mid: '1', trackName: 'audio-track' }], requiresImmediateRenegotiation: true, sessionDescription: { type: 'offer', sdp: 'offer' } }))
      .mockResolvedValueOnce(response({ sessionId: 's-other' }, 201));
    const gateway = createSfuGateway({ appId: 'app-id', appSecret: 'app-secret', secret, fetchImpl });
    await gateway.createSession(publisher);
    const published = await gateway.publish(publisher, { sessionId: 's-pub', sessionDescription: { type: 'offer', sdp: 'offer' }, tracks: [{ mid: '0', trackName: 'video-track', kind: 'video' }, { mid: '1', trackName: 'audio-track', kind: 'audio' }] });
    expect(published.mediaToken).toEqual(expect.any(String));
    await gateway.createSession(viewer);
    const pulled = await gateway.subscribe(viewer, { sessionId: 's-view', mediaToken: published.mediaToken });
    expect(pulled.sessionDescription.type).toBe('offer');
    const subscribeBody = JSON.parse(fetchImpl.mock.calls[3][1].body);
    expect(subscribeBody.tracks).toEqual([{ location: 'remote', sessionId: 's-pub', trackName: 'video-track' }, { location: 'remote', sessionId: 's-pub', trackName: 'audio-track' }]);
    const otherRoomViewer = { ...viewer, room: 'room-b' };
    await gateway.createSession(otherRoomViewer);
    await expect(gateway.subscribe(otherRoomViewer, { sessionId: 's-other', mediaToken: published.mediaToken })).rejects.toThrow('room');
  });

  it('rejects disabled configuration and sessions owned by another user', async () => {
    expect(createSfuGateway({ secret }).enabled).toBe(false);
    await expect(createSfuGateway({ secret }).createSession(viewer)).rejects.toThrow('not configured');
    const fetchImpl = vi.fn().mockResolvedValue(response({ sessionId: 's-one' }, 201));
    const gateway = createSfuGateway({ appId: 'app', appSecret: 'secret', secret, fetchImpl });
    await gateway.createSession(viewer);
    await expect(gateway.renegotiate({ ...viewer, user: 'other' }, { sessionId: 's-one', sessionDescription: { type: 'answer', sdp: 'answer' } })).rejects.toThrow('owner');
  });
});
