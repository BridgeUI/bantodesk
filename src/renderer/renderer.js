'use strict';
// Renderer core: tabs, panes (split view), status detection, sessions, remote bridge.
// Side panel = window.Panel (panel.js), cheat sheet = window.CheatSheet, remote button = window.RemoteUI.
// See CONTRACT.md for the interfaces.

// `api` is the global exposed by preload (contextBridge makes it a non-configurable window
// property, so redeclaring it with const/let here would be a SyntaxError).
const termsEl = document.getElementById('terminals');
const tabsEl = document.getElementById('tabs');
const overlayRoot = document.getElementById('overlay-root');

const tabs = new Map(); // sessionId -> tab (Map keeps insertion order = tab order)
let activeId = null;
let counter = 0;
let info = { workDir: '', dev: false, isGit: false };
let folderName = '';
let restoreDone = false;
let usageTabId = null; // UA1: the session whose open is being timed (src/renderer/usage.js)
let band = null; // UA3: the problem band of the opened session { el, tabId, kind, line, resolved, ranAt, note }
let lastPointerAt = 0; // UA1: a user's pointer press (assist panel tabs chosen by hand)
window.addEventListener('pointerdown', () => (lastPointerAt = Date.now()), { capture: true, passive: true });
const PMO_LABEL = 'PMO'; // the manager window's resident session (computeLabel, PROGRESS 45)

const THEME = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  cursorAccent: '#1e1e2e',
  selectionBackground: 'rgba(137, 180, 250, 0.3)',
  black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
  blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
  brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
  brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
};

const STATUS_JA = { starting: '起動中', running: '実行中', asking: '応答待ち', idle: '待機中', exited: '終了' };
const WT_NAME_RE = /^[A-Za-z0-9._-]{1,40}$/;

// ---- helpers ---------------------------------------------------------------
function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    console.error(err);
    return fallback;
  }
}

// First meaningful line of a prompt (paste wrapper tags and Markdown heading marks dropped).
function shortLabel(text, max = 28) {
  const line = String(text || '').replace(/<\/?pasted_content\b[^>]*>/g, '').split(/\r?\n/).map((l) => l.trim().replace(/^#+\s*/, '')).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function normPath(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function worktreeFromCwd(cwd) {
  const m = /[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/.exec(cwd || '');
  return m ? m[1] : null;
}

function relTime(ms) {
  const d = Date.now() - ms;
  if (d < 60e3) return 'たった今';
  if (d < 3600e3) return `${Math.floor(d / 60e3)}分前`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}時間前`;
  if (d < 7 * 86400e3) return `${Math.floor(d / 86400e3)}日前`;
  return new Date(ms).toLocaleDateString('ja-JP');
}

// ---- Panel wrappers (panel.js is optional at runtime) --------------------
const P = {
  newStats: () => safe(() => window.Panel?.newStats?.(), null) || {},
  onEvent: (tab, evt) => safe(() => window.Panel?.onEvent?.(tab, evt)),
  addLocal: (tab, entry) => safe(() => window.Panel?.addLocal?.(tab, entry)),
  render: (tab) => safe(() => window.Panel?.render?.(tab)),
  summary: (tab) => safe(() => window.Panel?.summary?.(tab), null) || {},
};

// ---- per-folder layout store ------------------------------------------------
// Dock layout, preset, assist panel and view modes are saved by main (userData/layouts.json,
// api.layoutGet / layoutSave). localStorage lost the last seconds of changes on quit.
let folderLayout = { dock: null, preset: 1, assistShown: true, viewModes: {}, defaultViewMode: 'rich' };
let layoutSaveT = 0;

function saveFolderLayout(now = false) {
  clearTimeout(layoutSaveT);
  layoutSaveT = 0;
  if (!layoutLoaded) return;
  if (now) {
    if (dock) folderLayout.dock = safe(() => dock.toJSON(), folderLayout.dock);
    safe(() => api.layoutSaveSync(folderLayout));
    return;
  }
  layoutSaveT = setTimeout(() => {
    layoutSaveT = 0;
    if (dock) folderLayout.dock = safe(() => dock.toJSON(), folderLayout.dock);
    safe(() => api.layoutSave(folderLayout));
  }, 300);
}
let layoutLoaded = false;

async function loadFolderLayout() {
  let saved = null;
  try {
    saved = await api.layoutGet();
  } catch (err) {
    console.error(err);
  }
  if (saved) folderLayout = saved;
  else {
    // First run with the file store: take over what the localStorage version had saved.
    const json = safe(() => JSON.parse(localStorage.getItem(`dockLayout:${normPath(info.workDir)}`) || 'null'), null);
    const preset = Number(localStorage.getItem('layout'));
    const modes = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const m = /^viewMode:(.+)$/.exec(k || '');
      if (m) modes[m[1]] = localStorage.getItem(k);
    }
    folderLayout = {
      dock: json,
      preset: [1, 2, 4].includes(preset) ? preset : 1,
      assistShown: localStorage.getItem('assistShown') !== '0',
      viewModes: modes,
      defaultViewMode: VIEW_MODES.includes(localStorage.getItem('defaultViewMode')) ? localStorage.getItem('defaultViewMode') : 'rich',
    };
  }
  layoutPreset = [1, 2, 4].includes(folderLayout.preset) ? folderLayout.preset : 1;
  layoutLoaded = true;
}

// Composer drafts (per tab) and send history (per folder): a separate store in main
// (api.composerGet / composerSave / composerSaveSync), written asynchronously, size-capped.
let composerStore = { drafts: {}, history: [] };
let composerLoaded = false;
let composerSaveT = 0;

function saveComposerStore(now = false) {
  clearTimeout(composerSaveT);
  composerSaveT = 0;
  if (!composerLoaded) return;
  if (now) {
    safe(() => api.composerSaveSync?.(composerStore));
    return;
  }
  composerSaveT = setTimeout(() => {
    composerSaveT = 0;
    safe(() => api.composerSave?.(composerStore));
  }, 400);
}

async function loadComposerStore() {
  let s = null;
  try {
    s = await api.composerGet?.();
  } catch (err) {
    console.error(err);
  }
  composerStore = { drafts: (s && s.drafts) || {}, history: (s && s.history) || [] };
  composerLoaded = true;
}

window.addEventListener('beforeunload', () => {
  for (const t of tabs.values()) safe(() => t.conv?.composer?.flushDraft());
  saveComposerStore(true);
  saveFolderLayout(true);
});

// ---- Conversation view wrappers (conversation.js) ---------------------------
// Display mode per tab (folderLayout.viewModes): 'rich' = conversation view over the terminal
// (terminal kept laid out underneath so the pty size and screen parsing stay valid), 'term' =
// terminal only, 'split' = conversation in its own dock panel next to the terminal pane.
// tab.peek: false | 'manual' | 'auto' – in rich mode, temporarily show the terminal instead.
const VIEW_MODES = ['rich', 'term', 'split'];
const C = {
  create: (tab, opts) => safe(() => window.Conversation?.create?.(tab, opts), null),
  onEvent: (tab, evt) => safe(() => window.Conversation?.onEvent?.(tab, evt)),
  onScreen: (tab, s) => safe(() => window.Conversation?.onScreen?.(tab, s)),
  focus: (tab) => safe(() => window.Conversation?.focus?.(tab)),
  beginBulk: (tab) => safe(() => window.Conversation?.beginBulk?.(tab)),
  endBulk: (tab) => safe(() => window.Conversation?.endBulk?.(tab)),
};
const defaultViewMode = () => (VIEW_MODES.includes(folderLayout.defaultViewMode) ? folderLayout.defaultViewMode : 'rich');
const savedViewMode = (id) => (VIEW_MODES.includes(folderLayout.viewModes[id]) ? folderLayout.viewModes[id] : null);
function rememberViewMode(id, mode, asDefault) {
  if (mode) folderLayout.viewModes[id] = mode;
  else delete folderLayout.viewModes[id];
  if (asDefault) folderLayout.defaultViewMode = mode;
  saveFolderLayout();
}
const convShown = (tab) => !!tab?.conv && ((tab.mode === 'rich' && !tab.peek) || tab.mode === 'split');

// The composer (tab.conv.dock) lives in the conversation view except in 'term' mode, where core
// puts it under the terminal. Put it back (or keep it with a detached tab, e.g. a closed one).
function restoreComposer(tab, dockEl) {
  if (!dockEl) return;
  if (tab?.conv && tab.conv.dock === dockEl) {
    if (dockEl.parentNode !== tab.conv.el) tab.conv.el.append(dockEl);
  } else dockEl.remove();
}

// Keyboard focus for a tab: its text box whenever one is on screen (conversation view, or the
// composer under the terminal), else the terminal.
function focusTab(tab) {
  if (!tab) return;
  // Typing in the dashboard page (manager window): an automatic activation (layout change, the manager
  // session restarting) must not pull the caret into the session; that would also end the IME composition.
  // A click on the session itself has already moved the focus out of the page by the time this runs.
  if (document.getElementById('dashboard')?.contains(document.activeElement)) return;
  const conv = tab.conv;
  if (conv && (conv.el.contains(document.activeElement) || conv.dock.contains(document.activeElement))) return;
  if (conv && ((tab.mode === 'rich' && !tab.peek && conv.el.isConnected) || (tab.mode === 'term' && conv.dock.isConnected))) C.focus(tab);
  else tab.term.focus();
}

let panelRaf = 0;
// UX8: while events stream the section tab titles (their badges: "ツール 12") changed on every tool call, and each
// new title re-laid out the dock (onDidLayoutChange -> fitSoon -> the terminal measured). At most every TITLES_GAP_MS
// from renderPanelSoon; renderPanelNow (a tab switch) at once.
const TITLES_GAP_MS = 1000;
let titlesAt = 0;
let titlesTimer = 0;
function updateSectionTitlesSoon() {
  const wait = TITLES_GAP_MS - (Date.now() - titlesAt);
  if (wait <= 0) {
    clearTimeout(titlesTimer);
    titlesTimer = 0;
    titlesAt = Date.now();
    updateSectionTitles();
  } else if (!titlesTimer) {
    titlesTimer = setTimeout(() => {
      titlesTimer = 0;
      titlesAt = Date.now();
      updateSectionTitles();
    }, wait);
  }
}
function renderPanelSoon() {
  if (panelRaf) return;
  panelRaf = requestAnimationFrame(() => {
    panelRaf = 0;
    P.render(tabs.get(activeId));
    updateSectionTitlesSoon();
  });
}
function renderPanelNow() {
  cancelAnimationFrame(panelRaf);
  panelRaf = 0;
  P.render(tabs.get(activeId));
  updateSectionTitles();
}

// ---- panes / dock layout ---------------------------------------------------
// The area below the top bar is a dockview layout (node_modules/dockview-core, UMD global).
// Panel kinds (dockview "components"):
//   'pane'   – shows one session's terminal; which session = pane.tabId (picked via the top tabs)
//   'assist' – the side panel (#panel, rendered by panel.js)
// Sashes resize, dragging a panel tab moves / docks it, dragging a session tab from the top bar
// onto the layout opens it in a new pane there. The layout is saved per folder (main: layouts.json).
const DV = window['dockview-core'];
const TAB_MIME = 'application/x-bantodesk-tab';
const panes = []; // pane objects, creation order
const paneById = new Map();
const stash = h('div', 'term-stash');
const assistEl = document.getElementById('panel');
const assistHost = h('div', 'assist-host');
let assistApi = null; // dockview panel api while the assist panel is in the layout
let dock = null;
let paneSeq = 0;
let useClock = 0;
let focusedPane = null;
let rebuilding = false;
let layoutPreset = 1; // set from folderLayout.preset by loadFolderLayout()
const ASSIST_WIDTH = 320;

function makePane(id) {
  const el = h('div', 'pane');
  el.dataset.pane = id;
  const body = h('div', 'pane-body');
  const empty = h('div', 'pane-empty');
  empty.append(h('span', 'pane-empty-text', 'タブを選ぶか、上のタブをここへドラッグすると表示されます'));
  body.append(empty);
  el.append(body);
  // pane header = the dockview tab (status dot, label, badge, status, close)
  const head = h('div', 'pane-tab');
  const dot = h('span', 'dot');
  const label = h('span', 'pane-label');
  const wt = h('span', 'wt-badge');
  const st = h('span', 'pane-status');
  const modeBtn = h('span', 'pane-mode');
  modeBtn.title = `クリックで 会話 → ターミナル → 並べる の順に切り替え（${scKey('viewMode')}）`;
  const close = h('span', 'pane-close', '×');
  close.title = 'ペインを閉じる（セッションは閉じません）';
  head.append(dot, label, wt, st, modeBtn, close);
  const pane = { id, el, body, empty, head, dot, label, wt, st, modeBtn, close, dv: null, tabId: null, used: 0 };
  // 「待機中 · コマンド 26分」: what the session waits for (waits:state), the commands' output on a click
  st.addEventListener('mousedown', (e) => {
    if (st.classList.contains('has-wait')) e.stopPropagation();
  });
  st.addEventListener('click', (e) => {
    const tab = tabs.get(pane.tabId);
    if (!waitOf(tab)) return;
    e.stopPropagation();
    const r = st.getBoundingClientRect();
    openWaitPop(tab, { x: r.left, y: r.bottom });
  });
  modeBtn.dataset.usage = 'session.mode.toggle'; // UA1
  modeBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  modeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const tab = tabs.get(pane.tabId);
    if (tab) toggleViewMode(tab);
  });

  el.addEventListener('mousedown', () => {
    if (pane.tabId && tabs.has(pane.tabId)) {
      if (pane.tabId !== activeId) activate(pane.tabId);
    } else {
      pane.used = -1; // empty pane: target for the next tab activation
    }
  }, true);
  close.addEventListener('mousedown', (e) => e.stopPropagation());
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    pane.dv?.close();
  });

  // drag & drop files -> paste paths
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  el.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    el.classList.add('drop');
  });
  el.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drop');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop');
  });
  el.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop');
    const tab = tabs.get(pane.tabId);
    if (!tab || tab.exited) return;
    const raw = [...(e.dataTransfer?.files || [])].map((f) => safe(() => api.pathForFile(f), '')).filter(Boolean);
    if (!raw.length) return;
    // A composer on screen (conversation view, or under the terminal) takes the files as chips.
    if (tab.conv?.composer && (tab.mode === 'term' || (tab.mode === 'rich' && !tab.peek))) {
      tab.conv.composer.addFiles(raw);
      activate(tab.id);
      return;
    }
    tab.term.paste(`${raw.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ')} `);
    activate(tab.id);
  });

  if (typeof ResizeObserver === 'function') new ResizeObserver(fitSoon).observe(body);
  const n = Number(/^pane-(\d+)$/.exec(id)?.[1]);
  if (n > paneSeq) paneSeq = n;
  paneById.set(id, pane);
  panes.push(pane);
  return pane;
}

const getPane = (id) => paneById.get(id) || makePane(id);

function dropPane(pane) {
  paneById.delete(pane.id);
  const i = panes.indexOf(pane);
  if (i >= 0) panes.splice(i, 1);
  if (focusedPane === pane) focusedPane = null;
  const tab = tabs.get(pane.tabId);
  if (tab && tab.el.parentNode === pane.body) stash.append(tab.el);
  if (rebuilding) return;
  // Never leave the layout without a terminal pane.
  if (!panes.length) {
    const p = addPane({ direction: 'left' });
    if (p && activeId) p.tabId = activeId;
  }
  queueMicrotask(() => {
    // The active session lost its pane: switch to a session that is still on screen.
    if (activeId && !paneOfTab(activeId)) {
      const next = panes.find((p) => p.tabId && tabs.has(p.tabId) && paneShown(p));
      if (next) activate(next.tabId);
    }
    applyLayout();
    fitSoon();
    scheduleRemote();
  });
}

function addPane(position, opts = {}) {
  const id = `pane-${++paneSeq}`;
  dock.addPanel({ id, component: 'pane', tabComponent: 'pane', title: id, position, inactive: !!opts.inactive });
  return paneById.get(id);
}

// ---- assist sections (roadmap 12) ---------------------------------------------
// The assist panel is split into one dock panel per function (Panel.SECTIONS from panel.js:
// 概要 / タスク / チーム / エージェント / 変更ファイル / ツール), id `sec-<id>`, component 'section'.
// They open as tabs of one group on the right; users can drag any of them elsewhere.
// Without Panel.SECTIONS (older panel.js) the single legacy 'assist' panel (#panel) is used.
const sectionHosts = new Map(); // section id -> container element (handed to Panel.attach)
const sectionApis = new Map(); // section id -> dock panel api
const sectionTitles = new Map(); // section id -> last title set (avoid redundant setTitle)
const panelSections = () => safe(() => window.Panel?.SECTIONS, null) || [];
const useSections = () => panelSections().length > 0;
const assistShownNow = () => (useSections() ? sectionApis.size > 0 : !!assistApi);
const anyAssistApi = () => sectionApis.get(panelSections()[0]?.id) || sectionApis.values().next().value || assistApi;

function sectionHost(id) {
  let el = sectionHosts.get(id);
  if (!el) {
    el = h('div', 'section-host');
    el.dataset.section = id;
    sectionHosts.set(id, el);
  }
  return el;
}

function addAssist() {
  if (!useSections()) {
    if (assistApi) return;
    dock.addPanel({
      id: 'assist', component: 'assist', title: 'アシスト',
      position: { direction: 'right' }, initialWidth: ASSIST_WIDTH, inactive: true,
    });
    // initialWidth is only a hint once other groups share the row; pin it explicitly.
    safe(() => assistApi?.group?.api.setSize({ width: ASSIST_WIDTH }));
    return;
  }
  const secs = panelSections();
  const missing = secs.filter((s) => !sectionApis.has(s.id));
  if (!missing.length) return;
  const fresh = missing.length === secs.length;
  // Fresh column: state on top (概要 タスク チーム エージェント), activity below (変更ファイル ツール),
  // so the tabs of each group fit a ~320px column. Sections added later join an open section's group.
  const LOWER = new Set(['files', 'tools']);
  for (const s of missing) {
    const sameRow = secs.find((x) => x !== s && sectionApis.has(x.id) && (!fresh || LOWER.has(x.id) === LOWER.has(s.id)));
    let position;
    if (sameRow) position = { referencePanel: `sec-${sameRow.id}`, direction: 'within' };
    else if (fresh && LOWER.has(s.id) && sectionApis.size) position = { referencePanel: `sec-${secs[0].id}`, direction: 'below' };
    else position = { direction: 'right' };
    safe(() => dock.addPanel({ id: `sec-${s.id}`, component: 'section', title: s.title, position, initialWidth: ASSIST_WIDTH, inactive: true }));
  }
  if (fresh) {
    safe(() => sectionApis.get(secs[0].id)?.setActive()); // 概要 in front
    safe(() => sectionApis.get('tools')?.setActive()); // ツール in front of the lower group
    safe(() => anyAssistApi()?.group?.api.setSize({ width: ASSIST_WIDTH }));
  }
  updateSectionTitles();
}

// Dock tab titles carry the section badges (e.g. "タスク 1/2", "ツール 12 · 1 err").
function updateSectionTitles() {
  if (!sectionApis.size) return;
  const tab = tabs.get(activeId);
  const badges = safe(() => window.Panel?.badges?.(tab), null) || {};
  for (const s of panelSections()) {
    const api = sectionApis.get(s.id);
    if (!api) continue;
    safe(() => api.group?.element?.classList.add('assist-group')); // compact tabs (style.css)
    const b = badges[s.id];
    // compact badges for tabs: "1 実行中" -> "▶1", "12 · 1 err" -> "12 ⚠1"
    const badge = b && b.badge ? String(b.badge).replace(/^(\d+) 実行中$/, '▶$1').replace(/\s*·\s*(\d+) err$/, ' ⚠$1').replace(/^≈\s*/, '') : '';
    const title = badge ? `${s.title} ${badge}` : s.title;
    if (sectionTitles.get(s.id) === title) continue;
    sectionTitles.set(s.id, title);
    safe(() => api.setTitle(title));
  }
}

// The 通知 dock panel is gone (UIUX U4): its settings are in ⚙ 設定 (settings.js), what to answer in the dashboard's
// 「あなたの番」, the rest in「PMO の記録」(Ctrl+Shift+E). A saved layout's 'notify' panel closes itself (createComponent).
function openPmoLog() {
  if (info.role === 'manager') safe(() => window.Dashboard?.showTab?.('log'));
  else safe(() => api.dashboardOpen?.({ tab: 'log' }));
}

// The バックログ panel (dock panel kind 'backlog', element from backlog.js), next to the assist panel.
let backlogApi = null;
const backlogHost = h('div', 'backlog-host');
function toggleBacklogPanel(force) {
  const on = force ?? !backlogApi;
  if (!on) {
    safe(() => backlogApi?.close());
    return;
  }
  if (backlogApi) {
    safe(() => backlogApi.setActive());
    return;
  }
  const ref = anyAssistApi();
  const position = ref ? { referencePanel: ref.id, direction: 'within' } : { direction: 'right' };
  safe(() => dock.addPanel({ id: 'backlog', component: 'backlog', title: (window.Labels && window.Labels.WORDS.queueList) || '待ちの一覧', position, initialWidth: ASSIST_WIDTH }));
}

// Manager window (app:info role 'manager') = the integrated dashboard (roadmap 20): a full page
// (#dashboard, dashboard.js: folders with their sessions' status and task queues, the inbox) and the
// manager agent's session in a narrow column on the right (body.dash-mode, dashboard.css).
// Dock panels 'db-inbox' / 'db-projects' of the earlier layout may come back from a saved layout: close them.
function ensureDashboardPanels() {
  if (info.role !== 'manager') return;
  for (const p of [...dock.panels]) if (/^db-/.test(p.id)) safe(() => p.api.close());
}

// The border between the dashboard page and the manager agent's column (dash-mode only): drag to set the
// column's width, double-click for the default. The width is kept in the manager folder's layout
// (folderLayout.dashChatWidth, main's layouts.json; saved on release). Limits: column >= DASH_CHAT_MIN, page >= DASH_PAGE_MIN (the column's minimum wins when the
// window is too narrow for both); re-applied when the window is resized. xterm follows through the
// ResizeObserver on #terminals (fitSoon, one fit per frame) plus one fit on release.
const DASH_CHAT_DEFAULT = 420;
const DASH_CHAT_MIN = 280;
const DASH_PAGE_MIN = 480;
function setupDashSplit(dashEl) {
  const col = document.getElementById('dash-chat') || termsEl; // the 「PMO に相談」 column (heading + the session)
  const split = h('div', 'dash-split');
  split.title = 'ドラッグで幅を変更（ダブルクリックで既定の幅）';
  col.parentNode.insertBefore(split, col);
  let want = Number(folderLayout.dashChatWidth) || DASH_CHAT_DEFAULT;
  const apply = (w) => {
    const box = col.parentNode;
    const cs = getComputedStyle(box);
    const inner = box.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const room = inner - split.offsetWidth - DASH_PAGE_MIN;
    const px = Math.round(Math.max(DASH_CHAT_MIN, Math.min(w, room)));
    col.style.width = `${px}px`;
    return px;
  };
  apply(want);
  window.addEventListener('resize', () => apply(want));
  let drag = null;
  // mousedown default would move focus (and end an IME composition in the inbox field): keep it where it is
  split.addEventListener('mousedown', (e) => e.preventDefault());
  split.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, w: col.offsetWidth, raf: 0, last: e.clientX };
    split.setPointerCapture(e.pointerId);
    document.body.classList.add('dash-resizing');
  });
  split.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.last = e.clientX;
    if (drag.raf) return;
    drag.raf = requestAnimationFrame(() => {
      if (!drag) return;
      drag.raf = 0;
      want = apply(drag.w + (drag.x - drag.last));
    });
  });
  const end = () => {
    if (!drag) return;
    if (drag.raf) cancelAnimationFrame(drag.raf);
    want = apply(drag.w + (drag.x - drag.last));
    drag = null;
    document.body.classList.remove('dash-resizing');
    folderLayout.dashChatWidth = want;
    saveFolderLayout();
    fitSoon();
  };
  split.addEventListener('pointerup', end);
  split.addEventListener('pointercancel', end);
  split.addEventListener('lostpointercapture', end);
  split.addEventListener('dblclick', () => {
    want = apply(DASH_CHAT_DEFAULT);
    delete folderLayout.dashChatWidth;
    saveFolderLayout();
    fitSoon();
  });
}

// The manager window's right column: 「PMO に相談」 heading with the PMO's role, above its session (PROGRESS 45).
const PMO_ROLE_TEXT = '全プロジェクトを見て、依頼の振り分け・順番決め・指摘をする。何でも相談できます';
function buildPmoColumn() {
  const col = h('div', '');
  col.id = 'dash-chat';
  termsEl.parentNode.insertBefore(col, termsEl);
  const head = h('div', 'dash-pmo-head');
  // U4 (docs/ui-copy.md 1): the role is the heading's tooltip, not a line of text under it
  head.append(h('div', 'dash-pmo-title', 'PMO に相談'));
  head.title = `${PMO_ROLE_TEXT}。下の入力欄から話しかけられます。重くなったら自動で新しいセッションに引き継ぎます`;
  // a click on the heading puts the caret in the input box (without ending an IME composition elsewhere first)
  head.addEventListener('mousedown', (e) => e.preventDefault());
  head.addEventListener('click', () => focusPmo());
  col.append(head, termsEl);
}

// 「PMO に相談」 (widget / tray, main sends dashboard:focusPmo; PROGRESS 45): the PMO's session shown, caret in its
// input box. Before the window's init it is kept and done after the restore. A composition already going on in that
// box is left alone (focusing again would end it); the caret is put there at most a few times while the window comes up.
let pmoFocusWanted = false;
function focusPmo() {
  if (info.role !== 'manager') return;
  if (!restoreDone) {
    pmoFocusWanted = true;
    return;
  }
  pmoFocusWanted = false;
  const tab = residentTab();
  if (!tab) return;
  if (activeId !== tab.id) activate(tab.id);
  let tries = 0;
  const put = () => {
    const box = pmoInputOf(tab);
    if (box && document.activeElement === box) return; // there already (maybe composing): leave it
    if (box) {
      box.focus();
    } else safe(() => tab.term.focus());
    if (++tries < 4) setTimeout(put, 250); // the window may take the focus only after it is shown
  };
  requestAnimationFrame(put);
}
// the PMO's input box (the composer textarea in the dock), null in the plain terminal mode
function pmoInputOf(tab) {
  const dock = tab?.conv?.dock;
  if (!dock || !dock.isConnected) return null;
  return dock.querySelector('textarea');
}
if (typeof api !== 'undefined' && api.onDashboardFocusPmo) api.onDashboardFocusPmo(() => focusPmo());
// dashboard:open { tab } from another window (Ctrl+Shift+E there -> PMO の記録): main sends dashboard:showTab here
if (typeof api !== 'undefined') api.onDashboardShowTab?.((o) => info.role === 'manager' && safe(() => window.Dashboard?.showTab?.(o && o.tab)));

function setAssistShown(on) {
  folderLayout.assistShown = !!on;
  saveFolderLayout();
  if (on) addAssist();
  else {
    for (const api of [...sectionApis.values()]) safe(() => api.close());
    if (assistApi) safe(() => assistApi.close());
  }
  renderPanelSoon();
  fitSoon();
}

// Conversation dock panels ('split' mode): id `conv-<tabId>`. They can be restored from a saved
// layout before the tab exists, so the host shows a placeholder until the tab attaches.
const convPanels = new Map(); // tabId -> { host, placeholder, api }
const convPanelId = (tabId) => `conv-${tabId}`;

function convPanelTitle(tab) {
  return `会話: ${tab ? tab.label : ''}`;
}

function ensureConvPanel(tab) {
  if (convPanels.get(tab.id)?.api) return;
  const pane = paneOfTab(tab.id);
  const position = pane?.dv ? { referencePanel: pane.id, direction: 'right' } : { direction: 'right' };
  safe(() => dock.addPanel({ id: convPanelId(tab.id), component: 'conv', title: convPanelTitle(tab), position, inactive: true }));
}

function closeConvPanel(tabId) {
  const cp = convPanels.get(tabId);
  if (cp?.api) safe(() => cp.api.close());
}

function attachConvPanels() {
  for (const [tabId, cp] of convPanels) {
    const tab = tabs.get(tabId);
    cp.placeholder.hidden = !!tab;
    if (tab && tab.mode === 'split' && tab.conv && tab.conv.el.parentNode !== cp.host) cp.host.append(tab.conv.el);
    if (tab) safe(() => cp.api?.setTitle(convPanelTitle(tab)));
  }
}

function setViewMode(tab, mode) {
  if (!VIEW_MODES.includes(mode) || !tab.conv) return;
  const prev = tab.mode;
  tab.mode = mode;
  tab.peek = false;
  rememberViewMode(tab.id, mode, true);
  if (mode === 'split') ensureConvPanel(tab);
  else if (prev === 'split') closeConvPanel(tab.id);
  applyLayout();
  fitSoon();
  scan(tab);
  if (tab.id === activeId) requestAnimationFrame(() => focusTab(tab));
}

function toggleViewMode(tab) {
  // The pane tab's button (and Ctrl+Shift+M) steps through the modes in order.
  const next = { rich: 'term', term: 'split', split: 'rich' }[tab.mode] || 'rich';
  setViewMode(tab, next);
}

// Automatic view switches move the keyboard focus only when it is already on this session (or
// nowhere), never out of the rename box, the assist panel or another session's input.
function focusIsOnTab(tab) {
  const a = document.activeElement;
  return !a || a === document.body || tab.el.contains(a) || !!tab.conv?.el.contains(a) || !!tab.conv?.dock.contains(a) || !!tab.peekBar?.contains(a);
}

function setPeek(tab, peek, { user = false } = {}) {
  if (tab.peek === peek) return;
  const mayFocus = tab.id === activeId && (user || focusIsOnTab(tab));
  tab.peek = peek;
  applyLayout();
  fitSoon();
  scan(tab);
  if (mayFocus) requestAnimationFrame(() => focusTab(tab));
}

// "会話に戻る": leaving an auto-shown terminal also suppresses auto-show for the current screen.
function leavePeek(tab) {
  if (tab.peek === 'auto') tab.peekDismissed = screenTailKey(physicalScreen(tab));
  setPeek(tab, false, { user: true });
}

function makePeekBar(tab) {
  const bar = h('div', 'peek-bar');
  const text = h('span');
  const back = h('button', null, '会話に戻る');
  back.type = 'button';
  back.addEventListener('mousedown', (e) => e.stopPropagation());
  back.addEventListener('click', () => leavePeek(tab));
  bar.append(text, back);
  bar.hidden = true;
  tab.peekBar = bar;
  tab.peekText = text;
}

// ---- member views: read-only conversation of a team member / subagent ----------------
// Opened from the assist panel (document event 'bantodesk:open-member' {tabId, agentId, name}).
// Dock panel kind 'member', id `member-<agentId>`; not restored after a restart.
const memberViews = new Map(); // agentId -> { tabId, agentId, name, view, host, api, timer, loading }
const MEMBER_RELOAD_MS = 800;

function openMemberView({ tabId, agentId, name } = {}) {
  const tab = tabs.get(tabId);
  if (!tab || !/^[A-Za-z0-9_-]{1,100}$/.test(String(agentId || ''))) return;
  const existing = memberViews.get(agentId);
  if (existing?.api) {
    safe(() => existing.api.setActive());
    return;
  }
  const view = { id: `member:${agentId}` };
  view.conv = C.create(view, { readOnly: true }) || null;
  if (!view.conv) return;
  const host = h('div', 'conv-host member-host');
  const head = h('div', 'member-head');
  const term = h('button', null, 'リーダーのターミナルを表示');
  term.type = 'button';
  term.title = 'Claude Code のメンバー画面は、リーダーのターミナルで ↓ キー → Enter で開けます';
  term.addEventListener('click', () => {
    activate(tabId);
    const t = tabs.get(tabId);
    if (t?.mode === 'rich') setPeek(t, 'manual', { user: true });
    else t && focusTab(t);
  });
  head.append(h('span', null, `@${name || agentId} の会話（読み取り専用）`), h('span', 'cv-spacer'), term);
  host.append(head, view.conv.el);
  const mv = { tabId, agentId, name: name || agentId, view, host, api: null, timer: 0, loading: false, snap: tab.subSnaps?.get(agentId) || null };
  memberViews.set(agentId, mv);
  const pane = paneOfTab(tabId);
  const position = pane?.dv ? { referencePanel: pane.id, direction: 'right' } : { direction: 'right' };
  safe(() => dock.addPanel({ id: `member-${agentId}`, component: 'member', title: `@${mv.name}`, position }));
  reloadMemberView(mv);
}

async function reloadMemberView(mv) {
  if (mv.loading) {
    mv.again = true;
    return;
  }
  mv.loading = true;
  let evts = [];
  try {
    evts = (await api.replayAgent({ sessionId: mv.tabId, agentId: mv.agentId })) || [];
  } catch (err) {
    console.error('replayAgent failed', err);
  }
  mv.loading = false;
  if (memberViews.get(mv.agentId) !== mv) return;
  const first = !mv.loaded;
  mv.loaded = true;
  if (first) C.beginBulk(mv.view);
  for (const e of evts) C.onEvent(mv.view, e);
  if (first) C.endBulk(mv.view);
  if (first && !evts.length) mv.view.conv.empty.textContent = 'このメンバーの会話はまだありません';
  updateMemberStatus(mv);
  if (mv.again) {
    mv.again = false;
    reloadMemberView(mv);
  }
}

function updateMemberStatus(mv, snap) {
  if (snap) mv.snap = snap;
  const s = mv.snap;
  const running = !!s && s.status === 'running';
  const spinner = running && s.lastTool ? `${s.lastTool.name} ${s.lastTool.arg || ''}` : '';
  C.onScreen(mv.view, { status: running ? 'running' : 'idle', exited: false, choices: null, spinner, needTerminal: false, mode: null, peek: false });
}

// Subagent activity of an open member view -> refresh it (debounced).
function memberActivity(tab, evt) {
  if (evt.kind !== 'subagent' || !memberViews.size) return;
  const mv = memberViews.get(evt.agentId);
  if (!mv || mv.tabId !== tab.id) return;
  updateMemberStatus(mv, evt);
  clearTimeout(mv.timer);
  mv.timer = setTimeout(() => reloadMemberView(mv), MEMBER_RELOAD_MS);
}

document.addEventListener('bantodesk:open-member', (e) => openMemberView(e.detail));

