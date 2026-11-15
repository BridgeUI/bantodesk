// 「PMO から」 notices (roadmap 20, 2026-11-03): announcements (info), findings (warn) and proposals (proposal) from the
// manager agent (outbox action `notice`) and from the app's own PMO patrol, shown together on the dashboard.
// Stored by main in <userData>/manager/notices.json = { notices: Notice[] } (newest last) so the manager agent can read
// them (incl. the user's answers to proposals) and the read state survives restarts.
//   Notice = { id, kind: 'info'|'warn'|'proposal', title, text (Markdown), folder: string|null, itemId: string|null,
//              key: string|null, source: 'manager'|'app', createdAt, updatedAt, readAt: number|null,
//              resolvedAt: number|null, answer: { choice: 'go'|'reject', comment, at } | null,
//              announcedAt: number|null (updatedAt of the version announced by a desktop notification), refs: string[] }
// Life (U4): the dashboard shows info / warn only in 「PMO の記録」 (forLog), with no read operation; info goes 7 days after
// its last update (or its read, in old files), answered proposals 7 days after the answer; warn stays until resolved;
// resolved ones stay in the record (as 立て直し) and are dropped after 7 days. readAt / read() remain for old files and IPC.
// A notice with the key of a live one replaces it (same id; unread again when title / text / kind changed).
// Sync atomic writes (tmp + rename); the file is small. No Electron imports (testable from plain Node).
const path = require('path');
const crypto = require('crypto');
const writeq = require('./writeq');
const Labels = require('../renderer/labels'); // 「依頼 保留」 etc. (the patrol lines' words, src/main/pmo.js inboxWhere)

const KINDS = new Set(['info', 'warn', 'proposal']);
const CHOICES = new Set(['go', 'reject']);
const TITLE_MAX = 200;
const TEXT_MAX = 8000;
const KEY_MAX = 200;
const COMMENT_MAX = 2000;
const FOLDER_MAX = 1000;
const REFS_MAX = 100;
const NOTICES_MAX = 200;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const newId = () => 'n' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

function sanitizeAnswer(a) {
  if (!a || typeof a !== 'object' || !CHOICES.has(a.choice)) return null;
  return { choice: a.choice, comment: typeof a.comment === 'string' ? a.comment.trim().slice(0, COMMENT_MAX) : '', at: num(a.at) ?? 0 };
}

function sanitizeNotice(o) {
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !ID_RE.test(o.id) || !KINDS.has(o.kind)) return null;
  const title = oneLine(o.title, TITLE_MAX);
  if (!title) return null;
  const createdAt = num(o.createdAt) ?? 0;
  return {
    id: o.id,
    kind: o.kind,
    title,
    text: typeof o.text === 'string' ? o.text.slice(0, TEXT_MAX) : '',
    folder: typeof o.folder === 'string' && o.folder && path.isAbsolute(o.folder) ? o.folder.slice(0, FOLDER_MAX) : null,
    itemId: typeof o.itemId === 'string' && ID_RE.test(o.itemId) ? o.itemId : null,
    key: typeof o.key === 'string' && o.key.trim() ? o.key.trim().slice(0, KEY_MAX) : null,
    source: o.source === 'app' ? 'app' : 'manager',
    createdAt,
    updatedAt: num(o.updatedAt) ?? createdAt,
    readAt: num(o.readAt),
    resolvedAt: num(o.resolvedAt),
    answer: o.kind === 'proposal' ? sanitizeAnswer(o.answer) : null,
    announcedAt: num(o.announcedAt), // = updatedAt of the version the dashboard raised a desktop notification for
    refs: Array.isArray(o.refs) ? o.refs.filter((r) => typeof r === 'string').map((r) => r.slice(0, 300)).slice(0, REFS_MAX) : [],
  };
}

// Whether a notice is past its time (see the header). now = Date.now().
function expired(n, now) {
  if (n.resolvedAt) return now - n.resolvedAt >= KEEP_MS;
  if (n.kind === 'warn') return false;
  // U4: no read operation anymore, so an info goes 7 days after it was last updated (or read, in old files)
  const since = n.kind === 'proposal' ? (n.answer ? n.answer.at : null) || (n.readAt && !n.answer ? n.readAt : null) : Math.max(n.readAt || 0, n.updatedAt || 0) || null;
  return !!since && now - since >= KEEP_MS;
}

