// AT-202: 管理フォルダの projects.json・inbox.json・waits.json の書き出しと outbox の処理が長く止まらないことの確かめ。
//   A timebox の基本
//   B writeq: 非同期の書き込みが返らない（手で止めた writeFile）-> 時間切れで同期で書き、後から来た古い書き込みは捨てる
//   C writeq: rename が遅れて古い内容を上書きした -> 新しい内容を書き直す
//   D 本物の重い条件: libuv のスレッドプールを crypto.pbkdf2 で数秒ふさぐ（プロセスは起こさない）。その間も
//     projects.json の書き込み（writeq）と buildProjects（バックログの読み）が時間内に終わる。素の fs.promises は待たされる
//   E outbox/done の古いファイルを日付のフォルダへ移す（3000 件）。新しいもの・.result.json の近いものは残る
//   F outbox: 1 件の処理が返らなくても、次のファイルが先に処理される。止まっていた方も後で done に移る
//   G outbox: chokidar が何も知らせなくても（非同期の stat がプールを待つ）、同期の見回りでファイルを拾う。1 回だけ
// node tmp/at202/unit.js   （打ち切り 120 秒。AT_APP_ROOT = 別のアプリのフォルダ〈stable の確認〉）
'use strict';
process.env.AGENT_TERMINAL_WRITEQ_STEP_MS = '300';
process.env.AGENT_TERMINAL_SLOW_READ_MS = '300';
process.env.AGENT_TERMINAL_OUTBOX_FILE_MS = '500';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

setTimeout(() => {
  console.log('TIMEOUT');
  process.exit(2);
}, 120000).unref();

const appRoot = process.env.AT_APP_ROOT || path.join(__dirname, '..', '..');
const src = (m) => require(path.join(appRoot, 'src', 'main', m));
const { timebox, TIMED_OUT } = src('timebox');
const writeq = src('writeq');
const manager = src('manager');
const backlog = src('backlog');
const chokidar = require(path.join(appRoot, 'node_modules', 'chokidar'));

