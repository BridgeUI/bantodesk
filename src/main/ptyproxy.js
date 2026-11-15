'use strict';
// Main-side handle of a terminal that runs in the pty host (src/main/ptyhost.js, an Electron utilityProcess with one
// worker thread per live terminal). spawn() returns at once with an object shaped like node-pty's IPty for what
// main.js uses: pid (undefined until the host answers), write, resize, kill, onData, onExit, plus `ready`
// (Promise<pid | undefined>) and `spawnMs`. The main process no longer waits for ConPTY / CreateProcess
// (1-9 s per start on this PC; docs/perf.md 結論 1, 案 1).
//
// Order: every message to the host goes through one port and the host handles them in order, so a write / kill sent
// right after spawn() reaches that terminal (or is dropped when it already ended), like with node-pty in main.
// The host gone (crash): each of its terminals ends with exitCode -1 (the tab shows it ended); the next spawn() starts
// a new host. AGENT_TERMINAL_PTY_INPROC=1, or no utilityProcess (plain Node): node-pty in this process, as before.
const path = require('path');

const HOST_FILE = path.join(__dirname, 'ptyhost.js');

let host = null; // { child, terms: Map<key, HostedPty>, waiters: Map<key, fn> }
let seq = 0;
let onHostStart = null; // (pid) => void: orphans.js records the host like a main (its children are ours)

class HostedPty {
  constructor(key) {
    this.key = key;
    this.pid = undefined;
    this.spawnMs = undefined;
    this.exited = null; // { exitCode, signal } once ended
    this._data = new Set();
    this._exit = new Set();
    this.ready = new Promise((r) => (this._ready = r));
  }
  _post(m) {
    if (this.exited || !this._host || this._host !== host) return;
    try {
      this._host.child.postMessage({ ...m, key: this.key });
    } catch {}
  }
  write(data) {
    this._post({ t: 'write', data: String(data) });
  }
  resize(cols, rows) {
    this._post({ t: 'resize', cols, rows });
  }
  kill() {
    this._post({ t: 'kill' });
  }
  onData(cb) {
    this._data.add(cb);
    return { dispose: () => this._data.delete(cb) };
  }
  // Also when it has already ended (an exit can arrive between a lookup and the listener): called on the next tick.
  onExit(cb) {
    if (this.exited) {
      const e = this.exited;
      setImmediate(() => cb(e));
      return { dispose() {} };
    }
    this._exit.add(cb);
    return { dispose: () => this._exit.delete(cb) };
  }
  _spawned(pid, ms) {
    this.pid = pid;
    this.spawnMs = ms;
    this._ready(pid);
  }
  _gotData(data) {
    for (const cb of this._data) {
      try {
        cb(data);
      } catch (err) {
        console.error('[ptyproxy] onData listener', err);
      }
    }
  }
  _ended(exitCode, signal, error) {
    if (this.exited) return;
    this.exited = { exitCode, signal };
    if (error) console.warn('[ptyproxy] pty ended:', error);
    this._ready(this.pid);
    for (const cb of [...this._exit]) {
      try {
        cb(this.exited);
      } catch (err) {
        console.error('[ptyproxy] onExit listener', err);
      }
    }
    this._exit.clear();
    this._data.clear();
  }
}

function startHost() {
  const { utilityProcess } = require('electron');
  if (!utilityProcess || typeof utilityProcess.fork !== 'function') return null;
  const child = utilityProcess.fork(HOST_FILE, [], { serviceName: 'BantoDesk pty host', stdio: 'inherit' });
  const h = { child, terms: new Map(), waiters: new Map(), drained: new Set() };
  // shutdown(): told whenever a terminal ends (it resolves once terms is empty)
  const ended = () => {
    for (const fn of [...h.drained]) fn();
  };
  child.on('spawn', () => {
    try {
      onHostStart?.(child.pid);
    } catch {}
  });
  child.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'killedAll') {
      const done = h.waiters.get(m.key);
      h.waiters.delete(m.key);
      if (done) done();
      return;
    }
    const p = h.terms.get(m.key);
    if (!p) return;
    if (m.t === 'data') p._gotData(m.data);
    else if (m.t === 'spawned') p._spawned(m.pid, m.ms);
    else if (m.t === 'exit') {
      h.terms.delete(m.key);
      p._ended(m.exitCode, m.signal, m.error);
      ended();
    }
  });
  child.on('exit', (code) => {
    if (host === h) host = null;
    if (h.terms.size) console.warn(`[ptyproxy] pty host exited (${code}) with ${h.terms.size} terminal(s)`);
    for (const p of h.terms.values()) p._ended(-1, undefined, `pty host exited ${code}`);
    h.terms.clear();
    for (const done of h.waiters.values()) done();
    h.waiters.clear();
    ended();
  });
  return h;
}