// ---- viewer panels (roadmap 5b, docs/plan-viewer.md): MD / image / HTML / PDF of a local file ---------------------
// Dock panel kind 'viewer', id `viewer-<n>`. Not restored after a restart (user decision 2026-11-03): a viewer panel
// found in a saved layout closes itself, like 'member'. Main checks every path (src/main/viewer.js).
const viewerViews = new Map(); // panel id -> { id: panel id, info, view, api }
let viewerSeq = 0;
const VIEWER_REASONS = {
  unsupported: 'ビューアで開けない形式です',
  missing: 'ファイルが見つかりません',
  badpath: 'パスが正しくありません',
};

// UX2: the separator comes from the folder (paths.js): C:\… / \\server keep "\", a macOS folder joins with "/" and a
// path starting with "/" is already absolute there.
function viewerAbsPath(p, tabId) {
  const tab = tabs.get(tabId) || tabs.get(activeId);
  const base = (tab && tab.cwd) || info.workDir || '';
  return window.AtPath.absPath(p, base);
}

// UX2: a short note at the bottom of the window that does not stop the screen (window.alert did: docs/mac-polish.md M1).
let toastBox = null;
function toast(text, { ms = 4000 } = {}) {
  if (!toastBox) {
    toastBox = h('div', 'at-toasts');
    toastBox.setAttribute('role', 'status');
    toastBox.setAttribute('aria-live', 'polite');
    document.body.append(toastBox);
  }
  const t = h('div', 'at-toast', text);
  toastBox.append(t);
  while (toastBox.children.length > 3) toastBox.firstChild.remove();
  setTimeout(() => t.remove(), ms);
  return t;
}

async function openViewer(p, { source = 'event', tabId = null } = {}) {
  if (!window.Viewer || !p || !dock) return null; // before the layout exists (startup) there is nowhere to show it
  const path = viewerAbsPath(p, tabId);
  if (!window.Viewer.canOpen(path)) return null;
  let r = null;
  try {
    r = await api.viewerOpen({ path, source });
  } catch (err) {
    console.error('viewerOpen failed', err);
  }
  return showViewer(r, path);
}

async function pickViewer() {
  if (!window.Viewer || !dock) return;
  showViewer(await safe(() => api.viewerPick(), null));
}

function showViewer(r, path = '') {
  if (!r || !r.ok) {
    if (r && VIEWER_REASONS[r.reason]) toast(path ? `${VIEWER_REASONS[r.reason]}: ${path}` : VIEWER_REASONS[r.reason]);
    return null;
  }
  for (const vv of viewerViews.values()) {
    if (vv.info.id === r.id) {
      safe(() => vv.api?.setActive());
      return vv;
    }
  }
  const id = `viewer-${++viewerSeq}`;
  const vv = { id, info: r, view: null, api: null };
  vv.view = window.Viewer.create(r, { onOpenPath: (abs) => openViewer(abs, { source: 'link' }) });
  if (!vv.view) return null;
  viewerViews.set(id, vv);
  // next to the other viewers (as a tab of their group), else right of the active session's pane
  const other = [...viewerViews.values()].find((x) => x !== vv && x.api);
  const group = other && safe(() => dock.getPanel(other.id)?.group, null);
  const pane = paneOfTab(activeId);
  const position = group ? { referenceGroup: group, direction: 'within' } : pane?.dv ? { referencePanel: pane.id, direction: 'right' } : { direction: 'right' };
  safe(() => dock.addPanel({ id, component: 'viewer', title: r.name, position }));
  if (!safe(() => dock.getPanel(id), null)) {
    // no panel came up: do not leave an orphan entry (and main's watcher) behind
    viewerViews.delete(id);
    safe(() => vv.view.dispose());
    safe(() => api.viewerClose({ id: r.id }));
    return null;
  }
  return vv;
}

api.onViewerChanged?.(({ id, gone } = {}) => {
  for (const vv of viewerViews.values()) if (vv.info.id === id) safe(() => vv.view.changed(!!gone));
});
document.addEventListener('bantodesk:open-viewer', (e) => {
  const d = e.detail || {};
  openViewer(d.path, { source: 'event', tabId: d.tabId || null });
});

// Dragging files from the OS over the window: a band on top of the layout 「ビューアで開く」. Dropping there (or on a
// viewer panel) opens them; dropping on a pane / the conversation / the composer still attaches them as before.
const viewerBand = h('div', 'vw-dropband', 'ここにドロップしてビューアで開く（MD / HTML / 画像 / PDF / xlsx）');
viewerBand.hidden = true;
document.getElementById('content')?.append(viewerBand);
let viewerDragDepth = 0;
const dragHasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
const droppedViewerPaths = (e) => [...(e.dataTransfer?.files || [])]
  .map((f) => safe(() => api.pathForFile(f), ''))
  .filter((p) => p && window.Viewer?.canOpen(p));
function hideViewerBand() {
  viewerDragDepth = 0;
  viewerBand.hidden = true;
  viewerBand.classList.remove('over');
}
// capture phase: the panes stop the propagation of their own drops
window.addEventListener('dragenter', (e) => {
  if (!dragHasFiles(e) || !window.Viewer) return;
  viewerDragDepth++;
  viewerBand.hidden = false;
}, true);
window.addEventListener('dragleave', (e) => {
  if (!dragHasFiles(e)) return;
  if (--viewerDragDepth <= 0) hideViewerBand();
}, true);
window.addEventListener('drop', hideViewerBand, true);
window.addEventListener('dragend', hideViewerBand, true);
viewerBand.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  viewerBand.classList.add('over');
});
viewerBand.addEventListener('dragleave', () => viewerBand.classList.remove('over'));
viewerBand.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const list = droppedViewerPaths(e);
  hideViewerBand();
  if (!list.length) toast('ビューアで開ける形式（MD / HTML / 画像 / PDF）のファイルではありません');
  for (const p of list) openViewer(p, { source: 'drop' });
});
// panel.js 「新しいセッションへ引き継ぐ」 (document event 'bantodesk:handoff' { tabId })
document.addEventListener('bantodesk:handoff', (e) => {
  const tab = tabs.get(e.detail?.tabId);
  if (tab) handoffStart(tab);
});
function handoffStart(tab) {
  const why = safe(() => window.Handoff?.start?.(tab, 'manual'), '');
  if (why) window.alert(why);
}

function buildDock() {
  if (!assistHost.contains(assistEl)) assistHost.append(assistEl);
  termsEl.classList.add('dockview-theme-catppuccin-mocha');
  dock = DV.createDockview(termsEl, {
    disableFloatingGroups: true,
    createComponent: ({ id, name }) => {
      if (name === 'dashboard') {
        // earlier layouts only (the dashboard is a full page now): an empty host, closed by ensureDashboardPanels
        return { element: h('div', 'dashboard-host'), init: () => {}, dispose: () => {} };
      }
      if (name === 'backlog') {
        const el = safe(() => window.Backlog?.panel?.(), null);
        if (el && el.parentNode !== backlogHost) backlogHost.append(el);
        return {
          element: backlogHost,
          init: (p) => { backlogApi = p.api; safe(() => window.Backlog?.render?.()); },
          dispose: () => { backlogApi = null; },
        };
      }
      if (name === 'notify') {
        // earlier layouts only (the 通知 panel is gone, UIUX U4): an empty host that closes itself
        return { element: h('div', 'notify-host'), init: (p) => queueMicrotask(() => safe(() => p.api.close())), dispose: () => {} };
      }
      if (name === 'member') {
        const mv = memberViews.get(id.replace(/^member-/, ''));
        // Restored from a saved layout (member views are not kept across restarts): close it.
        const element = mv ? mv.host : h('div', 'conv-host');
        return {
          element,
          init: (p) => {
            if (mv) mv.api = p.api;
            else queueMicrotask(() => safe(() => p.api.close()));
          },
          dispose: () => {
            if (!mv) return;
            clearTimeout(mv.timer);
            if (memberViews.get(mv.agentId) === mv) memberViews.delete(mv.agentId);
          },
        };
      }
      if (name === 'viewer') {
        const vv = viewerViews.get(id);
        // Restored from a saved layout (viewers are not kept across restarts): close it.
        const element = vv ? vv.view.el : h('div', 'vw-host');
        if (vv) {
          // a file dropped on a viewer panel opens in a viewer too
          element.addEventListener('dragover', (e) => {
            if (!dragHasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          });
          element.addEventListener('drop', (e) => {
            if (!dragHasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            for (const p of droppedViewerPaths(e)) openViewer(p, { source: 'drop' });
          });
        }
        return {
          element,
          init: (p) => {
            if (!vv) {
              queueMicrotask(() => safe(() => p.api.close()));
              return;
            }
            vv.api = p.api;
            safe(() => vv.view.setVisible(p.api.isVisible !== false));
            p.api.onDidVisibilityChange((ev) => safe(() => vv.view.setVisible(!!ev.isVisible)));
          },
          dispose: () => {
            if (!vv) return;
            if (viewerViews.get(id) === vv) viewerViews.delete(id);
            safe(() => vv.view.dispose());
            safe(() => api.viewerClose({ id: vv.info.id }));
          },
        };
      }
      if (name === 'conv') {
        const tabId = id.replace(/^conv-/, '');
        const host = h('div', 'conv-host');
        const placeholder = h('div', 'conv-host-empty', 'このセッションは開いていません');
        host.append(placeholder);
        // Working in a session's conversation panel makes that session the active one.
        host.addEventListener('mousedown', () => {
          if (tabs.has(tabId) && tabId !== activeId) activate(tabId);
        }, true);
        const cp = { host, placeholder, api: null };
        convPanels.set(tabId, cp);
        return {
          element: host,
          init: (p) => {
            cp.api = p.api;
            queueMicrotask(attachConvPanels);
          },
          dispose: () => {
            if (convPanels.get(tabId) === cp) convPanels.delete(tabId);
            const tab = tabs.get(tabId);
            if (tab?.conv && tab.conv.el.parentNode === host) tab.conv.el.remove();
            // Closed by the user (not a preset rebuild): fall back to the terminal view.
            if (!rebuilding && tab && tab.mode === 'split') {
              tab.mode = 'term';
              rememberViewMode(tab.id, 'term', false);
              queueMicrotask(() => {
                applyLayout();
                scan(tab);
              });
            }
          },
        };
      }
      if (name === 'section') {
        const sid = id.replace(/^sec-/, '');
        const host = sectionHost(sid);
        return {
          element: host,
          init: (p) => {
            sectionApis.set(sid, p.api);
            sectionTitles.delete(sid);
            safe(() => window.Panel?.attach?.(sid, host));
            // a section behind another dock tab is drawn later (panel.js flush); draw it when it is shown
            safe(() => p.api.onDidVisibilityChange((ev) => { if (ev.isVisible) safe(() => window.Panel?.shown?.(sid)); }));
            queueMicrotask(() => {
              updateSectionTitles();
              renderPanelSoon();
            });
          },
          dispose: () => {
            if (sectionApis.get(sid)) sectionApis.delete(sid);
            safe(() => window.Panel?.detach?.(sid));
          },
        };
      }
      if (name === 'assist') {
        return {
          element: assistHost,
          init: (p) => {
            assistApi = p.api;
            // A layout saved before the split: replace the single panel by the section panels.
            if (useSections()) queueMicrotask(() => {
              safe(() => p.api.close());
              if (folderLayout.assistShown !== false) addAssist();
            });
          },
          dispose: () => { assistApi = null; },
        };
      }
      const pane = getPane(id);
      return {
        element: pane.el,
        init: (p) => {
          pane.dv = p.api;
          p.api.onDidVisibilityChange(() => {
            applyLayout();
            fitSoon();
          });
        },
        dispose: () => dropPane(pane),
      };
    },
    createTabComponent: ({ id, name }) => {
      if (name !== 'pane') return undefined; // default tab (with its own close button)
      const pane = getPane(id);
      return { element: pane.head, init: () => {} };
    },
  });

  dock.onDidActivePanelChange((e) => {
    const panel = e?.panel ?? e;
    // UA1: an assist panel tab the user chose (a pointer press just before; not the layout's own activations)
    if (panel && /^sec-[a-z]+$/.test(panel.id) && Date.now() - lastPointerAt < 1500) safe(() => window.Usage?.track?.('click', 'session.panel.' + panel.id.slice(4)));
    const pane = panel && paneById.get(panel.id);
    if (rebuilding || !pane || !pane.tabId || pane.tabId === activeId || !tabs.has(pane.tabId)) return;
    activate(pane.tabId);
  });

  // Session tab dragged from the top bar onto the layout -> show it in a new pane there
  // (or, dropped on the middle of a terminal pane, in that pane).
  dock.onUnhandledDragOver((e) => {
    const types = e.nativeEvent?.dataTransfer?.types || [];
    if ([...types].includes(TAB_MIME)) e.accept();
  });
  dock.onDidDrop((e) => {
    const id = e.nativeEvent?.dataTransfer?.getData(TAB_MIME);
    if (!id || !tabs.has(id)) return;
    const dir = { top: 'above', bottom: 'below', left: 'left', right: 'right', center: 'within' }[e.position] || 'right';
    let target = null;
    const groupPane = e.group?.activePanel && paneById.get(e.group.activePanel.id);
    if (dir === 'within' && groupPane) target = groupPane;
    else target = addPane(e.group ? { referenceGroup: e.group, direction: dir } : { direction: dir });
    if (!target) return;
    showInPane(target, id);
  });

  dock.onDidLayoutChange(() => {
    fitSoon();
    if (!rebuilding) saveFolderLayout(); // debounced; written by main
  });

  let restored = false;
  if (folderLayout.dock) {
    rebuilding = true;
    restored = safe(() => {
      dock.fromJSON(folderLayout.dock);
      return panes.length > 0;
    }, false);
    rebuilding = false;
  }
  if (!restored) buildPreset(layoutPreset);
  else {
    const wantAssist = folderLayout.assistShown !== false;
    if (wantAssist !== assistShownNow()) setAssistShown(wantAssist);
  }
}

// Presets (layout button / Ctrl+Shift+L): 1 pane, 2 side by side, 2x2 — plus the assist panel.
function buildPreset(n) {
  const keep = [activeId, ...panes.map((p) => p.tabId)].filter((id, i, a) => id && tabs.has(id) && a.indexOf(id) === i);
  rebuilding = true;
  safe(() => dock.clear());
  panes.length = 0;
  paneById.clear();
  focusedPane = null;
  paneSeq = 0;
  const p1 = addPane(undefined);
  if (n >= 2) {
    const p2 = addPane({ referencePanel: p1.id, direction: 'right' }, { inactive: true });
    if (n >= 4) {
      addPane({ referencePanel: p1.id, direction: 'below' }, { inactive: true });
      addPane({ referencePanel: p2.id, direction: 'below' }, { inactive: true });
    }
  }
  if (folderLayout.assistShown !== false) addAssist();
  if (n >= 2) {
    // Split the terminal area evenly between the two columns.
    const avail = termsEl.clientWidth - (assistShownNow() ? ASSIST_WIDTH : 0);
    if (avail > 200) {
      safe(() => p1.dv.group.api.setSize({ width: Math.floor(avail / 2) }));
      // resizing the first column takes space from the assist panel too: re-pin it
      safe(() => anyAssistApi()?.group?.api.setSize({ width: ASSIST_WIDTH }));
    }
  }
  rebuilding = false;
  panes.forEach((p, i) => { p.tabId = keep[i] || null; });
  fillEmptyPanes();
  // dock.clear() removed the conversation panels: put back the ones of 'split' tabs.
  for (const t of tabs.values()) if (t.mode === 'split') ensureConvPanel(t);
  if (restoreDone) ensureDashboardPanels();
  if (activeId) paneOfTab(activeId)?.dv?.setActive();
}

const paneOfTab = (id) => (id ? panes.find((p) => p.tabId === id) || null : null);
const paneShown = (p) => !!p && (!p.dv || p.dv.isVisible);
const visiblePaneOf = (id) => {
  const p = paneOfTab(id);
  return paneShown(p) ? p : null;
};
const isVisible = (tab) => !!visiblePaneOf(tab.id);

function pickPane() {
  const free = panes.find((p) => !p.tabId || !tabs.has(p.tabId));
  if (free) return free;
  return panes.reduce((a, b) => (b.used < a.used ? b : a), panes[0]);
}

function freeTabsByRecency() {
  return [...tabs.values()].filter((t) => !paneOfTab(t.id)).sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
}

function fillEmptyPanes() {
  const free = freeTabsByRecency();
  for (const p of panes) {
    if (!p.tabId || !tabs.has(p.tabId)) {
      const t = free.shift();
      p.tabId = t ? t.id : null;
    }
  }
}

function showInPane(pane, id) {
  for (const p of panes) if (p.tabId === id) p.tabId = null;
  pane.tabId = id;
  activate(id);
}

function renderPaneHead(pane) {
  const tab = tabs.get(pane.tabId);
  pane.head.dataset.status = tab ? tab.status : 'none';
  pane.head.classList.toggle('unseen', !!tab?.unseen && tab.status === 'idle');
  pane.el.dataset.unread = tab?.unread?.kind || ''; // coloured ring: input / error / done
  pane.label.textContent = tab ? tab.label : '（空き）';
  pane.wt.textContent = badgeText(tab);
  pane.wt.hidden = !badgeText(tab);
  const w = waitOf(tab);
  pane.st.textContent = tab ? `${STATUS_JA[tab.status] || ''}${w && w.short ? ` · ${w.short}` : ''}` : '';
  pane.st.classList.toggle('has-wait', !!w);
  pane.st.classList.toggle('wait-warn', !!w && w.level === 'warn');
  pane.st.title = w ? `${w.text || ''}\nクリックで待っているもの・出力の末尾を見る` : '';
  pane.modeBtn.hidden = !tab?.conv;
  pane.modeBtn.textContent = { rich: '会話', term: 'ターミナル', split: '並べる' }[tab?.mode] || '会話';
  pane.head.title = tab ? `${tab.label} — ${w && w.text ? w.text : STATUS_JA[tab.status] || ''}\nドラッグで配置を変更` : 'ドラッグで配置を変更';
}

// AT-139: a project window with no tab shows this instead of starting claude by itself (closing the last tab, a
// start with nothing to restore, a hidden routed window brought up). New tabs come only from the user (＋ / Ctrl+T /
// this card's 新しいタブ) or from routed work (startRouted). The manager window keeps its resident session as before.
let noTabsEl = null;
function noTabsCard() {
  if (noTabsEl) return noTabsEl;
  const el = h('div', 'no-tabs');
  el.id = 'no-tabs';
  el.append(h('div', 'no-tabs-title', 'このフォルダで動いているセッションはありません'));
  el.append(h('div', 'no-tabs-sub', '作業はダッシュボード（PMO）から頼めます。claude はタブを作ったときだけ起動します。'));
  const row = h('div', 'no-tabs-actions');
  const btn = (cls, text, fn) => {
    const b = h('button', `no-tabs-btn ${cls}`, text);
    b.type = 'button';
    b.addEventListener('click', fn);
    row.append(b);
  };
  btn('nt-dashboard', 'ダッシュボード', () => safe(() => api.dashboardOpen?.()));
  btn('nt-inbox', '依頼を置く', () => safe(() => api.dashboardOpen?.({ inbox: true, folder: info.workDir || '' })));
  btn('nt-new', '新しいタブ', () => createTab());
  el.append(row);
  return (noTabsEl = el);
}
const showNoTabs = () => restoreDone && !tabs.size && info.role !== 'manager';

function applyLayout() {
  const multi = panes.length > 1;
  document.body.classList.toggle('split', multi);
  const none = showNoTabs();
  document.body.classList.toggle('no-tabs', none);
  if (none && panes[0] && noTabsCard().parentNode !== panes[0].empty) panes[0].empty.append(noTabsCard());
  for (const p of panes) {
    const tab = tabs.get(p.tabId);
    p.el.classList.toggle('focused', multi && p === focusedPane);
    p.el.classList.toggle('empty', !tab);
    p.empty.hidden = !!tab;
    if (tab && tab.el.parentNode !== p.body) {
      p.body.append(tab.el);
      tab.needsRefresh = true;
    }
    const rich = !!tab?.conv && tab.mode === 'rich';
    // 'term' mode keeps the conversation's composer (input box, choices, status) under the terminal:
    // typing Japanese straight into the terminal breaks with IME, so input always has a real text box.
    const composer = !!tab?.conv && tab.mode === 'term';
    p.body.classList.toggle('mode-rich', rich);
    p.body.classList.toggle('peek', rich && !!tab.peek);
    p.body.classList.toggle('with-composer', composer);
    // Elements of the session previously shown here (conversation / peek bar) go back to the stash.
    for (const el of [...p.body.querySelectorAll(':scope > .conv, :scope > .peek-bar')]) {
      if (!tab || (el !== tab.conv?.el && el !== tab.peekBar) || !rich) stash.append(el);
    }
    for (const el of [...p.body.querySelectorAll(':scope > .cv-dock')]) {
      if (!composer || el !== tab.conv.dock) restoreComposer(tabs.get(el.dataset.tab), el);
    }
    if (composer && tab.conv.dock.parentNode !== p.body) p.body.append(tab.conv.dock);
    if (rich) {
      if (tab.conv.el.parentNode !== p.body) p.body.append(tab.conv.el);
      if (tab.peekBar.parentNode !== p.body) p.body.append(tab.peekBar);
      tab.peekBar.hidden = !tab.peek;
      tab.peekBar.classList.toggle('auto', tab.peek === 'auto');
      tab.peekText.textContent = tab.peek === 'auto' ? 'ターミナルで操作が必要です' : 'ターミナルを表示中';
    }
    renderPaneHead(p);
  }
  attachConvPanels();
  for (const t of tabs.values()) {
    if (t.conv && t.mode !== 'term') restoreComposer(t, t.conv.dock);
    if (!paneOfTab(t.id) && t.el.parentNode !== stash) stash.append(t.el);
    if (t.conv && t.mode !== 'split' && !paneOfTab(t.id) && t.conv.el.parentNode !== stash) stash.append(t.conv.el);
    if (t.conv && t.mode === 'split' && !convPanels.has(t.id) && t.conv.el.parentNode !== stash) stash.append(t.conv.el);
    t.btn.classList.toggle('active', t.id === activeId);
    t.btn.classList.toggle('visible', multi && isVisible(t) && t.id !== activeId);
  }
  syncRenderersSoon(); // WebGL for the terminals on screen, DOM for the rest (perf2 case 4)
}

// perf2 case 4 (docs/perf.md): the terminal of a tab on screen draws with WebGL (@xterm/addon-webgl), every other
// tab with xterm's DOM renderer. The DOM renderer rebuilds the rows' DOM on each output (50-750ms long tasks).
// - A window has a limited number of WebGL contexts (Chromium drops the oldest past ~16): at most WEBGL_MAX at a
//   time. A terminal takes one when its pane is shown and keeps it while hidden (tab switches re-make nothing);
//   past WEBGL_MAX the tab shown longest ago gives it back (dispose -> DOM) and takes one again when shown.
// - The conversation view ('rich') and its peek at the terminal do NOT switch the renderer: the two renderers
//   measure the cell a little differently, so a switch on every peek changed cols / rows, resized the pty and
//   redrew claude's screen without the input prompt -> the view peeked again (handoff 21's queued prompt never
//   went out: tmp/handoff/t2.mjs 12/3 -> 14/0 with this rule).
// - DOM stays when: localStorage xtermRenderer = 'dom' (to compare), no WebGL2, a software GL (SwiftShader /
//   llvmpipe, e.g. --disable-gpu or the GPU blocked: slower than the DOM), or loading the addon threw (then never
//   again in this window). A lost context (GPU reset) disposes the addon -> DOM; the tab retries after 30 s.
// tab.el.dataset.renderer says which one draws ('webgl' / 'dom'), for the tests (tmp/perf2/webgl-e2e.mjs).
const WEBGL_MAX = 8;
const WEBGL_RETRY_MS = 30000;
let webglOk = null; // null = not probed yet
function webglUsable() {
  if (webglOk !== null) return webglOk;
  webglOk = safe(() => {
    if (typeof WebglAddon === 'undefined' || !WebglAddon.WebglAddon) return false;
    if (String(localStorage.getItem('xtermRenderer') || '').toLowerCase() === 'dom') return false;
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
    safe(() => gl.getExtension('WEBGL_lose_context')?.loseContext()); // give the probe's context back at once
    return !/swiftshader|llvmpipe|software|basic render/i.test(name);
  }, false);
  return webglOk;
}
const termShown = (t) => !!t.opened && paneShown(paneOfTab(t.id));
function detachWebgl(t) {
  const a = t.webgl;
  if (!a) return;
  t.webgl = null;
  safe(() => a.dispose()); // xterm goes back to its DOM renderer
  t.el.dataset.renderer = 'dom';
  t.needsRefresh = true;
}
function attachWebgl(t) {
  let a = null;
  try {
    a = new WebglAddon.WebglAddon();
    t.term.loadAddon(a);
  } catch (e) {
    safe(() => a?.dispose());
    webglOk = false; // no WebGL here: every terminal stays on the DOM renderer
    console.warn('xterm WebGL off, DOM renderer:', e?.message || e);
    for (const x of tabs.values()) detachWebgl(x);
    fitSoon(); // the tabs fitVisible kept waiting for WebGL (webglSoon) fit on the DOM renderer now
    return false;
  }
  t.webgl = a;
  t.el.dataset.renderer = 'webgl';
  t.needsRefresh = true;
  a.onContextLoss(() => {
    if (t.webgl !== a) return;
    t.webglLostAt = Date.now();
    detachWebgl(t);
    fitSoon();
  });
  return true;
}
function syncRenderers() {
  if (![...tabs.values()].some((t) => t.opened)) return; // probe WebGL only once a terminal exists
  if (!webglUsable()) return;
  const now = Date.now();
  const want = [];
  for (const t of tabs.values()) {
    if (!t.opened) continue;
    if (termShown(t)) {
      // its own field: tab.shownAt is "on the user's screen" for done-stop 35 / rest 31 / auto-close (a shared name
      // kept every tab in a shown pane "in use": done-stop 35 / done-kill 42 failed)
      t.glShownAt = now;
      want.push(t);
    }
  }
  // One new context per frame: making one (getContext, shaders, the glyph atlas) takes 100-290ms (perf2
  // measurement), 4 at once (layout 1 -> 4) made one 200-330ms frame. The active tab goes first.
  const next = want
    .filter((t) => !t.webgl && !(t.webglLostAt && now - t.webglLostAt < WEBGL_RETRY_MS))
    .sort((a, b) => (b.id === activeId) - (a.id === activeId));
  // A hidden tab keeps its context (switching back costs nothing) until the window needs more than WEBGL_MAX:
  // then the one shown longest ago gives it back (perf2: a dispose on every hide re-made one per tab switch).
  const holders = [...tabs.values()].filter((t) => t.webgl);
  const spare = holders.filter((t) => !want.includes(t)).sort((a, b) => (a.glShownAt || 0) - (b.glShownAt || 0));
  while (spare.length && holders.length + (next.length ? 1 : 0) > WEBGL_MAX) {
    const old = spare.shift();
    detachWebgl(old);
    holders.splice(holders.indexOf(old), 1);
  }
  if (!next.length || holders.length >= WEBGL_MAX) return;
  if (!attachWebgl(next[0])) return;
  fitSoon();
  // 依頼-240: the next frame takes the next one, also when it needs a spare's context first (with every context held,
  // the 2nd of two tabs shown at once stayed on DOM until the next layout change)
  if (next.length > 1 && (holders.length + 1 < WEBGL_MAX || spare.length)) syncRenderersSoon();
}
// 依頼-240: a tab on screen still on DOM that syncRenderers will give WebGL within a few frames (WebGL usable, not lost
// in the last WEBGL_RETRY_MS, a free context or a hidden holder's to take). fitVisible waits for it: the two renderers
// measure the cell differently (macOS "SF Mono": DOM 123 cols, WebGL 130), so a DOM fit first resized claude twice.
// A tab whose context was lost stays on DOM and fits on DOM.
function webglSoon(t) {
  if (t.webgl || !t.opened || webglOk === false) return false;
  if (t.webglLostAt && Date.now() - t.webglLostAt < WEBGL_RETRY_MS) return false;
  if (!webglUsable()) return false;
  const holders = [...tabs.values()].filter((x) => x.webgl);
  return holders.length < WEBGL_MAX || holders.some((x) => !termShown(x));
}
let rendererRaf = 0;
function syncRenderersSoon() {
  if (rendererRaf) return;
  rendererRaf = requestAnimationFrame(() => {
    rendererRaf = 0;
    syncRenderers();
  });
}

let fitRaf = 0;
// UX8: a pane whose terminal, size, font and renderer are what they were at its last fit is not measured again (a dock
// layout change on every tool call while output streams — a section's tab title with a new badge — and the visibility
// / layout events made fit() measure the terminal each time). force: measure anyway.
function fitVisible(force = false) {
  for (const p of panes) {
    const t = tabs.get(p.tabId);
    if (!t || !t.opened || !paneShown(p)) continue;
    if (webglSoon(t)) {
      syncRenderersSoon(); // attachWebgl -> fitSoon fits it on WebGL
      continue;
    }
    const o = t.term.options || {};
    const key = `${t.id}|${t.el.clientWidth}x${t.el.clientHeight}|${p.body.clientWidth}x${p.body.clientHeight}|${o.fontSize}|${o.fontFamily}|${o.lineHeight}|${t.el.dataset.renderer || ''}|${p.body.className}`;
    if (!force && key === t.fitKey && !t.needsRefresh) continue;
    t.fitKey = key;
    safe(() => {
      t.fit.fit();
      if (t.needsRefresh) {
        t.needsRefresh = false;
        t.term.refresh(0, t.term.rows - 1);
      }
    });
  }
}
function fitSoon() {
  if (fitRaf) return;
  fitRaf = requestAnimationFrame(() => {
    fitRaf = 0;
    fitVisible();
  });
}

function setLayout(n) {
  layoutPreset = n;
  folderLayout.preset = n;
  buildPreset(n);
  focusedPane = paneOfTab(activeId) || panes[0] || null;
  applyLayout();
  requestAnimationFrame(() => {
    fitVisible();
    focusTab(tabs.get(activeId));
  });
  saveFolderLayout();
  scheduleRemote();
}

function cycleLayout() {
  setLayout(layoutPreset === 1 ? 2 : layoutPreset === 2 ? 4 : 1);
}

// ---- tabs -----------------------------------------------------------------
function computeLabel(tab) {
  if (tab.manualLabel && tab.manualText) return tab.manualText;
  // The manager window's resident session is always 「PMO」 (PROGRESS 45): not its first prompt (the app's request)
  // nor the window title, also after a handoff / restart. A name the user typed still wins (above).
  if (info.role === 'manager') return PMO_LABEL;
  return taskLabel(tab) || tab.titleLabel || tab.promptLabel || tab.defaultLabel;
}

// "AT-12 見出し" of the routed backlog item a tab works on (UIUX U1, labels.js): the active one, else the newest. '' = none.
function taskLabel(tab) {
  const B = window.Backlog;
  if (!B || !window.Labels || !tab) return '';
  const its = safe(() => B.items(tab.id), []).filter((i) => i.no && String(i.id).startsWith('r-'));
  const it = its.find((i) => i.status === 'active') || its[its.length - 1];
  return it ? window.Labels.taskName(it) : '';
}

// Badge next to the label: worktree name and/or "TEAM" (Agent Teams session).
function badgeText(tab) {
  if (!tab) return '';
  return [tab.worktree, tab.team ? 'チーム' : ''].filter(Boolean).join(' · ');
}

// ---- what a waiting session waits for (waits:state from main) -------------------------------
// main sends { [tabId]: Wait | null } for this window's tabs (Wait: { kind, text, short, level 'ok'|'warn', since,
// items: [command | member | agent], alerts }). Kept on tab.wait; shown only while the tab is idle / asking (a status
// change here is quicker than main's next push).
function waitOf(tab) {
  if (!tab || !tab.wait || tab.exited || tab.rest) return null;
  return tab.status === 'idle' || tab.status === 'asking' ? tab.wait : null;
}

function applyWaits(map) {
  if (!map || typeof map !== 'object') return;
  for (const t of tabs.values()) {
    const w = map[t.id] && typeof map[t.id] === 'object' ? map[t.id] : null;
    if (JSON.stringify(w) === JSON.stringify(t.wait || null)) continue;
    t.wait = w;
    renderTab(t);
    if (waitPop && waitPop.tabId === t.id) renderWaitPop();
  }
  safe(() => tickProblemBand()); // UA3: stuck -> moving again
}

const durText = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60e3));
  return m < 60 ? `${m}分` : m < 1440 ? `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}` : `${Math.floor(m / 1440)}日`;
};
const bytesText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n || 0}B`);
const PROC_JA = { alive: '動いている', gone: 'プロセスが見つからない', unknown: '' };

// The popover: the wait's text and alerts, each command (command line, how long, last output) with 「出力の末尾」
// (api.waitTail, about the last 8 KB), members / subagents it waits for. One at a time; outside click / Esc closes.
let waitPop = null; // { el, tabId, at: { x, y }, open: Set<id>, tails: Map<id, { loading, res }> }

function closeWaitPop() {
  if (!waitPop) return;
  waitPop.el.remove();
  waitPop = null;
  document.removeEventListener('mousedown', onWaitPopOutside, true);
  document.removeEventListener('keydown', onWaitPopKey, true);
}
function onWaitPopOutside(e) {
  if (waitPop && !waitPop.el.contains(e.target)) closeWaitPop();
}
function onWaitPopKey(e) {
  if (e.key !== 'Escape' || !waitPop) return;
  e.preventDefault();
  e.stopPropagation();
  closeWaitPop();
}

function openWaitPop(tab, at) {
  closeMenu(false);
  if (waitPop && waitPop.tabId === tab.id) return closeWaitPop();
  closeWaitPop();
  const el = h('div', 'popover wait-pop');
  waitPop = { el, tabId: tab.id, at, open: new Set(), tails: new Map() };
  document.body.append(el);
  renderWaitPop();
  document.addEventListener('mousedown', onWaitPopOutside, true);
  document.addEventListener('keydown', onWaitPopKey, true);
  // a single command: its tail right away
  const cmds = (tab.wait?.items || []).filter((x) => x && x.type === 'command');
  if (cmds.length === 1) toggleWaitTail(cmds[0].id);
}

function toggleWaitTail(id) {
  if (!waitPop) return;
  const pop = waitPop;
  if (pop.open.has(id)) {
    pop.open.delete(id);
    return renderWaitPop();
  }
  pop.open.add(id);
  loadWaitTail(pop, id);
}

function loadWaitTail(pop, id) {
  pop.tails.set(id, { loading: true, res: pop.tails.get(id)?.res || null });
  renderWaitPop();
  Promise.resolve(api.waitTail?.({ tabId: pop.tabId, id }))
    .then((res) => res || { error: '出力を読めませんでした' })
    .catch((err) => ({ error: String(err?.message || err) }))
    .then((res) => {
      pop.tails.set(id, { loading: false, res });
      if (waitPop === pop) renderWaitPop();
    });
}

function renderWaitPop() {
  if (!waitPop) return;
  const pop = waitPop;
  const tab = tabs.get(pop.tabId);
  const w = waitOf(tab);
  const el = pop.el;
  const pre = new Map([...el.querySelectorAll('.wp-tail')].map((x) => [x.dataset.id, x.scrollTop]));
  el.replaceChildren();
  const head = h('div', 'menu-head');
  head.append(h('span', null, tab ? tab.label : ''), h('span', 'mi-hint', tab ? STATUS_JA[tab.status] || '' : ''));
  el.append(head);
  if (!w) {
    el.append(h('div', 'wp-none', '今は待機中ではありません'));
  } else {
    el.append(h('div', `wp-text${w.level === 'warn' ? ' wait-warn' : ''}`, w.text || ''));
    for (const a of Array.isArray(w.alerts) ? w.alerts : []) el.append(h('div', 'wp-alert', a.text || a.code || ''));
    const now = Date.now();
    for (const it of Array.isArray(w.items) ? w.items : []) {
      if (!it || typeof it !== 'object') continue;
      const box = h('div', `wp-item wp-${it.type}`);
      if (it.type === 'command') {
        box.append(h('div', 'wp-cmd', String(it.command || '(コマンド不明)')));
        const meta = [
          it.startedAt ? `開始から ${durText(now - it.startedAt)}` : '',
          it.lastOutputAt ? `最後の出力 ${relTime(it.lastOutputAt)}` : it.hasOutput ? '' : '出力なし',
          it.outBytes ? bytesText(it.outBytes) : '',
          PROC_JA[it.proc] || '',
        ].filter(Boolean);
        const row = h('div', 'wp-meta');
        row.append(h('span', `wp-proc p-${it.proc || 'unknown'}`, meta.join(' · ')));
        const opened = pop.open.has(it.id);
        const b = h('button', 'wp-btn', opened ? '出力を閉じる' : '出力の末尾');
        b.type = 'button';
        b.addEventListener('click', () => toggleWaitTail(it.id));
        row.append(b);
        if (opened) {
          const r = h('button', 'wp-btn', '読み直す');
          r.type = 'button';
          r.addEventListener('click', () => loadWaitTail(pop, it.id));
          row.append(r);
        }
        box.append(row);
        if (opened) {
          const t = pop.tails.get(it.id);
          if (t && t.res && !t.res.error) {
            const tail = h('pre', 'wp-tail', t.res.text || '（出力はまだありません）');
            tail.dataset.id = String(it.id);
            box.append(tail);
            const info = [t.res.size != null ? bytesText(t.res.size) : '', t.res.mtime ? `更新 ${relTime(t.res.mtime)}` : '', t.loading ? '読み直し中…' : ''].filter(Boolean).join(' · ');
            const f = h('div', 'wp-file', info);
            if (t.res.file) f.title = t.res.file;
            box.append(f);
          } else if (t && t.res && t.res.error) {
            box.append(h('div', 'wp-alert', t.res.error));
          } else {
            box.append(h('div', 'wp-none', '読み込み中…'));
          }
        }
      } else if (it.type === 'member') {
        box.append(h('div', 'wp-who', `担当 ${it.name || ''}`), h('div', 'wp-meta', [it.status, it.updatedAt ? relTime(it.updatedAt) : ''].filter(Boolean).join(' · ')));
      } else if (it.type === 'agent') {
        box.append(h('div', 'wp-who', `サブエージェント ${it.agentType || ''}${it.description ? ` — ${it.description}` : ''}`), h('div', 'wp-meta', [it.status, it.updatedAt ? relTime(it.updatedAt) : ''].filter(Boolean).join(' · ')));
      } else {
        continue;
      }
      el.append(box);
    }
  }
  // keep it on screen
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.round(Math.max(8, Math.min(pop.at.x, window.innerWidth - r.width - 8)))}px`;
  el.style.top = `${Math.round(Math.max(8, Math.min(pop.at.y + 4, window.innerHeight - r.height - 8)))}px`;
  for (const t of el.querySelectorAll('.wp-tail')) {
    const s = pre.get(t.dataset.id);
    t.scrollTop = s == null ? t.scrollHeight : s; // the end first; a re-render keeps where the user scrolled
  }
}

