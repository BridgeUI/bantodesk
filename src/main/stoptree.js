// Stop a session's whole process tree for sure (PROGRESS 49, docs/close-done.md). No Electron imports, so the choice of
// what to kill is testable from plain Node.
//
// Why: killPty (node-pty ConPTY kill) closes the pseudo console. Processes attached to it get CTRL_CLOSE and end, but a
// descendant with its own console or none (a detached / CREATE_NEW_CONSOLE child, a background server a tool started)
// is not attached and keeps running, holding its memory, after the tab's claude is gone.
// How: list the tree (pty pid + every descendant, with creation times) BEFORE the kill, kill the pty, wait for it to
// exit, then look again: every process of that list still there (same PID and same creation time: not a reused PID)
// is killed (TerminateProcess; with any child it started since), then checked once more.
const fs = require('fs');
const path = require('path');

const SAME_MS = 2000; // creation times read twice differ by rounding only
// The list comes from src/main/proclist.js (the app's native module, SEC3: NtQuerySystemInformation on a worker
// thread; not WMI: on this PC Get-CimInstance and taskkill (which uses WMI) can hang for good, docs/close-done.md).
const proclist = require('./proclist');

// procs, root pid -> [root, ...descendants] (root first; [] when root is not listed)
function treeOf(procs, root) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const r = byPid.get(root);
  if (!r) return [];
  const kids = new Map();
  for (const p of procs) {
    if (p.pid === p.ppid) continue;
    // a child is created after its parent: an older process whose parent PID was reused is not a descendant
    const par = byPid.get(p.ppid);
    if (par && Number.isFinite(p.created) && Number.isFinite(par.created) && p.created + SAME_MS < par.created) continue;
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const out = [];
  const seen = new Set();
  const stack = [r];
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push(p);
    for (const c of kids.get(p.pid) || []) stack.push(c);
  }
  return out;
}

// before: the tree listed before the kill, now: the list after -> the processes of `before` still running
function survivors(before, now) {
  const byPid = new Map(now.map((p) => [p.pid, p]));
  return before.filter((b) => {
    const n = byPid.get(b.pid);
    if (!n) return false;
    if (Number.isFinite(b.created) && Number.isFinite(n.created)) return Math.abs(b.created - n.created) <= SAME_MS;
    return n.name === b.name;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

// pid: the pty's process (node-pty t.pid), kill(): kills the pty, exited: Promise resolved when the pty exited,
// killPid(pid) -> Promise (TerminateProcess), listProcs (tests): () -> Promise<proclist rows>
// -> { at, pid, before: [{ pid, name }], survivors: [{ pid, name }] (alive after the pty kill), left: [{ pid, name }]
//      (alive after those kills too), error? }
// onBefore(rows) (optional): the tree listed before the kill, with creation times (src/main/leftovers.js remembers it:
// a child created in the middle of the kill and never resumed is then known as this tab's, PROGRESS 51c)
async function stopTree({ pid, kill, exited, killPid, listProcs, onBefore, waitMs = 5000, settleMs = 1500, tries = 3 }) {
  const res = { at: new Date().toISOString(), pid: pid || null, before: [], survivors: [], left: [] };
  const list = async () => (listProcs ? listProcs() : proclist.list({ timeout: 20000 }));
  let before = [];
  if (process.platform === 'win32' && pid) {
    try {
      before = treeOf(await list(), pid);
    } catch (e) {
      res.error = `list: ${e.message || e}`;
    }
  }
  if (onBefore && before.length) {
    try {
      onBefore(before);
    } catch {}
  }
  res.before = before.map((p) => ({ pid: p.pid, name: p.name }));
  try {
    kill();
  } catch {}
  await Promise.race([exited || Promise.resolve(), sleep(waitMs)]);
  if (!before.length) return res;
  let left = before;
  for (let i = 0; i < tries && left.length; i++) {
    await sleep(settleMs); // ConPTY close: attached processes get a moment to end by themselves
    try {
      const now = await list();
      // a survivor's children started after the first list go with it
      const more = new Map();
      for (const p of survivors(left, now)) for (const q of treeOf(now, p.pid)) more.set(q.pid, q);
      left = [...more.values()];
    } catch (e) {
      res.error = `check: ${e.message || e}`;
      break;
    }
    if (i === 0) res.survivors = left.map((p) => ({ pid: p.pid, name: p.name }));
    for (const p of left) await killPid(p.pid).catch(() => {});
  }
  res.left = left.map((p) => ({ pid: p.pid, name: p.name }));
  // the last kill round is checked once more
  if (left.length) {
    await sleep(settleMs);
    try {
      res.left = survivors(left, await list()).map((p) => ({ pid: p.pid, name: p.name }));
    } catch {}
  }
  return res;
}

// <userData>/stopped-trees.json: the last results (what was stopped, what had to be killed by hand, what stayed)
const LOG = 'stopped-trees.json';
const KEEP = 40;
function record(userData, entry) {
  try {
    const f = path.join(userData, LOG);
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {}
    if (!Array.isArray(list)) list = [];
    list.push(entry);
    fs.writeFileSync(f, JSON.stringify(list.slice(-KEEP), null, 1));
  } catch {}
}

module.exports = { stopTree, treeOf, survivors, record, LOG };
