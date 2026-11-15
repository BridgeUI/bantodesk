'use strict';
// Keep the PC awake while work runs (settings "実行中はスリープしない" / "ふたを閉じてもスリープしない"), docs/keep-awake.md.
//
// Three parts, all replaceable for tests (no real power setting is changed in dev or tests):
//   1. Electron's powerSaveBlocker, by the setting "スリープを避ける方法" (notifySettings.sleepMode, 52c):
//      'display' (default on Windows) = 'prevent-display-sleep', the request meeting apps (Teams, Zoom, a browser call)
//      hold: Chromium makes it PowerRequestDisplayRequired (plus SystemRequired before Windows 11), the screen stays on,
//      so a Modern Standby machine never reaches its idle sleep. The policy "allow applications to prevent automatic
//      sleep" (SYSTEMREQUIRED = 0) ignores SystemRequired requests only, not display ones. A display request also stops
//      the screensaver and the automatic session lock while it is held (as during a call).
//      'system' (default elsewhere) = 'prevent-app-suspension': on Windows 8+ PowerRequestExecutionRequired, which on
//      Modern Standby (S0 low power idle) machines does NOT keep the system awake; on macOS it keeps the system awake
//      and lets the display sleep.
//   2. A system-required power request (PowerCreateRequest + PowerSetRequest(PowerRequestSystemRequired)) held by the
//      app's own process through its native module (SEC3); Windows drops it when the process ends, so a crash cannot
//      leave it behind. Shown by `powercfg /requests` (admin) under SYSTEM as "BantoDesk: ...".
//   3. The lid: while busy (and the lid setting is on), the active scheme's AC "lid close action" (SUB_BUTTONS / LIDACTION)
//      is set to 0 (do nothing). The original value is saved in userData first (lid-action.json) and put back when work ends,
//      when the app quits, and on the next start after a crash. Battery (DC) is never touched: closing the lid on battery
//      still sleeps. Not changed when a group policy fixes it, when the write is refused, or when writes are not allowed
//      (dev / custom user-data-dir / tests without the fake powercfg): then the reason is reported.
const fs = require('fs');
const path = require('path');
const { execFileOff } = require('./offthread');

const SUB_BUTTONS = '4f971e89-eebd-4455-a8de-9e59040e7347';
const LIDACTION = '5ca83367-6e45-459f-a27b-476b1d01c936';
const POLICY_KEY = `HKLM\\SOFTWARE\\Policies\\Microsoft\\Power\\PowerSettings\\${LIDACTION}`;
const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CALL_TIMEOUT_MS = 8000;

// --- how sleep is avoided (52c) -----------------------------------------------------------------------------
// 'display': keep the screen on like a meeting app; 'system': keep only the system awake (the older way)
const BLOCKER_OF = { display: 'prevent-display-sleep', system: 'prevent-app-suspension' };
const defaultMode = (platform = process.platform) => (platform === 'win32' ? 'display' : 'system');
// the setting's value (may be unset or anything) -> 'display' | 'system'
const resolveMode = (mode, platform = process.platform) => (mode === 'display' || mode === 'system' ? mode : defaultMode(platform));

// --- which windows count as busy --------------------------------------------------------------------------
// states: [{ busy, keepAwake, lid, role, mode }] (one per window, as reported by power:busy); routed: number of queued
// items main knows to be running or just started (sched: active r-* items of open folders + reservations).
// -> { busy, lid, why, mode }: mode 'display' when any busy window asks for it (the settings are shared by all windows,
// so they normally agree), else 'system'; only queued items -> the setting of any window, else the platform's default.
function decide(states, routed = 0, platform = process.platform) {
  const why = [];
  let lid = false;
  let any = false;
  let display = false;
  for (const s of states) {
    if (!s || !s.busy || s.keepAwake === false) continue;
    any = true;
    if (s.lid !== false) lid = true;
    if (resolveMode(s.mode, platform) === 'display') display = true;
    why.push(s.role === 'manager' ? 'pmo' : 'window');
  }
  // queued work main started for a folder whose window has not reported yet (hidden window loading)
  if (routed > 0 && !states.some((s) => s && s.keepAwake === false)) {
    if (!any) {
      lid = !states.some((s) => s && s.lid === false);
      const set = states.find((s) => s && (s.mode === 'display' || s.mode === 'system'));
      display = resolveMode(set && set.mode, platform) === 'display';
    }
    any = true;
    why.push('queue');
  }
  return { busy: any, lid: any && lid, why, mode: any ? (display ? 'display' : 'system') : null };
}

