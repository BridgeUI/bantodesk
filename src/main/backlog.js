// Backlog (queued prompts per folder, roadmap 8 "issues"), stored by main in
// userData/backlog/<sha1(norm(workDir)) first 16 hex>.json. Same write scheme as the composer store in
// layouts.js: async coalesced writes (newest wins) + a sync variant for beforeunload. One window per
// folder, so there is no cross-window sync. No Electron imports (testable from plain Node).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const models = require('./models');
const writeq = require('./writeq');
const { timebox, TIMED_OUT, limits } = require('./timebox');
const AutoSend = require('../renderer/autosend'); // autoOff records (why a tab's auto send waits / stopped)

const norm = (p) => path.resolve(p).toLowerCase();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const STATUSES = new Set(['pending', 'active', 'done', 'failed', 'dropped']); // dropped = 取り消し (kept as history)
const TEXT_MAX = 20000;
const NOTE_MAX = 500;
const ITEMS_MAX = 500;
const AUTO_MAX = 200;
const BYTES_MAX = 1024 * 1024;
const bytes = (x) => Buffer.byteLength(JSON.stringify(x));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const empty = () => ({ items: [], auto: {} });
const USER_ORDER_LOCK_MS = 24 * 60 * 60 * 1000; // after the user reordered, the manager's reorder is refused this long

// --- scheduling hints of a queued item (roadmap 33, docs/plan-backlog-sched.md) ----------------------
// kind: what the work does; touches: paths relative to the folder it will change (trailing / = a directory);
// after: backlog ids (any folder) that must be done first. See src/main/sched.js for how they are used.
const KINDS = new Set(['research', 'implement', 'verify']);
const TOUCHES_MAX = 30;
const TOUCH_LEN_MAX = 200;
const AFTER_MAX = 20;

// One touches entry -> normalized relative path ('src/a.js', 'docs/') | null (empty, absolute, ~, or with a .. segment).
function cleanTouch(t) {
  if (typeof t !== 'string') return null;
  let s = t.trim().replace(/\\/g, '/');
  if (!s || s.length > TOUCH_LEN_MAX) return null;
  if (s.startsWith('/') || s.startsWith('~') || /^[A-Za-z]:/.test(s) || s.includes('\0')) return null;
  s = s.replace(/\/{2,}/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  if (!s || s === '.' || s.split('/').some((seg) => seg === '..')) return null;
  return s;
}

// Array -> cleaned, de-duplicated touches (≤ 30) | null when not an array / nothing valid left.
function cleanTouches(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const t of v) {
    const c = cleanTouch(t);
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= TOUCHES_MAX) break;
  }
  return out.length ? out : null;
}

// Array -> valid, de-duplicated backlog ids (≤ 20) | null when not an array / none valid.
function cleanAfter(v, selfId = null) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const id of v) {
    if (typeof id !== 'string' || !ID_RE.test(id) || id === selfId || out.includes(id)) continue;
    out.push(id);
    if (out.length >= AFTER_MAX) break;
  }
  return out.length ? out : null;
}

const TITLE_MAX = 200;

