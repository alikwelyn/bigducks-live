// Short, stable codes so a friend can report "deu 0x5" and the meaning is exact.
// NEVER renumber an existing entry: a code that changes meaning is worse than none.
export const CODES = Object.freeze({
  SFU_ACTIVE: 0x0,
  RELAY_ACTIVE: 0x1,
  P2P_ACTIVE: 0x2,
  SFU_TIMEOUT: 0x3,
  SFU_LOST: 0x4,
  RELAY_STALL: 0x5,
  SOCKET_CLOSED: 0x6,
  ROOM_TIMEOUT: 0x7,
  GUILD_REQUIRED: 0x8,
  GUILD_UNVERIFIABLE: 0x9,
  DISCORD_AUTH: 0xa,
  CAPTURE_DENIED: 0xb,
  CAPTURE_ENDED: 0xc,
  CAPTURE_FAILED: 0xd,
  PUBLISH_FAILED: 0xe,
  RELAY_UNAVAILABLE: 0xf,
});

export function codeLabel(code) {
  return typeof code === 'number' && Number.isInteger(code) ? `0x${code.toString(16).toUpperCase()}` : '';
}

// Appends the code to a sentence, e.g. "Transmissão interrompida (0xC)".
export function withCode(text, code) {
  const label = codeLabel(code);
  return label ? `${text} (${label})` : text;
}

const SESSION_CODES = {
  guild_required: CODES.GUILD_REQUIRED,
  guild_unverifiable: CODES.GUILD_UNVERIFIABLE,
  discord_required: CODES.DISCORD_AUTH,
  discord_failed: CODES.DISCORD_AUTH,
};

export function codeForSessionError(error) {
  return SESSION_CODES[error?.code] ?? undefined;
}
