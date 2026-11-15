'use strict';
// pty host: runs in an Electron utilityProcess (src/main/ptyproxy.js starts it) and owns node-pty for the app's tabs.
// Why: node-pty's spawn (ConPTY + CreateProcess) blocks the calling thread 1-3 s per start on this PC (claude.exe
// 2.9-9.0 s, endpoint protection), and in the main process that froze every window, the dashboard and the widget
// (docs/perf.md 結論 1). This thread only routes; each terminal lives in a worker thread (src/main/ptyworker.js), so a
// start blocks one worker, not the other tabs' output. A separate process (not workers in main): a node-pty fault
// cannot take main down, and at quit Electron ends this process, no Node teardown with live terminals in main
// (tmp/perf1/pty-worker-probe.js; docs/perf.md 案 1).
//
// Messages from main (one parentPort, handled in order, so a write / kill sent after a spawn reaches that pty):
//   { t: 'spawn', key, file, args, opts }   -> { t: 'spawned', key, pid, ms } | { t: 'exit', key, exitCode: -1, error }
//   { t: 'write', key, data } / { t: 'resize', key, cols, rows } / { t: 'kill', key }
//   { t: 'killAll', key }                    -> { t: 'killedAll', key } (every terminal's kill sent; before the app quits)
// To main: { t: 'data', key, data }, { t: 'exit', key, exitCode, signal }.
// key: a number main gives each start (a tab id can be started again after a restart / reload).
const path = require('path');
const { Worker } = require('worker_threads');

const port = process.parentPort;
const MAX_WORKERS = 16;
const workers = []; // { w, live: Set<key>, spawning: number }
const owner = new Map(); // key -> worker entry

const post = (m) => {
  try {
    port.postMessage(m);
  } catch {}
};

function newWorker() {
  const entry = { w: null, live: new Set(), starting: new Set(), waiters: new Map() };
  const w = new Worker(path.join(__dirname, 'ptyworker.js'));
  entry.w = w;
  w.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'killedAll') {
      const done = entry.waiters.get(m.key);
      entry.waiters.delete(m.key);
      if (done) done();
      return;
    }
    if (m.t === 'spawned') entry.starting.delete(m.key);
    if (m.t === 'exit') {
      if (!entry.live.has(m.key)) return;
      entry.starting.delete(m.key); // a failed spawn ends with an exit and no spawned
      entry.live.delete(m.key);
      owner.delete(m.key);
    }
    post(m);
  });
  const gone = (why) => {
    const i = workers.indexOf(entry);
    if (i < 0) return;
    workers.splice(i, 1);
    for (const key of entry.live) {
      owner.delete(key);
      post({ t: 'exit', key, exitCode: -1, error: `pty worker ${why}` });
    }
    entry.live.clear();
    entry.starting.clear();
    for (const done of entry.waiters.values()) done();
    entry.waiters.clear();
  };
  w.on('error', (err) => gone(`error: ${(err && err.message) || err}`));
  w.on('exit', (code) => gone(`exited ${code}`));
  workers.push(entry);
  return entry;
}

// A worker that is not starting anything and has no terminal (its start would stall nobody); else a new one; at the
// cap, the least loaded one that is not starting.
function pickWorker() {
  const free = workers.find((e) => !e.live.size);
  if (free) return free;
  if (workers.length < MAX_WORKERS) return newWorker();
  const idle = workers.filter((e) => !e.starting.size);
  const pool = idle.length ? idle : workers;
  return pool.reduce((a, b) => (b.live.size < a.live.size ? b : a));
}

port.on('message', (e) => {
  const m = e && e.data;
  if (!m || typeof m !== 'object') return;
  if (m.t === 'spawn') {
    let entry;
    try {
      entry = pickWorker();
    } catch (err) {
      post({ t: 'exit', key: m.key, exitCode: -1, error: `pty worker: ${(err && err.message) || err}` });
      return;
    }
    entry.live.add(m.key);
    entry.starting.add(m.key);
    owner.set(m.key, entry);
    entry.w.postMessage(m);
    return;
  }
  if (m.t === 'killAll') {
    const all = workers.map(
      (entry) =>
        new Promise((resolve) => {
          entry.waiters.set(m.key, resolve);
          entry.w.postMessage({ t: 'killAll', key: m.key });
        }),
    );
    Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, 1500))]).then(() => post({ t: 'killedAll', key: m.key }));
    return;
  }
  const entry = owner.get(m.key);
  if (entry) entry.w.postMessage(m);
});