// Item = { id, text, tabId: UUID|null, status, createdAt, startedAt|null, doneAt|null, note,
//          kind?: 'research'|'implement'|'verify', touches?: string[], after?: string[],
//          seq?: number (task number in the folder, UIUX U1), title?: string (short heading, ~20 chars),
//          model?: string, effort?: string (AT-6: the ルーター's choice at route / create; none = the default, src/main/models.js),
//          assignTries?: number (SCH-AS: assignments to a tab given back because the start was not confirmed) }
// The optional fields are only present when set (an item without them is stored exactly as before).
// `no` ("AT-12" = the folder's prefix + seq) is not stored: getBacklog / saveBacklog add it from numbers.json.
function sanitizeItem(o) {
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !ID_RE.test(o.id)) return null;
  const it = {
    id: o.id,
    text: typeof o.text === 'string' ? o.text.slice(0, TEXT_MAX) : '',
    tabId: typeof o.tabId === 'string' && UUID_RE.test(o.tabId) ? o.tabId : null,
    status: STATUSES.has(o.status) ? o.status : 'pending',
    createdAt: num(o.createdAt) ?? 0,
    startedAt: num(o.startedAt),
    doneAt: num(o.doneAt),
    note: typeof o.note === 'string' ? o.note.slice(0, NOTE_MAX) : '',
  };
  if (KINDS.has(o.kind)) it.kind = o.kind;
  const touches = cleanTouches(o.touches);
  if (touches) it.touches = touches;
  const after = cleanAfter(o.after, o.id);
  if (after) it.after = after;
  if (Number.isInteger(o.seq) && o.seq > 0) it.seq = o.seq;
  const title = typeof o.title === 'string' ? o.title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) : '';
  if (title) it.title = title;
  if (models.isModel(o.model)) it.model = o.model;
  if (models.isEffort(o.effort)) it.effort = o.effort;
  // SCH-AS: how many times the item was assigned to a new tab whose start could not be confirmed (src/renderer/startwatch.js)
  if (Number.isInteger(o.assignTries) && o.assignTries > 0) it.assignTries = Math.min(o.assignTries, 10);
  // SCH-HO: an active item that went over to a new session in a context handoff (renderer handoff.js complete): its
  // start there is judged by any sign of the session working, not by the 60 s send check (renderer.js backlogTick)
  if (it.status === 'active' && o.handoff && typeof o.handoff === 'object' && num(o.handoff.at)) it.handoff = { at: num(o.handoff.at), ...(typeof o.handoff.from === 'string' && UUID_RE.test(o.handoff.from) ? { from: o.handoff.from } : {}) };
  // an active item marked just before an update restart at a turn gap (renderer backlog.js markResume): continues after it
  if (it.status === 'active' && o.resume && typeof o.resume === 'object' && num(o.resume.at)) it.resume = { at: num(o.resume.at), ...(o.resume.restart === true ? { restart: true } : {}) }; // restart: not an update (AT-101)
  return it;
}

// Index of the item to drop on overflow: the oldest (createdAt, then array position) DONE (or dropped) item,
// else the oldest of any status.
function victim(items) {
  let best = -1;
  let bestDone = false;
  for (let i = 0; i < items.length; i++) {
    const done = items[i].status === 'done' || items[i].status === 'dropped';
    if (best < 0 || (done && !bestDone) || (done === bestDone && items[i].createdAt < items[best].createdAt)) {
      best = i;
      bestDone = done;
    }
  }
  return best;
}

// BacklogState = { items: Item[], auto: { [tabId UUID]: boolean }, autoOff?: { [tabId UUID]: AutoSend record }, userOrderAt?: number } (userOrderAt = when the user
// last moved an item with ↑ / ↓; the manager's reorder is refused for 24 h after it). Array order is kept; duplicate ids
// keep the first. Overflow (> 500 items or > 1 MB total) drops the oldest done items first, then the oldest.
function sanitizeBacklog(o) {
  const x = o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  const out = empty();
  if (num(x.userOrderAt) !== null) out.userOrderAt = x.userOrderAt;
  if (x.auto && typeof x.auto === 'object' && !Array.isArray(x.auto)) {
    let n = 0;
    for (const [id, v] of Object.entries(x.auto)) {
      if (!UUID_RE.test(id) || typeof v !== 'boolean') continue;
      out.auto[id] = v;
      if (++n >= AUTO_MAX) break;
    }
  }
  // autoOff: { [tabId]: { why, n, at, retryAt, stopped, text } } (src/renderer/autosend.js); only when there is one
  if (x.autoOff && typeof x.autoOff === 'object' && !Array.isArray(x.autoOff)) {
    let n = 0;
    for (const [id, v] of Object.entries(x.autoOff)) {
      const r = UUID_RE.test(id) ? AutoSend.clean(v) : null;
      if (!r) continue;
      (out.autoOff ||= {})[id] = r;
      if (++n >= AUTO_MAX) break;
    }
  }
  if (Array.isArray(x.items)) {
    const seen = new Set();
    for (const raw of x.items) {
      const it = sanitizeItem(raw);
      if (!it || seen.has(it.id)) continue;
      seen.add(it.id);
      out.items.push(it);
    }
  }
  if (out.items.length > ITEMS_MAX) {
    // same order as victim(), done in one sort so a huge input stays cheap
    const rank = out.items
      .map((it, i) => ({ i, done: it.status === 'done' || it.status === 'dropped', t: it.createdAt }))
      .sort((a, b) => b.done - a.done || a.t - b.t || a.i - b.i);
    const drop = new Set(rank.slice(0, out.items.length - ITEMS_MAX).map((r) => r.i));
    out.items = out.items.filter((_, i) => !drop.has(i));
  }
  const items = out.items;
  let total = bytes(out);
  while (items.length && total > BYTES_MAX) {
    const [gone] = items.splice(victim(items), 1);
    total -= bytes(gone) + 1; // + the comma
  }
  return out;
}

