const { app, BrowserWindow, ipcMain, Menu, dialog, Notification, shell, powerSaveBlocker, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
// UX6: record every invoke handler from here on (dashboard:snapshot runs the read-only ones in one invoke)
const dashSnapshot = require('./main/snapshot').create();
dashSnapshot.record(ipcMain);

// SEC2 (docs/security.md): remote debugging only in an app a test started (the e2e mark) and only
// on 127.0.0.1. Anything else quits before a window or a session starts; the reason goes to <userData>\logs\security-guard.log.
{
  const why = require('./main/e2e').remoteDebugProblem(process.argv, process.env, app.commandLine);
  if (why) {
    const line = `${new Date().toISOString()} quit: ${why} (pid ${process.pid})\n`;
    console.error('[security] ' + line.trim());
    try {
      const dir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'security-guard.log'), line);
    } catch {}
    app.exit(3);
    process.exit(3);
  }
  // an app a test started quits when that test is gone (no orphaned test apps in the Dock; src/main/e2e.js)
  require('./main/e2e').watchParent(app);
}

// BN3 (docs/naming.md 3.3): userData <appData>/bantodesk[-dev] gets a copy of <appData>/agent-terminal[-dev] on its first
// start (the old place is kept). Before anything below reads userData (src/main/migrate-userdata.js).
try {
  require('./main/migrate-userdata').migrate({ userData: app.getPath('userData'), log: (m) => console.log(m) });
} catch (err) {
  console.warn('[main] userData migration failed', err && err.message);
}

// PROGRESS 32: setting "GPU を使わない" (<userData>/app-settings.json, src/main/appsettings.js). It has to be applied
// before 'ready', so it takes effect from the next start; gpuAtStart is what this start runs with.
const appSettings = require('./main/appsettings');
let gpuAtStart = { disableGpu: false };
try {
  gpuAtStart = appSettings.applyEarly(app, app.getPath('userData'));
} catch (err) {
  console.warn('[main] app-settings.json not applied', err && err.message);
}

const ptyProxy = require('./main/ptyproxy'); // node-pty in the pty host (utilityProcess), off the main thread (docs/perf.md 案 1)
// 52b-mac: every chokidar watcher (transcripts, teams, outbox, viewers) is remembered and closed in will-quit; an
// fsevents watch left open when Electron frees the Node environment ends the app with SIGABRT (src/main/watchers.js)
const fileWatchers = require('./main/watchers').track(require('chokidar'));
const { waitThenQuit } = require('./main/quitwait');
const chokidar = fileWatchers.chokidar;
const transcript = require('./main/transcript');
const oneview = require('./main/oneview'); // UX13: the main window's session view (relay)
const workbench = require('./main/workbench'); // UX14: when a folder window (the workbench) shows
const sessions = require('./main/sessions');
const gitTools = require('./main/git');
const teams = require('./main/teams');
const autorestart = require('./main/autorestart');
const layouts = require('./main/layouts');
const writeq = require('./main/writeq'); // perf2: per-file async write queue (flushed on will-quit)
const usageMod = require('./main/usage'); // UA1: usage records on this PC only
const usageReport = require('./main/usage-report'); // UA2: the summary (settings 使い方) and the report in the manager folder
const { timebox, TIMED_OUT, limits: timeboxLimits } = require('./main/timebox'); // AT-202: time limits for snapshot steps
const backlog = require('./main/backlog');
const samesave = require('./main/samesave'); // UX6 / J2: drop a window's backlog save with unchanged content
const files = require('./main/files');
const claudeCmd = require('./main/claude-cmd');
const models = require('./main/models');
const leanPref = require('./main/lean-pref'); // TK3
const inboxStore = require('./main/inbox');
const qaStore = require('./main/qa');
const manager = require('./main/manager');
const propose = require('./main/propose');
const review = require('./main/review'); // UIUX U8: the review when a folder's work is over
const pmo = require('./main/pmo');
const noticesStore = require('./main/notices'); // 「ルーターから」 notices (dashboard, widget)
const progressFile = require('./main/progress'); // PROGRESS.md per folder (dashboard:progress)
const progressCheck = require('./main/progress-check'); // PM1 段 3: hourly PROGRESS.md / backlog gaps (haiku) -> 「ルーターから」 info
const triage = require('./main/triage'); // PM1 段 1: the patrol's haiku triage + the one shared claude -p runner
const carryover = require('./main/carryover'); // AT-carryover: unfinished PROGRESS.md / roadmap rows -> inbox (hold) on first open
const widget = require('./main/widget');
const winIcon = require('./main/winicon'); // DOCKID: the dashboard window's icon and title (taskbar / Dock)
const stuck = require('./main/stuck'); // roadmap 27: prompts that stopped a session (manager answer action)
const waits = require('./main/waits'); // PROGRESS 40: what idle sessions wait for, waits that never end
const lookout = require('./main/lookout'); // UX11: the watchers' gaps (closed folders, after-failed, heartbeat, outlook)
const reviewsMod = require('./main/reviews'); // UX12: 事後の確認 (manager/reviews.json)
const Reassure = require('./renderer/reassure'); // UX12: 安心の 1 行・留守の間・事後の確認の見出し (shared with the renderer)
const waitHints = require('./main/wait-hints'); // PM1 段 2: 誤報の見込み under the manager's waits block
const patrolGapsMod = require('./main/patrol-gaps'); // 見回りの検出
const attention = require('./main/attention'); // UIUX U3: 「あなたの番」 (what only the user can decide)
const AutoSend = require('./renderer/autosend');
const Nonstop = require('./renderer/nonstop'); // UX10: the usage limit hold (上限待ち), shared with the renderer // the backlog's auto send after API errors (a stopped ルーター -> あなたの番)
const tempSessions = require('./main/tempsessions'); // roadmap 9 / 19: temp + edit windows (block "temp / edit sessions" below)
const fileEdit = require('./main/fileedit');
const procMem = require('./main/procmem'); // memory of each session's process tree (pty:mem)
const stopTree = require('./main/stoptree'); // stop a session's whole process tree and check it is gone (PROGRESS 49)
const orphans = require('./main/orphans'); // startup sweep of suspended children a killed previous run left (PROGRESS 47)
const leftovers = require('./main/leftovers'); // processes the tabs left behind: counted for the dashboard, stopped by the setting (51c)
const simview = require('./main/simview').create({ ipcMain, userData: () => app.getPath('userData'), workDirOf: (e) => windows.get(e.sender.id)?.workDir || '' }); // IOS-SIM: iOS Simulator pane
const pincomment = require('./main/pincomment').create({ ipcMain, windowOf: (e) => windows.get(e.sender.id)?.win || null, workDirOf: (e) => windows.get(e.sender.id)?.workDir || '' }); // 15 場所を指定したコメント
const present = require('./main/present').create({ ipcMain, dialog: require('electron').dialog, windowOf: (e) => windows.get(e.sender.id)?.win || null, workDirOf: (e) => windows.get(e.sender.id)?.workDir || '', userData: () => app.getPath('userData'), renderer: (() => { const r = require('./main/present-render').pickRenderer(); return () => r; })(), thumbOf: (f) => { try { const img = require('electron').nativeImage.createFromPath(f); if (img.isEmpty()) return ''; return img.resize({ width: 320 }).toDataURL(); } catch { return ''; } } }); // 18 資料パネル (第 1 段)
const browserview = require('./main/browserview').create({ ipcMain, WebContentsView: require('electron').WebContentsView, session: require('electron').session, dialog: require('electron').dialog, downloadsDir: () => app.getPath('downloads'), windowOf: (e) => windows.get(e.sender.id)?.win || null, workDirOf: (e) => windows.get(e.sender.id)?.workDir || '' }); // 内蔵ブラウザ (PROGRESS 6)
const viewer = require('./main/viewer'); // roadmap 5b: file viewer panels, atview: protocol (CONTRACT.md "Viewer")
const sched = require('./main/sched'); // backlog start rules across folders (limit / resources / touches / after)
const keepAwakeMod = require('./main/keepawake'); // keep the PC awake while work runs, lid action (docs/keep-awake.md)

viewer.registerScheme(protocol); // before app 'ready'

let remote = null;
try {
  remote = require('./main/remote');
} catch (err) {
  console.warn('[main] remote module unavailable:', err && err.message);
}

const { UUID_RE, WORKTREE_RE, isInside, norm } = sessions;

// The released copy is named "bantodesk"; the working tree is "bantodesk-dev" (BN3; package.json, scripts/release.js).
// Different names give separate userData (settings) and separate single-instance locks,
// so both can run side by side.
const isDev = app.getName().endsWith('-dev');

// UX1 (docs/ux-journey.md §5.7): the 40px top bar. macOS: the traffic lights in the vertical middle of the bar (the renderer
// keeps the bar's left clear, style.css :root[data-os="darwin"] #topbar). Windows: the overlay (the 3 buttons on the right) as before.
const TITLE_BAR = process.platform === 'darwin'
  ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 13 } }
  : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#11111b', symbolColor: '#a6adc8', height: 40 } };

// One window per folder. webContents.id -> { win, workDir, ptys: Map<sessionId, IPty> }
const windows = new Map();

function parseWorkDir(argv, cwd) {
  // Drop switches first (their position varies), then the exe and, in dev, the app path.
  const positional = argv.slice(1).filter((a) => !a.startsWith('-'));
  for (const a of app.isPackaged ? positional : positional.slice(1)) {
    const p = path.resolve(cwd, a);
    try {
      if (fs.statSync(p).isDirectory()) return p;
    } catch {}
  }
  return null; // no folder given: the caller shows the folder picker
}

// `--temp` (temporary session) and `--edit <file>` / a FILE as positional argument (edit mode, roadmap 19).
// The file is the first positional that is an existing file (switch order varies in second-instance argv).
function parseTempArgs(argv, cwd) {
  const args = argv.slice(1);
  const temp = args.includes('--temp');
  const eq = args.find((a) => a.startsWith('--edit='));
  const positional = args.filter((a) => !a.startsWith('-'));
  const cands = [...(eq ? [eq.slice('--edit='.length)] : []), ...(app.isPackaged ? positional : positional.slice(1))];
  for (const a of cands) {
    const p = path.resolve(cwd, a);
    try {
      if (fs.statSync(p).isFile()) return { temp, edit: p };
    } catch {}
  }
  return { temp, edit: null };
}

// --- recent folders + picker window -------------------------------------
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const recentFile = () => path.join(app.getPath('userData'), 'recent-folders.json');

function loadRecent() {
  try {
    const list = JSON.parse(fs.readFileSync(recentFile(), 'utf8'));
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string' && isDir(p)) : [];
  } catch {
    return [];
  }
}

function addRecent(dir) {
  const list = [dir, ...loadRecent().filter((p) => norm(p) !== norm(dir))].slice(0, 12);
  try {
    fs.mkdirSync(path.dirname(recentFile()), { recursive: true });
    fs.writeFileSync(recentFile(), JSON.stringify(list));
  } catch {}
}

// UX5: the picker window (picker.html) is gone. Only when the dashboard cannot open (no manager folder, which the app
// normally creates itself) the OS folder dialog asks for a folder; cancelled with no window shown -> the app quits.
let choosingFolder = false;
async function chooseFolderFallback() {
  if (choosingFolder) return;
  choosingFolder = true;
  let r = null;
  try {
    r = await dialog.showOpenDialog({ title: 'フォルダを選ぶ', properties: ['openDirectory'] });
  } catch {}
  choosingFolder = false;
  if (r && !r.canceled && r.filePaths[0]) openFolder(r.filePaths[0]);
  else quitIfNoVisibleWindow();
}

// UX14: a folder chosen on the home's ＋ opens hidden (its first session shows in the home: dashboard.js startFolder);
// without a main window (the OS folder dialog) it is the window, as before
function openFolder(dir) {
  if (typeof dir !== 'string' || !isDir(dir)) return;
  const reason = mainOn() ? 'session' : 'folder';
  const hidden = !workbench.showOnOpen(reason, { main: mainOn() });
  const was = windowOf(path.resolve(dir));
  // 'session' (＋ 新しいセッション): the window starts a new session (a new window: on its empty screen, an open one: one more tab)
  const s = openWindow(path.resolve(dir), { hidden, wantTab: reason === 'session' });
  if (hidden && s) addRecent(s.workDir); // a hidden window is not added by openWindow (routed work is not "recent")
  if (reason === 'session' && was && s === was && s.role === 'project' && !s.temp) send(s, 'session:newTab', {});
}

const hasArgFolder = (argv, cwd) => {
  const t = parseTempArgs(argv, cwd);
  return !!parseWorkDir(argv, cwd) || t.temp || !!t.edit;
};

function launch(argv, cwd) {
  const t = parseTempArgs(argv, cwd);
  if (t.edit) return void openEditWindow(t.edit);
  if (t.temp) return void openTempWindow();
  const dir = parseWorkDir(argv, cwd);
  if (!dir) return void openStart();
  // UX14: a folder on the command line opens hidden (the workbench); the main window shows (the home as the user left it:
  // its saved folder filter is not replaced)
  if (!workbench.showOnOpen('launch', { main: mainOn() })) {
    const s = openWindow(dir, { launch: true, hidden: true });
    if (s && s.role === 'project' && !s.temp) addRecent(s.workDir);
    openStart();
    return;
  }
  openWindow(dir, { launch: true });
}

// UIUX U5: started without a folder (or started again) -> the dashboard, whose 新しいセッション panel (folders, temp / edit
// sessions, a new work folder) is where a folder is chosen; it is drawn large while no session is open. UX5: no picker
// window any more; when the dashboard cannot open (no manager folder) the OS folder dialog asks (chooseFolderFallback).
function openStart({ panel = false } = {}) {
  const s = startManager({ show: true });
  if (!s) return void chooseFolderFallback();
  revealWindow(s);
  if (!panel) return;
  // a dashboard still loading registers its listener in Dashboard.init (after the page's restore): send a little after the load
  const tell = (ms) => setTimeout(() => !s.win.isDestroyed() && send(s, 'dashboard:newSession', {}), ms);
  if (s.win.webContents.isLoading()) s.win.webContents.once('did-finish-load', () => tell(1500));
  else tell(300);
}

// SCH-FR2: the dashboard is never throttled, so its page always reads visibilityState 'visible'. win:seen tells it
// whether anyone can see it: shown, not minimized, the screen not locked (preload: <html data-unseen> + 'bantodesk:seen').
let screenLocked = false;
const seenWins = new Set();
function seenOf(win) {
  return !win.isDestroyed() && win.isVisible() && !win.isMinimized() && !screenLocked;
}
function tellSeen(win, seen = seenOf(win)) {
  try {
    // E2E-SEEN: an app a test started is always seen (src/main/e2e.js seenFor), unless AGENT_TERMINAL_E2E_REAL_SEEN=1
    if (!win.isDestroyed()) win.webContents.send('win:seen', require('./main/e2e').seenFor(seen && !screenLocked));
  } catch {}
}
let lockWatched = false;
function watchSeen(win) {
  seenWins.add(win);
  // during 'hide' / 'minimize' isVisible() / isMinimized() may not have changed yet (macOS): the event says it
  win.on('hide', () => tellSeen(win, false));
  win.on('minimize', () => tellSeen(win, false));
  for (const e of ['show', 'restore']) win.on(e, () => tellSeen(win));
  win.webContents.on('did-finish-load', () => tellSeen(win));
  win.on('closed', () => seenWins.delete(win));
  if (lockWatched) return;
  lockWatched = true;
  try {
    const { powerMonitor } = require('electron');
    const set = (v) => {
      screenLocked = v;
      for (const w of seenWins) tellSeen(w);
    };
    powerMonitor.on('lock-screen', () => set(true));
    powerMonitor.on('unlock-screen', () => set(false));
  } catch {}
}

// Shows a window that was opened hidden (routed work, the manager) and focuses it.
function revealWindow(s) {
  if (s.win.isDestroyed()) return;
  if (s.hidden) {
    s.hidden = false;
    s.win.setSkipTaskbar(false);
    if (s.role !== 'manager' && !s.temp) addRecent(s.workDir);
  }
  if (s.win.isMinimized()) s.win.restore();
  s.win.show();
  s.win.focus();
  if (seenWins.has(s.win)) tellSeen(s.win); // SCH-FR2 ('show' may not come for a window shown again on macOS)
}

// Hidden windows (routed work, the manager agent) do not keep the app alive: it quits when the last
// VISIBLE window (project window or the dashboard) is closed; hidden ones are destroyed with it.
let quitting = false;
const reopenLater = require('./main/reopenlater').createReopenLater({ app, log: (m) => console.warn('[main] ' + m) });
const anyVisibleWindow = () => [...windows.values()].some((s) => !s.hidden && !s.win.isDestroyed()) || choosingFolder;
// UX14 (§5.7 窓を閉じたとき): macOS keeps the app when the last window closes (Dock / menu bar open the main window, ⌘Q
// quits); Windows quits as before
function quitIfNoVisibleWindow() {
  if (quitting) return;
  if (!anyVisibleWindow() && (workbench.quitWhenNoneVisible() || !mainOn())) app.quit(); // no main window to come back to: quit (as before)
}
// UX14: a main window (the home) can be shown -> folder windows stay hidden unless asked for (src/main/workbench.js)
const mainOn = () => workbench.mainAvailable({ managerDir, noManager: process.env.AGENT_TERMINAL_NO_MANAGER === '1' });

const isManagerDir = (dir) => !!managerDir && norm(dir) === norm(managerDir);

// opts.hidden: open without showing it (show:false, no taskbar button, no background throttling so the
// sessions keep running); an already open window is left as it is. Without it, a hidden window is shown.
// -> window state
function openWindow(workDir, opts = {}) {
  const hidden = opts.hidden === true;
  // Canonical long path: 8.3 short names (C:\Users\ABCDEF~1\...) or different casing would not
  // match the long cwd Claude Code records in transcripts (history, resume cwd checks, git diff)
  // and would let the same folder open twice.
  try {
    workDir = fs.realpathSync.native(workDir);
  } catch {}
  for (const s of windows.values()) {
    if (norm(s.workDir) === norm(workDir)) {
      if (!hidden) revealWindow(s);
      return s;
    }
  }
  const role = isManagerDir(workDir) ? 'manager' : 'project';
  // opts.temp: { kind: 'temp'|'edit', name?, original? } – a folder the app made (block "temp / edit sessions")
  const temp = opts.temp && typeof opts.temp === 'object' ? opts.temp : null;
  const winLabel = temp ? (temp.kind === 'edit' ? `編集: ${temp.name || ''}` : '一時セッション') : role === 'manager' ? 'ダッシュボード' : workDir;
  const win = new BrowserWindow({
    width: 1400,
    height: 850,
    minWidth: 720, // UX18 (docs/ux-journey.md §5.7): the smallest window is 720 wide
    minHeight: 480,
    show: !hidden,
    skipTaskbar: hidden,
    backgroundColor: firstGround(), // UX18: the ground of the chosen theme (no dark flash when the light ground opens)
    // DOCKID: the dashboard's title starts with 「ダッシュボード」 (taskbar, the Dock's window list, the ウインドウ menu)
    title: role === 'manager' && !temp ? winIcon.dashboardTitle(isDev) : `BantoDesk${isDev ? ' [DEV]' : ''} - ${winLabel}`,
    ...TITLE_BAR,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Notification sounds (WebAudio) must play although the user may not have clicked the window yet.
      autoplayPolicy: 'no-user-gesture-required',
      // SCH-FR (docs/sched-assigned.md「SCH-FR」): a project window runs its queue on a 1 s timer (start, send, watch).
      // Throttled while the user does not look at it, the timer woke once a minute: a new tab's item waited 7 min
      // (AT-165) or failed the 60 s start watch 3 times (AT-166).
      // SCH-FR2 (「SCH-FR2」): the dashboard (manager) too — the ルーター's prompts (依頼を確認して…) go out from its 1 s queue
      // timer and sendText's timers; throttled, they reached the ルーター 1-3 min late (the ルーター transcript's prompts at the
      // same second, :21.0xx, all afternoon). The dashboard's "draw nothing while hidden" (§5.5.2) follows win:seen.
      backgroundThrottling: false,
      zoomFactor: zoomFactor(), // UX18: one zoom for every window (app-settings.json zoom)
    },
  });
  if (!hidden && role !== 'manager' && !temp) addRecent(workDir);
  const id = win.webContents.id;
  // launch: opened by starting the app (command line), not from the picker later (AT-139: an empty one shows the dashboard)
  // wantTab (UX14): opened from the home's ＋ — with nothing to restore it starts a session (else AT-139's empty screen)
  const state = { win, workDir, ptys: new Map(), hidden, role, temp, launch: opts.launch === true, wantTab: opts.wantTab === true };
  windows.set(id, state);
  win.webContents.on('did-finish-load', () => { try { win.webContents.setZoomFactor(zoomFactor()); } catch {} }); // UX18
  if (zoomFactor() !== 1 || themeNow() !== 'dark') fitWindowButtons(win); // UX18 (TITLE_BAR is the 100% / dark one)
  if (temp) attachTempWindow(state);
  if (role === 'manager') {
    managerState = state;
    winIcon.applyDashboardIcon(win, { nativeImage: require('electron').nativeImage }); // DOCKID (Windows; no-op on macOS)
    // Closing the dashboard only hides it: the manager agent keeps running until the app quits.
    win.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      state.hidden = true;
      win.setSkipTaskbar(true);
      win.hide();
      tellSeen(win, false); // SCH-FR2 ('hide' is not emitted for a hide() inside 'close' on macOS)
      quitIfNoVisibleWindow();
    });
    watchSeen(win);
  } else {
    // UX14: closing a folder window (the workbench) only hides it while a main window can come back; its sessions go on
    win.on('close', (e) => {
      if (!workbench.hideOnClose({ quitting, role, temp, main: mainOn() })) return;
      e.preventDefault();
      state.hidden = true;
      win.setSkipTaskbar(true);
      win.hide();
      quitIfNoVisibleWindow();
    });
    if (!hidden) scheduleManagerStart();
  }
  files.prewarm(workDir); // the first @-search should not pay for spawning git (~300 ms on Windows)
  if (role === 'project' && !temp) carryoverSoon(workDir); // AT-carryover: first open on this PC -> the folder's open rows
  win.on('page-title-updated', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  // Rendered Markdown (conversation view) contains links: never navigate the app window itself.
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    openExternalUrl(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  // Viewer iframes (roadmap 5b): an HTML page may navigate its own sandboxed frame within atview:. Leaving it is
  // blocked; an http(s) target opens in the default browser unless that viewer is offline (rate-limited, viewer.js).
  win.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return;
    let from = '';
    try {
      from = e.frame ? e.frame.url : '';
    } catch {}
    if (viewer.frameTargetAllowed(e.url)) return;
    e.preventDefault();
    // in-process frames only; atview: frames (out of process) are handled by did-start-navigation below
    if (!/^atview:/i.test(from) && viewer.frameNavigation(id, from, e.url) === 'open') openExternalUrl(e.url);
  });
  win.webContents.on('did-start-navigation', (e) => {
    if (e.isMainFrame || e.isSameDocument) return;
    let from = '';
    try {
      from = (e.initiator && e.initiator.url) || (e.frame && e.frame.url) || '';
    } catch {}
    if (!/^atview:/i.test(from)) return;
    if (viewer.frameLeft(id, from, e.url) === 'open') openExternalUrl(e.url);
  });
  // The app uses no WebRTC; viewer pages must not reach the network around the CSP over UDP.
  try {
    win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  } catch {}
  win.on('focus', () => win.flashFrame(false));
  // A renderer reload (DevTools, crash recovery) recreates tabs with the same session ids; the old
  // ptys would otherwise linger and make pty:create reject those ids. Fresh page = fresh ptys.
  // Only when the window's own page is replaced: `did-start-loading` also fires for iframes (viewer panels, roadmap 5b),
  // and `did-start-navigation` also for navigations that will-navigate cancels. `did-navigate` = a main-frame,
  // cross-document navigation committed (before the new page's scripts run).
  win.webContents.on('did-navigate', () => {
    for (const t of state.ptys.values()) killPty(t);
    state.ptys.clear();
    try { views.windowGone(state); } catch {} // UX13
    viewer.windowGone(id);
    simview.windowGone(id); // IOS-SIM: stop its capture loops
    present.windowGone(id); // 18: stop its file watchers
    browserview.windowGone(id); // 内蔵ブラウザ: destroy its views
  });
  win.on('closed', () => {
    for (const t of state.ptys.values()) killPty(t);
    try { views.windowGone(state); } catch {} // UX13
    if (state.temp) tempWindowClosed(state); // delete / keep the temp folder (after its ptys exit)
    windows.delete(id);
    viewer.windowGone(id, { closed: true });
    simview.windowGone(id);
    browserview.windowGone(id);
    if (managerState === state) managerState = null;
    schedWindowClosed(state);
    // 52b: a close that quits the app (the last visible window, or the hidden ones the quit destroys) leaves the
    // keep-awake as it is: will-quit ends it once (keepAwake.quit), no lid release started per closed window
    if (!quitting && anyVisibleWindow()) updatePowerBlock();
    widget.windowClosed(id);
    if (remote) {
      try {
        remote.windowClosed(id);
      } catch (err) {
        console.warn('[main] remote.windowClosed failed', err);
      }
    }
    scheduleProjects();
    quitIfNoVisibleWindow();
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  scheduleProjects(); // `open` changed
  return state;
}

// node-pty's kill() on Windows first forks conpty_console_list_agent (a second electron.exe) to list the console's
// processes. Starting a process blocks the main process ~1 s on this PC, so every window, the dashboard and the widget
// froze for a second per closed tab. The agent also started only after the console was already closed
// ("AttachConsole failed"), so its list was always just the root pid. Same result without the fork: kill the root
// pid at once; ClosePseudoConsole (native, does not block) ends the console's other processes.
// docs/memory-investigation.md "タブを閉じると一瞬固まる". node-pty internals (1.1.x): when they are missing,
// the plain kill() still runs. A terminal in the pty host (ptyproxy) has no _agent here: the host's worker does the same
// (src/main/ptyworker.js killTerm).
// Once per terminal (52b): node-pty's kill closes the same pseudo console again until the exit came (conpty.cc PtyKill);
// a pty host terminal's kill is a message, made once-only in the host's worker (ptyworker.js killTerm).
function killPty(t) {
  if (t._atKilled) return;
  t._atKilled = true;
  try {
    const ag = t._agent;
    if (ag && typeof ag._getConsoleProcessList === 'function') {
      ag._getConsoleProcessList = () => Promise.resolve(ag._innerPid ? [ag._innerPid] : []);
    }
  } catch {}
  try {
    t.kill();
  } catch {}
}

function send(state, channel, payload) {
  if (!state.win.isDestroyed()) state.win.webContents.send(channel, payload);
}

// The claude arguments / cwd are built from validated values only (UUID id, worktree name regex).
const INHERITED_SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT', // IDE integration of the parent terminal
  // Set by the running claude for its tool processes (seen in a Bash tool's env, absent from the
  // user / machine environment): the parent's claude.exe path and its current effort level. A tab's
  // claude must use its own install and the user's own effort setting.
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_EFFORT',
];

// <userData>\claude-settings.json (+ -routed / -manager), written once at startup (a null path when writing failed).
let claudeSettingsPaths = {}; // { base, routed, manager } (claudeCmd.writeAllClaudeSettings, UX9)
// TK2: the same three with the lean preamble (claude-settings[-kind]-lean.json, claude-cmd.js LEAN_SETTINGS)
let claudeLeanSettingsPaths = {};
// PROGRESS 4: the app's localhost MCP server (src/main/mcp-server.js, CONTRACT.md "App MCP server"). Started in
// whenReady; a tab that starts before it listens (or with AGENT_TERMINAL_NO_MCP=1) gets no --mcp-config.
const mcpServerLib = require('./main/mcp-server');
const codeMode = require('./main/code-mode'); // 依頼-535: Claude Code's code mode (docs/plan-code-mode.md)
let mcpServer = null;
function startMcpServer() {
  if (process.env.AGENT_TERMINAL_NO_MCP === '1') return;
  mcpServerLib
    .start({
      configDir: path.join(app.getPath('userData'), 'mcp'),
      log: (m, err) => console.warn('[mcp] ' + m, err || ''),
      // notify: to the window that owns the tab (its renderer raises the notice like an OSC 777 one)
      onNotify: (tabId, o) => {
        for (const st of windows.values()) {
          if (!st.ptys.has(tabId)) continue;
          send(st, 'mcp:notify', { tabId, kind: o.kind, text: o.text });
          return true;
        }
        return false;
      },
    })
    .then((srv) => {
      if (quitting) return srv.close();
      mcpServer = srv;
    })
    .catch((err) => console.warn('[mcp] server not started', err));
}

// How a tab's claude is started → { kind, file, args } (claudeCmd.launchSpec, CONTRACT.md "How a tab's claude is
// started"): claude.exe straight under the pty by default (no powershell.exe per tab, ~55-63 MB each). AGENT_TERMINAL_SHELL
// set = through that shell the old way (-NoExit). override = AGENT_TERMINAL_CMD where it applies (tests).
// --settings (with the SEC5 deny rules) and the SEC5 guard prompt go to every claude start; the progress prompt to
// folder tabs only (not the manager / temp windows).
// claude.delegate (a session the app started for a routed item, setting on): + docs/prompts/routed-session.md.
const ROUTED_PROMPT_FILE = path.join(__dirname, '..', 'docs', 'prompts', 'routed-session.md');
// model / effort (AT-6, src/main/models.js): the tab's own (a routed item's, sent by the renderer) when valid, else the
// default of manager-settings.json (the ルーター's for the manager window), read at every start so a change applies to the
// next start.
function claudeModel(s, own) {
  return models.pick(models.fromSettings(loadManagerSettings()), s.role, own);
}
// UX9: the --settings file by the kind of claude: the ルーター's (manager folder + outbox), a routed session's (the
// permissions decided at the start, claude-cmd.js roleRules), else the base one. Each has the SEC5 deny rules and hook.
function settingsPathFor(s, claude) {
  const p = claudeSettingsPaths || {};
  if (s.role === 'manager') return p.manager || p.base || null;
  if (!s.temp && claude.delegate) return p.routed || p.base || null;
  return p.base || null;
}
// TK2: the lean file of the same kind (no fallback to another kind: a missing one = the usual file, by buildClaudeArgs)
function leanSettingsPathFor(s, claude) {
  const p = claudeLeanSettingsPaths || {};
  if (s.role === 'manager') return p.manager || null;
  if (!s.temp && claude.delegate) return p.routed || null;
  return p.base || null;
}
function claudeLaunch(s, claude, override) {
  const folder = s.role !== 'manager' && !s.temp;
  claude = { ...claude, ...claudeModel(s, { model: claude.model, effort: claude.effort, kind: claude.kind }) };
  const parts = [claudeCmd.GUARD_PROMPT]; // SEC5: every claude, the manager and temp windows too
  if (folder) parts.push(claudeCmd.PROGRESS_PROMPT);
  if (folder && claude.delegate) parts.push(claudeCmd.routedPrompt(ROUTED_PROMPT_FILE));
  const appendPrompt = parts.join('\n\n');
  // code mode (experimental, env only): on / off / auto from manager-settings.json, read at every start
  const cmEnv = codeMode.envFor({ mode: codeMode.modeOf(loadManagerSettings()), role: s.role, temp: !!s.temp, team: !!claude.team, kind: claude.kind, model: claude.model, env: process.env });
  const spec = claudeCmd.launchSpec({
    shell: process.env.AGENT_TERMINAL_SHELL || null,
    override,
    // TK2 (docs/plan-token.md): the lean preamble unless manager-settings.json turns it off (app-wide / this folder),
    // read at every start; a running claude keeps what it started with (the system layer heads the prompt cache)
    claude: { ...claude, settingsPath: settingsPathFor(s, claude), leanSettingsPath: leanSettingsPathFor(s, claude), lean: claudeCmd.leanPreambleFor(loadManagerSettings(), s.workDir), mcpConfigPath: mcpServer ? mcpServer.configFor(claude.id) : null, appendPrompt },
  });
  return Object.keys(cmEnv).length ? { ...spec, env: cmEnv } : spec;
}

