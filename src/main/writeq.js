// perf2 (docs/perf.md 案 6): settings / state files are written off the main thread's critical path.
// One serial queue per file, newest data wins: while a write is running, later writes only replace the
// pending text, and the running loop writes the newest text once more when it is done. Each write goes to
// a temp file first and is renamed over the target (a reader never sees a half-written file).
// On Windows the rename fails with EPERM / EBUSY / EACCES while a reader (the manager's claude) has the
// target open; it is retried a few times with short async pauses instead of blocking main.
// No Electron imports (testable from plain Node).
const fs = require('fs');
const path = require('path');
const { timebox, TIMED_OUT, limits } = require('./timebox');

const RETRY_MS = [20, 60, 150, 400, 1000];
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const queues = new Map(); // resolved path -> { text, version, onDisk, running }

const keyOf = (file) => path.resolve(file);
function queueOf(file) {
  const k = keyOf(file);
  let q = queues.get(k);
  if (!q) queues.set(k, (q = { file: k, text: null, version: 0, onDisk: 0, running: null }));
  return q;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      return await fs.promises.rename(from, to);
    } catch (err) {
      if (i >= RETRY_MS.length || !RETRY_CODES.has(err && err.code)) throw err;
      await sleep(RETRY_MS[i]);
    }
  }
}

// One async attempt: tmp + rename. An attempt given up by run() (a.abandoned) does not rename once it finds out; one
// whose rename was already under way and lands late puts the newest text back (it may have overwritten it).
async function attempt(q, text, a) {
  await fs.promises.mkdir(path.dirname(q.file), { recursive: true });
  // the usual temp name, unless an abandoned attempt may still write its own
  const tmp = q.abandonedLive ? `${q.file}.${a.n}.tmp` : q.file + '.tmp';
  try {
    await fs.promises.writeFile(tmp, text);
    if (a.abandoned) throw Object.assign(new Error('abandoned'), { code: 'ABANDONED' });
    await renameRetry(tmp, q.file);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
  if (a.abandoned) lateRename(q);
}
// AT-202: the newest text this queue knows is written again (sync) after an abandoned attempt renamed an older one.
function lateRename(q) {
  const text = q.text !== null ? q.text : q.last;
  if (text === null || text === undefined) return;
  try {
    syncWrite(q.file, text);
  } catch (err) {
    console.warn('[writeq] rewrite after a late rename failed', q.file, err && err.code ? err.code : err);
  }
}
function syncWrite(file, text) {
  const tmp = file + '.sync.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, text);
    renameRetrySync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}
// AT-202: a step longer than this (thread pool held by slow disk work elsewhere) is not waited for: the text is written
// synchronously instead (state files are small, a sync write takes milliseconds when the disk itself answers).
const SYNC_FALLBACK_MAX = 4 * 1024 * 1024;
let attempts = 0;

async function run(q) {
  let ok = true;
  try {
    while (q.onDisk < q.version) {
      const v = q.version;
      const text = q.text;
      const a = { n: ++attempts, abandoned: false };
      const step = attempt(q, text, a);
      const r = await timebox(step, limits.write(), {
        onLate: (_v, err) => err && err.code !== 'ABANDONED' && console.warn('[writeq] late async write failed', q.file, err.code || err),
      });
      if (r === TIMED_OUT) {
        a.abandoned = true;
        q.abandonedLive = (q.abandonedLive || 0) + 1;
        const settle = () => q.abandonedLive--;
        step.then(settle, settle);
        q.slowWrites = (q.slowWrites || 0) + 1;
        console.warn(`[writeq] async write of ${path.basename(q.file)} took over ${limits.write()} ms, writing it synchronously`);
        if (text.length > SYNC_FALLBACK_MAX) throw Object.assign(new Error('slow and too big for a sync write'), { code: 'ETIMEDOUT' });
        syncWrite(q.file, text);
      }
      q.last = text;
      if (v > q.onDisk) q.onDisk = v;
    }
  } catch (err) {
    console.warn('[writeq] save failed', q.file, err && err.code ? err.code : err);
    ok = false; // q.text keeps the newest data: readers still see it, the next write retries
    // Still busy after the quick retries (a reader keeps the file open), or slow: try again later by itself,
    // so the newest data does not wait for the next save or the quit.
    if ((RETRY_CODES.has(err && err.code) || (err && err.code === 'ETIMEDOUT')) && !q.later && (q.laterCount = (q.laterCount || 0) + 1) <= LATER_MAX) {
      q.later = setTimeout(() => {
        q.later = null;
        if (!q.running && q.text !== null && q.onDisk < q.version) q.running = run(q);
      }, LATER_MS);
      if (q.later.unref) q.later.unref();
    }
  }
  q.running = null;
  if (ok) {
    q.text = null; // the disk is current
    q.laterCount = 0;
  }
  return ok;
}
const LATER_MS = 2000;
const LATER_MAX = 30;

// Queue a write of `text` to `file`. -> Promise<boolean>: true when this (or newer) text is on disk.
function write(file, text) {
  const q = queueOf(file);
  q.text = String(text);
  q.version++;
  if (!q.running) q.running = run(q);
  return q.running;
}

// Synchronous write (beforeunload / quit). A running async loop rewrites the same newest text after it
// (the version moved on), so an older async rename cannot win. Its own temp name keeps the two apart.
function writeSync(file, text) {
  const q = queueOf(file);
  q.version++;
  const s = String(text);
  if (q.running) q.text = s;
  else {
    q.onDisk = q.version;
    q.text = null;
  }
  const tmp = q.file + '.sync.tmp';
  try {
    fs.mkdirSync(path.dirname(q.file), { recursive: true });
    fs.writeFileSync(tmp, s);
    renameRetrySync(tmp, q.file);
    return true;
  } catch (err) {
    console.warn('[writeq] sync save failed', q.file, err && err.code ? err.code : err);
    if (!q.running) q.text = s; // keep it for readers and for flushSync / the next write
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return false;
  }
}

// Only for the sync path (beforeunload / quit, rare): a rename racing the async one, or a reader holding
// the file, gets up to ~100 ms of short pauses.
const SYNC_RETRY_MS = [5, 15, 30, 50];
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function renameRetrySync(from, to) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      if (i >= SYNC_RETRY_MS.length || !RETRY_CODES.has(err && err.code)) throw err;
      pause(SYNC_RETRY_MS[i]);
    }
  }
}

// The newest text queued for `file` that may not be on disk yet, else null.
function pending(file) {
  const q = queues.get(keyOf(file));
  return q && q.text !== null ? q.text : null;
}

// Read-your-writes: the queued text if any, else the file (sync; small settings files only).
function readTextSync(file) {
  const p = pending(file);
  return p !== null ? p : fs.readFileSync(file, 'utf8');
}

// Write every pending text now (quit). Returns the number of files written.
function flushSync() {
  let n = 0;
  for (const q of queues.values()) {
    if (q.text === null) continue;
    if (writeSync(q.file, q.text)) n++;
  }
  return n;
}

// -> Promise<boolean>: the running write of `file` (true when the newest text got on disk), else true at once.
function whenWritten(file) {
  const q = queues.get(keyOf(file));
  return q && q.running ? q.running : Promise.resolve(true);
}

// Resolves when no write is running (tests).
async function idle() {
  for (;;) {
    const r = [...queues.values()].map((q) => q.running).filter(Boolean);
    if (!r.length) return;
    await Promise.all(r);
  }
}

module.exports = { write, writeSync, pending, readTextSync, flushSync, whenWritten, idle };
