// PMO patrol (roadmap 20 stage 2, docs/plan-dashboard.md answer 6): finds neglected inbox / backlog items so
// the manager agent can act on them. main runs a patrol on a timer and, when there is something not reported
// before, adds a "見回り" line to the manager's prompt (manager.notifyManager); once a day the patrol is a
// "棚卸し" (stocktake) that lists everything still stale. The dashboard marks the same findings (dashboard:stale).
// No Electron imports.
const path = require('path');
const Labels = require('../renderer/labels'); // screen words (docs/ui-copy.md): 依頼, the inbox status words

// How an inbox item is named in the patrol lines (AT 呼び名 RN, 依頼-59): 「依頼 保留」 = WORDS.inbox + the status word of
// the screens (Labels.status('inbox', code).short). The data (inbox.json, status codes) keeps its names.
const INBOX_WORD = Labels.WORDS.inbox;
const inboxWhere = (status) => `${INBOX_WORD} ${Labels.status('inbox', status).short}`;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// How long an item may sit in a status before the patrol reports it.
const STALE = {
  inbox: { new: 30 * MIN, asking: DAY, routed: DAY, hold: 3 * DAY },
  backlog: { pending: DAY, active: 2 * HOUR, failed: DAY },
  // a folder's PROGRESS.md 確認待ち rows (roadmap 48): reported when there are ≥ count of them, or one is ≥ days old (更新日)
  progress: { count: 3, days: 1 },
};
const PATROL_FIRST_MS = 2 * MIN; // first patrol after start
const PATROL_EVERY_MS = 30 * MIN;
const STOCKTAKE_EVERY_MS = DAY; // daily stocktake: re-report everything still stale
const LIST_MAX = 15; // lines in the prompt
const PATROL_TEXT_MAX = 2000;

const norm = (p) => path.resolve(p).toLowerCase();
const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Since when the item is in its current status (best available timestamp).
function backlogSince(it) {
  if (it.status === 'active') return it.startedAt || it.createdAt || 0;
  if (it.status === 'failed') return it.doneAt || it.startedAt || it.createdAt || 0;
  return it.createdAt || 0;
}

// inboxId of a route-made backlog item (r-<inboxId|x>-<hex>), else null.
function routedInboxId(id) {
  const m = /^r-(.+)-[0-9a-f]{1,8}$/.exec(String(id || ''));
  return m && m[1] !== 'x' ? m[1] : null;
}

// Local midnight of a YYYY-MM-DD date (PROGRESS.md 更新日), or 0.
function dayStart(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : 0;
}
// Whole calendar days from a YYYY-MM-DD date to now (local), or null.
function daysSince(ymd, now) {
  const t = dayStart(ymd);
  if (!t) return null;
  const d = new Date(now);
  return Math.max(0, Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - t) / DAY));
}

// Why a pending backlog item has not started, as far as the app knows (roadmap 48): 前提待ち / 前提が failed /
// 順番待ち (position, the scheduler's reason) / QA 未回答. '' when nothing is known.
function pendingWhy(it, position, schedReason, statusOf, qa) {
  const out = [];
  const after = Array.isArray(it.after) ? it.after.filter((x) => typeof x === 'string' && x) : [];
  const failed = after.find((id) => statusOf(id) === 'failed');
  const open = after.find((id) => statusOf(id) === 'pending' || statusOf(id) === 'active');
  if (failed) out.push(`前提が failed（${failed}）`);
  else if (open) out.push(`前提待ち（${open} が ${statusOf(open)}）`);
  else if (schedReason && schedReason.code !== 'after' && schedReason.code !== 'after-failed') {
    out.push(`順番待ち（${position} 番目、${oneLine(schedReason.text, 60)}）`);
  } else if (position > 1) out.push(`順番待ち（${position} 番目）`);
  if (qa === 'open') out.push('QA 未回答');
  return out.join('、');
}

