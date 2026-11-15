'use strict';
// UA1 (docs/usage-analytics.md §1.1 A, §2): how the app's features are used, kept on this PC only, in
// <userData>/usage/. Nothing is sent anywhere. The renderer only calls api.usage.track(k, id, w, v, r); this module
// keeps a line only when every field is in src/main/usage-ids.js (no free text: names, paths, typed text, PID, §2.4).
//
//   events-YYYY-MM-DD.jsonl   one line per event {"t","k","id","w","v"?,"r"?}; 5,000 lines / 512 KB a day (more: counted
//                             only, daily .over); kept 30 days
//   daily.json                per day: counts per id (c), seconds per view id (s), open from|state (o), close
//                             (n, sec, resolved / still / none), lines / bytes written, over, usage.unknown; kept 400 days
//
// Writes do not block main (as src/main/writeq.js): events wait in memory and are appended every 10 s (async); daily.json
// goes through writeq. flushSync() on will-quit writes what is left. OFF: track() drops everything (nothing written);
// the records already there stay until clear().
// No Electron imports (testable from plain Node).
const fs = require('fs');
const path = require('path');
const ids = require('./usage-ids');
const writeq = require('./writeq');

const LIMITS = Object.freeze({ lines: 5000, bytes: 512 * 1024, rawDays: 30, dailyDays: 400, maxV: 86400 });
const FLUSH_MS = 10_000;
const DAILY = 'daily.json';
const EVENTS_RE = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;

const pad = (n) => String(n).padStart(2, '0');
// the local calendar day (the user's day, not UTC)
function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// whole days between two YYYY-MM-DD (local noon, so a DST change does not move it)
function daysBetween(a, b) {
  const p = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d, 12).getTime();
  };
  return Math.round((p(b) - p(a)) / 86400e3);
}

// the id a kind must carry (a click cannot pretend to be an open, an open needs open.from.*)
function idFits(k, id) {
  if (k === 'view') return id.startsWith('view.');
  if (k === 'open') return id.startsWith('open.from.');
  if (k === 'close') return id === 'close';
  if (k === 'auto') return id.startsWith('auto.');
  if (k === 'key') return id.startsWith('key.');
  return !/^(view|open|close|auto|key)\b/.test(id); // click: everything else (app.start, dash.*, session.*, …)
}

// -> the line's object, or { unknown: true } (id not in the list), or null (bad kind / window: dropped, not counted)
function clean(o, nowMs) {
  if (!o || typeof o !== 'object') return null;
  const { k, id, w } = o;
  if (!ids.isKind(k) || !ids.isWindow(w)) return null;
  if (!ids.isId(id) || !idFits(k, id)) return { unknown: true };
  const line = { t: Math.floor(nowMs / 1000), k, id, w };
  const v = o.v;
  if (typeof v === 'number') {
    if (Number.isFinite(v)) line.v = Math.min(LIMITS.maxV, Math.max(0, Math.round(v)));
  } else if (ids.isValue(v)) line.v = v;
  if (k === 'close' && ids.isResult(o.r)) line.r = o.r;
  return line;
}

const emptyDay = () => ({ n: 0, b: 0, over: 0, c: {}, s: {}, o: {}, close: { n: 0, sec: 0, resolved: 0, still: 0, none: 0 } });

