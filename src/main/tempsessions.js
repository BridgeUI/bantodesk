// Temporary sessions (roadmap 9) and file edit sessions (roadmap 19): folders the app creates under
// <realpath(tmpdir)>\bantodesk-temp (BN3; folders under the former <tmp>\agent-terminal-temp are still known), recorded in a ledger (userData/temp-sessions.json) so that only
// folders THIS app instance made are ever deleted (stable and dev have different userData).
// No Electron imports (testable from plain Node). Plans: docs/plan-temp-widget.md 9, docs/plan-temp-edit.md.
//
// Ledger entry: { dir, kind: 'temp'|'edit', state: 'open'|'kept', sessionIds: string[], tabs: SavedTab[],
//                 createdAt, original?: string }
const fs = require('fs');
const os = require('os');
const path = require('path');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const norm = (p) => path.resolve(p).toLowerCase();
const encode = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const { TEMP_DIR, LEGACY_TEMP_DIR } = require('./names');

function tmpRoot(name) {
  let t = os.tmpdir();
  try {
    t = fs.realpathSync.native(t); // 8.3 short names -> the long path Claude Code records as cwd
  } catch {}
  return path.join(t, name);
}
const defaultRoot = () => tmpRoot(TEMP_DIR);
// BN3 compat: ledger entries (kept edit sessions) in the former root are still listed, reopened and deleted
const defaultLegacyRoot = () => tmpRoot(LEGACY_TEMP_DIR);

// True when p is a direct child folder of root (not root itself, not deeper, no "..").
function isDirectChild(p, root) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep) && !rel.includes('/');
}

// Removes a path without following symlinks / junctions: a link is removed itself, never its target.
// fs.rm does not follow links inside the tree either (it lstat()s), the top level is checked here.
async function rmNoFollow(p, opts = {}) {
  let st;
  try {
    st = await fs.promises.lstat(p);
  } catch (err) {
    if (err && err.code === 'ENOENT') return true;
    throw err;
  }
  if (st.isSymbolicLink()) {
    // A junction / directory symlink: remove the link only.
    try {
      await fs.promises.unlink(p);
    } catch {
      await fs.promises.rmdir(p);
    }
    return true;
  }
  await fs.promises.rm(p, { recursive: true, force: true, maxRetries: opts.maxRetries ?? 10, retryDelay: opts.retryDelay ?? 300 });
  return true;
}

