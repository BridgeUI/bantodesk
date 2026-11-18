// Tray icon + every window's session state (roadmap 10 / 20 stage 2; docs/plan-temp-widget.md, docs/plan-dashboard.md).
// UIUX U5 (docs/concept-uiux.md §4): the always-on widget window on the right edge is gone (its page src/widget/ and
// src/widget-preload.js were removed; what only it had is in the dashboard, docs/plan-temp-widget.md 「U5」). Left here:
// the tray icon (the menu bar on macOS), created at app start, whose number and dot are あなたの番 (main's attention list,
// setAttention), and main's copy of every window's tab states that the dashboard draws (dashboard:sessions) and main's
// checks read (sessionsSnapshot). The tray does not keep the app alive (main's quit rule counts visible windows).
//
// Data: every project / manager window already sends `remote:state { tabs: TabState[] }` (debounced by the
// renderer). This module keeps its own copy per window (remote.js is not touched) and sends a condensed
// `dashboard:sessions WidgetState` to the manager windows (throttled 250 ms). See CONTRACT.md "Widget / tray".
const path = require('path');
const zlib = require('zlib');
const stuck = require('./stuck');

const THROTTLE_MS = 250;
const OPEN_INBOX = new Set(['new', 'asking', 'routed']);
const ATTN = new Set(['input', 'error', 'done']);
const ATTN_PRIORITY = { input: 3, error: 2, done: 1 };

const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);

// --- pure helpers (exported for tests) ---------------------------------------------------

// One TabState (as sent by the renderer, incl. `unread`) -> widget session, or null when unusable.
function sessionOf(win, t, waits = null) {
  if (!t || typeof t !== 'object' || t.id == null) return null;
  const tabId = str(t.id, 100);
  if (!tabId) return null;
  const status = str(t.status, 20);
  const unread = t.unread && typeof t.unread === 'object' && ATTN.has(t.unread.kind) ? t.unread : null;
  const working = t.working === true; // 依頼-524: turn over but a background command / subagent / member runs
  // a 'done' notice is stale while work goes on (an 'input' / 'error' one is not)
  const attention = unread && !(working && unread.kind === 'done') ? unread.kind : status === 'asking' ? 'input' : null;
  const choices = t.choices && typeof t.choices === 'object' && Array.isArray(t.choices.options) ? t.choices : null;
  const question = choices ? str(choices.question, 500) : '';
  const options = choices
    ? choices.options
        .filter((o) => o && Number.isInteger(Number(o.n)) && Number(o.n) >= 1 && Number(o.n) <= 9)
        .slice(0, 9)
        .map((o) => ({ n: Number(o.n), label: str(o.label, 200) }))
    : [];
  const at = unread && Number.isFinite(unread.at) ? unread.at : Number.isFinite(t.updatedAt) ? t.updatedAt : null;
  return {
    wcId: win.wcId,
    tabId,
    folder: win.workDir || '',
    folderName: win.role === 'manager' ? 'ダッシュボード' : path.basename(win.workDir || '') || win.workDir || '',
    label: str(t.label, 200),
    status,
    // 'done' = 完了: the app stopped its claude after its routed item ended with 作業完了 (PROGRESS 35); 'idle' = 休止中 (31).
    // Shown apart from 待機中 and not counted as a session (dashboard, widget, エージェント tab).
    rest: t.rest === 'done' || t.rest === 'idle' ? t.rest : null,
    // ended with 作業完了 (renderer doneMarkAt; its claude may not be stopped yet): shown as 完了, never as 待機中 /
    // 待ちが長い / エラー (PROGRESS 50)
    finished: Number.isFinite(t.doneAt) && t.doneAt > 0 && status !== 'asking' && status !== 'running' && !working,
    working,
    attention,
    text: str(unread && unread.text ? unread.text : question, 500),
    question,
    options,
    // the dialog's key (answers from the dashboard are sent only while the same dialog shows) and whether it is of a
    // kind the manager may never press (delete, secrets …: red, confirm before pressing). stuck.js
    promptKey: status === 'asking' && t.prompt && typeof t.prompt.key === 'string' ? str(t.prompt.key, 40) : '',
    danger: status === 'asking' ? stuck.dangerOf(stuck.promptOf(t)) : '',
    at,
    // UX12: the last transcript event (renderer tab.eventAt, 10 s rounded): the row's 「最後の動き」
    eventAt: Number.isFinite(t.eventAt) && t.eventAt > 0 ? t.eventAt : 0,
    // session memory (renderer's pty:mem figure) and whether it is over the user's mark (roadmap 22)
    memMb: Number.isFinite(t.memMb) && t.memMb >= 0 ? Math.round(t.memMb) : null,
    memHeavy: t.memHeavy === true,
    // the dashboard's エージェント tab (roadmap 13, docs/plan-agents-view.md)
    model: str(t.model, 60),
    contextPct: Number.isFinite(t.contextPct) && t.contextPct >= 0 ? Math.round(t.contextPct) : null,
    costUsd: Number.isFinite(t.costUsd) && t.costUsd >= 0 ? Math.round(t.costUsd * 100) / 100 : null,
    doing: doingOf(t.todos),
    agents: agentsOf(t.agents),
    // 関係図 (agents-view.js, 依頼-481): the tab's background commands from its transcript (Panel.summary cmds)
    cmds: cmdsOf(t.cmds),
    // what an idle / asking session waits for (src/main/waits.js Wait, set by main's checkWaits) | null
    wait: (waits && waits.get(`${win.wcId}:${tabId}`)) || null,
  };
}