// o: { dir (<userData>/usage), enabled: () => boolean, now?: () => ms, flushMs?, limits?, log? }
function create(o) {
  const dir = o.dir;
  const enabled = typeof o.enabled === 'function' ? o.enabled : () => !!o.enabled;
  const now = o.now || Date.now;
  const flushMs = o.flushMs || FLUSH_MS;
  const lim = { ...LIMITS, ...(o.limits || {}) };
  const log = o.log || (() => {});
  const dailyFile = path.join(dir, DAILY);
  let daily = null; // { v: 1, days: { day: Day } }, read on first use
  let buf = new Map(); // day -> lines (text, newline ended) not on disk yet
  let timer = null;
  let flushing = null;
  let lastDay = null;
  let dirty = false;
  let gen = 0; // clear() bumps it: a flush already under way does not write old lines after it

  function load() {
    if (daily) return daily;
    let j = null;
    try {
      j = JSON.parse(writeq.readTextSync(dailyFile)); // once, on first use (small); later reads are in memory
    } catch {}
    daily = j && typeof j === 'object' && j.days && typeof j.days === 'object' ? { v: 1, days: j.days } : { v: 1, days: {} };
    return daily;
  }
  function dayRec(day) {
    const d = load().days;
    if (!d[day] || typeof d[day] !== 'object') d[day] = emptyDay();
    const r = d[day];
    for (const [k, v] of Object.entries(emptyDay())) if (r[k] === undefined) r[k] = v;
    return r;
  }
  const inc = (m, k, by = 1) => {
    m[k] = (Number(m[k]) || 0) + by;
  };

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch((err) => log('[usage] flush failed', err && err.code ? err.code : err));
    }, flushMs);
    if (timer.unref) timer.unref();
  }

  // -> true when a line was kept
  function track(input) {
    if (!enabled()) return false;
    const t = now();
    const line = clean(input, t);
    if (!line) return false;
    const day = dayOf(t);
    if (day !== lastDay) {
      if (lastDay) prune(day); // the date changed while running
      lastDay = day;
    }
    const r = dayRec(day);
    dirty = true;
    schedule();
    if (line.unknown) {
      inc(r.c, 'usage.unknown');
      return false;
    }
    inc(r.c, line.id);
    if (line.k === 'view' && typeof line.v === 'number') inc(r.s, line.id, line.v);
    if (line.k === 'open') inc(r.o, `${line.id.slice('open.from.'.length)}|${typeof line.v === 'string' ? line.v : '-'}`);
    if (line.k === 'close') {
      inc(r.close, 'n');
      if (typeof line.v === 'number') inc(r.close, 'sec', line.v);
      if (line.r) inc(r.close, line.r);
    }
    const text = JSON.stringify(line) + '\n';
    const bytes = Buffer.byteLength(text);
    if (r.n >= lim.lines || r.b + bytes > lim.bytes) {
      inc(r, 'over');
      return false;
    }
    r.n += 1;
    r.b += bytes;
    if (!buf.has(day)) buf.set(day, []);
    buf.get(day).push(text);
    return true;
  }

  // the main process's own records (auto.*): the same filter
  const auto = (id, w = 'dash') => track({ k: 'auto', id, w });

  function takeBuf() {
    const b = buf;
    buf = new Map();
    const d = dirty ? JSON.stringify(load()) : null;
    dirty = false;
    return { b, d };
  }

  async function flush() {
    if (flushing) await flushing.catch(() => {});
    const my = gen;
    const { b, d } = takeBuf();
    if (!b.size && d === null) return;
    flushing = (async () => {
      await fs.promises.mkdir(dir, { recursive: true });
      for (const [day, lines] of b) {
        if (my !== gen) return;
        await fs.promises.appendFile(path.join(dir, `events-${day}.jsonl`), lines.join(''));
      }
      if (d !== null && my === gen) writeq.write(dailyFile, d);
    })();
    try {
      await flushing;
    } finally {
      flushing = null;
    }
  }

  function flushSync() {
    if (timer) clearTimeout(timer);
    timer = null;
    const { b, d } = takeBuf();
    if (!b.size && d === null) return;
    fs.mkdirSync(dir, { recursive: true });
    for (const [day, lines] of b) fs.appendFileSync(path.join(dir, `events-${day}.jsonl`), lines.join(''));
    if (d !== null) writeq.writeSync(dailyFile, d);
  }

  // events files older than rawDays, daily entries older than dailyDays (at start and when the date changes)
  function prune(today = dayOf(now())) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {}
    let gone = 0;
    for (const n of names) {
      const m = EVENTS_RE.exec(n);
      if (!m || daysBetween(m[1], today) < lim.rawDays) continue;
      try {
        fs.unlinkSync(path.join(dir, n));
        gone++;
      } catch {}
    }
    const days = load().days;
    for (const k of Object.keys(days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || daysBetween(k, today) >= lim.dailyDays) {
        delete days[k];
        dirty = true;
      }
    }
    if (dirty) schedule();
    return gone;
  }

  // 全部消す: every record goes (the setting stays, it is not in this folder)
  async function clear() {
    gen++;
    if (timer) clearTimeout(timer);
    timer = null;
    buf = new Map();
    daily = { v: 1, days: {} };
    dirty = false;
    if (flushing) await flushing.catch(() => {});
    let names = [];
    try {
      names = await fs.promises.readdir(dir);
    } catch {}
    for (const n of names) if (EVENTS_RE.test(n)) await fs.promises.rm(path.join(dir, n), { force: true }).catch(() => {});
    if (names.includes(DAILY) || writeq.pending(dailyFile) !== null) await writeq.write(dailyFile, JSON.stringify(daily)).catch(() => {});
    return true;
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  // UA2: the lines of the events files from fromDay (YYYY-MM-DD) on, after writing what waits in memory
  async function events(fromDay = '0000-00-00') {
    await flush().catch(() => {});
    let names = [];
    try {
      names = await fs.promises.readdir(dir);
    } catch {}
    const out = [];
    for (const n of names.sort()) {
      const m = EVENTS_RE.exec(n);
      if (!m || m[1] < fromDay) continue;
      let text = '';
      try {
        text = await fs.promises.readFile(path.join(dir, n), 'utf8');
      } catch {}
      for (const l of text.split('\n')) {
        if (!l) continue;
        try {
          out.push(JSON.parse(l));
        } catch {}
      }
    }
    return out;
  }

  return { track, auto, flush, flushSync, prune, clear, stop, events, snapshot: () => JSON.parse(JSON.stringify(load())), dir };
}

