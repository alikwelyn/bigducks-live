import { expect, it, vi } from 'vitest';
import { requestSession, sessionMessage, REAUTHORISE_CODES } from './session-client.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

it('returns the token and sends the bearer only from the identity', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(json({ token: 'room-token' }));
  const result = await requestSession({ fetchImpl, apiBase: '/.proxy', identity: { accessToken: 'discord-token', user: 'u1' }, role: 'viewer', room: 'r' });
  expect(result).toEqual({ token: 'room-token' });
  expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer discord-token');
});

it('keeps the refusal reason instead of collapsing every failure into one', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(json({ error: 'nope', code: 'guild_unverifiable' }, 503));
  await expect(requestSession({ fetchImpl, identity: { accessToken: 't' }, role: 'viewer', room: 'r' })).rejects.toMatchObject({ code: 'guild_unverifiable', status: 503 });
});

it('turns the reason into something a person can act on', () => {
  expect(sessionMessage({ code: 'guild_required' })).toMatch(/não está no servidor autorizado/i);
  expect(sessionMessage({ code: 'guild_unverifiable' })).toMatch(/Autorize a Activity novamente/i);
  expect(sessionMessage({ code: 'discord_failed' })).toMatch(/conta do Discord/i);
  expect(sessionMessage({ code: 'http_500' })).toMatch(/Não foi possível carregar a sala/i);
  expect(REAUTHORISE_CODES.has('guild_unverifiable')).toBe(true);
  expect(REAUTHORISE_CODES.has('guild_required')).toBe(false);
});
