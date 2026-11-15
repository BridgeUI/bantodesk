// File edit mode (roadmap 19, docs/plan-temp-edit.md): a working copy of one file in a temp folder
// (src/main/tempsessions.js), status of the original (changed / missing / locked) and the write-back.
// No Electron imports (testable from plain Node: tmp/edit/test.js).
//
// Folder layout:
//   CLAUDE.md                    instructions for Claude (never contains the original path)
//   <name>                       working copy (what Claude edits)
//   .bantodesk\edit.json    { original, name, importedAt, base: { mtimeMs, size, sha256 } }
//   .bantodesk\base\<name>  the original as imported / last written back (read-only attribute)
//
// The original is always overwritten IN PLACE (same path opened and written, never a temp file + rename):
// OneDrive / SharePoint would otherwise treat it as another item (version history, share links).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileOff } = require('./offthread');
const pptxDiff = require('./pptxdiff');

const { META_DIR, LEGACY_META_DIR } = require('./names');
// BN3 compat: an edit folder made before the rename (kept with 「残して閉じる」) has .agent-terminal\ — it is used as is
const metaDirOf = (dir) => (!fs.existsSync(path.join(dir, META_DIR)) && fs.existsSync(path.join(dir, LEGACY_META_DIR)) ? LEGACY_META_DIR : META_DIR);
const NAME_MAX = 80;
const IMPORT_TIMEOUT_MS = 60_000;
const BACKUP_DAYS = 30;

function safeName(name) {
  const base = path.basename(String(name || 'file'));
  if (base.length <= NAME_MAX) return base;
  const ext = path.extname(base).slice(0, 20);
  return base.slice(0, NAME_MAX - ext.length) + ext;
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', reject);
    s.on('data', (b) => h.update(b));
    s.on('end', () => resolve(h.digest('hex')));
  });
}
const sha256Buf = (b) => crypto.createHash('sha256').update(b).digest('hex');

const metaFile = (dir) => path.join(dir, metaDirOf(dir), 'edit.json');
const baseFile = (dir, name) => path.join(dir, metaDirOf(dir), 'base', name);

function readMeta(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(metaFile(dir), 'utf8'));
    if (!m || typeof m.original !== 'string' || typeof m.name !== 'string' || !m.base) return null;
    return m;
  } catch {
    return null;
  }
}
function writeMeta(dir, m) {
  const f = metaFile(dir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(m, null, 1));
  fs.renameSync(f + '.tmp', f);
}

const withTimeout = (p, ms, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(Object.assign(new Error(`${what} timed out`), { code: 'ETIMEDOUT' })), ms)))]).finally(() => clearTimeout(t));
};

function claudeMd(name, folderName) {
  return [
    '# 編集モード（BantoDesk）',
    '',
    `このフォルダはファイル 1 つを直すための作業用フォルダです${folderName ? `（元のファイルはフォルダ「${folderName}」にあります）` : ''}。`,
    '',
    `- 直す対象は \`./${name}\` です。直したら **同じ名前で上書き保存** してください。`,
    '- このフォルダの外には何も書かないでください。中間ファイル（Python スクリプト、画像の書き出しなど）もこのフォルダに置きます。',
    '- `.bantodesk` フォルダには触らないでください（元の内容の控えと管理用のファイルです）。',
    '- 元の場所への書き戻しはユーザーがアプリの帯の [書き戻す] で行います。自分で元のファイルを探して書き換えないでください。',
    '- pptx は python-pptx で直します（スキル slide-brushup / consulting-pptx-skill）。docx / xlsx も同様にライブラリで直し、同じ名前で保存します。',
    '- 保存に失敗したら（ファイルが PowerPoint などで開かれている）、ユーザーにそのファイルを閉じるよう頼んでください。',
    '',
  ].join('\n');
}

const sameStat = (a, b) => a && b && a.size === b.size && a.mtimeMs === b.mtimeMs;

