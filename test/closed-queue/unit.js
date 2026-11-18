// AT-closedq: queues of folders without a window start (sched.planClosed) + why an item waits goes to
// projects.json pendingItems[].blocked (manager.buildProjects blockedOf) + the ルーター template documents it.
// Run: node tmp/closed-queue/unit.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const sched = require(path.join(root, 'src', 'main', 'sched'));
const manager = require(path.join(root, 'src', 'main', 'manager'));
const backlog = require(path.join(root, 'src', 'main', 'backlog'));

let pass = 0;
let fail = 0;
const ok = (name, cond, ev) => {
  if (cond) pass++;
  else fail++;
  console.log(cond ? 'PASS' : 'FAIL', name, ev === undefined ? '' : '| ' + JSON.stringify(ev));
};

const A = 'C:\\work\\school';
const B = 'C:\\work\\proposal';
const C = 'C:\\work\\third';
const item = (id, o = {}) => ({ id, status: 'pending', text: id, ...o });
const base = { running: [], items: new Map(), limit: 3, resources: { over: [] }, hold: null };

// --- closedWaiting: r-* pending only (a stale tabId of a folder without a window does not matter)
const cw = sched.closedWaiting([item('r-1'), item('r-2', { tabId: 'x' }), item('u-1'), item('r-3', { status: 'active' }), item('r-4', { status: 'done' })]);
ok('closedWaiting: r-* pending, tabId ignored', cw.map((w) => w.id).join() === 'r-1,r-2', cw);

// --- the reported case: two closed folders, slots free, nothing before them -> both open
let r = sched.planClosed({ ...base, folders: [{ folder: A, items: [item('r-88')] }, { folder: B, items: [item('r-9')] }] });
ok('closed folders with free slots: both open', r.open.map((o) => o.folder).join('|') === `${A}|${B}` && r.open[0].start.join() === 'r-88' && r.open[1].start.join() === 'r-9', r);
ok('no reasons when they start', !Object.keys(r.reasons[A]).length && !Object.keys(r.reasons[B]).length, r.reasons);

// --- limit counts running items of open windows + the ones this pass starts
r = sched.planClosed({
  ...base,
  limit: 2,
  running: [{ id: 'r-x', folder: C, kind: null, touches: [] }],
  folders: [{ folder: A, items: [item('r-88')] }, { folder: B, items: [item('r-9')] }],
});
ok('limit: first closed folder opens, second waits', r.open.length === 1 && r.open[0].folder === A && r.reasons[B]['r-9'].code === 'limit', r);
ok('limit text', /上限（2 件）/.test(r.reasons[B]['r-9'].text), r.reasons[B]['r-9'].text);

// --- overlap within a closed folder: whole-folder items one at a time
r = sched.planClosed({ ...base, folders: [{ folder: A, items: [item('r-1'), item('r-2')] }] });
ok('overlap: one item of the folder starts, the next waits', r.open[0].start.join() === 'r-1' && r.reasons[A]['r-2'].code === 'overlap', r);

// --- after: a prerequisite not done -> the folder does not open
r = sched.planClosed({ ...base, items: new Map([['r-0', 'pending']]), folders: [{ folder: A, items: [item('r-1', { after: ['r-0'] })] }] });
ok('after: waits, folder not opened', !r.open.length && r.reasons[A]['r-1'].code === 'after', r);
r = sched.planClosed({ ...base, items: new Map([['r-0', 'failed']]), folders: [{ folder: A, items: [item('r-1', { after: ['r-0'] })] }] });
ok('after-failed', !r.open.length && r.reasons[A]['r-1'].code === 'after-failed', r);
r = sched.planClosed({ ...base, items: new Map([['r-0', 'done']]), folders: [{ folder: A, items: [item('r-1', { after: ['r-0'] })] }] });
ok('after done: opens', r.open.length === 1, r);

// --- resources: while something runs, nothing more
r = sched.planClosed({ ...base, running: [{ id: 'r-x', folder: C }], resources: { over: ['CPU 95%'] }, folders: [{ folder: A, items: [item('r-1')] }] });
ok('resource: waits', !r.open.length && r.reasons[A]['r-1'].code === 'resource', r);
r = sched.planClosed({ ...base, resources: { over: ['CPU 95%'] }, folders: [{ folder: A, items: [item('r-1')] }] });
ok('resource: nothing running = one may start', r.open.length === 1, r);