// Duplicate ids keep the first; expired ones dropped; over NOTICES_MAX the oldest resolved / read go first.
function sanitizeNotices(o, now = Date.now()) {
  const list = o && typeof o === 'object' && Array.isArray(o.notices) ? o.notices : [];
  const seen = new Set();
  let out = [];
  for (const raw of list) {
    const n = sanitizeNotice(raw);
    if (!n || seen.has(n.id) || expired(n, now)) continue;
    seen.add(n.id);
    out.push(n);
  }
  while (out.length > NOTICES_MAX) {
    let k = out.findIndex((n) => n.resolvedAt);
    if (k < 0) k = out.findIndex((n) => n.readAt);
    if (k < 0) k = 0;
    out.splice(k, 1);
  }
  return { notices: out };
}

const live = (n) => !n.resolvedAt;

// createNotices(file, { onChange(state, info) }) -> store. info = { type: 'add'|'replace'|'resolve'|'read'|'answer', notice?, fresh? }
// fresh = the notice is new or unread again (the dashboard / widget / desktop notification announce it).
function createNotices(file, { onChange } = {}) {
  let state = { notices: [] };
  try {
    state = sanitizeNotices(JSON.parse(writeq.readTextSync(file).trim()));
  } catch {}

  // perf2 (案 6): the per-file queue of writeq.js (newest wins, tmp + rename, retried while the manager reads it)
  function write() {
    return writeq.write(file, JSON.stringify(state, null, 1));
  }
  const changed = (info) => {
    state = sanitizeNotices(state);
    write();
    try {
      onChange && onChange(state, info);
    } catch (err) {
      console.warn('[notices] onChange failed', err);
    }
  };
  const byKey = (key) => (key ? state.notices.find((n) => live(n) && n.key === key) || null : null);
  const replaceAt = (id, next) => {
    state = { notices: state.notices.map((n) => (n.id === id ? next : n)) };
  };

  return {
    // live notices, newest first
    list: () => state.notices.filter(live).sort((a, b) => b.updatedAt - a.updatedAt),
    all: () => state.notices,
    find: (id) => state.notices.find((n) => n.id === id) || null,
    findKey: byKey,
    // o = { kind, title, text?, folder?, itemId?, key?, source?, refs?, quiet? } -> { notice, replaced, fresh } | null (invalid).
    // A live notice with the same key is replaced in place; it becomes unread again when kind / title / text changed
    // (quiet: true keeps its read state, for app-made notices whose list only shrank).
    add(o) {
      const now = Date.now();
      const prev = byKey(o && typeof o.key === 'string' ? o.key.trim() : null);
      const base = { ...(o || {}), id: prev ? prev.id : newId(), createdAt: prev ? prev.createdAt : now, updatedAt: now, readAt: null, resolvedAt: null, answer: null };
      const n = sanitizeNotice(base);
      if (!n) return null;
      if (prev) {
        const same = prev.kind === n.kind && prev.title === n.title && prev.text === n.text;
        if (same && prev.folder === n.folder && prev.itemId === n.itemId && JSON.stringify(prev.refs) === JSON.stringify(n.refs)) {
          return { notice: prev, replaced: true, fresh: false, unchanged: true };
        }
        const keepRead = same || (o && o.quiet === true);
        const next = {
          ...n,
          announcedAt: prev.announcedAt,
          readAt: keepRead ? prev.readAt : null,
          answer: same && n.kind === 'proposal' ? prev.answer : null,
          updatedAt: keepRead ? prev.updatedAt : now,
        };
        replaceAt(prev.id, next);
        const fresh = !keepRead;
        changed({ type: 'replace', notice: next, fresh });
        return { notice: next, replaced: true, fresh };
      }
      state = { notices: [...state.notices, n] };
      changed({ type: 'add', notice: n, fresh: true });
      return { notice: n, replaced: false, fresh: true };
    },
    // Hides the live notice with this key (resolve: true). -> the notice | null (none live)
    resolve(key) {
      const prev = byKey(key);
      if (!prev) return null;
      const next = { ...prev, resolvedAt: Date.now() };
      replaceAt(prev.id, next);
      changed({ type: 'resolve', notice: next });
      return next;
    },
    // ids: string[] (or 'all') -> number of notices marked read
    read(ids) {
      const now = Date.now();
      const want = ids === 'all' ? null : new Set(Array.isArray(ids) ? ids : []);
      let n = 0;
      state = {
        notices: state.notices.map((x) => {
          if (x.readAt || !live(x) || (want && !want.has(x.id))) return x;
          n++;
          return { ...x, readAt: now };
        }),
      };
      if (n) changed({ type: 'read' });
      return n;
    },
    // The dashboard announced these (desktop notification): announcedAt = updatedAt. -> number changed
    announced(ids) {
      const want = new Set(Array.isArray(ids) ? ids : []);
      let n = 0;
      state = {
        notices: state.notices.map((x) => {
          if (!want.has(x.id) || x.announcedAt === x.updatedAt) return x;
          n++;
          return { ...x, announcedAt: x.updatedAt };
        }),
      };
      if (n) changed({ type: 'announced' });
      return n;
    },
    // A proposal's answer (also marks it read). -> the notice | null (unknown / not a proposal / resolved)
    answer(id, choice, comment) {
      const prev = state.notices.find((x) => x.id === id);
      if (!prev || prev.kind !== 'proposal' || !live(prev) || !CHOICES.has(choice)) return null;
      const now = Date.now();
      const next = { ...prev, readAt: prev.readAt || now, answer: sanitizeAnswer({ choice, comment, at: now }) };
      replaceAt(prev.id, next);
      changed({ type: 'answer', notice: next });
      return next;
    },
    // Drops expired notices (called on a timer; also done on every change). -> true when something went
    prune(now = Date.now()) {
      const before = state.notices.length;
      state = sanitizeNotices(state, now);
      if (state.notices.length === before) return false;
      changed({ type: 'prune' });
      return true;
    },
    state: () => state,
  };
}