// Copies original into dir as the working copy + base. Retries (twice) when the original changes during the
// copy; a cloud-only OneDrive file is downloaded by the copy (timeout opts.timeoutMs, default 60 s).
// -> meta
async function importFile(original, dir, opts = {}) {
  original = path.resolve(original);
  const st0 = await fs.promises.stat(original);
  if (!st0.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOTFILE' });
  const name = safeName(path.basename(original));
  const work = path.join(dir, name);
  let before;
  let after;
  for (let i = 0; i < 3; i++) {
    before = await fs.promises.stat(original);
    await withTimeout(fs.promises.copyFile(original, work), opts.timeoutMs || IMPORT_TIMEOUT_MS, 'import');
    after = await fs.promises.stat(original);
    if (sameStat(before, after)) break;
    if (i === 2) throw Object.assign(new Error('the file kept changing while it was copied'), { code: 'ECHANGING' });
  }
  const sha256 = await sha256File(work);
  const b = baseFile(dir, name);
  fs.mkdirSync(path.dirname(b), { recursive: true });
  await fs.promises.copyFile(work, b);
  try {
    fs.chmodSync(b, 0o444);
  } catch {}
  const meta = { original, name, importedAt: Date.now(), base: { mtimeMs: after.mtimeMs, size: after.size, sha256 } };
  writeMeta(dir, meta);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd(name, path.basename(path.dirname(original))));
  return meta;
}