// --- an item already running (reserved / opening) is neither started again nor given a reason
r = sched.planClosed({ ...base, running: [{ id: 'r-1', folder: A, kind: 'implement', touches: ['src/'] }], folders: [{ folder: A, items: [item('r-1'), item('r-2', { kind: 'research', touches: ['docs/'] })] }] });
ok('running id skipped, a disjoint item may still start', r.open.length === 1 && r.open[0].start.join() === 'r-2' && !r.reasons[A]['r-1'], r);

// --- update reserved: nothing opens, every waiting item says update
r = sched.planClosed({ ...base, hold: { code: 'update', text: '更新待ち' }, folders: [{ folder: A, items: [item('r-1'), item('r-2')] }] });
ok('update hold: nothing opens, all update', !r.open.length && r.reasons[A]['r-1'].code === 'update' && r.reasons[A]['r-2'].code === 'update', r);

// --- folder with nothing routed pending: no entry
r = sched.planClosed({ ...base, folders: [{ folder: A, items: [item('u-1'), item('r-1', { status: 'done' })] }] });
ok('nothing waiting: no open, no reasons', !r.open.length && !(A in r.reasons), r);

// --- the user's limit kept by main (manager-settings.json schedLimit / schedThresholds): settingsOf
let s = sched.settingsOf({});
ok('settingsOf: nothing saved = the defaults (3, 1 GB / 80% / 200 ms)', s.limit === 3 && s.thresholds.minFreeMB === 1024 && s.thresholds.maxCpuPct === 80 && s.thresholds.maxLagMs === 200, s);
s = sched.settingsOf({ workRoot: 'C:\\x', schedLimit: 1, schedThresholds: { minFreeMB: 0, maxCpuPct: 50, maxLagMs: 200 } });
ok('settingsOf: saved limit 1 and thresholds (0 = off)', s.limit === 1 && s.thresholds.minFreeMB === null && s.thresholds.maxCpuPct === 50, s);
ok('settingsOf: out of range is clamped (1..10)', sched.settingsOf({ schedLimit: 25 }).limit === 10 && sched.settingsOf({ schedLimit: 0 }).limit === 1 && sched.settingsOf({ schedLimit: 'x' }).limit === 3);
ok('settingsOf: null / junk = defaults', sched.settingsOf(null).limit === 3 && sched.settingsOf({ schedThresholds: 'x' }).thresholds.maxCpuPct === 80);
// after a restart, before any window asked: the closed-folder check judges with the saved limit, not 3
const two = [{ folder: A, items: [item('r-88')] }, { folder: B, items: [item('r-9')] }];
r = sched.planClosed({ ...base, limit: sched.settingsOf({ schedLimit: 1 }).limit, folders: two });
ok('saved limit 1: only the first closed folder opens, the second waits (limit)', r.open.length === 1 && r.open[0].folder === A && r.reasons[B]['r-9'].code === 'limit' && /上限（1 件）/.test(r.reasons[B]['r-9'].text), r);
r = sched.planClosed({ ...base, limit: sched.settingsOf({}).limit, folders: two });
ok('nothing saved: the default 3 lets both open', r.open.length === 2, r);

