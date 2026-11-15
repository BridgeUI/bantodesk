// Unit (plain Node): UIUX U4 「PMO の記録」 — src/main/notices.js forLog / parseActions and the info expiry without a
// read operation. AT_APP_ROOT = the app to test (stable check), else this repo.
'use strict';
const path = require('path');
const root = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.resolve(__dirname, '..', '..');
const N = require(path.join(root, 'src', 'main', 'notices.js'));
const Labels = require(path.join(root, 'src', 'renderer', 'labels.js'));

const results = [];
const ok = (name, cond, ev = '') => {
  results.push(!!cond);
  console.log(cond ? 'PASS' : 'FAIL', name, ev !== '' ? '| ' + (typeof ev === 'string' ? ev : JSON.stringify(ev)).slice(0, 500) : '');
};

const F = '/w/agent_terminal';
const iso = (ms) => new Date(ms).toISOString();
const t0 = Date.parse('2026-11-13T09:00:00Z');
const actions = [
  { at: iso(t0 + 1000), type: 'answer', folder: F, tabKey: 'k1', label: 'AT-53 記録', promptKey: 'p1', question: 'Read file?', context: ['cat x'], choice: 1, option: 'Yes', reason: '読み取りだけ' },
  { at: iso(t0 + 2000), type: 'reorder', folder: F, order: ['a', 'b'], reason: 'AT-52 は QA 待ち' },
  { at: iso(t0 + 3000), type: 'route', folder: F, backlogId: 'r-x-1', no: 'AT-54', title: '設定の画面', text: '本文' },
  { at: iso(t0 + 4000), type: 'release', ok: true, commit: '7714494abc', text: 'ok' },
  { at: iso(t0 + 5000), type: 'answer-refused', tabKey: 'k2', error: 'stale', reason: 'x' },
  { at: iso(t0 + 6000), type: 'done', folder: F, backlogId: 'r-x-1', no: 'AT-54', title: '設定の画面' },
  { at: iso(t0 + 7000), type: 'failed', folder: F, backlogId: 'r-x-2', no: 'AT-55', title: '別' },
  { at: iso(t0 + 8000), type: 'backlog-update', folder: F, backlogId: 'r-x-3', from: 'pending', status: 'dropped', note: '重複' },
  { at: iso(t0 + 9000), type: 'nudge', folder: F, tabKey: 'k3', label: 'AT-56', text: '続けてください', wait: 'silent' },
  { at: iso(t0 + 9500), type: 'attention-dismiss', tabKey: 'k3' },
  { at: 'not a date', type: 'answer' },
  { type: 'reorder' },
];
const notices = [
  { id: 'n1', kind: 'info', title: 'お知らせ 1', text: 'a', createdAt: t0 + 10000, updatedAt: t0 + 10000, readAt: null },
  { id: 'n2', kind: 'warn', title: '放置 2 件', key: 'app:patrol', createdAt: t0 + 11000, updatedAt: t0 + 11000, resolvedAt: t0 + 12000 },
  { id: 'n3', kind: 'warn', title: '止まっています', key: 'app:stuck', createdAt: t0 + 13000, updatedAt: t0 + 13000 },
  { id: 'n4', kind: 'info', title: 'answer の要約', key: 'app:answer:abc', createdAt: t0 + 14000, updatedAt: t0 + 14000 },
  { id: 'n5', kind: 'proposal', title: '未回答の提案', createdAt: t0 + 15000, updatedAt: t0 + 15000, answer: null },
  { id: 'n6', kind: 'proposal', title: '答えた提案', createdAt: t0 + 16000, updatedAt: t0 + 16000, answer: { choice: 'go', comment: '', at: t0 + 17000 } },
  { id: 'n7', kind: 'info', title: 'PMO を引き継ぎました', key: 'app:pmo-handoff:t1', createdAt: t0 + 18000, updatedAt: t0 + 18000 },
  { id: 'n8', kind: 'info', title: '片付けました', key: 'app:autodrop:x', createdAt: t0 + 19000, updatedAt: t0 + 19000 },
];
const log = N.forLog(notices, actions);
const by = (pred) => log.filter(pred);
ok('1 newest first', log.every((e, i) => i === 0 || log[i - 1].at >= e.at), log.map((e) => e.at));
ok('2 every kind is a LOG_KIND key', log.every((e) => Labels.LOG_KIND[e.kind]), [...new Set(log.map((e) => e.kind))]);
ok('3 answer -> push, with question and option', by((e) => e.type === 'answer').length === 1 && by((e) => e.type === 'answer')[0].kind === 'push' && /Read file\?/.test(by((e) => e.type === 'answer')[0].title) && /Yes/.test(by((e) => e.type === 'answer')[0].title));
ok('4 reorder -> order', by((e) => e.type === 'reorder')[0]?.kind === 'order' && /AT-52 は QA 待ち/.test(by((e) => e.type === 'reorder')[0].title));
ok('5 route -> route with AT-54 and the title', by((e) => e.type === 'route')[0]?.kind === 'route' && /AT-54 設定の画面/.test(by((e) => e.type === 'route')[0].title) && by((e) => e.type === 'route')[0].folder === F);
ok('6 release -> release with the short commit', by((e) => e.type === 'release')[0]?.kind === 'release' && /7714494\b/.test(by((e) => e.type === 'release')[0].title));
ok('7 refused answer is bad', by((e) => e.type === 'answer-refused')[0]?.bad === true && by((e) => e.type === 'answer')[0].bad === false);
ok('8 done / failed -> done, failed bad', by((e) => e.type === 'done')[0]?.kind === 'done' && by((e) => e.type === 'failed')[0]?.kind === 'done' && by((e) => e.type === 'failed')[0].bad === true);
ok('9 backlog-update to dropped -> clean', by((e) => e.type === 'backlog-update')[0]?.kind === 'clean');
ok('10 nudge -> push', by((e) => e.type === 'nudge')[0]?.kind === 'push');
ok('11 attention-dismiss and bad lines left out', !by((e) => e.type === 'attention-dismiss').length && by((e) => e.type === 'answer').length === 1 && by((e) => e.type === 'reorder').length === 1);
ok('12 info notice -> info', by((e) => e.id === 'n1')[0]?.kind === 'info');
ok('13 resolved warn -> warn at createdAt + fix at resolvedAt', by((e) => e.id === 'n2')[0]?.kind === 'warn' && by((e) => e.id === 'n2-r')[0]?.kind === 'fix' && by((e) => e.id === 'n2-r')[0].at === t0 + 12000);
ok('14 live warn -> warn only', by((e) => e.id === 'n3').length === 1 && !by((e) => e.id === 'n3-r').length);
ok('15 notice the action log already has (app:answer:) left out', !by((e) => e.id === 'n4').length);
ok('16 unanswered proposal left out (あなたの番), answered one in at the answer', !by((e) => e.id === 'n5').length && by((e) => e.id === 'n6')[0]?.at === t0 + 17000 && /進める/.test(by((e) => e.id === 'n6')[0].title));
ok('17 handoff / autodrop notices -> handoff / clean', by((e) => e.id === 'n7')[0]?.kind === 'handoff' && by((e) => e.id === 'n8')[0]?.kind === 'clean');
ok('18 ids unique and stable', new Set(log.map((e) => e.id)).size === log.length && JSON.stringify(N.forLog(notices, actions).map((e) => e.id)) === JSON.stringify(log.map((e) => e.id)));
ok('19 limit', N.forLog(notices, actions, { limit: 3 }).length === 3);
ok('20 parseActions skips cut / bad lines', N.parseActions('{"at":"x"\n{"at":"2026-11-13T00:00:00Z","type":"route"}\n\nnope\n').length === 1);
ok('21 old notices.json (readAt set, no key) still read', N.sanitizeNotices({ notices: [{ id: 'old1', kind: 'info', title: 't', createdAt: 1, readAt: 2 }] }, 3).notices.length === 1);
// info expiry without a read operation: 7 days after its last update
const now = t0 + N.KEEP_MS + 20000;
const kept = N.sanitizeNotices({ notices: [
  { id: 'i1', kind: 'info', title: 'old unread', createdAt: t0, updatedAt: t0 },
  { id: 'i2', kind: 'info', title: 'new unread', createdAt: now - 1000, updatedAt: now - 1000 },
  { id: 'w1', kind: 'warn', title: 'old live warn', createdAt: t0, updatedAt: t0 },
] }, now).notices.map((n) => n.id);
ok('22 unread info older than 7 days goes, newer stays, live warn stays', JSON.stringify(kept) === JSON.stringify(['i2', 'w1']), kept);
ok('23 labels: LOG_KIND short words', Labels.status('log', 'push').short === '後押し' && Labels.status('log', 'route').short === '振り分け' && Labels.status('log', 'release').short === '更新');

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