function renderTab(tab) {
  if (!tab.btn) return;
  tab.btn.dataset.status = tab.status;
  tab.btn.dataset.rest = tab.rest || ''; // 完了 / 休止中 (PROGRESS 35 / 31)
  tab.btn.classList.toggle('unseen', !!tab.unseen && tab.status === 'idle');
  tab.btn.dataset.unread = tab.unread?.kind || '';
  if (tab.labelEl.isConnected) tab.labelEl.textContent = tab.label;
  tab.wtEl.textContent = badgeText(tab);
  tab.wtEl.hidden = !badgeText(tab);
  const heavy = memHeavy(tab);
  tab.memEl.textContent = heavy ? memText(tab.memMb) : '';
  tab.memEl.hidden = !heavy;
  const mem = tab.rest ? '\nメモリ 0MB（claude を止めています）' : tab.memMb != null && !tab.exited ? `\nメモリ ${memText(tab.memMb)}${heavy ? '（右クリック →「再起動」で軽くできます）' : ''}` : '';
  const w = waitOf(tab);
  tab.btn.classList.toggle('wait-warn', !!w && w.level === 'warn');
  const st = tab.rest === 'done' ? '完了（休止中。「再開」か送信で claude を起こします）' : tab.rest === 'idle' ? '休止中（開くと再開）' : w && w.text ? w.text : STATUS_JA[tab.status] || '';
  tab.btn.title = `${tab.label} — ${st}${tab.worktree ? ` (worktree: ${tab.worktree})` : ''}${mem}\nダブルクリックで名前を変更・右クリックでメニュー・ドラッグで並べ替え`;
  const pane = paneOfTab(tab.id);
  if (pane) renderPaneHead(pane);
  scheduleTabsMore(); // UIUX U6: a label change can push tabs out of the bar
}

function updateLabel(tab) {
  const next = computeLabel(tab);
  if (next === tab.label) return;
  tab.label = next;
  renderTab(tab);
  safe(() => convPanels.get(tab.id)?.api?.setTitle(convPanelTitle(tab)));
  saveSessions();
  if (tab.id === activeId) {
    updateTitle();
    renderPanelSoon();
  }
  scheduleRemote();
}

function updateTitle() {
  const tab = tabs.get(activeId);
  const parts = [];
  if (tab) parts.push(tab.label);
  if (folderName) parts.push(folderName);
  parts.push('BantoDesk');
  const text = parts.join(' - ') + (info.dev ? ' [DEV]' : '');
  document.title = text;
  safe(() => api.setTitle(text));
}

function buildTabButton(tab) {
  const btn = h('div', 'tab');
  const dot = h('span', 'dot');
  const label = h('span', 'label', tab.label);
  const wt = h('span', 'wt-badge');
  const mem = h('span', 'mem-badge');
  mem.hidden = true;
  mem.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openTabMenu(tab, ev);
  });
  const close = h('span', 'close', '×');
  close.title = `セッションを閉じる (${scKey('closeTab')})`;
  close.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeTab(tab.id);
  });
  btn.append(dot, label, wt, mem, close);
  btn.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    openTabMenu(tab, ev);
  });
  // Drag onto the layout to show this session in a new pane at the drop position.
  btn.draggable = true;
  btn.addEventListener('dragstart', (ev) => {
    ev.dataTransfer.setData(TAB_MIME, tab.id);
    ev.dataTransfer.effectAllowed = 'move';
  });
  btn.addEventListener('click', () => {
    const was = activeId;
    const openState = usageStateOf(tab);
    activate(tab.id);
    if (was !== tab.id || usageTabId !== tab.id) {
      usageOpen(tab.id, 'tab', openState); // UA1: open.from.tab
      openProblemBand(tab, openState); // UA3
    }
  });
  btn.addEventListener('auxclick', (ev) => {
    if (ev.button === 1) closeTab(tab.id);
  });
  label.addEventListener('dblclick', (ev) => {
    ev.stopPropagation();
    startRename(tab);
  });
  tabsEl.append(btn);
  tab.btn = btn;
  tab.labelEl = label;
  tab.wtEl = wt;
  tab.memEl = mem;
}

// ---- session memory / restart (docs/memory-investigation.md, proposal A) ------------
// main pushes pty:mem (private memory of each session's process tree: shell + claude + its tools) about
// once a minute. A long claude session grows to ~1 GB; restarting it with --resume keeps the
// conversation and starts a small process again.
// The mark is the setting "重いセッションの目安" (⚙ 設定 → 引き継ぎ, stored with the handoff settings; default 800 MB).
const memThreshold = () => safe(() => window.Handoff?.settings?.().memMb, 0) || 800;
const memHeavy = (tab) => !!tab && !tab.exited && tab.memMb != null && tab.memMb >= memThreshold();
const memText = (mb) => (mb >= 1000 ? `${(mb / 1024).toFixed(1)}GB` : `${Math.round(mb)}MB`);

function applyMem(map) {
  let changed = false;
  for (const t of tabs.values()) {
    const m = map && map[t.id];
    const mb = t.rest ? 0 : m ? m.mb : null; // resting (35 / 31): no claude, 0
    if (mb === t.memMb) continue;
    t.memMb = mb;
    changed = true;
    renderTab(t);
    if (t.id === activeId) renderPanelSoon();
  }
  if (changed) {
    scheduleRemote(); // dashboard / widget (TabState.memMb)
    safe(() => window.Dashboard?.renderOwn?.());
  }
}
document.addEventListener('bantodesk:mem-threshold', () => {
  for (const t of tabs.values()) renderTab(t);
  renderPanelSoon();
  scheduleRemote();
  safe(() => window.Dashboard?.renderOwn?.());
});
// side panel 「再起動」 (panel.js dispatches it, like bantodesk:handoff)
document.addEventListener('bantodesk:restart', (e) => {
  const tab = tabs.get(e.detail?.tabId);
  if (tab) restartTab(tab);
});

// Why a restart now would cut something off ([] = safe). Same signals as the handoff's "do not switch" list.
function restartBusy(tab) {
  if (!tab || tab.exited) return [];
  const why = [];
  if (tab.status === 'running' || tab.titleBusy) why.push('応答中です（いまの処理は中断されます）');
  if (tab.status === 'asking' || tab.choices) why.push('承認や質問のダイアログが出ています');
  if (tab.autoYesAns) why.push('「安全な確認は自動で通す」がダイアログに答えています');
  if (safe(() => window.Backlog?.activeOf?.(tab.id), null)) why.push('待ちの項目を対応中です');
  if (safe(() => window.Handoff?.holds?.(tab), false)) why.push('新しいセッションへの引き継ぎ中です');
  return why;
}

function openTabMenu(tab, ev) {
  closeMenu(false);
  const m = h('div', 'popover tab-pop');
  m.style.top = `${Math.round(ev.clientY + 4)}px`;
  m.style.left = `${Math.round(Math.max(8, Math.min(ev.clientX, window.innerWidth - 320)))}px`;
  const head = h('div', 'menu-head');
  const memEl = h('span', 'mi-hint', tab.rest ? '休止中（メモリ 0MB）' : tab.exited ? '終了しています' : tab.memMb != null ? `メモリ ${memText(tab.memMb)}` : 'メモリ 計測中…');
  head.append(h('span', null, tab.label), memEl);
  m.append(head);
  const w = waitOf(tab);
  if (w) {
    const at = { x: ev.clientX, y: ev.clientY };
    m.append(menuItem('待っているもの・出力を見る', w.short || '', () => {
      closeMenu(false);
      openWaitPop(tab, at);
    }, 'session.menu.wait'));
  }
  m.append(menuItem(tab.exited ? window.Labels?.WORDS?.resume || '再開' : '再起動（会話はそのまま）', 'メモリを空ける', () => {
    closeMenu(false);
    restartTab(tab);
  }, 'session.menu.restart'));
  // 休ませる (31): stop its claude now; opening the tab, Enter or a send wakes it with --resume
  if (!tab.exited && !tab.rest && info.role !== 'manager') {
    m.append(menuItem('休ませる', 'claude を止めてメモリを空ける（開くと再開）', () => {
      closeMenu(false);
      const why = restByHand(tab);
      if (why) safe(() => raise(tab, 'error', why));
    }, 'session.menu.rest'));
  }
  if (!tab.exited && !tab.handedOff && window.Handoff) {
    m.append(menuItem('新しいセッションへ引き継ぐ', 'メモを書かせて続ける', () => {
      closeMenu(false);
      handoffStart(tab);
    }, 'session.menu.handoff'));
  }
  m.append(menuItem('名前を変更', 'ダブルクリック', () => {
    closeMenu(false);
    startRename(tab);
  }, 'session.menu.rename'));
  m.append(menuItem('閉じる', scKey('closeTab'), () => {
    closeMenu(false);
    closeTab(tab.id);
  }, 'session.menu.close'));
  document.body.append(m);
  menuEl = m;
  document.addEventListener('mousedown', onMenuOutside, true);
  // fresh figure for the menu (the pushed one may be a minute old)
  if (!tab.exited) {
    api.ptyMem?.().then((map) => {
      applyMem(map);
      if (menuEl === m && tab.memMb != null) memEl.textContent = `メモリ ${memText(tab.memMb)}`;
    }).catch(() => {});
  }
}

// Kill the tab's claude and start `claude --resume <id>` in the same tab (main waits for the old one to exit).
// o.noConfirm (dashboard / remote: the user is not looking at this window): refuse while busy instead of asking.
// -> '' when restarted, else the reason.
function restartTab(tab, o = {}) {
  if (!tabs.has(tab.id)) return 'セッションがありません';
  const busy = restartBusy(tab);
  if (o.noConfirm && busy.length) return `いまは再起動できません: ${busy.join('、')}`;
  const warn = busy.map((w) => `・${w}`);
  if (tab.team && !tab.exited) warn.push('・チームのメンバー（Agent Teams）も止まります');
  if (!o.noConfirm && warn.length && !window.confirm(`${warn.join('\n')}\n\n再起動しますか？会話はそのまま続きから戻ります。`)) return '取り消しました';
  // the backlog item being worked on would wait forever for a turn_end of the killed process
  const act = safe(() => window.Backlog?.activeOf?.(tab.id), null);
  if (act) safe(() => window.Backlog.finish(act.id, false, '再起動で中断しました'));
  clearTimeout(tab.scanTimer);
  clearTimeout(tab.autoYesTimer);
  tab.exited = false;
  tab.exitCode = null;
  tab.choices = null;
  tab.prompt = null;
  tab.firstDataAt = 0;
  tab.memMb = null;
  tab.handedOff = false; // resumed after a handoff: a normal session again
  tab.handoff = null;
  tab.rest = null; // woken (PROGRESS 35 / 31)
  tab.restAt = 0;
  tab.wokeAt = Date.now(); // restarted by hand / woken: not stopped again for an item that ended before (doneStopTick)
  safe(() => tab.term.reset()); // the old process's screen and scrollback
  setStatus(tab, 'starting');
  renderTab(tab);
  api.ptyRestart({ id: tab.id, cols: tab.term.cols, rows: tab.term.rows, cwd: tab.cwd, team: tab.team, delegate: tab.delegate, ...(tab.model ? { model: tab.model } : {}), ...(tab.effort ? { effort: tab.effort } : {}) });
  saveSessions();
  if (tab.id === activeId) focusTab(tab);
  renderPanelSoon();
  safe(() => window.Dashboard?.renderOwn?.());
  return '';
}

// The rename box being typed in, if any (activate asked document.querySelector('.tab-rename'), which walked every
// tab's hidden terminal / conversation DOM in the stash at each tab switch; docs/perf.md 第 3 段)
let renameInput = null;
function startRename(tab) {
  if (!tab.labelEl.isConnected) return;
  const input = h('input', 'tab-rename');
  renameInput = input;
  input.value = tab.label;
  input.spellcheck = false;
  input.placeholder = '空欄で自動';
  tab.labelEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (renameInput === input) renameInput = null;
    if (save) {
      const v = input.value.trim();
      tab.manualLabel = !!v;
      tab.manualText = v;
    }
    input.replaceWith(tab.labelEl);
    tab.labelEl.textContent = tab.label;
    updateLabel(tab);
    saveSessions();
    if (tab.id === activeId) focusTab(tab);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

function cycleTab(dir) {
  const ids = [...tabs.keys()];
  if (!ids.length) return;
  const i = ids.indexOf(activeId);
  activate(ids[(i + dir + ids.length) % ids.length]);
}

function activate(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  if (usageTabId && usageTabId !== id) usageClose(); // UA1: moved to another session
  if (band && band.tabId !== id) hideProblemBand(); // UA3: the band is the opened session's
  const prev = tabs.get(activeId);
  activeId = id;
  let pane = paneOfTab(id);
  if (!pane) {
    pane = pickPane();
    if (pane) pane.tabId = id;
  }
  focusedPane = pane;
  if (pane) {
    pane.used = ++useClock;
    // Bring the pane to the front of its dockview group (it may be a background tab there).
    if (dock && dock.activePanel?.id !== pane.id) safe(() => pane.dv?.setActive());
  }
  tab.lastActive = ++useClock;
  tab.selectedAt = Date.now(); // idle rest (31): selecting a tab is use
  if (restoreDone) tab.userSelectedAt = tab.selectedAt; // auto-close (quietAtOf): not the restore's own activations
  if (document.hasFocus()) clearUnread(tab); // the user is looking at it now
  // opened in a window the user sees: a tab resting idle (31) wakes (not while the tabs are being restored, nor in a
  // hidden window). A 完了 tab (rest 'done') stays stopped: it is opened to read the result (PROGRESS 44)
  if (tab.rest === 'idle' && restoreDone && document.visibilityState === 'visible') safe(() => wakeTab(tab));
  applyLayout(); // the active / visible marks of every tab button and the pane heads
  // UX8 (docs/ux-journey.md §5.5): renderTab only for the tab left and the tab opened (it was every tab on each switch)
  if (prev && prev !== tab) renderTab(prev);
  renderTab(tab);
  tab.btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  updateTitle();
  renderPanelNow();
  safe(() => window.Backlog?.render?.()); // the panel follows the active session
  scheduleRemote();
  requestAnimationFrame(() => {
    fitVisible();
    if (!(renameInput && renameInput.isConnected) && !overlayHasFocus()) focusTab(tab);
  });
}

function overlayHasFocus() {
  return !!(document.activeElement && overlayRoot.contains(document.activeElement));
}

function createTab(opts = {}) {
  const id = opts.id || crypto.randomUUID();
  if (tabs.has(id)) {
    activate(id);
    return tabs.get(id);
  }
  const mode = opts.mode === 'resume' ? 'resume' : 'new';
  const el = h('div', 'term');
  // UX1 (mac-polish 4): the macOS fonts first (Windows has none of them: Cascadia / BIZ UDGothic as before), and a little
  // line spacing on macOS only (the Windows cells stay as they were). xterm draws on a canvas: no CSS variable here.
  const onMac = document.documentElement.dataset.os === 'darwin';
  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, "Cascadia Code", "Cascadia Mono", Consolas, "Hiragino Sans", "BIZ UDGothic", "Meiryo UI", monospace',
    ...(onMac ? { lineHeight: 1.15 } : {}),
    fontSize: 14,
    cursorBlink: true,
    allowProposedApi: true,
    theme: THEME,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);

  const tab = {
    id, el, term, fit,
    label: '',
    manualLabel: false,
    manualText: '',
    titleLabel: '',
    promptLabel: '',
    defaultLabel: `Claude ${++counter}`,
    cwd: opts.cwd || info.workDir,
    worktree: opts.worktree || worktreeFromCwd(opts.cwd) || null,
    team: !!opts.team, // Agent Teams enabled (in-process teammates)
    delegate: !!opts.delegate, // routed item: started with the delegation prompt (docs/prompts/routed-session.md)
    // AT-6: a routed item's own model / effort (the PMO's route / create); null = the default (main checks both)
    model: typeof opts.model === 'string' && opts.model ? opts.model : null,
    effort: typeof opts.effort === 'string' && opts.effort ? opts.effort : null,
    status: 'starting',
    stats: P.newStats(),
    autoYesAns: null,
    scanTimer: 0,
    notifyTimer: 0,
    started: false,
    exited: false,
    firstDataAt: 0,
    choices: null,
    unseen: false,
    evtStatus: null,
    evtAt: 0,
    replayQueue: null,
    lastActive: 0,
    opened: false,
    needsRefresh: false,
    mode: 'term',
    peek: false,
    unknownSince: 0,
    conv: null,
    // made for an item routed by the manager agent (set before the pty starts: the folder-trust
    // dialog is auto-answered only for these and the manager window, see scan())
    forBacklog: !!opts.forBacklog,
    usedAtSaved: Number(opts.usedAt) || 0, // restored: when it was last used before the restart (usedAtOf, 42)
    quietSaved: Number(opts.quietAt) || 0, // restored: its last activity before the restart (quietAtOf, AT-autoclose)
    askingSaved: !!opts.asking, // restored: it waited for the user's answer (waitsForAnswer; the replay sets no marker)
    createdAt: Date.now(), // idle rest (31): counted from here when nothing else happened
    resumed: mode === 'resume', // has a conversation already (idle rest: a tab never talked to does not rest)
  };
  tab.conv = C.create(tab);
  if (tab.conv) {
    // A conversation panel restored with the layout means the tab was in 'split' mode.
    tab.mode = convPanels.has(id) ? 'split' : savedViewMode(id) || defaultViewMode();
    if (tab.mode === 'split' && !convPanels.has(id)) tab.mode = 'rich';
    makePeekBar(tab);
    tab.conv.dock.dataset.tab = id;
    safe(() => tab.conv.composer?.restore(composerStore.drafts?.[id])); // draft from the last run
    safe(() => window.Handoff?.attachBar?.(tab)); // context handoff confirm bar (handoff.js)
  }
  if (opts.label) {
    if (opts.manualLabel) {
      tab.manualLabel = true;
      tab.manualText = opts.label;
    } else {
      tab.defaultLabel = opts.label;
    }
  }
  tab.label = computeLabel(tab);
  tabs.set(id, tab);
  buildTabButton(tab);
  // background: a session made for a routed backlog item must not take the screen from the user
  if (!opts.background || !activeId || !tabs.has(activeId)) activate(id);
  else applyLayout();

  term.open(el);
  // The composer under the terminal ('term' mode) changes the terminal's height, not the pane's.
  if (typeof ResizeObserver === 'function') (tab.resizeObs = new ResizeObserver(fitSoon)).observe(el);
  tab.opened = true;
  el.dataset.renderer = 'dom'; // until syncRenderers gives it WebGL (shown on screen)
  // WebGL before the first fit (依頼-224): the two renderers measure the cell differently when the font's advance is
  // not a whole pixel (macOS "SF Mono" 14px since UX1: DOM 8.43px, WebGL floors to 8px), so a fit on the DOM renderer
  // started claude at 123 cols and resized it to 130 a frame later. A tab on screen gets its context here (one context,
  // as syncRenderers does per frame); a background tab stays on DOM until shown.
  safe(() => syncRenderers());
  safe(() => fit.fit());
  syncRenderersSoon();
  term.attachCustomKeyEventHandler((e) => {
    // Copy (UX4): Mac ⌘C (Ctrl+C always goes to claude); Windows Ctrl+C while something is selected (as before).
    // Mac ⌘A selects the whole terminal (the 編集 menu's selectAll would select the hidden textarea).
    const mac = Labels.isMac();
    if (e.type === 'keydown' && e.code === 'KeyC' && !e.shiftKey && !e.altKey && term.hasSelection() && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) {
      navigator.clipboard.writeText(term.getSelection());
      e.preventDefault();
      return false;
    }
    if (mac && e.type === 'keydown' && e.code === 'KeyA' && e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      term.selectAll();
      e.preventDefault();
      return false;
    }
    if (shortcutAction(e)) return false; // handled by the window-level listener
    return true;
  });
  term.onData((data) => {
    if (tab.exited) {
      if (data === '\r') restartTab(tab); // "Enter で再開" (onPtyExit)
      return;
    }
    // xterm.js's own answers to the program's queries are not the user typing (AT-8, isTermReply)
    if (!isTermReply(data)) {
      tab.lastUserInputAt = Date.now(); // backlog waits while the user types in the terminal
      if (Date.now() > (tab.pasteUntil || 0)) tab.lastTypedAt = Date.now(); // typed by hand (not our paste)
    }
    api.ptyInput({ id, data });
  });
  term.onResize(({ cols, rows }) => {
    tab.resizedAt = Date.now(); // the repaint that follows is no activity (auto-close, quietAtOf)
    api.ptyResize({ id, cols, rows });
  });
  // Notifications from the program in the terminal (Claude Code via preferredNotifChannel, other CLIs).
  safe(() => term.parser.registerOscHandler(777, (data) => {
    const parts = String(data).split(';');
    if (parts[0] === 'notify') onTerminalNotification(tab, parts.slice(2).join(';') || parts[1]);
    return true;
  }));
  safe(() => term.parser.registerOscHandler(9, (data) => {
    const s = String(data);
    if (!/^\d+;/.test(s)) onTerminalNotification(tab, s); // "9;4;…" is a progress report (ConEmu / WT), not a notice
    return true;
  }));
  // Window title: Claude Code shows ◐/◑ while working and ✳ when idle or asking.
  term.onTitleChange((t) => { tab.titleBusy = /^[◐◑◒◓]/.test(String(t || '')); });

  const req = { id, cols: term.cols, rows: term.rows, mode };
  // new: a cwd inside the folder (context handoff of a worktree tab) when no worktree is to be created
  if (opts.cwd && (mode === 'resume' || !opts.worktree)) req.cwd = opts.cwd;
  if (mode === 'new' && opts.worktree) req.worktree = opts.worktree;
  if (tab.team) req.team = true;
  if (tab.delegate) req.delegate = true;
  if (tab.model) req.model = tab.model;
  if (tab.effort) req.effort = tab.effort;
  if (mode === 'resume' && REST_TEXT[opts.rest]) {
    // restored resting (PROGRESS 35 / 31): no claude until the tab is opened (wakeTab -> pty:restart --resume)
    tab.rest = opts.rest;
    tab.restAt = Date.now();
    tab.memMb = 0;
    tab.exited = true;
    tab.status = 'exited';
    term.write(`\x1b[2m[${REST_TEXT[opts.rest]}]\x1b[0m\r\n`);
    safe(() => C.onScreen(tab, { status: 'exited', exited: true, rest: tab.rest, choices: null, spinner: '', needTerminal: false, mode: tab.mode, peek: tab.peek }));
  } else {
    api.ptyCreate(req);
  }
  if (mode === 'resume') startReplay(tab);

  renderTab(tab);
  saveSessions();
  scheduleRemote();
  return tab;
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  if (usageTabId === id) usageClose(); // UA1: close, with the seconds it was open
  safe(() => settleOnExit(tab, 'タブが閉じられました')); // its backlog item must not stay 対応中
  clearTimeout(tab.scanTimer);
  clearTimeout(tab.notifyTimer);
  clearTimeout(tab.autoYesTimer);
  safe(() => tab.resizeObs?.disconnect());
  const ids = [...tabs.keys()];
  const next = ids[ids.indexOf(id) + 1] ?? ids[ids.indexOf(id) - 1];
  api.ptyClose(id);
  safe(() => tab.term.dispose());
  tab.el.remove();
  tab.btn.remove();
  tab.conv?.el.remove();
  tab.conv?.dock.remove();
  tab.peekBar?.remove();
  tabs.delete(id);
  closeConvPanel(id);
  for (const mv of [...memberViews.values()]) if (mv.tabId === id) safe(() => mv.api?.close());
  rememberViewMode(id, null, false);
  if (composerStore.drafts?.[id]) {
    delete composerStore.drafts[id];
    saveComposerStore();
  }
  for (const p of panes) if (p.tabId === id) p.tabId = null;
  if (tabs.size === 0) {
    activeId = null;
    // AT-139: no new claude by itself; the empty screen (noTabsCard) instead. The manager window keeps its resident
    // session (the PMO) as before.
    if (info.role === 'manager') createTab();
    else {
      applyLayout();
      updateTitle();
    }
  } else {
    if (activeId === id) {
      // picked by the app, not by the user: no activity for the auto-close clock (quietAtOf)
      const nt = tabs.get(next);
      const was = nt ? nt.userSelectedAt : 0;
      activate(next);
      if (nt) nt.userSelectedAt = was;
    }
    fillEmptyPanes();
    applyLayout();
    fitSoon();
  }
  saveSessions();
  scheduleRemote();
}

// ---- sessions -------------------------------------------------------------
let saveTimer = 0;
function saveSessions() {
  if (!restoreDone) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // a tab that handed off to a new session is history now (still in the 履歴 menu), not resumed
    const list = [...tabs.values()].filter((t) => !t.handedOff).map((t) => ({
      id: t.id,
      label: t.label,
      manualLabel: !!t.manualLabel,
      cwd: t.cwd || info.workDir,
      worktree: t.worktree || null,
      team: !!t.team,
      delegate: !!t.delegate,
      ...(t.model ? { model: t.model } : {}), // AT-6: resumed with the same model / effort
      ...(t.effort ? { effort: t.effort } : {}),
      forBacklog: !!t.forBacklog,
      rest: t.rest || null, // resting (PROGRESS 35 / 31): restored without starting its claude
      usedAt: usedAtOf(t), // last talked to / opened by the user: a session used after its item ended is resumed (42)
      quietAt: safe(() => quietAtOf(t), 0), // AT-autoclose: its last activity, so the clock goes on after a restart
      asking: safe(() => waitsForAnswer(t), false), // waits for the user's answer: not closed by the clock
    }));
    for (const t of tabs.values()) t.quietSavedAt = safe(() => quietAtOf(t), 0);
    safe(() => api.sessionsSave(list));
  }, 400);
}

const evtKey = (e) =>
  [e.kind, e.ts, e.uuid ? `${e.uuid}:${e.idx ?? 0}` : e.msgId || e.toolUseId || e.agentId || '', e.kind === 'subagent' ? `${e.status}|${e.updatedAt}|${e.toolCount}` : ''].join('|');

async function startReplay(tab) {
  tab.replayQueue = [];
  let evts = [];
  try {
    evts = (await api.replay(tab.id)) || [];
  } catch (err) {
    console.error('replay failed', err);
  }
  if (!tabs.has(tab.id)) return;
  const seen = new Set();
  C.beginBulk(tab); // the conversation view renders only the tail of a long history
  for (const evt of evts) {
    seen.add(evtKey(evt));
    applyEvent(tab, evt, false);
  }
  C.endBulk(tab);
  const queued = tab.replayQueue || [];
  tab.replayQueue = null;
  for (const evt of queued) if (!seen.has(evtKey(evt))) applyEvent(tab, evt, true);
  if (tab.id === activeId) renderPanelNow();
  scheduleRemote();
}

// ---- assist events --------------------------------------------------------
function handleAssistEvent(evt) {
  const tab = evt && tabs.get(evt.sessionId);
  if (!tab) return;
  if (tab.replayQueue) {
    tab.replayQueue.push(evt);
    return;
  }
  applyEvent(tab, evt, true);
}

function applyEvent(tab, evt, live) {
  if (evt.cwd && evt.cwd !== tab.cwd) {
    tab.cwd = evt.cwd;
    const wt = worktreeFromCwd(evt.cwd);
    if (wt && !tab.worktree) tab.worktree = wt;
    renderTab(tab);
    saveSessions();
  }
  if (evt.kind === 'prompt') {
    if (!tab.promptLabel && evt.text) tab.promptLabel = shortLabel(evt.text);
    updateLabel(tab);
  } else if (evt.kind === 'title') {
    if (evt.title) tab.titleLabel = shortLabel(evt.title, 40);
    updateLabel(tab);
  }
  if (live) {
    if (evt.kind === 'prompt') {
      tab.lastPromptAt = Date.now(); // sendText checks that a message really started a turn
      // Who started this turn: the latest of "typed in the terminal" and "sent by the app" decides.
      tab.turnStartAt = Date.now();
      tab.turnByUser = (tab.lastTypedAt || 0) > (tab.lastSendAt || 0) ? true : tab.lastSendOrigin !== 'auto';
      tab.started = true;
      tab.evtStatus = 'running';
      tab.evtAt = Date.now();
      if (!tab.exited && tab.status !== 'asking') setStatus(tab, 'running');
      scheduleScan(tab);
    } else if (evt.kind === 'api_error') {
      tab.apiErrorAt = Date.now();
      tab.apiErrorText = String(evt.text || evt.error || '').slice(0, 200); // the reason on あなたの番 (autosend.js)
      tab.started = true;
      raise(tab, 'error', evt.text || evt.error || 'API エラー');
    } else if (evt.kind === 'assistant_text') {
      // backlog: the routed item's marker (作業完了 / 作業中断) is read from the last reply
      tab.lastAssistantText = String(evt.text || '').slice(-2000);
      tab.lastAssistantAt = Date.now();
      tab.started = true;
    } else if (evt.kind === 'turn_end') {
      tab.lastTurnEndAt = Date.now(); // backlog: the sent item finished a turn
      setTimeout(() => maybeNotifyDone(tab), 1600); // the screen may have gone idle before this arrived
      tab.started = true;
      tab.evtStatus = 'idle';
      tab.evtAt = Date.now();
      scan(tab); // screen decides (it wins if a turn is still visibly running)
    } else {
      tab.started = true;
    }
  }
  P.onEvent(tab, evt);
  C.onEvent(tab, evt);
  if (live) safe(() => window.Handoff?.onEvent?.(tab, evt)); // collects the handoff memo
  if (evt.kind === 'subagent' && evt.agentId) (tab.subSnaps ||= new Map()).set(evt.agentId, evt); // member views
  if (live) memberActivity(tab, evt);
  if (live) {
    if (tab.id === activeId) renderPanelSoon();
    scheduleRemote();
  }
}

