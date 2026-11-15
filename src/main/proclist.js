// One process list for everything in src/main that needs one (waits, procmem, orphans, stoptree), without WMI and
// without PowerShell. No Electron imports, so it is testable from plain Node.
//
// Why: on this PC Get-CimInstance Win32_Process (and wmic / taskkill, which use WMI) can take 40 s+ or never return
// (docs/proclist.md, docs/close-done.md). The first replacement compiled C# at run time into a DLL under the temp
// folder and was flagged by endpoint security (EDR) products (docs/security.md).
// How (SEC3, docs/security.md): the app's own native module src/main/native/atproc.node (N-API, built
// from native/atproc, shipped in src) takes one NtQuerySystemInformation(SystemProcessInformation) snapshot on a
// libuv worker thread: PID, parent, creation time, thread count, private bytes, image name and "every thread
// suspended". Nothing is compiled or written at run time, no process is started, no other process is opened, and no
// command line is read (CLAUDE.md: PID / parent / memory only). Rows keep `cmd: null` (not read) for the callers.
const path = require('path');

const NATIVE = path.join(__dirname, 'native', 'atproc.node');
let mod = null;
let loadErr = null;
// -> the native module, or throws (not Windows x64, the file missing or not loadable)
function native() {
  if (mod) return mod;
  if (loadErr) throw loadErr;
  try {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error(`proclist: Windows x64 only (${process.platform} ${process.arch})`);
    mod = require(NATIVE);
    return mod;
  } catch (e) {
    loadErr = e instanceof Error ? e : new Error(String(e));
    throw loadErr;
  }
}

// native rows -> [{ pid, ppid, created (NaN = unknown), threads, priv, suspended, name, cmd: null }]
function rowsOf(raw) {
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!r || !Number.isFinite(r.pid) || !Number.isFinite(r.ppid)) continue;
    out.push({
      pid: r.pid,
      ppid: r.ppid,
      created: r.created > 0 ? r.created : NaN,
      threads: r.threads | 0,
      priv: Number(r.priv) || 0,
      suspended: r.suspended === true,
      name: String(r.name || '').trim(),
      cmd: null,
    });
  }
  return out;
}

// -> Promise<procs> (rejects on a failure, a time-out or an empty list: never read as "every process gone").
// impl (tests): { list() -> Promise<raw rows> } instead of the native module. Calls while one runs share it.
// withCmd / run / dir: accepted for the old callers and ignored (no command lines, no child process).
let running = null;
function list({ impl, timeout = 20000 } = {}) {
  if (!impl && running) return running;
  const p = (async () => {
    const m = impl || native();
    let timer;
    const raw = await Promise.race([
      m.list(),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`proclist: no answer in ${timeout} ms`)), timeout);
      }),
    ]).finally(() => clearTimeout(timer));
    const procs = rowsOf(raw);
    if (!procs.length) throw new Error('proclist: empty list');
    return procs;
  })();
  if (impl) return p;
  running = p.finally(() => (running = null));
  return running;
}

// The same rows on the calling thread (test teardown tools; tens of ms). Throws like list().
function listSync() {
  const procs = rowsOf(native().listSync());
  if (!procs.length) throw new Error('proclist: empty list');
  return procs;
}

// procs, root pid -> [root, ...descendants] by parent PID, skipping a "child" older than its parent (a reused PID)
function descendants(procs, root, sameMs = 2000) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const r = byPid.get(root);
  if (!r) return [];
  const kids = new Map();
  for (const p of procs) {
    if (p.pid === p.ppid) continue;
    const par = byPid.get(p.ppid);
    if (par && Number.isFinite(p.created) && Number.isFinite(par.created) && p.created + sameMs < par.created) continue;
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const out = [];
  const seen = new Set();
  const stack = [r];
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push(p);
    for (const c of kids.get(p.pid) || []) stack.push(c);
  }
  return out;
}

module.exports = { list, listSync, rowsOf, descendants, NATIVE, native };