const AGENT_ST = new Set(['running', 'starting', 'idle', 'done', 'error']);
const AGENT_ID = /^[A-Za-z0-9_-]{1,100}$/;

// The in-progress todo of a tab (its current piece of work), '' when none.
function doingOf(todos) {
  const t = Array.isArray(todos) ? todos.find((x) => x && x.status === 'in_progress') : null;
  return t ? str(t.text, 160) : '';
}

// TabState.agents (renderer.js agentsOf) -> { subagents: ≤30, team: { name, removed, members: ≤20 } | null } | null
function agentsOf(a) {
  if (!a || typeof a !== 'object') return null;
  const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  const id = (v) => (typeof v === 'string' && AGENT_ID.test(v) ? v : null);
  const st = (v) => (AGENT_ST.has(v) ? v : 'running');
  const tool = (x) => (x && typeof x === 'object' ? { name: str(x.name, 40), arg: str(x.arg, 80) } : null);
  const objs = (v, max) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object').slice(0, max) : []);
  const subagents = objs(a.subagents, 30).map((x) => ({
    agentId: id(x.agentId),
    agentType: str(x.agentType, 60),
    description: str(x.description, 200),
    teamName: str(x.teamName, 60),
    status: st(x.status),
    lastTool: tool(x.lastTool),
    tokens: num(x.tokens),
    startedAt: num(x.startedAt),
    updatedAt: num(x.updatedAt),
  }));
  const tm = a.team && typeof a.team === 'object' ? a.team : null;
  const team = tm
    ? {
        name: str(tm.name, 80),
        removed: tm.removed === true,
        members: objs(tm.members, 20)
          .filter((m) => typeof m.name === 'string' && m.name)
          .map((m) => ({
            name: str(m.name, 60),
            agentId: id(m.agentId),
            agentType: str(m.agentType, 60),
            color: str(m.color, 20),
            status: st(m.status),
            summary: str(m.summary, 160),
            lastTool: tool(m.lastTool),
            tokens: num(m.tokens),
            updatedAt: num(m.updatedAt),
          })),
      }
    : null;
  if (!subagents.length && !team) return null;
  return { subagents, team };
}

const CMD_ST = new Set(['running', 'completed', 'failed', 'killed', 'stopped', 'exited']);
// TabState.cmds -> [{ id, command, startedAt, endedAt, status }] (≤ 8); [] when none
function cmdsOf(list) {
  const n = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && typeof c === 'object' && typeof c.id === 'string' && c.id)
    .slice(-8)
    .map((c) => ({ id: str(c.id, 60), command: str(c.command, 300), startedAt: n(c.startedAt), endedAt: n(c.endedAt), status: CMD_ST.has(c.status) ? c.status : c.endedAt ? 'completed' : 'running' }));
}