// findStale({ inboxItems, backlogs: [{ folder, name?, items, reasons?, progress? }], now, qaStatus? }) -> Finding[] (oldest first)
// Finding = { key, kind: 'inbox'|'backlog'|'progress', id, status, since, age, text, folder: string|null, name, inboxId: string|null,
//             detail, count?, days? }
// key changes when the item changes status, so a new kind of neglect is reported again.
// A routed inbox item is left out while one of its backlog items is pending / active (or already reported);
// it is reported when its backlog items are missing, or all finished while the inbox item stayed 'routed'.
// reasons = the scheduler's { [backlogId]: { code, text } } for that folder; progress = progress.progressSummary(folder);
// qaStatus(folder|null, id) -> 'none'|'open'|'answered' (folder null = an inbox item).
// A 'progress' finding is one per folder (key p:<folder>:確認待ち): ≥ STALE.progress.count 確認待ち rows, or one whose 更新日
// is ≥ STALE.progress.days old. id = '確認待ち', text = the row numbers, count = rows, days = oldest age in days (null if no date).
function findStale({ inboxItems = [], backlogs = [], now = Date.now(), qaStatus = null } = {}) {
  const out = [];
  const qaOf = (folder, id) => {
    try {
      return qaStatus ? qaStatus(folder, id) : 'none';
    } catch {
      return 'none';
    }
  };
  const linked = new Map(); // inboxId -> [{ it, folder }]
  // backlog items tied to an inbox item by the manager's link action: norm(folder) + '|' + backlogId -> inboxId
  const links = new Map();
  for (const it of inboxItems) for (const l of (it && it.links) || []) links.set(`${norm(l.folder)}|${l.backlogId}`, it.id);
  // every backlog item's status (after = ids of any folder)
  const statuses = new Map();
  for (const b of backlogs) for (const it of (b && Array.isArray(b.items) && b.items) || []) if (it && typeof it.id === 'string') statuses.set(it.id, it.status);
  const statusOf = (id) => statuses.get(id);
  for (const b of backlogs) {
    if (!b || typeof b.folder !== 'string' || !Array.isArray(b.items)) continue;
    const name = b.name || path.basename(b.folder) || b.folder;
    const pr = b.progress;
    if (pr && Array.isArray(pr.waiting) && pr.waiting.length) {
      const count = Number(pr.waitingCount) || pr.waiting.length;
      const ages = pr.waiting.map((r) => daysSince(r.updated, now)).filter((d) => d !== null);
      const days = ages.length ? Math.max(...ages) : null;
      if (count >= STALE.progress.count || (days !== null && days >= STALE.progress.days)) {
        const oldest = days !== null ? pr.waiting.find((r) => daysSince(r.updated, now) === days) : null;
        const since = oldest ? dayStart(oldest.updated) : now;
        const ns = pr.waiting.map((r) => r.n || oneLine(r.item, 20)).join('、') + (count > pr.waiting.length ? '、…' : '');
        out.push({
          key: `p:${norm(b.folder)}:確認待ち`,
          kind: 'progress',
          id: '確認待ち',
          status: '確認待ち',
          since,
          age: now - since,
          text: oneLine(ns, 200),
          folder: b.folder,
          name,
          inboxId: null,
          detail: oldest ? `最古 ${oldest.n} ${oneLine(oldest.item, 40)}（${oldest.updated}）` : '',
          count,
          days,
        });
      }
    }
    let position = 0;
    for (const it of b.items) {
      if (!it || typeof it.id !== 'string') continue;
      if (it.status === 'pending') position++;
      const inboxId = routedInboxId(it.id) || links.get(`${norm(b.folder)}|${it.id}`) || null;
      if (inboxId) {
        if (!linked.has(inboxId)) linked.set(inboxId, []);
        linked.get(inboxId).push(it);
      }
      const limit = STALE.backlog[it.status];
      if (!limit) continue;
      const since = backlogSince(it);
      if (!since || now - since < limit) continue;
      out.push({
        key: `b:${norm(b.folder)}:${it.id}:${it.status}`,
        kind: 'backlog',
        id: it.id,
        status: it.status,
        since,
        age: now - since,
        text: oneLine(it.text, 200),
        folder: b.folder,
        name,
        inboxId,
        detail:
          it.status === 'failed'
            ? oneLine(it.note, 80)
            : it.status === 'pending'
              ? pendingWhy(it, position, b.reasons && b.reasons[it.id], statusOf, qaOf(b.folder, it.id))
              : '',
      });
    }
  }
  const reportedInbox = new Set(out.map((f) => f.inboxId).filter(Boolean));
  for (const it of inboxItems) {
    if (!it || typeof it.id !== 'string') continue;
    const limit = STALE.inbox[it.status];
    if (!limit) continue;
    const since = it.updatedAt || it.createdAt || 0;
    if (!since || now - since < limit) continue;
    let detail = '';
    if (it.status === 'asking') detail = `質問の回答待ち${it.note ? `: ${oneLine(it.note, 70)}` : ''}`;
    else if (it.status === 'hold') detail = `保留${it.note ? `: ${oneLine(it.note, 70)}` : '（理由・再開の条件なし）'}`;
    else if (it.status === 'new' && qaOf(null, it.id) === 'open') detail = 'QA 未回答';
    if (it.status === 'routed') {
      const mine = linked.get(it.id) || [];
      // pending / active backlog work: still moving (its own thresholds cover a stall)
      if (reportedInbox.has(it.id) || mine.some((b) => b.status === 'pending' || b.status === 'active')) continue;
      detail = mine.length
        ? `バックログは ${[...new Set(mine.map((b) => b.status))].join('/')}、${INBOX_WORD}は${Labels.status('inbox', 'routed').short}（routed）のまま`
        : '振り分け先のバックログに項目が見つかりません';
    }
    out.push({
      key: `i:${it.id}:${it.status}`,
      kind: 'inbox',
      id: it.id,
      status: it.status,
      since,
      age: now - since,
      text: oneLine(it.text, 200),
      folder: it.folder || null,
      name: it.folder ? path.basename(it.folder) : INBOX_WORD,
      inboxId: it.id,
      detail,
    });
  }
  return out.sort((a, b) => a.since - b.since);
}