function spawnPty(state, id, cols, rows, launch, cwd, opts = {}) {
  // Launched from inside another Claude Code session, that session's markers would leak into the
  // tab's claude (skipped transcript saving, teammates not starting, messages routed to the parent).
  // Only session-scoped variables are removed; user settings such as CLAUDE_CODE_USE_BEDROCK or
  // CLAUDE_CODE_GIT_BASH_PATH are kept.
  const env = { ...process.env };
  for (const k of INHERITED_SESSION_ENV) delete env[k];
  claudeCmd.longTempEnv(env); // Claude Code's task output paths in the long form (claude-cmd.js tempReadRules)
  // Agent Teams (docs/agent-teams-plan.md): in-process teammates only. A TMUX variable makes
  // Claude Code try the tmux backend, which on Windows leaves teammates stuck at "Initializing…",
  // and an inherited CLAUDE_PID (app started from inside a Claude session) stops them starting.
  if (launch.env) Object.assign(env, launch.env); // code mode (claudeLaunch)
  if (opts.team) {
    env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.CLAUDE_PID;
  }
  // Returns at once: ConPTY + CreateProcess (1-9 s on this PC) run in the pty host; t.pid is set when it answers
  // (t.ready). Writes / resizes / kills sent before that reach the terminal in order (src/main/ptyproxy.js).
  const t = ptyProxy.spawn(launch.file, launch.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
    useConpty: true,
  });
  // After a renderer reload a new pty may own this id; output/exit of a replaced pty must not
  // reach (and e.g. mark as exited) the new tab.
  const current = () => state.ptys.get(id) === t;
  t.onData((data) => {
    if (current()) send(state, 'pty:data', { id, data });
  });
  t.onExit(({ exitCode }) => {
    if (!current()) return;
    state.ptys.delete(id); // no longer "open" (history) and may be recreated
    send(state, 'pty:exit', { id, code: exitCode });
  });
  return t;
}

const stateOf = (e) => windows.get(e.sender.id);
const clampSize = (n) => Math.min(500, Math.max(2, Number.isFinite(n) ? Math.floor(n) : 80));


const userFile = (name) => path.join(app.getPath('userData'), name);

ipcMain.handle('app:info', async (e) => {
  const s = stateOf(e);
  if (!s) return { workDir: undefined, dev: isDev, isGit: false, role: null };
  // role: 'manager' = the dashboard window (managing agent's folder), else 'project'. hidden: opened without showing.
  // temp: null | { kind: 'temp'|'edit', name?, original? } (temp / edit window)
  const temp = s.temp ? { kind: s.temp.kind, ...(s.temp.name ? { name: s.temp.name } : {}), ...(s.temp.original ? { original: s.temp.original } : {}) } : null;
  // AT-139: a project window with nothing to restore starts no claude, also in an app a test started (the e2e open
  // their first tab themselves: tmp/dock/start-tab.mjs)
  const wantTab = !!s.wantTab;
  s.wantTab = false; // once (a reload does not start another)
  return { workDir: s.workDir, dev: isDev, isGit: await gitTools.isGit(s.workDir), role: s.role, hidden: !!s.hidden, temp, launch: !!s.launch, wantTab };
});
ipcMain.on('win:title', (e, text) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed() || typeof text !== 'string') return;
  // DOCKID: the dashboard keeps 「ダッシュボード — BantoDesk」 (the page's "<tab> - ダッシュボード - …" would put the
  // ルーター tab's name first in the taskbar and the Dock's window list)
  const s = stateOf(e);
  win.setTitle(s && s.role === 'manager' && !s.temp ? winIcon.dashboardTitle(isDev) : text.slice(0, 300));
});

ipcMain.handle('picker:list', () => ({
  recent: loadRecent(),
  open: [...windows.values()].filter((s) => s.role !== 'manager' && !s.temp).map((s) => s.workDir), // incl. hidden ones
  // edit sessions closed with "残して閉じる": [{ dir, name, original, createdAt, open }]
  kept: tempStore ? tempStore.kept().filter((k) => k.kind === 'edit').map((k) => ({ dir: k.dir, name: k.name || (k.original ? path.basename(k.original) : ''), original: k.original || '', createdAt: k.createdAt, open: !!windowOf(k.dir) })) : [],
}));
ipcMain.handle('picker:browse', async (e) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(parent, { title: 'フォルダを選ぶ', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return false;
  openFolder(r.filePaths[0]);
  return true;
});
ipcMain.on('picker:open', (_e, dir) => openFolder(dir));
ipcMain.on('picker:show', () => openStart({ panel: true })); // U5: the dashboard's 新しいセッション
// U5 「新しい作業」 on the dashboard's 新しいセッション panel: { name } -> a new folder under the work root (the same place and
// naming as the ルーター's create action: manager.createWorkFolder, never an existing folder), opened in its own window.
// -> { ok: true, folder } | { error }
ipcMain.handle('dashboard:newWork', (e, o) => {
  if (stateOf(e)?.role !== 'manager') return { error: 'not allowed' };
  const name = o && typeof o.name === 'string' ? o.name.slice(0, 200) : '';
  if (!name.trim()) return { error: 'フォルダの名前がありません' };
  let dir = null;
  try {
    dir = manager.createWorkFolder(getWorkRoot(), name);
  } catch (err) {
    return { error: String((err && err.message) || err).slice(0, 200) };
  }
  // the same check as the ルーター's create (a work root set inside the app data is refused)
  const v = manager.validateFolder(dir, app.getPath('userData'));
  if (!v.ok) return { error: String(v.error || 'not allowed').slice(0, 200) };
  dir = v.folder;
  addRecent(dir);
  openWindow(dir, { hidden: !workbench.showOnOpen('session', { main: mainOn() }), wantTab: mainOn() }); // UX14: its session shows in the home
  return { ok: true, folder: dir };
});

// --- pty ----------------------------------------------------------------------
// Where a resumed claude starts: the tab's saved cwd when it is a folder inside the window's folder; else the last cwd
// the session's (newest) transcript recorded, when that is inside; else the folder. claude finds the conversation by the
// cwd's project folder, so the folder root is wrong for a session that ran in a sub-folder (the ルーター in manager/outbox):
// a saved cwd from the former data folder (BN3: …/agent-terminal/manager/outbox) made every ルーター resume exit.
function resumeDir(s, id, cwd) {
  const ok = (d) => typeof d === 'string' && d && isDir(d) && isInside(d, s.workDir);
  if (ok(cwd)) return path.resolve(cwd);
  const last = transcript.lastCwd(id);
  if (ok(last)) return path.resolve(last);
  return s.workDir;
}

ipcMain.on('pty:create', (e, o) => {
  const s = stateOf(e);
  const { id, cols, rows, mode = 'new', cwd, worktree } = o || {};
  const team = (o || {}).team === true;
  const delegate = (o || {}).delegate === true; // routed item: the delegation prompt (claudeLaunch)
  // AT-6: a routed item's own (checked in claudeLaunch); MODEL-KIND: + its kind (the default by kind)
  const own = { model: (o || {}).model, effort: (o || {}).effort, kind: (o || {}).kind };
  if (!s || typeof id !== 'string' || !UUID_RE.test(id) || s.ptys.has(id)) return;
  const reject = (why) => {
    console.warn(`[main] pty:create rejected (${why})`);
    send(s, 'pty:exit', { id, code: -1 });
  };
  let launch;
  let dir = s.workDir;
  if (mode === 'new') {
    if (worktree !== undefined && worktree !== null && worktree !== '') {
      if (typeof worktree !== 'string' || !WORKTREE_RE.test(worktree)) return reject('bad worktree name');
    }
    launch = claudeLaunch(s, { mode, id, worktree, team, delegate, ...own }, process.env.AGENT_TERMINAL_CMD);
    if (delegate && s.role !== 'manager' && !s.temp && s.workDir) propose.ensureOutbox(s.workDir); // U7: where it proposes
    // a sub-dir of the folder (context handoff of a worktree tab), unless a new worktree is being made
    if (!worktree && typeof cwd === 'string' && cwd && isDir(cwd) && isInside(cwd, s.workDir)) dir = path.resolve(cwd);
  } else if (mode === 'resume') {
    launch = claudeLaunch(s, { mode, id, team, delegate, ...own });
    dir = resumeDir(s, id, cwd);
  } else {
    return reject('bad mode');
  }
  s.ptys.set(id, spawnPty(s, id, clampSize(cols), clampSize(rows), launch, dir, { team }));
  (s.ptyStarted ||= new Map()).set(id, Date.now()); // waits.js: background commands of an earlier claude are not waited for
  if (s.temp) tempTrackPty(s, id, s.ptys.get(id)); // ledger session ids + wait for exit before deleting
  sendMemSoon(s); // first figure ~15 s after start instead of at the next minute tick
});
ipcMain.on('pty:input', (e, { id, data }) => stateOf(e)?.ptys.get(id)?.write(data));
ipcMain.on('pty:resize', (e, { id, cols, rows }) => {
  try {
    stateOf(e)?.ptys.get(id)?.resize(clampSize(cols), clampSize(rows));
  } catch {}
});
ipcMain.on('pty:close', (e, id) => {
  const s = stateOf(e);
  const t = s?.ptys.get(id);
  if (t) {
    s.ptys.delete(id);
    // the tree is remembered first (≤ 1.5 s, on a worker): a child created in the middle of the kill and never resumed
    // is then known as this tab's leftover and stopped (51c, src/main/leftovers.js)
    leftoverRemember(t.pid).then(() => killPty(t));
  }
});

// Stop a tab's claude and every process under it, and check they are gone (PROGRESS 49: a routed session done with
// 作業完了; main/stoptree.js). -> { before, survivors, left, ... } (also kept in <userData>/stopped-trees.json)
ipcMain.handle('pty:stopTree', async (e, o) => {
  const s = stateOf(e);
  const id = o && typeof o.id === 'string' ? o.id : null;
  const t = id ? s?.ptys.get(id) : null;
  if (!t) return { none: true };
  s.ptys.delete(id);
  const exited = new Promise((r) => t.onExit(() => r()));
  await t.ready; // a tab stopped while its claude is still starting: the pid comes with the host's answer
  const res = await stopTree.stopTree({
    pid: t.pid,
    kill: () => killPty(t),
    exited,
    onBefore: (rows) => leftoverTracker?.rememberRows(rows, t.pid), // 51c: children created during the kill stay known
    // TerminateProcess (not taskkill: it uses WMI, which can hang on this PC; docs/close-done.md)
    killPid: async (pid) => {
      try {
        process.kill(pid);
      } catch {}
    },
  });
  const entry = { ...res, tabId: id, folder: s.workDir, why: o && typeof o.why === 'string' ? o.why.slice(0, 40) : '' };
  stopTree.record(app.getPath('userData'), entry);
  if (res.survivors.length || res.left.length) console.log('[stoptree]', id, 'survivors', res.survivors.map((p) => `${p.pid} ${p.name}`).join(', '), 'left', res.left.length);
  return entry;
});

// Restart a tab's claude with --resume (same session id, same conversation): a long session's claude.exe
// grows to ~1 GB, a fresh process starts small again (docs/memory-investigation.md, proposal A).
// The old process is waited for (≤ 5 s) so two claude processes never write the same transcript.
ipcMain.on('pty:restart', async (e, o) => {
  const s = stateOf(e);
  const { id, cols, rows, cwd } = o || {};
  const team = (o || {}).team === true;
  const delegate = (o || {}).delegate === true;
  const own = { model: (o || {}).model, effort: (o || {}).effort, kind: (o || {}).kind }; // AT-6 (as pty:create)
  if (!s || typeof id !== 'string' || !UUID_RE.test(id)) return;
  if (s.restarting?.has(id)) return;
  (s.restarting ||= new Set()).add(id);
  try {
    const old = s.ptys.get(id);
    if (old) {
      s.ptys.delete(id);
      const gone = new Promise((r) => old.onExit(() => r()));
      await leftoverRemember(old.pid); // 51c (as pty:close)
      killPty(old);
      await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
    }
    if (s.win.isDestroyed() || s.ptys.has(id)) return;
    const dir = resumeDir(s, id, cwd);
    // AGENT_TERMINAL_CMD (tests) replaces the command here too, so a restart never starts a real claude in a test.
    // No transcript yet (claude exited before the first message): --resume would only print "No conversation found"
    // and exit, so the same session id starts fresh instead.
    const mode = transcript.findTranscript(id) ? 'resume' : 'new';
    const launch = claudeLaunch(s, { mode, id, team, delegate, ...own }, process.env.AGENT_TERMINAL_CMD);
    s.ptys.set(id, spawnPty(s, id, clampSize(cols), clampSize(rows), launch, dir, { team }));
    (s.ptyStarted ||= new Map()).set(id, Date.now());
    if (s.temp) tempTrackPty(s, id, s.ptys.get(id));
    sendMemSoon(s);
  } finally {
    s.restarting.delete(id);
  }
});

// pty:mem – { [tabId]: { mb, procs } } for the window's sessions (private bytes of the pty shell + descendants).
// Pushed every MEM_POLL_MS to visible windows, and on request (tab menu).
const MEM_POLL_MS = 60_000;
async function sessionMem(s) {
  const ids = [...s.ptys.keys()];
  const roots = ids.map((id) => s.ptys.get(id).pid).filter((p) => Number.isInteger(p) && p > 0);
  const totals = await procMem.sample(roots);
  const out = {};
  for (const id of ids) {
    const t = s.ptys.get(id);
    const r = t && totals.get(t.pid);
    if (r) out[id] = { mb: Math.round(r.bytes / 1048576), procs: r.count };
  }
  return out;
}
async function pushMem(s) {
  if (s.win.isDestroyed() || !s.ptys.size) return;
  try {
    send(s, 'pty:mem', await sessionMem(s));
  } catch (err) {
    console.warn('[main] pty:mem failed', err);
  }
}
function sendMemSoon(s) {
  clearTimeout(s.memTimer);
  s.memTimer = setTimeout(() => pushMem(s), 15_000); // after the new claude has started
}
ipcMain.handle('pty:mem', (e) => {
  const s = stateOf(e);
  return s ? sessionMem(s) : {};
});
// Hidden / minimized windows too: the dashboard shows every session's memory (roadmap 22). All windows'
// calls start in the same tick, so procMem.sample() answers them with one shared query.
setInterval(() => {
  for (const s of windows.values()) {
    if (!s.win.isDestroyed()) pushMem(s);
  }
}, MEM_POLL_MS).unref?.();

// --- processes the tabs left behind (PROGRESS 51c, src/main/leftovers.js, docs/proc-leftovers.md) ---------------
// Every LEFTOVER_POLL_MS: one process list (the native proclist, no WMI / tasklist), the tabs' trees remembered, the
// leftovers counted (-> proc:leftovers to every window: the dashboard's band) and stopped by the setting
// (leftovers-settings.json: 'ended' default = a gone session's, 'all', 'off').
const LEFTOVER_POLL_MS = Number(process.env.AGENT_TERMINAL_LEFTOVERS_MS) || 60_000;
let leftoverTracker = null;
let leftoverSig = '';
function leftoverRoots() {
  const out = [];
  for (const s of windows.values()) for (const t of s.ptys.values()) if (Number.isInteger(t.pid) && t.pid > 0) out.push({ pid: t.pid });
  return out;
}
// e2e only (the mark + AGENT_TERMINAL_PROCLIST_EXTRA = a JSON file of made-up rows added to the list): the real
// leftovers cannot be made without a compiled helper (SEC3b), so tmp/proc-leftovers/e2e.mjs describes them in a file
function leftoverExtraRows() {
  const f = process.env.AGENT_TERMINAL_PROCLIST_EXTRA;
  if (!f || !require('./main/e2e').isE2E()) return [];
  try {
    return require('./main/proclist').rowsOf(JSON.parse(fs.readFileSync(f, 'utf8')));
  } catch {
    return [];
  }
}
function leftoverTrackerInit() {
  leftoverTracker = leftovers.createTracker({
    userData: app.getPath('userData'),
    list: async () => [...(await require('./main/proclist').list({ timeout: 20000 })), ...leftoverExtraRows()],
    roots: leftoverRoots,
    kill: async (pid) => process.kill(pid), // TerminateProcess (not taskkill: WMI)
    minAgeMs: Number(process.env.AGENT_TERMINAL_LEFTOVERS_MIN_AGE_MS) || undefined,
    endedMinAgeMs: Number(process.env.AGENT_TERMINAL_LEFTOVERS_ENDED_AGE_MS) || undefined,
    log: (...a) => console.log(...a),
  });
  const tick = () => leftoverCheck().catch(() => {});
  setTimeout(tick, Number(process.env.AGENT_TERMINAL_LEFTOVERS_FIRST_MS) || 20_000).unref?.();
  setInterval(tick, LEFTOVER_POLL_MS).unref?.();
}
function leftoverView(r) {
  if (!r) return null;
  const { at, mode, count, mb, suspended, tasklist, ended, stoppedTotal, error } = r;
  return { at, mode, count, mb, suspended, tasklist, ended, stoppedTotal, stopped: (r.stopped || []).length, ...(error ? { error } : {}) };
}
let leftoverRunning = null;
function leftoverCheck() {
  if (!leftoverTracker || process.platform !== 'win32') return Promise.resolve(null);
  if (leftoverRunning) return leftoverRunning;
  leftoverRunning = leftoverTracker.check().then((r) => {
    const v = leftoverView(r);
    const sig = JSON.stringify([v.mode, v.count, v.mb, v.ended, v.stoppedTotal, !!v.error]);
    if (sig !== leftoverSig) {
      leftoverSig = sig;
      broadcast('proc:leftovers', v);
    }
    return v;
  }).finally(() => (leftoverRunning = null));
  return leftoverRunning;
}
// a tab's tree remembered right before its pty is killed (≤ 1.5 s; never blocks the kill for longer)
function leftoverRemember(pid) {
  if (!leftoverTracker || process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  return Promise.race([leftoverTracker.snapshot([{ pid }]).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
}
// -> { at, mode, count, mb, suspended, tasklist, ended, stoppedTotal, stopped } ({ fresh: true }: count now)
ipcMain.handle('proc:leftovers', async (_e, o) => {
  if (o && o.fresh) return leftoverCheck();
  return leftoverView(leftoverTracker?.last()) || leftoverCheck();
});
// AT-200: the processes running under a tab's claude (leftovers.liveKids), for the renderer's auto-close / rest (31) /
// done-stop (35): a tab whose claude still has a child at work is not closed or rested (up to a time limit there).
// -> { root, kids: [{ pid, name, ageS }] } | { unsupported: true } (no process list: macOS outside the e2e) | { none } | { error }
ipcMain.handle('pty:kids', async (e, id) => {
  const s = stateOf(e);
  const t = typeof id === 'string' ? s?.ptys.get(id) : null;
  if (!t) return { none: true };
  await t.ready;
  const pid = t.pid;
  if (!Number.isInteger(pid) || pid <= 0) return { none: true };
  const e2eRows = !!process.env.AGENT_TERMINAL_PROCLIST_EXTRA && require('./main/e2e').isE2E(); // made-up rows (e2e only)
  if (process.platform !== 'win32' && !e2eRows) return { unsupported: true };
  let procs = [];
  if (process.platform === 'win32') {
    try {
      procs = await require('./main/proclist').list({ timeout: 20000 });
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  }
  procs = procs.concat(leftoverExtraRows());
  const now = Date.now();
  const kids = leftovers.liveKids({ procs, known: leftoverTracker?.known, rootPid: pid, startedAt: s.ptyStarted?.get(id) || 0,
    settleMs: Number(process.env.AGENT_TERMINAL_KIDS_SETTLE_MS) || undefined });
  return { root: pid, kids: kids.slice(0, 20).map((k) => ({ pid: k.pid, name: k.name, ageS: Number.isFinite(k.created) ? Math.round((now - k.created) / 1000) : null })), count: kids.length };
});
// mode 'off' | 'ended' | 'all' -> the new state (counted again at once)
ipcMain.handle('proc:leftoversMode', async (_e, mode) => {
  if (!leftoverTracker) return null;
  leftoverTracker.setMode(String(mode || ''));
  return leftoverCheck();
});

// --- transcripts --------------------------------------------------------------
// Only to the window that has the session open (events now carry tool output; other sessions on
// the machine would just be IPC noise). Sessions opened later get their history via assist:replay.
// UX13: a window that views the session in place (the dashboard's session view) also gets it, on 'view:event'
// (src/main/oneview.js: at most once per window and channel).
const views = oneview.create({
  windows,
  send: (s, ch, payload) => send(s, ch, payload),
  replay: async (id) => [...(await transcript.replay(id)), ...teams.eventsFor(id)],
  hasTab: (wcId, id) => widget.hasTab(wcId, id),
});
function emit(evt) {
  views.emit(evt);
}
// manager window only: { tabId } -> { ok, sessionId, owned, folder, events }
ipcMain.handle('view:open', (e, o) => {
  const s = stateOf(e);
  if (s?.role !== 'manager') return { ok: false, why: 'bad' };
  return views.open(s, o);
});
ipcMain.on('view:close', (e) => views.close(stateOf(e)));
// { tabId, type: 'text'|'choice'|'key', value } -> '' (sent) | the reason it was not sent
ipcMain.handle('view:input', (e, o) => {
  const s = stateOf(e);
  if (s?.role !== 'manager') return 'bad';
  return views.input(s, o);
});
ipcMain.on('view:inputDone', (e, o) => views.inputDone(stateOf(e), o)); // the owner window's reply
ipcMain.on('view:screen', (e, o) => views.screen(stateOf(e), o)); // the owner window's screen state (while watched)
ipcMain.handle('assist:replay', async (_e, sessionId) => {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return [];
  try {
    return [...(await transcript.replay(sessionId)), ...teams.eventsFor(sessionId)];
  } catch (err) {
    console.warn('[main] replay failed', err);
    return [];
  }
});

ipcMain.handle('assist:replayAgent', async (_e, o) => {
  const { sessionId, agentId } = o || {};
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return [];
  try {
    return await transcript.replayAgent(sessionId, agentId);
  } catch (err) {
    console.warn('[main] replayAgent failed', err);
    return [];
  }
});

// --- sessions -----------------------------------------------------------------
const isOpenAnywhere = (id) => [...windows.values()].some((s) => s.ptys.has(id));
ipcMain.on('sessions:save', (e, tabs) => {
  const s = stateOf(e);
  if (s && s.temp) return void tempStore?.setTabs(s.workDir, sessions.sanitizeTabs(tabs)); // temp: the ledger, not sessions.json
  if (s) sessions.saveTabs(userFile('sessions.json'), s.workDir, tabs);
});
ipcMain.handle('sessions:saved', (e) => {
  const s = stateOf(e);
  if (s && s.temp) return tempSavedTabs(s);
  return s ? sessions.savedTabs(userFile('sessions.json'), s.workDir) : [];
});
ipcMain.handle('sessions:history', (e) => {
  const s = stateOf(e);
  return s ? sessions.history(s.workDir, isOpenAnywhere) : [];
});

// --- dock layout (per folder, userData/layouts.json) ------------------------------
// Temp / edit windows keep their layout and composer data in memory only (state.mem).
ipcMain.handle('layout:get', (e) => {
  const s = stateOf(e);
  if (s && s.temp) return s.mem?.layout || null;
  return s ? layouts.getLayout(userFile('layouts.json'), s.workDir) : null;
});
ipcMain.handle('layout:save', (e, layout) => {
  const s = stateOf(e);
  if (s && s.temp) return !!((s.mem ||= {}).layout = layout);
  return s ? layouts.saveLayout(userFile('layouts.json'), s.workDir, layout) : false;
});
// Synchronous variant for beforeunload: the file is written before the window goes away.
ipcMain.on('layout:saveSync', (e, layout) => {
  const s = stateOf(e);
  if (s && s.temp) return void (e.returnValue = !!((s.mem ||= {}).layout = layout));
  e.returnValue = s ? layouts.saveLayoutSync(userFile('layouts.json'), s.workDir, layout) : false;
});

// --- composer drafts + send history (per folder, userData/composer/<hash>.json) ----
ipcMain.handle('composer:get', async (e) => {
  const s = stateOf(e);
  if (!s) return { drafts: {}, history: [] };
  if (s.temp) return s.mem?.composer || { drafts: {}, history: [] };
  return layouts.getComposer(userFile('composer'), s.workDir, userFile('layouts.json'));
});
ipcMain.handle('composer:save', async (e, o) => {
  const s = stateOf(e);
  if (s && s.temp) return !!((s.mem ||= {}).composer = o);
  return s ? layouts.saveComposer(userFile('composer'), s.workDir, o) : false;
});
ipcMain.on('composer:saveSync', (e, o) => {
  const s = stateOf(e);
  if (s && s.temp) return void (e.returnValue = !!((s.mem ||= {}).composer = o));
  e.returnValue = s ? layouts.saveComposerSync(userFile('composer'), s.workDir, o) : false;
});

// --- backlog (per folder, userData/backlog/<hash>.json) ---------------------------
// J2 (docs/mac-polish.md): a window's save equal to its last written save is dropped (backlog:save / saveBacklogSync).
// Every write to a folder's file through the backlog module (main's own writes, manager.js included) forgets the entry.
const backlogSame = samesave.create();
samesave.forgetOnWrite(backlog, ['saveBacklog', 'saveBacklogSync', 'updateStatus'], backlogSame, (a) => norm(a[1]));
// Items main itself put on a folder's backlog (routed work, manager prompts) are re-added to a window's
// save that does not know them yet (manager.mergeInjected), so a save racing the reload cannot drop them.
ipcMain.handle('backlog:get', async (e) => {
  const s = stateOf(e);
  if (!s) return { items: [], auto: {} };
  const st = await backlog.getBacklog(userFile('backlog'), s.workDir);
  routedStatuses(s.workDir, st.items, false);
  return st;
});
ipcMain.handle('backlog:save', async (e, o) => {
  const s = stateOf(e);
  if (!s) return false;
  const data = applyPendingStatus(s.workDir, applyPendingOrder(s.workDir, manager.mergeInjected(s.workDir, o)));
  const key = norm(s.workDir);
  const json = JSON.stringify(data);
  if (backlogSame.same(key, json)) return true; // J2: the same content as the last save: nothing to write
  const p = backlog.saveBacklog(userFile('backlog'), s.workDir, data); // (forgets key, then it is remembered)
  backlogSame.remember(key, json);
  const ok = await p;
  if (!ok) backlogSame.forget(key);
  backlogSavedByWindow(s, data);
  return ok;
});
ipcMain.on('backlog:saveSync', (e, o) => {
  const s = stateOf(e);
  if (!s) {
    e.returnValue = false;
    return;
  }
  const data = applyPendingStatus(s.workDir, applyPendingOrder(s.workDir, manager.mergeInjected(s.workDir, o)));
  const key = norm(s.workDir);
  const json = JSON.stringify(data);
  if (backlogSame.same(key, json)) {
    e.returnValue = true; // J2: unchanged
    return;
  }
  e.returnValue = backlog.saveBacklogSync(userFile('backlog'), s.workDir, data);
  if (e.returnValue) backlogSame.remember(key, json);
  backlogSavedByWindow(s, data);
});
// The user's 取り消す of a waiting item of any folder (dashboard): { folder, id } -> { ok: true, item } | { ok: false, error }.
// The item stays as history with status dropped (its inbox tie is kept, the inbox item is not changed).
ipcMain.handle('backlog:drop', async (_e, o) => {
  const folder = o && o.folder;
  const id = o && o.id;
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || typeof id !== 'string') return { ok: false, error: 'bad request' };
  const r = await backlogUpdate({ folder, backlogId: id, status: 'dropped', note: 'ユーザーが取り消しました', by: 'user', from: ['pending'] });
  return r.error ? { ok: false, error: r.error } : { ok: true, item: r.item };
});
// UX15: the card's row menu (was the バックログ panel's buttons): { folder, id, op } -> { ok } | { ok: false, error }.
//   op 'reopen' (戻す): a done / failed / dropped item waits again. op 'done' (完了にする): a running item is done by hand.
// The folder's own window holds the queue (a running item, its save): it does it there (backlog:op) and saves. A folder
// without a window: main writes the file (done needs a running item, which only a window has: refused).
ipcMain.handle('backlog:set', async (e, o) => {
  if (stateOf(e)?.role !== 'manager') return { ok: false, error: 'bad request' };
  const folder = o && o.folder;
  const id = o && o.id;
  const op = o && o.op;
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || typeof id !== 'string' || !['reopen', 'done', 'title'].includes(op)) return { ok: false, error: 'bad request' };
  // 見出しを直す (the card's row menu, was the panel's 編集): empty = made from the text again (titleAuto)
  const title = op === 'title' ? (typeof o.title === 'string' ? o.title.replace(/\s+/g, ' ').trim().slice(0, 200) : null) : undefined;
  if (title === null) return { ok: false, error: 'bad request' };
  if (managerDir && norm(folder) === norm(managerDir)) return { ok: false, error: "the manager folder's own queue cannot be changed" };
  const items = (await backlog.getBacklog(userFile('backlog'), folder)).items || [];
  const it = items.find((i) => i && i.id === id);
  const own = windowOf(folder);
  if (own && own.role !== 'manager') {
    // the window's copy may be newer than the file (an item it just started): it checks the status itself
    send(own, 'backlog:op', op === 'title' ? { id, op, title } : { id, op });
    if (op === 'title') {
      pmoLog({ type: 'backlog-update', by: 'user', folder, backlogId: id, from: it ? it.status : '', status: it ? it.status : '', note: `見出しを直す: ${title || '（本文の先頭から）'}` });
      return { ok: true, window: true };
    }
    pmoLog({ type: 'backlog-update', by: 'user', folder, backlogId: id, from: it ? it.status : '', status: op === 'done' ? 'done' : 'pending', note: op === 'done' ? '手動で完了' : '戻す' });
    return { ok: true, window: true };
  }
  if (!it) return { ok: false, error: `unknown backlogId ${JSON.stringify(id)}` };
  if (op === 'title') {
    const st0 = await backlog.getBacklog(userFile('backlog'), folder);
    const items0 = st0.items.map((i) => {
      if (i.id !== id) return i;
      const n = { ...i };
      if (title) n.title = title;
      else delete n.title;
      return n;
    });
    await backlog.saveBacklog(userFile('backlog'), folder, { ...st0, items: items0 });
    backlogChanged(folder, 'main');
    pmoLog({ type: 'backlog-update', by: 'user', folder, backlogId: id, from: it.status, status: it.status, note: `見出しを直す: ${title || '（本文の先頭から）'}` });
    return { ok: true };
  }
  if (op === 'done') return { ok: false, error: '動いている作業はフォルダの窓が持っています（窓が閉じていると完了にできません）' };
  if (!['done', 'failed', 'dropped'].includes(it.status)) return { ok: false, error: `backlog item ${id} is ${it.status} (only done / failed / dropped items can be put back)` };
  const st = await backlog.getBacklog(userFile('backlog'), folder);
  const next = { ...st, items: st.items.map((i) => (i.id === id ? { ...i, status: 'pending', doneAt: null, note: '' } : i)) };
  await backlog.saveBacklog(userFile('backlog'), folder, next);
  backlogChanged(folder, 'main');
  pmoLog({ type: 'backlog-update', by: 'user', folder, backlogId: id, from: it.status, status: 'pending', note: '戻す' });
  return { ok: true };
});
// Read-only view of any folder's backlog (dashboard). -> BacklogState
ipcMain.handle('backlog:getFolder', async (_e, o) => {
  const folder = o && o.folder;
  if (typeof folder !== 'string' || !folder || !path.isAbsolute(folder)) return { items: [], auto: {} };
  return backlog.getBacklog(userFile('backlog'), folder);
});

// --- global inbox + managing agent (roadmap 20, docs/plan-dashboard.md) ---------------------------
let inbox = null; // inbox.createInbox store, set when ready
let qa = null; // qa.createQa store (pre-answered QA per queued task), set with the inbox
let notices = null; // notices.createNotices store (「ルーターから」), <managerDir>/notices.json, set with the manager folder
let managerDir = null; // <userData>\manager (canonical)
let managerState = null; // the manager's window state while open
let managerTimer = null;

const windowOf = (dir) => [...windows.values()].find((s) => norm(s.workDir) === norm(dir)) || null;

function broadcast(channel, payload) {
  for (const s of windows.values()) send(s, channel, payload);
}

// backlog:changed { folder, source: 'main'|'window' } – to the folder's window only when main wrote it
// (the window reloads), and to the manager window (dashboard) for every change.
function backlogChanged(folder, source, extra = null) {
  const payload = { folder, source, ...(extra || {}) };
  const own = windowOf(folder);
  if (source === 'main') schedItemsCache.delete(norm(folder)); // main wrote the file: read it again when needed
  if (source !== 'window') backlogSame.forget(norm(folder)); // J2: a later window save is written even if it equals an older one
  if (source === 'main' && own) send(own, 'backlog:changed', payload);
  if (managerState && managerState !== own) send(managerState, 'backlog:changed', payload);
  scheduleProjects();
  autoDropSoon();
  attnTasks.delete(norm(folder));
  attentionSoon();
  reviewSoon(); // U8
}

// Route-made backlog items (r-*) per folder: last known status, to notice done / failed.
const routedSeen = new Map(); // norm(folder) -> Map<itemId, status>
function routedStatuses(folder, items, report) {
  const key = norm(folder);
  if (!routedSeen.has(key)) routedSeen.set(key, new Map());
  // r-* items, plus items tied to an inbox item by the manager's link action
  const linkedOf = (id) => (inbox ? manager.inboxIdOf(inbox.get().items, folder, id) : null);
  const finished = manager.finishedRouted(routedSeen.get(key), items, linkedOf);
  if (!report) return;
  for (const f of finished) {
    pmoLog({ type: f.item.status === 'done' ? 'done' : 'failed', folder, backlogId: f.item.id, no: f.item.no || null, title: f.item.title || null, text: String(f.item.text || '').slice(0, 300), note: f.item.note || '' });
    const what = `${path.basename(folder)}: 「${f.item.text.replace(/\s+/g, ' ').slice(0, 60)}」が${f.item.status === 'done' ? '完了' : '失敗'}`;
    const it = f.inboxId && inbox ? inbox.find(f.inboxId) : null;
    if (it && it.status === 'routed') {
      inbox.update(it.id, { status: f.item.status, note: f.item.note || it.note }, { source: 'app', finished: what });
    } else {
      notifyManager(what);
    }
  }
}

function backlogSavedByWindow(s, data) {
  if (!data || !Array.isArray(data.items)) return;
  if (s.role !== 'manager') routedStatuses(s.workDir, data.items, true);
  schedSaved(s, schedNumbered(s.workDir, data.items));
  backlogChanged(s.workDir, 'window');
}

// 依頼-136: a window's save carries new items without their number (backlog.saveBacklog numbers only its own copy, the
// window gets it with the next merge). The scheduler's reasons name items by number, so the items missing one take it
// from the saved state (the pending write, else the file) before they go into schedItemsCache.
function schedNumbered(folder, items) {
  if (!items.some((i) => i && typeof i.id === 'string' && !i.no)) return items;
  let saved;
  try {
    saved = backlog.readBacklogSync(userFile('backlog'), folder).items || [];
  } catch {
    return items;
  }
  const nos = new Map(saved.filter((i) => i && typeof i.no === 'string' && i.no).map((i) => [i.id, i.no]));
  if (!nos.size) return items;
  return items.map((i) => (i && typeof i.id === 'string' && !i.no && nos.has(i.id) ? { ...i, no: nos.get(i.id) } : i));
}

// --- backlog start rules across folders (src/main/sched.js) -----------------------------------------------
// Each window asks sched:plan before it starts waiting routed items (r-*, tabId null) in new tabs; main decides over
// all folders: at most `limit` running at once, nothing more while resources are short (unless nothing runs),
// no overlap of touches within a folder, prerequisites (after) done. Running = r-* items of open (non-manager) windows'
// folders that are active, or pending with a tabId (SCH-AS: only for 90 s from when main first saw it so, docs/sched-assigned.md),
// + reservations (ids sched:plan just started, until that folder's save shows them, at most 60 s, so a slow save cannot
// start the same item twice).
const SCHED_RESERVE_MS = 60_000;
const schedItemsCache = new Map(); // norm(folder) -> { folder, items } (last saved / read backlog of open windows)
const schedReserved = new Map(); // backlogId -> { folder, id, kind, touches, at }
const schedWaiting = new Map(); // norm(folder) -> { folder, reasons: { [id]: { code, text } } }
// SCH-AS (docs/sched-assigned.md): backlogId -> { tabId, at } when main first saw a routed item pending with a tab
// (assigned, its start not confirmed yet). It counts as running only for sched.ASSIGN_COUNT_MS from then.
const schedAssigned = new Map();
const schedStaleTold = new Set(); // ids logged once as stale
let schedLimit = sched.DEFAULT_LIMIT;
let schedThresholds = sched.normalizeThresholds(null);
// The setting 同時に動かす作業 lives in the windows (localStorage notifySettings) and comes with sched:plan. main keeps
// the last one in manager-settings.json (schedLimit / schedThresholds) and reads it at the start (startSchedClosed), so
// the queues of folders without a window are judged by the user's limit before any window has asked.
function schedLoadSettings() {
  const v = sched.settingsOf(loadManagerSettings());
  schedLimit = v.limit;
  schedThresholds = v.thresholds;
}
function schedSetSettings(o) {
  if (!o || (o.limit === undefined && o.thresholds === undefined)) return;
  const limit = o.limit !== undefined ? sched.clampLimit(o.limit) : schedLimit;
  const thresholds = o.thresholds !== undefined ? sched.normalizeThresholds(o.thresholds) : schedThresholds;
  if (limit === schedLimit && JSON.stringify(thresholds) === JSON.stringify(schedThresholds)) return;
  schedLimit = limit;
  schedThresholds = thresholds;
  try {
    manager.writeJsonAtomic(managerSettingsFile(), { ...loadManagerSettings(), schedLimit: limit, schedThresholds: thresholds });
  } catch (err) {
    console.warn('[main] saving the sched settings failed', err);
  }
  schedMaybeChanged();
}
let schedMonitor = null;
let schedChain = Promise.resolve();
let schedSig = '';
let schedChangedTimer = null;
const SCHED_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;

function schedMon() {
  if (!schedMonitor) schedMonitor = sched.createResourceMonitor({ sampleMs: 2000, windowMs: 30000 });
  return schedMonitor;
}
const isRoutedRunning = (i) => // active, or assigned to a tab (pending with a tabId; SCH-AS: counted only for a while)
  i && typeof i.id === 'string' && i.id.startsWith('r-') && (i.status === 'active' || (i.status === 'pending' && i.tabId));
const schedFolders = () => [...windows.values()].filter((s) => s.role !== 'manager' && !isManagerDir(s.workDir) && !s.win.isDestroyed());

async function schedItemsOf(folder) {
  const key = norm(folder);
  let c = schedItemsCache.get(key);
  if (!c) {
    let items = [];
    try {
      items = (await backlog.getBacklog(userFile('backlog'), folder)).items || [];
    } catch {}
    c = { folder, items };
    schedItemsCache.set(key, c);
  }
  return c.items;
}

// -> { running: [{ folder, id, kind, touches, startedAt }], statuses: Map<id, status>, nos: Map<id, no> } (open folders)
async function schedRunning() {
  const now = Date.now();
  for (const [id, r] of schedReserved) if (now - r.at > SCHED_RESERVE_MS) schedReserved.delete(id);
  const running = [];
  const statuses = new Map();
  const nos = new Map(); // the reasons name items by their number (AT-12) when they have one
  const ids = new Set();
  const assigned = new Set(); // SCH-AS: ids pending with a tab now (their clocks in schedAssigned stay)
  for (const s of schedFolders()) {
    const items = await schedItemsOf(s.workDir);
    for (const i of items) {
      if (!i || typeof i.id !== 'string') continue;
      statuses.set(i.id, i.status);
      if (typeof i.no === 'string' && i.no) nos.set(i.id, i.no);
      if (isRoutedRunning(i) && i.status === 'pending') assigned.add(i.id);
    }
    // SCH-AS: active r- items, and pending ones with a tab only for a while (sched.routedRunning, docs/sched-assigned.md)
    const r = sched.routedRunning(s.workDir, items, { now, seen: schedAssigned });
    for (const x of r.running) {
      if (ids.has(x.id)) continue;
      ids.add(x.id);
      running.push(x);
    }
    for (const id of r.stale) {
      if (schedStaleTold.has(id)) continue;
      schedStaleTold.add(id);
      console.warn(`[sched] ${id} is assigned to a tab but did not start within ${sched.ASSIGN_COUNT_MS / 1000} s: not counted as running`);
    }
  }
  sched.pruneAssigned(schedAssigned, assigned);
  for (const id of [...schedStaleTold]) if (!assigned.has(id)) schedStaleTold.delete(id);
  for (const r of schedReserved.values()) {
    if (ids.has(r.id) || isManagerDir(r.folder)) continue;
    ids.add(r.id);
    running.push({ folder: r.folder, id: r.id, kind: r.kind, touches: r.touches, startedAt: r.at });
  }
  return { running, statuses, nos };
}

// Status (and number, into nos) of `after` ids not in an open folder: looked up in the recent folders' backlogs (only when needed).
// UX11 (§1.6 row 11, docs/ux11-check.md): the folders whose queues main reads without a window. recent-folders.json
// holds only the last 12 folders the user showed (addRecent; a folder opened hidden for a route is never put there), so
// a 13th folder's queue, or a routed folder never shown, was never started. Now also every folder of the backlog's
// number registry (numbers.json) that has a backlog file.
function schedKnownFolders() {
  const dir = userFile('backlog');
  let reg = [];
  try {
    reg = backlog.knownFolders(dir).filter((e) => fs.existsSync(e.file)).map((e) => e.folder);
  } catch {}
  return lookout.knownFolders(loadRecent(), reg, (f) => isDir(f) && !isManagerDir(f));
}
// The items of a folder without a window, read again only when its backlog file changed (mtime + size): the registry
// may know many folders, read every SCHED_CLOSED_MS.
const closedItemsCache = new Map(); // file -> { mtimeMs, size, items }
async function closedItemsOf(folder) {
  const dir = userFile('backlog');
  const file = backlog.backlogFile(dir, folder);
  let st = null;
  try {
    st = fs.statSync(file);
  } catch {
    closedItemsCache.delete(file);
    return [];
  }
  const c = closedItemsCache.get(file);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.items;
  let items = [];
  try {
    items = (await backlog.getBacklog(dir, folder)).items || [];
  } catch {}
  closedItemsCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, items });
  if (closedItemsCache.size > 500) closedItemsCache.delete(closedItemsCache.keys().next().value);
  return items;
}

async function schedResolveAfter(statuses, waiting, nos = null) {
  const missing = new Set();
  for (const w of waiting) for (const a of w.after) if (!statuses.has(a)) missing.add(a);
  if (!missing.size) return;
  const seen = new Set(schedFolders().map((s) => norm(s.workDir)));
  if (managerDir) seen.add(norm(managerDir));
  for (const folder of schedKnownFolders()) {
    if (!missing.size) break;
    if (typeof folder !== 'string' || seen.has(norm(folder))) continue;
    seen.add(norm(folder));
    try {
      for (const i of await closedItemsOf(folder)) {
        if (i && missing.has(i.id)) {
          statuses.set(i.id, i.status);
          if (nos && typeof i.no === 'string' && i.no) nos.set(i.id, i.no);
          missing.delete(i.id);
        }
      }
    } catch {}
  }
}

const schedStrings = (a, max, len) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()).slice(0, max).map((x) => x.slice(0, len)) : []);
function schedSanitizeWaiting(list) {
  const out = [];
  for (const w of Array.isArray(list) ? list.slice(0, 200) : []) {
    if (!w || typeof w.id !== 'string' || !SCHED_ID_RE.test(w.id)) continue;
    out.push({
      id: w.id,
      kind: sched.KINDS.has(w.kind) ? w.kind : null,
      touches: schedStrings(w.touches, 100, 300),
      after: schedStrings(w.after, 50, 100).filter((x) => SCHED_ID_RE.test(x)),
    });
  }
  return out;
}