const backlogFile = (dir, workDir) =>
  path.join(dir, crypto.createHash('sha1').update(norm(workDir)).digest('hex').slice(0, 16) + '.json');

// --- task numbers (UIUX U1, docs/ui-copy.md): "AT-12" = the folder's prefix + a running number --------------------
// Registry <dir>/numbers.json = { folders: { [norm(folder)]: { folder, prefix, next, migrated, userPrefix? } } }.
// Every item of a folder gets a seq when it is first saved (route items before, see assignNo); numbers are never reused
// (next only grows). The first time a folder is seen, its existing items are numbered once in creation order (migrated).
// The manager's own prompts (id m-…) get no number. The prefix comes from the folder name (autoPrefix), unique among
// the folders in the registry; the user changes it through the manager (outbox task-prefix -> setPrefix).
const NUMBERS_FILE = 'numbers.json';
const PREFIX_MAX = 8;
const RESERVED_PREFIX = '依頼'; // inbox items not routed yet: 依頼-N (inbox.js)
const registries = new Map(); // dir -> registry (main is the only writer)
const numberable = (it) => it && typeof it.id === 'string' && !it.id.startsWith('m-');

function loadRegistry(dir) {
  let reg = registries.get(dir);
  if (reg) return reg;
  reg = { folders: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, NUMBERS_FILE), 'utf8'));
    for (const [k, e] of Object.entries((raw && raw.folders) || {})) {
      if (!e || typeof e !== 'object' || !prefixValid(e.prefix)) continue;
      reg.folders[k] = {
        folder: typeof e.folder === 'string' ? e.folder : k,
        prefix: e.prefix,
        next: Number.isInteger(e.next) && e.next > 0 ? e.next : 1,
        migrated: e.migrated === true,
        ...(e.userPrefix === true ? { userPrefix: true } : {}),
      };
    }
  } catch {}
  registries.set(dir, reg);
  return reg;
}
function saveRegistry(dir, reg) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, NUMBERS_FILE);
    fs.writeFileSync(file + '.tmp', JSON.stringify(reg, null, 1));
    fs.renameSync(file + '.tmp', file);
  } catch (err) {
    console.warn('[backlog] saving numbers.json failed', err);
  }
}

// A prefix the user / manager may set: 1–8 letters / digits / _ (any script), not only digits, not 依頼.
function prefixValid(p) {
  if (typeof p !== 'string') return false;
  const s = p.trim();
  const n = [...s].length;
  return n >= 1 && n <= PREFIX_MAX && /^[\p{L}\p{N}_]+$/u.test(s) && !/^\d+$/.test(s) && s !== RESERVED_PREFIX;
}