// 「ルーターから」 notices (src/main/notices.js) -> the unread warn / proposal ones for the widget (newest first, ≤ 5 listed).
function noticesOf(list) {
  const want = (Array.isArray(list) ? list : []).filter((n) => n && !n.readAt && (n.kind === 'warn' || n.kind === 'proposal'));
  return {
    unread: want.length,
    items: want.slice(0, 5).map((n) => ({ id: str(n.id, 40), kind: n.kind, title: str(n.title, 200), at: Number.isFinite(n.updatedAt) ? n.updatedAt : null })),
  };
}

// windows: [{ wcId, workDir, role }], tabsByWc: Map<wcId, TabState[]>, inboxItems: InboxItem[], now, notices: Notice[]
// -> WidgetState
function buildState(windows, tabsByWc, inboxItems, now = Date.now(), notices = [], waits = waitsByKey) {
  const sessions = [];
  for (const w of windows) {
    for (const t of tabsByWc.get(w.wcId) || []) {
      const s = sessionOf(w, t, waits);
      if (s) sessions.push(s);
    }
  }
  sessions.sort((a, b) => (ATTN_PRIORITY[b.attention] || 0) - (ATTN_PRIORITY[a.attention] || 0) || (b.at || 0) - (a.at || 0));
  const items = Array.isArray(inboxItems) ? inboxItems : [];
  return {
    sessions: sessions.slice(0, 200),
    inbox: {
      open: items.filter((i) => i && OPEN_INBOX.has(i.status)).length,
      asking: items.filter((i) => i && i.status === 'asking').length,
    },
    notices: noticesOf(notices),
    updatedAt: now,
  };
}

// Minimal RGBA PNG encoder (tray icons are generated at runtime, no asset files).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const DOT_COLORS = { input: '#f9e2af', error: '#f38ba8' };

// size px icon: a Catppuccin-blue disc with a lighter core; dot: 'input' | 'error' | null adds a coloured
// dot (with a dark ring) in the lower right. -> PNG Buffer
// mono (UX1, macOS menu bar): a template image, black and transparent only (macOS tints it for a light / dark menu bar):
// the disc with the core cut out, the dot filled and its ring cut out (the count is the title next to it, setTrayTitle)
function iconPng(size, dot = null, mono = false) {
  const px = Buffer.alloc(size * size * 4);
  const blue = hex('#89b4fa');
  const core = hex('#b4befe');
  const ring = hex('#11111b');
  const dotC = DOT_COLORS[dot] ? hex(DOT_COLORS[dot]) : null;
  const S = 4; // supersampling per axis
  const cx = size / 2;
  const r = size * 0.44;
  const rc = size * 0.17;
  const dx = size * 0.74;
  const dr = size * 0.24;
  const dring = dr + size * 0.07;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let R = 0, G = 0, B = 0, A = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const fx = x + (sx + 0.5) / S;
          const fy = y + (sy + 0.5) / S;
          let c = null;
          const dd = Math.hypot(fx - dx, fy - dx);
          if (dotC && dd <= dr) c = dotC;
          else if (dotC && dd <= dring) c = ring;
          else {
            const d = Math.hypot(fx - cx, fy - cx);
            if (d <= rc) c = core;
            else if (d <= r) c = blue;
          }
          if (c && mono) c = c === core || c === ring ? null : [0, 0, 0];
          if (c) {
            R += c[0];
            G += c[1];
            B += c[2];
            A += 1;
          }
        }
      }
      const i = (y * size + x) * 4;
      if (A) {
        px[i] = Math.round(R / A);
        px[i + 1] = Math.round(G / A);
        px[i + 2] = Math.round(B / A);
        px[i + 3] = Math.round((A / (S * S)) * 255);
      }
    }
  }
  return encodePng(size, px);
}

// --- runtime --------------------------------------------------------------------------------

