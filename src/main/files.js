// Composer helpers: @-file search, custom slash command / skill list, pasted image save.
// No Electron imports (testable from plain Node). Every exported function is total: errors → empty result.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileOff } = require('./offthread');
const { PASTE_DIR } = require('./names');

// --- file search --------------------------------------------------------------
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', '__pycache__', 'tmp']);
const WALK_MAX = 20000;
const WALK_DEPTH = 12;
const CACHE_MS = 10 * 1000;
const STAT_MAX = 5000; // non-git folders: mtimes for the empty query are read for at most this many files
const STAT_CONCURRENCY = 16;
const RECENT_MAX = 100;
// norm(cwd) -> { at, files: string[], isGit, untracked: string[], gitRecent: string[], mtimes: Map (kept across refreshes),
//                recent: string[]|null, recentPending: Promise|null, pending: Promise|null }
const cache = new Map();

// git runs on offthread's worker (starting a process blocks the calling thread 120-1100 ms here, docs/perf.md #3);
// the worker also splits the output, so main never holds the whole (up to 64 MB) string.
// -> string[] (stdout split on `split`) | null on any error.
const git = async (cwd, args, maxBuffer, split) => {
  const r = await execFileOff('git', args, { cwd, windowsHide: true, maxBuffer, timeout: 5000 }, { split });
  return r.err ? null : r.lines;
};

// -> { files, untracked } | null (not a repo). `-t` tags each path: 'H ' tracked, '? ' untracked.
async function gitList(cwd) {
  const recs = await git(cwd, ['ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard'], 64 * 1024 * 1024, '\0');
  if (recs === null) return null;
  const seen = new Set();
  const untracked = [];
  for (const rec of recs) {
    if (rec.length < 3) continue;
    const f = rec.slice(2);
    if (seen.has(f)) continue; // --cached + --others can repeat
    seen.add(f);
    if (rec[0] === '?') untracked.push(f);
    if (seen.size >= 100000) break;
  }
  return { files: [...seen], untracked };
}

// Files touched by the last 30 commits, newest first, relative to cwd (--relative limits to cwd's subtree).
async function gitRecent(cwd) {
  const lines = await git(cwd, ['-c', 'core.quotepath=off', 'log', '--relative', '--name-only', '--pretty=format:', '-n', '30'], 8 * 1024 * 1024, { re: '\\r?\\n' });
  if (lines === null) return [];
  const seen = new Set();
  for (const l of lines) if (l.trim()) seen.add(l.trim().replace(/^"|"$/g, ''));
  return [...seen];
}

// Async stat with limited concurrency; fills `mtimes` (path -> ms, missing files removed).
async function statInto(cwd, paths, mtimes) {
  let i = 0;
  const worker = async () => {
    while (i < paths.length) {
      const f = paths[i++];
      try {
        mtimes.set(f, (await fs.promises.stat(path.join(cwd, f))).mtimeMs);
      } catch {
        mtimes.delete(f); // deleted but still listed
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, paths.length) }, worker));
}

// Recently modified files for the empty "@" query. Git: candidates = files of recent commits + untracked
// files (re-stat'ed, a few hundred at most). Otherwise: the first STAT_MAX listed files, only new paths stat'ed.
function computeRecent(cwd, entry) {
  if (entry.recentPending) return entry.recentPending;
  entry.recentPending = (async () => {
    try {
      const listed = new Set(entry.files);
      let cands;
      if (entry.isGit) {
        cands = [...new Set([...entry.gitRecent,...entry.untracked.slice(0, 500)])].filter((f) => listed.has(f));
        await statInto(cwd, cands, entry.mtimes);
      } else {
        cands = entry.files.slice(0, STAT_MAX);
        await statInto(cwd, cands.filter((f) => !entry.mtimes.has(f)), entry.mtimes);
      }
      for (const f of entry.mtimes.keys()) if (!listed.has(f)) entry.mtimes.delete(f);
      entry.recent = cands
        .filter((f) => entry.mtimes.has(f))
        .sort((a, b) => entry.mtimes.get(b) - entry.mtimes.get(a))
        .slice(0, RECENT_MAX);
    } catch {
      if (!entry.recent) entry.recent = [];
    }
    entry.recentPending = null;
    return entry.recent;
  })();
  return entry.recentPending;
}

async function walkList(cwd) {
  const out = [];
  const stack = [{ dir: cwd, rel: '', depth: 0 }];
  while (stack.length && out.length < WALK_MAX) {
    const { dir, rel, depth } = stack.pop();
    let ents;
    try {
      ents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of ents) {
      const r = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name) && depth + 1 < WALK_DEPTH) stack.push({ dir: path.join(dir, d.name), rel: r, depth: depth + 1 });
      } else if (d.isFile()) {
        out.push(r);
        if (out.length >= WALK_MAX) break;
      }
    }
  }
  return out;
}