// The app's own PMO patrol findings (pmo.findStale) -> one warn notice (key PATROL_KEY), or null when nothing is stale.
// Links each line to its folder / inbox item in the text; the notice itself points at the oldest finding.
const PATROL_KEY = 'app:patrol';
function patrolNotice(findings, ageText) {
  if (!findings || !findings.length) return null;
  const lines = findings.slice(0, 15).map((f) => {
    if (f.kind === 'progress') {
      // PROGRESS.md 確認待ち piling up (roadmap 48): [agent_terminal 確認待ち 14 件・最古 1日] 5b、9、13、…
      const oldest = f.days === null || f.days === undefined ? '' : `・最古 ${f.days}日`;
      return `- [${f.name} 確認待ち ${f.count} 件${oldest}] ${oneLine(f.text, 120)}`;
    }
    const where = f.kind === 'inbox' ? `${Labels.WORDS.inbox} ${Labels.status('inbox', f.status).short}` : `${f.name} ${f.status}`;
    return `- ${where}・${ageText(f.age)}: ${oneLine(f.text, 80)}${f.detail ? `（${oneLine(f.detail, 80)}）` : ''}`;
  });
  if (findings.length > 15) lines.push(`- ほか ${findings.length - 15} 件`);
  const first = findings[0];
  return {
    kind: 'warn',
    title: `放置されている項目が ${findings.length} 件あります`,
    text: lines.join('\n') + '\n\n管理エージェントの見回りにも挙がり、PMO が立て直します。原因が解消すると、この指摘は自動で消えます。',
    folder: first.kind === 'inbox' ? null : first.folder,
    itemId: first.kind === 'inbox' ? first.id : null,
    key: PATROL_KEY,
    source: 'app',
    refs: findings.map((f) => f.key),
  };
}

