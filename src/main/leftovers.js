// Processes the app's sessions left behind (PROGRESS 51c, docs/proc-leftovers.md "止めてよいものの条件" 1 and 2): count
// them with their private MB for the dashboard, and stop them by the setting. No Electron imports (plain Node tests).
//
// What counts (only processes that ran under one of the app's tabs; never a claude / VS Code / test started by hand):
//   A suspended  every thread suspended, 1 thread (created, never resumed: its parent was killed in between), the parent
//                gone (or its PID reused by a later process), older than minAgeMs.
//   B tasklist   tasklist.exe older than minAgeMs (it waits for WMI for good) whose parent is gone, or whose parent is a
//                cmd.exe that has lost its own parent; with it that cmd.exe and its findstr.exe started at the same time.
// Never counted: msedgewebview2.exe (WebView2 hosts suspend their own on purpose), a live tab's claude itself, anything
// that is not under a tab. WindowsApps / SystemApps (UWP) and other users' processes cannot be under a tab (their parent
// is the OS's DcomLaunch / another logon); the list has no paths or owners to check (proclist: SEC3, PID / parent /
// memory only, no process is opened).
//
// How "under a tab" is known after the parent died: remember() keeps { pid, created } of every process seen in a tab's
// tree (sampled every minute, and right before a tab's tree is stopped). A process whose parent is such a remembered one
// (created after it, and not after a later owner of that PID started) is under the same tab, and so on down.
//
// Stopping (mode): 'ended' (default; QA 51c-3: when a session goes, its children must not stay as zombies) stops the
// leftovers of sessions whose claude is gone (closed, rested, restarted, exited); 'all' also those of sessions still
// running; 'off' only counts. A leftover is never waited for: A never ran an instruction, B waits for WMI forever.
const fs = require('fs');
const path = require('path');

const SAME_MS = 2000; // creation times read twice differ by rounding only
const MIN_AGE_MS = 10 * 60_000; // docs/proc-leftovers.md: 10 min (a tasklist normally returns in seconds)
const ENDED_MIN_AGE_MS = 2 * 60_000; // a session that is gone: nobody will resume its children
// remembered processes that are gone are kept this long, as parents: a live child is remembered itself at the next look,
// so a gone parent is only needed until then (or across an app restart)
const KEEP_MS = 3600_000;
const MAX_KNOWN = 20000;
const COMPANION_MS = 10_000; // findstr of the same pipe as the tasklist
const MODES = ['off', 'ended', 'all'];
const DEFAULT_MODE = 'ended';
const KNOWN_FILE = 'proc-known.json';
const RESULT_FILE = 'proc-leftovers.json';
const SETTINGS_FILE = 'leftovers-settings.json';

const lower = (s) => String(s || '').toLowerCase();
const keyOf = (pid, created) => `${pid}:${Math.round(created / 1000)}`;
const live = (p) => !!p && p.threads > 0; // an exited process someone still holds a handle to: listed with no threads

// procs -> Map pid -> row (live only)
function byPidOf(procs) {
  const m = new Map();
  for (const p of procs || []) if (live(p) && p.pid !== p.ppid) m.set(p.pid, p);
  return m;
}

// the row of `pid` when it is that remembered process (same creation time), else null
function sameProc(byPid, k) {
  const p = byPid.get(k.pid);
  if (!p) return null;
  if (Number.isFinite(p.created) && Number.isFinite(k.created)) return Math.abs(p.created - k.created) <= SAME_MS ? p : null;
  return lower(p.name) === lower(k.name) ? p : null;
}

// p's parent row when the parent is alive (and not a later process with the reused PID), else null
function parentOf(byPid, p) {
  const q = byPid.get(p.ppid);
  if (!q || q.pid === p.pid) return null;
  if (Number.isFinite(q.created) && Number.isFinite(p.created) && q.created > p.created + SAME_MS) return null;
  return q;
}

// roots: [{ pid, created? }] -> Set of root keys alive in procs
function liveRootKeys(byPid, roots) {
  const out = new Set();
  for (const r of roots || []) {
    const p = byPid.get(r && r.pid);
    if (p && (!Number.isFinite(r.created) || Math.abs(p.created - r.created) <= SAME_MS)) out.add(keyOf(p.pid, p.created));
  }
  return out;
}

