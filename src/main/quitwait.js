// The quit's waits in will-quit (src/main.js): the handler calls preventDefault, waits, then quits again.
//
// 52b-mac2: the app.quit() after the waits runs on a later task (setImmediate), never from inside the will-quit
// dispatch. When every wait had already settled (no terminal yet, file watchers whose close resolves at once: a quit
// in the first seconds after the start), the .then() ran as a microtask while Electron was still emitting will-quit:
// Browser::Quit saw the quit still in progress and returned, then the preventDefault reset it, and nothing quit again.
// The app stayed with no window and its SIGTERM did nothing more (tests needed SIGKILL).
// The deadline: if the app is still there deadlineMs after the waits began (a quit cancelled again, or a wait that
// never settles), app.exit(0).
//
//   waitThenQuit(app, [p1, p2, …], { deadlineMs: 20000, log })
function waitThenQuit(app, waits, { deadlineMs = 20000, log = () => {} } = {}) {
  const deadline = setTimeout(() => {
    log(`quit: still running ${deadlineMs} ms after will-quit; exiting`);
    app.exit(0);
  }, deadlineMs);
  deadline.unref?.();
  Promise.allSettled(waits.filter(Boolean)).then(() => setImmediate(() => app.quit()));
  return deadline;
}

module.exports = { waitThenQuit };
