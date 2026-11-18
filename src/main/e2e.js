// SEC2 (docs/security.md): the e2e mark and the remote debugging guard. (The SEC2b switch that kept
// the run-time compiled helpers from running is gone with SEC3: the process list and the power request are a native
// module, docs/security.md.)
//
// The e2e mark: the switch --agent-terminal-e2e or env AGENT_TERMINAL_E2E=1 (tests: tmp/dock/cdp.mjs and the other
// launchers). The user's app (stable, or dev started by hand) has neither, so its behaviour does not change.

const MARK = '--agent-terminal-e2e';

function isE2E(argv = process.argv, env = process.env) {
  return env.AGENT_TERMINAL_E2E === '1' || (argv || []).includes(MARK);
}

// --name=value or --name value -> value; --name alone -> ''; absent -> null
function switchValue(argv, name) {
  const a = argv || [];
  for (let i = 0; i < a.length; i++) {
    const s = String(a[i]);
    if (s === '--' + name) return i + 1 < a.length && !String(a[i + 1]).startsWith('-') ? String(a[i + 1]) : '';
    if (s.startsWith('--' + name + '=')) return s.slice(name.length + 3);
  }
  return null;
}

// -> null (fine) | the reason to quit. Remote debugging (a TCP port) only in an e2e app and only on 127.0.0.1.
// cl: app.commandLine (optional; also sees switches given by appendSwitch before this runs).
function remoteDebugProblem(argv = process.argv, env = process.env, cl = null) {
  let port = switchValue(argv, 'remote-debugging-port');
  let addr = switchValue(argv, 'remote-debugging-address');
  if (cl && typeof cl.hasSwitch === 'function') {
    if (port === null && cl.hasSwitch('remote-debugging-port')) port = cl.getSwitchValue('remote-debugging-port');
    if (addr === null && cl.hasSwitch('remote-debugging-address')) addr = cl.getSwitchValue('remote-debugging-address');
  }
  if (port === null) return null;
  if (!isE2E(argv, env)) return `--remote-debugging-port=${port} without the e2e mark (${MARK} / AGENT_TERMINAL_E2E=1)`;
  if (addr !== '127.0.0.1') return `--remote-debugging-port=${port} with --remote-debugging-address=${addr === null ? '(not given)' : addr} (must be 127.0.0.1)`;
  return null;
}

// An app a test started (the e2e mark) ends when that test is gone (macOS / Linux). A test runner killed hard (SIGKILL,
// a closed terminal, a time limit outside it) runs no teardown, and its electron stayed: parent PID 1, its window and
// Dock icon there until the next reboot (2026-11-13: six such mains, up to 2 h old). The test is the parent at the
// start; its PID is kept in AGENT_TERMINAL_E2E_PARENT, so an app.relaunch()ed app (Electron's relauncher is its parent)
// watches the same test. Once a second: the test's PID gone -> app.quit(), app.exit(0) 15 s later if the quit hangs.
// Not on Windows (its tests reap by the native process list; a launcher there may be a short-lived cmd.exe).
// AGENT_TERMINAL_E2E_STAY=1 turns it off. -> the PID watched, or 0 when not watching.
function watchParent(app, { argv = process.argv, env = process.env, everyMs = 1000, platform = process.platform, log = console.warn } = {}) {
  if (platform === 'win32' || !isE2E(argv, env) || env.AGENT_TERMINAL_E2E_STAY === '1') return 0;
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  };
  const kept = Number(env.AGENT_TERMINAL_E2E_PARENT);
  const pid = kept > 1 && alive(kept) ? kept : process.ppid;
  if (!(pid > 1)) return 0;
  env.AGENT_TERMINAL_E2E_PARENT = String(pid);
  const t = setInterval(() => {
    if (alive(pid)) return;
    clearInterval(t);
    log(`[e2e] the test that started this app (pid ${pid}) is gone: quitting`);
    const hard = setTimeout(() => app.exit(0), 15000);
    if (hard.unref) hard.unref();
    try {
      app.quit();
    } catch {}
  }, everyMs);
  if (t.unref) t.unref();
  return pid;
}

// AT-202 (tests only, with the e2e mark): the file <dir>/e2e-pool-hog (its text = ms) makes main keep every libuv
// thread-pool thread busy with crypto.pbkdf2 jobs for that long (a slow disk holding the pool, without a slow disk; no
// process is started). <dir>/e2e-pool-hog.json reports { startedAt, endsAt, probeMs[] }: how long a plain
// fs.promises.stat waited meanwhile (shows the pool was really held). The trigger file is looked for every 500 ms.
function watchPoolHog(dir, { everyMs = 500 } = {}) {
  if (!isE2E()) return null;
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const trigger = path.join(dir, 'e2e-pool-hog');
  const report = path.join(dir, 'e2e-pool-hog.json');
  let busyUntil = 0;
  const state = { startedAt: 0, endsAt: 0, probeMs: [] };
  const save = () => fs.writeFileSync(report, JSON.stringify(state));
  const threads = Number(process.env.UV_THREADPOOL_SIZE) || 4;
  // one job per pool thread, each about `ms` long (a stuck disk read holds its thread the whole time)
  const hold = (ms) => {
    const t0 = Date.now();
    crypto.pbkdf2Sync('x', 'y', 20000, 32, 'sha512');
    const n = Math.max(20000, Math.round((ms / Math.max(1, Date.now() - t0)) * 20000));
    let left = threads;
    for (let i = 0; i < threads; i++) crypto.pbkdf2('x', 'y' + i, n, 32, 'sha512', () => --left || ((state.freedAt = Date.now()), save()));
  };
  const probe = () => {
    if (Date.now() >= busyUntil) return;
    const t0 = Date.now();
    fs.promises.stat(dir).then(() => {
      state.probeMs.push(Date.now() - t0);
      save();
    });
    setTimeout(probe, 2000);
  };
  const t = setInterval(() => {
    if (!fs.existsSync(trigger)) return;
    let ms = 0;
    try {
      ms = Number(fs.readFileSync(trigger, 'utf8')) || 30000;
      fs.unlinkSync(trigger);
    } catch {}
    busyUntil = Date.now() + ms;
    state.startedAt = Date.now();
    state.endsAt = busyUntil;
    state.probeMs = [];
    save();
    hold(ms);
    probe();
  }, everyMs);
  if (t.unref) t.unref();
  return t;
}

// E2E-SEEN (依頼-487): an app a test started (the e2e mark) tells its windows "seen" always. A test run while the Mac's
// screen is locked / asleep (the ルーター runs e2e while the user is away) got win:seen false, <html data-unseen>, and the
// dashboard drew nothing (SCH-FR2, dashboard.js pageHidden): tmp/dash4/e2e.mjs and others failed with no app bug.
// AGENT_TERMINAL_E2E_REAL_SEEN=1 keeps the real value (tmp/sched-fresh/e2e-dash.mjs tests SCH-FR2 itself).
// The user's app (no mark) is unchanged. -> the value main sends as win:seen.
function seenFor(seen, argv = process.argv, env = process.env) {
  if (isE2E(argv, env) && env.AGENT_TERMINAL_E2E_REAL_SEEN !== '1') return true;
  return !!seen;
}

module.exports = { MARK, isE2E, switchValue, remoteDebugProblem, watchParent, watchPoolHog, seenFor };
