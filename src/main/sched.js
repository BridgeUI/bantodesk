// Backlog start rules across folders: which waiting routed items (r-*) may start now.
// No Electron imports (testable from plain Node). Rules (planStarts):
//   a. limit    – running items of all folders + the ones started by this call < limit
//   b. resource – while anything runs, nothing more starts when a resource is over its threshold
//                 (nothing running = one item may always start, as before)
//   c. overlap  – the item's scope (touches) must not overlap a running item of the same folder
//   d. after    – every prerequisite (backlogId of any folder) must be done
//   e. order    – waiting is judged front to back; a later item may pass an earlier one that cannot start
const os = require('os');
const memfree = require('./memfree');

const DEFAULT_LIMIT = 3;
const MAC_ASK_MS = 60_000; // macOS free memory: refreshed (vm_stat) only within this long after the last over()
const LIMIT_MIN = 1;
const LIMIT_MAX = 10;
const DEFAULT_THRESHOLDS = Object.freeze({ minFreeMB: 1024, maxCpuPct: 80, maxLagMs: 200 });
const KINDS = new Set(['research', 'implement', 'verify']);

const clampLimit = (n) => {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_LIMIT;
  return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, v));
};

// { minFreeMB, maxCpuPct, maxLagMs }: a missing key = the default, 0 / null = that check is off.
function normalizeThresholds(t) {
  const o = t && typeof t === 'object' ? t : {};
  const out = {};
  for (const k of Object.keys(DEFAULT_THRESHOLDS)) {
    if (o[k] === undefined) out[k] = DEFAULT_THRESHOLDS[k];
    else if (o[k] === null) out[k] = null;
    else {
      const v = Number(o[k]);
      out[k] = Number.isFinite(v) && v > 0 ? v : null;
    }
  }
  return out;
}

// Path of a touches entry: \ -> /, no leading ./, lower case, no trailing /. '' / '.' / '*' = the whole folder ('*').
function normPath(p) {
  let s = String(p == null ? '' : p).trim().replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/\/+/g, '/').replace(/\/+$/, '').toLowerCase();
  if (s === '' || s === '.' || s === '*') return '*';
  return s;
}

// The scope an item claims: research = its touches (none = nothing); implement / verify / null = its touches,
// or the whole folder ['*'] when it has none. -> normalized paths (deduplicated)
function scopeOf(item) {
  const touches = Array.isArray(item && item.touches) ? item.touches.filter((t) => typeof t === 'string' && t.trim()) : [];
  if (!touches.length) return item && item.kind === 'research' ? [] : ['*'];
  return [...new Set(touches.map(normPath))];
}

// First overlapping pair of two scopes -> [a, b] | null. '*' overlaps everything (except an empty scope);
// otherwise equal paths, or one is a directory above the other (`a` and `a/b.js`).
function overlapOf(sa, sb) {
  for (const a of sa) {
    for (const b of sb) {
      if (a === '*' || b === '*' || a === b || b.startsWith(a + '/') || a.startsWith(b + '/')) return [a, b];
    }
  }
  return null;
}

