// Automatic restart after `npm run release` (2026-11-03), with an update hold (PROGRESS 34, 2026-11-04).
// No other Electron imports than what the caller passes in, so the decision logic is testable from plain Node.
//
// scripts/release.js writes <appRoot>/RELEASE.json = { released, build, commit, ... } last. A running
// app watches that file; when the version differs from the one it started with, an update is reserved:
//   1. every window is told (send('app:update', status)) and holds its queue: no backlog item starts, no session
//      is created for a routed item (renderer.js); items already running go on to the end,
//   2. once no window has a working session for IDLE_MS (windows report it via power:busy) it restarts,
//   3. if that does not happen within the hold limit (setting 更新の待ち, default 30 min, windows report it as
//      holdMin) or the user presses 「今すぐ更新」, it restarts as soon as every session is between turns
//      (gap: not answering, no dialog, no running subagent / member; also reported via power:busy) for GAP_MS.
//      Then status.resume = true: the windows mark their running backlog items so that after the restart they
//      continue in the same tab (--resume + 「再起動しました。作業を続けてください」) instead of starting over,
//   4. records the open folders in <userData>/reopen.json, closes the windows normally (so their
//      beforeunload saves run) and relaunches itself.
// 「後で」 (postpone) drops the reservation: the queues run again, no restart until 「今すぐ更新」 or a newer release.
// On the next start, takeReopen() returns those folders (once) so main opens them all again; the tabs
// come back through the saved sessions (--resume). The new process runs the new version, so nothing holds.
//
// Status (app:update payload and status()): { state: 'none'|'pending'|'postponed'|'restarting', version, startVersion,
//   since (ms, reserved at), deadline (ms), force (deadline passed or 今すぐ更新: waiting for a turn gap), resume, busy (windows working),
//   blocked (windows not between turns) }. state 'pending' = the queues hold.
const fs = require('fs');
const path = require('path');

const IDLE_MS = 10_000;
const GAP_MS = 2_000;
const CHECK_MS = 2_000;
const HOLD_MIN_DEFAULT = 30;

function readVersion(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 'build' changes on every release (scripts/release.js); 'released' as a fallback
    const v = j && (j.build || j.released);
    return v ? String(v) : null;
  } catch {
    return null;
  }
}

const holdMinOf = (wins) => {
  for (const w of wins) {
    const n = Number(w.holdMin);
    if (w.holdMin != null && Number.isFinite(n) && n > 0) return Math.min(24 * 60, Math.max(0.1, n)); // < 1: tests
  }
  return HOLD_MIN_DEFAULT;
};

