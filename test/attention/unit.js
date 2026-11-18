// UIUX U3 「あなたの番」 (src/main/attention.js): what the ルーター may press (U3 QA 1 widening), the list per kind (taken in /
// gone), the fixed order, the promptKey check of the answer path, the nudge counter, notices.forAttention.
//   node tmp/attention/unit.js            (AT_APP_ROOT=<app> to test another copy, e.g. the stable one)
const path = require('path');
const ROOT = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src', 'main');
const attention = require(path.join(SRC, 'attention.js'));
const stuck = require(path.join(SRC, 'stuck.js'));
const notices = require(path.join(SRC, 'notices.js'));
console.log('src:', SRC);

let pass = 0;
let fail = 0;
const ok = (name, cond, ev) => {
  if (cond) pass++;
  else fail++;
  console.log(cond ? 'PASS' : 'FAIL', name, cond || ev === undefined ? '' : '| ' + JSON.stringify(ev).slice(0, 300));
};

const folder = path.resolve(__dirname, 'work', 'proj');
const mgr = path.resolve(__dirname, 'work', 'manager');
const perm = (cmd, key = 'k' + Math.random().toString(36).slice(2, 8), extra = {}) => ({
  key,
  since: 1000,
  question: 'Do you want to proceed?',
  kind: 'permission',
  options: [{ n: 1, label: 'Yes' }, { n: 2, label: "Yes, and don't ask again for this command" }, { n: 3, label: 'No, and tell Claude what to do differently (esc)' }],
  context: ['Bash command', '', `  ${cmd}`, '  Run it', ''],
  complete: true,
  ...extra,
});
const V = (cmd) => attention.pmoVerdict(perm(cmd), folder);

// ---- 1. what the ルーター may press -------------------------------------------------------------------------------------
ok('plain command inside: safe (base rule)', V('npm test').safe === true);
ok('outside the folder: safe now (relaxed)', V('cat C:\\Windows\\win.ini').safe === true && /作業フォルダの外/.test(V('cat C:\\Windows\\win.ini').relaxed), V('cat C:\\Windows\\win.ini'));
ok('network (curl): safe now', V('curl https://example.com/x.json').safe === true && V('curl https://example.com/x.json').relaxed === 'ネットワークへの送信');
ok('network + overwrite (curl > file): refused', V('curl https://example.com > out.json').safe === false, V('curl https://example.com > out.json'));
ok('git push: refused (git, before network)', V('git push origin main').safe === false && /git/.test(V('git push origin main').reason));
ok('delete build/: refused (削除)', V('rm -rf build').safe === false && V('rm -rf build').reason === '削除');
ok('delete tmp/x: safe (temporary)', V('rm -rf tmp/x').safe === true, V('rm -rf tmp/x'));
ok('delete tmp + src: refused', V('rm -rf tmp/x && rm -rf src').safe === false);
ok('delete tmp/../src: refused', V('rm -rf tmp/../src').safe === false);
ok('delete tmp/*: refused (wildcard)', V('rm -rf tmp/*').safe === false);
ok('Remove-Item $env:TEMP\\foo: safe', V('Remove-Item -Recurse -Force $env:TEMP\\foo').safe === true, V('Remove-Item -Recurse -Force $env:TEMP\\foo'));
ok('del AppData\\Local\\Temp\\a.tmp: safe', V('del /q C:\\Users\\me\\AppData\\Local\\Temp\\a.tmp').safe === true, V('del /q C:\\Users\\me\\AppData\\Local\\Temp\\a.tmp'));
ok('delete out.tmp file: safe', V('rm out.tmp').safe === true);
ok('delete tmp + git reset --hard: refused', V('rm -rf tmp/x; git reset --hard').safe === false);
ok('.env: refused (秘密情報)', V('cat .env').safe === false && /秘密情報/.test(V('cat .env').reason));
ok('rm .env in tmp: refused (secret first)', V('rm tmp/.env').safe === false);
ok('the word "delete" in prose only: refused', attention.pmoVerdict({ ...perm('node x.js'), question: 'Do you want to delete the cache?' }, folder).safe === false);
ok('incomplete dialog: refused', attention.pmoVerdict(perm('curl https://x', 'k1', { complete: false }), folder).safe === false);
ok('wide yes only: refused', attention.pmoVerdict({ ...perm('curl https://x'), options: [{ n: 1, label: "Yes, and don't ask again" }, { n: 2, label: 'No' }] }, folder).safe === false);
ok('question kind: never safe', attention.pmoVerdict({ ...perm('x'), kind: 'question' }, folder).safe === false);
ok('safe choice is the plain Yes (1)', V('curl https://example.com').choice === 1);
// one place for the rules: attention.js uses stuck.js's own DENY patterns (stuck.RULES, no copies), and they still
// match what dangerOf names (the first matching reason in the DENY order)
const R = attention._re;
ok('rules from stuck.js (same objects, no copies)', !!stuck.RULES && R.GIT_RE === stuck.RULES.GIT_RE && R.IRREV_RE === stuck.RULES.IRREV_RE && R.DELETE_RE === stuck.RULES.DELETE_RE);
ok('stuck.RULES are its DENY patterns', ['git push', 'kill 3', 'rm a'].map((c) => stuck.dangerOf(perm(c))).join('|') === '取り返しのつかない git の操作|取り返しのつかない操作|削除', ['git push', 'kill 3', 'rm a'].map((c) => stuck.dangerOf(perm(c))));
const same = [
  ['git reset --hard', 'git', R.GIT_RE],
  ['Stop-Process -Id 3', '取り返しのつかない操作', R.IRREV_RE],
  ['mv a b', '取り返しのつかない操作', R.IRREV_RE],
  ['Remove-Item x', '削除', R.DELETE_RE],
  ['git rm a', '削除', R.DELETE_RE],
];
for (const [cmd, word, re] of same) ok(`rule copy in step: ${cmd}`, re.test(cmd) && stuck.dangerOf(perm(cmd)).includes(word), stuck.dangerOf(perm(cmd)));
// relaxWaiting: sessions.json / the answer action see the widened verdict
const wl = attention.relaxWaiting([{ tabKey: 't1', prompt: perm('curl https://example.com', 'pk1'), folder, verdict: stuck.classify(perm('curl https://example.com', 'pk1'), folder) }]);
ok('relaxWaiting: network entry safe', wl[0].verdict.safe === true);
ok('checkAnswer accepts it now', stuck.checkAnswer({ tabKey: 't1', promptKey: 'pk1', choice: 1, reason: 'r' }, wl).ok === true);
ok('checkAnswer: stale promptKey refused', /changed/.test(stuck.checkAnswer({ tabKey: 't1', promptKey: 'zz', choice: 1, reason: 'r' }, wl).error || ''));