// Folder name -> a short prefix: ASCII names take the initials of their words (agent_terminal -> AT, myApp -> MA, up to
// 4) or the first 3 letters of a single word (dashboard -> DAS); other scripts take the first 2 letters (学校シミュ -> 学校).
function autoPrefix(name) {
  const s = String(name || '').normalize('NFKC');
  const first = (s.match(/\p{L}/u) || [''])[0];
  if (first && !/[A-Za-z]/.test(first)) {
    const letters = [...s].filter((c) => /\p{L}/u.test(c)).slice(0, 2).join('');
    if (prefixValid(letters)) return letters;
  }
  const words = s.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter((w) => /[A-Za-z]/.test(w));
  let p = words.length >= 2 ? words.slice(0, 4).map((w) => w.replace(/^[^A-Za-z]+/, '')[0]).join('') : (words[0] || '').replace(/[^A-Za-z]/g, '').slice(0, 3);
  p = p.toUpperCase();
  return prefixValid(p) ? p : 'P';
}

const prefixTaken = (reg, prefix, exceptKey) =>
  Object.entries(reg.folders).some(([k, e]) => k !== exceptKey && e.prefix.toLowerCase() === prefix.toLowerCase());

// The registry entry of a folder (created with a free prefix: AT, AT2, AT3… when taken). -> entry (not saved yet)
function folderEntry(reg, workDir) {
  const key = norm(workDir);
  let e = reg.folders[key];
  if (e) return e;
  const base = autoPrefix(path.basename(path.resolve(workDir)));
  let prefix = base;
  for (let n = 2; prefixTaken(reg, prefix, key); n++) prefix = `${[...base].slice(0, PREFIX_MAX - String(n).length).join('')}${n}`;
  e = reg.folders[key] = { folder: path.resolve(workDir), prefix, next: 1, migrated: false };
  return e;
}

// UX11 (§1.6 row 11): every folder the number registry knows (numbers.json; a folder gets an entry when its first item
// is numbered, a routed folder at the route), with its backlog file. -> [{ folder, file }]
function knownFolders(dir) {
  const out = [];
  for (const e of Object.values(loadRegistry(dir).folders)) {
    if (!e || typeof e.folder !== 'string' || !path.isAbsolute(e.folder)) continue;
    out.push({ folder: e.folder, file: backlogFile(dir, e.folder) });
  }
  return out;
}

// Gives the items without a seq one (in place, items = sanitized). known(id) -> stored item | null fills seq / title of
// items a window saved from an older copy. A folder seen for the first time is numbered in creation order. -> changed
function numberItems(dir, workDir, items, known = null) {
  const reg = loadRegistry(dir);
  const fresh = !reg.folders[norm(workDir)];
  const e = folderEntry(reg, workDir);
  let changed = fresh;
  const max = items.reduce((m, it) => Math.max(m, it.seq || 0), 0);
  if (e.next <= max) {
    e.next = max + 1;
    changed = true;
  }
  let todo = items.filter((it) => numberable(it) && !it.seq);
  if (todo.length && known) {
    for (const it of todo) {
      const k = known(it.id);
      if (k && k.seq) {
        it.seq = k.seq;
        if (!it.title && k.title) it.title = k.title;
      }
    }
    todo = todo.filter((it) => !it.seq);
  }
  if (!e.migrated) {
    todo = todo.map((it, i) => ({ it, i })).sort((a, b) => (a.it.createdAt || 0) - (b.it.createdAt || 0) || a.i - b.i).map((x) => x.it);
    e.migrated = true;
    changed = true;
  }
  for (const it of todo) {
    it.seq = e.next++;
    changed = true;
  }
  if (changed) saveRegistry(dir, reg);
  return changed;
}

// Adds no ("AT-12") to the numbered items of a state (in place). -> state
function decorate(dir, workDir, state) {
  const e = loadRegistry(dir).folders[norm(workDir)];
  for (const it of state.items) if (it.seq && e) it.no = `${e.prefix}-${it.seq}`;
  return state;
}

