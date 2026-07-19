// Async logger with microsecond-precision pipeline benchmarking.
//
// Why async? console.log is synchronous — it blocks the event loop waiting for stdout.
// At sub-5ms pipeline targets, even one sync log adds 1-3ms of jitter.
// setImmediate defers the write to the next tick, so the hot path continues unblocked.
//
// Why two timestamps?
// - Date.now() (wall-clock): human-readable, "when did this happen" in logs
// - performance.now() (monotonic): microsecond-precision elapsed time for benchmarking.
//   Monotonic clocks only go forward — immune to NTP/system clock jumps.

const PROCESS_START = performance.now();

function wallClock(): string {
  return new Date().toISOString();
}

function elapsed(): string {
  return `${(performance.now() - PROCESS_START).toFixed(3)}ms`;
}

// Non-blocking emit: captures timestamps at call time (accurate), defers the actual write.
function emit(tag: string, msg: string): void {
  const ts = wallClock();
  const el = elapsed();
  setImmediate(() => {
    console.log(`[${ts}] [+${el}] [${tag}] ${msg}`);
  });
}

export function log(tag: string, msg: string): void {
  emit(tag, msg);
}

export function perf(tag: string, label: string, startMs: number): void {
  const delta = (performance.now() - startMs).toFixed(3);
  emit(tag, `${label} (+${delta}ms from start)`);
}

// Pipeline timer: call checkpoint() at each stage, finish() to emit the full breakdown.
// Used in blaze's hot path to measure market lookup → user lookup → FAK order.
export function createTimer() {
  const t0 = performance.now();
  const checkpoints: { label: string; time: number }[] = [];

  return {
    checkpoint(label: string) {
      checkpoints.push({ label, time: performance.now() });
    },
    finish(tag: string) {
      const total = (performance.now() - t0).toFixed(3);
      const breakdown = checkpoints
        .map((c, i) => {
          const prev = i === 0 ? t0 : checkpoints[i - 1].time;
          return `${c.label}: ${(c.time - prev).toFixed(3)}ms`;
        })
        .join(" → ");
      emit(tag, `Pipeline done in ${total}ms | ${breakdown}`);
    },
  };
}
