// node tmp/pmo/test.js — findStale / patrolDecision / formatPatrol + notifyManager patrol coalescing.
const path = require('path');
const fs = require('fs');
const os = require('os');
// AT_APP_ROOT (e.g. ..\agent_terminal_stable, set by run.mjs --all-stable) tests that app's src; default is this repo.
const SRC = path.join(process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.join(__dirname, '..', '..'), 'src', 'main');
console.log('src:', SRC);
const pmo = require(path.join(SRC, 'pmo'));
const manager = require(path.join(SRC, 'manager'));
const backlog = require(path.join(SRC, 'backlog'));

let fail = 0;
let pass = 0;
const ok = (c, msg) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL', msg);
  }
};

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.UTC(2026, 10, 3, 12, 0, 0);
// folders in the platform's own form: path.basename / path.resolve on macOS do not split a C:\ path
const W = (name) => (process.platform === 'win32' ? `C:\\work\\${name}` : `/work/${name}`);
const A = W('alpha');
const B = W('beta');

const inboxItems = [
  { id: 'iNew1', text: '新しい依頼 1', status: 'new', createdAt: now - 31 * MIN, updatedAt: now - 31 * MIN },
  { id: 'iNew2', text: 'まだ新しい', status: 'new', createdAt: now - 10 * MIN, updatedAt: now - 10 * MIN },
  { id: 'iAsk1', text: '質問中', status: 'asking', note: 'どのフォルダ？', createdAt: now - 3 * DAY, updatedAt: now - 2 * DAY },
  { id: 'iAsk2', text: '質問したばかり', status: 'asking', createdAt: now - 3 * DAY, updatedAt: now - 2 * HOUR },
  { id: 'iRt1', text: 'routed, backlog pending stale', status: 'routed', folder: A, createdAt: now - 3 * DAY, updatedAt: now - 3 * DAY },
  { id: 'iRt2', text: 'routed, backlog lost', status: 'routed', folder: A, createdAt: now - 3 * DAY, updatedAt: now - 2 * DAY },
  { id: 'iRt3', text: 'routed, backlog done', status: 'routed', folder: B, createdAt: now - 3 * DAY, updatedAt: now - 2 * DAY },
  { id: 'iRt4', text: 'routed, backlog active fine', status: 'routed', folder: B, createdAt: now - 3 * DAY, updatedAt: now - 2 * DAY },
  { id: 'iDone', text: 'done long ago', status: 'done', createdAt: now - 9 * DAY, updatedAt: now - 9 * DAY },
];
const backlogs = [
  {
    folder: A,
    items: [
      { id: 'r-iRt1-0a0b0c0d', text: 'routed work', status: 'pending', createdAt: now - 3 * DAY },
      { id: 'p1', text: '古い pending', status: 'pending', createdAt: now - 25 * HOUR },
      { id: 'p2', text: '新しい pending', status: 'pending', createdAt: now - 2 * HOUR },
      { id: 'a1', text: '長い active', status: 'active', createdAt: now - DAY, startedAt: now - 3 * HOUR },
      { id: 'a2', text: '短い active', status: 'active', createdAt: now - DAY, startedAt: now - 30 * MIN },
    ],
  },
  {
    folder: B,
    items: [
      { id: 'r-iRt3-11111111', text: 'done routed', status: 'done', createdAt: now - 3 * DAY, doneAt: now - DAY },
      { id: 'r-iRt4-22222222', text: 'active routed', status: 'active', createdAt: now - 3 * DAY, startedAt: now - 1 * HOUR },
      { id: 'f1', text: '失敗したまま', status: 'failed', note: 'exit 1', createdAt: now - 3 * DAY, startedAt: now - 3 * DAY, doneAt: now - 2 * DAY },
      { id: 'f2', text: '最近失敗', status: 'failed', createdAt: now - 3 * DAY, doneAt: now - 3 * HOUR },
      { id: 'd1', text: 'done', status: 'done', createdAt: now - 9 * DAY, doneAt: now - 9 * DAY },
    ],
  },
];