async function schedStateNow() {
  const { running } = await schedRunning();
  const mon = schedMon();
  const waiting = {};
  for (const w of schedWaiting.values()) if (Object.keys(w.reasons).length) waiting[w.folder] = w.reasons;
  // over: only while it holds a start back (AT-147, sched.blockingOver); overAll: every resource over its mark now
  const overAll = mon.over(schedThresholds);
  return {
    limit: schedLimit,
    thresholds: { ...schedThresholds },
    resources: { ...mon.snapshot(), over: sched.blockingOver(overAll, running, waiting), overAll },
    running,
    waiting,
    hold: schedLimitHold(), // UX12: the account-wide 上限待ち { code: 'usage', text } | null (the home's 安心の 1 行)
  };
}

// sched:changed (the state) to every window, only when limit / running / waiting reasons / resource verdict changed.
function schedMaybeChanged() {
  updatePowerBlock(); // queued items started / ended count for keep-awake
  if (!schedMonitor) return; // the scheduler was never asked: nothing to tell
  clearTimeout(schedChangedTimer);
  schedChangedTimer = setTimeout(async () => {
    try {
      const st = await schedStateNow();
      afterFailedTell(st.waiting); // UX11 row 9: a prerequisite failed -> the ルーター now
      const sig = JSON.stringify([st.limit, st.thresholds, st.running.map((r) => [r.folder, r.id]), st.waiting, st.resources.over, st.hold && st.hold.text]);
      if (sig === schedSig) return;
      schedSig = sig;
      broadcast('sched:changed', st);
      scheduleProjects(); // projects.json pendingItems[].blocked
    } catch (err) {
      console.warn('[main] sched:changed failed', err);
    }
  }, 150);
}

// A folder's window saved its backlog: cache it, release reservations it now shows, drop reasons of items that left the queue.
function schedSaved(s, items) {
  if (s.role === 'manager' || isManagerDir(s.workDir)) return;
  const key = norm(s.workDir);
  schedItemsCache.set(key, { folder: s.workDir, items });
  const byId = new Map(items.filter((i) => i && typeof i.id === 'string').map((i) => [i.id, i]));
  for (const [id, r] of schedReserved) {
    if (norm(r.folder) !== key) continue;
    const i = byId.get(id);
    if (!i || i.status !== 'pending' || i.tabId) schedReserved.delete(id);
  }
  const w = schedWaiting.get(key);
  if (w) {
    for (const id of Object.keys(w.reasons)) {
      const i = byId.get(id);
      if (!i || i.status !== 'pending' || i.tabId) delete w.reasons[id];
    }
  }
  schedMaybeChanged();
}

function schedWindowClosed(state) {
  const key = norm(state.workDir);
  if (windowOf(state.workDir)) return; // another window of the same folder (should not happen)
  schedItemsCache.delete(key);
  schedWaiting.delete(key);
  schedOpening.delete(key);
  for (const [id, r] of schedReserved) if (norm(r.folder) === key) schedReserved.delete(id);
  schedMaybeChanged();
}

// { waiting: [{ id, kind, touches, after }], limit?, thresholds? } -> { start: id[], reasons: { [id]: { code, text } } }
// The folder is the sender's. The manager window is not scheduled (its items are not routed work): all start.
ipcMain.handle('sched:plan', (e, o) => {
  const s = stateOf(e);
  if (!s) return { start: [], reasons: {} };
  const waiting = schedSanitizeWaiting(o && o.waiting);
  schedSetSettings(o); // the user's setting (every window, the manager's too), kept in manager-settings.json
  if (s.role === 'manager' || isManagerDir(s.workDir)) return { start: waiting.map((w) => w.id), reasons: {} };
  // nothing waiting = a window only telling the setting (at load / when changed, renderer schedTellSettings)
  if (!waiting.length) return { start: [], reasons: {} };
  const usage = schedLimitHold(); // UX10: 上限待ち (the API usage limit)
  if (usage) {
    const reasons = Object.fromEntries(waiting.map((w) => [w.id, { code: usage.code, text: usage.text }]));
    schedWaiting.set(norm(s.workDir), { folder: s.workDir, reasons });
    schedMaybeChanged();
    return { start: [], reasons };
  }
  // serialized: two windows asking at once must not both fill the last free slot
  const p = schedChain.then(async () => {
    schedOpening.delete(norm(s.workDir)); // a window opened for its queue (schedCheckClosed) asks for itself now
    const { running, statuses, nos } = await schedRunning();
    // 依頼-136: the window may ask before its save of these items came in; the ones it asks for are pending, so an item
    // after one of them waits (an unknown id does not block)
    for (const w of waiting) if (!statuses.has(w.id)) statuses.set(w.id, 'pending');
    await schedResolveAfter(statuses, waiting, nos);
    const mon = schedMon();
    const plan = sched.planStarts({
      waiting: waiting.map((w) => ({ ...w, folder: s.workDir })),
      running,
      items: statuses,
      limit: schedLimit,
      resources: { over: mon.over(schedThresholds) },
      thresholds: schedThresholds,
      nos,
    });
    const at = Date.now();
    for (const id of plan.start) {
      const w = waiting.find((x) => x.id === id);
      schedReserved.set(id, { folder: s.workDir, id, kind: w.kind, touches: w.touches, at });
    }
    schedWaiting.set(norm(s.workDir), { folder: s.workDir, reasons: plan.reasons });
    schedMaybeChanged();
    return plan;
  });
  schedChain = p.catch(() => {});
  return p.catch((err) => {
    console.warn('[main] sched:plan failed', err);
    return { start: [], reasons: {} };
  });
});

ipcMain.handle('sched:state', () => schedStateNow());

// --- queued routed work of folders without a window (AT-closedq) ------------------------------------------
// A route opens the target folder in a hidden window (onRouted), but after a restart nobody opens the folders whose
// queue still holds routed items, and only a window asks sched:plan: the queue stood still until the user opened the
// folder. Every SCHED_CLOSED_MS main judges those folders' r-* pending items by the same rules (sched.planClosed) and
// opens a folder with a startable item hidden, so its window starts it as for a route (docs/plan-dashboard.md 3).
// The others get their reasons in schedWaiting (closed: true), shown on the dashboard and in projects.json (blocked).
const SCHED_CLOSED_MS = Number(process.env.AGENT_TERMINAL_SCHED_CLOSED_MS) || 15_000;
const SCHED_CLOSED_FIRST_MS = Number(process.env.AGENT_TERMINAL_SCHED_CLOSED_FIRST_MS) || 10_000;
const schedOpening = new Map(); // norm(folder) -> { at, entries: [{ folder, id, kind, touches }] } (opened, its window not asked yet)
let schedClosedTimer = null;
let closedQueued = []; // UX11: the folders without a window that have queued items (last pass), also in projects.json
const UPDATE_HOLD = Object.freeze({ code: 'update', text: '更新待ち（再起動の後に始めます）' });
const schedUpdateHold = () => {
  const st = updater ? safeStatus() : null;
  return st && (st.state === 'pending' || st.state === 'restarting') ? UPDATE_HOLD : null;
};
// UX10 (docs/ux-journey.md §1.6 row 13): the API usage limit is one for the account. A window whose session got the
// limit message tells its reset time (sched:limit); until then no routed item starts anywhere (sched:plan, the closed
// folders' pass, the queue order) with the reason 上限待ち HH:MM, and a warn notice (ルーターの記録) says so; it is resolved
// at the time. Not kept over a restart (the next limit message sets it again).
const USAGE_KEY = 'app:usage-limit';
let schedUsageHold = null; // { resetAt, text, at }
let schedUsageTimer = null;
function schedLimitHold() {
  const h = Nonstop.holdOf(schedUsageHold);
  if (!h && schedUsageHold) {
    schedUsageHold = null;
    if (notices && notices.findKey(USAGE_KEY)) notices.resolve(USAGE_KEY);
  }
  return h;
}
const schedHold = () => schedUpdateHold() || schedLimitHold();
ipcMain.handle('sched:limit', (e, o) => {
  if (!stateOf(e)) return false;
  const rec = Nonstop.cleanHold(o);
  if (!rec) return false;
  const prev = schedLimitHold() ? schedUsageHold : null;
  schedUsageHold = Nonstop.laterHold(prev, rec);
  schedMaybeChanged(); // UX12: sched:changed carries the hold (the home's line), also with nothing waiting
  if (prev && prev.resetAt === schedUsageHold.resetAt) return true;
  console.log('[main] usage limit: new starts wait until', new Date(schedUsageHold.resetAt).toISOString());
  if (notices) {
    notices.add({
      kind: 'warn',
      title: `API の利用の上限: ${Nonstop.holdText(schedUsageHold)}`,
      text: [`新しい作業はこの時刻まで始めません。動いていた作業は、時刻を過ぎたら続きを送ります。`, rec.text ? `メッセージ: ${rec.text}` : ''].filter(Boolean).join('\n'),
      key: USAGE_KEY,
      source: 'app',
    });
  }
  clearTimeout(schedUsageTimer);
  schedUsageTimer = setTimeout(() => {
    schedLimitHold();
    schedMaybeChanged();
  }, Math.max(1000, schedUsageHold.resetAt - Date.now() + 1000));
  schedUsageTimer.unref?.();
  schedMaybeChanged();
  return true;
});
// HOLD-LOG (依頼-497, src/main/hold-log.js): the update hold's start / end and the ルーター's m- prompts taken meanwhile go to
// 「ルーターの記録」 (pmoLog type 'update-hold') and to <from>/.bantodesk/update/hold.jsonl, <from> = RELEASE.json's `from` (the
// dev repo the release came from), so an agent there sees them without opening <userData>. Local files only: times,
// versions, counts. E2E runs never write to <from> (a stable-check run would mix its lines in): AGENT_TERMINAL_HOLD_LOG_DIR.
const holdLog = require('./main/hold-log').createHoldLog();
const HOLD_LOG_MAX = 512 * 1024;
function holdLogDir() {
  if (require('./main/e2e').isE2E()) return process.env.AGENT_TERMINAL_HOLD_LOG_DIR || null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'RELEASE.json'), 'utf8'));
    const from = j && typeof j.from === 'string' ? j.from : '';
    if (!from || !path.isAbsolute(from) || !isDir(from) || path.resolve(from) === path.resolve(app.getAppPath())) return null;
    return path.join(from, '.bantodesk', 'update');
  } catch {
    return null; // the dev repo itself (no RELEASE.json): nothing to tell
  }
}
function holdLogWrite(lines) {
  if (!Array.isArray(lines) || !lines.length) return;
  for (const l of lines) if (l.ev !== 'start') pmoLog({ type: 'update-hold', ...l });
  try {
    const dir = holdLogDir();
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'hold.jsonl');
    const at = new Date().toISOString();
    const userData = path.basename(app.getPath('userData'));
    fs.appendFileSync(file, lines.map((l) => JSON.stringify({ at, app: userData, pid: process.pid, ...l }) + '\n').join(''));
    if (fs.statSync(file).size > HOLD_LOG_MAX) {
      const text = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, text.slice(text.indexOf('\n', text.length - HOLD_LOG_MAX / 2) + 1));
    }
  } catch (err) {
    console.warn('[main] hold log failed', err && err.message);
  }
}
function safeStatus() {
  try {
    return updater.status();
  } catch {
    return null;
  }
}

async function schedCheckClosed() {
  if (quitting) return { open: [], reasons: {} };
  const p = schedChain.then(async () => {
    const now = Date.now();
    for (const [k, o] of schedOpening) if (now - o.at > SCHED_RESERVE_MS || !windowOf(o.folder)) schedOpening.delete(k);
    const seen = new Set();
    const folders = [];
    for (const folder of schedKnownFolders()) {
      const key = norm(folder);
      if (seen.has(key) || isManagerDir(folder) || windowOf(folder)) continue;
      seen.add(key);
      const items = await closedItemsOf(folder);
      // a folder outside recent-folders.json is judged only when it has something queued (UX11: no empty passes)
      if (!items.some((i) => i && (i.status === 'pending' || i.status === 'active'))) continue;
      folders.push({ folder, items });
    }
    closedQueued = folders.map((f) => f.folder);
    const { running, statuses, nos } = await schedRunning();
    const ids = new Set(running.map((r) => r.id));
    for (const o of schedOpening.values()) for (const e of o.entries) if (!ids.has(e.id)) running.push({ ...e, startedAt: o.at });
    for (const f of folders) for (const i of f.items) if (i && typeof i.id === 'string' && !statuses.has(i.id)) statuses.set(i.id, i.status);
    await schedResolveAfter(statuses, folders.flatMap((f) => sched.closedWaiting(f.items)), nos);
    const plan = sched.planClosed({
      folders,
      running,
      items: statuses,
      limit: schedLimit, // the user's setting from the start (schedLoadSettings), not only after a window asked
      resources: { over: schedMon().over(schedThresholds) },
      hold: schedHold(),
      nos,
    });
    for (const [k, w] of schedWaiting) if (w.closed) schedWaiting.delete(k); // this pass's reasons replace the last one's
    for (const [folder, reasons] of Object.entries(plan.reasons)) {
      if (Object.keys(reasons).length) schedWaiting.set(norm(folder), { folder, reasons, closed: true });
    }
    for (const o of plan.open) {
      const w = folders.find((f) => f.folder === o.folder);
      const s = openWindow(o.folder, { hidden: true }); // loads the backlog itself and asks sched:plan (renderer)
      if (!s) {
        const why = { code: 'closed', text: 'フォルダを開けませんでした（開くと始まります）' };
        const reasons = { ...(plan.reasons[o.folder] || {}) };
        for (const id of o.start) reasons[id] = why;
        schedWaiting.set(norm(o.folder), { folder: o.folder, reasons, closed: true });
        continue;
      }
      const entries = sched.closedWaiting(w ? w.items : []).filter((x) => o.start.includes(x.id)).map((x) => ({ folder: o.folder, id: x.id, kind: x.kind, touches: x.touches }));
      schedOpening.set(norm(o.folder), { folder: o.folder, at: now, entries });
      console.log(`[sched] opened ${o.folder} (hidden) for its queue: ${o.start.join(', ')}`);
    }
    schedMaybeChanged();
    return plan;
  });
  schedChain = p.catch(() => {});
  return p.catch((err) => {
    console.warn('[main] sched closed folders failed', err);
    return { open: [], reasons: {} };
  });
}
function startSchedClosed() {
  if (schedClosedTimer) return;
  schedLoadSettings(); // the user's limit / thresholds, before the first look and before any window asks
  const tick = (ms) => {
    schedClosedTimer = setTimeout(async () => {
      await schedCheckClosed();
      if (!quitting) tick(SCHED_CLOSED_MS);
    }, ms);
    schedClosedTimer.unref?.();
  };
  tick(SCHED_CLOSED_FIRST_MS);
}

// The scheduler's reason why a pending item does not start yet (projects.json pendingItems[].blocked), or null.
function schedBlockedOf(folder, item) {
  if (!item || item.status !== 'pending') return null;
  const w = schedWaiting.get(norm(folder));
  return require('./main/blocked-of').blockedOf(item, schedUpdateHold(), w && w.reasons[item.id]);
}

// --- sched:alert: a routed session stopped without its done mark / a team deadlock / aborted (renderer watches) ---
// Told once per backlogId + kind: a 見回り line to the manager agent (in the same block as the stuck prompts, see
// checkStuck) + a warn notice (key app:sched:<backlogId>). kind 'resumed' resolves the notice and drops the line.
const SCHED_ALERT_KINDS = new Set(['stalled', 'deadlock', 'aborted', 'nostart', 'resumed']); // nostart: SCH-AS
const schedAlerted = new Set(); // `${backlogId}\n${kind}`
const schedNotes = new Map(); // backlogId -> { line, at } (見回り lines for the manager agent)
const SCHED_NOTE_MS = 60 * 60 * 1000;
function withSchedNotes(base) {
  const now = Date.now();
  for (const [id, n] of schedNotes) if (now - n.at > SCHED_NOTE_MS) schedNotes.delete(id);
  base = [base, waitsBase].filter(Boolean).join('\n'); // + 終わらない待ち (checkWaits)
  const lines = [...schedNotes.values()].slice(-8).map((n) => n.line);
  if (!lines.length) return base;
  const block = ['見回り（バックログの作業）:', ...lines.map((l) => `- ${l}`)].join('\n');
  return [base, block].filter(Boolean).join('\n');
}
// UX11 (§1.6 row 9): an item whose prerequisite (after) failed waits forever; the ルーター read it only from blocked in
// projects.json at a patrol. Every scheduler change (sched:plan of a window, the closed folders' pass) its reasons are
// looked at; a new after-failed one is a 見回り line now (schedNotes, wakes the ルーター), told once per item until it goes
// away (then a recurrence is new again).
const afterFailedTold = new Set(); // lookout.afterFailed keys
function schedItemOf(folder, id) {
  const c = schedItemsCache.get(norm(folder));
  const fromCache = c && Array.isArray(c.items) ? c.items.find((i) => i && i.id === id) : null;
  if (fromCache) return fromCache;
  const cc = closedItemsCache.get(backlog.backlogFile(userFile('backlog'), folder));
  return cc ? cc.items.find((i) => i && i.id === id) || null : null;
}
function afterFailedTell(waiting) {
  const list = lookout.afterFailed(
    Object.entries(waiting || {}).map(([folder, reasons]) => ({ folder, reasons })),
    schedItemOf,
  );
  const now = new Set(list.map((x) => x.key));
  for (const k of [...afterFailedTold]) if (!now.has(k)) afterFailedTold.delete(k);
  const fresh = list.filter((x) => !afterFailedTold.has(x.key));
  if (!fresh.length) return;
  for (const x of fresh) {
    afterFailedTold.add(x.key);
    schedNotes.set(x.id, { line: x.line, at: Date.now() });
    pmoLog({ type: 'after-failed', folder: x.folder, backlogId: x.id, text: x.line });
  }
  console.log(`[sched] after-failed -> ルーター: ${fresh.map((x) => x.id).join(', ')}`);
  schedTellManager();
}
function schedTellManager() {
  if (!managerDir || !inbox) return;
  stuckBlock = withSchedNotes(stuckBase);
  manager
    .notifyManager(userFile('backlog'), managerDir, { newItems: newForManager(), stuck: stuckBlock, wake: true })
    .then((r) => r && backlogChanged(managerDir, 'main'))
    .catch((err) => console.warn('[main] sched alert -> manager failed', err));
}
// { backlogId, kind, text } -> boolean (true = told now; false = invalid or already told)
ipcMain.handle('sched:alert', (e, o) => {
  const s = stateOf(e);
  if (!s || !o || typeof o.backlogId !== 'string' || !SCHED_ID_RE.test(o.backlogId) || !SCHED_ALERT_KINDS.has(o.kind)) return false;
  const id = o.backlogId;
  const key = `app:sched:${id}`;
  if (o.kind === 'resumed') {
    let had = false;
    for (const k of [...schedAlerted]) {
      if (k.startsWith(id + '\n')) {
        schedAlerted.delete(k);
        had = true;
      }
    }
    if (schedNotes.delete(id)) {
      // the line goes from a still pending prompt (wake: false = no new prompt for it)
      stuckBlock = withSchedNotes(stuckBase);
      if (managerDir && inbox) {
        manager
          .notifyManager(userFile('backlog'), managerDir, { newItems: newForManager(), stuck: stuckBlock, wake: false })
          .then((r) => r && backlogChanged(managerDir, 'main'))
          .catch((err) => console.warn('[main] sched resumed -> manager failed', err));
      }
    }
    if (notices && notices.findKey(key)) notices.resolve(key);
    return had;
  }
  const once = `${id}\n${o.kind}`;
  if (schedAlerted.has(once)) return false;
  schedAlerted.add(once);
  const name = path.basename(s.workDir) || s.workDir;
  // 見回りの検出 (6): the last reply says it waits, but waits has nothing to wait on for this item
  let lonely = '';
  if (o.kind === 'stalled' && typeof o.reply === 'string') {
    const we = waitEntries.find((e) => e && e.backlogId === id && e.role !== 'manager');
    lonely = patrolGapsMod.noTarget(o.reply.slice(-400), we ? we.wait : null);
  }
  const detail = oneLineText([o.text, lonely].filter(Boolean).join(' '), 400);
  const what =
    o.kind === 'deadlock'
      ? 'チームが互いの返事を待って止まっている可能性があります'
      : o.kind === 'aborted'
        ? '作業が完了の印のないまま終わりました'
        : o.kind === 'nostart'
          ? '作業を割り当てたセッションで開始を確かめられず、失敗にしました'
          : '作業が完了の印のないまま止まっています';
  const title = `「${name}」の${what}（${id}）`;
  schedNotes.set(id, { line: `「${name}」の ${id}: ${what}${detail ? ` — ${detail}` : ''}`.slice(0, 420), at: Date.now() });
  schedTellManager();
  if (notices) {
    notices.add({
      kind: 'warn',
      title,
      text: `${detail || '（詳細なし）'}\n\nそのフォルダのタブで様子を見て、続けるか止めるかを決めてください。`,
      folder: s.workDir,
      itemId: id,
      key,
      source: 'app',
    });
  }
  return true;
});

// { team } -> { unread: number } (~/.claude/teams/<team>/inboxes/*.json, elements whose read !== true; -1 = none / unreadable)
ipcMain.handle('teams:unread', async (_e, o) => {
  const team = o && o.team;
  if (typeof team !== 'string' || !teams.TEAM_NAME_RE.test(team)) return { unread: -1 };
  return { unread: await teams.unreadCount(team) };
});

// Inbox items to offer the manager as new work: status new, not put there (or back) by the manager itself
// (an item the manager added with the inbox action must not come back to it as new work — no loop).
const newForManager = () => inbox.get().items.filter((i) => i.status === 'new' && i.statusBy !== 'manager');
function notifyManager(finished) {
  if (!managerDir || !inbox) return;
  const newItems = newForManager();
  manager
    .notifyManager(userFile('backlog'), managerDir, { newItems, finished: finished || null })
    .then((r) => r && backlogChanged(managerDir, 'main'))
    .catch((err) => console.warn('[main] notifyManager failed', err));
}

