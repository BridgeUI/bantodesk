// git helpers + "open in editor". No Electron imports (the openPath fallback is injected).
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { isInside, norm } = require('./sessions');
const { execFileOff } = require('./offthread');

const DIFF_CAP = 200 * 1024;

// On offthread's worker: starting git blocks the calling thread 120-1100 ms on this PC (docs/perf.md #4).
// -> { err: null | { message, code, killed }, stdout, stderr } (never rejects)
function git(cwd, args) {
  return execFileOff('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15000,
    encoding: 'utf8',
  });
}

const gitCache = new Map(); // norm(dir) -> Promise<boolean>
function isGit(dir) {
  const k = norm(dir);
  if (!gitCache.has(k)) {
    gitCache.set(
      k,
      git(dir, ['rev-parse', '--is-inside-work-tree']).then((r) => !r.err && r.stdout.trim() === 'true'),
    );
  }
  return gitCache.get(k);
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const cap = (s) => (s.length > DIFF_CAP ? s.slice(0, DIFF_CAP) + '\n… (diff truncated)\n' : s);

function syntheticDiff(rel, abs) {
  let buf;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    const fd = fs.openSync(abs, 'r');
    try {
      buf = Buffer.alloc(Math.min(st.size, DIFF_CAP));
      fs.readSync(fd, buf, 0, buf.length, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const name = rel.replace(/\\/g, '/');
  const header = `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n`;
  if (buf.includes(0)) return header + 'Binary file (untracked)\n';
  const lines = buf.toString('utf8').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return cap(header + `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => '+' + l).join('\n') + '\n');
}

// { cwd, file } -> { ok, isGit, diff, untracked, error? }
async function gitDiff(workDir, o) {
  const fail = (error, gitFlag = true) => ({ ok: false, isGit: gitFlag, diff: '', untracked: false, error });
  if (!workDir || !o || typeof o.file !== 'string' || !o.file) return fail('bad request', false);
  const cwd = typeof o.cwd === 'string' && o.cwd ? path.resolve(workDir, o.cwd) : workDir;
  if (!isInside(cwd, workDir) || !isDir(cwd)) return fail('cwd outside workDir', false);
  if (!(await isGit(cwd))) return { ok: false, isGit: false, diff: '', untracked: false };
  const abs = path.resolve(cwd, o.file);
  const rel = path.relative(cwd, abs);

  const r = await git(cwd, ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', abs]);
  if (!r.err && r.stdout) return { ok: true, isGit: true, diff: cap(r.stdout), untracked: false };

  // Empty (or failing, e.g. no commits yet): maybe the file is untracked.
  const u = await git(cwd, ['ls-files', '--others', '--exclude-standard', '--', abs]);
  if (!u.err && u.stdout.trim()) {
    const d = syntheticDiff(rel, abs);
    if (d !== null) return { ok: true, isGit: true, diff: d, untracked: true };
  }
  if (r.err) {
    // Repository without HEAD: show the staged/working diff instead.
    const w = await git(cwd, ['diff', '--no-color', '--no-ext-diff', '--', abs]);
    if (!w.err) return { ok: true, isGit: true, diff: cap(w.stdout), untracked: false };
    return fail((r.stderr || String(r.err.message || r.err)).trim().slice(0, 500));
  }
  return { ok: true, isGit: true, diff: '', untracked: false };
}

// Open a file in VS Code; fall back to the OS handler (openPath(p) -> Promise<string error>).
function openInEditor(p, openPath) {
  if (typeof p !== 'string' || !p || !fs.existsSync(p)) return;
  const fallback = () => {
    try {
      Promise.resolve(openPath && openPath(p)).catch(() => {});
    } catch {}
  };
  // shell:true is needed on Windows (code is code.cmd); refuse characters cmd.exe would interpret.
  if (/["%^&|<>!\r\n]/.test(p)) return fallback();
  let done = false;
  const once = (fn) => {
    if (!done) {
      done = true;
      fn();
    }
  };
  try {
    const win = process.platform === 'win32';
    const child = spawn('code', [win ? `"${p}"` : p], {
      shell: win,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => once(fallback));
    child.on('exit', (code) => once(() => code !== 0 && fallback()));
    child.unref();
  } catch {
    fallback();
  }
}

// 見回りの検出 (7) / (5) (src/main/patrol-gaps.js): the number of uncommitted changes (git status --porcelain lines,
// untracked files included) -> number | null (not a repo / git failed). Read only; on offthread's worker like git().
async function uncommittedCount(dir) {
  if (!dir || !(await isGit(dir))) return null;
  const r = await git(dir, ['status', '--porcelain']);
  if (r.err) return null;
  return String(r.stdout || '').split(/\r?\n/).filter((l) => l.trim()).length;
}

module.exports = { isGit, gitDiff, openInEditor, uncommittedCount };