// Office owner file ("~$name"; Word replaces the first 1-2 characters of longer names).
function officeOwner(file) {
  const dir = path.dirname(file);
  const n = path.basename(file);
  for (const c of [`~$${n}`, `~$${n.slice(1)}`, `~$${n.slice(2)}`]) {
    try {
      if (fs.existsSync(path.join(dir, c))) return true;
    } catch {}
  }
  return false;
}
// true when the file cannot be opened for writing (open in another program, read-only)
function openForWriteFails(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r+');
    return null;
  } catch (err) {
    return err && err.code ? err.code : 'EUNKNOWN';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// -> { state: 'same'|'changed'|'missing'|'locked', lockedBy: 'office'|'busy'|null, stat? }
// deep: always compare the sha256 (write-back); otherwise an unchanged mtime + size counts as the same.
async function originalState(meta, { deep = false } = {}) {
  let st;
  try {
    st = await fs.promises.stat(meta.original);
  } catch {
    return { state: 'missing', lockedBy: null };
  }
  if (!st.isFile()) return { state: 'missing', lockedBy: null };
  if (officeOwner(meta.original)) return { state: 'locked', lockedBy: 'office', stat: st };
  const code = openForWriteFails(meta.original);
  if (code && code !== 'ENOENT') return { state: 'locked', lockedBy: 'busy', stat: st, code };
  if (st.size !== meta.base.size) return { state: 'changed', lockedBy: null, stat: st };
  if (!deep && st.mtimeMs === meta.base.mtimeMs) return { state: 'same', lockedBy: null, stat: st };
  const sha = await sha256File(meta.original);
  return { state: sha === meta.base.sha256 ? 'same' : 'changed', lockedBy: null, stat: st };
}

// sha256 of the working copy, cached by mtime + size (status is polled).
const workCache = new Map();
async function workSha(work) {
  const st = await fs.promises.stat(work);
  const c = workCache.get(work);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.sha;
  const sha = await sha256File(work);
  workCache.set(work, { size: st.size, mtimeMs: st.mtimeMs, sha });
  return sha;
}

// -> EditStatus { original, work, name, workChanged, workMissing, workLocked, originalState, lockedBy } | null
async function status(dir) {
  const meta = readMeta(dir);
  if (!meta) return null;
  const work = path.join(dir, meta.name);
  let workChanged = false;
  let workMissing = false;
  try {
    workChanged = (await workSha(work)) !== meta.base.sha256;
  } catch {
    workMissing = true;
    workChanged = true;
  }
  const workLocked = !workMissing && !!openForWriteFails(work);
  const o = await originalState(meta);
  return { original: meta.original, work, name: meta.name, workChanged, workMissing, workLocked, originalState: o.state, lockedBy: o.lockedBy };
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

// Writes buf into file in place (same file: open r+, write, truncate). Never creates the file.
async function overwriteInPlace(file, buf) {
  const fh = await fs.promises.open(file, 'r+');
  try {
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await fh.write(buf, off, buf.length - off, off);
      off += bytesWritten;
    }
    await fh.truncate(buf.length);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// opts: { force?: boolean (write although the original changed), backupDir, now? }
// -> { ok: true, backup } | { ok: false, reason: 'unchanged'|'changed'|'locked'|'missing'|'failed', lockedBy?, error? }
async function writeBack(dir, opts = {}) {
  const meta = readMeta(dir);
  if (!meta) return { ok: false, reason: 'failed', error: 'not an edit folder' };
  const work = path.join(dir, meta.name);
  let buf;
  try {
    buf = await fs.promises.readFile(work);
  } catch (err) {
    return { ok: false, reason: 'failed', error: `作業用コピーを読めません (${err && err.code})` };
  }
  const newSha = sha256Buf(buf);
  if (newSha === meta.base.sha256) return { ok: false, reason: 'unchanged' };
  const o = await originalState(meta, { deep: true });
  if (o.state === 'missing') return { ok: false, reason: 'missing' };
  if (o.state === 'locked') return { ok: false, reason: 'locked', lockedBy: o.lockedBy };
  if (o.state === 'changed' && !opts.force) return { ok: false, reason: 'changed' };
  // backup of the original as it is now
  let backup = null;
  try {
    fs.mkdirSync(opts.backupDir, { recursive: true });
    const b = `${stamp(new Date(opts.now || Date.now()))}-${meta.name}`;
    backup = path.join(opts.backupDir, b);
    for (let i = 2; fs.existsSync(backup); i++) backup = path.join(opts.backupDir, `${b}.${i}`);
    await fs.promises.copyFile(meta.original, backup, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    return { ok: false, reason: 'failed', error: `バックアップを作れません (${err && err.code})` };
  }
  try {
    await overwriteInPlace(meta.original, buf);
  } catch (err) {
    const code = err && err.code;
    await restore(meta.original, backup);
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return { ok: false, reason: 'locked', lockedBy: 'busy', error: code };
    return { ok: false, reason: 'failed', error: String(code || err) };
  }
  let check = null;
  try {
    check = await sha256File(meta.original);
  } catch {}
  if (check !== newSha) {
    await restore(meta.original, backup);
    return { ok: false, reason: 'failed', error: '書き込んだ内容を確認できませんでした（元に戻しました）' };
  }
  // the written content is the new base (edit on and write back again)
  try {
    const st = await fs.promises.stat(meta.original);
    const b = baseFile(dir, meta.name);
    try {
      fs.chmodSync(b, 0o644);
    } catch {}
    await fs.promises.writeFile(b, buf);
    try {
      fs.chmodSync(b, 0o444);
    } catch {}
    writeMeta(dir, { ...meta, base: { mtimeMs: st.mtimeMs, size: st.size, sha256: newSha }, writtenAt: Date.now() });
  } catch {}
  return { ok: true, backup };
}

async function restore(file, backup) {
  try {
    await overwriteInPlace(file, await fs.promises.readFile(backup));
  } catch {}
}

// "<stem>（編集版）<ext>", "<stem>（編集版 2）<ext>", … the first name that does not exist in folder.
function editedName(folder, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const n = `${stem}（編集版${i === 1 ? '' : ` ${i}`}）${ext}`;
    if (!fs.existsSync(path.join(folder, n))) return path.join(folder, n);
  }
  return null;
}

// Copies the working copy next to the original (or into opts.folder, e.g. Downloads) under the edited name.
// -> { ok: true, path } | { ok: false, error }
async function saveCopy(dir, opts = {}) {
  const meta = readMeta(dir);
  if (!meta) return { ok: false, error: 'not an edit folder' };
  const folder = opts.folder || path.dirname(meta.original);
  const origName = path.basename(meta.original);
  for (let tries = 0; tries < 3; tries++) {
    const target = editedName(folder, origName);
    if (!target) return { ok: false, error: 'no free name' };
    try {
      await fs.promises.copyFile(path.join(dir, meta.name), target, fs.constants.COPYFILE_EXCL);
      return { ok: true, path: target };
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      return { ok: false, error: String((err && err.code) || err) };
    }
  }
  return { ok: false, error: 'no free name' };
}

// Backups older than days (by mtime of the backup file = when it was made). -> number removed
function pruneBackups(backupDir, { days = BACKUP_DAYS, now = Date.now() } = {}) {
  let n = 0;
  let list;
  try {
    list = fs.readdirSync(backupDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const d of list) {
    if (!d.isFile()) continue;
    const p = path.join(backupDir, d.name);
    try {
      if (now - fs.statSync(p).mtimeMs > days * 86400_000) {
        fs.unlinkSync(p);
        n++;
      }
    } catch {}
  }
  return n;
}

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.css', '.js', '.ts', '.py', '.ps1', '.bat', '.cmd', '.ini', '.log', '.sql', '.sh', '.java', '.cs', '.c', '.h', '.cpp', '.go', '.rs', '.rb', '.php', '.toml']);
const BINARY_EXT = new Set(['.pptx', '.ppt', '.docx', '.doc', '.xlsx', '.xls', '.xlsm', '.pdf', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.mp4', '.exe', '.dll']);
function looksText(file) {
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  if (BINARY_EXT.has(ext)) return false;
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(8192);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    fs.closeSync(fd);
    return n > 0 && !b.subarray(0, n).includes(0);
  } catch {
    return false;
  }
}

// "元と比べる": text -> git diff --no-index base work; pptx (19 第 3 段) -> the text / shapes of each slide (pptxdiff.js),
// shown as the same +/- lines; others -> the hashes only.
// -> { kind: 'text', diff, changed, format?: 'pptx', slides?, counts? } | { kind: 'binary', changed, baseSha, workSha, error? } | null
async function diff(dir) {
  const meta = readMeta(dir);
  if (!meta) return null;
  const work = path.join(dir, meta.name);
  const base = baseFile(dir, meta.name);
  let ws = null;
  try {
    ws = await workSha(work);
  } catch {}
  const changed = ws !== meta.base.sha256;
  let pptxErr;
  if (changed && path.extname(meta.name).toLowerCase() === '.pptx') {
    try {
      const r = await pptxDiff.compare(base, work);
      const sha = `\n\n元:           sha256 ${meta.base.sha256}\n作業用コピー: sha256 ${ws}`;
      return { kind: 'text', format: 'pptx', changed, diff: r.text + sha, slides: r.slides, counts: r.counts, baseSha: meta.base.sha256, workSha: ws };
    } catch (err) {
      pptxErr = String((err && err.message) || err); // not readable as a pptx (e.g. saved while being written): the hashes
    }
  }
  if (looksText(work) && fs.statSync(work).size < 4 * 1024 * 1024) {
    // relative paths (cwd = the edit folder): headers read "a/.bantodesk/base/<name>" / "b/<name>".
    // On offthread's worker: starting git blocks the calling thread 120-1100 ms on this PC (docs/perf.md 5).
    const rel = `${metaDirOf(dir)}/base/${meta.name}`;
    const r = await execFileOff('git', ['diff', '--no-index', '--no-color', '--', rel, meta.name], { cwd: dir, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    const out = r.err && r.err.code !== 1 ? null : r.stdout; // exit 1 = differences found
    if (out !== null) return { kind: 'text', changed, diff: out };
  }
  return { kind: 'binary', changed, baseSha: meta.base.sha256, workSha: ws, ...(pptxErr ? { error: pptxErr } : {}) };
}

module.exports = {
  META_DIR,
  BACKUP_DAYS,
  safeName,
  sha256File,
  readMeta,
  importFile,
  originalState,
  status,
  writeBack,
  overwriteInPlace,
  editedName,
  saveCopy,
  pruneBackups,
  diff,
  claudeMd,
};