let ctx = null; // init() options
let waitsByKey = new Map(); // `${wcId}:${tabId}` -> Wait (main's checkWaits, setWaits)
let electron = null;
let tray = null;
let started = false;
const tabsByWc = new Map(); // wcId -> raw TabState[] (as received)
let lastObj = null; // last built WidgetState
let timer = null;
let lastSent = 0;
let iconCache = {};
let iconKind = undefined;
// あなたの番 (UIUX U3, main's attention list): what the tray counts and colours (U5). setAttention(items).
let attnCount = 0;
let attnDanger = false;
// the tray tooltip / menu-bar title last set (docs/perf.md 第 3 段, 案 7): setToolTip ran on every widget state send even when
// the text was the same (2,358 times in 12 min, up to 206 ms in main); now only when it changes
let trayTip = null;
let trayTitle = null;
let menuCount = null; // the あなたの番 count the tray menu was built with
function setTrayTip(text) {
  if (text === trayTip) return;
  trayTip = text;
  tray.setToolTip(text);
}
// macOS: the number next to the icon in the menu bar ('' = none)
function setTrayTitle(text) {
  if (process.platform !== 'darwin' || typeof tray.setTitle !== 'function' || text === trayTitle) return;
  trayTitle = text;
  tray.setTitle(text);
}

const listWindows = () => {
  try {
    return (ctx.listWindows() || []).filter((w) => w && w.win && !w.win.isDestroyed());
  } catch {
    return [];
  }
};
// The dashboard (manager window) gets the state and may focus / answer sessions.
const managerWindows = () => listWindows().filter((w) => w.role === 'manager');
const isManager = (e) => !!e && managerWindows().some((w) => w.wcId === e.sender.id);
let answerSeq = 0;
const answerWaits = new Map(); // reqId -> { wcId, resolve } (dashboard:answer waiting for remote:answerResult)
let lastDash = null; // JSON last sent to the manager windows
let dashFresh = false; // a manager window (re)loaded: resend

// --- tray -----------------------------------------------------------------------------------

function trayIcon(kind) {
  if (iconCache[kind || 'none']) return iconCache[kind || 'none'];
  const { nativeImage } = electron;
  const mono = process.platform === 'darwin';
  const img = nativeImage.createFromBuffer(iconPng(16, kind, mono), { scaleFactor: 1 });
  img.addRepresentation({ scaleFactor: 2, buffer: iconPng(32, kind, mono) });
  img.addRepresentation({ scaleFactor: 1.5, buffer: iconPng(24, kind, mono) });
  if (mono && typeof img.setTemplateImage === 'function') img.setTemplateImage(true);
  iconCache[kind || 'none'] = img;
  return img;
}

function createTray() {
  const { Tray } = electron;
  tray = new Tray(trayIcon(null));
  iconKind = null;
  trayTip = null;
  trayTitle = null;
  setTrayTip(`BantoDesk${ctx.isDev ? ' [DEV]' : ''}`);
  // Windows / Linux: a click opens the dashboard, the right click the menu. macOS (menu bar): a click shows the menu.
  if (process.platform !== 'darwin') tray.on('click', () => ctx.openDashboard());
  updateTrayMenu();
}

function trayTemplate() {
  const n = attnCount;
  return [
    { label: n ? `要対応 ${n} 件` : '要対応 なし', enabled: n > 0, click: () => openWaiting() },
    { type: 'separator' },
    { label: 'ダッシュボードを開く', click: () => ctx.openDashboard() },
    { label: 'ルーターに相談', click: () => consultPmo() },
    { label: '新しいセッション…', click: () => newSession() },
    { type: 'separator' },
    { label: '終了', click: () => ctx.app.quit() },
  ];
}
function updateTrayMenu() {
  if (!tray || tray.isDestroyed() || typeof tray.setContextMenu !== 'function' || !electron || !electron.Menu) return;
  const { Menu } = electron;
  menuCount = attnCount;
  tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
}

// Sends `channel` to the dashboard once it exists and has loaded (it may be created / loading right now).
// ready: the renderer answers the channel only after its init (it re-sends itself until then, see dashboard:focusPmo).
function tellDashboard(channel) {
  let tries = 0;
  const tell = () => {
    const ms = managerWindows().filter((m) => !m.win.isDestroyed() && !m.win.webContents.isLoading());
    if (ms.length) ms.forEach((m) => m.win.webContents.send(channel));
    else if (++tries < 40) setTimeout(tell, 300); // the dashboard is still being created / loaded
  };
  setTimeout(tell, 100);
}

