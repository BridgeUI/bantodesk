'use strict';
// UA1 (docs/usage-analytics.md §2): the closed lists of what a usage record may hold. src/main/usage.js keeps a line only
// when its kind / id / window / value is in these lists, so no free text (folder or session names, paths, typed text,
// conversation, PID) can reach the records (§2.4). An id is <screen>.<part>.<action>: lower-case letters, digits, '.',
// '-', at most 64 characters (tmp/usage/unit.js checks the form, and that every data-usage in src/renderer is listed).
// No Electron imports (testable from plain Node; the renderer has its own copy of nothing: it sends, main filters).

const KINDS = Object.freeze(['view', 'click', 'key', 'open', 'close', 'auto']);
const WINDOWS = Object.freeze(['dash', 'session', 'workbench', 'viewer', 'settings', 'tray', 'notif']);
// v as text: the state of a session when it was opened (§2.3), the build kind on app.start
const STATES = Object.freeze(['permission', 'question', 'error', 'stuck', 'failed', 'done', 'working', 'idle']);
const PROBLEM_STATES = Object.freeze(['permission', 'question', 'error', 'stuck', 'failed']);
const VALUES = Object.freeze([...STATES, 'stable', 'dev']);
// r: close only — did the problem go away while the session was open
const RESULTS = Object.freeze(['resolved', 'still', 'none']);

// where a session was opened from (§2.3)
const OPEN_FROM = Object.freeze(['turn', 'project', 'request', 'log', 'notif', 'tray', 'tab', 'palette', 'agents', 'nav', 'home']);

// the shortcut ids of src/renderer/labels.js SHORTCUTS (the commands with keys), as key.<kebab-case> (the action, never
// the key pressed). UX16: autoYes is gone (設定 only); its old key.auto-yes stays listed below for older records.
const SHORTCUT_IDS = Object.freeze(['palette', 'newTab', 'closeTab', 'cycleTab', 'layout', 'viewer', 'backlog', 'history', 'tempSession', 'folder', 'pmoLog', 'cheatsheet']);
// UX16: every command of labels.js COMMANDS, as palette.cmd.<kebab-case> (run from the command palette)
const COMMAND_IDS = Object.freeze(['palette', 'newTab', 'closeTab', 'cycleTab', 'layout', 'terminal', 'detail', 'viewer', 'editFile', 'backlog', 'history', 'newSession', 'tempSession', 'folder', 'home', 'pmoLog', 'remote', 'settings', 'cheatsheet']);
const kebab = (s) => String(s).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

const IDS = Object.freeze([
  // the app itself
  'app.start',
  // screen time (k: view, v: seconds)
  'view.dash.turn',
  'view.dash.projects',
  'view.dash.requests',
  'view.dash.log',
  'view.dash.map',
  'view.session.conversation',
  'view.session.terminal',
  'view.session.split',
  'view.settings',
  // dashboard (manager window)
  'dash.tab.turn',
  'dash.tab.projects',
  'dash.tab.requests',
  'dash.tab.log',
  'dash.tab.map',
  'dash.turn.open-session',
  'dash.turn.watch',
  'dash.turn.pmo-resume',
  'dash.turn.answer',
  'dash.turn.answer-send',
  'dash.card.answer',
  'dash.card.open-session',
  'dash.card.open-closed',
  'dash.card.rest',
  'dash.card.restart',
  'dash.card.output',
  'dash.card.ask-order',
  'dash.card.move',
  'dash.card.lean-keep', // TK3
  'dash.settings.code-mode', // 依頼-535
  'dash.card.drop',
  // UX15: the card row's ⋯ (was the バックログ panel): 完了にする / 戻す
  'dash.card.menu',
  'dash.card.done',
  'dash.card.reopen',
  'dash.card.title',
  'dash.inbox.send',
  'dash.notice.go',
  'dash.notice.reject',
  // UX14: the main window's left nav, the breadcrumb, the session view's ターミナル
  'dash.nav.home',
  'dash.nav.folder',
  'dash.nav.session',
  'dash.nav.new',
  'dash.nav.settings',
  'dash.crumb.home',
  'dash.crumb.folder',
  'dash.view.terminal',
  'dash.view.workbench',
  // UX15: 「この作業」 in the main window's view
  'dash.view.restart',
  'dash.view.handoff',
  'dash.view.folder',
  'dash.view.auto',
  'dash.pmo.drawer',
  // HOME-ROLES (docs/ux-journey.md §8): ホームの「いま」, a project's own page, the ルーター pane's head
  'dash.home.session',
  'dash.home.log',
  'dash.home.project',
  'dash.project.open',
  'dash.pmo.hide',
  // a session window
  'session.mode.toggle',
  'session.menu.wait',
  'session.menu.restart',
  'session.menu.rest',
  'session.menu.handoff',
  'session.menu.rename',
  'session.menu.close',
  // UX15: one section 「この作業」 (the six before it stay listed for older records)
  'session.panel.work',
  'session.panel.folder',
  'session.panel.auto',
  'session.panel.overview',
  'session.panel.tasks',
  'session.panel.team',
  'session.panel.agents',
  'session.panel.files',
  'session.panel.tools',
  'session.panel.restart',
  'session.panel.handoff',
  'session.send',
  'session.answer',
  // UA3: the problem band over the conversation (docs/usage-analytics.md §4・§5)
  'session.band.answer',
  'session.band.restart',
  'session.band.handoff',
  'session.band.stop',
  'session.band.back',
  'session.band.close',
  // the top bar
  'topbar.new-tab',
  'topbar.dashboard',
  'topbar.settings',
  'topbar.panel',
  'topbar.more', // UX16: the ⋯ menu is gone; topbar.more.* stay for the records before it
  'topbar.palette',
  'dash.nav.palette',
  'palette.task',
  'palette.request',
  'palette.session',
  'palette.folder',
  'palette.file',
  ...COMMAND_IDS.map((c) => 'palette.cmd.' + kebab(c)),
  'key.auto-yes',
  'topbar.more.session',
  'topbar.more.viewer',
  'topbar.more.queue',
  'topbar.more.cheatsheet',
  'topbar.more.remote',
  'topbar.more.auto-yes',
  'topbar.more.detail',
  'topbar.more.terminal',
  // shortcuts
  ...SHORTCUT_IDS.map((s) => 'key.' + kebab(s)),
  // sessions opened / closed (§2.3)
  ...OPEN_FROM.map((f) => 'open.from.' + f),
  'close',
  // what the app / ルーター did instead of the user
  'auto.answer',
  'auto.handoff',
  'auto.restart',
  'auto.nudge',
  // UPD-MISS: the update hold (src/main/autorestart.js): reserved by the app, 今すぐ更新 / 後で in the dashboard line
  'auto.update-reserve',
  'dash.update.now',
  'dash.update.later',
]);

const ID_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const ID_SET = new Set(IDS);
const has = (list) => {
  const s = new Set(list);
  return (x) => typeof x === 'string' && s.has(x);
};

module.exports = {
  KINDS,
  WINDOWS,
  STATES,
  PROBLEM_STATES,
  VALUES,
  RESULTS,
  OPEN_FROM,
  SHORTCUT_IDS,
  COMMAND_IDS,
  IDS,
  ID_RE,
  isId: (x) => typeof x === 'string' && ID_SET.has(x),
  isKind: has(KINDS),
  isWindow: has(WINDOWS),
  isValue: has(VALUES),
  isResult: has(RESULTS),
  isState: has(STATES),
  isProblem: has(PROBLEM_STATES),
  keyId: (shortcutId) => 'key.' + kebab(shortcutId),
};
