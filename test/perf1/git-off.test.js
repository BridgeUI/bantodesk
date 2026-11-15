// docs/perf.md 5: git runs through offthread's execFileOff (worker thread) in files.js / git.js / fileedit.js.
// Checks that execFileOff (with and without the `split` option) and the changed functions return what the old
// main-thread execFile versions returned: a git folder, a folder without git, timeout, maxBuffer overflow.
// Only git is started. Run: node tmp/perf1/git-off.test.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const M = (n) => require(path.join(ROOT, 'src', 'main', n));
const { execFileOff } = M('offthread');
const files = M('files');
const gitm = M('git');
const fileedit = M('fileedit');

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log('ok   ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e));
  }
}

// --- the old implementations (main-thread execFile), copied from before the change ---------------------------
const oldFilesGit = (cwd, args, maxBuffer = 64 * 1024 * 1024) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer, timeout: 5000 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
async function oldGitList(cwd) {
  const out = await oldFilesGit(cwd, ['ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard']);
  if (out === null) return null;
  const seen = new Set();
  const untracked = [];
  for (const rec of out.split('\0')) {
    if (rec.length < 3) continue;
    const f = rec.slice(2);
    if (seen.has(f)) continue;
    seen.add(f);
    if (rec[0] === '?') untracked.push(f);
    if (seen.size >= 100000) break;
  }
  return { files: [...seen], untracked };
}
async function oldGitRecent(cwd) {
  const out = await oldFilesGit(cwd, ['-c', 'core.quotepath=off', 'log', '--relative', '--name-only', '--pretty=format:', '-n', '30'], 8 * 1024 * 1024);
  if (out === null) return [];
  const seen = new Set();
  for (const l of out.split(/\r?\n/)) if (l.trim()) seen.add(l.trim().replace(/^"|"$/g, ''));
  return [...seen];
}
// old execFile result shaped like execFileOff's, to compare the two directly
const oldShape = (file, args, opts) =>
  new Promise((resolve) =>
    execFile(file, args, opts, (err, stdout, stderr) =>
      resolve({ err: err ? { message: err.message, code: err.code, killed: !!err.killed } : null, stdout: String(stdout), stderr: String(stderr) }),
    ),
  );

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'at-gitoff-'));
const noGit = path.join(tmpRoot, 'plain');
const repo = path.join(tmpRoot, 'repo');
fs.mkdirSync(noGit);
fs.mkdirSync(repo);
fs.writeFileSync(path.join(noGit, 'a.txt'), 'a\n');

const run = (cwd, args) =>
  new Promise((resolve, reject) => execFile('git', args, { cwd, windowsHide: true, timeout: 15000 }, (e, so) => (e ? reject(e) : resolve(so))));