// Number for one new item main is about to put on a folder's backlog (route / create), so the inbox item can show it.
// -> { ...item, seq, no } (an item that already has a seq keeps it)
function assignNo(dir, workDir, item) {
  const it = { ...item };
  if (numberable(it) && !(Number.isInteger(it.seq) && it.seq > 0)) {
    const reg = loadRegistry(dir);
    const e = folderEntry(reg, workDir);
    if (!e.migrated) {
      // number what is already in the file first (creation order), then this item
      try {
        const st = sanitizeBacklog(JSON.parse(fs.readFileSync(backlogFile(dir, workDir), 'utf8')));
        numberItems(dir, workDir, st.items);
      } catch {
        e.migrated = true;
      }
    }
    it.seq = e.next++;
    saveRegistry(dir, reg);
  }
  const e = loadRegistry(dir).folders[norm(workDir)];
  if (it.seq && e) it.no = `${e.prefix}-${it.seq}`;
  return it;
}

// The folder's prefix (created if new). -> string
function prefixOf(dir, workDir) {
  const reg = loadRegistry(dir);
  const fresh = !reg.folders[norm(workDir)];
  const e = folderEntry(reg, workDir);
  if (fresh) saveRegistry(dir, reg);
  return e.prefix;
}

// Changes a folder's prefix (old numbers keep their seq and show with the new prefix). -> { prefix, old } | { error }
function setPrefix(dir, workDir, prefix) {
  if (!prefixValid(prefix)) return { error: `bad prefix ${JSON.stringify(prefix)} (1-${PREFIX_MAX} letters / digits, not only digits, not ${RESERVED_PREFIX})` };
  const p = prefix.trim();
  const reg = loadRegistry(dir);
  const key = norm(workDir);
  if (prefixTaken(reg, p, key)) return { error: `prefix ${p} is used by another folder` };
  const e = folderEntry(reg, workDir);
  const old = e.prefix;
  e.prefix = p;
  e.userPrefix = true;
  saveRegistry(dir, reg);
  const w = writers.get(backlogFile(dir, workDir));
  if (w && w.latest) decorate(dir, workDir, w.latest);
  return { prefix: p, old };
}

// Per file: newest data and write bookkeeping (see layouts.js saveComposer).
const writers = new Map();
const writerOf = (file) => {
  let w = writers.get(file);
  if (!w) writers.set(file, (w = { latest: null, version: 0, asyncVer: 0, running: null }));
  return w;
};

// The stored item of an id (newest pending write, else the disk), for numberItems' known(). Reads the disk once.
function knownOf(file, w) {
  let map = null;
  return (id) => {
    if (!map) {
      map = new Map();
      let items = w && w.latest ? w.latest.items : null;
      if (!items) {
        try {
          items = sanitizeBacklog(JSON.parse(fs.readFileSync(file, 'utf8'))).items;
        } catch {
          items = [];
        }
      }
      for (const it of items) map.set(it.id, it);
    }
    return map.get(id) || null;
  };
}

// -> BacklogState (empty default when missing / unreadable). Items carry no ("AT-12"); a folder read for the first time
// is numbered (and saved) once.
async function getBacklog(dir, workDir) {
  const file = backlogFile(dir, workDir);
  const w = writers.get(file);
  if (w && w.latest) return decorate(dir, workDir, w.latest); // newer than the disk while a write is pending
  let st;
  try {
    // AT-202: a read that does not come back in time (thread pool held by slow disk work) is done synchronously
    let text = await timebox(fs.promises.readFile(file, 'utf8'), limits.read());
    if (text === TIMED_OUT) text = fs.readFileSync(file, 'utf8');
    st = sanitizeBacklog(JSON.parse(text));
  } catch {
    return empty();
  }
  const ww = writers.get(file);
  if (ww && ww.latest) return decorate(dir, workDir, ww.latest); // a save came in while reading
  if (st.items.some((it) => numberable(it) && !it.seq) && numberItems(dir, workDir, st.items)) {
    saveBacklog(dir, workDir, st);
    return decorate(dir, workDir, writers.get(file).latest || st);
  }
  return decorate(dir, workDir, st);
}

