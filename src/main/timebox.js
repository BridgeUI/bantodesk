// AT-202: a time limit for one await on a step that may hang (async fs work waits for a libuv thread-pool slot; on
// Windows a slow disk / file scan can hold the pool for minutes). The caller goes on with a fallback instead of
// holding its "running" guard (and every later snapshot of manager/*.json) until the step comes back.
// The step itself is not cancelled: when it settles late, onLate(value | undefined, error | undefined) runs.
// No Electron imports (testable from plain Node).
'use strict';

const TIMED_OUT = Symbol('timed out');

// -> Promise<value | TIMED_OUT>; a rejection inside the limit rejects as usual.
function timebox(promise, ms, { onLate = null, label = '' } = {}) {
  const p = Promise.resolve(promise);
  if (!(ms > 0)) return p;
  let timer = null;
  let late = false;
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => {
      late = true;
      slowAt = Date.now();
      if (label) console.warn(`[timebox] ${label}: no answer after ${ms} ms, going on without it`);
      resolve(TIMED_OUT);
    }, ms);
    if (timer.unref) timer.unref();
  });
  p.then(
    (v) => {
      clearTimeout(timer);
      if (late && onLate) onLate(v, undefined);
    },
    (err) => {
      clearTimeout(timer);
      if (late && onLate) onLate(undefined, err);
    }
  );
  return Promise.race([p, limit]);
}

// The time limits (ms); tests shorten them through the environment. After any step ran out of time, the pool is
// probably still held: for SLOW_WINDOW_MS the short step limits drop to SLOW_STEP_MS, so the steps after it go to
// their fallback at once instead of each waiting its whole limit again.
let slowAt = 0;
const SLOW_WINDOW_MS = 30_000;
const SLOW_STEP_MS = 250;
const env = (k, d) => Number(process.env[k]) || d;
const step = (ms) => (Date.now() - slowAt < SLOW_WINDOW_MS ? Math.min(ms, SLOW_STEP_MS) : ms);
const limits = {
  write: () => step(env('AGENT_TERMINAL_WRITEQ_STEP_MS', 5000)), // one async write + rename of a small state file
  read: () => step(env('AGENT_TERMINAL_SLOW_READ_MS', 3000)), // one async read / stat / readdir for a snapshot
  snapshot: () => env('AGENT_TERMINAL_SNAPSHOT_MS', 30000), // a whole manager snapshot (projects.json)
  outbox: () => env('AGENT_TERMINAL_OUTBOX_FILE_MS', 60000), // one outbox file before the next one may start
};

module.exports = { timebox, TIMED_OUT, limits, _resetSlow: () => (slowAt = 0) };