// --- AT-carryover (src/main/carryover.js, docs/plan-carryover.md) ---------------------------------------------------------
// A project folder opened: when this userData has never imported it and its backlog is empty, its unfinished PROGRESS.md
// rows (and docs/roadmap.md rows PROGRESS.md does not list) go to the inbox as hold items, and the ルーター gets one line.
// Waits for the inbox / manager (started after the first window) for up to 3 minutes. AGENT_TERMINAL_NO_CARRYOVER=1 disables.
// Off under the e2e mark unless AGENT_TERMINAL_CARRYOVER=1 (older e2e tests open folders with a PROGRESS.md and count inbox items).
const carryoverBusy = new Set();
function carryoverSoon(folder, tries = 0) {
  if (process.env.AGENT_TERMINAL_NO_CARRYOVER === '1') return;
  if (require('./main/e2e').isE2E() && process.env.AGENT_TERMINAL_CARRYOVER !== '1') return;
  const t = setTimeout(() => {
    if (!inbox || !managerDir) {
      if (tries < 36) carryoverSoon(folder, tries + 1);
      return;
    }
    carryoverRun(folder, { manual: false }).catch((err) => console.warn('[main] carry-over failed', err));
  }, tries ? 5000 : 1500);
  t.unref?.();
}
async function carryoverRun(folder, { manual }) {
  if (!inbox) return { error: 'inbox not ready' };
  if (isManagerDir(folder)) return { error: 'manager folder' };
  const k = norm(folder);
  if (carryoverBusy.has(k)) return { error: 'busy' };
  carryoverBusy.add(k);
  try {
    const ud = app.getPath('userData');
    const state = carryover.loadState(ud);
    const backlogItems = (await backlog.getBacklog(userFile('backlog'), folder)).items || [];
    const p = carryover.plan({ folder, manual, backlogItems, inboxItems: inbox.get().items, state });
    if (!p.run) return { added: 0, skipped: 0, more: 0, reason: p.reason };
    const today = new Date().toISOString().slice(0, 10);
    const added = [];
    for (const c of p.add) {
      const it = inbox.add({ ...carryover.inboxItemOf(folder, c, today), source: 'app' });
      if (it) added.push({ key: c.key, inboxId: it.id, reqNo: it.reqNo });
    }
    // recorded even when nothing was new: the automatic import runs once per folder and userData
    carryover.saveState(ud, carryover.record(state, folder, added));
    console.log(`[main] carry-over ${folder}: ${added.length} added, ${p.skipped.length} skipped, ${p.more} more (${p.reason})`);
    if (added.length && managerDir) {
      manager
        .notifyManager(userFile('backlog'), managerDir, { newItems: newForManager(), imported: carryover.pmoLine(folder, added, p.more) })
        .then((r) => r && backlogChanged(managerDir, 'main'))
        .catch((err) => console.warn('[main] notifyManager (carry-over) failed', err));
    }
    return { added: added.length, skipped: p.skipped.length, more: p.more, reason: p.reason };
  } finally {
    carryoverBusy.delete(k);
  }
}

function onInboxChange(_state, info) {
  clearTimeout(onInboxChange.t);
  onInboxChange.t = setTimeout(() => broadcast('inbox:changed', inbox.get()), 150);
  scheduleProjects();
  widget.changed(); // inbox counts
  attentionSoon();
  reviewSoon(); // U8: a new request takes 「すべて完了」 off
  // user and session (U7 propose) adds are new work for the ルーター; manager / app (carry-over, hold) adds: no new-work line
  if (info.type === 'add' && (info.source === 'user' || info.source === 'session')) notifyManager();
  else if (info.type === 'update' && info.source !== 'manager' && info.prev.status !== info.item.status) {
    if (info.item.status === 'done' || info.item.status === 'failed') {
      notifyManager(info.finished || `${info.item.id} 「${info.item.text.replace(/\s+/g, ' ').slice(0, 60)}」が${info.item.status === 'done' ? '完了' : '失敗'}`);
    } else if (info.item.status === 'new') notifyManager(); // put back into the inbox
  }
}

// manager/inbox.json + manager/projects.json, rewritten (debounced) on inbox / backlog / window changes.
let projectsTimer = null;
let projectsRunning = false;
let projectsGen = 0; // AT-202: build number, so a late build never overwrites a newer projects.json
let projectsWrittenGen = 0;
async function currentProjects() {
  const recent = loadRecent();
  const known = new Set(recent.map(norm));
  // plus open windows not in the recent list (e.g. hidden ones opened for routed work)
  for (const s of windows.values()) if (!s.temp && !known.has(norm(s.workDir))) (recent.push(s.workDir), known.add(norm(s.workDir))); // not temp / edit folders
  // UX11: and the folders outside the recent list whose queue main found (schedCheckClosed), so the card shows its reasons
  for (const f of closedQueued) if (!known.has(norm(f))) (recent.push(f), known.add(norm(f)));
  return manager.buildProjects({
    recent,
    managerDir,
    backlogDir: userFile('backlog'),
    isOpen: (dir) => !!windowOf(dir),
    qaStatus: (folder, id) => (qa ? qa.statusOf(qaStore.backlogKey(folder, id)) : 'none'),
    blockedOf: schedBlockedOf, // why a pending item does not start yet (sched:plan of its window / schedCheckClosed)
    modelDefaults: models.fromSettings(loadManagerSettings()), // AT-6: pendingItems[].model / effort
    reviewOf: (folder) => (reviewStore ? review.summary(reviewStore.get(folder)) : null), // U8: 「すべて完了」 / a running review
    outlookOf: (folder) => outlooks().get(folder), // UX11: the ルーター's 見立て (outbox outlook)
  });
}
function scheduleProjects() {
  if (!managerDir) return;
  clearTimeout(projectsTimer);
  projectsTimer = setTimeout(async () => {
    if (projectsRunning) return scheduleProjects();
    projectsRunning = true;
    try {
      const inboxItems = inbox ? inbox.get().items : [];
      // + qa: 'none'|'open'|'answered' per item (pre-answered QA, see src/main/qa.js; routed items: see projects.json pendingItems)
      manager.writeJsonAtomic(path.join(managerDir, 'inbox.json'), {
        items: inboxItems.map((i) => ({ ...i, qa: qa ? qa.statusOf(qaStore.inboxKey(i.id)) : 'none' })),
      });
      // AT-202: a build that does not come back in time does not hold the guard (and every later snapshot); a late one
      // is still written unless a newer build was written first
      const gen = ++projectsGen;
      const write = (list) => {
        if (gen < projectsWrittenGen) return;
        projectsWrittenGen = gen;
        manager.writeJsonAtomic(path.join(managerDir, 'projects.json'), list);
      };
      const built = await timebox(currentProjects(), timeboxLimits.snapshot(), {
        label: 'projects.json',
        onLate: (list) => list && write(list),
      });
      if (built === TIMED_OUT) scheduleProjects(); // try again with fresh data
      else write(built);
    } catch (err) {
      console.warn('[main] writing manager files failed', err);
    }
    projectsRunning = false;
  }, 800);
}

// ルーター patrol (roadmap 20 stage 2, src/main/pmo.js): every patrolMinutes (manager settings, default 5, 1-60; PM1 段 1,
// 依頼-64; first ~2 min after start) look for neglected inbox / backlog items; when some were not reported before, add a
// "見回り" block to the manager prompt. Each round also diffs a summary of the state with the last one (src/main/triage.js):
// the unsure changes go to haiku, and the ルーター is woken only when there is something to act on (haiku failing = woken,
// a change haiku let pass = woken within 30 min). patrolTriage: false turns the haiku part off.
// Once a day (first patrol ≥ 24 h after the last one) it is a "棚卸し" that re-reports everything still stale.
// Reported keys + the last stocktake time are kept in manager/pmo.json so a restart does not repeat a report.
let patrolTimer = null;
let patrolRunning = false;
// Current stale findings (pmo.findStale) over the inbox + the backlogs of recent folders and open windows.
async function currentStale(now = Date.now(), out = null) {
  if (!managerDir || !inbox) return [];
  const recent = loadRecent();
  for (const s of windows.values()) recent.push(s.workDir);
  const seen = new Set([norm(managerDir)]);
  const backlogs = [];
  for (const folder of recent) {
    if (typeof folder !== 'string' || seen.has(norm(folder))) continue;
    seen.add(norm(folder));
    const w = schedWaiting.get(norm(folder));
    backlogs.push({
      folder,
      items: (await backlog.getBacklog(userFile('backlog'), folder)).items,
      reasons: w ? w.reasons : null, // the scheduler's last reasons (順番待ち / 前提待ち)
      progress: progressFile.progressSummary(folder), // PROGRESS.md 確認待ち piling up (roadmap 48)
    });
  }
  const qaStatus = (folder, id) => (!qa ? 'none' : qa.statusOf(folder ? qaStore.backlogKey(folder, id) : qaStore.inboxKey(id)));
  const findings = pmo.findStale({ inboxItems: inbox.get().items, backlogs, now, qaStatus });
  if (out) out.backlogs = backlogs; // the patrol's triage summary (triage.snapshotOf)
  syncPatrolNotice(findings);
  return findings;
}
// The patrol's findings as one warn notice in 「ルーターから」 (key app:patrol), resolved when nothing is stale any more.
// It is unread (announced) again only when a finding appears that the notice did not list yet.
function syncPatrolNotice(findings) {
  if (!notices) return;
  try {
    const n = noticesStore.patrolNotice(findings, pmo.ageText);
    const prev = notices.findKey(noticesStore.PATROL_KEY);
    if (!n) {
      if (prev) notices.resolve(noticesStore.PATROL_KEY);
      return;
    }
    const known = new Set(prev ? prev.refs : []);
    notices.add({ ...n, quiet: !!prev && n.refs.every((k) => known.has(k)) });
  } catch (err) {
    console.warn('[main] patrol notice failed', err);
  }
}
// 見回りの検出 (src/main/patrol-gaps.js): the ways work stopped that the patrol missed, found by
// code (no model). Reads only what the app itself has: the backlogs, the scheduler's reasons, its own tabs' TabState,
// the outbox failed/ folders, git status of the known folders, notices.json. gs = pmo.json gaps ({ reported, notStart,
// dirty }). -> { findings, decision, state (to keep) }
const GAP_GIT_FOLDERS = 12;
const GAP_FAILED_RECENT_MS = 24 * 60 * 60 * 1000;
async function patrolGaps(now, backlogs, gs = {}) {
  // (4) the refused files told before (same name and mtime) are left out; the stocktake counts them (holdProposals)
  const set = patrolGapsMod.settingsOf(loadManagerSettings());
  const testEnv = (k) => (require('./main/e2e').isE2E() && Number(process.env[k])) || 0; // tests (e2e mark) may shorten them
  const sessions = widget.sessionsSnapshot();
  const findings = [];
  // (2) the first pending item with no reason does not start
  const ns = patrolGapsMod.findNotStarting(backlogs, gs.notStart || {}, { now, blocked: schedBlockedOf, notStartMin: testEnv('AGENT_TERMINAL_GAP_NOT_START_MIN') || set.notStartMin });
  findings.push(...ns.findings);
  // (3) endless watches / leftovers after 作業完了 (only the commands this app's own tabs reported)
  findings.push(...patrolGapsMod.findWatches(sessions, { now, timeoutOf: waits.timeoutOf, leftoverMin: set.leftoverMin }));
  // (4) refused propose files (new in 24 h) and folders near the 24 h limit
  const folders = [];
  for (const f of [...backlogs.map((b) => b.folder), ...proposeFolders()]) if (typeof f === 'string' && !folders.some((x) => norm(x) === norm(f))) folders.push(f);
  const failed = [];
  for (const folder of folders) {
    for (const box of propose.outboxesOf(folder)) {
      const dir = path.join(box, 'failed');
      let names = [];
      try {
        names = await fs.promises.readdir(dir);
      } catch {
        continue; // none
      }
      for (const name of names.filter((n) => /\.json$/i.test(n) && !/\.result\.json$/i.test(n)).slice(-50)) {
        const file = path.join(dir, name);
        try {
          const st = await fs.promises.stat(file);
          if (!st.isFile() || now - st.mtimeMs > GAP_FAILED_RECENT_MS || st.size > 256 * 1024) continue;
          const text = await fs.promises.readFile(file, 'utf8');
          const error = await fs.promises.readFile(file + '.error.txt', 'utf8').catch(() => '');
          failed.push({ folder, dir, name, error: error.trim(), title: patrolGapsMod.titleOf(text), at: st.mtimeMs });
        } catch {}
      }
    }
  }
  const items = inbox.get().items;
  const counts = folders.map((folder) => ({ folder, day: items.filter((i) => i.source === 'session' && i.folder && norm(i.folder) === norm(folder) && now - (i.createdAt || 0) < 24 * 60 * 60 * 1000).length, max: propose.dayLimitOf(loadManagerSettings()) })); // SCH-HO 4: the setting proposeDayMax (default 30)
  const hp = patrolGapsMod.holdProposals(patrolGapsMod.findProposals(failed, counts) /* 依頼-414: near = nearOf(each folder's max) */, gs.proposeSeen || {});
  findings.push(...hp.findings);
  // (5) (7) git status of the folders with work (read only, on offthread's worker, ≤ GAP_GIT_FOLDERS a round)
  const gitCounts = {};
  const dirty = [];
  for (const b of backlogs.slice(0, GAP_GIT_FOLDERS)) {
    if (!b || typeof b.folder !== 'string' || isManagerDir(b.folder)) continue;
    const c = await timebox(gitTools.uncommittedCount(b.folder), 20000, { label: 'patrol git status' }).catch(() => null);
    const count = c === TIMED_OUT ? null : c;
    gitCounts[norm(b.folder)] = count;
    const busyTab = sessions.some((x) => x.role !== 'manager' && x.workDir && norm(x.workDir) === norm(b.folder) && !x.t.rest && x.t.status !== 'idle' && !x.t.exited);
    const busy = busyTab || (b.items || []).some((i) => i && i.status === 'active');
    dirty.push({ folder: b.folder, count, busy });
  }
  findings.push(...patrolGapsMod.findResumeFailed(backlogs, gitCounts, { now }));
  const dr = patrolGapsMod.findDirty(dirty, gs.dirty || {}, { now, dirtyCount: set.dirtyCount, dirtyHours: testEnv('AGENT_TERMINAL_GAP_DIRTY_HOURS') || set.dirtyHours });
  findings.push(...dr.findings);
  // (8) proposals past their 期限 with no answer
  if (notices) findings.push(...patrolGapsMod.findDeadlines(notices.list(), { now }));
  const decision = patrolGapsMod.decide(findings, gs.reported || []);
  return { findings, decision, held: hp.held, state: { reported: decision.keys, notStart: ns.seen, dirty: dr.since, proposeSeen: hp.seen } };
}
async function runPatrol() {
  if (!managerDir || !inbox || patrolRunning) return null;
  patrolRunning = true;
  try {
    const now = Date.now();
    const file = path.join(managerDir, 'pmo.json');
    let saved = {};
    try {
      saved = manager.readJsonFile(file) || {}; // sees a write still queued (writeJsonAtomic is async)
    } catch {}
    const reported = Array.isArray(saved.reported) ? saved.reported : [];
    const lastStocktake = Number(saved.stocktakeAt) || 0;
    // 依頼-188: the progress check once before the stocktake (unless it is turned off), so the stocktake sees today's gaps
    if (pmo.stocktakeDue(lastStocktake, now) && progressChecker && progressCheck.intervalOf(loadManagerSettings())) {
      try {
        await progressChecker.runOnce();
      } catch (err) {
        console.warn('[main] progress check before the stocktake failed', err);
      }
    }
    const state = {};
    const stale = await currentStale(now, state);
    // the gaps to act on (done-open / pending-done, confirmed by haiku) join the patrol block, once per key (reported)
    const gaps = progressChecker && progressCheck.intervalOf(loadManagerSettings()) ? progressCheck.patrolFindings(progressChecker.actions(), now) : [];
    const findings = stale.concat(gaps);
    const d = pmo.patrolDecision(findings, reported, { lastStocktake, now });
    // 保留 (hold) items become findings only after 3 days (pmo.STALE); the daily stocktake lists the others as 「保留 N 件」
    const held = d.stocktake ? inbox.get().items.filter((i) => i.status === 'hold') : [];
    if (d.stocktake && held.length) d.report = true;
    // 前さばき (PM1 段 1): the state summary vs the last patrol's
    const settings = loadManagerSettings();
    const tsaved = saved.triage && typeof saved.triage === 'object' ? saved.triage : {};
    const readOr = (name) => {
      try {
        return manager.readJsonFile(path.join(managerDir, name));
      } catch {
        return null; // not written yet
      }
    };
    const cur = triage.snapshotOf({
      inboxItems: inbox.get().items,
      backlogs: state.backlogs || [],
      waits: readOr('waits.json'),
      sessions: readOr('sessions.json'),
    });
    const wakeAt = Number(tsaved.wakeAt) || Number(saved.at) || now;
    const t = await triage.triageRound({
      prev: tsaved.snap || null,
      cur,
      fresh: d.report,
      enabled: triage.triageOn(settings),
      passed: Array.isArray(tsaved.passed) ? tsaved.passed : [],
      lastWakeAt: wakeAt,
      now,
      context: findings.slice(0, 8).map((f) => `放置: ${f.name} ${f.status} ${f.id} 「${String(f.text || '').slice(0, 40)}」`),
      ask: (prompt) => haikuRunner().run(prompt, { program: haikuProgram(), args: triage.HAIKU_ARGS, timeoutMs: triage.TIMEOUT_MS }),
    });
    if (t.called && !t.ok) console.warn('[main] patrol triage: haiku', t.error);
    // 見回りの検出: facts by code, before the triage; a new one wakes the ルーター (each key once, like the stale findings)
    const gsaved = saved.gaps && typeof saved.gaps === 'object' ? saved.gaps : {};
    let gaps2 = null;
    try {
      gaps2 = await patrolGaps(now, state.backlogs || [], gsaved);
    } catch (err) {
      console.warn('[main] patrol gaps failed', err);
    }
    const gapWake = !!(gaps2 && gaps2.decision.report);
    if (d.report || t.wake || gapWake) {
      const gapText = gaps2 ? patrolGapsMod.format(gaps2.findings, gaps2.decision.fresh, { stocktake: d.stocktake, held: gaps2.held }) : '';
      const patrol = [gapText, d.report ? pmo.formatPatrol(findings, d.fresh, { stocktake: d.stocktake, held }) : '', triage.formatTriage(t)].filter(Boolean).join('\n').slice(0, 2000);
      const r = await manager.notifyManager(userFile('backlog'), managerDir, { newItems: newForManager(), patrol });
      if (r) backlogChanged(managerDir, 'main');
    }
    const round = { at: now, unsure: t.unsure.length, called: t.called, ok: t.ok, wake: d.report || t.wake || gapWake, reason: d.report ? 'stale' : t.reason || (gapWake ? 'gaps' : null), gaps: gaps2 ? gaps2.findings.length : null };
    manager.writeJsonAtomic(file, {
      ...saved,
      reported: d.keys,
      at: now,
      stocktakeAt: d.stocktake ? now : lastStocktake,
      triage: { snap: cur, passed: t.passed, wakeAt: d.report || t.wake || gapWake ? now : wakeAt, round, calls: (Number(tsaved.calls) || 0) + (t.called ? 1 : 0) },
      gaps: gaps2 ? { ...gaps2.state, findings: gaps2.findings.slice(0, 30).map((g) => ({ key: g.key, kind: g.kind, name: g.name, text: g.text })) } : gsaved,
    });
    return { findings: findings.length, gaps: gaps.length, reported: d.report, stocktake: d.stocktake, triage: round, patrolGaps: gaps2 ? gaps2.findings.map((g) => g.key) : null };
  } catch (err) {
    console.warn('[main] patrol failed', err);
    return null;
  } finally {
    patrolRunning = false;
  }
}
function startPatrol() {
  if (patrolTimer) return;
  const first = Number(process.env.AGENT_TERMINAL_PATROL_FIRST_MS) || pmo.PATROL_FIRST_MS; // tests may shorten it
  const e2e = require('./main/e2e').isE2E();
  // the interval is read again each round (a changed setting counts from the next round); tests (e2e mark): _EVERY_MS
  const every = () => (e2e && Number(process.env.AGENT_TERMINAL_PATROL_EVERY_MS)) || triage.patrolEveryMs(loadManagerSettings());
  const tick = (ms) => {
    patrolTimer = setTimeout(async () => {
      await runPatrol();
      if (!quitting) tick(every());
    }, ms);
  };
  tick(first);
}

// The one claude -p runner of the app (src/main/triage.js): the patrol's triage and the progress check share it, so
// at most one haiku runs at a time; nothing is started while free memory is under the scheduler's mark (同時に動かす作業).
let haikuRunnerObj = null;
function haikuRunner() {
  if (!haikuRunnerObj) {
    haikuRunnerObj = triage.createRunner({
      cwd: userFile('haiku'),
      memOk: () => !schedMon().over({ minFreeMB: schedThresholds.minFreeMB, maxCpuPct: null, maxLagMs: null }).length,
    });
  }
  return haikuRunnerObj;
}
// claude itself, or (tests, e2e mark only) AGENT_TERMINAL_HAIKU_CMD = a .js file run by this executable as node
function haikuProgram() {
  const e2e = require('./main/e2e').isE2E();
  const fake = e2e ? process.env.AGENT_TERMINAL_HAIKU_CMD : null;
  return fake ? { file: process.execPath, pre: [fake], env: { ELECTRON_RUN_AS_NODE: '1' } } : progressCheck.claudeProgram(claudeCmd);
}

// 進み具合の確認 (PM1 段 3, src/main/progress-check.js): every progressCheckMinutes (manager settings, default 60, 0 = off)
// compare each recent / open folder's PROGRESS.md with its backlog; gaps -> one haiku call for all folders -> one info per
// folder in 「ルーターから」 (key app:progress:<folder>). haiku failing: nothing shown, the ルーター is not woken, next round again.
// Tests (e2e mark only): AGENT_TERMINAL_HAIKU_CMD = a .js file run by this executable as node instead of claude,
// AGENT_TERMINAL_PROGRESS_FIRST_MS / AGENT_TERMINAL_PROGRESS_EVERY_MS shorten the timer.
let progressChecker = null;
let progressTimer = null;
let progressTick = null; // (ms) -> arm the next round (startProgressCheck)
function progressFolders() {
  const recent = loadRecent();
  for (const s of windows.values()) recent.push(s.workDir);
  const seen = new Set(managerDir ? [norm(managerDir)] : []);
  const out = [];
  for (const folder of recent) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder) || seen.has(norm(folder))) continue;
    seen.add(norm(folder));
    out.push(folder);
  }
  return out;
}
function startProgressCheck() {
  if (progressChecker || !notices) return;
  const e2e = require('./main/e2e').isE2E();
  progressChecker = progressCheck.createProgressCheck({
    notices,
    folders: async () => {
      const list = [];
      for (const folder of progressFolders()) {
        const progress = progressFile.readProgress(folder);
        if (!progress) continue;
        list.push({ folder, progress, items: (await backlog.getBacklog(userFile('backlog'), folder)).items, checkList: progressCheck.checkListOf(folder) });
      }
      return list;
    },
    ask: async (prompt) => {
      const r = await haikuRunner().run(prompt, { program: haikuProgram(), args: progressCheck.HAIKU_ARGS, timeoutMs: progressCheck.HAIKU_TIMEOUT_MS });
      if (!r.ok) console.warn('[main] progress check: haiku', r.error);
      return r.ok ? r.stdout : null;
    },
  });
  // the setting is read each round; 0 (止める) wins over the test interval (e2e mark: _EVERY_MS)
  const every = () => {
    const v = progressCheck.intervalOf(loadManagerSettings());
    return v && ((e2e && Number(process.env.AGENT_TERMINAL_PROGRESS_EVERY_MS)) || v);
  };
  const tick = (ms) => {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = setTimeout(async () => {
      progressTimer = null;
      if (quitting) return;
      if (every()) {
        try {
          await progressChecker.runOnce();
        } catch (err) {
          console.warn('[main] progress check failed', err);
        }
      }
      if (!quitting && !progressTimer) tick(every() || 10 * 60 * 1000); // off: look at the setting again in 10 min
    }, ms);
    progressTimer.unref?.();
  };
  progressTick = () => tick(every() || 10 * 60 * 1000);
  tick((e2e && Number(process.env.AGENT_TERMINAL_PROGRESS_FIRST_MS)) || progressCheck.FIRST_MS);
}

function startManager({ show = false } = {}) {
  if (!managerDir) return null;
  clearTimeout(managerTimer);
  managerTimer = null;
  return openWindow(managerDir, { hidden: !show });
}
// After the first project window: the manager starts hidden a little later (off the startup path).
function scheduleManagerStart() {
  if (managerState || managerTimer || !managerDir) return;
  if (process.env.AGENT_TERMINAL_NO_MANAGER === '1') return; // tests: no background manager window (opens on dashboard:open)
  managerTimer = setTimeout(() => {
    managerTimer = null;
    if (!managerState && !quitting) startManager();
  }, 3000);
}

function initManager() {
  try {
    managerDir = userFile('manager');
    manager.ensureManagerDir(managerDir);
    try {
      managerDir = fs.realpathSync.native(managerDir);
    } catch {}
  } catch (err) {
    console.warn('[main] manager folder unavailable', err);
    managerDir = null;
  }
  require('./main/e2e').watchPoolHog(app.getPath('userData')); // AT-202: tests only (e2e mark), see src/main/e2e.js
  inbox = inboxStore.createInbox(userFile('inbox.json'), { onChange: onInboxChange });
  qa = qaStore.createQa(userFile('qa.json'), { onChange: onQaChange });
  startProposeWatch();
  startReview();
  if (!managerDir) return;
  notices = noticesStore.createNotices(path.join(managerDir, 'notices.json'), { onChange: onNoticesChange });
  setInterval(() => notices.prune(), 60 * 60 * 1000).unref?.(); // read info / answered proposals after 7 days
  scheduleProjects();
  startPatrol();
  startProgressCheck();
  startStuckCheck();
  startHeartbeat(); // UX11: manager/heartbeat.json, wakes a ルーター that takes no prompt
  startAttention();
  setTimeout(() => autoDropSoon(), 20_000).unref?.(); // replaced items left from before (also after every backlog change)
  manager.watchOutbox(
    managerDir,
    {
      inbox,
      qa,
      notices,
      backlogDir: userFile('backlog'),
      userData: app.getPath('userData'),
      workRoot: getWorkRoot,
      managerDir,
      onReordered,
      answer: answerAction,
      nudge: nudgeAction,
      interrupt: interruptAction, // UX11
      outlook: outlookAction, // UX11
      onFailed: outboxFailed, // UX11: told in the next prompt
      release: releaseAction,
      backlogUpdate: (o) => backlogUpdate({ ...o, from: ['pending', 'failed'] }),
      onCreated: (folder) => addRecent(folder), // shows on the dashboard / picker
      onRouted(folder, item) {
        pmoLog({ type: 'route', folder, backlogId: item.id, no: item.no || null, title: item.title || null, text: String(item.text || '').slice(0, 300), inboxId: (inbox && manager.inboxIdOf(inbox.get().items, folder, item.id)) || null });
        const key = norm(folder);
        if (!routedSeen.has(key)) routedSeen.set(key, new Map());
        routedSeen.get(key).set(item.id, item.status);
        if (!windowOf(folder)) openWindow(folder, { hidden: true }); // loads the backlog itself
        backlogChanged(folder, 'main');
      },
      // link action: watch the tied backlog item's status from now on (its done / failed reaches the inbox item)
      onLinked(folder, item) {
        const key = norm(folder);
        if (!routedSeen.has(key)) routedSeen.set(key, new Map());
        routedSeen.get(key).set(item.id, item.status);
        scheduleProjects();
      },
    },
    { chokidar },
  );
}

// --- UIUX U7: a routed session's "next thing to do" (src/main/propose.js, docs/plan-propose.md) ---------------------
// <folder>/.bantodesk/outbox/*.json (and the former .agent-terminal/outbox) of every open project window -> the inbox (source session, status new); the
// ルーター gets them as 新規 (onInboxChange). Off when AGENT_TERMINAL_NO_PROPOSE=1.
let proposeWatch = null;
function proposeFolders() {
  const out = [];
  for (const s of windows.values()) {
    if (!s || s.role === 'manager' || s.temp || !s.workDir || isManagerDir(s.workDir)) continue;
    if (!out.some((f) => norm(f) === norm(s.workDir))) out.push(s.workDir);
  }
  return out;
}
function startProposeWatch() {
  if (proposeWatch || !inbox || process.env.AGENT_TERMINAL_NO_PROPOSE === '1') return;
  proposeWatch = propose.watch(proposeFolders, {
    inbox,
    hints: manager.schedHints,
    backlogItems: async (folder) => (await backlog.getBacklog(userFile('backlog'), folder)).items || [],
    onAdded(folder, results) {
      const added = results.filter((r) => !r.duplicate);
      console.log(`[main] propose ${folder}: ${added.length} added, ${results.length - added.length} duplicate`);
    },
    onFailed(folder, name, error) {
      console.warn(`[main] propose ${folder} ${name} refused: ${error}`);
    },
  });
}

// --- UIUX U8: all the work of a folder is over -> a review is put on it (src/main/review.js, docs/plan-review.md) -------
// Looks at the known project folders after backlog / inbox changes (debounced) and every REVIEW_TICK_MS. A review is an
// inbox item (source app, routed) + its r- backlog item, started by the folder's window like routed work; what it finds
// comes back with the U7 propose. 「すべて完了」 / the stop after 3 rounds go to 「ルーターの記録」 (pmoLog) and the ルーター's
// conversation (notifyManager). Off when AGENT_TERMINAL_NO_REVIEW=1, and in e2e runs unless AGENT_TERMINAL_REVIEW_IDLE_MS
// is set (other tests finish work and must not get reviews).
const REVIEW_TEMPLATE_FILE = path.join(__dirname, '..', 'docs', 'prompts', 'review.md');
const REVIEW_TICK_MS = Number(process.env.AGENT_TERMINAL_REVIEW_TICK_MS) > 0 ? Number(process.env.AGENT_TERMINAL_REVIEW_TICK_MS) : 15_000; // env: tests
let reviewStore = null;
let reviewTimer = null;
let reviewRunning = false;
let reviewAgain = false;
function reviewEnabled() {
  if (process.env.AGENT_TERMINAL_NO_REVIEW === '1') return false;
  if (require('./main/e2e').isE2E() && !process.env.AGENT_TERMINAL_REVIEW_IDLE_MS) return false;
  return true;
}
function reviewFolders() {
  const out = [];
  const add = (f) => {
    if (typeof f !== 'string' || !f || isManagerDir(f) || (managerDir && isInside(f, managerDir)) || !isDir(f)) return;
    if (!out.some((x) => norm(x) === norm(f))) out.push(f);
  };
  for (const f of loadRecent()) add(f);
  for (const s of windows.values()) if (s && !s.temp && s.role !== 'manager') add(s.workDir);
  return out.slice(0, 40);
}
function reviewSoon(ms = 1000) {
  if (!reviewStore) return;
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(runReview, ms);
}
async function runReview() {
  if (!reviewStore || !inbox) return;
  if (reviewRunning) {
    reviewAgain = true;
    return;
  }
  reviewRunning = true;
  try {
    const envMs = (k) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : undefined);
    await review.tick(reviewFolders(), {
      store: reviewStore,
      inbox,
      backlogItems: async (folder) => (await backlog.getBacklog(userFile('backlog'), folder)).items || [],
      appendBacklog: (folder, raw) => manager.appendBacklog(userFile('backlog'), folder, raw),
      templateFile: REVIEW_TEMPLATE_FILE,
      idleMs: envMs('AGENT_TERMINAL_REVIEW_IDLE_MS'),
      graceMs: envMs('AGENT_TERMINAL_REVIEW_GRACE_MS'),
      onAction: onReviewAction,
    });
  } catch (err) {
    console.warn('[main] review look failed', err);
  } finally {
    reviewRunning = false;
    clearTimeout(reviewTimer);
    reviewTimer = setTimeout(runReview, reviewAgain ? 1000 : REVIEW_TICK_MS);
    reviewAgain = false;
  }
}
function onReviewAction(action, { folder, round, queued, proposals, item }) {
  const name = path.basename(folder);
  if (action === 'queue' && queued) {
    const bi = queued.item;
    pmoLog({ type: 'review', folder, backlogId: bi.id, no: bi.no || null, title: bi.title || null, round, inboxId: queued.inboxId });
    const key = norm(folder);
    if (!routedSeen.has(key)) routedSeen.set(key, new Map());
    routedSeen.get(key).set(bi.id, bi.status); // its done / failed reaches the inbox item (routedStatuses)
    if (!windowOf(folder)) openWindow(folder, { hidden: true });
    backlogChanged(folder, 'main');
    notifyManager(`${name}: 作業が全部終わったので、アプリが見直し（${round} 回目）${bi.no ? ' ' + bi.no : ''} を積んだ`);
  } else if (action === 'all-done') {
    pmoLog({ type: 'all-done', folder, round });
    notifyManager(`${name}: 見直しで次の作業が出なかったので「すべて完了」にした（新しい依頼が来たら外れる）`);
  } else if (action === 'reviewed') {
    pmoLog({ type: 'reviewed', folder, round, count: (proposals || []).length });
  } else if (action === 'stop') {
    pmoLog({ type: 'review-stop', folder, round });
    notifyManager(`${name}: 見直しを続けて ${round} 回積んで、そのたびに次の作業が出た。${round + 1} 回目は積まない。続けるかはユーザーの判断（qa か notice の proposal で聞く）`);
  } else if (action === 'review-failed') {
    pmoLog({ type: 'review-failed', folder, round, backlogId: item ? item.id : null, no: item ? item.no || null : null, note: item ? item.note || '' : '' });
  } else if (action === 'clear') {
    pmoLog({ type: 'all-done-clear', folder });
  }
  if (action === 'wait' || action === 'baseline') return;
  scheduleProjects(); // projects.json review
  if (managerState && action !== 'queue') send(managerState, 'backlog:changed', { folder, source: 'review' }); // the dashboard's mark
}
function startReview() {
  if (reviewStore || !inbox || !reviewEnabled()) return;
  reviewStore = review.createStore(userFile('review.json'));
  reviewSoon(20_000); // after the windows have loaded their backlogs
}

