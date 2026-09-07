import crypto from 'node:crypto';

export function loadConfig(env = process.env) {
  const secret = env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must have at least 32 characters');
  if (env.NODE_ENV === 'production' && env.ALLOW_DEV_SESSIONS === 'true') throw new Error('ALLOW_DEV_SESSIONS cannot be enabled in production');
  return {
    secret,
    port: Number(env.PORT || 3001),
    origin: env.PUBLIC_ORIGIN || '',
    clientId: env.DISCORD_CLIENT_ID || '',
    clientSecret: env.DISCORD_CLIENT_SECRET || '',
    allowDevSessions: env.ALLOW_DEV_SESSIONS === 'true' && env.NODE_ENV !== 'production',
    maxViewers: Number(env.MAX_VIEWERS || 25),
    turnKeyId: env.CLOUDFLARE_TURN_KEY_ID || '',
    turnKeySecret: env.CLOUDFLARE_TURN_KEY_SECRET || '',
    iceServers: env.TURN_URL ? [{ urls: env.TURN_URL, username: env.TURN_USER, credential: env.TURN_PASS }] : [],
  };
}

export function generateSecret() { return crypto.randomBytes(32).toString('hex'); }