// --- findStale
const f = pmo.findStale({ inboxItems, backlogs, now });
const ids = f.map((x) => x.id).sort();
console.log('findings:', f.map((x) => `${x.kind}:${x.id}:${x.status}`).join(' '));
ok(JSON.stringify(ids) === JSON.stringify(['a1', 'f1', 'iAsk1', 'iNew1', 'iRt2', 'iRt3', 'p1', 'r-iRt1-0a0b0c0d'].sort()), 'stale ids ' + ids.join(','));
ok(!ids.includes('iRt1'), 'routed inbox item skipped when its backlog item is reported');
ok(!ids.includes('iRt4'), 'routed inbox item skipped while its backlog item is active');
ok(f.find((x) => x.id === 'iRt3').detail.includes('バックログは done'), 'routed but backlog done -> reported with detail');
ok(f.find((x) => x.id === 'iRt2').detail.includes('見つかりません'), 'lost routed item explained');
ok(f.find((x) => x.id === 'r-iRt1-0a0b0c0d').inboxId === 'iRt1', 'backlog finding knows its inbox id');
ok(f.every((x, i) => i === 0 || f[i - 1].since <= x.since), 'oldest first');
ok(pmo.findStale({ inboxItems: [], backlogs: [], now }).length === 0, 'empty -> none');
// thresholds are boundaries: exactly at the limit counts
ok(pmo.findStale({ inboxItems: [{ id: 'x', text: 't', status: 'new', createdAt: now - 30 * MIN, updatedAt: now - 30 * MIN }], now }).length === 1, '30 min boundary');
ok(pmo.findStale({ inboxItems: [{ id: 'x', text: 't', status: 'new', createdAt: 0, updatedAt: 0 }], now }).length === 0, 'no timestamp -> skipped');

// --- no-nag
const d1 = pmo.patrolDecision(f, []);
ok(d1.report && d1.fresh.size === f.length, 'first patrol reports all');
const d2 = pmo.patrolDecision(f, d1.keys);
ok(!d2.report, 'same findings -> no report');
const fewer = f.filter((x) => x.id !== 'p1');
const d3 = pmo.patrolDecision(fewer, d1.keys);
ok(!d3.report && d3.keys.length === f.length - 1, 'one resolved -> no report, key forgotten');
const d4 = pmo.patrolDecision(f, d3.keys);
ok(d4.report && d4.fresh.size === 1 && [...d4.fresh][0].includes(':p1:'), 'comes back -> reported again (only it fresh)');
// status change = new key (pending -> failed)
const changed = pmo.findStale({
  backlogs: [{ folder: A, items: [{ id: 'p1', text: 'x', status: 'failed', createdAt: now - 3 * DAY, doneAt: now - 2 * DAY }] }],
  now,
});
ok(pmo.patrolDecision(changed, d1.keys).report, 'status change -> reported');

// --- daily stocktake (棚卸し)
// never done -> this patrol is a stocktake
const s0 = pmo.patrolDecision(f, d1.keys, { lastStocktake: 0, now });
ok(s0.stocktake && s0.report && s0.fresh.size === 0, 'never stocktaken -> stocktake reports all, even with nothing new');
// < 24 h since the last one -> normal no-nag
const s1 = pmo.patrolDecision(f, d1.keys, { lastStocktake: now - 23 * HOUR, now });
ok(!s1.stocktake && !s1.report, '23 h after the stocktake, same findings -> nothing');
const s1b = pmo.patrolDecision(f, d3.keys, { lastStocktake: now - 23 * HOUR, now });
ok(!s1b.stocktake && s1b.report && s1b.fresh.size === 1, 'between stocktakes only something new triggers a report');
// ≥ 24 h -> stocktake again, all items re-reported
const s2 = pmo.patrolDecision(f, d1.keys, { lastStocktake: now - DAY, now });
ok(s2.stocktake && s2.report && s2.keys.length === f.length, '24 h boundary -> stocktake re-reports everything');
// nothing stale -> stocktake counts as done but no report
const s3 = pmo.patrolDecision([], [], { lastStocktake: now - 2 * DAY, now });
ok(s3.stocktake && !s3.report, 'stocktake with nothing stale -> no report');
ok(pmo.STOCKTAKE_EVERY_MS === DAY, 'stocktake every day');
const ts = pmo.formatPatrol(f, d4.fresh, { stocktake: true });
console.log('---\n' + ts + '\n---');
ok(ts.startsWith(`棚卸し: 放置されている項目（${f.length} 件）`), 'stocktake head');
ok(ts.split('\n').length === f.length + 1 && (ts.match(/\[新\]/g) || []).length === 1, 'stocktake lists every item, [新] kept for the new one');
ok(!ts.includes('見回り:'), 'stocktake head replaces 見回り');

