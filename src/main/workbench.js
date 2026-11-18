'use strict';
// UX14 (docs/ux-journey.md §5.1 B・§5.7, docs/ux14-check.md): one main window (the home = the manager window). A folder
// window is the back room ("作業台", workbench): it keeps running its sessions (Auto-yes, the done check, the send path,
// the queue) but is shown only when the user asks for what lives there — 作業台で開く, ターミナル, 並べる, the viewer,
// a temp session, a file edit. Opening by the app (start-up with a folder, routing, the restore after a release, a new
// session from ＋) leaves it hidden; closing it only hides it. Without a main window (no manager folder, or the tests'
// AGENT_TERMINAL_NO_MANAGER=1) the folder window is the window, as before UX14.
// Pure decisions (tmp/oneview/unit2.js); main.js applies them. No process, network or native call (EDR: unchanged).

// why a folder window is opened / shown
const REASONS = new Set([
  'launch', // the app started with a folder on its command line
  'restore', // reopened after an automatic restart (a new release)
  'route', // the ルーター routed work / the app queued a review (sched)
  'session', // a new session from the home's ＋ (folder / 新しい作業)
  'folder', // chosen in the OS folder dialog (only when there is no main window)
  'workbench', // 作業台で開く, ターミナル, 並べる, the viewer, a notice clicked in a folder window
  'temp', // 一時セッション
  'edit', // ファイルの編集
]);
const ALWAYS = new Set(['workbench', 'temp', 'edit']);

// o: { main: boolean (a main window can be shown), wasHidden?: boolean (restore: it was hidden before) }
function showOnOpen(reason, o = {}) {
  const r = REASONS.has(reason) ? reason : 'workbench';
  if (ALWAYS.has(r)) return true;
  if (o.main) return false;
  // no main window: as before UX14 (routed work stays hidden, a restore keeps what was hidden)
  if (r === 'route') return false;
  if (r === 'restore') return !o.wasHidden;
  return true;
}

// a folder window's close: hide it (its sessions keep running) unless the app quits, it is a temp / edit window (their
// close keeps or deletes the folder) or there is no main window to come back to
function hideOnClose(o = {}) {
  return !o.quitting && o.role === 'project' && !o.temp && !!o.main;
}

// no visible window left: Windows (and Linux) quits as before (the ルーター stops); macOS stays (the Dock / the menu bar
// opens the main window again, ⌘Q quits)
function quitWhenNoneVisible(platform = process.platform) {
  return platform !== 'darwin';
}

// a main window can be shown: the manager folder exists and the tests did not turn it off
function mainAvailable(o = {}) {
  return !!o.managerDir && o.noManager !== true;
}

module.exports = { REASONS, showOnOpen, hideOnClose, quitWhenNoneVisible, mainAvailable };