// ---- 2. the list ---------------------------------------------------------------------------------------------------
const now = 100000;
const wentry = (tabId, prompt, o = {}) => ({ wcId: o.wcId || 1, tabId, folder: o.folder || folder, folderName: path.basename(o.folder || folder), label: o.label || 'タブ', kind: 'input', since: prompt ? prompt.since : now - 60000, waitedMs: 60000, hidden: false, text: '', prompt, screen: prompt ? [] : ['x'], danger: prompt ? stuck.dangerOf(prompt) : '' });
const pDel = { ...perm('rm -rf build', 'pdel'), since: now - 60000 };
const pSafe = { ...perm('npm test', 'psafe'), since: now - 60000 };
const pNet = { ...perm('curl https://example.com', 'pnet'), since: now - 60000 };
const pNew = { ...perm('rm -rf build2', 'pnew'), since: now - 2000 };
const pQ = { key: 'pq', since: now - 30000, question: 'どちらにしますか？', kind: 'question', options: [{ n: 1, label: 'A' }, { n: 2, label: 'B' }, { n: 3, label: 'Type something.' }], context: [], complete: true };
const pOwn = { ...perm('npm test', 'pown'), since: now - 60000 };
const inbox = [
  { id: 'i1', reqNo: '依頼-1', no: '', title: '依頼の見出し', text: '本文1', status: 'new', folder: null, createdAt: 10 },
  { id: 'i2', reqNo: '依頼-2', no: '', title: '', text: '答え済みの依頼', status: 'new', folder: null, createdAt: 11 },
  { id: 'i3', reqNo: '依頼-3', no: 'AT-9', title: '', text: '振り分け済み', status: 'routed', folder, createdAt: 12 },
];
const backlogItems = { b1: { id: 'b1', no: 'AT-5', title: 'タスク5', text: 't5', status: 'pending' }, b2: { id: 'b2', no: 'AT-6', title: 'タスク6', text: 't6', status: 'active' }, b3: { id: 'b3', no: 'AT-7', title: 'タスク7', text: 't7', status: 'active' } };
const rows = [{ topic: '論点', hypothesis: '仮説', question: '質問', answer: '' }];
const qaList = [
  { key: 'inbox|i1', folder: null, itemId: null, inboxId: 'i1', rows, status: 'open', createdAt: 20 },
  { key: 'inbox|i2', folder: null, itemId: null, inboxId: 'i2', rows, status: 'answered', createdAt: 21 },
  { key: `${folder.toLowerCase()}|b1`, folder, itemId: 'b1', inboxId: null, rows: [...rows, ...rows], status: 'open', createdAt: 22 },
  { key: `${folder.toLowerCase()}|b2`, folder, itemId: 'b2', inboxId: null, rows, status: 'open', createdAt: 23 },
];
const ntc = [
  { id: 'n1', kind: 'proposal', title: '提案1', text: 'x', folder, itemId: null, createdAt: 30, answer: null, resolvedAt: null },
  { id: 'n2', kind: 'proposal', title: '回答済み', text: 'x', folder, itemId: null, createdAt: 31, answer: { choice: 'go' }, resolvedAt: null },
  { id: 'n3', kind: 'warn', title: '指摘', text: 'x', folder, itemId: null, createdAt: 32, answer: null, resolvedAt: null },
  { id: 'n4', kind: 'info', title: 'お知らせ', text: 'x', folder, itemId: null, createdAt: 33, answer: null, resolvedAt: null },
];
const tabs = new Map([['1:tdel', { backlogId: 'b3', role: 'project' }], ['9:town', { backlogId: null, role: 'manager' }]]);
const input = (over = {}) => ({
  now,
  managerDir: mgr,
  waiting: [wentry('tdel', pDel), wentry('tsafe', pSafe), wentry('tnet', pNet), wentry('tnew', pNew), wentry('tq', pQ), wentry('town', pOwn, { wcId: 9, folder: mgr }), wentry('tscr', null), { ...wentry('terr', null), kind: 'error' }],
  tabs,
  qa: qaList,
  notices: notices.forAttention(ntc),
  inbox,
  task: (f, id) => (path.resolve(f).toLowerCase() === folder.toLowerCase() ? backlogItems[id] || null : null),
  nudges: [],
  graceMs: 10000,
  nudgeSettleMs: 300000,
  ...over,
});
let items = attention.build(input());
// a dialog's id is s:<tabId>:<promptKey>:<since> (AT-159: the same dialog asked again is a new card); 's:<tab>:<key>'
// here finds it with the since of its entry
const byId = (id) => items.find((i) => i.id === id || (/^s:[^:]+:[^:]+$/.test(id) && id !== `s:${i.tabId}:screen` && i.id === `${id}:${i.entry && i.entry.since}`));
ok('dialog id carries the since of the dialog (s:<tab>:<key>:<since>)', items.some((i) => i.id === `s:tdel:pdel:${i.entry && i.entry.since}` && Number.isFinite(i.entry.since)), items.filter((i) => /^s:/.test(i.id)).map((i) => i.id));
{
  // the same dialog asked again (a new since) is another id; while it stays on the screen (same since) the id stays
  const pd = items.find((i) => i.tabId === 'tdel');
  const again = attention.build(input({ waiting: [{ ...pd.entry, since: pd.entry.since + 5000, prompt: { ...pd.entry.prompt, since: pd.entry.since + 5000 } }], qa: [], notices: [], nudges: [], now: now + 60000 }));
  const same = attention.build(input({ waiting: [pd.entry], qa: [], notices: [], nudges: [], now: now + 60000 }));
  ok('same dialog asked again -> new id; same dialog still there -> same id', again.length === 1 && again[0].id !== pd.id && same.length === 1 && same[0].id === pd.id, { pd: pd.id, again: again.map((i) => i.id), same: same.map((i) => i.id) });
}
ok('confirm: delete dialog in', byId('s:tdel:pdel') && byId('s:tdel:pdel').kind === 'confirm');
ok('confirm: why short 確認（削除）, full has the reason', byId('s:tdel:pdel') && byId('s:tdel:pdel').why.short === '確認（削除）' && /ルーターは押せません: 削除/.test(byId('s:tdel:pdel').why.full), byId('s:tdel:pdel') && byId('s:tdel:pdel').why);
ok('confirm: task AT-7 of its backlog item', byId('s:tdel:pdel') && byId('s:tdel:pdel').task && byId('s:tdel:pdel').task.no === 'AT-7');
ok('confirm: carries wcId / tabId / promptKey / entry', byId('s:tdel:pdel') && byId('s:tdel:pdel').promptKey === 'pdel' && byId('s:tdel:pdel').entry.prompt.key === 'pdel' && byId('s:tdel:pdel').danger === '削除');
ok('safe dialog: out (the ルーター / Auto-yes takes it)', !byId('s:tsafe:psafe'));
ok('network dialog: out (the ルーター may press it now)', !byId('s:tnet:pnet'));
ok('new dialog inside the grace: out', !byId('s:tnew:pnew'));
ok('question: in (no grace)', byId('s:tq:pq') && byId('s:tq:pq').kind === 'question' && byId('s:tq:pq').why.short === '質問');
ok("ルーター's own dialog: in, own, ダッシュボード", byId('s:town:pown') && byId('s:town:pown').own === true && byId('s:town:pown').folderName === 'ダッシュボード');
ok('unreadable dialog: confirm 画面の確認', byId('s:tscr:screen') && byId('s:tscr:screen').why.short === '画面の確認');
ok('error session: out', !items.some((i) => i.tabId === 'terr'));
ok('qa: open inbox table in, task 依頼-1', byId('qa:inbox|i1') && byId('qa:inbox|i1').task.reqNo === '依頼-1' && byId('qa:inbox|i1').why.short === 'QA 1問');
ok('qa: answered table out', !byId('qa:inbox|i2'));
ok('qa: pending task table in (QA 2問, AT-5)', byId(`qa:${folder.toLowerCase()}|b1`) && byId(`qa:${folder.toLowerCase()}|b1`).task.no === 'AT-5' && byId(`qa:${folder.toLowerCase()}|b1`).why.short === 'QA 2問');
ok('qa: started task table out', !byId(`qa:${folder.toLowerCase()}|b2`));
ok('proposal: unanswered in, answered out', byId('p:n1') && byId('p:n1').kind === 'proposal' && byId('p:n1').title === '提案1' && !byId('p:n2'));
ok('warn / info: never in', !byId('p:n3') && !byId('p:n4') && !items.some((i) => /n3|n4/.test(i.id)));
items = attention.build(input({ now: now + 9000 }));
ok('grace passed: the new dialog comes in', !!byId('s:tnew:pnew'));

