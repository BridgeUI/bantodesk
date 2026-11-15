// 52b-mac: every chokidar watcher the app starts, so the quit can close them all before the app goes.
//
// On macOS chokidar watches with fsevents (a native module with a thread-safe function per watch). A watch still open
// when Electron frees the Node environment is destroyed from there (napi_release_threadsafe_function ->
// fse_instance_destroy) and the app ends with SIGABRT about 200 ms after a normal quit (PROGRESS 52b-mac). fsevents'
// stop runs on a later microtask (Promise.resolve(instance).then(Native.stop)), so the quit waits for closeAll().
//
//   const w = require('./main/watchers').track(require('chokidar'));
//   w.chokidar.watch(...)   // like chokidar.watch; the watcher is remembered until its close()
//   await w.closeAll(ms)    // closes every open one; resolves after all closed or after ms -> number still open

function track(chokidar) {
  const live = new Set();
  const watch = (...args) => {
    const w = chokidar.watch(...args);
    live.add(w);
    const close = w.close.bind(w);
    w.close = () => {
      live.delete(w);
      return close();
    };
    return w;
  };
  const closeAll = (ms = 3000) => {
    const all = [...live];
    if (!all.length) return Promise.resolve(0);
    const closing = all.map((w) => {
      try {
        return Promise.resolve(w.close()).catch(() => {});
      } catch {
        return Promise.resolve();
      }
    });
    let timer = null;
    const limit = new Promise((r) => {
      timer = setTimeout(r, ms);
    });
    const done = Promise.all(closing);
    return Promise.race([done.then(() => 0), limit.then(() => -1)]).then((r) => {
      clearTimeout(timer);
      return r === -1 ? all.length : 0;
    });
  };
  return { chokidar: { ...chokidar, watch }, closeAll, count: () => live.size };
}

module.exports = { track };