// Stale-while-revalidate: spawning git costs ~300 ms on Windows, so a list older than CACHE_MS is still
// returned at once while a fresh one is fetched in the background. Only the very first call waits.
function refresh(cwd, entry) {
  if (entry.pending) return entry.pending;
  entry.pending = (async () => {
    try {
      // An empty git list = not tracked here (e.g. a folder git ignores inside a repo): walk it instead.
      // both git processes in parallel: each spawn costs ~300 ms on Windows
      const [g, recent] = await Promise.all([gitList(cwd), gitRecent(cwd)]);
      entry.gitRecent = recent;
      entry.isGit = !!(g && g.files.length);
      entry.files = entry.isGit ? g.files : await walkList(cwd);
      entry.untracked = entry.isGit ? g.untracked : [];
      entry.at = Date.now();
      setImmediate(() => computeRecent(cwd, entry)); // ready by the time "@" is typed
    } catch {
      if (!entry.files) entry.files = [];
    }
    entry.pending = null;
    return entry;
  })();
  return entry.pending;
}

async function listFiles(cwd) {
  const key = path.resolve(cwd).toLowerCase();
  let entry = cache.get(key);
  if (!entry) {
    entry = { at: 0, files: null, isGit: false, untracked: [], gitRecent: [], mtimes: new Map(), recent: null, recentPending: null, pending: null };
    cache.set(key, entry);
    if (cache.size > 20) cache.delete(cache.keys().next().value);
  }
  if (!entry.files) return refresh(cwd, entry);
  // spawn() itself blocks ~100 ms on Windows: start it after this reply has gone out
  if (Date.now() - entry.at >= CACHE_MS && !entry.pending) setImmediate(() => refresh(cwd, entry));
  return entry;
}

// Fill the cache ahead of the first search (main calls this when a project window opens).
function prewarm(cwd) {
  listFiles(cwd).catch(() => {});
}

// The last computed list is returned at once; only the very first call waits for it.
async function recentFirst(cwd, entry, limit) {
  const list = entry.recent || (await computeRecent(cwd, entry));
  return list.slice(0, limit);
}

function isSubsequence(q, s) {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++;
  return i === q.length;
}

// Lower is better. null = no match.
// 0 basename prefix, 1 basename substring, 2 path substring, 3 basename subsequence, 4 path subsequence.
// Tiers above `worst` are not even tested (they could not make the result any more).
function rank(q, file, worst) {
  const p = file.toLowerCase();
  const slash = p.lastIndexOf('/');
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  if (base.startsWith(q)) return 0;
  if (worst < 1) return null;
  if (base.includes(q)) return 1;
  if (worst < 2) return null;
  if (p.includes(q)) return 2;
  if (worst < 3) return null;
  if (isSubsequence(q, base)) return 3;
  if (worst < 4) return null;
  if (isSubsequence(q, p)) return 4;
  return null;
}

const TOP_TIER_ENOUGH = 2000; // this many basename-prefix hits: stop scanning (sorted by length anyway)

function rankFiles(files, query, limit) {
  const q = query.toLowerCase().replace(/\\/g, '/');
  const hits = [];
  const count = [0, 0, 0, 0, 0];
  let worst = 4; // worst tier still worth testing: once `limit` hits exist at tiers <= t, worse tiers are skipped
  for (const f of files) {
    const r = rank(q, f, worst);
    if (r === null) continue;
    hits.push({ f, r });
    count[r]++;
    let sum = 0;
    for (let t = 0; t < worst; t++) {
      sum += count[t];
      if (sum >= limit) {
        worst = t;
        break;
      }
    }
    if (count[0] >= TOP_TIER_ENOUGH) break;
  }
  hits.sort((a, b) => a.r - b.r || a.f.length - b.f.length || (a.f < b.f ? -1 : a.f > b.f ? 1 : 0));
  return hits.slice(0, limit).map((h) => h.f);
}

// -> { cwd, files: string[] relative to cwd (forward slashes), best first }. Never throws.
async function searchFiles(cwd, query, limit) {
  const dir = path.resolve(String(cwd || '.'));
  try {
    const n = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 30));
    const entry = await listFiles(dir);
    const q = typeof query === 'string' ? query.trim().slice(0, 200) : '';
    if (!q) return { cwd: dir, files: await recentFirst(dir, entry, n) };
    return { cwd: dir, files: rankFiles(entry.files, q, n) }; // git and the walker both emit forward slashes
  } catch (err) {
    console.warn('[files] search failed', err);
    return { cwd: dir, files: [] };
  }
}

