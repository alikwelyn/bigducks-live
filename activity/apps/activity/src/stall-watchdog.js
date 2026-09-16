const STALL_MS = 6000;
const SAMPLE_MS = 2000;

// Live media must keep advancing. A connection can stay "connected" while
// delivering nothing, so recovery keys off progress, not connection state.
export function createStallWatchdog({ sample, onStall = () => {}, intervalMs = SAMPLE_MS, stallMs = STALL_MS, now = () => Date.now() } = {}) {
  let timer;
  let armed = false;
  let lastProgressAt = 0;
  let latest = new Map();
  let triggered = false;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(pool, intervalMs); };
  const pool = async () => {
    if (!armed) return;
    try {
      const current = await sample();
      let progressed = false;
      for (const [id, value] of current) {
        const before = latest.get(id);
        if (before === undefined || value > before) progressed = true;
      }
      latest = new Map(current);
      if (progressed || !latest.size) { lastProgressAt = now(); triggered = false; }
      else if (!triggered && now() - lastProgressAt >= stallMs) { triggered = true; onStall(); }
    } catch { lastProgressAt = now(); }
    if (armed) schedule();
  };
  return {
    start() { if (armed) return; armed = true; triggered = false; lastProgressAt = now(); latest = new Map(); schedule(); },
    stop() { armed = false; clearTimeout(timer); timer = undefined; },
    get stalled() { return triggered; },
  };
}

// Owns the single live watchdog. Teardown paths only have to call stop(), so a
// forgotten cancellation cannot leave a poll running against a closed peer.
export function createStallWatchController({ create = createStallWatchdog } = {}) {
  let current;
  return {
    watch(sample, onStall) {
      current?.stop();
      current = create({ sample, onStall });
      current.start();
      return current;
    },
    stop() { current?.stop(); current = undefined; },
    get armed() { return Boolean(current); },
  };
}