// AT-202: the same state without the thread pool (a snapshot whose async read did not come back in time). Numbers
// missing items in memory only (getBacklog saves them when it runs).
function readBacklogSync(dir, workDir) {
  const file = backlogFile(dir, workDir);
  const w = writers.get(file);
  if (w && w.latest) return decorate(dir, workDir, w.latest);
  try {
    const st = sanitizeBacklog(JSON.parse(fs.readFileSync(file, 'utf8')));
    return decorate(dir, workDir, st);
  } catch {
    return empty();
  }
}

// Async write (tmp + rename); resolves true when the newest data passed in so far is on disk.
function saveBacklog(dir, workDir, data) {
  const file = backlogFile(dir, workDir);
  const w = writerOf(file);
  const clean = sanitizeBacklog(data);
  numberItems(dir, workDir, clean.items, knownOf(file, w));
  w.latest = decorate(dir, workDir, clean);
  w.version++;
  if (!w.running) {
    w.running = (async () => {
      let ok = true;
      try {
        // AT-202: the per-file queue of writeq.js (tmp + rename, retries, a sync write when a step is too slow)
        while (w.asyncVer < w.version) {
          const v = w.version;
          if (!(await writeq.write(file, JSON.stringify(w.latest)))) throw new Error('not written yet (writeq retries it)');
          w.asyncVer = v;
        }
      } catch (err) {
        console.warn('[backlog] save failed', err);
        ok = false;
      }
      w.running = null;
      if (ok) w.latest = null; // disk is current again
      return ok;
    })();
  }
  return w.running;
}

// Synchronous variant for beforeunload. If an async write is in flight it rewrites the same newest
// data afterwards (version moved on), so an older async rename cannot win.
function saveBacklogSync(dir, workDir, data) {
  const file = backlogFile(dir, workDir);
  const w = writerOf(file);
  const clean = sanitizeBacklog(data);
  numberItems(dir, workDir, clean.items, knownOf(file, w));
  decorate(dir, workDir, clean);
  w.version++;
  if (w.running) w.latest = clean;
  else w.asyncVer = w.version;
  return writeq.writeSync(file, JSON.stringify(clean)); // AT-202: same queue as the async writes
}

// --- reorder (manager action, roadmap 27) -----------------------------------------------------------
// Only pending items move, and only among the array slots pending items already hold (active / done / failed stay
// where they are). Pending items named in `order` come first in that order, the rest keep their relative order.
// -> { items } | { error }
function applyOrder(items, order) {
  if (!Array.isArray(order) || !order.length) return { error: 'order missing' };
  const ids = [];
  for (const id of order) {
    if (typeof id !== 'string' || !id) return { error: `bad id ${JSON.stringify(id)}` };
    if (!ids.includes(id)) ids.push(id);
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const id of ids) {
    const it = byId.get(id);
    if (!it) return { error: `unknown backlogId ${id}` };
    if (it.status !== 'pending') return { error: `backlog item ${id} is ${it.status} (only pending items can be reordered)` };
  }
  const slots = [];
  items.forEach((it, i) => it.status === 'pending' && slots.push(i));
  const pend = slots.map((i) => items[i]);
  const sorted = [...ids.map((id) => byId.get(id)), ...pend.filter((it) => !ids.includes(it.id))];
  const out = [...items];
  slots.forEach((slot, k) => (out[slot] = sorted[k]));
  return { items: out };
}

// true when the pending items named in `order` already appear in that order (the window has taken the reorder over).
function followsOrder(items, order) {
  const want = (order || []).filter((id) => items.some((i) => i.id === id && i.status === 'pending'));
  const have = items.filter((i) => i.status === 'pending' && want.includes(i.id)).map((i) => i.id);
  return want.every((id, k) => have[k] === id);
}

// -> null when the manager may reorder now, else the time until which the user's own order wins.
function userOrderLock(state, now = Date.now()) {
  const at = state && num(state.userOrderAt);
  return at !== null && now - at < USER_ORDER_LOCK_MS ? at + USER_ORDER_LOCK_MS : null;
}

