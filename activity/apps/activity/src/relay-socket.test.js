import { describe, expect, it } from 'vitest';
import { relayUrls } from './relay-socket.js';

describe('edge relay URLs', () => {
  it('prefers edge and retains origin fallback outside Discord', () => {
    expect(relayUrls({ origin: 'https://stream.skillup.com.br', apiBase: '', token: 'a b' })).toEqual([
      'wss://stream.skillup.com.br/edge/ws?token=a%20b',
      'wss://stream.skillup.com.br/ws?token=a%20b',
    ]);
  });

  it('uses the Discord proxy prefix inside an Activity', () => {
    expect(relayUrls({ origin: 'https://discord.invalid', apiBase: '/.proxy', token: 't' })[0]).toBe('wss://discord.invalid/.proxy/edge/ws?token=t');
  });
});
