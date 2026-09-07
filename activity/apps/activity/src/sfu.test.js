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
  getSenders() { return this.transceivers.map(({ sender }) => sender); }
  getStats = vi.fn().mockResolvedValue(new Map([['video', { type: 'outbound-rtp', kind: 'video', qualityLimitationReason: 'bandwidth' }]]));
}

function json(body, status = 200) { return new Response(JSON.stringify(body), { status }); }

describe('SFU browser transport', () => {
  it('keeps automatic quality idle and resumes adaptation when an audience returns', async () => {
    vi.useFakeTimers();
    let published;
    try {
      const fetchImpl = vi.fn().mockResolvedValueOnce(json({ sessionId: 'session' }))
        .mockResolvedValueOnce(json({ sessionDescription: { type: 'answer', sdp: 'answer' }, mediaToken: 'media' })).mockResolvedValue(json({}));
      published = await createSfuPublisher({ stream: new FakeMediaStream([{ id: 'v', kind: 'video', getSettings: () => ({ width: 1280, height: 720 }) }]), profile: { automatic: true, width: 1280, height: 720, bitrate: 2_500_000, fps: 30 }, fetchImpl, RTCPeerConnectionClass: FakePeerConnection });
      await published.setAudience(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(published.peer.getStats).not.toHaveBeenCalled();
      await published.setAudience(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(published.peer.getStats).toHaveBeenCalledOnce();
      expect(published.peer.getSenders()[0].setParameters).toHaveBeenLastCalledWith({ encodings: [{ maxBitrate: 1_500_000, maxFramerate: 25, scaleResolutionDownBy: 1.5 }] });
    } finally { published?.close(); vi.useRealTimers(); }
  });
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
    await published.setAudience(0);
    expect(published.peer.transceivers[0].sender.setParameters).toHaveBeenLastCalledWith({ encodings: [{ maxBitrate: 40_000, maxFramerate: 1, scaleResolutionDownBy: 8 }] });
    expect(published.peer.transceivers[1].sender.setParameters).toHaveBeenLastCalledWith({ encodings: [{ maxBitrate: 6_000 }] });
    await published.setAudience(1);
    expect(published.peer.transceivers[0].sender.setParameters).toHaveBeenLastCalledWith({ encodings: [{ maxBitrate: 2_500_000, maxFramerate: 30, scaleResolutionDownBy: 2 }] });
    expect(published.peer.transceivers[1].sender.setParameters).toHaveBeenLastCalledWith({ encodings: [{ maxBitrate: 96_000 }] });
    await Promise.all([published.setAudience(0), published.setAudience(1), published.setAudience(0)]);
    expect(published.peer.transceivers[0].sender.setParameters).toHaveBeenLastCalledWith({ encodings: [{ maxBitrate: 40_000, maxFramerate: 1, scaleResolutionDownBy: 8 }] });
    fetchImpl.mockResolvedValue(json({}));
    published.close();
    const calls = published.peer.transceivers[0].sender.setParameters.mock.calls.length;
    await published.setAudience(1);
    expect(published.peer.transceivers[0].sender.setParameters).toHaveBeenCalledTimes(calls);
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
