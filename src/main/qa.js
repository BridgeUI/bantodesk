// Pre-answered QA per queued task (2026-11-03): the manager agent (ルーター) prepares a QA table for a backlog item
// (or an inbox item not routed yet) ahead of time, the user answers it on the dashboard whenever, and the
// answers are appended to the prompt when the item is actually sent, so the session does not stop to ask.
// Stored by main in userData/qa.json = { entries: { [key]: QaEntry } }.
//   key = `${norm(folder)}|${backlogItemId}` for backlog items, `inbox|${inboxId}` for inbox items not routed yet.
//   QaEntry = { folder: string|null, itemId: string|null, inboxId: string|null,
//               rows: [{ topic, hypothesis, question, answer }], status: 'open'|'answered',
//               createdAt, updatedAt, answeredAt: number|null, usedAt: number|null }
// Atomic writes (tmp + rename) through the per-file queue of writeq.js (perf2 案 6: async, newest wins).
// No Electron imports (testable from plain Node).
const path = require('path');
const writeq = require('./writeq');

const norm = (p) => path.resolve(p).toLowerCase();
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ROWS_MAX = 12;
const STR_MAX = 1000;
const FOLDER_MAX = 1000;
const ENTRIES_MAX = 300;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v.slice(0, STR_MAX) : '');

const backlogKey = (folder, itemId) => `${norm(folder)}|${itemId}`;
const inboxKey = (inboxId) => `inbox|${inboxId}`;

// Row from the agent / file -> { topic, hypothesis, question, answer } | null (no topic and no question)
function sanitizeRow(o) {
  if (!o || typeof o !== 'object') return null;
  const row = { topic: str(o.topic).trim(), hypothesis: str(o.hypothesis).trim(), question: str(o.question).trim(), answer: str(o.answer) };
  return row.topic || row.question ? row : null;
}
const sanitizeRows = (rows) => (Array.isArray(rows) ? rows.map(sanitizeRow).filter(Boolean).slice(0, ROWS_MAX) : []);

function sanitizeEntry(o) {
  if (!o || typeof o !== 'object') return null;
  const rows = sanitizeRows(o.rows);
  if (!rows.length) return null;
  const createdAt = num(o.createdAt) ?? 0;
  return {
    folder: typeof o.folder === 'string' && o.folder && path.isAbsolute(o.folder) ? o.folder.slice(0, FOLDER_MAX) : null,
    itemId: typeof o.itemId === 'string' && ID_RE.test(o.itemId) ? o.itemId : null,
    inboxId: typeof o.inboxId === 'string' && ID_RE.test(o.inboxId) ? o.inboxId : null,
    rows,
    status: o.status === 'answered' ? 'answered' : 'open',
    createdAt,
    updatedAt: num(o.updatedAt) ?? createdAt,
    answeredAt: num(o.answeredAt),
    usedAt: num(o.usedAt),
  };
}

// Keys must match the entry (backlog key needs folder + itemId, inbox key needs inboxId). Over ENTRIES_MAX the
// oldest (updatedAt) entries are dropped.
function sanitizeQa(o) {
  const x = o && typeof o === 'object' && o.entries && typeof o.entries === 'object' && !Array.isArray(o.entries) ? o.entries : {};
  let list = [];
  for (const [key, raw] of Object.entries(x)) {
    const e = sanitizeEntry(raw);
    if (!e) continue;
    const want = e.folder && e.itemId ? backlogKey(e.folder, e.itemId) : e.inboxId && !e.folder ? inboxKey(e.inboxId) : null;
    if (want !== key) continue;
    list.push([key, e]);
  }
  if (list.length > ENTRIES_MAX) list = list.sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, ENTRIES_MAX);
  return { entries: Object.fromEntries(list) };
}

const rowKey = (r) => `${r.topic}\u0000${r.question}`;

// New rows from the agent + the previous entry -> rows with the old answers kept for the same topic + question,
// and whether every new row was answered before (then the entry stays 'answered').
function mergeRows(rows, prev) {
  const old = new Map((prev ? prev.rows : []).map((r) => [rowKey(r), r.answer]));
  let allKnown = !!prev;
  const out = rows.map((r) => {
    const k = rowKey(r);
    if (!old.has(k)) allKnown = false;
    return { ...r, answer: old.has(k) ? old.get(k) : '' };
  });
  return { rows: out, keepAnswered: allKnown && prev.status === 'answered' };
}

