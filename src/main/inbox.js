// Global inbox (roadmap 20, docs/plan-dashboard.md): work items not yet tied to a folder, stored by main in
// userData/inbox.json = { items: InboxItem[] }. The manager agent routes them to project backlogs.
// Same write scheme as backlog.js: async coalesced writes (newest wins) + a sync variant for quit.
// No Electron imports (testable from plain Node).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const writeq = require('./writeq');

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
// hold (2026-11-03) = 保留: kept in the inbox, not offered to the manager as new work (counted in the daily stocktake)
const STATUSES = new Set(['new', 'asking', 'hold', 'routed', 'done', 'failed', 'dropped']);
const TEXT_MAX = 20000;
const NOTE_MAX = 2000;
const FOLDER_MAX = 1000;
const TITLE_MAX = 200;
const LINKS_MAX = 20;
const HISTORY_MAX = 20;
const HISTORY_ACTIONS = new Set(['add', 'edit', 'merge', 'link']);
const UNDO_FIELDS = ['text', 'title', 'status', 'note', 'folder', 'links'];
const ITEMS_MAX = 500;
const BYTES_MAX = 1024 * 1024;
const FINISHED = new Set(['done', 'dropped']); // dropped first on overflow
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bytes = (x) => Buffer.byteLength(JSON.stringify(x));

const newId = () => 'i' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

// InboxState = { items: InboxItem[], nextReq: number }
// InboxItem = { id, reqNo: '依頼-N', no: 'AT-12'|'' (folder number once routed), text, title, createdAt, status, folder: string|null, note, updatedAt,
//   source: 'user'|'manager'|'app'|'session' (who added it; app = the carry-over import, src/main/carryover.js; session = a routed
//   session's propose, src/main/propose.js), statusBy: 'user'|'manager'|'app'|'session' (who set the status last),
//   origin: null | { folder, backlogId, no, tabId, reason, kind?, touches?, after? } (source session: where it came from, U7),
//   links: [{ folder, backlogId }] (backlog items tied to it by the manager's link action),
//   originalText: string|null (text before the manager's first edit), history: HistoryEntry[] (manager changes, oldest first) }
// HistoryEntry = { at, action: 'add'|'edit'|'merge'|'link', note, undo: patch | null } (undo = the fields to restore)
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const absFolder = (v) => (typeof v === 'string' && v && path.isAbsolute(v) ? v.slice(0, FOLDER_MAX) : null);
function sanitizeLinks(v) {
  const out = [];
  for (const l of Array.isArray(v) ? v : []) {
    const folder = l && absFolder(l.folder);
    if (!folder || typeof l.backlogId !== 'string' || !ID_RE.test(l.backlogId)) continue;
    if (out.some((x) => x.backlogId === l.backlogId && x.folder.toLowerCase() === folder.toLowerCase())) continue;
    out.push({ folder, backlogId: l.backlogId });
  }
  return out.slice(-LINKS_MAX);
}
function sanitizeUndo(u) {
  if (!u || typeof u !== 'object') return null;
  const o = {};
  if (typeof u.text === 'string') o.text = u.text.slice(0, TEXT_MAX);
  if (typeof u.title === 'string') o.title = u.title.slice(0, TITLE_MAX);
  if (STATUSES.has(u.status)) o.status = u.status;
  if (typeof u.note === 'string') o.note = u.note.slice(0, NOTE_MAX);
  if (u.folder === null) o.folder = null;
  else if (absFolder(u.folder)) o.folder = absFolder(u.folder);
  if (Array.isArray(u.links)) o.links = sanitizeLinks(u.links);
  return Object.keys(o).length ? o : null;
}
function sanitizeHistory(v) {
  const out = [];
  for (const e of Array.isArray(v) ? v : []) {
    if (!e || !HISTORY_ACTIONS.has(e.action)) continue;
    out.push({ at: num(e.at) ?? 0, action: e.action, note: str(e.note, 300), undo: sanitizeUndo(e.undo) });
  }
  return out.slice(-HISTORY_MAX);
}
// Task numbers (UIUX U1, docs/ui-copy.md): reqNo = "依頼-N" (given when the item is added, kept), no = the folder's
// number of the backlog item it was first routed to ("AT-12", manager.js route), '' before that.
const REQ_PREFIX = '依頼';
const REQ_RE = /^依頼-\d{1,9}$/;
const NO_RE = /^[\p{L}\p{N}_]{1,8}-\d{1,9}$/u;
const SOURCES = ['user', 'manager', 'app', 'session'];
const REASON_MAX = 1000;
// origin of a session's proposal (U7, src/main/propose.js): the session's folder and backlog item, and the scheduling
// hints it suggested (kind / touches / after, already checked by manager.schedHints)
function sanitizeOrigin(o) {
  const folder = o && absFolder(o.folder);
  if (!folder) return null;
  const id = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : null);
  const out = { folder, backlogId: id(o.backlogId), no: typeof o.no === 'string' && NO_RE.test(o.no) ? o.no : null, tabId: id(o.tabId), reason: str(o.reason, REASON_MAX) };
  if (['research', 'implement', 'verify'].includes(o.kind)) out.kind = o.kind;
  if (Array.isArray(o.touches)) out.touches = o.touches.filter((t) => typeof t === 'string').map((t) => t.slice(0, 200)).slice(0, 30);
  if (Array.isArray(o.after)) out.after = o.after.filter((t) => id(t)).slice(0, 20);
  return out;
}
function sanitizeItem(o) {
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !ID_RE.test(o.id)) return null;
  const createdAt = num(o.createdAt) ?? 0;
  const source = SOURCES.includes(o.source) ? o.source : 'user';
  return {
    id: o.id,
    reqNo: typeof o.reqNo === 'string' && REQ_RE.test(o.reqNo) ? o.reqNo : '',
    no: typeof o.no === 'string' && NO_RE.test(o.no) ? o.no : '',
    text: str(o.text, TEXT_MAX),
    title: str(o.title, TITLE_MAX).replace(/\s+/g, ' ').trim(),
    createdAt,
    status: STATUSES.has(o.status) ? o.status : 'new',
    folder: absFolder(o.folder),
    note: str(o.note, NOTE_MAX),
    updatedAt: num(o.updatedAt) ?? createdAt,
    source,
    statusBy: SOURCES.includes(o.statusBy) ? o.statusBy : source,
    links: sanitizeLinks(o.links),
    originalText: typeof o.originalText === 'string' ? o.originalText.slice(0, TEXT_MAX) : null,
    history: sanitizeHistory(o.history),
    ...(source === 'session' ? { origin: sanitizeOrigin(o.origin) } : {}),
  };
}

