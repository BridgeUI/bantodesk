// IOS-SIM (docs/plan-ios-sim.md 6.1): the iOS Simulator's screen in a pane (stage 1: look only).
// Main side: the device list, the capture loop (xcrun's `simctl io <UDID> screenshot` into <userData>/simframes), boot / shutdown
// only when the pane's buttons ask, "open in Simulator", and handing the current picture to the folder (.bantodesk/sim/).
//
// What EDR sees (plan 9): Apple's own simctl, started by execFile with an array (no shell), a 10 s timeout on every call,
// by its absolute path fixed once from `xcrun -f simctl` and checked to lie under Xcode / CommandLineTools (DEVELOPER_DIR of
// the environment is never trusted), one device named by a UUID-shaped UDID (never `booted`). No other process is read or
// touched. Starts are few: one picture at a time (~2.5 fps), slower when the picture does not change, two at a time only for
// 10 s after the pane was clicked, never more than 240 starts a minute, nothing while the pane is not seen.
const path = require('path');
const fs = require('fs');
const { execFile: nodeExecFile } = require('child_process');

const TIMEOUT_MS = 10_000;
const MAX_STARTS_PER_MIN = 240;
const ACTIVE_MS = 10_000; // two pictures in flight only this long after a click / an operation
const SAME_SLOW_AFTER = 5; // the same picture 5 times in a row -> one a second
const SAME_SLOWER_MS = 30_000; // the same picture for 30 s -> one every 3 s
const RING = 8;
const UDID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const SIMCTL_OK = [
  /^\/Applications\/Xcode[^/]*\.app\/Contents\/Developer\/usr\/bin\/simctl$/,
  /^\/Library\/Developer\/CommandLineTools\/usr\/bin\/simctl$/,
];
const SIMULATOR_BUNDLE = 'com.apple.iphonesimulator';

const isUdid = (s) => typeof s === 'string' && UDID_RE.test(s);
const simctlPathOk = (p) => typeof p === 'string' && !p.includes('..') && SIMCTL_OK.some((re) => re.test(p));

// Interval (ms between two starts of one worker): 0 = back to back.
// sameCount = pictures in a row equal to the one before, sameForMs = how long the picture has not changed.
function intervalFor({ sameCount = 0, sameForMs = 0, active = false } = {}) {
  if (active) return 0;
  if (sameForMs >= SAME_SLOWER_MS) return 3000;
  if (sameCount >= SAME_SLOW_AFTER) return 1000;
  return 0;
}

// at most `max` starts in a sliding `windowMs`
function makeLimiter({ max = MAX_STARTS_PER_MIN, windowMs = 60_000 } = {}) {
  const times = [];
  const trim = (now) => {
    while (times.length && now - times[0] >= windowMs) times.shift();
  };
  return {
    // -> 0 when a start is allowed now (and counted), else ms until the next free slot
    take(now, { count = true } = {}) {
      trim(now);
      if (times.length >= max) return Math.max(1, windowMs - (now - times[0]));
      if (count) times.push(now);
      return 0;
    },
    count: (now) => (trim(now), times.length),
    note(now) {
      trim(now);
      times.push(now);
    },
  };
}