// --- slash commands / skills -------------------------------------------------
function frontmatter(text) {
  const out = {};
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: out, body: text };
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?\d*$/.test(v)) {
      // YAML block scalar (`>-`, `|` ...): the following indented / blank lines, joined into one line
      const parts = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) parts.push(lines[++i].trim());
      v = parts.filter(Boolean).join(' ');
    } else {
      v = v.replace(/^(["'])(.*)\1$/, '$2');
    }
    out[kv[1].toLowerCase()] = v;
  }
  return { meta: out, body: text.slice(m[0].length) };
}

function firstLine(body) {
  for (const l of body.split(/\r?\n/)) {
    const t = l.replace(/^#+\s*/, '').trim();
    if (t) return t;
  }
  return '';
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function readHead(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf8', 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function collectCommands(root, source, out, seen) {
  const walk = (dir, prefix, depth) => {
    if (depth > 6) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of ents) {
      if (out.length >= 500) return;
      if (d.isDirectory()) walk(path.join(dir, d.name), [...prefix, d.name], depth + 1);
      else if (d.isFile() && /\.md$/i.test(d.name)) {
        // Like current Claude Code: a sub-folder does not prefix the name, it is shown as "(project:frontend)".
        const name = d.name.replace(/\.md$/i, '');
        if (seen.has(name)) continue; // first wins: project before user
        const text = readHead(path.join(dir, d.name));
        if (text === null) continue;
        const { meta, body } = frontmatter(text);
        seen.add(name);
        const where = prefix.length ? ` (${source}:${prefix.join('/')})` : '';
        out.push({ name, description: (clip(meta.description || firstLine(body), 120) + where).trim(), source });
      }
    }
  };
  walk(root, [], 0);
}

function collectSkills(root, source, out, seen) {
  let ents;
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of ents) {
    if (out.length >= 500) return;
    if (!d.isDirectory()) continue;
    const text = readHead(path.join(root, d.name, 'SKILL.md'));
    if (text === null) continue;
    const { meta, body } = frontmatter(text);
    const name = (meta.name || d.name).slice(0, 100);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: clip(meta.description || firstLine(body), 120), source });
  }
}

// -> [{ name, description, source: 'project'|'user'|'project-skill'|'user-skill' }]. Never throws.
function listCommands(cwd, home = os.homedir()) {
  const out = [];
  try {
    const seen = new Set(); // one namespace for commands and skills; project entries come first and win
    if (cwd) collectCommands(path.join(cwd, '.claude', 'commands'), 'project', out, seen);
    if (cwd) collectSkills(path.join(cwd, '.claude', 'skills'), 'project-skill', out, seen);
    if (home) collectCommands(path.join(home, '.claude', 'commands'), 'user', out, seen);
    if (home) collectSkills(path.join(home, '.claude', 'skills'), 'user-skill', out, seen);
  } catch (err) {
    console.warn('[files] commands list failed', err);
  }
  return out;
}

// --- pasted images ------------------------------------------------------------
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const IMAGE_MAX = 20 * 1024 * 1024;
const IMAGE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

// Long path (8.3 names such as C:\Users\USERNA~1 expanded): Claude Code gets a path it can read back.
function pasteDir() {
  let tmp = os.tmpdir();
  try {
    tmp = fs.realpathSync.native(tmp);
  } catch {}
  return path.join(tmp, PASTE_DIR);
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// -> { ok: true, path } | { ok: false, error }. Never throws.
function saveImage(data, ext, dir = pasteDir()) {
  try {
    const e = typeof ext === 'string' ? ext.toLowerCase().replace(/^\./, '') : '';
    if (!IMAGE_EXTS.has(e)) return { ok: false, error: 'unsupported image type' };
    let buf;
    if (Buffer.isBuffer(data)) buf = data;
    else if (data instanceof Uint8Array) buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
    else return { ok: false, error: 'data must be a Uint8Array' };
    if (buf.length === 0) return { ok: false, error: 'empty image' };
    if (buf.length > IMAGE_MAX) return { ok: false, error: 'image larger than 20 MB' };
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `img-${stamp()}-${crypto.randomBytes(3).toString('hex')}.${e}`);
    fs.writeFileSync(file, buf, { flag: 'wx' });
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// Best effort: delete pasted images older than 7 days. -> number of files removed.
function cleanupImages(dir = pasteDir(), now = Date.now()) {
  let n = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name);
      try {
        const st = fs.statSync(f);
        if (st.isFile() && now - st.mtimeMs > IMAGE_KEEP_MS) {
          fs.unlinkSync(f);
          n++;
        }
      } catch {}
    }
  } catch {}
  return n;
}

// Image file -> data: URL for display in the renderer (its CSP allows data: images, not file:).
// Absolute paths of png/jpg/gif/webp files up to 8 MB only; anything else -> null. Never throws.
const READ_IMAGE_MAX = 8 * 1024 * 1024;
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
async function readImageDataUrl(p) {
  try {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
    const mime = IMAGE_MIME[path.extname(p).slice(1).toLowerCase()];
    if (!mime) return null;
    const st = await fs.promises.stat(p);
    if (!st.isFile() || st.size > READ_IMAGE_MAX) return null;
    return `data:${mime};base64,${(await fs.promises.readFile(p)).toString('base64')}`;
  } catch {
    return null;
  }
}

module.exports = { searchFiles, prewarm, rankFiles, listCommands, saveImage, cleanupImages, pasteDir, readImageDataUrl, gitList, gitRecent };
