// UIUX U8 (依頼-51 D, docs/concept-uiux.md §4 U8, docs/plan-review.md): when all the work of a folder is over, the app
// puts one more work on it: "think again about the user's aim, check the output is the best, list what is left".
// The review session is an ordinary routed session (it gets the routed-session preface and 「この作業の id」), so what it
// finds goes out with the U7 propose (src/main/propose.js). When a review proposes nothing, the folder is marked
// 「すべて完了」 (projects.json review, the dashboard's card); a new request takes the mark off.
//
// Guards: a review is queued only after work (not a review) finished since the last look, the folder stayed idle for
// IDLE_MS and nothing of it is open in the inbox; reviews whose proposals were done chain, at most MAX_ROUNDS in a row
// (then the PMO is told and the user decides); a failed review is not retried.
//
// State per folder (<userData>/review.json): { folder, status: idle|running|reviewed|allDone|stopped, round, since,
//   idleAt, reviewId, inboxId, reviewIds: [...], reviewInboxIds: [...], at, doneAt? }.
// decide() is pure; the store and queue() do the files. No Electron imports (testable from plain Node).
const path = require('path');
const fs = require('fs');
const { META_DIR, LEGACY_META_DIR } = require('./names');
const crypto = require('crypto');

const MAX_ROUNDS = 3; // 「同じフォルダで続けて 3 回まで」
const IDLE_MS = 60 * 1000; // the folder stays idle this long first (the PMO may still route the next work)
const GRACE_MS = 10 * 1000; // after the review is done, proposals still on their way (outbox poll 2 s + 1 s settle)
const IDS_KEEP = 20;
const OPEN_INBOX = new Set(['new', 'asking', 'routed']); // 依頼にそのフォルダの未完了（new・asking・routed）が無いこと
const STATUSES = new Set(['idle', 'running', 'reviewed', 'allDone', 'stopped']);
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const norm = (f) => path.resolve(String(f || '')).toLowerCase();
const same = (a, b) => !!a && !!b && norm(a) === norm(b);

function routedInboxId(id) {
  const m = /^r-(.+)-[0-9a-f]{1,8}$/.exec(String(id || ''));
  return m && m[1] !== 'x' ? m[1] : null;
}

// Inbox items that belong to the folder: its folder, a session proposal from it, or a link to it.
function ofFolder(i, folder) {
  return !!i && (same(i.folder, folder) || (i.origin && same(i.origin.folder, folder)) || (Array.isArray(i.links) && i.links.some((l) => l && same(l.folder, folder))));
}

// Is something of the folder still to do? backlog pending / active, or an open inbox item of the folder; unrouted new
// requests (no folder yet) hold the queuing too (unrouted: true), since the PMO may route them here; they do not take a
// mark off. skip = inbox ids not to count (the reviews' own items, routed until their done reaches the inbox).
function busyOf(folder, items, inboxItems, { skip = [], unrouted = false } = {}) {
  if ((items || []).some((i) => i && (i.status === 'pending' || i.status === 'active'))) return true;
  return (inboxItems || []).some((i) => i && !skip.includes(i.id) && ((OPEN_INBOX.has(i.status) && ofFolder(i, folder)) || (unrouted && i.status === 'new' && !i.folder && i.source !== 'session')));
}

// The proposals a review put into the inbox (U7 propose, origin.backlogId = the review's backlog id).
const proposalsOf = (reviewId, inboxItems) => (inboxItems || []).filter((i) => i && i.source === 'session' && i.origin && i.origin.backlogId === reviewId);

// Did a backlog item come from a review's proposal? (r-<inboxId>-… -> the inbox item, a session proposal of a review)
function fromReview(item, inboxItems, reviewIds) {
  const id = routedInboxId(item && item.id);
  const linked = (inboxItems || []).find((i) => i && (i.id === id || (Array.isArray(i.links) && i.links.some((l) => l && l.backlogId === item.id))));
  return !!(linked && linked.source === 'session' && linked.origin && reviewIds.includes(linked.origin.backlogId));
}

function fresh(folder, now) {
  return { folder, status: 'idle', round: 0, since: now, idleAt: null, reviewId: null, inboxId: null, reviewIds: [], reviewInboxIds: [], at: now };
}

