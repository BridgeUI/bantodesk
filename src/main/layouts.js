// Dock layout + view settings per folder, stored by main in userData/layouts.json.
// Replaces the renderer's localStorage, whose lazy commit lost the last seconds of layout changes
// when the app quit (found by tmp/dock/t2.mjs). No Electron imports (testable from plain Node).
// Also: composer drafts + send history per folder, in their own file per folder (userData/composer/<hash>.json)
// so that the frequently saved, potentially large composer state does not rewrite layouts.json.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const writeq = require('./writeq');

const norm = (p) => path.resolve(p).toLowerCase();
const MAX_BYTES = 512 * 1024; // a dockview toJSON() is a few KB; refuse anything absurd
const VIEW_MODES = new Set(['rich', 'term', 'split']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function loadStore(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

// FolderLayout = { dock: object|null, preset: 1|2|4, assistShown: boolean, viewModes: { [tabId]: mode }, defaultViewMode }
function sanitize(o) {
  const out = { dock: null, preset: 1, assistShown: true, viewModes: {}, defaultViewMode: 'rich' };
  if (!o || typeof o !== 'object') return out;
  if (o.dock && typeof o.dock === 'object' && !Array.isArray(o.dock)) {
    try {
      if (JSON.stringify(o.dock).length <= MAX_BYTES) out.dock = o.dock;
    } catch {}
  }
  if ([1, 2, 4].includes(o.preset)) out.preset = o.preset;
  if (typeof o.assistShown === 'boolean') out.assistShown = o.assistShown;
  if (VIEW_MODES.has(o.defaultViewMode)) out.defaultViewMode = o.defaultViewMode;
  // manager window: width of the agent column beside the dashboard (renderer.js setupDashSplit)
  if (Number.isFinite(o.dashChatWidth) && o.dashChatWidth >= 100 && o.dashChatWidth <= 10000) out.dashChatWidth = Math.round(o.dashChatWidth);
  if (o.viewModes && typeof o.viewModes === 'object') {
    let n = 0;
    for (const [id, mode] of Object.entries(o.viewModes)) {
      if (!UUID_RE.test(id) || !VIEW_MODES.has(mode)) continue;
      out.viewModes[id] = mode;
      if (++n >= 200) break;
    }
  }
  return out;
}

// perf2 (案 6): layouts.json is shared by every window. main keeps one store per file in memory (read from
// disk once) and every save goes through it, so two windows saving close together cannot lose each other's
// folder; the file is written by the per-file queue of src/main/writeq.js (newest wins, tmp + rename).
const stores = new Map(); // resolved file -> store object (newest; the disk may lag a few ms)
function storeOf(file) {
  const k = path.resolve(file);
  let s = stores.get(k);
  if (!s) {
    const p = writeq.pending(k);
    s = p !== null ? JSON.parse(p) : loadStore(k);
    stores.set(k, s);
  }
  return s;
}

function getLayout(file, workDir) {
  const store = storeOf(file);
  const key = norm(workDir);
  return Object.prototype.hasOwnProperty.call(store, key) ? sanitize(store[key]) : null; // null = never saved
}

// Async write (layout:save): the store is updated at once, the file a moment later.
function saveLayout(file, workDir, layout) {
  const store = storeOf(file);
  store[norm(workDir)] = sanitize(layout);
  writeq.write(file, JSON.stringify(store));
  return true;
}

// Synchronous write (beforeunload's layout:saveSync): on disk before the IPC returns.
function saveLayoutSync(file, workDir, layout) {
  const store = storeOf(file);
  store[norm(workDir)] = sanitize(layout);
  return writeq.writeSync(file, JSON.stringify(store));
}

// --- composer state: { drafts, history } per folder ----------------------------------------------
const DRAFT_TEXT_MAX = 20000;
const DRAFT_TABS_MAX = 100;
const DRAFTS_BYTES_MAX = 512 * 1024;
const ATTACH_MAX = 20;
const HISTORY_ITEM_MAX = 4000;
const HISTORY_MAX = 200;
const HISTORY_BYTES_MAX = 256 * 1024;
const ATTACH_KINDS = new Set(['file', 'image']);
const bytes = (x) => Buffer.byteLength(JSON.stringify(x));

// drafts: { [tabId]: { text, attachments: [{ path, kind, name }] } }, insertion order = oldest first.
// Overflow (count or bytes) drops the OLDEST entries.
function sanitizeDrafts(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const list = [];
  for (const [id, d] of Object.entries(o)) {
    if (!UUID_RE.test(id) || !d || typeof d !== 'object') continue;
    const attachments = [];
    if (Array.isArray(d.attachments)) {
      for (const a of d.attachments) {
        if (attachments.length >= ATTACH_MAX) break;
        if (!a || typeof a.path !== 'string' || !a.path || !ATTACH_KINDS.has(a.kind)) continue;
        attachments.push({ path: a.path.slice(0, 1000), kind: a.kind, name: typeof a.name === 'string' ? a.name.slice(0, 200) : '' });
      }
    }
    list.push([id, { text: typeof d.text === 'string' ? d.text.slice(0, DRAFT_TEXT_MAX) : '', attachments }]);
  }
  const kept = list.slice(-DRAFT_TABS_MAX);
  let total = kept.reduce((n, [id, d]) => n + bytes(id) + bytes(d), 0);
  while (kept.length && total > DRAFTS_BYTES_MAX) {
    const [id, d] = kept.shift();
    total -= bytes(id) + bytes(d);
  }
  return Object.fromEntries(kept);
}

// history: sent prompts, oldest first; keeps the newest HISTORY_MAX items within HISTORY_BYTES_MAX.
function sanitizeHistory(a) {
  if (!Array.isArray(a)) return [];
  const kept = a
    .filter((s) => typeof s === 'string')
    .slice(-HISTORY_MAX)
    .map((s) => s.slice(0, HISTORY_ITEM_MAX));
  let total = kept.reduce((n, s) => n + bytes(s), 0);
  while (kept.length && total > HISTORY_BYTES_MAX) total -= bytes(kept.shift());
  return kept;
}

function sanitizeComposer(o) {
  const x = o && typeof o === 'object' ? o : {};
  return { drafts: sanitizeDrafts(x.drafts), history: sanitizeHistory(x.history) };
}

const composerFile = (dir, workDir) =>
  path.join(dir, crypto.createHash('sha1').update(norm(workDir)).digest('hex').slice(0, 16) + '.json');

// Per file: newest data and write bookkeeping. version counts saves; asyncVer = version the async
// writer last put on disk. Concurrent async saves are coalesced into one write of the newest data.
const writers = new Map();
const writerOf = (file) => {
  let w = writers.get(file);
  if (!w) writers.set(file, (w = { latest: null, version: 0, asyncVer: 0, running: null }));
  return w;
};

// Attachments whose file is gone (pasted images are deleted after 7 days) are dropped, so a restored
// draft never sends a dead path. Relative paths are taken relative to workDir. Returns a new object.
async function dropMissingAttachments(state, workDir) {
  const exists = (p) =>
    fs.promises.access(path.resolve(workDir, p)).then(
      () => true,
      () => false,
    );
  const drafts = {};
  await Promise.all(
    Object.entries(state.drafts).map(async ([id, d]) => {
      const ok = await Promise.all(d.attachments.map((a) => exists(a.path)));
      drafts[id] = { text: d.text, attachments: d.attachments.filter((_, i) => ok[i]) };
    }),
  );
  // keep the insertion order (oldest first) of the original
  const ordered = {};
  for (const id of Object.keys(state.drafts)) ordered[id] = drafts[id];
  return { drafts: ordered, history: state.history };
}

// -> { drafts, history }. If no composer file exists yet, takes over drafts/history that an older
// version stored inside layouts.json (once: the composer file is written right away).
async function getComposer(dir, workDir, layoutsFile) {
  return dropMissingAttachments(await readComposer(dir, workDir, layoutsFile), workDir);
}

async function readComposer(dir, workDir, layoutsFile) {
  const file = composerFile(dir, workDir);
  const w = writers.get(file);
  if (w && w.latest) return w.latest; // newer than the disk while a write is pending
  try {
    return sanitizeComposer(JSON.parse(await fs.promises.readFile(file, 'utf8')));
  } catch (err) {
    if (err && err.code !== 'ENOENT') return sanitizeComposer(null); // unreadable / corrupt
  }
  const old = layoutsFile ? storeOf(layoutsFile)[norm(workDir)] : null;
  const taken = sanitizeComposer(old);
  if (old && (old.drafts || old.history)) saveComposerSync(dir, workDir, taken);
  return taken;
}

function writeSync(file, data, tmpSuffix) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + tmpSuffix;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// Async write (tmp + rename); resolves true when the newest data passed in so far is on disk.
function saveComposer(dir, workDir, data) {
  const file = composerFile(dir, workDir);
  const w = writerOf(file);
  w.latest = sanitizeComposer(data);
  w.version++;
  if (!w.running) {
    w.running = (async () => {
      let ok = true;
      try {
        await fs.promises.mkdir(dir, { recursive: true });
        while (w.asyncVer < w.version) {
          const v = w.version;
          const tmp = file + '.tmp';
          await fs.promises.writeFile(tmp, JSON.stringify(w.latest));
          await fs.promises.rename(tmp, file);
          w.asyncVer = v;
        }
      } catch (err) {
        console.warn('[composer] save failed', err);
        ok = false;
      }
      w.running = null;
      if (ok) w.latest = null; // disk is current again
      return ok;
    })();
  }
  return w.running;
}

// Synchronous variant for beforeunload. If an async write is in flight it will rewrite the same
// newest data afterwards (version moved on), so an older async rename cannot win.
function saveComposerSync(dir, workDir, data) {
  const file = composerFile(dir, workDir);
  const w = writerOf(file);
  const clean = sanitizeComposer(data);
  w.version++;
  if (w.running) w.latest = clean;
  else w.asyncVer = w.version;
  try {
    writeSync(file, clean, '.sync.tmp');
    return true;
  } catch (err) {
    console.warn('[composer] sync save failed', err);
    return false;
  }
}

module.exports = { getLayout, saveLayout, saveLayoutSync, sanitize, sanitizeComposer, composerFile, getComposer, saveComposer, saveComposerSync };