ipcMain.handle('inbox:get', () => (inbox ? inbox.get() : { items: [] }));
ipcMain.handle('inbox:add', (_e, o) => (inbox && o ? inbox.add({ text: o.text }) : null)); // text only (source / status are main's)
// AT-carryover: 「積み残しを取り込む」 on a dashboard folder card. { folder } -> { added, skipped, more } | { error }
ipcMain.handle('carryover:import', async (e, o) => {
  if (stateOf(e)?.role !== 'manager') return { error: 'manager window only' };
  const folder = o && typeof o.folder === 'string' && path.isAbsolute(o.folder) && isDir(o.folder) ? o.folder : null;
  if (!folder) return { error: 'no folder' };
  return carryoverRun(folder, { manual: true });
});
ipcMain.handle('inbox:update', (_e, o) => {
  const { id, patch } = o || {};
  if (!inbox || typeof id !== 'string') return null;
  return inbox.update(id, patch, { source: 'user' });
});
// Undo the newest manager change (add / edit / merge / link) of an inbox item (dashboard 「元に戻す」). -> InboxItem | null
ipcMain.handle('inbox:undo', (_e, o) => {
  const id = o && o.id;
  if (!inbox || typeof id !== 'string') return null;
  return inbox.undo(id);
});

// --- pre-answered QA per queued task (src/main/qa.js, CONTRACT.md "Inbox / manager") ---------------
// qa:changed { entries } (debounced) to manager windows; projects.json / inbox.json carry the qa status.
function onQaChange() {
  clearTimeout(onQaChange.t);
  onQaChange.t = setTimeout(() => {
    const payload = { entries: qa ? qa.list() : [] };
    for (const s of windows.values()) if (s.role === 'manager') send(s, 'qa:changed', payload);
  }, 100);
  scheduleProjects();
  attentionSoon();
}
// manager window only: -> { entries: [{ key, ...QaEntry }] } (newest first) | null
ipcMain.handle('qa:list', (e) => (stateOf(e)?.role === 'manager' && qa ? { entries: qa.list() } : null));
// manager window only: { key, answers: string[] } -> entry | null (status 'answered', blanks = as hypothesised)
ipcMain.handle('qa:answer', (e, o) => {
  if (stateOf(e)?.role !== 'manager' || !qa || !o || typeof o.key !== 'string') return null;
  return qa.answer(o.key, o.answers);
});
// any window, own folder only: { itemId, use?: boolean } -> entry | null. use:true records usedAt (the item is being sent).
ipcMain.handle('qa:forItem', (e, o) => {
  const s = stateOf(e);
  if (!s || !qa || !o || typeof o.itemId !== 'string') return null;
  let real = s.workDir;
  try {
    real = fs.realpathSync.native(s.workDir);
  } catch {}
  for (const dir of [s.workDir, real]) {
    const key = qaStore.backlogKey(dir, o.itemId);
    const entry = qa.get(key);
    if (entry) return o.use ? qa.markUsed(key) : { key, ...entry };
  }
  return null;
});
// --- Auto-yes: one setting for every window ------------------------------------------------------
// Each window reads localStorage 'autoYes' only at load, so a toggle in one window goes to the others through here
// (stable check 不具合候補 1: the manager window kept its own OFF and its claude stopped at its own permission prompts).
ipcMain.on('autoYes:set', (e, on) => {
  const payload = { on: on === true };
  for (const s of windows.values()) if (!s.win.isDestroyed() && s.win.webContents.id !== e.sender.id) send(s, 'autoYes:changed', payload);
});

// --- 「ルーターから」 notices (src/main/notices.js, CONTRACT.md "Inbox / manager") ----------------------
// notices:changed { notices } (debounced) to manager windows. The dashboard raises the desktop notification for unread
// warn / proposal notices whose announcedAt is not their updatedAt (notices:announced). The widget gets them via WidgetState.
function onNoticesChange() {
  clearTimeout(onNoticesChange.t);
  onNoticesChange.t = setTimeout(() => {
    const payload = { notices: notices ? notices.list() : [] };
    for (const s of windows.values()) if (s.role === 'manager') send(s, 'notices:changed', payload);
  }, 150);
  widget.changed();
  attentionSoon();
  pmoLogSoon();
}
const noticeLine = (n) => `${n.id}「${n.title.slice(0, 80)}」→ ${n.answer.choice === 'go' ? '進める' : '却下'}${n.answer.comment ? `（${n.answer.comment.replace(/\s+/g, ' ').slice(0, 300)}）` : ''}`;
// manager window only: -> { notices: Notice[] } (live, newest first) | null
ipcMain.handle('notices:list', (e) => (stateOf(e)?.role === 'manager' && notices ? { notices: notices.list() } : null));
// manager window only: { ids: string[] | 'all' } -> number marked read
ipcMain.handle('notices:read', (e, o) => {
  if (stateOf(e)?.role !== 'manager' || !notices || !o) return 0;
  return notices.read(o.ids === 'all' ? 'all' : Array.isArray(o.ids) ? o.ids.filter((x) => typeof x === 'string') : []);
});
// manager window only: { ids: string[] } the dashboard raised the desktop notification for (kept across restarts)
ipcMain.handle('notices:announced', (e, o) => {
  if (stateOf(e)?.role !== 'manager' || !notices || !o || !Array.isArray(o.ids)) return 0;
  return notices.announced(o.ids.filter((x) => typeof x === 'string'));
});
// manager window only: { title, text?, key? } -> Notice | null. An app info notice from the window (the ルーター's automatic
// handoff, PROGRESS 45): always kind info, source app, key under app:pmo-.
ipcMain.handle('notices:add', (e, o) => {
  if (stateOf(e)?.role !== 'manager' || !notices || !o || typeof o.title !== 'string' || !o.title.trim()) return null;
  const key = typeof o.key === 'string' && /^app:pmo-[\w:.-]{1,80}$/.test(o.key) ? o.key : null;
  const r = notices.add({ kind: 'info', title: o.title, text: typeof o.text === 'string' ? o.text : '', key, source: 'app' });
  return r ? r.notice || null : null;
});
// manager window only: { id, choice: 'go'|'reject', comment? } -> Notice | null. The answer goes to the manager agent's
// backlog prompt (「ルーターの提案への回答: …」, same coalesced item as the inbox check).
ipcMain.handle('notices:answer', (e, o) => {
  if (stateOf(e)?.role !== 'manager' || !notices || !o || typeof o.id !== 'string') return null;
  const n = notices.answer(o.id, o.choice, typeof o.comment === 'string' ? o.comment : '');
  if (n && managerDir && inbox) {
    manager
      .notifyManager(userFile('backlog'), managerDir, { newItems: newForManager(), reply: noticeLine(n) })
      .then((r) => r && backlogChanged(managerDir, 'main'))
      .catch((err) => console.warn('[main] notice answer -> manager failed', err));
  }
  return n;
});

// --- status of a backlog item from outside its window (the user's 取り消す on the dashboard, the manager's backlog-update,
// the auto clean-up below) -----------------------------------------------------------------------------------------
// main writes the folder's file; the folder's window (if open) gets backlog:changed { statuses } and takes the status over.
// Until a save of that window shows it, the status is re-applied to its saves (a save racing the change cannot undo it),
// at most 60 s, and never to an item the window has started meanwhile (active).
const pendingStatuses = new Map(); // norm(folder) -> Map<id, { status, note, doneAt, at }>
function applyPendingStatus(folder, data) {
  const key = norm(folder);
  const m = pendingStatuses.get(key);
  if (!m || !m.size || !data || !Array.isArray(data.items)) return data;
  const now = Date.now();
  let items = null;
  for (const [id, p] of m) {
    const k = data.items.findIndex((i) => i && i.id === id);
    const it = k >= 0 ? data.items[k] : null;
    if (!it || now - p.at > 60_000 || it.status === p.status || it.status === 'active') {
      m.delete(id);
      continue;
    }
    items ||= [...data.items];
    items[k] = { ...it, status: p.status, note: p.note, doneAt: p.doneAt };
  }
  if (!m.size) pendingStatuses.delete(key);
  return items ? { ...data, items } : data;
}

// { folder, backlogId, status, note, by: 'user'|'manager'|'app', from } -> { item, prev } | { error }
const STATUS_JA_BL = { dropped: '取り消し', failed: '失敗', done: '完了' };
let backlogUpdateChain = Promise.resolve();
function backlogUpdate(o) {
  const run = async () => {
    const folder = o.folder;
    if (managerDir && norm(folder) === norm(managerDir)) return { error: "the manager folder's own queue cannot be changed" };
    const r = await backlog.updateStatus(userFile('backlog'), folder, o.backlogId, o.status, o.note, { from: o.from || ['pending'] });
    if (r.error) return r;
    const key = norm(folder);
    if (!pendingStatuses.has(key)) pendingStatuses.set(key, new Map());
    pendingStatuses.get(key).set(r.item.id, { status: r.item.status, note: r.item.note, doneAt: r.item.doneAt, at: Date.now() });
    // the tied inbox item keeps its status: the change is not reported as a routed item finishing
    if (!routedSeen.has(key)) routedSeen.set(key, new Map());
    routedSeen.get(key).set(r.item.id, r.item.status);
    backlogChanged(folder, 'main', { statuses: [{ id: r.item.id, status: r.item.status, note: r.item.note, doneAt: r.item.doneAt }] });
    pmoLog({ type: 'backlog-update', by: o.by, folder, backlogId: r.item.id, from: r.prev.status, status: r.item.status, note: r.item.note });
    if (notices && o.by === 'manager') {
      const name = path.basename(folder) || folder;
      notices.add({
        kind: 'info',
        title: `「${name}」の待ち行列の項目を ルーターが${STATUS_JA_BL[r.item.status]}にしました`,
        text: `**項目**: ${oneLineText(r.item.text, 120)}（${r.item.id}、${r.prev.status} → ${r.item.status}）\n\n**理由**: ${r.item.note}`,
        folder,
        key: `app:backlog-update:${r.item.id}`,
        source: 'app',
      });
    }
    return { item: r.item, prev: r.prev };
  };
  const p = backlogUpdateChain.then(run);
  backlogUpdateChain = p.catch(() => {});
  return p.catch((err) => ({ error: `failed: ${err && err.message}` }));
}

// Auto clean-up (src/main/backlog.js findReplaced): a waiting item whose prerequisite failed and whose inbox item was routed
// again (a newer backlog item for it exists) never starts: it becomes dropped, told per folder as a 「ルーターから」 info.
const AUTO_DROP_NOTE = '前提が失敗し、振り直された項目に置き換わったため';
let autoDropTimer = null;
let autoDropRunning = false;
function autoDropSoon() {
  if (!managerDir || autoDropTimer) return;
  autoDropTimer = setTimeout(() => {
    autoDropTimer = null;
    autoDropReplaced().catch((err) => console.warn('[main] auto drop failed', err));
  }, 2000);
  autoDropTimer.unref?.();
}
async function autoDropReplaced() {
  if (autoDropRunning || !managerDir || quitting) return [];
  autoDropRunning = true;
  try {
    const folders = loadRecent();
    for (const s of windows.values()) if (!s.temp) folders.push(s.workDir);
    const seen = new Set([norm(managerDir)]);
    const backlogs = [];
    for (const folder of folders) {
      if (typeof folder !== 'string' || seen.has(norm(folder))) continue;
      seen.add(norm(folder));
      backlogs.push({ folder, items: (await backlog.getBacklog(userFile('backlog'), folder)).items });
    }
    const linkedOf = (folder, id) => (inbox ? manager.inboxIdOf(inbox.get().items, folder, id) : null);
    const found = backlog.findReplaced(backlogs, linkedOf);
    const done = [];
    for (const f of found) {
      const r = await backlogUpdate({ folder: f.folder, backlogId: f.id, status: 'dropped', note: AUTO_DROP_NOTE, by: 'app', from: ['pending'] });
      if (!r.error) done.push({ ...f, item: r.item });
    }
    const byFolder = new Map();
    for (const d of done) {
      const k = norm(d.folder);
      if (!byFolder.has(k)) byFolder.set(k, []);
      byFolder.get(k).push(d);
    }
    for (const list of byFolder.values()) {
      if (!notices) break;
      const folder = list[0].folder;
      const name = path.basename(folder) || folder;
      const lines = list.map((d) => `- ${oneLineText(d.item.text, 80)}（${d.id}）: 前提の ${d.after} が失敗。振り直された ${d.by.id}${norm(d.by.folder) !== norm(folder) ? `（${path.basename(d.by.folder)}）` : ''} に置き換わりました`);
      notices.add({
        kind: 'info',
        title: `「${name}」の始まらない待ちの項目を ${list.length} 件取り消しました`,
        text: `前提の項目が失敗したため始まらず、同じ依頼から振り直された項目に置き換わっていた待ちの項目を、取り消し（dropped）にしました。項目は履歴として残ります。\n\n${lines.join('\n')}`,
        folder,
        key: `app:autodrop:${shortHash(norm(folder) + '\n' + list.map((d) => d.id).join(','))}`,
        source: 'app',
      });
    }
    return done;
  } finally {
    autoDropRunning = false;
  }
}

// --- ルーター: reorder of a folder's queue + answers to stuck prompts (roadmap 27, src/main/stuck.js) ----------------
// Every reorder / answer (and refused answer) is appended to userData/logs/pmo-actions.jsonl and shown as an info
// notice in 「ルーターから」 (one per folder / per session, replaced by the next one, keeping the last few lines).
const PMO_LOG_AUTO = { answer: 'auto.answer', nudge: 'auto.nudge' }; // UA1: what the ルーター did instead of the user
function pmoLog(entry) {
  if (entry && PMO_LOG_AUTO[entry.type]) usageAuto(PMO_LOG_AUTO[entry.type]);
  try {
    fs.mkdirSync(userFile('logs'), { recursive: true });
    fs.appendFileSync(userFile(path.join('logs', 'pmo-actions.jsonl')), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (err) {
    console.warn('[main] pmo log failed', err);
  }
  pmoLogSoon();
}
// 「ルーターの記録」 (UIUX U4, notices.forLog): the tail of pmo-actions.jsonl (last 256 KB) + every stored notice, newest first.
// pmo:log -> { entries } (manager window only); pmo:log-changed { entries } (debounced) after a pmoLog line or a notice change.
function pmoLogEntries() {
  let actions = [];
  try {
    const file = userFile(path.join('logs', 'pmo-actions.jsonl'));
    const st = fs.statSync(file);
    const len = Math.min(st.size, 256 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, st.size - len);
    } finally {
      fs.closeSync(fd);
    }
    actions = noticesStore.parseActions(buf.toString('utf8'));
  } catch {}
  return noticesStore.forLog(notices ? notices.all() : [], actions);
}
function pmoLogSoon() {
  clearTimeout(pmoLogSoon.t);
  pmoLogSoon.t = setTimeout(() => {
    const managers = [...windows.values()].filter((s) => s.role === 'manager');
    if (!managers.length) return;
    const payload = { entries: pmoLogEntries() };
    for (const s of managers) send(s, 'pmo:log-changed', payload);
  }, 300);
}
ipcMain.handle('pmo:log', (e) => (stateOf(e)?.role === 'manager' ? { entries: pmoLogEntries() } : null));
const shortHash = (s) => require('crypto').createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
const oneLineText = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// A reorder main wrote while the folder's window holds its own copy of the backlog: re-applied to that window's saves
// until one follows it (the window takes it over on backlog:changed { order }), the user moves an item, or 60 s pass.
// userAt (queue order, docs/queue-order.md): set when the order came from the user's ↑ / ↓ on the dashboard (ms) or the
// user handed the order to the ルーター (null = the lock lifted); the window's saves carry it too until they follow the order.
const pendingOrders = new Map(); // norm(folder) -> { order, at, userAt? }
function withUserAt(data, p) {
  if (!p || p.userAt === undefined) return data;
  if (typeof p.userAt === 'number') return { ...data, userOrderAt: Math.max(p.userAt, typeof data.userOrderAt === 'number' ? data.userOrderAt : 0) };
  if (typeof data.userOrderAt === 'number' && data.userOrderAt <= p.at) {
    const { userOrderAt, ...rest } = data;
    return rest;
  }
  return data;
}
function applyPendingOrder(folder, data) {
  const key = norm(folder);
  const p = pendingOrders.get(key);
  if (!p || !data || !Array.isArray(data.items)) return data;
  const userMoved = typeof data.userOrderAt === 'number' && data.userOrderAt > p.at;
  if (userMoved || Date.now() - p.at > 60_000 || backlog.followsOrder(data.items, p.order)) {
    pendingOrders.delete(key);
    return userMoved ? data : withUserAt(data, p);
  }
  const known = p.order.filter((id) => data.items.some((i) => i.id === id && i.status === 'pending'));
  const r = known.length ? backlog.applyOrder(data.items, known) : { error: 'none' };
  return withUserAt(r.items ? { ...data, items: r.items } : data, p);
}
function onReordered(folder, { order, reason, items }) {
  pendingOrders.set(norm(folder), { order, at: Date.now() });
  queueReorders().set(norm(folder), { at: Date.now(), reason: oneLineText(reason, 300) });
  backlogChanged(folder, 'main', { order });
  const pend = items.filter((i) => i.status === 'pending');
  pmoLog({ type: 'reorder', folder, order, reason });
  if (!notices) return;
  const name = path.basename(folder) || folder;
  const list = pend.slice(0, 10).map((i, k) => `${k + 1}. ${oneLineText(i.text, 80)}`).join('\n');
  notices.add({
    kind: 'info',
    title: `「${name}」の待ち行列を ルーターが並べ替えました`,
    text: `**理由**: ${reason}\n\n**新しい順番**:\n${list}${pend.length > 10 ? `\n…ほか ${pend.length - 10} 件` : ''}\n\n変えたいときは、そのフォルダのバックログで ↑ ↓ を使ってください（24 時間は ルーターが並べ替えません）。`,
    folder,
    key: `app:reorder:${shortHash(norm(folder))}`,
    source: 'app',
  });
}

// --- queue order on the dashboard cards (docs/queue-order.md, src/main/queueorder.js) ---------------------------------
// queue:order { folders?: string[] } -> queueorder.buildQueueOrder(...) for those folders (default: the open ones + the
// recent ones): every waiting task in the order it is sent, the one that starts next over all folders, why each does
// not start yet, the ルーター's last reorder and the user's order lock per folder. One call for the whole プロジェクト tab.
// queue:move { folder, id, dir: -1 | 1 } the user's ↑ / ↓ on a card (same save and 24 h lock as the window's ↑ / ↓).
// queue:askPmo { folder, note } a 依頼 (source user) 「<フォルダ> の待ち行列の順番を見直して: <ひとこと>」; the user's
// lock on that queue is lifted (they hand the order to the ルーター).
let queueReorderMap = null; // norm(folder) -> { at, reason } (the ルーター's last reorder; read once from pmo-actions.jsonl)
function queueReorders() {
  if (queueReorderMap) return queueReorderMap;
  queueReorderMap = new Map();
  try {
    const file = userFile(path.join('logs', 'pmo-actions.jsonl'));
    const st = fs.statSync(file);
    const len = Math.min(st.size, 512 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, st.size - len);
    } finally {
      fs.closeSync(fd);
    }
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('"reorder"')) continue;
      try {
        const e = JSON.parse(line);
        if (e && e.type === 'reorder' && typeof e.folder === 'string') queueReorderMap.set(norm(e.folder), { at: Date.parse(e.at) || null, reason: oneLineText(e.reason, 300) });
      } catch {}
    }
  } catch {}
  return queueReorderMap;
}
const queueOrderLib = require('./main/queueorder');
const queueFolderOk = (f) => typeof f === 'string' && f && f.length < 1000 && path.isAbsolute(f) && !isManagerDir(f) && !(managerDir && norm(f) === norm(managerDir));
ipcMain.handle('queue:order', async (_e, o) => {
  try {
    let list = Array.isArray(o && o.folders) ? o.folders.filter(queueFolderOk).slice(0, 40) : null;
    if (!list) {
      list = [];
      for (const s of schedFolders()) list.push(s.workDir);
      for (const f of loadRecent()) if (typeof f === 'string') list.push(f);
    }
    const seen = new Set();
    const folders = [];
    const locks = {};
    for (const folder of list) {
      if (!queueFolderOk(folder) || seen.has(norm(folder))) continue;
      seen.add(norm(folder));
      const w = windowOf(folder);
      let st = { items: [] };
      try {
        st = await backlog.getBacklog(userFile('backlog'), folder);
      } catch {}
      if (typeof st.userOrderAt === 'number') locks[queueOrderLib.normFolder(folder)] = st.userOrderAt;
      folders.push({ folder, open: !!(w && w.role !== 'manager' && !w.win.isDestroyed()), items: st.items || [] });
    }
    const { running, statuses, nos } = await schedRunning();
    for (const f of folders) for (const i of f.items) if (i && typeof i.id === 'string' && !statuses.has(i.id)) statuses.set(i.id, i.status);
    const want = folders.flatMap((f) => f.items.filter((i) => i && i.status === 'pending').map((i) => ({ after: Array.isArray(i.after) ? i.after.filter((x) => typeof x === 'string') : [] })));
    await schedResolveAfter(statuses, want, nos);
    const reorders = {};
    for (const [k, v] of queueReorders()) reorders[queueOrderLib.normFolder(k)] = v;
    return queueOrderLib.buildQueueOrder({ folders, running, statuses, nos, limit: schedLimit, over: schedMon().over(schedThresholds), hold: schedHold(), reorders, locks });
  } catch (err) {
    console.warn('[main] queue:order failed', err);
    return null;
  }
});
let queueChain = Promise.resolve();
function queueSerial(fn) {
  const p = queueChain.then(fn);
  queueChain = p.catch(() => {});
  return p.catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
}
// writes the folder's backlog with the new pending order / lock and tells its window (same path as the ルーター's reorder)
async function queueWrite(folder, st, items, userAt) {
  const data = { ...st, items };
  if (typeof userAt === 'number') data.userOrderAt = userAt;
  else if (userAt === null) delete data.userOrderAt;
  await backlog.saveBacklog(userFile('backlog'), folder, data);
  const order = items.filter((i) => i.status === 'pending').map((i) => i.id);
  pendingOrders.set(norm(folder), { order, at: Date.now(), userAt });
  backlogChanged(folder, 'main', { order, userOrderAt: userAt });
  return order;
}
ipcMain.handle('queue:move', (_e, o) =>
  queueSerial(async () => {
    const folder = o && o.folder;
    const id = o && o.id;
    const dir = o && (o.dir === -1 || o.dir === 1) ? o.dir : 0;
    if (!queueFolderOk(folder) || typeof id !== 'string' || !dir) return { ok: false, error: 'bad request' };
    const st = await backlog.getBacklog(userFile('backlog'), folder);
    const items = [...(st.items || [])];
    const it = items.find((i) => i && i.id === id);
    if (!it || it.status !== 'pending') return { ok: false, error: it ? `the task is ${it.status}` : 'unknown task' };
    // like the window's ↑ / ↓ (src/renderer/backlog.js move): among the waiting tasks of the same tab (here: no tab)
    const same = items.filter((i) => i.status === 'pending' && (i.tabId || null) === (it.tabId || null));
    const other = same[same.indexOf(it) + dir];
    if (!other) return { ok: false, error: 'already at the end' };
    const a = items.indexOf(it);
    const b = items.indexOf(other);
    items[a] = other;
    items[b] = it;
    const at = Date.now();
    const order = await queueWrite(folder, st, items, at);
    return { ok: true, order, userOrderAt: at };
  }),
);
ipcMain.handle('queue:askPmo', (_e, o) =>
  queueSerial(async () => {
    const folder = o && o.folder;
    if (!queueFolderOk(folder)) return { ok: false, error: 'bad request' };
    if (!inbox) return { ok: false, error: 'no inbox' };
    const item = inbox.add({ text: queueOrderLib.askText(folder, o && typeof o.note === 'string' ? o.note : '') });
    if (!item) return { ok: false, error: 'not added' };
    const st = await backlog.getBacklog(userFile('backlog'), folder);
    let unlocked = false;
    if (backlog.userOrderLock(st)) {
      await queueWrite(folder, st, [...(st.items || [])], null);
      unlocked = true;
    }
    return { ok: true, item, unlocked };
  }),
);

const stuckMs = () => Number(process.env.AGENT_TERMINAL_STUCK_MS) || stuck.STUCK_MS; // tests may shorten it
// with the U3 widening of what the ルーター may press (attention.pmoVerdict: network, outside the folder, temporary files)
const currentWaiting = (now = Date.now()) => attention.relaxWaiting(stuck.waitingList(widget.sessionsSnapshot(), now, stuckMs()));
const answerLines = new Map(); // tabKey -> last answer lines for its notice
async function answerAction(a) {
  const c = stuck.checkAnswer(a, currentWaiting());
  if (c.error) {
    pmoLog({ type: 'answer-refused', tabKey: a && a.tabKey, promptKey: a && a.promptKey, choice: a && a.choice, reason: a && a.reason, error: c.error });
    return { error: c.error };
  }
  const e = c.entry;
  const reason = oneLineText(a.reason, 500);
  if (!widget.sendAction(e.wcId, { tabId: e.tabKey, type: 'answer', value: c.n, promptKey: e.prompt.key, reason })) return { error: 'the window of that tab is gone' };
  const label = (e.prompt.options.find((o) => o.n === c.n) || {}).label || String(c.n);
  pmoLog({ type: 'answer', folder: e.folder, tabKey: e.tabKey, label: e.label, promptKey: e.prompt.key, question: e.prompt.question, context: e.prompt.context, choice: c.n, option: label, reason });
  if (notices) {
    const t = new Date();
    const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const cmd = oneLineText(e.prompt.context.filter((l) => l !== e.prompt.question).slice(-3).join(' / '), 160);
    const lines = [...(answerLines.get(e.tabKey) || []), `- ${hm}「${oneLineText(e.prompt.question, 80)}」${cmd ? `（${cmd}）` : ''} → **${c.n}. ${oneLineText(label, 40)}** — ${reason}`].slice(-8);
    answerLines.set(e.tabKey, lines);
    notices.add({
      kind: 'info',
      title: `ルーターが「${e.folderName}」の確認に答えました（${oneLineText(e.label, 40)}）`,
      text: lines.join('\n'),
      folder: e.folder || null,
      key: `app:answer:${shortHash(e.tabKey)}`,
      source: 'app',
    });
  }
  return { type: 'answer', tabKey: e.tabKey, promptKey: e.prompt.key, choice: c.n, folder: e.folder };
}

// Every 10 s (or faster in tests): manager/sessions.json with the waiting prompts; a prompt waiting ≥ 2 min that the
// app lets the manager press wakes the manager up (「確認で止まっているセッションがあります（N 件）」, once per prompt);
// those it may not press go to the user as one warn notice (key app:stuck, 要対応), resolved when they are answered.
let stuckReported = new Set(); // `${tabKey}:${promptKey}` of stuck prompts already told to the manager
let sessionsWritten = '';
let stuckBlock = ''; // the stuck block last given to the manager (stuck part + scheduler lines)
let stuckBase = ''; // stuck.formatStuck part only
function checkStuck() {
  if (!managerDir) return;
  try {
    const now = Date.now();
    const list = currentWaiting(now);
    const sig = JSON.stringify(list.map((e) => [e.tabKey, e.prompt.key, e.stuck]));
    if (list.length || sig !== sessionsWritten) manager.writeJsonAtomic(path.join(managerDir, 'sessions.json'), stuck.forManager(list, now));
    sessionsWritten = sig;
    const stuckNow = list.filter((e) => e.stuck);
    const keyOf = (e) => `${e.tabKey}:${e.prompt.key}`;
    const fresh = stuckNow.filter((e) => e.verdict.safe && !stuckReported.has(keyOf(e)));
    stuckReported = new Set(stuckNow.map(keyOf));
    stuckBase = stuck.formatStuck(stuckNow.filter((e) => e.verdict.safe));
    const block = withSchedNotes(stuckBase); // + the scheduler's 見回り lines (sched:alert), same block
    if (inbox && (fresh.length || block !== stuckBlock)) {
      stuckBlock = block;
      manager
        .notifyManager(userFile('backlog'), managerDir, { newItems: newForManager(), stuck: block, wake: fresh.length > 0 })
        .then((r) => r && backlogChanged(managerDir, 'main'))
        .catch((err) => console.warn('[main] stuck -> manager failed', err));
    }
    if (notices) {
      const n = stuck.refusedNotice(list);
      const prev = notices.findKey(stuck.STUCK_KEY);
      if (!n) {
        if (prev) notices.resolve(stuck.STUCK_KEY);
      } else {
        const known = new Set(prev ? prev.refs : []);
        notices.add({ ...n, quiet: !!prev && n.refs.every((k) => known.has(k)) });
      }
      // the manager's own session at a dialog (waitingList leaves it out: it cannot answer itself)
      const m = stuck.managerStuckNotice(widget.sessionsSnapshot(), now, stuckMs());
      const mprev = notices.findKey(stuck.MGR_STUCK_KEY);
      if (!m) {
        if (mprev && !mprev.resolvedAt) notices.resolve(stuck.MGR_STUCK_KEY);
      } else if (!mprev || mprev.resolvedAt || m.refs.some((k) => !mprev.refs.includes(k))) {
        notices.add(m);
      }
    }
  } catch (err) {
    console.warn('[main] stuck check failed', err);
  }
}
function startStuckCheck() {
  const every = Math.max(1000, Math.min(10_000, Math.floor(stuckMs() / 4)));
  setInterval(checkStuck, every).unref?.();
}