// --- powercfg / reg runner ----------------------------------------------------------------------------------
// -> Promise<{ code, out, timedOut }> (never rejects). The process is started on the offthread worker
// (src/main/offthread.js): starting one blocks the calling thread 0.7-1.2 s on PCs with endpoint protection, which in
// main froze every window (docs/perf.md "第 1 段" / perf1b). Same programs and arguments as before, only fewer starts
// (the lid keeps what it read, below). AT_POWERCFG_FAKE=<script.js>: run `node <script> <cmd> ...args` instead (tests;
// ELECTRON_RUN_AS_NODE). o.onCall(cmd, args) (tests, measuring): told before every start.
function makeRunner(env = process.env, timeoutMs = CALL_TIMEOUT_MS, o = {}) {
  const fake = env.AT_POWERCFG_FAKE;
  return async (cmd, args) => {
    if (o.onCall) o.onCall(cmd, args);
    const r = fake
      ? await execFileOff(process.execPath, [fake, cmd, ...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } })
      : await execFileOff(cmd === 'reg' ? 'reg.exe' : 'powercfg.exe', args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    const e = r.err;
    // execFile: a non-zero exit is err.code (a number); a timeout kills the child (err.killed)
    const code = !e ? 0 : typeof e.code === 'number' ? e.code : -1;
    return { code, out: `${r.stdout || ''}${r.stderr || ''}`, timedOut: !!(e && e.killed) };
  };
}

// `powercfg /qh SCHEME_CURRENT SUB_BUTTONS LIDACTION` (the setting is hidden on many machines, so /qh) -> { scheme, ac, dc } | null.
// Language independent: the scheme is the first GUID; the current AC / DC indexes are the last two 0x........ values.
function parseLid(out) {
  const text = String(out || '');
  const g = text.match(GUID_RE);
  const hex = [...text.matchAll(/0x([0-9a-f]{8})\s*$/gim)].map((m) => parseInt(m[1], 16));
  if (!g || hex.length < 2 || !text.toLowerCase().includes(LIDACTION)) return null;
  return { scheme: g[0].toLowerCase(), ac: hex[hex.length - 2], dc: hex[hex.length - 1] };
}