// createQa(file, { onChange(state, info) }) -> store. info = { type: 'set'|'answer'|'remove'|'move'|'used', key, entry? }
function createQa(file, { onChange } = {}) {
  let state = { entries: {} };
  try {
    state = sanitizeQa(JSON.parse(writeq.readTextSync(file)));
  } catch {}

  function write() {
    return writeq.write(file, JSON.stringify(state, null, 1));
  }
  const changed = (info) => {
    state = sanitizeQa(state); // caps
    write();
    try {
      onChange && onChange(state, info);
    } catch (err) {
      console.warn('[qa] onChange failed', err);
    }
  };
  const put = (key, entry) => {
    state = { entries: { ...state.entries, [key]: entry } };
  };

  return {
    get: (key) => state.entries[key] || null,
    // -> [{ key, ...entry }] newest first
    list: () => Object.entries(state.entries).map(([key, e]) => ({ key, ...e })).sort((a, b) => b.updatedAt - a.updatedAt),
    // Target = { folder, itemId } (backlog item) or { inboxId } (inbox item not routed). -> entry | null (no valid rows / target)
    set(target, rows) {
      const t = target || {};
      const backlog = typeof t.folder === 'string' && path.isAbsolute(t.folder) && typeof t.itemId === 'string' && ID_RE.test(t.itemId);
      const inbox = !backlog && typeof t.inboxId === 'string' && ID_RE.test(t.inboxId);
      if (!backlog && !inbox) return null;
      const clean = sanitizeRows(rows);
      if (!clean.length) return null;
      const key = backlog ? backlogKey(t.folder, t.itemId) : inboxKey(t.inboxId);
      const prev = state.entries[key] || null;
      const m = mergeRows(clean, prev);
      const now = Date.now();
      const entry = sanitizeEntry({
        folder: backlog ? t.folder : null,
        itemId: backlog ? t.itemId : null,
        inboxId: typeof t.inboxId === 'string' ? t.inboxId : prev ? prev.inboxId : null,
        rows: m.rows,
        status: m.keepAnswered ? 'answered' : 'open',
        createdAt: prev ? prev.createdAt : now,
        updatedAt: now,
        answeredAt: m.keepAnswered ? prev.answeredAt : null,
        usedAt: null,
      });
      put(key, entry);
      changed({ type: 'set', key, entry });
      return { key, ...entry };
    },
    // answers[i] belongs to rows[i] (missing / non-string -> ''). Status becomes 'answered' even with blanks
    // (blank = as the hypothesis says). -> entry | null (unknown key)
    answer(key, answers) {
      const prev = state.entries[key];
      if (!prev) return null;
      const a = Array.isArray(answers) ? answers : [];
      const now = Date.now();
      const entry = { ...prev, rows: prev.rows.map((r, i) => ({ ...r, answer: str(a[i]) })), status: 'answered', answeredAt: now, updatedAt: now };
      put(key, entry);
      changed({ type: 'answer', key, entry });
      return { key, ...entry };
    },
    // Inbox entry -> backlog item key once the item is routed (answers carry over). -> entry | null
    moveInbox(inboxId, folder, itemId) {
      const from = inboxKey(inboxId);
      const prev = state.entries[from];
      if (!prev || typeof folder !== 'string' || !path.isAbsolute(folder) || !ID_RE.test(String(itemId))) return null;
      const key = backlogKey(folder, itemId);
      const entry = { ...prev, folder, itemId, inboxId: prev.inboxId || inboxId, updatedAt: Date.now() };
      const entries = { ...state.entries, [key]: entry };
      delete entries[from];
      state = { entries };
      changed({ type: 'move', key, from, entry });
      return { key, ...entry };
    },
    markUsed(key) {
      const prev = state.entries[key];
      if (!prev) return null;
      const entry = { ...prev, usedAt: Date.now() };
      put(key, entry);
      changed({ type: 'used', key, entry });
      return { key, ...entry };
    },
    remove(key) {
      if (!state.entries[key]) return false;
      const entries = { ...state.entries };
      delete entries[key];
      state = { entries };
      changed({ type: 'remove', key });
      return true;
    },
    // 'none'|'open'|'answered'
    statusOf: (key) => (state.entries[key] ? state.entries[key].status : 'none'),
    state: () => state,
  };
}

module.exports = { createQa, sanitizeQa, sanitizeRows, backlogKey, inboxKey, ROWS_MAX, STR_MAX };