// 「ルーターに相談」 (tray; PROGRESS 45): opens the dashboard and puts the caret in the ルーター's input box.
function consultPmo() {
  ctx.openDashboard();
  tellDashboard('dashboard:focusPmo');
}
// 「新しいセッション…」 (tray, U5): the dashboard with its 新しいセッション panel open (folders, temp / edit sessions).
function newSession() {
  ctx.openDashboard();
  tellDashboard('dashboard:newSession');
}
// 「あなたの番 N 件」 (tray, U5): the dashboard on its あなたの番 tab.
function openWaiting() {
  ctx.openDashboard();
  tellDashboard('dashboard:showWaiting');
}

// Tray (U5): あなたの番 (main's attention list) is the number and the dot: yellow while there is something to decide, red when
// one of them is a confirmation the ルーター may not press (danger). The tooltip adds what runs and what ended.
function updateTray(state) {
  if (!tray || tray.isDestroyed()) return;
  const n = attnCount;
  const kind = n ? (attnDanger ? 'error' : 'input') : null;
  if (kind !== iconKind) {
    tray.setImage(trayIcon(kind));
    iconKind = kind;
  }
  const sessions = (state && state.sessions) || [];
  const running = sessions.filter((s) => (s.status === 'running' || s.status === 'starting' || s.working) && !s.finished).length;
  const done = sessions.filter((s) => s.attention === 'done' || (s.rest === 'done' && !s.attention) || (s.finished && s.attention !== 'input')).length;
  const open = state && state.inbox ? state.inbox.open : 0;
  const extra = [running ? `動作中 ${running}` : '', done ? `完了 ${done}` : '', open ? `依頼 ${open}` : ''].filter(Boolean).join(' / ');
  setTrayTip(`BantoDesk${ctx.isDev ? ' [DEV]' : ''} — 要対応 ${n}${extra ? ` / ${extra}` : ''}`.slice(0, 127));
  setTrayTitle(n ? String(n) : '');
  if (menuCount !== n) updateTrayMenu();
}

// --- state ----------------------------------------------------------------------------------

function currentNotices() {
  try {
    return (ctx.getNotices && ctx.getNotices()) || [];
  } catch {
    return [];
  }
}
function currentInbox() {
  try {
    return (ctx.getInbox() || {}).items || [];
  } catch {
    return [];
  }
}
const currentState = () => buildState(
  listWindows().map((w) => ({ wcId: w.wcId, workDir: w.workDir, role: w.role })),
  tabsByWc,
  currentInbox(),
  Date.now(),
  currentNotices(),
);

function flush() {
  timer = null;
  lastSent = Date.now();
  const state = currentState();
  lastObj = state;
  updateTray(state);
  const json = JSON.stringify({ ...state, updatedAt: 0 });
  if (json !== lastDash || dashFresh) {
    lastDash = json;
    dashFresh = false;
    for (const w of managerWindows()) if (!w.win.webContents.isLoading()) w.win.webContents.send('dashboard:sessions', state);
  }
}

function schedule() {
  if (!ctx || timer) return;
  timer = setTimeout(flush, Math.max(0, lastSent + THROTTLE_MS - Date.now()));
}

// --- public API -----------------------------------------------------------------------------

