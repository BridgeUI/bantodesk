// Memory of each session's process tree (docs/memory-investigation.md, proposal A). No Electron imports,
// so the tree arithmetic is testable from plain Node.
//
// One process list per sample (src/main/proclist.js, the native module: no WMI / PowerShell) gives
// every process with its parent and private bytes; a session's figure is the sum over the pty's shell (pty.pid) and
// all its descendants (claude.exe and its tool processes). Windows only; elsewhere sample() resolves to an empty Map.
const proclist = require('./proclist');

// "pid ppid privateBytes" lines -> [{ pid, ppid, priv }] (the old text form; kept for tests and tools)
function parseList(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) out.push({ pid: +m[1], ppid: +m[2], priv: +m[3] });
  }
  return out;
}

// roots: pid[] -> Map(rootPid -> { bytes, count }) (root included; pids missing from the list are skipped)
function treeTotals(procs, roots) {
  const byPid = new Map();
  const kids = new Map();
  for (const p of procs) {
    byPid.set(p.pid, p);
    if (p.pid === p.ppid) continue; // System Idle (0 -> 0)
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const res = new Map();
  for (const root of roots) {
    const r = byPid.get(root);
    if (!r) continue;
    let bytes = 0;
    let count = 0;
    const seen = new Set();
    const stack = [r];
    while (stack.length) {
      const p = stack.pop();
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      bytes += p.priv;
      count++;
      for (const c of kids.get(p.pid) || []) stack.push(c);
    }
    res.set(root, { bytes, count });
  }
  return res;
}

// roots: pid[] -> Promise<Map(rootPid -> { bytes, count })>. Concurrent calls share one list (proclist: the native
// module on a libuv worker, no child process).
function sample(roots) {
  if (process.platform !== 'win32' || !roots.length) return Promise.resolve(new Map());
  return proclist.list({ timeout: 20000 }).then(
    (procs) => treeTotals(procs, roots),
    () => new Map()
  );
}

module.exports = { parseList, treeTotals, sample };