// known: Map key -> { pid, ppid, created, name, root, seenAt }. Adds every process of each root's tree, then every live
// process whose parent is a remembered one (children of a parent that died before it was sampled again), to a fixed
// point. Changes `known` in place; -> number of entries added.
function remember(known, procs, roots, now = Date.now()) {
  const byPid = byPidOf(procs);
  let added = 0;
  const put = (p, root) => {
    const k = keyOf(p.pid, p.created);
    const old = known.get(k);
    if (old) {
      old.seenAt = now;
      return false;
    }
    known.set(k, { pid: p.pid, ppid: p.ppid, created: p.created, name: p.name, root, seenAt: now });
    added++;
    return true;
  };
  const kids = new Map();
  for (const p of byPid.values()) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  for (const r of roots || []) {
    const rp = byPid.get(r && r.pid);
    if (!rp || (Number.isFinite(r.created) && Math.abs(rp.created - r.created) > SAME_MS)) continue;
    const root = keyOf(rp.pid, rp.created);
    const stack = [rp];
    const seen = new Set();
    while (stack.length) {
      const p = stack.pop();
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      put(p, root);
      for (const c of kids.get(p.pid) || []) if (!(Number.isFinite(c.created) && Number.isFinite(p.created) && c.created + SAME_MS < p.created)) stack.push(c);
    }
  }
  // children of remembered processes (alive or gone), by PID + time
  const byPidKnown = new Map();
  for (const k of known.values()) {
    if (!byPidKnown.has(k.pid)) byPidKnown.set(k.pid, []);
    byPidKnown.get(k.pid).push(k);
  }
  for (let pass = 0; pass < 8; pass++) {
    let more = false;
    for (const p of byPid.values()) {
      if (known.has(keyOf(p.pid, p.created))) continue;
      const cands = byPidKnown.get(p.ppid);
      if (!cands) continue;
      const owner = byPid.get(p.ppid); // a live process holding the parent PID now
      let best = null;
      for (const k of cands) {
        if (Number.isFinite(p.created) && Number.isFinite(k.created) && p.created + SAME_MS < k.created) continue; // older than that parent
        // the PID now belongs to a later process (not k): p must be older than it, or that later process is the parent
        if (owner && Math.abs(owner.created - k.created) > SAME_MS && owner.created <= p.created + SAME_MS) continue;
        if (!best || k.created > best.created) best = k;
      }
      if (!best) continue;
      if (put(p, best.root)) {
        const k = known.get(keyOf(p.pid, p.created));
        if (!byPidKnown.has(k.pid)) byPidKnown.set(k.pid, []);
        byPidKnown.get(k.pid).push(k);
        more = true;
      }
    }
    if (!more) break;
  }
  return added;
}

// drop gone entries older than keepMs, and the oldest when over max
function prune(known, procs, now = Date.now(), keepMs = KEEP_MS, max = MAX_KNOWN) {
  const byPid = byPidOf(procs);
  for (const [k, v] of known) {
    if (now - v.seenAt > keepMs && !sameProc(byPid, v)) known.delete(k);
  }
  if (known.size > max) {
    const list = [...known.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt);
    for (const [k] of list.slice(0, known.size - max)) known.delete(k);
  }
}

// -> [{ pid, ppid, name, created, priv, kind: 'suspended' | 'tasklist', ended, root }]
function findLeftovers({ procs, known, roots, now = Date.now(), minAgeMs = MIN_AGE_MS, endedMinAgeMs = ENDED_MIN_AGE_MS }) {
  const byPid = byPidOf(procs);
  const liveRoots = liveRootKeys(byPid, roots);
  const ours = new Map(); // pid -> { proc, root }
  for (const k of known.values()) {
    const p = sameProc(byPid, k);
    if (p && !liveRoots.has(keyOf(p.pid, p.created))) ours.set(p.pid, { p, root: k.root });
  }
  const out = new Map();
  const add = (p, root, kind) => {
    if (out.has(p.pid) || lower(p.name) === 'msedgewebview2.exe') return;
    out.set(p.pid, { pid: p.pid, ppid: p.ppid, name: p.name, created: p.created, priv: p.priv || 0, kind, ended: !liveRoots.has(root), root });
  };
  for (const { p, root } of ours.values()) {
    if (lower(p.name) === 'msedgewebview2.exe') continue;
    const ended = !liveRoots.has(root);
    const old = Number.isFinite(p.created) && now - p.created >= (ended ? endedMinAgeMs : minAgeMs);
    if (!old) continue;
    const par = parentOf(byPid, p);
    if (p.suspended && p.threads === 1 && !par) {
      add(p, root, 'suspended');
      continue;
    }
    if (lower(p.name) === 'tasklist.exe') {
      const cmdOrphan = par && lower(par.name) === 'cmd.exe' && !parentOf(byPid, par) && ours.has(par.pid);
      if (par && !cmdOrphan) continue;
      add(p, root, 'tasklist');
      if (cmdOrphan) add(par, root, 'tasklist');
      for (const o of ours.values()) {
        const q = o.p;
        if (lower(q.name) === 'findstr.exe' && q.ppid === p.ppid && Math.abs(q.created - p.created) <= COMPANION_MS) add(q, root, 'tasklist');
      }
    }
  }
  return [...out.values()];
}

