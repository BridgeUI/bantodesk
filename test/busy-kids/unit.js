// Unit (AT-200): src/main/leftovers.js liveKids — which processes under a live tab's claude keep the tab from being
// closed / rested automatically. Plain Node, made-up process rows; no process is listed, started or stopped.
//   node tmp/busy-kids/unit.js        (AT_APP_ROOT=<app> for another copy)
const path = require('path');

const root = path.resolve(process.env.AT_APP_ROOT || path.join(__dirname, '..', '..'));
const L = require(path.join(root, 'src', 'main', 'leftovers.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
}

const NOW = Date.parse('2026-11-13T12:00:00Z');
const MIN = 60_000;
const P = (pid, ppid, name, agoMin, o = {}) => ({ pid, ppid, name, created: NOW - agoMin * MIN, threads: 4, priv: 2 * 1048576, suspended: false, ...o });
// main 100, the tab's claude 200 (root, started 60 min ago), its MCP server 210 (at the start)
const START = NOW - 60 * MIN;
const base = () => [P(4, 0, 'System', 999), P(100, 4, 'electron.exe', 120), P(200, 100, 'claude.exe', 60), P(210, 200, 'node.exe', 59.9)];
const kids = (procs, o = {}) => L.liveKids({ procs, rootPid: 200, startedAt: START, ...o }).map((x) => x.pid).sort((a, b) => a - b);
const J = JSON.stringify;

ok('1 nothing but the start-up helper (MCP server within the settle) -> none', J(kids(base())) === '[]', kids(base()));
ok('2 a background command started at work -> counted', J(kids([...base(), P(300, 200, 'bash.exe', 5)])) === '[300]');
ok('3 its own child (grandchild of claude) -> counted too', J(kids([...base(), P(300, 200, 'bash.exe', 5), P(310, 300, 'node.exe', 4)])) === '[300,310]');
ok('4 a child of the start-up helper made later -> counted', J(kids([...base(), P(320, 210, 'python.exe', 3)])) === '[320]');
ok('5 suspended (never runs, 51c) -> not counted', J(kids([...base(), P(330, 200, 'git.exe', 5, { suspended: true, threads: 1 })])) === '[]');
ok('6 msedgewebview2.exe -> not counted', J(kids([...base(), P(340, 200, 'msedgewebview2.exe', 5)])) === '[]');
ok('7 a process under another claude / not under the tab -> not counted', J(kids([...base(), P(400, 100, 'claude.exe', 30), P(410, 400, 'bash.exe', 5), P(500, 4, 'node.exe', 5)])) === '[]');
ok('8 the root itself is never counted', !kids([...base(), P(300, 200, 'bash.exe', 5)]).includes(200));
ok('9 a "child" older than the claude (PID reused) -> not counted', J(kids([...base(), P(350, 200, 'old.exe', 90)])) === '[]');
ok('10 no startedAt -> the start-up helper counts (nothing known to leave out)', J(L.liveKids({ procs: base(), rootPid: 200 }).map((x) => x.pid)) === '[210]');
ok('11 settleMs 0 -> the start-up helper counts', J(kids(base(), { settleMs: 0 })) === '[210]');
// 12: remembered by the tracker under this root: its parent (bash 300) died, the child (node 360, ppid 300) lives on
{
  const known = new Map();
  const before = [...base(), P(300, 200, 'bash.exe', 10), P(360, 300, 'node.exe', 9)];
  L.remember(known, before, [{ pid: 200 }], NOW - 8 * MIN);
  const after = [...base(), P(360, 300, 'node.exe', 9)];
  ok('12a without the tracker: the orphan is not seen in the tree', J(kids(after)) === '[]');
  ok('12b with what the tracker remembered: counted', J(kids(after, { known })) === '[360]');
  // a remembered process of another root does not count here
  const known2 = new Map();
  L.remember(known2, [...base(), P(400, 100, 'claude.exe', 30), P(410, 400, 'bash.exe', 10)], [{ pid: 400 }], NOW - 8 * MIN);
  ok('12c remembered under another tab -> not counted', J(kids([...base(), P(410, 400, 'bash.exe', 10)], { known: known2 })) === '[]');
  // the remembered PID now belongs to another process (other creation time) -> not counted
  ok('12d remembered PID reused by a later process -> not counted', J(kids([...base(), P(360, 4, 'node.exe', 1)], { known })) === '[]');
}
// 13: macOS e2e: the made-up rows have no row for the root (only the children) -> found by parent PID
ok('13 no row for the root (made-up rows only) -> its children by parent PID', J(L.liveKids({ procs: [P(9000001, 200, 'sleep', 0.5)], rootPid: 200, startedAt: NOW - MIN }).map((x) => x.pid)) === '[9000001]');
ok('14 a row with threads 0 (exited, a handle still held) -> not counted', J(kids([...base(), P(300, 200, 'bash.exe', 5, { threads: 0 })])) === '[]');
ok('15 rows carry name and created', (() => {
  const r = L.liveKids({ procs: [...base(), P(300, 200, 'bash.exe', 5)], rootPid: 200, startedAt: START })[0];
  return r && r.name === 'bash.exe' && r.created === NOW - 5 * MIN;
})());

console.log(`\n${pass} ok, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