// No-nag rule. reported = keys reported earlier (still stale).
// -> { report, fresh: Set, keys: string[], stocktake: boolean }
// report only when some finding was not reported before; keys = the current findings (resolved ones are
// forgotten, so an item that comes back is reported again).
// Daily stocktake (棚卸し): when lastStocktake is missing or ≥ STOCKTAKE_EVERY_MS ago, the patrol is a stocktake —
// all current findings are reported again (fresh ones still marked [新]); with nothing stale it counts as done.
// The caller stores `now` as the new stocktake time when stocktake is true. Without opts: no stocktake.
// Is the next patrol a stocktake? (the progress check runs once before it, 依頼-188)
function stocktakeDue(lastStocktake, now = Date.now()) {
  const last = Number(lastStocktake) || 0;
  return !(last > 0) || now - last >= STOCKTAKE_EVERY_MS;
}
function patrolDecision(findings, reported = [], opts = null) {
  const before = new Set(reported);
  const keys = findings.map((f) => f.key);
  const fresh = new Set(keys.filter((k) => !before.has(k)));
  const now = (opts && opts.now) || Date.now();
  const stocktake = !!opts && stocktakeDue(opts.lastStocktake, now);
  return { report: fresh.size > 0 || (stocktake && keys.length > 0), fresh, keys, stocktake };
}

