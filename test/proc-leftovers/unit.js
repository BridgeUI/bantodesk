// Unit (PROGRESS 51c): src/main/leftovers.js (which processes the tabs left behind, what each mode stops) and
// src/main/claude-cmd.js (the tab's claude settings carry spinnerTipsEnabled: false, only in the app's file).
// Plain Node, made-up process rows; no process is listed, started or stopped.
//   node tmp/proc-leftovers/unit.js        (AT_APP_ROOT=<app> for another copy)
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(process.env.AT_APP_ROOT || path.join(__dirname, '..', '..'));
const L = require(path.join(root, 'src', 'main', 'leftovers.js'));
const claudeCmd = require(path.join(root, 'src', 'main', 'claude-cmd.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
}

const NOW = Date.parse('2026-11-12T12:00:00Z');
const MIN = 60_000;
const P = (pid, ppid, name, agoMin, o = {}) => ({ pid, ppid, name, created: NOW - agoMin * MIN, threads: 4, priv: 2 * 1048576, suspended: false, ...o });
const SUSP = { suspended: true, threads: 1, priv: 1048576 };
// the main / pty host 100, a tab's claude 200 (root), its bash 300
const base = () => [P(4, 0, 'System', 999), P(100, 4, 'electron.exe', 120), P(200, 100, 'claude.exe', 60)];
const pids = (items) => items.map((x) => x.pid).sort((a, b) => a - b);
const run = (procs, known, roots, o = {}) => L.findLeftovers({ procs, known, roots, now: NOW, ...o });

// --- 1. claude settings: spinnerTipsEnabled false
{
  ok('1a CLAUDE_SETTINGS has spinnerTipsEnabled: false', claudeCmd.CLAUDE_SETTINGS.spinnerTipsEnabled === false, claudeCmd.CLAUDE_SETTINGS);
  ok('1b claudeSettings() keeps it with the other settings', claudeCmd.claudeSettings().spinnerTipsEnabled === false && claudeCmd.claudeSettings().preferredNotifChannel === 'ghostty');
  const dir = fs.mkdtempSync(path.join(__dirname, 'ud-unit-'));
  const fakeHome = path.join(dir, 'home');
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
  const userFile = path.join(fakeHome, '.claude', 'settings.json');
  fs.writeFileSync(userFile, '{"theme":"dark"}');
  const oldHome = process.env.USERPROFILE;
  process.env.USERPROFILE = fakeHome;
  let f = null;
  try {
    f = claudeCmd.writeClaudeSettings(path.join(dir, 'ud'));
  } finally {
    process.env.USERPROFILE = oldHome;
  }
  const j = f ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  ok('1c writeClaudeSettings: <userData>/claude-settings.json has spinnerTipsEnabled false', f === path.join(dir, 'ud', 'claude-settings.json') && j.spinnerTipsEnabled === false, j.spinnerTipsEnabled);
  ok('1d the user\'s ~/.claude/settings.json is not touched', fs.readFileSync(userFile, 'utf8') === '{"theme":"dark"}');
  ok('1e permissions / hooks still there (SEC5)', Array.isArray(j.permissions?.deny) && j.permissions.deny.length > 100 && !!j.hooks);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 2. remember: the tab's tree, then children of a remembered parent that died
{
  const known = new Map();
  const procs = [...base(), P(300, 200, 'bash.exe', 30), P(310, 300, 'git.exe', 29), P(900, 4, 'Code.exe', 50)];
  L.remember(known, procs, [{ pid: 200 }], NOW);
  const has = (pid) => [...known.values()].some((k) => k.pid === pid);
  ok('2a the tab tree is remembered (claude, bash, git)', has(200) && has(300) && has(310), [...known.values()].map((k) => k.pid));
  ok('2b nothing else (main, VS Code)', !has(100) && !has(900) && !has(4));
  // bash dies; a child created just before (never sampled while bash lived) is found through bash's entry
  const later = [...base(), P(320, 300, 'getprocaddr64.exe', 25, SUSP), P(330, 320, 'x.exe', 24)];
  L.remember(known, later, [{ pid: 200 }], NOW);
  ok('2c child + grandchild of a remembered dead parent are known', has(320) && has(330));
  // a process whose parent PID 300 was reused by a later process: not ours
  const reused = [...base(), P(300, 4, 'svchost.exe', 5), P(340, 300, 'other.exe', 4)];
  L.remember(known, reused, [{ pid: 200 }], NOW);
  ok('2d child of a later owner of a reused PID is not ours', !has(340));
  // a process older than the remembered parent (its PID's earlier owner) is not ours
  const older = [...base(), P(350, 300, 'old.exe', 40)];
  L.remember(known, older, [{ pid: 200 }], NOW);
  ok('2e a "child" older than the remembered parent is not ours', !has(350));
}

// --- 3. findLeftovers: A (suspended) and B (tasklist pipe), only the tab's
{
  const known = new Map();
  // phase 1 (sampled): claude 200 -> bash 300; claude 200 -> cmd 400 (the tips pipe)
  L.remember(known, [...base(), P(300, 200, 'bash.exe', 30), P(400, 200, 'cmd.exe', 30)], [{ pid: 200 }], NOW);
  // phase 2: bash 300 gone; its git 310 suspended (1 thread). cmd 400 alive but its parent claude 200 ended -> the
  // tab's root is now 201 (a restart). tasklist 410 + findstr 411 under cmd 400.
  const procs = [
    P(4, 0, 'System', 999), P(100, 4, 'electron.exe', 120), P(201, 100, 'claude.exe', 1),
    P(310, 300, 'git.exe', 25, SUSP),
    P(400, 200, 'cmd.exe', 30), P(410, 400, 'tasklist.exe', 30, { priv: 3 * 1048576 }), P(411, 400, 'findstr.exe', 30),
    // not ours: a hand-started claude's leftovers, a WebView2 the host suspended, a UWP app
    P(700, 600, 'git.exe', 50, SUSP), P(710, 4, 'tasklist.exe', 50),
    P(720, 4, 'msedgewebview2.exe', 50, SUSP), P(730, 4, 'ShellExperienceHost.exe', 50, { suspended: true, threads: 30 }),
  ];
  L.remember(known, procs, [{ pid: 201 }], NOW);
  const items = run(procs, known, [{ pid: 201 }]);
  ok('3a A: suspended 1-thread child of a gone parent', items.some((x) => x.pid === 310 && x.kind === 'suspended'), items);
  ok('3b B: tasklist + its cmd (parent gone) + findstr of the same pipe', [400, 410, 411].every((p) => items.some((x) => x.pid === p && x.kind === 'tasklist')));
  ok('3c only those 4 (not the hand-started ones, not WebView2 / UWP, not the live claude)', JSON.stringify(pids(items)) === '[310,400,410,411]', pids(items));
  ok('3d ended: the root 200 is gone, so all 4 are a gone session\'s', items.every((x) => x.ended));
  const s = L.summarize(items);
  ok('3e summary: 4, 1 + 2 + 3 + 2 = 8 MB, 1 suspended / 3 tasklist', s.count === 4 && s.mb === 8 && s.suspended === 1 && s.tasklist === 3 && s.ended === 4, s);
}

// --- 4. not leftovers: young, parent alive, more threads, live tasklist under a live claude
{
  const known = new Map();
  const procs = [
    ...base(),
    P(300, 200, 'bash.exe', 30), P(301, 300, 'git.exe', 30, SUSP), // parent alive (being created / resumed)
    P(302, 200, 'node.exe', 30, { suspended: true, threads: 5 }), // more than one thread
    P(303, 200, 'tasklist.exe', 30), // parent claude alive
    P(304, 200, 'cmd.exe', 30), P(305, 304, 'tasklist.exe', 30), // cmd's parent (claude) alive
  ];
  L.remember(known, procs, [{ pid: 200 }], NOW);
  const items = run(procs, known, [{ pid: 200 }]);
  ok('4a nothing while every parent lives', items.length === 0, items);
  // young: parent gone, but only 3 minutes old in a live session (< 10 min)
  const k2 = new Map();
  L.remember(k2, [...base(), P(300, 200, 'bash.exe', 5)], [{ pid: 200 }], NOW);
  const young = [...base(), P(310, 300, 'git.exe', 3, SUSP)];
  L.remember(k2, young, [{ pid: 200 }], NOW);
  ok('4b live session: a 3-minute-old one is not yet a leftover', run(young, k2, [{ pid: 200 }]).length === 0);
  const old = [...base(), P(310, 300, 'git.exe', 11, SUSP)];
  const k3 = new Map();
  L.remember(k3, [...base(), P(300, 200, 'bash.exe', 12)], [{ pid: 200 }], NOW);
  L.remember(k3, old, [{ pid: 200 }], NOW);
  const it = run(old, k3, [{ pid: 200 }]);
  ok('4c live session: after 10 minutes it is (ended false)', it.length === 1 && it[0].ended === false, it);
  // ended session: 3 minutes is enough (2 min)
  const goneRoot = [P(4, 0, 'System', 999), P(100, 4, 'electron.exe', 120), P(310, 300, 'git.exe', 3, SUSP)];
  ok('4d ended session: 3 minutes old is a leftover', run(goneRoot, k2, []).length === 1);
}

// --- 5. modes: what is stopped
{
  const items = [{ pid: 1, ended: true }, { pid: 2, ended: false }];
  ok('5a default mode is ended', L.DEFAULT_MODE === 'ended');
  ok('5b ended: only the gone session\'s', JSON.stringify(L.toStop(items, 'ended').map((x) => x.pid)) === '[1]');
  ok('5c all: both', L.toStop(items, 'all').length === 2);
  ok('5d off: none', L.toStop(items, 'off').length === 0);
}

// --- 6. tracker: check() stops by the mode, never a process that is not the tab's; mode is kept in userData
(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir() === '' ? __dirname : __dirname, 'ud-trk-'));
  let rows = [...base(), P(300, 200, 'bash.exe', 30), P(900, 4, 'Code.exe', 50), P(910, 900, 'git.exe', 40, SUSP)];
  let roots = [{ pid: 200 }];
  const killed = [];
  const mk = () => L.createTracker({ userData: ud, list: async () => rows, roots: () => roots, kill: async (pid) => killed.push(pid), now: () => NOW });
  let t = mk();
  ok('6a mode from an empty userData: ended', t.mode() === 'ended');
  let r = await t.check();
  ok('6b first check: nothing (bash alive, VS Code\'s git is not ours)', r.count === 0 && killed.length === 0, r);
  // bash dies leaving git 310 suspended; claude 200 still runs (live session leftover, 25 min old)
  rows = [...base(), P(310, 300, 'git.exe', 25, SUSP), P(900, 4, 'Code.exe', 50), P(910, 900, 'git.exe', 40, SUSP)];
  r = await t.check();
  ok('6c live session leftover counted (1, 1 MB), default does not stop it', r.count === 1 && r.mb === 1 && r.ended === 0 && killed.length === 0 && r.stopped.length === 0, r);
  ok('6d result file written', JSON.parse(fs.readFileSync(path.join(ud, L.RESULT_FILE), 'utf8')).count === 1);
  t.setMode('off');
  // the session ends (claude 200 gone)
  rows = [P(4, 0, 'System', 999), P(100, 4, 'electron.exe', 120), P(310, 300, 'git.exe', 25, SUSP), P(900, 4, 'Code.exe', 50), P(910, 900, 'git.exe', 40, SUSP)];
  roots = [];
  r = await t.check();
  ok('6e mode off: counted as ended, not stopped', r.count === 1 && r.ended === 1 && killed.length === 0, r);
  t.setMode('ended');
  r = await t.check();
  ok('6f mode ended: the gone session\'s leftover stopped (310 only, never VS Code\'s 910)', JSON.stringify(killed) === '[310]' && r.stopped.length === 1 && r.stopped[0].ok, { killed, r });
  // a new tracker on the same userData: the mode and the remembered tree come back (restart of the app)
  killed.length = 0;
  await new Promise((res) => setTimeout(res, 100)); // known file written async
  t = mk();
  ok('6g mode kept in leftovers-settings.json', t.mode() === 'ended' && JSON.parse(fs.readFileSync(path.join(ud, L.SETTINGS_FILE), 'utf8')).mode === 'ended');
  r = await t.check();
  ok('6h after a restart the remembered tree still finds 310', r.count === 1 && JSON.stringify(killed) === '[310]', { r, killed });
  // a live session's leftover with mode all
  rows = [...base(), P(300, 200, 'bash.exe', 30)];
  roots = [{ pid: 200 }];
  t = mk();
  t.setMode('all');
  await t.check();
  rows = [...base(), P(320, 300, 'git.exe', 25, SUSP)];
  killed.length = 0;
  r = await t.check();
  ok('6i mode all: the live session\'s leftover is stopped too', JSON.stringify(killed) === '[320]', { r, killed });
  t.setMode('bogus');
  ok('6j an unknown mode is ignored', t.mode() === 'all');
  // a kill that fails (already gone) is reported, not counted
  t = L.createTracker({ list: async () => rows, roots: () => roots, kill: async () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); }, now: () => NOW });
  t.setMode('all');
  t.rememberRows([P(200, 100, 'claude.exe', 60), P(300, 200, 'bash.exe', 30)], 200);
  r = await t.check();
  ok('6k rememberRows (stoptree\'s tree) finds the child; a failed kill is reported with its code', r.stopped.length === 1 && r.stopped[0].ok === false && r.stopped[0].err === 'ESRCH' && r.stoppedTotal === 0, r);
  fs.rmSync(ud, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