// Array order kept (oldest first), duplicate ids keep the first. Overflow (> 500 items or > 1 MB) drops the
// oldest done / dropped items first, then the oldest of any status.
function sanitizeInbox(o) {
  const x = o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  const items = [];
  const seen = new Set();
  for (const raw of Array.isArray(x.items) ? x.items : []) {
    const it = sanitizeItem(raw);
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    items.push(it);
  }
  const victim = () => {
    let best = -1;
    for (let i = 0; i < items.length; i++) {
      const f = FINISHED.has(items[i].status);
      const bf = best >= 0 && FINISHED.has(items[best].status);
      if (best < 0 || (f && !bf) || (f === bf && items[i].createdAt < items[best].createdAt)) best = i;
    }
    return best;
  };
  while (items.length > ITEMS_MAX) items.splice(victim(), 1);
  let total = bytes({ items });
  while (items.length && total > BYTES_MAX) {
    const [gone] = items.splice(victim(), 1);
    total -= bytes(gone) + 1;
  }
  // nextReq = the next 依頼-N (only grows; absent in a file written before U1 -> createInbox numbers it once)
  const nextReq = Number.isInteger(x.nextReq) && x.nextReq > 0 ? x.nextReq : null;
  return nextReq ? { items, nextReq } : { items };
}

