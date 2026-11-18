// Unit: the queue order and reasons (src/main/queueorder.js buildQueueOrder). docs/queue-order.md.
//   node tmp/queue-order/unit.js        (AT_APP_ROOT=<stable> reads the stable code, as run.mjs --all-stable does)
const path = require('path');
const root = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.join(__dirname, '..', '..');
const Q = require(path.join(root, 'src', 'main', 'queueorder.js'));

let pass = 0;
let fail = 0;
const ok = (name, cond, ev = '') => {
  if (cond) pass++;
  else fail++;
  console.log(cond ? 'PASS' : 'FAIL', name, ev !== '' ? '| ' + (typeof ev === 'string' ? ev : JSON.stringify(ev)).slice(0, 400) : '');
};

const A = '/w/A';
const B = '/w/B';
const it = (id, o = {}) => ({ id, no: o.no || id.toUpperCase().replace(/^R-/, 'AT-'), status: 'pending', text: `task ${id}`, ...o });
const byId = (r, folder, id) => r.folders.find((f) => f.folder === folder).items.find((x) => x.id === id);

// 1. the head is held by the limit: every waiting item gets limit, the head of the first folder is next
{
  const r = Q.buildQueueOrder({
    folders: [
      { folder: A, open: true, items: [it('r-a1', { status: 'active', touches: ['a1'] }), it('r-a2', { touches: ['a2'] }), it('r-a3', { touches: ['a3'] })] },
      { folder: B, open: true, items: [it('r-b1', { status: 'active', touches: ['b1'] }), it('r-b2', { status: 'active', touches: ['b2'] }), it('r-b3', { touches: ['b3'] })] },
    ],
    running: [{ folder: A, id: 'r-a1', touches: ['a1'] }, { folder: B, id: 'r-b1', touches: ['b1'] }, { folder: B, id: 'r-b2', touches: ['b2'] }],
    limit: 3,
  });
  ok('1a positions in queue order', r.folders[0].items.map((x) => x.position).join() === '1,2' && r.folders[0].items[0].id === 'r-a2', r.folders[0].items);
  ok('1b all wait on the limit', r.folders.flatMap((f) => f.items).every((x) => x.reason && x.reason.code === 'limit'), r.folders.flatMap((f) => f.items.map((x) => x.reason)));
  ok('1c next = head of A (limit)', r.next && r.next.id === 'r-a2' && r.next.why === 'limit', r.next);
  ok('1d next is marked on the row only', byId(r, A, 'r-a2').next === true && byId(r, A, 'r-a3').next === false && byId(r, B, 'r-b3').next === false);
  ok('1e line names it, waits for a slot (the free count is on the band, not here)', /^次のタスク: A · AT-A2（空き待ち）$/.test(r.line), r.line);
  ok('1f running / free', r.running === 3 && r.free === 0 && r.limit === 3);
}

// 2. overlap of touches with a running item: the reason names it, the overlap partner is given; a later item that
//    does not overlap starts (next = free) and the earlier one is passed
{
  const r = Q.buildQueueOrder({
    folders: [{ folder: A, open: true, items: [it('r-a1', { status: 'active', touches: ['src/x.js'] }), it('r-a2', { touches: ['src/x.js'] }), it('r-a3', { kind: 'research', touches: ['docs/q.md'] }), it('r-a4', { touches: ['src/x.js', 'src/y.js'] })] }],
    running: [{ folder: A, id: 'r-a1', touches: ['src/x.js'] }],
    limit: 3,
  });
  const a2 = byId(r, A, 'r-a2');
  ok('2a overlap reason', a2.reason && a2.reason.code === 'overlap' && /AT-A1/.test(a2.reason.text), a2.reason);
  ok('2b overlap partner = running AT-A1', a2.overlap && a2.overlap.id === 'r-a1' && a2.overlap.running === true, a2.overlap);
  ok('2c detail line says 重なり', a2.detail.some((d) => /^重なり: AT-A1（動作中）/.test(d)), a2.detail);
  const a3 = byId(r, A, 'r-a3');
  ok('2d research on other files may start, it is next (free)', a3.state === 'next' && r.next && r.next.id === 'r-a3' && r.next.why === 'free', { a3, next: r.next });
  ok('2e line with a free slot: just the task', /^次のタスク: AT-A3$/.test(r.line), r.line);
  const a4 = byId(r, A, 'r-a4');
  ok('2f the 4th overlaps the 2nd waiting one too (ahead)', a4.ahead.some((x) => x.id === 'r-a2' && x.position === 1), a4.ahead);
}

