import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitJoined, relayUrls } from './relay-socket.js';

afterEach(() => { vi.useRealTimers(); });

class FakeSocket extends EventTarget {
  constructor() { super(); this.binaryType = ''; this.close = vi.fn(); }
  message(data) { this.dispatchEvent(Object.assign(new Event('message'), { data })); }
}

function text(value) { return JSON.stringify(value); }

describe('joining a room', () => {
  it('resolves with the slot and stops listening once joined arrives', async () => {
    const socket = new FakeSocket();
    const joined = awaitJoined(socket, { timeoutMs: 8000 });
    socket.message('not json');
    socket.message(JSON.stringify({ type: 'audience', slot: 0 }));
    socket.message(new ArrayBuffer(4));
    socket.message(text({ type: 'joined', slot: 2, name: 'Ana' }));
    await expect(joined).resolves.toMatchObject({ slot: 2, name: 'Ana' });
    expect(getEventListeners(socket, 'message')).toHaveLength(0);
    expect(getEventListeners(socket, 'close')).toHaveLength(0);
  });

  it('rejects instead of hanging when the room closes before confirming', async () => {
    const socket = new FakeSocket();
    const joined = awaitJoined(socket, { timeoutMs: 8000 });
    socket.dispatchEvent(new Event('close'));
    await expect(joined).rejects.toThrow(/encerrou a conexão antes de confirmar/i);
  });

  it('rejects when the socket fails before confirming', async () => {
    const socket = new FakeSocket();
    const joined = awaitJoined(socket, { timeoutMs: 8000 });
    socket.dispatchEvent(new Event('error'));
    await expect(joined).rejects.toThrow(/falhou antes de confirmar/i);
  });

  it('clears the deadline as soon as the room confirms', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const joined = awaitJoined(socket, { timeoutMs: 8000 });
    socket.message(text({ type: 'joined', slot: 1 }));
    await expect(joined).resolves.toMatchObject({ slot: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects on timeout and leaves no pending timer behind', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const joined = awaitJoined(socket, { timeoutMs: 8000 });
    const rejected = expect(joined).rejects.toThrow(/demorou demais/i);
    vi.advanceTimersByTime(8000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});

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