// --- formatPatrol
const t = pmo.formatPatrol(f, d4.fresh);
console.log('---\n' + t + '\n---');
ok(t.startsWith('見回り: 放置されている項目があります（8 件）'), 'head');
ok(t.split('\n').length === 9, 'one line per finding');
ok((t.match(/\[新\]/g) || []).length === 1, 'only fresh marked [新]');
ok(/\[alpha pending 1日\] p1/.test(t), 'folder name, status, age');
ok(/依頼 iRt1/.test(t), 'backlog line links its inbox item');
const many = Array.from({ length: 40 }, (_, i) => ({ ...f[0], key: 'k' + i, id: 'id' + i }));
const tm = pmo.formatPatrol(many);
ok(tm.split('\n').length === 17 && tm.includes('ほか 25 件') && tm.length <= 2000, 'long list capped');
ok(pmo.ageText(90 * MIN) === '1時間' && pmo.ageText(5 * MIN) === '5分' && pmo.ageText(50 * HOUR) === '2日', 'ageText');

// --- roadmap 48: 立て直し, PROGRESS.md 確認待ち, old asking / hold, why a pending item waits
const notices = require(path.join(SRC, 'notices'));
const ymd = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const today = ymd(now);
const twoAgo = ymd(now - 2 * DAY);
ok(t.includes('立て直し') && t.includes('outbox に書いて') && t.includes('指摘だけで終えない') && !t.includes('update の note で指摘'), 'head asks for recovery actions, not just pointing out');
ok(ts.includes('立て直し') && ts.includes('指摘だけで終えない'), 'stocktake head asks for recovery too');
const C = W('gamma');
const wrow = (n, updated) => ({ n, item: `項目${n}`, next: '確かめる', updated });
const prog = (waiting, count) => ({ done: 1, total: 9, inProgress: [], updated: today, waiting, waitingCount: count || waiting.length, held: [wrow('17', twoAgo)], heldCount: 1 });
const pf = (progress) => pmo.findStale({ backlogs: [{ folder: C, items: [], progress }], now }).filter((x) => x.kind === 'progress');
ok(pf(prog([wrow('9', today), wrow('13', today)])).length === 0, '2 fresh 確認待ち -> nothing');
ok(pf(null).length === 0 && pf(prog([])).length === 0, 'no progress / no 確認待ち -> nothing');
const p3 = pf(prog([wrow('9', today), wrow('13', today), wrow('20', today)]));
ok(p3.length === 1 && p3[0].count === 3 && p3[0].days === 0 && p3[0].text === '9、13、20', '3 確認待ち -> one finding per folder', JSON.stringify(p3));
const p1 = pf(prog([wrow('5b', twoAgo)]));
ok(p1.length === 1 && p1[0].days === 2 && p1[0].detail.includes('5b'), 'one 確認待ち 2 days old -> finding with the oldest', JSON.stringify(p1));
ok(pf(prog([wrow('5b', ymd(now - DAY))])).length === 1, '1 calendar day boundary');
ok(pf(prog([wrow('x', '')])).length === 0, 'undated single 確認待ち -> nothing');
const p14 = pf(prog([wrow('5b', twoAgo), ...Array.from({ length: 9 }, (_, i) => wrow(String(i + 1), today))], 14));
ok(p14.length === 1 && p14[0].count === 14 && p14[0].text.endsWith('、…'), 'count from waitingCount, list capped with …');
ok(p14[0].key === p3[0].key && p14[0].key === `p:${C.toLowerCase()}:確認待ち`, 'stable key per folder (more rows do not nag)');
ok(!pmo.patrolDecision(p14, p3.map((x) => x.key)).report, 'no-nag: the folder stays reported while its rows change');
ok(pmo.patrolDecision(p14, []).report && pmo.patrolDecision([], p3.map((x) => x.key)).keys.length === 0, 'resolved -> forgotten; back -> reported');
const pl = pmo.formatPatrol(p14, new Set(p14.map((x) => x.key)));
ok(/\[新\] \[gamma 確認待ち 14 件・最古 2日\] 5b、1、2、/.test(pl), 'patrol line for 確認待ち', pl);
const pn = notices.patrolNotice(p14, pmo.ageText);
ok(pn && /- \[gamma 確認待ち 14 件・最古 2日\] 5b、1/.test(pn.text) && pn.folder === C && pn.refs[0] === p14[0].key && pn.text.includes('立て直'), 'app:patrol warn line + folder', pn && pn.text);
// inbox asking / hold
const ih = pmo.findStale({
  inboxItems: [
    { id: 'iHoldOld', text: '保留 4 日', status: 'hold', note: '41 の後に再開', createdAt: now - 9 * DAY, updatedAt: now - 4 * DAY },
    { id: 'iHold3', text: '保留ちょうど 3 日', status: 'hold', createdAt: now - 9 * DAY, updatedAt: now - 3 * DAY },
    { id: 'iHoldNew', text: '保留 2 日', status: 'hold', note: 'x', createdAt: now - 9 * DAY, updatedAt: now - 2 * DAY },
    { id: 'iAskOld', text: '質問中', status: 'asking', note: 'どちらの案？', createdAt: now - 3 * DAY, updatedAt: now - DAY },
    { id: 'iNewQa', text: 'QA が未回答', status: 'new', createdAt: now - HOUR, updatedAt: now - HOUR },
  ],
  now,
  qaStatus: (folder, id) => (folder === null && id === 'iNewQa' ? 'open' : 'none'),
});
const byId = Object.fromEntries(ih.map((x) => [x.id, x]));
ok(byId.iHoldOld && byId.iHoldOld.detail === '保留: 41 の後に再開', 'hold 4 days -> finding with the reason', JSON.stringify(byId.iHoldOld));
ok(byId.iHold3 && byId.iHold3.detail.includes('再開の条件なし') && !byId.iHoldNew, 'hold 3 days boundary; 2 days -> not yet');
ok(byId.iAskOld && byId.iAskOld.detail === '質問の回答待ち: どちらの案？', 'asking 1 day -> finding with the question');
ok(byId.iNewQa && byId.iNewQa.detail === 'QA 未回答', 'new inbox item with an open QA says so');
const heldAll = [{ id: 'iHoldOld', text: '保留 4 日', status: 'hold' }, { id: 'iHoldNew', text: '保留 2 日', status: 'hold', note: 'x' }];
const hs = pmo.formatPatrol(ih, new Set(), { stocktake: true, held: heldAll });
ok(hs.includes('保留 1 件（再開の条件を確かめ') && (hs.match(/iHoldOld/g) || []).length === 1 && hs.includes('[依頼 保留] iHoldNew'), 'a hold that is a finding is not listed twice', hs);
// why a pending item waits
const wf = pmo.findStale({
  backlogs: [
    {
      folder: A,
      items: [
        { id: 'w1', text: '先頭', status: 'pending', createdAt: now - 2 * DAY },
        { id: 'w2', text: '前提待ち', status: 'pending', createdAt: now - 2 * DAY, after: ['act1'] },
        { id: 'w3', text: '前提 failed', status: 'pending', createdAt: now - 2 * DAY, after: ['bf1'] },
        { id: 'w4', text: '上限', status: 'pending', createdAt: now - 2 * DAY },
        { id: 'w5', text: '後ろ', status: 'pending', createdAt: now - 2 * DAY },
        { id: 'act1', text: '動作中', status: 'active', createdAt: now - DAY, startedAt: now - 10 * MIN },
      ],
      reasons: { w4: { code: 'limit', text: '同時に動かす上限（3 件）に達しています' }, w2: { code: 'after', text: '前提の act1 が済んでいません' } },
    },
    { folder: B, items: [{ id: 'bf1', text: '失敗', status: 'failed', createdAt: now - 3 * HOUR, doneAt: now - 3 * HOUR }] },
  ],
  now,
  qaStatus: (folder, id) => (folder === A && id === 'w5' ? 'open' : 'none'),
});
const w = Object.fromEntries(wf.map((x) => [x.id, x.detail]));
ok(w.w1 === '', 'head of the queue: no reason known', JSON.stringify(w));
ok(w.w2 === '前提待ち（act1 が active）', 'after pending/active -> 前提待ち', w.w2);
ok(w.w3 === '前提が failed（bf1）', 'after failed (other folder) -> 前提が failed', w.w3);
ok(w.w4 === '順番待ち（4 番目、同時に動かす上限（3 件）に達しています）', 'scheduler reason -> 順番待ち with position', w.w4);
ok(w.w5 === '順番待ち（5 番目）、QA 未回答', 'position + open QA', w.w5);
ok(pmo.formatPatrol(wf).includes('（前提が failed（bf1））'), 'reason shown on the patrol line');
// the manager template (roadmap 48)
{
  const md = manager.claudeMd ? manager.claudeMd('C:\\m') : null;
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-md-'));
  manager.ensureManagerDir(tdir);
  const text = md || fs.readFileSync(path.join(tdir, 'CLAUDE.md'), 'utf8');
  ok(manager.CLAUDE_MD_VERSION >= 14 && text.includes('放置の立て直し') && text.includes('指摘だけで終わらせず ルーターが立て直す') && !text.includes('update の note で指摘する'), 'template: recovery rule replaces "update の note で指摘する"');
  ok(['reorder で前に出す', 'kind research と touches', 'backlog-update で dropped / done', 'トランスクリプトと git status', '前提を先に進めるか', '再開の条件を確かめ', '仮説付きの事前 QA'].every((s) => text.includes(s)), 'template: every recovery case');
  ok(text.includes('waiting / waitingCount / held / heldCount') && text.includes('確認待ち N 件・最古 D日') && text.includes('hold 3 日'), 'template: progress waiting / held and the new patrol lines');
  // 依頼-265: the screen word 要対応 (UXW); あなたの番 only as the older version's word
  const oldTurn = 'あなたの' + '番';
  ok(manager.CLAUDE_MD_VERSION >= 32 && text.includes('要対応 = asking') && text.includes('ダッシュボードの「要対応」に集めて出す') && text.split(oldTurn).length === 2 && text.includes(`前の版の「${oldTurn}」は今の「要対応」と同じもの`), 'template v32: 要対応 = asking, あなたの番 only as the older word');
  fs.rmSync(tdir, { recursive: true, force: true });
}