const OPEN_FROM = new Set(require('./usage-ids').OPEN_FROM);
// o: { app, ipcMain, isDev, listWindows: () => [{ wcId, workDir, win, role }], getInbox: () => { items }, getNotices?: () => Notice[],
//      openDashboard(), focusTab(wcId, tabId, kind, member?, from?, mode?), isQuitting(): boolean }
// Registers the IPC listeners; the tray appears on start().
function init(o) {
  ctx = o;
  electron = require('electron');
  const { ipcMain } = o;
  // Our own copy of every window's tab states (remote.js keeps its own; pick() there drops `unread`).
  ipcMain.on('remote:state', (e, payload) => {
    const wcId = e.sender.id;
    if (!listWindows().some((w) => w.wcId === wcId)) return;
    const tabs = payload && Array.isArray(payload.tabs) ? payload.tabs.filter((t) => t && typeof t === 'object' && t.id != null).slice(0, 50) : [];
    tabsByWc.set(wcId, tabs);
    schedule();
  });
  const target = (wcId) => listWindows().find((w) => w.wcId === wcId) || null;
  const hasTab = (wcId, tabId) => (tabsByWc.get(wcId) || []).some((t) => String(t.id) === tabId);
  ipcMain.handle('dashboard:sessions', (e) => {
    if (!isManager(e)) return null;
    dashFresh = true; // later pushes resend even if unchanged
    return currentState();
  });
  // the dashboard's session rows (the channel names are from the widget, removed in U5)
  ipcMain.on('widget:focus', (e, a) => {
    if (!isManager(e) || !a || typeof a.tabId !== 'string') return;
    const w = target(a.wcId);
    if (!w || !hasTab(w.wcId, a.tabId)) return;
    const s = lastObj ? lastObj.sessions.find((x) => x.wcId === w.wcId && x.tabId === a.tabId) : null;
    // { agentId, name }: also open that member / subagent's read-only conversation (dashboard エージェント tab, roadmap 13)
    const member = typeof a.agentId === 'string' && AGENT_ID.test(a.agentId) ? { agentId: a.agentId, name: str(a.name, 60) } : null;
    // UA1: where the dashboard opened it from (usage record open.from.<from>; only the listed words)
    const from = OPEN_FROM.has(a.from) ? a.from : 'project';
    // UX14: 'term' / 'split' = ターミナル / 並べる in the workbench (the home's session view)
    const mode = a.mode === 'term' || a.mode === 'split' ? a.mode : null;
    ctx.focusTab(w.wcId, a.tabId, s ? s.attention : null, member, from, mode);
  });
  ipcMain.on('widget:choose', (e, a) => {
    if (!isManager(e) || !a || typeof a.tabId !== 'string') return;
    const n = Number(a.n);
    if (!Number.isInteger(n) || n < 1 || n > 9) return;
    const w = target(a.wcId);
    if (!w || !hasTab(w.wcId, a.tabId)) return;
    w.win.webContents.send('remote:action', { tabId: a.tabId, type: 'choice', value: n });
  });
  // The dashboard's 確認待ち list (docs/plan-dashboard.md): full dialogs (context, multi-select state, screen tail).
  ipcMain.handle('dashboard:waiting', (e) => {
    if (!isManager(e)) return null;
    return { sessions: stuck.userList(sessionsSnapshot()) };
  });
  // The user's answer from that list: checked here against the last state (promptKey), then once more by the
  // tab's window against its screen right now; the window reports back (remote:answerResult).
  ipcMain.handle('dashboard:answer', async (e, a) => {
    if (!isManager(e)) return { error: 'not allowed' };
    const c = stuck.checkUserAnswer(a, stuck.userList(sessionsSnapshot()));
    if (c.error) return c;
    const w = target(c.entry.wcId);
    if (!w) return { error: 'そのウィンドウはもう閉じています', changed: true };
    const reqId = `a${++answerSeq}`;
    const res = new Promise((resolve) => {
      const timer = setTimeout(() => {
        answerWaits.delete(reqId);
        resolve({ error: 'ウィンドウから応答がありません（送られたかどうか、タブを開いて確かめてください）' });
      }, 5000);
      answerWaits.set(reqId, { wcId: w.wcId, resolve: (r) => (clearTimeout(timer), resolve(r)) });
    });
    w.win.webContents.send('remote:action', { tabId: c.entry.tabId, type: 'userAnswer', reqId, promptKey: c.entry.prompt.key, ...c.action });
    return res;
  });
  ipcMain.on('remote:answerResult', (e, r) => {
    const wait = r && typeof r.reqId === 'string' ? answerWaits.get(r.reqId) : null;
    if (!wait || wait.wcId !== e.sender.id) return;
    answerWaits.delete(r.reqId);
    wait.resolve(r.ok === true ? { ok: true } : { error: str(r.error, 200) || '送れませんでした', changed: r.changed === true });
  });
  // 再起動 of a heavy session from the dashboard: the owning window refuses while the session is busy.
  ipcMain.on('dashboard:restart', (e, a) => {
    if (!isManager(e) || !a || typeof a.tabId !== 'string') return;
    const w = target(a.wcId);
    if (!w || !hasTab(w.wcId, a.tabId)) return;
    w.win.webContents.send('remote:action', { tabId: a.tabId, type: 'restart' });
  });
  // 休止 of a session from the dashboard (PROGRESS 31): the owning window refuses while the session works.
  ipcMain.on('dashboard:rest', (e, a) => {
    if (!isManager(e) || !a || typeof a.tabId !== 'string') return;
    const w = target(a.wcId);
    if (!w || !hasTab(w.wcId, a.tabId)) return;
    w.win.webContents.send('remote:action', { tabId: a.tabId, type: 'rest' });
  });
}

