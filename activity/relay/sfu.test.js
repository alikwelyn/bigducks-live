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
  it('keeps the rate-limit map bounded instead of growing with attacker-chosen rooms', async () => {
    const fetchImpl = vi.fn(async () => response({ sessionId: `s-${Math.random()}` }, 201));
    const gateway = createSfuGateway({ appId: 'app-id', appSecret: 'app-secret', secret, fetchImpl, maxRateKeys: 50 });
    for (let index = 0; index < 50; index++) await gateway.createSession({ room: `room-${index}`, user: 'pub', role: 'publisher' });
    await expect(gateway.createSession({ room: 'room-novo', user: 'pub', role: 'publisher' })).rejects.toThrow(/capacity/i);
    // An expired window is pruned, so the same identity is not permanently locked out.
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(Date.now() + 61_000);
    try {
      await expect(gateway.createSession({ room: 'room-novo', user: 'pub', role: 'publisher' })).resolves.toHaveProperty('sessionId');
    } finally { clock.mockRestore(); }
  });

  it('still rate limits one identity that opens sessions in a burst', async () => {
    const fetchImpl = vi.fn(async () => response({ sessionId: `s-${Math.random()}` }, 201));
    const gateway = createSfuGateway({ appId: 'app-id', appSecret: 'app-secret', secret, fetchImpl });
    for (let index = 0; index < 10; index++) await gateway.createSession({ room: 'room-a', user: 'pub', role: 'publisher' });
    await expect(gateway.createSession({ room: 'room-a', user: 'pub', role: 'publisher' })).rejects.toThrow(/rate limit/i);
  });

  it('refuses a nonsense cap instead of locking every identity out', async () => {
    const fetchImpl = vi.fn(async () => response({ sessionId: 's' }, 201));
    const gateway = createSfuGateway({ appId: 'app-id', appSecret: 'app-secret', secret, fetchImpl, maxRateKeys: 0 });
    await expect(gateway.createSession({ room: 'r', user: 'u', role: 'viewer' })).resolves.toHaveProperty('sessionId');
  });

  it('keeps admitting a known identity while the rate-limit map is full', async () => {
    const fetchImpl = vi.fn(async () => response({ sessionId: `s-${Math.random()}` }, 201));
    const gateway = createSfuGateway({ appId: 'app-id', appSecret: 'app-secret', secret, fetchImpl, maxRateKeys: 2 });
    const known = { room: 'r', user: 'u', role: 'viewer' };
    await gateway.createSession(known);
    await gateway.createSession({ room: 'outra', user: 'u', role: 'viewer' });
    await expect(gateway.createSession({ room: 'terceira', user: 'u', role: 'viewer' })).rejects.toThrow(/capacity/i);
    await expect(gateway.createSession(known)).resolves.toHaveProperty('sessionId');
  });

  it('forgets a session once it is closed instead of holding it for six hours', async () => {
    const fetchImpl = vi.fn(async () => response({ sessionId: 's-pub' }, 201));
    const gateway = createSfuGateway({ appId: 'app-id', appSecret: 'app-secret', secret, fetchImpl });
    await gateway.createSession(publisher);
    await gateway.closeTracks(publisher, { sessionId: 's-pub', mids: ['0'] });
    await expect(gateway.closeTracks(publisher, { sessionId: 's-pub', mids: ['0'] })).rejects.toThrow(/owner/i);
  });

  it('stops honouring a media capability once the publication is closed', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ sessionId: 's-pub' }, 201))
      .mockResolvedValueOnce(response({ tracks: [{ mid: '0', trackName: 'video-track' }], sessionDescription: { type: 'answer', sdp: 'answer' } }))
      .mockResolvedValueOnce(response({ sessionId: 's-view' }, 201))
      .mockImplementation(async () => response({}));
    const gateway = createSfuGateway({ appId: 'app-id', appSecret: 'app-secret', secret, fetchImpl });
    await gateway.createSession(publisher);
    const published = await gateway.publish(publisher, { sessionId: 's-pub', sessionDescription: { type: 'offer', sdp: 'offer' }, tracks: [{ mid: '0', trackName: 'video-track', kind: 'video' }] });
    await gateway.createSession(viewer);
    await gateway.subscribe(viewer, { sessionId: 's-view', mediaToken: published.mediaToken });
    await gateway.closeTracks(publisher, { sessionId: 's-pub', mids: ['0'] });
    await expect(gateway.subscribe(viewer, { sessionId: 's-view', mediaToken: published.mediaToken })).rejects.toThrow(/publication|capability/i);
  });

  it('revokes the publication when the publisher leaves without a close request', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ sessionId: 's-pub' }, 201))
      .mockResolvedValueOnce(response({ tracks: [{ mid: '0', trackName: 'video-track' }], sessionDescription: { type: 'answer', sdp: 'answer' } }))
      .mockResolvedValueOnce(response({ sessionId: 's-view' }, 201))
      .mockImplementation(async () => response({}));
    const gateway = createSfuGateway({ appId: 'app-id', appSecret: 'app-secret', secret, fetchImpl });
    await gateway.createSession(publisher);
    const published = await gateway.publish(publisher, { sessionId: 's-pub', sessionDescription: { type: 'offer', sdp: 'offer' }, tracks: [{ mid: '0', trackName: 'video-track', kind: 'video' }] });
    await gateway.createSession(viewer);
    await gateway.subscribe(viewer, { sessionId: 's-view', mediaToken: published.mediaToken });
    expect(gateway.release({ room: 'room-a', user: 'pub' })).toBe(1);
    await expect(gateway.subscribe(viewer, { sessionId: 's-view', mediaToken: published.mediaToken })).rejects.toThrow(/publication|capability/i);
    expect(gateway.release({ room: 'room-a', user: 'pub' })).toBe(0);
    expect(gateway.release({ room: 'outra-sala' })).toBe(0);
  });

});