// inbox QA of a routed request: out (moveInbox carries the table to the task)
ok('qa of a routed request: out', !attention.build(input({ qa: [{ key: 'inbox|i3', folder: null, itemId: null, inboxId: 'i3', rows, status: 'open', createdAt: 1 }] })).length || !attention.build(input({ qa: [{ key: 'inbox|i3', folder: null, itemId: null, inboxId: 'i3', rows, status: 'open', createdAt: 1 }] })).some((i) => i.id === 'qa:inbox|i3'));

// nudges
const g = { tabKey: 'tn', wcId: 1, folder, folderName: 'proj', label: '止まったタブ', backlogId: 'b1', count: 2, firstAt: now - 20 * 60000, lastAt: now - 6 * 60000, waitText: 'node x.mjs の出力が止まっています' };
items = attention.build(input({ waiting: [], qa: [], notices: [], nudges: [g] }));
ok('nudge: 2 nudges + settle passed -> in', byId('n:tn') && byId('n:tn').kind === 'nudge' && byId('n:tn').why.short === '止まって 20分' && /2 回後押し/.test(byId('n:tn').why.full) && byId('n:tn').task.no === 'AT-5', items);
ok('nudge: 1 nudge -> out', !attention.build(input({ waiting: [], qa: [], notices: [], nudges: [{ ...g, count: 1 }] })).length);
ok('nudge: inside the settle time -> out', !attention.build(input({ waiting: [], qa: [], notices: [], nudges: [{ ...g, lastAt: now - 60000 }] })).length);

