import { expect, it, vi } from 'vitest';
import { pageMode, captureSession, createShareLink } from './access.js';

const makeStorage = () => { const map = new Map(); return { getItem: (k) => map.get(k) || null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) }; };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
it('keeps direct visits and forged frame_id outside the SDK', () => {
  expect(pageMode(new URL('https://stream.test/'), false)).toBe('public');
  expect(pageMode(new URL('https://stream.test/?frame_id=fake'), false)).toBe('public');
  expect(pageMode(new URL('https://stream.test/?frame_id=frame'), true)).toBe('viewer');
  expect(pageMode(new URL('https://stream.test/share'), false)).toBe('capture');
});
it('does not request capture validation without a session', async () => {
  const fetchImpl = vi.fn();
  await expect(captureSession({ url: new URL('https://stream.test/share'), storage: makeStorage(), replaceUrl: vi.fn(), fetchImpl })).rejects.toThrow('invitation');
  expect(fetchImpl).not.toHaveBeenCalled();
});
it('cleans the URL, redeems a code, validates role and supports reload in the same tab', async () => {
  const storage = makeStorage(); const replaceUrl = vi.fn();
  const fetchImpl = vi.fn().mockResolvedValueOnce(json({ token: 'publisher-token' })).mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(json({ ok: true }));
  const url = new URL('https://stream.test/share?capture=1&code=one-use');
  expect(await captureSession({ url, storage, replaceUrl, fetchImpl })).toBe('publisher-token');
  expect(replaceUrl).toHaveBeenCalledWith('/share?capture=1');
  expect(fetchImpl.mock.calls[0][0]).toBe('/api/share-redeem');
  expect(fetchImpl.mock.calls[1][1].headers.authorization).toBe('Bearer publisher-token');
  expect(await captureSession({ url: new URL('https://stream.test/share'), storage, replaceUrl, fetchImpl })).toBe('publisher-token');
});
it('validates legacy tokens but never reuses stored access when a new invitation fails', async () => {
  const storage = makeStorage(); const replaceUrl = vi.fn();
  const fetchImpl = vi.fn().mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(json({}, 401));
  expect(await captureSession({ url: new URL('https://stream.test/share?t=legacy'), storage, replaceUrl, fetchImpl })).toBe('legacy');
  expect(replaceUrl).toHaveBeenCalledWith('/share');
  await expect(captureSession({ url: new URL('https://stream.test/share?code=used'), storage, replaceUrl, fetchImpl })).rejects.toThrow('invitation');
  await expect(captureSession({ url: new URL('https://stream.test/share'), storage, replaceUrl, fetchImpl })).rejects.toThrow('invitation');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it('does not fall back to a saved session when an explicitly empty invite is supplied', async () => {
  const storage = makeStorage(); const replaceUrl = vi.fn();
  const fetchImpl = vi.fn().mockResolvedValue(json({ ok: true }));
  await captureSession({ url: new URL('https://stream.test/share?t=legacy'), storage, replaceUrl, fetchImpl });
  await expect(captureSession({ url: new URL('https://stream.test/share?code='), storage, replaceUrl, fetchImpl })).rejects.toThrow('invitation');
  expect(fetchImpl).toHaveBeenCalledOnce();
});
it('opens new links without a room token in the URL', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(json({ code: 'invite' }));
  const link = await createShareLink({ publicOrigin: 'https://stream.test', apiBase: '/.proxy', token: 'secret-room-token', fetchImpl });
  expect(link).toBe('https://stream.test/share?code=invite');
  expect(link).not.toContain('secret-room-token');
  expect(fetchImpl.mock.calls[0][0]).toBe('/.proxy/api/share-link');
});