// One folder's next step. st = its state (null: never seen), items = its backlog items, inboxItems = all inbox items.
// o = { now, outboxBusy (files waiting in its .bantodesk/outbox or the former .agent-terminal/outbox), idleMs, graceMs, maxRounds }
// -> { action, state, round?, proposals? }
//   action: 'none' | 'baseline' (first look: only work finished from now on counts) | 'wait' (idle timer started / reset)
//   | 'queue' (put review number `round` on it) | 'all-done' | 'reviewed' (the review proposed `proposals`) | 'review-failed'
//   | 'stop' (MAX_ROUNDS reviews in a row; tell the PMO) | 'clear' (new work: the mark is taken off)
function decide(st, items, inboxItems, o = {}) {
  const now = o.now ?? Date.now();
  const idleMs = o.idleMs ?? IDLE_MS;
  const graceMs = o.graceMs ?? GRACE_MS;
  const maxRounds = o.maxRounds ?? MAX_ROUNDS;
  const folder = o.folder || (st && st.folder);
  if (!st) return { action: 'baseline', state: fresh(folder, now) };
  const s = { ...st, reviewIds: [...(st.reviewIds || [])], reviewInboxIds: [...(st.reviewInboxIds || [])] };
  const skip = s.reviewInboxIds;
  if (s.status === 'running') {
    const r = (items || []).find((i) => i && i.id === s.reviewId);
    if (r && (r.status === 'pending' || r.status === 'active')) return { action: 'none', state: s };
    if (r && r.status === 'done') {
      const doneAt = num(r.doneAt) ?? now;
      if (now - doneAt < graceMs || o.outboxBusy) return { action: 'none', state: s }; // proposals may still come
      const props = proposalsOf(s.reviewId, inboxItems);
      if (props.length) return { action: 'reviewed', proposals: props, state: { ...s, status: 'reviewed', since: doneAt, idleAt: null, doneAt, at: now } };
      if (busyOf(folder, items, inboxItems, { skip })) return { action: 'reviewed', proposals: [], state: { ...s, status: 'reviewed', since: doneAt, idleAt: null, doneAt, at: now } }; // other work came meanwhile
      return { action: 'all-done', state: { ...s, status: 'allDone', round: 0, since: doneAt, idleAt: null, doneAt, at: now } };
    }
    // failed, dropped or gone: not retried; the next finished work starts a new chain
    return { action: 'review-failed', item: r || null, state: { ...s, status: 'idle', round: 0, since: now, idleAt: null, at: now } };
  }
  if (busyOf(folder, items, inboxItems, { skip })) {
    if (s.status === 'allDone' || s.status === 'stopped') return { action: 'clear', state: { ...s, status: 'idle', round: 0, idleAt: null, at: now } };
    return { action: 'none', state: { ...s, idleAt: null } };
  }
  if (busyOf(folder, items, inboxItems, { skip, unrouted: true })) return { action: 'none', state: { ...s, idleAt: null } };
  if (s.status === 'allDone' || s.status === 'stopped') return { action: 'none', state: s };
  const newDone = (items || []).filter((i) => i && i.status === 'done' && (num(i.doneAt) ?? 0) > (s.since || 0) && !s.reviewIds.includes(i.id));
  if (!newDone.length) {
    // the PMO dropped every proposal of the last review: nothing more to do after all
    if (s.status === 'reviewed' && s.reviewId) {
      const props = proposalsOf(s.reviewId, inboxItems);
      if (props.length && props.every((p) => p.status === 'dropped')) return { action: 'all-done', state: { ...s, status: 'allDone', round: 0, idleAt: null, at: now } };
    }
    return { action: 'none', state: s };
  }
  if (!s.idleAt) return { action: 'wait', state: { ...s, idleAt: now } };
  if (now - s.idleAt < idleMs) return { action: 'none', state: s };
  const chained = s.status === 'reviewed' && newDone.every((i) => fromReview(i, inboxItems, s.reviewIds));
  const round = (chained ? s.round || 0 : 0) + 1;
  if (round > maxRounds) return { action: 'stop', round: round - 1, state: { ...s, status: 'stopped', since: now, idleAt: null, at: now } };
  return { action: 'queue', round, state: { ...s, status: 'running', round, idleAt: null, at: now } };
}