(async () => {
  // a small repo of our own: committed, changed, untracked and a name with non-ASCII characters
  await run(repo, ['init', '-q']);
  await run(repo, ['config', 'user.email', 'test@example.invalid']);
  await run(repo, ['config', 'user.name', 'test']);
  await run(repo, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(repo, 'one.txt'), 'one\n');
  fs.mkdirSync(path.join(repo, 'sub'));
  fs.writeFileSync(path.join(repo, 'sub', 'ふたつ.txt'), 'two\n');
  await run(repo, ['add', '.']);
  await run(repo, ['commit', '-q', '-m', 'first']);
  fs.writeFileSync(path.join(repo, 'one.txt'), 'one\nmore\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new 1\nnew 2\n');

  // --- execFileOff ----------------------------------------------------------------------------------------------
  await t('execFileOff: same result as execFile (git --version)', async () => {
    const opts = { cwd: repo, windowsHide: true, timeout: 15000 };
    assert.deepStrictEqual(await execFileOff('git', ['--version'], opts), await oldShape('git', ['--version'], opts));
  });
  await t('execFileOff: no 4th argument -> no `lines` key (existing callers unchanged)', async () => {
    const r = await execFileOff('git', ['--version'], { windowsHide: true });
    assert.deepStrictEqual(Object.keys(r).sort(), ['err', 'stderr', 'stdout']);
  });
  await t('execFileOff: error in a folder without git matches execFile (code 128)', async () => {
    const opts = { cwd: noGit, windowsHide: true, timeout: 15000 };
    const a = await execFileOff('git', ['rev-parse', '--is-inside-work-tree'], opts);
    const b = await oldShape('git', ['rev-parse', '--is-inside-work-tree'], opts);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a.err.code, 128);
  });
  await t('execFileOff: split "\\0" gives the same parts as stdout.split on main', async () => {
    const args = ['ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard'];
    const opts = { cwd: ROOT, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 15000 };
    const a = await execFileOff('git', args, opts, { split: '\0' });
    const b = await oldShape('git', args, opts);
    assert.strictEqual(a.err, null);
    assert.strictEqual(a.stdout, '');
    assert.deepStrictEqual(a.lines, b.stdout.split('\0'));
    assert.ok(a.lines.length > 50);
  });
  await t('execFileOff: split { re } (regexp source) splits on \\r?\\n', async () => {
    const r = await execFileOff('git', ['log', '--name-only', '--pretty=format:', '-n', '1'], { cwd: repo, windowsHide: true }, { split: { re: '\\r?\\n' } });
    assert.strictEqual(r.err, null);
    assert.ok(r.lines.includes('one.txt'), JSON.stringify(r.lines));
  });
  await t('execFileOff: timeout -> err.killed, like execFile', async () => {
    // git log -p over this repository's whole history takes far more than 1 ms
    const opts = { cwd: ROOT, windowsHide: true, timeout: 1, maxBuffer: 256 * 1024 * 1024 };
    const a = await execFileOff('git', ['log', '-p'], opts);
    const b = await oldShape('git', ['log', '-p'], opts);
    assert.ok(a.err && a.err.killed, JSON.stringify(a.err));
    assert.strictEqual(a.err.killed, b.err.killed);
    assert.strictEqual(a.err.code, b.err.code);
  });
  await t('execFileOff: maxBuffer overflow -> same err.code as execFile', async () => {
    const opts = { cwd: ROOT, windowsHide: true, timeout: 15000, maxBuffer: 64 };
    const a = await execFileOff('git', ['ls-files'], opts, { split: '\n' });
    const b = await oldShape('git', ['ls-files'], opts);
    assert.ok(a.err, 'expected an error');
    assert.strictEqual(a.err.code, b.err.code);
    assert.strictEqual(a.err.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  });
  await t('execFileOff: a missing program -> ENOENT, never rejects', async () => {
    const r = await execFileOff('git-does-not-exist-x', [], { windowsHide: true });
    assert.strictEqual(r.err.code, 'ENOENT');
  });
  await t('execFileOff: 8 calls in parallel all come back with their own result', async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => execFileOff('git', ['rev-parse', '--is-inside-work-tree'], { cwd: i % 2 ? repo : noGit, windowsHide: true })));
    rs.forEach((r, i) => (i % 2 ? assert.strictEqual(r.stdout.trim(), 'true') : assert.strictEqual(r.err.code, 128)));
  });

  // --- files.js (gitList / gitRecent via listFiles' internals) --------------------------------------------------
  await t('files.js: git folder -> gitList / gitRecent same as before', async () => {
    const g = await files.gitList(repo);
    assert.deepStrictEqual(g, await oldGitList(repo));
    assert.deepStrictEqual(g.untracked, ['new.txt']);
    assert.strictEqual(g.files.length, 3);
    const r = await files.gitRecent(repo);
    assert.deepStrictEqual(r, await oldGitRecent(repo));
    assert.strictEqual(r.length, 2);
  });
  await t('files.js: this repository -> gitList / gitRecent same as before', async () => {
    const g = await files.gitList(ROOT);
    assert.deepStrictEqual(g, await oldGitList(ROOT));
    assert.ok(g.files.length > 50);
    assert.deepStrictEqual(await files.gitRecent(ROOT), await oldGitRecent(ROOT));
  });
  await t('files.js: folder without git -> gitList null, gitRecent [] (as before)', async () => {
    assert.strictEqual(await oldGitList(noGit), null);
    assert.strictEqual(await files.gitList(noGit), null);
    assert.deepStrictEqual(await oldGitRecent(noGit), []);
    assert.deepStrictEqual(await files.gitRecent(noGit), []);
  });
  await t('files.js: searchFiles in a git folder still lists through gitList', async () => {
    const r = await files.searchFiles(repo, 'one');
    assert.ok(JSON.stringify(r).includes('one.txt'), JSON.stringify(r));
  });

  // --- git.js (isGit / gitDiff) ---------------------------------------------------------------------------------
  await t('git.js: isGit true / false', async () => {
    assert.strictEqual(await gitm.isGit(repo), true);
    assert.strictEqual(await gitm.isGit(noGit), false);
  });
  await t('git.js: gitDiff of a changed tracked file', async () => {
    const r = await gitm.gitDiff(repo, { file: 'one.txt' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.isGit, true);
    assert.strictEqual(r.untracked, false);
    assert.ok(/^\+more$/m.test(r.diff), r.diff);
  });
  await t('git.js: gitDiff of an untracked file -> synthetic diff', async () => {
    const r = await gitm.gitDiff(repo, { file: 'new.txt' });
    assert.deepStrictEqual([r.ok, r.isGit, r.untracked], [true, true, true]);
    assert.ok(r.diff.includes('+new 2'), r.diff);
  });
  await t('git.js: gitDiff of an unchanged file -> empty diff', async () => {
    const r = await gitm.gitDiff(repo, { file: path.join('sub', 'ふたつ.txt') });
    assert.deepStrictEqual(r, { ok: true, isGit: true, diff: '', untracked: false });
  });
  await t('git.js: gitDiff in a folder without git -> isGit false', async () => {
    assert.deepStrictEqual(await gitm.gitDiff(noGit, { file: 'a.txt' }), { ok: false, isGit: false, diff: '', untracked: false });
  });
  await t('git.js: gitDiff in a repo without HEAD -> working diff, no error', async () => {
    const fresh = path.join(tmpRoot, 'fresh');
    fs.mkdirSync(fresh);
    await run(fresh, ['init', '-q']);
    fs.writeFileSync(path.join(fresh, 'x.txt'), 'x\n');
    await run(fresh, ['add', 'x.txt']);
    const r = await gitm.gitDiff(fresh, { file: 'x.txt' });
    assert.deepStrictEqual(r, { ok: true, isGit: true, diff: '', untracked: false });
  });

  // --- fileedit.js (diff: git diff --no-index) ------------------------------------------------------------------
  await t('fileedit.js: diff of a changed text file (exit 1) -> text diff', async () => {
    const src = path.join(tmpRoot, 'orig.txt');
    fs.writeFileSync(src, 'alpha\nbeta\n');
    const dir = path.join(tmpRoot, 'edit1');
    fs.mkdirSync(dir);
    await fileedit.importFile(src, dir);
    fs.writeFileSync(path.join(dir, 'orig.txt'), 'alpha\ngamma\n');
    const d = await fileedit.diff(dir);
    assert.strictEqual(d.kind, 'text');
    assert.strictEqual(d.changed, true);
    assert.ok(/^-beta$/m.test(d.diff) && /^\+gamma$/m.test(d.diff), d.diff);
    assert.ok(d.diff.includes('a/.bantodesk/base/orig.txt'), d.diff);
  });
  await t('fileedit.js: diff of an unchanged text file (exit 0) -> empty text diff', async () => {
    const src = path.join(tmpRoot, 'same.txt');
    fs.writeFileSync(src, 'same\n');
    const dir = path.join(tmpRoot, 'edit2');
    fs.mkdirSync(dir);
    await fileedit.importFile(src, dir);
    assert.deepStrictEqual(await fileedit.diff(dir), { kind: 'text', changed: false, diff: '' });
  });
  await t('fileedit.js: diff with the base file missing -> same as the old exit-code rule', async () => {
    const src = path.join(tmpRoot, 'gone.txt');
    fs.writeFileSync(src, 'g\n');
    const dir = path.join(tmpRoot, 'edit3');
    fs.mkdirSync(dir);
    await fileedit.importFile(src, dir);
    fs.rmSync(path.join(dir, '.bantodesk', 'base'), { recursive: true, force: true });
    // old rule: err && err.code !== 1 -> binary, else text with stdout
    const old = await oldShape('git', ['diff', '--no-index', '--no-color', '--', '.bantodesk/base/gone.txt', 'gone.txt'], { cwd: dir, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    const d = await fileedit.diff(dir);
    if (old.err && old.err.code !== 1) assert.strictEqual(d.kind, 'binary');
    else assert.deepStrictEqual([d.kind, d.diff], ['text', old.stdout]);
  });

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('FAIL setup', e);
  process.exit(1);
});
