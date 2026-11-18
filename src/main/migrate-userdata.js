// BN3 (依頼-250, docs/naming.md 3.3): the userData folder moves from <appData>/agent-terminal[-dev] to
// <appData>/bantodesk[-dev] (package.json name / scripts/release.js). On the first start of the new name, when the new
// place holds no app data yet and the old place exists, the old place is COPIED into the new one (the old one is never
// changed or removed: an older version still running keeps using it, and it is the way back).
//
// Rule: the userData folder's own name decides. Its name is bantodesk / bantodesk-dev -> the old place is the sibling
// agent-terminal / agent-terminal-dev (names.USERDATA_LEGACY). Any other name (a test's --user-data-dir such as
// tmp/x/ud) -> nothing happens. A test makes <dir>/agent-terminal-dev + passes --user-data-dir=<dir>/bantodesk-dev.
//
// What is copied: every entry except Chromium's caches and lock files (SKIP). Files already in the new place are kept
// (a copy that stopped half way goes on at the next start: the mark says "copying"). Afterwards:
//  - the absolute old path inside the copied JSON files at the top and in manager/ (sessions.json keys, the ルーター's
//    folder <userData>/manager ...) is replaced with the new path, in the NEW place only;
//  - Claude Code's data of folders inside userData (~/.claude/projects/<encoded cwd>, e.g. the ルーター's conversation in
//    <userData>/manager) is copied to the encoded new cwd, so the ルーター resumes its conversation. Nothing is removed.
// The mark <new userData>/migrated-from.json { state: 'copying' | 'done', from, to, startedAt, at, copied, failed,
// rewritten, claude } records it (shown in docs/naming.md 3.3). EDR: plain file copies by the app's own main process;
// no process is started, no other process is read.
// No Electron imports (tmp/bn3/unit.js runs it from plain Node).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { USERDATA_LEGACY } = require('./names');

const MARK = 'migrated-from.json';
// Chromium's caches and the single-instance lock files: rebuilt by Electron, not worth copying (and locked while the
// old version runs).
const SKIP = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache', 'GrShaderCache', 'GraphiteDawnCache', 'Crashpad', 'blob_storage', 'SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile', 'LOCK', '.DS_Store', MARK]);
// what a start may have made in the new place before the migration runs (still "no app data")
const FRESH_OK = new Set([...SKIP, 'logs']);
const encode = (p) => p.replace(/[^A-Za-z0-9]/g, '-'); // Claude Code's project folder name (tempsessions.js)
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// -> { from, to } | null (not a userData of the new name)
function plan(userData) {
  if (!userData) return null;
  const to = path.resolve(userData);
  const legacy = USERDATA_LEGACY[path.basename(to)];
  if (!legacy) return null;
  return { from: path.join(path.dirname(to), legacy), to };
}

// Files only (symlinks skipped); a file already there is kept. Errors are collected, the rest goes on.
function copyTree(src, dst, failed) {
  let st;
  try {
    st = fs.lstatSync(src);
  } catch (err) {
    failed.push(`${src}: ${err.code || err.message}`);
    return 0;
  }
  if (st.isSymbolicLink() || SKIP.has(path.basename(src))) return 0;
  if (st.isDirectory()) {
    let n = 0;
    try {
      fs.mkdirSync(dst, { recursive: true });
      for (const e of fs.readdirSync(src)) n += copyTree(path.join(src, e), path.join(dst, e), failed);
    } catch (err) {
      failed.push(`${src}: ${err.code || err.message}`);
    }
    return n;
  }
  if (!st.isFile()) return 0;
  try {
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    try {
      fs.utimesSync(dst, st.atime, st.mtime);
    } catch {}
    return 1;
  } catch (err) {
    if (err.code !== 'EEXIST') failed.push(`${src}: ${err.code || err.message}`);
    return 0;
  }
}

// The old absolute path -> the new one in text (raw, lower case as sessions.json keys, JSON-escaped backslashes),
// only where a separator or the string's end follows (agent-terminal is not taken out of agent-terminal-dev).
function rewriteText(text, from, to) {
  let out = text;
  const pairs = [[from, to]];
  if (from.toLowerCase() !== from) pairs.push([from.toLowerCase(), to.toLowerCase()]);
  for (const [a, b] of pairs) {
    for (const [x, y] of [[a, b], [JSON.stringify(a).slice(1, -1), JSON.stringify(b).slice(1, -1)]]) {
      out = out.replace(new RegExp(reEscape(x) + '(?=[\\\\/"]|$)', 'gm'), () => y);
    }
  }
  return out;
}