// AT-200: the processes still running under a live tab's claude (the auto-close / rest / done-stop checks wait for them).
// rootPid = the tab's pty pid (alive: main holds it). The tree is walked by parent PID in the live list, plus what the
// tracker remembered under this root (a child whose parent died in between). Not counted: the root, a process created
// within settleMs of the claude's start (startedAt: its MCP servers and other start-up helpers live as long as it does),
// a suspended one (every thread suspended: it never runs, 51c 'suspended'), msedgewebview2.exe.
// -> [{ pid, ppid, name, created, priv }]
const KIDS_SETTLE_MS = 30_000;
function liveKids({ procs, known, rootPid, startedAt = 0, settleMs = KIDS_SETTLE_MS }) {
  const byPid = byPidOf(procs);
  const kids = new Map();
  for (const p of byPid.values()) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const rp = byPid.get(rootPid);
  const found = new Map();
  const stack = [...(kids.get(rootPid) || [])];
  // remembered under this root (needs the root's creation time for its key)
  if (rp && known) {
    const rk = keyOf(rp.pid, rp.created);
    for (const k of known.values ? known.values() : []) {
      if (k.root !== rk) continue;
      const p = sameProc(byPid, k);
      if (p) stack.push(p);
    }
  }
  while (stack.length) {
    const p = stack.pop();
    if (p.pid === rootPid || found.has(p.pid)) continue;
    if (rp && Number.isFinite(rp.created) && Number.isFinite(p.created) && p.created + SAME_MS < rp.created) continue; // older than the root
    found.set(p.pid, p);
    for (const c of kids.get(p.pid) || []) if (!(Number.isFinite(c.created) && Number.isFinite(p.created) && c.created + SAME_MS < p.created)) stack.push(c);
  }
  const out = [];
  for (const p of found.values()) {
    if (p.suspended || lower(p.name) === 'msedgewebview2.exe') continue;
    if (startedAt > 0 && Number.isFinite(p.created) && p.created < startedAt + settleMs) continue;
    out.push({ pid: p.pid, ppid: p.ppid, name: p.name, created: p.created, priv: p.priv || 0 });
  }
  return out.sort((a, b) => (a.created || 0) - (b.created || 0));
}

function summarize(items) {
  const bytes = items.reduce((s, x) => s + (x.priv || 0), 0);
  const n = (f) => items.filter(f).length;
  return {
    count: items.length,
    mb: Math.round((bytes / 1048576) * 10) / 10,
    suspended: n((x) => x.kind === 'suspended'),
    tasklist: n((x) => x.kind === 'tasklist'),
    ended: n((x) => x.ended),
  };
}

// which of the leftovers the mode stops
function toStop(items, mode) {
  if (mode === 'all') return items;
  if (mode === 'ended') return items.filter((x) => x.ended);
  return [];
}

function readJson(f, d) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
}

function readMode(userData) {
  const v = readJson(path.join(userData, SETTINGS_FILE), {});
  return v && MODES.includes(v.mode) ? v.mode : DEFAULT_MODE;
}