// --- the review's text (docs/prompts/review.md, its ```text block; {{name}} placeholders) ---------------------------
const REVIEW_FALLBACK = [
  'このフォルダ（{{folder}}）の作業が全部終わったので、アプリが見直しの作業を積みました（続けて {{round}} 回目、{{max}} 回まで）。',
  '(a) README、PLAN / project-plan、PROGRESS.md と、下のユーザーの依頼の原文を読み、ユーザーの目的を自分の言葉で書き直す。',
  '(b) 成果物を目的に照らして確かめる（動かす・開く・数字を検算する）。',
  '(c) 足りないもの・直すべきものがあれば、次にやること（propose）として .bantodesk/outbox/ に出す（自分では始めない）。',
  '(d) 何も無ければ、最善と判断した理由を書き、PROGRESS.md に「すべて完了（見直し済み）」の行を足す（状態は 完了）。',
  '(e) 最後に 作業完了 と書く。',
  '',
  'ユーザーの依頼の原文:',
  '{{requests}}',
].join('\n');

function template(file) {
  try {
    const m = /```text\r?\n([\s\S]*?)```/.exec(fs.readFileSync(file, 'utf8'));
    if (m && m[1].trim()) return m[1].trim();
  } catch {}
  return REVIEW_FALLBACK;
}

// The user's own words for the folder: inbox items routed / done there (originalText before the PMO's edits), newest last.
// Items the PMO added (route inbox: true, often on the user's behalf) come too, marked; the app's (carry-over, reviews)
// and the sessions' proposals do not.
function requestsOf(folder, inboxItems, { max = 10, each = 800 } = {}) {
  const list = (inboxItems || [])
    .filter((i) => i && (i.source === 'user' || i.source === 'manager') && ofFolder(i, folder) && i.status !== 'dropped')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .slice(-max);
  if (!list.length) return '（このフォルダに来た依頼は記録に無い。README・PROGRESS.md・docs から目的を読み取る）';
  return list.map((i) => `- ${i.reqNo || i.id}${i.source === 'manager' ? '（PMO が足した）' : ''}${i.title ? ' ' + i.title : ''}: ${String(i.originalText || i.text).replace(/\s+/g, ' ').trim().slice(0, each)}`).join('\n');
}

function render(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (all, k) => (vars[k] !== undefined ? String(vars[k]) : all));
}

const TITLE = (round) => `見直し（${round} 回目）: 目的に照らして成果を確かめる`;

// Puts the review on the folder: an inbox item (source app, routed at once) + its backlog item r-<inboxId>-<hex>
// (pending; the folder's window starts it like any routed work). ctx = { inbox, appendBacklog(folder, raw) -> item,
// templateFile, maxRounds }. -> { inboxId, backlogId, no, item }
async function queue(folder, round, ctx) {
  const inboxItems = ctx.inbox.get().items;
  const text = render(template(ctx.templateFile), {
    folder,
    name: path.basename(folder),
    round,
    max: ctx.maxRounds || MAX_ROUNDS,
    requests: requestsOf(folder, inboxItems),
  }).slice(0, 19000);
  const title = TITLE(round);
  const it = ctx.inbox.add({ text, title, source: 'app', folder, historyNote: `アプリが見直し（${round} 回目）を積んだ` });
  if (!it) throw new Error('the inbox refused the review');
  const bi = await ctx.appendBacklog(folder, {
    id: `r-${it.id}-`.slice(0, 31) + crypto.randomBytes(4).toString('hex'),
    title,
    text,
    tabId: null,
    status: 'pending',
    createdAt: Date.now(),
    startedAt: null,
    doneAt: null,
    note: '',
    kind: 'verify',
  });
  ctx.inbox.update(it.id, { status: 'routed', folder, ...(bi.no ? { no: bi.no } : {}) }, { source: 'app', internal: true });
  return { inboxId: it.id, backlogId: bi.id, no: bi.no || null, item: bi };
}

// --- the store (<userData>/review.json) ------------------------------------------------------------------------------
function sanitizeState(o) {
  if (!o || typeof o !== 'object' || typeof o.folder !== 'string' || !path.isAbsolute(o.folder)) return null;
  const id = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : null);
  return {
    folder: o.folder,
    status: STATUSES.has(o.status) ? o.status : 'idle',
    round: Math.max(0, Math.min(99, num(o.round) ?? 0)),
    since: num(o.since) ?? 0,
    idleAt: num(o.idleAt),
    reviewId: id(o.reviewId),
    inboxId: id(o.inboxId),
    reviewIds: Array.isArray(o.reviewIds) ? o.reviewIds.filter(id).slice(-IDS_KEEP) : [],
    reviewInboxIds: Array.isArray(o.reviewInboxIds) ? o.reviewInboxIds.filter(id).slice(-IDS_KEEP) : [],
    at: num(o.at) ?? 0,
    ...(num(o.doneAt) !== null ? { doneAt: o.doneAt } : {}),
  };
}