// --- What idle sessions wait for (PROGRESS 40, src/main/waits.js) -----------------------------------------------------
// Every WAITS_EVERY_MS: for each idle / asking tab, the background commands (output file stat; process tree at most every
// WAITS_PROC_MS and only while some command is waited for), team members, subagents -> Wait. Pushed to the tab's window
// (waits:state), the dashboard / widget (widget.setWaits), manager/waits.json; waits that never end (process gone, output
// silent, too long, team deadlock) -> warn notice app:waits + a block in the manager's prompt (wakes it once per alert).
// Reads no transcript: the renderer's TabState already carries bg / team / agents.
const WAITS_EVERY_MS = () => Number(process.env.AGENT_TERMINAL_WAITS_EVERY_MS) || 15_000;
const WAITS_PROC_MS = () => Number(process.env.AGENT_TERMINAL_WAITS_PROC_MS) || 60_000;
const WAITS_UNREAD_MS = 30_000;
const waitTrack = new Map(); // `${wcId}:${tabId}` -> { status, idleSince, teamQuietSince }
const goneScans = new Map(); // command id -> consecutive process scans without it
let procCache = { at: 0, procs: null, busy: false };
const unreadCache = new Map(); // team -> { at, n }
let waitEntries = []; // last [{ tabKey, wcId, folder, folderName, label, backlogId, wait }]
let waitsReported = new Set(); // alert refs already told to the manager
let waitsBase = ''; // waits.formatForManager part of the manager's stuck block
let waitsWritten = '';
let waitsRunning = false;
const waitsSlowCache = new Map(); // AT-202: `t:<command id>` / `f:<output file>` -> the last answer, used when a step is slow
const waitsSent = new Map(); // wcId -> JSON last sent
// PM1 段 2 の残り (依頼-187): haiku's opinion on the alerts wait-hints has no reason for (src/main/wait-hints.js
// createOpinions, the shared runner, one call per ref). Off with patrolTriage false, and in e2e unless a fake haiku is
// given (AGENT_TERMINAL_HAIKU_CMD), so tests never call the real claude.
const waitOutFiles = new Map(); // command id -> its bg output file (only paths the renderer's TabState gave)
let waitOpinionsObj = null;
function waitOpinions() {
  if (!triage.triageOn(loadManagerSettings())) return null;
  if (require('./main/e2e').isE2E() && !process.env.AGENT_TERMINAL_HAIKU_CMD) return null;
  if (!waitOpinionsObj) {
    waitOpinionsObj = waitHints.createOpinions({
      ask: (prompt) => haikuRunner().run(prompt, { program: haikuProgram(), args: waitHints.HAIKU_ARGS, timeoutMs: triage.TIMEOUT_MS }),
      readTail: (e, item) => readWaitTail(waitOutFiles.get(item.id) || (Array.isArray(item.files) && item.files[0]) || ''),
    });
  }
  return waitOpinionsObj;
}
// the last ~15 lines (≤ 4 KB read) of a file main knows, '' when none / not readable
async function readWaitTail(file) {
  if (!file || !path.isAbsolute(file)) return '';
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const { size } = await fh.stat();
    const n = Math.min(size, 4096);
    const buf = Buffer.alloc(n);
    await fh.read(buf, 0, n, size - n);
    return buf.toString('utf8').split(/\r?\n/).slice(-15).join('\n');
  } catch {
    return '';
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}
// UX11: how long a 実行中 tab may write no transcript line (tests shorten it; the e2e mark only)
const runQuietMs = () => (require('./main/e2e').isE2E() && Number(process.env.AGENT_TERMINAL_RUN_QUIET_MS)) || waits.RUN_QUIET_MIN * 60_000;
function waitSettings() {
  const o = loadManagerSettings();
  const s = waits.settingsOf({ silentMin: o.waitSilentMin, longMin: o.waitLongMin });
  // tests may shorten them (ms)
  const env = (k) => Number(process.env[k]) || 0;
  if (env('AGENT_TERMINAL_WAIT_SILENT_MS')) s.silentMin = env('AGENT_TERMINAL_WAIT_SILENT_MS') / 60_000;
  if (env('AGENT_TERMINAL_WAIT_LONG_MS')) s.longMin = env('AGENT_TERMINAL_WAIT_LONG_MS') / 60_000;
  return s;
}
function scanProcs() {
  if (process.platform !== 'win32' || procCache.busy) return;
  procCache.busy = true;
  // src/main/proclist.js (the native module, no WMI / PowerShell; image names, no command lines: SEC3); a failed list
  // -> unknown. from: when the list was asked for. A command that started after it cannot be in it (unknown, not gone).
  const from = Date.now();
  require('./main/proclist')
    .list({ timeout: 20000 })
    .then((procs) => (procCache = { at: Date.now(), from, procs, busy: false, fresh: true }))
    .catch(() => (procCache = { at: Date.now(), from, procs: null, busy: false, fresh: true }));
}
async function checkWaits() {
  if (waitsRunning) return;
  waitsRunning = true;
  try {
    const now = Date.now();
    const settings = waitSettings();
    const snap = widget.sessionsSnapshot();
    const live = new Set();
    const files = new Map();
    const targets = new Map(); // command id -> waits.newestOf()
    let anyCmd = false;
    let slowRound = false; // AT-202: a step of this round timed out
    for (const x of snap) {
      const t = x.t;
      const key = `${x.wcId}:${t.id}`;
      live.add(key);
      let tr = waitTrack.get(key);
      if (!tr) waitTrack.set(key, (tr = { status: '', idleSince: 0, teamQuietSince: 0 }));
      if (t.status !== tr.status) {
        tr.status = t.status;
        tr.idleSince = now;
      }
      if (t.status !== 'idle' || t.rest || t.doneAt) continue;
      for (const b of Array.isArray(t.bg) ? t.bg : []) {
        // the files the command itself writes (> f, | tee f, Out-File f …): their updates are its output (PROGRESS 50)
        if (b && typeof b.id === 'string' && typeof b.command === 'string' && !targets.has(b.id)) {
          const tg = waits.outTargets(b.command, t.cwd || x.workDir || '');
          // AT-202: a listing / stat that does not come back in time -> the last answer (else unknown), so waits.json
          // keeps being written while the disk is slow
          if (tg.length) {
            const r = slowRound ? TIMED_OUT : await timebox(waits.newestOf(tg), timeboxLimits.read(), { label: 'waits targets' });
            if (r === TIMED_OUT) slowRound = true; // the rest of this round uses the last answers (one wait per round)
            else waitsSlowCache.set(`t:${b.id}`, r);
            targets.set(b.id, r !== TIMED_OUT ? r : waitsSlowCache.get(`t:${b.id}`) || { known: false, mtimeMs: 0, files: [] });
          }
        }
        if (!b || typeof b.outFile !== 'string' || !b.outFile) continue;
        anyCmd = true;
        if (!files.has(b.outFile) && path.isAbsolute(b.outFile) && /\.output$/i.test(b.outFile)) {
          const r = slowRound
            ? TIMED_OUT
            : await timebox(
                fs.promises.stat(b.outFile).then((st) => ({ mtimeMs: st.mtimeMs, size: st.size }), () => null),
                timeboxLimits.read(),
                { label: 'waits output stat' }
              );
          if (r === TIMED_OUT) slowRound = true;
          else waitsSlowCache.set(`f:${b.outFile}`, r);
          files.set(b.outFile, r !== TIMED_OUT ? r : waitsSlowCache.get(`f:${b.outFile}`) || null);
        }
      }
      if (Array.isArray(t.bg) && t.bg.length) anyCmd = true;
    }
    for (const k of [...waitTrack.keys()]) if (!live.has(k)) waitTrack.delete(k);
    if (waitsSlowCache.size > 500) waitsSlowCache.clear();
    if (anyCmd && now - procCache.at >= WAITS_PROC_MS()) scanProcs();
    const scanned = procCache.fresh === true;
    procCache.fresh = false;

    const entries = [];
    const seenCmd = new Set();
    // update hold (autorestart): the stale rule's shorter quiet limit when a tab sent no clock of its own (stale-agents.js)
    const upState = (() => {
      try {
        return updater ? updater.status().state : 'none';
      } catch {
        return 'none';
      }
    })();
    const updateHold = upState === 'pending' || upState === 'restarting';
    for (const x of snap) {
      const t = x.t;
      const tr = waitTrack.get(`${x.wcId}:${t.id}`);
      const ws = windows.get(x.wcId);
      const pty = ws && ws.ptys.get(t.id);
      const procs = new Map();
      if (t.status === 'idle' && !t.rest) {
        for (const b of Array.isArray(t.bg) ? t.bg : []) {
          if (!b || typeof b.id !== 'string') continue;
          seenCmd.add(b.id);
          if (typeof b.outFile === 'string' && b.outFile) waitOutFiles.set(b.id, b.outFile);
          // a list taken before the command started does not count (it said "プロセスが見つからない" right after the start)
          const stale = Number(b.startedAt) > 0 && Number(b.startedAt) >= (procCache.from || 0);
          const st = procCache.procs && pty && !stale ? waits.procState(procCache.procs, pty.pid, b.command || '', { since: Number(b.startedAt) || 0 }) : 'unknown';
          procs.set(b.id, st);
          if (scanned && !stale) goneScans.set(b.id, st === 'gone' ? (goneScans.get(b.id) || 0) + 1 : 0);
        }
      }
      // the team: since when every live member waits, and its unread count (at most every 30 s per team)
      const team = t.agents && t.agents.team ? t.agents.team : t.team;
      const members = team && !team.removed && Array.isArray(team.members) ? team.members.filter((m) => m && (m.status === 'running' || m.status === 'starting' || m.status === 'idle')) : [];
      const allIdle = t.status === 'idle' && members.length > 0 && members.every((m) => m.status === 'idle');
      let teamUnread = null;
      if (tr) {
        if (!allIdle) tr.teamQuietSince = 0;
        else {
          tr.teamQuietSince ||= now;
          const name = String(team.name || '');
          const c = unreadCache.get(name);
          if (c && now - c.at < WAITS_UNREAD_MS) teamUnread = c.n;
          else if (teams.TEAM_NAME_RE.test(name)) {
            let n = slowRound ? TIMED_OUT : await timebox(teams.unreadCount(name), timeboxLimits.read(), { label: 'waits team unread' });
            if (n === TIMED_OUT) (slowRound = true), (n = -1); // unknown, asked again on the next round (same as a half-written inbox)
            unreadCache.set(name, { at: now, n });
            teamUnread = n;
          }
        }
      }
      // UX11 (§1.6 row 6): 実行中 with no transcript line for 15 min (waits.runningOf) is told the same way
      const running = () =>
        x.role === 'manager' ? null : waits.runningOf(t, { now, runningSince: tr && tr.status === 'running' ? tr.idleSince : 0, quietMs: runQuietMs() });
      const wait = waits.waitOf(t, {
        now,
        idleSince: tr ? tr.idleSince : now,
        ptyStartedAt: ws && ws.ptyStarted ? ws.ptyStarted.get(t.id) : 0,
        files,
        targets,
        procs,
        goneScans,
        teamUnread,
        teamQuietSince: tr ? tr.teamQuietSince : 0,
        settings,
        deadlockMs: Number(process.env.AGENT_TERMINAL_WAIT_DEADLOCK_MS) || undefined, // tests may shorten these two
        goneGraceMs: Number(process.env.AGENT_TERMINAL_WAIT_GONE_GRACE_MS) || undefined,
        timeoutGraceMs: Number(process.env.AGENT_TERMINAL_WAIT_TIMEOUT_GRACE_MS) || undefined,
        staleAgentMs: Number(process.env.AGENT_TERMINAL_WAIT_STALE_MS) || undefined, // same rule as the renderer's staleAgentMs
        staleQuietMs: Number(process.env.AGENT_TERMINAL_WAIT_STALE_QUIET_MS) || undefined,
        updateHold,
      }) || running();
      entries.push({
        tabKey: String(t.id),
        wcId: x.wcId,
        role: x.role,
        folder: x.workDir || '',
        folderName: x.role === 'manager' ? 'ダッシュボード' : path.basename(x.workDir || '') || x.workDir || '',
        label: String(t.label || '').slice(0, 200),
        backlogId: typeof t.backlogId === 'string' ? t.backlogId : null,
        wait,
      });
    }
    for (const id of [...goneScans.keys()]) if (!seenCmd.has(id)) goneScans.delete(id);
    for (const id of [...waitOutFiles.keys()]) if (!seenCmd.has(id)) waitOutFiles.delete(id);
    waitEntries = entries;
    nudgeTrack.seen(entries.filter((e) => e.role !== 'manager'), now);

    // the windows (tab heads / tooltips) and the dashboard / widget
    const byWc = new Map();
    for (const e of entries) {
      if (!byWc.has(e.wcId)) byWc.set(e.wcId, {});
      byWc.get(e.wcId)[e.tabKey] = e.wait;
    }
    for (const [wcId, s] of windows) {
      const payload = byWc.get(wcId) || {};
      const json = JSON.stringify(payload);
      if (waitsSent.get(wcId) === json) continue;
      waitsSent.set(wcId, json);
      send(s, 'waits:state', payload);
    }
    for (const k of [...waitsSent.keys()]) if (!windows.has(k)) waitsSent.delete(k);
    widget.setWaits(entries);

    // the manager (not its own session: it cannot nudge itself) and 「ルーターから」
    const project = entries.filter((e) => e.role !== 'manager');
    if (managerDir) {
      const forMgr = waits.forManager(project, now);
      const sig = JSON.stringify(forMgr.sessions.map((s) => [s.tabKey, s.kind, s.alerts.map((a) => a.code)]));
      if (sig !== waitsWritten || now - (checkWaits.writtenAt || 0) >= 60_000) {
        waitsWritten = sig;
        checkWaits.writtenAt = now;
        manager.writeJsonAtomic(path.join(managerDir, 'waits.json'), forMgr);
      }
      const refs = project.flatMap((e) => (e.wait ? e.wait.alerts.map((a) => `${e.tabKey}:${a.ref}`) : []));
      // an alert haiku is still being asked about is held back (≤ 120 s + a round) so its opinion goes with the first wake
      const opinions = waitOpinions();
      const asking = opinions ? opinions.update(project) : new Set();
      const fresh = refs.filter((r) => !waitsReported.has(r) && !asking.has(r));
      waitsReported = new Set(refs.filter((r) => !asking.has(r)));
      const base = [waits.formatForManager(project), waitHints.block(project, 10, opinions && opinions.opinionOf)].filter(Boolean).join('\n');
      // the durations in the lines change every tick: tell the manager only when an alert appears or all are gone
      if (fresh.length || (!base && waitsBase)) {
        waitsBase = base;
        const block = withSchedNotes(stuckBase);
        if (inbox) {
          stuckBlock = block;
          manager
            .notifyManager(userFile('backlog'), managerDir, { newItems: newForManager(), stuck: block, wake: fresh.length > 0 })
            .then((r) => r && backlogChanged(managerDir, 'main'))
            .catch((err) => console.warn('[main] waits -> manager failed', err));
        }
      } else waitsBase = base;
    }
    if (notices) {
      const n = waits.notice(project);
      const prev = notices.findKey(waits.NOTICE_KEY);
      if (!n) {
        if (prev && !prev.resolvedAt) notices.resolve(waits.NOTICE_KEY);
      } else if (!prev || prev.resolvedAt || n.refs.some((k) => !prev.refs.includes(k)) || prev.refs.length !== n.refs.length) {
        const known = new Set(prev && !prev.resolvedAt ? prev.refs : []);
        notices.add({ ...n, quiet: n.refs.every((k) => known.has(k)) });
      }
    }
  } catch (err) {
    console.warn('[main] waits check failed', err);
  } finally {
    waitsRunning = false;
  }
}
function startWaits() {
  setInterval(checkWaits, WAITS_EVERY_MS()).unref?.();
}
// { wcId?, tabId, id } -> { file, text, size, mtime } | { error }: the tail of a waited command's output file. Only files
// main already knows from a tab's TabState (bg[].outFile), never a path from the caller.
const TAIL_BYTES = 8192;
ipcMain.handle('waits:tail', async (e, o) => {
  const own = stateOf(e);
  if (!own || !o || typeof o.tabId !== 'string' || typeof o.id !== 'string') return { error: 'bad request' };
  const wcId = own.role === 'manager' && Number.isInteger(o.wcId) ? o.wcId : e.sender.id;
  const x = widget.sessionsSnapshot().find((s) => s.wcId === wcId && String(s.t.id) === o.tabId);
  const b = x && Array.isArray(x.t.bg) ? x.t.bg.find((c) => c && c.id === o.id) : null;
  const file = b && typeof b.outFile === 'string' ? b.outFile : '';
  if (!file || !path.isAbsolute(file) || !/\.output$/i.test(file)) return { error: 'このコマンドの出力のファイルは分かりません' };
  try {
    const st = await fs.promises.stat(file);
    const fh = await fs.promises.open(file, 'r');
    try {
      const len = Math.min(TAIL_BYTES, st.size);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, st.size - len);
      let text = buf.toString('utf8');
      if (st.size > len) text = text.replace(/^[^\n]*\n/, ''); // drop the cut first line
      return { file, text: text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), size: st.size, mtime: st.mtimeMs };
    } finally {
      await fh.close();
    }
  } catch {
    return { error: '出力のファイルを読めません（消えたか、まだ作られていません）' };
  }
});
// 進み具合の確認の間隔 (依頼-189, the settings screen): { minutes, choices } / set { minutes } -> settings.json
// progressCheckMinutes (other keys kept); the timer is armed again with the new interval (0 = 止める: no round).
ipcMain.handle('progress:settings', () => ({ minutes: progressCheck.minutesOf(loadManagerSettings()), choices: progressCheck.CHOICES }));
ipcMain.handle('progress:setSettings', (e, o) => {
  const m = progressCheck.normalizeMinutes(o && o.minutes);
  if (m === null) return null;
  try {
    manager.writeJsonAtomic(managerSettingsFile(), { ...loadManagerSettings(), progressCheckMinutes: m });
  } catch (err) {
    console.warn('[main] saving the progress check interval failed', err);
    return null;
  }
  if (progressTick) progressTick();
  return { minutes: progressCheck.minutesOf({ progressCheckMinutes: m }), choices: progressCheck.CHOICES };
});
// 依頼-414: セッションからの依頼の上限（24 時間）. manager-settings.json proposeDayMax (1..1000, default 30), saved the way
// the other settings are (other keys kept). The outbox reads it at every file (propose.readDayLimit), the patrol at every
// round (dayLimitOf + nearOf), so no restart. -> { max, near, min, maxRange, def } / set { max } -> same | null (bad value)
const proposeSettingsOf = () => {
  const max = propose.dayLimitOf(loadManagerSettings());
  return { max, near: patrolGapsMod.nearOf(max), min: propose.DAY_MAX_RANGE[0], maxRange: propose.DAY_MAX_RANGE[1], def: propose.PER_FOLDER_DAY };
};
ipcMain.handle('propose:settings', () => proposeSettingsOf());
ipcMain.handle('propose:setSettings', (e, o) => {
  const n = Number(o && o.max);
  if (!Number.isInteger(n) || n < propose.DAY_MAX_RANGE[0] || n > propose.DAY_MAX_RANGE[1]) return null;
  try {
    manager.writeJsonAtomic(managerSettingsFile(), { ...loadManagerSettings(), proposeDayMax: n });
  } catch (err) {
    console.warn('[main] saving the propose limit failed', err);
    return null;
  }
  return proposeSettingsOf();
});
ipcMain.handle('waits:settings', () => waits.settingsOf({ silentMin: loadManagerSettings().waitSilentMin, longMin: loadManagerSettings().waitLongMin }));
ipcMain.handle('waits:setSettings', (e, o) => {
  if (stateOf(e)?.role !== 'manager') return null;
  const s = waits.settingsOf(o);
  try {
    manager.writeJsonAtomic(managerSettingsFile(), { ...loadManagerSettings(), waitSilentMin: s.silentMin, waitLongMin: s.longMin });
  } catch (err) {
    console.warn('[main] saving wait settings failed', err);
    return null;
  }
  setTimeout(checkWaits, 0);
  return s;
});
// The manager's nudge action: a message to a waiting session's lead (waits.json), typed into its tab when it is idle.
async function nudgeAction(a) {
  const c = waits.checkNudge(a, waitEntries.filter((e) => e.role !== 'manager'));
  if (c.error) {
    pmoLog({ type: 'nudge-refused', tabKey: a && a.tabKey, reason: a && a.reason, error: c.error });
    return { error: c.error };
  }
  const e = c.entry;
  if (!widget.sendAction(e.wcId, { tabId: e.tabKey, type: 'nudge', text: c.text })) return { error: 'the window of that tab is gone' };
  const reason = oneLineText(a.reason, 500);
  pmoLog({ type: 'nudge', folder: e.folder, tabKey: e.tabKey, label: e.label, text: c.text, reason, wait: e.wait.text });
  nudgeTrack.nudged(e);
  attentionSoon();
  if (notices) {
    notices.add({
      kind: 'info',
      title: `ルーターが「${e.folderName}」のリーダーに確かめさせました（${oneLineText(e.label, 40)}）`,
      text: `**待っていたもの**: ${e.wait.text}\n\n**送った文**: ${oneLineText(c.text, 400)}\n\n**理由**: ${reason}`,
      folder: e.folder || null,
      key: `app:nudge:${shortHash(e.tabKey)}`,
      source: 'app',
    });
  }
  return { type: 'nudge', tabKey: e.tabKey, folder: e.folder };
}

// UX11: the manager's interrupt action (CONTRACT.md "Waits"): a tab in waits.json as kind running (実行中 with no
// transcript line for 15 min) gets Esc, then the text once its input box is back (renderer interruptTab).
async function interruptAction(a) {
  const c = waits.checkInterrupt(a, waitEntries.filter((e) => e.role !== 'manager'));
  if (c.error) {
    pmoLog({ type: 'interrupt-refused', tabKey: a && a.tabKey, reason: a && a.reason, error: c.error });
    return { error: c.error };
  }
  const e = c.entry;
  if (!widget.sendAction(e.wcId, { tabId: e.tabKey, type: 'interrupt', text: c.text })) return { error: 'the window of that tab is gone' };
  const reason = oneLineText(a.reason, 500);
  pmoLog({ type: 'interrupt', folder: e.folder, tabKey: e.tabKey, label: e.label, text: c.text, reason, wait: e.wait.text });
  attentionSoon();
  if (notices) {
    notices.add({
      kind: 'info',
      title: `ルーターが「${e.folderName}」の実行中のセッションを止めて、状況を聞きました（${oneLineText(e.label, 40)}）`,
      text: `**様子**: ${e.wait.text}\n\n**送った文**: ${oneLineText(c.text, 400)}\n\n**理由**: ${reason}`,
      folder: e.folder || null,
      key: `app:interrupt:${shortHash(e.tabKey)}`,
      source: 'app',
    });
  }
  return { type: 'interrupt', tabKey: e.tabKey, folder: e.folder };
}
// UX11: the ルーター's outlook on a folder's card (manager/outlook.json -> projects.json outlook -> 「ルーターの見立て」)
let outlookStore = null;
function outlooks() {
  if (!outlookStore) {
    const file = () => (managerDir ? path.join(managerDir, 'outlook.json') : null);
    outlookStore = lookout.createOutlooks({
      read: () => (file() ? JSON.parse(fs.readFileSync(file(), 'utf8')) : null),
      write: (d) => file() && manager.writeJsonAtomic(file(), d),
    });
  }
  return outlookStore;
}
function outlookAction(a) {
  const v = lookout.cleanOutlook(a);
  if (v.error) return { error: v.error };
  if (!isDir(v.folder)) return { error: `not an existing directory: ${a.folder}` };
  outlooks().set(v.folder, v.text);
  pmoLog({ type: 'outlook', folder: v.folder, text: v.text });
  scheduleProjects();
  return { type: 'outlook', folder: v.folder, text: v.text };
}
// --- UX12 事後の確認 (src/main/reviews.js, docs/ux12-check.md) ---------------------------------------------------------
// A routed item ended with 作業完了: its window sends the last reply (review:add); its 「仮説で決めたこと」 / 「事後の確認」
// headings (Reassure.hypothesesOf) are kept in manager/reviews.json and shown on the home under 要対応. 「違う」
// (review:answer) puts a request in the inbox: the ルーター reads it with the next prompt and stacks the fix.
let postStore = null;
function postChecks() {
  if (!postStore) {
    const file = () => (managerDir ? path.join(managerDir, 'reviews.json') : null);
    postStore = reviewsMod.createReviews({
      read: () => (file() ? JSON.parse(fs.readFileSync(file(), 'utf8')) : null),
      write: (d) => file() && manager.writeJsonAtomic(file(), d),
    });
  }
  return postStore;
}
function reviewsChanged() {
  const payload = { items: postChecks().list() };
  for (const s of windows.values()) if (s.role === 'manager') send(s, 'reviews:changed', payload);
}
ipcMain.handle('review:add', async (e, o) => {
  const s = stateOf(e);
  if (!s || !s.workDir || s.role === 'manager' || !managerDir) return false;
  const id = o && typeof o.backlogId === 'string' ? o.backlogId.slice(0, 120) : '';
  const text = o && typeof o.text === 'string' ? o.text.slice(-20000) : '';
  if (!id || !text) return false;
  const h = Reassure.hypothesesOf(text);
  if (!h.hypotheses.length && !h.checks.length) return false;
  let it = null;
  try {
    it = ((await backlog.getBacklog(userFile('backlog'), s.workDir)).items || []).find((x) => x && x.id === id) || null;
  } catch {}
  const r = postChecks().add({ folder: s.workDir, itemId: id, no: (it && it.no) || '', title: (it && (it.title || it.text)) || '', tabId: o.tabId || '', ...h });
  if (!r) return false;
  pmoLog({ type: 'review-add', folder: s.workDir, backlogId: id, no: r.no, title: r.title, count: r.hypotheses.length + r.checks.length });
  reviewsChanged();
  return true;
});
ipcMain.handle('reviews:list', (e) => (stateOf(e)?.role === 'manager' && managerDir ? { items: postChecks().list() } : null));
// { id, key: 'h0'|'c0'…, choice: 'wrong'|'ok', note? } -> { ok, inboxId? } | { error }
ipcMain.handle('review:answer', (e, o) => {
  if (stateOf(e)?.role !== 'manager' || !managerDir) return { error: 'manager window only' };
  const r = postChecks().answer(o);
  if (r.error) return r;
  let inboxId = null;
  if (r.wrong && inbox) {
    const item = inbox.add({ text: r.wrong });
    inboxId = (item && item.id) || null;
    pmoLog({ type: 'review-wrong', folder: r.review.folder || null, backlogId: r.review.itemId, no: r.review.no, title: r.review.title, inboxId, text: o.key });
  }
  reviewsChanged();
  return { ok: true, inboxId };
});
ipcMain.handle('review:seen', (e, o) => {
  if (stateOf(e)?.role !== 'manager' || !managerDir || !o || typeof o.id !== 'string') return false;
  const r = postChecks().seen(o.id);
  if (r) reviewsChanged();
  return !!r;
});

// UX11 (§1.6 row 20): the ルーター's own outbox file moved to failed/ -> a line in its next prompt (wakes it)
function outboxFailed(f) {
  const line = lookout.outboxFailLine(f);
  if (!line || !managerDir || !inbox) return;
  pmoLog({ type: 'outbox-failed', name: f.name, error: (f.errors || []).join(' / ').slice(0, 300) });
  manager
    .notifyManager(userFile('backlog'), managerDir, { newItems: newForManager(), outboxFailed: line, wake: true })
    .then((r) => r && backlogChanged(managerDir, 'main'))
    .catch((err) => console.warn('[main] outbox failed -> manager failed', err));
}

// --- UX11 (§1.6 row 17): the ルーター's heartbeat ---------------------------------------------------------------------
// Every HEART_EVERY_MS: manager/heartbeat.json { updatedAt, lastReceivedAt (an m- prompt last taken), pending (m- prompts
// not taken), inboxNew, oldestPendingAt, status, woken } and, when a prompt waits HEART_STALE_MS without the ルーター taking
// one (lookout.heartbeat stale), the ルーター is woken (lookout.wakeOf: Esc when its claude is stuck 実行中, else a restart
// with --resume), at most Nonstop.WAKE_MAX times an hour, with an info notice app:pmo-heartbeat.
const HEART_EVERY_MS = () => (require('./main/e2e').isE2E() && Number(process.env.AGENT_TERMINAL_HEART_EVERY_MS)) || 60_000;
const heartStaleMs = () => (require('./main/e2e').isE2E() && Number(process.env.AGENT_TERMINAL_HEART_STALE_MS)) || lookout.HEART_STALE_MS;
let heartWakes = [];
let heartWritten = '';
let heartWrittenAt = 0;
let heartSent = '';
let heartLast = null; // the last heartbeat (pmo:heartbeat)
// UX12: the home reads the heartbeat (manager window only). E2E: AGENT_TERMINAL_E2E_HEARTBEAT (a file with a heartbeat
// object) stands in while it exists, so the e2e can show the PMO-stopped line without waiting 20 minutes.
ipcMain.handle('pmo:heartbeat', (e) => {
  if (stateOf(e)?.role !== 'manager') return null;
  const fake = require('./main/e2e').isE2E() && process.env.AGENT_TERMINAL_E2E_HEARTBEAT;
  if (fake && fs.existsSync(fake)) {
    try {
      return JSON.parse(fs.readFileSync(fake, 'utf8'));
    } catch {}
  }
  return heartLast;
});
async function checkHeartbeat() {
  if (!managerDir || !inbox || quitting) return null;
  try {
    const now = Date.now();
    const items = (await backlog.getBacklog(userFile('backlog'), managerDir)).items || [];
    const pmoTabs = widget.sessionsSnapshot().filter((x) => x.role === 'manager');
    const pmo = (pmoTabs.find((x) => !x.t.rest && x.t.status !== 'exited') || pmoTabs[0]) || null;
    const hb = lookout.heartbeat({ items, inboxNew: inbox.get().items.filter((i) => i.status === 'new').length, pmo: pmo && pmo.t, now, staleMs: heartStaleMs() });
    const quiet = !!(pmo && waits.runningOf(pmo.t, { now, runningSince: 0, quietMs: runQuietMs() }));
    const allowed = Nonstop.wakeAllowed(heartWakes, now);
    const gapOk = now - (heartWakes[heartWakes.length - 1] || 0) >= Math.min(5 * 60_000, heartStaleMs()); // not again the next minute
    // not while the app is restarting or the usage limit holds (the ルーター's prompt waits for the time). PMO-SEND: a reserved
    // update ('pending') no longer holds the ルーター's prompts (renderer.js queueHolds), so a stale heartbeat then is a real
    // stop: woken as at any other time (before, the hold could last 30 min to a night and nothing woke it)
    const restarting = !!(updater && (safeStatus() || {}).state === 'restarting');
    const wake = lookout.wakeOf(hb, pmo && pmo.t, { quiet, allowed: allowed.ok && gapOk && !restarting && !schedLimitHold() });
    if (wake && widget.sendAction(pmo.wcId, { tabId: String(pmo.t.id), type: 'pmo-wake', mode: wake.mode })) {
      heartWakes = allowed.times;
      hb.woken = { at: now, mode: wake.mode, why: wake.why };
      checkHeartbeat.woken = hb.woken;
      console.log(`[pmo] heartbeat stale (${hb.pending} waiting since ${new Date(hb.oldestPendingAt || now).toISOString()}): woken (${wake.mode})`);
      pmoLog({ type: 'pmo-heartbeat-wake', mode: wake.mode, why: wake.why, pending: hb.pending });
      if (notices) {
        notices.add({
          kind: 'info',
          title: `ルーターが ${Math.round((now - Math.max(hb.oldestPendingAt || 0, hb.lastReceivedAt || 0)) / 60000)} 分 依頼を受け取っていないので、起こし直しました`,
          text: `${wake.mode === 'esc' ? '実行中のまま止まっていたので Esc を送りました。' : 'タブの claude を再開しました（会話はそのまま）。'}1 時間に ${Nonstop.WAKE_MAX} 回まで自動で起こします（今回 ${heartWakes.length} 回目）。`,
          key: 'app:pmo-heartbeat',
          source: 'app',
        });
      }
    } else if (checkHeartbeat.woken) hb.woken = checkHeartbeat.woken;
    holdLogWrite(holdLog.onHeartbeat(hb, items, updater ? (safeStatus() || {}).state : 'none')); // HOLD-LOG
    const sig = JSON.stringify({ ...hb, updatedAt: 0 });
    if (sig !== heartWritten || now - heartWrittenAt >= 5 * 60_000) {
      heartWritten = sig;
      heartWrittenAt = now;
      manager.writeJsonAtomic(path.join(managerDir, 'heartbeat.json'), hb);
    }
    // UX12: the home's 安心の 1 行 (pmo:heartbeat / pmo:heartbeat-changed), only when it changed
    if (sig !== heartSent) {
      heartSent = sig;
      for (const s of windows.values()) if (s.role === 'manager') send(s, 'pmo:heartbeat-changed', hb);
    }
    heartLast = hb;
    return hb;
  } catch (err) {
    console.warn('[main] heartbeat failed', err);
    return null;
  }
}
function startHeartbeat() {
  const t = setInterval(checkHeartbeat, HEART_EVERY_MS());
  t.unref?.();
  setTimeout(checkHeartbeat, 5000).unref?.();
}