// 3. prerequisite not done: the after list says where it is (its place in the queue, another folder); failed one
{
  const r = Q.buildQueueOrder({
    folders: [
      { folder: A, open: true, items: [it('r-a1', { status: 'active', kind: 'research' }), it('r-a2'), it('r-a3', { after: ['r-a2'] }), it('r-a4', { after: ['r-b9'] })] },
      { folder: B, open: false, items: [it('r-b9', { status: 'failed' })] },
    ],
    running: [{ folder: A, id: 'r-a1', kind: 'research' }],
    limit: 2,
  });
  const a3 = byId(r, A, 'r-a3');
  ok('3a after reason', a3.reason && a3.reason.code === 'after' && /AT-A2/.test(a3.reason.text), a3.reason);
  ok('3b after: position 1 of the same queue', a3.after[0] && a3.after[0].position === 1 && a3.after[0].status === 'pending', a3.after);
  ok('3c detail 前提: AT-A2（1 番目）', a3.detail.includes('前提: AT-A2（1 番目）'), a3.detail);
  const a4 = byId(r, A, 'r-a4');
  ok('3d failed prerequisite in another folder', a4.reason.code === 'after-failed' && a4.after[0].folderName === 'B' && a4.after[0].status === 'failed', a4);
  ok('3e detail 前提: AT-B9（B・失敗）', a4.detail.includes('前提: AT-B9（B・失敗）'), a4.detail);
  ok('3f the head a2 is next (free, limit 2 with 1 running)', r.next && r.next.id === 'r-a2' && r.next.why === 'free', r.next);
}

// 4. update reserved: everything waits for the update, nothing is next
{
  const r = Q.buildQueueOrder({
    folders: [{ folder: A, open: true, items: [it('r-a1'), it('r-a2')] }],
    running: [],
    limit: 3,
    hold: { code: 'update', text: '更新待ち（再起動の後に始めます）' },
  });
  ok('4a update reason on all', r.folders[0].items.every((x) => x.reason && x.reason.code === 'update'), r.folders[0].items.map((x) => x.reason));
  ok('4b no next, line = the hold text', r.next === null && r.line === '更新待ち（再起動の後に始めます）', r.line);
}

// 5. global next: open folders before closed ones; a closed folder's non-routed item waits for the folder to open;
//    tab-tied pending items are not in the numbered queue
{
  const r = Q.buildQueueOrder({
    folders: [
      { folder: B, open: false, items: [it('r-b1'), it('m-b2')] },
      { folder: A, open: true, items: [it('r-a1', { tabId: 't1' }), it('r-a2')] },
    ],
    running: [{ folder: A, id: 'x1', kind: 'research' }, { folder: B, id: 'x2', kind: 'research' }, { folder: B, id: 'x3', kind: 'research' }],
    limit: 4,
  });
  ok('5a next is in the open folder A even though B is listed first', r.next && r.next.id === 'r-a2', r.next);
  ok('5b folders keep the given order in the result', r.folders[0].folder === B && r.folders[1].folder === A);
  ok('5c closed folder non-routed item waits (closed)', byId(r, B, 'm-b2').reason.code === 'closed', byId(r, B, 'm-b2').reason);
  ok('5d tab-tied item is apart (tabbed, no number)', r.folders[1].items.length === 1 && r.folders[1].tabbed.length === 1 && r.folders[1].tabbed[0].id === 'r-a1');
}

