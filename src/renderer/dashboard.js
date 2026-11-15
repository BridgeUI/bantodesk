'use strict';
// Integrated dashboard page (roadmap 20, docs/plan-dashboard.md). Owner: core.
// Shown in the manager window (app:info role 'manager', body.dash-mode) as a full page; the manager
// agent's own session sits in a narrow column on the right (the normal dock).
//
// Layout: a header with the totals and the inbox input, the open inbox items, then one row per folder:
//   フォルダ (name, open / closed, last activity) | セッション (each with its status; a question is
//   answered on あなたの番) | キュー (the folder's backlog: running, waiting in order, failed; done count).
// Data: recent folders (picker:list) + every window's sessions (dashboard:sessions, from main's widget
// module) + each folder's backlog (backlog:getFolder) + the inbox (inbox:get) + the pre-answered QA
// (qa:list / qa:changed; answered here with qa:answer).
//
// window.Dashboard: init({ api, exclude, root, own?, restart? }), refresh(), renderOwn()
// Session memory (roadmap 22): each session line shows its memory (TabState.memMb via dashboard:sessions);
// over the mark it offers 再起動 (dashboard:restart). The manager agent's own session is in the header.
//
// UIUX U2: 4 tabs あなたの番 / プロジェクト / 依頼 / PMO の記録 under a top band (動いている N / 上限 M, PMO, スマホ, ⚙) and
// the request box. Words come from labels.js (index.html loads it first; docs/ui-copy.md): short state words, the full
// reason in the tooltip.
//
// UIUX U3: あなたの番 is main's attention list (attention:list / attention:changed, docs/concept-uiux.md §2.2 §4):
// one card per item in seq order (確認 the PMO may not press, AskUserQuestion, unanswered QA, unanswered proposals,
// sessions that did not move after two nudges). Answered through the existing parts (dashboard:answer, qa:answer,
// notices:answer, attention:dismiss). 指摘 (warn) go to PMO の記録 only.
//
// UIUX U4: PMO の記録 is main's merged log (pmo:log / pmo:logChanged: logs/pmo-actions.jsonl, info and warn notices live and
// resolved, the patrol, answered proposals; newest first): one row per entry (time | kind | folder + one-line title, a click
// unfolds the detail), kind chips to filter (dashLogKinds), the folder / text filters apply. Without pmoLog (older main) the
// notices stand in. No read / unread any more (no 既読, no count on the tab, notices:read is never called) and no desktop
// notification from here: main's attention raises it when あなたの番 grows. ⚙ opens the settings modal (settings.js,
// window.Settings) where this page registers its own section ('dashboard'); the old inline panel only when it is missing.
// The update bar is hidden unless the setting showUpdateBar is on (or while restarting): the release is in the record.
// Top text: short words, the explanations in tooltips (docs/ui-copy.md).
(() => {
  let api = null;
  let root = null;
  let exclude = '';
  let inbox = [];
  let sessions = []; // WidgetState.sessions
  let folders = []; // [{ folder, open, backlog: BacklogItem[] }]
  // queue order (docs/queue-order.md, main's queue:order = src/main/queueorder.js): { limit, running, free, hold, next,
  // line, folders: [{ folder, items, tabbed, lastReorder, orderLock }] }; the cards draw their waiting tasks from it
  let queue = null;
  const qAsk = new Map(); // key(folder) -> draft of 「PMO に順番を見直してもらう」 (open while present)
  const qNotes = new Map(); // key(folder) -> { text, bad, until }
  let workRoot = ''; // setting "新しい作業の置き場所" (dashboard:workRoot)
  // 新しいセッション (UIUX U5; the picker window's parts): opened by the band's button / the tray (dashboard:newSession), and
  // drawn large on top of the tab while no session is open (the user may close that one). startList = picker:list.
  let startOpen = false;
  let sessionsSeen = false; // the first session list came (no large panel before it: it would flash at start-up)
  let startClosed = false;
  let startList = { recent: [], open: [], kept: [] };
  let startName = ''; // 新しい作業: the folder name typed so far (render() replaces the box)
  let startNote = { text: '', bad: false };
  // the tray's 「新しいセッション…」 / a project window's folder button (picker:show) -> the panel open. Registered when this
  // script loads (the message may come before init, while the window restores); drawn by init's first render then.
  try {
    window.api?.onDashboardNewSession?.(() => {
      startOpen = true;
      startClosed = false;
      if (!api || !root) return;
      loadFolders().then(renderSoon).catch(() => {});
      render();
      root.querySelector('.dbx-start')?.scrollIntoView?.({ block: 'nearest' });
    });
  } catch {}
  let modelCfg = null; // AT-6: { session: { model, effort }, pmo: { model, effort }, efforts, builtin } (models:get)
  let modelErr = '';
  // core hooks for the manager agent's own session: own() -> { memMb, heavy, status } | null, restart()
  let ownHooks = {};
  let stale = []; // PMO findings (dashboard:stale): [{ kind, id, status, folder, since }] -> quiet "放置 N日" marks
  // Pre-answered QA (qa:list, src/main/qa.js): [{ key, folder, itemId, inboxId, rows, status, … }]. A pending
  // backlog item / an inbox item not routed yet with an entry gets a "QA 3問" mark; clicking it opens the table
  // under the row. Open tables and typed answers live here (render() replaces the DOM on every session update).
  let qaEntries = [];
  const qaOpen = new Set(); // entry keys
  const qaDrafts = new Map(); // entry key -> { sig, answers: string[] }
  const qaNotes = new Map(); // entry key -> short note under the table ("保存しました", errors)
  // 「PMO から」 notices (notices:list / notices:changed, src/main/notices.js): the proposals are answered on あなたの番;
  // without pmo:log (older main) the notices are also what PMO の記録 shows.
  let notices = [];
  const noticeDrafts = new Map(); // proposal id -> comment typed so far (render() replaces the box)
  const noticeNotes = new Map(); // proposal id -> error note
  // PMO の記録 (U4): LogEntry[] from main (pmoLog / onPmoLogChanged), newest first; null = not given (fall back to notices)
  let pmoLog = null;
  const logOpen = new Set(); // entry ids unfolded
  let logShowAll = false;
  let logKinds = new Set(); // kinds chosen on PMO の記録 ([] = すべて); read from 'dashLogKinds' once store is there
  const INBOX_JA = { new: '受付', asking: '質問中', hold: '保留', routed: '振り分け済み', done: '完了', failed: '失敗', dropped: '取り下げ' };
  const HISTORY_JA = { add: '追加', edit: '書き直し', merge: '統合', link: '結び付け' };
  // あなたの番 (U3): main's attention list (api.attentionList / onAttentionChanged). AttnItem: { id, kind confirm |
  // question | qa | proposal | nudge, seq, since, folder, folderName, task, label, why: { short, full }, … }; drawn in
  // seq order. A confirm / question carries its WaitEntry (stuck.js userList: dialog, context, multi-select boxes,
  // screen tail); answers go through dashboard:answer, which presses only while the same dialog (promptKey) is on that
  // session's screen. The widget's 確認待ち count opens this tab (openWaiting).
  let attn = []; // AttnItem[] (seq ascending)
  const attnSent = new Map(); // item id -> at (answered here: hidden until main drops it, or 20 s passed)
  const waitOpen = () => tab === 'turn';
  // sched:state (src/main/sched.js): { limit, resources: { freeMB, cpuPct, lagMs, over }, running, waiting: { [folder]: { [id]: { code, text } } } }
  let sched = null;
  // proc:leftovers (src/main/leftovers.js, 51c): { mode, count, mb, suspended, tasklist, ended, stoppedTotal }
  let leftover = null;
  const LEFTOVER_MODES = { ended: '終わったセッションの分を止める（既定）', all: 'すべて止める（動いているセッションの分も）', off: '数えるだけ（止めない）' };
  // update hold after a release (app:update, src/main/autorestart.js): { state, force, busy, blocked, deadline }
  let update = { state: 'none' };
  const waitDrafts = new Map(); // `${tabId}:${promptKey}` -> { want: Set<n>, text } (multi-select boxes, free text)
  const waitCtxOpen = new Set(); // entry keys whose context (screen lines above the dialog) is unfolded
  const waitNotes = new Map(); // entry key or tabId -> { text, bad } (「質問が変わりました」, errors)
  const waitSent = new Map(); // sentKey(entry) -> at (answered: hidden until the dialog is gone from the list, ≤ 20 s)
  let waitDone = []; // [{ at, wcId, tabId, folderName, label, question, answer }] answered here (newest first, ≤ 5)
  let waitBusy = false;
  // What an idle session waits for (WidgetState session.wait, main's waits.js): a line under the session, and
  // 「出力」 opens the tail of its commands' output (wait:tail) under it. Open ones live here (render() rebuilds).
  const tailOpen = new Set(); // `${wcId}:${tabId}`
  const tails = new Map(); // `${wcId}:${tabId}:${commandId}` -> { loading, res: { file, text, size, mtime } | { error } }
  // setting 「待ちの見張り」 (wait:settings): { silentMin, longMin }; typed values not committed yet survive a redraw
  let waitCfg = null;
  const waitCfgDraft = {};
  const waitCfgNote = { text: '', bad: false };
  // ---- page tabs (UIUX U2, docs/concept-uiux.md §2.2, docs/plan-dashboard.md) ------------------------------
  // 'turn' あなたの番 (main's attention list, U3) | 'proj' プロジェクト (folder cards; 関係図 = agents-view.js
  // as a switch inside) | 'req' 依頼 (inbox: 対応中 / 対応履歴) | 'log' PMO の記録 (「PMO から」 notices). Only the shown tab is
  // drawn. Remembered; at start-up the tab is あなたの番 when it has anything, else the last one (あなたの番 -> プロジェクト).
  const TABS = ['turn', 'proj', 'req', 'log'];
  const USAGE_TAB = { turn: 'turn', proj: 'projects', req: 'requests', log: 'log' }; // UA1 ids (src/main/usage-ids.js)
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    },
  };
  // older builds kept 'dashView' = 'main' | 'agents' (a raw string): the 関係図 becomes the プロジェクト tab's switch, once
  let oldView = null;
  try {
    oldView = localStorage.getItem('dashView');
    if (oldView != null) localStorage.removeItem('dashView');
  } catch {}
  logKinds = new Set((store.get('dashLogKinds', []) || []).filter((x) => typeof x === 'string'));
  let tab = TABS.includes(store.get('dashTab', '')) ? store.get('dashTab', '') : 'proj';
  let tabChosen = false; // the start-up rule ran (after the first data load)
  let projMode = store.get('dashProjMode', oldView === 'agents' ? 'agents' : 'cards') === 'agents' ? 'agents' : 'cards';
  if (oldView === 'agents') {
    tab = 'proj';
    store.set('dashProjMode', 'agents');
  }
  // the 'view' of older code: the folder rows' data signature still asks for agents fields on the 関係図
  const agentsShown = () => tab === 'proj' && projMode === 'agents' && !!window.AgentsView;
  // folder filter (all tabs): keys of the chosen folders; [] = すべて. NOFOLDER = requests / notices without a folder.
  const NOFOLDER = '-';
  let folderSel = new Set((store.get('dashFolders', []) || []).filter((x) => typeof x === 'string'));
  // fixed order of the folders: the user's (drag on a card), else first seen; new ones go to the end
  let folderOrder = (store.get('dashFolderOrder', []) || []).filter((x) => typeof x === 'string');
  // 依頼 tab: 'open' 対応中 | 'hist' 対応履歴, text filter, folded status groups, 「過去 N 件」 opened
  let reqView = store.get('dashReqView', 'open') === 'hist' ? 'hist' : 'open';
  let textFilter = '';
  const groupOpen = store.get('dashGroups', {}) || {};
  const GROUP_DEFAULT = { 'g-unrouted': true, 'g-asking': true, 'g-routed': true, 'g-hold': false, 'g-done': true, 'g-failed': true, 'g-dropped': false };
  // UX7 (docs/ux-journey.md §5.5.5・§6, docs/mac-polish.md J3): long lists show a first part, the rest behind 「ほか N 件」
  // that opens REQ_STEP more per click; what was opened stays through redraws (these maps are in the signature)
  const groupMore = new Map(); // group id -> rows shown past GROUP_SHOWN
  const GROUP_SHOWN = 8;
  const REQ_STEP = 50;
  const RECENT_DAYS = 7;
  let pastOpen = false;
  // 「過去 N 件」 folded by date: 'month' (7-30 days ago) and 'older', both folded at first (an open 50 rows put the tab
  // over 600 elements, perf big); each REQ_STEP rows at a time
  const PAST_FOLDS = [['month', '30 日以内', 30], ['older', 'それより前', Infinity]];
  const pastFold = { month: false, older: false };
  const pastMore = new Map(); // fold id -> rows shown past REQ_STEP
  let revealId = ''; // goTo: the request whose row must be within the shown part of its group
  // プロジェクト cards: CARD_SHOWN rows per state, 「ほか N 件」 opens CARD_STEP more; key `${folderKey}|${state}` -> extra
  const CARD_SHOWN = 5;
  const CARD_STEP = 20;
  const cardMore = new Map();
  // PMO の記録: runs of automatic rows (振り分け・順番) as one row; open ones by the run's oldest entry id
  const LOG_AUTO = new Set(['route', 'order']);
  const LOG_RUN_MIN = 3;
  const LOG_RUN_GAP = 30 * 60e3;
  const logRunOpen = new Set();
  let reqMenu = ''; // inbox id whose row menu (⋯) is open
  let remote = null; // remote:getStatus { running, … }

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }
  // ---- UX6 (docs/ux-journey.md §5.5, docs/mac-polish.md J1・J7・J8): draw only what changed ------------------------
  // render() still builds the page from the state, but puts it in by patch(): an element equal to the one on the page
  // (isEqualNode) keeps the one on the page (its hover, text selection, open menu, caret and listeners stay); a different
  // one is swapped in whole. Only a container marked with P() (data-patch) is opened and its children matched by key
  // (data-k, else data-id / data-folder / data-group, else their place) — so a session's state change swaps that one
  // row. P() is only for elements whose listeners need nothing but themselves and the state (the old element's
  // listeners stay), and whose children do not hold each other in closures (a child swapped alone must still work).
  const stats = { renders: 0, refreshes: 0, snapshots: 0, folderLoads: 0, replaced: 0, removed: 0, skipped: 0 };
  const P = (el, k) => {
    el.setAttribute('data-patch', '');
    if (k != null && k !== '') el.dataset.k = String(k);
    return el;
  };
  const kOf = (n) => (n.nodeType === 1 ? n.dataset.k || n.dataset.id || n.dataset.folder || n.dataset.group || '' : '');
  function syncAttrs(o, n) {
    for (const a of [...o.attributes]) if (!n.hasAttribute(a.name)) o.removeAttribute(a.name);
    for (const a of [...n.attributes]) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
  }
  // -> the node to keep in o's place: o itself (equal, or patched in place) or n
  function reconcile(o, n) {
    if (!o || o.nodeType !== n.nodeType || o.nodeName !== n.nodeName) return n;
    if (o.nodeType === 3 || o.nodeType === 8) {
      if (o.data !== n.data) o.data = n.data;
      return o;
    }
    if (o.nodeType !== 1) return n;
    if (o.isEqualNode(n)) return o;
    if (!o.hasAttribute('data-patch') || !n.hasAttribute('data-patch')) return n;
    syncAttrs(o, n);
    patchKids(o, n);
    return o;
  }
  // o's children become n's: matched by key (or place), kept / patched / swapped; o's other children go
  function patchKids(o, n) {
    const olds = [...o.childNodes];
    const keyed = new Map();
    for (const c of olds) {
      const k = kOf(c);
      if (k && !keyed.has(k)) keyed.set(k, c);
    }
    const used = new Set();
    const out = [];
    let cur = 0;
    for (const c of [...n.childNodes]) {
      const k = kOf(c);
      let cand = null;
      if (k) {
        cand = keyed.get(k) || null;
        if (cand && (used.has(cand) || cand.nodeName !== c.nodeName)) cand = null;
      } else {
        while (cur < olds.length && (used.has(olds[cur]) || kOf(olds[cur]))) cur++;
        if (cur < olds.length && olds[cur].nodeName === c.nodeName) cand = olds[cur++];
      }
      const r = cand ? reconcile(cand, c) : c;
      if (cand && r === cand) used.add(cand);
      out.push(r);
    }
    for (const c of olds) {
      if (used.has(c)) continue;
      c.remove();
      if (c.nodeType === 1) stats.removed++;
    }
    let ref = o.firstChild;
    for (const r of out) {
      if (r === ref) {
        ref = ref.nextSibling;
        continue;
      }
      o.insertBefore(r, ref);
      if (!used.has(r) && r.nodeType === 1) stats.replaced++;
    }
  }
  // the parts of the page that only move with the clock: 「N分前」「N分待ち」「止まって N時間」 are spans with data-ago (the
  // time) and data-fmt; one timer puts their words right every 30 s (and render() before it compares), nothing redraws
  const AGO_FMT = {
    rel: (ts) => rel(ts),
    wait: (ts) => `${Date.now() - ts < 60e3 ? '1分未満' : ago(ts)}待ち`,
    stale: (ts) => `${W('stalled', '止まって')} ${ago(ts)}`,
  };
  function agoSpan(el, ts, fmt = 'rel') {
    if (!ts) return el;
    el.dataset.ago = String(ts);
    el.dataset.fmt = fmt;
    el.textContent = (AGO_FMT[fmt] || AGO_FMT.rel)(ts);
    return el;
  }
  function tickAgo(scope) {
    if (!scope) return;
    for (const el of scope.querySelectorAll('[data-ago]')) {
      const f = AGO_FMT[el.dataset.fmt] || AGO_FMT.rel;
      const t = f(Number(el.dataset.ago));
      if (el.textContent !== t) el.textContent = t;
    }
  }
  // J8: the Markdown of the notices / PMO の記録 (marked + DOMPurify) by its text, once
  const mdCache = new Map();
  const MD_KEEP = 300;
  // J7: the big sources are compared by their version (bumped when new data came), not by their JSON on every redraw
  const ver = { inbox: 0, folders: 0, folderNames: 0, notices: 0, qa: 0, log: 0, queue: 0 };
  const key = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
  const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
  function rel(ts) {
    if (!ts) return '';
    const d = Date.now() - ts;
    if (d < 60e3) return 'たった今';
    if (d < 3600e3) return `${Math.floor(d / 60e3)}分前`;
    if (d < 86400e3) return `${Math.floor(d / 3600e3)}時間前`;
    return new Date(ts).toLocaleDateString('ja-JP');
  }
  const firstLine = (t) => String(t || '').split(/\r?\n/).find((l) => l.trim()) || '';
  // the words table (labels.js); the fallbacks are the same words, for a page that could not load it
  const L = () => window.Labels || null;
  const W = (k, d) => (L() && L().WORDS && L().WORDS[k]) || d;
  // a session's state words (UX5: the word table's, not the old 確認待ち / 実行中)
  const SESSION_JA = { running: W('running', '動作中'), asking: W('yourTurn', '要対応'), idle: '待機中', starting: '起動中', exited: '終了' };
  const ATTN_JA = { input: W('yourTurn', '要対応'), error: W('error', 'エラー'), done: W('done', '完了') };
  const stWord = (kind, code, d) => {
    const s = L() && L().status ? L().status(kind, code) : null;
    return { short: (s && s.short) || d || String(code || ''), full: (s && s.full) || '' };
  };
  const taskName = (it) => (L() && L().taskName ? L().taskName(it) : firstLine(it && (it.title || it.text)).slice(0, 40));
  const taskNo = (it) => (L() && L().taskNo ? L().taskNo(it) : (it && (it.no || it.reqNo)) || '');
  const taskTitle = (it) => (L() && L().taskTitle ? L().taskTitle(it, 40) : firstLine(it && (it.title || it.text)).slice(0, 40));
  const ago = (ts) => {
    const d = Math.max(0, Date.now() - (ts || Date.now()));
    return d >= 86400e3 ? `${Math.floor(d / 86400e3)}日` : d >= 3600e3 ? `${Math.floor(d / 3600e3)}時間` : `${Math.max(1, Math.floor(d / 60e3))}分`;
  };
  const md = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  // Stale marks (same rules as the PMO patrol, src/main/pmo.js). Only on the rows; no count in the header.
  function staleOf(kind, id, folder) {
    return stale.find((f) => f.kind === kind && f.id === id && (kind === 'inbox' || key(f.folder) === key(folder))) || null;
  }
  function staleMark(f) {
    const d = Math.max(0, Date.now() - (f.since || Date.now()));
    const age = d >= 86400e3 ? `${Math.floor(d / 86400e3)}日` : d >= 3600e3 ? `${Math.floor(d / 3600e3)}時間` : `${Math.max(1, Math.floor(d / 60e3))}分`;
    const el = agoSpan(h('span', 'dbx-stale', `${W('stalled', '止まって')} ${age}`), f.since, 'stale');
    el.title = `${f.status} のまま。PMO の 1 日 1 回の棚卸しでも挙がります`;
    return el;
  }

  // ---- pre-answered QA -----------------------------------------------------------------------
  const qaForBacklog = (folder, id) => qaEntries.find((e) => e.itemId === id && e.folder && key(e.folder) === key(folder)) || null;
  const qaForInbox = (id) => qaEntries.find((e) => e.inboxId === id && !e.folder) || null;
  const qaSig = (e) => e.rows.map((r) => `${r.topic}\u0000${r.question}`).join('\u0001');
  function qaDraft(e) {
    let d = qaDrafts.get(e.key);
    if (!d || d.sig !== qaSig(e)) {
      d = { sig: qaSig(e), answers: e.rows.map((r) => r.answer || '') };
      qaDrafts.set(e.key, d);
    }
    return d;
  }

  function qaMark(e) {
    const open = e.status !== 'answered';
    const b = h('button', `dbx-qamark ${open ? 'open' : 'answered'}${qaOpen.has(e.key) ? ' on' : ''}`, open ? `QA ${e.rows.length}問` : 'QA 回答済み');
    b.type = 'button';
    b.title = open
      ? 'PMO が用意した事前の確認です。先に答えておくと、作業が始まったときに止まらずに進みます'
      : '回答済み。作業を始めるときに回答が指示に添えられます（クリックで見直し）';
    b.addEventListener('click', () => {
      if (qaOpen.has(e.key)) qaOpen.delete(e.key);
      else qaOpen.add(e.key);
      render();
      if (qaOpen.has(e.key)) root.querySelector(`.dbx-qa-input[data-key="${CSS.escape(e.key)}"]`)?.focus();
    });
    return b;
  }

  // The inline table: 論点 / 仮説 / 質問 / 回答 (text box, blank = 仮説どおり), 保存 / 閉じる.
  // inCard: on an あなたの番 card (always open there: no 閉じる)
  function qaPanel(e, title, inCard = false) {
    const d = qaDraft(e);
    const p = h('div', 'dbx-qa');
    const head = h('div', 'dbx-qa-head');
    const tt = h('span', 'dbx-qa-title', title);
    tt.title = '空欄は仮説どおり。答えておくと、作業の開始時に指示へ添えられます'; // U4: in the tooltip, not on the card
    head.append(tt);
    p.append(head);
    const table = h('table', 'dbx-qa-table');
    const tr0 = h('tr');
    for (const t of ['論点', '仮説', '質問', '回答']) tr0.append(h('th', '', t));
    const thead = h('thead');
    thead.append(tr0);
    const tbody = h('tbody');
    const save = h('button', 'dbx-qa-save', '保存');
    e.rows.forEach((r, i) => {
      const tr = h('tr');
      tr.append(h('td', 'dbx-qa-topic', r.topic), h('td', 'dbx-qa-hyp', r.hypothesis), h('td', 'dbx-qa-q', r.question));
      const td = h('td', 'dbx-qa-ans');
      const box = h('textarea', 'dbx-qa-input');
      box.rows = 1;
      box.dataset.key = e.key;
      box.dataset.i = String(i);
      box.placeholder = '仮説どおり';
      box.value = d.answers[i] || '';
      box.addEventListener('input', () => {
        d.answers[i] = box.value;
        qaNotes.delete(e.key);
      });
      box.addEventListener('compositionend', () => {
        d.answers[i] = box.value;
      });
      box.addEventListener('keydown', (ev) => {
        if (ev.isComposing || ev.keyCode === 229) return;
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          save.click();
        }
      });
      td.append(box);
      tr.append(td);
      tbody.append(tr);
    });
    table.append(thead, tbody);
    p.append(table);
    const bar = h('div', 'dbx-qa-bar');
    save.type = 'button';
    save.title = `${window.Labels.key('mod+Enter')}（どの回答欄からでも）`;
    save.addEventListener('click', async () => {
      let res = null;
      try {
        res = await api.qaAnswer?.({ key: e.key, answers: d.answers.map((a) => String(a || '')) });
      } catch (err) {
        console.error(err);
      }
      if (res) {
        qaDrafts.delete(e.key);
        qaOpen.delete(e.key);
        qaNotes.delete(e.key);
        setQa(qaEntries.map((x) => (x.key === e.key ? { ...res, key: e.key } : x)));
        unsig('qa');
      } else qaNotes.set(e.key, '保存できませんでした');
      render();
    });
    const close = h('button', 'dbx-link dim', '閉じる');
    close.type = 'button';
    close.addEventListener('click', () => {
      qaOpen.delete(e.key);
      render();
    });
    bar.append(save);
    if (!inCard) bar.append(close);
    if (qaNotes.has(e.key)) bar.append(h('span', 'dbx-qa-note', qaNotes.get(e.key)));
    p.append(bar);
    return p;
  }

  // session -> 'input' | 'error' | 'busy' | 'done' | 'idle' | 'fin' | 'rest' | 'off'
  // fin = 完了: its routed item ended with 作業完了 and the app stopped its claude (TabState.rest 'done', PROGRESS 35);
  // rest = 休止中 (rest 'idle', 31). Neither is 待機中, and neither counts as a session.
  // finished = ended with 作業完了 while its claude still runs (PROGRESS 50): 完了 too, not エラー / 待機中.
  function kindOf(s) {
    if (s.attention === 'input') return s.attention;
    if (s.finished && s.rest !== 'idle') return 'fin';
    if (s.attention === 'error') return s.attention;
    if (s.rest === 'done') return 'fin';
    if (s.rest === 'idle') return 'rest';
    if (s.status === 'running' || s.status === 'starting') return 'busy';
    if (s.attention === 'done') return 'done';
    if (s.status === 'exited') return 'off';
    return 'idle';
  }
  const RANK = { input: 0, error: 1, busy: 2, done: 3, idle: 4, rest: 5, fin: 6, off: 7 };
  const REST_JA = { fin: '完了', rest: '休止中' };

  // ---- model ---------------------------------------------------------------------------------
  function rows() {
    const byKey = new Map();
    const add = (folder) => {
      const k = key(folder);
      if (!k || k === key(exclude)) return null;
      if (!byKey.has(k)) byKey.set(k, { folder, open: false, backlog: [], sessions: [], order: byKey.size });
      return byKey.get(k);
    };
    for (const f of folders) {
      const r = add(f.folder);
      if (r) Object.assign(r, { open: f.open, backlog: f.backlog, progress: f.progress || null, outlook: f.outlook || '', review: f.review || null });
    }
    for (const s of sessions) {
      const r = add(s.folder);
      if (r) {
        r.sessions.push({ ...s, kind: kindOf(s) });
        r.open = true;
      }
    }
    const out = [...byKey.values()];
    for (const r of out) {
      r.sessions.sort(bySeen); // fixed: a state change moves no row (U2)
      const b = r.backlog;
      r.active = b.filter((i) => i.status === 'active');
      r.pending = b.filter((i) => i.status === 'pending');
      r.failed = b.filter((i) => i.status === 'failed');
      r.done = b.filter((i) => i.status === 'done');
      const first = [...r.sessions].sort((a, b) => RANK[a.kind] - RANK[b.kind])[0];
      r.kind = first ? first.kind : r.failed.length ? 'error' : 'off';
      if (r.kind === 'fin' || r.kind === 'rest') r.kind = r.failed.length ? 'error' : 'idle'; // only stopped sessions left
      if (r.kind !== 'input' && r.kind !== 'error' && r.active.length) r.kind = 'busy';
      r.last = Math.max(0, ...r.sessions.map((s) => s.at || 0), ...b.map((i) => i.doneAt || i.startedAt || i.createdAt || 0));
    }
    // the user's order (drag), else first seen; a state change or a newer activity moves nothing (U2)
    const cmp = orderFolders(out.map((r) => key(r.folder)));
    out.sort((a, b) => cmp(key(a.folder), key(b.folder)) || a.order - b.order);
    return out;
  }

  // ---- rendering -----------------------------------------------------------------------------
  // IME composition in any text box of the page (the inbox box, a QA answer box): render() replaces
  // every element, and replacing the box mid-composition drops the unconverted text (no kanji), so the
  // redraw waits for compositionend. Listened on root (composition events bubble), see watchComposition.
  let composing = false;
  let renderLater = false;
  function watchComposition(el) {
    el.addEventListener('compositionstart', () => {
      composing = true;
    });
    const end = () => {
      if (!composing) return;
      composing = false;
      if (renderLater) setTimeout(render, 0);
    };
    el.addEventListener('compositionend', end);
    el.addEventListener('focusout', end); // focus left mid-composition: compositionend may never come
  }

  // Data-driven redraws (session updates, inbox / backlog / QA changes, the 15 s refresh, the own
  // session's memory) go through renderSoon(): at most one per RENDER_GAP ms, none while the list is
  // being scrolled, and none at all when what is drawn did not change (dataSig; relative times only
  // move per minute). render() itself stays immediate for the page's own clicks (open a QA table, …).
  // Replacing the whole page on every session update made scrolling stutter and cut IME composition.
  const RENDER_GAP = 700;
  const SCROLL_QUIET = 300;
  let lastSig = '';
  let lastRender = 0;
  let scrollUntil = 0;
  let softT = 0;
  // AT-147: the resource texts (sched.js overOf: 「CPU 92%（目安 85% 超え）」, the 'resource' wait reasons) carry the
  // figures of now, and they are drawn only in tooltips. Compared with the figures they redrew every tab on every
  // sched:changed while a resource was over its mark; compared without them (sigText), and the tooltips get the new
  // text in place (refreshTips) when nothing else changed.
  const sigText = (s) => String(s == null ? '' : s).replace(/\d+(?:\.\d+)?/g, '#');
  function schedSig(st, onTab) {
    if (!st) return null;
    const r = st.resources || {};
    const over = Array.isArray(r.over) ? r.over.map(sigText) : [];
    let waiting = null;
    if (onTab === 'proj' && st.waiting && typeof st.waiting === 'object') {
      waiting = {};
      for (const [f, m] of Object.entries(st.waiting)) {
        waiting[f] = {};
        for (const [id, x] of Object.entries(m || {})) waiting[f][id] = x && typeof x === 'object' ? [x.code, sigText(x.text)] : x;
      }
    }
    return [Array.isArray(st.running) ? st.running.length : 0, st.limit, over, waiting];
  }
  function schedTip() {
    const r = sched.resources || {};
    const over = Array.isArray(r.over) ? r.over : [];
    const gb = (mb) => (mb / 1024).toFixed(1);
    return [
      `同時に動かすタスク: ${sched.running.length} 件（上限 ${sched.limit}）`,
      over.length ? `新しく始めない: ${over.join('、')}` : '',
      r.freeMB != null ? `空きメモリ ${gb(r.freeMB)} GB / ${gb(r.totalMB || 0)} GB` : '',
      r.cpuPct != null ? `CPU ${Math.round(r.cpuPct)}%（30 秒平均）` : '',
      ...sched.running.map((x) => `▶ ${baseName(x.folder)}: ${x.id}`),
    ].filter(Boolean).join('\n');
  }
  // the tooltips whose text has figures in it, without a redraw (renderSoon when dataSig did not change)
  function refreshTips() {
    if (!root) return;
    const chipEl = root.querySelector('.dbx-sched');
    if (chipEl && sched && Array.isArray(sched.running)) chipEl.title = schedTip();
    for (const el of root.querySelectorAll('[data-why-id]')) {
      const why = schedWhy(el.dataset.whyFolder || '', el.dataset.whyId);
      if (why && why.text) el.title = why.text;
    }
  }
  function dataSig() {
    let own = null;
    try {
      own = ownHooks.own ? ownHooks.own() : null;
    } catch {}
    // UX6: the memory as it is drawn (memText), not the figure that moves with every sample
    if (own && typeof own === 'object') own = { ...own, memMb: own.memMb == null ? null : memText(own.memMb) };
    // the folder tab does not draw agents / context / cost: their every tool call must not redraw it
    // `at` moves on every push (TabState.updatedAt) and is drawn only in the card's tooltip (最後の動き): not compared (UX6;
    // the tooltip takes the new time with the next draw of the card)
    // compared in a fixed wcId / tabId order: widget.js orders by `at`, and every push stamps the pushing
    // window's tabs with Date.now(), so two windows pushing in turn swap the order with nothing else changed
    // (stable check NG 1). The drawn order follows `at` per folder, which is compared per minute above.
    const ss = sessions
      .map(({ agents, doing, model, contextPct, costUsd, ...s }) => {
        // wait: only what is drawn (its items carry member / output times that move with every tool call)
        const o = { ...s, memMb: s.memMb == null ? s.memMb : memText(s.memMb), at: 0, wait: s.wait ? [s.wait.kind, s.wait.level, s.wait.text] : null };
        if (agentsShown()) return { ...o, agents, doing, contextPct, costUsd };
        // tabs other than プロジェクト draw sessions only as counts (band, tab badges; あなたの番 cards come from attn)
        if (tab !== 'proj') return [o.wcId, o.tabId, kindOf(s), o.folder, o.promptKey];
        return o;
      })
      .sort((a, b) => (a.wcId ?? a[0] ?? 0) - (b.wcId ?? b[0] ?? 0) || String(a.tabId ?? a[1]).localeCompare(String(b.tabId ?? b[1])));
    // あなたの番 (attention list): on that tab the items without the ever-growing wait times (drawn per minute anyway);
    // elsewhere only what the tab badge counts
    const hid = [liveSent(attnSent), liveSent(waitSent)];
    const ws = waitOpen()
      ? [attn.map(({ entry, ...x }) => [x, entry ? { ...entry, waitedMs: 0 } : null]), hid, waitDone.map((d) => nowText(d)), waitNotes.size]
      : [attn.map((x) => [x.id, x.folder, x.own]), hid];
    // folders / progress only matter to the プロジェクト tab (and the filter chips: their names)
    // 依頼 draws the routed tasks of a request (「→ C AT-3」 and its flow) from the backlogs: their number / state / tab only
    const fs = tab === 'proj' ? ver.folders : tab === 'req' ? [ver.folderNames, folders.map((f) => (f.backlog || []).map((i) => [i.id, i.no, i.status, i.tabId]))] : ver.folderNames;
    const view = [tab, projMode, [...folderSel], folderOrder, reqView, textFilter, groupOpen, [...groupMore], pastOpen, pastFold, [...pastMore], [...cardMore], window.ProgressView && ProgressView.sig ? ProgressView.sig() : '', reqMenu, titleEdit, remote && remote.running, startShown() ? [startBig(), startList, startNote.text] : null];
    // sched: what is drawn (the band, 待ち（上限） marks), not the resource figures that move every few seconds
    const sc = schedSig(sched, tab);
    // PMO の記録 (U4): drawn only on its tab (no count on the tab); the update bar only with the setting on
    const lg = tab === 'log' ? [ver.log, [...logKinds], [...logOpen], [...logRunOpen], logShowAll] : null;
    const upd = updateShown() ? update : null;
    const qs = tab === 'proj' ? [ver.queue, [...qAsk.keys()], [...qNotes.values()].map((n) => n.text)] : null;
    // UX6: no clock in the signature (the 「N分前」 words follow tickAgo); the big sources by their version (J7)
    const parts = [view, ver.inbox, ss, fs, workRoot, modelCfg, modelErr, stale, ver.qa, ver.notices, own, ws, upd, waitCfg, sc, lg, qs, leftover && [leftover.count, leftover.mb, leftover.mode, leftover.error, leftover.suspended, leftover.tasklist, leftover.ended, leftover.stoppedTotal], flashSel && Date.now() < flashUntil ? flashSel : ''].map((x) => JSON.stringify(x));
    sigParts = parts;
    return parts.join('\u0001');
  }
  // which parts of the signature moved for the last draws (tests, tmp/ux6: Dashboard._stats().why)
  const SIG_NAMES = ['view', 'inbox', 'sessions', 'folders', 'workRoot', 'models', 'modelErr', 'stale', 'qa', 'notices', 'own', 'attention', 'update', 'waitCfg', 'sched', 'log', 'queue', 'leftover', 'flash'];
  let sigParts = [];
  let drawnParts = [];
  function renderSoon() {
    if (!root || softT) return;
    const now = Date.now();
    const wait = Math.max(0, lastRender + RENDER_GAP - now, scrollUntil - now);
    softT = setTimeout(() => {
      softT = 0;
      // §5.5.2: a hidden page computes nothing; it draws once when it is shown again (visibilitychange)
      if (pageHidden()) {
        hiddenDirty = true;
        return;
      }
      if (Date.now() < scrollUntil) return renderSoon();
      if (dataSig() === lastSig) {
        stats.skipped++;
        return refreshTips();
      }
      requestAnimationFrame(render);
    }, wait);
  }
  let hiddenDirty = false;
  const pageHidden = () => {
    try {
      return document.visibilityState === 'hidden';
    } catch {
      return false;
    }
  };
  function watchScroll(el) {
    // scroll does not bubble: capture it from the list (.dbx-body is rebuilt by render)
    el.addEventListener('scroll', () => {
      scrollUntil = Date.now() + SCROLL_QUIET;
    }, { capture: true, passive: true });
  }

  function restore0(box, f) {
    if (!box) return;
    box.focus({ preventScroll: true });
    try {
      box.setSelectionRange(f.s, f.e, f.dir);
    } catch {}
  }
  const tabScroll = {};
  let drawnTab = '';
  function render() {
    if (!root) return;
    if (composing) {
      renderLater = true;
      return;
    }
    renderLater = false;
    lastRender = Date.now();
    lastSig = dataSig();
    stats.renders++;
    const moved = SIG_NAMES.filter((n, i) => sigParts[i] !== drawnParts[i]);
    stats.why = [...(stats.why || []), moved.join(',')].slice(-8);
    drawnParts = sigParts;
    const scroll = root.querySelector('.dbx-body')?.scrollTop || 0;
    const draft = root.querySelector('.dbx-new');
    const draftVal = draft ? draft.value : '';
    // the box with the caret (inbox box, or a QA answer box by entry key + row index): focus and selection come back
    const act = document.activeElement;
    const sel = (el) => ({ s: el.selectionStart, e: el.selectionEnd, dir: el.selectionDirection });
    const newFocus = draft && act === draft ? sel(draft) : null;
    const qaFocus = act && act.classList && act.classList.contains('dbx-qa-input') && root.contains(act)
      ? { key: act.dataset.key, i: act.dataset.i, ...sel(act) }
      : null;
    const ntcFocus = act && act.classList && act.classList.contains('dbx-ntc-input') && root.contains(act) ? { id: act.dataset.id, ...sel(act) } : null;
    const waitFocus = act && act.classList && act.classList.contains('dbx-wait-text') && root.contains(act) ? { key: act.dataset.key, ...sel(act) } : null;
    const cfgFocus = act && act.classList && act.classList.contains('dbx-wcfg-input') && root.contains(act) ? act.dataset.k : null;
    const filterFocus = act && act.classList && act.classList.contains('dbx-filter') && root.contains(act) ? sel(act) : null;
    const titleFocus = act && act.classList && act.classList.contains('dbx-ititle-input') && root.contains(act) ? { id: act.dataset.id, ...sel(act) } : null;
    const startFocus = act && act.classList && act.classList.contains('dbx-start-name') && root.contains(act) ? sel(act) : null;
    const qaskFocus = act && act.classList && act.classList.contains('dbx-qask-in') && root.contains(act) ? { k: act.dataset.k, ...sel(act) } : null;
    const list = rows();
    // UX6: patched in (only the changed rows are swapped; the box, the band and the tabs stay); the body is new only
    // when the tab changed (its data-k is the tab)
    const next = document.createElement('div');
    next.append(header(list, draftVal), body(list));
    tickAgo(root); // the words on the page are the clock's of now, as the new ones: no swap for the time alone
    refreshTips(); // and the tooltips with figures (the band's 動いている chip) the ones of now
    patchKids(root, next);
    // the body's scroll position per tab (a switch puts the other tab's back)
    const bd = root.querySelector('.dbx-body');
    if (bd.dataset.tab === drawnTab) {
      if (bd.scrollTop !== scroll) bd.scrollTop = scroll;
    } else {
      tabScroll[drawnTab] = scroll;
      bd.scrollTop = tabScroll[bd.dataset.tab] || 0;
    }
    drawnTab = bd.dataset.tab;
    // the box with the caret is still on the page (kept by the patch): nothing to put back
    if (act && act !== document.body && act.isConnected && root.contains(act)) return;
    const restore = restore0;
    if (filterFocus) restore(root.querySelector('.dbx-filter'), filterFocus);
    if (titleFocus) restore(root.querySelector(`.dbx-ititle-input[data-id="${CSS.escape(titleFocus.id)}"]`), titleFocus);
    if (startFocus) restore(root.querySelector('.dbx-start-name'), startFocus);
    if (qaskFocus) restore(root.querySelector(`.dbx-qask-in[data-k="${CSS.escape(qaskFocus.k)}"]`), qaskFocus);
    if (newFocus) restore(root.querySelector('.dbx-new'), newFocus);
    if (qaFocus) restore(root.querySelector(`.dbx-qa-input[data-key="${CSS.escape(qaFocus.key)}"][data-i="${qaFocus.i}"]`), qaFocus);
    if (ntcFocus) restore(root.querySelector(`.dbx-ntc-input[data-id="${CSS.escape(ntcFocus.id)}"]`), ntcFocus);
    if (waitFocus) restore(root.querySelector(`.dbx-wait-text[data-key="${CSS.escape(waitFocus.key)}"]`), waitFocus);
    if (cfgFocus) root.querySelector(`.dbx-wcfg-input[data-k="${CSS.escape(cfgFocus)}"]`)?.focus({ preventScroll: true });
  }

  // 更新待ち (src/main/autorestart.js): a new release is reserved, the queues hold until the restart. 「今すぐ更新」 restarts
  // at the next turn gap (running items continue in the same conversation), 「後で」 drops the reservation.
  // U4: not shown by default (the release is in PMO の記録; the forced restart comes anyway): only with the setting
  // showUpdateBar (Notify.settings) on, or while restarting.
  function updateShown() {
    const st = update && update.state;
    if (st === 'restarting') return true;
    if (st !== 'pending' && st !== 'postponed') return false;
    let s = null;
    try {
      s = window.Notify?.settings?.() || null;
    } catch {}
    return !!(s && s.showUpdateBar === true);
  }
  function updateBar() {
    const st = update && update.state;
    if (!updateShown()) return null;
    const bar = h('div', `dbx-update${st === 'postponed' ? ' postponed' : ''}`);
    const hm = (ms) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    // short words on the bar, the whole sentence in the tooltip (docs/ui-copy.md)
    let text;
    let full;
    if (st === 'restarting') text = full = '新しい版で再起動しています…';
    else if (st === 'postponed') {
      text = '新しい版あり（更新は後で）';
      full = '新しい版があります（更新は後で）。待ちのタスクは動いています';
    } else if (update.force) {
      text = `更新待ち（ターンの合間で再起動）`;
      full = `更新待ち: ターンの合間で再起動します${update.blocked ? `（応答中・${W('yourTurn', '要対応')}のウィンドウ ${update.blocked}）` : ''}。実行中の作業は再起動の後、同じ会話の続きで再開します`;
    } else {
      text = `更新待ち${update.deadline ? `（${hm(update.deadline)} まで）` : ''}`;
      full = `更新待ち: 新しい作業は再起動の後に始めます${update.busy ? `（実行中のウィンドウ ${update.busy} の終わりを待っています${update.deadline ? `、${hm(update.deadline)} を過ぎたらターンの合間で再起動` : ''}）` : ''}`;
    }
    const tx = h('span', 'dbx-upd-text', text);
    tx.title = full;
    bar.append(tx);
    const btn = (label, title, action) => {
      const b = h('button', `dbx-upd-${action}`, label);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', () => {
        b.disabled = true;
        Promise.resolve(api.updateAction?.(action)).catch(() => {}).finally(() => (b.disabled = false));
      });
      bar.append(b);
    };
    if (st === 'restarting') return bar;
    if (!update.force) btn('今すぐ更新', '実行中の作業の終わりを待たずに、全部のセッションがターンの合間になったところで再起動します（実行中の作業は同じ会話の続きで再開します）', 'now');
    if (st === 'pending') btn('後で', '更新の予約を取り消し、待ちの作業を再開します（あとで「今すぐ更新」を押すと更新します）', 'later');
    return bar;
  }

  // ---- counts for the band and the tab badges ---------------------------------------------------
  // あなたの番 (U3) = main's attention list, under the folder filter (the PMO's own session only with すべて), less the
  // cards answered here and not dropped by main yet.
  const passAttn = (it) => (it.own || (exclude && it.folder && key(it.folder) === key(exclude)) ? folderSel.size === 0 : passFolder(it.folder));
  // since: the same dialog asked again after it left the screen (same promptKey, new since) is a new dialog, shown at
  // once — not the one just answered (AT-159: it stayed hidden behind the answered one's key)
  const sentKey = (e) => `${e.wcId}:${e.tabId}:${e.prompt ? `${e.prompt.key}:${e.prompt.since || ''}` : e.kind}`;
  const SENT_MS = 20e3;
  // the hidden keys still within SENT_MS (dataSig: a key running out changes the signature, so the card is drawn again)
  const liveSent = (m, now = Date.now()) => [...m].filter(([, at]) => now - at <= SENT_MS).map(([k]) => k);
  // redraw when the next answered card runs out of its SENT_MS (else it came back only with the next list change)
  let unhideT = 0;
  function armUnhide() {
    clearTimeout(unhideT);
    unhideT = 0;
    const now = Date.now();
    let next = Infinity;
    for (const m of [attnSent, waitSent]) for (const at of m.values()) if (now - at <= SENT_MS) next = Math.min(next, at + SENT_MS);
    if (next === Infinity) return;
    unhideT = setTimeout(() => {
      unhideT = 0;
      renderSoon();
      armUnhide();
    }, Math.max(0, next - now) + 50);
  }
  function attnHidden(it) {
    const at = attnSent.get(it.id);
    if (at) return Date.now() - at <= SENT_MS;
    const e = it.entry;
    if (e && e.prompt) {
      const t = waitSent.get(sentKey(e));
      if (t && Date.now() - t <= SENT_MS) return true;
    }
    // answered here through the shared parts (qa:answer / notices:answer update the local lists at once)
    let done = false;
    if (it.kind === 'qa') done = qaEntries.some((x) => x.key === it.qaKey && x.status === 'answered');
    else if (it.kind === 'proposal') done = notices.some((n) => n.id === it.noticeId && n.answer);
    if (done) {
      attnSent.set(it.id, Date.now());
      armUnhide();
    }
    return done;
  }
  const attnShown = () => attn.filter((it) => passAttn(it) && !attnHidden(it));
  const OPEN_REQ = ['new', 'asking', 'hold', 'routed'];
  // 対応中 under the folder filter: the 依頼 tab's count and its 対応中 chip both come from here (UX5: they disagreed on hold)
  const isOpenReq = (it) => OPEN_REQ.includes(it.status);
  const openReqs = () => inbox.filter((it) => isOpenReq(it) && passFolder(it.folder));
  // PMO の記録 (U4): main's LogEntry[] { id, at, kind, type, title, text, folder, bad, itemId? }; with an older main the
  // notices stand in (every notice but the unanswered proposals: those are あなたの番). Under the folder filter.
  function logEntries() {
    if (Array.isArray(pmoLog)) return pmoLog.filter((e) => e && typeof e === 'object' && e.id != null);
    return notices
      .filter((n) => !(n.kind === 'proposal' && !n.answer))
      .map((n) => ({
        id: n.id,
        at: n.updatedAt || n.createdAt || 0,
        kind: n.kind === 'warn' ? 'warn' : 'info',
        type: 'notice',
        title: n.kind === 'proposal' && n.answer ? `${n.title}（${n.answer.choice === 'go' ? '進める' : '却下'}）` : n.title,
        text: n.text || '',
        folder: n.folder || null,
        bad: false,
        itemId: n.itemId || null,
      }));
  }
  const logList = () => logEntries().filter((e) => passFolder(e.folder));

  // folder filter: '' / null folder = NOFOLDER (振り分け前の依頼, notices without a folder)
  function passFolder(folder) {
    if (!folderSel.size) return true;
    return folderSel.has(folder ? key(folder) : NOFOLDER);
  }
  // the folders in their fixed order (the user's drag, else first seen); new ones are appended and saved
  function orderFolders(keys) {
    let changed = false;
    for (const k of keys) {
      if (!folderOrder.includes(k)) {
        folderOrder.push(k);
        changed = true;
      }
    }
    if (folderOrder.length > 200) {
      // forget the oldest ones that are not shown any more
      const shown = new Set(keys);
      folderOrder = folderOrder.filter((k, i) => shown.has(k) || i >= folderOrder.length - 150);
      changed = true;
    }
    if (changed) store.set('dashFolderOrder', folderOrder);
    const at = new Map(folderOrder.map((k, i) => [k, i]));
    return (a, b) => (at.get(a) ?? 1e9) - (at.get(b) ?? 1e9);
  }

  function switchTab(t) {
    if (!TABS.includes(t)) return;
    tabChosen = true;
    if (tab === t) return render();
    tab = t;
    store.set('dashTab', t);
    reqMenu = '';
    if (t === 'turn') {
      // the attention list is read when the tab opens (then main pushes its changes: attention:changed)
      loadAttention().then(renderSoon);
    } else if (t === 'log') loadPmoLog().then(renderSoon);
    render();
  }

  // the top: band (動いている / PMO / スマホ / ⚙) + the request box, then the tabs and the folder filter
  function header(list, draftVal) {
    const head = P(h('header', 'dbx-head'));
    const top = P(h('div', 'dbx-top'));
    top.append(h('span', 'dbx-title', W('dashboard', 'ダッシュボード')));
    top.append(band());
    head.append(top);
    const upd = updateBar();
    if (upd) head.append(upd);
    const row = P(h('div', 'dbx-newrow'));
    const box = h('textarea', 'dbx-new');
    box.rows = 1;
    box.value = draftVal;
    box.placeholder = `依頼を書いて ${window.Labels.key('mod+Enter')}`;
    box.title = 'どのフォルダで進めるかは PMO が決めて振り分けます。「@フォルダ名」を書くとそのフォルダを指定できます（例 @agent_terminal）。新しいフォルダが要るときは PMO が作ります';
    // UX6: the box on the page (the patch may keep the button of an older draw and this box, or the other way round);
    // emptied at once and keeps the caret, the request goes out in the background (no full refresh to wait for)
    const send = async () => {
      const el = root.querySelector('.dbx-new') || box;
      const text = el.value.trim();
      if (!text) return;
      el.value = '';
      el.focus({ preventScroll: true });
      let item = null;
      try {
        item = await api.inboxAdd?.({ text });
      } catch (err) {
        console.error(err);
      }
      // 「@フォルダ名」: a known folder's name in the text = where it should go (the PMO still routes it)
      const at = /(?:^|\s)@([^\s@]+)/.exec(text);
      const hit = at && item && item.id ? folders.find((f) => baseName(f.folder).toLowerCase() === at[1].toLowerCase()) : null;
      if (hit) {
        try {
          await api.inboxUpdate?.({ id: item.id, patch: { folder: hit.folder } });
        } catch (err) {
          console.error(err);
        }
      }
      inboxSoon();
    };
    box.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        send();
      }
    });
    const go = h('button', 'dbx-send', '送信');
    go.type = 'button';
    go.dataset.usage = 'dash.inbox.send'; // UA1
    go.title = window.Labels.key('mod+Enter');
    go.addEventListener('click', send);
    row.append(box, go);
    head.append(row);
    head.append(tabBar(list), filterBar(list));
    return head;
  }

  // 「動いている 2 / 上限 3」 · PMO (memory, 再起動 when heavy) · スマホ. Quiet; coloured only when something is off.
  function band() {
    const b = P(h('div', 'dbx-band'));
    const chip = (cls, text, title, onClick) => {
      const el = h(onClick ? 'button' : 'span', `dbx-chip ${cls}`, text);
      if (onClick) {
        el.type = 'button';
        el.addEventListener('click', onClick);
      }
      if (title) el.title = title;
      b.append(el);
      return el;
    };
    // U5: ＋ 新しいセッション (the picker's parts, on this page): opens / closes the panel on top of the tab
    const ns = chip(`dbx-newsess${startShown() ? ' on' : ''}`, `＋ ${W('newSession', '新しいセッション')}`, 'フォルダを開く・新しい作業・一時セッション・ファイルの編集', () => {
      if (startShown()) {
        startOpen = false;
        startClosed = true;
      } else {
        startOpen = true;
        startClosed = false;
        loadFolders().then(renderSoon).catch(() => {});
      }
      render();
    });
    ns.setAttribute('aria-expanded', String(startShown()));
    if (sched && Array.isArray(sched.running)) {
      const r = sched.resources || {};
      const over = Array.isArray(r.over) ? r.over : [];
      chip(`dbx-sched${over.length ? ' over' : ''}`, `動いている ${sched.running.length} / 上限 ${sched.limit}${over.length ? '（資源）' : ''}`, schedTip());
    }
    // 51c: processes the tabs left behind (src/main/leftovers.js): count + private MB, next to the resources chip.
    // U4: only when there are some (or counting failed); 「残ったプロセス 0」 said nothing
    if (leftover && Number.isFinite(leftover.count) && (leftover.count > 0 || leftover.error)) {
      const lo = leftover;
      const el = chip(`dbx-leftovers${lo.count ? ' over' : ''}`, `残ったプロセス ${lo.count}${lo.count ? ` · ${lo.mb >= 1000 ? `${(lo.mb / 1024).toFixed(1)}GB` : `${Math.round(lo.mb)}MB`}` : ''}`, [
        `タブの claude の下で残ったプロセス: ${lo.count} 個、${lo.mb} MB（private）`,
        lo.count ? `内訳: 中断状態のまま ${lo.suspended || 0} 個、終わらない tasklist の組 ${lo.tasklist || 0} 個（うち終わったセッションの分 ${lo.ended || 0} 個）` : '',
        `止める設定: ${LEFTOVER_MODES[lo.mode] || lo.mode}（⚙ で変更）`,
        lo.stoppedTotal ? `この起動で止めた数: ${lo.stoppedTotal}` : '',
        lo.error ? `数えられませんでした: ${lo.error}` : '',
        '手で動かしている claude・VS Code・テストのプロセスは数えません',
      ].filter(Boolean).join('\n'));
      el.dataset.count = String(lo.count);
      el.dataset.mode = String(lo.mode || '');
    }
    const own = ownLine();
    if (own) b.append(own);
    // UX5: a mark only while ON; the switch is in 設定 > スマホ (remote-ui.js)
    if (remote && remote.running) chip('dbx-remote on', `${W('phone', 'スマホ')} ON`, `${W('phone', 'スマホ')}から操作できます（切り替えは ${W('settings', '設定')} > ${W('phone', 'スマホ')}）`);
    return b;
  }

  // ---- ⚙ settings (U4) -------------------------------------------------------------------------
  // window.Settings (settings.js, a modal): { open(sectionId?), close(), isOpen(), render(), register({ id, title, order,
  // render(container) }) }. This page registers 'dashboard' (「作業とモデル」: 置き場所・モデル・止まりの見張り・残ったプロセス) once, and
  // draws it again in place after its own changes (settingsHost) without touching the other sections.
  const SETTINGS_ID = 'dashboard';
  const settingsModal = () => {
    const S = window.Settings;
    return S && typeof S.open === 'function' && typeof S.register === 'function' ? S : null;
  };
  let settingsRegistered = false;
  let settingsHost = null; // the container the modal gave this section (last render)
  function ensureSettings() {
    const S = settingsModal();
    if (!S || settingsRegistered) return !!S;
    try {
      S.register({
        id: SETTINGS_ID,
        title: W('workAndModel', '作業とモデル'),
        order: 12, // UX5: second from the top (after 自動で進める 10; settings.js sorts all sections by order)
        render(container) {
          settingsHost = container;
          drawSettings(container);
        },
      });
      settingsRegistered = true;
    } catch (err) {
      console.error('settings register failed', err);
      return false;
    }
    return true;
  }
  // the section's controls, keeping the field with the caret
  function drawSettings(container) {
    if (!container) return;
    const act = document.activeElement;
    const k = act && act.classList && act.classList.contains('dbx-wcfg-input') && container.contains(act) ? act.dataset.k : null;
    // UX6: patched like the page (an open select / the field with the caret stays when nothing of it changed)
    const nx = document.createElement('div');
    nx.append(settingsPanel());
    patchKids(container, nx);
    if (k) container.querySelector(`.dbx-wcfg-input[data-k="${CSS.escape(k)}"]`)?.focus({ preventScroll: true });
  }
  // after a change made in the settings (or new data): the modal's section in place, and the page
  function settingsChanged() {
    if (settingsHost && settingsHost.isConnected) drawSettings(settingsHost);
    render();
  }
  // new data from main (refresh): the open section shows it, unless the user is typing in it
  function settingsData() {
    if (!settingsHost || !settingsHost.isConnected) return;
    if (settingsHost.contains(document.activeElement)) return;
    drawSettings(settingsHost);
  }

  // AT-6: the default model / effort of the claude starts (作業のセッション・タブ / PMO), manager-settings.json.
  // A routed item's own (the PMO's route / create) wins over it. Applies from the next start of each claude.
  function modelLines() {
    if (!modelCfg || !api.modelsSet) return null;
    const wrap = h('div', 'dbx-models');
    const row = (label, key, cur, tip) => {
      const r = h('div', 'dbx-workroot dbx-modelrow');
      r.dataset.key = key;
      r.append(h('span', 'dbx-wrlabel', label));
      const inp = h('input', 'dbx-modelin');
      inp.value = cur.model;
      inp.placeholder = modelCfg.builtin.model;
      inp.spellcheck = false;
      inp.title = `${tip}\nモデル名（例 ${modelCfg.builtin.model}）か別名（opus / sonnet / haiku）。空にすると ${modelCfg.builtin.model}`;
      const sel = h('select', 'dbx-effortsel');
      for (const v of modelCfg.efforts) {
        const o = h('option', null, v);
        o.value = v;
        if (v === cur.effort) o.selected = true;
        sel.append(o);
      }
      sel.title = `${tip}\neffort（既定 ${modelCfg.builtin.effort}）`;
      const save = async () => {
        const o = key === 'pmo' ? { pmoModel: inp.value.trim(), pmoEffort: sel.value } : { claudeModel: inp.value.trim(), claudeEffort: sel.value };
        try {
          const r2 = await api.modelsSet(o);
          if (r2 && r2.session) {
            modelCfg = r2;
            modelErr = '';
          } else modelErr = `保存できませんでした: ${(r2 && r2.error) || '不明'}`;
        } catch (err) {
          modelErr = `保存できませんでした: ${err && err.message}`;
        }
        settingsChanged();
      };
      inp.addEventListener('change', save);
      sel.addEventListener('change', save);
      r.append(inp, sel);
      return r;
    };
    wrap.append(
      row('モデル（作業・タブ）', 'session', modelCfg.session, '振り分けた作業のセッションとタブの claude の既定（PMO が作業ごとに変えたものはそちらが優先）。次に起動する claude から効きます'),
      row('モデル（PMO）', 'pmo', modelCfg.pmo, 'PMO 自身の claude。次に PMO の claude を起動したときから効きます'),
    );
    if (modelErr) wrap.append(h('div', 'dbx-modelerr', modelErr));
    return wrap;
  }

  // ⚙: the settings that sat at the top of the page before (置き場所, モデル, 待ちの見張り, 残ったプロセス). U4: drawn into
  // the settings modal's 'dashboard' section (the ⚙ of the top bar is the one entry; UX5).
  function settingsPanel() {
    const p = P(h('div', 'dbx-settings in-modal'));
    if (workRoot) {
      const wr = h('div', 'dbx-workroot');
      wr.append(h('span', 'dbx-wrlabel', '新しい作業の置き場所'));
      const pth = h('span', 'dbx-wrpath', workRoot);
      pth.title = `${workRoot}\nどのプロジェクトにも属さない新しい作業は、この中にフォルダを作って始めます`;
      const change = h('button', 'dbx-link', '変更');
      change.type = 'button';
      change.addEventListener('click', async () => {
        try {
          const dir = await api.dashboardChooseWorkRoot?.();
          if (dir) workRoot = dir;
        } catch (err) {
          console.error(err);
        }
        settingsChanged();
      });
      wr.append(pth, change);
      p.append(wr);
    }
    const ml = modelLines();
    if (ml) p.append(ml);
    const wc = waitCfgLine();
    if (wc) p.append(wc);
    if (leftover && api.procLeftoversMode) {
      // 51c: what to do with the processes the tabs left behind
      const row = h('div', 'dbx-workroot dbx-leftmode');
      row.append(h('span', 'dbx-wrlabel', '残ったプロセス'));
      const sel = h('select', 'dbx-leftsel');
      for (const [v, label] of Object.entries(LEFTOVER_MODES)) {
        const o = h('option', null, label);
        o.value = v;
        if (v === leftover.mode) o.selected = true;
        sel.append(o);
      }
      sel.title = 'タブの claude の下で残った、中断状態のまま 1 命令も動いていないプロセスと、終わらない tasklist の組だけが対象';
      sel.addEventListener('change', async () => {
        try {
          const st = await api.procLeftoversMode(sel.value);
          if (st) leftover = st;
        } catch (err) {
          console.error(err);
        }
        settingsChanged();
      });
      row.append(sel);
      p.append(row);
    }
    return p;
  }

  function tabBar(list) {
    const bar = P(h('div', 'dbx-tabs'));
    bar.setAttribute('role', 'tablist');
    const nTurn = attnShown().length;
    const reqOpen = openReqs().length;
    const shownFolders = list.filter((r) => passFolder(r.folder)).length;
    // PMO の記録: no count (U4: 読まなくてよい場所, no read / unread)
    const defs = [
      ['turn', W('yourTurn', '要対応'), nTurn, nTurn ? 'hot' : '', 'あなたにしか決められないもの（確認・質問・QA・提案・動かないセッション）'],
      ['proj', W('projects', 'プロジェクト'), shownFolders, '', 'フォルダごとの進み具合とタスク'],
      ['req', W('inbox', '依頼'), reqOpen, '', '依頼の受付 → 振り分け → 進み具合（数は対応中）'],
      ['log', W('pmoLog', 'PMO の記録'), 0, '', 'PMO とアプリが自分で行ったこと（後押し・振り分け・順番・立て直し・片付け・更新・引き継ぎ）。読まなくても大丈夫です。取り消したいものは PMO に相談してください'],
    ];
    for (const [id, label, n, cls, title] of defs) {
      const b = h('button', `dbx-tab${tab === id ? ' on' : ''}`);
      b.type = 'button';
      b.dataset.tab = id;
      b.dataset.usage = 'dash.tab.' + USAGE_TAB[id]; // UA1
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(tab === id));
      b.title = title;
      b.append(document.createTextNode(label));
      if (n) b.append(h('span', `dbx-badge ${cls}`, String(n)));
      b.addEventListener('click', () => switchTab(id));
      bar.append(b);
    }
    return bar;
  }

  // すべて + one chip per folder (fixed order) + 振り分け前; several can be chosen; saved. Text filter on 依頼 / 記録.
  function filterBar(list) {
    const bar = P(h('div', 'dbx-filters'));
    const chip = (label, on, title, fn, cls = '') => {
      const c = h('button', `dbx-fchip${on ? ' on' : ''}${cls}`, label);
      c.type = 'button';
      if (title) c.title = title;
      c.addEventListener('click', fn);
      bar.append(c);
      return c;
    };
    const save = () => store.set('dashFolders', [...folderSel]);
    chip('すべて', !folderSel.size, 'フォルダで絞らない', () => {
      folderSel.clear();
      save();
      render();
    });
    for (const r of list) {
      const k = key(r.folder);
      const c = chip(baseName(r.folder), folderSel.has(k), `${r.folder}\nクリックで絞り込みに足す / 外す`, () => {
        if (folderSel.has(k)) folderSel.delete(k);
        else folderSel.add(k);
        save();
        render();
      });
      c.dataset.folder = k;
    }
    if (tab === 'req' || tab === 'log') {
      chip('振り分け前', folderSel.has(NOFOLDER), 'フォルダが決まっていない依頼・お知らせ', () => {
        if (folderSel.has(NOFOLDER)) folderSel.delete(NOFOLDER);
        else folderSel.add(NOFOLDER);
        save();
        render();
      }).dataset.folder = NOFOLDER;
      const f = h('input', 'dbx-filter');
      f.type = 'search';
      f.placeholder = '文字で絞る';
      f.value = textFilter;
      f.title = '見出し・本文・番号（AT-12、依頼-3）で絞ります';
      // typed text redraws once the IME has committed (input events while composing are skipped)
      let t = 0;
      f.addEventListener('input', (e) => {
        if (e.isComposing) return;
        textFilter = f.value;
        clearTimeout(t);
        t = setTimeout(render, 150);
      });
      f.addEventListener('compositionend', () => {
        textFilter = f.value;
        clearTimeout(t);
        t = setTimeout(render, 150);
      });
      bar.append(f);
    }
    if (tab === 'proj' && window.AgentsView) {
      const sw = h('span', 'dbx-views');
      for (const [m, label, title] of [['cards', 'カード', 'フォルダごとのカード'], ['agents', '関係図', 'セッション・チーム・サブエージェントの関係図（エージェント）']]) {
        const b = h('button', projMode === m ? 'on' : '', label);
        b.type = 'button';
        b.title = title;
        b.addEventListener('click', () => {
          if (projMode === m) return;
          projMode = m;
          store.set('dashProjMode', m);
          render();
        });
        sw.append(b);
      }
      bar.append(sw);
    }
    return bar;
  }

  // more = the task numbers an inbox item was routed to (reqNos), so a request is found by 依頼-N and by AT-n
  const matchText = (it, q, more) => {
    if (!q) return true;
    const s = q.trim().toLowerCase();
    if (!s) return true;
    if (L() && L().matchNo && L().matchNo(it, q, more)) return true; // AT-12 / at-12 / 12 / 依頼-3 (labels.js)
    return [it.title, it.text, it.no, it.reqNo, it.note, it.folder && baseName(it.folder)].some((x) => String(x || '').toLowerCase().includes(s));
  };

  // 「待ちの見張り」: minutes of silence (no new output) / since the start after which a waiting session is flagged
  // (wait level 'warn', the manager agent is told). 1-1440 each, main keeps them (wait:settings).
  function waitCfgLine() {
    if (!waitCfg || !api.setWaitSettings) return null;
    const el = h('div', 'dbx-workroot dbx-wcfg');
    el.append(h('span', 'dbx-wrlabel', '待ちの見張り'));
    const field = (k, before, after, title) => {
      const lab = h('label', 'dbx-wcfg-f');
      lab.title = title;
      const i = h('input', 'dbx-wcfg-input');
      i.type = 'number';
      i.min = '1';
      i.max = '1440';
      i.step = '1';
      i.dataset.k = k;
      i.value = waitCfgDraft[k] != null ? waitCfgDraft[k] : String(waitCfg[k] ?? '');
      i.addEventListener('input', () => {
        waitCfgDraft[k] = i.value;
      });
      i.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          i.blur();
        } else if (e.key === 'Escape') {
          delete waitCfgDraft[k];
          i.value = String(waitCfg[k] ?? '');
          i.blur();
        }
      });
      i.addEventListener('change', () => saveWaitCfg(k, i.value));
      lab.append(document.createTextNode(before), i, document.createTextNode(after));
      return lab;
    };
    el.append(
      field('silentMin', '出力が止まって ', ' 分で知らせる', '待っているコマンドの出力がこの分数だけ増えないと、目立つ色にして PMO に知らせます'),
      field('longMin', '開始から ', ' 分で知らせる', '待ち始めてからこの分数たっても終わらないと、目立つ色にして PMO に知らせます'),
    );
    if (waitCfgNote.text) el.append(h('span', `dbx-wcfg-note${waitCfgNote.bad ? ' bad' : ''}`, waitCfgNote.text));
    return el;
  }
  async function saveWaitCfg(k, value) {
    const n = Math.round(Number(value));
    delete waitCfgDraft[k];
    if (!Number.isFinite(n) || n < 1 || n > 1440) {
      Object.assign(waitCfgNote, { text: '1〜1440 分で入れてください', bad: true });
      return settingsChanged();
    }
    if (n === waitCfg[k]) return settingsChanged();
    try {
      const r = await api.setWaitSettings({ ...waitCfg, [k]: n });
      if (r && typeof r === 'object' && r.silentMin != null) {
        waitCfg = { silentMin: r.silentMin, longMin: r.longMin };
        Object.assign(waitCfgNote, { text: '保存しました', bad: false });
      } else {
        // main refuses outside the manager window (null)
        Object.assign(waitCfgNote, { text: 'ここでは変えられません（PMO のウィンドウのダッシュボードで変えてください）', bad: true });
      }
    } catch (err) {
      console.error(err);
      Object.assign(waitCfgNote, { text: '保存できませんでした', bad: true });
    }
    settingsChanged();
    setTimeout(() => {
      if (waitCfgNote.text !== '保存しました') return;
      waitCfgNote.text = '';
      settingsChanged();
    }, 2500);
  }

  // Only the shown tab is built (U2): a switch draws the other one then.
  function body(list) {
    const b = P(h('div', 'dbx-body'), `body-${tab}`);
    b.dataset.tab = tab;
    b.setAttribute('role', 'tabpanel');
    try {
      if (startShown()) b.append(startPanel());
    } catch (err) {
      console.error('new session panel failed', err);
    }
    try {
      if (tab === 'turn') turnBody(b);
      else if (tab === 'proj') projBody(b, list);
      else if (tab === 'req') reqBody(b);
      else logBody(b);
    } catch (err) {
      console.error('dashboard tab failed', err);
      b.append(h('div', 'dbx-empty', '表示に失敗しました'));
    }
    return b;
  }

  // ---- 新しいセッション (UIUX U5) -----------------------------------------------------------------
  // The picker window's parts on the dashboard: フォルダを選ぶ… (folder dialog), 新しい作業 (a new folder under the work root,
  // dashboard:newWork), 一時セッション, ファイルを編集…, 最近のフォルダ (click = its window), 編集中のファイル（残したもの）.
  // Large (.big) while no session other than the PMO's is open; the user may close it (startClosed) until one opens.
  const otherSessions = () => sessions.filter((s) => s && s.folder && key(s.folder) !== key(exclude)).length;
  const startBig = () => sessionsSeen && !otherSessions();
  let startBusy = false; // 新しい作業 in flight (Enter and a click must not make 「x」 and 「x (2)」)
  function startShown() {
    if (startOpen) return true;
    // a session opened since the user closed the large panel: it may come back once all are closed again
    if (startClosed && otherSessions()) startClosed = false;
    return startBig() && !startClosed;
  }
  function startDone() {
    startOpen = false;
    startNote = { text: '', bad: false };
    render();
  }
  function startPanel() {
    const big = startBig();
    const p = h('section', `dbx-sec dbx-start${big ? ' big' : ''}`);
    const head = h('div', 'dbx-start-head');
    head.append(h('span', 'dbx-start-title', W('newSession', '新しいセッション')));
    if (big) head.append(h('span', 'dbx-start-lead', 'まだセッションがありません。フォルダを開くか、上の欄に依頼を書くと PMO が振り分けます'));
    const x = h('button', 'dbx-start-close', '×');
    x.type = 'button';
    x.title = '閉じる（上の帯の「＋ 新しいセッション」で開き直せます）';
    x.addEventListener('click', () => {
      startOpen = false;
      startClosed = true;
      render();
    });
    head.append(x);
    p.append(head);
    // the actions
    const acts = h('div', 'dbx-start-acts');
    const act = (cls, text, title, fn) => {
      const b = h('button', `dbx-start-btn ${cls}`, text);
      b.type = 'button';
      if (title) b.title = title;
      b.addEventListener('click', fn);
      acts.append(b);
      return b;
    };
    act('is-primary k-browse', W('pickFolder', 'フォルダを選ぶ…'), 'フォルダごとに窓が開き、その中のタブで claude が動きます', async () => {
      let ok = false;
      try {
        ok = await api.pickerBrowse?.();
      } catch {}
      if (ok) startDone();
    });
    act('k-temp', W('tempSession', '一時セッション'), `空の一時フォルダで始め、閉じると消します（${window.Labels.shortcutKey('tempSession')}）`, () => {
      api.tempOpen?.();
      startDone();
    });
    act('k-edit', W('editFile', 'ファイルを編集…'), 'ファイルの作業用コピーを一時フォルダで直し、終わったら元へ書き戻します', async () => {
      let ok = false;
      try {
        ok = await api.editPick?.();
      } catch {}
      if (ok) startDone();
    });
    p.append(acts);
    // 新しい作業: a new folder under the work root
    const nw = h('div', 'dbx-start-new');
    nw.append(h('span', 'dbx-start-label', W('newWork', '新しい作業')));
    const name = h('input', 'dbx-start-name');
    name.type = 'text';
    name.value = startName;
    name.placeholder = 'フォルダ名';
    name.title = workRoot ? `置き場所: ${workRoot}\nこの中に新しいフォルダを作って開きます（同じ名前があれば「名前 (2)」）` : 'この中に新しいフォルダを作って開きます';
    name.addEventListener('input', () => {
      startName = name.value;
    });
    const make = h('button', 'dbx-start-btn k-make', '作って開く');
    make.type = 'button';
    const go = async () => {
      const v = name.value.trim();
      if (!v) return name.focus();
      if (startBusy) return;
      startBusy = true;
      make.disabled = true;
      let r = null;
      try {
        r = await api.dashboardNewWork?.({ name: v });
      } catch (err) {
        r = { error: String((err && err.message) || err) };
      } finally {
        startBusy = false;
      }
      if (r && r.ok) {
        startName = '';
        startDone();
        loadFolders().then(renderSoon).catch(() => {});
      } else {
        startNote = { text: `作れませんでした: ${(r && r.error) || '不明'}`, bad: true };
        render();
      }
    };
    make.addEventListener('click', go);
    name.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        go();
      }
    });
    nw.append(name, make);
    if (workRoot) nw.append(h('span', 'dbx-start-where', baseName(workRoot) || workRoot));
    p.append(nw);
    if (startNote.text) p.append(h('div', `dbx-start-note${startNote.bad ? ' bad' : ''}`, startNote.text));
    // 最近のフォルダ / 編集中のファイル
    const openSet = new Set((startList.open || []).map(key));
    const listOf = (title, cls, entries) => {
      if (!entries.length) return;
      p.append(h('div', 'dbx-start-sub', title));
      const ul = h('ul', `dbx-start-list ${cls}`);
      for (const en of entries) {
        const li = h('li', 'dbx-start-item');
        li.tabIndex = 0;
        li.title = en.title;
        const t = h('div', 'dbx-start-text');
        t.append(h('span', 'dbx-start-name1', en.name), h('span', 'dbx-start-path', en.path));
        li.append(t);
        if (en.open) li.append(h('span', 'dbx-start-open', W('openNow', '開いている')));
        const fire = () => {
          en.go();
          startDone();
        };
        li.addEventListener('click', fire);
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') fire();
        });
        ul.append(li);
      }
      p.append(ul);
    };
    listOf(W('keptEdits', '編集中のファイル（残したもの）'), 'k-kept', (startList.kept || []).slice(0, 8).map((k) => ({
      name: k.name || '(名前なし)', path: k.original || '', open: !!k.open, title: `${k.original || ''}\nクリックで続きを開く`, go: () => api.editOpen?.({ path: k.dir }),
    })));
    const recent = (startList.recent || []).filter((d) => key(d) !== key(exclude)).slice(0, 10);
    listOf(W('recentFolders', '最近のフォルダ'), 'k-recent', recent.map((d) => ({ name: baseName(d) || d, path: d, open: openSet.has(key(d)), title: d, go: () => api.pickerOpen?.(d) })));
    if (!recent.length) p.append(h('div', 'dbx-start-empty', 'まだ開いたフォルダはありません。「フォルダを選ぶ…」で開けます'));
    return p;
  }

  // ---- あなたの番 -------------------------------------------------------------------------------
  // U3: main's attention list, one card per item in seq order (oldest first; a new one goes to the end, an answered
  // one closes up). Card: why (short word, full reason in the tooltip) · AT-12 見出し (or the tab name) · folder ·
  // elapsed, then the kind's answer part. Answered cards stay hidden here until main drops them (≤ 20 s).
  const ATTN_WORD = { confirm: '確認', question: '質問', qa: 'QA', proposal: '提案', nudge: '動かない', pmosend: 'PMO' };
  function turnBody(b) {
    const items = attnShown();
    const done = waitDone.filter((d) => Date.now() - d.at <= 10 * 60e3);
    if (done.length) {
      const p = h('div', 'dbx-attn-done');
      for (const d of done) {
        const r = h('div', 'dbx-wait-done');
        r.append(h('span', 'dbx-wait-ok', '✓ 答えました'), h('span', 'dbx-wait-where', `${d.folderName} / ${d.label || 'セッション'}`), h('span', 'dbx-wait-q', `「${firstLine(d.question).slice(0, 50)}」→ ${d.answer}`), h('span', 'dbx-wait-now', `今: ${nowText(d)}`));
        p.append(r);
      }
      b.append(p);
    }
    if (!items.length) {
      b.append(h('div', 'dbx-empty', folderSel.size && attn.length ? `絞り込みに合う${W('yourTurn', '要対応')}はありません` : `${W('yourTurn', '要対応')}はありません`));
      return;
    }
    const sec = P(h('section', 'dbx-sec dbx-attns'));
    for (const it of items) {
      try {
        sec.append(attnCard(it));
      } catch (err) {
        console.error('attention card failed', it && it.id, err);
      }
    }
    b.append(sec);
  }

  function attnCard(it) {
    const e = it.entry || null;
    const danger = it.kind === 'confirm' && !!(it.danger || (e && e.danger));
    const c = h('div', `dbx-attn k-${it.kind}${danger ? ' danger' : ''}${it.own ? ' own' : ''}`);
    c.dataset.id = it.id;
    const head = h('div', 'dbx-attn-head');
    const why = (it.why && typeof it.why === 'object' ? it.why : null) || {};
    const tag = h('span', 'dbx-attn-why', why.short || ATTN_WORD[it.kind] || it.kind);
    if (why.full) tag.title = why.full;
    head.append(tag);
    const name = h('span', 'dbx-attn-name', it.task ? taskName(it.task) : (it.kind === 'proposal' || it.kind === 'pmosend' ? it.title : '') || it.label || '');
    name.title = it.kind === 'pmosend' ? it.title || '' : [it.task ? firstLine(it.task.text || it.task.title) : '', it.label ? `タブ: ${it.label}` : ''].filter(Boolean).join('\n');
    head.append(name);
    if (it.folderName) {
      const f = h('span', 'dbx-attn-folder', it.folderName);
      if (it.folder) f.title = it.folder;
      head.append(f);
    }
    // the PMO's own session lives in the window that shows this dashboard: not a 振り分け window (AT-159)
    if (e && e.hidden && !it.own) {
      const hid = h('span', 'dbx-wait-hidden', '見えないウィンドウ');
      hid.title = '振り分けで動いている、画面に出ていないウィンドウのセッションです。ここから答えられます';
      head.append(hid);
    }
    const session = it.kind === 'confirm' || it.kind === 'question' || it.kind === 'nudge';
    // under a minute: 「1分未満待ち」 (ago() starts at 1分: a 2-second wait read 「1分待ち」, AT-159). No seconds that
    // would stand still
    // (UX6: the words follow the 30 s clock, tickAgo)
    const age = agoSpan(h('span', 'dbx-time dbx-attn-age', ''), it.since, session ? 'wait' : 'rel');
    if (it.since) age.title = md(it.since);
    head.append(age);
    const wcId = it.wcId ?? (e && e.wcId);
    const tabId = it.kind === 'nudge' ? it.tabKey : it.tabId ?? (e && e.tabId);
    if (session && tabId != null) {
      const open = h('button', 'dbx-link dbx-attn-open', '会話を開く');
      open.type = 'button';
      open.dataset.usage = 'dash.turn.open-session'; // UA1
      open.title = 'そのセッションのタブを開きます';
      open.addEventListener('click', () => api.dashboardFocus?.({ wcId, tabId, from: 'turn' })); // from: UA1 open.from.turn
      head.append(open);
    }
    c.append(head);
    if (it.kind === 'confirm' || it.kind === 'question') {
      if (e) c.append(waitRow({ ...e, danger: e.danger || it.danger || '' }));
      else c.append(h('div', 'dbx-wait-hint', '確認の中身を読めませんでした。会話を開いて答えてください'));
    } else if (it.kind === 'qa') {
      const qe = qaEntries.find((x) => x.key === it.qaKey) || { key: it.qaKey, folder: it.folder, rows: Array.isArray(it.rows) ? it.rows : [], status: 'open' };
      c.append(qaPanel(qe, '事前の QA', true));
    } else if (it.kind === 'proposal') {
      const n = notices.find((x) => x.id === it.noticeId) || { id: it.noticeId, kind: 'proposal', title: it.title || '', text: it.text || '', folder: it.folder, createdAt: it.since };
      const p = h('div', 'dbx-ntc k-proposal open');
      p.dataset.id = n.id;
      if (n.title) p.append(h('div', 'dbx-attn-title', n.title));
      if (n.text) p.append(noticeMd(n.text));
      p.append(proposalBar(n));
      c.append(p);
    } else if (it.kind === 'nudge') {
      if (it.waitText) c.append(h('div', 'dbx-attn-text', it.waitText));
      const bar = h('div', 'dbx-attn-bar');
      const watch = h('button', 'dbx-attn-dismiss', '様子を見る');
      watch.dataset.usage = 'dash.turn.watch'; // UA1
      watch.type = 'button';
      watch.title = 'もう少し待ちます（PMO の後押しを数え直します）';
      watch.addEventListener('click', async () => {
        watch.disabled = true;
        let ok = false;
        try {
          ok = !!(await api.attentionDismiss?.({ id: it.id }));
        } catch (err) {
          console.error(err);
        }
        if (ok) {
          attnSent.set(it.id, Date.now());
          armUnhide();
        } else watch.disabled = false;
        render();
        loadAttention().then(renderSoon);
      });
      bar.append(watch);
      c.append(bar);
    } else if (it.kind === 'pmosend') {
      // the PMO's queue (src/renderer/autosend.js): this window holds the PMO's session and its backlog
      c.append(h('div', 'dbx-attn-text', it.off ? '新しい依頼や完了の知らせが PMO に届かず、振り分けが止まっています。API エラーが続いたときは、時間をおいて「再開」してください' : 'PMO の会話が応答の途中のままか、送れる状態になっていません。会話を開いて確かめるか、「今すぐ送る」で待ちを解きます'));
      const bar = h('div', 'dbx-attn-bar');
      const B = window.Backlog;
      if (it.tabId && B && B.resumeAuto) {
        const go = h('button', 'dbx-attn-dismiss', it.off ? '再開' : '今すぐ送る');
        go.dataset.usage = 'dash.turn.pmo-resume'; // UA1
        go.type = 'button';
        go.title = it.off ? 'PMO への自動送信を戻します（待っている知らせが送られます）' : '送り直しの待ちを解きます（PMO が応答を終えたら送ります）';
        go.addEventListener('click', () => {
          go.disabled = true;
          try {
            B.resumeAuto(it.tabId);
            attnSent.set(it.id, Date.now());
            armUnhide();
          } catch (err) {
            console.error(err);
            go.disabled = false;
          }
          render();
          loadAttention().then(renderSoon);
        });
        bar.append(go);
      }
      c.append(bar);
    }
    return c;
  }

  // ---- プロジェクト -------------------------------------------------------------------------------
  function projBody(b, list) {
    const shown = list.filter((r) => passFolder(r.folder));
    if (projMode === 'agents' && window.AgentsView) {
      try {
        b.append(window.AgentsView.body(shown, { api, rerender: render }));
      } catch (err) {
        console.error('agents view failed', err);
        b.append(h('div', 'dbx-empty', '関係図の表示に失敗しました'));
      }
      return;
    }
    if (!shown.length) {
      b.append(h('div', 'dbx-empty', list.length ? '絞り込みに合うフォルダがありません' : 'まだフォルダがありません'));
      return;
    }
    if (queue && queue.line) {
      const nx = h('div', `dbx-qnext${queue.next ? '' : ' none'}`, queue.line);
      nx.title = '全部のフォルダの待ちのうち、空きが出たら最初に始めるタスク。ウィンドウが開いているフォルダから順に見ます。空きの数は上の「動いている N / 上限 M」';
      b.append(nx);
    }
    const sec = P(h('section', 'dbx-sec dbx-cards'));
    for (const r of shown) sec.append(folderRow(r));
    b.append(sec);
  }

  // ---- 依頼 ---------------------------------------------------------------------------------------
  // 対応中 (new / asking / routed / hold) | 対応履歴 (done / failed / dropped), grouped by status and folded; each group
  // shows GROUP_SHOWN rows then 「ほか N 件」. 対応履歴 shows the last RECENT_DAYS days, older ones as 「過去 N 件」.
  // Rows keep their place (creation order); a new request goes to the end of its group.
  function reqBody(b) {
    const byText = (it) => matchText(it, textFilter, textFilter.trim() ? reqNos(it) : null);
    const open = openReqs().filter(byText);
    const hist = inbox.filter((it) => !isOpenReq(it) && passFolder(it.folder) && byText(it));
    const sw = h('div', 'dbx-reqsw');
    for (const [v, label, n] of [['open', W('inboxOpen', '対応中'), open.length], ['hist', W('inboxHistory', '対応履歴'), hist.length]]) {
      const btn = h('button', `dbx-fchip${reqView === v ? ' on' : ''}`, `${label} ${n}`);
      btn.type = 'button';
      btn.dataset.req = v;
      btn.addEventListener('click', () => {
        if (reqView === v) return;
        reqView = v;
        store.set('dashReqView', v);
        tabScroll.req = 0;
        render();
        const bd = root.querySelector('.dbx-body');
        if (bd) bd.scrollTop = 0;
      });
      sw.append(btn);
    }
    b.append(sw);
    const asc = (a, c) => (a.createdAt || 0) - (c.createdAt || 0);
    const st = (s) => stWord('inbox', s, INBOX_JA[s]).short;
    if (reqView === 'open') {
      group(b, 'g-asking', st('asking'), open.filter((it) => it.status === 'asking').sort(asc), 'k-hot');
      group(b, 'g-unrouted', st('new'), open.filter((it) => it.status === 'new').sort(asc));
      group(b, 'g-routed', st('routed'), open.filter((it) => it.status === 'routed').sort(asc));
      group(b, 'g-hold', st('hold'), open.filter((it) => it.status === 'hold').sort(asc));
      if (!open.length) b.append(h('div', 'dbx-empty', textFilter || folderSel.size ? '絞り込みに合う依頼はありません' : `${W('inboxOpen', '対応中')}の依頼はありません`));
      return;
    }
    const since = Date.now() - RECENT_DAYS * 86400e3;
    const at = (it) => it.updatedAt || it.createdAt || 0;
    const recent = hist.filter((it) => at(it) >= since);
    const past = hist.filter((it) => at(it) < since);
    group(b, 'g-failed', st('failed'), recent.filter((it) => it.status === 'failed').sort(asc), 'k-bad');
    group(b, 'g-done', st('done'), recent.filter((it) => it.status === 'done').sort(asc));
    group(b, 'g-dropped', st('dropped'), recent.filter((it) => it.status === 'dropped').sort(asc));
    if (past.length) {
      const more = h('button', 'dbx-link dim dbx-past-btn', pastOpen ? `過去 ${past.length} 件を畳む` : `過去 ${past.length} 件`);
      more.type = 'button';
      more.title = `${RECENT_DAYS} 日より前に済んだ依頼`;
      more.addEventListener('click', () => {
        pastOpen = !pastOpen;
        render();
      });
      b.append(more);
      if (pastOpen) {
        // UX7: newest first, folded by date (30 日以内 / それより前), REQ_STEP rows at a time
        let from = since;
        for (const [fid, label, days] of PAST_FOLDS) {
          const to = days === Infinity ? -Infinity : Date.now() - days * 86400e3;
          const rows = past.filter((it) => at(it) < from && at(it) >= to).sort((a, c) => at(c) - at(a));
          from = to;
          if (!rows.length) continue;
          const ri = revealId ? rows.findIndex((it) => it.id === revealId) : -1;
          if (ri >= 0) {
            pastFold[fid] = true;
            if (ri >= REQ_STEP + (pastMore.get(fid) || 0)) pastMore.set(fid, Math.ceil((ri + 1 - REQ_STEP) / REQ_STEP) * REQ_STEP);
            revealId = '';
          }
          const open = !!pastFold[fid];
          const sec = P(h('section', `dbx-sec dbx-past dbx-group${open ? ' open' : ''}`));
          sec.dataset.group = `past-${fid}`;
          const head = h('button', 'dbx-group-head dbx-past-head');
          head.type = 'button';
          head.append(h('span', 'dbx-caret', open ? '▾' : '▸'), document.createTextNode(label), h('span', 'dbx-group-n', String(rows.length)));
          head.addEventListener('click', () => {
            pastFold[fid] = !pastFold[fid];
            render();
          });
          sec.append(head);
          if (open) moreRows(sec, rows, REQ_STEP, pastMore, fid, inboxRow);
          b.append(sec);
        }
      }
    }
    if (!hist.length) b.append(h('div', 'dbx-empty', '済んだ依頼はまだありません'));
  }

  // a folded status group: 「▸ 受付 12」; open ones list GROUP_SHOWN rows, the rest behind 「ほか N 件」
  function group(b, id, label, items, cls = '') {
    if (!items.length) return;
    const open = groupOpen[id] ?? GROUP_DEFAULT[id] ?? true;
    const sec = P(h('section', `dbx-sec dbx-group ${cls}${open ? ' open' : ''}`));
    sec.dataset.group = id;
    const head = h('button', 'dbx-group-head');
    head.type = 'button';
    head.append(h('span', 'dbx-caret', open ? '▾' : '▸'), document.createTextNode(label), h('span', 'dbx-group-n', String(items.length)));
    head.addEventListener('click', () => {
      groupOpen[id] = !open;
      store.set('dashGroups', groupOpen);
      render();
    });
    sec.append(head);
    if (open) {
      const ri = revealId ? items.findIndex((it) => it.id === revealId) : -1;
      if (ri >= 0) {
        if (ri >= GROUP_SHOWN + (groupMore.get(id) || 0)) groupMore.set(id, Math.ceil((ri + 1 - GROUP_SHOWN) / REQ_STEP) * REQ_STEP);
        revealId = '';
      }
      moreRows(sec, items, GROUP_SHOWN, groupMore, id, inboxRow, REQ_STEP);
    }
    b.append(sec);
  }

  // UX7: the first `first` rows (+ what was opened, more.get(id)), then 「ほか N 件」 (opens `step` more) and, once
  // opened, 「畳む」. The buttons carry data-k so the patch keeps them (and the rows) through redraws.
  function moreRows(sec, items, first, more, id, rowFn, step = first, word = '') {
    const n = Math.min(items.length, first + (more.get(id) || 0));
    for (const it of items.slice(0, n)) sec.append(rowFn(it));
    if (items.length <= first) return;
    const bar = h('div', 'dbx-morebar');
    bar.dataset.k = `more:${id}`;
    if (n < items.length) {
      const rest = items.length - n;
      const b = h('button', 'dbx-link dim dbx-more', `ほか ${rest} 件${word}`);
      b.type = 'button';
      b.dataset.more = id;
      if (rest > step) b.title = `${step} 件ずつ開きます`;
      b.addEventListener('click', () => {
        more.set(id, (more.get(id) || 0) + step);
        render();
      });
      bar.append(b);
    }
    if (n > first) {
      const c = h('button', 'dbx-link dim dbx-fold', '畳む');
      c.type = 'button';
      c.dataset.fold = id;
      c.addEventListener('click', () => {
        more.delete(id);
        render();
      });
      bar.append(c);
    }
    sec.append(bar);
  }

  // backlog items routed for an inbox item (r-<inboxId>-<hex>, manager.js route), any folder: [{ folder, it }]
  // + the ones tied by the PMO's link action (inbox item links: [{ folder, backlogId }]; requests routed before U1 have
  // only 依頼-N, their task numbers come from here). inbox.json is not rewritten.
  function routedTasks(inboxId, links = []) {
    const pre = `r-${inboxId}-`;
    const out = [];
    for (const f of folders) {
      for (const it of f.backlog || []) {
        const linked = links.some((l) => l && l.backlogId === it.id && key(l.folder) === key(f.folder));
        if (String(it.id || '').startsWith(pre) || linked) out.push({ folder: f.folder, it });
      }
    }
    return out;
  }

  // the task numbers (AT-n) of the backlog items a request was routed to (same rule as the row's 「→ folder AT-n」)
  const reqNos = (it) => (it.status === 'new' ? [] : routedTasks(it.id, Array.isArray(it.links) ? it.links : []).map((x) => taskNo(x.it)).filter(Boolean));

  // ---- PMO の記録 ---------------------------------------------------------------------------------
  // U4: main's merged log (pmoLog), newest first: time | kind | folder + one-line title; a click unfolds the detail
  // (Markdown, same sanitizer as the notices). Kind chips (すべて + the kinds present, several can be chosen, saved in
  // dashLogKinds) above the rows; the folder and text filters apply too. No read / unread.
  const LOG_SHOWN = 100;
  const LOG_ORDER = ['push', 'route', 'order', 'fix', 'clean', 'done', 'release', 'handoff', 'info', 'warn'];
  const logKindOrder = () => {
    const t = L() && L().LOG_KIND ? Object.keys(L().LOG_KIND) : [];
    return [...t, ...LOG_ORDER.filter((k) => !t.includes(k))];
  };
  const hm = (ts) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  // HH:MM today, else M/D HH:MM
  const logTime = (ts) => {
    if (!ts) return '';
    return new Date(ts).toDateString() === new Date().toDateString() ? hm(ts) : md(ts);
  };
  function logBody(b) {
    const base = logList()
      .filter((e) => matchText({ title: e.title, text: e.text, folder: e.folder }, textFilter))
      .sort((a, c) => (c.at || 0) - (a.at || 0));
    // the chips: the kinds present (in the table's order) and the chosen ones even when none is left
    const present = new Set(base.map((e) => e.kind));
    const kinds = logKindOrder().filter((k) => present.has(k) || logKinds.has(k));
    for (const k of present) if (!kinds.includes(k)) kinds.push(k);
    const list = logKinds.size ? base.filter((e) => logKinds.has(e.kind)) : base;
    if (base.length || logKinds.size) {
      const bar = h('div', 'dbx-log-kinds');
      const saveKinds = () => store.set('dashLogKinds', [...logKinds]);
      const chip = (label, on, title, k, fn) => {
        const c = h('button', `dbx-fchip dbx-log-kind${on ? ' on' : ''}`, label);
        c.type = 'button';
        c.dataset.kind = k;
        c.setAttribute('aria-pressed', String(on));
        if (title) c.title = title;
        c.addEventListener('click', () => {
          fn();
          saveKinds();
          logShowAll = false;
          render();
        });
        bar.append(c);
      };
      chip('すべて', !logKinds.size, '種類で絞らない', '', () => logKinds.clear());
      for (const k of kinds) {
        const w = stWord('log', k, k);
        chip(w.short, logKinds.has(k), w.full, k, () => {
          if (logKinds.has(k)) logKinds.delete(k);
          else logKinds.add(k);
        });
      }
      b.append(bar);
    }
    if (!list.length) {
      b.append(h('div', 'dbx-empty', textFilter || folderSel.size || logKinds.size ? '絞り込みに合う記録はありません' : 'まだ記録はありません'));
      return;
    }
    const sec = P(h('section', 'dbx-sec dbx-log'));
    const units = logUnits(list);
    const shown = logShowAll ? units : units.slice(0, LOG_SHOWN);
    for (const u of shown) sec.append(Array.isArray(u) ? logRun(u) : logRow(u));
    if (units.length > LOG_SHOWN) {
      const more = h('button', 'dbx-link dim dbx-log-more', logShowAll ? '畳む' : `ほか ${units.length - LOG_SHOWN} 件`);
      more.type = 'button';
      more.addEventListener('click', () => {
        logShowAll = !logShowAll;
        render();
      });
      sec.append(more);
    }
    b.append(sec);
  }

  // UX7 (§5.2): consecutive automatic rows (振り分け・順番) of one kind, none refused, each within LOG_RUN_GAP of the
  // next, LOG_RUN_MIN or more -> one unit (an array, newest first); every other entry stays a unit of its own
  function logUnits(list) {
    const out = [];
    let run = [];
    const flush = () => {
      if (run.length >= LOG_RUN_MIN) out.push(run);
      else out.push(...run);
      run = [];
    };
    for (const e of list) {
      const auto = LOG_AUTO.has(e.kind) && !e.bad;
      const prev = run[run.length - 1];
      if (auto && prev && prev.kind === e.kind && (prev.at || 0) - (e.at || 0) <= LOG_RUN_GAP) run.push(e);
      else {
        flush();
        if (auto) run.push(e);
        else out.push(e);
      }
    }
    flush();
    return out;
  }
  // 「05:12〜05:20 振り分け 12 件」; a click shows its rows (drawn only while open). Keyed by the run's oldest entry, which
  // stays when newer entries join the run.
  function logRun(run) {
    const last = run[run.length - 1];
    const id = `run:${last.kind}:${last.id}`;
    const open = logRunOpen.has(id);
    const box = h('div', `dbx-log-run k-${last.kind}${open ? ' open' : ''}`);
    box.dataset.k = id;
    box.dataset.kind = String(last.kind || '');
    box.dataset.n = String(run.length);
    const head = h('button', 'dbx-log-head dbx-log-runhead');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open));
    const t0 = logTime(last.at);
    const t1 = run[0].at ? hm(run[0].at) : '';
    head.append(h('span', 'dbx-time dbx-log-time', t1 && t1 !== t0 ? `${t0}〜${t1}` : t0));
    const w = stWord('log', last.kind, last.kind);
    const tag = h('span', 'dbx-log-tag', w.short);
    if (w.full) tag.title = w.full;
    const fl = [...new Set(run.map((e) => (e.folder ? baseName(e.folder) : '')).filter(Boolean))];
    head.append(tag, h('span', 'dbx-log-title', `${run.length} 件${fl.length ? `（${fl.slice(0, 3).join('・')}${fl.length > 3 ? ' ほか' : ''}）` : ''}`));
    head.title = `${open ? 'クリックで畳む' : 'クリックで中身を開く'}（自動の記録をまとめています）`;
    head.addEventListener('click', () => {
      if (logRunOpen.has(id)) logRunOpen.delete(id);
      else logRunOpen.add(id);
      render();
    });
    box.append(head);
    if (open) {
      const inner = h('div', 'dbx-log-runrows');
      for (const e of run) inner.append(logRow(e));
      box.append(inner);
    }
    return box;
  }

  function logRow(e) {
    const id = String(e.id);
    const text = String(e.text || '');
    const open = !!text && logOpen.has(id);
    const r = h('div', `dbx-log-row k-${e.kind}${e.bad ? ' bad' : ''}${text ? ' has-text' : ''}${open ? ' open' : ''}`);
    r.dataset.kind = String(e.kind || '');
    r.dataset.type = String(e.type || '');
    r.dataset.id = id;
    const head = h(text ? 'button' : 'div', 'dbx-log-head');
    if (text) {
      head.type = 'button';
      head.setAttribute('aria-expanded', String(open));
      head.addEventListener('click', () => {
        if (logOpen.has(id)) logOpen.delete(id);
        else logOpen.add(id);
        render();
      });
    }
    const tm = h('span', 'dbx-time dbx-log-time', logTime(e.at));
    if (e.at) tm.title = new Date(e.at).toLocaleString('ja-JP');
    head.append(tm);
    const w = stWord('log', e.kind, e.kind);
    const tag = h('span', 'dbx-log-tag', w.short);
    if (w.full) tag.title = w.full;
    head.append(tag);
    const t = h('span', 'dbx-log-title');
    // the folder's name first (unless the title starts with it), or the request's number when it points at one without a
    // folder; clicking it shows the request (itemId) / the folder's card
    const fname = e.folder ? baseName(e.folder) : '';
    const title = String(e.title || firstLine(text) || '');
    const item = e.itemId ? inbox.find((i) => i.id === e.itemId) || null : null;
    const label = fname && !title.startsWith(fname) ? fname : !fname && item ? taskNo(item) || W('inbox', '依頼') : '';
    if (label) {
      const go = h('span', 'dbx-log-go', label);
      if (e.itemId) go.dataset.item = String(e.itemId);
      go.title = [e.folder, `クリックでその${item ? W('inbox', '依頼') : W('projects', 'プロジェクト')}へ`].filter(Boolean).join('\n');
      go.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!goTo({ itemId: e.itemId || null, folder: e.folder }) && e.folder) api.pickerOpen?.(e.folder);
      });
      t.append(go, document.createTextNode(' '));
    }
    t.append(document.createTextNode(title));
    t.title = title;
    head.append(t);
    if (e.bad) {
      const bad = h('span', 'dbx-log-bad');
      bad.title = '断られた・失敗した';
      head.append(bad);
    }
    r.append(head);
    if (open) r.append(noticeMd(text));
    return r;
  }

  // A request: status word · number · date · → folder AT-n | title | the flow 受付 → 振り分け → AT-3 動作中・AT-4 待ち.
  // 取り下げ / 受付に戻す / 元に戻す are in the row menu (⋯).
  function inboxRow(it) {
    const r = h('div', `dbx-inbox st-${it.status}`);
    r.dataset.id = it.id; // 「PMO の記録」 links scroll here
    if (flashing(`.dbx-inbox[data-id="${CSS.escape(it.id)}"]`)) r.classList.add('dbx-flash');
    const word = stWord('inbox', it.status, INBOX_JA[it.status]);
    const stEl = h('span', 'dbx-ist', word.short);
    if (word.full) stEl.title = word.full;
    r.append(stEl);
    // one line: number + title | → folder AT-n · date · marks · ⋯ (the flow / hold reason under it when there is one)
    const mid = h('div', 'dbx-imid');
    const tasks = it.status === 'new' ? [] : routedTasks(it.id, Array.isArray(it.links) ? it.links : []);
    const t = h('div', 'dbx-ititle');
    if (it.reqNo) t.append(h('span', 'dbx-ino', it.reqNo));
    t.append(document.createTextNode(it.title || taskTitle(it) || firstLine(it.text)));
    t.title = it.text;
    mid.append(t);
    // the flow, while it is being worked on
    if (it.status === 'routed' && tasks.length) {
      const flow = h('div', 'dbx-iflow');
      flow.append(document.createTextNode(`${stWord('inbox', 'new', '受付').short} → 振り分け → `));
      tasks.forEach((x, i) => {
        if (i) flow.append(document.createTextNode('・'));
        const s = stWord('backlog', x.it.status, x.it.status);
        const el = h('span', `dbx-iflow-t st-${x.it.status}`, `${taskNo(x.it) || taskTitle(x.it)} ${s.short}`);
        el.title = `${taskName(x.it)}\n${s.full}`;
        flow.append(el);
      });
      mid.append(flow);
    }
    if (it.note && it.status === 'hold') {
      const n = h('div', 'dbx-inote', firstLine(it.note).slice(0, 60));
      n.title = `保留の理由: ${it.note}`;
      mid.append(n);
    }
    r.append(mid);
    // MP4 21: fixed cells (folder | date | marks | ⋯, dashboard.css .dbx-iside), empty ones kept, so the dates line up
    const side = h('div', 'dbx-iside');
    if (it.folder || tasks.length) {
      const f = h('span', 'dbx-ifolder', `→ ${baseName(it.folder || tasks[0].folder)}${tasks.length ? ` ${tasks.map((x) => taskNo(x.it)).filter(Boolean).join(' / ')}` : it.no ? ` ${it.no}` : ''}`);
      f.title = `${f.textContent}\n${it.folder || tasks[0].folder}`;
      side.append(f);
    } else side.append(h('span', 'dbx-islot'));
    const date = h('span', 'dbx-idate', md(it.createdAt));
    date.title = `受付 ${new Date(it.createdAt || 0).toLocaleString('ja-JP')}${it.updatedAt ? `\n更新 ${new Date(it.updatedAt).toLocaleString('ja-JP')}` : ''}`;
    side.append(date);
    const imarks = h('span', 'dbx-imarks');
    const pmoMark = pmoMarkOf(it);
    if (pmoMark) imarks.append(pmoMark);
    const sesMark = sessionMarkOf(it);
    if (sesMark) imarks.append(sesMark);
    const qe = it.status === 'new' || it.status === 'asking' || it.status === 'hold' ? qaForInbox(it.id) : null;
    if (qe) imarks.append(qaMark(qe));
    const sf = staleOf('inbox', it.id);
    if (sf) imarks.append(staleMark(sf));
    side.append(imarks);
    // the row menu: what the user can still do with this request
    const acts = [];
    if (it.status === 'new' || it.status === 'asking') acts.push(['取り下げる', '依頼をやめる（取り下げ）', { status: 'dropped' }]);
    if (it.status === 'hold') acts.push(['受付に戻す', '保留をやめ、PMO に振り分けてもらう', { status: 'new' }]);
    if (OPEN_REQ.includes(it.status)) acts.push(['見出しを直す', '一覧に出す短い見出しを直す（空なら本文の先頭から）', 'title']);
    // once the work is routed / finished, only a rewrite can be undone (undoing the add / link would part the
    // inbox item from its backlog work)
    const undoable = (it.history || []).filter((e) => e.undo).pop();
    if (undoable && (['new', 'asking', 'hold', 'dropped'].includes(it.status) || undoable.action === 'edit')) {
      acts.push(['元に戻す', `PMO の「${HISTORY_JA[undoable.action] || undoable.action}」を取り消す${undoable.note ? `（${undoable.note}）` : ''}`, 'undo']);
    }
    if (acts.length) {
      const m = h('button', `dbx-link dim dbx-imenu${reqMenu === it.id ? ' on' : ''}`, '⋯');
      m.type = 'button';
      m.title = acts.map((a) => a[0]).join('・');
      m.setAttribute('aria-expanded', String(reqMenu === it.id));
      m.addEventListener('click', () => {
        reqMenu = reqMenu === it.id ? '' : it.id;
        render();
      });
      side.append(m);
    } else side.append(h('span', 'dbx-islot'));
    r.append(side);
    if (acts.length && reqMenu === it.id) {
      const menu = h('div', 'dbx-imenu-list');
      for (const [label, title, what] of acts) {
        const b = h('button', 'dbx-link', label);
        b.type = 'button';
        b.title = title;
        b.addEventListener('click', async () => {
          if (what === 'title') {
            titleEdit = it.id;
            reqMenu = '';
            render();
            root.querySelector('.dbx-ititle-input')?.focus();
            return;
          }
          reqMenu = '';
          if (what === 'undo') await api.inboxUndo?.({ id: it.id });
          else await api.inboxUpdate?.({ id: it.id, patch: what });
          refresh();
        });
        menu.append(b);
      }
      r.append(menu);
    }
    if (titleEdit === it.id) r.append(titleBox(it));
    if (qe && qaOpen.has(qe.key)) r.append(qaPanel(qe, '事前の QA'));
    return r;
  }

  // the heading of a request (Enter saves, Esc cancels; empty = made from the text again). Same as the backlog panel's field.
  let titleEdit = '';
  const titleDrafts = new Map();
  function titleBox(it) {
    const row = h('div', 'dbx-imenu-list dbx-ititle-edit');
    const box = h('input', 'dbx-ititle-input');
    box.type = 'text';
    box.dataset.id = it.id;
    box.maxLength = 60;
    box.value = titleDrafts.has(it.id) ? titleDrafts.get(it.id) : it.title || '';
    box.placeholder = (L() && L().provisionalTitle ? L().provisionalTitle(it.text) : firstLine(it.text).slice(0, 20)) || '見出し';
    const close = () => {
      titleEdit = '';
      titleDrafts.delete(it.id);
      render();
    };
    const save = async () => {
      const v = box.value.trim();
      titleEdit = '';
      titleDrafts.delete(it.id);
      try {
        await api.inboxUpdate?.({ id: it.id, patch: { title: v } });
      } catch (err) {
        console.error(err);
      }
      refresh();
    };
    box.addEventListener('input', () => titleDrafts.set(it.id, box.value));
    box.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') close();
    });
    const ok = h('button', 'dbx-link', '保存');
    ok.type = 'button';
    ok.addEventListener('click', save);
    const no = h('button', 'dbx-link dim', 'やめる');
    no.type = 'button';
    no.addEventListener('click', close);
    row.append(box, ok, no);
    return row;
  }

  // 「PMO」 mark on an inbox item the manager added or changed; the tooltip is its change history (+ the original text).
  // An item the app added (source 'app', e.g. the AT-carryover import) gets 「アプリ」 instead, so it does not read as the PMO's.
  function pmoMarkOf(it) {
    const hist = it.history || [];
    const byApp = it.source === 'app';
    if (it.source !== 'manager' && !byApp && !hist.length) return null;
    const el = h('span', byApp ? 'dbx-pmo dbx-app' : 'dbx-pmo', byApp ? 'アプリ' : 'PMO');
    const lines = hist.map((e) => `${e.at ? new Date(e.at).toLocaleString('ja-JP') : ''} ${HISTORY_JA[e.action] || e.action}${e.note ? `: ${e.note}` : ''}`);
    if (byApp) lines.unshift('アプリが追加（積み残しの取り込みなど）');
    else if (it.source === 'manager' && !hist.some((e) => e.action === 'add')) lines.unshift('PMO が追加');
    if (it.originalText) lines.push('', '書き直す前の本文:', it.originalText.slice(0, 600));
    el.title = lines.join('\n');
    return el;
  }

  // 「セッションから」 (UIUX U7): a request a routed session proposed (src/main/propose.js). The tooltip says which work
  // proposed it and why; a click opens that session (its folder's window when the session id is not known).
  function sessionMarkOf(it) {
    if (it.source !== 'session') return null;
    const o = it.origin || {};
    const el = h('button', 'dbx-pmo dbx-ses', 'セッションから');
    el.type = 'button';
    const who = [baseName(o.folder || it.folder || ''), o.no || ''].filter(Boolean).join(' ');
    el.title = [`${who || 'セッション'} が出した次にやること`, o.reason ? `理由: ${o.reason}` : '', o.tabId || o.folder ? 'クリックで出したセッションを開く' : ''].filter(Boolean).join('\n');
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const folder = o.folder || it.folder;
      if (!folder) return;
      if (o.tabId) api.dashboardOpenSession?.({ folder, tabId: o.tabId });
      else api.pickerOpen?.(folder);
    });
    return el;
  }

  // ---- 「PMO から」 ---------------------------------------------------------------------------
  // Markdown body (marked + DOMPurify, same profile as the conversation view); links open in the browser.
  function noticeMd(text) {
    const el = h('div', 'dbx-ntc-md');
    const raw = String(text || '');
    if (window.marked && window.DOMPurify) {
      try {
        // J8: the sanitized HTML by its text (once per text, not once per redraw)
        let html = mdCache.get(raw);
        if (html === undefined) {
          html = window.DOMPurify.sanitize(window.marked.parse(raw, { gfm: true, breaks: true, async: false }), {
            USE_PROFILES: { html: true },
            FORBID_TAGS: ['img', 'style', 'form', 'input', 'button', 'textarea', 'select'],
            FORBID_ATTR: ['style', 'id', 'name', 'class'],
            SANITIZE_NAMED_PROPS: true,
          });
          if (mdCache.size >= MD_KEEP) mdCache.delete(mdCache.keys().next().value);
          mdCache.set(raw, html);
        }
        el.innerHTML = html;
      } catch (err) {
        console.error(err);
        el.textContent = raw;
      }
    } else el.textContent = raw;
    el.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) api.openExternal?.(href);
    });
    for (const a of el.querySelectorAll('a[href]')) a.title = a.getAttribute('href');
    return el;
  }

  // Shows the row a notice points at (a request on the 依頼 tab, else the folder's card on プロジェクト) and flashes it.
  // The flash is state (flashSel until flashUntil), not only a class on the element, because a redraw replaces the row.
  let flashSel = '';
  let flashUntil = 0;
  const flashing = (sel) => sel === flashSel && Date.now() < flashUntil;
  function goTo(n) {
    const it = n.itemId ? inbox.find((i) => i.id === n.itemId) : null;
    let sel = '';
    if (it) {
      // its tab, its 対応中 / 対応履歴 view and its group open, all rows of the group shown, no filter hiding it
      tab = 'req';
      reqView = OPEN_REQ.includes(it.status) ? 'open' : 'hist';
      const gid = { asking: 'g-asking', new: 'g-unrouted', routed: 'g-routed', hold: 'g-hold', failed: 'g-failed', done: 'g-done', dropped: 'g-dropped' }[it.status];
      if (gid) {
        groupOpen[gid] = true;
      }
      revealId = it.id; // group() / the 過去 folds open as far as its row
      pastOpen = true;
      textFilter = '';
      if (folderSel.size && !passFolder(it.folder)) folderSel.clear();
      sel = `.dbx-inbox[data-id="${CSS.escape(it.id)}"]`;
    } else if (n.folder) {
      tab = 'proj';
      projMode = 'cards';
      if (folderSel.size && !passFolder(n.folder)) folderSel.clear();
      sel = `.dbx-folder[data-folder="${CSS.escape(key(n.folder))}"]`;
    }
    if (!sel) return false;
    tabChosen = true;
    store.set('dashTab', tab);
    flashSel = sel;
    flashUntil = Date.now() + 1600;
    render();
    const el = root.querySelector(sel);
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => {
      if (Date.now() >= flashUntil) root.querySelectorAll('.dbx-flash').forEach((x) => x.classList.remove('dbx-flash'));
    }, 1700);
    return true;
  }

  // 「進める」「却下」 + a short comment. The answer goes to the manager agent's backlog (notices:answer).
  function proposalBar(n) {
    const bar = h('div', 'dbx-ntc-bar');
    const box = h('textarea', 'dbx-ntc-input');
    box.rows = 1;
    box.dataset.id = n.id;
    box.placeholder = 'ひとこと（任意）';
    box.value = noticeDrafts.get(n.id) || '';
    const keep = () => {
      noticeDrafts.set(n.id, box.value);
      noticeNotes.delete(n.id);
    };
    box.addEventListener('input', keep);
    box.addEventListener('compositionend', keep);
    const send = async (choice) => {
      let res = null;
      try {
        res = await api.noticesAnswer?.({ id: n.id, choice, comment: String(noticeDrafts.get(n.id) || box.value || '') });
      } catch (err) {
        console.error(err);
      }
      if (res) {
        noticeDrafts.delete(n.id);
        noticeNotes.delete(n.id);
        setNotices(notices.map((x) => (x.id === n.id ? res : x)));
        unsig('notices');
      } else noticeNotes.set(n.id, '送れませんでした');
      render();
    };
    const go = h('button', 'dbx-ntc-go-btn', '進める');
    go.type = 'button';
    go.dataset.usage = 'dash.notice.go'; // UA1
    go.title = 'PMO に「進める」と伝えます（作業として振り分けられます）';
    go.addEventListener('click', () => send('go'));
    const no = h('button', 'dbx-link dim', '却下');
    no.type = 'button';
    no.dataset.usage = 'dash.notice.reject'; // UA1
    no.title = 'PMO に「却下」と伝えます';
    no.addEventListener('click', () => send('reject'));
    bar.append(box, go, no);
    if (noticeNotes.has(n.id)) bar.append(h('span', 'dbx-qa-note', noticeNotes.get(n.id)));
    return bar;
  }

  function setNotices(list) {
    if (!Array.isArray(list)) return;
    notices = list;
    ver.notices++;
    for (const id of [...noticeDrafts.keys()]) if (!notices.some((n) => n.id === id && !n.answer)) noticeDrafts.delete(id);
    // U4: no desktop notification from here (main's attention raises one when あなたの番 grows; 指摘 are in PMO の記録)
  }

  // A folder card (プロジェクト tab): name (opens the folder; drag to reorder), the progress band and counts, PROGRESS.md
  // line | the task rows 「AT-3 見出し」 with their state | the PMO's outlook (slot; filled by a later stage).
  // Rows keep their place: tasks in creation order, then the sessions without a task in the order they were first seen.
  // UIUX U8: 「すべて完了」 (the review found nothing more) / 「見直し中」 on the card; projects.json review
  function reviewMark(rv) {
    if (!rv) return null;
    if (rv.status === 'allDone') {
      const el = h('div', 'dbx-alldone', W('allDone', 'すべて完了'));
      el.title = `見直しで次の作業が出なかった${rv.at ? `（${rel(rv.at)}）` : ''}。新しい依頼が来たら外れる`;
      return el;
    }
    if (rv.status === 'running') {
      const el = h('div', 'dbx-alldone reviewing', `${W('reviewing', '見直し中')}（${rv.round || 1} 回目）`);
      el.title = '作業が全部終わったので、アプリが見直しの作業を積んだ（続けて 3 回まで）';
      return el;
    }
    if (rv.status === 'stopped') {
      const el = h('div', 'dbx-alldone stopped', `見直し ${rv.round || 3} 回で止めた`);
      el.title = '見直しのたびに次の作業が出たので、続けての見直しを止めた。続けるかはユーザーの判断（PMO が聞く）';
      return el;
    }
    return null;
  }
  function folderRow(r) {
    const card = P(h('div', `dbx-folder dbx-card k-${r.kind}${r.open ? '' : ' closed'}`));
    const fk = key(r.folder);
    card.dataset.folder = fk; // 「PMO の記録」 links scroll here
    if (flashing(`.dbx-folder[data-folder="${CSS.escape(fk)}"]`)) card.classList.add('dbx-flash');
    dragTarget(card, fk);
    // left: name, band, counts
    const fc = P(h('div', 'dbx-fcell'));
    const name = h('button', 'dbx-fname');
    name.type = 'button';
    name.append(h('span', 'dbx-dot'), document.createTextNode(baseName(r.folder)));
    name.title = `${r.folder}\nクリックでフォルダを開く。ドラッグで並べ替え`;
    name.draggable = true;
    name.addEventListener('dragstart', (e) => {
      dragKey = fk;
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', fk);
      } catch {}
    });
    name.addEventListener('dragend', () => {
      dragKey = '';
      root.querySelectorAll('.dbx-card.drop').forEach((x) => x.classList.remove('drop'));
    });
    name.addEventListener('click', () => api.pickerOpen?.(r.folder));
    fc.append(name);
    const live = r.backlog.filter((i) => i.status !== 'dropped');
    if (live.length) fc.append(progressBand(r));
    const counts = [
      [W('done', '完了'), r.done.length],
      [W('running', '動作中'), r.active.length],
      [W('queue', '待ち'), r.pending.length],
      [W('failed', '失敗'), r.failed.length],
    ].filter(([, n]) => n);
    const meta = h('div', 'dbx-fmeta', counts.map(([w, n]) => `${w} ${n}`).join(' · ') || (r.open ? '' : '閉じている'));
    meta.title = [r.open ? 'ウィンドウが開いている' : 'ウィンドウは閉じている', r.last ? `最後の動き ${rel(r.last)}` : ''].filter(Boolean).join('\n');
    fc.append(meta);
    const rm = reviewMark(r.review);
    if (rm) fc.append(rm);
    if (r.progress && window.ProgressView) fc.append(ProgressView.line(r.progress, { id: fk, onToggle: render })); // PROGRESS.md
    if (r.progress && api.carryoverImport) fc.append(carryoverButton(r.folder)); // AT-carryover: open rows -> 依頼 (hold)
    card.append(fc);
    // middle: the tasks (and sessions without one)
    const tc = P(h('div', 'dbx-qcell dbx-tasks'));
    const since = Date.now() - RECENT_DAYS * 86400e3;
    const sessByTab = new Map(r.sessions.map((s) => [s.tabId, s]));
    const doneOpen = r.done.filter((i) => i.tabId && sessByTab.has(i.tabId));
    // newest finished first; items finished in the same millisecond (one tick ends several) by the later one in the
    // queue (created later, then listed later), so the 3 shown do not depend on the sort's tie order (49 H1)
    const doneRank = new Map(r.done.map((i, k) => [i, k]));
    const newerDone = (a, b) => (b.doneAt || 0) - (a.doneAt || 0) || (b.createdAt || 0) - (a.createdAt || 0) || (doneRank.get(b) ?? -1) - (doneRank.get(a) ?? -1);
    // UX7: CARD_SHOWN rows per state (動作中 / 待ち / 失敗 / 完了), the rest behind 「ほか N 件」 (CARD_STEP more per click)
    const lim = (st) => CARD_SHOWN + (cardMore.get(`${fk}|${st}`) || 0);
    const doneAll = [...new Set([...doneOpen.sort(newerDone), ...r.done.filter((i) => (i.doneAt || 0) >= since).sort(newerDone)])];
    const qf = queueOf(r.folder); // the waiting tasks in the order they are sent (queue:order), drawn in their own block
    const failedNew = r.failed.slice().reverse(); // the latest first
    const per = [
      ['active', r.active, W('running', '動作中')],
      ['pending', qf ? [] : r.pending, W('queue', '待ち')],
      ['failed', failedNew, W('failed', '失敗')],
      ['done', doneAll, W('done', '完了')],
    ];
    const shown = [...new Set(per.flatMap(([st, list]) => list.slice(0, lim(st))))].sort(byTask);
    // a session belongs to the active item on its tab, else to the newest finished one
    const tied = new Map(); // item id -> session
    const used = new Set();
    for (const it of [...shown].sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || newerDone(a, b))) {
      const s = it.tabId != null ? sessByTab.get(it.tabId) : null;
      if (s && !used.has(s.tabId)) {
        tied.set(it.id, s);
        used.add(s.tabId);
      }
    }
    for (const it of shown) tc.append(taskRow(r, it, tied.get(it.id) || null));
    for (const [st, list, word] of per) if (list.length > CARD_SHOWN) tc.append(cardMoreBar(fk, st, list.length, word));
    if (qf) {
      if (r.pending.length || qf.lastReorder || qf.orderLock || qAsk.has(fk) || qNotes.has(fk)) tc.append(queueBlock(r, qf));
    }
    const loose = r.sessions.filter((s) => !used.has(s.tabId)).sort(bySeen);
    const looseLive = loose.filter((s) => !REST_JA[s.kind]);
    const looseRest = loose.filter((s) => REST_JA[s.kind]);
    for (const s of looseLive.slice(0, 6)) tc.append(taskRow(r, null, s));
    if (looseLive.length > 6) tc.append(h('div', 'dbx-none', `ほか ${looseLive.length - 6} セッション`));
    for (const s of looseRest.slice(0, 3)) tc.append(taskRow(r, null, s));
    if (looseRest.length > 3) tc.append(h('div', 'dbx-none', `ほか${W('done', '完了')} ${looseRest.length - 3}`));
    const hidden = r.backlog.filter((it) => !shown.includes(it) && staleOf('backlog', it.id, r.folder)).length;
    if (hidden) tc.append(h('div', 'dbx-none dbx-stale-more', `ほかに${W('stalled', '止まって')}いるもの ${hidden} 件`));
    if (!tc.childNodes.length) tc.append(h('div', 'dbx-none', '—'));
    card.append(tc);
    // right: the PMO's outlook (projects.json outlook; U2 only makes the place)
    const ol = h('div', `dbx-outlook${r.outlook ? '' : ' empty'}`);
    if (r.outlook) ol.append(h('div', 'dbx-outlook-t', 'PMO の見立て'), h('div', 'dbx-outlook-b', r.outlook));
    card.append(ol);
    const pt = r.progress && window.ProgressView ? ProgressView.table(r.progress, { id: fk }) : null;
    if (pt) card.append(pt); // expanded PROGRESS.md table, full width under the card
    // open QA tables of this folder's waiting items: full width under the card
    for (const it of r.pending) {
      const e = qaForBacklog(r.folder, it.id);
      if (e && qaOpen.has(e.key)) card.append(qaPanel(e, `事前の QA — ${taskName(it)}`));
    }
    return card;
  }
  // AT-carryover: PROGRESS.md の未完了の行（と docs/roadmap.md の PROGRESS.md に無い行）を依頼に保留で出し、PMO に仕分けさせる。
  // 取り込み済み・依頼にある・バックログにある番号は出ない（main の carryover:import）。
  // The result text is kept per folder for 4 s across redraws (the new inbox items redraw the cards right away, NG 2d).
  const carryoverShown = new Map(); // key(folder) -> { text: string|null (null while importing), until }
  const CARRYOVER_LABEL = '取り込む';
  function carryoverButton(folder) {
    const k = key(folder);
    const b = h('button', 'dbx-link dbx-carryover', CARRYOVER_LABEL);
    b.type = 'button';
    b.title = '積み残しを取り込む: PROGRESS.md の 進行中・確認待ち・保留・未着手 の行を、依頼に保留で出して PMO に仕分けさせる（取り込み済みのものは出ない）';
    b.dataset.folderKey = k;
    b.__carryoverShow = () => {
      const st = carryoverShown.get(k);
      if (!st) return;
      if (st.text == null) {
        b.disabled = true;
        return;
      }
      const left = st.until - Date.now();
      if (left <= 0) return;
      b.disabled = true;
      b.textContent = st.text;
      setTimeout(() => {
        b.textContent = CARRYOVER_LABEL;
        b.disabled = false;
      }, left);
    };
    b.addEventListener('click', async () => {
      const st = { text: null, until: 0 };
      carryoverShown.set(k, st);
      b.disabled = true;
      let text;
      try {
        const r = await api.carryoverImport({ folder });
        text = r && !r.error ? (r.added ? `${r.added} 件を依頼に出した${r.more ? `（ほか ${r.more} 件）` : ''}` : '新しい積み残しはない') : `取り込めなかった（${(r && r.error) || '不明'}）`;
      } catch (err) {
        console.error(err);
        text = '取り込めなかった';
      }
      st.text = text;
      st.until = Date.now() + 4000;
      setTimeout(() => {
        if (carryoverShown.get(k) === st) carryoverShown.delete(k);
      }, 4000);
      // the clicked button may already be replaced by a redraw: update every live button of this folder
      for (const el of document.querySelectorAll('.dbx-carryover')) if (el.dataset.folderKey === k && el.__carryoverShow) el.__carryoverShow();
    });
    b.__carryoverShow();
    return b;
  }
  const byTask = (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.no || '').localeCompare(String(b.no || ''), 'ja', { numeric: true });
  // sessions in the order they were first seen (kept for the page's life; a restart starts over in the push order)
  const seen = new Map();
  const bySeen = (a, b) => seenAt(a) - seenAt(b);
  function seenAt(s) {
    const k = `${key(s.folder)}|${s.wcId}:${s.tabId}`;
    if (!seen.has(k)) seen.set(k, seen.size);
    return seen.get(k);
  }

  // the band: done / running / waiting / failed in proportion (dropped not counted)
  function progressBand(r) {
    const segs = [['done', r.done.length], ['active', r.active.length], ['pending', r.pending.length], ['failed', r.failed.length]];
    const total = segs.reduce((a, [, n]) => a + n, 0) || 1;
    const band = h('div', 'dbx-pband');
    for (const [k, n] of segs) {
      if (!n) continue;
      const s = h('span', `seg ${k}`);
      s.style.width = `${(n / total) * 100}%`;
      band.append(s);
    }
    band.title = segs.filter(([, n]) => n).map(([k, n]) => `${stWord('backlog', k, k).short} ${n}`).join(' · ');
    return band;
  }

  // drag a card's name onto another card: it goes before that one; the order is saved (dashFolderOrder)
  let dragKey = '';
  function dragTarget(card, fk) {
    card.addEventListener('dragover', (e) => {
      if (!dragKey || dragKey === fk) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      card.classList.add('drop');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drop');
      const from = dragKey;
      dragKey = '';
      if (!from || from === fk) return;
      const order = folderOrder.filter((k) => k !== from);
      const at = order.indexOf(fk);
      order.splice(at < 0 ? order.length : at, 0, from);
      folderOrder = order;
      store.set('dashFolderOrder', folderOrder);
      render();
    });
  }

  // One row of a card: a task (backlog item) with its session's state when it has one, or a session without a task.
  // With a session the row is also .dbx-sess k-<kind> (its label opens the session; a dialog points to あなたの番).
  // q (queue order, a waiting task): { position, next, state, reason, detail, last } from queue:order, or { tab: true }
  function taskRow(r, it, s, q = null) {
    const folder = r.folder;
    const el = h('div', `dbx-task${s ? ` dbx-sess k-${s.kind}` : ''}${q ? ' dbx-qitem' : ''}${q && q.next ? ' next' : ''}`);
    el.dataset.k = it ? `t:${it.id}` : `s:${s.wcId}:${s.tabId}`; // UX6: the row's key in the patch
    const cls = it ? it.status : 'sess';
    const line = h('div', `dbx-q st-${cls}`);
    if (it) line.dataset.id = it.id;
    else line.dataset.sess = `${s.wcId}:${s.tabId}`;
    if (q && q.position) {
      const p = h('span', 'dbx-qpos', String(q.position));
      p.title = `${q.position} 番目に送る`;
      line.append(p);
    }
    const no = it ? taskNo(it) : '';
    const mark = h('span', 'dbx-qmark', no || (it ? { active: '▶', pending: '·', failed: '✕', done: '✓' }[it.status] || '' : ''));
    line.append(mark);
    // the title: opens the session (open tab), or the closed finished session (会話を開く), else only text
    const closedDone = it && it.status === 'done' && it.tabId && !s;
    const lab = h(s || closedDone ? 'button' : 'span', `dbx-qtext${s ? ' dbx-slabel' : ''}`);
    if (s || closedDone) lab.type = 'button';
    if (s) lab.append(h('span', 'dbx-dot'));
    lab.append(document.createTextNode(it ? taskTitle(it) : s.label || 'セッション'));
    lab.title = it ? `${taskName(it)}\n\n${it.text}${it.note ? `\n\n${it.note}` : ''}` : s.label || '';
    if (s) {
      lab.dataset.usage = 'dash.card.open-session'; // UA1
      lab.addEventListener('click', () => api.dashboardFocus?.({ wcId: s.wcId, tabId: s.tabId, from: 'project' }));
      // 完了 opens to read only (PROGRESS 44); 休止中 (31) wakes when opened
      if (s.kind === 'fin' && s.rest !== 'done') lab.title += '\n\nクリックで会話を開く（作業完了で終わったセッション）';
      else if (s.kind === 'fin') lab.title += '\n\nクリックで会話を開く（止めたまま見られます。送ると再開します）';
      else if (REST_JA[s.kind]) lab.title += '\n\nクリックで会話を開く（開くと再開します）';
      else lab.title += '\n\nクリックで会話を開く';
    } else if (closedDone) {
      lab.title += '\n\nクリックで会話を開く（止めたまま見られます。送ると再開します）';
      lab.addEventListener('click', () => api.dashboardOpenSession?.({ folder, tabId: it.tabId }));
    }
    line.append(lab);
    // MP4 18: the row is a grid (title | marks | state | model | actions, dashboard.css .dbx-q): the marks and the
    // actions go in one cell each so the state / model columns line up across the rows of a card
    const marks = h('span', 'dbx-qmarks');
    const acts = h('span', 'dbx-qacts');
    // state: the session's when it has one, else the task's; 待ち（上限） etc. with the full reason in the tooltip
    let word;
    let full = '';
    if (s) {
      word = s.kind === 'input' ? W('yourTurn', '要対応') : REST_JA[s.kind] || ATTN_JA[s.attention] || SESSION_JA[s.status] || s.status || '';
      if (s.kind === 'busy') word = W('running', '動作中');
    } else if (q && q.tab) {
      word = W('queue', '待ち');
      full = q.reason ? q.reason.text : '';
    } else if (q && (q.next || q.state === 'start')) {
      word = q.next ? W('nextStart', '次') : W('startSoon', 'まもなく開始');
      full = q.reason ? `${q.reason.text}。空きが出たら最初に始まります` : '空きがあるので、すぐに始まります';
    } else if (q && q.reason) {
      const w = stWord('wait', q.reason.code, `${W('queue', '待ち')}（${q.reason.code}）`);
      word = w.short;
      full = q.reason.text || w.full;
    } else if (it) {
      const why = it.status === 'pending' ? schedWhy(folder, it.id) : null;
      if (why) {
        const w = stWord('wait', why.code, `${W('queue', '待ち')}（${why.code}）`);
        word = w.short;
        full = why.text || w.full;
      } else {
        const w = stWord('backlog', it.status, it.status);
        word = w.short;
        full = w.full;
      }
    }
    const stEl = h('span', `dbx-qst${s ? ' dbx-sstate' : ''}${!s && it && it.status === 'pending' && /資源|前提が失敗/.test(word) ? ' warn' : ''}${q && q.next ? ' next' : ''}`, word);
    if (full) stEl.title = full;
    if (!s && it && it.status === 'pending' && schedWhy(folder, it.id)) {
      stEl.dataset.whyFolder = folder;
      stEl.dataset.whyId = it.id;
    }
    line.append(stEl);
    // AT-6: the model / effort its session starts / started with (small; the PMO's own choice stands out)
    const mm = it && (it.status === 'pending' || it.status === 'active') && window.Labels?.modelMark ? window.Labels.modelMark(it, modelCfg && modelCfg.session) : null;
    if (mm) {
      const m = h('span', `dbx-qmodel${mm.own ? ' own' : ''}`, mm.text);
      m.title = mm.title;
      line.append(m);
    }
    const qe = it && it.status === 'pending' ? qaForBacklog(folder, it.id) : null;
    if (qe) marks.append(qaMark(qe));
    const sf = it ? staleOf('backlog', it.id, folder) : null;
    if (sf) marks.append(staleMark(sf));
    if (s) {
      const mem = s.rest ? restMem() : memMark(s.memMb, s.memHeavy, s.status, () => api.dashboardRestart?.({ wcId: s.wcId, tabId: s.tabId }));
      if (mem) acts.append(mem);
      // 休止 (PROGRESS 31): stop its claude now (the owning window refuses while it works); not the PMO's own session
      if (!s.rest && s.status === 'idle' && s.kind !== 'fin' && s.folderName !== 'ダッシュボード' && api.dashboardRest) {
        const b = h('button', 'dbx-link dim dbx-rest', '休止');
        b.type = 'button';
        b.dataset.usage = 'dash.card.rest'; // UA1
        b.title = 'このセッションの claude を止めてメモリを空けます（タブと会話は残り、開くか送ると同じ会話で再開）';
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          api.dashboardRest({ wcId: s.wcId, tabId: s.tabId });
        });
        acts.append(b);
      }
    }
    if (it && it.status === 'active' && it.note && !s) {
      const n = h('span', 'dbx-qwhy', it.note);
      n.title = it.note;
      marks.append(n);
    }
    if (q && q.position) acts.append(...moveButtons(folder, it, q));
    if (it && it.status === 'pending') acts.append(dropButton(folder, it));
    if (closedDone) {
      const b = h('button', 'dbx-link dim dbx-qopen', '会話を開く');
      b.type = 'button';
      b.dataset.usage = 'dash.card.open-closed'; // UA1
      b.title = 'このフォルダのウィンドウでこの作業のセッションを開く（止めたまま会話を見られます。送ると再開します）';
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        api.dashboardOpenSession?.({ folder, tabId: it.tabId });
      });
      acts.append(b);
    }
    if (marks.childNodes.length) line.append(marks);
    if (acts.childNodes.length) line.append(acts);
    el.append(line);
    // queue order: why it does not start yet and what it waits for (前提: AT-5（2 番目）, 重なり: AT-3（動作中）)
    if (q) {
      const parts = q.tab ? (q.reason ? [q.reason.text] : []) : Array.isArray(q.info) ? q.info : q.reason && !q.next && q.state !== 'start' ? [q.reason.text] : [];
      if (parts.length) {
        const inf = h('div', 'dbx-qinfo', parts.join(' · '));
        inf.title = parts.join('\n');
        el.append(inf);
      }
    }
    if (!s) return el;
    const text = s.kind === 'input' ? s.question || s.text : s.kind === 'error' || s.kind === 'done' ? s.text : '';
    if (text) el.append(h('div', 'dbx-stext', firstLine(text)));
    const wl = waitLine(s);
    if (wl) el.append(wl);
    // UX5: answers only on あなたの番 (one place); the row points there
    if (s.kind === 'input' && s.options && s.options.length) el.append(turnLink());
    return el;
  }

  // ---- queue order on the card (docs/queue-order.md) -------------------------------------------------------------
  const queueOf = (folder) => (queue && Array.isArray(queue.folders) ? queue.folders.find((f) => key(f.folder) === key(folder)) || null : null);
  async function loadQueue() {
    if (!api.queueOrder) return;
    const r = await snap({ queue: ['queue:order', { folders: folders.map((f) => f.folder) }] });
    if (r.queue !== undefined) setQueue(r.queue);
  }
  // ver.queue moves only with what is drawn (leftMs / until count down on every read)
  let queueShape = '';
  function setQueue(q) {
    if (!q || !Array.isArray(q.folders)) return;
    queue = q;
    const sh = JSON.stringify(q, (k, v) => (k === 'leftMs' || k === 'until' ? undefined : v));
    if (sh !== queueShape) {
      queueShape = sh;
      ver.queue++;
    }
  }
  let queueT = 0;
  const queueSoon = () => {
    clearTimeout(queueT);
    queueT = setTimeout(() => loadQueue().then(renderSoon), 400);
  };
  function qNote(fk, text, bad = false) {
    const n = { text, bad, until: Date.now() + 8000 };
    qNotes.set(fk, n);
    setTimeout(() => {
      if (qNotes.get(fk) === n) {
        qNotes.delete(fk);
        renderSoon();
      }
    }, 8100);
  }
  // the waiting tasks of a card in the order they are sent: 1, 2, 3 … with 次に始まる / the reason, ↑ ↓, and the
  // PMO's last reorder, the user's lock and 「PMO に順番を見直してもらう」 above them
  function queueBlock(r, qf) {
    const fk = key(r.folder);
    const box = h('div', 'dbx-queue');
    box.dataset.folder = fk;
    const head = h('div', 'dbx-qhead');
    const t = h('span', 'dbx-qtitle', `${W('queueOrder', '送る順')}${r.pending.length ? `（${W('queue', '待ち')} ${r.pending.length}）` : ''}`);
    t.title = '上から順に新しいセッションで始めます。始められないタスクは飛ばして、後ろのタスクが先に始まることがあります';
    head.append(t);
    if (qf.orderLock) {
      const lk = h('span', 'dbx-qlock', `${W('orderLocked', '手で並べた順')}（残り ${qf.orderLock.leftText}）`);
      lk.title = `↑ ↓ で並べ替えたので、24 時間は PMO が並べ替えません（残り ${qf.orderLock.leftText}）。「${W('askPmoOrder', '順番の見直し')}」で送ると外れます`;
      head.append(lk);
    }
    const ab = h('button', 'dbx-link dbx-qask', W('askPmoOrder', '順番の見直し'));
    ab.type = 'button';
    ab.dataset.usage = 'dash.card.ask-order'; // UA1
    ab.title = `PMO に順番の見直しを頼みます。ひとこと書いて送ります（依頼に入ります）${qf.orderLock ? '。手で並べた順の固定は外れます' : ''}`;
    ab.addEventListener('click', () => {
      if (qAsk.has(fk)) qAsk.delete(fk);
      else qAsk.set(fk, '');
      render();
      if (qAsk.has(fk)) root?.querySelector(`.dbx-queue[data-folder="${CSS.escape(fk)}"] .dbx-qask-in`)?.focus();
    });
    head.append(ab);
    box.append(head);
    if (qf.lastReorder) {
      const pm = h('div', 'dbx-qpmo', `${W('pmoReordered', 'PMO の並べ替え')}${qf.lastReorder.at ? `（${rel(qf.lastReorder.at)}）` : ''}: ${qf.lastReorder.reason}`);
      pm.title = qf.lastReorder.reason;
      box.append(pm);
    }
    if (qAsk.has(fk)) {
      const bar = h('div', 'dbx-qask-box');
      const inp = h('input', 'dbx-qask-in');
      inp.type = 'text';
      inp.maxLength = 500;
      inp.dataset.k = fk;
      inp.placeholder = 'ひとこと（例: AT-61 を先に）';
      inp.value = qAsk.get(fk) || '';
      inp.addEventListener('input', () => qAsk.set(fk, inp.value));
      const go = h('button', 'dbx-qask-go', '送る');
      go.type = 'button';
      const send = async () => {
        go.disabled = true;
        let res = null;
        try {
          res = await api.queueAskPmo?.({ folder: r.folder, note: String(qAsk.get(fk) ?? inp.value ?? '') });
        } catch (err) {
          res = { ok: false, error: String(err) };
        }
        if (res && res.ok) {
          qAsk.delete(fk);
          qNote(fk, `${W('inbox', '依頼')}に足しました${res.item && res.item.reqNo ? `（${res.item.reqNo}）` : ''}${res.unlocked ? '。手で並べた順の固定を外しました' : ''}`);
        } else qNote(fk, `送れませんでした: ${(res && res.error) || '不明なエラー'}`, true);
        await loadQueue();
        render();
      };
      go.addEventListener('click', send);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          send();
        } else if (e.key === 'Escape') {
          qAsk.delete(fk);
          render();
        }
      });
      const no = h('button', 'dbx-link dim', 'やめる');
      no.type = 'button';
      no.addEventListener('click', () => {
        qAsk.delete(fk);
        render();
      });
      bar.append(inp, go, no);
      box.append(bar);
    }
    const nt = qNotes.get(fk);
    if (nt) box.append(h('div', `dbx-qa-note dbx-qnote${nt.bad ? ' bad' : ''}`, nt.text));
    const byId = new Map(r.pending.map((i) => [i.id, i]));
    const listed = new Set();
    const rows = [];
    for (const q of qf.items) {
      const it = byId.get(q.id);
      if (!it) continue;
      listed.add(q.id);
      rows.push([it, { ...q, last: q.position === qf.items.length }]);
    }
    for (const q of qf.tabbed || []) {
      const it = byId.get(q.id);
      if (!it) continue;
      listed.add(q.id);
      rows.push([it, { tab: true, reason: q.reason }]);
    }
    for (const it of r.pending) if (!listed.has(it.id)) rows.push([it, null]); // came after the last queue:order
    const n = CARD_SHOWN + (cardMore.get(`${fk}|queue`) || 0);
    for (const [it, q] of rows.slice(0, n)) box.append(taskRow(r, it, null, q));
    if (rows.length > CARD_SHOWN) box.append(cardMoreBar(fk, 'queue', rows.length, W('queue', '待ち')));
    return box;
  }
  // UX7: 「ほか N 件<state>」 under a card's rows (CARD_STEP more per click) and 「畳む」 once opened; kept by key in the patch
  function cardMoreBar(fk, st, total, word) {
    const k = `${fk}|${st}`;
    const n = Math.min(total, CARD_SHOWN + (cardMore.get(k) || 0));
    const bar = h('div', 'dbx-morebar dbx-card-more');
    bar.dataset.k = `more:${st}`;
    if (n < total) {
      const b = h('button', 'dbx-link dim dbx-more', `ほか ${total - n} 件${word}`);
      b.type = 'button';
      b.dataset.more = st;
      if (total - n > CARD_STEP) b.title = `${CARD_STEP} 件ずつ開きます`;
      b.addEventListener('click', () => {
        cardMore.set(k, (cardMore.get(k) || 0) + CARD_STEP);
        render();
      });
      bar.append(b);
    }
    if (n > CARD_SHOWN) {
      const c = h('button', 'dbx-link dim dbx-fold', '畳む');
      c.type = 'button';
      c.dataset.fold = st;
      c.addEventListener('click', () => {
        cardMore.delete(k);
        render();
      });
      bar.append(c);
    }
    return bar;
  }
  // ↑ ↓ on a card: the same save and 24 h lock as the folder's own ↑ ↓ (main queue:move)
  function moveButtons(folder, it, q) {
    const mk = (dir, txt, tip) => {
      const b = h('button', `dbx-link dim dbx-qmove ${dir < 0 ? 'up' : 'down'}`, txt);
      b.type = 'button';
      b.dataset.usage = 'dash.card.move'; // UA1
      b.title = `${tip}（24 時間は PMO が並べ替えません）`;
      b.disabled = dir < 0 ? q.position <= 1 : !!q.last;
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        b.disabled = true;
        let res = null;
        try {
          res = await api.queueMove?.({ folder, id: it.id, dir });
        } catch (err) {
          res = { ok: false, error: String(err) };
        }
        if (!res || !res.ok) qNote(key(folder), `並べ替えられませんでした: ${(res && res.error) || '不明なエラー'}`, true);
        await loadFolders();
        await loadQueue();
        render();
      });
      return b;
    };
    return [mk(-1, '↑', '1 つ前へ'), mk(1, '↓', '1 つ後ろへ')];
  }

  // 取り消す: the item never starts; it stays in the folder's backlog as 取り消し (history, its inbox tie kept)
  function dropButton(folder, it) {
    const x = h('button', 'dbx-link dim dbx-qdrop', '取り消す');
    x.type = 'button';
    x.dataset.usage = 'dash.card.drop'; // UA1
    x.title = '始めずに取り消す（タスクは履歴として残り、そのフォルダの待ちの一覧の「戻す」で戻せる）';
    x.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!window.confirm(`「${baseName(folder)}」の待ちのタスクを取り消しますか？\n\n${taskName(it)}\n\n始めずに「取り消し」として残します。`)) return;
      x.disabled = true;
      let res = null;
      try {
        res = await api.backlogDrop?.({ folder, id: it.id });
      } catch (err) {
        res = { ok: false, error: String(err) };
      }
      if (!res || !res.ok) {
        x.disabled = false;
        window.alert(`取り消せませんでした: ${(res && res.error) || '不明なエラー'}`);
      }
      refresh();
    });
    return x;
  }

  // ---- あなたの番 (was the 確認待ち list) ----------------------------------------------------------
  // since: the same dialog asked again (e.g. the same command twice) is a new entry, not the one just answered
  const wkey = (e) => `${e.tabId}:${e.prompt ? `${e.prompt.key}:${e.prompt.since || ''}` : e.kind}`;
  const waitAge = (ms) => (ms >= 3600e3 ? `${Math.floor(ms / 3600e3)}時間${Math.floor((ms % 3600e3) / 60e3)}分` : ms >= 60e3 ? `${Math.floor(ms / 60e3)}分` : `${Math.max(0, Math.floor(ms / 1e3))}秒`);
  const NO_RE = /^(no|いいえ|cancel|キャンセル)(?![a-z])/i;

  // あなたの番 (U3): main's attention list (attention:list; changes come by attention:changed). The manager's own
  // session is in it too (own, folderName ダッシュボード): stopped at a dialog it is in no folder row.
  async function loadAttention() {
    const r = await snap({ attention: ['attention:list'] });
    if (r.attention !== undefined) setAttn(r.attention);
  }
  function setAttn(r) {
    if (r && Array.isArray(r.items)) attn = r.items.filter((x) => x && x.id).sort((a, b) => (a.seq || 0) - (b.seq || 0));
    // an answered card stays hidden until main drops it (or 20 s passed: then it is shown again, e.g. the keys were lost)
    const now = Date.now();
    const ids = new Set(attn.map((x) => x.id));
    const entries = attn.map((x) => x.entry).filter((e) => e && e.prompt);
    for (const [id, at] of attnSent) if (now - at > SENT_MS || !ids.has(id)) attnSent.delete(id);
    for (const [k, at] of waitSent) if (now - at > SENT_MS || !entries.some((e) => sentKey(e) === k)) waitSent.delete(k);
    for (const k of [...waitDrafts.keys()]) if (!entries.some((e) => wkey(e) === k)) waitDrafts.delete(k);
    armUnhide();
  }
  // the widget's 確認待ち count (and a refused quick answer) open あなたの番
  async function openWaiting() {
    tabChosen = true;
    if (tab !== 'turn') {
      tab = 'turn';
      store.set('dashTab', tab);
    }
    await loadAttention();
    render();
    const bd = root && root.querySelector('.dbx-body');
    if (bd) bd.scrollTop = 0;
  }
  const sessionNow = (wcId, tabId) => sessions.find((s) => s.wcId === wcId && s.tabId === tabId) || null;
  function nowText(d) {
    const s = sessionNow(d.wcId, d.tabId);
    if (!s) return 'タブは閉じられました';
    if (d.promptKey && s.promptKey === d.promptKey && Date.now() - d.at < 5000) return '反映を待っています…';
    if (s.attention === 'input' || s.status === 'asking') return `${W('yourTurn', '要対応')}（${firstLine(s.question || s.text).slice(0, 60) || '次の確認'}）`;
    if (s.attention === 'error') return `エラー（${firstLine(s.text).slice(0, 60)}）`;
    return SESSION_JA[s.status] || s.status || '';
  }

  // e = WaitEntry (or a folder-row session with promptKey), payload = { choice } | { want, text } | { text }
  async function sendAnswer(e, payload, answerText) {
    if (waitBusy) return;
    const k = wkey(e);
    waitBusy = true;
    let r;
    try {
      r = await api.dashboardAnswer?.({ wcId: e.wcId, tabId: e.tabId, promptKey: e.prompt.key, ...payload });
    } catch (err) {
      r = { error: String(err && err.message ? err.message : err) };
    }
    waitBusy = false;
    if (r && r.ok) {
      waitSent.set(sentKey(e), Date.now());
      armUnhide();
      waitNotes.delete(k);
      waitNotes.delete(e.tabId);
      waitDrafts.delete(k);
      waitDone = [{ at: Date.now(), promptKey: e.prompt.key, wcId: e.wcId, tabId: e.tabId, folderName: e.folderName, label: e.label, question: e.prompt.question, answer: answerText }, ...waitDone].slice(0, 5);
    } else {
      const text = (r && r.error) || '送れませんでした';
      waitNotes.set(r && r.changed ? e.tabId : k, { text: r && r.changed ? `${text}。送らずに一覧を新しくしました` : text, bad: true });
    }
    await loadAttention();
    render();
  }
  // a dangerous dialog (stuck.js dangerOf): ask before any option that is not a "No"
  const confirmDanger = (e, label) => !e.danger || NO_RE.test(label) || window.confirm(`「${e.danger}」に当たる確認です。\n\n${e.prompt ? e.prompt.question : ''}\n\n「${label}」を押しますか？`);

  // One dialog of a WaitEntry, inside an あなたの番 card (U3), whose head already says where / how long / 会話を開く
  function waitRow(e) {
    const k = wkey(e);
    const el = h('div', `dbx-wrow k-${e.kind}${e.danger ? ' danger' : ''} in-card`);
    el.dataset.key = k;
    if (e.danger) {
      const dz = h('div', 'dbx-wait-danger', `注意: ${e.danger}に当たる確認`);
      dz.title = `${e.danger}に当たる確認です。押す前に中身を確かめてください`;
      el.append(dz);
    }
    const note = waitNotes.get(k) || waitNotes.get(e.tabId);
    if (note) el.append(h('div', `dbx-wait-note${note.bad ? ' bad' : ''}`, note.text));
    const p = e.prompt;
    if (e.kind === 'error' || !p) {
      if (e.text) el.append(h('div', 'dbx-wait-qtext', e.text));
      if (e.kind === 'input') {
        const hint = h('div', 'dbx-wait-hint', '選択肢を読めません。会話を開いて答えてください');
        hint.title = '選択肢を画面から読めない確認です（全画面の表示・ログインなど）。画面の末尾を出しています';
        el.append(hint);
      }
      if (e.screen && e.screen.length) el.append(h('pre', 'dbx-wait-screen', e.screen.join('\n')));
      return el;
    }
    if (p.kind === 'multi' && p.tabs && p.tabs.length > 1) el.append(h('div', 'dbx-wait-qtabs', p.tabs.map((t) => `${t.answered ? '✓ ' : ''}${t.label}`).join('  ·  ')));
    el.append(h('div', 'dbx-wait-qtext', `${p.question || '(質問の文を読めませんでした)'}${p.kind === 'multi' ? '（複数選べます）' : ''}`));
    if (p.context && p.context.length) {
      const det = h('details', 'dbx-wait-ctx');
      det.open = waitCtxOpen.has(k);
      det.addEventListener('toggle', () => (det.open ? waitCtxOpen.add(k) : waitCtxOpen.delete(k)));
      det.append(h('summary', '', `直前の画面（${p.context.length} 行）`), h('pre', '', p.context.join('\n')));
      el.append(det);
    }
    if (p.kind === 'multi') el.append(multiBox(e, k));
    else el.append(singleBox(e, k));
    return el;
  }

  function textBox(e, k, d, placeholder) {
    const t = h('textarea', 'dbx-wait-text');
    t.rows = 1;
    t.dataset.key = k;
    t.value = d.text || '';
    t.placeholder = placeholder;
    t.addEventListener('input', () => {
      d.text = t.value;
      waitDrafts.set(k, d);
    });
    return t;
  }
  function draftOf(e, k) {
    let d = waitDrafts.get(k);
    if (!d) {
      d = { want: new Set(e.prompt.options.filter((o) => o.checked && !o.other).map((o) => o.n)), text: '' };
      waitDrafts.set(k, d);
    }
    return d;
  }

  function singleBox(e, k) {
    const box = h('div', 'dbx-wait-ans');
    const opts = h('div', 'dbx-wait-opts');
    const other = e.prompt.options.find((o) => o.other);
    for (const o of e.prompt.options) {
      if (o.other) continue;
      const bad = e.danger && !NO_RE.test(o.label);
      const b = h('button', `dbx-wait-opt${bad ? ' danger' : ''}`);
      b.type = 'button';
      b.dataset.usage = 'dash.turn.answer'; // UA1
      b.disabled = waitBusy;
      b.append(h('span', 'dbx-optn', String(o.n)), document.createTextNode(o.label));
      b.addEventListener('click', () => {
        if (!confirmDanger(e, o.label)) return;
        sendAnswer(e, { choice: o.n }, `${o.n}. ${o.label}`);
      });
      opts.append(b);
    }
    box.append(opts);
    if (other) {
      const d = draftOf(e, k);
      const row = h('div', 'dbx-wait-free');
      const t = textBox(e, k, d, `${other.label}（自由記入。${window.Labels.key('mod+Enter')} で送る）`);
      const send = h('button', 'dbx-wait-send', '送る');
      send.type = 'button';
      send.dataset.usage = 'dash.turn.answer-send'; // UA1
      const go = () => {
        const text = (d.text || '').trim();
        if (!text) return t.focus();
        sendAnswer(e, { text }, `自由記入「${text.slice(0, 40)}」`);
      };
      send.addEventListener('click', go);
      t.addEventListener('keydown', (ev) => {
        if (ev.isComposing || ev.keyCode === 229) return;
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          go();
        }
      });
      row.append(t, send);
      box.append(row);
    }
    return box;
  }

  function multiBox(e, k) {
    const d = draftOf(e, k);
    const box = h('div', 'dbx-wait-ans');
    const opts = h('div', 'dbx-wait-checks');
    const other = e.prompt.options.find((o) => o.other);
    for (const o of e.prompt.options) {
      if (o.other) continue;
      const lab = h('label', 'dbx-wait-check');
      const cb = h('input');
      cb.type = 'checkbox';
      cb.checked = d.want.has(o.n);
      cb.addEventListener('change', () => (cb.checked ? d.want.add(o.n) : d.want.delete(o.n)));
      lab.append(cb, document.createTextNode(` ${o.label}`));
      opts.append(lab);
    }
    box.append(opts);
    if (other) {
      const row = h('div', 'dbx-wait-free');
      row.append(textBox(e, k, d, `${other.label}（自由記入。空欄なら使いません）`));
      box.append(row);
    }
    const next = e.prompt.submitLabel === 'Next';
    const send = h('button', 'dbx-wait-send', next ? '次の質問へ' : '回答を確定');
    send.type = 'button';
    send.dataset.usage = 'dash.turn.answer-send'; // UA1
    send.disabled = waitBusy;
    send.title = next ? '選んだ内容で次の質問へ進みます（次の質問はこの一覧に出ます）' : '選んだ内容で確認画面へ進み、「Submit answers」を押して送ります';
    send.addEventListener('click', () => {
      const want = [...d.want].sort((a, b) => a - b);
      const text = (d.text || '').trim();
      const labels = e.prompt.options.filter((o) => want.includes(o.n)).map((o) => o.label);
      if (!want.length && !text && !window.confirm('何も選んでいません。このまま進めますか？')) return;
      sendAnswer(e, { want, text }, `${labels.join('、') || '（選択なし）'}${text ? ` ＋「${text.slice(0, 30)}」` : ''}`);
    });
    const bar = h('div', 'dbx-wait-bar');
    bar.append(send);
    box.append(bar);
    return box;
  }

  // a waiting session's row / box (プロジェクト, 関係図): the pointer to あなたの番, where it is answered (UX5)
  function turnLink() {
    const b = h('button', 'dbx-link dbx-turnlink', '答える');
    b.type = 'button';
    b.dataset.usage = 'dash.card.answer'; // UA1
    b.title = `「${W('yourTurn', '要対応')}」のタブで答えます`;
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      switchTab('turn');
    });
    return b;
  }

  // ---- what a waiting session waits for (session.wait) ----------------------------------------
  // Shown while idle (and while asking only when flagged: the question is on the line already). wait.text starts
  // with 「待機中 — 」, which the state word next to the label already says.
  function waitShown(s) {
    const w = s && s.wait && typeof s.wait === 'object' ? s.wait : null;
    if (!w || s.rest || s.kind === 'fin' || (s.status !== 'idle' && s.status !== 'asking')) return null;
    if (s.status === 'asking' && w.level !== 'warn') return null;
    return w;
  }
  const waitCmds = (w) => (Array.isArray(w.items) ? w.items : []).filter((x) => x && x.type === 'command' && x.id != null);
  const sk = (s) => `${s.wcId}:${s.tabId}`;

  function waitLine(s) {
    const w = waitShown(s);
    if (!w) return null;
    const box = h('div', `dbx-swait${w.level === 'warn' ? ' warn' : ''}`);
    const t = h('span', 'dbx-swait-text', String(w.text || w.short || '').replace(/^待機中\s*[—–-]\s*/, ''));
    const alerts = (Array.isArray(w.alerts) ? w.alerts : []).map((a) => a && a.text).filter(Boolean);
    t.title = [w.text, ...alerts].filter(Boolean).join('\n');
    box.append(t);
    const cmds = waitCmds(w);
    if (cmds.length) {
      const k = sk(s);
      const b = h('button', `dbx-link dbx-swait-out${tailOpen.has(k) ? ' on' : ''}`, tailOpen.has(k) ? '出力を閉じる' : '出力');
      b.type = 'button';
      b.dataset.usage = 'dash.card.output'; // UA1
      b.title = '待っているコマンドの出力の末尾を見る';
      b.addEventListener('click', () => {
        if (tailOpen.has(k)) tailOpen.delete(k);
        else {
          tailOpen.add(k);
          for (const c of cmds) loadTail(s, c.id);
        }
        render();
      });
      box.append(b);
    }
    if (!tailOpen.has(sk(s)) || !cmds.length) return box;
    const wrap = h('div', 'dbx-swait-wrap');
    wrap.append(box, tailPanel(s, cmds));
    return wrap;
  }

  function loadTail(s, id) {
    const k = `${sk(s)}:${id}`;
    tails.set(k, { loading: true, res: tails.get(k)?.res || null });
    Promise.resolve(api.waitTail?.({ wcId: s.wcId, tabId: s.tabId, id }))
      .then((res) => res || { error: '出力を読めませんでした' })
      .catch((err) => ({ error: String((err && err.message) || err) }))
      .then((res) => {
        tails.set(k, { loading: false, res });
        render();
      });
  }

  function tailPanel(s, cmds) {
    const p = h('div', 'dbx-tail');
    for (const c of cmds) {
      const k = `${sk(s)}:${c.id}`;
      const head = h('div', 'dbx-tail-head');
      const cmd = h('span', 'dbx-tail-cmd', String(c.command || '(コマンド不明)'));
      cmd.title = String(c.command || '');
      const meta = [c.lastOutputAt ? `最後の出力 ${rel(c.lastOutputAt)}` : c.hasOutput ? '' : '出力なし', c.proc === 'gone' ? 'プロセスが見つからない' : ''].filter(Boolean).join(' · ');
      const again = h('button', 'dbx-link', '読み直す');
      again.type = 'button';
      again.addEventListener('click', () => {
        loadTail(s, c.id);
        render();
      });
      head.append(cmd, h('span', `dbx-tail-meta${c.proc === 'gone' ? ' warn' : ''}`, meta), again);
      p.append(head);
      const t = tails.get(k);
      if (!t || (!t.res && t.loading)) {
        p.append(h('div', 'dbx-none', '読み込み中…'));
      } else if (t.res && t.res.error) {
        p.append(h('div', 'dbx-tail-err', t.res.error));
      } else if (t.res) {
        const pre = h('pre', 'dbx-tail-text', t.res.text || '（出力はまだありません）');
        pre.dataset.k = k;
        if (t.res.file) pre.title = t.res.file;
        // render() builds the new page before it replaces the old one: keep where the user scrolled
        const old = root && root.querySelector(`.dbx-tail-text[data-k="${CSS.escape(k)}"]`);
        const top = old ? old.scrollTop : null;
        const atEnd = !old || old.scrollTop + old.clientHeight >= old.scrollHeight - 4;
        requestAnimationFrame(() => {
          pre.scrollTop = atEnd || top == null ? pre.scrollHeight : top;
        });
        p.append(pre);
      }
    }
    return p;
  }

  // Session memory (roadmap 22): quiet figure; over the user's mark it is orange with 再起動 (not while busy:
  // the owning window refuses then too, without asking).
  const memText = (mb) => (mb >= 1000 ? `${(mb / 1024).toFixed(1)}GB` : `${Math.round(mb)}MB`);
  function memMark(mb, heavy, status, onRestart) {
    if (mb == null || status === 'exited') return null;
    const wrap = h('span', `dbx-mem${heavy ? ' heavy' : ''}`, memText(mb));
    wrap.title = 'このセッションの claude とその子プロセスのメモリ（約 1 分ごとに更新）';
    if (heavy && onRestart) {
      const busy = status === 'running' || status === 'asking' || status === 'starting';
      const b = h('button', 'dbx-link dbx-restart', '再起動');
      b.type = 'button';
      b.dataset.usage = 'dash.card.restart'; // UA1
      b.disabled = busy;
      b.title = busy ? `応答中・${W('yourTurn', '要対応')}の間は再起動できません。手が空いてから押してください` : '同じ会話のまま claude を起動し直して、メモリを空けます';
      b.addEventListener('click', onRestart);
      wrap.append(b);
    }
    return wrap;
  }

  // resting (35 完了 / 31 休止中): its claude is stopped, 0
  function restMem() {
    const wrap = h('span', 'dbx-mem', '0MB');
    wrap.title = 'claude を止めています（開くか送ると同じ会話で再開し、メモリの表示も戻ります）';
    return wrap;
  }

  // The manager agent's own resident session (its folder is excluded from the rows): header line.
  function ownLine() {
    const o = ownHooks.own ? ownHooks.own() : null;
    if (!o) return null;
    // a chip in the band: 「PMO 動作中」 while it works, its memory (orange + 再起動 over the mark)
    const busy = o.status === 'running' || o.status === 'starting';
    const el = h('span', `dbx-own dbx-chip${busy ? ' busy' : ''}`);
    el.append(h('span', 'dbx-wrlabel', `${W('pmo', 'PMO')}${busy ? ` ${W('running', '動作中')}` : ''}`));
    el.title = 'PMO（右の欄の会話）。全部のプロジェクトを見て振り分け・順番・後押しをします';
    const m = o.memMb == null ? null : memMark(o.memMb, o.heavy, o.status, () => ownHooks.restart && ownHooks.restart());
    if (m) el.append(m);
    return el;
  }

  // why a routed item of the folder does not start yet (sched:plan of its window, kept by main)
  function schedWhy(folder, id) {
    const w = sched && sched.waiting;
    if (!w) return null;
    for (const [f, m] of Object.entries(w)) if (key(f) === key(folder) && m && m[id]) return m[id];
    return null;
  }
  // ---- data ----------------------------------------------------------------------------------
  // UX6 (J2): the reads of a refresh go in one invoke (dashboard:snapshot, src/main/snapshot.js): { calls: { name:
  // [channel, arg] }, sigs: { name: sig } } -> { name: { sig, value } | { sig, same } | { error } }. What did not change
  // since the last answer (same sig) comes back without its value: snap() returns only the new values (a name missing =
  // unchanged). Without dashboard:snapshot (an older main) each read is its own invoke as before.
  const SNAP_VIA = {
    'inbox:get': 'inboxGet',
    'dashboard:sessions': 'dashboardSessions',
    'dashboard:workRoot': 'dashboardWorkRoot',
    'models:get': 'modelsGet',
    'waits:settings': 'waitSettings',
    'dashboard:stale': 'dashboardStale',
    'qa:list': 'qaList',
    'notices:list': 'noticesList',
    'pmo:log': 'pmoLog',
    'sched:state': 'schedState',
    'proc:leftovers': 'procLeftovers',
    'remote:getStatus': 'remoteGetStatus',
    'picker:list': 'pickerList',
    'dashboard:projects': 'dashboardProjects',
    'backlog:getFolder': 'backlogGetFolder',
    'dashboard:progress': 'dashboardProgress',
    'queue:order': 'queueOrder',
    'attention:list': 'attentionList',
  };
  const snapSigs = new Map(); // name -> sig of the value this page holds
  // a push from main replaced the value: the next snapshot must not answer 「same」 against the older sig
  const unsig = (...names) => names.forEach((n) => snapSigs.delete(n));
  let snapWarned = false;
  async function snap(calls) {
    const names = Object.keys(calls);
    const out = {};
    if (!names.length) return out;
    if (api.dashboardSnapshot) {
      stats.snapshots++;
      let r = null;
      try {
        const sigs = {};
        for (const n of names) if (snapSigs.has(n)) sigs[n] = snapSigs.get(n);
        r = await api.dashboardSnapshot({ calls, sigs });
      } catch (err) {
        console.error(err);
      }
      if (r && typeof r === 'object') {
        const miss = [];
        for (const n of names) {
          const x = r[n];
          if (!x || x.error || !x.sig) {
            miss.push(n); // not answered: read on its own below (never taken as 「unchanged」)
            snapSigs.delete(n);
            continue;
          }
          snapSigs.set(n, x.sig);
          if (!x.same) out[n] = x.value;
        }
        if (!miss.length) return out;
        if (!snapWarned) {
          snapWarned = true;
          console.warn('dashboard:snapshot did not answer', miss.slice(0, 5), r[miss[0]]);
        }
        names.splice(0, names.length, ...miss);
      }
    }
    await Promise.all(names.map(async (n) => {
      const [ch, arg] = calls[n];
      const fn = api[SNAP_VIA[ch]];
      if (typeof fn !== 'function') return;
      try {
        out[n] = await (arg === undefined ? fn() : fn(arg));
      } catch {}
    }));
    return out;
  }

  // the folder list (picker:list + projects.json + the sessions' folders) and each folder's backlog / PROGRESS.md / the
  // queue order, kept per folder: an unchanged folder keeps its arrays (and ver.folders does not move)
  let listedNow = { recent: [], open: [], kept: [] };
  let projectsNow = [];
  const folderData = new Map(); // key(folder) -> { backlog, progress }
  // a folder's short id in the snapshot's names (main takes [A-Za-z0-9_.:-]{1,64}: no paths)
  const fids = new Map();
  const fid = (k) => {
    if (!fids.has(k)) fids.set(k, `f${fids.size}`);
    return fids.get(k);
  };
  let foldersShape = '';
  let folderNames = '';
  // pre: { picker?, projects? } read by refresh() (undefined = unchanged); else read here
  async function loadFolders(pre = null) {
    stats.folderLoads++;
    const got = pre || (await snap({ picker: ['picker:list'], projects: ['dashboard:projects'] }));
    if (got.picker !== undefined) listedNow = got.picker || { recent: [], open: [] };
    if (got.projects !== undefined) projectsNow = Array.isArray(got.projects) ? got.projects : [];
    const listed = listedNow;
    startList = { recent: listed.recent || [], open: listed.open || [], kept: listed.kept || [] };
    const open = new Set((listed.open || []).map(key));
    const list = [...(listed.recent || [])];
    for (const s of sessions) if (s.folder && !list.some((f) => key(f) === key(s.folder))) list.push(s.folder);
    // + the PMO's projects (projects.json): a folder routed to but not opened yet (its window starts with its first task)
    // has a card too; its outlook (PMO の見立て, a later stage) comes along
    const outlook = new Map();
    const reviews = new Map(); // U8: projects.json review { status, round, at, allDone? }
    for (const pr of projectsNow) {
      if (!pr || typeof pr.folder !== 'string' || !pr.folder) continue;
      if (typeof pr.outlook === 'string' && pr.outlook.trim()) outlook.set(key(pr.folder), pr.outlook.trim().slice(0, 300));
      if (pr.review && typeof pr.review.status === 'string') reviews.set(key(pr.folder), pr.review);
      if (!list.some((f) => key(f) === key(pr.folder))) list.push(pr.folder);
    }
    const want = list.filter((f) => key(f) !== key(exclude)).slice(0, 30);
    const calls = {};
    for (const folder of want) {
      calls[`bl:${fid(key(folder))}`] = ['backlog:getFolder', { folder }];
      calls[`pg:${fid(key(folder))}`] = ['dashboard:progress', { folder }]; // PROGRESS.md (main caches by mtime)
    }
    if (api.queueOrder) calls.queue = ['queue:order', { folders: want }];
    const r = await snap(calls);
    let changed = false;
    const keep = new Set(want.map(key));
    for (const k of [...folderData.keys()]) {
      if (keep.has(k)) continue;
      folderData.delete(k);
      unsig(`bl:${fid(k)}`, `pg:${fid(k)}`);
    }
    const out = [];
    for (const folder of want) {
      const k = key(folder);
      const d = folderData.get(k) || { backlog: [], progress: null };
      if (r[`bl:${fid(k)}`] !== undefined) {
        d.backlog = (r[`bl:${fid(k)}`] && r[`bl:${fid(k)}`].items) || [];
        changed = true;
      }
      if (r[`pg:${fid(k)}`] !== undefined) {
        d.progress = r[`pg:${fid(k)}`] || null;
        changed = true;
      }
      folderData.set(k, d);
      out.push({ folder, open: open.has(k), backlog: d.backlog, progress: d.progress, outlook: outlook.get(k) || '', review: reviews.get(k) || null });
    }
    const shape = JSON.stringify(out.map((f) => [f.folder, f.open, f.outlook, f.review]));
    if (shape !== foldersShape) changed = true;
    foldersShape = shape;
    const names = JSON.stringify(out.map((f) => f.folder));
    if (names !== folderNames) {
      folderNames = names;
      ver.folderNames++;
    }
    folders = out;
    if (changed) ver.folders++;
    if (r.queue !== undefined) setQueue(r.queue);
  }
  // backlog:changed { folder }: only that folder's backlog (J2; a folder without a card yet reads the list)
  async function loadOneFolder(folder) {
    const k = key(folder);
    if (!k || k === key(exclude)) return;
    const f0 = folders.find((f) => key(f.folder) === k);
    if (!f0) return loadFoldersSoon();
    stats.folderLoads++;
    const r = await snap({ [`bl:${fid(k)}`]: ['backlog:getFolder', { folder: f0.folder }] });
    const v = r[`bl:${fid(k)}`];
    if (v === undefined) return;
    const d = folderData.get(k) || { backlog: [], progress: null };
    d.backlog = (v && v.items) || [];
    folderData.set(k, d);
    folders = folders.map((f) => (key(f.folder) === k ? { ...f, backlog: d.backlog } : f));
    ver.folders++;
    queueSoon(); // the queue order follows the backlogs
    renderSoon();
  }
  const oneT = new Map(); // key(folder) -> timer (several saves of one folder in a row: one read)
  function loadOneSoon(folder) {
    const k = key(folder);
    clearTimeout(oneT.get(k));
    oneT.set(k, setTimeout(() => {
      oneT.delete(k);
      if (pageHidden()) {
        hiddenStale = true;
        return;
      }
      loadOneFolder(folder).catch((err) => console.error(err));
    }, 250));
  }
  let foldersT = 0;
  function loadFoldersSoon() {
    clearTimeout(foldersT);
    foldersT = setTimeout(() => {
      if (pageHidden()) {
        hiddenStale = true;
        return;
      }
      loadFolders().then(renderSoon).catch((err) => console.error(err));
    }, 300);
  }

  let refreshT = 0;
  let hiddenStale = false; // a read was skipped while the page was hidden: one refresh when it is shown
  let refreshing = null;
  let refreshAgain = false;
  async function refresh() {
    clearTimeout(refreshT);
    if (pageHidden()) {
      hiddenStale = true;
      return;
    }
    // one at a time; asked again during the read: once more after it (what changed meanwhile is read then)
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    refreshing = refresh0().finally(() => {
      refreshing = null;
      if (refreshAgain) {
        refreshAgain = false;
        refreshSoon();
      }
    });
    return refreshing;
  }
  async function refresh0() {
    stats.refreshes++;
    const calls = {
      inbox: ['inbox:get'],
      workRoot: ['dashboard:workRoot'],
      models: ['models:get'],
      waits: ['waits:settings'],
      stale: ['dashboard:stale'],
      qa: ['qa:list'],
      notices: ['notices:list'],
      sched: ['sched:state'],
      leftovers: ['proc:leftovers'],
      remote: ['remote:getStatus'],
      picker: ['picker:list'],
      projects: ['dashboard:projects'],
      attention: ['attention:list'],
    };
    // PMO の記録 (U4): read once, then while its tab is shown (main pushes its changes: pmo:logChanged)
    if (api.pmoLog && (pmoLog === null || tab === 'log')) calls.log = ['pmo:log'];
    // the sessions: read until the first list came; then main pushes every change (dashboard:sessions). Reading them
    // again made main resend an unchanged list (widget.js dashFresh) in a form that redrew nothing
    if (!sessionsSeen) calls.sessions = ['dashboard:sessions'];
    const r = await snap(calls);
    if (r.inbox !== undefined) setInbox(r.inbox);
    if (r.sessions && Array.isArray(r.sessions.sessions)) {
      sessions = r.sessions.sessions;
      sessionsSeen = true;
    }
    if (r.workRoot) workRoot = r.workRoot;
    if (r.models && r.models.session) modelCfg = r.models;
    if (r.waits && typeof r.waits === 'object' && r.waits.silentMin != null) waitCfg = { silentMin: r.waits.silentMin, longMin: r.waits.longMin };
    // the finding's age moves on every read: only what is drawn (the marks count from since)
    if (Array.isArray(r.stale)) stale = r.stale.map(({ age, ...f }) => f);
    if (r.qa && Array.isArray(r.qa.entries)) setQa(r.qa.entries);
    if (r.notices && Array.isArray(r.notices.notices)) setNotices(r.notices.notices);
    if (r.log !== undefined) setPmoLog(r.log);
    if (r.sched) sched = r.sched;
    if (r.leftovers) leftover = r.leftovers;
    if (r.remote && typeof r.remote === 'object') remote = { running: !!r.remote.running };
    if (r.attention !== undefined) setAttn(r.attention);
    await loadFolders({ picker: r.picker, projects: r.projects });
    ensureSettings();
    settingsData();
    // start-up tab (U2): あなたの番 when it has anything (attention list, U3), else the last tab (あなたの番 with nothing
    // -> プロジェクト)
    if (!tabChosen) {
      tabChosen = true;
      if (attnShown().length) tab = 'turn';
      else if (tab === 'turn') tab = 'proj';
    }
    renderSoon();
  }
  function setInbox(s) {
    inbox = (s && s.items) || [];
    ver.inbox++;
  }
  function setQa(entries) {
    qaEntries = entries;
    ver.qa++;
  }
  // { entries: LogEntry[] } | null (not the manager window / an older main: the notices stand in)
  async function loadPmoLog() {
    if (!api.pmoLog) return;
    const r = await snap({ log: ['pmo:log'] });
    if (r.log !== undefined) setPmoLog(r.log);
  }
  function setPmoLog(st) {
    if (!st || !Array.isArray(st.entries)) return;
    pmoLog = st.entries;
    ver.log++;
    const ids = new Set(pmoLog.map((e) => e && String(e.id)));
    for (const id of [...logOpen]) if (!ids.has(id)) logOpen.delete(id);
  }
  function setUpdate(st) {
    if (!st || typeof st !== 'object') return;
    // since / deadline do not change while pending; only what is drawn
    const { state, force, busy, blocked, deadline } = st;
    update = { state, force: !!force, busy: busy || 0, blocked: blocked || 0, deadline: deadline || 0 };
    if (root) renderSoon();
  }
  // inbox:changed: the inbox alone (the QA / attention / backlogs it touches push their own changes)
  let inboxT = 0;
  function inboxSoon() {
    clearTimeout(inboxT);
    inboxT = setTimeout(async () => {
      if (pageHidden()) {
        hiddenStale = true;
        return;
      }
      const r = await snap({ inbox: ['inbox:get'] });
      if (r.inbox !== undefined) setInbox(r.inbox);
      renderSoon();
    }, 200);
  }
  const refreshSoon = () => {
    clearTimeout(refreshT);
    refreshT = setTimeout(refresh, 300);
  };

  window.Dashboard = {
    usageView: () => (root && root.isConnected && USAGE_TAB[tab] ? 'view.dash.' + USAGE_TAB[tab] : null), // UA1 screen time
    init(o) {
      api = (o && o.api) || window.api;
      exclude = (o && o.exclude) || '';
      root = (o && o.root) || null;
      ownHooks = { own: o && o.own, restart: o && o.restart };
      if (root) {
        watchComposition(root);
        watchScroll(root);
      }
      ensureSettings(); // ⚙ section 'dashboard' (settings.js may load later: refresh() tries again)
      // UX6 (J2): a request changed -> the inbox (and what hangs on it); a backlog saved -> only that folder
      api.onInboxChanged?.(() => inboxSoon());
      api.onBacklogChanged?.((o) => {
        const folder = o && typeof o.folder === 'string' ? o.folder : '';
        if (!folder) return refreshSoon();
        if (o.source === 'review') return loadFoldersSoon(); // projects.json review mark (a card's line)
        loadOneSoon(folder);
      });
      api.onSchedChanged?.((st) => {
        if (!st || typeof st !== 'object') return;
        const was = JSON.stringify(schedSig(sched, 'proj'));
        sched = st;
        unsig('sched');
        // queue order: the reasons and 次に始まる follow the scheduler — only when its drawn part moved (UX6: the
        // resource figures change every few seconds)
        if (JSON.stringify(schedSig(st, 'proj')) !== was) queueSoon();
        renderSoon();
      });
      api.onProcLeftovers?.((st) => {
        if (!st || typeof st !== 'object') return;
        leftover = st;
        unsig('leftovers');
        renderSoon();
      });
      api.onQaChanged?.((st) => {
        if (!st || !Array.isArray(st.entries)) return;
        setQa(st.entries);
        unsig('qa');
        renderSoon();
      });
      api.onNoticesChanged?.((st) => {
        if (!st || !Array.isArray(st.notices)) return;
        setNotices(st.notices);
        unsig('notices');
        renderSoon();
      });
      api.onPmoLogChanged?.((st) => {
        if (!st || !Array.isArray(st.entries)) return;
        setPmoLog(st);
        unsig('log');
        renderSoon(); // dataSig compares the log only while its tab is shown
      });
      api.onDashboardSessions?.((st) => {
        if (!st || !Array.isArray(st.sessions)) return;
        const before = new Set(sessions.map((s) => key(s.folder)));
        sessions = st.sessions;
        sessionsSeen = true;
        unsig('sessions');
        // a folder that just got its first session: reload the folder list; otherwise only redraw
        if (sessions.some((s) => !before.has(key(s.folder)))) loadFoldersSoon();
        else renderSoon();
      });
      // あなたの番 (U3): main pushes the attention list whenever it changes
      api.onAttentionChanged?.((st) => {
        if (!st || !Array.isArray(st.items)) return;
        setAttn(st);
        unsig('attention');
        renderSoon();
      });
      api.onDashboardShowWaiting?.(() => openWaiting()); // the tray's あなたの番 / a あなたの番 notification
      // a project window with no tab: 「依頼を置く」 (AT-139) -> the request box, with 「@<folder> 」 when empty
      api.onDashboardFocusInbox?.((o) => {
        const box = root.querySelector('.dbx-new');
        if (!box) return;
        const name = o && typeof o.folder === 'string' ? baseName(o.folder) : '';
        if (!box.value.trim() && name && !/\s/.test(name)) box.value = `@${name} `;
        box.focus();
        box.selectionStart = box.selectionEnd = box.value.length;
      });
      api.onRemoteStatus?.((st) => {
        if (!st || typeof st !== 'object') return;
        remote = { running: !!st.running };
        unsig('remote');
        renderSoon();
      });
      Promise.resolve(api.updateState?.()).then((st) => st && setUpdate(st)).catch(() => {});
      // the rest (PROGRESS.md, projects.json, the stale marks, …) has no push: read every 30 s while shown (one
      // snapshot, unchanged parts answer 「same」). The relative times follow the clock, without a redraw (§5.5.3)
      setInterval(refresh, 30_000);
      setInterval(() => !pageHidden() && tickAgo(root), 30_000);
      // §5.5.2: hidden, nothing is read or drawn; shown again: what was skipped, once
      document.addEventListener('visibilitychange', () => {
        if (pageHidden()) return;
        tickAgo(root);
        if (hiddenStale) {
          hiddenStale = false;
          refresh();
        } else if (hiddenDirty) {
          hiddenDirty = false;
          renderSoon();
        }
      });
      refresh();
    },
    refresh,
    renderOwn: () => root && renderSoon(), // core: the own session's memory / status changed
    turnLink: () => turnLink(), // 関係図 (agents-view.js): a waiting box points to あなたの番 (UX5)
    openWaiting: () => openWaiting(),
    showTab: (t) => switchTab(t), // 'turn' | 'proj' | 'req' | 'log'
    tab: () => tab,
    setUpdate: (st) => setUpdate(st), // core (renderer.js showUpdate): app:update status
    _schedSig: (st, t) => schedSig(st, t), // tests (tmp/at147/unit.js): what the signature keeps of sched:state
    // tests (tmp/ux6): cumulative counts of draws / reads / swapped elements
    _stats: () => ({ ...stats }),
    _folders: () => folders.map((f) => ({ folder: f.folder, items: (f.backlog || []).map((i) => [i.id, i.no || '', i.status]) })),
    _resetStats: () => {
      for (const k of Object.keys(stats)) stats[k] = k === 'why' ? [] : 0;
    },
  };
})();