const inProc = () => process.env.AGENT_TERMINAL_PTY_INPROC === '1';

// spawn(file, args, opts) -> HostedPty (or a node-pty IPty in process when the host cannot be used)
function spawn(file, args, opts) {
  if (!inProc()) {
    try {
      if (!host) host = startHost();
    } catch (err) {
      console.warn('[ptyproxy] pty host did not start, node-pty in main', err);
      host = null;
    }
  }
  if (!host) return spawnInProc(file, args, opts);
  const p = new HostedPty(++seq);
  p._host = host;
  host.terms.set(p.key, p);
  try {
    host.child.postMessage({ t: 'spawn', key: p.key, file, args, opts });
  } catch (err) {
    host.terms.delete(p.key);
    setImmediate(() => p._ended(-1, undefined, `spawn not sent: ${err && err.message}`));
  }
  return p;
}

const inproc = new Set(); // node-pty terminals in this process (no host) that have not ended
function spawnInProc(file, args, opts) {
  const t = require('node-pty').spawn(file, args, opts);
  t.ready = Promise.resolve(t.pid);
  inproc.add(t);
  t.onExit(() => inproc.delete(t));
  return t;
}

// The kill of main.js killPty / ptyworker.js killTerm: no conpty_console_list_agent start (node-pty 1.1.x internals).
// Once only: node-pty's kill calls ClosePseudoConsole on the same console again until the exit came (conpty.cc PtyKill
// keeps the handle), and a second close of a console being closed corrupted the heap (0xC0000374, 52b).
function killInProc(t) {
  if (t._atKilled) return;
  t._atKilled = true;
  try {
    const ag = t._agent;
    if (ag && typeof ag._getConsoleProcessList === 'function') ag._getConsoleProcessList = () => Promise.resolve(ag._innerPid ? [ag._innerPid] : []);
  } catch {}
  try {
    t.kill();
  } catch {}
}

// Before the app quits (will-quit): kill every live terminal and wait (≤ timeoutMs) until each one's exit has come
// back, so no claude outlives the app with its kill still queued, and no shell's exit reaches node-pty while Node is
// being torn down (the 0xC0000409 abort and the 8-40 s hang of docs/exit-crash.md). -> Promise<number> terminals
// still running when it gave up (0: all ended).
function shutdown(timeoutMs = 3000) {
  const h = host && host.terms.size ? host : null;
  const live = () => (h ? h.terms.size : 0) + inproc.size;
  if (!live()) return Promise.resolve(0);
  return new Promise((resolve) => {
    let timer = null;
    const check = () => {
      if (live()) return;
      finish();
    };
    const finish = () => {
      clearTimeout(timer);
      if (h) h.drained.delete(check);
      resolve(live());
    };
    timer = setTimeout(finish, timeoutMs);
    if (h) {
      h.drained.add(check);
      try {
        h.child.postMessage({ t: 'killAll', key: ++seq });
      } catch {}
    }
    for (const t of [...inproc]) {
      t.onExit(() => setImmediate(check)); // after spawnInProc's own listener has taken it out
      killInProc(t);
    }
    check();
  });
}

// Start the host ahead (app ready): its own start is an electron.exe start (2-7 s on this PC, off the main thread), so
// the first tab does not wait for it.
function warm() {
  if (inProc() || host) return;
  try {
    host = startHost();
  } catch (err) {
    console.warn('[ptyproxy] pty host did not start', err);
    host = null;
  }
}

const liveCount = () => (host ? host.terms.size : 0) + inproc.size;
const hostPid = () => (host && host.child ? host.child.pid : undefined);
function setOnHostStart(fn) {
  onHostStart = fn;
}

module.exports = { spawn, warm, shutdown, liveCount, hostPid, setOnHostStart, HostedPty };