// One tracker per app. list(): Promise<proclist rows>, roots(): [{ pid }] of the live tabs, kill(pid) (TerminateProcess)
function createTracker({ userData, list, roots, kill, now = () => Date.now(), minAgeMs = MIN_AGE_MS, endedMinAgeMs = ENDED_MIN_AGE_MS, log = () => {} }) {
  const known = new Map();
  if (userData) {
    for (const v of readJson(path.join(userData, KNOWN_FILE), [])) {
      if (v && Number.isInteger(v.pid) && Number.isFinite(v.created) && Number.isFinite(v.seenAt)) known.set(keyOf(v.pid, v.created), v);
    }
  }
  let mode = userData ? readMode(userData) : DEFAULT_MODE;
  let last = null;
  let stoppedTotal = 0;
  let dirty = false;
  let saving = null;

  function save() {
    if (!userData || !dirty || saving) return;
    dirty = false;
    saving = fs.promises
      .writeFile(path.join(userData, KNOWN_FILE), JSON.stringify([...known.values()]))
      .catch(() => {})
      .finally(() => (saving = null));
  }

  // remember the trees of rootList (or the live tabs) now; -> procs
  async function snapshot(rootList) {
    const procs = await list();
    const t = now();
    if (remember(known, procs, rootList || roots(), t)) dirty = true;
    return procs;
  }

  // rows already listed (stoptree's tree before the kill): remember them under that root
  function rememberRows(rows, rootPid) {
    if (!Array.isArray(rows) || !rows.length) return;
    const root = rows.find((r) => r.pid === rootPid) || rows[0];
    const rk = keyOf(root.pid, root.created);
    const t = now();
    for (const p of rows) {
      if (!Number.isFinite(p.created)) continue;
      const k = keyOf(p.pid, p.created);
      if (known.has(k)) known.get(k).seenAt = t;
      else {
        known.set(k, { pid: p.pid, ppid: p.ppid, created: p.created, name: p.name, root: rk, seenAt: t });
        dirty = true;
      }
    }
  }

  // list, remember, count, stop by the mode. -> the result (also <userData>/proc-leftovers.json)
  async function check() {
    const res = { at: new Date(now()).toISOString(), mode, count: 0, mb: 0, suspended: 0, tasklist: 0, ended: 0, items: [], stopped: [], stoppedTotal };
    try {
      const rootList = roots();
      const procs = await snapshot(rootList);
      const t = now();
      prune(known, procs, t);
      const items = findLeftovers({ procs, known, roots: rootList, now: t, minAgeMs, endedMinAgeMs });
      Object.assign(res, summarize(items));
      res.items = items.slice(0, 50).map((x) => ({ pid: x.pid, name: x.name, kind: x.kind, ended: x.ended, mb: Math.round((x.priv / 1048576) * 10) / 10, ageMin: Math.round((t - x.created) / 60000) }));
      for (const x of toStop(items, mode)) {
        let ok = true;
        let err = '';
        try {
          await kill(x.pid);
        } catch (e) {
          ok = false;
          err = String((e && (e.code || e.message)) || e);
        }
        res.stopped.push({ pid: x.pid, name: x.name, kind: x.kind, ended: x.ended, ok, ...(err ? { err } : {}) });
        if (ok) stoppedTotal++;
      }
      res.stoppedTotal = stoppedTotal;
      if (res.stopped.length) log('[leftovers] stopped', res.stopped.map((s) => `${s.pid} ${s.name}${s.ok ? '' : ` (${s.err})`}`).join(', '));
    } catch (e) {
      res.error = String((e && e.message) || e);
    }
    last = res;
    if (userData) {
      try {
        fs.writeFileSync(path.join(userData, RESULT_FILE), JSON.stringify(res, null, 1));
      } catch {}
    }
    save();
    return res;
  }

  function setMode(m) {
    if (!MODES.includes(m)) return mode;
    mode = m;
    if (userData) {
      try {
        fs.mkdirSync(userData, { recursive: true });
        fs.writeFileSync(path.join(userData, SETTINGS_FILE), JSON.stringify({ mode }));
      } catch {}
    }
    return mode;
  }

  return { snapshot, rememberRows, check, setMode, mode: () => mode, last: () => last, known };
}

module.exports = {
  remember, prune, findLeftovers, liveKids, summarize, toStop, createTracker, readMode, keyOf,
  KIDS_SETTLE_MS, MODES, DEFAULT_MODE, MIN_AGE_MS, ENDED_MIN_AGE_MS, KNOWN_FILE, RESULT_FILE, SETTINGS_FILE,
};