// ---- screen scan: status, choices, auto-yes --------------------------------
// Default on (user, 2026-11-03: background sessions must not stop at dialogs); an explicit OFF is kept.
// The setting is ⚙ 設定 →「安全な確認は自動で通す」(Labels.WORDS.autoYes, settings.js through window.AutoYes; UIUX U4).
let autoYes = localStorage.getItem('autoYes') !== '0';

// One setting for every window: a change here goes to the others through main (autoYes:set -> autoYes:changed);
// `fromOther` = applying another window's change (not sent back).
function setAutoYes(on, fromOther = false) {
  autoYes = on;
  localStorage.setItem('autoYes', on ? '1' : '0');
  for (const t of tabs.values()) scheduleScan(t);
  if (!fromOther) api.autoYesSet?.(on);
  if (window.Settings?.isOpen?.()) safe(() => window.Settings.render());
}
window.AutoYes = { get: () => autoYes, set: (on) => setAutoYes(!!on) };
api.onAutoYesChanged?.((p) => p && typeof p.on === 'boolean' && setAutoYes(p.on, true));

// Debounced (250 ms after the last output) but with a max wait: Claude Code redraws spinners /
// timers more often than 250 ms, and a plain debounce would then never scan at all.
const SCAN_DEBOUNCE_MS = 250;
const SCAN_MAX_WAIT_MS = 600;

function scheduleScan(tab) {
  clearTimeout(tab.scanTimer);
  const now = Date.now();
  if (!tab.scanPendingSince) tab.scanPendingSince = now;
  const wait = Math.max(0, Math.min(SCAN_DEBOUNCE_MS, tab.scanPendingSince + SCAN_MAX_WAIT_MS - now));
  tab.scanTimer = setTimeout(() => scan(tab), wait);
}

// Bottom of the live buffer (independent of where the user scrolled to).
function readScreen(tab, maxLines) {
  if (!tab.opened) return [];
  const term = tab.term;
  const buf = term.buffer.active;
  const end = buf.baseY + term.rows;
  const start = Math.max(0, end - (maxLines || term.rows));
  const out = [];
  for (let y = start; y < end; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '');
  return out;
}

// Same region as readScreen, but soft-wrapped rows (IBufferLine.isWrapped) are joined into
// logical lines so long questions / option labels match as one line.
// Exception: Claude Code pads its rows with spaces to the full width, and at 80 columns (the size of
// a tab that was never shown: fit() cannot measure a hidden element) xterm then marks the next row as
// wrapped, gluing "❯ 1. Yes" and "2. No" into one line and hiding the dialog from Auto-yes (bug
// 2026-11-03, background routed tab). A row that starts a numbered option after a padded row is a new line.
const WRAPPED_OPT_RE = /^[\s│┃║|]*([❯›>]\s*)?\d{1,2}[.)]\s/;
function readLogicalScreen(tab) {
  if (!tab.opened) return [];
  const term = tab.term;
  const buf = term.buffer.active;
  const end = buf.baseY + term.rows;
  let start = Math.max(0, buf.baseY);
  while (start > 0 && buf.getLine(start)?.isWrapped) start--;
  const out = [];
  let prevRaw = '';
  for (let y = start; y < end; y++) {
    const line = buf.getLine(y);
    if (!line) {
      out.push('');
      prevRaw = '';
      continue;
    }
    const raw = line.translateToString(false);
    const padded = /\s$/.test(prevRaw) && WRAPPED_OPT_RE.test(raw);
    if (line.isWrapped && out.length && !padded) out[out.length - 1] += raw;
    else out.push(raw);
    prevRaw = raw;
  }
  return out.map((l) => l.replace(/\s+$/, ''));
}

const BOX = /[│┃║|╭╮╰╯─━═┌┐└┘├┤]/g;
const OPT_RE = /^[\s│┃║|]*([❯›>])?\s*(\d{1,2})[.)]\s+(.+?)[\s│┃║|]*$/;
const SEL_RE = /^[\s│┃║|]*[❯›>]\s*\d{1,2}[.)]\s+\S/;
const CHOICE_WINDOW = 30; // a live menu is always near the bottom of the screen

function cleanLine(l) {
  return l.replace(BOX, ' ').replace(/\s+/g, ' ').trim();
}

// Structural menu parser. Returns { question, options, permission, firstIdx } or null.
// permission = the numbered menu also offers a "No…" option (permission dialogs always do;
// AskUserQuestion menus don't). The "Do you want to …?" text is NOT required.
function parseChoices(lines) {
  let selIdx = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - CHOICE_WINDOW); i--) {
    if (SEL_RE.test(lines[i])) {
      selIdx = i;
      break;
    }
  }
  if (selIdx < 0) return null;
  const cands = [];
  for (let i = Math.max(0, selIdx - 25); i < Math.min(lines.length, selIdx + 25); i++) {
    const m = OPT_RE.exec(lines[i]);
    if (m) cands.push({ idx: i, n: Number(m[2]), label: cleanLine(m[3]), selected: !!m[1] });
  }
  const sel = cands.find((c) => c.idx === selIdx);
  if (!sel) return null;
  const chain = [sel];
  for (let k = sel.n - 1; k >= 1; k--) {
    const top = chain[0].idx;
    const c = cands.filter((x) => x.n === k && x.idx < top).pop();
    if (!c) break;
    chain.unshift(c);
  }
  for (let k = sel.n + 1; k < 100; k++) {
    const bottom = chain[chain.length - 1].idx;
    const c = cands.find((x) => x.n === k && x.idx > bottom);
    if (!c) break;
    chain.push(c);
  }
  if (chain.length < 2 || chain[0].n !== 1) return null;

  let question = '';
  const first = chain[0].idx;
  for (let i = first - 1; i >= Math.max(0, first - 14) && !question; i--) {
    const t = cleanLine(lines[i]);
    const m = /Do you want to .+?\?/.exec(t);
    if (m) question = t.slice(m.index);
  }
  for (let i = first - 1; i >= Math.max(0, first - 14) && !question; i--) {
    const t = cleanLine(lines[i]);
    if (t && /[?？]$/.test(t)) question = t;
  }
  if (!question) {
    for (let i = first - 1; i >= Math.max(0, first - 6); i--) {
      const t = cleanLine(lines[i]);
      if (t && /[\p{L}\p{N}]/u.test(t)) {
        question = t;
        break;
      }
    }
  }
  const options = chain.map((c) => ({ n: c.n, label: c.label, selected: c.selected }));
  const permission = isPermissionMenu(question, options);
  if (permission) options[options.length - 1].label = fixNoLabel(options[options.length - 1].label);
  return { question, permission, options, firstIdx: first };
}