const reqOf = (it) => (it && REQ_RE.test(it.reqNo || '') ? Number(it.reqNo.slice(REQ_PREFIX.length + 1)) : 0);
// Gives the items without a reqNo one (creation order) and sets nextReq. -> new state (same object when nothing changed)
function numberInbox(state) {
  const max = state.items.reduce((m, it) => Math.max(m, reqOf(it)), 0);
  let next = Math.max(state.nextReq || 1, max + 1);
  const todo = state.items
    .map((it, i) => ({ it, i }))
    .filter((x) => !x.it.reqNo)
    .sort((a, b) => a.it.createdAt - b.it.createdAt || a.i - b.i);
  if (!todo.length && state.nextReq === next) return state;
  const items = [...state.items];
  for (const { i } of todo) items[i] = { ...items[i], reqNo: `${REQ_PREFIX}-${next++}` };
  return { items, nextReq: next };
}

// Patch fields a caller may change: text, status, folder, note, title; with { internal: true } (main only, never from a
// renderer) also no, links, originalText. Unknown / invalid values are ignored. by = who sets the status (statusBy).
function applyPatch(item, patch, { internal = false, by = null } = {}) {
  if (!patch || typeof patch !== 'object') return item;
  const next = { ...item };
  if (typeof patch.text === 'string') next.text = patch.text;
  if (STATUSES.has(patch.status)) {
    if (by && patch.status !== item.status) next.statusBy = by;
    next.status = patch.status;
  }
  if (patch.folder === null || (typeof patch.folder === 'string' && path.isAbsolute(patch.folder))) next.folder = patch.folder;
  if (typeof patch.note === 'string') next.note = patch.note;
  if (typeof patch.title === 'string') next.title = patch.title; // the user fixes the heading too (UIUX U1)
  if (internal) {
    if (typeof patch.no === 'string') next.no = patch.no;
    if (Array.isArray(patch.links)) next.links = patch.links;
    if (typeof patch.originalText === 'string') next.originalText = patch.originalText;
  }
  next.updatedAt = Date.now();
  return sanitizeItem(next) || item;
}

// The fields `patch` would change in `item`, as a patch that restores them (HistoryEntry.undo).
function undoOf(item, patch) {
  const u = {};
  for (const k of UNDO_FIELDS) if (patch && patch[k] !== undefined) u[k] = k === 'links' ? [...item.links] : item[k];
  return u;
}