// --- the reasons name items by their number (no) when they have one, else by the id
r = sched.planClosed({ ...base, items: new Map([['r-0', 'pending']]), nos: new Map([['r-0', 'SSA-88']]), folders: [{ folder: A, items: [item('r-1', { after: ['r-0'] })] }] });
ok('after: names the prerequisite by its no', r.reasons[A]['r-1'].text === '前提の SSA-88 が済んでいません', r.reasons[A]['r-1']);
r = sched.planClosed({ ...base, items: new Map([['r-0', 'failed']]), nos: { 'r-0': 'SSA-88' }, folders: [{ folder: A, items: [item('r-1', { after: ['r-0'] })] }] });
ok('after-failed: names it by its no (nos as an object)', r.reasons[A]['r-1'].text === '前提の SSA-88 が失敗しています', r.reasons[A]['r-1']);
r = sched.planClosed({ ...base, items: new Map([['r-0', 'pending']]), folders: [{ folder: A, items: [item('r-0', { status: 'pending', tabId: 'x', no: 'AT-7' }), item('r-1', { after: ['r-0'], no: 'AT-8' })] }] });
ok('after: a no from the folder\'s own items', r.reasons[A]['r-1'].text === '前提の AT-7 が済んでいません', r.reasons[A]);
r = sched.planClosed({ ...base, folders: [{ folder: A, items: [item('r-1', { no: 'AT-1' }), item('r-2', { no: 'AT-2' })] }] });
ok('overlap: names the item started first by its no', /先に始める AT-1 と重なります/.test(r.reasons[A]['r-2'].text), r.reasons[A]['r-2'].text);
r = sched.planStarts({ waiting: [{ id: 'r-2', folder: A }], running: [{ id: 'r-1', folder: A }], nos: new Map([['r-1', 'AT-1']]) });
ok('planStarts overlap: the running item by its no', /実行中の AT-1 と重なります/.test(r.reasons['r-2'].text), r.reasons['r-2'].text);
r = sched.planStarts({ waiting: [{ id: 'r-1', folder: A, after: ['r-0'] }], items: new Map([['r-0', 'active']]) });
ok('without a no: the id as before', r.reasons['r-1'].text === '前提の r-0 が済んでいません', r.reasons['r-1']);

// --- buildProjects: blocked only when there is a reason
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'closedq-'));
  try {
    const bdir = path.join(tmp, 'backlog');
    const work = path.join(tmp, 'work');
    fs.mkdirSync(work, { recursive: true });
    let st = await backlog.getBacklog(bdir, work);
    st.items.push({ id: 'r-a', status: 'pending', text: 'first', createdAt: 1 }, { id: 'r-b', status: 'pending', text: 'second', createdAt: 2 });
    await backlog.saveBacklog(bdir, work, st);
    const calls = [];
    const projects = await manager.buildProjects({
      recent: [work],
      managerDir: path.join(tmp, 'mgr'),
      backlogDir: bdir,
      isOpen: () => false,
      blockedOf: (folder, i) => {
        calls.push([folder, i.id]);
        return i.id === 'r-b' ? { code: 'limit', text: '同時に動かす上限（3 件）に達しています' } : null;
      },
    });
    const pi = projects[0] && projects[0].pendingItems;
    const a = pi && pi.find((i) => i.id === 'r-a');
    const b = pi && pi.find((i) => i.id === 'r-b');
    ok('projects: open false listed', projects[0] && projects[0].open === false);
    ok('pendingItems: no blocked key without a reason', a && !('blocked' in a), a);
    ok('pendingItems: blocked { code, text }', b && b.blocked && b.blocked.code === 'limit' && /上限/.test(b.blocked.text), b);
    ok('blockedOf gets the folder and the item', calls.length === 2 && calls[0][0] === work, calls);
    const plain = await manager.buildProjects({ recent: [work], managerDir: path.join(tmp, 'mgr'), backlogDir: bdir });
    ok('without blockedOf: no blocked', plain[0].pendingItems.every((i) => !('blocked' in i)));

    // --- ルーター template
    const mgr = path.join(tmp, 'mgr');
    fs.mkdirSync(mgr, { recursive: true });
    manager.ensureManagerDir(mgr);
    const md = fs.readFileSync(path.join(mgr, 'CLAUDE.md'), 'utf8');
    ok(`template v${manager.CLAUDE_MD_VERSION} >= 20`, manager.CLAUDE_MD_VERSION >= 20 && md.startsWith(`<!-- bantodesk manager v${manager.CLAUDE_MD_VERSION} -->`));
    ok('template: pendingItems lists blocked with its codes', /\[\{ id, no, [^\]\n]*, blocked \}\]/.test(md) && /blocked は、その項目がまだ始まらない理由/.test(md) && ['limit', 'resource', 'overlap', 'after-failed', 'update', 'closed'].every((c) => md.includes(c)));
    ok('template: a closed folder alone does not hold the queue', /フォルダがアプリで開いていなくても/.test(md) && /open: false）だけでは止まらない/.test(md));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`closed-queue/unit: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
