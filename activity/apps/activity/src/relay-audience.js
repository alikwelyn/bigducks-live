// The relay encoder must not keep producing video for an empty relay audience:
// with zero relay viewers the bytes are billed and wasted, and the SFU path
// already has its own idle economy.
export function relayEncoderAction({ viewers = 0, running = false, starting = false } = {}) {
  if (viewers > 0) return running || starting ? 'keep' : 'start';
  return running || starting ? 'stop' : 'keep';
}
