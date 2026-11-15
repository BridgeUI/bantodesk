// AT-199: an "open" that reaches this app while it is quitting is not dropped.
//
// While the app ends (before-quit -> will-quit, whose waits take up to a few seconds: terminals ≤ 3 s, keep-awake's lid
// ≤ 12 s, src/main.js), it still holds the single-instance lock. Opening the app again then makes the new process hand
// its arguments to this one (second-instance) and end at once; the ending app opened nothing, so for those seconds
// opening the app did nothing (docs/exit-crash.md, AT-146).
// Now each such open is kept and, once the quit can no longer be cancelled (will-quit), handed to app.relaunch(): after
// this process has exited, Electron starts the app again with the kept arguments, as if the open had come a moment later.
// A quit that is cancelled before will-quit (a temp window's 「キャンセル」) gives the opens back, to be opened now.
//
//   const later = createReopenLater({ app });
//   app.on('second-instance', (e, argv, cwd) => (quitting ? later.keep(argv, cwd) : launch(argv, cwd)));
//   will-quit: later.arm();   quit cancelled: for (const o of later.takeBack()) launch(o.argv, o.cwd);
//
// The relaunch arguments are the second instance's own (same binary: the lock is per user-data-dir), with its relative
// paths made absolute against its cwd (the relaunched process does not start in that cwd) and without remote debugging
// switches (a pipe's descriptors are not passed on; a port is for e2e tests only, src/main/e2e.js).
const path = require('path');

const DROP = /^--remote-debugging-(pipe|port|address)(=|$)/;

function relaunchArgs(argv, cwd) {
  const base = cwd || process.cwd();
  const out = [];
  for (const a of (argv || []).slice(1)) {
    if (typeof a !== 'string' || DROP.test(a)) continue;
    if (a.startsWith('--edit=')) out.push('--edit=' + path.resolve(base, a.slice('--edit='.length)));
    else if (a.startsWith('-')) out.push(a);
    else out.push(path.resolve(base, a));
  }
  return out;
}

function createReopenLater({ app, execPath = process.execPath, log = () => {} } = {}) {
  const kept = []; // { argv, cwd, args, relaunched }
  let armed = false;
  const relaunch = (o) => {
    if (o.relaunched) return;
    o.relaunched = true;
    try {
      app.relaunch({ execPath, args: o.args });
      log(`[reopen] opened while quitting: the app starts again after it has ended (${o.args.join(' ')})`);
    } catch (err) {
      log(`[reopen] relaunch failed: ${err && err.message}`);
    }
  };
  return {
    keep(argv, cwd) {
      const args = relaunchArgs(argv, cwd);
      const key = JSON.stringify(args);
      let o = kept.find((x) => x.key === key);
      if (!o) {
        o = { argv, cwd, args, key, relaunched: false };
        kept.push(o);
      }
      if (armed) relaunch(o);
      return args;
    },
    // will-quit: the quit goes on (src/main.js only delays it); every kept open is relaunched after the exit
    arm() {
      armed = true;
      for (const o of kept) relaunch(o);
    },
    // the quit was cancelled before will-quit: the kept opens are given back to be opened now
    takeBack() {
      if (armed) return [];
      return kept.splice(0).map(({ argv, cwd }) => ({ argv, cwd }));
    },
    count: () => kept.length,
  };
}

module.exports = { createReopenLater, relaunchArgs };