// What 「あなたの番」 takes from the notices (UIUX U3, src/main/attention.js): proposals not answered yet, oldest first.
// warn (指摘) and info stay out: the PMO repairs what a warn says, and both only go to the record (PMO の記録).
function forAttention(list) {
  return (Array.isArray(list) ? list : [])
    .filter((n) => n && n.kind === 'proposal' && !n.answer && !n.resolvedAt)
    .map((n) => ({ id: n.id, kind: n.kind, title: n.title, text: n.text, folder: n.folder, itemId: n.itemId, createdAt: n.createdAt, updatedAt: n.updatedAt, answer: null, resolvedAt: null }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

// --- 「PMO の記録」 (UIUX U4, docs/concept-uiux.md §2.2): what the PMO and the app did, newest first ----------------------
// forLog(notices, actions, { limit }) -> LogEntry[]
//   notices = every stored notice (store.all(): live and resolved; the file keeps its form, old files read as before)
//   actions = parsed lines of <userData>/logs/pmo-actions.jsonl ({ at: ISO string, type, … }, see main.js pmoLog)
//   LogEntry = { id, at (ms), kind: LOG_KIND key, type (raw action type or 'notice'), title (one line), text, folder, itemId, bad }
//   itemId = the inbox item (notices that point at one; route lines with inboxId) for the dashboard's link
//   kind: push 後押し (answer, nudge, refused ones bad) | route 振り分け (route, create) | order 順番 (reorder) |
//         fix 立て直し (backlog-update, a warn that was resolved) | clean 片付け (dropped by backlog-update, auto clean-up) |
//         done 完了 (done; failed = bad) | release 更新 | handoff 引き継ぎ (app:pmo-handoff:*) | info お知らせ | warn 指摘
// Notices the action log already holds (app:answer: / app:reorder: / app:nudge: / app:backlog-update:, one per
// folder or session replaced by the next) are left out; unanswered proposals belong to あなたの番 (forAttention).
// No read state: the record is a place one need not read (notice.readAt is kept in the file but not used here).
const LOG_FROM_ACTIONS = /^app:(answer|reorder|nudge|backlog-update):/;
const LOG_MAX = 300;
function forLog(notices, actions, { limit = LOG_MAX } = {}) {
  const out = [];
  const base = (f) => (typeof f === 'string' && f ? path.basename(f) || f : '');
  const where = (f) => (base(f) ? `${base(f)} ` : '');
  const task = (a) => [a.no, a.title || oneLine(a.text, 40)].filter(Boolean).join(' ') || a.backlogId || '';
  const bl = (code) => Labels.status('backlog', code).short || String(code || '');
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!a || typeof a !== 'object' || typeof a.type !== 'string') continue;
    const at = Date.parse(a.at);
    if (!Number.isFinite(at)) continue;
    const folder = typeof a.folder === 'string' && a.folder ? a.folder : null;
    const id = 'a' + crypto.createHash('sha1').update(`${a.at}\n${a.type}\n${a.tabKey || ''}\n${a.backlogId || ''}\n${a.promptKey || ''}`).digest('hex').slice(0, 12);
    let e = null;
    switch (a.type) {
      case 'answer':
        e = { kind: 'push', title: `${where(folder)}${oneLine(a.label, 60)} の確認「${oneLine(a.question, 80)}」に「${oneLine(a.option || a.choice, 40)}」`, text: [a.reason, ...(Array.isArray(a.context) ? a.context.slice(-3) : [])].filter(Boolean).join('\n') };
        break;
      case 'answer-refused':
        e = { kind: 'push', bad: true, title: `確認に答えなかった（${oneLine(a.error, 80)}）`, text: oneLine(a.reason, 300) };
        break;
      case 'nudge':
        e = { kind: 'push', title: `${where(folder)}${oneLine(a.label, 60)} に声をかけた: ${oneLine(a.text, 80)}`, text: [a.wait, a.reason].filter(Boolean).join('\n') };
        break;
      case 'nudge-refused':
        e = { kind: 'push', bad: true, title: `声をかけなかった（${oneLine(a.error, 80)}）`, text: oneLine(a.reason, 300) };
        break;
      case 'reorder':
        e = { kind: 'order', title: `${where(folder)}待ちの順番を変えた${a.reason ? `（${oneLine(a.reason, 80)}）` : ''}`, text: Array.isArray(a.order) ? a.order.join(' → ') : '' };
        break;
      case 'route':
      case 'create':
        e = { kind: 'route', title: `${a.type === 'create' ? '新しいフォルダ ' : ''}${where(folder)}${task(a)} に振り分け`, text: oneLine(a.text, 300) };
        break;
      case 'backlog-update':
        e = { kind: a.status === 'dropped' ? 'clean' : 'fix', title: `${where(folder)}${a.no || a.backlogId || ''}: ${bl(a.from)} → ${bl(a.status)}`, text: oneLine(a.note, 300) };
        break;
      case 'done':
      case 'failed':
        e = { kind: 'done', bad: a.type === 'failed', title: `${where(folder)}${task(a)} が${a.type === 'failed' ? '失敗' : '完了'}`, text: oneLine(a.note, 300) };
        break;
      case 'release':
        e = { kind: 'release', bad: a.ok === false, title: a.ok === false ? '新しい版を入れられなかった' : `新しい版を入れた${a.commit ? `（${String(a.commit).slice(0, 7)}）` : ''}`, text: String(a.text || '').slice(-500) };
        break;
      // UIUX U8 (src/main/review.js): the review the app puts on a folder whose work is over, and 「すべて完了」
      case 'review':
        e = { kind: 'route', title: `${where(folder)}作業が全部終わったので見直し（${a.round || 1} 回目）${a.no ? ' ' + a.no : ''} を積んだ`, text: '' };
        break;
      case 'reviewed':
        e = { kind: 'route', title: `${where(folder)}見直し（${a.round || 1} 回目）から次の作業が ${a.count || 0} 件出た`, text: '' };
        break;
      case 'all-done':
        e = { kind: 'done', title: `${where(folder)}${Labels.WORDS.allDone}（見直しで次の作業が出なかった）`, text: '' };
        break;
      case 'all-done-clear':
        e = { kind: 'route', title: `${where(folder)}新しい作業が来たので「${Labels.WORDS.allDone}」を外した`, text: '' };
        break;
      case 'review-stop':
        e = { kind: 'warn', title: `${where(folder)}見直しを続けて ${a.round || 3} 回積んだので、次は積まない（続けるかはユーザーの判断）`, text: '' };
        break;
      case 'review-failed':
        e = { kind: 'done', bad: true, title: `${where(folder)}見直し${a.no ? ' ' + a.no : ''} が終わらなかった（積み直さない）`, text: oneLine(a.note, 300) };
        break;
      default:
        continue; // attention-dismiss (the user's own 「様子を見る」) and unknown types
    }
    out.push({ id, at, type: a.type, folder, itemId: typeof a.inboxId === 'string' ? a.inboxId : null, bad: false, ...e, title: oneLine(e.title, TITLE_MAX) });
  }
  for (const n of Array.isArray(notices) ? notices : []) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string') continue;
    const key = n.key || '';
    if (LOG_FROM_ACTIONS.test(key)) continue;
    const at = n.updatedAt || n.createdAt || 0;
    const common = { type: 'notice', folder: n.folder || null, itemId: n.itemId || null, text: n.text || '', bad: false };
    if (n.kind === 'proposal') {
      if (!n.answer) continue; // still the user's turn
      out.push({ ...common, id: n.id, at: n.answer.at || at, kind: 'info', title: oneLine(`提案「${n.title}」→ ${n.answer.choice === 'go' ? '進める' : '却下'}`, TITLE_MAX) });
      continue;
    }
    if (n.kind === 'warn') {
      out.push({ ...common, id: n.id, at: n.createdAt || at, kind: 'warn', title: n.title });
      if (n.resolvedAt) out.push({ ...common, id: `${n.id}-r`, at: n.resolvedAt, kind: 'fix', title: oneLine(`解けた: ${n.title}`, TITLE_MAX) });
      continue;
    }
    const kind = key.startsWith('app:pmo-handoff') ? 'handoff' : key.startsWith('app:autodrop:') ? 'clean' : 'info';
    out.push({ ...common, id: n.id, at, kind, title: n.title });
  }
  out.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
  return out.slice(0, limit);
}

// Lines of pmo-actions.jsonl (text of its tail) -> parsed entries (bad lines and a cut first line skipped)
function parseActions(text) {
  const out = [];
  for (const l of String(text || '').split('\n')) {
    if (!l.trim()) continue;
    try {
      const o = JSON.parse(l);
      if (o && typeof o === 'object') out.push(o);
    } catch {}
  }
  return out;
}

module.exports = { createNotices, sanitizeNotices, sanitizeNotice, patrolNotice, forAttention, forLog, parseActions, PATROL_KEY, KINDS, TITLE_MAX, TEXT_MAX, KEY_MAX, KEEP_MS };
