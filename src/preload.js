const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Shared contract between main and renderer. See CONTRACT.md before changing names or payloads.
const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, p) => cb(p));

// UX1: <html data-os="darwin|win32|linux"> before the first paint, for the OS-specific CSS (the top bar's left clear of the
// traffic lights, the thin scrollbars on macOS). style.css; Windows has no rule on it.
try {
  const mark = () => document.documentElement && document.documentElement.setAttribute('data-os', process.platform);
  if (document.documentElement) mark();
  else document.addEventListener('readystatechange', mark, { once: true });
} catch {}
// UX1b: <html data-fullscreen> while the window is in full screen (main sends win:fullscreen on enter / leave on macOS).
// The traffic lights are hidden then, so style.css gives the top bar its plain 14px left padding back.
ipcRenderer.on('win:fullscreen', (_e, on) => {
  try {
    if (on) document.documentElement.setAttribute('data-fullscreen', '');
    else document.documentElement.removeAttribute('data-fullscreen');
  } catch {}
});

contextBridge.exposeInMainWorld('api', {
  // app / picker
  getInfo: () => ipcRenderer.invoke('app:info'), // -> { workDir, dev, isGit, role: 'manager'|'project', hidden }
  openPicker: () => ipcRenderer.send('picker:show'),
  pickerList: () => ipcRenderer.invoke('picker:list'),
  pickerBrowse: () => ipcRenderer.invoke('picker:browse'),
  pickerOpen: (dir) => ipcRenderer.send('picker:open', dir),
  setTitle: (text) => ipcRenderer.send('win:title', text),

  // temp / edit sessions (roadmap 9 / 19, see CONTRACT.md "Temp / edit sessions"); app:info has temp: null | { kind, name?, original? }
  tempOpen: () => ipcRenderer.send('temp:open'), // opens a new temporary-session window
  editPick: () => ipcRenderer.invoke('edit:pick'), // file dialog -> true when an edit window opened
  editOpen: (o) => ipcRenderer.send('edit:open', o), // { path }: a file to edit, or a kept edit session's dir (picker:list kept[])
  editStatus: () => ipcRenderer.invoke('edit:status'), // -> EditStatus | null (edit window only)
  editWriteBack: (o) => ipcRenderer.invoke('edit:writeBack', o), // { force? } -> { ok: true, backup } | { ok: false, reason, error? }
  editWriteBackAsk: () => ipcRenderer.invoke('edit:writeBackAsk'), // write-back, conflicts asked in native dialogs -> { ok, action, … }
  editDiff: () => ipcRenderer.invoke('edit:diff'), // -> { kind: 'text', diff, changed, format?: 'pptx', slides?, counts? } | { kind: 'binary', changed, baseSha, workSha, error? } | null
  editOpenWork: () => ipcRenderer.send('edit:openWork'), // opens the working copy in its default app
  onEditState: on('edit:state'), // EditStatus, when it changes

  // pty
  ptyCreate: (o) => ipcRenderer.send('pty:create', o), // { id, cols, rows, mode: 'new'|'resume', cwd?, worktree?, team?, delegate?, model?, effort? }
  ptyInput: (o) => ipcRenderer.send('pty:input', o),
  ptyResize: (o) => ipcRenderer.send('pty:resize', o),
  ptyClose: (id) => ipcRenderer.send('pty:close', id),
  ptyKids: (id) => ipcRenderer.invoke('pty:kids', id), // -> { root, kids: [{ pid, name, ageS }], count } | { unsupported } | { none } | { error } (AT-200)
  ptyStopTree: (o) => ipcRenderer.invoke('pty:stopTree', o), // { id, why? } -> { before, survivors, left } (claude + descendants stopped, PROGRESS 49)
  sessionTakeOpen: () => ipcRenderer.invoke('session:takeOpen'), // -> tabId[] the dashboard asked this window to reopen (closed 完了 sessions)
  onSessionOpenPending: on('session:openPending'), // () -> call sessionTakeOpen
  ptyRestart: (o) => ipcRenderer.send('pty:restart', o), // { id, cols, rows, cwd?, team?, delegate?, model?, effort? }: kill, then claude --resume <id>
  ptyMem: () => ipcRenderer.invoke('pty:mem'), // -> { [tabId]: { mb, procs } } (private memory of the session's process tree)
  onPtyData: on('pty:data'),
  onMenuCommand: on('menu:command'), // UX4: the macOS menu's 設定… (src/main/appmenu.js) -> 'settings'
  onPtyExit: on('pty:exit'),
  onMcpNotify: on('mcp:notify'), // { tabId, kind: 'done'|'input'|'error', text }: the tab's claude called the app MCP server's notify (PROGRESS 4)
  procLeftovers: (o) => ipcRenderer.invoke('proc:leftovers', o), // { fresh? } -> { at, mode, count, mb, suspended, tasklist, ended, stoppedTotal, stopped } (51c)
  procLeftoversMode: (mode) => ipcRenderer.invoke('proc:leftoversMode', mode), // 'off' | 'ended' | 'all' -> same as procLeftovers()
  onProcLeftovers: on('proc:leftovers'), // same shape, when the count / MB / mode changed
  onPtyMem: on('pty:mem'), // same shape as ptyMem(), pushed about every minute while the window is visible

  // transcript events
  onAssistEvent: on('assist:event'),
  replay: (sessionId) => ipcRenderer.invoke('assist:replay', sessionId), // -> AssistEvent[]
  replayAgent: (o) => ipcRenderer.invoke('assist:replayAgent', o), // { sessionId, agentId } -> conversation events of a subagent / team member

  // sessions
  sessionsSaved: () => ipcRenderer.invoke('sessions:saved'), // -> SavedTab[]
  sessionsSave: (tabs) => ipcRenderer.send('sessions:save', tabs),
  sessionsHistory: () => ipcRenderer.invoke('sessions:history'), // -> HistoryItem[]

  // dock layout per folder (FolderLayout, see CONTRACT.md "Dock layout")
  layoutGet: () => ipcRenderer.invoke('layout:get'), // -> FolderLayout | null (never saved)
  layoutSave: (layout) => ipcRenderer.invoke('layout:save', layout),
  layoutSaveSync: (layout) => ipcRenderer.sendSync('layout:saveSync', layout), // for beforeunload

  // composer drafts + send history per folder (see CONTRACT.md "Composer")
  composerGet: () => ipcRenderer.invoke('composer:get'), // -> { drafts, history }
  composerSave: (o) => ipcRenderer.invoke('composer:save', o), // { drafts, history } -> boolean (async write)
  composerSaveSync: (o) => ipcRenderer.sendSync('composer:saveSync', o), // for beforeunload

  // backlog per folder (see CONTRACT.md IPC "backlog:*")
  backlogGet: () => ipcRenderer.invoke('backlog:get'), // -> { items, auto }
  backlogSave: (o) => ipcRenderer.invoke('backlog:save', o), // { items, auto } -> boolean (async write, newest wins)
  backlogSaveSync: (o) => ipcRenderer.sendSync('backlog:saveSync', o), // for beforeunload -> boolean
  backlogGetFolder: (o) => ipcRenderer.invoke('backlog:getFolder', o), // { folder } -> { items, auto } (read-only, any folder)
  backlogDrop: (o) => ipcRenderer.invoke('backlog:drop', o), // { folder, id } -> { ok, item? , error? } (取り消す: a pending item -> dropped)
  onBacklogChanged: on('backlog:changed'), // { folder, source: 'main'|'window' } (own window: only 'main' = reload)
  // backlog start rules across folders (src/main/sched.js): limit / resources / touches / after
  schedPlan: (o) => ipcRenderer.invoke('sched:plan', o), // { waiting: [{ id, kind, touches, after }], limit?, thresholds? } -> { start: id[], reasons: { [id]: { code, text } } }
  schedState: () => ipcRenderer.invoke('sched:state'), // -> { limit, thresholds, resources, running, waiting }
  schedAlert: (o) => ipcRenderer.invoke('sched:alert', o), // { backlogId, kind: 'stalled'|'deadlock'|'aborted'|'resumed', text, reply? (stalled: the last reply's tail) } -> boolean (told now)
  onSchedChanged: on('sched:changed'), // same shape as schedState() (only when it changed)
  // queue order on the dashboard cards (docs/queue-order.md, src/main/queueorder.js)
  queueOrder: (o) => ipcRenderer.invoke('queue:order', o), // { folders?: string[] } -> { limit, running, free, hold, next, line, folders: [...] } | null
  queueMove: (o) => ipcRenderer.invoke('queue:move', o), // { folder, id, dir: -1|1 } -> { ok, order?, userOrderAt?, error? } (the user's ↑ / ↓, 24 h lock)
  queueAskPmo: (o) => ipcRenderer.invoke('queue:askPmo', o), // { folder, note } -> { ok, item?, unlocked?, error? } (a 依頼 to the PMO; lifts the user's lock)
  teamUnread: (team) => ipcRenderer.invoke('teams:unread', { team }), // -> { unread: number } (-1 = no inboxes / unreadable)
  // what idle sessions wait for (PROGRESS 40, src/main/waits.js; CONTRACT.md "Waits")
  onWaitsState: on('waits:state'), // { [tabId]: Wait | null } for this window's tabs (only when it changed)
  waitTail: (o) => ipcRenderer.invoke('waits:tail', o), // { wcId? (dashboard), tabId, id } -> { file, text, size, mtime } | { error }
  waitSettings: () => ipcRenderer.invoke('waits:settings'), // -> { silentMin, longMin }
  setWaitSettings: (o) => ipcRenderer.invoke('waits:setSettings', o), // { silentMin, longMin } -> same | null (manager window only)
  // 進み具合の確認の間隔 (PM1 段 3, 依頼-189): -> { minutes (0 = off), choices: [[minutes, words]] }; set { minutes } -> same | null
  progressCheckSettings: () => ipcRenderer.invoke('progress:settings'),
  setProgressCheckSettings: (o) => ipcRenderer.invoke('progress:setSettings', o),

  // global inbox + dashboard (roadmap 20, see CONTRACT.md "Inbox / manager")
  inboxGet: () => ipcRenderer.invoke('inbox:get'), // -> { items: InboxItem[] }
  inboxAdd: (o) => ipcRenderer.invoke('inbox:add', o), // { text } -> InboxItem | null
  carryoverImport: (o) => ipcRenderer.invoke('carryover:import', o), // { folder } -> { added, skipped, more, reason } | { error } (AT-carryover, manager window only)
  inboxUpdate: (o) => ipcRenderer.invoke('inbox:update', o), // { id, patch: { text?, status?, folder?, note? } } -> InboxItem | null
  inboxUndo: (o) => ipcRenderer.invoke('inbox:undo', o), // { id } -> InboxItem | null (undo the newest manager change: add / edit / merge / link)
  onInboxChanged: on('inbox:changed'), // { items: InboxItem[] } (debounced, all windows)
  // manager window only (main ignores others): every window's sessions, same shape as WidgetState (CONTRACT.md "Widget / tray")
  dashboardSessions: () => ipcRenderer.invoke('dashboard:sessions'), // -> WidgetState | null
  dashboardSnapshot: (o) => ipcRenderer.invoke('dashboard:snapshot', o), // { calls, sigs } -> { [name]: { sig, value } | { sig, same } | { error } }
  onDashboardSessions: on('dashboard:sessions'), // WidgetState (throttled, only when changed)
  dashboardFocus: (o) => ipcRenderer.send('widget:focus', o), // { wcId, tabId, from? } -> shows + focuses that session (from: UA1 open.from.*)
  dashboardChoose: (o) => ipcRenderer.send('widget:choose', o), // { wcId, tabId, n } -> answers its choice prompt
  // UX5: no screen calls it any more (あなたの番 reads attention:list); kept for the e2e tests (tmp/wait-answer/e2e.mjs,
  // tmp/stable-check/pmo-answer-real.mjs) that read the dialogs' promptKey through it
  dashboardWaiting: () => ipcRenderer.invoke('dashboard:waiting'), // -> { sessions: WaitEntry[] } (manager window only)
  dashboardAnswer: (o) => ipcRenderer.invoke('dashboard:answer', o), // { wcId, tabId, promptKey, choice? | want?: n[], text? } -> { ok } | { error, changed? }
  // 「あなたの番」 (UIUX U3, src/main/attention.js; manager window only): -> { items: AttnItem[], at, notified } | null
  attentionList: () => ipcRenderer.invoke('attention:list'),
  onAttentionChanged: on('attention:changed'), // { items, at, notified } when the list changed
  attentionDismiss: (o) => ipcRenderer.invoke('attention:dismiss', o), // { id } of a nudge item -> boolean (「様子を見る」)
  onDashboardShowWaiting: on('dashboard:showWaiting'), // the tray's 「あなたの番 N 件」 / a あなたの番 notification was clicked: open あなたの番
  onDashboardFocusPmo: on('dashboard:focusPmo'), // 「PMO に相談」 (tray): show the PMO and focus its input box
  onDashboardNewSession: on('dashboard:newSession'), // U5: the tray's 「新しいセッション…」 -> open the 新しいセッション panel
  dashboardNewWork: (o) => ipcRenderer.invoke('dashboard:newWork', { name: String((o && o.name) || '') }), // U5 「新しい作業」: { name } -> { ok, folder } | { error } (manager window only)
  dashboardOpenSession: (o) => ipcRenderer.send('dashboard:openSession', o), // { folder, tabId } -> opens the folder's window and that (closed) session in it
  dashboardRestart: (o) => ipcRenderer.send('dashboard:restart', o), // { wcId, tabId } -> claude --resume in that tab (refused while busy)
  dashboardRest: (o) => ipcRenderer.send('dashboard:rest', o), // { wcId, tabId } -> 休止: stop that tab's claude (refused while it works, 31)
  dashboardOpen: (o) => ipcRenderer.send('dashboard:open', o && typeof o === 'object' ? { inbox: o.inbox === true, folder: String(o.folder || ''), tab: typeof o.tab === 'string' ? o.tab : '' } : undefined), // show + focus the manager window; { inbox: true, folder } also puts the caret in its request box (AT-139)
  onDashboardShowTab: on('dashboard:showTab'), // { tab: 'turn'|'proj'|'req'|'log' } (U4: Ctrl+Shift+E in a project window -> 'log')
  onDashboardFocusInbox: on('dashboard:focusInbox'), // { folder } -> the request box gets the caret (and 「@<folder> 」 when empty)
  dashboardProjects: () => ipcRenderer.invoke('dashboard:projects'), // -> Project[] (same as manager/projects.json)
  dashboardWorkRoot: () => ipcRenderer.invoke('dashboard:workRoot'), // -> string (folder for create actions) | null
  dashboardChooseWorkRoot: () => ipcRenderer.invoke('dashboard:chooseWorkRoot'), // folder dialog -> new path | null (cancelled)
  // AT-6: default model / effort of the claude starts (read: every window; set: the manager window only)
  modelsGet: () => ipcRenderer.invoke('models:get'), // -> { session: { model, effort }, pmo: { model, effort }, efforts, builtin } | null
  modelsSet: (o) => ipcRenderer.invoke('models:set', o), // { claudeModel?, claudeEffort?, pmoModel?, pmoEffort? } -> view | { error }
  // pre-answered QA per queued task (see CONTRACT.md "Inbox / manager")
  qaList: () => ipcRenderer.invoke('qa:list'), // -> { entries: [{ key, folder, itemId, inboxId, rows, status, … }] } | null (manager window only)
  qaAnswer: (o) => ipcRenderer.invoke('qa:answer', o), // { key, answers: string[] } -> entry | null (manager window only)
  qaForItem: (o) => ipcRenderer.invoke('qa:forItem', o), // { itemId, use? } -> entry | null (own folder's backlog item)
  onQaChanged: on('qa:changed'), // { entries } (manager windows)
  dashboardStale: () => ipcRenderer.invoke('dashboard:stale'), // -> [{ kind:'inbox'|'backlog', id, status, folder, since, age }] (manager window only)
  dashboardProgress: (o) => ipcRenderer.invoke('dashboard:progress', o), // { folder } -> { rows, counts, done, total, mtime } | null (PROGRESS.md; manager window only)
  // 「PMO から」 notices (see CONTRACT.md "Inbox / manager"; manager window only)
  noticesList: () => ipcRenderer.invoke('notices:list'), // -> { notices: Notice[] } (live, newest first) | null
  noticesAnswer: (o) => ipcRenderer.invoke('notices:answer', o), // { id, choice: 'go'|'reject', comment? } -> Notice | null (proposals)
  onNoticesChanged: on('notices:changed'), // { notices } (debounced)
  // 「PMO の記録」 (UIUX U4, notices.forLog; manager window only): -> { entries: LogEntry[] } (newest first) | null
  pmoLog: () => ipcRenderer.invoke('pmo:log'),
  onPmoLogChanged: on('pmo:log-changed'), // { entries } (debounced) after a pmo-actions.jsonl line or a notice change
  noticesAdd: (o) => ipcRenderer.invoke('notices:add', o), // { title, text?, key? } -> Notice | null (app info, e.g. the PMO's automatic handoff)

  // files / git
  gitDiff: (o) => ipcRenderer.invoke('git:diff', o), // { cwd, file } -> { ok, isGit, diff, untracked, error? }
  openFile: (p) => ipcRenderer.send('shell:openFile', p),
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url), // http(s) only, default browser
  pathForFile: (file) => webUtils.getPathForFile(file),

  // composer
  filesSearch: (o) => ipcRenderer.invoke('files:search', o), // { cwd, query, limit } -> { cwd: dir searched, files: string[] relative to it }
  commandsList: (o) => ipcRenderer.invoke('commands:list', o), // { cwd } -> [{ name, description, source }] custom commands + skills
  imageRead: (p) => ipcRenderer.invoke('image:read', p), // absolute image path -> data: URL | null (png/jpg/gif/webp ≤ 8 MB)
  imageSave: (o) => ipcRenderer.invoke('image:save', o), // { data: Uint8Array, ext } -> { ok, path } | { ok: false, error }

  // viewer panels (roadmap 5b, see CONTRACT.md "Viewer"): main checks every path against the window's readable scope
  viewerOpen: (o) => ipcRenderer.invoke('viewer:open', o), // { path, source } -> ViewerInfo | { ok: false, reason }
  viewerPick: () => ipcRenderer.invoke('viewer:pick'), // file dialog -> ViewerInfo | { ok: false, reason: 'cancelled' }
  viewerRead: (o) => ipcRenderer.invoke('viewer:read', o), // { id } -> { ok, text, mtime } (md only)
  viewerAsset: (o) => ipcRenderer.invoke('viewer:asset', o), // { id, src } -> data: URL | null (images of an md)
  viewerSetOffline: (o) => ipcRenderer.invoke('viewer:setOffline', o), // { id, offline } -> { ok, url, offline }
  viewerClose: (o) => ipcRenderer.send('viewer:close', o), // { id }
  viewerOpenExternal: (o) => ipcRenderer.send('viewer:openExternal', o), // { id } -> default app
  viewerShowInFolder: (o) => ipcRenderer.send('viewer:showInFolder', o), // { id }
  onViewerChanged: on('viewer:changed'), // { id, gone }

  // keep the PC awake while this window has a running session (main aggregates all windows)
  powerBusy: (o) => ipcRenderer.send('power:busy', o),
  // UA1 usage records (docs/usage-analytics.md §2; on this PC only, main keeps only the listed ids / values)
  usage: {
    track: (k, id, w, v, r) => ipcRenderer.send('usage:track', { k, id, w, v, r }),
    get: () => ipcRenderer.invoke('usage:get'), // -> { enabled, autoReport }
    set: (o) => ipcRenderer.invoke('usage:set', o), // { enabled } -> { enabled } | { autoReport } -> { autoReport }
    // UA2: the summary of 7 / 30 / 'all' days (src/main/usage-report.js summarize), the report in the manager folder
    summary: (period) => ipcRenderer.invoke('usage:summary', period),
    exportReport: () => ipcRenderer.invoke('usage:export'), // -> { written, day, files, removed } | { error }
    clear: () => ipcRenderer.invoke('usage:clear'), // -> { cleared, enabled } | { error }
  },
  appSettings: () => ipcRenderer.invoke('appSettings:get'), // PROGRESS 32: { disableGpu, atStart: { disableGpu }, gpu }
  setAppSettings: (o) => ipcRenderer.invoke('appSettings:set', o), // { disableGpu } -> the same view (next start)
  powerState: () => ipcRenderer.invoke('power:state'), // keep-awake status { busy, lid: { state, reason, note }, lidWanted } (docs/keep-awake.md) // { busy, keepAwake, gap, holdMin } of this window (main aggregates all windows)
  // update hold after a release (src/main/autorestart.js): status as in onAppUpdate; action 'now' (今すぐ更新) | 'later' (後で)
  updateState: () => ipcRenderer.invoke('update:state'),
  updateAction: (action) => ipcRenderer.invoke('update:action', { action }), // -> boolean

  // Auto-yes is one setting for all windows (localStorage 'autoYes'): a toggle here is sent to the other windows
  autoYesSet: (on) => ipcRenderer.send('autoYes:set', on === true),
  onAutoYesChanged: on('autoYes:changed'), // { on } (another window toggled it)

  // notifications
  notify: (o) => ipcRenderer.send('notify', o), // { tabId, title, body, kind?: 'done'|'input'|'error', silent?: boolean }
  onNotifyClick: on('notify:click'), // { tabId, kind, from? } (from: UA1 open.from.*, 'notif' / 'project' / 'turn' / …)
  onAppUpdate: on('app:update'), // { state: 'none'|'pending'|'postponed'|'restarting', version, since, deadline, force, resume, busy, blocked } – a new release was copied in (pending = queues hold)

  // prompt snippets (cheat sheet)
  snippetsGet: () => ipcRenderer.invoke('snippets:get'), // -> Snippet[] | null
  snippetsSet: (list) => ipcRenderer.send('snippets:set', list),

  // LAN remote
  remoteState: (payload) => ipcRenderer.send('remote:state', payload), // { tabs: TabState[] }
  onRemoteAction: on('remote:action'), // { tabId, type, value }
  remoteAnswerResult: (r) => ipcRenderer.send('remote:answerResult', r), // { reqId, ok, error?, changed? } (dashboard:answer)
  remoteGetStatus: () => ipcRenderer.invoke('remote:getStatus'),
  remoteSetEnabled: (on_) => ipcRenderer.invoke('remote:setEnabled', on_),
  remoteRegenToken: () => ipcRenderer.invoke('remote:regenToken'),
  onRemoteStatus: on('remote:status'),
});
