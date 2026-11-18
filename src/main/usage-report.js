'use strict';
// UA2 (docs/usage-analytics.md §3, 依頼-246): the summary of the usage records (src/main/usage.js) for the settings
// section 「使い方」 and the report written to the manager folder (<managerDir>/.bantodesk/usage/report-YYYY-MM-DD.md
// and .json). Everything here comes from daily.json (counts per id) and the events files (one line per event); the
// output holds only ids from src/main/usage-ids.js, the fixed state / result words, days (YYYY-MM-DD) and numbers —
// never a name, a path or typed text (tmp/usage/unit.js walks the JSON to check it).
//
//   summarize(daily, { today, period, events })  -> the summary (see the end of the function)
//   markdown(sum) / json(sum, daily)             -> the report texts (each at most 200 KB)
//   writeReport(dir, sum, daily)                 -> writes the two files, keeps the newest 8 days
//   weeklyDue(lastAuto, today)                   -> true when no automatic report since this week's Monday
// No Electron imports (testable from plain Node).
const fs = require('fs');
const path = require('path');
const ids = require('./usage-ids');
const { daysBetween } = require('./usage');

const PERIODS = Object.freeze([7, 30, 'all']);
const JUDGE_DAYS = 14; // fewer days of records: 使われていない機能 is「まだ判断しない」
const MAX_BYTES = 200 * 1024;
const KEEP = 8;
const REPORT_RE = /^report-(\d{4}-\d{2}-\d{2})\.(md|json)$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// what the user can use (the unused list): not app.start / close (always there), not auto.* (the app's own)
const isFeature = (id) => id !== 'app.start' && id !== 'close' && !id.startsWith('auto.');
const FEATURES = Object.freeze(ids.IDS.filter(isFeature));

// what was done in a session window between open and close (§2.3「開いて何をしたか」)
const ACTION_OF = Object.freeze({
  'session.answer': 'answer',
  'session.band.answer': 'answer',
  'session.band.restart': 'restart',
  'session.band.handoff': 'handoff',
  'topbar.more.terminal': 'terminal',
  'palette.cmd.terminal': 'terminal', // UX16
  'session.send': 'send',
  'session.menu.restart': 'restart',
  'session.panel.restart': 'restart',
  'session.menu.handoff': 'handoff',
  'session.panel.handoff': 'handoff',
  'session.mode.toggle': 'terminal',
  'view.session.terminal': 'terminal',
  'view.session.split': 'terminal',
});
const ACTIONS = Object.freeze(['answer', 'send', 'restart', 'handoff', 'terminal', 'none']);
// what the dashboard's card can do as well (a problem opened only for these: カードで済んだはず)
const CARD_CAN = new Set(['answer', 'restart']);

// what the app / ルーター did instead of the user, next to the same thing done by hand
const AUTO_PAIRS = Object.freeze([
  { kind: 'answer', auto: 'auto.answer', hand: ['dash.turn.answer', 'dash.turn.answer-send', 'dash.card.answer', 'session.answer'] },
  { kind: 'restart', auto: 'auto.restart', hand: ['dash.card.restart', 'session.menu.restart', 'session.panel.restart', 'session.band.restart', 'dash.view.restart'] },
  { kind: 'handoff', auto: 'auto.handoff', hand: ['session.menu.handoff', 'session.panel.handoff', 'session.band.handoff', 'dash.view.handoff'] },
  { kind: 'nudge', auto: 'auto.nudge', hand: [] },
]);

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
const periodOf = (p) => (p === 'all' ? 'all' : Number(p) === 7 ? 7 : 30);
// the days of the period: today and the (period - 1) days before ('all': every day)
const inPeriod = (day, today, period) => DAY_RE.test(day) && day <= today && (period === 'all' || daysBetween(day, today) < period);
const firstDayOfPeriod = (today, period, days) => {
  if (period !== 'all') {
    const [y, m, d] = today.split('-').map(Number);
    const t = new Date(y, m - 1, d - (period - 1), 12);
    const pad = (n) => String(n).padStart(2, '0');
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  }
  return days.length ? days[0] : today;
};

