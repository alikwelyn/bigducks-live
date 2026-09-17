// Reports how many bytes this client received, purely for the owner's monthly
// visibility. It never throttles, stops or gates anything.
export function createUsageReporter({ send, sample, intervalMs = 30_000 } = {}) {
  let timer;
  let last;
  const tick = async () => {
    try {
      const total = await sample();
      if (Number.isFinite(total)) {
        // A counter that went backwards means the transport restarted.
        const previous = last === undefined || total < last ? total : last;
        const delta = total - previous;
        last = total;
        if (delta > 0) send(delta);
      }
    } catch { /* reporting must never disturb playback */ }
    if (timer) timer = setTimeout(tick, intervalMs);
  };
  return {
    start() { if (timer) return; last = undefined; timer = setTimeout(tick, intervalMs); },
    stop() { clearTimeout(timer); timer = undefined; },
    get running() { return Boolean(timer); },
  };
}
