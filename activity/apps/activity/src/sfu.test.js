import { describe, expect, it, vi } from 'vitest';
import { createSfuPublisher, createSfuViewer, sfuRequest } from './sfu.js';

class FakeMediaStream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  addTrack(track) { this.tracks.push(track); }
  getTracks() { return this.tracks; }
}

class FakePeerConnection {
  constructor() { this.transceivers = []; this.connectionState = 'connected'; this.iceConnectionState = 'connected'; this.listeners = new Map(); }
  addTransceiver(track, init) {
    const sender = { track, getParameters: () => ({ encodings: [{}] }), setParameters: vi.fn().mockResolvedValue() };
    const value = { mid: String(this.transceivers.length), sender, init };
    this.transceivers.push(value); return value;
  }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener() {}
  createOffer() { return Promise.resolve({ type: 'offer', sdp: 'publisher-offer' }); }
  createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'viewer-answer' }); }
  setLocalDescription(value) { this.localDescription = value; return Promise.resolve(); }
  setRemoteDescription(value) {
    this.remoteDescription = value;
    if (value.type === 'offer') queueMicrotask(() => {
      for (const [index, kind] of ['video', 'audio'].entries()) this.listeners.get('track')?.({ transceiver: { mid: String(index) }, track: { kind, id: `${kind}-remote` } });
    });
    return Promise.resolve();
  }
  close() { this.connectionState = 'closed'; }
}

function json(body, status = 200) { return new Response(JSON.stringify(body), { status }); }

describe('SFU browser transport', () => {
  it('sends the room token only to the authenticated origin proxy', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ sessionId: 'session' }));
    expect(await sfuRequest({ apiBase: '/.proxy', token: 'room-token', operation: 'session', fetchImpl })).toEqual({ sessionId: 'session' });
    expect(fetchImpl).toHaveBeenCalledWith('/.proxy/api/sfu/session', expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer room-token' }) }));
  });

  it('publishes native display tracks and returns a signed media capability', async () => {
    const video = { id: 'video-id', kind: 'video', getSettings: () => ({ width: 2560, height: 1440 }) }; const audio = { id: 'audio-id', kind: 'audio' };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ sessionId: 'publisher-session' }))
      .mockResolvedValueOnce(json({ sessionDescription: { type: 'answer', sdp: 'publisher-answer' }, mediaToken: 'signed-media', tracks: [{ kind: 'video', trackName: 'video-id' }, { kind: 'audio', trackName: 'audio-id' }] }));
    const published = await createSfuPublisher({ stream: new FakeMediaStream([video, audio]), profile: { width: 1280, height: 720, bitrate: 2_500_000, fps: 30 }, token: 'room-token', fetchImpl, RTCPeerConnectionClass: FakePeerConnection });
    expect(published.mediaToken).toBe('signed-media');
    expect(published.peer.transceivers[0].init.sendEncodings).toEqual([{ maxBitrate: 2_500_000, maxFramerate: 30, scaleResolutionDownBy: 2 }]);
    const publishBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(publishBody.tracks).toEqual([{ mid: '0', trackName: 'video-id', kind: 'video' }, { mid: '1', trackName: 'audio-id', kind: 'audio' }]);
    expect(published.peer.remoteDescription.type).toBe('answer');
  });

  it('subscribes to remote tracks and completes required renegotiation', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ sessionId: 'viewer-session' }))
      .mockResolvedValueOnce(json({ requiresImmediateRenegotiation: true, tracks: [{ mid: '0' }, { mid: '1' }], sessionDescription: { type: 'offer', sdp: 'viewer-offer' } }))
      .mockResolvedValueOnce(json({}));
    const video = { srcObject: null, play: vi.fn().mockResolvedValue() };
    const viewed = await createSfuViewer({ mediaToken: 'signed-media', video, token: 'room-token', fetchImpl, RTCPeerConnectionClass: FakePeerConnection, MediaStreamClass: FakeMediaStream });
    expect(video.srcObject.getTracks().map((track) => track.kind)).toEqual(['video', 'audio']);
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body).sessionDescription).toEqual({ type: 'answer', sdp: 'viewer-answer' });
    viewed.close();
    expect(viewed.peer.connectionState).toBe('closed');
  });
});