// daily: { days: { 'YYYY-MM-DD': Day } } (usage.js snapshot()); events: the lines of the events files (any order; the
// ones out of the period are skipped). -> the summary (only ids, fixed words, days, numbers)
function summarize(daily, { today, period = 30, events = [] } = {}) {
  period = periodOf(period);
  const all = daily && daily.days && typeof daily.days === 'object' ? daily.days : {};
  const recDays = Object.keys(all).filter((d) => DAY_RE.test(d) && d <= today).sort();
  const days = recDays.filter((d) => inPeriod(d, today, period));
  const c = {};
  const s = {};
  const o = {};
  const last = {};
  const close = { n: 0, sec: 0, resolved: 0, still: 0, none: 0 };
  let over = 0;
  for (const d of days) {
    const r = all[d] || {};
    for (const [id, n] of Object.entries(r.c || {})) {
      if (!ids.isId(id) && id !== 'usage.unknown') continue;
      c[id] = (c[id] || 0) + num(n);
      if (num(n) > 0) last[id] = d; // days are in order: the last one wins
    }
    for (const [id, n] of Object.entries(r.s || {})) if (ids.isId(id)) s[id] = (s[id] || 0) + num(n);
    for (const [k, n] of Object.entries(r.o || {})) o[k] = (o[k] || 0) + num(n);
    for (const k of Object.keys(close)) close[k] += num(r.close && r.close[k]);
    over += num(r.over);
  }

  // 画面の時間の割合
  const viewSec = Object.entries(s).filter(([id, n]) => id.startsWith('view.') && n > 0);
  const totalSec = viewSec.reduce((a, [, n]) => a + n, 0);
  const screens = viewSec.sort((a, b) => b[1] - a[1]).map(([id, sec]) => ({ id, sec, share: pct(sec, totalSec) }));

  // 機能ごとの回数と最後に使った日 / 使われていない機能
  const features = FEATURES.filter((id) => (c[id] || 0) > 0)
    .map((id) => ({ id, n: c[id], last: last[id] }))
    .sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : 1));
  const recordedDays = recDays.length ? daysBetween(recDays[0], today) + 1 : 0;
  const judged = recordedDays >= JUDGE_DAYS;
  const unused = FEATURES.filter((id) => !(c[id] > 0) && !(s[id] > 0)); // a screen shown for a while is used

  // セッションを開いた理由（入口 × 状態）
  const opens = [];
  let openN = 0;
  let problemN = 0;
  for (const from of ids.OPEN_FROM) {
    const row = { from, n: 0, states: {} };
    for (const st of [...ids.STATES, '-']) {
      const n = num(o[`${from}|${st}`]);
      if (!n) continue;
      row.states[st] = n;
      row.n += n;
      if (ids.isProblem(st)) problemN += n;
    }
    if (row.n) opens.push(row);
    openN += row.n;
  }
  opens.sort((a, b) => b.n - a.n);
  const byState = {};
  for (const r of opens) for (const [st, n] of Object.entries(r.states)) byState[st] = (byState[st] || 0) + n;
  const problemTop = ids.PROBLEM_STATES.filter((st) => byState[st] > 0)
    .map((state) => ({ state, n: byState[state] }))
    .sort((a, b) => b.n - a.n);

  // 開いていた時間の中央値と、開いて何をしたか: the events files (kept 30 days)
  const evs = (Array.isArray(events) ? events : [])
    .filter((l) => l && typeof l === 'object' && Number.isFinite(l.t) && ids.isKind(l.k) && inPeriod(dayOfSec(l.t), today, period))
    .sort((a, b) => a.t - b.t);
  const secs = [];
  const did = Object.fromEntries(ACTIONS.map((a) => [a, 0]));
  const cardCould = {};
  let cur = null; // { state, acts: Set }
  let paired = 0;
  for (const l of evs) {
    if (l.k === 'open') {
      cur = { state: typeof l.v === 'string' ? l.v : '-', acts: new Set() };
      continue;
    }
    if (l.k === 'close') {
      if (typeof l.v === 'number') secs.push(l.v);
      if (!cur) continue;
      paired++;
      if (!cur.acts.size) did.none++;
      for (const a of cur.acts) did[a]++;
      if (ids.isProblem(cur.state) && cur.acts.size && [...cur.acts].every((a) => CARD_CAN.has(a))) cardCould[cur.state] = (cardCould[cur.state] || 0) + 1;
      cur = null;
      continue;
    }
    if (cur && l.w === 'session' && ACTION_OF[l.id]) cur.acts.add(ACTION_OF[l.id]);
  }
  const openSec = { median: median(secs), mean: close.n ? Math.round(close.sec / close.n) : null, n: close.n, fromEvents: secs.length };
  const card = Object.entries(cardCould)
    .map(([state, n]) => ({ state, n }))
    .sort((a, b) => b.n - a.n);

  // 代わりにしてくれたこと（auto.* と手の比）
  const auto = AUTO_PAIRS.map((p) => {
    const a = num(c[p.auto]);
    const h = p.hand.reduce((x, id) => x + num(c[id]), 0);
    return { kind: p.kind, auto: a, hand: h, autoShare: pct(a, a + h) };
  });

  return {
    v: 1,
    today,
    period,
    from: firstDayOfPeriod(today, period, days),
    to: today,
    daysWithRecords: days.length,
    recordedDays,
    screens,
    totalSec,
    features,
    unused: { judged, minDays: JUDGE_DAYS, ids: judged ? unused : [], n: unused.length },
    opens: { n: openN, problem: problemN, problemShare: pct(problemN, openN), rows: opens, problemTop, sec: openSec, close, did, paired, cardCould: card },
    auto,
    over,
    unknown: num(c['usage.unknown']),
  };
}
function dayOfSec(t) {
  const d = new Date(t * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---- the report texts ----------------------------------------------------------------------------------------------
const STATE_JA = { permission: '許可', question: '質問', error: 'エラー', stuck: '黙った', failed: '失敗', done: '完了の後', working: '動いている', idle: '何もしていない', '-': '不明' };
const ACTION_JA = { answer: '答えた', send: '送った', restart: '再起動', handoff: '引き継ぎ', terminal: 'ターミナル', none: '何もしない' };
const AUTO_JA = { answer: '答える（後押し）', restart: '再起動', handoff: '引き継ぎ', nudge: '声かけ' };
const periodJa = (p) => (p === 'all' ? '全部' : `${p} 日`);
const fmtSec = (n) => (n === null || n === undefined ? '—' : n >= 3600 ? `${Math.round(n / 360) / 10} 時間` : n >= 60 ? `${Math.round(n / 6) / 10} 分` : `${n} 秒`);

function markdown(sum) {
  const L = [];
  L.push(`# 使い方の集計（${sum.today}）`, '');
  L.push(`期間: ${periodJa(sum.period)}（${sum.from} 〜 ${sum.to}、記録のある日 ${sum.daysWithRecords} 日、記録の始まりから ${sum.recordedDays} 日）。`);
  L.push('この PC の使い方の記録（id と数だけ。文・名前・パスは入っていない）から作った。docs/usage-analytics.md §3。', '');
  L.push('## 画面の時間の割合', '', '| 画面 | 時間 | 割合 |', '|---|---|---|');
  for (const r of sum.screens) L.push(`| ${r.id} | ${fmtSec(r.sec)} | ${r.share}% |`);
  if (!sum.screens.length) L.push('| — | — | — |');
  L.push('', '## 機能ごとの回数と最後に使った日', '', '| 機能 | 回数 | 最後 |', '|---|---|---|');
  for (const r of sum.features) L.push(`| ${r.id} | ${r.n} | ${r.last} |`);
  if (!sum.features.length) L.push('| — | 0 | — |');
  L.push('', `## 使われていない機能（期間で 0 回、${sum.unused.n} 件）`, '');
  if (!sum.unused.judged) L.push(`まだ判断しない（記録が ${sum.unused.minDays} 日に満たない: ${sum.recordedDays} 日）。`);
  else if (!sum.unused.ids.length) L.push('なし。');
  else for (const id of sum.unused.ids) L.push(`- ${id}`);
  const op = sum.opens;
  L.push('', '## セッションを開いた理由', '');
  L.push(`開いた回数 ${op.n}、問題で開いた割合 ${op.problemShare}%（${op.problem} 回）、開いていた時間の中央値 ${fmtSec(op.sec.median)}（平均 ${fmtSec(op.sec.mean)}、閉じた ${op.sec.n} 回）。`);
  L.push(`閉じたとき: 直った ${op.close.resolved}、まだ ${op.close.still}、問題なし ${op.close.none}。`, '');
  const cols = [...ids.STATES, '-'].filter((st) => op.rows.some((r) => r.states[st]));
  if (op.rows.length) {
    L.push(`| 入口 | 計 | ${cols.map((st) => STATE_JA[st]).join(' | ')} |`, `|---|---|${cols.map(() => '---').join('|')}|`);
    for (const r of op.rows) L.push(`| open.from.${r.from} | ${r.n} | ${cols.map((st) => r.states[st] || 0).join(' | ')} |`);
  } else L.push('（開いた記録なし）');
  L.push('', '問題で開いた理由の上位: ' + (op.problemTop.length ? op.problemTop.map((r) => `${r.state} ${r.n}`).join('、') : 'なし'));
  L.push('', `開いて何をしたか（開いて閉じた ${op.paired} 回）: ` + ACTIONS.map((a) => `${ACTION_JA[a]} ${op.did[a]}`).join('、'));
  L.push('カードで済んだはずの操作（問題で開き、答える・再起動だけをした）: ' + (op.cardCould.length ? op.cardCould.map((r) => `${r.state} ${r.n}`).join('、') : 'なし'));
  L.push('', '## 代わりにしてくれたこと', '', '| 操作 | アプリ・ルーター | 手 | アプリの割合 |', '|---|---|---|---|');
  for (const r of sum.auto) L.push(`| ${AUTO_JA[r.kind]} | ${r.auto} | ${r.hand} | ${r.autoShare}% |`);
  L.push('', `上限を超えて数だけにした行 ${sum.over}、一覧の外の id ${sum.unknown}。`, '');
  return cap(L.join('\n'));
}
function cap(text) {
  if (Buffer.byteLength(text) <= MAX_BYTES) return text;
  let t = text;
  while (Buffer.byteLength(t) > MAX_BYTES - 64) t = t.slice(0, Math.floor(t.length * 0.9));
  return t + '\n\n（200KB で切った）\n';
}

// the JSON: the summary and the daily records of the period (ids and numbers only), at most 200 KB (older days dropped)
function json(sum, daily) {
  const all = (daily && daily.days) || {};
  const days = {};
  for (const d of Object.keys(all).sort()) {
    if (!inPeriod(d, sum.today, sum.period)) continue;
    const r = all[d] || {};
    const keepIds = (m) => Object.fromEntries(Object.entries(m || {}).filter(([k]) => ids.isId(k) || k === 'usage.unknown').map(([k, v]) => [k, num(v)]));
    const keepOpen = (m) =>
      Object.fromEntries(
        Object.entries(m || {})
          .filter(([k]) => {
            const [f, st] = k.split('|');
            return ids.OPEN_FROM.includes(f) && (ids.isState(st) || st === '-');
          })
          .map(([k, v]) => [k, num(v)]),
      );
    const cl = r.close || {};
    days[d] = { c: keepIds(r.c), s: keepIds(r.s), o: keepOpen(r.o), close: { n: num(cl.n), sec: num(cl.sec), resolved: num(cl.resolved), still: num(cl.still), none: num(cl.none) }, over: num(r.over) };
  }
  const out = { v: 1, kind: 'usage-report', summary: sum, days, truncated: 0 };
  let text = JSON.stringify(out, null, 1);
  const keys = Object.keys(days);
  while (Buffer.byteLength(text) > MAX_BYTES && keys.length) {
    delete days[keys.shift()];
    out.truncated++;
    text = JSON.stringify(out, null, 1);
  }
  if (Buffer.byteLength(text) > MAX_BYTES) {
    out.summary = { ...sum, features: sum.features.slice(0, 50), unused: { ...sum.unused, ids: sum.unused.ids.slice(0, 50) } };
    text = JSON.stringify(out);
  }
  return text;
}

// writes report-<today>.md / .json into dir (made when missing), removes the older days beyond the newest KEEP
// -> { day, files: [names], removed: [names] }
function writeReport(dir, sum, daily, { keep = KEEP } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const day = sum.today;
  const files = [`report-${day}.md`, `report-${day}.json`];
  const write = (name, text) => {
    const file = path.join(dir, name);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  };
  write(files[0], markdown(sum));
  write(files[1], json(sum, daily));
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {}
  const daysThere = [...new Set(names.map((n) => REPORT_RE.exec(n)).filter(Boolean).map((m) => m[1]))].sort().reverse();
  const drop = new Set(daysThere.slice(keep));
  const removed = [];
  for (const n of names) {
    const m = REPORT_RE.exec(n);
    if (!m || !drop.has(m[1])) continue;
    try {
      fs.unlinkSync(path.join(dir, n));
      removed.push(n);
    } catch {}
  }
  return { day, files, removed };
}

// the Monday (YYYY-MM-DD) of the week of today (local days)
function mondayOf(today) {
  const [y, m, d] = today.split('-').map(Number);
  const t = new Date(y, m - 1, d, 12);
  t.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}
// once a week: the first start on or after this week's Monday that has not written one yet (a Monday without a start
// is caught up on the next start of the week)
const weeklyDue = (lastAuto, today) => !(typeof lastAuto === 'string' && DAY_RE.test(lastAuto) && lastAuto >= mondayOf(today));

module.exports = { summarize, markdown, json, writeReport, weeklyDue, mondayOf, PERIODS, FEATURES, ACTIONS, JUDGE_DAYS, MAX_BYTES, KEEP, REPORT_RE };
