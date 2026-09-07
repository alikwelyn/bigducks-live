export function relayUrls({ origin = location.origin, apiBase = '', token }) {
  const websocketOrigin = origin.replace(/^http/, 'ws');
  const query = `?token=${encodeURIComponent(token)}`;
  return [`${websocketOrigin}${apiBase}/edge/ws${query}`, `${websocketOrigin}${apiBase}/ws${query}`];
}

function open(url, timeoutMs, WebSocketClass) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketClass(url);
    socket.binaryType = 'arraybuffer';
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('relay connection timeout'));
    }, timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(socket); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('relay connection failed')); }, { once: true });
  });
}

export async function connectRelaySocket({ origin = location.origin, apiBase = '', token, timeoutMs = 8000, allowOriginFallback = false, WebSocketClass = WebSocket }) {
  let lastError;
  const urls = relayUrls({ origin, apiBase, token });
  for (const url of allowOriginFallback ? urls : urls.slice(0, 1)) {
    try {
      const socket = await open(url, timeoutMs, WebSocketClass);
      socket.relay = url.includes('/edge/ws') ? 'cloudflare-edge' : 'origin-fallback';
      return socket;
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('relay unavailable');
}