// --- notifyManager coalescing with patrol (real backlog files in a temp dir)
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-'));
  const bdir = path.join(root, 'backlog');
  const mdir = path.join(root, 'manager');
  fs.mkdirSync(mdir);
  const items = async () => (await backlog.getBacklog(bdir, mdir)).items;

  ok((await manager.notifyManager(bdir, mdir, { newItems: [], patrol: t })) === 'added', 'patrol-only prompt added');
  let it = await items();
  ok(it.length === 1 && it[0].text.startsWith(manager.INBOX_PROMPT_HEAD) && it[0].text.includes('\n見回り:'), 'one prompt with head + patrol');
  // an inbox notification while pending keeps the patrol part
  ok((await manager.notifyManager(bdir, mdir, { newItems: [{ id: 'iZ', text: 'zzz' }] })) === 'updated', 'inbox change updates');
  it = await items();
  ok(it.length === 1 && it[0].text.includes('新規: iZ') && it[0].text.includes('見回り:'), 'patrol kept while pending');
  // the manager picks it up -> a later inbox prompt has no old patrol part
  await backlog.saveBacklog(bdir, mdir, { items: it.map((x) => ({ ...x, status: 'done' })), auto: {} });
  ok((await manager.notifyManager(bdir, mdir, { newItems: [{ id: 'iY', text: 'yyy' }] })) === 'added', 'new prompt after pickup');
  it = (await items()).filter((x) => x.status === 'pending');
  ok(it.length === 1 && !it[0].text.includes('見回り'), 'patrol not repeated after pickup');
  // a huge inbox part does not cut the patrol away
  const big = Array.from({ length: 20 }, (_, i) => ({ id: 'iBig' + i, text: 'あ'.repeat(300) }));
  await manager.notifyManager(bdir, mdir, { newItems: big, finished: 'x'.repeat(200), patrol: t });
  it = (await items()).filter((x) => x.status === 'pending');
  ok(it.length === 1 && it[0].text.length <= 4000 && it[0].text.endsWith(t), 'patrol survives the 4000-char cap');
  fs.rmSync(root, { recursive: true, force: true });

  // one PASS line per passed check, so run.mjs (counts lines starting with PASS / FAIL) shows the real count
  for (let i = 0; i < pass; i++) console.log(`PASS check ${i + 1}`);
  console.log(`total: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