function ageText(ms) {
  if (ms >= DAY) return `${Math.floor(ms / DAY)}日`;
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)}時間`;
  return `${Math.max(1, Math.floor(ms / MIN))}分`;
}

// The "見回り" part of the manager prompt (≤ PATROL_TEXT_MAX chars). fresh = keys new since the last report.
// stocktake = the daily stocktake: a "棚卸し:" heading instead of "見回り:". held = inbox items on hold (保留; listed
// in the stocktake only, as 「保留 N 件」 with their note = reason / condition, so the PMO can review them once a day).
// held items that are already findings (on hold ≥ STALE.inbox.hold) are listed once, as findings.
function formatPatrol(findings, fresh = new Set(), { stocktake = false, held = [] } = {}) {
  const inFindings = new Set(findings.filter((f) => f.kind === 'inbox').map((f) => f.id));
  held = held.filter((i) => i && !inFindings.has(i.id));
  const heldText =
    stocktake && held.length
      ? `保留 ${held.length} 件（再開の条件を確かめ、整っていれば route、整っていなければ条件を満たす作業を積んでください）:\n` +
        held
          .slice(0, LIST_MAX)
          .map((i) => `[${inboxWhere('hold')}] ${i.id} 「${oneLine(i.title || i.text, 60)}」${i.note ? `（${oneLine(i.note, 80)}）` : ''}`)
          .join('\n') +
        (held.length > LIST_MAX ? `\nほか ${held.length - LIST_MAX} 件` : '')
      : '';
  if (!findings.length) return heldText ? `棚卸し: 放置されている項目はありません。\n${heldText}`.slice(0, PATROL_TEXT_MAX) : '';
  const body = formatFindings(findings, fresh, stocktake);
  return (heldText ? `${body}\n${heldText}` : body).slice(0, PATROL_TEXT_MAX);
}
function formatFindings(findings, fresh, stocktake) {
  const lines = findings.slice(0, LIST_MAX).map((f) => {
    const mark = fresh.has(f.key) ? '[新] ' : '';
    if (f.kind === 'progress-gap') {
      // 進み具合のずれ (progress-check.patrolFindings, 依頼-188): [agent_terminal 進み具合のずれ] 行 AT-1: <fact>（直す所）
      return `${mark}[${f.name} 進み具合のずれ] 行 ${f.id}: ${oneLine(f.text, 160)}${f.detail ? `（${f.detail}）` : ''}`;
    }
    if (f.kind === 'progress') {
      // [agent_terminal 確認待ち 14 件・最古 1日] 5b、9、13、…（最古 …）
      const oldest = f.days === null || f.days === undefined ? '' : `・最古 ${f.days}日`;
      return `${mark}[${f.name} 確認待ち ${f.count} 件${oldest}] ${oneLine(f.text, 120)}${f.detail ? `（${f.detail}）` : ''}`;
    }
    const where = f.kind === 'inbox' ? inboxWhere(f.status) : `${f.name} ${f.status}`;
    const extra = [f.kind === 'backlog' && f.inboxId ? `${INBOX_WORD} ${f.inboxId}` : '', f.detail].filter(Boolean).join('、');
    return `${mark}[${where} ${ageText(f.age)}] ${f.id} 「${oneLine(f.text, 60)}」${extra ? `（${extra}）` : ''}`;
  });
  if (findings.length > LIST_MAX) lines.push(`ほか ${findings.length - LIST_MAX} 件`);
  const head =
    (stocktake
      ? `棚卸し: 放置されている項目（${findings.length} 件）。1 日 1 回、まだ放置されているものをすべて挙げています。`
      : `見回り: 放置されている項目があります（${findings.length} 件）。`) +
    '各項目について、立て直しのアクション（reorder / route・create の振り直し / backlog-update / update / 前提を先に進める）を' +
    'この回のうちに outbox に書いてください。指摘だけで終えない。ユーザーの判断がどうしても要るものだけ、仮説付きの qa を書いて別の作業を前に出す' +
    '（決まりは CLAUDE.md の「放置の立て直し」）。';
  return head + '\n' + lines.join('\n');
}

module.exports = { STALE, PATROL_FIRST_MS, PATROL_EVERY_MS, STOCKTAKE_EVERY_MS, findStale, patrolDecision, stocktakeDue, formatPatrol, ageText, routedInboxId, daysSince, inboxWhere };
