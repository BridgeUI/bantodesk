// 「あなたの番」 (UIUX U3, docs/concept-uiux.md §2.1 / §2.2 / §4): the one list of what only the user can decide.
// main builds it from what it already keeps and pushes it to the dashboard (attention:list / attention:changed):
//   confirm   a session's permission dialog the PMO may not press (pmoVerdict below; the reason comes along), a dialog
//             the screen parser could not read, or any dialog of the PMO's own session (it cannot answer itself)
//   question  AskUserQuestion (prompt kind question / multi / menu): the PMO never chooses for the user
//   qa        an unanswered pre-answered QA table (qa.json status open) of a request / task not started yet
//   proposal  an unanswered PMO proposal (notices.json kind proposal, no answer)
//   nudge     a session the PMO nudged NUDGE_LIMIT times that still waits (counted from its nudge actions)
//   pmosend   the PMO's own queue: its auto send stopped (API errors / by hand), or a prompt not sent for 15 min
//             (src/renderer/autosend.js stalls; the PMO cannot tell this itself, it gets nothing). 再開 on the card.
// Each item carries which request / task it is about (task: { no, reqNo, title, text } -> Labels.taskName) and why it is
// the user's (why: { short, full }). Order is fixed (createOrder): oldest first, a new one goes to the end, a gone one
// leaves no gap; a state change does not move an item.
// The answers go through the existing paths: dashboard:answer (promptKey checked), qa:answer, notices:answer.
// PMO 指摘 (warn notices) are not here: the PMO repairs those and they only go to the record (U3 QA 1 / §6 論点 2).
// No Electron imports (testable from plain Node).
const path = require('path');
const stuck = require('./stuck');

const GRACE_MS = 10 * 1000; // a confirm shows after this long (Auto-yes / the PMO get the first go)
const NUDGE_LIMIT = 2; // nudges after which a still waiting session becomes the user's
const NUDGE_SETTLE_MS = 5 * 60 * 1000; // time the session gets to move after the last nudge
const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const mins = (ms) => `${Math.max(1, Math.round(ms / 60000))}分`;

