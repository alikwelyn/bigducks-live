export function validRoomClaims(claims) {
  const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
  return Boolean(claims && !claims.type && id(claims.room) && id(claims.user) && ['publisher', 'viewer'].includes(claims.role));
}

export function safeRedirect(value) {
  if (typeof value !== 'string' || /[\\\x00-\x1f\x7f]/.test(value)) return '/share';
  try {
    const url = new URL(value, 'https://local.invalid');
    if (!value.startsWith('/') || url.origin !== 'https://local.invalid' || !['/', '/share'].includes(url.pathname)) return '/share';
    return url.pathname + url.search;
  } catch { return '/share'; }
}

export function allowedOrigin(value, { origin, clientId, allowDevSessions } = {}) {
  // Additional browser CSRF defense, never a replacement for authentication.
  if (value === undefined) return true;
  if (value === origin || (clientId && [`https://${clientId}.discordsays.com`, `https://${clientId}.discordsez.com`].includes(value))) return true;
  return Boolean(allowDevSessions && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(value));
}

export function createLimiter({ limit = 600, interval = 60_000, maxKeys = 10_000 } = {}) {
  const buckets = new Map();
  return (key, now = Date.now()) => {
    for (const [id, bucket] of buckets) if (bucket.expires <= now) buckets.delete(id);
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= maxKeys) return false;
      bucket = { count: 0, expires: now + interval }; buckets.set(key, bucket);
    }
    if (bucket.count >= limit) return false;
    bucket.count += 1;
    return true;
  };
}

export function readJsonBody(request, maxBytes = 16_384) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []; let settled = false;
    const fail = (status, message) => { if (!settled) { settled = true; chunks.length = 0; reject(Object.assign(new Error(message), { status })); } };
    request.on('data', (chunk) => {
      if (settled) return;
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) { fail(413, 'request body too large'); return; }
      chunks.push(Buffer.from(chunk));
    });
    request.on('end', () => {
      if (settled) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const value = raw ? JSON.parse(raw) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        settled = true; resolve(value);
      } catch { fail(400, 'invalid JSON body'); }
    });
    request.on('error', () => fail(400, 'request interrupted'));
    request.on('aborted', () => fail(400, 'request interrupted'));
  });
}
