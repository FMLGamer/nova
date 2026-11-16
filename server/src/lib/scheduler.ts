/** Runs background jobs on a fixed interval, never overlapping and never throwing. */
const jobs = new Map<string, { running: boolean; timer: NodeJS.Timeout }>();

export function every(name: string, intervalMs: number, fn: () => Promise<unknown> | unknown, opts: { initialDelayMs?: number } = {}): void {
  if (jobs.has(name)) return;
  const state = { running: false, timer: undefined as unknown as NodeJS.Timeout };
  const tick = async () => {
    if (state.running) return;
    state.running = true;
    try {
      await fn();
    } catch (err) {
      console.error(`[jobs] ${name} failed:`, err);
    } finally {
      state.running = false;
    }
  };
  state.timer = setInterval(tick, intervalMs);
  state.timer.unref();
  setTimeout(tick, opts.initialDelayMs ?? Math.min(30_000, intervalMs)).unref();
  jobs.set(name, state);
}

/** Next UTC time today/tomorrow at `hour`:00, in ms from now. */
export function msUntilUtcHour(hour: number): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour);
  return next > now.getTime() ? next - now.getTime() : next + 86_400_000 - now.getTime();
}