// ---- 3. fixed order --------------------------------------------------------------------------------------------------
const order = attention.createOrder();
const mk = (id, since) => ({ id, since });
let o1 = order.apply([mk('c', 30), mk('a', 10), mk('b', 20)]);
ok('first batch: oldest first', o1.map((i) => i.id).join() === 'a,b,c', o1);
let o2 = order.apply([mk('c', 30), mk('d', 5), mk('a', 10), mk('b', 20)]);
ok('a new one goes to the end even if older', o2.map((i) => i.id).join() === 'a,b,c,d', o2);
let o3 = order.apply([mk('d', 5), mk('c', 31), mk('a', 99)]);
ok('a gone one leaves no gap; a changed one keeps its place', o3.map((i) => i.id).join() === 'a,c,d', o3);
let o4 = order.apply([mk('d', 5), mk('b', 20), mk('a', 99), mk('c', 31)]);
ok('one that comes back is new (end)', o4.map((i) => i.id).join() === 'a,c,d,b', o4);

// ---- 4. the answer path checks the dialog (dashboard:answer = stuck.checkUserAnswer) --------------------------------
const ul = [wentry('tq', { ...pQ, options: pQ.options.map((x) => ({ ...x, checked: false, other: /Type something/.test(x.label) })), submitLabel: '', tabs: [] })];
ok('answer with the shown promptKey: ok', stuck.checkUserAnswer({ wcId: 1, tabId: 'tq', promptKey: 'pq', choice: 2 }, ul).ok === true);
ok('answer from an old screen (other promptKey): 質問が変わりました, nothing pressed', stuck.checkUserAnswer({ wcId: 1, tabId: 'tq', promptKey: 'old', choice: 2 }, ul).changed === true);
ok('answer to a tab no longer asking: changed', stuck.checkUserAnswer({ wcId: 1, tabId: 'gone', promptKey: 'pq', choice: 1 }, ul).changed === true);

