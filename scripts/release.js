// Release a committed version of this repo into a sibling "agent_terminal_stable" folder that you
// can use while continuing to edit this one. Run with: npm run release
//
// The source is a commit (default HEAD), not the working tree, so release works while the working
// tree is dirty; uncommitted changes are listed and left out.
//
//   node scripts/release.js [--commit <rev>] [--target <dir>] [--no-deps] [--force]
//
// Also runs as ELECTRON_RUN_AS_NODE=1 <electron.exe> scripts/release.js (the app spawns it with
// process.execPath). Uses only node built-ins plus git.
//
// The target may be the running stable app (it holds src/main/native/*.node loaded and cannot have them
// deleted or overwritten). So the copy never leaves the target half-written:
//   1. the commit's files are read from git (cat-file, no tar, nothing written to %TEMP%) and every file that
//      is new or different is staged under <target>/.release-work-*/new (same volume, nothing executed);
//      files with the same bytes are not touched at all (a loaded .node that did not change stays as it is);
//   2. file by file, the old file is moved aside to .release-work-*/old (rename works for a loaded .node,
//      delete/overwrite does not) and the staged file is moved in; files no longer in the commit are moved aside;
//   3. on any error every step is undone in reverse order, so the target keeps the previous release.
// node_modules (robocopy, best effort) and RELEASE.json (last) follow only after the swap succeeded.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const defaultTarget = path.resolve(root, '..', 'agent_terminal_stable');
// Paths taken from the commit. src and docs/prompts mirror the commit in the target (files not in it are removed).
const PATHS = ['src', 'docs/prompts', 'package.json', 'package-lock.json'];
const MIRROR_DIRS = ['src', 'docs/prompts'];
const WORK_PREFIX = '.release-work';

function git(args, { raw = false, ...opts } = {}) {
  // core.autocrlf=false: files come out exactly as committed (same bytes as `git show <rev>:<path>`).
  // raw: return a Buffer (no encoding option at all: older Electron's node rejects encoding 'buffer').
  const o = { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 512 * 1024 * 1024, ...opts };
  if (!raw) o.encoding = 'utf8';
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], o);
}

// The commit's blobs under `paths` -> Map(rel path with '/', Buffer), read with one `git cat-file --batch`.
function readTree(sha, paths, repo) {
  const entries = git(['ls-tree', '-r', '-z', sha, '--', ...paths], { cwd: repo }).split('\0').filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const [mode, type, obj] = line.slice(0, tab).split(' ');
      return { mode, type, obj, rel: line.slice(tab + 1) };
    })
    .filter((e) => e.type === 'blob' && e.mode !== '120000');
  const files = new Map();
  if (!entries.length) return files;
  const out = git(['cat-file', '--batch'], {
    cwd: repo, raw: true, input: entries.map((e) => e.obj).join('\n') + '\n', stdio: ['pipe', 'pipe', 'pipe'],
  });
  let pos = 0;
  for (const e of entries) {
    const nl = out.indexOf(0x0a, pos);
    const header = out.slice(pos, nl).toString('utf8').split(' ');
    if (header[0] !== e.obj || header[1] !== 'blob') throw new Error(`git cat-file: 予期しない出力 (${e.rel})`);
    const size = Number(header[2]);
    files.set(e.rel, out.slice(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return files;
}

function listFiles(dir, rel, acc = []) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of list) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory() && !e.isSymbolicLink()) listFiles(path.join(dir, e.name), r, acc);
    else acc.push(r);
  }
  return acc;
}

function sameBytes(file, buf) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size === buf.length && fs.readFileSync(file).equals(buf);
  } catch { return false; }
}

// Remove leftovers of earlier runs (best effort: an old .node moved aside stays while the old app has it loaded),
// then make a fresh work folder inside the target (same volume, so the swap is plain renames).
function makeWorkDir(target) {
  for (const name of fs.readdirSync(target)) {
    if (name.startsWith(WORK_PREFIX)) {
      try { fs.rmSync(path.join(target, name), { recursive: true, force: true }); } catch {}
    }
  }
  let work = path.join(target, WORK_PREFIX);
  if (fs.existsSync(work)) work = path.join(target, `${WORK_PREFIX}-${Date.now().toString(36)}`);
  fs.mkdirSync(path.join(work, 'new'), { recursive: true });
  fs.mkdirSync(path.join(work, 'old'), { recursive: true });
  return work;
}