// --- 「あなたの番」 (UIUX U3, src/main/attention.js, CONTRACT.md "Inbox / manager") ---------------------------------------
// One list of what only the user can decide: dialogs the ルーター may not press / questions (stuck.userList), open QA tables,
// unanswered proposals, sessions nudged twice that still wait. Rebuilt on every change of its sources (debounced) and
// every ATTN_EVERY_MS (grace / settle times pass); attention:changed { items, at, notified } to manager windows when it
// changed. A new item raises one Windows notification (not while the dashboard has the focus; not for the list found at
// start-up), clicking it opens あなたの番.
const ATTN_EVERY_MS = 3000;
const attnGraceMs = () => (process.env.AGENT_TERMINAL_ATTN_GRACE_MS != null ? Number(process.env.AGENT_TERMINAL_ATTN_GRACE_MS) || 0 : attention.GRACE_MS);
const attnNudgeMs = () => (process.env.AGENT_TERMINAL_ATTN_NUDGE_MS != null ? Number(process.env.AGENT_TERMINAL_ATTN_NUDGE_MS) || 0 : attention.NUDGE_SETTLE_MS);
const nudgeTrack = attention.createNudges();
const attnOrder = attention.createOrder();
const attnTasks = new Map(); // norm(folder) -> { at, items } (backlog items for the task names; dropped on backlogChanged)
let attnItems = [];
let attnSig = '';
let attnSeeded = false; // the first build only records what is there (no notification for it)
const attnAnnounced = new Set(); // ids a notification was raised for (or that were there at start-up)
let attnNotified = 0;
let attnLastToast = 0;
let attnTimer = null;
let attnRunning = false;
let attnAgain = false;
function attentionSoon() {
  if (!managerDir || attnTimer) return;
  attnTimer = setTimeout(() => {
    attnTimer = null;
    buildAttention().catch((err) => console.warn('[main] attention failed', err));
  }, 250);
  attnTimer.unref?.();
}
async function attnBacklogState(folder) {
  const k = norm(folder);
  const c = attnTasks.get(k);
  if (c && Date.now() - c.at < 30_000) return c.state;
  let state = { items: [], auto: {} };
  try {
    state = await backlog.getBacklog(userFile('backlog'), folder);
  } catch {}
  attnTasks.set(k, { at: Date.now(), state, items: state.items || [] });
  return state;
}
const attnBacklog = async (folder) => (await attnBacklogState(folder)).items || [];
const attnPmoStallMs = () => (process.env.AGENT_TERMINAL_PMO_STALL_MS != null ? Number(process.env.AGENT_TERMINAL_PMO_STALL_MS) || 0 : AutoSend.STALL_MS);
async function buildAttention() {
  if (!managerDir || quitting) return;
  if (attnRunning) {
    attnAgain = true;
    return;
  }
  attnRunning = true;
  try {
    const now = Date.now();
    const snap = widget.sessionsSnapshot();
    const tabs = new Map(snap.map((x) => [`${x.wcId}:${x.t.id}`, { backlogId: typeof x.t.backlogId === 'string' ? x.t.backlogId : null, role: x.role }]));
    const waiting = stuck.userList(snap, now);
    const qaList = qa ? qa.list() : [];
    const nudgeList = nudgeTrack.list();
    // the backlogs the items point into (task names, whether a QA's task has started)
    const want = new Set();
    for (const e of waiting) if (e.kind === 'input' && e.folder) want.add(e.folder);
    for (const q of qaList) if (q.status === 'open' && q.folder) want.add(q.folder);
    for (const g of nudgeList) if (g.folder) want.add(g.folder);
    const byFolder = new Map();
    for (const f of want) byFolder.set(norm(f), await attnBacklog(f));
    // the ルーター's own queue: its auto send stopped / a prompt not sent for long (autosend.js stalls)
    // PMO-SEND (docs/pmo-send.md): with the ルーター tabs' state, a ルーター in a turn whose transcript moves is not a stall
    const pmoTabs = {};
    for (const x of snap) {
      if (x.role !== 'manager' || !x.t || x.t.id == null) continue;
      const st = x.t.rest ? 'rest' : String(x.t.status || '');
      // no transcript event seen at all (a tab back from a restart, a screen frozen on the spinner): not known to move
      const moved = Number(x.t.eventAt) > 0;
      pmoTabs[String(x.t.id)] = { status: st, quiet: st === 'running' && (!moved || !!waits.runningOf(x.t, { now, runningSince: 0, quietMs: runQuietMs() })) };
    }
    const upNow = updater ? (safeStatus() || {}).state : '';
    const pmoHold = schedLimitHold() ? 'limit' : upNow === 'restarting' ? 'restart' : '';
    const pmoStalls = AutoSend.stalls(await attnBacklogState(managerDir), now, attnPmoStallMs(), { tabs: pmoTabs, hold: pmoHold });
    const items = attention.build({
      now,
      managerDir,
      waiting,
      tabs,
      qa: qaList,
      notices: notices ? noticesStore.forAttention(notices.list()) : [],
      inbox: inbox ? inbox.get().items : [],
      task: (folder, id) => (byFolder.get(norm(folder)) || []).find((i) => i && i.id === id) || null,
      nudges: nudgeList,
      pmo: pmoStalls,
      graceMs: attnGraceMs(),
      nudgeSettleMs: attnNudgeMs(),
    });
    attnItems = attnOrder.apply(items);
    widget.setAttention(attnItems); // U5: the tray's number and dot
    const fresh = attnItems.filter((i) => !attnAnnounced.has(i.id));
    for (const i of fresh) attnAnnounced.add(i.id);
    for (const id of [...attnAnnounced]) if (!attnOrder.has(id)) attnAnnounced.delete(id);
    if (attnSeeded && fresh.length) attentionToast(fresh);
    attnSeeded = true;
    const sig = attention.signature(attnItems);
    if (sig !== attnSig) {
      attnSig = sig;
      const payload = attentionPayload();
      for (const s of windows.values()) if (s.role === 'manager') send(s, 'attention:changed', payload);
    }
  } finally {
    attnRunning = false;
    if (attnAgain) {
      attnAgain = false;
      attentionSoon();
    }
  }
}
let attnDesktop = true; // UX16: the windows' デスクトップ通知 (notify:prefs)
const attentionPayload = () => ({ items: attnItems, at: Date.now(), notified: attnNotified });
const ATTN_JA = { confirm: '確認', question: '質問', qa: 'QA', proposal: '提案', nudge: '止まったまま', pmosend: 'ルーターへの自動送信' };
function attentionToast(fresh) {
  const mgr = managerState;
  if (mgr && !mgr.win.isDestroyed() && mgr.win.isVisible() && mgr.win.isFocused()) return; // the user is looking at it
  const now = Date.now();
  if (now - attnLastToast < 5000) return; // a burst: one notification
  attnLastToast = now;
  attnNotified++;
  if (!attnDesktop || !Notification.isSupported()) return; // UX16: 設定 > 通知 > デスクトップ通知
  const first = fresh[0];
  const what = [first.task && (first.task.no || first.task.reqNo), first.task && first.task.title, !first.task && first.label].filter(Boolean).join(' ');
  const n = new Notification({
    title: `要対応 ${attnItems.length} 件${isDev ? ' [DEV]' : ''}`.slice(0, 200),
    body: `${ATTN_JA[first.kind] || ''}${first.folderName ? `（${first.folderName}）` : ''}${what ? ` ${what}` : ''}${fresh.length > 1 ? ` ほか ${fresh.length - 1} 件` : ''}`.slice(0, 300),
  });
  n.on('click', () => {
    const s = startManager({ show: true });
    if (s) {
      revealWindow(s);
      setTimeout(() => send(s, 'dashboard:showWaiting', {}), 300); // opens あなたの番
    }
  });
  notifications.add(n);
  n.on('close', () => notifications.delete(n));
  setTimeout(() => notifications.delete(n), 10 * 60 * 1000);
  n.show();
}
function startAttention() {
  // nudges of the last hours survive a restart (pmo-actions.jsonl, its last 256 KB)
  try {
    const file = userFile(path.join('logs', 'pmo-actions.jsonl'));
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(st.size, 256 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      const lines = [];
      for (const l of buf.toString('utf8').split('\n')) {
        if (!l.includes('"nudge"')) continue;
        try {
          lines.push(JSON.parse(l));
        } catch {}
      }
      nudgeTrack.load(lines);
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  setInterval(() => buildAttention().catch(() => {}), ATTN_EVERY_MS).unref?.();
  attentionSoon();
}
// every window's tab states (widget.js keeps them): the dialogs in the list follow them
ipcMain.on('remote:state', () => attentionSoon());
// manager window only: -> { items: AttnItem[], at, notified } | null
ipcMain.handle('attention:list', async (e) => {
  if (stateOf(e)?.role !== 'manager' || !managerDir) return null;
  await buildAttention().catch(() => {});
  // a build already running (the first one at start-up): wait for it, not the list from before it (at most 5 s)
  for (let i = 0; (attnRunning || attnAgain) && i < 100; i++) await new Promise((r) => setTimeout(r, 50));
  return attentionPayload();
});
// manager window only: { id } of a nudge item -> true (「様子を見る」: its nudges are counted again from 0)
ipcMain.handle('attention:dismiss', (e, o) => {
  if (stateOf(e)?.role !== 'manager' || !o || typeof o.id !== 'string' || !o.id.startsWith('n:')) return false;
  const ok = nudgeTrack.dismiss(o.id.slice(2));
  if (ok) {
    pmoLog({ type: 'attention-dismiss', tabKey: o.id.slice(2) });
    attentionSoon();
  }
  return ok;
});

// o.inbox (AT-139, a project window's empty screen 「依頼を置く」): the caret goes to the dashboard's request box,
// with 「@<folder name> 」 written in it when it is empty (o.folder)
ipcMain.on('dashboard:open', (_e, o) => {
  const s = startManager({ show: true });
  // U4: Ctrl+Shift+E in a project window opens the dashboard on 「ルーターの記録」 ({ tab: 'log' })
  // UX15: Ctrl+Shift+B (was the バックログ panel) opens the home on that folder ({ tab: 'proj', showFolder })
  const showFolder = o && typeof o.showFolder === 'string' && path.isAbsolute(o.showFolder) ? o.showFolder.slice(0, 1000) : '';
  if (s && o && ['turn', 'proj', 'req', 'log'].includes(o.tab)) setTimeout(() => send(s, 'dashboard:showTab', { tab: o.tab, ...(showFolder ? { folder: showFolder } : {}) }), 300);
  if (!s || !o || o.inbox !== true) return;
  revealWindow(s);
  const folder = typeof o.folder === 'string' ? o.folder.slice(0, 1000) : '';
  setTimeout(() => send(s, 'dashboard:focusInbox', { folder }), 300);
});
// The dashboard's 「会話を開く」 on a finished item whose tab was closed (PROGRESS 49): open (or show) the folder's
// window and ask it to reopen that session; a window still loading takes the request after its restore (session:takeOpen)
ipcMain.on('dashboard:openSession', (e, o) => {
  if (stateOf(e)?.role !== 'manager' || !o || typeof o.folder !== 'string' || typeof o.tabId !== 'string' || !UUID_RE.test(o.tabId) || !isDir(o.folder)) return;
  const s = openWindow(path.resolve(o.folder));
  if (!s || s.role === 'manager') return;
  revealWindow(s);
  (s.openQueue ||= []).includes(o.tabId) || s.openQueue.push(o.tabId);
  send(s, 'session:openPending', {});
});
ipcMain.handle('session:takeOpen', (e) => {
  const s = stateOf(e);
  if (!s) return [];
  const ids = s.openQueue || [];
  s.openQueue = [];
  return ids;
});
ipcMain.handle('dashboard:projects', async () => (managerDir ? currentProjects() : []));

// Setting "新しい作業の置き場所" (create actions make their folders here): userData/manager-settings.json { workRoot }.
const managerSettingsFile = () => userFile('manager-settings.json');
function loadManagerSettings() {
  try {
    // read-modify-write by waits:setSettings and dashboard:chooseWorkRoot: read the newest queued text (perf2)
    const o = manager.readJsonFile(managerSettingsFile());
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}
function getWorkRoot() {
  const w = loadManagerSettings().workRoot;
  if (typeof w === 'string' && path.isAbsolute(w)) return w;
  // BN3 (docs/naming.md 3.3): the default is <Documents>/BantoDesk. When only the former <Documents>/Agent Terminal
  // exists (work folders live there, they are not moved), that one stays the default (compat).
  const docs = app.getPath('documents');
  const next = path.join(docs, 'BantoDesk');
  const former = path.join(docs, 'Agent' + ' Terminal'); // BN3 compat
  return !isDir(next) && isDir(former) ? former : next;
}
// UX6: the dashboard's refresh in one invoke (src/main/snapshot.js): { calls: { [name]: [channel, arg?] }, sigs? }
//   -> { [name]: { sig, value } | { sig, same: true } | { error } }; read-only channels only (snapshot.CHANNELS)
ipcMain.handle('dashboard:snapshot', (e, o) => dashSnapshot.run(e, o));
ipcMain.handle('dashboard:workRoot', (e) => (stateOf(e)?.role === 'manager' ? getWorkRoot() : null));
// AT-6: the default model / effort of every claude start (manager-settings.json, src/main/models.js). Changed from the
// manager window only.
// -> { session: { model, effort }, pmo: { model, effort }, kinds: { <kind>: { model, effort } }, efforts, builtin: { model, effort }, kindBuiltin }
function modelSettingsView() {
  const ms = loadManagerSettings();
  // TK3: + lean { on, off } (the lean preamble switch, lean:set)
  return { ...models.fromSettings(ms), efforts: models.EFFORTS, builtin: { model: models.DEFAULT_MODEL, effort: models.DEFAULT_EFFORT }, kindBuiltin: models.KIND_DEFAULTS, lean: leanPref.view(ms), codeMode: codeMode.modeOf(ms), codeModeModes: codeMode.MODES };
}
ipcMain.handle('models:get', (e) => (stateOf(e) ? modelSettingsView() : null)); // read: every window (the marks on the items)
// o = { claudeModel?, claudeEffort?, pmoModel?, pmoEffort? } ('' = built-in default) -> the view, or { error }
ipcMain.handle('models:set', (e, o) => {
  if (stateOf(e)?.role !== 'manager') return { error: 'manager window only' };
  const p = models.settingsPatch(o);
  if (p.error) return { error: p.error };
  const next = { ...loadManagerSettings() };
  for (const [k, v] of Object.entries(p.fields)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  try {
    manager.writeJsonAtomic(managerSettingsFile(), next);
  } catch (err) {
    console.warn('[main] saving model settings failed', err);
    return { error: 'not saved' };
  }
  return modelSettingsView();
});
// 依頼-535: code mode on / off / auto: o = { codeMode } -> the models view, or { error }. Applies from the next claude start.
ipcMain.handle('codemode:set', (e, o) => {
  if (stateOf(e)?.role !== 'manager') return { error: 'manager window only' };
  const p = codeMode.patch(loadManagerSettings(), o);
  if (p.error) return { error: p.error };
  try {
    manager.writeJsonAtomic(managerSettingsFile(), p.next);
  } catch (err) {
    console.warn('[main] saving code mode failed', err);
    return { error: 'not saved' };
  }
  return modelSettingsView();
});
// TK3: the lean preamble (TK2) from the settings: o = { on?: boolean } (app-wide) | { folder, keep: boolean }
// (このフォルダでは削らない) -> the models view (with lean), or { error }. Applies from the next claude start.
ipcMain.handle('lean:set', (e, o) => {
  if (stateOf(e)?.role !== 'manager') return { error: 'manager window only' };
  const p = leanPref.patch(loadManagerSettings(), o);
  if (p.error) return { error: p.error };
  try {
    manager.writeJsonAtomic(managerSettingsFile(), p.next);
  } catch (err) {
    console.warn('[main] saving lean settings failed', err);
    return { error: 'not saved' };
  }
  return modelSettingsView();
});
// A folder's PROGRESS.md as a table (src/main/progress.js, cached by mtime). Manager windows only.
ipcMain.handle('dashboard:progress', (e, o) => (stateOf(e)?.role === 'manager' ? progressFile.readProgress(o && o.folder) : null));
// 全体図 (roadmap 14, src/main/overview.js): the dashboard's sessions, inbox, backlogs and PROGRESS.md rows regrouped by purpose.
// Only the records the app already holds (no process / network reading). Manager windows only; the dashboard asks while the
// 全体図 tab is open (about once a second, on dashboard:sessions changes).
ipcMain.handle('overview:get', async (e) => {
  if (stateOf(e)?.role !== 'manager') return null;
  try {
    const folders = progressFolders().slice(0, 40);
    const backlogs = {};
    const progressByFolder = {};
    for (const f of folders) {
      try {
        backlogs[f] = (await backlog.getBacklog(userFile('backlog'), f)).items;
      } catch {}
      const p = progressFile.readProgress(f);
      if (p) progressByFolder[f] = p;
    }
    return require('./main/overview').buildOverview({
      sessions: widget.currentSessions(),
      inbox: inbox ? inbox.get().items : [],
      backlogs,
      projects: folders.map((f) => ({ folder: f, name: path.basename(f) || f })),
      progressByFolder,
      log: pmoLogEntries(),
      now: Date.now(),
    });
  } catch (err) {
    console.warn('[main] overview:get failed', err);
    return null;
  }
});
// Stale items for the dashboard's quiet "放置 N日" marks (same rules as the ルーター patrol, computed on demand).
ipcMain.handle('dashboard:stale', async (e) => {
  if (stateOf(e)?.role !== 'manager') return [];
  try {
    return (await currentStale()).map((f) => ({ kind: f.kind, id: f.id, status: f.status, folder: f.folder, since: f.since, age: f.age }));
  } catch (err) {
    console.warn('[main] dashboard:stale failed', err);
    return [];
  }
});
ipcMain.handle('dashboard:chooseWorkRoot', async (e) => {
  const s = stateOf(e);
  if (!s || s.role !== 'manager') return null;
  const cur = getWorkRoot();
  const r = await dialog.showOpenDialog(s.win, {
    title: '新しい作業の置き場所',
    defaultPath: isDir(cur) ? cur : app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
  const dir = path.resolve(r.filePaths[0]);
  if (isInside(dir, app.getPath('userData'))) return null;
  try {
    manager.writeJsonAtomic(managerSettingsFile(), { ...loadManagerSettings(), workRoot: dir });
  } catch (err) {
    console.warn('[main] saving manager settings failed', err);
    return null;
  }
  return dir;
});

// --- files / git --------------------------------------------------------------
ipcMain.handle('git:diff', async (e, o) => {
  const s = stateOf(e);
  if (!s) return { ok: false, isGit: false, diff: '', untracked: false, error: 'no window' };
  try {
    return await gitTools.gitDiff(s.workDir, o);
  } catch (err) {
    return { ok: false, isGit: true, diff: '', untracked: false, error: String(err && err.message) };
  }
});
// UX15 「この作業」 フォルダを開く: Finder / Explorer on a folder the app knows (a window's folder or one under it, a recent
// folder); nothing else is opened (the path comes from a renderer).
ipcMain.on('shell:openFolder', (e, p) => {
  if (typeof p !== 'string' || !p || !path.isAbsolute(p) || !isDir(p)) return;
  const abs = path.resolve(p);
  const inside = (dir) => typeof dir === 'string' && !!dir && isInside(abs, dir);
  const known = [...windows.values()].some((s) => inside(s.workDir)) || loadRecent().some(inside);
  if (!known) return;
  shell.openPath(abs).catch(() => {});
});
ipcMain.on('shell:openFile', (e, p) => {
  const s = stateOf(e);
  if (typeof p !== 'string' || !p) return;
  const abs = s ? path.resolve(s.workDir, p) : path.resolve(p);
  gitTools.openInEditor(abs, (x) => shell.openPath(x));
});

// --- composer: @-file search, slash commands, pasted images -------------------
// cwd may be a sub-dir of workDir (worktree tab); anything else falls back to workDir.
const composerCwd = (s, cwd) => (typeof cwd === 'string' && cwd && isDir(cwd) && isInside(cwd, s.workDir) ? path.resolve(cwd) : s.workDir);
ipcMain.handle('files:search', async (e, o) => {
  const s = stateOf(e);
  if (!s) return { cwd: null, files: [] };
  const { cwd, query, limit } = o || {};
  return files.searchFiles(composerCwd(s, cwd), query, limit); // -> { cwd: dir actually searched, files }
});
ipcMain.handle('commands:list', (e, o) => {
  const s = stateOf(e);
  return s ? files.listCommands(composerCwd(s, (o || {}).cwd)) : [];
});
ipcMain.handle('image:save', (e, o) => {
  if (!stateOf(e)) return { ok: false, error: 'no window' };
  const { data, ext } = o || {};
  return files.saveImage(data, ext);
});

// Thumbnails of attached images (conversation bubbles, composer chips): data: URL or null.
ipcMain.handle('image:read', (e, p) => (stateOf(e) ? files.readImageDataUrl(p) : null));

// --- keep the PC awake while sessions run (settings "実行中はスリープしない" / "ふたを閉じてもスリープしない") --------
// Each window (project windows, hidden ones, the manager's) reports whether one of its sessions works (renderer decides:
// running, a queued item, subagents / team members, background commands), honouring the settings. main adds queued items
// it started for folders whose window has not reported yet. While anything is busy: Electron's blocker, a system-required
// power request and (AC power, setting on) the lid close action "do nothing"; all undone when work ends, on quit, and the
// lid also on the next start after a crash. src/main/keepawake.js, docs/keep-awake.md.
const keepAwakeFile = () => path.join(app.getPath('userData'), 'keep-awake.json'); // status (tests, settings screen)
let keepAwake = null;
function keepAwakeCtl() {
  if (keepAwake) return keepAwake;
  const fake = !!process.env.AT_POWERCFG_FAKE;
  // Real writes only from the released app with its own userData (not dev, not a test's --user-data-dir).
  // (app.getPath('appData') can throw when the environment is changed, as in tests: then no real writes)
  let allowWrite = fake;
  try {
    const defaultUserData = path.join(process.env.APPDATA || app.getPath('appData'), app.getName());
    allowWrite = fake || (!isDev && norm(app.getPath('userData')) === norm(defaultUserData));
  } catch {}
  const log = (m) => console.log(m);
  const lid = keepAwakeMod.createLid({ run: keepAwakeMod.makeRunner(), file: path.join(app.getPath('userData'), 'lid-action.json'), allowWrite, log, platform: fake ? 'win32' : process.platform });
  const request = process.platform === 'win32' && !process.env.AT_KEEPAWAKE_NO_REQUEST ? keepAwakeMod.createSystemRequest({ log }) : null;
  keepAwake = keepAwakeMod.createController({ blocker: powerSaveBlocker, request, lid, file: keepAwakeFile(), log });
  return keepAwake;
}
function updatePowerBlock() {
  if (quitting) return; // will-quit ends keep-awake once (52b)
  const states = [...windows.values()].map((s) => ({ busy: s.busy, keepAwake: s.keepAwake, lid: s.lidKeep, role: s.role, mode: s.sleepMode }));
  let routed = 0;
  const open = new Set(schedFolders().map((s) => norm(s.workDir)));
  for (const r of schedReserved.values()) if (Date.now() - r.at <= SCHED_RESERVE_MS) routed++;
  for (const [key, c] of schedItemsCache) if (open.has(key)) routed += (c.items || []).filter((i) => i && i.status === 'active' && typeof i.id === 'string' && i.id.startsWith('r-')).length;
  try {
    keepAwakeCtl().update(keepAwakeMod.decide(states, routed));
  } catch (err) {
    console.warn('[main] keep-awake update failed', err);
  }
}
setInterval(updatePowerBlock, 30_000).unref?.(); // reservations expire with time
ipcMain.handle('power:state', () => keepAwakeCtl().snapshot()); // { busy, why, blocker, request, requestHelper, lid, lidWanted }
// UX18 (docs/ux-journey.md §5.7): the zoom of every window (80〜150%, app-settings.json zoom) and the first ground of a
// new window (app-settings.json theme = the renderer's localStorage 'theme', copied by theme.js; 'os' -> nativeTheme).
// The ground values are tokens.css --bg of the two grounds.
const FIRST_GROUND = { dark: '#141519', light: '#f4f5f7' };
let zoomNow = null;
function zoomFactor() {
  if (zoomNow === null) zoomNow = appSettings.read(app.getPath('userData')).zoom;
  return zoomNow;
}
function themeNow() {
  const t = appSettings.read(app.getPath('userData')).theme;
  if (t !== 'os') return t;
  try {
    return require('electron').nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
}
function firstGround() {
  return FIRST_GROUND[themeNow()] || FIRST_GROUND.dark;
}
// the window's own buttons follow the zoom and the ground: the 40px bar is 40 × zoom on the screen, so the traffic lights
// (macOS, ~14px high) move to its middle and the Windows overlay (3 buttons) takes its height and the ground's colours
const OVERLAY_SYMBOL = { dark: '#a0a4ad', light: '#50565f' }; // tokens.css --muted
function fitWindowButtons(w) {
  const z = zoomFactor();
  try {
    if (process.platform === 'darwin') w.setWindowButtonPosition?.({ x: 14, y: Math.max(4, Math.round(20 * z - 7)) });
    else if (process.platform === 'win32') {
      const t = themeNow();
      w.setTitleBarOverlay?.({ color: FIRST_GROUND[t] || FIRST_GROUND.dark, symbolColor: OVERLAY_SYMBOL[t] || OVERLAY_SYMBOL.dark, height: Math.round(40 * z) });
    }
  } catch {}
}
// apply the saved zoom / ground to every open window (the windows of the app's folders and the dashboard)
function applyLook() {
  const z = zoomFactor();
  const bg = firstGround();
  for (const st of windows.values()) {
    const w = st.win;
    if (!w || w.isDestroyed()) continue;
    try { w.webContents.setZoomFactor(z); } catch {}
    try { w.setBackgroundColor(bg); } catch {}
    fitWindowButtons(w);
    try { w.webContents.send('zoom:changed', z); } catch {}
  }
}
function saveZoom(z) {
  const s = appSettings.patch(app.getPath('userData'), { zoom: z });
  zoomNow = s.zoom;
  applyLook();
  return zoomNow;
}
// ⌘+ / ⌘- / ⌘0 (the 表示 menu on macOS) and Ctrl+ on Windows (renderer.js): +1 / -1 / 0 = 実際のサイズ
function stepZoom(dir) {
  return saveZoom(appSettings.stepZoom(zoomFactor(), dir));
}
ipcMain.handle('zoom:step', (e, dir) => (stateOf(e) ? stepZoom(Number(dir) || 0) : null));
// PROGRESS 32: app-settings.json (applied before 'ready'). -> { disableGpu (saved), atStart: { disableGpu }, gpu: feature status }
function appSettingsView() {
  let gpu = null;
  try {
    gpu = app.getGPUFeatureStatus();
  } catch {}
  return { ...appSettings.read(app.getPath('userData')), atStart: gpuAtStart, gpu };
}
ipcMain.handle('appSettings:get', (e) => (stateOf(e) ? appSettingsView() : null));
ipcMain.handle('appSettings:set', (e, o) => {
  if (!stateOf(e)) return null;
  try {
    const before = appSettings.read(app.getPath('userData'));
    const after = appSettings.patch(app.getPath('userData'), o);
    zoomNow = after.zoom;
    if (after.zoom !== before.zoom || after.theme !== before.theme) applyLook(); // UX18
  } catch (err) {
    console.warn('[main] saving app-settings.json failed', err);
    return { error: 'not saved' };
  }
  return appSettingsView();
});
// UA1 (docs/usage-analytics.md §2): usage records on this PC only (<userData>/usage/, src/main/usage.js). The renderer's
// track() is filtered here against src/main/usage-ids.js; OFF drops everything. Nothing is sent anywhere.
let usageOn = null;
let usageRec = null;
function usageEnabled() {
  if (usageOn === null) usageOn = usageMod.readEnabled(app.getPath('userData'), { e2e: require('./main/e2e').isE2E() });
  return usageOn;
}
function usage() {
  if (!usageRec) {
    const e2e = require('./main/e2e').isE2E();
    const flushMs = e2e ? Number(process.env.AGENT_TERMINAL_USAGE_FLUSH_MS) || 0 : 0; // tests: a shorter batch
    usageRec = usageMod.create({ dir: path.join(app.getPath('userData'), 'usage'), enabled: usageEnabled, flushMs: flushMs || undefined, log: (...a) => console.warn(...a) });
  }
  return usageRec;
}
const usageAuto = (id) => {
  try {
    usage().auto(id);
  } catch {}
};
ipcMain.on('usage:track', (e, o) => {
  if (!stateOf(e)) return;
  try {
    usage().track(o);
  } catch (err) {
    console.warn('[main] usage track failed', err);
  }
});
ipcMain.handle('usage:get', (e) => (stateOf(e) ? { enabled: usageEnabled(), autoReport: usageMod.readAutoReport(app.getPath('userData')) } : null));
ipcMain.handle('usage:set', (e, o) => {
  if (!stateOf(e) || !o || (typeof o.enabled !== 'boolean' && typeof o.autoReport !== 'boolean')) return null;
  const ud = app.getPath('userData');
  if (typeof o.enabled === 'boolean') usageOn = usageMod.writeEnabled(ud, o.enabled);
  if (typeof o.autoReport === 'boolean') usageMod.writeSettings(ud, { autoReport: o.autoReport });
  return typeof o.autoReport === 'boolean' && typeof o.enabled !== 'boolean' ? { autoReport: o.autoReport } : { enabled: usageEnabled() };
});
// UA2 (docs/usage-analytics.md §3): the summary of a period (7 / 30 / 'all') and the report in the manager folder
// (<managerDir>/.bantodesk/usage/report-YYYY-MM-DD.md / .json: ids and numbers only, newest 8 kept)
async function usageSummary(period) {
  const p = usageReport.PERIODS.includes(period) ? period : 30;
  const today = usageMod.dayOf(Date.now());
  const rec = usage();
  const evs = await rec.events(p === 'all' ? '0000-00-00' : usageMod.dayOf(Date.now() - (p + 1) * 86400e3));
  const daily = rec.snapshot();
  return { sum: usageReport.summarize(daily, { today, period: p, events: evs }), daily };
}
const usageReportDir = () => (managerDir ? path.join(managerDir, require('./main/names').META_DIR, 'usage') : null);
async function writeUsageReport(period = 30) {
  const dir = usageReportDir();
  if (!dir) return { error: 'no manager folder' };
  const { sum, daily } = await usageSummary(period);
  const r = usageReport.writeReport(dir, sum, daily);
  return { written: true, day: r.day, files: r.files, removed: r.removed.length };
}
ipcMain.handle('usage:summary', async (e, period) => {
  if (!stateOf(e)) return null;
  try {
    return (await usageSummary(period)).sum;
  } catch (err) {
    console.warn('[main] usage summary failed', err);
    return { error: 'not summarized' };
  }
});
ipcMain.handle('usage:export', async (e) => {
  if (!stateOf(e)) return null;
  try {
    return await writeUsageReport(30);
  } catch (err) {
    console.warn('[main] usage export failed', err && err.code ? err.code : err);
    return { error: 'not written' };
  }
});
// once a week (the first start on or after Monday, src/main/usage-report.js weeklyDue), while records are ON and the
// setting 自動で書き出す is ON (default)
async function usageWeekly() {
  const ud = app.getPath('userData');
  if (!usageEnabled() || !usageMod.readAutoReport(ud) || !usageReportDir()) return null;
  const today = usageMod.dayOf(Date.now());
  if (!usageReport.weeklyDue(usageMod.readSettings(ud).lastAuto, today)) return null;
  const r = await writeUsageReport(30);
  if (r && r.written) usageMod.writeSettings(ud, { lastAuto: today });
  return r;
}
ipcMain.handle('usage:clear', async (e) => {
  if (!stateOf(e)) return null;
  try {
    await usage().clear();
    return { cleared: true, enabled: usageEnabled() };
  } catch (err) {
    console.warn('[main] usage clear failed', err);
    return { error: 'not cleared' };
  }
});
ipcMain.on('power:busy', (e, busy) => {
  const s = stateOf(e);
  if (!s) return;
  // { busy, keepAwake, lid }: busy = a session is working (also used by the auto restart); keepAwake / lid = the settings
  const o = busy && typeof busy === 'object' ? busy : { busy: busy === true, keepAwake: true };
  s.busy = o.busy === true;
  s.keepAwake = o.keepAwake !== false;
  s.lidKeep = o.lid !== false;
  // setting スリープを避ける方法 (52c): 'display' (like a meeting app) | 'system'; unset -> the platform's default
  s.sleepMode = o.mode === 'display' || o.mode === 'system' ? o.mode : null;
  // update hold (src/main/autorestart.js): gap = every session of the window is between turns; holdMin = setting 更新の待ち
  s.gap = o.gap === true;
  s.holdMin = Number.isFinite(Number(o.holdMin)) && Number(o.holdMin) > 0 ? Number(o.holdMin) : null;
  updatePowerBlock();
});

// --- update hold after a release (src/main/autorestart.js) -------------------------------------
let updater = null;
ipcMain.handle('update:state', () => (updater ? updater.status() : { state: 'none' }));
ipcMain.handle('update:action', (_e, o) => {
  const a = o && typeof o === 'object' ? o.action : o;
  return updater ? updater.action(a) : false;
});

// Release the committed HEAD of the source repo into this app's folder (outbox { type: 'release' } of the manager
// agent): scripts/release.js of that repo, run with this Electron as node. The source repo is RELEASE.json's `from`
// (a released copy) or this app's own folder (the dev repo: then release.js's default target, the sibling stable).
// The written RELEASE.json then reserves the update here (autorestart's watcher). -> Promise<{ ok, text }>
let releasing = null;
function runRelease() {
  if (releasing) return releasing;
  const appRoot = app.getAppPath();
  let from = appRoot;
  let target = null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(appRoot, 'RELEASE.json'), 'utf8'));
    if (j && typeof j.from === 'string' && j.from) {
      from = j.from;
      target = appRoot;
    }
  } catch {}
  const script = path.join(from, 'scripts', 'release.js');
  releasing = new Promise((resolve) => {
    if (!fs.existsSync(script)) return resolve({ ok: false, text: `release.js が見つかりません: ${script}` });
    const args = [script, '--commit', 'HEAD', '--json', ...(target ? ['--target', target] : [])];
    const { execFile } = require('child_process');
    execFile(process.execPath, args, { cwd: from, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10 * 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim();
      console.log(`[release] ${err ? 'failed' : 'done'}\n${out}`);
      let result = null; // the last line `RELEASE_RESULT {json}` of scripts/release.js --json
      const m = /^RELEASE_RESULT (\{.*\})\s*$/m.exec(String(stdout || ''));
      try {
        if (m) result = JSON.parse(m[1]);
      } catch {}
      const text = out.replace(/^RELEASE_RESULT .*$/m, '').trim();
      resolve({ ok: !err && (!result || result.ok !== false), result, text: text.slice(-1500) || (err ? String(err.message || err) : '') });
    });
  }).finally(() => (releasing = null));
  return releasing;
}
// outbox { type: 'release' } -> { type, commit, skipped, uncommitted, text } | { error }
async function releaseAction() {
  const r = await runRelease();
  pmoLog({ type: 'release', ok: r.ok, commit: (r.result && r.result.commit) || null, text: r.text.slice(-500) });
  if (!r.ok) return { error: `release failed: ${(r.result && r.result.error) || r.text.slice(-600)}` };
  const x = r.result || {};
  return {
    type: 'release',
    commit: x.commit || null,
    build: x.build || null,
    target: x.target || null,
    skipped: !!x.skipped,
    uncommitted: Array.isArray(x.uncommitted) ? x.uncommitted.slice(0, 100) : [],
    text: r.text.slice(-1500),
  };
}

function openExternalUrl(url) {
  if (typeof url === 'string' && /^https?:\/\//i.test(url) && url.length < 4096) shell.openExternal(url).catch(() => {});
}
ipcMain.on('shell:openExternal', (_e, url) => openExternalUrl(url));

// --- notifications ------------------------------------------------------------
// { tabId, title, body, kind?: 'done'|'input'|'error' } from a window's raise() (renderer.js).
// UX16 (docs/ux-journey.md §5.4): the OS notification is A only (attentionToast: あなたの番 grew). This one (was B, a
// toast per session for 確認待ち・エラー・完了) no longer shows an OS notification, so one confirm rings once: the
// window flashes in the taskbar, and 完了 / エラー go to 「ルーターの記録」 (pmo-actions.jsonl type 'session'). 確認待ち is
// in あなたの番 (A) already. The same notice within 60 s is written once.
const NOTIFY_KINDS = new Set(['done', 'input', 'error']);
const notifications = new Set();
const sessionNoticeAt = new Map(); // tabId|kind -> ms
ipcMain.on('notify:prefs', (_e, o) => {
  if (o && typeof o.desktop === 'boolean') attnDesktop = o.desktop;
});
ipcMain.on('notify', (e, o) => {
  const s = stateOf(e);
  if (!s || !o || typeof o !== 'object') return;
  const { win } = s;
  const tabId = typeof o.tabId === 'string' ? o.tabId.slice(0, 100) : null;
  const kind = NOTIFY_KINDS.has(o.kind) ? o.kind : null;
  // UA3 (docs/usage-analytics.md §4 の 8): a window opened hidden for routed work does not call for attention by itself
  if (!win.isFocused() && !s.hidden) win.flashFrame(true);
  if (kind !== 'done' && kind !== 'error') return;
  const k = `${tabId}|${kind}`;
  const now = Date.now();
  if (now - (sessionNoticeAt.get(k) || 0) < 60_000) return;
  sessionNoticeAt.set(k, now);
  if (sessionNoticeAt.size > 500) for (const key of [...sessionNoticeAt.keys()].slice(0, 250)) sessionNoticeAt.delete(key);
  pmoLog({ type: 'session', kind, folder: s.workDir || null, label: String(o.title ?? '').slice(0, 120), text: String(o.body ?? '').slice(0, 300), tabKey: tabId });
});

// --- snippets -----------------------------------------------------------------
function getSnippets() {
  try {
    const list = JSON.parse(fs.readFileSync(userFile('snippets.json'), 'utf8'));
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}
function sanitizeSnippets(list) {
  if (!Array.isArray(list)) return null;
  return list
    .filter((x) => x && typeof x === 'object' && typeof x.text === 'string')
    .slice(0, 500)
    .map((x) => ({
      id: typeof x.id === 'string' ? x.id.slice(0, 100) : String(Math.random()).slice(2),
      group: typeof x.group === 'string' ? x.group.slice(0, 100) : '',
      title: typeof x.title === 'string' ? x.title.slice(0, 200) : '',
      text: x.text.slice(0, 20000),
      submit: !!x.submit,
    }));
}
ipcMain.handle('snippets:get', () => getSnippets());
ipcMain.on('snippets:set', (_e, list) => {
  const clean = sanitizeSnippets(list);
  if (!clean) return;
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(userFile('snippets.json'), JSON.stringify(clean, null, 1));
  } catch (err) {
    console.warn('[main] snippets save failed', err);
  }
});

// --- temp / edit sessions (roadmap 9 / 19, docs/plan-temp-edit.md, CONTRACT.md "Temp / edit sessions") ---------
// Temp window: an empty folder <tmp>\bantodesk-temp\t-XXXXXX, deleted (with its Claude data) when the window
// closes. Edit window: e-XXXXXX holding a working copy of one file (src/main/fileedit.js); the user writes it back
// with the band's button or when closing. Folders are recorded in userData/temp-sessions.json (tempsessions.js).
// Native dialogs go through askChoice(); with AGENT_TERMINAL_TEST_DIALOGS=1 a test can answer them by setting
// global.__atDialog = ({ message, detail, buttons }) => index | label (and global.__atOpenFile = () => path | null)
// through the main-process inspector (tmp/edit/e2e.mjs).
let tempStore = null;
const pendingTempDeletes = new Set();
const backupDir = () => userFile('edit-backups');

function initTempSessions() {
  try {
    tempStore = tempSessions.createTempStore({ file: userFile('temp-sessions.json'), log: (...a) => console.warn(...a) });
    // Single instance: nothing in the ledger is in use now. Kept edit sessions stay.
    tempStore.cleanup().catch((err) => console.warn('[temp] startup cleanup failed', err));
  } catch (err) {
    console.warn('[temp] unavailable', err);
    tempStore = null;
  }
  setTimeout(() => fileEdit.pruneBackups(backupDir()), 15_000); // backups older than 30 days
}

const testHooks = () => process.env.AGENT_TERMINAL_TEST_DIALOGS === '1';
if (testHooks()) global.__atRequire = require; // tests only: reach electron (BrowserWindow) from the inspector
// -> index of the chosen button (cancelId when the dialog is dismissed)
async function askChoice(win, o) {
  const { buttons } = o;
  const cancelId = o.cancelId ?? buttons.length - 1;
  if (testHooks() && typeof global.__atDialog === 'function') {
    const r = await global.__atDialog({ message: o.message, detail: o.detail || '', buttons });
    const i = typeof r === 'number' ? r : buttons.indexOf(r);
    return i >= 0 && i < buttons.length ? i : cancelId;
  }
  const opts = { type: o.type || 'question', title: 'BantoDesk', message: o.message, detail: o.detail || '', buttons, cancelId, defaultId: o.defaultId ?? 0, noLink: true };
  const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return r.response;
}
async function tell(win, message, detail) {
  await askChoice(win, { type: 'info', message, detail, buttons: ['OK'], cancelId: 0 });
}

function openTempWindow() {
  if (!tempStore) return null;
  let entry;
  try {
    entry = tempStore.create('temp');
  } catch (err) {
    console.warn('[temp] could not create a temp folder', err);
    return null;
  }
  const s = openWindow(entry.dir, { temp: { kind: 'temp' } });
  return s;
}

const editWindowFor = (original) => [...windows.values()].find((s) => s.temp && s.temp.kind === 'edit' && s.temp.original && norm(s.temp.original) === norm(original)) || null;

// Imports file into a new edit folder and opens its window. parent: window for error dialogs. -> state | null
async function openEditWindow(file, parent = null) {
  if (!tempStore || typeof file !== 'string' || !path.isAbsolute(file)) return null;
  let original = path.resolve(file);
  try {
    original = fs.realpathSync.native(original);
  } catch {}
  if (tempStore.inRoot(path.dirname(original)) || isInside(original, tempStore.root)) {
    await tell(parent, '作業用フォルダの中のファイルは編集モードで開けません。');
    return null;
  }
  const open = editWindowFor(original);
  if (open) {
    revealWindow(open);
    return open;
  }
  // the same file kept earlier ("残して閉じる"): continue there
  const kept = tempStore.kept().find((k) => k.kind === 'edit' && k.original && norm(k.original) === norm(original) && isDir(k.dir));
  if (kept) return resumeEditWindow(kept.dir);
  let st;
  try {
    st = fs.statSync(original);
  } catch {}
  if (!st || !st.isFile()) {
    await tell(parent, 'ファイルが見つかりません。', original);
    return null;
  }
  const entry = tempStore.create('edit', { original, name: fileEdit.safeName(path.basename(original)) });
  let meta;
  try {
    meta = await fileEdit.importFile(original, entry.dir);
  } catch (err) {
    await tempStore.remove(entry.dir).catch(() => {});
    const why = err && err.code === 'ETIMEDOUT' ? '60 秒以内に読み込めませんでした（OneDrive のクラウドのみのファイルで、オフラインの可能性があります）。' : err && err.code === 'ECHANGING' ? '読み込み中にファイルが変わり続けました。少し待ってからやり直してください。' : `読み込めませんでした（${(err && err.code) || err}）。`;
    await tell(parent, `「${path.basename(original)}」を取り込めませんでした。`, why);
    return null;
  }
  tempStore.update(entry.dir, { name: meta.name });
  const s = openWindow(entry.dir, { temp: { kind: 'edit', name: meta.name, original } });
  return s;
}

function resumeEditWindow(dir) {
  const e = tempStore && tempStore.find(dir);
  if (!e || e.kind !== 'edit' || !isDir(e.dir)) return null;
  const meta = fileEdit.readMeta(e.dir);
  if (!meta) return null;
  tempStore.update(e.dir, { state: 'open' });
  const s = openWindow(e.dir, { temp: { kind: 'edit', name: meta.name, original: meta.original } });
  return s;
}

function tempTrackPty(s, id, t) {
  tempStore?.addSession(s.workDir, id);
  if (!t) return;
  (s.ptyExits ||= []).push(new Promise((r) => t.onExit(() => r())));
}

// Saved tabs of a temp / edit window (a resumed kept edit session): from the ledger, only with a transcript.
function tempSavedTabs(s) {
  const e = tempStore && tempStore.find(s.workDir);
  if (!e || !e.tabs || !e.tabs.length) return [];
  return sessions.sanitizeTabs(e.tabs).filter((t) => transcript.findTranscript(t.id));
}

function attachTempWindow(state) {
  const { win } = state;
  win.on('close', (e) => {
    if (state.closeAction) return; // decided: let it close
    e.preventDefault();
    if (state.closeAsking) return;
    state.closeAsking = true;
    const wasQuitting = quitting; // preventDefault cancelled the app quit: resume it once this window is decided
    decideTempClose(state)
      .catch((err) => {
        console.warn('[temp] close dialog failed', err);
        return null;
      })
      .then((action) => {
        state.closeAsking = false;
        if (!action) {
          quitting = false; // an app quit that this window refused is cancelled
          for (const o of reopenLater.takeBack()) launch(o.argv, o.cwd); // AT-199: opens kept meanwhile open now
          updatePowerBlock(); // the windows closed meanwhile did not update it (52b)
          return;
        }
        state.closeAction = action;
        if (!win.isDestroyed()) win.close();
        if (wasQuitting) setImmediate(() => app.quit());
      });
  });
  if (state.temp.kind === 'edit') {
    // edit:state – the status, sent when it changes (the original is checked every 15 s)
    const poll = () => pushEditState(state).catch(() => {});
    state.editTimer = setInterval(poll, 15_000);
    win.on('focus', poll);
  }
}

// -> 'delete' | 'keep' | null (stay open)
async function decideTempClose(state) {
  const { win, temp } = state;
  if (temp.kind === 'temp') {
    const e = tempStore && tempStore.find(state.workDir);
    const talked = !!e && e.sessionIds.some((id) => transcript.findTranscript(id));
    if (!talked) return 'delete';
    const i = await askChoice(win, {
      type: 'warning',
      message: '一時セッションを閉じますか？',
      detail: '閉じると一時フォルダと会話の記録を削除します。',
      buttons: ['削除して閉じる', 'キャンセル'],
    });
    return i === 0 ? 'delete' : null;
  }
  const st = await fileEdit.status(state.workDir);
  if (!st || !st.workChanged) return 'delete'; // nothing to keep
  const i = await askChoice(win, {
    type: 'question',
    message: `「${temp.name}」の作業用コピーに、元のファイルへ書き戻していない変更があります。`,
    detail: `元のファイル: ${temp.original}`,
    buttons: ['書き戻して閉じる', '破棄して閉じる', '残して閉じる', 'キャンセル'],
    cancelId: 3,
  });
  if (i === 0) {
    const r = await editWriteBackAsk(state);
    return r.ok || r.action === 'unchanged' ? 'delete' : null;
  }
  if (i === 1) return 'delete';
  if (i === 2) return 'keep';
  return null;
}

function tempWindowClosed(state) {
  clearInterval(state.editTimer);
  if (!tempStore) return;
  const dir = state.workDir;
  // A window destroyed without the close dialog (crash, forced exit): an edit session is kept (never lose edits).
  const action = state.closeAction || (state.temp.kind === 'edit' ? 'keep' : 'delete');
  if (action === 'keep') {
    tempStore.update(dir, { state: 'kept' });
    return;
  }
  const exits = state.ptyExits || [];
  const p = Promise.race([Promise.all(exits), new Promise((r) => setTimeout(r, 3000))])
    .then(() => tempStore.remove(dir))
    .then((r) => {
      if (!r.ok) console.warn('[temp] removal failed (retried at next start)', dir, r.error);
      try {
        backlogSame.forget(norm(dir));
        fs.rmSync(backlog.backlogFile(userFile('backlog'), dir), { force: true });
      } catch {}
    })
    .catch((err) => console.warn('[temp] removal failed', err))
    .finally(() => pendingTempDeletes.delete(p));
  pendingTempDeletes.add(p);
}
// The last window closed: wait (≤ 5 s) for the deletions before the app goes. Also the terminals: each one is killed
// and its exit awaited (≤ 3 s; src/main/ptyproxy.js shutdown), so no claude outlives the app with its kill still
// queued and node-pty has nothing left to deliver during the teardown (52b, docs/exit-crash.md). One handler for both: a second app.quit() from one wait would skip the other.
// keep-awake too: blocker and request stop at once, the lid action is put back by powercfg on the worker (≤ 12 s;
// if it does not finish, lid-action.json stays and the next start puts it back). docs/keep-awake.md.
let quitWaited = false;
// UX1b: tell each window's page when it enters / leaves full screen (macOS only; the top bar's traffic-light padding).
if (process.platform === 'darwin') {
  app.on('browser-window-created', (_e, w) => {
    const send = () => {
      try {
        if (!w.isDestroyed()) w.webContents.send('win:fullscreen', w.isFullScreen());
      } catch {}
    };
    w.on('enter-full-screen', send);
    w.on('leave-full-screen', send);
    w.webContents.on('did-finish-load', send);
  });
}

app.on('will-quit', (e) => {
  try { simview.stopAll(); } catch {}
  try { present.stopAll(); } catch {}
  try { browserview.stopAll(); } catch {}
  reopenLater.arm(); // AT-199: the quit goes on now; opens kept while quitting start the app again after the exit
  try {
    if (usageRec) usageRec.flushSync(); // UA1: the last batch of usage lines (before writeq: daily.json goes through it)
  } catch (err) {
    console.warn('[main] usage flush failed', err);
  }
  // perf2: settings / state files queued by src/main/writeq.js are written now (sync), so a quit never drops the last save
  try {
    writeq.flushSync();
  } catch (err) {
    console.warn('[main] writeq flush failed', err);
  }
  if (mcpServer) {
    mcpServer.close(); // the tabs' --mcp-config files go now (sync), the listener with the app
    mcpServer = null;
  }
  if (quitWaited) return;
  let ka = null;
  try {
    if (keepAwake) ka = keepAwake.quit();
  } catch (err) {
    console.warn('[main] keep-awake quit failed', err);
  }
  const kaWait = !!ka && keepAwake.settling();
  if (!kaWait && !pendingTempDeletes.size && !ptyProxy.liveCount() && !fileWatchers.count()) return;
  e.preventDefault();
  quitWaited = true;
  const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
  // 52b-mac: the file watchers are closed (fsevents stopped) before the Node environment is freed (≤ 3 s)
  const watchersClosed = fileWatchers.closeAll(3000).then((left) => {
    if (left) console.warn(`[main] quit: ${left} file watcher(s) had not closed after 3 s`);
  });
  const temps = within(Promise.allSettled([...pendingTempDeletes]), 5000);
  // 52b: every terminal is killed and its exit awaited (≤ 3 s), so no shell's exit reaches node-pty during the
  // teardown (0xC0000409 / the long hang, docs/exit-crash.md)
  const ptys = ptyProxy.shutdown(3000).then((left) => {
    if (left) console.warn(`[main] quit: ${left} terminal(s) had not ended after 3 s`);
  });
  // 52b-mac2: the quit is resumed on a later task, and app.exit(0) if it has not ended 20 s on (src/main/quitwait.js)
  waitThenQuit(app, [temps, ptys, watchersClosed, kaWait ? within(ka.catch(() => {}), 12000) : null], { log: (m) => console.warn('[main] ' + m) });
});

async function pushEditState(state) {
  if (state.win.isDestroyed()) return;
  const st = await fileEdit.status(state.workDir);
  if (!st) return;
  const key = JSON.stringify(st);
  if (key === state.editLast) return;
  state.editLast = key;
  send(state, 'edit:state', st);
}

// Write-back with the conflict choices as native dialogs.
// -> { ok, action: 'written'|'copy'|'downloads'|'unchanged'|'cancelled'|'failed', backup?, path?, reason?, error? }
async function editWriteBackAsk(state) {
  const dir = state.workDir;
  const { win, temp } = state;
  const name = path.basename(temp.original || temp.name || '');
  const ext = path.extname(name);
  const editedLabel = `元のフォルダに「${name.slice(0, name.length - ext.length)}（編集版）${ext}」として保存`;
  let r = await fileEdit.writeBack(dir, { backupDir: backupDir() });
  let out = null;
  for (let round = 0; round < 6 && !out; round++) {
    if (r.ok) {
      out = { ok: true, action: 'written', backup: r.backup };
      break;
    }
    if (r.reason === 'unchanged') {
      out = { ok: false, action: 'unchanged', reason: r.reason };
      break;
    }
    if (r.reason === 'failed') {
      await tell(win, '書き戻せませんでした。元のファイルは変更していません。', r.error || '');
      out = { ok: false, action: 'failed', reason: r.reason, error: r.error };
      break;
    }
    const msg = {
      changed: ['元のファイルが、取り込んだ後に変更されています（他の人の更新や同期の結果の可能性があります）。', '上書きすると、その変更は失われます（書き戻す前の内容はバックアップに残ります）。'],
      locked: ['元のファイルが開かれているため書き戻せません。', r.lockedBy === 'office' ? 'PowerPoint などで開いている場合は閉じてから「再試行」を押してください。' : '他のプログラムが使用中です。閉じてから「再試行」を押してください。'],
      missing: ['元のファイルが見つかりません（移動・削除・名前の変更の可能性があります）。', temp.original || ''],
    }[r.reason] || ['書き戻せません。', ''];
    const opts = [];
    if (r.reason === 'changed') opts.push(['force', 'それでも上書きする']);
    if (r.reason === 'locked') opts.push(['retry', '再試行']);
    opts.push(['copy', editedLabel], ['downloads', '作業用コピーをダウンロードに保存'], ['cancel', '中止']);
    const i = await askChoice(win, { type: 'warning', message: msg[0], detail: msg[1], buttons: opts.map((o) => o[1]), cancelId: opts.length - 1 });
    const pick = (opts[i] || ['cancel'])[0];
    if (pick === 'force') r = await fileEdit.writeBack(dir, { backupDir: backupDir(), force: true });
    else if (pick === 'retry') r = await fileEdit.writeBack(dir, { backupDir: backupDir() });
    else if (pick === 'copy' || pick === 'downloads') {
      const c = await fileEdit.saveCopy(dir, pick === 'downloads' ? { folder: app.getPath('downloads') } : {});
      if (c.ok) out = { ok: true, action: pick, path: c.path };
      else {
        await tell(win, '保存できませんでした。', c.error || '');
        out = { ok: false, action: 'failed', reason: 'failed', error: c.error };
      }
    } else out = { ok: false, action: 'cancelled', reason: r.reason };
  }
  if (!out) out = { ok: false, action: 'cancelled', reason: r.reason };
  state.editLast = null;
  pushEditState(state).catch(() => {});
  return out;
}

const editStateOf = (e) => {
  const s = stateOf(e);
  return s && s.temp && s.temp.kind === 'edit' ? s : null;
};
ipcMain.on('temp:open', () => openTempWindow());
// file dialog -> true when an edit window opened, false when cancelled / failed
ipcMain.handle('edit:pick', async (e) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  let file = null;
  if (testHooks() && typeof global.__atOpenFile === 'function') file = await global.__atOpenFile();
  else {
    const r = await dialog.showOpenDialog(parent, { title: '編集するファイル', properties: ['openFile'] });
    file = !r.canceled && r.filePaths && r.filePaths[0];
  }
  if (!file) return false;
  return !!(await openEditWindow(file, parent));
});
// { path }: a file to edit, or the dir of a kept edit session (resume)
ipcMain.on('edit:open', (e, o) => {
  const p = o && typeof o.path === 'string' ? o.path : null;
  if (!p || !path.isAbsolute(p)) return;
  const parent = BrowserWindow.fromWebContents(e.sender);
  if (tempStore && tempStore.find(p)) {
    const s = windowOf(p);
    if (s) revealWindow(s);
    else resumeEditWindow(p);
    return;
  }
  openEditWindow(p, parent);
});
ipcMain.handle('edit:status', async (e) => {
  const s = editStateOf(e);
  return s ? fileEdit.status(s.workDir) : null;
});
// { force? } -> { ok: true, backup } | { ok: false, reason, error? } (no dialogs)
ipcMain.handle('edit:writeBack', async (e, o) => {
  const s = editStateOf(e);
  if (!s) return { ok: false, reason: 'failed', error: 'not an edit window' };
  const r = await fileEdit.writeBack(s.workDir, { backupDir: backupDir(), force: !!(o && o.force === true) });
  s.editLast = null;
  pushEditState(s).catch(() => {});
  return r;
});
// band's [書き戻す]: write-back with the conflict choices (native dialogs) -> see editWriteBackAsk
ipcMain.handle('edit:writeBackAsk', async (e) => {
  const s = editStateOf(e);
  if (!s) return { ok: false, action: 'failed', reason: 'failed', error: 'not an edit window' };
  if (s.writing) return { ok: false, action: 'cancelled', reason: 'busy' };
  s.writing = true;
  try {
    return await editWriteBackAsk(s);
  } finally {
    s.writing = false;
  }
});
ipcMain.handle('edit:diff', async (e) => {
  const s = editStateOf(e);
  return s ? fileEdit.diff(s.workDir) : null;
});
ipcMain.on('edit:openWork', (e) => {
  const s = editStateOf(e);
  const meta = s && fileEdit.readMeta(s.workDir);
  if (meta) shell.openPath(path.join(s.workDir, meta.name)).catch(() => {});
});

// --- app lifecycle ------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Toasts on Windows need an AppUserModelID; for an unpackaged electron.exe the exe path works.
  if (process.platform === 'win32') app.setAppUserModelId(process.execPath);
  // AT-199: an open that comes while the app is quitting is opened again after the exit (src/main/reopenlater.js)
  app.on('second-instance', (_e, argv, cwd) => (quitting ? reopenLater.keep(argv, cwd) : launch(argv, cwd)));
  app.whenReady().then(() => {
    // BN1 (docs/naming.md 3.2): the shown name only. No app.setName(): app.getName() (package.json name bantodesk /
    // bantodesk-dev, BN3) picks the userData folder and isDev. The About panel shows this name.
    try { app.setAboutPanelOptions({ applicationName: `BantoDesk${isDev ? ' [DEV]' : ''}` }); } catch {}
    // The default menu's accelerators (e.g. Ctrl+W closes the window) would swallow keys meant for the terminal: no menu
    // on Windows. macOS gets the app / 編集 / 表示 / ウインドウ menus without such keys (UX4, src/main/appmenu.js).
    require('./main/appmenu').install(Menu, {
      appName: 'BantoDesk',
      onSettings: () => {
        const w = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows().find((x) => x.isVisible());
        if (w && !w.isDestroyed()) w.webContents.send('menu:command', 'settings');
      },
      onZoom: (dir) => stepZoom(dir), // UX18: the 表示 menu changes the one zoom of every window and saves it
    });
    try { require('electron').nativeTheme.on('updated', () => applyLook()); } catch {} // UX18: OS dark / light -> first ground
    // DOCKID: the Dock's right-click menu starts with 「ダッシュボードを開く」 (macOS only)
    require('./main/appmenu').installDock(app, Menu, { onDashboard: () => !quitting && openStart() });
    claudeSettingsPaths = claudeCmd.writeAllClaudeSettings(app.getPath('userData')); // before the first tab starts (UX9: base / routed / manager)
    claudeLeanSettingsPaths = claudeCmd.writeAllClaudeSettings(app.getPath('userData'), true); // TK2
    startMcpServer(); // PROGRESS 4 (listens in a few ms, before a window's first tab asks for its claude)
    leftoverTrackerInit(); // 51c: tabs' leftovers counted every minute (first look after 20 s, off the startup path)
    initTempSessions(); // ledger + removal of temp folders left by a crash (before any window opens)
    // a lid action a crashed run changed is put back first (lid-action.json in userData; powercfg on the worker, a
    // hold asked meanwhile waits for it in keepawake.js settle)
    try {
      keepAwakeCtl().restore();
    } catch (err) {
      console.warn('[main] keep-awake startup restore failed', err);
    }
    initManager(); // inbox store, manager folder + outbox watcher (before any window opens)
    startSchedClosed(); // queues of folders without a window (first look ~10 s after start)
    // pty host (docs/perf.md 案 1): started before the first window so the first tab does not wait for its start. It
    // starts the tabs' claude, so the startup sweep treats it like a main of this userData (src/main/orphans.js).
    ptyProxy.setOnHostStart((pid) => orphans.record(app.getPath('userData'), { pid, startedAt: Date.now() }));
    ptyProxy.warm();
    // Sessions state + tray (src/main/widget.js; the widget window was removed in U5): IPC now, the tray right after.
    widget.init({
      app,
      ipcMain,
      isDev,
      listWindows: () => [...windows.entries()].map(([wcId, s]) => ({ wcId, workDir: s.workDir, win: s.win, role: s.role })),
      getInbox: () => (inbox ? inbox.get() : { items: [] }),
      getNotices: () => (notices ? notices.list() : []),
      openDashboard: () => startManager({ show: true }),
      // member { agentId, name } (validated by widget.js): the dashboard's 「会話を見る」 also opens that member view
      focusTab: (wcId, tabId, kind, member, from, mode) => {
        const s = windows.get(wcId);
        if (!s || s.win.isDestroyed()) return;
        revealWindow(s); // UX14: the workbench shows (作業台で開く / ターミナル)
        s.win.flashFrame(false);
        send(s, 'notify:click', { tabId, kind: NOTIFY_KINDS.has(kind) ? kind : null, from: from || 'project', ...(member ? { member } : {}), ...(mode ? { mode } : {}) });
      },
      isQuitting: () => quitting,
    });
    try {
      usage().track({ k: 'click', id: 'app.start', w: 'dash', v: isDev ? 'dev' : 'stable' }); // UA1
    } catch {}
    setTimeout(() => {
      try {
        if (usageEnabled()) usage().prune(); // UA1: events older than 30 days, daily entries older than 400
      } catch {}
      usageWeekly().catch((err) => console.warn('[main] usage weekly report failed', err && err.code ? err.code : err)); // UA2
    }, (require('./main/e2e').isE2E() && Number(process.env.AGENT_TERMINAL_USAGE_REPORT_DELAY_MS)) || 15_000).unref?.();
    widget.start(); // U5: the tray (menu bar on macOS) from the start; the dashboard is the first window (AGENT_TERMINAL_NO_WIDGET=1: no tray)
    // After an automatic restart (new release): reopen every folder that was open, hidden ones hidden.
    const reopen = autorestart.takeReopen(app.getPath('userData'));
    // UX14: folder windows come back hidden while the main window can show (the home is opened below)
    for (const r of reopen) if (isDir(r.folder)) openWindow(path.resolve(r.folder), { hidden: !workbench.showOnOpen('restore', { main: mainOn(), wasHidden: !!r.hidden }), launch: true });
    if (reopen.length && mainOn() && !hasArgFolder(process.argv, process.cwd()) && !reopen.some((r) => r.folder && isManagerDir(r.folder) && !r.hidden)) openStart();
    if (!reopen.length || hasArgFolder(process.argv, process.cwd())) launch(process.argv, process.cwd());
    // A new release copied into this app's folder (scripts/release.js): restart once sessions are idle.
    updater = autorestart.init({
      app,
      appRoot: app.getAppPath(),
      userData: app.getPath('userData'),
      // temp / edit windows count as busy and never as between turns: a restart would close (and delete) them, so it
      // waits until they are closed
      listWindows: () => [...windows.values()].map((s) => ({ win: s.win, workDir: s.workDir, busy: !!s.busy || !!s.temp, gap: !s.temp && s.gap === true, hidden: !!s.hidden, role: s.role, holdMin: s.holdMin })),
      send: (win, ch, payload) => !win.isDestroyed() && win.webContents.send(ch, payload),
      log: (...a) => console.log(...a),
      onRestart: () => usageAuto('auto.restart'),
      // UPD-MISS: what the update hold did, in <userData>/logs/update.jsonl (this PC only; main's console goes nowhere
      // in agent-terminal.sh). reserve also counts as auto.update-reserve (usage).
      record: (ev) => {
        try {
          fs.mkdirSync(userFile('logs'), { recursive: true });
          fs.appendFileSync(userFile(path.join('logs', 'update.jsonl')), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...ev }) + '\n');
        } catch {}
        if (ev && ev.ev === 'reserve') usageAuto('auto.update-reserve');
        holdLogWrite(holdLog.onEvent(ev)); // HOLD-LOG
      },
    });
    simview.init();
    browserview.init();
    pincomment.init();
    present.init();
    viewer.init({ ipcMain, protocol, dialog, shell, session, chokidar, stateOf, windowState: (wcId) => windows.get(wcId) || null });
    transcript.startWatcher(emit, { chokidar });
    teams.startWatcher(emit, { chokidar });
    startWaits();
    setTimeout(() => files.cleanupImages(), 5000); // pasted images older than 7 days (best effort, off the startup path)
    // Suspended children a killed previous run of this userData left behind (procmem's powershell.exe; src/main/orphans.js).
    // The PID is recorded now; the query runs on a worker a few seconds later, off the startup path.
    orphans.record(app.getPath('userData'));
    setTimeout(() => {
      const gapMs = Number(process.env.AGENT_TERMINAL_ORPHAN_SWEEP_GAP_MS) || 15000;
      orphans.sweep({ userData: app.getPath('userData'), gapMs, log: (...a) => console.log(...a) }).catch(() => {});
    }, Number(process.env.AGENT_TERMINAL_ORPHAN_SWEEP_MS) || 8000);
    if (remote) {
      try {
        remote.init({
          ipcMain,
          app,
          listWindows: () => [...windows.entries()].map(([wcId, s]) => ({ wcId, workDir: s.workDir, win: s.win })),
          getSnippets: () => getSnippets() || [],
        });
      } catch (err) {
        console.warn('[main] remote.init failed', err);
      }
    }
  });
  app.on('before-quit', () => {
    quitting = true; // the manager window's close handler stops hiding it
    if (inbox) inbox.saveSync();
  });
  app.on('will-quit', () => widget.destroy()); // the tray icon goes with the app
  // macOS: the Dock icon clicked while no window shows (the dashboard closed, the project windows hidden) -> the dashboard
  app.on('activate', () => {
    if (quitting || !app.isReady()) return;
    const shown = [...windows.values()].some((s) => !s.hidden && !s.win.isDestroyed() && s.win.isVisible());
    if (!shown && !choosingFolder) openStart();
  });
  // keep-awake (blocker, request, lid) is ended in the will-quit handler above, which waits for the lid's powercfg
  app.on('window-all-closed', () => app.quit());
}
