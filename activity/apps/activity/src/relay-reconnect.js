// Cloudflare closes an idle WebSocket and may restart servers, so losing the room
// connection is normal rather than exceptional. Retrying is what keeps a live
// alive instead of ending it for everyone.
export function createReconnecter({ connect, onOpen, onGiveUp = () => {}, onAttempt = () => {}, attempts = 6, baseMs = 1000, maxMs = 15_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let running = false;
  let stopped = false;
  const delayFor = (attempt) => Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const run = async () => {
    running = true;
    for (let attempt = 1; attempt <= attempts && !stopped; attempt++) {
      const wait = delayFor(attempt);
      onAttempt(attempt, wait);
      await sleep(wait);
      if (stopped) break;
      try {
        const value = await connect();
        if (stopped) return;
        await onOpen(value);
        running = false;
        return;
      } catch { /* try again */ }
    }
    running = false;
    if (!stopped) onGiveUp();
  };
  return {
    start() { if (running) return; stopped = false; void run(); },
    stop() { stopped = true; running = false; },
    get running() { return running; },
    delayFor,
  };
}