// --- status of one item from outside its window (the user's 取り消す on the dashboard, the manager's backlog-update,
// the auto clean-up of replaced items) ----------------------------------------------------------------------------
// The item keeps its id, text and links (inbox r-<id>-…); only status / note / doneAt change. -> { items, item, prev } | { error }
const SET_TARGETS = new Set(['dropped', 'failed', 'done']);
function setStatus(items, id, status, note, { from = ['pending', 'failed'], now = Date.now() } = {}) {
  if (!SET_TARGETS.has(status)) return { error: `bad status ${JSON.stringify(status)} (dropped, failed or done)` };
  const k = (items || []).findIndex((i) => i && i.id === id);
  if (k < 0) return { error: `unknown backlogId ${JSON.stringify(id)}` };
  const prev = items[k];
  if (!from.includes(prev.status)) return { error: `backlog item ${id} is ${prev.status} (only ${from.join(' / ')} items can be changed)` };
  const item = { ...prev, status, doneAt: now, note: String(note || '').slice(0, NOTE_MAX) };
  delete item.resume;
  const out = [...items];
  out[k] = item;
  return { items: out, item, prev };
}

// The same on the folder's file (read the newest state, write it). -> { state, item, prev } | { error }
async function updateStatus(dir, workDir, id, status, note, opts = {}) {
  const st = await getBacklog(dir, workDir);
  const r = setStatus(st.items, id, status, note, opts);
  if (r.error) return r;
  const state = { ...st, items: r.items };
  await saveBacklog(dir, workDir, state);
  return { state, item: r.item, prev: r.prev };
}

// Inbox item a backlog item was routed for: r-<inboxId>-<hex> (manager.js route; r-x-… = routed without one) -> id | null
function routedInboxId(id) {
  const m = /^r-(.+)-[0-9a-f]{1,8}$/.exec(String(id || ''));
  return m && m[1] !== 'x' ? m[1] : null;
}

// Pending items that can never start and were replaced: a prerequisite (after) is failed (or dropped), and a NEWER backlog
// item (any folder, not dropped) was routed for the same inbox item. backlogs = [{ folder, items }] (every folder known).
// linkedOf(folder, backlogId) -> inboxId | null (link action ties, optional). -> [{ folder, id, after, by: { folder, id } }]
function findReplaced(backlogs, linkedOf = null) {
  const statuses = new Map();
  const all = [];
  for (const b of backlogs || []) {
    for (const i of (b && b.items) || []) {
      if (!i || typeof i.id !== 'string') continue;
      if (!statuses.has(i.id)) statuses.set(i.id, i.status);
      all.push({ folder: b.folder, item: i, inbox: routedInboxId(i.id) || (linkedOf ? linkedOf(b.folder, i.id) : null) });
    }
  }
  const out = [];
  for (const x of all) {
    const i = x.item;
    if (i.status !== 'pending' || !x.inbox || !Array.isArray(i.after)) continue;
    const bad = i.after.find((a) => statuses.get(a) === 'failed' || statuses.get(a) === 'dropped');
    if (!bad) continue;
    const by = all.find((y) => y !== x && y.inbox === x.inbox && y.item.status !== 'dropped' && (y.item.createdAt || 0) > (i.createdAt || 0));
    if (by) out.push({ folder: x.folder, id: i.id, after: bad, by: { folder: by.folder, id: by.item.id } });
  }
  return out;
}

module.exports = { knownFolders, autoPrefix, prefixValid, prefixOf, setPrefix, assignNo, numberItems, NUMBERS_FILE, TITLE_MAX, STATUSES, setStatus, updateStatus, routedInboxId, findReplaced, KINDS, TOUCHES_MAX, AFTER_MAX, cleanTouch, cleanTouches, cleanAfter, sanitizeItem, applyOrder, followsOrder, userOrderLock, USER_ORDER_LOCK_MS, sanitizeBacklog, backlogFile, getBacklog, readBacklogSync, saveBacklog, saveBacklogSync };
