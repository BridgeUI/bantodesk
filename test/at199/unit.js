// AT-199 unit test of src/main/reopenlater.js (plain node, no Electron): an open handed to the app while it quits is
// relaunched after the exit (once the quit is past will-quit), given back when the quit is cancelled, and its
// arguments are made absolute and stripped of remote debugging switches.
//   [AT_APP_ROOT=<app root>] node tmp/at199/unit.js [--app <app root>]
const path = require('path');
const ai = process.argv.indexOf('--app');
const root = ai > 0 ? path.resolve(process.argv[ai + 1]) : process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.resolve(__dirname, '..', '..');
const { createReopenLater, relaunchArgs } = require(path.join(root, 'src', 'main', 'reopenlater.js'));

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' | ' + extra : ''}`);
};
const fakeApp = () => {
  const calls = [];
  return { calls, relaunch: (o) => calls.push(o) };
};
const cwd = path.resolve('/work/here');
const bin = '/apps/Electron';

// 1. arguments
{
  const a = relaunchArgs([bin, '--no-sandbox', '.', '--user-data-dir=/ud', '--remote-debugging-pipe', '--remote-debugging-port=9333', '--remote-debugging-address=127.0.0.1', '--agent-terminal-e2e', 'proj'], cwd);
  ok(!a.some((x) => x.startsWith('--remote-debugging')), 'remote debugging switches dropped', a.join(' '));
  ok(a.includes(path.join(cwd, 'proj')) && a.includes(cwd), 'relative positionals made absolute against the second instance cwd', a.join(' '));
  ok(a.includes('--user-data-dir=/ud') && a.includes('--agent-terminal-e2e') && a.includes('--no-sandbox'), 'other switches kept in order', a.join(' '));
  ok(a[0] === '--no-sandbox', 'argv[0] (the binary) left out');
  const e = relaunchArgs([bin, '--edit=doc.pptx', '--temp'], cwd);
  ok(e[0] === '--edit=' + path.join(cwd, 'doc.pptx') && e[1] === '--temp', '--edit=<file> made absolute, --temp kept', e.join(' '));
  ok(relaunchArgs([bin, '/abs/dir'], cwd)[0] === path.resolve('/abs/dir'), 'absolute path kept');
}

// 2. kept before will-quit: nothing relaunched until arm(); arm() relaunches each once
{
  const app = fakeApp();
  const r = createReopenLater({ app, execPath: bin });
  r.keep([bin, 'p1'], cwd);
  ok(app.calls.length === 0, 'an open while quitting (before will-quit) is only kept');
  r.keep([bin, 'p1'], cwd);
  r.keep([bin, 'p2'], cwd);
  ok(r.count() === 2, 'the same open twice is kept once', `kept ${r.count()}`);
  r.arm();
  ok(app.calls.length === 2 && app.calls.every((c) => c.execPath === bin), 'will-quit: each kept open relaunched with the binary', JSON.stringify(app.calls));
  ok(app.calls[0].args[0] === path.join(cwd, 'p1') && app.calls[1].args[0] === path.join(cwd, 'p2'), 'relaunch args are the opens');
  r.arm();
  ok(app.calls.length === 2, 'a second will-quit (after the waits) relaunches nothing again');
  // 3. after will-quit: relaunched at once
  r.keep([bin, 'p3'], cwd);
  ok(app.calls.length === 3 && app.calls[2].args[0] === path.join(cwd, 'p3'), 'an open after will-quit is relaunched at once');
  r.keep([bin, 'p3'], cwd);
  ok(app.calls.length === 3, 'the same open again after will-quit: one relaunch');
  ok(r.takeBack().length === 0, 'after will-quit nothing is given back (the quit cannot be cancelled)');
}

// 4. quit cancelled before will-quit: the opens are given back, nothing relaunched
{
  const app = fakeApp();
  const r = createReopenLater({ app, execPath: bin });
  r.keep([bin, 'p1'], cwd);
  const back = r.takeBack();
  ok(back.length === 1 && back[0].argv[1] === 'p1' && back[0].cwd === cwd, 'cancelled quit: the open is given back with its argv and cwd', JSON.stringify(back));
  ok(r.count() === 0, 'and no longer kept');
  r.arm();
  ok(app.calls.length === 0, 'a later quit does not relaunch the given-back open');
}

// 5. relaunch throwing does not throw out of keep / arm
{
  const r = createReopenLater({ app: { relaunch: () => { throw new Error('x'); } }, execPath: bin });
  let threw = false;
  try {
    r.keep([bin, 'p1'], cwd);
    r.arm();
  } catch {
    threw = true;
  }
  ok(!threw, 'a failing app.relaunch is logged, not thrown');
}

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