// At app start (U5; before: after the first project window): create the tray once. Env AGENT_TERMINAL_NO_WIDGET=1 disables
// it (tests; the name is from the removed widget).
function start() {
  if (started || !ctx || process.env.AGENT_TERMINAL_NO_WIDGET === '1') return;
  started = true;
  try {
    createTray();
  } catch (err) {
    console.warn('[widget] tray failed', err);
  }
  schedule();
}

// Something changed outside remote:state (window closed, inbox changed).
function windowClosed(wcId) {
  tabsByWc.delete(wcId);
  schedule();
}
const changed = () => schedule();

// main's あなたの番 list changed (AttnItem[]): the tray's number and dot follow it.
function setAttention(items) {
  const list = Array.isArray(items) ? items : [];
  const n = list.length;
  const danger = list.some((i) => i && i.kind === 'confirm' && !!(i.danger || (i.entry && i.entry.danger)));
  if (n === attnCount && danger === attnDanger) return;
  attnCount = n;
  attnDanger = danger;
  updateTray(lastObj || currentState());
}

function destroy() {
  clearTimeout(timer);
  timer = null;
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

// Every window's last TabState list (roadmap 27: stuck prompts for the manager). -> [{ wcId, workDir, role, t }]
function sessionsSnapshot() {
  if (!ctx) return [];
  const out = [];
  for (const w of listWindows()) {
    let hidden = false;
    try {
      hidden = !w.win.isVisible();
    } catch {}
    for (const t of tabsByWc.get(w.wcId) || []) out.push({ wcId: w.wcId, workDir: w.workDir, role: w.role, hidden, t });
  }
  return out;
}
// entries = [{ wcId, tabKey, wait }] from main's checkWaits: shown with each session (dashboard)
function setWaits(entries) {
  const next = new Map();
  for (const e of entries || []) if (e && e.wait) next.set(`${e.wcId}:${e.tabKey}`, e.wait);
  waitsByKey = next;
  schedule();
}
// Sends a remote:action to the tab's window (the answer action). -> true when the window is there
function sendAction(wcId, action) {
  const w = ctx ? listWindows().find((x) => x.wcId === wcId) : null;
  if (!w || !w.win || w.win.isDestroyed()) return false;
  w.win.webContents.send('remote:action', action);
  return true;
}

module.exports = {
  init,
  sessionsSnapshot,
  // 全体図 (overview.js): the dashboard's session list as it is now
  currentSessions: () => currentState().sessions,
  // UX13 (oneview.js): the window has that tab (a resting tab has no pty but is still that window's)
  hasTab: (wcId, tabId) => (tabsByWc.get(wcId) || []).some((t) => String(t.id) === tabId),
  sendAction,
  setWaits,
  setAttention,
  start,
  windowClosed,
  changed,
  destroy,
  // internal, for tests
  _trayTemplate: () => trayTemplate(),
  _buildState: buildState,
  _sessionOf: sessionOf,
  _agentsOf: agentsOf,
  _cmdsOf: cmdsOf,
  _iconPng: iconPng,
  _encodePng: encodePng, // src/main/winicon.js (the dashboard window icon)
  _tray: () => tray,
  // tmp/perf3/unit.js, tmp/no-widget/unit.js: a fake tray (setImage / setToolTip / setTitle? / setContextMenu? / isDestroyed)
  // and ctx ({ isDev, … })
  _useTray: (t, c) => {
    tray = t;
    trayTip = null;
    trayTitle = null;
    iconKind = null;
    menuCount = null;
    if (c) ctx = c;
  },
  _updateTray: (state) => updateTray(state),
};