// the simctl to use: xcrun -f simctl, from an environment without DEVELOPER_DIR, then checked and fixed
function resolveSimctl({ execFile = nodeExecFile, platform = process.platform, exists = fs.existsSync, realpath = fs.realpathSync } = {}) {
  return new Promise((resolve) => {
    if (platform !== 'darwin') return resolve(null);
    const env = { ...process.env };
    delete env.DEVELOPER_DIR;
    try {
      execFile('/usr/bin/xcrun', ['-f', 'simctl'], { timeout: TIMEOUT_MS, env, encoding: 'utf8' }, (err, out) => {
        if (err) return resolve(null);
        const p = String(out || '').trim();
        try {
          const real = exists(p) ? realpath(p) : '';
          resolve(simctlPathOk(p) && simctlPathOk(real) ? p : null);
        } catch {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

function parseDevices(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return [];
  }
  const out = [];
  for (const [runtime, list] of Object.entries((j && j.devices) || {})) {
    for (const d of Array.isArray(list) ? list : []) {
      if (!d || !isUdid(d.udid) || d.isAvailable === false) continue;
      out.push({ udid: d.udid.toUpperCase(), name: String(d.name || ''), state: String(d.state || ''), runtime: runtime.replace(/^.*SimRuntime\./, '').replace(/-/g, '.') });
    }
  }
  const rank = (s) => (s === 'Booted' ? 0 : s === 'Booting' ? 1 : 2);
  return out.sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));
}

function create({ ipcMain, userData, workDirOf, execFile = nodeExecFile, platform = process.platform, now = () => Date.now(), resolve = resolveSimctl, maxStarts = MAX_STARTS_PER_MIN }) {
  let simctl = null; // string | null (null = none, also before the first look)
  const limiter = makeLimiter({ max: maxStarts });
  const children = new Set();
  const sessions = new Map(); // `${wcId}:${panelId}` -> session
  const framesDirNow = () => path.join(typeof userData === 'function' ? userData() : userData, 'simframes');
  let framesDir = '';
  const stats = { starts: 0, kills: 0 };

  // one lookup at a time (the promise is shared); a failure is looked up again after a minute, not forever
  let findP = null;
  function find() {
    if (!findP) {
      findP = Promise.resolve(resolve({ execFile, platform })).then((p) => {
        simctl = p || null;
        if (!simctl) setTimeout(() => (findP = null), 60_000).unref?.();
        return simctl;
      });
    }
    return findP;
  }

  function run(args, { cmd = null, timeout = TIMEOUT_MS } = {}) {
    return new Promise((res) => {
      const bin = cmd || simctl;
      if (!bin) return res({ code: 127, stdout: '', stderr: 'no simctl' });
      limiter.note(now());
      stats.starts++;
      const env = { ...process.env };
      if (!cmd) env.DEVELOPER_DIR = bin.replace(/\/usr\/bin\/simctl$/, '');
      let child;
      try {
        child = execFile(bin, args, { timeout, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
          children.delete(child);
          res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut: !!(err && err.killed) });
        });
        children.add(child);
      } catch (e) {
        res({ code: 1, stdout: '', stderr: String(e && e.message) });
      }
    });
  }

  // the list is reused for 1.5 s (tab switches, attach checks); boot / shutdown clear it
  let listCache = null;
  async function list() {
    if (!(await find())) return { ok: false, reason: 'nosimctl', devices: [] };
    if (listCache && now() - listCache.at < 1500) return listCache.r;
    const r = await run(['list', 'devices', 'available', '-j']);
    if (r.code !== 0) return { ok: false, reason: 'list', devices: [] };
    const res = { ok: true, devices: parseDevices(r.stdout) };
    listCache = { at: now(), r: res };
    return res;
  }

  const stateOf = async (udid) => (await list()).devices.find((d) => d.udid === udid.toUpperCase())?.state || null;

  // ---- the capture loop of one pane ----
  const wake = (s) => {
    const w = s.waiters.splice(0);
    for (const f of w) f();
  };
  const sleep = (s, ms) => new Promise((res) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      const i = s.waiters.indexOf(done);
      if (i >= 0) s.waiters.splice(i, 1);
      res();
    }
    s.waiters.push(done);
  });
  const seeing = (s) => s.running && s.visible && !s.paused;
  const isActive = (s) => now() < s.activeUntil;

  async function worker(s, idx) {
    while (s.running) {
      if (s.wc.isDestroyed()) {
        closeOne(s.key);
        break;
      }
      if (!seeing(s) || (idx === 1 && !isActive(s))) {
        await sleep(s, idx === 1 ? 500 : 60_000);
        continue;
      }
      const wait = limiter.take(now(), { count: false });
      if (wait) {
        await sleep(s, Math.max(1000, wait)); // at the cap: not faster than one a second
        continue;
      }
      const t0 = now();
      const seq = ++s.seq;
      const file = path.join(framesDir, `${s.key.replace(/[^\w-]/g, '_')}-${seq % RING}.jpg`);
      const r = await run(['io', s.udid, 'screenshot', '--type=jpeg', file]);
      if (!s.running) {
        // closed while this one was in flight: the killed simctl may have written the file just before it died
        try {
          fs.rmSync(file, { force: true });
        } catch {}
        break;
      }
      let buf = null;
      if (r.code === 0) {
        try {
          buf = fs.readFileSync(file);
        } catch {}
      }
      if (!buf || !buf.length) {
        s.errors++;
        await sleep(s, [500, 1000, 3000][s.errors - 1] || 10_000); // never straight again
        if (s.errors >= 3 && s.running) {
          listCache = null;
          if ((await stateOf(s.udid)) !== 'Booted') {
            send(s, 'sim:state', { id: s.id, error: 'capture', stopped: true });
            closeOne(s.key);
            break;
          }
          send(s, 'sim:state', { id: s.id, error: 'capture' });
        }
        continue;
      }
      s.errors = 0;
      if (seq > s.sentSeq) {
        const same = s.last && s.last.equals(buf);
        if (same) {
          s.sameCount++;
        } else {
          s.sameCount = 0;
          s.changedAt = now();
          s.last = buf;
          s.sentSeq = seq;
          s.frames++;
          send(s, 'sim:frame', { id: s.id, jpeg: buf, seq, capMs: now() - t0 });
        }
      }
      const gap = intervalFor({ sameCount: s.sameCount, sameForMs: now() - s.changedAt, active: isActive(s) });
      const left = gap - (now() - t0);
      if (left > 0) await sleep(s, left);
    }
  }

  function send(s, ch, payload) {
    try {
      if (!s.wc.isDestroyed()) s.wc.send(ch, payload);
    } catch {}
  }

  function stop(key) {
    const s = sessions.get(key);
    if (!s) return;
    sessions.delete(key);
    s.running = false;
    wake(s);
    const clean = () => {
      for (let i = 0; framesDir && i < RING; i++) {
        try {
          fs.rmSync(path.join(framesDir, `${s.key.replace(/[^\w-]/g, '_')}-${i}.jpg`), { force: true });
        } catch {}
      }
    };
    clean();
    // a killed simctl's request can still be written by the simulator service a moment later: once more, unless the pane came back
    setTimeout(() => !sessions.has(s.key) && clean(), 2000).unref?.();
    s.last = null;
  }

  const attachGen = new Map();
  async function attach(wc, id, udid, flags = {}) {
    if (!(await find())) return { ok: false, reason: 'nosimctl' };
    if (typeof id !== 'string' || !/^[\w-]{1,40}$/.test(id) || !isUdid(udid)) return { ok: false, reason: 'bad' };
    udid = udid.toUpperCase();
    const key = `${wc.id}:${id}`;
    stop(key);
    const gen = (attachGen.get(key) || 0) + 1;
    attachGen.set(key, gen);
    const st = await stateOf(udid);
    if (attachGen.get(key) !== gen || wc.isDestroyed()) return { ok: false, reason: 'superseded' }; // a newer attach / the window left
    if (st !== 'Booted') return { ok: false, reason: st ? 'notbooted' : 'nodevice', state: st };
    stop(key);
    try {
      framesDir = framesDirNow();
      fs.mkdirSync(framesDir, { recursive: true });
    } catch {}
    const s = { key, id, wc, udid, running: true, visible: flags.visible !== false, paused: !!flags.paused, seq: 0, sentSeq: 0, last: null, sameCount: 0, changedAt: now(), activeUntil: now() + ACTIVE_MS, errors: 0, frames: 0, waiters: [] };
    sessions.set(key, s);
    worker(s, 0);
    worker(s, 1);
    return { ok: true };
  }

  // children are tracked globally by run(); a closing pane kills the ones of its device's screenshots
  function killKidsOf(udid) {
    for (const c of children) {
      if (Array.isArray(c.spawnargs) && c.spawnargs.includes(udid) && c.spawnargs.includes('screenshot')) {
        try {
          c.kill('SIGTERM');
          stats.kills++;
        } catch {}
        children.delete(c); // the exit callback also deletes it; not waiting for it keeps "no child left" true at once
      }
    }
  }
  const closeOne = (key) => {
    const s = sessions.get(key);
    if (!s) return;
    const udid = s.udid;
    stop(key);
    killKidsOf(udid);
  };
  const windowGone = (wcId) => {
    for (const k of [...sessions.keys()]) if (k.startsWith(`${wcId}:`)) closeOne(k);
  };
  const stopAll = () => {
    for (const k of [...sessions.keys()]) closeOne(k);
    for (const c of children) {
      try {
        c.kill('SIGTERM');
      } catch {}
      children.delete(c);
    }
  };

  const sessionOf = (e, id) => sessions.get(`${e.sender.id}:${id}`);

  function init() {
    ipcMain.handle('sim:available', async () => ({ ok: !!(await find()) }));
    ipcMain.handle('sim:list', () => list());
    ipcMain.handle('sim:attach', (e, o) => attach(e.sender, o && o.id, o && o.udid, { visible: o && o.visible, paused: o && o.paused }).catch(() => ({ ok: false, reason: 'error' })));
    ipcMain.on('sim:detach', (e, o) => o && typeof o.id === 'string' && closeOne(`${e.sender.id}:${o.id}`));
    ipcMain.on('sim:visible', (e, o) => {
      const s = o && sessionOf(e, o.id);
      if (!s) return;
      const was = s.visible;
      s.visible = !!o.visible;
      if (s.visible && !was) wake(s);
    });
    ipcMain.on('sim:paused', (e, o) => {
      const s = o && sessionOf(e, o.id);
      if (!s) return;
      const was = s.paused;
      s.paused = !!o.paused;
      if (was && !s.paused) wake(s);
    });
    ipcMain.on('sim:activity', (e, o) => {
      const s = o && sessionOf(e, o.id);
      if (!s) return;
      s.activeUntil = now() + ACTIVE_MS;
      s.sameCount = 0;
      s.changedAt = now();
      wake(s);
    });
    // boot / shutdown: only when the pane's button asks, one device named by its UDID, only from the state it needs
    ipcMain.handle('sim:boot', async (e, o) => {
      if (!isUdid(o && o.udid)) return { ok: false, reason: 'bad' };
      const udid = o.udid.toUpperCase();
      if ((await stateOf(udid)) !== 'Shutdown') return { ok: false, reason: 'state' };
      const r = await run(['boot', udid]);
      listCache = null;
      return { ok: r.code === 0, timedOut: !!r.timedOut, reason: r.code === 0 ? '' : 'boot' };
    });
    ipcMain.handle('sim:shutdown', async (e, o) => {
      if (!isUdid(o && o.udid)) return { ok: false, reason: 'bad' };
      const udid = o.udid.toUpperCase();
      for (const k of [...sessions.keys()]) if (sessions.get(k).udid === udid) closeOne(k);
      if ((await stateOf(udid)) !== 'Booted') return { ok: false, reason: 'state' };
      const r = await run(['shutdown', udid]);
      listCache = null;
      return { ok: r.code === 0, reason: r.code === 0 ? '' : 'shutdown' };
    });
    // the real window: `open -b <bundle id>` (by id: a name search could find another app)
    ipcMain.handle('sim:openApp', async (e, o) => {
      if (!isUdid(o && o.udid)) return { ok: false, reason: 'bad' };
      const r = await run(['-b', SIMULATOR_BUNDLE, '--args', '-CurrentDeviceUDID', o.udid.toUpperCase()], { cmd: '/usr/bin/open' });
      const s = o.id && sessionOf(e, o.id);
      if (s) {
        s.activeUntil = now() + ACTIVE_MS;
        wake(s);
      }
      return { ok: r.code === 0 };
    });
    // the current picture -> <folder>/.bantodesk/sim/<time>.jpg (the .bantodesk folder keeps its own .gitignore = "*")
    ipcMain.handle('sim:save', (e, o) => {
      const s = o && sessionOf(e, o.id);
      const wd = workDirOf && workDirOf(e);
      if (!s || !s.last) return { ok: false, reason: 'noframe' };
      if (!wd) return { ok: false, reason: 'nofolder' };
      try {
        const base = path.join(wd, '.bantodesk');
        const dir = path.join(base, 'sim');
        fs.mkdirSync(dir, { recursive: true });
        const gi = path.join(base, '.gitignore');
        if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
        const d = new Date(now());
        const p2 = (n) => String(n).padStart(2, '0');
        const name = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}.jpg`;
        const file = path.join(dir, name);
        fs.writeFileSync(file, s.last);
        return { ok: true, path: file };
      } catch (err) {
        return { ok: false, reason: 'write' };
      }
    });
    // tests only: what the loops did (counts, no paths)
    ipcMain.handle('sim:stats', () => ({ starts: stats.starts, kills: stats.kills, sessions: sessions.size, children: children.size, perMin: limiter.count(now()) }));
  }

  return { init, list, attach, windowGone, stopAll, find, closeOne, _sessions: sessions, _children: children, _limiter: limiter };
}

module.exports = {
  create, intervalFor, makeLimiter, resolveSimctl, parseDevices, isUdid, simctlPathOk,
  TIMEOUT_MS, MAX_STARTS_PER_MIN, ACTIVE_MS, SAME_SLOW_AFTER, SAME_SLOWER_MS, RING, SIMULATOR_BUNDLE,
};