// createInbox(file, { onChange(state, info) }) -> store kept in memory, persisted to `file`.
// info = { type: 'add'|'update', item, prev?, source? }
function createInbox(file, { onChange } = {}) {
  let state = { items: [], nextReq: 1 };
  let migrate = false;
  try {
    state = sanitizeInbox(JSON.parse(fs.readFileSync(file, 'utf8')));
    const numbered = numberInbox(state);
    migrate = numbered !== state; // a file from before U1: its items get 依頼-N once, in creation order
    state = numbered;
  } catch {}
  const setItems = (items) => (state = { items, nextReq: state.nextReq });

  // AT-202: through the per-file queue of writeq.js (newest wins, tmp + rename; a step that does not come back in time
  // is written synchronously instead of waiting for a busy thread pool). The state in memory is what everyone reads.
  function save() {
    return writeq.write(file, JSON.stringify(state, null, 1));
  }

  function saveSync() {
    return writeq.writeSync(file, JSON.stringify(state, null, 1));
  }

  const changed = (info) => {
    save();
    try {
      onChange && onChange(state, info);
    } catch (err) {
      console.warn('[inbox] onChange failed', err);
    }
  };

  if (migrate) save(); // the numbers given above, written once (the next load finds them)

  return {
    file, // its place (src/main/propose.js reads manager-settings.json next to it)
    get: () => state,
    find: (id) => state.items.find((i) => i.id === id) || null,
    // -> InboxItem | null (empty text). o = { text, title?, note?, status?: 'new'|'hold', source?: 'user'|'manager'|'app'|'session',
    // historyNote?, folder?, origin? } — only text from a renderer (inbox:add); the rest is for main (the manager's inbox / route
    // actions; 'app' = the carry-over import, which may also set folder; 'session' = a session's propose (src/main/propose.js):
    // title, folder = the session's folder and origin, status new, or hold + note when it is over a propose limit; no history).
    // A manager-added item gets history [{ action:'add', undo: { status:'dropped' } }] (the dashboard can undo it).
    add(o) {
      const text = o && typeof o.text === 'string' ? o.text.trim() : '';
      if (!text) return null;
      const now = Date.now();
      const byApp = o.source === 'app';
      const bySession = o.source === 'session';
      const byManager = o.source === 'manager' || byApp; // title / note / hold allowed
      const nextReq = state.nextReq || 1;
      const item = sanitizeItem({
        id: newId(),
        reqNo: `${REQ_PREFIX}-${nextReq}`,
        text,
        title: (byManager || bySession) && typeof o.title === 'string' ? o.title.trim() : '',
        createdAt: now,
        updatedAt: now,
        status: (byManager || bySession) && o.status === 'hold' ? 'hold' : 'new',
        folder: byApp || bySession ? absFolder(o.folder) : null,
        note: (byManager || bySession) && typeof o.note === 'string' ? o.note : '',
        source: byApp ? 'app' : byManager ? 'manager' : bySession ? 'session' : 'user',
        statusBy: byApp ? 'app' : byManager ? 'manager' : bySession ? 'session' : 'user',
        origin: bySession ? o.origin : null,
        history: byManager ? [{ at: now, action: 'add', note: o.historyNote || (byApp ? 'アプリが取り込み' : 'ルーターが追加'), undo: { status: 'dropped' } }] : [],
      });
      state = sanitizeInbox({ items: [...state.items, item], nextReq: nextReq + 1 });
      changed({ type: 'add', item, source: item.source });
      return item;
    },
    // -> updated InboxItem | null (unknown id)
    // meta.source ('manager'|'user'|'app') is passed to onChange as info.source and becomes statusBy when the status
    // changes. meta.internal allows title / links / originalText. meta.history = { action, note } appends a HistoryEntry
    // whose undo restores the fields this patch changed (meta.undo replaces it; null = cannot be undone).
    update(id, patch, meta) {
      const i = state.items.findIndex((x) => x.id === id);
      if (i < 0) return null;
      const prev = state.items[i];
      const m = meta || {};
      let item = applyPatch(prev, patch, { internal: !!m.internal, by: m.source || null });
      if (m.history) {
        const undo = m.undo !== undefined ? m.undo : undoOf(prev, patch);
        const entry = { at: Date.now(), action: m.history.action, note: m.history.note || '', undo };
        item = sanitizeItem({ ...item, history: [...item.history, entry] }) || item;
      }
      setItems(state.items.map((x, j) => (j === i ? item : x)));
      changed({ type: 'update', item, prev, source: m.source || null, finished: m.finished || null });
      return item;
    },
    // Undoes the newest manager change of the item that has an undo patch; that history entry is removed.
    // Undoing the last edit also clears originalText. -> updated InboxItem | null (unknown id / nothing to undo)
    undo(id) {
      const i = state.items.findIndex((x) => x.id === id);
      if (i < 0) return null;
      const prev = state.items[i];
      const k = prev.history.map((e) => !!e.undo).lastIndexOf(true);
      if (k < 0) return null;
      const entry = prev.history[k];
      const history = prev.history.filter((_, j) => j !== k);
      let item = applyPatch(prev, entry.undo, { internal: true, by: 'user' });
      const extra = entry.action === 'edit' && !history.some((e) => e.action === 'edit') ? { originalText: null } : {};
      item = sanitizeItem({ ...item, history, ...extra }) || item;
      setItems(state.items.map((x, j) => (j === i ? item : x)));
      changed({ type: 'update', item, prev, source: 'user', undone: entry.action });
      return item;
    },
    flush: () => writeq.whenWritten(file),
    saveSync,
  };
}

module.exports = { sanitizeInbox, sanitizeItem, applyPatch, createInbox, numberInbox, STATUSES, ID_RE, TITLE_MAX, REQ_PREFIX };