function rewriteJsonFiles(to, from, failed) {
  const done = [];
  for (const dir of [to, path.join(to, 'manager')]) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/\.json$/i.test(n) || n === MARK) continue;
      const f = path.join(dir, n);
      try {
        const st = fs.statSync(f);
        if (!st.isFile() || st.size > 32 * 1024 * 1024) continue;
        const text = fs.readFileSync(f, 'utf8');
        const next = rewriteText(text, from, to);
        if (next === text) continue;
        fs.writeFileSync(f + '.bn3tmp', next);
        fs.renameSync(f + '.bn3tmp', f);
        done.push(path.relative(to, f));
      } catch (err) {
        failed.push(`${f}: ${err.code || err.message}`);
      }
    }
  }
  return done;
}

// Folders in the old userData (2 levels, not the caches) whose Claude Code data (projects/<encoded>) is copied to the
// encoded new folder.
function copyClaudeProjects(from, to, claudeHome, failed) {
  const projects = path.join(claudeHome, 'projects');
  if (!isDir(projects)) return [];
  const dirs = [from];
  const walk = (d, depth) => {
    let names = [];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      dirs.push(path.join(d, e.name));
      if (depth < 2) walk(path.join(d, e.name), depth + 1);
    }
  };
  walk(from, 1);
  const out = [];
  for (const d of dirs) {
    const src = path.join(projects, encode(d));
    if (!isDir(src)) continue;
    const dst = path.join(projects, encode(path.join(to, path.relative(from, d))));
    if (fs.existsSync(dst)) continue;
    copyTree(src, dst, failed);
    out.push(path.basename(dst));
  }
  return out;
}

// opts: { userData, claudeHome? (~/.claude), now?, log? } -> { migrated: boolean, reason?, mark? }
function migrate(opts) {
  const log = opts.log || (() => {});
  const p = plan(opts.userData);
  if (!p) return { migrated: false, reason: 'not a userData of the new name' };
  const { from, to } = p;
  if (!isDir(from)) return { migrated: false, reason: 'no old place' };
  const markFile = path.join(to, MARK);
  const prev = readJson(markFile);
  if (prev && prev.state === 'done') return { migrated: false, reason: 'already migrated', mark: prev };
  if (!prev) {
    let entries = [];
    try {
      entries = fs.readdirSync(to);
    } catch {}
    const own = entries.filter((n) => !FRESH_OK.has(n));
    if (own.length) return { migrated: false, reason: `the new place already has data (${own.slice(0, 3).join(', ')})` };
  }
  const now = opts.now || (() => new Date().toISOString());
  const mark = { state: 'copying', from, to, startedAt: (prev && prev.startedAt) || now() };
  const writeMark = () => {
    fs.writeFileSync(markFile + '.tmp', JSON.stringify(mark, null, 1) + '\n');
    fs.renameSync(markFile + '.tmp', markFile);
  };
  try {
    fs.mkdirSync(to, { recursive: true });
    writeMark();
  } catch (err) {
    return { migrated: false, reason: `cannot write the new place: ${err.code || err.message}` };
  }
  const failed = [];
  const copied = [];
  let files = 0;
  for (const n of fs.readdirSync(from)) {
    if (SKIP.has(n)) continue;
    files += copyTree(path.join(from, n), path.join(to, n), failed);
    copied.push(n);
  }
  const rewritten = rewriteJsonFiles(to, from, failed);
  const claude = copyClaudeProjects(from, to, opts.claudeHome || path.join(os.homedir(), '.claude'), failed);
  Object.assign(mark, { state: 'done', at: now(), files, copied, rewritten, claude, failed: failed.slice(0, 50) });
  try {
    writeMark();
  } catch {}
  log(`[migrate] ${from} -> ${to}: ${files} files, ${rewritten.length} json rewritten, ${claude.length} claude projects, ${failed.length} failed`);
  return { migrated: true, mark };
}

module.exports = { MARK, SKIP, plan, migrate, rewriteText, encode };