const normFolder = (f) =>
  String(f || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();

const shownPath = (p) => (p === '*' ? 'フォルダ全体' : p);

function statusOf(items, id) {
  if (!items) return undefined;
  if (items instanceof Map) return items.get(id);
  return Object.prototype.hasOwnProperty.call(items, id) ? items[id] : undefined;
}

// How a reason names an item: its number (no, "AT-12") when it has one, else its id.
function nameOf(nos, id) {
  const no = statusOf(nos, id);
  return typeof no === 'string' && no ? no : id;
}

// The limit / thresholds main keeps in manager-settings.json (schedLimit / schedThresholds, saved when a window tells
// them with sched:plan), so a restart judges with the user's setting before any window asks. -> { limit, thresholds }
function settingsOf(o) {
  const s = o && typeof o === 'object' ? o : {};
  return {
    limit: s.schedLimit === undefined ? DEFAULT_LIMIT : clampLimit(s.schedLimit),
    thresholds: normalizeThresholds(s.schedThresholds && typeof s.schedThresholds === 'object' ? s.schedThresholds : null),
  };
}

/**
 * -> { start: string[], reasons: { [id]: { code, text } } }
 * waiting: this folder's items that want to start, in queue order [{ id, folder, kind, touches, after }]
 * running: running routed items of all folders [{ id, folder, kind, touches }]
 * items:   Map | object id -> 'pending'|'active'|'done'|'failed' (all folders; an unknown id does not block)
 * resources: { over: string[] } (createResourceMonitor().over(thresholds))
 * nos:     Map | object id -> no ("AT-12"): the reasons name other items by it (an id without one is named by its id)
 * A waiting id that is already running (reserved) is neither started nor given a reason.
 */
function planStarts({ waiting = [], running = [], items = null, limit = DEFAULT_LIMIT, resources = null, nos = null } = {}) {
  const max = clampLimit(limit);
  const over = resources && Array.isArray(resources.over) ? resources.over.filter(Boolean) : [];
  const start = [];
  const reasons = {};
  const runningIds = new Set(running.map((r) => r && r.id));
  // running + started by this call, each with its scope
  const busy = running.filter(Boolean).map((r) => ({ id: r.id, folder: normFolder(r.folder), scope: scopeOf(r), planned: false }));
  const seen = new Set();
  for (const w of Array.isArray(waiting) ? waiting : []) {
    if (!w || typeof w.id !== 'string' || seen.has(w.id) || runningIds.has(w.id)) continue;
    seen.add(w.id);
    // d. after (checked first: the most specific reason)
    const after = Array.isArray(w.after) ? w.after.filter((x) => typeof x === 'string' && x && x !== w.id) : [];
    const failed = after.find((id) => statusOf(items, id) === 'failed');
    if (failed) {
      reasons[w.id] = { code: 'after-failed', text: `前提の ${nameOf(nos, failed)} が失敗しています` };
      continue;
    }
    const open = after.find((id) => {
      const st = statusOf(items, id);
      return st !== undefined && st !== null && st !== 'done';
    });
    if (open) {
      reasons[w.id] = { code: 'after', text: `前提の ${nameOf(nos, open)} が済んでいません` };
      continue;
    }
    // c. overlap with the same folder's running / just started items
    const folder = normFolder(w.folder);
    const scope = scopeOf(w);
    let clash = null;
    for (const b of busy) {
      if (b.folder !== folder) continue;
      const o = overlapOf(scope, b.scope);
      if (o) {
        clash = { b, o };
        break;
      }
    }
    if (clash) {
      const [mine, theirs] = clash.o;
      const where = mine === theirs || theirs === '*' ? shownPath(mine) : `${shownPath(mine)}（相手は ${shownPath(theirs)}）`;
      reasons[w.id] = { code: 'overlap', text: `${where}${where.endsWith('）') ? '' : ' '}が${clash.b.planned ? '先に始める' : '実行中の'} ${nameOf(nos, clash.b.id)} と重なります` };
      continue;
    }
    // a. limit
    if (busy.length >= max) {
      reasons[w.id] = { code: 'limit', text: `同時に動かす上限（${max} 件）に達しています` };
      continue;
    }
    // b. resources (only while something runs)
    if (busy.length > 0 && over.length) {
      reasons[w.id] = { code: 'resource', text: `資源の余裕がありません: ${over.join('、')}` };
      continue;
    }
    start.push(w.id);
    busy.push({ id: w.id, folder, scope, planned: true });
  }
  return { start, reasons };
}

// --- folders without a window -------------------------------------------------------------------
// Each window asks for its own queue (sched:plan). A folder with no window (after a restart, before the user opens it)
// has nobody asking, so main looks at those folders itself: their routed items (r-*, pending) are judged by the same
// rules, and a folder with an item that may start is opened (hidden window, as for a route) to start it there.

// Routed items of a folder that want a new session: r-*, pending. A tabId left from before does not count (the folder
// has no window, so no tab: the window's sweep gives the item back to the queue).
function closedWaiting(items) {
  const out = [];
  for (const i of Array.isArray(items) ? items : []) {
    if (!i || typeof i.id !== 'string' || !i.id.startsWith('r-') || i.status !== 'pending') continue;
    out.push({
      id: i.id,
      kind: KINDS.has(i.kind) ? i.kind : null,
      touches: Array.isArray(i.touches) ? i.touches.filter((t) => typeof t === 'string') : [],
      after: Array.isArray(i.after) ? i.after.filter((t) => typeof t === 'string') : [],
    });
  }
  return out;
}

/**
 * -> { open: [{ folder, start: id[] }], reasons: { [folder]: { [id]: { code, text } } } }
 * folders: [{ folder, items }] without a window, in the order to judge them (items = the folder's backlog items)
 * running / items / limit / resources / nos: as planStarts. Items a folder starts count as running for the next folders.
 * The folders' items' own no are added to nos.
 * hold: { code, text } | null – an update is reserved: nothing starts, every waiting item gets this reason.
 */
function planClosed({ folders = [], running = [], items = null, limit = DEFAULT_LIMIT, resources = null, hold = null, nos = null } = {}) {
  const open = [];
  const reasons = {};
  const busy = running.filter(Boolean).slice();
  const names = new Map(nos instanceof Map ? nos : Object.entries(nos && typeof nos === 'object' ? nos : {}));
  for (const f of Array.isArray(folders) ? folders : []) {
    for (const i of f && Array.isArray(f.items) ? f.items : []) {
      if (i && typeof i.id === 'string' && typeof i.no === 'string' && i.no && !names.has(i.id)) names.set(i.id, i.no);
    }
  }
  for (const f of Array.isArray(folders) ? folders : []) {
    if (!f || typeof f.folder !== 'string') continue;
    const waiting = closedWaiting(f.items).map((w) => ({ ...w, folder: f.folder }));
    if (!waiting.length) continue;
    if (hold) {
      reasons[f.folder] = Object.fromEntries(waiting.map((w) => [w.id, { code: hold.code, text: hold.text }]));
      continue;
    }
    const plan = planStarts({ waiting, running: busy, items, limit, resources, nos: names });
    if (plan.start.length) {
      open.push({ folder: f.folder, start: plan.start });
      for (const id of plan.start) {
        const w = waiting.find((x) => x.id === id);
        busy.push({ id, folder: f.folder, kind: w.kind, touches: w.touches });
      }
    }
    reasons[f.folder] = plan.reasons;
  }
  return { open, reasons };
}

// --- resources -------------------------------------------------------------------------------

const gbText = (mb) => String(Number((mb / 1024).toFixed(1)));

// Texts (Japanese) for the resources over their thresholds. snap = { freeMB, cpuPct, lagMs } (null = not known yet).
function overOf(snap, thresholds) {
  const t = normalizeThresholds(thresholds);
  const out = [];
  if (!snap) return out;
  if (t.minFreeMB && Number.isFinite(snap.freeMB) && snap.freeMB < t.minFreeMB) {
    out.push(`空きメモリ ${gbText(snap.freeMB)}GB（目安 ${gbText(t.minFreeMB)}GB 未満）`);
  }
  if (t.maxCpuPct && Number.isFinite(snap.cpuPct) && snap.cpuPct > t.maxCpuPct) {
    out.push(`CPU ${Math.round(snap.cpuPct)}%（目安 ${t.maxCpuPct}% 超え）`);
  }
  if (t.maxLagMs && Number.isFinite(snap.lagMs) && snap.lagMs > t.maxLagMs) {
    out.push(`アプリの応答の遅れ ${Math.round(snap.lagMs)}ms（目安 ${t.maxLagMs}ms 超え）`);
  }
  return out;
}

// AT-147: the over texts that actually hold a start back (what sched:state shows as resources.over). Rule b applies only
// while something runs, and it holds back only an item that waits for it (reason code 'resource'); a resource over its
// mark with nothing running, or with nothing waiting on it, stopped nothing, so it is not shown (it was, as 「（資源）」).
// running: [{ folder, id }] or a count; waiting: { [folder]: { [id]: { code, text } } } (main's schedWaiting).
function blockingOver(over, running, waiting) {
  const list = Array.isArray(over) ? over.filter(Boolean) : [];
  const busy = Array.isArray(running) ? running.length : Number(running) || 0;
  if (!list.length || busy <= 0) return [];
  for (const m of Object.values(waiting || {})) {
    for (const r of Object.values(m || {})) if (r && r.code === 'resource') return list;
  }
  return [];
}

const cpuTotals = (cpus) => {
  let idle = 0;
  let total = 0;
  for (const c of cpus || []) {
    const t = c && c.times;
    if (!t) continue;
    idle += t.idle || 0;
    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
  }
  return { idle, total };
};

/**
 * Samples free memory, CPU use (os.cpus() times between samples) and the main event loop delay every sampleMs;
 * snapshot() = the averages over the last windowMs (so "over" means it stayed over, not one spike).
 * Free memory: os.freemem() on Windows / Linux; on macOS free + inactive + speculative + purgeable pages (src/main/memfree.js).
 * deps (tests): { os: { freemem, totalmem, cpus }, platform, macMem: { read() } (memfree.createMacMemReader), now: () => ms,
 *   histogram: { enable, disable, reset, mean (ns) }, timers: false }. An injected os without platform keeps the freemem path.
 * -> { sample(), snapshot() -> { freeMB, totalMB, cpuPct, lagMs }, over(thresholds) -> string[], stop() }
 */
function createResourceMonitor({ sampleMs = 2000, windowMs = 30000 } = {}, deps = {}) {
  const sys = deps.os || os;
  const platform = deps.platform || (deps.os ? 'injected' : process.platform);
  const macReader = platform === 'darwin' ? deps.macMem || memfree.createMacMemReader() : null;
  const now = deps.now || (() => Date.now());
  let hist = deps.histogram || null;
  if (!hist) {
    try {
      hist = require('perf_hooks').monitorEventLoopDelay({ resolution: 20 });
    } catch {
      hist = null;
    }
  }
  if (hist && typeof hist.enable === 'function') hist.enable();
  const samples = []; // { at, freeMB, cpuPct|null, lagMs|null }
  let prevCpu = null;
  let totalMB = 0;
  // macOS: vm_stat runs only while someone asks (over(): a plan / the dashboard) in the last MAC_ASK_MS, not for the
  // whole life of the app (AT-8: no steady stream of child processes)
  let askedAt = -Infinity;

  function sample() {
    const at = now();
    let freeMB = null;
    try {
      freeMB = memfree.freeMBOf({ platform, sys, macReader, fresh: at - askedAt < MAC_ASK_MS });
      totalMB = sys.totalmem() / 1048576;
    } catch {}
    let cpuPct = null;
    try {
      const cur = cpuTotals(sys.cpus());
      if (prevCpu && cur.total > prevCpu.total) {
        const dt = cur.total - prevCpu.total;
        cpuPct = Math.max(0, Math.min(100, (1 - (cur.idle - prevCpu.idle) / dt) * 100));
      }
      prevCpu = cur;
    } catch {}
    let lagMs = null;
    if (hist) {
      const mean = Number(hist.mean);
      if (Number.isFinite(mean) && mean > 0) lagMs = mean / 1e6;
      try {
        hist.reset();
      } catch {}
    }
    samples.push({ at, freeMB, cpuPct, lagMs });
    while (samples.length && samples[0].at < at - windowMs) samples.shift();
    return snapshot();
  }

  const avg = (key) => {
    const v = samples.map((s) => s[key]).filter((x) => Number.isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

  function snapshot() {
    return {
      freeMB: avg('freeMB') === null ? null : Math.round(avg('freeMB')),
      totalMB: Math.round(totalMB),
      cpuPct: round1(avg('cpuPct')),
      lagMs: round1(avg('lagMs')),
    };
  }

  function safeRefresh() {
    try {
      macReader.read({ fresh: true });
    } catch {}
  }

  let timer = null;
  if (deps.timers !== false) {
    timer = setInterval(sample, Math.max(200, sampleMs));
    if (timer.unref) timer.unref();
  }
  sample(); // baseline (CPU needs two samples)

  return {
    sample,
    snapshot,
    over: (thresholds) => {
      const was = askedAt;
      askedAt = now();
      if (macReader && askedAt - was >= MAC_ASK_MS) safeRefresh(); // asked after a quiet time: the cached value may be old
      return overOf(snapshot(), thresholds);
    },
    stop() {
      if (timer) clearInterval(timer);
      if (macReader && typeof macReader.stop === 'function') macReader.stop();
      timer = null;
      if (hist && typeof hist.disable === 'function') hist.disable();
    },
  };
}

module.exports = {
  planStarts,
  planClosed,
  closedWaiting,
  settingsOf,
  createResourceMonitor,
  overOf,
  blockingOver,
  scopeOf,
  overlapOf,
  normPath,
  normalizeThresholds,
  clampLimit,
  DEFAULT_LIMIT,
  DEFAULT_THRESHOLDS,
  KINDS,
};
