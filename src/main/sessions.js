// Saved tabs (per workDir) and session history. No Electron imports (testable from plain Node).
const path = require('path');
const fs = require('fs');
const { projectsDir, promptText, findTranscript, readJson } = require('./transcript');
const writeq = require('./writeq');
const models = require('./models');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKTREE_RE = /^[A-Za-z0-9._-]{1,40}$/;
const norm = (p) => path.resolve(p).toLowerCase();
const encode = (p) => p.replace(/[^A-Za-z0-9]/g, '-');

function isInside(child, parent) {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// --- saved tabs -------------------------------------------------------------
function loadStore(file) {
  const j = readJson(file);
  return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
}

function sanitizeTabs(tabs) {
  if (!Array.isArray(tabs)) return [];
  const out = [];
  const seen = new Set();
  for (const t of tabs) {
    if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !UUID_RE.test(t.id) || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push({
      id: t.id,
      label: typeof t.label === 'string' ? t.label.slice(0, 200) : '',
      manualLabel: !!t.manualLabel,
      cwd: typeof t.cwd === 'string' ? t.cwd : '',
      worktree: typeof t.worktree === 'string' && WORKTREE_RE.test(t.worktree) ? t.worktree : null,
      team: t.team === true, // Agent Teams session: resumed with teams enabled
      delegate: t.delegate === true, // started for a routed item: resumed with the delegation prompt
      // AT-6: a routed item's own model / effort, resumed with the same (only valid values; none = the default)
      ...(models.isModel(t.model) ? { model: t.model } : {}),
      ...(models.isEffort(t.effort) ? { effort: t.effort } : {}),
      ...(models.KINDS.includes(t.kind) ? { kind: t.kind } : {}), // MODEL-KIND: the item's kind (its default model)
      forBacklog: t.forBacklog === true, // made for a routed item: after a restart its item is still judged by the done mark
      // resting tab (PROGRESS 35 'done' / 31 'idle'): restored without starting its claude (it starts when opened)
      rest: t.rest === 'done' || t.rest === 'idle' ? t.rest : null,
      // last talked to / opened by the user (ms): a routed session used after its item ended is resumed (PROGRESS 42)
      usedAt: Number.isFinite(t.usedAt) && t.usedAt > 0 ? Math.round(t.usedAt) : 0,
      // AT-autoclose: its last activity (ms), so the auto-close clock goes on after a restart; waiting for an answer
      quietAt: Number.isFinite(t.quietAt) && t.quietAt > 0 ? Math.round(t.quietAt) : 0,
      asking: t.asking === true,
    });
    if (out.length >= 100) break;
  }
  return out;
}

// perf2 (案 6): sessions.json is shared by every window. One store per file in memory (read from disk once),
// written by the per-file queue of src/main/writeq.js (newest wins, tmp + rename, off main's path).
const stores = new Map();
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

function saveTabs(file, workDir, tabs) {
  const store = storeOf(file);
  store[norm(workDir)] = sanitizeTabs(tabs);
  return writeq.write(file, JSON.stringify(store));
}

function savedTabs(file, workDir, root = projectsDir) {
  const list = sanitizeTabs(storeOf(file)[norm(workDir)]);
  return list.filter((t) => findTranscript(t.id, root));
}

// --- history ----------------------------------------------------------------
// Read complete lines from the head of a (possibly huge) jsonl until cwd and the first prompt are found.
function readHead(file, maxBytes = 512 * 1024) {
  const res = { cwd: null, firstPrompt: null, title: null, ts: null };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    let pos = 0;
    let rest = '';
    const chunk = Buffer.alloc(64 * 1024);
    while (pos < maxBytes) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      const text = rest + chunk.subarray(0, n).toString('utf8');
      const lines = text.split('\n');
      rest = lines.pop(); // possibly partial (or a split multi-byte char)
      for (const line of lines) scanLine(line, res);
      if (res.cwd && res.firstPrompt) break;
    }
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return res;
}

function scanLine(line, res) {
  if (!line.trim()) return;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (!o || o.isSidechain) return;
  if (!res.cwd && typeof o.cwd === 'string' && o.cwd) res.cwd = o.cwd;
  if (!res.ts && o.timestamp) res.ts = o.timestamp;
  if (o.type === 'custom-title' && typeof o.customTitle === 'string') res.title = o.customTitle;
  if (!res.firstPrompt) {
    const p = promptText(o);
    if (p) res.firstPrompt = p.slice(0, 500);
  }
}

// Latest inline custom-title line in the last bytes of the file.
function tailTitle(file, size, bytes = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"custom-title"')) continue;
      try {
        const o = JSON.parse(lines[i]);
        if (o.type === 'custom-title' && typeof o.customTitle === 'string') return o.customTitle;
      } catch {}
    }
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

// isOpen(id) -> boolean. Newest first, at most `limit`.
function history(workDir, isOpen = () => false, { root = projectsDir, limit = 60 } = {}) {
  const prefix = encode(path.resolve(workDir)).toLowerCase();
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const d of dirs) {
    if (!d.isDirectory() || !d.name.toLowerCase().startsWith(prefix)) continue;
    const pd = path.join(root, d.name);
    let names;
    try {
      names = fs.readdirSync(pd);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl') || !UUID_RE.test(n.slice(0, -6))) continue;
      const f = path.join(pd, n);
      try {
        const st = fs.statSync(f);
        if (st.isFile()) files.push({ f, id: n.slice(0, -6), mtime: st.mtimeMs, size: st.size });
      } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  const seen = new Set();
  for (const x of files) {
    if (out.length >= limit) break;
    if (seen.has(x.id)) continue;
    const head = readHead(x.f);
    if (!head.cwd || !isInside(head.cwd, workDir)) continue;
    const tj = readJson(path.join(x.f.slice(0, -6), 'custom-title.json'));
    const title =
      (tj && typeof tj.customTitle === 'string' && tj.customTitle) || tailTitle(x.f, x.size) || head.title || null;
    if (!head.firstPrompt && !title) continue; // nothing was ever said: not worth resuming
    seen.add(x.id);
    out.push({
      id: x.id,
      title,
      firstPrompt: head.firstPrompt || '',
      cwd: head.cwd,
      mtime: Math.round(x.mtime),
      size: x.size,
      open: !!isOpen(x.id),
    });
  }
  return out;
}

module.exports = { saveTabs, savedTabs, sanitizeTabs, history, isInside, encode, norm, UUID_RE, WORKTREE_RE };
