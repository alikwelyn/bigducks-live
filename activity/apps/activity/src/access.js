const STORAGE_KEY = 'bigducks-publisher-session';

export function pageMode(url, embedded) {
  if (url.pathname === '/share' || url.searchParams.get('capture') === '1') return 'capture';
  return embedded && url.searchParams.has('frame_id') ? 'viewer' : 'public';
}

export async function captureSession({ url, storage, replaceUrl, fetchImpl = globalThis.fetch }) {
  const supplied = url.searchParams.has('code') || url.searchParams.has('t');
  const code = url.searchParams.get('code');
  const legacy = url.searchParams.get('t');
  // Clean bearer tokens/one-use codes before further requests or rendering media.
  url.searchParams.delete('code'); url.searchParams.delete('t');
  replaceUrl(url.pathname + url.search + url.hash);
  let token;
  try {
    if (supplied) {
      try { storage?.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
      if (!code && !legacy) throw new Error('invalid invitation');
    }
    if (code) {
      const response = await fetchImpl('/api/share-redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
      if (!response.ok) throw new Error('invalid invitation');
      token = (await response.json()).token;
    } else {
      token = legacy;
      if (!token) { try { token = storage?.getItem(STORAGE_KEY); } catch { /* storage unavailable */ } }
    }
    if (typeof token !== 'string' || !token) throw new Error('publisher invitation required');
    const valid = await fetchImpl('/api/capture-session', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    if (!valid.ok) throw new Error('invalid invitation');
    try { storage?.setItem(STORAGE_KEY, token); } catch { /* current tab still works without persistence */ }
    return token;
  } catch (error) {
    try { storage?.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
    throw error;
  }
}

export async function createShareLink({ publicOrigin, apiBase = '', token, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(`${apiBase}/api/share-link`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error('Não foi possível criar o convite. Tente novamente.');
  const { code } = await response.json();
  if (typeof code !== 'string' || !code) throw new Error('Convite indisponível.');
  return `${publicOrigin}/share?code=${encodeURIComponent(code)}`;
}
