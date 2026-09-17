// The server explains why a session was refused; the UI used to discard that and
// show a generic "could not load the room", which hid a misconfigured gate.
export async function requestSession({ fetchImpl = globalThis.fetch, apiBase = '', identity, role, room, signal }) {
  const response = await fetchImpl(`${apiBase}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(identity?.accessToken ? { authorization: `Bearer ${identity.accessToken}` } : {}) },
    body: JSON.stringify({ room, user: identity?.user, role }),
    ...(signal ? { signal } : {}),
  });
  const body = await response.json().catch(() => ({}));
  if (response.ok && typeof body.token === 'string') return { token: body.token };
  const error = new Error(body.error || 'session unavailable');
  error.code = body.code || `http_${response.status}`;
  error.status = response.status;
  throw error;
}

// A token that never granted the `guilds` scope cannot be checked at all, so this
// is the one refusal worth retrying after asking Discord for consent again.
export const REAUTHORISE_CODES = new Set(['guild_unverifiable']);

export function sessionMessage(error) {
  switch (error?.code) {
    case 'guild_required': return 'Sua conta não está no servidor autorizado para esta Activity.';
    case 'guild_unverifiable': return 'Não foi possível verificar seu acesso ao servidor. Autorize a Activity novamente.';
    case 'discord_required':
    case 'discord_failed': return 'Não foi possível confirmar sua conta do Discord. Abra a Activity novamente pelo Discord.';
    default: return 'Não foi possível carregar a sala. Tente novamente.';
  }
}
