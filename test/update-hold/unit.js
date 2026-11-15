// Unit test of src/main/autorestart.js (update hold): node tmp/update-hold/unit.js
// env AT_APP_ROOT = app folder whose src is tested (default this repo)
const fs = require('fs');
const path = require('path');
const os = require('os');
const root = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.join(__dirname, '..', '..');
const ar = require(path.join(root, 'src', 'main', 'autorestart'));

let pass = 0;
let fail = 0;
const ok = (c, m) => (c ? (pass++, console.log('PASS', m)) : (fail++, console.log('FAIL', m)));

function setup(winsInit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-'));
  const root = path.join(dir, 'app');
  const ud = path.join(dir, 'ud');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'RELEASE.json'), JSON.stringify({ build: 'v1' }));
  let t = 1_000_000;
  const sent = [];
  const app = { relaunched: 0, quit: 0, relaunch() { this.relaunched++; }, quit() { this.quit++; }, exit() {} };
  const env = { wins: winsInit, t };
  const u = ar.init({
    app,
    appRoot: root,
    userData: ud,
    listWindows: () => env.wins.map((w) => ({ win: w, ...w })),
    send: (_w, ch, p) => sent.push({ ch, p }),
    now: () => env.t,
  });
  const release = (v) => {
    fs.writeFileSync(path.join(root, 'RELEASE.json'), JSON.stringify({ build: v }));
    u._onChange();
  };
  const last = () => sent.filter((s) => s.ch === 'app:update').slice(-1)[0]?.p;
  return { u, env, app, sent, release, last, ud };
}

// 1. normal: hold until idle 10 s, then restart without resume
{
  const s = setup([{ workDir: 'C:/a', busy: true, gap: false }]);
  ok(s.u.status().state === 'none', 'no update at start');
  s.release('v1');
  ok(s.u.status().state === 'none', 'same version: nothing');
  s.release('v2');
  ok(s.last().state === 'pending' && s.u.holding(), 'new version -> pending (hold) broadcast');
  s.u._check();
  s.env.t += 60_000;
  s.u._check();
  ok(s.u.status().state === 'pending', 'still busy -> keeps holding');
  s.env.wins[0].busy = false;
  s.u._check();
  s.env.t += 5_000;
  s.u._check();
  ok(s.u.status().state === 'pending', 'idle 5 s -> not yet');
  s.env.t += 6_000;
  s.u._check();
  ok(s.u.status().state === 'restarting' && s.u.status().resume === false, 'idle 11 s -> restart, resume false');
  const ro = JSON.parse(fs.readFileSync(path.join(s.ud, 'reopen.json'), 'utf8'));
  ok(ro.folders.length === 1 && ro.resume === false, 'reopen.json written with folders');
}

// 2. deadline: after holdMin, restart at a turn gap (busy + gap) with resume
{
  const s = setup([{ workDir: 'C:/a', busy: true, gap: false, holdMin: 30 }, { workDir: 'C:/b', busy: false, gap: true }]);
  s.release('v2');
  s.env.t += 29 * 60_000;
  s.u._check();
  ok(!s.u.status().force, 'before 30 min: not forced');
  s.env.wins[0].gap = true;
  s.u._check();
  s.env.t += 3_000;
  s.u._check();
  ok(s.u.status().state === 'pending', 'gap before the deadline does not restart');
  s.env.t += 60_000;
  s.env.wins[0].gap = false;
  s.u._check();
  ok(s.u.status().force && s.last().force, 'after 30 min: force broadcast');
  s.env.t += 5_000;
  s.u._check();
  ok(s.u.status().state === 'pending', 'forced but mid-turn: waits');
  s.env.wins[0].gap = true;
  s.u._check();
  s.env.t += 1_000;
  s.u._check();
  ok(s.u.status().state === 'pending', 'gap 1 s: not yet');
  s.env.t += 1_500;
  s.u._check();
  ok(s.u.status().state === 'restarting' && s.u.status().resume === true, 'gap 2.5 s -> restart with resume');
  ok(s.last().state === 'restarting' && s.last().resume === true, 'restarting broadcast carries resume');
}

// 3. holdMin from the windows (setting) changes the deadline
{
  const s = setup([{ workDir: 'C:/a', busy: true, gap: true, holdMin: 60 }]);
  s.release('v2');
  s.env.t += 45 * 60_000;
  s.u._check();
  ok(!s.u.status().force, 'holdMin 60: not forced at 45 min');
  s.env.t += 16 * 60_000;
  s.u._check();
  ok(s.u.status().force, 'holdMin 60: forced at 61 min');
}

// 4. 今すぐ更新 / 後で
{
  const s = setup([{ workDir: 'C:/a', busy: true, gap: false }]);
  s.release('v2');
  ok(s.u.action('later') && s.u.status().state === 'postponed' && !s.u.holding(), '後で -> postponed, queues run');
  s.env.wins[0].busy = false;
  s.u._check();
  s.env.t += 20_000;
  s.u._check();
  ok(s.u.status().state === 'postponed', 'postponed: no restart even when idle');
  s.env.wins[0].busy = true;
  ok(s.u.action('now') && s.u.status().state === 'pending' && s.u.status().force, '今すぐ更新 from postponed -> pending + force');
  s.u._check();
  s.env.t += 3_000;
  s.u._check();
  ok(s.u.status().state === 'pending', 'forced, mid-turn: waits');
  s.env.wins[0].gap = true;
  s.u._check();
  s.env.t += 2_500;
  s.u._check();
  ok(s.u.status().state === 'restarting' && s.u.status().resume, '今すぐ更新 -> restart at the gap with resume');
}

// 5. temp window (busy, never gap) blocks even when forced; newer release after postpone reserves again
{
  const s = setup([{ workDir: 'C:/t', busy: true, gap: false }]);
  s.release('v2');
  s.u.action('now');
  for (let i = 0; i < 5; i++) {
    s.env.t += 3_000;
    s.u._check();
  }
  ok(s.u.status().state === 'pending' && s.u.status().blocked === 1, 'blocked window keeps it waiting (blocked count 1)');
  s.u.action('later');
  s.release('v3');
  ok(s.u.status().state === 'pending' && s.u.status().version === 'v3' && !s.u.status().force, 'newer release after 後で reserves again');
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