// ---- the ON / OFF setting: <userData>/usage-settings.json { enabled } (outside usage/, so 全部消す keeps it) ----------
const SETTINGS = 'usage-settings.json';
// default ON (the user's own request, kept on this PC); e2e runs (--agent-terminal-e2e) default OFF unless
// AGENT_TERMINAL_USAGE=1 (a test that checks the records). An explicit choice in the file wins over the default.
function readEnabled(userData, { e2e = false, env = process.env } = {}) {
  if (e2e && env.AGENT_TERMINAL_USAGE === '1') return true;
  try {
    const j = JSON.parse(writeq.readTextSync(path.join(userData, SETTINGS)));
    if (j && typeof j.enabled === 'boolean') return j.enabled;
  } catch {}
  return !e2e;
}
// the whole file: { enabled?, autoReport? (UA2, default ON), lastAuto? (UA2, the day of the last automatic report) }
function readSettings(userData) {
  try {
    const j = JSON.parse(writeq.readTextSync(path.join(userData, SETTINGS)));
    if (j && typeof j === 'object') return j;
  } catch {}
  return {};
}
// merges patch into the file (only the known fields)
function writeSettings(userData, patch) {
  const cur = readSettings(userData);
  const next = {};
  if (typeof cur.enabled === 'boolean') next.enabled = cur.enabled;
  if (typeof cur.autoReport === 'boolean') next.autoReport = cur.autoReport;
  if (typeof cur.lastAuto === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cur.lastAuto)) next.lastAuto = cur.lastAuto;
  if (patch && typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (patch && typeof patch.autoReport === 'boolean') next.autoReport = patch.autoReport;
  if (patch && typeof patch.lastAuto === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(patch.lastAuto)) next.lastAuto = patch.lastAuto;
  writeq.write(path.join(userData, SETTINGS), JSON.stringify(next));
  return next;
}
function writeEnabled(userData, on) {
  writeSettings(userData, { enabled: !!on });
  return !!on;
}
const readAutoReport = (userData) => readSettings(userData).autoReport !== false;

module.exports = { create, clean, dayOf, daysBetween, readEnabled, writeEnabled, readSettings, writeSettings, readAutoReport, LIMITS, FLUSH_MS, SETTINGS, DAILY };