// ---- what the PMO may press (U3 QA 1: network, outside the folder and deleting temporary files are fine) ------------
// stuck.classify is the base rule. Its reasons are tested in a fixed order (組織 → 秘密情報 → 削除 → git → ネットワーク →
// 取り返しのつかない操作 → フォルダの外), so a reason tells which earlier ones did not match. Only the later rules are
// checked again here, with the stuck.js DENY patterns themselves (stuck.RULES; no copies here).
const { GIT_RE, IRREV_RE, DELETE_RE } = stuck.RULES;
// a delete command and its arguments (up to the end of the command)
const DEL_CMD_RE = /(^|[\s;&|(`"'])((?:git\s+)?(?:rm|rmdir|rd|del|erase|Remove-Item|ri|unlink|rimraf))(?=\s)([^\n;&|`)]*)/gi;
// temporary places / files: tmp / temp / scratchpad folders, %TEMP%, AppData\Local\Temp, /tmp, *.tmp / *.temp
const TEMP_RE = /(^|[\\/])(tmp|temp|\.tmp|scratchpad)([\\/]|$)|%te?mp%|\$env:te?mp\b|\$\{?(tmpdir|temp|tmp)\b|AppData[\\/]Local[\\/]Temp([\\/]|$)|^\/tmp(\/|$)|\.(tmp|temp)$/i;
const FLAG_RE = /^(-{1,2}[A-Za-z][\w-]*|\/[A-Za-z])$/; // -rf, --force, -Recurse, /s /q

// text -> the text without its delete commands when every delete in it is a delete command whose every target is a
// temporary file / folder, else null. (The rest is checked for the later rules: "Remove-Item" itself contains "move-Item".)
function tempDeletesRest(text) {
  let found = 0;
  let rest = text;
  let m;
  DEL_CMD_RE.lastIndex = 0;
  while ((m = DEL_CMD_RE.exec(text))) {
    const args = m[3]
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((a) => a.replace(/^["'`]+|["'`,]+$/g, ''))
      .filter((a) => a && !FLAG_RE.test(a) && !/^-(Path|LiteralPath)$/i.test(a));
    if (!args.length) return null;
    if (!args.every((a) => TEMP_RE.test(a) && !/[*?]/.test(a.replace(/\.(tmp|temp)$/i, '')) && !/(^|[\\/])\.\.([\\/]|$)/.test(a))) return null;
    found++;
    rest = rest.replace(m[2] + m[3], ' ');
  }
  // a delete word left over (prose, Clear-Content, truncate …) is not a command we read: not known to be temporary
  return found > 0 && !DELETE_RE.test(rest) ? rest : null;
}
const onlyTempDeletes = (text) => tempDeletesRest(text) !== null;

const textOf = (p) => [...(p.context || []), p.question || '', ...(p.options || []).map((o) => o.label)].join('\n');

// prompt (stuck.promptOf / userList prompt), folder -> { safe, choice, reason } like stuck.classify, with the U3 widening.
// relaxed: the stuck.classify reason that no longer stops the PMO (for the record).
function pmoVerdict(prompt, folder) {
  const v = stuck.classify(prompt, folder);
  if (v.safe || !prompt || prompt.kind !== 'permission') return v;
  const yes = prompt.options.find((o) => /^(yes|はい)\b/i.test(o.label) && !/don.?t ask|always|\ball\b|session|remember|from now|今後|以降|常に|すべて/i.test(o.label));
  if (!yes) return v;
  const ok = { safe: true, choice: yes.n, reason: `ツールの許可・作業を進めるかの確認（その場限りの Yes。${v.reason} は PMO が押してよい）`, relaxed: v.reason };
  const text = textOf(prompt);
  // the folder check comes last in classify: no deny rule matched
  if (/^作業フォルダの外のパス/.test(v.reason)) return ok;
  if (v.reason === 'ネットワークへの送信') {
    if (IRREV_RE.test(text)) return { safe: false, choice: null, reason: '取り返しのつかない操作' };
    return ok;
  }
  if (v.reason === '削除') {
    const rest = tempDeletesRest(text);
    if (rest === null) return v;
    if (GIT_RE.test(rest)) return { safe: false, choice: null, reason: '取り返しのつかない git の操作' };
    if (IRREV_RE.test(rest)) return { safe: false, choice: null, reason: '取り返しのつかない操作' };
    return { ...ok, reason: 'ツールの許可・作業を進めるかの確認（その場限りの Yes。一時ファイルの削除は PMO が押してよい）' };
  }
  return v;
}

// stuck.waitingList entries -> the same entries with pmoVerdict (what sessions.json, the answer action and the stuck
// block use). The entry's prompt is the stuck.promptOf one; folder = the session's working folder.
function relaxWaiting(list) {
  return (list || []).map((e) => {
    if (!e || !e.prompt || e.verdict.safe) return e;
    const v = pmoVerdict(e.prompt, e.folder);
    return v.safe ? { ...e, verdict: v } : e;
  });
}

// ---- the list -----------------------------------------------------------------------------------------------------
const QUESTION_KINDS = new Set(['question', 'multi', 'menu']);
const OPEN_INBOX = new Set(['new', 'asking', 'hold']);
const taskOf = (it) => (it ? { no: str(it.no, 40), reqNo: str(it.reqNo, 40), title: str(it.title, 200), text: str(it.text, 400) } : null);

// o = {
//   now, managerDir,
//   waiting:  stuck.userList(sessionsSnapshot)          (dialogs / errors of every window; only kind 'input' is used)
//   tabs:     Map `${wcId}:${tabId}` -> { backlogId, role } (from sessionsSnapshot)
//   qa:       qa.list()                                 ([{ key, folder, itemId, inboxId, rows, status, createdAt, … }])
//   notices:  notices.list()                            (live notices)
//   inbox:    inbox.get().items
//   task:     (folder, backlogId) -> BacklogItem | null (sync lookup; null = unknown)
//   nudges:   [{ tabKey, wcId, folder, folderName, label, backlogId, count, firstAt, lastAt, waitText }] (still waiting)
//   pmo:      AutoSend.stalls(manager backlog)          ([{ tabId, kind: 'off' | 'slow', since, why, itemId, count }])
//   graceMs, nudgeLimit, nudgeSettleMs }
// -> AttnItem[] (unordered; createOrder().apply gives seq)
function build(o) {
  const now = o.now || Date.now();
  const graceMs = o.graceMs ?? GRACE_MS;
  const limit = o.nudgeLimit ?? NUDGE_LIMIT;
  const settle = o.nudgeSettleMs ?? NUDGE_SETTLE_MS;
  const norm = (p) => (p ? path.resolve(p).toLowerCase() : '');
  const mgr = norm(o.managerDir);
  const inboxById = new Map((o.inbox || []).filter((it) => it && it.id).map((it) => [it.id, it]));
  const taskAt = (folder, id) => {
    if (!folder || !id || !o.task) return null;
    try {
      return o.task(folder, id) || null;
    } catch {
      return null;
    }
  };
  const out = [];

  // dialogs
  for (const e of o.waiting || []) {
    if (!e || e.kind !== 'input') continue;
    const info = (o.tabs && o.tabs.get(`${e.wcId}:${e.tabId}`)) || {};
    const own = info.role === 'manager' || (!!mgr && norm(e.folder) === mgr);
    const p = e.prompt;
    const base = {
      since: e.since,
      folder: own ? null : e.folder || null,
      folderName: own ? 'ダッシュボード' : e.folderName || path.basename(e.folder || '') || '',
      task: own ? null : taskOf(taskAt(e.folder, info.backlogId)),
      label: str(e.label, 200),
      wcId: e.wcId,
      tabId: e.tabId,
      promptKey: p ? p.key : '',
      danger: e.danger || '',
      own,
      entry: e,
    };
    if (!p) {
      // a dialog the screen parser could not read (full-screen, login …): only the user can deal with it
      if (now - e.since < graceMs) continue;
      out.push({ ...base, id: `s:${e.tabId}:screen`, kind: 'confirm', why: { short: '画面の確認', full: '選択肢を画面から読めない確認です。会話を開いて答えてください' } });
      continue;
    }
    if (QUESTION_KINDS.has(p.kind)) {
      const multi = p.kind === 'multi' ? '（複数選べます）' : '';
      out.push({ ...base, id: `s:${e.tabId}:${p.key}:${e.since}`, kind: 'question', why: { short: '質問', full: `セッションがあなたに質問しています${multi}。PMO は代わりに選びません${p.question ? `\n\n${oneLine(p.question, 300)}` : ''}` } });
      continue;
    }
    // a permission / proceed dialog
    let why;
    if (own) why = { short: '確認（PMO）', full: 'PMO 自身のセッションの確認です。PMO は自分の確認に答えられません' };
    else {
      const v = pmoVerdict(p, e.folder);
      if (v.safe) continue; // Auto-yes or the PMO's answer action takes it
      const short = e.danger || (/^作業フォルダの外/.test(v.reason) ? 'フォルダの外' : /画面に収まって/.test(v.reason) ? '読み切れない' : '確認');
      why = { short: short === '確認' ? '確認' : `確認（${oneLine(short.replace(/（.*$/, ''), 20)}）`, full: `PMO は押せません: ${v.reason}` };
    }
    if (now - e.since < graceMs) continue;
    out.push({ ...base, id: `s:${e.tabId}:${p.key}:${e.since}`, kind: 'confirm', why });
  }

  // QA tables not answered, of requests / tasks not started yet
  for (const q of o.qa || []) {
    if (!q || q.status !== 'open' || !Array.isArray(q.rows) || !q.rows.length) continue;
    let task = null;
    let folder = null;
    if (q.folder && q.itemId) {
      const it = taskAt(q.folder, q.itemId);
      if (it && it.status && it.status !== 'pending') continue; // started / finished / dropped: the table is spent
      folder = q.folder;
      task = taskOf(it || (q.inboxId ? inboxById.get(q.inboxId) : null));
    } else if (q.inboxId) {
      const it = inboxById.get(q.inboxId);
      if (it && !OPEN_INBOX.has(it.status)) continue; // routed (moveInbox carries the table) / done / dropped
      folder = it && it.folder ? it.folder : null;
      task = taskOf(it);
    } else continue;
    out.push({
      id: `qa:${q.key}`,
      kind: 'qa',
      since: q.createdAt || q.updatedAt || now,
      folder,
      folderName: folder ? path.basename(folder) : '',
      task,
      label: '',
      why: { short: `QA ${q.rows.length}問`, full: '始める前の質問です。空欄のまま送ると仮説どおりに進みます' },
      qaKey: q.key,
      rows: q.rows.map((r) => ({ topic: str(r.topic, 1000), hypothesis: str(r.hypothesis, 1000), question: str(r.question, 1000), answer: str(r.answer, 1000) })),
    });
  }

  // PMO proposals without an answer
  for (const n of o.notices || []) {
    if (!n || n.kind !== 'proposal' || n.answer || n.resolvedAt) continue;
    const it = n.itemId ? inboxById.get(n.itemId) : null;
    out.push({
      id: `p:${n.id}`,
      kind: 'proposal',
      since: n.createdAt || n.updatedAt || now,
      folder: n.folder || (it && it.folder) || null,
      folderName: n.folder ? path.basename(n.folder) : it && it.folder ? path.basename(it.folder) : '',
      task: taskOf(it),
      label: '',
      why: { short: '提案', full: `PMO の提案です。進めるか却下かを決めてください\n\n${oneLine(n.title, 200)}` },
      noticeId: n.id,
      title: str(n.title, 200),
      text: str(n.text, 8000),
    });
  }

  // sessions the PMO nudged NUDGE_LIMIT times that still wait
  for (const g of o.nudges || []) {
    if (!g || g.count < limit || now - g.lastAt < settle) continue;
    out.push({
      id: `n:${g.tabKey}`,
      kind: 'nudge',
      since: g.lastAt,
      folder: g.folder || null,
      folderName: g.folderName || (g.folder ? path.basename(g.folder) : ''),
      task: taskOf(taskAt(g.folder, g.backlogId)),
      label: str(g.label, 200),
      why: { short: `止まって ${mins(now - g.firstAt)}`, full: `PMO が ${g.count} 回後押ししても動きません${g.waitText ? `（${oneLine(g.waitText, 200)}）` : ''}。会話を開いて確かめてください` },
      wcId: g.wcId,
      tabId: g.tabKey,
      tabKey: g.tabKey,
      count: g.count,
      waitText: str(g.waitText, 300),
    });
  }

  // the PMO's own queue
  for (const s of o.pmo || []) {
    if (!s || (s.kind !== 'off' && s.kind !== 'slow')) continue;
    const off = s.kind === 'off';
    const why = oneLine(s.why, 200);
    const title = off ? `PMO への自動送信が止まっています（${why}）` : `PMO への知らせが ${mins(now - (s.since || now))} 送られていません（${why}）`;
    out.push({
      id: `pmo:${s.tabId || '-'}:${s.kind}`,
      kind: 'pmosend',
      since: s.since || now,
      folder: null,
      folderName: 'ダッシュボード',
      task: null,
      label: 'PMO',
      own: true,
      tabId: s.tabId || null,
      off,
      count: s.count || 0,
      title,
      why: {
        short: off ? '自動送信の停止' : '送られていない',
        full: `${title}。依頼（inbox.json）の確認を PMO に送れていないので、新しい依頼が振り分けられません${s.tabId ? '。「再開」で送ります' : ''}`,
      },
    });
  }
  return out;
}

// Fixed order: ids get a sequence number the first time they are seen (a batch in `since` order), kept while present.
function createOrder() {
  const seqOf = new Map();
  let next = 1;
  return {
    apply(items) {
      const live = new Set(items.map((i) => i.id));
      for (const id of [...seqOf.keys()]) if (!live.has(id)) seqOf.delete(id);
      const fresh = items.filter((i) => !seqOf.has(i.id)).sort((a, b) => (a.since || 0) - (b.since || 0) || String(a.id).localeCompare(String(b.id)));
      for (const i of fresh) seqOf.set(i.id, next++);
      return items.map((i) => ({ ...i, seq: seqOf.get(i.id) })).sort((a, b) => a.seq - b.seq);
    },
    has: (id) => seqOf.has(id),
  };
}

// The PMO's nudges per tab (nudge action + the waits each check sees). -> tracker
//   nudged(e)        a nudge was sent to waits entry e ({ tabKey, wcId, folder, folderName, label, backlogId, wait })
//   seen(entries)    every waits check: a tab that no longer waits (no alerts / gone / running) starts over
//   list()           [{ tabKey, …, count, firstAt, lastAt, waitText }]
//   dismiss(tabKey)  the user's 「様子を見る」: counted again from 0
//   load(lines)      pmo-actions.jsonl entries ({ at, type: 'nudge', tabKey, … }) of the last `withinMs` (app restart)
function createNudges({ withinMs = 6 * 60 * 60 * 1000, resetMs = 10 * 60 * 1000 } = {}) {
  const byTab = new Map();
  const put = (e, at) => {
    const prev = byTab.get(e.tabKey);
    byTab.set(e.tabKey, {
      tabKey: e.tabKey,
      wcId: e.wcId ?? (prev && prev.wcId),
      folder: e.folder || (prev && prev.folder) || '',
      folderName: e.folderName || (prev && prev.folderName) || '',
      label: e.label || (prev && prev.label) || '',
      backlogId: e.backlogId || (prev && prev.backlogId) || null,
      count: (prev ? prev.count : 0) + 1,
      firstAt: prev ? prev.firstAt : at,
      lastAt: at,
      noWaitSince: 0,
      waitText: (e.wait && e.wait.text) || e.waitText || (prev && prev.waitText) || '',
    });
  };
  return {
    nudged(e, at = Date.now()) {
      if (e && typeof e.tabKey === 'string' && e.tabKey) put(e, at);
    },
    // A nudged session runs for a while (reads the message) and may wait again: only a tab that is gone, or that has
    // not waited for resetMs, starts over.
    seen(entries, now = Date.now()) {
      const live = new Map();
      for (const e of entries || []) if (e && typeof e.tabKey === 'string') live.set(e.tabKey, e);
      for (const [k, g] of byTab) {
        const e = live.get(k);
        if (!e) {
          byTab.delete(k);
          continue;
        }
        const waiting = !!(e.wait && e.wait.kind !== 'user');
        const noWaitSince = waiting ? 0 : g.noWaitSince || now;
        if (!waiting && now - noWaitSince >= resetMs) {
          byTab.delete(k);
          continue;
        }
        byTab.set(k, { ...g, noWaitSince, wcId: e.wcId, waitText: (waiting && e.wait.text) || g.waitText, label: e.label || g.label, backlogId: e.backlogId || g.backlogId });
      }
    },
    // the tabs waiting right now
    list: () => [...byTab.values()].filter((g) => !g.noWaitSince),
    dismiss: (tabKey) => byTab.delete(tabKey),
    load(lines, now = Date.now()) {
      for (const l of lines || []) {
        const at = l && Date.parse(l.at);
        if (!l || l.type !== 'nudge' || !Number.isFinite(at) || now - at > withinMs) continue;
        put({ tabKey: l.tabKey, folder: l.folder, label: l.label, waitText: l.wait }, at);
      }
    },
  };
}

// What is sent to the dashboard / compared for a change: the waiting time grows every tick, so it is left out.
const signature = (items) => JSON.stringify(items.map(({ entry, ...i }) => [i, entry ? { ...entry, waitedMs: 0 } : null]));

module.exports = { build, createOrder, createNudges, pmoVerdict, relaxWaiting, onlyTempDeletes, signature, GRACE_MS, NUDGE_LIMIT, NUDGE_SETTLE_MS, _re: { GIT_RE, IRREV_RE, DELETE_RE, TEMP_RE } };