// opts: { file: ledger path, root?: temp root, legacyRoot?: the former root (default: <tmp>/agent-terminal-temp when root is
// not given), claudeHome?: ~/.claude, log? }
function createTempStore(opts) {
  const file = opts.file;
  const rootGiven = opts.root || defaultRoot();
  // canonical (long) path of the root once it exists, so it matches the realpath'd folders
  const canon = () => {
    try {
      return fs.realpathSync.native(rootGiven);
    } catch {
      return rootGiven;
    }
  };
  let root = canon();
  const legacyRoot = opts.legacyRoot !== undefined ? opts.legacyRoot : opts.root ? null : defaultLegacyRoot();
  const inLegacy = (p) => {
    if (!legacyRoot) return false;
    let c = legacyRoot;
    try {
      c = fs.realpathSync.native(legacyRoot);
    } catch {}
    return isDirectChild(p, c) || isDirectChild(p, legacyRoot);
  };
  const inRoot = (p) => isDirectChild(p, canon()) || isDirectChild(p, rootGiven) || inLegacy(p);
  const claudeHome = opts.claudeHome || path.join(os.homedir(), '.claude');
  const log = opts.log || (() => {});
  let entries = load();

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = Array.isArray(j) ? j : Array.isArray(j && j.entries) ? j.entries : [];
      return list
        .filter((e) => e && typeof e.dir === 'string' && inRoot(e.dir))
        .map((e) => ({
          dir: e.dir,
          kind: e.kind === 'edit' ? 'edit' : 'temp',
          state: e.state === 'kept' ? 'kept' : 'open',
          sessionIds: Array.isArray(e.sessionIds) ? e.sessionIds.filter((s) => typeof s === 'string' && UUID_RE.test(s)) : [],
          tabs: Array.isArray(e.tabs) ? e.tabs : [],
          createdAt: Number(e.createdAt) || 0,
          ...(typeof e.original === 'string' ? { original: e.original } : {}),
        }));
    } catch {
      return [];
    }
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 1));
      fs.renameSync(tmp, file);
    } catch (err) {
      log('[temp] ledger save failed', err);
    }
  }
  const find = (dir) => entries.find((e) => norm(e.dir) === norm(dir)) || null;

  // -> entry (dir is the canonical long path)
  function create(kind = 'temp', extra = {}) {
    fs.mkdirSync(rootGiven, { recursive: true });
    root = canon();
    let dir = fs.mkdtempSync(path.join(root, kind === 'edit' ? 'e-' : 't-'));
    try {
      dir = fs.realpathSync.native(dir);
    } catch {}
    const e = { dir, kind: kind === 'edit' ? 'edit' : 'temp', state: 'open', sessionIds: [], tabs: [], createdAt: Date.now(), ...extra };
    entries.push(e);
    save();
    return e;
  }

  function addSession(dir, sid) {
    const e = find(dir);
    if (!e || typeof sid !== 'string' || !UUID_RE.test(sid) || e.sessionIds.includes(sid)) return;
    e.sessionIds.push(sid);
    save();
  }
  function setTabs(dir, tabs) {
    const e = find(dir);
    if (!e || !Array.isArray(tabs)) return;
    e.tabs = tabs.slice(0, 50);
    save();
  }
  function update(dir, patch) {
    const e = find(dir);
    if (!e) return null;
    for (const k of ['state', 'original', 'name']) if (patch && patch[k] !== undefined) e[k] = patch[k];
    save();
    return e;
  }

  // Claude Code data that belongs only to this folder / these sessions.
  function claudePaths(e) {
    const out = [path.join(claudeHome, 'projects', encode(e.dir))];
    for (const sid of e.sessionIds) {
      if (!UUID_RE.test(sid)) continue;
      out.push(path.join(claudeHome, 'file-history', sid));
      out.push(path.join(claudeHome, 'session-env', sid));
      out.push(path.join(claudeHome, 'teams', `session-${sid.slice(0, 8)}`));
      try {
        for (const f of fs.readdirSync(path.join(claudeHome, 'todos'))) {
          if (f.startsWith(`${sid}-`) && f.endsWith('.json')) out.push(path.join(claudeHome, 'todos', f));
        }
      } catch {}
    }
    return out;
  }

  // Deletes the folder and its Claude data. Only for ledger entries whose dir is a direct child of root
  // (double check). On failure the entry stays in the ledger (cleanup() retries at the next start).
  // -> { ok, error? }
  async function remove(dir, rmOpts) {
    const e = find(dir);
    if (!e) return { ok: false, error: 'not in ledger' };
    if (!inRoot(e.dir)) return { ok: false, error: 'outside temp root' };
    let error = null;
    try {
      // The folder itself must not be a link to somewhere else (rmNoFollow would remove only the link).
      await rmNoFollow(e.dir, rmOpts);
    } catch (err) {
      error = String((err && err.code) || err);
    }
    for (const p of claudePaths(e)) {
      try {
        if (fs.existsSync(p)) await rmNoFollow(p, rmOpts);
      } catch (err) {
        log('[temp] could not remove', p, err && err.code);
      }
    }
    if (error && fs.existsSync(e.dir)) {
      log('[temp] could not remove', e.dir, error);
      return { ok: false, error };
    }
    entries = entries.filter((x) => x !== e);
    save();
    return { ok: true };
  }

  // At startup (single instance: nothing of ours is in use): remove every entry except kept ones.
  async function cleanup(rmOpts) {
    const results = [];
    for (const e of [...entries]) {
      if (e.state === 'kept') {
        if (!fs.existsSync(e.dir)) {
          entries = entries.filter((x) => x !== e);
          save();
        }
        continue;
      }
      results.push({ dir: e.dir, ...(await remove(e.dir, rmOpts)) });
    }
    return results;
  }

  return {
    get root() {
      return root;
    },
    inRoot,
    create,
    find,
    list: () => entries.map((e) => ({ ...e })),
    kept: () => entries.filter((e) => e.state === 'kept').map((e) => ({ ...e })),
    isTemp: (dir) => !!find(dir),
    addSession,
    setTabs,
    update,
    remove,
    cleanup,
    claudePaths,
  };
}

module.exports = { createTempStore, defaultRoot, isDirectChild, rmNoFollow, encode };