// --- the lid ------------------------------------------------------------------------------------------------
// o: { run (async, makeRunner), file (userData/lid-action.json), allowWrite, log, cacheMs, now }. hold() / release()
// return Promise<status>; the controller runs one at a time. status(): { state, reason, original }.
//   state: off (not held) | held (set to do nothing, will restore) | already (it already does nothing) |
//          blocked (policy / refused / unreadable) | dry (writes not allowed here) | unsupported (not Windows)
// What it read is kept (cacheMs, 10 min): the policy key always, the lid value when nothing will be written (dry /
// already / unreadable). Before a change (hold with writes allowed) and before putting the value back (release) it
// reads again, so the original saved and the "changed by the user meanwhile" check are always fresh.
function createLid(o) {
  const run = o.run;
  const log = o.log || (() => {});
  const cacheMs = Number.isFinite(o.cacheMs) ? o.cacheMs : 10 * 60_000;
  const now = o.now || Date.now;
  let cache = null; // { v: parseLid result | null, at }
  let policy = null; // { fixed, at }
  // note: the last reason it was not changed (kept after the work ends, for the settings screen)
  let status = { state: 'off', reason: '', note: '' };
  const set = (state, reason = '', extra = {}) => {
    const note = reason || (state === 'held' || state === 'already' ? '' : status.note);
    status = { state, reason, note, ...extra };
    if (reason) log(`[keep-awake] lid ${state}: ${reason}`);
    return status;
  };
  // fresh: always ask powercfg (before a write); else a value read within cacheMs is used
  const read = async (fresh = true) => {
    if (!fresh && cache && now() - cache.at < cacheMs) return cache.v;
    const r = await run('powercfg', ['/qh', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION']);
    const v = r.code === 0 ? parseLid(r.out) : null;
    cache = { v, at: now() };
    return v;
  };
  const policyFixed = async () => {
    if (policy && now() - policy.at < cacheMs) return policy.fixed;
    const r = await run('reg', ['query', POLICY_KEY, '/v', 'ACSettingIndex']);
    policy = { fixed: r.code === 0, at: now() };
    return policy.fixed;
  };
  const saved = () => {
    try {
      const j = JSON.parse(fs.readFileSync(o.file, 'utf8'));
      return j && GUID_RE.test(j.scheme) && Number.isInteger(j.ac) ? j : null;
    } catch {
      return null;
    }
  };
  const write = async (scheme, v) => {
    cache = null; // the value read before is no longer known
    const a = await run('powercfg', ['/setacvalueindex', scheme, SUB_BUTTONS, LIDACTION, String(v)]);
    if (a.code !== 0) return a;
    return run('powercfg', ['/setactive', scheme]);
  };

  async function hold() {
    if (status.state === 'held' || status.state === 'already') return status;
    if (o.platform && o.platform !== 'win32') return set('unsupported', 'Windows のときだけ変えます');
    // a write may follow only when allowed: then fresh, else what was read lately is enough (dry: shown only)
    const cur = await read(!!o.allowWrite);
    if (!cur) return set('blocked', 'ふたを閉じたときの動作を読めませんでした（powercfg /qh）');
    if (cur.ac === 0) return set('already', '', { original: 0 });
    if (await policyFixed()) return set('blocked', '組織のポリシーで固定されているため変えません');
    if (!o.allowWrite) return set('dry', '開発版・テストのため電源設定は変えません', { original: cur.ac });
    try {
      fs.mkdirSync(path.dirname(o.file), { recursive: true });
      fs.writeFileSync(o.file, JSON.stringify({ scheme: cur.scheme, ac: cur.ac, at: new Date().toISOString() }, null, 2));
    } catch (err) {
      return set('blocked', `元の値を保存できないため変えません（${err.message}）`);
    }
    const w = await write(cur.scheme, 0);
    const after = await read(); // also after a failed / timed out write: it may have landed
    if (!after || after.ac !== 0) {
      // refused (no rights) or overridden: put back what we may have changed. The saved file goes only once the value
      // is known to be the original again (else the next release / start puts it back).
      if (after && after.ac !== cur.ac) await write(cur.scheme, cur.ac);
      const back = after && after.ac === cur.ac ? after : await read();
      if (back && back.ac === cur.ac) {
        try {
          fs.unlinkSync(o.file);
        } catch {}
      }
      const why = w.timedOut
        ? 'powercfg が時間内に終わらなかったため変えません'
        : w.code !== 0
          ? `変えられませんでした（権限がないか、ポリシーで固定。powercfg の終了コード ${w.code}）`
          : '変えても元に戻されました（ポリシーで固定）';
      return set('blocked', why);
    }
    if (w.code !== 0) log(`[keep-awake] lid: powercfg answered ${w.code} but the value is 0 now`);
    log(`[keep-awake] lid: AC action ${cur.ac} -> 0 (scheme ${cur.scheme}), original saved`);
    return set('held', '', { original: cur.ac });
  }

  // Put back the saved value (end of work, quit, next start after a crash). If the user changed it meanwhile (not 0
  // any more) their value stays. Nothing saved: no powercfg at all. -> Promise<status>
  async function release() {
    const j = saved();
    if (!j) return set('off'); // nothing was changed (already / blocked / dry); the reason stays in note
    const cur = await read();
    if (cur && cur.scheme === j.scheme && cur.ac !== 0) {
      log(`[keep-awake] lid: changed by the user meanwhile (${cur.ac}), left as is`);
    } else if (o.allowWrite) {
      const w = await write(j.scheme, j.ac);
      if (w.code !== 0) {
        log(`[keep-awake] lid: restore failed (code ${w.code}), will retry on next start`);
        return set('blocked', `元に戻せませんでした（powercfg の終了コード ${w.code}）。次の起動でもう一度戻します`);
      }
      log(`[keep-awake] lid: AC action restored to ${j.ac} (scheme ${j.scheme})`);
    }
    try {
      fs.unlinkSync(o.file);
    } catch {}
    return set('off');
  }

  return { hold, release, status: () => status, read, saved };
}

// --- the system-required request (the app's native module, SEC3) ----------------------------------------------
// PowerCreateRequest + PowerSetRequest(PowerRequestSystemRequired) in this process (src/main/native/atproc.node,
// docs/security.md). Windows drops the request when the process ends, so a crash cannot leave it behind.
// No child process, no PowerShell, nothing compiled at run time.
const REASON = 'BantoDesk: セッションの実行中';

// -> { set(on), state(), close() }. o.power (tests): (on, reason) -> { ok, fallback } instead of the native module.
function createSystemRequest(o = {}) {
  const log = o.log || (() => {});
  let want = false;
  let state = 'off'; // off | on | failed
  let accepted = null;
  let power = o.power || null;
  const call = (on) => {
    if (!power) {
      try {
        const m = require('./proclist').native();
        power = (v, reason) => m.power(v, reason);
      } catch (err) {
        state = 'failed';
        log(`[keep-awake] power request not available: ${err.message}`);
        return null;
      }
    }
    try {
      return power(on, REASON);
    } catch (err) {
      state = 'failed';
      log(`[keep-awake] power request failed: ${err.message}`);
      return null;
    }
  };
  return {
    set(on) {
      want = !!on;
      // PowerSetRequest counts its calls (each needs a PowerClearRequest): never set twice in a row
      if (want && state === 'on') return;
      if (!want && state !== 'on') return;
      const r = call(want);
      if (!r) return;
      if (want) {
        // ok: PowerSetRequest accepted; else fell back to SetThreadExecutionState (fallback true) or nothing held
        accepted = !!r.ok;
        state = r.ok || r.fallback ? 'on' : 'failed';
        if (!r.ok) log(`[keep-awake] PowerSetRequest refused${r.fallback ? ' (SetThreadExecutionState instead)' : ''}`);
      } else state = 'off';
    },
    wanted: () => want,
    state: () => state,
    accepted: () => accepted,
    // the request is held by this process (no helper)
    pid: () => (state === 'on' ? process.pid : null),
    close() {
      if (state === 'on') call(false);
      want = false;
      state = 'off';
    },
  };
}

// --- controller -----------------------------------------------------------------------------------------------
// o: { blocker: { start(type) -> id, stop(id) }, request, lid, file (status json, optional), log, platform }
// update({ busy, lid, why, mode }) after every change (mode: 'display' | 'system', missing -> the platform's default;
// a change of mode while busy starts the new blocker before stopping the old one, so there is no gap) (synchronous: the blocker and the request at once; the lid in the
// background, one powercfg step at a time, see settle). restore() on start (a lid a crashed run left), quit() on
// will-quit: both -> Promise<snapshot> once the lid is settled; settling() says whether a lid step still runs.
function createController(o) {
  const log = o.log || (() => {});
  const platform = o.platform || process.platform;
  let blockId = null;
  let blockType = null; // the blocker's type while it is held
  let last = { busy: false, lid: false, why: [], mode: null };
  let lidRun = null; // Promise of the running settle loop
  let forceRelease = false; // restore / quit: release even when this run changed nothing (saved file of a crash)
  let closing = false; // after quit(): the lid is not held again
  // the next lid step: 'hold' | 'release' | null
  const lidTodo = () => {
    if (!o.lid) return null;
    const st = o.lid.status().state;
    if (last.lid && !closing) return st === 'off' ? 'hold' : null;
    if (st === 'off' && !forceRelease) return null;
    if (!o.lid.saved()) {
      // nothing was changed (dry / already / blocked): back to off here, no powercfg, nothing to wait for
      forceRelease = false;
      if (st !== 'off') o.lid.release();
      return null;
    }
    return 'release';
  };
  // Runs hold / release until the lid matches the latest wish. Wishes that change during a step are picked up after
  // it (on -> off -> on while a hold runs: release, then hold). A step that did not reach its goal (release refused:
  // state blocked) is tried again by the next update, not in a loop here.
  function settle() {
    if (lidRun) return lidRun;
    if (!lidTodo()) return Promise.resolve(snapshot());
    const p = (async () => {
      await null;
      try {
        for (let n = 0; n < 8; n++) {
          const todo = lidTodo();
          if (!todo) break;
          if (todo === 'release') forceRelease = false;
          try {
            await (todo === 'hold' ? o.lid.hold() : o.lid.release());
          } catch (err) {
            log(`[keep-awake] lid ${todo} failed: ${err && err.message}`);
          }
          writeStatus();
          if (lidTodo() === todo) break;
        }
      } finally {
        lidRun = null;
      }
      writeStatus();
      return snapshot();
    })();
    lidRun = p;
    return p;
  }
  const writeStatus = () => {
    if (!o.file) return;
    try {
      fs.writeFileSync(o.file, JSON.stringify(snapshot(), null, 2));
    } catch {}
  };
  const snapshot = () => ({
    busy: last.busy,
    why: last.why,
    blocker: blockId !== null,
    blockerType: blockId !== null ? blockType : null, // 'prevent-display-sleep' | 'prevent-app-suspension'
    mode: last.mode, // 'display' | 'system' while busy
    defaultMode: defaultMode(platform),
    request: o.request ? o.request.wanted() : false,
    // the helper's answer: { state: on|off|failed, accepted: PowerSetRequest's result, pid }
    requestHelper: o.request && o.request.state ? { state: o.request.state(), accepted: o.request.accepted ? o.request.accepted() : null, pid: o.request.pid ? o.request.pid() : null } : null,
    lid: o.lid ? o.lid.status() : { state: 'off', reason: '' },
    lidWanted: last.lid,
    lidPending: !!lidRun, // a powercfg step for the lid is running (lid.state is from before it)
    at: new Date().toISOString(),
  });
  function update(d) {
    if (closing) return snapshot();
    const mode = d.busy ? resolveMode(d.mode, platform) : null;
    const next = { busy: !!d.busy, lid: !!d.busy && !!d.lid, why: Array.isArray(d.why) ? d.why : [], mode };
    const changed = next.busy !== last.busy || next.lid !== last.lid || next.why.join() !== last.why.join() || next.mode !== last.mode;
    last = next;
    const want = next.busy ? BLOCKER_OF[mode] : null;
    if (want && (blockId === null || blockType !== want)) {
      const old = blockId;
      try {
        blockId = o.blocker.start(want);
        blockType = want;
      } catch (err) {
        log(`[keep-awake] blocker ${want} failed: ${err && err.message}`);
      }
      // the old one goes only after the new one holds (or stays, if the new one could not start)
      if (old !== null && blockId !== old) {
        try {
          o.blocker.stop(old);
        } catch {}
      }
    } else if (!want && blockId !== null) {
      try {
        o.blocker.stop(blockId);
      } catch {}
      blockId = null;
      blockType = null;
    }
    if (o.request && o.request.wanted() !== next.busy) o.request.set(next.busy);
    settle();
    if (changed) writeStatus();
    return snapshot();
  }
  // start: put back a lid action a crashed run left (lid-action.json); nothing saved -> no powercfg
  function restore() {
    if (!closing) forceRelease = true;
    return settle();
  }
  function quit() {
    closing = true;
    if (blockId !== null) {
      try {
        o.blocker.stop(blockId);
      } catch {}
      blockId = null;
      blockType = null;
    }
    if (o.request) o.request.close();
    forceRelease = true;
    last = { busy: false, lid: false, why: [], mode: null };
    writeStatus();
    return settle();
  }
  return { update, restore, quit, snapshot, settling: () => !!lidRun };
}

module.exports = { decide, defaultMode, resolveMode, BLOCKER_OF, parseLid, createLid, createSystemRequest, createController, makeRunner, REASON, SUB_BUTTONS, LIDACTION, POLICY_KEY };