function pruneEmptyDirs(dir, keep) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of list) if (e.isDirectory() && !e.isSymbolicLink()) pruneEmptyDirs(path.join(dir, e.name), false);
  if (!keep) { try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch {} }
}

// Make the target's files equal `desired` (Map rel -> Buffer) and remove files under MIRROR_DIRS that are not
// in it, without ever leaving a half-written target: see the header. Throws after undoing on failure.
// `failAfter` (tests only): throw after that many swap steps, to exercise the undo.
function swapIn(target, desired, { log, failAfter } = {}) {
  const abs = (rel) => path.join(target, ...rel.split('/'));
  const writes = [...desired.keys()].filter((rel) => !sameBytes(abs(rel), desired.get(rel)));
  const removes = MIRROR_DIRS.flatMap((d) => listFiles(abs(d), d)).filter((rel) => !desired.has(rel));
  const unchanged = desired.size - writes.length;
  if (!writes.length && !removes.length) return { writes: 0, removes: 0, unchanged, work: null };

  const work = makeWorkDir(target);
  const inWork = (side, rel) => path.join(work, side, ...rel.split('/'));
  // 1. stage (the target is not touched yet)
  try {
    for (const rel of writes) {
      fs.mkdirSync(path.dirname(inWork('new', rel)), { recursive: true });
      fs.writeFileSync(inWork('new', rel), desired.get(rel));
    }
  } catch (e) {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    throw new Error(`新しい中身を用意できませんでした（stable は変えていません）: ${e.message}`);
  }

  // 2. swap, with a journal for the undo
  const journal = [];
  let steps = 0;
  const step = () => { if (failAfter != null && ++steps > failAfter) throw new Error(`test: failAfter ${failAfter}`); };
  const moveAside = (rel) => {
    if (!fs.existsSync(abs(rel))) return;
    fs.mkdirSync(path.dirname(inWork('old', rel)), { recursive: true });
    fs.renameSync(abs(rel), inWork('old', rel));
    journal.push({ kind: 'aside', rel });
  };
  try {
    for (const rel of writes) {
      step();
      moveAside(rel);
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      fs.renameSync(inWork('new', rel), abs(rel));
      journal.push({ kind: 'placed', rel });
    }
    for (const rel of removes) {
      step();
      moveAside(rel);
    }
  } catch (e) {
    // 3. undo in reverse order
    const notUndone = [];
    for (const j of journal.reverse()) {
      try {
        if (j.kind === 'placed') fs.rmSync(abs(j.rel), { force: true });
        else {
          fs.mkdirSync(path.dirname(abs(j.rel)), { recursive: true });
          fs.renameSync(inWork('old', j.rel), abs(j.rel));
        }
      } catch { notUndone.push(j.rel); }
    }
    for (const d of MIRROR_DIRS) pruneEmptyDirs(abs(d), true);
    if (!notUndone.length) { try { fs.rmSync(work, { recursive: true, force: true }); } catch {} }
    throw new Error(notUndone.length
      ? `入れ替えに失敗し、元に戻せないファイルがあります（${work} の old に前の中身）: ${notUndone.join(', ')}: ${e.message}`
      : `入れ替えに失敗したので前の中身に戻しました: ${e.message}`);
  }

  for (const d of MIRROR_DIRS) pruneEmptyDirs(abs(d), true);
  let leftover = false;
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { leftover = true; }
  if (leftover && log) log(`メモ: ${path.basename(work)} に読み込み中のファイルが残りました（次の release で片づけます）。`);
  return { writes: writes.length, removes: removes.length, unchanged, work: leftover ? work : null };
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Is this executable the image of a running process? Windows refuses to open a running image for writing
// (EBUSY = sharing violation). The file is opened and closed again, nothing is written, no process is started
// or listed (the maintainers' test notes: why not a process list).
function imageInUse(exe) {
  let fd;
  try { fd = fs.openSync(exe, 'r+'); } catch (e) { return e.code === 'EBUSY'; }
  try { fs.closeSync(fd); } catch {}
  return false;
}

// `exe` (tests): the file to check instead of the target's electron.exe.
function warnIfStableRunning(target, log, exe = path.join(target, 'node_modules', 'electron', 'dist', 'electron.exe')) {
  // A running stable instance keeps its old main process; windows it opens later would mix old
  // main/preload with new renderer files. Tell the user rather than silently risking that.
  if (!imageInUse(exe)) return false;
  log('WARNING: the stable app is currently running. Files are replaced anyway;');
  log('it restarts by itself once its sessions are idle (or close all stable windows and start it again).\n');
  return true;
}

function launcherText() {
  // Launcher: `agent-terminal.cmd [folder]`, `agent-terminal.cmd --temp` (temporary session),
  // `agent-terminal.cmd --edit <file>` (edit mode; a file given without --edit works too).
  // Without a folder the app shows its folder picker.
  return [
    '@echo off',
    'setlocal',
    'set "WD="',
    'set "SW="',
    'if /i "%~1"=="--temp" set "SW=--temp"',
    'if /i "%~1"=="--temp" goto launch',
    'if /i "%~1"=="--edit" set "SW=--edit"',
    'if /i "%~1"=="--edit" shift',
    'if "%~1"=="" goto launch',
    'for %%I in ("%~1") do set "WD=%%~fI"',
    'if "%WD:~-1%"=="\\" set "WD=%WD%."',
    ':launch',
    'cd /d "%~dp0"',
    'if not defined WD goto nofolder',
    'start "" "%~dp0node_modules\\electron\\dist\\electron.exe" . %SW% "%WD%"',
    'goto :eof',
    ':nofolder',
    'start "" "%~dp0node_modules\\electron\\dist\\electron.exe" . %SW%',
    '',
  ].join('\r\n');
}

// macOS / Linux launcher: `sh agent-terminal.sh [folder | --temp | --edit <file>]` (same arguments as the .cmd).
function posixLauncherText() {
  return [
    '#!/bin/sh',
    'cd "$(dirname "$0")" || exit 1',
    'if [ "$1" = "--temp" ] || [ "$1" = "" ]; then',
    '  nohup ./node_modules/.bin/electron . "$@" >/dev/null 2>&1 &',
    'else',
    '  SW=""',
    '  if [ "$1" = "--edit" ]; then SW="--edit"; shift; fi',
    '  WD="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"',
    '  nohup ./node_modules/.bin/electron . $SW "$WD" >/dev/null 2>&1 &',
    'fi',
    '',
  ].join('\n');
}

// `repo` and `failAfter` are for tests (a throwaway repo, and a forced failure in the middle of the swap).
function release({ commit = 'HEAD', target, noDeps = false, force = false, log = console.log, repo = root, failAfter } = {}) {
  const isDefaultTarget = !target;
  target = path.resolve(target || defaultTarget);
  const g = (args, opts = {}) => git(args, { cwd: repo, ...opts });

  let sha;
  try {
    sha = g(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]).trim();
  } catch {
    throw new Error(`commit が見つかりません: ${commit}`);
  }
  if (!sha) throw new Error(`commit が見つかりません: ${commit}`);
  const shortSha = sha.slice(0, 8);
  const commitSubject = g(['log', '-1', '--format=%s', sha]).trim();

  const prev = readJson(path.join(target, 'RELEASE.json'));
  if (!force && prev && prev.commit === sha) {
    log(`この commit は release 済みです (${shortSha} ${commitSubject})。やり直すときは --force を付けてください。`);
    return { ok: true, skipped: true, commit: sha, build: prev.build, target, uncommitted: [] };
  }

  // Uncommitted changes under the released paths (they are not part of this release).
  const uncommitted = g(['status', '--porcelain', '--untracked-files=all', '--', ...PATHS])
    .split(/\r?\n/).filter(Boolean);
  const headSha = g(['rev-parse', 'HEAD']).trim();
  if (uncommitted.length) {
    log('次の変更はコミットされていないので、この release には入りません:');
    for (const l of uncommitted) log(`  ${l}`);
    log('');
  }
  if (sha !== headSha) {
    const later = g(['log', '--oneline', `${sha}..HEAD`, '--', ...PATHS]).split(/\r?\n/).filter(Boolean);
    if (later.length) {
      log(`次のコミットは ${shortSha} より後なので、この release には入りません:`);
      for (const l of later) log(`  ${l}`);
      log('');
    }
  }

  if (isDefaultTarget) warnIfStableRunning(target, log);

  // The commit's files (src, docs/prompts: prompt wording read at each claude start, package.json, lock).
  const desired = readTree(sha, PATHS, repo);
  for (const need of ['src/main.js', 'package.json']) {
    if (!desired.has(need)) throw new Error(`${shortSha} に ${need} がありません`);
  }
  // Manifest: same dependencies, but the released app name (separate settings and instance lock).
  const pkg = JSON.parse(desired.get('package.json').toString('utf8'));
  const stablePkg = { ...pkg, name: 'bantodesk', scripts: { start: 'electron .' } };
  desired.set('package.json', Buffer.from(JSON.stringify(stablePkg, null, 2) + '\n'));
  desired.set('agent-terminal.cmd', Buffer.from(launcherText()));
  desired.set('agent-terminal.sh', Buffer.from(posixLauncherText()));

  fs.mkdirSync(target, { recursive: true });
  // All or nothing: on failure the target keeps the previous release (and RELEASE.json is not written).
  const swap = swapIn(target, desired, { log, failAfter });
  log(`files: 書き換え ${swap.writes}・削除 ${swap.removes}・同じなので触らない ${swap.unchanged}`);

  // Dependencies: copy the already-working node_modules (incremental) instead of reinstalling,
  // so the released copy uses the exact Electron/node-pty binaries that were tested. Skipped when
  // the target's node_modules is a junction/symlink (test copies point at the dev node_modules).
  const targetModules = path.join(target, 'node_modules');
  if (noDeps) {
    log('node_modules: --no-deps のため更新しません。');
  } else if (isLink(targetModules)) {
    log('node_modules: リンク (junction) なので更新しません。');
  } else if (process.platform !== 'win32') {
    // macOS / Linux: rsync keeps the executable bits and the .bin symlinks; a running app's open files can be replaced.
    try {
      execFileSync('rsync', ['-a', '--delete', path.join(repo, 'node_modules') + '/', targetModules + '/'], { stdio: 'inherit' });
    } catch (e) {
      log(`WARNING: rsync failed (exit ${e.status}). Run \`npm run release -- --force\` again if dependencies changed.\n`);
    }
  } else {
    try {
      // /R:2 /W:2: files held open by a running stable instance (electron.exe, node-pty's .node)
      // would otherwise be retried with robocopy's default 1,000,000 x 30 s, i.e. hang forever.
      execFileSync('robocopy', [path.join(repo, 'node_modules'), targetModules, '/MIR', '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/MT:16'], { stdio: 'inherit', windowsHide: true });
    } catch (e) {
      if (!(e.status < 8)) {
        // 8+ = some files could not be copied (typically locked by the running stable app).
        log(`WARNING: robocopy reported failures (exit ${e.status}). Files locked by a running stable app were`);
        log('not replaced. Close the stable app and run `npm run release` again if dependencies changed.\n');
      }
    }
  }

  // Written last: a running stable app watches this file and restarts when `build` changes.
  const build = `${shortSha}-${Date.now().toString(36)}`;
  const info = {
    released: new Date().toISOString(),
    build,
    commit: sha,
    commitSubject,
    from: repo,
    version: pkg.version,
  };
  fs.writeFileSync(path.join(target, 'RELEASE.json'), JSON.stringify(info, null, 2) + '\n');

  log(`Released ${shortSha} (${commitSubject}) to ${target}`);
  log('A running stable app restarts by itself once its sessions are idle (tabs come back with --resume).');
  return { ok: true, commit: sha, build, target, uncommitted: uncommitted.map((l) => l.trim()) };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') opts.commit = argv[++i];
    else if (a === '--target') opts.target = argv[++i];
    else if (a === '--no-deps') opts.noDeps = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--json') opts.json = true;
    else throw new Error(`unknown argument: ${a}`);
    if ((a === '--commit' || a === '--target') && !argv[i]) throw new Error(`${a} needs a value`);
  }
  return opts;
}

module.exports = { release, warnIfStableRunning, imageInUse };

if (require.main === module) {
  // --json: one final line `RELEASE_RESULT <json>` for the app to parse (also on failure).
  const json = process.argv.includes('--json');
  try {
    const result = release(parseArgs(process.argv.slice(2)));
    if (json) console.log(`RELEASE_RESULT ${JSON.stringify(result)}`);
  } catch (e) {
    console.error(`release failed: ${e.message}`);
    if (json) console.log(`RELEASE_RESULT ${JSON.stringify({ ok: false, error: e.message })}`);
    process.exitCode = 1;
  }
}