function createStore(file) {
  let folders = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const v of Object.values((raw && raw.folders) || {})) {
      const s = sanitizeState(v);
      if (s) folders[norm(s.folder)] = s;
    }
  } catch {}
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ folders }, null, 1));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.warn('[review] save failed', err && err.message);
    }
  };
  return {
    get: (folder) => folders[norm(folder)] || null,
    set(folder, st) {
      const s = sanitizeState({ ...st, folder });
      if (!s) return;
      folders[norm(folder)] = s;
      save();
    },
    all: () => Object.values(folders),
  };
}

// What projects.json / the dashboard show: { status, round, at } for a folder with a mark or a running review, else null.
function summary(st) {
  if (!st || st.status === 'idle') return null;
  return { status: st.status, round: st.round || 0, at: st.at || 0, ...(st.status === 'allDone' ? { allDone: true } : {}) };
}

// Files waiting in <folder>/.bantodesk/outbox or the former .agent-terminal/outbox (BN3 compat; a review's proposal may
// still be on its way).
function outboxBusy(folder) {
  return [META_DIR, LEGACY_META_DIR].some((m) => {
    try {
      return fs.readdirSync(path.join(folder, m, 'outbox')).some((n) => /\.json$/i.test(n) && !/\.result\.json$/i.test(n));
    } catch {
      return false;
    }
  });
}

// One look over folders(). ctx = { store, inbox, backlogItems(folder) -> items | Promise, appendBacklog(folder, raw),
// templateFile, now?(), idleMs?, graceMs?, maxRounds?, outboxBusy?(folder), onAction?(action, info) }
// info = { folder, round, state, queued?: { inboxId, backlogId, no, item }, proposals?, item? }. -> [{ folder, action }]
async function tick(folders, ctx) {
  const out = [];
  const seen = new Set();
  for (const folder of folders || []) {
    if (typeof folder !== 'string' || !folder || seen.has(norm(folder))) continue;
    seen.add(norm(folder));
    let items;
    try {
      items = (await ctx.backlogItems(folder)) || [];
    } catch {
      continue;
    }
    const now = ctx.now ? ctx.now() : Date.now();
    const st = ctx.store.get(folder);
    const d = decide(st, items, ctx.inbox.get().items, {
      folder,
      now,
      idleMs: ctx.idleMs,
      graceMs: ctx.graceMs,
      maxRounds: ctx.maxRounds,
      outboxBusy: ctx.outboxBusy ? ctx.outboxBusy(folder) : outboxBusy(folder),
    });
    let state = d.state;
    let queued = null;
    if (d.action === 'queue') {
      try {
        queued = await queue(folder, d.round, { inbox: ctx.inbox, appendBacklog: ctx.appendBacklog, templateFile: ctx.templateFile, maxRounds: ctx.maxRounds });
      } catch (err) {
        console.warn('[review] queue failed', err && err.message);
        continue; // the state stays: tried again next look
      }
      state = {
        ...state,
        reviewId: queued.backlogId,
        inboxId: queued.inboxId,
        reviewIds: [...state.reviewIds, queued.backlogId].slice(-IDS_KEEP),
        reviewInboxIds: [...state.reviewInboxIds, queued.inboxId].slice(-IDS_KEEP),
      };
    }
    if (JSON.stringify(state) !== JSON.stringify(st)) ctx.store.set(folder, state);
    if (d.action !== 'none' && ctx.onAction) {
      try {
        ctx.onAction(d.action, { folder, round: d.round ?? state.round, state, queued, proposals: d.proposals, item: d.item });
      } catch (err) {
        console.warn('[review] onAction failed', err && err.message);
      }
    }
    out.push({ folder, action: d.action });
  }
  return out;
}

module.exports = { tick, MAX_ROUNDS, IDLE_MS, GRACE_MS, decide, busyOf, proposalsOf, fromReview, requestsOf, template, render, queue, createStore, sanitizeState, summary, outboxBusy, REVIEW_FALLBACK, TITLE };
