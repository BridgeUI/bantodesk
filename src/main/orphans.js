// Startup sweep of processes a killed previous run of this app left suspended (PROGRESS 47; the maintainers' test notes,
// 注 "LISTEN が残る"). No Electron imports, so the choice is testable from plain Node.
//
// Why: Node/libuv starts a child with CreateProcess(CREATE_SUSPENDED), puts it in its kill-on-close job, then resumes
// it. When the main process is killed (Task Manager, crash, taskkill /F) while a CreateProcess is in flight (procmem's
// powershell.exe on a worker thread: ~300 ms with endpoint protection, every 60 s and after each tab start), the child
// is never resumed: it stays suspended forever (~1 MB) holding copies of the dead main's inheritable handles.
//
// How the sweep tells "ours" from everything else: every start appends { pid, startedAt } of this main process to
// <userData>/main-pids.json. At the next start, for each recorded main that is gone (no such PID, or the PID now
// belongs to a process started at another time), the children it created whose every thread is suspended are
// killed. The file is per userData, so stable (%APPDATA%\bantodesk) and dev (another --user-data-dir) never
// touch each other's processes, even when both run at once. Running children (a tab's claude.exe, a git call) are
// left alone: only a process that never ran a single instruction is stopped.
// The list: src/main/proclist.js (the app's native module, SEC3: NtQuerySystemInformation: parents, creation times,
// every thread's state), not WMI (Get-CimInstance does not return on this PC, docs/proclist.md).
const fs = require('fs');
const path = require('path');
const proclist = require('./proclist');

const FILE = 'main-pids.json';
const RESULT = 'orphan-sweep.json';
const KEEP = 10; // previous mains kept while their sweep has not run yet (killed again within the delay)
const SAME_START_MS = 10000; // a PID whose process started this close to the recorded time is still that main

const startedAt = Date.now() - Math.round(process.uptime() * 1000);

function readList(userData) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(userData, FILE), 'utf8'));
    return Array.isArray(v) ? v.filter((e) => e && Number.isInteger(e.pid) && e.pid > 0 && Number.isFinite(e.startedAt)) : [];
  } catch {
    return [];
  }
}

function writeList(userData, list) {
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, FILE), JSON.stringify(list.slice(-KEEP)));
  } catch {}
}

// Record this main; -> the previous mains (not this one).
function record(userData, me = { pid: process.pid, startedAt }) {
  const prev = readList(userData).filter((e) => e.pid !== me.pid || Math.abs(e.startedAt - me.startedAt) > SAME_START_MS);
  writeList(userData, [...prev, me]);
  return prev;
}

// prev: [{ pid, startedAt }], par: [{ pid, created }] (processes now holding those PIDs),
// kids: [{ pid, ppid, name, created, suspended? }], th: [{ pid, state, wait }] (thread rows of the kids; used when a
// kid has no `suspended`)
// -> { dead: [prev entries that are gone], orphans: [kids to kill] }
function pickOrphans({ prev, par, kids, th = [] }) {
  const now = new Map(par.map((p) => [p.pid, p.created]));
  const dead = prev.filter((e) => !now.has(e.pid) || Math.abs(now.get(e.pid) - e.startedAt) > SAME_START_MS);
  const threads = new Map();
  for (const t of th) {
    if (!threads.has(t.pid)) threads.set(t.pid, []);
    threads.get(t.pid).push(t);
  }
  const orphans = [];
  for (const k of kids) {
    // created by that main: after it started (not by an older process that had the same PID) and, when the PID has
    // been reused since, before the new owner started (not by the new owner)
    const m = dead.find((e) => e.pid === k.ppid && k.created >= e.startedAt - 2000 && (!now.has(e.pid) || k.created < now.get(e.pid)));
    if (!m) continue;
    const ts = threads.get(k.pid) || [];
    // ThreadState 5 = Waiting, ThreadWaitReason 5 = Suspended (proclist's `suspended`: the same test on every thread)
    const susp = typeof k.suspended === 'boolean' ? k.suspended : ts.length > 0 && ts.every((t) => t.state === 5 && t.wait === 5);
    if (susp) orphans.push({ ...k, mainStartedAt: m.startedAt });
  }
  return { dead, orphans };
}

// proclist rows, the recorded main PIDs -> { par, kids } for pickOrphans
function fromList(procs, pids) {
  const ids = new Set(pids);
  return {
    // an exited process whose handle someone still holds stays listed, with no threads: that main is gone
    par: procs.filter((p) => ids.has(p.pid) && p.threads > 0).map((p) => ({ pid: p.pid, created: p.created })),
    kids: procs.filter((p) => ids.has(p.ppid) && p.pid !== p.ppid).map((p) => ({ pid: p.pid, ppid: p.ppid, name: p.name, created: p.created, suspended: p.suspended })),
  };
}

// -> Promise<{ at, prev, dead, killed: [{ pid, ppid, name }], error? }> (also written to <userData>/orphan-sweep.json)
// list (tests): () -> Promise<proclist rows>, else proclist.list (the native module)
async function sweepOnce({ userData, list, kill = (pid) => process.kill(pid), me, log = () => {} }) {
  const prev = record(userData, me);
  const res = { at: new Date().toISOString(), prev, dead: [], killed: [] };
  if (process.platform === 'win32' && prev.length) {
    try {
      const procs = await (list ? list() : proclist.list({ timeout: 20000 }));
      const { dead, orphans } = pickOrphans({ prev, ...fromList(procs, prev.map((e) => e.pid)) });
      res.dead = dead;
      for (const o of orphans) {
        try {
          kill(o.pid);
          res.killed.push({ pid: o.pid, ppid: o.ppid, name: o.name });
        } catch {}
      }
      // swept mains are done with; a live one (PID reused at the same time: never in practice) stays
      const deadSet = new Set(dead.map((e) => `${e.pid}:${e.startedAt}`));
      writeList(userData, readList(userData).filter((e) => !deadSet.has(`${e.pid}:${e.startedAt}`)));
    } catch (e) {
      res.error = String(e.message || e); // the entries stay: the next start tries again
    }
  }
  if (res.killed.length) log('[orphans] killed suspended children of a previous run:', res.killed.map((k) => `${k.pid} ${k.name} (parent ${k.ppid})`).join(', '));
  return res;
}

// A main killed just before this start can still be listed for a few seconds (with threads, while Windows tears it
// down; seen 2 times in 6 on this PC): while a previous main is not gone yet or the query failed, try again every
// gapMs, `tries` times in all. -> the last result with `killed` summed over the tries and `attempt`.
async function sweep({ tries = 4, gapMs = 15000, sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.()), ...opts }) {
  const killed = [];
  let res;
  for (let attempt = 1; attempt <= tries; attempt++) {
    res = await sweepOnce(opts);
    killed.push(...res.killed);
    res = { ...res, killed, attempt };
    try {
      fs.writeFileSync(path.join(opts.userData, RESULT), JSON.stringify(res, null, 1));
    } catch {}
    if (!res.error && res.dead.length === res.prev.length) break;
    if (attempt < tries) await sleep(gapMs);
  }
  return res;
}

module.exports = { sweep, sweepOnce, record, pickOrphans, fromList, startedAt, FILE, RESULT };