// 6. resources over their mark while something runs: next waits for the resources
{
  const r = Q.buildQueueOrder({
    folders: [{ folder: A, open: true, items: [it('r-a1', { status: 'active' }), it('r-a2')] }],
    running: [{ folder: A, id: 'r-a1', kind: 'research', touches: ['docs'] }],
    limit: 3,
    over: ['CPU 92%（目安 80% 超え）'],
  });
  const a2 = byId(r, A, 'r-a2');
  ok('6a overlap first (implement without touches = whole folder)', a2.reason.code === 'overlap', a2.reason);
  const r2 = Q.buildQueueOrder({
    folders: [{ folder: A, open: true, items: [it('r-a2', { kind: 'research', touches: ['tmp/x'] })] }],
    running: [{ folder: B, id: 'r-b1' }],
    limit: 3,
    over: ['CPU 92%（目安 80% 超え）'],
  });
  ok('6b resource reason, next waits for resources', r2.next && r2.next.why === 'resource' && /（資源待ち）$/.test(r2.line), r2);
}

// 7. all stuck on prerequisites: no next, the line says why
{
  const r = Q.buildQueueOrder({
    folders: [{ folder: A, open: true, items: [it('r-a1', { status: 'active' }), it('r-a2', { after: ['r-a1'] })] }],
    running: [{ folder: A, id: 'r-a1' }],
    limit: 3,
  });
  ok('7a no next when every item waits on after / overlap', r.next === null && /^次のタスク: なし（前提・重なり待ち）$/.test(r.line), r.line);
  const e = Q.buildQueueOrder({ folders: [{ folder: A, open: true, items: [] }], running: [], limit: 3 });
  ok('7b empty queue line', e.line === '次のタスク: なし', e.line);
}

// 8. last ルーター reorder and the user's order lock
{
  const now = 1_800_000_000_000;
  const r = Q.buildQueueOrder({
    folders: [{ folder: A, open: true, items: [it('r-a1')] }],
    running: [],
    reorders: { '/w/a': { at: now - 60000, reason: '依存の順に並べた' } },
    locks: { '/w/a': now - 3 * 3600e3 - 20 * 60e3 },
    now,
  });
  const f = r.folders[0];
  ok('8a lastReorder', f.lastReorder && f.lastReorder.reason === '依存の順に並べた', f.lastReorder);
  ok('8b orderLock with time left 20h40m', f.orderLock && f.orderLock.leftText === '20 時間 40 分', f.orderLock);
  const r2 = Q.buildQueueOrder({ folders: [{ folder: A, open: true, items: [it('r-a1')] }], locks: { '/w/a': now - 25 * 3600e3 }, now });
  ok('8c lock gone after 24 h', r2.folders[0].orderLock === null);
}

// 10. the line under a row says each thing once: overlap = the scheduler's text, after = 前提 with its place, next = nothing
{
  const r = Q.buildQueueOrder({
    folders: [{ folder: A, open: true, items: [it('r-a1', { status: 'active', touches: ['src/x.js'] }), it('r-a2', { touches: ['src/x.js'] }), it('r-a3', { touches: ['src/z.js'] }), it('r-a4', { touches: ['src/y.js'], after: ['r-a2'] }), it('r-a5', { touches: ['src/x.js', 'src/w.js'] })] }],
    running: [{ folder: A, id: 'r-a1', touches: ['src/x.js'] }, { folder: B, id: 'r-b1', kind: 'research' }],
    limit: 2,
  });
  const g = (id) => byId(r, A, id).info;
  ok('10a overlap: one text naming the files and the task', g('r-a2').length === 1 && g('r-a2')[0] === 'src/x.js が実行中の AT-A1 と重なります', g('r-a2'));
  ok('10b next (limit): no line', g('r-a3').length === 0 && byId(r, A, 'r-a3').next, g('r-a3'));
  ok('10c after: 前提 with its place instead of the reason text', g('r-a4').join('|') === '前提: AT-A2（1 番目）', g('r-a4'));
  ok('10d overlap with a running one + an earlier waiting one: the overlap text only', g('r-a5').length === 1 && /AT-A1/.test(g('r-a5')[0]), g('r-a5'));
}

// 9. the request text for the ルーター
{
  const t = Q.askText('/w/proj', '  急ぎの AT-3 を先に ');
  ok('9a ask text', t.startsWith('proj の待ち行列の順番を見直して: 急ぎの AT-3 を先に') && t.includes('/w/proj'), t);
}

console.log(`\n${pass}/${fail}`);
process.exit(fail ? 1 : 0);
