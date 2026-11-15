// execFile on a worker thread. Starting a process (CreateProcess) blocks the calling thread ~300 ms on Windows PCs
// with endpoint protection (powershell.exe; electron.exe ~1 s), and in the main process that froze every window, the
// dashboard and the widget (docs/memory-investigation.md "タブを閉じると一瞬固まる"). The worker pays that time
// instead. No Electron imports. When the worker cannot start or dies, the call falls back to execFile here.
const { execFile } = require('child_process');

// out.split (optional, a string or a RegExp source given as { re }): the stdout is split on the worker and returned
// as `lines` (stdout is then ''), so main never holds or splits the whole output (git ls-files: up to 64 MB).
const shape = (err, stdout, stderr, out) => {
  const r = { err: err ? { message: err.message, code: err.code, killed: !!err.killed } : null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
  if (out && out.split != null) {
    const sep = typeof out.split === 'string' ? out.split : new RegExp(out.split.re);
    r.lines = r.stdout ? r.stdout.split(sep) : [];
    r.stdout = '';
  }
  return r;
};

const WORKER_SRC = `
const { parentPort } = require('worker_threads');
const { execFile } = require('child_process');
const shape = ${shape.toString()};
parentPort.on('message', ({ id, file, args, opts, out }) => {
  execFile(file, args, opts, (err, stdout, stderr) => {
    parentPort.postMessage({ id, ...shape(err, stdout, stderr, out) });
  });
});`;

let worker = null;
let seq = 0;
const pending = new Map(); // id -> resolve

function getWorker() {
  if (worker) return worker;
  try {
    const { Worker } = require('worker_threads');
    const w = new Worker(WORKER_SRC, { eval: true });
    w.on('message', ({ id, ...res }) => {
      const done = pending.get(id);
      pending.delete(id);
      if (!pending.size) w.unref(); // idle: never keeps the process alive (unref after the listeners are attached)
      if (done) done(res);
    });
    const fail = (e) => {
      if (worker === w) worker = null;
      for (const done of pending.values()) done({ err: { message: `worker: ${e?.message || e}` }, stdout: '', stderr: '' }); // no `lines`: callers treat err first
      pending.clear();
    };
    w.on('error', fail);
    w.on('exit', (code) => fail(`exited ${code}`));
    w.unref();
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

// -> Promise<{ err: null | { message, code, killed }, stdout, stderr, lines? }> (never rejects). opts must be cloneable.
// out (optional): { split: '\0' } or { split: { re: '\\r?\\n' } } -> `lines` (string[]) instead of stdout.
function execFileOff(file, args, opts = {}, out = null) {
  const w = getWorker();
  if (!w) {
    return new Promise((resolve) => {
      execFile(file, args, opts, (err, stdout, stderr) => resolve(shape(err, stdout, stderr, out)));
    });
  }
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    w.ref(); // a pending call keeps the process alive, like execFile would
    w.postMessage({ id, file, args, opts, out });
  });
}

module.exports = { execFileOff };
