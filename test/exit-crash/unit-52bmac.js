// 52b-mac unit: src/main/watchers.js (every chokidar watcher closed by closeAll) and src/main/e2e.js watchParent
// (an e2e app quits when the test that started it is gone).   node tmp/exit-crash/unit-52bmac.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '..', '..');
const appRoot = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : root; // the src under test
const { track } = require(path.join(appRoot, 'src', 'main', 'watchers'));
const { watchParent } = require(path.join(appRoot, 'src', 'main', 'e2e'));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || extra === undefined ? '' : ' | ' + JSON.stringify(extra)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hard = setTimeout(() => {
  console.log('time limit');
  process.exit(2);
}, 30000);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-52bmac-'));
  try {
    // --- watchers
    const w = track(require(path.join(root, 'node_modules', 'chokidar')));
    ok('w1 no watcher: closeAll -> 0', (await w.closeAll(1000)) === 0);
    const a = w.chokidar.watch(dir, { depth: 1 });
    const b = w.chokidar.watch(path.join(dir, '*.json'));
    await Promise.all([new Promise((r) => a.on('ready', r)), new Promise((r) => b.on('ready', r))]);
    ok('w2 two watchers counted', w.count() === 2, w.count());
    await b.close();
    ok('w3 a watcher closed by its owner is forgotten', w.count() === 1, w.count());
    let seen = 0;
    a.on('add', () => seen++);
    const left = await w.closeAll(3000);
    ok('w4 closeAll closes the rest -> 0 still open', left === 0 && w.count() === 0, { left, count: w.count() });
    ok('w5 the closed watcher is marked closed', a.closed === true);
    fs.writeFileSync(path.join(dir, 'x.json'), '{}');
    await sleep(400);
    ok('w6 no event after closeAll', seen === 0, seen);
    ok('w7 FSWatcher still exported', typeof w.chokidar.FSWatcher === 'function');

    // --- watchParent
    const fakeApp = () => {
      const s = { quit: 0, exit: null };
      return { s, app: { quit: () => s.quit++, exit: (c) => (s.exit = c) } };
    };
    const quiet = () => {};
    const e2eEnv = () => ({ AGENT_TERMINAL_E2E: '1' });
    {
      const { app } = fakeApp();
      ok('p1 not e2e: not watching', watchParent(app, { argv: [], env: {}, log: quiet }) === 0);
      ok('p2 Windows: not watching', watchParent(app, { argv: [], env: e2eEnv(), platform: 'win32', log: quiet }) === 0);
      ok('p3 AGENT_TERMINAL_E2E_STAY=1: not watching', watchParent(app, { argv: [], env: { ...e2eEnv(), AGENT_TERMINAL_E2E_STAY: '1' }, log: quiet }) === 0);
    }
    {
      // a stand-in "test" that ends after 600 ms
      const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600)'], { stdio: 'ignore' });
      const { s, app } = fakeApp();
      const env = { ...e2eEnv(), AGENT_TERMINAL_E2E_PARENT: String(kid.pid) };
      const pid = watchParent(app, { argv: ['--agent-terminal-e2e'], env, everyMs: 100, platform: 'darwin', log: quiet });
      ok('p4 a kept parent PID that is alive is watched', pid === kid.pid, { pid, kid: kid.pid });
      await sleep(300);
      ok('p5 while it runs: no quit', s.quit === 0);
      await new Promise((r) => kid.on('exit', r));
      await sleep(400);
      ok('p6 once it is gone: app.quit() once', s.quit === 1, s);
    }
    {
      const { app } = fakeApp();
      const env = { ...e2eEnv(), AGENT_TERMINAL_E2E_PARENT: '999999' }; // gone: falls back to the real parent
      const pid = watchParent(app, { argv: [], env, everyMs: 60000, platform: 'darwin', log: quiet });
      ok('p7 a kept PID that is gone: the real parent is watched and kept', pid === process.ppid && env.AGENT_TERMINAL_E2E_PARENT === String(process.ppid), { pid, ppid: process.ppid, env });
    }
  } catch (e) {
    fail++;
    console.log('ERROR', e.stack);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    clearTimeout(hard);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
