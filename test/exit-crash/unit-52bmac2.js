// 52b-mac2 unit: src/main/quitwait.js waitThenQuit. The app.quit() after the will-quit waits runs on a later task (not
// as a microtask inside the will-quit dispatch, where Electron ignored it), once, after every wait has settled
// (also a rejected one); app.exit(0) when the app is still there after the deadline.   node tmp/exit-crash/unit-52bmac2.js
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const appRoot = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : root;
const { waitThenQuit } = require(path.join(appRoot, 'src', 'main', 'quitwait'));

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
}, 20000);
const fakeApp = () => {
  const a = { quit: 0, exit: [], log: [] };
  a.app = { quit: () => a.quit++, exit: (c) => a.exit.push(c) };
  return a;
};
const microtasks = async (n = 50) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

(async () => {
  // q1: all waits settled already (the hang: a quit in the first seconds after the start)
  {
    const a = fakeApp();
    const t = waitThenQuit(a.app, [Promise.resolve(), Promise.resolve(0), null], { deadlineMs: 5000 });
    await microtasks();
    ok('q1 settled waits: no app.quit() within the microtasks of the will-quit dispatch', a.quit === 0, a);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    ok('q2 app.quit() once on a later task', a.quit === 1, a);
    clearTimeout(t);
  }
  // q3: a wait that takes time: quit after it, not before
  {
    const a = fakeApp();
    let done;
    const slow = new Promise((r) => (done = r));
    const t = waitThenQuit(a.app, [Promise.resolve(), slow], { deadlineMs: 5000 });
    await sleep(100);
    ok('q3 a wait still running: no quit yet', a.quit === 0, a);
    done();
    await sleep(20);
    ok('q4 the wait ended: app.quit() once', a.quit === 1, a);
    clearTimeout(t);
  }
  // q5: a rejected wait still leads to the quit (Promise.all would have dropped it)
  {
    const a = fakeApp();
    const t = waitThenQuit(a.app, [Promise.reject(new Error('x')), Promise.resolve()], { deadlineMs: 5000 });
    await sleep(20);
    ok('q5 a rejected wait: app.quit() still once', a.quit === 1, a);
    clearTimeout(t);
  }
  // q6: the deadline: a wait that never settles -> app.exit(0) with a log line
  {
    const a = fakeApp();
    waitThenQuit(a.app, [new Promise(() => {})], { deadlineMs: 150, log: (m) => a.log.push(m) });
    await sleep(60);
    ok('q6 before the deadline: no exit', a.exit.length === 0, a);
    await sleep(200);
    ok('q7 after the deadline: app.exit(0) once, logged', a.exit.length === 1 && a.exit[0] === 0 && a.log.length === 1 && a.quit === 0, a);
  }
  clearTimeout(hard);
  console.log(`${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
})();