// ---- 5. nudge counter ------------------------------------------------------------------------------------------------
const nt = attention.createNudges({ resetMs: 60000 });
const we = { tabKey: 'tz', wcId: 3, folder, folderName: 'proj', label: 'L', backlogId: 'b1', wait: { kind: 'command', text: '待ち', alerts: [{ code: 'silent' }] } };
nt.nudged(we, 1000);
nt.nudged(we, 2000);
ok('two nudges counted', nt.list().length === 1 && nt.list()[0].count === 2 && nt.list()[0].firstAt === 1000 && nt.list()[0].lastAt === 2000);
nt.seen([{ ...we, wait: null }], 3000);
ok('running after a nudge: kept but not listed', nt.list().length === 0);
nt.seen([we], 4000);
ok('waits again: listed with its count', nt.list().length === 1 && nt.list()[0].count === 2);
nt.seen([{ ...we, wait: null }], 5000);
nt.seen([{ ...we, wait: null }], 70000);
ok('not waiting for resetMs: starts over', nt.list().length === 0 && (nt.nudged(we, 71000), nt.list()[0].count === 1));
nt.seen([], 72000);
ok('tab gone: dropped', nt.list().length === 0);
nt.nudged(we, 1000);
ok('dismiss: dropped', nt.dismiss('tz') === true && nt.list().length === 0);
const nl = attention.createNudges();
nl.load([{ at: new Date(Date.now() - 60000).toISOString(), type: 'nudge', tabKey: 'tl', folder, label: 'L', wait: 'w' }, { at: new Date(Date.now() - 30000).toISOString(), type: 'nudge', tabKey: 'tl' }, { at: new Date(Date.now() - 9 * 3600e3).toISOString(), type: 'nudge', tabKey: 'tl' }, { at: new Date().toISOString(), type: 'answer', tabKey: 'tl' }]);
ok('load: recent nudges of the log counted (old / other types not)', nl.list().length === 1 && nl.list()[0].count === 2 && nl.list()[0].waitText === 'w');

// ---- 6. notices.forAttention / signature -----------------------------------------------------------------------------
const fa = notices.forAttention([...ntc, { id: 'n0', kind: 'proposal', title: '古い', text: '', createdAt: 1, answer: null, resolvedAt: null }, { id: 'n9', kind: 'proposal', title: '消えた', createdAt: 2, answer: null, resolvedAt: 5 }]);
ok('forAttention: open proposals only, oldest first', fa.map((n) => n.id).join() === 'n0,n1', fa);
const s1 = attention.signature([{ id: 'x', entry: { waitedMs: 1 } }]);
const s2 = attention.signature([{ id: 'x', entry: { waitedMs: 99999 } }]);
ok('signature ignores the growing waiting time', s1 === s2);

console.log(`${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