let pass = 0;
let fail = 0;
const ok = (c, m, ev) => {
  if (c) pass++;
  else fail++;
  console.log(`${c ? 'ok  ' : 'FAIL'} ${m}${ev !== undefined ? ' | ' + (typeof ev === 'string' ? ev : JSON.stringify(ev)) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = path.join(__dirname, 'out', 'u-' + process.pid);
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(base, { recursive: true });
const read = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
async function until(cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return !!cond();
}
const tmpsOf = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));

const real = { writeFile: fs.promises.writeFile, rename: fs.promises.rename, readFile: fs.promises.readFile };

async function partA() {
  ok((await timebox(Promise.resolve(7), 100)) === 7, 'A timebox: an answer in time comes back');
  let late = null;
  const slow = new Promise((r) => setTimeout(() => r('late'), 200));
  const t0 = Date.now();
  const r = await timebox(slow, 50, { onLate: (v) => (late = v) });
  ok(r === TIMED_OUT && Date.now() - t0 < 150, 'A timebox: no answer in time -> TIMED_OUT at the limit', Date.now() - t0);
  await sleep(250);
  ok(late === 'late', 'A timebox: the late answer goes to onLate', late);
  let rej = null;
  try {
    await timebox(Promise.reject(new Error('x')), 100);
  } catch (e) {
    rej = e.message;
  }
  ok(rej === 'x', 'A timebox: a failure in time is a failure');
}

async function partB() {
  const dir = path.join(base, 'B');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'projects.json');
  let release = null;
  fs.promises.writeFile = function (p, ...a) {
    if (String(p).startsWith(file) && !release) {
      return new Promise((res, rej) => {
        release = () => real.writeFile.call(fs.promises, p, ...a).then(res, rej);
      });
    }
    return real.writeFile.call(this, p, ...a);
  };
  try {
    const t0 = Date.now();
    writeq.write(file, '{"v":1}');
    const landed = await until(() => read(file) === '{"v":1}', 2000);
    ok(landed && Date.now() - t0 < 1500, 'B a write whose async writeFile never answers is on disk after the step limit (sync)', Date.now() - t0);
    writeq.write(file, '{"v":2}');
    writeq.write(file, '{"v":3}');
    ok(await until(() => read(file) === '{"v":3}', 2000), 'B later writes land while the first async write is still hanging', read(file));
    release();
    await sleep(300);
    await writeq.idle();
    ok(read(file) === '{"v":3}', 'B the hung write coming back late does not put the old text back', read(file));
    ok(tmpsOf(dir).length === 0, 'B no temp file left', tmpsOf(dir));
  } finally {
    fs.promises.writeFile = real.writeFile;
  }
}

async function partC() {
  const dir = path.join(base, 'C');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'waits.json');
  let release = null;
  fs.promises.rename = function (from, to, ...a) {
    if (String(to) === file && !release) {
      // the rename is "under way": it lands only when released (an old text over a newer one)
      return new Promise((res, rej) => {
        release = () => real.rename.call(fs.promises, from, to, ...a).then(res, rej);
      });
    }
    return real.rename.call(this, from, to, ...a);
  };
  try {
    writeq.write(file, '{"v":1}');
    ok(await until(() => read(file) === '{"v":1}', 2000), 'C a hanging rename -> the text is written synchronously', read(file));
    writeq.write(file, '{"v":2}');
    ok(await until(() => read(file) === '{"v":2}', 2000), 'C the next write lands (own temp name while the old attempt lives)', read(file));
    release();
    ok(await until(() => read(file) === '{"v":2}' && tmpsOf(dir).length === 0, 2000), 'C the late rename of v1 is followed by v2 again; no temp file left', [read(file), tmpsOf(dir)]);
  } finally {
    fs.promises.rename = real.rename;
  }
}

// ~ms of one pbkdf2 job of n iterations
function costOf(n) {
  const t0 = Date.now();
  crypto.pbkdf2Sync('x', 'y', n, 32, 'sha512');
  return Math.max(1, Date.now() - t0);
}
async function partD() {
  const dir = path.join(base, 'D');
  const backlogDir = path.join(dir, 'backlog');
  const folder = path.join(dir, 'proj');
  fs.mkdirSync(folder, { recursive: true });
  await backlog.saveBacklog(backlogDir, folder, {
    items: [
      { id: 'a1', text: 'one', status: 'pending', createdAt: 1 },
      { id: 'a2', text: 'two', status: 'pending', createdAt: 2 },
      { id: 'a3', text: 'three', status: 'done', createdAt: 3 },
    ],
  });
  // fill every thread-pool thread for ~6 s (no process is started: crypto work on the pool)
  const n = Math.round((6000 / costOf(20000)) * 20000);
  const hogs = [];
  const hogStart = Date.now();
  for (let i = 0; i < 8; i++) hogs.push(new Promise((r) => crypto.pbkdf2('x', 'y' + i, n, 32, 'sha512', () => r(Date.now()))));
  const hogEnd = Promise.all(hogs).then(() => Date.now());
  await sleep(50);
  // a plain async fs call waits for the pool (what stalled the snapshots)
  const rawT0 = Date.now();
  const rawDone = real.writeFile.call(fs.promises, path.join(dir, 'raw.txt'), 'x').then(() => Date.now() - rawT0);

  const file = path.join(dir, 'projects.json');
  const t0 = Date.now();
  writeq.write(file, '{"projects":1}');
  const landed = await until(() => read(file) === '{"projects":1}', 3000);
  const wMs = Date.now() - t0;
  ok(landed && wMs < 1500, 'D pool held: projects.json (writeq) is on disk within the step limit', wMs);

  const b0 = Date.now();
  const list = await manager.buildProjects({ recent: [folder], managerDir: path.join(dir, 'manager'), backlogDir });
  const bMs = Date.now() - b0;
  const p = list[0] || {};
  ok(bMs < 1500 && p.backlog && p.backlog.pending === 2 && p.backlog.done === 1, 'D pool held: buildProjects answers in time from a sync read, counts right', { ms: bMs, backlog: p.backlog });

  const rawMs = await rawDone;
  const end = await hogEnd;
  ok(rawMs > 2000, 'D (control) a plain fs.promises write waited for the pool', { rawMs, poolHeldMs: end - hogStart });
  await writeq.idle();
  ok(read(file) === '{"projects":1}' && tmpsOf(dir).length === 0, 'D after the pool frees: the file keeps its text, no temp file');
}

async function partE() {
  const mdir = path.join(base, 'E', 'manager');
  const done = path.join(mdir, 'outbox', 'done');
  fs.mkdirSync(done, { recursive: true });
  const now = Date.now();
  const old = new Date(now - 5 * 24 * 3600 * 1000);
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const f = path.join(done, `old-${i}.json`);
    fs.writeFileSync(f, '{}');
    fs.utimesSync(f, old, old);
  }
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(done, `new-${i}.json`), '{}');
    fs.writeFileSync(path.join(done, `new-${i}.json.result.json`), '[]');
  }
  const t0 = Date.now();
  const r = await manager.archiveDone(mdir, { now });
  const ms = Date.now() - t0;
  const day = (() => {
    const d = old;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const top = fs.readdirSync(done);
  ok(r.moved === N && r.kept === 10 && r.failed === 0, 'E old files moved, recent ones and their results kept', { ...r, ms });
  ok(top.length === 11 && top.includes(day) && top.includes('new-0.json.result.json'), 'E done/ keeps 10 recent files + the day folder', top.length);
  ok(fs.readdirSync(path.join(done, day)).length === N, `E the old files are in done/${day}/`);
  const r2 = await manager.archiveDone(mdir, { now });
  ok(r2.moved === 0 && r2.kept === 10, 'E a second run moves nothing (day folders are skipped)', r2);
}

async function partF() {
  const mdir = path.join(base, 'F', 'manager');
  manager.ensureManagerDir(mdir);
  const outbox = path.join(mdir, 'outbox');
  let release = null;
  const seen = [];
  const ctx = {
    inbox: { find: () => null },
    nudge: (a) => {
      seen.push(a.tabKey);
      if (a.tabKey === 'hang') return new Promise((r) => (release = () => r({ ok: true, tabKey: a.tabKey })));
      return Promise.resolve({ ok: true, tabKey: a.tabKey });
    },
  };
  const w = manager.watchOutbox(mdir, ctx, { chokidar });
  try {
    await sleep(300);
    fs.writeFileSync(path.join(outbox, '1-hang.json'), JSON.stringify({ type: 'nudge', tabKey: 'hang', text: 't', reason: 'r' }));
    await until(() => seen.includes('hang'), 5000);
    fs.writeFileSync(path.join(outbox, '2-next.json'), JSON.stringify({ type: 'nudge', tabKey: 'next', text: 't', reason: 'r' }));
    const t0 = Date.now();
    const moved = await until(() => fs.existsSync(path.join(outbox, 'done', '2-next.json')), 6000);
    ok(moved, 'F the next outbox file is done although the one before it never answers', Date.now() - t0);
    ok(fs.existsSync(path.join(outbox, '1-hang.json')), 'F the hanging one is still in outbox (not lost, not failed)');
    release();
    ok(await until(() => fs.existsSync(path.join(outbox, 'done', '1-hang.json')), 3000), 'F once it answers it moves to done itself');
  } finally {
    await w.close();
  }
}

// G: chokidar never tells (its async stats wait for a held pool) -> the synchronous look at outbox/ finds the file
async function partG() {
  const mdir = path.join(base, 'G', 'manager');
  manager.ensureManagerDir(mdir);
  const outbox = path.join(mdir, 'outbox');
  const { EventEmitter } = require('events');
  const silent = { watch: () => Object.assign(new EventEmitter(), { close: async () => {} }) };
  const seen = [];
  const ctx = { inbox: { find: () => null }, nudge: async (a) => (seen.push(a.tabKey), { ok: true, tabKey: a.tabKey }) };
  const w = manager.watchOutbox(mdir, ctx, { chokidar: silent });
  try {
    const t0 = Date.now();
    fs.writeFileSync(path.join(outbox, 'g.json'), JSON.stringify({ type: 'nudge', tabKey: 'g', text: 't', reason: 'r' }));
    const moved = await until(() => fs.existsSync(path.join(outbox, 'done', 'g.json')), 10000);
    ok(moved && seen.join() === 'g', 'G a silent watcher: the outbox file is still processed (sync look every 2 s), once', { ms: Date.now() - t0, seen });
    await sleep(4500);
    ok(seen.join() === 'g', 'G not processed twice', seen);
  } finally {
    await w.close();
  }
}

(async () => {
  for (const [name, fn] of Object.entries({ partA, partB, partC, partD, partE, partF, partG })) {
    try {
      await fn();
    } catch (err) {
      ok(false, `${name} threw`, String((err && err.stack) || err));
    }
  }
  fs.rmSync(base, { recursive: true, force: true });
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
