// UX6 main side: src/main/snapshot.js (dashboard:snapshot) and src/main/samesave.js (J2 same-content saves). Plain node.
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const snapshot = require(path.join(__dirname, '../../src/main/snapshot.js'));
const samesave = require(path.join(__dirname, '../../src/main/samesave.js'));

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// a fake ipcMain with Electron's shape: handle() throws on a second handler, _invokeHandlers is a Map
function fakeIpc() {
  const m = new Map();
  return {
    _invokeHandlers: m,
    handle(ch, fn) {
      if (m.has(ch)) throw new Error(`Attempted to register a second handler for '${ch}'`);
      m.set(ch, fn);
    },
    removeHandler(ch) {
      m.delete(ch);
    },
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('record: handle still registers, originals are recorded', () => {
  const ipc = fakeIpc();
  const s = snapshot.create();
  s.record(ipc);
  s.record(ipc); // twice: no double wrap
  const fn = () => 1;
  ipc.handle('inbox:get', fn);
  assert.equal(ipc._invokeHandlers.get('inbox:get'), fn);
  assert.equal(s.handlers.get('inbox:get'), fn);
  assert.throws(() => ipc.handle('inbox:get', () => 2), /second handler/);
  assert.equal(s.handlers.get('inbox:get'), fn); // the failed second one is not recorded
  ipc.removeHandler('inbox:get');
  assert.equal(s.handlers.has('inbox:get'), false);
  assert.equal(ipc._invokeHandlers.has('inbox:get'), false);
});

test('run calls the recorded original, not _invokeHandlers (a counting wrapper does not count)', async () => {
  const ipc = fakeIpc();
  const s = snapshot.create();
  s.record(ipc);
  let seenE = null;
  let seenArg = 'unset';
  ipc.handle('backlog:getFolder', (e, o) => {
    seenE = e;
    seenArg = o;
    return { items: [o.folder] };
  });
  let counted = 0;
  const orig = ipc._invokeHandlers.get('backlog:getFolder');
  ipc._invokeHandlers.set('backlog:getFolder', (...a) => (counted++, orig(...a)));
  const e = { sender: { id: 7 } };
  const r = await s.run(e, { calls: { a: ['backlog:getFolder', { folder: '/x' }] } });
  assert.deepEqual(r.a.value, { items: ['/x'] });
  assert.equal(typeof r.a.sig, 'string');
  assert.equal(r.a.sig.length, 16);
  assert.equal(seenE, e);
  assert.deepEqual(seenArg, { folder: '/x' });
  assert.equal(counted, 0);
});

test('no arg -> handler gets only e', async () => {
  const ipc = fakeIpc();
  const s = snapshot.create();
  s.record(ipc);
  let n = -1;
  ipc.handle('models:get', (...a) => ((n = a.length), { m: 1 }));
  await s.run({}, { calls: { m: ['models:get'] } });
  assert.equal(n, 1);
});

test('allowlist: not allowed / unknown / bad calls; snapshot itself is not callable', async () => {
  const ipc = fakeIpc();
  const s = snapshot.create();
  s.record(ipc);
  let wrote = 0;
  ipc.handle('inbox:add', () => ++wrote);
  ipc.handle('dashboard:snapshot', (e, o) => s.run(e, o));
  const r = await s.run({}, {
    calls: { w: ['inbox:add', { text: 'x' }], snap: ['dashboard:snapshot', {}], gone: ['qa:list'], bad: 'inbox:get', bad2: [1] },
  });
  assert.deepEqual(r.w, { error: 'not allowed' });
  assert.deepEqual(r.snap, { error: 'not allowed' });
  assert.deepEqual(r.gone, { error: 'not allowed' }); // allowed channel but no handler registered
  assert.deepEqual(r.bad, { error: 'bad call' });
  assert.deepEqual(r.bad2, { error: 'bad call' });
  assert.equal(wrote, 0);
});

test('every allowed channel is a real channel name (in src/preload.js)', () => {
  const fs = require('node:fs');
  const pre = fs.readFileSync(path.join(__dirname, '../../src/preload.js'), 'utf8');
  for (const [name, ch] of Object.entries(snapshot.CHANNELS)) {
    assert.ok(pre.includes(`${name}: (`) || pre.includes(`${name}: ()`), `preload has ${name}`);
    assert.ok(pre.includes(`'${ch}'`), `preload uses ${ch}`);
  }
  assert.equal(snapshot.ALLOWED.size, 20);
  assert.ok(pre.includes("dashboardSnapshot: (o) => ipcRenderer.invoke('dashboard:snapshot', o)"));
});

// SNAP-ALLOW: a channel the renderer reads through the snapshot (dashboard.js SNAP_VIA) but main does not allow is
// answered 「not allowed」 on every refresh (read again one by one, warned once). UX12's pmo:heartbeat / reviews:list were.
test('every channel of the renderer SNAP_VIA is allowed by main, under the same preload name', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/dashboard.js'), 'utf8');
  const i = src.indexOf('const SNAP_VIA = {');
  assert.ok(i > 0, 'SNAP_VIA found');
  const body = src.slice(i, src.indexOf('};', i));
  const pairs = [...body.matchAll(/'([a-z]+:[A-Za-z]+)':\s*'([A-Za-z]+)'/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length >= 20, `SNAP_VIA pairs ${pairs.length}`);
  for (const [ch, name] of pairs) {
    assert.ok(snapshot.ALLOWED.has(ch), `main allows ${ch}`);
    assert.equal(snapshot.CHANNELS[name], ch, `CHANNELS.${name} = ${ch}`);
  }
});

test('sig / same: a known sig drops the value; a changed value sends it again', async () => {
  const ipc = fakeIpc();
  const s = snapshot.create();
  s.record(ipc);
  let v = { a: 1 };
  ipc.handle('sched:state', () => v);
  const r1 = await s.run({}, { calls: { s: ['sched:state'] } });
  assert.equal(r1.s.sig, snapshot.sigOf({ a: 1 }));
  const r2 = await s.run({}, { calls: { s: ['sched:state'] }, sigs: { s: r1.s.sig } });
  assert.deepEqual(r2.s, { sig: r1.s.sig, same: true });
  v = { a: 2 };
  const r3 = await s.run({}, { calls: { s: ['sched:state'] }, sigs: { s: r1.s.sig } });
  assert.deepEqual(r3.s.value, { a: 2 });
  assert.notEqual(r3.s.sig, r1.s.sig);
  // null / undefined values have a sig too
  ipc.handle('dashboard:workRoot', () => null);
  ipc.handle('qa:list', () => undefined);
  const r4 = await s.run({}, { calls: { w: ['dashboard:workRoot'], q: ['qa:list'] } });
  assert.equal(r4.w.value, null);
  assert.equal(typeof r4.q.sig, 'string');
  assert.notEqual(r4.w.sig, r4.q.sig);
});

test('error per call: a throwing / rejecting handler does not fail the others', async () => {
  const ipc = fakeIpc();
  const s = snapshot.create();
  s.record(ipc);
  ipc.handle('pmo:log', () => {
    throw new Error('boom');
  });
  ipc.handle('notices:list', async () => {
    throw new Error('later');
  });
  ipc.handle('inbox:get', () => ({ items: [] }));
  const r = await s.run({}, { calls: { p: ['pmo:log'], n: ['notices:list'], i: ['inbox:get'] } });
  assert.deepEqual(r.p, { error: 'boom' });
  assert.deepEqual(r.n, { error: 'later' });
  assert.deepEqual(r.i.value, { items: [] });
});

test('parallel: 3 slow calls take about one delay, not three', async () => {
  const ipc = fakeIpc();
  const s = snapshot.create();
  s.record(ipc);
  let inFlight = 0;
  let peak = 0;
  ipc.handle('dashboard:progress', async (_e, o) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await sleep(150);
    inFlight--;
    return o.folder;
  });
  const t = Date.now();
  const r = await s.run({}, { calls: { a: ['dashboard:progress', { folder: 'a' }], b: ['dashboard:progress', { folder: 'b' }], c: ['dashboard:progress', { folder: 'c' }] } });
  const ms = Date.now() - t;
  assert.equal(peak, 3);
  assert.ok(ms < 400, `took ${ms} ms`);
  assert.deepEqual([r.a.value, r.b.value, r.c.value], ['a', 'b', 'c']);
});

test('max 80 calls; bad names and bad requests', async () => {
  const ipc = fakeIpc();
  const s = snapshot.create();
  s.record(ipc);
  let n = 0;
  ipc.handle('backlog:getFolder', () => ++n);
  const calls = {};
  for (let i = 0; i < 85; i++) calls['f' + i] = ['backlog:getFolder', { folder: '/' + i }];
  const r = await s.run({}, { calls });
  assert.equal(n, 80);
  assert.equal(Object.values(r).filter((x) => x.error === 'too many calls').length, 5);
  assert.deepEqual(await s.run({}, null), {});
  assert.deepEqual(await s.run({}, { calls: 'x' }), {});
  const r2 = await s.run({}, JSON.parse('{"calls":{"__proto__":["backlog:getFolder"],"a b":["backlog:getFolder"],"ok":["backlog:getFolder"]}}'));
  assert.deepEqual(Object.keys(r2).sort(), ['a b', 'ok']);
  assert.deepEqual(r2['a b'], { error: 'bad name' });
  assert.equal(Object.getPrototypeOf(r2), Object.prototype);
});

test('samesave: first save goes through, same content dropped, a main write forgets', () => {
  const d = samesave.create();
  const a = JSON.stringify({ items: [{ id: 'x', status: 'pending' }] });
  const b = JSON.stringify({ items: [{ id: 'x', status: 'done' }] });
  assert.equal(d.same('/f', a), false); // first save of the folder
  d.remember('/f', a);
  assert.equal(d.same('/f', a), true);
  assert.equal(d.same('/f', b), false);
  assert.equal(d.same('/g', a), false); // per folder
  d.forget('/f');
  assert.equal(d.same('/f', a), false);
});

test('samesave.forgetOnWrite: the module functions forget the folder, keep result and this', async () => {
  const d = samesave.create();
  const writes = [];
  const mod = {
    saveBacklog(dir, workDir, data) {
      writes.push([workDir, data]);
      return Promise.resolve(true);
    },
    saveBacklogSync(dir, workDir) {
      writes.push([workDir]);
      return this === mod;
    },
    other: () => 'x',
  };
  samesave.forgetOnWrite(mod, ['saveBacklog', 'saveBacklogSync', 'missing'], d, (a) => a[1].toLowerCase());
  samesave.forgetOnWrite(mod, ['saveBacklog'], d, (a) => a[1]); // no double wrap
  const A = '{"items":[]}';
  // a window save: same() false -> write (forgets) -> remember
  assert.equal(d.same('/f', A), false);
  const p = mod.saveBacklog('dir', '/F', {});
  d.remember('/f', A);
  assert.equal(await p, true);
  assert.equal(d.same('/f', A), true);
  // main writes the folder (e.g. backlogUpdate -> updateStatus / manager.js -> saveBacklog): entry forgotten
  assert.equal(mod.saveBacklogSync('dir', '/F'), true);
  assert.equal(d.same('/f', A), false); // the window's older content is written again
  assert.equal(writes.length, 2);
  assert.equal(mod.other(), 'x');
});

test('main.js wiring: record before the first handler, snapshot handler, dedupe in both saves', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
  const rec = src.indexOf('dashSnapshot.record(ipcMain)');
  const first = src.indexOf('ipcMain.handle(');
  assert.ok(rec > 0 && rec < first, 'record() comes before the first ipcMain.handle');
  for (const init of ['widget.init(', 'remote.init(', 'viewer.init(']) assert.ok(src.indexOf(init) > rec, init);
  assert.ok(src.includes("ipcMain.handle('dashboard:snapshot', (e, o) => dashSnapshot.run(e, o))"));
  const save = src.slice(src.indexOf("ipcMain.handle('backlog:save'"), src.indexOf("ipcMain.handle('backlog:drop'"));
  assert.equal((save.match(/backlogSame\.same\(key, json\)/g) || []).length, 2);
  assert.ok(src.includes("samesave.forgetOnWrite(backlog, ['saveBacklog', 'saveBacklogSync', 'updateStatus']"));
  assert.ok(/if \(source !== 'window'\) backlogSame\.forget\(norm\(folder\)\)/.test(src));
  // every backlog:changed to the dashboard carries folder
  const sends = src.match(/send\(managerState, 'backlog:changed', [^)]*\)/g) || [];
  assert.ok(sends.length >= 2);
  for (const x of sends) assert.ok(/payload|\{ folder/.test(x), x);
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      pass++;
      console.log('ok  ', name);
    } catch (err) {
      console.log('FAIL', name, '\n    ', err && err.message);
    }
  }
  console.log(`${pass}/${tests.length} passed`);
  process.exit(pass === tests.length ? 0 : 1);
})();
