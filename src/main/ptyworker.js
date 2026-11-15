'use strict';
// A worker thread of the pty host (src/main/ptyhost.js): owns some node-pty terminals. The spawn (ConPTY +
// CreateProcess, 1-9 s on this PC) blocks only this thread, so other tabs' output / input go on in the other workers
// and the host thread keeps routing. Workers are reused and never torn down: tearing down a Node environment while
// node-pty can still deliver an exit is the abort of docs/exit-crash.md; the host process just ends with the app.
// Protocol: the same messages as ptyhost.js (spawn / write / resize / kill in, spawned / data / exit out).
const { parentPort } = require('worker_threads');
const pty = require('node-pty');

const terms = new Map(); // key -> IPty
const post = (m) => {
  try {
    parentPort.postMessage(m);
  } catch {}
};

// node-pty's kill() on Windows first forks conpty_console_list_agent (another electron.exe) to list the console's
// processes; the agent started after the console was closed and only ever listed the root pid. Same result without
// the start: kill the root pid at once; ClosePseudoConsole ends the console's other processes
// (docs/memory-investigation.md "タブを閉じると一瞬固まる"; node-pty 1.1.x internals, plain kill() when missing).
// Once per terminal: a kill at the tab's close and the killAll before the quit must not both reach node-pty, whose kill
// calls ClosePseudoConsole on the same console again until the exit came (conpty.cc PtyKill; 52b, docs/exit-crash.md).
function killTerm(t) {
  if (t._atKilled) return;
  t._atKilled = true;
  try {
    const ag = t._agent;
    if (ag && typeof ag._getConsoleProcessList === 'function') {
      ag._getConsoleProcessList = () => Promise.resolve(ag._innerPid ? [ag._innerPid] : []);
    }
  } catch {}
  try {
    t.kill();
  } catch {}
}

parentPort.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  const { key } = m;
  switch (m.t) {
    case 'spawn': {
      const t0 = Date.now();
      let t;
      try {
        t = pty.spawn(m.file, m.args, m.opts);
      } catch (err) {
        post({ t: 'exit', key, exitCode: -1, error: String((err && err.message) || err) });
        return;
      }
      terms.set(key, t);
      post({ t: 'spawned', key, pid: t.pid, ms: Date.now() - t0 });
      t.onData((data) => post({ t: 'data', key, data }));
      t.onExit(({ exitCode, signal }) => {
        terms.delete(key);
        post({ t: 'exit', key, exitCode, signal });
      });
      break;
    }
    case 'write':
      try {
        terms.get(key)?.write(m.data);
      } catch {}
      break;
    case 'resize':
      try {
        terms.get(key)?.resize(m.cols, m.rows);
      } catch {}
      break;
    case 'kill': {
      const t = terms.get(key);
      if (t) killTerm(t);
      break;
    }
    case 'killAll':
      for (const t of terms.values()) killTerm(t);
      post({ t: 'killedAll', key });
      break;
  }
});
