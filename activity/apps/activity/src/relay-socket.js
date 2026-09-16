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

// Resolves only when the room confirms the session. Registering close/error
// before sending hello, and bounding the wait, prevents a connection that dies
// during the handshake from leaving the studio permanently stuck.
export function awaitJoined(socket, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
      if (error) reject(error); else resolve(value);
    };
    const onMessage = (event) => {
      if (typeof event?.data !== 'string') return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message?.type === 'joined') finish(null, message);
    };
    const onClose = () => finish(new Error('A sala encerrou a conexão antes de confirmar a transmissão.'));
    const onError = () => finish(new Error('A conexão com a sala falhou antes de confirmar a transmissão.'));
    timer = setTimeout(() => finish(new Error('A sala demorou demais para confirmar a transmissão.')), timeoutMs);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);
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