// A permission dialog = a "No…" option, and no AskUserQuestion rows ("Type something." / "Chat about this").
// The "No" row is sometimes glued to leftover cells of a longer row drawn there before ("Nossion", "Noasure…",
// "Nocs/roadmap.md": Claude Code skips cells it thinks are blank, bug 2026-11-04). Such a last row still counts when
// the dialog asks "Do you want to …?" and option 1 is exactly "Yes"; its label is cut back to "No" (fixNoLabel).
const NO_LABEL_RE = /^No(?=$|[\s,.(:;、。（])/;
const NO_GLUED_RE = /^No(?![\s,.(:;、。（]|$)/;
function isPermissionMenu(question, options) {
  if (options.some((o) => /^(Type something\.?|Chat about this)$/i.test(o.label))) return false;
  if (options.some((o) => NO_LABEL_RE.test(o.label))) return true;
  return /^Do you want to /.test(question) && options[0]?.label === 'Yes' && options.length > 1 && NO_GLUED_RE.test(options[options.length - 1].label);
}
function fixNoLabel(label) {
  return NO_GLUED_RE.test(label) ? 'No' : label;
}

// Unnumbered menus (e.g. the folder trust dialog: "> No, exit" / "Yes, I trust this folder"
// above "Enter to confirm · Esc to cancel"). Digit keys don't work there, so no options are
// returned: the tab is just marked 'asking' and the user answers with arrows + Enter.
// Never auto-answered.
const MENU_FOOTER_RE = /Enter to (confirm|select)/i;
const UNNUM_SEL_RE = /^[\s│┃║|]*[❯›>]\s*\S/;

function parseUnnumberedMenu(lines) {
  const start = Math.max(0, lines.length - CHOICE_WINDOW);
  let footer = -1;
  for (let i = lines.length - 1; i >= start; i--) {
    if (MENU_FOOTER_RE.test(lines[i])) {
      footer = i;
      break;
    }
  }
  if (footer < 0) return null;
  let sel = -1;
  for (let i = footer - 1; i >= Math.max(start, footer - 20); i--) {
    if (UNNUM_SEL_RE.test(lines[i]) && !OPT_RE.test(lines[i])) {
      sel = i;
      break;
    }
  }
  if (sel < 0) return null;
  let question = '';
  for (let i = sel - 1; i >= Math.max(0, sel - 14) && !question; i--) {
    const t = cleanLine(lines[i]);
    if (t && /[?？]/.test(t)) question = t;
  }
  return { question: question || cleanLine(lines[sel]), permission: false, options: [], firstIdx: sel };
}

// Multi-select AskUserQuestion (verified on Claude Code 2.1.316, docs/roadmap.md "デバッグの予定"):
//   ←  ☒ Fruits  ✔ Submit  →          question tabs (☒ answered / ☐ not yet)
//   Which fruits do you like?
//   ❯ 1. [✔] Apple                    digits / Space / Enter toggle a box, nothing is sent
//     2. [ ] Banana
//     4. [ ] Type something           free text slot (never a button)
//        Submit                       unnumbered: Enter goes to the review screen ("Next" if more questions)
//   ─────────
//     5. Chat about this              rejects the whole tool call (never a button)
// Tab moves to the next question / the review screen ("1. Submit answers / 2. Cancel", a normal menu).
const CHECK_RE = /^\[([ ✔✓xX×])\]\s*(.*)$/;
const SUBMIT_ROW_RE = /^[\s│┃║|]*([❯›>])?\s+(Submit|Next)\s*$/;
const QTABS_RE = /^\s*←\s+(.*?)\s*✔\s*Submit\s+→\s*$/;

function parseMultiSelect(lines) {
  const start = Math.max(0, lines.length - CHOICE_WINDOW);
  let sub = -1;
  for (let i = lines.length - 1; i >= start; i--) {
    if (SUBMIT_ROW_RE.test(lines[i])) {
      sub = i;
      break;
    }
  }
  if (sub < 0) return null;
  const sm = SUBMIT_ROW_RE.exec(lines[sub]);
  const opts = [];
  for (let i = sub - 1; i >= Math.max(0, sub - 30); i--) {
    const m = OPT_RE.exec(lines[i]);
    if (!m) continue; // description rows
    const c = CHECK_RE.exec(cleanLine(m[3]));
    if (!c) return null;
    const n = Number(m[2]);
    if (opts.length && n !== opts[0].n - 1) return null;
    opts.unshift({ n, label: c[2], checked: c[1] !== ' ', cursor: !!m[1], idx: i });
    if (n === 1) break;
  }
  if (!opts.length || opts[0].n !== 1) return null;
  const first = opts[0].idx;
  let question = '';
  let tabs = [];
  for (let i = first - 1; i >= Math.max(0, first - 12); i--) {
    const tm = QTABS_RE.exec(lines[i]);
    if (tm) {
      tabs = tm[1].split(/\s{2,}/).map((s) => ({ answered: s.startsWith('☒'), label: s.replace(/^[☐☒]\s*/, '') }));
      break;
    }
    if (!question && /[\p{L}\p{N}]/u.test(lines[i])) question = cleanLine(lines[i]);
  }
  const last = opts[opts.length - 1].n; // "Type something"
  return {
    kind: 'multi',
    question,
    permission: false,
    options: opts.map(({ n, label, checked, cursor }) => ({ n, label, checked, selected: cursor, other: n === last })),
    submitLabel: sm[2],
    onSubmitRow: !!sm[1],
    tabs,
    firstIdx: first,
  };
}

const STARTED_RE = /for shortcuts|Claude Code|❯|╭─|Welcome/;

// AT-8: what xterm.js sends on its own as the answer to a query of the program, not typed by the user: cursor position
// (CPR "ESC[r;cR", DECXCPR "ESC[?r;c(;p)R"), device attributes (DA1 "ESC[?…c", DA2 "ESC[>…c"), focus in / out
// ("ESC[I" / "ESC[O"), mode reports (DECRPM "ESC[?…$y"), OSC answers (colors, "ESC]…BEL|ST") and DCS answers
// ("ESCP…ST"). Claude Code asks the cursor position about 5 times a second; on macOS / Linux the pty passes the
// question to xterm.js, whose answer came through onData and counted as typing, so a tab was never "quiet" for
// BACKLOG_QUIET_MS and a routed item's first prompt was never sent (on Windows ConPTY answers itself).
// (Shift / Ctrl+F3 is "ESC[1;2R" too, the same as a CPR for row 1: such a key is not counted as typing either.)
const TERM_REPLY_RE = /^(?:\x1b\[\??\d+(?:;\d+)*R|\x1b\[[?>]\d*(?:;\d+)*c|\x1b\[[IO]|\x1b\[\?\d+;\d+\$y|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/;
const isTermReply = (data) => typeof data === 'string' && data.length > 0 && TERM_REPLY_RE.test(data);

// Auto-yes bookkeeping (tab.autoYesAns = { key, at, tries } | null).
// A dialog is identified by its text (question, options and the lines just above them), so a new
// dialog that replaces the previous one without an intermediate frame is still answered, and an
// Enter that got lost is re-sent. Identical back-to-back dialogs are covered by the retry.
const AUTO_YES_RETRY_MS = 1500;
const AUTO_YES_MAX_TRIES = 3;

function dialogContext(lines, firstIdx) {
  return lines
    .slice(Math.max(0, firstIdx - 7), firstIdx)
    .map((l) => cleanLine(l).replace(/[╌╍┄┅┈┉─━]{2,}/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter((l) => /[\p{L}\p{N}]/u.test(l))
    .join(' | ');
}

// The dialog on the screen as the PMO (manager agent) sees it (roadmap 27, src/main/stuck.js): what it is, its text from
// the top border of the dialog down to the options, and a key that changes when the dialog does (the manager's answer
// action names the key, so a different dialog that replaced it is never pressed). since = when this dialog appeared.
const PROMPT_TOP_RE = /^\s*[╭┌]|[─━]{8,}/;
function promptKeyOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36) + text.length.toString(36);
}
function promptInfo(tab, lines, choices) {
  const first = Math.max(0, choices.firstIdx || 0);
  const context = [];
  let complete = false;
  for (let i = first - 1; i >= Math.max(0, first - 25); i--) {
    if (PROMPT_TOP_RE.test(lines[i])) {
      complete = true;
      break;
    }
    const t = cleanLine(lines[i]);
    if (t) context.unshift(t);
  }
  const kind = choices.kind === 'multi' ? 'multi' : !choices.options.length ? 'menu' : choices.permission ? 'permission' : 'question';
  const options = choices.options.map((o) => ({ n: o.n, label: o.label }));
  const key = promptKeyOf([kind, ...context, choices.question, ...options.map((o) => `${o.n}.${o.label}`)].join('\n'));
  const prev = tab.prompt;
  return { key, since: prev && prev.key === key ? prev.since : Date.now(), kind, question: choices.question, options, context, complete };
}

function scan(tab) {
  clearTimeout(tab.scanTimer);
  tab.scanPendingSince = 0;
  if (!tabs.has(tab.id) || !tab.opened) return;
  tab.scanSeq = tab.outSeq || 0;
  const lines = readLogicalScreen(tab);
  // Until the screen fills up, content sits at the top and the bottom rows are blank. Drop them so
  // the "last N lines" windows used for menu detection are relative to the last visible content.
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const text = lines.join('\n');
  if (!tab.started && ((/\S/.test(text) && STARTED_RE.test(text)) || (tab.firstDataAt && Date.now() - tab.firstDataAt > 6000))) {
    tab.started = true;
  }
  const running = /(esc|enter) to interrupt/i.test(text);
  let choices = tab.exited ? null : parseMultiSelect(lines) || parseChoices(lines) || parseUnnumberedMenu(lines);
  // The manager window runs hidden in the app's own folder, and a session made for an item the
  // manager routed (tab.forBacklog) may start in a folder never trusted: the first-run folder-trust
  // dialog must not block them. Only there, select "Yes, I trust this folder" (↓ until selected,
  // then Enter). Temp / edit windows (info.temp) run in an empty folder the app just made, so they too.
  // Everywhere else (tabs the user opened) unnumbered menus are never auto-answered.
  if (choices && !choices.options.length && (info.role === 'manager' || tab.forBacklog || info.temp) && /trust/i.test(text)) {
    const now = Date.now();
    if (!tab.trustAt || now - tab.trustAt > 700) {
      tab.trustAt = now;
      tab.trustTries = (tab.trustTries || 0) + 1;
      const sel = lines.find((l) => UNNUM_SEL_RE.test(l) && !OPT_RE.test(l)) || '';
      if (tab.trustTries <= 6) api.ptyInput({ id: tab.id, data: /yes|trust/i.test(sel) && !/no,?\s*exit/i.test(sel) ? '\r' : '\x1b[B' });
      setTimeout(() => scheduleScan(tab), 800);
    }
  }
  let autoAnswered = false;

  if (choices && choices.permission) {
    const sel = choices.options.find((o) => o.selected);
    const defaultIsYes = !!sel && sel.n === 1 && /^Yes\b/.test(sel.label);
    const excluded = /use this API key/i.test(choices.question);
    if (autoYes && defaultIsYes && !excluded) {
      const context = dialogContext(lines, choices.firstIdx);
      const key = [context, choices.question, ...choices.options.map((o) => o.label)].join('\n');
      const now = Date.now();
      const prev = tab.autoYesAns;
      const isNew = !prev || prev.key !== key;
      const retry = !isNew && now - prev.at >= AUTO_YES_RETRY_MS && prev.tries < AUTO_YES_MAX_TRIES;
      if (isNew || retry) {
        // Enter (not a digit) so that "2. Yes, and don't ask again" is never chosen.
        api.ptyInput({ id: tab.id, data: '\r' });
        tab.autoYesAns = { key, at: now, tries: isNew ? 1 : prev.tries + 1 };
        if (isNew) {
          P.addLocal(tab, { name: 'Auto-yes', arg: context.slice(0, 220) });
          if (tab.id === activeId) renderPanelSoon();
        }
        // The screen may stay static if the Enter was lost: re-check even without new output.
        clearTimeout(tab.autoYesTimer);
        tab.autoYesTimer = setTimeout(() => scheduleScan(tab), AUTO_YES_RETRY_MS + 100);
      }
      if (tab.autoYesAns.tries < AUTO_YES_MAX_TRIES || now - tab.autoYesAns.at < AUTO_YES_RETRY_MS) {
        autoAnswered = true;
        choices = null;
      }
      // else: gave up after retries -> leave the dialog visible ('asking') so the user notices.
    } else {
      tab.autoYesAns = null;
    }
  } else {
    tab.autoYesAns = null; // dialog gone (or never shown): ready for the next one
  }

  let st;
  if (tab.exited) st = 'exited';
  else if (choices) st = 'asking';
  else if (running || autoAnswered) st = 'running';
  else if (tab.evtStatus === 'running' && Date.now() - tab.evtAt < 4000) st = 'running';
  else if (tab.started) st = 'idle';
  else st = 'starting';

  tab.choices = choices
    ? { question: choices.question, options: choices.options, ...(choices.kind === 'multi' ? { kind: 'multi', submitLabel: choices.submitLabel, tabs: choices.tabs } : {}) }
    : null;
  tab.prompt = choices ? safe(() => promptInfo(tab, lines, choices), null) : null;
  // 回答を確定 of a multi-select from the dashboard: Tab reached the review screen -> press its "Submit answers"
  if (tab.submitAnswersUntil && choices && !choices.permission && choices.kind !== 'multi' && /submit your answers/i.test(choices.question || '')) {
    const sub = Date.now() < tab.submitAnswersUntil ? choices.options.find((o) => /^submit answers?(\s|$)/i.test(o.label)) : null;
    tab.submitAnswersUntil = 0;
    if (sub) {
      api.ptyInput({ id: tab.id, data: String(sub.n) });
      setTimeout(() => scheduleScan(tab), 200);
    }
  }
  setStatus(tab, st);
  screenToConversation(tab, lines, running, choices, autoAnswered);
  scheduleRemote();
}

// ---- conversation view: what the screen says --------------------------------
// The normal input prompt ("❯ " between horizontal rules) near the bottom = Claude Code's main
// screen. When it is missing for a while (full-screen UIs like /config, login, unnumbered menus)
// the rich view hands over to the terminal and takes it back once the prompt returns.
// Prompt characters: ❯ / > (normal), ! (bash mode), # (memory mode).
const PROMPT_LINE_RE = /^[\s│┃|]*[❯>!#](\s|$)/;
const PROMPT_WINDOW = 24;
const NEED_TERMINAL_MS = 1500;

// Claude Code's input box is drawn between horizontal rules; a "❯" selection marker in a list
// (e.g. /config's "  ❯ Auto-compact   true") has no rule right above it.
const RULE_RE = /[─━]{8,}/;
// Footers of full-screen UIs (/config, pickers): never the main screen, whatever else is visible.
// The first /config of a session shows only its tab row ("Settings  Status  Config  Usage  Stats") for ~2 s
// while it loads (verified on 2.1.317).
const FULLSCREEN_FOOTER_RE = /Esc to (close|clear|go back)|Type to (filter|search)|^\s*Settings\s+Status\s+Config\b/i;

function hasFullscreenFooter(lines) {
  const start = Math.max(0, lines.length - PROMPT_WINDOW);
  for (let i = lines.length - 1; i >= start; i--) if (FULLSCREEN_FOOTER_RE.test(lines[i])) return true;
  return false;
}

function hasInputPrompt(lines) {
  if (hasFullscreenFooter(lines)) return false;
  const start = Math.max(0, lines.length - PROMPT_WINDOW);
  for (let i = lines.length - 1; i >= start; i--) {
    if (!PROMPT_LINE_RE.test(lines[i]) || OPT_RE.test(lines[i])) continue;
    if (RULE_RE.test(lines[i - 1] || '') || RULE_RE.test(lines[i - 2] || '')) return true;
  }
  return false;
}

// Text in Claude Code's input box (the "❯ " line under a rule), '' when empty, null when no input box.
function inputBoxText(lines) {
  if (hasFullscreenFooter(lines)) return null;
  const start = Math.max(0, lines.length - PROMPT_WINDOW);
  for (let i = lines.length - 1; i >= start; i--) {
    if (!PROMPT_LINE_RE.test(lines[i]) || OPT_RE.test(lines[i])) continue;
    if (RULE_RE.test(lines[i - 1] || '') || RULE_RE.test(lines[i - 2] || '')) return lines[i].replace(PROMPT_LINE_RE, '').replace(/[│┃|]\s*$/, '').trim();
  }
  return null;
}

// Identity of the current screen bottom: after the user leaves an auto-shown terminal ("会話に戻る"),
// the same screen must not pull them back (misdetections would otherwise trap them in the terminal).
const screenTailKey = (lines) => lines.slice(-PROMPT_WINDOW).map((l) => cleanLine(l)).join('\n');

// Physical rows (bottom of the buffer, trailing blank rows dropped). The prompt check must not use
// readLogicalScreen: after /config or a turn, xterm marks the rule and "❯ " rows as wrapped and the
// logical join glues them onto the previous line (verified on Claude Code 2.1.316).
function physicalScreen(tab) {
  const rows = readScreen(tab).map((l) => l.replace(/\s+$/, ''));
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  return rows;
}

// PROGRESS 23b: the automatic switch to the terminal hides the conversation view with its input box. It waits
// - while the box is composing (IME): hiding it ends the composition with nothing committed. The conversation view
//   calls hooks.composed at compositionend / focusout, which scans again.
// - while the user is typing in the box (focused, input within TYPING_HOLD_MS): the switch moves the focus to the
//   terminal, so the next keys would go to Claude Code's screen (a menu or a dialog) instead of the message.
//   A scan is set for when the pause is long enough. See the maintainers' test notes, note 23.
const TYPING_HOLD_MS = 2000;
function holdPeekForInput(tab, now) {
  const c = tab.conv;
  if (!c) return false;
  if (c.composing) return true;
  const since = now - (c.lastInputAt || 0);
  if (document.activeElement !== c.input || since >= TYPING_HOLD_MS) return false;
  clearTimeout(tab.typingHoldT);
  tab.typingHoldT = setTimeout(() => tabs.has(tab.id) && scan(tab), TYPING_HOLD_MS - since + 50);
  return true;
}

function screenToConversation(tab, logical, running, choices, autoAnswered) {
  if (!tab.conv) return;
  const lines = physicalScreen(tab);
  const now = Date.now();
  const unnumbered = !!choices && !choices.options.length;
  // A dialog that Auto-yes is answering is neither a prompt nor an unknown screen.
  // An empty screen (Claude Code redrawing, e.g. ~3 s after the trust dialog) is not a full-screen UI.
  const unknown = tab.started && !tab.exited && !choices && !running && !autoAnswered && lines.length > 0 && !hasInputPrompt(lines);
  if (!unknown) tab.unknownSince = 0;
  else if (!tab.unknownSince) {
    tab.unknownSince = now;
    setTimeout(() => tabs.has(tab.id) && scan(tab), NEED_TERMINAL_MS + 100);
  }
  // A full-screen footer ("Esc to close", "Type to filter") is unambiguous: hand over at once. Other
  // screens without the input prompt wait NEED_TERMINAL_MS (Claude Code redraws, transient screens).
  // Real claude 2.1.317, /config: footer ~0.1–0.2 s after Enter; the switch took ~1.9 s more before.
  let needTerminal = unnumbered || (unknown && (hasFullscreenFooter(lines) || now - tab.unknownSince >= NEED_TERMINAL_MS));
  const tail = needTerminal || tab.peekDismissed ? screenTailKey(lines) : '';
  if (tab.peekDismissed) {
    if (!needTerminal || tail !== tab.peekDismissed) tab.peekDismissed = '';
    else needTerminal = false;
  }
  if (tab.mode === 'rich') {
    if (needTerminal && !tab.peek) {
      if (!holdPeekForInput(tab, now)) setPeek(tab, 'auto');
    }
    else if (!needTerminal && tab.peek === 'auto') setPeek(tab, false);
  }
  tab.lastTail = tail || screenTailKey(lines);
  let spinner = '';
  if (running) {
    const l = lines.find((x) => /(esc|enter) to interrupt/i.test(x));
    if (l) spinner = cleanLine(l);
  }
  C.onScreen(tab, { status: tab.status, exited: tab.exited, rest: tab.rest || null, choices: tab.choices, spinner, needTerminal, mode: tab.mode, peek: tab.peek });
}

// Input from the conversation view / phone UI: paste, then Enter.
// Claude Code needs time to digest a paste that contains file paths: it shows "Pasting…" for 3–7 s and
// drops an Enter that arrives meanwhile (verified on 2.1.316). So Enter is sent once the paste has
// settled, and sent once more if the message did not start a turn.
// Claude Code 2.1.322 on this PC also reads no input for 20-25 s after it drew its prompt (startup work), and then
// reads what came meanwhile in one go: an Enter read together with the paste is taken as part of the paste (a newline
// in the box, not a submit). Long texts were hit most (routed items / handoffs are sent right after the start), and a
// first check at 5 s / 9 s saw the box still empty (the placeholder 'Try "…"'), so no Enter came after the paste
// showed: the text stayed in the box (tmp/longsend/real-screen.mjs, 2026-11-12). So the Enter waits until the screen
// shows the paste (it changed since the paste) and has been still for PASTE_STILL_MS, at most PASTE_SHOW_MAX_MS.
const PASTE_SETTLE_MAX_MS = 25_000;
const PASTE_SHOW_MAX_MS = 60_000; // the screen shows nothing of the paste yet: Enter anyway after this
const PASTE_STILL_MS = 600; // the screen unchanged this long after the paste showed: claude has read it
const SUBMIT_CONFIRM_MS = 5_000; // first look at the input box after the Enter
const SUBMIT_RECHECK_MS = 4_000; // then again after each extra Enter
const SUBMIT_MAX_ENTERS = 5; // the first Enter + up to 4 more (about 20 s in all)
// Claude Code's empty input box shows a hint (dim on screen, plain text here): 'Try "fix lint errors"'
const BOX_PLACEHOLDER_RE = /^Try "/;
const boxEmpty = (box) => box === '' || (box != null && BOX_PLACEHOLDER_RE.test(box));

// Does the input box still hold what sendText pasted? `box` = inputBoxText (its first row, cut at the width),
// Claude Code shows a long / multi-line paste as "[Pasted text #1 +12 lines]".
function boxHoldsSent(box, text) {
  if (!box) return false;
  if (/^\[Pasted text #\d+/.test(box)) return true;
  const head = (String(text).split('\n').find((l) => l.trim()) || '').replace(/\s+/g, ' ').trim();
  const b = box.replace(/\s+/g, ' ');
  const n = Math.min(16, b.length, head.length);
  return n >= 3 && b.slice(0, n) === head.slice(0, n);
}

// origin: 'user' (composer, QA table, phone, cheat sheet) or 'auto' (backlog / manager). Only turns the
// user started end with a "done" notification.
// The Enter can be lost, most often right after claude started (real claude: 1-2 tabs in each of 4 test runs,
// and the handoff memo, stable check NG 2 / 不具合候補 3), and then the text stays in the input box with no turn.
// So after the Enter the input box is checked: while it still holds the sent text, Enter again (at most
// SUBMIT_MAX_ENTERS in all). The first check also keeps the older rule (db16321): no prompt event / turn yet and
// the box not empty -> Enter once more. Never when the user has typed in the terminal since (the Enter would send
// their half-typed text) or a dialog is up (the Enter would answer it).
// The rows of the input box (between the rule above the "❯" row and the next rule), as one key: tells whether
// claude has put something into the box. The whole bottom of the screen when no box is found.
function inputBoxKey(lines) {
  const start = Math.max(0, lines.length - PROMPT_WINDOW);
  for (let i = lines.length - 1; i >= start; i--) {
    if (!PROMPT_LINE_RE.test(lines[i]) || OPT_RE.test(lines[i])) continue;
    if (!RULE_RE.test(lines[i - 1] || '') && !RULE_RE.test(lines[i - 2] || '')) continue;
    let j = i + 1;
    while (j < lines.length && !RULE_RE.test(lines[j])) j++;
    return lines.slice(i, j).map((l) => cleanLine(l)).join('\n');
  }
  return screenTailKey(lines);
}

function sendText(tab, text, origin = 'user') {
  if (!tab || tab.exited) return false;
  const sentAt = Date.now();
  tab.lastSendOrigin = origin;
  tab.lastSendAt = sentAt;
  tab.pasteUntil = sentAt + 1000; // our own paste is not "the user typed in the terminal"
  const boxBefore = inputBoxKey(physicalScreen(tab));
  tab.term.paste(String(text));
  scheduleScan(tab);
  const id = tab.id;
  const alive = () => tabs.has(id) && !tab.exited && tab.lastSendAt === sentAt; // a newer send takes over
  const pasting = (lines) => lines.slice(-12).some((l) => /Pasting/i.test(l));
  const started = () => (tab.lastPromptAt || 0) >= sentAt || tab.status === 'running' || tab.status === 'asking' || tab.titleBusy;
  let shown = false; // the box changed since the paste: claude has read (at least the start of) it
  let enters = 0;
  const enter = () => {
    if (!alive()) return;
    enters += 1;
    api.ptyInput({ id, data: '\r' });
    if (enters < SUBMIT_MAX_ENTERS) setTimeout(check, enters === 1 ? SUBMIT_CONFIRM_MS : SUBMIT_RECHECK_MS);
  };
  // Enter once the paste is read: not "Pasting…", the box changed since the paste, and the box unchanged for
  // PASTE_STILL_MS (an Enter that claude reads together with the paste is a newline). At most PASTE_SETTLE_MAX_MS
  // while "Pasting…" shows and PASTE_SHOW_MAX_MS in all from the start of this wait, then Enter anyway.
  let waitFrom = 0;
  let lastKey = null;
  let stillSince = 0;
  const tick = () => {
    if (!alive()) return;
    const now = Date.now();
    if (!waitFrom) waitFrom = now;
    const lines = physicalScreen(tab);
    const key = inputBoxKey(lines);
    if (key !== lastKey) {
      lastKey = key;
      stillSince = now;
    }
    const box = inputBoxText(lines);
    if (key !== boxBefore && !boxEmpty(box)) shown = true; // not just another hint in the empty box
    const busy = pasting(lines);
    const ready = !busy && shown && now - stillSince >= PASTE_STILL_MS;
    const waited = now - waitFrom;
    if (!ready && waited < PASTE_SHOW_MAX_MS && (!busy || waited < PASTE_SETTLE_MAX_MS)) {
      setTimeout(tick, 200);
      return;
    }
    waitFrom = 0;
    enter();
  };
  function check() {
    if (!alive() || (tab.lastTypedAt || 0) > sentAt) return;
    if (tab.choices || tab.status === 'asking') return;
    const box = inputBoxText(physicalScreen(tab));
    const empty = boxEmpty(box);
    // Our text still in the box: Enter again. The box not changed since the paste (claude has not read it yet, the
    // Enter came too early): wait for it again. First check also (db16321): no turn seen and the box not empty (after
    // /clear there is no prompt event; a box that is already empty was submitted).
    const again = boxHoldsSent(box, text) || (!started() && (!shown || (enters === 1 && !empty)));
    if (!again) return;
    tick(); // waits for the box to show the paste / to be still (or "Pasting…" to end), then Enter
  }
  setTimeout(tick, 150);
  return true;
}

// The conversation input must not answer a dialog by accident: the Enter after the paste would
// confirm the selected option (usually "1. Yes"). Returns a reason string when sending is blocked.
function convSendBlocked(tab) {
  if (!tab || tab.exited) return 'プロセスは終了しています';
  if (tab.choices || tab.status === 'asking') return '先に上の選択肢に答えてください（自由入力はターミナルで行えます）';
  if (tab.peek === 'auto') return 'ターミナルでの操作を先に終えてください';
  return '';
}

function convSend(tab, text) {
  if (tab && tab.rest && tabs.has(tab.id)) return wakeAndSend(tab, text); // 完了 / 休止中: wake, then send (PROGRESS 44)
  if (tab && tab.wakeSend) return 'claude を再開しています。起きてから送ってください';
  const why = convSendBlocked(tab);
  if (why) return why;
  sendText(tab, text);
  safe(() => window.Usage?.track?.('click', 'session.send')); // UA1: only that it was sent, never the text
  return '';
}

function setStatus(tab, st) {
  if (tab.status === st) return;
  const prev = tab.status;
  tab.status = st;
  // A finished dialog / new turn makes its "input" / "done" notice stale.
  if (st === 'running' || (st === 'idle' && prev === 'asking' && tab.unread?.kind === 'input')) clearUnread(tab);

  clearTimeout(tab.notifyTimer);
  if (st === 'idle' && prev === 'running') {
    tab.notifyTimer = setTimeout(() => {
      if (tab.status === 'idle') maybeNotifyDone(tab);
    }, 1500);
  } else if (st === 'asking') {
    tab.notifyTimer = setTimeout(() => {
      if (tab.status === 'asking') raise(tab, 'input', tab.choices?.question || '選択してください');
    }, 300);
  }

  renderTab(tab);
  if (tab.id === activeId) renderPanelSoon();
  if (band && band.tabId === tab.id) safe(() => tickProblemBand()); // UA3
  scheduleRemote();
}

// "Done" only when it means something to the user (2026-11-03, user: notifications rang with nothing
// to check or answer): a turn the user started (not a backlog / manager auto send), that really ended
// (turn_end from the transcript, not a status flicker), lasted long enough that they may have looked
// away, and not in the manager window (its turns are bookkeeping).
const DONE_MIN_TURN_MS = 15_000;
function doneWorthNotifying(tab) {
  if (info.role === 'manager') return false;
  if (!tab.turnByUser || !tab.turnStartAt) return false;
  if ((tab.lastTurnEndAt || 0) < tab.turnStartAt) return false;
  return tab.lastTurnEndAt - tab.turnStartAt >= DONE_MIN_TURN_MS;
}
// Called after the screen went idle and again when turn_end arrives (it may lag behind the screen);
// at most once per turn.
function maybeNotifyDone(tab) {
  if (tab.status !== 'idle' || tab.doneNotifiedFor === tab.turnStartAt || !doneWorthNotifying(tab)) return;
  tab.doneNotifiedFor = tab.turnStartAt;
  raise(tab, 'done', '応答が完了しました');
}

// ---- notifications (roadmap 3, docs/plan-notify.md) ------------------------------
// raise(tab, kind, text): kind 'done' | 'input' | 'error'. Unless the user is already looking at the tab
// (settings.suppress), the tab gets an unread mark (tab badge + pane ring), an entry in the 通知 panel,
// a sound (Sounds, rate-limited, highest priority wins) and optionally a desktop notification.
const KIND_PRIORITY = { input: 3, error: 2, done: 1 };
const SOUND_GAP_MS = 3000;
let soundSlot = null; // { kind, timer } – sounds requested in the same 120 ms collapse into the top-priority one

const notifySettings = () => safe(() => window.Notify?.settings?.(), null) || { sound: true, volume: 0.6, kinds: { done: true, input: true, error: true }, suppress: 'visible', desktop: true };

function userIsLooking(tab, s) {
  if (s.suppress === 'never') return false;
  if (!document.hasFocus()) return false;
  return s.suppress === 'focused' || isVisible(tab);
}

function raise(tab, kind, text) {
  if (!tabs.has(tab.id)) return;
  const s = notifySettings();
  if (userIsLooking(tab, s)) return;
  const prev = tab.unread;
  const now = Date.now();
  // Same notice again (e.g. the OSC backup for a dialog the screen already reported): keep the first.
  if (prev && prev.kind === kind && now - prev.at < 10_000) return;
  if (prev && KIND_PRIORITY[prev.kind] > KIND_PRIORITY[kind] && now - prev.at < 10_000) return;
  tab.unread = { kind, at: now, text: String(text || '') };
  tab.unseen = kind === 'done'; // legacy flag (tab glow for finished turns)
  safe(() => window.Notify?.push?.({ tabId: tab.id, kind, title: tab.label, body: text }));
  const sound = s.sound && s.kinds?.[kind] !== false && window.Sounds;
  if (sound) playSoon(tab, kind, s.volume);
  if (s.desktop && s.kinds?.[kind] !== false) {
    const prefix = { input: '確認待ち: ', error: 'エラー: ', done: '' }[kind] || '';
    safe(() => api.notify({ tabId: tab.id, kind, silent: !!sound, title: `${tab.label} - ${folderName || 'BantoDesk'}`, body: `${prefix}${text || ''}` }));
  }
  renderTab(tab);
  scheduleRemote();
}

function playSoon(tab, kind, volume) {
  const now = Date.now();
  tab.soundAt ||= {};
  if (now - (tab.soundAt[kind] || 0) < SOUND_GAP_MS) return;
  tab.soundAt[kind] = now;
  if (soundSlot) {
    if (KIND_PRIORITY[kind] > KIND_PRIORITY[soundSlot.kind]) soundSlot.kind = kind;
    return;
  }
  soundSlot = { kind };
  setTimeout(() => {
    const k = soundSlot.kind;
    soundSlot = null;
    safe(() => window.Sounds.play(k, volume, notifySettings().style));
  }, 120);
}

function clearUnread(tab) {
  if (!tab.unread && !tab.unseen) return;
  tab.unread = null;
  tab.unseen = false;
  renderTab(tab);
  scheduleRemote();
}

// Seen = its pane is visible while the window has focus.
function clearSeen() {
  if (!document.hasFocus()) return;
  for (const t of tabs.values()) if ((t.unread || t.unseen) && isVisible(t)) clearUnread(t);
}

// ---- backlog scheduler (roadmap 8, docs/plan-notify.md; start rules: PROGRESS 33, docs/plan-dashboard.md) -----
// A session "has finished its current work" when, for BACKLOG_STABLE_MS in a row: it is idle on the
// main screen (prompt visible, no dialog, no full-screen UI, title not busy), no subagent or team
// member is running, and the user has not typed (terminal or composer) for BACKLOG_QUIET_MS.
// Then the next pending item of that session is sent. A hand-queued item counts as done once its
// prompt arrived, a turn ended after it and the session is ready again.
// A routed item (its session was made for it, tab.forBacklog) needs more (routedProgress): the last reply ends with
// the line 作業完了 (or 作業中断: <reason>), and no subagent / member of it is still running.
const BACKLOG_STABLE_MS = 3000;
const BACKLOG_QUIET_MS = 5000;
const BACKLOG_SEND_TIMEOUT_MS = 60_000;
const SCHED_STALL_MS = 2 * 60_000; // routed: quiet without a marker this long -> 「途中で止まった可能性」 to the PMO
const SCHED_DEADLOCK_MS = 5 * 60_000; // routed with a team whose members all wait: 「待ち合い」 to the PMO
const SCHED_FAIL_MS = 30 * 60_000; // routed: quiet without a marker this long -> failed
const SCHED_PLAN_MS = 3000; // how often a window with waiting routed items asks main (sched:plan)
const SCHED_UNREAD_MS = 30_000; // teams:unread at most this often per session
// The marker line asked for by the delegation prompt (docs/prompts/routed-session.md); for sessions started
// without it (setting 振り分けたセッション off) the same request is appended to the item's text.
const MARK_PROMPT = '\n\n（アプリから）作業をすべて終えたら、最後の返答の末尾に「作業完了」の 1 行だけを書いてください。途中で止める場合は「作業中断: <理由>」と書いてください。サブエージェントやバックグラウンドのコマンドの結果を待つ間は書かないでください（この印でアプリが完了を判定します）。';
// tests may shorten the waits: window.__schedTimes = { stall, deadlock, fail, unread }
const schedMs = (k, d) => (window.__schedTimes && Number.isFinite(window.__schedTimes[k]) ? window.__schedTimes[k] : d);

// Stale agents (PROGRESS 46 / AT-autoclose): the rule is src/renderer/stale-agents.js, shared with main's waits.js
// (waits.json). After the session ended with 作業完了 (doneMarkAt), a subagent / team member still "running" whose
// transcript got no line for STALE_AGENT_MS is not waited for, so the done tab can rest. Backstop for exits the
// transcript parser cannot see. tests: window.__schedTimes.staleAgent (ms)
const SA = window.StaleAgents;
const STALE_AGENT_MS = SA.STALE_AGENT_MS;
// ms the session ended with 作業完了: its routed item done by the marker (finishedItemOf), or the live last reply ends
// with it and the turn is over (no newer prompt). 0 = not.
function doneMarkAt(tab) {
  const it = safe(() => finishedItemOf(tab), null);
  if (it && it.doneAt) return it.doneAt;
  const end = tab.lastTurnEndAt || 0;
  const m = end ? workMarker(tab, 0) : null;
  if (m && m.kind === 'done' && end >= (tab.lastPromptAt || 0) && end >= (tab.lastAssistantAt || 0)) return end;
  return 0;
}
// AT-autoclose: a subagent / team member still "running" or "starting" whose transcript got no line for this long is
// not waited for even without 作業完了 (a finished in-process teammate the parser missed, a call never linked to its
// transcript, T23): it kept old tabs "working" and the update restart waited for hours. Shorter while an update holds,
// still twice the longest single tool call that writes no line meanwhile (Bash, at most 10 min; background commands
// return at once). tests: window.__schedTimes.staleQuiet / staleQuietHold (ms)
const staleQuietMs = () => (updateHolds() ? schedMs('staleQuietHold', SA.STALE_QUIET_HOLD_MS) : schedMs('staleQuiet', SA.STALE_QUIET_MS));
// The clock of the stale rule for this tab (also sent to main in tabState.agentClock, so waits.json uses the same one):
// base = what a row without a transcript line counts from (its turn / the tab's creation)
const agentClockOf = (tab) => ({
  doneAt: doneMarkAt(tab),
  base: Math.max(tab.lastPromptAt || 0, tab.lastAssistantAt || 0, tab.lastTurnEndAt || 0, tab.createdAt || 0),
  staleMs: schedMs('staleAgent', STALE_AGENT_MS),
  quiet: staleQuietMs(),
});
// running / starting subagents and team members that still count (stale ones left out)
function liveAgents(tab, s = P.summary(tab), now = Date.now()) {
  const c = { ...agentClockOf(tab), now };
  const live = (a) => a && (a.status === 'running' || a.status === 'starting') && !SA.isStale(a, c);
  return {
    subs: (s.subagents || []).filter(live),
    members: s.team && !s.team.removed ? (s.team.members || []).filter(live) : [],
  };
}

// Update hold (src/main/autorestart.js, status pushed as app:update): while an update is reserved no queued item starts
// and no session is made for a routed item; items already running go on. After a restart at a turn gap the items that
// were running continue in their restored tab (same conversation through --resume) with RESUME_PROMPT.
let appUpdate = { state: 'none' };
const updateHolds = () => appUpdate.state === 'pending' || appUpdate.state === 'restarting';
const updateHoldText = () => (appUpdate.force ? '更新待ち: ターンの合間で再起動します（新しい作業は再起動の後に始めます）' : '更新待ち: 新しい作業は再起動の後に始めます');
const RESUME_PROMPT = '（アプリから）アプリの更新のために再起動しました。会話はそのまま続いています。中断したところから作業を続けてください。';
// AT-101: a routed item running when the app stopped without the update mark (crash, quit, restart) whose tab came back
const RESTART_PROMPT = '（アプリから）アプリが再起動しました。会話はそのまま続いています。中断したところから作業を続けてください（最初からやり直さないでください）。';
const RESUME_WAIT_MS = 3 * 60_000; // the restored tab must be ready within this, else the item fails (not sent from scratch)

// A running item marked by Backlog.markResume() before the restart: once its restored tab is ready, tell the session to
// go on; from then on it is judged as before (done mark / turn end), counted from now.
function backlogResumeTick(tab, active, now, stable) {
  const B = window.Backlog;
  // the old process marked it just before quitting: the mark is for the next process, which continues it
  if (appUpdate.state === 'restarting') return;
  if (tab.exited) return finishByMarker(tab, active, '再起動の後に claude が終了しました');
  tab.resumeWaitSince ||= now;
  if (!stable) {
    if (now - tab.resumeWaitSince > RESUME_WAIT_MS) B.finish(active.id, false, '再起動の後に続きを送れませんでした（セッションが応答できる状態になりませんでした）');
    return;
  }
  if (convSendBlocked(tab)) return;
  tab.resumeWaitSince = 0;
  tab.readySince = 0;
  tab.sched = null;
  const prompt = active.resume && active.resume.restart ? RESTART_PROMPT : RESUME_PROMPT;
  B.resumed(active.id);
  const mark = tab.forBacklog ? '\n終わったら、最後の返答の末尾に「作業完了」の 1 行を書いてください（途中でやめるなら「作業中断: <理由>」）。' : '';
  sendText(tab, prompt + mark, 'auto');
}

// ignoreHold: the handoff (handoff.js) uses the same readiness for its own steps
function backlogReady(tab, now, ignoreHold = false) {
  if (!ignoreHold && safe(() => window.Handoff?.holds?.(tab), false)) return false; // handoff in progress
  if (tab.exited || !tab.started || tab.status !== 'idle' || tab.titleBusy || tab.choices || tab.peek === 'auto') return false;
  if (now - (tab.lastUserInputAt || 0) < BACKLOG_QUIET_MS) return false;
  if (now - (tab.conv?.lastInputAt || 0) < BACKLOG_QUIET_MS) return false;
  if (!hasInputPrompt(physicalScreen(tab))) return false;
  const la = liveAgents(tab, P.summary(tab), now);
  if (la.subs.length || la.members.length) return false;
  return true;
}

// The marker at the end of the session's last reply (assistant text since `since`): { kind: 'done' } |
// { kind: 'abort', reason } | null. Markdown decoration around the line (**, `, >, #) is ignored.
function workMarker(tab, since) {
  if (!tab.lastAssistantText || (tab.lastAssistantAt || 0) < since) return null;
  const lines = String(tab.lastAssistantText).split(/\r?\n/).map((l) => l.replace(/[*`_>#]/g, '').trim()).filter(Boolean).slice(-4);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^作業完了[。.！!]?$/.test(lines[i])) return { kind: 'done' };
    const m = /^作業中断\s*[:：]\s*(.*)$/.exec(lines[i]);
    if (m) return { kind: 'abort', reason: m[1].trim().slice(0, 300) || '理由の記載なし' };
  }
  return null;
}

// What of a routed item still runs besides the lead: ['サブエージェント 2 件', …] (background commands started
// before the item are not counted: they belong to earlier work or a previous process).
function workActivity(tab, since) {
  const s = P.summary(tab);
  const out = [];
  const la = liveAgents(tab, s);
  const subs = la.subs.length;
  if (subs) out.push(`サブエージェント ${subs} 件`);
  const mem = la.members.length;
  if (mem) out.push(`チームのメンバー ${mem} 人`);
  const bg = (s.bg || []).filter((t) => t.startedAt >= since - 1000).length;
  if (bg) out.push(`バックグラウンドのコマンド ${bg} 件`);
  return out;
}

function schedAlert(item, kind, text) {
  safe(() => api.schedAlert?.({ backlogId: item.id, kind, text: String(text || '').slice(0, 500) }));
}

// Ends an item by its marker: done / failed. why = what happened (e.g. 'タブが閉じられました'; '' = the marker came).
function finishByMarker(tab, item, why) {
  const B = window.Backlog;
  const m = workMarker(tab, item.startedAt || 0);
  if (m && m.kind === 'done') B.finish(item.id, true, why ? `${why}（完了の印あり）` : '');
  else if (m && m.kind === 'abort') B.finish(item.id, false, `作業中断: ${m.reason}`);
  else B.finish(item.id, false, `${why}（完了の印なし）`);
  if (tab.sched && tab.sched.alerted) schedAlert(item, 'resumed', '');
  if (tab.sched) tab.sched.alerted = null;
}

// The tab is closing or its claude ended: the active item ends by its marker instead of staying 対応中.
function settleOnExit(tab, why) {
  const B = window.Backlog;
  const act = B && B.activeOf(tab.id);
  if (act) finishByMarker(tab, act, why);
}

// Routed item in progress (called every second once its prompt arrived). turnDone = a turn ended after the item
// started and the session is ready (backlogReady for BACKLOG_STABLE_MS, so no subagent / member is running).
function routedProgress(tab, active, now, turnDone) {
  const B = window.Backlog;
  let w = tab.sched;
  if (!w || w.itemId !== active.id) w = tab.sched = { itemId: active.id, quietSince: 0, alerted: null, alertedAt: 0, unread: null, unreadAt: 0, unreadBusy: false, baseNote: active.note || '' };
  // UX9: an automatic handoff is writing its memo / starting the new session: quiet is expected, not a stall
  // (a failed handoff no longer holds, so the watch resumes). backlogReady is false while it holds, so turnDone never
  // comes either; this says it outright. An alert raised before the handoff is resolved (the item moves on with it).
  if (safe(() => window.Handoff?.holds?.(tab), false)) {
    w.quietSince = 0;
    if (w.alerted) {
      schedAlert(active, 'resumed', '');
      w.alerted = null;
    }
    return;
  }
  const note = (x) => B.note(active.id, x || w.baseNote); // keeps e.g. the overtake note when there is nothing else to say
  const settled = turnDone && (tab.lastTurnEndAt || 0) >= (tab.lastPromptAt || 0); // no newer prompt (task notice, message)
  const mark = settled ? workMarker(tab, active.startedAt) : null;
  if (mark) return finishByMarker(tab, active, '');
  const moving = workActivity(tab, active.startedAt);
  if (!settled || moving.length) {
    w.quietSince = 0;
    if (w.alerted) {
      schedAlert(active, 'resumed', '');
      w.alerted = null;
    }
    note(settled ? `${moving.join('、')}の終わりを待っています` : '');
    return;
  }
  w.quietSince ||= now;
  const quiet = now - w.quietSince;
  if (quiet >= schedMs('fail', SCHED_FAIL_MS)) {
    B.finish(active.id, false, `完了の印がないまま止まりました（${Math.max(1, Math.round(quiet / 60_000))} 分動きなし）`);
    w.failedItem = active.id;
    w.failedAt = now;
    if (w.alerted) schedAlert(active, 'resumed', '');
    w.alerted = null;
    return;
  }
  if (w.alerted) return;
  const s = P.summary(tab);
  const team = s.team && !s.team.removed && (s.team.members || []).some((m) => m.status === 'idle') ? s.team : null;
  if (team) {
    // the lead and every member wait; an unread inbox message means someone is about to pick it up
    if (quiet < schedMs('deadlock', SCHED_DEADLOCK_MS)) return note('リーダーとメンバーが待機中です');
    if (!w.unreadBusy && now - w.unreadAt >= schedMs('unread', SCHED_UNREAD_MS) && api.teamUnread) {
      w.unreadBusy = true;
      w.unreadAt = now;
      Promise.resolve(safe(() => api.teamUnread(team.name), null))
        .then((r) => (w.unread = r && typeof r.unread === 'number' ? r.unread : -1))
        .catch(() => (w.unread = -1))
        .finally(() => (w.unreadBusy = false));
      return;
    }
    if (w.unread === null || w.unread > 0 || w.unreadBusy) return;
    const names = (team.members || []).map((m) => `${m.name}（${m.status === 'idle' ? '待機' : m.status}）`).join('、');
    w.alerted = 'deadlock';
    w.alertedAt = now;
    schedAlert(active, 'deadlock', `チーム ${team.name} のリーダーと全員が ${Math.max(1, Math.round(quiet / 60_000))} 分待機中で、未読のメッセージがありません。メンバー: ${names}`);
    note('待ち合いで止まった可能性があります（PMO に知らせました）');
    return;
  }
  if (quiet < schedMs('stall', SCHED_STALL_MS)) return;
  w.alerted = 'stalled';
  w.alertedAt = now;
  schedAlert(active, 'stalled', `最後の返答に「作業完了」も「作業中断」もないまま ${Math.max(1, Math.round(quiet / 60_000))} 分動きがありません。`);
  note('完了の印がないまま止まっています（PMO に知らせました）');
}

// ---- resting tabs (PROGRESS 35; 31 「使っていないタブを休ませる」 uses the same parts) -----------------------------
// A resting tab keeps its button, conversation view and terminal text, but its claude is stopped (pty:close: main kills
// it without a pty:exit) to free its memory. tab.rest = 'done' (its routed item ended with 作業完了) | 'idle' (31).
// It counts as exited for everything else (no backlog sends, between turns for an update restart). It wakes with
// `claude --resume <id>` (restartTab). 'idle' wakes when the user opens it (activate in a visible window, a dashboard /
// widget click). 'done' does not (PROGRESS 44): opening it shows the conversation and the terminal as they are; only
// an explicit action wakes it: 再開, Enter in the terminal, or a send from the input box (woken, then sent: wakeSend).
// Saved with the tab (sessions.json rest), so a restart (autorestart reopen) brings it back resting, without starting
// its claude.
const REST_TEXT = {
  done: '作業完了のため claude を止めました（メモリを空けるため）。「再開」か Enter、入力欄からの送信で再開します（会話はそのまま）',
  idle: 'しばらく使われていないため claude を休ませています。タブを開くか Enter で再開します（会話はそのまま）',
};
// o.exited: its claude already ended (stopped from outside after 作業完了, PROGRESS 42): marked resting, nothing to close
function restTab(tab, kind, o = {}) {
  if (!tabs.has(tab.id) || (tab.exited && !o.exited) || tab.rest || !REST_TEXT[kind]) return false;
  clearTimeout(tab.scanTimer);
  clearTimeout(tab.autoYesTimer);
  clearTimeout(tab.notifyTimer);
  tab.rest = kind;
  tab.restAt = Date.now();
  tab.restBy = o.by || ''; // 'auto' (idle timer) | 'hand' (休ませる) | '' (31)
  tab.exited = true;
  tab.exitCode = null;
  tab.choices = null;
  tab.prompt = null;
  tab.memMb = 0; // no claude: 0 on the badge / dashboard until it wakes (restartTab sets null = 計測中, 31)
  tab.readySince = 0;
  // the claude and every process under it (a detached child survives the ConPTY close), checked by main (PROGRESS 49)
  if (!o.exited) {
    if (api.ptyStopTree) {
      tab.stopTree = Promise.resolve(api.ptyStopTree({ id: tab.id, why: kind })).catch(() => null).then((r) => {
        tab.stopped = r || {};
        return r;
      });
    } else api.ptyClose(tab.id);
  }
  safe(() => tab.term.write(`\r\n\x1b[2m[${REST_TEXT[kind]}]\x1b[0m\r\n`));
  setStatus(tab, 'exited');
  renderTab(tab);
  safe(() => C.onScreen(tab, { status: tab.status, exited: true, rest: kind, choices: null, spinner: '', needTerminal: false, mode: tab.mode, peek: tab.peek }));
  saveSessions();
  renderPanelSoon();
  scheduleRemote();
  safe(() => window.Dashboard?.renderOwn?.());
  return true;
}
// '' = woken (or not resting), else the reason
function wakeTab(tab) {
  if (!tab || !tab.rest) return '';
  const was = tab.rest;
  tab.rest = null;
  tab.restAt = 0;
  const why = restartTab(tab, { noConfirm: true });
  if (why) tab.rest = was;
  saveSessions();
  return why;
}
// A send from the input box of a resting tab (PROGRESS 44): wake it, hold the text (tab.wakeSend) and send it once the
// resumed claude shows its input box (wakeSendTick). '' = woken and held, else the reason.
const WAKE_SEND_MAX_MS = 90_000;
function wakeAndSend(tab, text) {
  const why = wakeTab(tab);
  if (why) return why;
  tab.wakeSend = { text: String(text), at: Date.now() };
  safe(() => tab.conv?.showNotice?.('claude を再開しています。起きたら送ります'));
  return '';
}
function wakeSendTick(tab, now) {
  const p = tab.wakeSend;
  if (!p) return;
  const fail = (msg) => {
    tab.wakeSend = null;
    safe(() => tab.conv?.showNotice?.(msg));
    safe(() => raise(tab, 'error', msg));
  };
  if (tab.exited) return fail('claude が再開しなかったため、入力を送れませんでした');
  if (now - p.at > WAKE_SEND_MAX_MS) return fail('claude の再開を待ちきれず、入力を送れませんでした');
  // the resumed claude is up: its output has come for a moment, no dialog, not busy, its input box on the screen
  if (!tab.firstDataAt || now - tab.firstDataAt < 1500 || tab.choices || tab.titleBusy) return;
  if (tab.status === 'running' || tab.status === 'asking' || !hasInputPrompt(physicalScreen(tab))) return;
  tab.wakeSend = null;
  sendText(tab, p.text);
}

// ---- children at work (AT-200) ------------------------------------------------------------------------------------
// The automatic stops (auto-close, idle rest 31, done-stop 35) also wait for the processes running under the tab's
// claude (main's pty:kids: the process tree / what src/main/leftovers.js remembered; not its start-up helpers such as
// MCP servers). The transcript signals (tabWorks / workActivity) miss a command that outlives its record (a detached
// child, a background command marked stale after 作業完了). The answer is cached KIDS_POLL_MS; the wait is at most
// KIDS_WAIT_MAX_MS from the moment it first held the tab, so a child that never ends does not keep the tab for good.
// No process list (macOS outside the e2e: { unsupported }) or a failed list: no wait (as before).
// tests: window.__schedTimes.kidsPoll / kidsWaitMax (ms)
const KIDS_POLL_MS = 10_000;
const KIDS_WAIT_MAX_MS = 60 * 60_000;
function refreshKids(tab, now) {
  if (!api.ptyKids || (tab.kidsAskAt && now - tab.kidsAskAt < 30_000)) return;
  tab.kidsAskAt = now;
  Promise.resolve(api.ptyKids(tab.id)).catch((e) => ({ error: String(e) })).then((r) => {
    tab.kidsAskAt = 0;
    const list = r && Array.isArray(r.kids) ? r.kids : [];
    tab.kids = { at: Date.now(), skip: !r || !!(r.unsupported || r.none || r.error), n: r && Number.isFinite(r.count) ? r.count : list.length, list };
  });
}
// '' = nothing under its claude holds the tab, else the reason (the caller does not stop it this time)
function kidsHold(tab, now = Date.now()) {
  if (!api.ptyKids || tab.exited) return '';
  const k = tab.kids;
  if (!k || now - k.at >= schedMs('kidsPoll', KIDS_POLL_MS)) refreshKids(tab, now);
  if (!k) return tab.kidsAskAt ? '子のプロセスを確かめています' : '';
  if (k.skip || !k.n) {
    tab.kidsHeldAt = 0;
    return '';
  }
  tab.kidsHeldAt ||= now;
  if (now - tab.kidsHeldAt >= schedMs('kidsWaitMax', KIDS_WAIT_MAX_MS)) {
    if (!tab.kidsGaveUp) console.log('[kids] wait limit reached', tab.id, k.list.map((x) => `${x.pid} ${x.name}`).join(', '));
    tab.kidsGaveUp = true;
    return '';
  }
  tab.kidsGaveUp = false;
  const names = [...new Set(k.list.map((x) => x.name).filter(Boolean))].slice(0, 3).join('、');
  return `子のプロセス ${k.n} 件${names ? `（${names}）` : ''}が動いています`;
}

// ---- idle rest (PROGRESS 31, docs/rest-idle.md) -------------------------------------------------------------------
// A tab nobody used for the setting 「使っていないタブ」 (⚙ 設定, notifySettings.restIdleMin, default 30 min, 0 = off) rests
// (restTab 'idle': its claude and the processes under it stop, the tab / conversation / terminal stay). Use = selecting
// it, typing in the terminal or the input box, a sent prompt, its output, being on the screen of the focused window.
// It wakes on opening (activate in a visible window, the dashboard / widget / a notice), Enter, a send (held and sent
// once up: wakeAndSend), a backlog item queued for it. tests: window.__schedTimes.restIdle (ms)
function restIdleMs() {
  const v = notifySettings().restIdleMin;
  const min = v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 30;
  return schedMs('restIdle', min * 60_000);
}
const lastUseOf = (tab) => Math.max(tab.createdAt || 0, tab.selectedAt || 0, tab.lastOutAt || 0, tab.lastUserInputAt || 0,
  tab.conv?.lastInputAt || 0, tab.lastPromptAt || 0, tab.wokeAt || 0, tab.shownAt || 0, tab.restWakeAt || 0);
// Why the tab must not rest now ([] = it may). auto: the idle timer (also: never talked to, being typed into).
function restHold(tab, now = Date.now(), auto = true) {
  if (!tab || tab.exited || tab.rest) return ['claude が動いていません'];
  if (info.role === 'manager') return ['PMO の常駐セッションは休ませません'];
  const why = restartBusy(tab).slice();
  if (!tab.started || tab.status === 'starting') why.push('起動中です');
  if (tab.wakeSend) why.push('起こして送る途中です');
  if (safe(() => tabWorks(tab, now), false) && !why.length) {
    const act = safe(() => workActivity(tab, 0), []);
    why.push(act.length ? `${act.join('、')}が動いています` : 'サブエージェントやバックグラウンドのコマンドが動いています');
  }
  if (safe(() => window.Backlog?.pendingOf?.(tab.id)?.length, 0)) why.push('依頼・バックログの項目が待っています');
  if (auto) {
    if (!tab.resumed && !tab.lastPromptAt && !tab.lastAssistantAt) why.push('まだ 1 通もやりとりしていません');
    if (now - (tab.lastUserInputAt || 0) < BACKLOG_QUIET_MS || now - (tab.conv?.lastInputAt || 0) < BACKLOG_QUIET_MS) why.push('入力中です');
  }
  return why;
}
// 休ませる by hand (tab menu, the dashboard's 休止): '' = resting now, else the reason
function restByHand(tab) {
  if (!tab || !tabs.has(tab.id)) return 'セッションがありません';
  if (tab.rest) return '';
  const why = restHold(tab, Date.now(), false);
  if (why.length) return `休ませませんでした — ${why.join('、')}`;
  return restTab(tab, 'idle', { by: 'hand' }) ? '' : '休ませませんでした';
}
function idleRestTick(tab, now) {
  if (shownToUser(tab)) tab.shownAt = now; // on the user's screen: in use
  const B = window.Backlog;
  if (tab.rest === 'idle') {
    // a backlog item queued for it (auto send on): wake so backlogTick can send it
    if (B && !tab.wakeSend && !updateHolds() && B.auto?.(tab.id) && B.pendingOf?.(tab.id)?.length && !tab.restWakeTry) {
      tab.restWakeTry = true;
      const why = wakeTab(tab);
      tab.restWakeTry = false;
      if (!why) tab.restWakeAt = now;
    }
    return;
  }
  if (tab.exited || tab.rest) return;
  const ms = restIdleMs();
  if (!(ms > 0) || now - lastUseOf(tab) < ms) return;
  if (restHold(tab, now, true).length) return;
  if (kidsHold(tab, now)) return; // AT-200: a child of its claude still runs
  restTab(tab, 'idle', { by: 'auto' });
}
// the user comes back to the window: its active tab, rested by the timer while the window was in the background, wakes
window.addEventListener('focus', () => {
  const t = activeId && tabs.get(activeId);
  if (t && t.rest === 'idle' && t.restBy === 'auto' && restoreDone && document.visibilityState === 'visible') safe(() => wakeTab(t));
});

// Reopen a session whose 完了 tab was closed (PROGRESS 49): the backlog panel's / dashboard's 「会話を開く」. It comes back
// resting (no claude: the conversation is replayed from its transcript; 再開 / Enter / a send wakes it with --resume) and,
// opened by the user, it is not closed again by doneCloseTick. -> '' | the reason
async function openClosedSession(id) {
  if (typeof id !== 'string' || !id) return 'セッションがありません';
  if (tabs.has(id)) {
    activate(id);
    return '';
  }
  let hist = null;
  try {
    hist = ((await api.sessionsHistory()) || []).find((x) => x.id === id) || null;
  } catch {}
  if (tabs.has(id)) {
    activate(id);
    return '';
  }
  if (hist && hist.open) return 'ほかのウィンドウで開いています';
  const tab = createTab({
    id,
    mode: 'resume',
    rest: 'done',
    forBacklog: true,
    cwd: (hist && hist.cwd) || info.workDir,
    worktree: worktreeFromCwd(hist && hist.cwd),
    label: hist && hist.title ? shortLabel(hist.title, 40) : hist && hist.firstPrompt ? shortLabel(hist.firstPrompt) : undefined,
  });
  tab.wokeAt = Date.now();
  saveSessions();
  safe(() => window.Backlog?.render?.());
  return '';
}
async function takeOpenRequests() {
  let ids = [];
  try {
    ids = (await api.sessionTakeOpen?.()) || [];
  } catch {}
  for (const id of ids) await safe(() => openClosedSession(id));
}

// A routed session whose item ended with 作業完了 (status done) stops its claude after a short grace (setting
// 終わったセッション, default 2 min, 0 = never), once nothing of it runs (backlogReady: idle, no subagent / member,
// no typing; workActivity: no background command). Not for a failed item (作業中断 / no mark: kept for the user or the
// PMO), the manager's resident session or a tab opened by hand (not forBacklog), nor when it was talked to after the
// item ended. tests may shorten the grace: window.__schedTimes.doneStop (ms)
function doneStopMs() {
  const v = notifySettings().doneStopMin;
  const min = v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 2;
  return schedMs('doneStop', min * 60_000);
}
// The routed item a session (tab, or a saved tab { id, forBacklog }) finished with 作業完了, when that is all it has:
// its latest ended item is done (not failed), nothing of it is active or queued, and it was not used after the item
// ended (usedAt: talked to = lastPromptAt, opened / restarted by the user = wokeAt). null otherwise: still working, a
// failed item, a tab opened by hand (not forBacklog), the manager's resident session. PROGRESS 35 / 42.
// AT-101: the same goes for a routed item that is over without being done: dropped (取り下げ: by the PMO, the user or
// the app's auto-drop), or failed and routed again (a newer item for the same inbox request, r-<inboxId>-…, that is not
// this tab's). A failed item that was not routed again stays for the user / the PMO as before.
const usedAtOf = (tab) => Math.max(tab.wokeAt || 0, tab.lastPromptAt || 0, tab.lastTypedAt || 0, tab.usedAtSaved || 0);
const routedInboxId = (id) => {
  const m = /^r-(.+)-[0-9a-f]{1,8}$/.exec(String(id || ''));
  return m && m[1] !== 'x' ? m[1] : null;
};
// The backlog item a session works on, for waits.json / sessions.json / あなたの番 (AT-101): the active one, else the
// next queued for it, else the latest that ran in it (done / failed / dropped). Before, only the active one: a tab whose
// item went back to pending (or ended) was listed without its item.
function backlogIdOf(tabId) {
  const B = window.Backlog;
  if (!B) return null;
  const cur = B.activeOf(tabId) || B.pendingOf(tabId)[0];
  if (cur) return cur.id;
  let last = null;
  const at = (i) => i.doneAt || i.startedAt || i.createdAt || 0;
  for (const it of B.items()) if (it.tabId === tabId && (!last || at(it) >= at(last))) last = it;
  return last ? last.id : null;
}
// -> when the newest item routed again for the same request was made (0 = not routed again)
function rerouted(item, items) {
  const inbox = routedInboxId(item.id);
  if (!inbox) return 0;
  const pre = `r-${inbox}-`;
  let at = 0;
  for (const o of items) {
    if (o.id === item.id || !o.id.startsWith(pre) || o.tabId === item.tabId || o.status === 'dropped' || (o.createdAt || 0) < (item.createdAt || 0)) continue;
    at = Math.max(at, o.createdAt || 1);
  }
  return at;
}
function finishedItemOf(tab, usedAt = usedAtOf(tab)) {
  const B = window.Backlog;
  if (!B || !tab || !tab.forBacklog || info.role === 'manager') return null;
  if (B.activeOf(tab.id) || B.pendingOf(tab.id).length) return null;
  const items = B.items();
  let last = null;
  for (const it of items) if (it.tabId === tab.id && ['done', 'failed', 'dropped'].includes(it.status) && (!last || (it.doneAt || 0) >= (last.doneAt || 0))) last = it;
  if (!last) return null;
  // failed: over only once routed again; the PMO's nudges between the failure and that do not count as use
  const again = last.status === 'failed' ? rerouted(last, items) : 0;
  if (last.status === 'failed' && !again) return null;
  if (usedAt > Math.max(last.doneAt || 0, again) || (tab.lastTypedAt || 0) > (last.doneAt || 0)) return null; // typed by hand: kept
  return last;
}
// PROGRESS 49 (QA: タブも閉じる): once its claude is stopped (rest 'done'), the tab itself is closed, so neither its
// process tree nor its terminal / conversation view stays. Not while the user has it on the screen (shown in a pane of
// a visible, focused window), nor for the grace after that. The window's last tab closes too (AT-139: no new claude
// starts after it; the window shows the empty screen). Its conversation reopens from the backlog panel (終わったもの) or the dashboard's キュー
// (「会話を開く」): openClosedSession. tests: window.__schedTimes.assumeFocus = true (CDP leaves the window unfocused)
function shownToUser(tab) {
  if (tab.id !== activeId || !paneOfTab(tab.id) || document.visibilityState !== 'visible') return false;
  return document.hasFocus() || (window.__schedTimes || {}).assumeFocus === true;
}
function doneCloseTick(tab, now) {
  if (tab.closingDone || tab.wakeSend || !finishedItemOf(tab)) return;
  const grace = doneStopMs();
  if (!(grace > 0) || now - (tab.shownAt || 0) < grace) return;
  tab.closingDone = true;
  Promise.resolve(tab.stopTree).then(() => {
    tab.closingDone = false;
    if (!tabs.has(tab.id) || tab.rest !== 'done' || !finishedItemOf(tab) || shownToUser(tab)) return;
    console.log('[done-close]', tab.id, tab.stopped ? `stopped ${(tab.stopped.before || []).length}, killed after ${(tab.stopped.survivors || []).length}, left ${(tab.stopped.left || []).length}` : 'no claude');
    closeTab(tab.id);
    safe(() => window.Backlog?.render?.()); // its item now lists 「会話を開く」
  });
}
function doneStopTick(tab, now) {
  if (shownToUser(tab)) tab.shownAt = now;
  if (tab.rest === 'done') return doneCloseTick(tab, now);
  if (tab.exited || tab.rest) return;
  const last = finishedItemOf(tab);
  if (!last) return;
  const grace = doneStopMs();
  if (!(grace > 0) || now - (last.doneAt || 0) < grace || now - (tab.shownAt || 0) < grace) return;
  // restored by a restart before the grace ran out: the resumed claude shows its prompt but no event made it `started`
  const resumedIdle = !tab.started && tab.firstDataAt && now - tab.firstDataAt > 10_000 && !tab.choices && !tab.titleBusy &&
    now - (tab.lastUserInputAt || 0) >= BACKLOG_QUIET_MS && hasInputPrompt(physicalScreen(tab));
  if (!(backlogReady(tab, now) || resumedIdle) || workActivity(tab, last.startedAt || 0).length) return;
  if (kidsHold(tab, now)) return; // AT-200: a child of its claude still runs
  restTab(tab, 'done');
}

// ---- auto-close of unneeded tabs (AT-autoclose: after the 11-11 releases old tabs held the update restart for hours) --
// A tab of a project window closes by itself (its claude and the processes under it stop, the tab goes; nothing is kept
// or announced, QA 3) when nobody needs it:
//   (a) its routed item is over (done = 作業完了, dropped, or failed and routed again) and nothing happened in it for
//       10 min (QA 2) — also when the user opened / typed into it after the item ended (QA 1: left alone = may close),
//   (b) it has no backlog item at all (a tab opened by hand, a routed tab whose item is gone) and nothing happened in it
//       for 1 hour (QA 2), a draft in its input box included (QA 1).
// Never: the manager window (the PMO), a tab with an item active / queued, a failed item not routed again (kept for the
// user / the PMO), a tab waiting for the user's answer (a dialog, choices, 作業中断), a tab still working (answering,
// live subagents / members, background commands: tabWorks, stale agents left out by liveAgents), a tab whose claude
// still has a child process at work (kidsHold, AT-200; at most KIDS_WAIT_MAX_MS), the tab on the user's screen. While an update holds (src/main/autorestart.js) the clock is 10 min for both, so the restart does not wait for
// them. Activity = quietAtOf. tests: window.__schedTimes.autoCloseDone / autoCloseIdle / autoCloseHold (ms)
const AUTO_CLOSE_DONE_MS = 10 * 60_000;
const AUTO_CLOSE_IDLE_MS = 60 * 60_000;
const AUTO_CLOSE_HOLD_MS = 10 * 60_000;
const OUT_SETTLE_MS = 20_000; // output right after a (re)start (the resumed screen) is not activity
// ms of the last activity: the user (selecting it after the restore, on the screen, typing, a send, waking it) or its
// claude (a prompt, a reply, a turn end, terminal output after the start settled, a subagent's transcript line). A
// restored tab starts from its saved value (sessions.json quietAt), not from the restart.
// withOut false: without the terminal output (closing: the output of its claude being stopped is no activity)
function quietAtOf(tab, withOut = true) {
  const agents = safe(() => (P.summary(tab).subagents || []).reduce((m, a) => Math.max(m, Number(a.updatedAt) || 0), 0), 0) || 0;
  const out = withOut && tab.workOutAt && tab.firstDataAt && tab.workOutAt - tab.firstDataAt > OUT_SETTLE_MS ? tab.workOutAt : 0;
  const base = tab.resumed && tab.quietSaved ? tab.quietSaved : tab.createdAt || 0;
  // terminal input right after the start is xterm answering the console's queries (cursor position), not the user
  const typed = (v) => (v && !(tab.firstDataAt && v >= tab.firstDataAt && v - tab.firstDataAt < OUT_SETTLE_MS) ? v : 0);
  return Math.max(base, tab.userSelectedAt || 0, tab.shownAt || 0, typed(tab.lastUserInputAt), tab.conv?.lastInputAt || 0,
    typed(tab.lastTypedAt), tab.wokeAt || 0, tab.restWakeAt || 0, tab.lastPromptAt || 0, tab.lastAssistantAt || 0,
    tab.lastTurnEndAt || 0, out, agents);
}
// The time rule alone, also for a saved tab at the restore ({ id, forBacklog }): -> 'done' | 'idle' | null
function autoCloseDue(tab, quietAt, now) {
  const B = window.Backlog;
  if (!B || B.loaded?.() === false || info.role === 'manager' || !(quietAt > 0)) return null; // items not known yet
  if (B.activeOf(tab.id) || B.pendingOf(tab.id).length) return null;
  const items = B.items();
  let last = null;
  for (const it of items) if (it.tabId === tab.id && (!last || (it.doneAt || it.startedAt || 0) >= (last.doneAt || last.startedAt || 0))) last = it;
  let kind = 'idle';
  let since = quietAt;
  if (last) {
    if (last.status === 'failed' && !rerouted(last, items)) return null; // 作業中断: kept for the user / the PMO
    if (!['done', 'dropped', 'failed'].includes(last.status)) return null;
    kind = 'done';
    since = Math.max(quietAt, last.doneAt || 0);
  }
  const hold = updateHolds() ? schedMs('autoCloseHold', AUTO_CLOSE_HOLD_MS) : Infinity;
  const ms = Math.min(hold, kind === 'done' ? schedMs('autoCloseDone', AUTO_CLOSE_DONE_MS) : schedMs('autoCloseIdle', AUTO_CLOSE_IDLE_MS));
  return now - since >= ms ? kind : null;
}
// Waits for the user's answer: a dialog / choices on its screen, or its last reply stops with 作業中断 and nothing came
// after (also saved: a restored tab has no marker from the replay, askingSaved until it is talked to again)
function waitsForAnswer(tab) {
  if (!tab.exited && (tab.status === 'asking' || tab.choices || tab.prompt)) return true;
  if (tab.askingSaved && !tab.lastPromptAt) return true;
  return safe(() => workMarker(tab, 0), null)?.kind === 'abort' && (tab.lastPromptAt || 0) <= (tab.lastAssistantAt || 0);
}
// -> 'done' | 'idle' when the open tab may close now, else null
function autoCloseWhy(tab, now) {
  if (!tabs.has(tab.id) || tab.handedOff || tab.wakeSend || tab.closingDone || shownToUser(tab)) return null;
  if (waitsForAnswer(tab)) return null;
  if (!tab.exited) {
    if (!tab.firstDataAt || now - tab.firstDataAt < OUT_SETTLE_MS || tab.status === 'starting') return null; // still starting
    if (safe(() => tabWorks(tab, now), true)) return null;
    if (safe(() => restartBusy(tab).length, 1)) return null;
  }
  const kind = autoCloseDue(tab, quietAtOf(tab), now);
  if (kind && !tab.exited && safe(() => kidsHold(tab, now), '')) return null; // AT-200: a child of its claude still runs
  return kind;
}
function autoCloseTick(tab, now) {
  if (shownToUser(tab)) tab.shownAt = now;
  if (tab.closingAuto) return;
  // keep the saved clock near the real one (a restart goes on from it): at most every 5 min a tab, not while it works
  if (!tab.exited && quietAtOf(tab) - (tab.quietSavedAt || 0) > 5 * 60_000 && !safe(() => tabWorks(tab, now), true)) saveSessions();
  const kind = autoCloseWhy(tab, now);
  if (!kind) return;
  tab.closingAuto = true;
  if (!tab.exited) restTab(tab, kind === 'done' ? 'done' : 'idle', { by: 'auto' }); // stops its claude and the tree under it
  Promise.resolve(tab.stopTree).catch(() => null).then(() => {
    tab.closingAuto = false;
    if (!tabs.has(tab.id) || !tab.exited || tab.wakeSend || shownToUser(tab) || !autoCloseDue(tab, quietAtOf(tab, false), Date.now())) return;
    console.log('[auto-close]', tab.id, kind);
    closeTab(tab.id);
    safe(() => window.Backlog?.render?.());
  });
}

function backlogTick(tab, now) {
  const B = window.Backlog;
  if (!B) return;
  if (backlogReady(tab, now)) tab.readySince ||= now;
  else tab.readySince = 0;
  const stable = !!tab.readySince && now - tab.readySince >= BACKLOG_STABLE_MS;
  const active = B.activeOf(tab.id);
  if (active) {
    if (active.resume) return backlogResumeTick(tab, active, now, stable); // restarted at a turn gap (update)
    if (tab.exited) return finishByMarker(tab, active, 'claude が終了しました');
    if ((tab.apiErrorAt || 0) > active.startedAt) return backlogApiError(tab, active, now);
    const prompted = (tab.lastPromptAt || 0) >= active.startedAt;
    if (!prompted && now - active.startedAt > BACKLOG_SEND_TIMEOUT_MS) {
      B.finish(active.id, false, '送信を確認できませんでした');
      return;
    }
    const turnDone = prompted && (tab.lastTurnEndAt || 0) > active.startedAt && stable;
    if (tab.forBacklog) {
      if (prompted) routedProgress(tab, active, now, turnDone);
      return;
    }
    if (turnDone) {
      if (B.autoOff?.(tab.id)?.why === 'api') B.setAutoOff(tab.id, null); // sent again and answered: the count starts over
      B.finish(active.id, true, '');
    }
    return;
  }
  // an item failed as stalled whose session later ended a reply with 作業完了 (e.g. after the PMO nudged it)
  const w = tab.sched;
  if (w && w.failedItem && !tab.exited) {
    const it = B.items().find((i) => i.id === w.failedItem);
    const m = stable ? workMarker(tab, w.failedAt) : null;
    if (!it || it.status !== 'failed') w.failedItem = null;
    else if (m && m.kind === 'done') {
      B.finish(it.id, true, '止まった後に再開し、完了の印を確認しました');
      w.failedItem = null;
    }
  }
  const off = backlogAutoOff(tab, stable);
  if (!stable || !B.auto(tab.id) || updateHolds()) return; // update reserved: the next item starts after the restart
  if (off && window.AutoSend && !window.AutoSend.canSend(off, now)) return; // an API error: waits for the retry time
  const item = B.next(tab.id);
  if (item) backlogSend(tab, item);
}

// An API error during a sent item (src/renderer/autosend.js). The PMO's prompt (it only says "check the inbox") goes
// back to the queue and is sent again 1, 2, 5, 10 min later; the 5th error in a row stops the auto send, the prompt stays
// queued and main puts 「PMO への自動送信が止まっています」 with 再開 on あなたの番. Other tabs stop at once (their item
// may have done half of its work) and switch on again when a later turn is answered (backlogAutoOff).
function backlogApiError(tab, active, now) {
  const B = window.Backlog;
  const AS = window.AutoSend;
  const retry = info.role === 'manager';
  const rec = AS ? AS.apiError(B.autoOff?.(tab.id), now, tab.apiErrorText || '', retry) : { why: 'api', n: 1, at: now, stopped: true };
  console.log('[backlog] api error', tab.id, active.id, `n=${rec.n}`, rec.stopped ? 'stopped' : `retry at ${new Date(rec.retryAt).toISOString()}`);
  if (!retry) {
    B.finish(active.id, false, 'API エラー（自動送信を止めました）');
    B.setAuto(tab.id, false, rec);
    return;
  }
  B.requeue(active.id, rec.stopped ? `${AS.whyText(rec, now)}。自動送信を止めました（要対応の「再開」で送ります）` : AS.whyText(rec, now));
  if (rec.stopped) B.setAuto(tab.id, false, rec);
  else B.setAutoOff(tab.id, rec);
}
// The tab's autoOff record (why its auto send waits / stopped), after two repairs: a tab the old code switched off for
// an API error (auto false, no record) gets one (the PMO: sent again now), and an API record is cleared once a later turn
// of the tab was answered without an API error (it is alive: the user's message went through). -> record | null
function backlogAutoOff(tab, stable) {
  const B = window.Backlog;
  const AS = window.AutoSend;
  if (!AS || !B.autoOff) return null;
  let rec = B.autoOff(tab.id);
  if (!rec) {
    const old = AS.legacy(B.state(), tab.id, info.role === 'manager');
    if (!old) return null;
    console.log('[backlog] auto send was stopped by an API error (old record)', tab.id, old.stopped ? 'stays stopped' : 'sent again');
    if (old.stopped) B.setAutoOff(tab.id, old);
    else {
      B.setAuto(tab.id, true);
      B.setAutoOff(tab.id, old);
    }
    rec = old;
  }
  if (rec.why === 'api' && stable && AS.turnOk(rec, tab)) {
    console.log('[backlog] auto send on again: a turn was answered', tab.id);
    B.setAuto(tab.id, true);
    return null;
  }
  return rec;
}

// Items routed here by the manager agent have no session yet (tabId null): each gets a new session. Which may
// start now is decided by main over all windows (sched:plan, src/main/sched.js): the overall limit (setting
// 同時に動かす作業, default 3), the resources (free memory, CPU, main's event loop lag), the files they touch
// (kind / touches of the item) and their prerequisites (after). The queue order is kept; a later item starts first
// only when the head cannot (the reasons are shown in the バックログ panel and on the dashboard).
let schedAsking = false;
let schedAskedAt = 0;
const overtakeNotes = new Map(); // item id -> note set when it starts (it overtook an item that could not start)
function schedSettings() {
  const s = notifySettings() || {};
  const n = (v, d, lo, hi) => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  return {
    limit: Math.round(n(s.parallelMax, 3, 1, 10)),
    thresholds: { minFreeMB: Math.round(n(s.minFreeGB, 1, 0, 256) * 1024), maxCpuPct: n(s.maxCpuPct, 80, 0, 100), maxLagMs: 200 },
  };
}
// The setting goes to main with every sched:plan, but a window asks only while it has waiting items. Told also at load
// and when it changes (sched:plan with nothing waiting), so main keeps it (manager-settings.json) for the queues of
// folders without a window, also after a restart.
let schedToldSig = '';
function schedTellSettings() {
  if (!api.schedPlan) return;
  const v = schedSettings();
  const sig = JSON.stringify(v);
  if (sig === schedToldSig) return;
  schedToldSig = sig;
  Promise.resolve(safe(() => api.schedPlan({ waiting: [], limit: v.limit, thresholds: v.thresholds }), null)).catch(() => (schedToldSig = ''));
}
function startRouted(item) {
  const B = window.Backlog;
  // AT-101: never a 2nd session for an item that already has one (pending / active with its tab open)
  if (item.status !== 'pending' || (item.tabId && tabs.has(item.tabId))) return;
  // Setting "振り分けたセッション" (⚙ 設定, default on): Agent Teams + the delegation prompt, so the
  // session can split parallel work over subagents / teammates. Off = started like a plain new tab.
  // The manager window's own (resident) session is never one of these.
  const delegate = notifySettings().routedTeam !== false;
  // AT-6: the item's own model / effort (route / create), else the default
  const tab = createTab({ label: shortLabel(item.text, 40), background: true, forBacklog: true, team: delegate, delegate, model: item.model || null, effort: item.effort || null });
  item.tabId = tab.id;
  B.setAuto(tab.id, true); // also saves the reassignment
}
// The user is writing to this session (the PMO's automatic handoff waits, PROGRESS 45): typed in the last few seconds
// (an IME composition fires input events too), or a draft in its input box touched in the last 10 minutes. An older
// draft does not hold the handoff forever: it moves to the new session's input box (Handoff hook carryDraft).
const PMO_DRAFT_HOLD_MS = 10 * 60_000;
function pmoTyping(tab, now = Date.now()) {
  if (now - (tab.lastUserInputAt || 0) < BACKLOG_QUIET_MS) return true;
  const lastIn = tab.conv?.lastInputAt || 0;
  if (now - lastIn < BACKLOG_QUIET_MS) return true;
  const empty = safe(() => tab.conv?.composer?.isEmpty?.(), true);
  return empty === false && now - lastIn < PMO_DRAFT_HOLD_MS;
}
// The manager window's resident session (the PMO): the first one not ended and not handed off.
const residentTab = () => [...tabs.values()].find((t) => !t.exited && !t.handedOff) || null;
function backlogAssignNew(now = Date.now()) {
  const B = window.Backlog;
  if (!B) return;
  const waiting = B.items().filter((i) => i.status === 'pending' && !i.tabId);
  // The manager agent keeps ONE resident session (its context must carry over): its requests go to
  // the first session of the manager window instead of a new one each time.
  if (info.role === 'manager') {
    // A handed-off session (handoff.js) is no longer the resident one, even in the seconds before it closes. Its
    // pending items moved to the new session when the memo went over; an item that still points at it (or at a closed
    // / ended session) is taken over too, so a request that arrives during a handoff is never lost (PROGRESS 45).
    const resident = residentTab();
    if (!resident) return;
    const live = (id) => {
      const t = tabs.get(id);
      return !!t && !t.exited && !t.handedOff;
    };
    const take = B.items().filter((i) => i.status === 'pending' && (!i.tabId || (i.tabId !== resident.id && !live(i.tabId))));
    if (!take.length) return;
    for (const it of take) it.tabId = resident.id;
    // also saves the reassignment. A tab whose auto send waits / stopped (autosend.js) keeps it: 再開 or an answered
    // turn switches it on (before, a new item switched it on, but the coalesced prompt of the PMO is never new)
    const off = B.autoOff?.(resident.id);
    if (off) B.setAutoOff(resident.id, off);
    else B.setAuto(resident.id, true);
    return;
  }
  if (!waiting.length) {
    if (Object.keys(B.waitReasons()).length) B.setWaitReasons({});
    return;
  }
  if (updateHolds()) {
    // update reserved (src/main/autorestart.js): no new session until the restart
    const why = { code: 'update', text: '更新待ち（再起動の後に始めます）' };
    B.setWaitReasons(Object.fromEntries(waiting.map((i) => [i.id, why])));
    return;
  }
  if (!api.schedPlan) {
    // no main-side scheduler (older main): one routed session at a time in this window
    for (const t of tabs.values()) if (t.forBacklog && !t.exited && (B.activeOf(t.id) || B.pendingOf(t.id).length)) return;
    return startRouted(waiting[0]);
  }
  if (schedAsking || now - schedAskedAt < SCHED_PLAN_MS) return;
  schedAsking = true;
  schedAskedAt = now;
  const { limit, thresholds } = schedSettings();
  const ask = waiting.map((i) => ({ id: i.id, kind: i.kind || null, touches: Array.isArray(i.touches) ? i.touches : [], after: Array.isArray(i.after) ? i.after : [] }));
  Promise.resolve(safe(() => api.schedPlan({ waiting: ask, limit, thresholds }), null))
    .then((r) => {
      if (!r || !Array.isArray(r.start)) return;
      const reasons = r.reasons && typeof r.reasons === 'object' ? r.reasons : {};
      const order = waiting.map((i) => i.id);
      for (const id of r.start) {
        const item = B.items().find((i) => i.id === id);
        if (!item || item.status !== 'pending' || item.tabId) continue;
        // started ahead of earlier items that could not start: say why on the item
        const ahead = order.slice(0, order.indexOf(id)).filter((x) => reasons[x]);
        if (ahead.length) {
          const first = B.items().find((i) => i.id === ahead[0]);
          const why = reasons[ahead[0]];
          overtakeNotes.set(id, `先に開始: 前の「${shortLabel(first ? first.text : ahead[0], 24)}」が始められないため（${why.text || why.code}）`);
        }
        startRouted(item);
      }
      const left = {};
      for (const [id, why] of Object.entries(reasons)) if (!r.start.includes(id)) left[id] = why;
      B.setWaitReasons(left);
    })
    .catch((err) => console.warn('[sched] plan failed', err))
    .finally(() => (schedAsking = false));
}

// AT-149 QA 1: the routed (r-…) items still pending on this saved tab while none is active on it -> their ids ([] when
// the tab has active work, or the backlog is not loaded)
function staleRoutedPending(tabId) {
  const B = window.Backlog;
  if (!B || B.loaded?.() === false || B.activeOf(tabId)) return [];
  return B.pendingOf(tabId).filter((i) => String(i.id).startsWith('r-')).map((i) => i.id);
}
// Routed items whose session is gone (a closed tab not restored after a restart): pending ones go back to the
// queue (a new session takes them), an active one ends by its marker. Runs once the restore has settled.
function backlogSweep() {
  const B = window.Backlog;
  if (!B || !restoreDone || info.role === 'manager' || performance.now() < 20_000) return;
  for (const it of B.items()) {
    if (!it.id.startsWith('r-') || !it.tabId || tabs.has(it.tabId)) continue;
    if (it.status === 'pending') B.unassign(it.id);
    else if (it.status === 'active') B.finish(it.id, false, 'セッションが見つかりません（完了の印なし）');
  }
}

// Synchronous contract kept: '' = started, else the reason. The item is marked active at once; the text is
// sent after the pre-answered QA lookup (qa:forItem, ≤ 1.5 s, then without it), with the QA block appended.
function backlogSend(tab, item) {
  const why = convSendBlocked(tab);
  if (why) return why;
  window.Backlog.start(item.id);
  const ov = overtakeNotes.get(item.id);
  if (ov) {
    overtakeNotes.delete(item.id);
    window.Backlog.note(item.id, ov);
  }
  tab.readySince = 0;
  tab.sched = null;
  const lookup = api.qaForItem ? Promise.resolve(safe(() => api.qaForItem({ itemId: item.id, use: true }), null)) : Promise.resolve(null);
  const timeout = new Promise((r) => setTimeout(() => r(null), 1500));
  Promise.race([lookup.catch(() => null), timeout]).then((entry) => {
    if (tab.exited || !tabs.has(tab.id)) return;
    const act = window.Backlog.activeOf(tab.id);
    if (!act || act.id !== item.id) return; // finished / removed meanwhile
    // a session started without the delegation prompt does not know the marker: ask for it in the text
    const mark = tab.forBacklog && !tab.delegate ? MARK_PROMPT : '';
    // U7: a session with the delegation prompt may propose the next work (docs/prompts/routed-session.md); its from field
    // names this item
    const own = tab.delegate ? `\n\n（アプリから）この作業の id: ${item.id}` : '';
    sendText(tab, item.text + (safe(() => qaBlock(entry), '') || '') + mark + own, 'auto');
  });
  return '';
}

// QaEntry -> "\n\n## 事前の確認…" Markdown block appended to a backlog item's prompt ('' when none).
function qaBlock(entry) {
  if (!entry || !Array.isArray(entry.rows) || !entry.rows.length) return '';
  const cell = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  const answered = entry.status === 'answered';
  const head = answered
    ? '## 事前の確認（QA、回答済み。空欄は仮説どおり）'
    : '## 事前の確認（QA、まだ回答がありません。未回答の項目は仮説どおりで進めてよい）';
  const lines = ['', '', head, '| # | 論点 | 仮説 | 回答 |', '|---|---|---|---|'];
  entry.rows.forEach((r, i) => {
    const topic = cell(r.topic) + (r.question ? `（${cell(r.question)}）` : '');
    lines.push(`| ${i + 1} | ${topic} | ${cell(r.hypothesis)} | ${cell(r.answer)} |`);
  });
  if (answered && entry.rows.some((r) => !cell(r.answer))) lines.push('', '空欄の項目は仮説どおりで進めてください。');
  return lines.join('\n');
}

setInterval(() => {
  updatePowerBusy();
  safe(() => window.Handoff?.tick?.(Date.now())); // context handoff: trigger check / memo delivery
  if (!window.Backlog) return;
  if (appUpdate.state === 'restarting') return; // quitting for an update: nothing starts, ends or resumes in this process
  const now = Date.now();
  safe(schedTellSettings);
  safe(() => backlogAssignNew(now));
  safe(backlogSweep);
  for (const t of tabs.values()) safe(() => backlogTick(t, now));
  for (const t of tabs.values()) safe(() => doneStopTick(t, now));
  for (const t of tabs.values()) safe(() => idleRestTick(t, now));
  if (restoreDone) for (const t of [...tabs.values()]) safe(() => autoCloseTick(t, now)); // AT-autoclose
  for (const t of tabs.values()) safe(() => wakeSendTick(t, now));
}, 1000);

// Tell main whether a session of this window is working (running, busy title, or a backlog item in
// progress). main keeps the PC awake meanwhile if the setting "実行中はスリープしない" (default on)
// allows it, and the automatic restart after a release waits until no window is working.
let powerBusySent = null; // last { busy, keepAwake, lid, ... } key sent
// A session works (keep-awake, docs/keep-awake.md): answering, a queued item in progress, an auto answer / handoff under way,
// subagents or team members still running, or background commands (Bash run_in_background, Monitor) not yet ended.
// Waiting for the user (asking / choices) alone does not count. Leftovers after 作業完了 drop out like liveAgents' stale ones.
function tabWorks(t, now = Date.now()) {
  if (t.exited) return false;
  if (t.status === 'running' || t.titleBusy || t.autoYesAns) return true;
  if (safe(() => window.Backlog?.activeOf?.(t.id), null)) return true;
  if (safe(() => window.Handoff?.holds?.(t), false)) return true;
  const s = safe(() => P.summary(t), null);
  if (!s) return false;
  const la = safe(() => liveAgents(t, s, now), { subs: [], members: [] });
  if (la.subs.length || la.members.length) return true;
  const done = safe(() => doneMarkAt(t), 0) || 0;
  const ms = schedMs('staleAgent', STALE_AGENT_MS);
  const at = (b) => (typeof b.startedAt === 'number' ? b.startedAt : Date.parse(b.startedAt)) || 0;
  return (s.bg || []).some((b) => b && !(done && at(b) <= done && now - at(b) >= ms));
}
function updatePowerBusy() {
  const keepAwake = notifySettings().preventSleep !== false;
  const lid = notifySettings().lidNoSleep !== false;
  // スリープを避ける方法 (52c): 'display' | 'system' | unset (main picks the platform's default)
  const mode = ['display', 'system'].includes(notifySettings().sleepMode) ? notifySettings().sleepMode : null;
  const now = Date.now();
  const busy = [...tabs.values()].some((t) => safe(() => tabWorks(t, now), false));
  // update hold: every session between turns (a restart now cuts nothing off; running items continue after it)
  const gap = [...tabs.values()].every((t) => safe(() => atTurnGap(t), false));
  const n = Number(notifySettings().updateHoldMin);
  const holdMin = Number.isFinite(n) && n > 0 ? n : 30;
  const key = `${busy}|${keepAwake}|${lid}|${mode}|${gap}|${holdMin}`;
  if (key === powerBusySent) return;
  powerBusySent = key;
  safe(() => api.powerBusy?.({ busy, keepAwake, lid, mode, gap, holdMin }));
}

// Between turns: not answering, no dialog, no running subagent / team member, no handoff, and a backlog item it works on
// already got its prompt (else the restart would lose the prompt). Exited tabs count as between turns.
function atTurnGap(tab) {
  if (tab.exited) return true;
  if (tab.status === 'running' || tab.status === 'asking' || tab.titleBusy || tab.choices || tab.autoYesAns) return false;
  if (safe(() => window.Handoff?.holds?.(tab), false)) return false;
  const la = liveAgents(tab);
  if (la.subs.length || la.members.length) return false;
  const act = safe(() => window.Backlog?.activeOf?.(tab.id), null);
  if (act && (act.resume || (tab.lastPromptAt || 0) < (act.startedAt || 0))) return false;
  return true;
}

// OSC 777 (notify;title;body) and OSC 9 (body) from the terminal. Claude Code emits them because main
// passes preferredNotifChannel via --settings: "Claude needs your permission" (dialogs, ~6 s late:
// a backup for the screen parser), "Claude is waiting for your input" (60 s idle: ignored).
// Other CLIs' notifications count as 'done' with their own text.
function onTerminalNotification(tab, body) {
  const text = String(body || '').trim();
  if (!text) return;
  if (/waiting for your input/i.test(text)) return;
  if (/needs your permission|needs your attention/i.test(text)) {
    if (autoYes) {
      // Auto-yes may have missed the dialog: look again, and only notify if it is still waiting.
      scheduleScan(tab);
      setTimeout(() => tab.status === 'asking' && raise(tab, 'input', tab.choices?.question || text), 1500);
      return;
    }
    raise(tab, 'input', tab.choices?.question || text);
    return;
  }
  raise(tab, 'done', text);
}

// ---- remote ---------------------------------------------------------------
let remoteTimer = 0;
function scheduleRemote() {
  if (remoteTimer) return;
  remoteTimer = setTimeout(() => {
    remoteTimer = 0;
    sendRemote();
  }, 300);
}

// UX8 (docs/ux-journey.md §5.5): the state of every tab was built and sent every 3 s (and 300 ms after each event)
// even when nothing changed, the screen read each time. The screen lines are read again only when the tab's screen
// changed (output parsed, size, status); a list equal to the last one sent (but for updatedAt) is sent again only
// after REMOTE_BEAT_MS (main keeps the last one per window: widget.js / remote.js / stuck.js).
const REMOTE_BEAT_MS = 15000;
let remoteSentSig = '';
let remoteSentAt = 0;
function remoteScreenOf(tab) {
  const key = `${tab.outSeq || 0}|${tab.term.cols}x${tab.term.rows}|${tab.status}|${tab.exited ? 1 : 0}|${tab.rest || ''}|${tab.opened ? 1 : 0}`;
  if (tab.remoteScreenKey !== key || !tab.remoteScreen) {
    tab.remoteScreen = remoteScreen(tab);
    tab.remoteScreenKey = key;
  }
  return tab.remoteScreen;
}
function remoteScreen(tab) {
  // the whole screen first, blank bottom rows dropped, then the last 40: on a fresh or full-screen screen (login) the
  // content sits at the top of a tall terminal and a plain "last 40 rows" lost its first lines (the question)
  const lines = readScreen(tab).map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-40);
}

// Subagents and team members of a tab with ids, times and tokens, for the dashboard's エージェント tab
// (roadmap 13, docs/plan-agents-view.md). Member status stays panel.js's (Panel.summary: idle / done rules);
// ids, tokens and times come from the transcript snapshots (tab.subSnaps). In-process teammates are
// subagents named a<name>-<hex> (same rule as panel.js teammateName).
const TEAMMATE_ID = /^a(.+)-[0-9a-f]{8,}$/;
const AGENTS_MAX = 30;
function agentsOf(tab, s) {
  const snaps = [...(tab.subSnaps?.values() || [])];
  const members = s.team?.members || [];
  const names = new Set(members.map((m) => m.name));
  const mate = (a) => TEAMMATE_ID.exec(a.agentId || '')?.[1] || '';
  const tool = (t) => (t ? { name: String(t.name || ''), arg: String(t.arg ?? '').slice(0, 80) } : null);
  const live = (st) => (st === 'running' || st === 'starting' ? 0 : 1);
  const subagents = snaps
    .filter((a) => !names.has(mate(a)))
    .sort((a, b) => live(a.status) - live(b.status) || (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, AGENTS_MAX)
    .map((a) => ({
      agentId: a.agentId,
      agentType: a.agentType || '',
      description: a.description || '',
      status: a.status || 'running',
      lastTool: tool(a.lastTool),
      tokens: a.tokens || 0,
      startedAt: a.startedAt || 0,
      updatedAt: a.updatedAt || 0,
    }));
  const team = s.team
    ? {
        name: s.team.name,
        removed: !!s.team.removed,
        members: members.map((m) => {
          const a = snaps.find((x) => mate(x) === m.name);
          return {
            name: m.name,
            agentId: a ? a.agentId : null,
            agentType: m.agentType || '',
            color: m.color || '',
            status: m.status,
            summary: m.summary || '',
            lastTool: tool(m.lastTool),
            tokens: a ? a.tokens || 0 : 0,
            updatedAt: a ? a.updatedAt || 0 : 0,
          };
        }),
      }
    : null;
  if (!subagents.length && !team) return null;
  return { subagents, team };
}

function tabState(tab) {
  const s = P.summary(tab);
  return {
    id: tab.id,
    label: tab.label,
    status: tab.status,
    rest: tab.rest || null, // 'done' = 完了 (claude stopped after 作業完了, PROGRESS 35) | 'idle' = 休止中 (31)
    active: tab.id === activeId,
    cwd: tab.cwd,
    worktree: tab.worktree,
    model: s.model ?? '',
    contextPct: s.contextPct ?? null,
    costUsd: s.costUsd ?? null,
    todos: s.todos || [],
    subagents: s.subagents || [],
    team: s.team || null,
    bg: s.bg || [], // background commands still running [{ id, command, outFile, startedAt }] (main's waits.js)
    doneAt: safe(() => doneMarkAt(tab), 0) || 0, // ms it ended with 作業完了 (waits.js staleAgent), 0 = not
    // the stale rule's clock (stale-agents.js): main's waits.js leaves out the same agents as liveAgents
    agentClock: safe(() => { const c = agentClockOf(tab); return { base: c.base, staleMs: c.staleMs, quiet: c.quiet }; }, null),
    agents: safe(() => agentsOf(tab, s), null), // the dashboard's エージェント tab (roadmap 13)
    screen: safe(() => remoteScreenOf(tab), []),
    choices: tab.choices,
    prompt: tab.prompt || null, // the dialog for the PMO (sessions.json / answer action, roadmap 27)
    backlogId: safe(() => backlogIdOf(tab.id), null) || null, // waits.json / sessions.json (AT-101: not only while active)
    memMb: tab.rest ? 0 : tab.exited ? null : tab.memMb ?? null, // session memory (pty:mem), for the dashboard; resting = 0 (31)
    memHeavy: memHeavy(tab), // over the user's mark (setting lives in this renderer's localStorage)
    unread: tab.unread || null, // { kind: 'input'|'done'|'error', at, text } (phone badge; remote.js must pass it through)
    updatedAt: Date.now(),
  };
}

function sendRemote() {
  const list = [...tabs.values()].map(tabState);
  // the tab's own updatedAt (the time of building) is left out; the agents' updatedAt stay in
  const sig = JSON.stringify(list.map((t) => ({ ...t, updatedAt: 0 })));
  const now = Date.now();
  if (sig === remoteSentSig && now - remoteSentAt < REMOTE_BEAT_MS) return;
  remoteSentSig = sig;
  remoteSentAt = now;
  safe(() => api.remoteState({ tabs: list }));
}

const KEY_MAP = {
  enter: '\r',
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  'ctrl-c': '\x03',
};

// The user's answer from the dashboard's 確認待ち list (dashboard:answer; main checked it against the last state we
// sent). Pressed only if the very same dialog (promptKey) is on the screen right now; the result goes back to main.
//   mode 'choice' { n }: the digit. 'text' { n, text }: the "Type something" digit, then the text + Enter.
//   'multi' { toggle: n[], other, text, next }: the digits of the boxes to flip (and the free text), then Tab to the
//   next question / the review screen, whose "Submit answers" scan() presses (tab.submitAnswersUntil).
const USER_STEP_MS = 150;
function userAnswer(tab, a) {
  const reply = (r) => safe(() => api.remoteAnswerResult?.({ reqId: a.reqId, ...r }));
  const cur = tab && tab.prompt;
  if (!tab || tab.exited) return reply({ error: 'セッションは終了しています', changed: true });
  if (!cur || cur.key !== a.promptKey || !tab.choices) return reply({ error: '質問が変わりました', changed: true });
  const id = tab.id;
  const steps = [];
  const press = (data) => steps.push(() => api.ptyInput({ id, data }));
  const opt = (n) => (cur.options || []).find((o) => o.n === n);
  let note = '';
  if (a.mode === 'choice' && /^[1-9]$/.test(String(a.n))) {
    press(String(a.n));
    note = `${a.n}. ${opt(a.n)?.label || ''}`;
  } else if (a.mode === 'text' && /^[1-9]$/.test(String(a.n)) && typeof a.text === 'string' && a.text) {
    press(String(a.n));
    steps.push(() => tab.term.paste(a.text));
    steps.push(null); // let the paste settle
    press(KEY_MAP.enter);
    note = `自由記入「${a.text.slice(0, 60)}」`;
  } else if (a.mode === 'multi' && Array.isArray(a.toggle)) {
    for (const n of a.toggle) if (/^[1-9]$/.test(String(n))) press(String(n));
    if (/^[1-9]$/.test(String(a.other)) && typeof a.text === 'string' && a.text) {
      press(String(a.other));
      steps.push(() => tab.term.paste(a.text));
      steps.push(null);
    }
    const k = Math.min(10, Math.max(1, Number(a.next) || 1));
    for (let i = 0; i < k; i++) press(KEY_MAP.tab);
    if (tab.choices.submitLabel !== 'Next') tab.submitAnswersUntil = Date.now() + steps.length * USER_STEP_MS + 5000;
    const picked = tab.choices.options.filter((o) => !o.other && !!o.checked !== a.toggle.includes(o.n));
    note = `${picked.map((o) => o.label).join('、') || '（選択なし）'}${a.text ? ` ＋「${a.text.slice(0, 40)}」` : ''}`;
  } else {
    return reply({ error: '答え方が分かりません' });
  }
  tab.pasteUntil = Date.now() + steps.length * USER_STEP_MS + 1000; // our own keys are not "the user typed in the terminal"
  steps.forEach((f, i) => setTimeout(() => tabs.has(id) && !tab.exited && f && f(), i * USER_STEP_MS));
  setTimeout(() => scheduleScan(tab), steps.length * USER_STEP_MS + 50);
  safe(() => P.addLocal(tab, { name: 'ダッシュボード', arg: `「${(cur.question || '').slice(0, 60)}」に答えました: ${note}`.slice(0, 220) }));
  if (tab.id === activeId) renderPanelSoon();
  reply({ ok: true });
}

function handleRemoteAction(action) {
  if (action && action.type === 'userAnswer') return userAnswer(tabs.get(action.tabId), action);
  const tab = action && tabs.get(action.tabId);
  if (!tab) return;
  if (action.type === 'restart') {
    // from the dashboard (dashboard:restart): never while busy, no dialog in a window the user is not looking at
    const why = restartTab(tab, { noConfirm: true });
    // the dashboard checks the status first; this only happens when it changed in between
    if (why) safe(() => raise(tab, 'error', `再起動しませんでした — ${why}`));
    return;
  }
  if (action.type === 'rest') {
    // the dashboard's 休止 (dashboard:rest, 31): refused while it works (the reason goes to the tab)
    const why = restByHand(tab);
    if (why) safe(() => raise(tab, 'error', why));
    return;
  }
  // a text for a resting tab (dashboard / phone): wake it and send once it is up (31 / 44)
  if (tab.rest && action.type === 'text') {
    const why = wakeAndSend(tab, action.value ?? '');
    if (why) safe(() => raise(tab, 'error', `送れませんでした — ${why}`));
    return;
  }
  if (tab.exited) return;
  const { type, value } = action;
  if (type === 'text') {
    sendText(tab, value ?? '');
  } else if (type === 'choice') {
    const d = String(value);
    if (/^\d{1,2}$/.test(d)) api.ptyInput({ id: tab.id, data: d });
  } else if (type === 'answer') {
    // the PMO's answer action (main checked it against the last state we sent): press only if the very same
    // dialog is still on the screen right now
    const cur = tab.prompt;
    const d = String(value);
    if (!cur || cur.key !== action.promptKey || !tab.choices || !/^[1-9]$/.test(d)) {
      safe(() => P.addLocal(tab, { name: 'PMO', arg: `押しませんでした（確認が変わっていました）: ${String(action.reason || '').slice(0, 160)}` }));
    } else {
      api.ptyInput({ id: tab.id, data: d });
      safe(() => P.addLocal(tab, { name: 'PMO', arg: `「${(cur.question || '').slice(0, 60)}」に ${d} で答えました: ${String(action.reason || '').slice(0, 140)}` }));
      if (tab.id === activeId) renderPanelSoon();
    }
  } else if (type === 'key') {
    const seq = KEY_MAP[value];
    if (seq) api.ptyInput({ id: tab.id, data: seq });
  } else if (type === 'nudge') {
    // the manager agent nudges a session that waits (waits:state): only when its input box takes text right now.
    // Unlike backlogReady, running subagents / team members do not hold it back (that is often what it waits for).
    const text = String(action.text ?? '').trim();
    const ready = text && tab.started && tab.status === 'idle' && !tab.rest && !tab.choices && tab.peek !== 'auto' && safe(() => hasInputPrompt(physicalScreen(tab)), false);
    if (!ready) {
      console.warn('nudge not sent: the session does not take input now', tab.id, tab.status);
      return;
    }
    sendText(tab, text, 'auto');
    safe(() => P.addLocal(tab, { name: 'PMO', arg: `声をかけました: ${text.slice(0, 160)}` }));
    if (tab.id === activeId) renderPanelSoon();
    return; // sendText scans itself
  }
  scheduleScan(tab);
}

// ---- new session menu / history -------------------------------------------
let menuEl = null;

let menuAnchor = null; // the button that opened menuEl (⋯ / ▾ N; the session menu hangs from ⋯ or ＋)

function onMenuOutside(e) {
  if (!menuEl) return;
  const anchor = menuAnchor || document.getElementById('more-btn');
  if (menuEl.contains(e.target) || anchor?.contains(e.target)) return;
  closeMenu();
}

function closeMenu(refocus = true) {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  menuAnchor = null;
  document.removeEventListener('mousedown', onMenuOutside, true);
  if (refocus) focusTab(tabs.get(activeId));
}

function menuItem(text, hint, onClick, usageId) {
  const b = h('button', 'menu-item');
  b.type = 'button';
  if (usageId) b.dataset.usage = usageId; // UA1 (src/renderer/usage.js)
  b.append(h('span', 'mi-text', text));
  if (hint) b.append(h('span', 'mi-hint', hint));
  b.addEventListener('click', onClick);
  return b;
}

function cwdNote(cwd) {
  if (!cwd || normPath(cwd) === normPath(info.workDir)) return '';
  const base = normPath(info.workDir);
  const n = normPath(cwd);
  if (base && n.startsWith(`${base}\\`)) return `.${cwd.slice(info.workDir.replace(/[\\/]+$/, '').length)}`;
  return cwd;
}

function openMenu() {
  if (menuEl) {
    closeMenu();
    return;
  }
  // the session menu opens under ⋯ (or ＋ when ⋯ is not shown)
  const anchor = [document.getElementById('more-btn'), document.getElementById('newtab')].find((b) => b && b.offsetParent) || document.getElementById('newtab');
  const m = h('div', 'popover newtab-pop');
  const r = anchor.getBoundingClientRect();
  m.style.top = `${Math.round(r.bottom + 6)}px`;
  m.style.left = `${Math.round(Math.max(8, Math.min(r.left - 24, window.innerWidth - 400)))}px`;

  m.append(menuItem('新しいセッション', scKey('newTab'), () => {
    closeMenu(false);
    createTab();
  }));
  // Agent Teams (experimental): in-process teammates, listed in the side panel / phone UI.
  m.append(menuItem('チームで新しいセッション（Agent Teams）', '実験的', () => {
    closeMenu(false);
    createTab({ team: true });
  }));
  // Temp session (roadmap 9): another window on an empty temp folder, deleted when it closes.
  m.append(menuItem('一時セッション（別ウィンドウ）', scKey('tempSession'), () => {
    closeMenu(false);
    safe(() => api.tempOpen?.());
  }));

  if (info.isGit) {
    const wtItem = menuItem('ワークツリーで新しいセッション…', '', () => {
      const row = h('div', 'wt-row');
      const input = h('input', 'wt-input');
      input.value = `wt-${crypto.randomUUID().slice(0, 6)}`;
      input.spellcheck = false;
      input.placeholder = 'ワークツリー名';
      const go = h('button', 'wt-go', '作成');
      go.type = 'button';
      const err = h('div', 'wt-err');
      const submit = () => {
        const name = input.value.trim();
        if (!WT_NAME_RE.test(name)) {
          err.textContent = '英数字と . _ - のみ、40 文字以内';
          input.focus();
          return;
        }
        closeMenu(false);
        createTab({ mode: 'new', worktree: name });
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeMenu();
        }
      });
      input.addEventListener('input', () => {
        err.textContent = '';
      });
      go.addEventListener('click', submit);
      const box = h('div', 'wt-box');
      box.append(h('div', 'wt-caption', 'ワークツリー名 (.claude/worktrees/<名前>)'), row, err);
      row.append(input, go);
      wtItem.replaceWith(box);
      input.focus();
      input.select();
    });
    m.append(wtItem);
  }

  m.append(h('div', 'menu-sep'));
  const head = h('div', 'menu-head');
  head.append(h('span', null, '履歴'), h('span', 'mi-hint', scKey('history')));
  m.append(head);
  const list = h('div', 'hist-list');
  list.append(h('div', 'hist-empty', '読み込み中…'));
  m.append(list);

  overlayRoot.append(m);
  menuEl = m;
  menuAnchor = anchor;
  document.addEventListener('mousedown', onMenuOutside, true);

  Promise.resolve()
    .then(() => api.sessionsHistory())
    .then((items) => {
      if (menuEl !== m) return;
      list.replaceChildren();
      if (!items || !items.length) {
        list.append(h('div', 'hist-empty', '履歴はありません'));
        return;
      }
      for (const it of items) list.append(historyItem(it));
    })
    .catch((err) => {
      console.error(err);
      if (menuEl !== m) return;
      list.replaceChildren(h('div', 'hist-empty', '履歴を読み込めませんでした'));
    });
}

function historyItem(it) {
  const here = tabs.has(it.id);
  const row = h('button', 'hist-item');
  row.type = 'button';
  const title = it.title || shortLabel(it.firstPrompt, 60) || '(無題のセッション)';
  row.append(h('div', 'hist-title', title));
  const meta = h('div', 'hist-meta');
  meta.append(h('span', null, it.mtime ? relTime(it.mtime) : ''));
  const note = cwdNote(it.cwd);
  if (note) meta.append(h('span', 'hist-cwd', note));
  if (here) meta.append(h('span', 'hist-badge', '開いています'));
  else if (it.open) meta.append(h('span', 'hist-badge other', '他のウィンドウ'));
  row.append(meta);
  row.title = [it.title, it.firstPrompt, it.cwd].filter(Boolean).join('\n');
  if (!here && it.open) row.classList.add('disabled');
  row.addEventListener('click', () => {
    if (tabs.has(it.id)) {
      closeMenu(false);
      activate(it.id);
      return;
    }
    if (it.open) return;
    closeMenu(false);
    createTab({
      id: it.id,
      mode: 'resume',
      cwd: it.cwd || info.workDir,
      worktree: worktreeFromCwd(it.cwd),
      label: it.title ? shortLabel(it.title, 40) : shortLabel(it.firstPrompt) || undefined,
      manualLabel: false,
    });
  });
  return row;
}

// ---- cheat sheet insert ----------------------------------------------------
function insertIntoActive(text, submit) {
  const tab = tabs.get(activeId);
  if (!tab || tab.exited) return;
  // Conversation view on screen: snippets go into its input box (or are sent right away).
  if (tab.conv && ((tab.mode === 'rich' && !tab.peek && tab.conv.el.isConnected) || (tab.mode === 'term' && tab.conv.dock.isConnected))) {
    // While a dialog is open the snippet only goes into the input box (Enter would answer the dialog).
    if (submit && !convSendBlocked(tab)) sendText(tab, text ?? '');
    else {
      const input = tab.conv.input;
      // The textarea keeps its selection while the cheat sheet has focus: replace it, caret after the snippet.
      const pos = input.selectionStart ?? input.value.length;
      const ins = String(text ?? '');
      input.value = `${input.value.slice(0, pos)}${ins}${input.value.slice(input.selectionEnd ?? pos)}`;
      input.selectionStart = input.selectionEnd = pos + ins.length;
      input.dispatchEvent(new Event('input'));
    }
    C.focus(tab);
    return;
  }
  tab.term.paste(String(text ?? ''));
  if (submit) setTimeout(() => api.ptyInput({ id: tab.id, data: '\r' }), 150);
  tab.term.focus();
}

// ---- usage records (UA1, docs/usage-analytics.md §2.3) --------------------------
// The state of a session when it is opened: a problem (permission / question / error / stuck / failed) or not
// (done / working / idle). Only these words go to main; nothing of the session itself.
function usageStateOf(tab) {
  if (!tab) return 'idle';
  // tab.prompt.kind (promptInfo): 'permission' for a permission dialog; tab.choices does not keep that flag
  if (tab.choices && !tab.exited) return tab.prompt?.kind === 'permission' || tab.choices.permission ? 'permission' : 'question';
  if (tab.unread && tab.unread.kind === 'error') return 'error';
  const bid = safe(() => backlogIdOf(tab.id), null);
  const item = bid ? safe(() => window.Backlog?.items?.().find((i) => i && i.id === bid), null) : null;
  if (item && item.status === 'failed') return 'failed';
  if (tab.status === 'asking') return 'question';
  const w = safe(() => waitOf(tab), null);
  if (w && w.level === 'warn') return 'stuck';
  if (tab.rest === 'done' || safe(() => doneMarkAt(tab), 0)) return 'done';
  if (tab.status === 'running' || tab.status === 'starting') return 'working';
  return 'idle';
}
function usageOpen(tabId, from, state) {
  usageTabId = tabId;
  safe(() => window.Usage?.open?.(from, state, () => usageStateOf(tabs.get(tabId))));
}
function usageClose() {
  usageTabId = null;
  safe(() => window.Usage?.close?.());
}

// ---- UA3: the problem band (docs/usage-analytics.md §4 の 1・5, §5) -------------------------------
// The session screen is opened when something is wrong. Opened in a problem (permission / question / error / stuck /
// failed: usageStateOf before activate), a band over the conversation says what is wrong in one line, with what can be
// done there (答える・止める・再起動・引き継ぐ), and the conversation goes to the problem's entry (Conversation.showProblem).
// Opened without one, no band and the newest line. When the problem has gone (answered, running again), the band says
// so with 「ダッシュボードに戻る」; it does not close by itself (the user may want to watch). Only the active session's.
const PROBLEM_KINDS = new Set(['permission', 'question', 'error', 'stuck', 'failed']);
function bandEl() {
  let el = document.getElementById('problem-band');
  if (el) return el;
  el = h('div', '');
  el.id = 'problem-band';
  el.hidden = true;
  (document.getElementById('edit-band') || document.getElementById('topbar'))?.after(el);
  return el;
}
const minText = (ms) => (ms < 60e3 ? '1 分たらず' : `${durText(ms)}`);
// the command a permission dialog asks about: the context lines without the box's header ("Bash command") / question
function promptSubject(p) {
  const ctx = (p?.context || []).map((l) => String(l || '').trim()).filter((l) => l && !/^(bash command|edit file|write file|create file|read file|fetch|web ?fetch|tool use|mcp\b|do you want)/i.test(l));
  return ctx[0] || String(p?.question || '').trim();
}
function bandLine(tab, kind) {
  const short = (s, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  if (kind === 'permission' || kind === 'question') {
    const p = tab.prompt;
    const since = p?.since || Date.now();
    const what = short(kind === 'permission' ? promptSubject(p) : String(p?.question || tab.choices?.question || '').trim());
    return `${kind === 'permission' ? '許可の確認' : '質問の答え'}で ${minText(Date.now() - since)}止まっています${what ? `: ${what}` : ''}`;
  }
  if (kind === 'error') {
    const t = short(String(tab.unread?.kind === 'error' ? tab.unread.text : band?.errText || '').trim());
    return `エラーで止まっています${t ? `: ${t}` : ''}`;
  }
  if (kind === 'stuck') {
    const w = tab.wait;
    const at = w?.since ? ` ${minText(Date.now() - w.since)}` : '';
    const a = (w?.alerts || []).map((x) => (typeof x === 'string' ? x : x?.text || '')).find(Boolean);
    return `動きが無いまま${at}たっています${a || w?.text ? `: ${short(String(a || w.text))}` : ''}`;
  }
  const bid = safe(() => backlogIdOf(tab.id), null);
  const item = bid ? safe(() => window.Backlog?.items?.().find((i) => i && i.id === bid), null) : null;
  return `作業が失敗で終わりました${item?.note ? `: ${short(item.note)}` : item?.text ? `: ${short(item.text)}` : ''}`;
}
// has the problem gone? permission / question: the dialog is gone; error / failed: the session ran again after the
// open; stuck: no warning any more (or it ran)
function bandResolved(tab) {
  if (!tab) return false;
  if (band.kind === 'permission' || band.kind === 'question') return !tab.choices && tab.status !== 'asking';
  if (band.ranAt) {
    const st = usageStateOf(tab);
    // an error mark from before it ran again is the old problem (the mark stays until the tab is looked at with focus)
    return band.kind === 'failed' || !PROBLEM_KINDS.has(st) || (st === 'error' && !((tab.unread?.at || 0) > band.ranAt));
  }
  if (band.kind === 'stuck') return !tab.exited && waitOf(tab)?.level !== 'warn';
  return false;
}
function openProblemBand(tab, state) {
  if (info.role === 'manager' || !tab) return;
  if (!PROBLEM_KINDS.has(state)) {
    hideProblemBand();
    return;
  }
  hideProblemBand();
  band = { el: bandEl(), tabId: tab.id, kind: state, resolved: false, ranAt: 0, note: '', errText: tab.unread?.kind === 'error' ? tab.unread.text : '' };
  band.line = bandLine(tab, state);
  renderProblemBand();
  // after the layout put the conversation in its pane (activate -> applyLayout)
  requestAnimationFrame(() => safe(() => window.Conversation?.showProblem?.(tab, state)));
}
function hideProblemBand() {
  if (!band) return;
  const tab = tabs.get(band.tabId);
  safe(() => window.Conversation?.clearProblem?.(tab));
  band.el.hidden = true;
  band.el.replaceChildren();
  band = null;
  fitSoon();
}
// called on the session's changes (setStatus, waits, exit) and every 3 s
function tickProblemBand() {
  if (!band) return;
  const tab = tabs.get(band.tabId);
  if (!tab || activeId !== band.tabId) {
    hideProblemBand();
    return;
  }
  if (tab.status === 'running' || tab.status === 'starting') band.ranAt ||= Date.now();
  if (!band.resolved && bandResolved(tab)) {
    band.resolved = true;
    band.note = '';
    safe(() => window.Conversation?.clearProblem?.(tab));
    renderProblemBand();
    return;
  }
  const st = usageStateOf(tab);
  const old = (st === 'error' && !((tab.unread?.at || 0) > (band.ranAt || Infinity))) || (st === 'failed' && band.kind === 'failed');
  if (band.resolved && PROBLEM_KINDS.has(st) && !old) {
    // a new problem while the band is up: say that one
    openProblemBand(tab, st);
    return;
  }
  if (!band.resolved && (band.kind === 'permission' || band.kind === 'question' || band.kind === 'stuck')) {
    const line = bandLine(tab, band.kind);
    if (line !== band.line) {
      band.line = line;
      const t = band.el.querySelector('.pb-line');
      if (t) t.textContent = line;
    }
  }
}
function renderProblemBand() {
  const el = band.el;
  const tab = tabs.get(band.tabId);
  el.replaceChildren();
  el.dataset.kind = band.resolved ? 'resolved' : band.kind;
  const btn = (text, usage, run, cls = '') => {
    const b = h('button', cls, text);
    b.type = 'button';
    b.dataset.usage = usage;
    b.dataset.pb = usage.split('.').pop();
    b.addEventListener('click', () => safe(run));
    return b;
  };
  const W = Labels.WORDS;
  const back = btn(W.backToDash || 'ダッシュボードに戻る', 'session.band.back', () => api.dashboardOpen?.(), band.resolved ? 'pb-primary' : 'pb-back');
  const close = btn('×', 'session.band.close', () => hideProblemBand(), 'pb-close');
  close.title = 'この帯を閉じる';
  if (band.resolved) {
    el.append(h('span', 'pb-icon', '✓'), h('span', 'pb-line', '問題は片付きました'));
    // routed work goes on when this window is closed (§4 の 5)
    if (tab?.forBacklog) el.append(h('span', 'pb-note', 'このウィンドウを閉じても、作業は裏で続きます'));
    el.append(h('span', 'pb-spacer'), back, close);
    el.hidden = false;
    fitSoon();
    return;
  }
  const line = h('span', 'pb-line', band.line);
  line.title = band.line;
  const row = h('div', 'pb-acts');
  const ask = band.kind === 'permission' || band.kind === 'question';
  row.append(btn(ask ? '答える' : '指示する', 'session.band.answer', () => bandAnswer(tab), 'pb-primary'));
  if (!tab.exited && (ask || band.kind === 'stuck')) {
    const stop = btn('止める', 'session.band.stop', () => api.ptyInput({ id: tab.id, data: '\x1b' }));
    stop.title = 'Esc を送って、いまの処理（確認）を止めます';
    row.append(stop);
  }
  row.append(btn(tab.exited ? W.resume || '再開' : '再起動', 'session.band.restart', () => {
    const why = restartTab(tab);
    if (why && why !== '取り消しました') bandNote(why);
  }));
  if (!tab.exited && !tab.handedOff && window.Handoff) {
    row.append(btn('引き継ぐ', 'session.band.handoff', () => {
      const why = window.Handoff.start(tab, 'manual');
      bandNote(why || '新しいセッションへの引き継ぎを始めました');
    }));
  }
  const note = h('span', 'pb-note', band.note);
  note.hidden = !band.note;
  el.append(h('span', 'pb-icon', '⚠'), line, row, note, h('span', 'pb-spacer'), back, close);
  el.hidden = false;
  fitSoon();
}
function bandNote(text) {
  if (!band) return;
  band.note = String(text || '');
  const n = band.el.querySelector('.pb-note');
  if (n) {
    n.textContent = band.note;
    n.hidden = !band.note;
  }
}
// 答える: the choices of the dialog (the conversation's composer, also under the terminal); else the input box
function bandAnswer(tab) {
  if (!tab) return;
  const C = tab.conv;
  const opt = C?.choices && !C.choices.hidden ? C.choices.querySelector('.cv-opt') : null;
  if (opt) {
    opt.scrollIntoView({ block: 'nearest' });
    opt.focus();
    return;
  }
  if (C && tab.mode !== 'split') return window.Conversation.focus(tab);
  safe(() => tab.term.focus());
}

// ---- UA3: the session screen without the everyday parts (docs/usage-analytics.md §4 の 3, §5) ---------------
// On by default ('sessionSlim' !== '0'): the assist panel starts closed and its button is off the bar, the pane's
// header (session name, status, 会話 / ターミナル / 並べる) is not drawn while one pane shows; ⋯ has 「この作業の詳しく」
// (the assist panel), 「ターミナル」, the viewer and 待ちの一覧. ⚙ 設定 → 会話の表示 turns it off (the form before).
// Not the dashboard window (its own layout).
const SLIM_KEY = 'sessionSlim';
function slimOn() {
  if (info.role === 'manager') return false;
  try {
    return localStorage.getItem(SLIM_KEY) !== '0';
  } catch {
    return true;
  }
}
function applySlim() {
  document.body.classList.toggle('slim', slimOn());
  fitSoon();
}
function setSlim(on) {
  try {
    localStorage.setItem(SLIM_KEY, on ? '1' : '0');
  } catch {}
  applySlim();
  if (dock) setAssistShown(!on); // the form chosen: the panel as it comes with it
}
window.SessionSlim = { get: slimOn, set: setSlim };
// a session of this window opened from a notice / the dashboard / the widget (main: notify:click)
function openFromNotice({ tabId, member, from } = {}) {
  if (!tabs.has(tabId)) return;
  const openState = usageStateOf(tabs.get(tabId)); // UA1: before activate() clears the unread mark
  activate(tabId);
  usageOpen(tabId, from || 'project', openState);
  openProblemBand(tabs.get(tabId), openState); // UA3
  // opened from a notice / the dashboard / the widget: the window may still be showing. Only an idle rest wakes; a
  // 完了 tab waits for 再開, a send or Enter (PROGRESS 44)
  const t = tabs.get(tabId);
  if (t && t.rest === 'idle') safe(() => wakeTab(t));
  // the dashboard's エージェント tab 「会話を見る」: the member's read-only conversation (roadmap 13)
  if (member && member.agentId) openMemberView({ tabId, agentId: member.agentId, name: member.name });
}
window.ProblemBand = { open: (tabId, from) => openFromNotice({ tabId, from }), state: () => (band ? { tabId: band.tabId, kind: band.kind, resolved: band.resolved, line: band.line } : null), tick: () => tickProblemBand() }; // tests (tmp/ua3)
// screen time: the dashboard's tab in the manager window, else the active session's view mode
const USAGE_MODE_VIEW = { rich: 'view.session.conversation', term: 'view.session.terminal', split: 'view.session.split' };
safe(() => window.Usage?.setView?.(() => {
  if (window.Settings?.isOpen?.()) return 'view.settings';
  if (info.role === 'manager') return safe(() => window.Dashboard?.usageView?.(), null) || null;
  const t = tabs.get(activeId);
  return t ? USAGE_MODE_VIEW[t.mode] || null : null;
}));

// ---- shortcuts --------------------------------------------------------------
// UX4: one table (Labels.SHORTCUTS: 'mod+shift+T' = ⇧⌘T on Mac, Ctrl+Shift+T on Windows); here only what each id does
const SHORTCUT_ACTIONS = {
  newTab: () => createTab(),
  closeTab: () => closeTab(activeId),
  folder: () => api.openPicker(),
  autoYes: () => setAutoYes(!autoYes),
  layout: () => cycleLayout(),
  history: () => openMenu(),
  cheatsheet: () => safe(() => window.CheatSheet?.toggle?.()),
  viewMode: () => tabs.has(activeId) && toggleViewMode(tabs.get(activeId)),
  pmoLog: () => openPmoLog(), // the dashboard's「PMO の記録」(UIUX U4)
  backlog: () => toggleBacklogPanel(),
  tempSession: () => safe(() => api.tempOpen?.()), // new temporary-session window (roadmap 9)
  viewer: () => pickViewer(), // open a file in a viewer panel (roadmap 5b)
  cycleTab: (e) => cycleTab(e.shiftKey ? -1 : 1),
};
// the key as shown on this OS (⇧⌘B / Ctrl+Shift+B); function declarations: titles set while the file loads use them
function keyOf(spec) {
  return Labels.key(spec);
}
function scKey(id) {
  return Labels.shortcutKey(id);
}
// index.html's static buttons name their shortcut by id (data-sc); the key is added for this OS
for (const el of document.querySelectorAll('[data-sc]')) el.title = `${el.title} (${scKey(el.dataset.sc)})`;
function shortcutAction(e) {
  if (e.type !== 'keydown') return null;
  const id = Labels.shortcutOf(e);
  const f = id && SHORTCUT_ACTIONS[id];
  return f ? () => f(e) : null;
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menuEl) {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    return;
  }
  const action = shortcutAction(e);
  if (action) {
    e.preventDefault();
    e.stopPropagation();
    safe(() => window.Usage?.key?.(Labels.shortcutOf(e))); // UA1: key.<action id> (never the key itself)
    action();
  }
}, true);

// ---- IPC wiring -------------------------------------------------------------
api.onAssistEvent(handleAssistEvent);

api.onPtyData(({ id, data }) => {
  const tab = tabs.get(id);
  if (!tab) return;
  if (!tab.firstDataAt) tab.firstDataAt = Date.now();
  tab.lastOutAt = Date.now(); // the last output counts as use for the idle rest (31)
  if (tab.lastOutAt - (tab.resizedAt || 0) > 3000) tab.workOutAt = tab.lastOutAt; // not a repaint after a resize (auto-close)
  tab.term.write(data, () => {
    tab.outSeq = (tab.outSeq || 0) + 1;
    scheduleScan(tab);
  });
});

// PROGRESS 4: the tab's claude called notify on the app's MCP server (src/main/mcp-server.js): the same notice as an
// OSC 777 one (unread mark, sound, toast by the notify settings), with the kind the agent gave
api.onMcpNotify?.(({ tabId, kind, text } = {}) => {
  const tab = tabs.get(tabId);
  if (tab && ['done', 'input', 'error'].includes(kind)) safe(() => raise(tab, kind, String(text || '').slice(0, 500)));
});

// memory of each session's process tree, pushed by main about once a minute (tab badge from MEM_HEAVY_MB)
api.onPtyMem?.((map) => safe(() => applyMem(map)));

api.onPtyExit(({ id, code }) => {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.exited = true;
  tab.exitCode = code ?? null;
  safe(() => settleOnExit(tab, 'claude が終了しました')); // its backlog item must not stay 対応中
  tab.choices = null;
  tab.prompt = null;
  // stopped from outside after its routed item ended with 作業完了 (e.g. the PMO freed memory with Stop-Process, exit
  // code 1): the work did not fail. 完了 like restTab, saved resting (a restart does not start it), no error (PROGRESS 42)
  if (!tab.rest && safe(() => finishedItemOf(tab), null) && restTab(tab, 'done', { exited: true })) {
    if (tab.unread?.kind === 'error') clearUnread(tab);
    return;
  }
  // claude runs without a shell around it (CONTRACT.md "How a tab's claude is started"), so the tab ends with it.
  // Enter here (or the 再開 button in the conversation view / the tab menu) starts `claude --resume <id>` again.
  tab.term.write('\r\n\x1b[2m[claude は終了しました。Enter で再開（会話はそのまま）]\x1b[0m\r\n');
  setStatus(tab, 'exited');
  if (code !== undefined && code !== null && code !== 0) raise(tab, 'error', `プロセスが終了しました（コード ${code}）`);
  safe(() => tickProblemBand()); // UA3
});

api.onNotifyClick?.((o) => openFromNotice(o || {})); // UA3: also the problem band

api.onRemoteAction?.(handleRemoteAction);

// what each waiting tab of this window waits for (main's waits.js): { [tabId]: Wait | null }
api.onWaitsState?.((map) => safe(() => applyWaits(map)));

// Prevent Electron from navigating to files dropped anywhere outside a pane.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
window.addEventListener('dragend', () => panes.forEach((p) => p.el.classList.remove('drop')));

window.addEventListener('focus', clearSeen);
document.getElementById('settings-btn')?.addEventListener('click', () => safe(() => window.Settings?.open?.()));
// UX4: the macOS menu's 設定… (⌘,)
safe(() => api.onMenuCommand?.((cmd) => cmd === 'settings' && safe(() => window.Settings?.open?.())));
document.getElementById('dashboard-btn')?.addEventListener('click', () => safe(() => api.dashboardOpen?.()));
// main wrote this folder's backlog (e.g. an item routed here by the manager agent)
api.onBacklogChanged?.((e) => {
  if (!e || e.source !== 'main' || normPath(e.folder) !== normPath(info.workDir)) return; // only our own folder
  // e.order: the manager agent reordered the queue (roadmap 27); new items first, then the order.
  // e.statuses: an item's status was changed from outside (取り消す on the dashboard, the manager's backlog-update, auto clean-up)
  Promise.resolve(safe(() => window.Backlog?.merge?.())).then(() => {
    // e.userOrderAt (queue order): the user moved a task on the dashboard card (ms) / handed the order to the PMO (null)
    if (e.order) safe(() => window.Backlog?.reorder?.(e.order, e.userOrderAt));
    if (Array.isArray(e.statuses)) safe(() => window.Backlog?.applyStatuses?.(e.statuses));
  });
});
window.addEventListener('resize', fitSoon);
if (typeof ResizeObserver === 'function') new ResizeObserver(fitSoon).observe(termsEl);

// ---- top bar (UIUX U6, 依頼-56) ------------------------------------------------------
// On the bar: ＋ 新しいセッション, ダッシュボード, ⋯ その他, ⚙ 設定, the side panel (and Remote while it is on).
// ⋯ holds the viewer, 待ちの一覧, the cheat sheet, remote, the new session options / history and the Auto-yes
// switch; their shortcuts stay. Tabs shrink (min width, the name cut with …); what still does not fit is in
// "▾ N" at the right end of the tabs; the wheel scrolls the tabs sideways; the current tab is scrolled into view
// (activate). 完了 tabs sit at the right, faded (style.css). Order: opened order, drag a tab to move it.
const tabsMoreBtn = document.getElementById('tabs-more');
const TAB_EDGE = 2; // px: a tab cut by less than this still counts as shown

function tabShown(tab) {
  if (!tab.btn || !tab.btn.isConnected) return false;
  const r = tab.btn.getBoundingClientRect();
  const c = tabsEl.getBoundingClientRect();
  return r.width > 0 && r.left >= c.left - TAB_EDGE && r.right <= c.right + TAB_EDGE;
}
function hiddenTabs() {
  return [...tabs.values()].filter((t) => t.btn && !tabShown(t)).sort((a, b) => a.btn.getBoundingClientRect().left - b.btn.getBoundingClientRect().left);
}

var tabsMoreRaf = 0; // var: renderTab may call scheduleTabsMore before this part of the file has run
function scheduleTabsMore() {
  const btn = document.getElementById('tabs-more');
  if (tabsMoreRaf || !btn) return;
  tabsMoreRaf = requestAnimationFrame(() => {
    tabsMoreRaf = 0;
    const n = safe(() => hiddenTabs().length, 0);
    btn.hidden = !n;
    btn.textContent = `▾ ${n}`;
    btn.title = `${window.Labels?.WORDS?.hiddenTabs || ''} ${n} 件（クリックで一覧）`;
    btn.dataset.count = String(n);
  });
}

function tabRow(t, onPick) {
  const row = h('button', 'menu-item tabs-more-item');
  row.type = 'button';
  row.dataset.status = t.status || '';
  row.dataset.rest = t.rest || '';
  row.dataset.id = t.id;
  row.append(h('span', 'dot'), h('span', 'mi-text', t.label), h('span', 'mi-hint', t.rest === 'done' ? Labels.WORDS.done : STATUS_JA[t.status] || ''));
  if (t.id === activeId) row.classList.add('on');
  row.addEventListener('click', () => onPick(t));
  return row;
}

function openTabsMore() {
  if (menuEl && menuAnchor === tabsMoreBtn) {
    closeMenu();
    return;
  }
  closeMenu(false);
  const list = hiddenTabs();
  const m = h('div', 'popover tabs-more-pop');
  const r = tabsMoreBtn.getBoundingClientRect();
  m.style.top = `${Math.round(r.bottom + 6)}px`;
  m.style.left = `${Math.round(Math.max(8, Math.min(r.left - 160, window.innerWidth - 360)))}px`;
  const head = h('div', 'menu-head');
  head.append(h('span', null, Labels.WORDS.hiddenTabs), h('span', 'mi-hint', `${list.length} 件`));
  m.append(head);
  for (const t of list) {
    m.append(tabRow(t, (x) => {
      closeMenu(false);
      activate(x.id);
      focusTab(x);
    }));
  }
  overlayRoot.append(m);
  menuEl = m;
  menuAnchor = tabsMoreBtn;
  document.addEventListener('mousedown', onMenuOutside, true);
}

function openMoreMenu() {
  const anchor = document.getElementById('more-btn');
  if (menuEl && menuAnchor === anchor) {
    closeMenu();
    return;
  }
  closeMenu(false);
  const W = Labels.WORDS;
  const m = h('div', 'popover more-pop');
  const r = anchor.getBoundingClientRect();
  m.style.top = `${Math.round(r.bottom + 6)}px`;
  m.style.left = `${Math.round(Math.max(8, Math.min(r.right - 300, window.innerWidth - 308)))}px`;
  const item = (key, text, hint, run) => {
    const b = menuItem(text, hint, () => {
      closeMenu(false);
      safe(run);
    });
    b.dataset.more = key;
    b.dataset.usage = 'topbar.more.' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()); // UA1
    return b;
  };
  // UA3 (docs/usage-analytics.md §5): what the slim session screen leaves out is here — この作業の詳しく (the assist
  // panel), ターミナル, the viewer, 待ちの一覧 (the backlog) — first, then the rest
  const cur = tabs.get(activeId);
  m.append(item('detail', `${assistShownNow() ? '✓ ' : ''}${W.workDetail}`, '', () => setAssistShown(!assistShownNow())));
  if (cur?.conv) m.append(item('terminal', `${cur.mode === 'term' ? '✓ ' : ''}${W.showTerminal}`, scKey('viewMode'), () => setViewMode(cur, cur.mode === 'term' ? 'rich' : 'term')));
  m.append(item('viewer', W.viewer, scKey('viewer'), () => pickViewer()));
  const n = safe(() => window.Backlog.items().filter((i) => i.status === 'pending' || i.status === 'active').length, 0);
  m.append(item('queue', `${W.queueList}${n ? `（${n} 件）` : ''}`, scKey('backlog'), () => toggleBacklogPanel()));
  m.append(h('div', 'menu-sep'));
  m.append(item('session', W.sessionOptions, scKey('history'), () => openMenu()));
  m.append(item('cheatsheet', W.cheatsheet, scKey('cheatsheet'), () => window.CheatSheet?.toggle?.()));
  const rb = document.getElementById('remote-btn');
  const rOn = !!rb?.classList.contains('rmt-on');
  m.append(item('remote', W.remote, rOn ? 'ON' : 'OFF', () => openRemoteFromMore()));
  m.append(h('div', 'menu-sep'));
  m.append(item('autoYes', `${autoYes ? '✓ ' : ''}${W.autoYes}`, scKey('autoYes'), () => setAutoYes(!autoYes)));
  overlayRoot.append(m);
  menuEl = m;
  menuAnchor = anchor;
  document.addEventListener('mousedown', onMenuOutside, true);
}

// The remote pill is on the bar only while remote is on (style.css). Opened from ⋯ while off, it shows until its
// popover (.rmt-pop, remote-ui.js) closes, so the popover has a place to hang from.
function openRemoteFromMore() {
  const rb = document.getElementById('remote-btn');
  if (!rb) return;
  rb.classList.add('rmt-peek');
  rb.click();
  if (!overlayRoot.querySelector('.rmt-pop')) return;
  const mo = new MutationObserver(() => {
    if (overlayRoot.querySelector('.rmt-pop')) return;
    mo.disconnect();
    rb.classList.remove('rmt-peek');
  });
  mo.observe(overlayRoot, { childList: true });
}

// Drag a tab onto another tab: put it before / after that one (the tab order is the Map order, saved in sessions.json).
function moveTab(id, targetId, after) {
  if (!tabs.has(id) || !tabs.has(targetId) || id === targetId) return;
  const order = [...tabs.keys()].filter((k) => k !== id);
  order.splice(order.indexOf(targetId) + (after ? 1 : 0), 0, id);
  const entries = order.map((k) => [k, tabs.get(k)]);
  tabs.clear();
  for (const [k, t] of entries) {
    tabs.set(k, t);
    if (t.btn) tabsEl.append(t.btn);
  }
  saveSessions();
  scheduleRemote();
  scheduleTabsMore();
}
function clearTabDrop() {
  for (const b of tabsEl.querySelectorAll('.drop-before, .drop-after')) b.classList.remove('drop-before', 'drop-after');
}
tabsEl.addEventListener('dragover', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes(TAB_MIME)) return;
  const btn = e.target.closest?.('.tab');
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearTabDrop();
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  btn.classList.add(e.clientX > r.left + r.width / 2 ? 'drop-after' : 'drop-before');
});
tabsEl.addEventListener('dragleave', (e) => {
  if (!tabsEl.contains(e.relatedTarget)) clearTabDrop();
});
tabsEl.addEventListener('drop', (e) => {
  const id = e.dataTransfer?.getData(TAB_MIME);
  const btn = e.target.closest?.('.tab');
  const after = !!btn?.classList.contains('drop-after');
  clearTabDrop();
  if (!id || !btn) return;
  e.preventDefault();
  const target = [...tabs.values()].find((t) => t.btn === btn);
  if (target) moveTab(id, target.id, after);
});
window.addEventListener('dragend', clearTabDrop);
// The wheel scrolls the tabs sideways (the scroll bar is hidden).
tabsEl.addEventListener('wheel', (e) => {
  if (tabsEl.scrollWidth <= tabsEl.clientWidth) return;
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (!d) return;
  e.preventDefault();
  tabsEl.scrollLeft += d;
}, { passive: false });
tabsEl.addEventListener('scroll', scheduleTabsMore);
if (typeof ResizeObserver === 'function') new ResizeObserver(scheduleTabsMore).observe(tabsEl);
new MutationObserver(scheduleTabsMore).observe(tabsEl, { childList: true });
tabsMoreBtn?.addEventListener('click', () => openTabsMore());
document.getElementById('more-btn')?.addEventListener('click', () => openMoreMenu());
window.AgentTopbar = { hiddenTabs: () => hiddenTabs().map((t) => t.id), moveTab, openMore: openMoreMenu, openTabsMore }; // tests (tmp/sess-conv)

document.getElementById('newtab')?.addEventListener('click', () => createTab());
document.getElementById('folder')?.addEventListener('click', () => api.openPicker());
document.getElementById('toggle-panel')?.addEventListener('click', () => {
  setAssistShown(!assistShownNow());
});

// Periodic rescan (status grace periods expire without new output) + remote refresh.
// UX8 (docs/ux-journey.md §5.5): every tab's screen was read every 3 s. Now the tabs on screen, and the hidden ones
// that can still change without new output (a dialog / an auto answer on it, a grace period, not started, a screen
// waiting for the terminal hand-off, running) or that got output since their last scan. A quiet idle / exited
// hidden tab reads the same screen again for nothing.
function rescanDue(t, now) {
  if (isVisible(t)) return true;
  if ((t.outSeq || 0) !== (t.scanSeq || 0)) return true;
  if (!t.started || t.choices || t.prompt || t.autoYesAns || t.submitAnswersUntil || t.unknownSince || t.trustAt) return true;
  if (t.status !== 'idle' && t.status !== 'exited') return true;
  if (t.evtStatus === 'running' && now - (t.evtAt || 0) < 6000) return true;
  return false;
}
setInterval(() => {
  if (!tabs.size) return;
  const now = Date.now();
  for (const t of tabs.values()) if (safe(() => rescanDue(t, now), true)) scan(t);
  safe(() => tickProblemBand()); // UA3: the minutes on the band, the problem gone
  scheduleRemote();
}, 3000);

let snippetCache = []; // cheat-sheet snippets for the composer's "/" palette (refreshed on use)

// ---- temp / edit band (roadmap 9 / 19, CONTRACT.md "Temp / edit sessions") ---------------------
// Temp window: a one-line note. Edit window: "編集中: <original>  [状態]  [作業用コピーを開く] [元と比べる] [書き戻す]".
let editBand = null; // { el, stateEl, msgEl, writeBtn, status }
function buildTempBand() {
  const band = h('div', info.temp.kind === 'edit' ? 'edit' : 'temp');
  band.id = 'edit-band';
  document.body.classList.add('temp-mode');
  document.getElementById('topbar')?.after(band);
  if (info.temp.kind !== 'edit') {
    band.append(h('span', 'eb-label', '一時セッション'), h('span', 'eb-msg', '閉じるとこのフォルダと会話の記録を削除します'));
    return;
  }
  const pathEl = h('span', 'eb-path', info.temp.original || '');
  pathEl.title = info.temp.original || '';
  const stateEl = h('span', 'eb-state', '確認中…');
  const msgEl = h('span', 'eb-msg', '');
  const btn = (label, title, fn, cls) => {
    const b = h('button', cls || '', label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', fn);
    return b;
  };
  const writeBtn = btn('書き戻す', '作業用コピーの内容で元のファイルを上書きします（直前の元はバックアップに残ります）', () => editWriteBackClick(), 'eb-primary');
  band.append(
    h('span', 'eb-label', '編集中:'),
    pathEl,
    stateEl,
    msgEl,
    h('span', 'eb-spacer'),
    btn('作業用コピーを開く', '作業用コピーを既定のアプリで開きます（開いたままだと Claude が保存できないことがあります）', () => safe(() => api.editOpenWork())),
    btn('元と比べる', '取り込んだ時点の元と作業用コピーを比べます', () => showEditDiff()),
    writeBtn,
  );
  editBand = { el: band, stateEl, msgEl, writeBtn, status: null };
  api.onEditState?.((st) => renderEditBand(st));
  api.editStatus?.().then((st) => st && renderEditBand(st)).catch(() => {});
  setInterval(() => {
    if (document.hasFocus()) api.editStatus?.().then((st) => st && renderEditBand(st)).catch(() => {});
  }, 5000); // quick feedback while Claude edits (main polls the original every 15 s on its own)
}

function renderEditBand(st) {
  if (!editBand || !st) return;
  editBand.status = st;
  let text = '未変更';
  let kind = '';
  if (st.originalState === 'locked') [text, kind] = ['元が開かれている', 'warn'];
  else if (st.originalState === 'missing') [text, kind] = ['元が見つからない', 'warn'];
  else if (st.originalState === 'changed') [text, kind] = ['元が更新された', 'warn'];
  else if (st.workChanged) [text, kind] = ['変更あり', 'changed'];
  editBand.stateEl.textContent = text;
  editBand.stateEl.dataset.s = kind;
  editBand.stateEl.title = st.originalState === 'locked' ? (st.lockedBy === 'office' ? 'Office で開かれています。閉じてから書き戻してください' : '他のプログラムが使用中です') : '';
  editBand.writeBtn.disabled = !st.workChanged || !!editBand.writing;
  // the "working copy is open elsewhere" note replaces / clears only itself (not a write-back result)
  if (st.workLocked) {
    editBand.msgEl.textContent = '作業用コピーが他のアプリで開かれています（Claude が保存できません）';
    editBand.msgEl.dataset.kind = 'lock';
  } else if (editBand.msgEl.dataset.kind === 'lock') {
    editBand.msgEl.textContent = '';
    editBand.msgEl.dataset.kind = '';
  }
}

async function editWriteBackClick() {
  if (!editBand || editBand.writing) return;
  editBand.writing = true;
  editBand.writeBtn.disabled = true;
  editBand.msgEl.textContent = '書き戻しています…';
  editBand.msgEl.dataset.kind = 'wb';
  let r = null;
  try {
    r = await api.editWriteBackAsk();
  } catch (err) {
    console.error(err);
  }
  editBand.writing = false;
  const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  const msgs = {
    written: `書き戻しました（${time}）`,
    copy: `編集版を保存しました: ${r && r.path ? r.path.split(/[\\/]/).pop() : ''}`,
    downloads: `ダウンロードに保存しました: ${r && r.path ? r.path.split(/[\\/]/).pop() : ''}`,
    unchanged: '変更はありません',
    cancelled: '書き戻しを中止しました',
    failed: '書き戻せませんでした',
  };
  editBand.msgEl.textContent = (r && msgs[r.action]) || '書き戻せませんでした';
  editBand.msgEl.dataset.kind = 'wb';
  editBand.msgEl.title = (r && (r.path || r.backup || r.error)) || '';
  api.editStatus?.().then((st) => st && renderEditBand(st)).catch(() => {});
}

async function showEditDiff() {
  document.querySelector('.edit-diff-pop')?.remove();
  let d = null;
  try {
    d = await api.editDiff();
  } catch {}
  const pop = h('div', 'edit-diff-pop');
  const head = h('div', 'ed-head');
  const close = h('button', 'icon-btn', '×');
  close.type = 'button';
  close.addEventListener('click', () => pop.remove());
  head.append(h('span', null, '元（取り込んだ時点）と作業用コピーの比較'), close);
  const pre = h('pre');
  if (!d) pre.textContent = '比べられませんでした';
  else if (!d.changed) pre.textContent = '変更はありません';
  else if (d.kind === 'text') {
    for (const line of d.diff.split('\n')) {
      const cls = line.startsWith('+++') || line.startsWith('---') ? '' : line.startsWith('+') ? 'ed-add' : line.startsWith('-') ? 'ed-del' : line.startsWith('@@') ? 'ed-hunk' : '';
      pre.append(h('div', cls, line || ' '));
    }
  } else {
    pre.textContent = `変更あり（この形式は内容の比較を表示できません）\n元:           sha256 ${d.baseSha}\n作業用コピー: sha256 ${d.workSha}`;
  }
  pop.append(head, pre);
  pop.addEventListener('keydown', (e) => e.key === 'Escape' && pop.remove());
  overlayRoot.append(pop);
}

// ---- startup ----------------------------------------------------------------
async function init() {
  setAutoYes(autoYes, true); // nothing to send: every window reads the same localStorage flag at load

  try {
    info = { ...info, ...((await api.getInfo()) || {}) };
  } catch (err) {
    console.error(err);
  }
  document.body.append(stash);
  applySlim(); // UA3 (needs info.role)
  await loadFolderLayout(); // per folder, from main (needs info.workDir for the migration)
  if (slimOn()) folderLayout.assistShown = false; // UA3: the assist panel starts closed (⋯ この作業の詳しく)
  if (info.role === 'manager') {
    // The dashboard page takes the window; the dock (the manager agent's session) is a column on the right.
    document.body.classList.add('dash-mode');
    folderLayout.assistShown = false;
    const dashEl = h('section', '');
    dashEl.id = 'dashboard';
    termsEl.parentNode.insertBefore(dashEl, termsEl);
    safe(() => buildPmoColumn());
    safe(() => setupDashSplit(dashEl));
  }
  await loadComposerStore(); // drafts + send history (restored into the tabs created below)
  buildDock();
  applyLayout();
  const devBadge = document.getElementById('dev-badge');
  if (devBadge) devBadge.hidden = !info.dev;
  folderName = info.role === 'manager' ? 'ダッシュボード' : (info.workDir || '').split(/[\\/]/).filter(Boolean).pop() || info.workDir || '';
  if (info.temp) {
    folderName = info.temp.kind === 'edit' ? `編集: ${info.temp.name || ''}` : '一時セッション';
    safe(() => buildTempBand());
  }
  const folderNameEl = document.getElementById('folder-name');
  if (folderNameEl) folderNameEl.textContent = folderName;
  const folderEl = document.getElementById('folder');
  if (folderEl) folderEl.title = `${info.workDir}\nフォルダを切り替え (${scKey('folder')})`;

  safe(() => window.CheatSheet?.init?.({ insert: insertIntoActive }));
  // Context handoff (roadmap 21, docs/plan-handoff.md)
  safe(() => window.Handoff?.init?.({
    tabs: () => [...tabs.values()],
    summary: (t) => P.summary(t),
    ready: (t, now) => backlogReady(t, now, true),
    blocked: (t) => convSendBlocked(t),
    send: (t, text) => sendText(t, text, 'auto'),
    createTab: (o) => createTab(o),
    closeTab: (id) => closeTab(id),
    activate: (id) => tabs.has(id) && activate(id),
    activeId: () => activeId,
    raise: (t, kind, text) => raise(t, kind, text),
    render: (t) => {
      renderTab(t);
      if (t.id === activeId) renderPanelSoon();
      scheduleRemote();
    },
    ptyClose: (id) => api.ptyClose(id),
    markExited: (t, note) => {
      if (!tabs.has(t.id)) return;
      t.exited = true;
      t.choices = null;
      safe(() => t.term.write(`
[2m[${note}][0m
`));
      setStatus(t, 'exited');
      saveSessions();
    },
    isManager: info.role === 'manager',
    // the PMO's automatic handoff (PROGRESS 45): its claude's memory, the user typing in its input box, 「PMO から」
    mem: (t) => (t.exited ? null : t.memMb ?? null),
    typing: (t) => pmoTyping(t),
    // the manager's old session closes: an unsent draft in its input box goes to the new one
    carryDraft: (o, n) => {
      safe(() => o.conv?.composer?.flushDraft?.());
      const d = composerStore.drafts?.[o.id];
      if (d && n.conv?.composer?.isEmpty?.()) n.conv.composer.restore(d);
    },
    notice: (n) => api.noticesAdd?.(n),
  }));
  safe(() => window.Notify?.init?.({ open: (id) => tabs.has(id) && activate(id), label: (id) => tabs.get(id)?.label || '（閉じたタブ）' }));
  // Backlog: per folder in main (backlog:*), saved debounced and on beforeunload.
  let backlogSaveT = 0;
  // the saved tabs (restored below): asked once, read by the backlog's load too (AT-101: which routed tabs come back)
  const savedP = Promise.resolve(safe(() => api.sessionsSaved(), null)).then((l) => (Array.isArray(l) ? l : []), (err) => {
    console.error(err);
    return [];
  });
  const backlogLoaded = safe(() => window.Backlog?.init?.({
    load: () => api.backlogGet?.(),
    restoring: () => (info.role === 'manager' ? null : savedP.then((l) => new Set(l.map((s) => s && s.id).filter(Boolean)))),
    save: (s) => {
      clearTimeout(backlogSaveT);
      backlogSaveT = setTimeout(() => safe(() => api.backlogSave?.(s)), 300);
    },
    tabs: () => [...tabs.values()].map((t) => ({ id: t.id, label: t.label })),
    activeId: () => activeId,
    sendNow: (tabId, item) => {
      const tab = tabs.get(tabId || activeId);
      if (!tab) return 'セッションが開いていません';
      if (window.Backlog.activeOf(tab.id)) return 'このセッションでは別の項目を対応中です';
      if (!item.tabId) item.tabId = tab.id;
      return backlogSend(tab, item);
    },
    openSession: (tabId) => openClosedSession(tabId), // a finished item whose 完了 tab was closed (PROGRESS 49)
    onChange: () => {
      for (const t of tabs.values()) updateLabel(t); // a routed item's number / heading names its tab (taskLabel)
    },
  }));
  window.addEventListener('beforeunload', () => safe(() => window.Backlog && window.Backlog.loaded?.() !== false && api.backlogSaveSync?.(window.Backlog.state())));
  safe(() => window.Conversation?.init?.({
    send: convSend, // -> '' when sent, else the reason it was not sent
    queue: (tab, text) => (safe(() => window.Backlog?.add?.(tab.id, text), null) ? '' : '待ちに追加できませんでした'), // Ctrl+Shift+Enter
    choose: (tab, n) => {
      if (tab.exited || !/^\d{1,2}$/.test(String(n))) return;
      safe(() => window.Usage?.track?.('click', 'session.answer')); // UA1
      api.ptyInput({ id: tab.id, data: String(n) });
      scheduleScan(tab);
    },
    key: (tab, name) => {
      if (tab.exited || !KEY_MAP[name]) return;
      api.ptyInput({ id: tab.id, data: KEY_MAP[name] });
      scheduleScan(tab);
    },
    restart: (tab) => tab.exited && restartTab(tab), // 「再開」 after claude exited
    setMode: setViewMode,
    peek: (tab, on) => (on ? setPeek(tab, 'manual', { user: true }) : leavePeek(tab)),
    composed: (tab) => tabs.has(tab.id) && scan(tab), // an automatic switch to the terminal may have waited (23b)
    openFile: (p) => p && api.openFile(p),
    openUrl: (url) => safe(() => api.openExternal(url)),
    // composer.js (attachments, "/" palette, history, drafts)
    cwd: (tab) => tab.cwd || info.workDir,
    filesSearch: (o) => api.filesSearch(o),
    commandsList: (o) => api.commandsList(o),
    imageSave: (o) => api.imageSave(o),
    imageRead: (p) => api.imageRead?.(p),
    snippets: () => {
      api.snippetsGet().then((l) => { snippetCache = l || safe(() => window.CheatSheet?.defaults?.(), []) || []; }).catch(() => {});
      return snippetCache;
    },
    history: () => composerStore.history || [],
    sent: (_tab, text) => {
      const hist = (composerStore.history ||= []);
      if (hist[hist.length - 1] !== text) hist.push(text);
      if (hist.length > 200) hist.splice(0, hist.length - 200);
      saveComposerStore();
    },
    saveDraft: (tab, d) => {
      if (!tabs.has(tab.id)) return;
      const drafts = (composerStore.drafts ||= {});
      if (d) drafts[tab.id] = d;
      else delete drafts[tab.id];
      saveComposerStore();
    },
  }));
  // The phone UI reads snippets from main, which only knows saved ones: persist the defaults once
  // so the remote shows the same quick buttons as the cheat sheet before the user edits anything.
  api.snippetsGet().then((list) => {
    if (list == null && window.CheatSheet?.defaults) api.snippetsSet(window.CheatSheet.defaults());
    snippetCache = list || safe(() => window.CheatSheet?.defaults?.(), []) || []; // ready for the first "/"
  }).catch(() => {});
  safe(() => window.RemoteUI?.init?.());

  const saved = await savedP;
  if (saved.length) {
    // the backlog decides which routed tabs come back 完了 (below); its load is one IPC (bounded, the tabs come anyway)
    if (saved.some((s) => (s.forBacklog && !s.rest) || s.quietAt)) await Promise.race([Promise.resolve(backlogLoaded).catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
    for (const s of saved) {
      // a resting tab (rest) comes back resting: its claude starts when the tab is opened (PROGRESS 35 / 31). So does a
      // routed tab whose item ended with 作業完了 and that was not used since, though it was not stopped yet (or was
      // stopped from outside before PROGRESS 42 and saved as exited): a restart does not wake finished work (42)
      let rest = s.rest || null;
      if (!rest && doneStopMs() > 0 && safe(() => finishedItemOf({ id: s.id, forBacklog: !!s.forBacklog }, s.usedAt || 0), null)) rest = 'done';
      // AT-autoclose: a tab that was already unneeded when the app stopped does not come back (as autoCloseTick would
      // have closed it): before, such tabs were resumed by every restart and held the next update restart
      // AT-149 QA 1 (既にできたものも閉じる): a routed tab whose routed item is still pending (never sent: backlogSend makes
      // it active first) was left by an older version or by a stop between startRouted and the send. Its claude has no
      // work: it does not come back, and the item goes back to the queue (a new session takes it, as backlogSweep does).
      const stalePending = s.forBacklog && info.role !== 'manager' ? safe(() => staleRoutedPending(s.id), []) : [];
      if (stalePending.length) {
        console.log('[auto-close]', s.id, 'not restored (pending item', stalePending.join(', ') + ')');
        for (const itId of stalePending) safe(() => window.Backlog.unassign(itId));
        if (composerStore.drafts?.[s.id]) {
          delete composerStore.drafts[s.id];
          saveComposerStore();
        }
        safe(() => rememberViewMode(s.id, null, false));
        continue;
      }
      if (!s.asking && safe(() => autoCloseDue({ id: s.id, forBacklog: !!s.forBacklog }, s.quietAt || 0, Date.now()), null)) {
        console.log('[auto-close]', s.id, 'not restored');
        if (composerStore.drafts?.[s.id]) {
          delete composerStore.drafts[s.id];
          saveComposerStore();
        }
        safe(() => rememberViewMode(s.id, null, false));
        continue;
      }
      createTab({ id: s.id, mode: 'resume', cwd: s.cwd, worktree: s.worktree || null, team: !!s.team, delegate: !!s.delegate, model: s.model || null, effort: s.effort || null, forBacklog: !!s.forBacklog, label: s.label, manualLabel: !!s.manualLabel, rest, usedAt: s.usedAt || 0, quietAt: s.quietAt || 0, asking: !!s.asking });
    }
    activate((saved.find((s) => tabs.has(s.id)) || saved[0]).id);
  } else if (info.role === 'manager' || info.temp) {
    // the manager window's resident session (the PMO); a temp / edit window (made to run claude there)
    createTab();
  }
  // AT-139: a project window with nothing to restore starts no claude: the empty screen, and when the app was started
  // with it (not a folder opened later from the picker, not a hidden window opened for routed work) the dashboard comes
  // up, where the user asks for work. A window opened hidden for a routed item gets its session from that item.
  const startEmpty = !tabs.size && info.role !== 'manager';
  restoreDone = true;
  if (startEmpty && info.launch && !info.hidden) safe(() => api.dashboardOpen?.());
  if (saved.length) saveSessions(); // a routed tab restored 完了 above stays resting in sessions.json (42)
  // the dashboard's 「会話を開く」 for a closed 完了 session of this folder (PROGRESS 49): asked before / after this point
  api.onSessionOpenPending?.(() => takeOpenRequests());
  takeOpenRequests();
  // Manager window: the dashboard panels (after the tabs exist, so they sit next to the session pane).
  if (info.role === 'manager') {
    // own / restart: the resident session's memory and 再起動 in the dashboard header (roadmap 22). Same tab id
    // after a restart, so the backlog items routed to it (backlogAssignNew) stay attached.
    const resident = residentTab;
    safe(() => window.Dashboard?.init?.({
      api,
      exclude: info.workDir,
      root: document.getElementById('dashboard'),
      own: () => {
        const t = resident();
        return t ? { memMb: t.memMb ?? null, heavy: memHeavy(t), status: restartBusy(t).length ? 'running' : t.status } : null;
      },
      restart: () => {
        const t = resident();
        if (t) restartTab(t);
      },
    }));
    ensureDashboardPanels();
    if (pmoFocusWanted) setTimeout(() => focusPmo(), 300); // 「PMO に相談」 arrived while the window was starting
  }
  // Drafts of sessions that did not come back (closed elsewhere, transcript gone) are dropped.
  let pruned = false;
  for (const id of Object.keys(composerStore.drafts || {})) {
    if (!tabs.has(id)) {
      delete composerStore.drafts[id];
      pruned = true;
    }
  }
  if (pruned) saveComposerStore();
  // Conversation panels restored with the layout whose session is no longer open.
  for (const tabId of [...convPanels.keys()]) if (!tabs.has(tabId)) closeConvPanel(tabId);
  applyLayout();
  saveSessions();
  updateTitle();
}

init();

// ---- automatic restart after a release (src/main/autorestart.js) --------------------------
// state 'pending' = the update is reserved: the queue holds (updateHolds), running items go on; the restart comes when
// nothing runs, or (after the hold limit / 今すぐ更新) at a turn gap with resume = true: the running items are marked
// so that they continue in the same tab after the restart (backlogResumeTick) instead of starting over.
function showUpdate(st) {
  appUpdate = st && typeof st === 'object' ? st : { state: 'none' };
  const el = document.getElementById('update-note');
  const s = appUpdate.state;
  if (s === 'restarting' && appUpdate.resume && safe(() => window.Backlog?.markResume?.(), 0)) safe(() => api.backlogSaveSync?.(window.Backlog.state()));
  safe(() => window.Backlog?.setHold?.(updateHolds() ? updateHoldText() : null));
  safe(() => window.Dashboard?.setUpdate?.(appUpdate));
  if (!el) return;
  // UIUX U4: hidden by default (the update is in「PMO の記録」); ⚙ 設定 →「更新の帯を出す」shows it. The restart itself always shows.
  const bar = safe(() => window.Notify?.settings?.().showUpdateBar === true, false);
  el.hidden = s === 'none' || !s || (s !== 'restarting' && !bar);
  const until = appUpdate.deadline ? new Date(appUpdate.deadline).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '';
  el.textContent =
    s === 'restarting' ? '再起動中…'
      : s === 'postponed' ? '新しい版あり'
        : appUpdate.force ? '更新待ち（ターンの合間）'
          : until ? `更新待ち（${until} まで）` : '更新待ち';
  el.title = s === 'restarting'
    ? '新しい版で再起動しています'
    : s === 'postponed'
      ? '新しい版があります。ダッシュボードの「今すぐ更新」で更新します'
      : '新しい版が入りました。新しい作業は再起動の後に始めます。実行中の作業が終わると再起動し、タブは続きから戻ります。' +
        `${until ? `\n${until} を過ぎても終わらなければ、ターンの合間で再起動し、実行中の作業は同じ会話の続きで再開します。` : ''}`;
}
api.onAppUpdate?.(showUpdate);
// ⚙ 設定 →「更新の帯を出す」: redraw the note (not while restarting: showUpdate marks the resume then)
window.addEventListener('bantodesk:update-bar', () => appUpdate.state !== 'restarting' && showUpdate(appUpdate));
Promise.resolve(safe(() => api.updateState?.(), null)).then((st) => st && st.state !== 'none' && appUpdate.state === 'none' && showUpdate(st)).catch(() => {});

// A hidden window (opened for routed work) that the user brings up with no session shows the empty screen
// (noTabsCard) instead of starting claude by itself (AT-139).
