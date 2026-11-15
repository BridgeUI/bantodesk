// The queue order as the user sees it (docs/queue-order.md): for every folder its waiting tasks in the order they are
// sent, which one starts next over all folders, and why each one does not start yet (with the task it waits for).
// No Electron imports (tested from plain Node: tmp/queue-order/unit.js). main.js gathers the inputs (queue:order).
//
// The verdicts are the scheduler's own rules (src/main/sched.js planStarts), judged again here over all the folders
// at once, the way they are judged when a slot frees: folders with a window first (their windows ask as soon as
// something changes), then the folders without one (main looks at them every 15 s), each in the given order.
const sched = require('./sched');
const Labels = require('../renderer/labels'); // 「次のタスク」 (WORDS.nextTask, docs/ui-wording.md)
const NEXT_TASK = (Labels.WORDS && Labels.WORDS.nextTask) || '次のタスク';

const LOCK_MS = 24 * 60 * 60 * 1000; // src/main/backlog.js USER_ORDER_LOCK_MS (the user's ↑ / ↓ wins this long)

const normFolder = (f) =>
  String(f || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
const baseName = (f) => String(f || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(f || '');
const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

function statusOf(items, id) {
  if (!items) return undefined;
  if (items instanceof Map) return items.get(id);
  return Object.prototype.hasOwnProperty.call(items, id) ? items[id] : undefined;
}

// What a line calls a task: its number (AT-12), else its heading, else its id.
const nameOf = (it) => (it && typeof it.no === 'string' && it.no ? it.no : it && it.title ? oneLine(it.title, 40) : it ? it.id : '');

// Waiting tasks of one folder that the scheduler judges: pending, not tied to a tab. A folder without a window starts
// only routed ones (r-*): its others wait until the folder is opened (code 'closed').
const isQueued = (i) => i && typeof i.id === 'string' && i.status === 'pending' && !i.tabId;
const isRouted = (i) => typeof i.id === 'string' && i.id.startsWith('r-');

const toWaiting = (i, folder) => ({
  id: i.id,
  folder,
  kind: sched.KINDS.has(i.kind) ? i.kind : null,
  touches: Array.isArray(i.touches) ? i.touches.filter((t) => typeof t === 'string') : [],
  after: Array.isArray(i.after) ? i.after.filter((t) => typeof t === 'string') : [],
});

const CLOSED = Object.freeze({ code: 'closed', text: 'フォルダを開くと始まります（振り分けた作業ではないため）' });
const TAB_TEXT = 'このセッションの手が空いたら送ります';

/**
 * -> {
 *   limit, running: n, free, hold: { code, text } | null,
 *   next: { folder, id, no, title, why: 'free'|'limit'|'resource' } | null,
 *   line: string (「次のタスク: AT-61 見出し」。見出しは名詞（docs/ui-wording.md）。空きの数は上の帯「動いている N / 上限 M」にあるので書かない),
 *   folders: [{ folder, name, open, items: QueueItem[], tabbed: QueueItem[], lastReorder, orderLock }]
 * }
 * QueueItem = { id, no, title, text, position, state: 'next'|'start'|'wait', reason: { code, text } | null,
 *   after: [{ id, no, status, position|null, folderName|null, done }], overlap: { id, no, running, position|null } | null,
 *   ahead: [{ id, no, position }] (earlier waiting tasks of the folder whose scope overlaps), kind, touches }
 *
 * folders:   [{ folder, open, items }] (items = the folder's backlog in its order), the order to judge them in
 * running:   [{ folder, id, kind, touches }] running routed tasks of all folders (main's schedRunning)
 * statuses:  Map | object id -> status (all folders known); nos: Map | object id -> no; folderOf: Map id -> folder
 * limit / over (resource texts) / hold: as sched.planStarts / planClosed
 * reorders:  { [normFolder]: { at, reason } } the PMO's last reorder per folder
 * locks:     { [normFolder]: userOrderAt } when the user last moved a task of that folder (ms)
 */
function buildQueueOrder({ folders = [], running = [], statuses = null, nos = null, folderOf = null, limit = sched.DEFAULT_LIMIT, over = [], hold = null, reorders = {}, locks = {}, now = Date.now() } = {}) {
  const max = sched.clampLimit(limit);
  const list = (Array.isArray(folders) ? folders : []).filter((f) => f && typeof f.folder === 'string');
  // judge order: folders with a window first, then the others (each group keeps the given order)
  const judged = [...list.filter((f) => f.open), ...list.filter((f) => !f.open)];
  const names = new Map(nos instanceof Map ? nos : Object.entries(nos && typeof nos === 'object' ? nos : {}));
  const byId = new Map(); // id -> { it, folder }
  for (const f of list) {
    for (const i of Array.isArray(f.items) ? f.items : []) {
      if (!i || typeof i.id !== 'string') continue;
      byId.set(i.id, { it: i, folder: f.folder });
      if (typeof i.no === 'string' && i.no && !names.has(i.id)) names.set(i.id, i.no);
    }
  }
  const stat = (id) => {
    const s = statusOf(statuses, id);
    if (s !== undefined) return s;
    const k = byId.get(id);
    return k ? k.it.status : undefined;
  };
  const allStatuses = new Map();
  for (const [id, k] of byId) allStatuses.set(id, k.it.status);
  if (statuses instanceof Map) for (const [id, s] of statuses) allStatuses.set(id, s);
  else if (statuses && typeof statuses === 'object') for (const [id, s] of Object.entries(statuses)) allStatuses.set(id, s);

  const busy = (Array.isArray(running) ? running : []).filter(Boolean).map((r) => ({ ...r }));
  const runningCount = busy.length;
  const verdict = new Map(); // id -> { state, reason }
  const startOrder = []; // ids that would start now, in judge order
  for (const f of judged) {
    const queued = (f.items || []).filter(isQueued);
    const asked = queued.filter((i) => f.open || isRouted(i));
    for (const i of queued) if (!asked.includes(i)) verdict.set(i.id, { state: 'wait', reason: { ...CLOSED } });
    if (!asked.length) continue;
    if (hold) {
      for (const i of asked) verdict.set(i.id, { state: 'wait', reason: { code: hold.code, text: hold.text } });
      continue;
    }
    const waiting = asked.map((i) => toWaiting(i, f.folder));
    const plan = sched.planStarts({ waiting, running: busy, items: allStatuses, limit: max, resources: { over }, nos: names });
    for (const w of waiting) {
      if (plan.start.includes(w.id)) {
        verdict.set(w.id, { state: 'start', reason: null });
        startOrder.push(w.id);
        busy.push({ id: w.id, folder: f.folder, kind: w.kind, touches: w.touches, planned: true });
      } else verdict.set(w.id, { state: 'wait', reason: plan.reasons[w.id] || null });
    }
  }

  // the task that starts next over all folders: one that may start now, else the first held back only by the limit /
  // the resources (rules a / b: it starts when a slot frees), in judge order
  let next = null;
  const pick = (id, why) => {
    const k = byId.get(id);
    next = { folder: k.folder, id, no: k.it.no || null, title: k.it.title || null, why };
  };
  if (startOrder.length) pick(startOrder[0], 'free');
  else if (!hold) {
    outer: for (const f of judged) {
      for (const i of (f.items || []).filter(isQueued)) {
        const v = verdict.get(i.id);
        if (v && v.reason && (v.reason.code === 'limit' || v.reason.code === 'resource')) {
          pick(i.id, v.reason.code);
          break outer;
        }
      }
    }
  }
  if (next) {
    const v = verdict.get(next.id);
    if (v && v.state === 'start') v.state = 'next';
    else if (v) v.next = true;
  }
  const free = Math.max(0, max - runningCount);
  const nextName = next ? nameOf(byId.get(next.id).it) : '';
  const many = list.length > 1;
  const where = next && many ? `${baseName(next.folder)} · ` : '';
  let line;
  if (hold) line = `${hold.text}`;
  else if (next && next.why === 'free') line = `${NEXT_TASK}: ${where}${nextName}`;
  else if (next && next.why === 'limit') line = `${NEXT_TASK}: ${where}${nextName}（空き待ち）`;
  else if (next && next.why === 'resource') line = `${NEXT_TASK}: ${where}${nextName}（資源待ち）`;
  else if ([...verdict.values()].length) line = `${NEXT_TASK}: なし（前提・重なり待ち）`;
  else line = `${NEXT_TASK}: なし`;

  const runningIds = new Set((Array.isArray(running) ? running : []).map((r) => r && r.id));
  const out = [];
  for (const f of list) {
    const key = normFolder(f.folder);
    const queued = (f.items || []).filter(isQueued);
    const pos = new Map(queued.map((i, k) => [i.id, k + 1]));
    const scopes = new Map(queued.map((i) => [i.id, sched.scopeOf(i)]));
    const items = queued.map((i, k) => {
      const v = verdict.get(i.id) || { state: 'wait', reason: null };
      const reason = v.reason ? { code: v.reason.code, text: v.reason.text } : null;
      // the prerequisites, each with where it is (its place in this queue, or the folder it is in)
      const after = (Array.isArray(i.after) ? i.after : [])
        .filter((a) => typeof a === 'string' && a && a !== i.id)
        .map((a) => {
          const k2 = byId.get(a);
          const st = stat(a);
          const sameFolder = k2 && normFolder(k2.folder) === key;
          const fo = k2 ? k2.folder : folderOf instanceof Map ? folderOf.get(a) : null;
          return {
            id: a,
            no: names.get(a) || null,
            status: st === undefined ? null : st,
            position: sameFolder && pos.has(a) ? pos.get(a) : null,
            folderName: fo && !sameFolder ? baseName(fo) : null,
            done: st === 'done' || st === undefined || st === null,
          };
        });
      // who the overlap is with: a running task of this folder, or one this pass starts first
      let overlap = null;
      if (reason && reason.code === 'overlap') {
        const mine = scopes.get(i.id);
        for (const b of busy) {
          if (normFolder(b.folder) !== key || b.id === i.id) continue;
          if (b.planned && (pos.get(b.id) || Infinity) > k + 1) continue;
          if (sched.overlapOf(mine, sched.scopeOf(b))) {
            overlap = { id: b.id, no: names.get(b.id) || null, running: runningIds.has(b.id), position: pos.has(b.id) ? pos.get(b.id) : null };
            break;
          }
        }
      }
      // earlier waiting tasks of the folder that touch the same files: they will not run side by side
      const ahead = [];
      for (const j of queued.slice(0, k)) {
        if (sched.overlapOf(scopes.get(i.id), scopes.get(j.id))) ahead.push({ id: j.id, no: names.get(j.id) || null, position: pos.get(j.id) });
      }
      const q = {
        id: i.id,
        no: i.no || null,
        title: i.title || null,
        text: oneLine(i.text, 200),
        position: k + 1,
        state: v.state,
        next: v.state === 'next' || !!v.next,
        reason,
        after,
        overlap,
        ahead,
        kind: i.kind || null,
        touches: Array.isArray(i.touches) ? i.touches.slice(0, 20) : [],
      };
      q.detail = detailParts(q);
      q.info = infoParts(q);
      return q;
    });
    const tabbed = (f.items || [])
      .filter((i) => i && i.status === 'pending' && i.tabId)
      .map((i) => ({ id: i.id, no: i.no || null, title: i.title || null, text: oneLine(i.text, 200), tabId: i.tabId, reason: { code: 'tab', text: TAB_TEXT } }));
    const r = reorders && reorders[key];
    const userAt = locks && Number(locks[key]);
    const lockUntil = Number.isFinite(userAt) && userAt > 0 && now - userAt < LOCK_MS ? userAt + LOCK_MS : null;
    out.push({
      folder: f.folder,
      name: baseName(f.folder),
      open: !!f.open,
      items,
      tabbed,
      lastReorder: r && r.reason ? { at: r.at || null, reason: oneLine(r.reason, 300) } : null,
      orderLock: lockUntil ? { userOrderAt: userAt, until: lockUntil, leftMs: lockUntil - now, leftText: leftText(lockUntil - now) } : null,
    });
  }
  return { limit: max, running: runningCount, free, hold: hold ? { code: hold.code, text: hold.text } : null, next, line, folders: out };
}

// 「残り 3 時間 20 分」 for an orderLock's leftMs
function leftText(ms) {
  const m = Math.max(0, Math.ceil(ms / 60000));
  if (m >= 60) return `${Math.floor(m / 60)} 時間${m % 60 ? ` ${m % 60} 分` : ''}`;
  return `${m} 分`;
}

// One line of a task's place for the card: 「前提: AT-5（2 番目）」「重なり: AT-3（実行中）」 parts. -> string[]
function detailParts(q) {
  const parts = [];
  for (const a of q.after || []) {
    if (a.done && a.status === 'done') continue;
    const nm = a.no || a.id;
    const where = a.position ? `${a.position} 番目` : a.folderName ? a.folderName : '';
    const st = a.status === 'failed' ? '失敗' : a.status === 'active' ? '動作中' : a.status === 'pending' && !a.position ? '待ち' : '';
    parts.push(`前提: ${nm}${[where, st].filter(Boolean).length ? `（${[where, st].filter(Boolean).join('・')}）` : ''}`);
  }
  if (q.overlap) parts.push(`重なり: ${q.overlap.no || q.overlap.id}（${q.overlap.running ? '動作中' : `${q.overlap.position} 番目が先に始まる`}）`);
  else if (q.ahead && q.ahead.length) parts.push(`同じ範囲: ${q.ahead.map((x) => `${x.no || x.id}（${x.position} 番目）`).join('・')}`);
  return parts;
}

// What the card writes under a waiting task (one line, nothing said twice): the prerequisites with their place instead of
// 「前提の AT-5 が済んでいません」, the scheduler's overlap text (it names the files and the task), else the reason's text;
// + the earlier waiting tasks on the same files. Nothing for the task that starts next / now. -> string[]
function infoParts(q) {
  const parts = [];
  const code = q.reason && q.reason.code;
  const startsFirst = q.state === 'next' || q.state === 'start' || q.next;
  if (code === 'after' || code === 'after-failed') {
    const pre = (q.detail || []).filter((d) => d.startsWith('前提: '));
    parts.push(...(pre.length ? pre : [q.reason.text]));
  } else if (code && !startsFirst) parts.push(q.reason.text);
  if (code !== 'overlap') parts.push(...(q.detail || []).filter((d) => d.startsWith('同じ範囲: ')));
  return parts;
}

// The PMO request for a folder's queue (dashboard 「PMO に順番を見直してもらう」): the inbox text.
function askText(folder, note) {
  const n = oneLine(note, 500);
  return `${baseName(folder)} の待ち行列の順番を見直して: ${n || '（ひとことなし）'}\n\nフォルダ: ${folder}\n（ダッシュボードのカードからの順番の見直し。CLAUDE.md の「順番決め」のとおり route せず、reorder か notice で答える）`;
}

module.exports = { normFolder, buildQueueOrder, leftText, detailParts, askText, LOCK_MS, TAB_TEXT };