// opts: { app, appRoot, userData, listWindows: () => [{ win, workDir, busy, gap?, hidden?, role?, holdMin? }],
//         send(win, channel, payload), log?, now? (tests) }
function init(opts) {
  const { app, appRoot, userData, listWindows, send } = opts;
  const log = opts.log || (() => {});
  const clock = opts.now || Date.now;
  const file = path.join(appRoot, 'RELEASE.json'); // written by scripts/release.js
  const startVersion = readVersion(file);
  let pending = null; // new version string
  let state = 'none';
  let since = 0;
  let forced = false; // 今すぐ更新
  let idleSince = 0;
  let gapSince = 0;
  let timer = null;
  let resume = false;
  let last = { busy: 0, blocked: 0 };

  function status() {
    const wins = listWindows();
    const deadline = since ? since + holdMinOf(wins) * 60_000 : 0;
    const force = state === 'pending' && (forced || (deadline && clock() >= deadline));
    return { state, version: pending, startVersion, since, deadline, force: !!force, resume, busy: last.busy, blocked: last.blocked };
  }
  let lastSent = '';
  const broadcast = (always) => {
    const st = status();
    const key = JSON.stringify({ ...st, since: st.since });
    if (!always && key === lastSent) return;
    lastSent = key;
    for (const w of listWindows()) {
      try {
        send(w.win, 'app:update', st);
      } catch {}
    }
  };

  function check() {
    if (state !== 'pending') return;
    const wins = listWindows();
    const now = clock();
    const busy = wins.filter((w) => w.busy).length;
    const blocked = wins.filter((w) => w.busy && !w.gap).length;
    last = { busy, blocked };
    if (!busy) {
      if (!idleSince) idleSince = now;
      if (now - idleSince >= IDLE_MS) return restart(false);
    } else idleSince = 0;
    const st = status();
    if (st.force && !blocked) {
      if (!gapSince) gapSince = now;
      if (now - gapSince >= GAP_MS) return restart(busy > 0); // something still runs: it continues after the restart
    } else gapSince = 0;
    broadcast(false); // busy / blocked counts, force once the deadline passed
  }

  function restart(withResume) {
    if (state === 'restarting') return;
    state = 'restarting';
    resume = !!withResume;
    clearInterval(timer);
    // { folder, hidden }: background windows come back hidden; the manager window is reopened by main anyway.
    const folders = listWindows().filter((w) => w.workDir && w.role !== 'manager').map((w) => ({ folder: w.workDir, hidden: !!w.hidden }));
    try {
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(path.join(userData, 'reopen.json'), JSON.stringify({ folders, at: Date.now(), version: pending, resume }));
    } catch (err) {
      log('[autorestart] could not record folders', err);
    }
    log(`[autorestart] restarting for version ${pending} (${folders.length} folders${resume ? ', running items resume' : ''})`);
    broadcast(true);
    try {
      if (typeof opts.onRestart === 'function') opts.onRestart(); // UA1: auto.restart (usage record)
    } catch {}
    // relaunch() + quit(): quitting closes every window normally, so their beforeunload saves
    // (layouts, drafts, backlog) run, and the manager window really closes (before-quit).
    setTimeout(() => {
      app.relaunch();
      app.quit();
    }, 800); // let the windows show "restarting" (and mark their running items)
    setTimeout(() => app.exit(0), 10_000); // a window refusing to close must not block the update
  }

  function reserve() {
    state = 'pending';
    since = clock();
    forced = false;
    idleSince = 0;
    gapSince = 0;
    clearInterval(timer);
    timer = setInterval(check, CHECK_MS);
    broadcast(true);
  }

  function onChange() {
    const v = readVersion(file);
    if (!v || v === startVersion || v === pending || state === 'restarting') return;
    pending = v;
    log(`[autorestart] new version ${v} (running ${startVersion || 'unknown'}): queues hold until the restart`);
    reserve();
  }

  // 「今すぐ更新」: wait for a turn gap now (no need to wait out the hold). From 'postponed' it reserves again.
  function now() {
    if (!pending || state === 'restarting') return false;
    if (state !== 'pending') reserve();
    forced = true;
    gapSince = 0;
    broadcast(true);
    setTimeout(check, 0);
    return true;
  }
  // 「後で」: drop the reservation; the queues run again.
  function later() {
    if (!pending || state !== 'pending') return false;
    state = 'postponed';
    forced = false;
    since = 0;
    clearInterval(timer);
    log(`[autorestart] update to ${pending} postponed`);
    broadcast(true);
    return true;
  }

  try {
    // Watch the folder: release.js replaces files, and watching a missing file throws.
    fs.watch(appRoot, { persistent: false }, (_ev, name) => {
      if (String(name || '').toLowerCase() === 'release.json') setTimeout(onChange, 500); // let the writer finish
    });
  } catch (err) {
    log('[autorestart] watch failed', err);
  }

  return {
    status,
    now,
    later,
    // action from a window (update:action): 'now' | 'later'
    action: (a) => (a === 'now' ? now() : a === 'later' ? later() : false),
    holding: () => state === 'pending',
    _check: check, // tests
    _onChange: onChange,
  };
}

// Folders to open after an automatic restart (read once, then removed).
function takeReopen(userData) {
  const f = path.join(userData, 'reopen.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.unlinkSync(f);
    if (!j || !Array.isArray(j.folders)) return [];
    if (Date.now() - (j.at || 0) > 10 * 60 * 1000) return []; // stale
    return j.folders
      .map((x) => (typeof x === 'string' ? { folder: x, hidden: false } : x))
      .filter((x) => x && typeof x.folder === 'string');
  } catch {
    return [];
  }
}

module.exports = { init, takeReopen, readVersion, IDLE_MS, GAP_MS, HOLD_MIN_DEFAULT };
