'use strict';
// UX13 (docs/ux-journey.md §5.1 B, docs/ux13-check.md): the main window (the dashboard) shows a session's conversation
// in place. The session stays in its owner window (the folder window = the workbench: its pty, Auto-yes, the done
// check and the send path are not moved); main relays:
//   - transcript events of the viewed session to the viewer, on 'view:event' (only while it is open)
//   - the owner's screen state (status, choices, spinner) to the viewer, on 'view:screen' (the owner sends it only
//     while it is watched: remote:action 'view-watch')
//   - the viewer's input (text / choice / key, UX15: work = 「この作業」 再起動 / 引き継ぐ / 自動で送る) to the owner
//     (remote:action 'view-input'), whose reply comes back
//     on 'view:inputDone' ('' = sent, else the reason it was not sent)
// Each window gets an event at most once per channel ('assist:event' for the pty owner, 'view:event' for a viewer),
// so opening the same conversation in the workbench as well does not double anything.
// No new process, network or native call (EDR: unchanged).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUT_TYPES = new Set(['text', 'choice', 'key', 'work']);
const KEYS = new Set(['esc', 'tab', 'enter', 'up', 'down', 'shift-tab']);
// UX15: 「この作業」 in the main window's view (the owner does it: renderer.js viewInput kind 'work')
const WORK_OPS = new Set(['restart', 'handoff', 'auto-on', 'auto-off']);

// o: { windows: Map<wcId, state>, send(state, channel, payload), replay(sessionId) -> Promise<evt[]>, timeoutMs? }
function create(o) {
  const { windows, send, replay } = o;
  const timeoutMs = Number(o.timeoutMs) || 8000;
  const pending = new Map(); // reqId -> { resolve, timer, ownerId }
  let seq = 0;

  // the window with the pty; else the window that has the tab (resting: no pty, the owner wakes it to send)
  const hasTab = typeof o.hasTab === 'function' ? o.hasTab : () => false;
  const ownerOf = (sessionId) => {
    for (const s of windows.values()) if (s.ptys && s.ptys.has(sessionId)) return s;
    for (const [id, s] of windows) if (s.role !== 'manager' && hasTab(id, sessionId)) return s;
    return null;
  };
  const hasPtyOrTab = (s, sessionId) => (s.ptys && s.ptys.has(sessionId)) || ownerOf(sessionId) === s;
  const viewersOf = (sessionId) => [...windows.values()].filter((s) => s.view && s.view.sessionId === sessionId);
  const watch = (owner, sessionId, on) => owner && send(owner, 'remote:action', { tabId: sessionId, type: 'view-watch', on: !!on });

  // after a viewer closed / changed: the owner stops relaying its screen when nobody views the session any more
  function unwatchIfUnused(sessionId) {
    if (viewersOf(sessionId).length) return;
    watch(ownerOf(sessionId), sessionId, false);
  }

  // transcript / teams events (main.js emit)
  function emit(evt) {
    if (!evt || typeof evt.sessionId !== 'string') return;
    for (const s of windows.values()) {
      if (s.ptys && s.ptys.has(evt.sessionId)) send(s, 'assist:event', evt);
      if (s.view && s.view.sessionId === evt.sessionId) send(s, 'view:event', evt);
    }
  }

  // viewer: { tabId } -> { ok, sessionId, owned, folder, events } (events = the history, like assist:replay)
  async function open(viewer, a) {
    const sessionId = a && typeof a.tabId === 'string' ? a.tabId : '';
    if (!viewer || !UUID_RE.test(sessionId)) return { ok: false, why: 'bad' };
    const prev = viewer.view && viewer.view.sessionId;
    viewer.view = { sessionId, at: Date.now() };
    if (prev && prev !== sessionId) unwatchIfUnused(prev);
    const owner = ownerOf(sessionId);
    if (owner && owner !== viewer) watch(owner, sessionId, true);
    let events = [];
    try {
      events = (await replay(sessionId)) || [];
    } catch {
      events = [];
    }
    return { ok: true, sessionId, owned: !!owner, ownWindow: owner === viewer, folder: owner ? owner.workDir || '' : '', events };
  }

  function close(viewer) {
    const prev = viewer && viewer.view && viewer.view.sessionId;
    if (!prev) return false;
    viewer.view = null;
    unwatchIfUnused(prev);
    return true;
  }

  // viewer: { tabId, type: 'text'|'choice'|'key', value } -> Promise<'' | reason>
  function input(viewer, a) {
    const sessionId = a && typeof a.tabId === 'string' ? a.tabId : '';
    if (!viewer || !viewer.view || viewer.view.sessionId !== sessionId) return Promise.resolve('この会話は開いていません');
    if (!INPUT_TYPES.has(a.type)) return Promise.resolve('bad');
    let value = a.value;
    if (a.type === 'text') value = String(value ?? '').slice(0, 100000);
    else if (a.type === 'choice') {
      value = String(value ?? '');
      if (!/^\d{1,2}$/.test(value)) return Promise.resolve('bad');
    } else if (a.type === 'work') {
      value = String(value ?? '');
      if (!WORK_OPS.has(value)) return Promise.resolve('bad');
    } else if (!KEYS.has(String(value))) return Promise.resolve('bad');
    const owner = ownerOf(sessionId);
    if (!owner) return Promise.resolve('このセッションは閉じています（作業台で開くと送れます）');
    if (owner !== viewer) watch(owner, sessionId, true); // opened in the workbench after the view: relay its screen too
    const reqId = `v${++seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        resolve('作業台の窓が応答しませんでした');
      }, timeoutMs);
      pending.set(reqId, { resolve, timer, ownerId: owner });
      send(owner, 'remote:action', { tabId: sessionId, type: 'view-input', kind: a.type, value, reqId });
    });
  }

  // owner: { reqId, why }
  function inputDone(owner, a) {
    const p = a && pending.get(a.reqId);
    if (!p || p.ownerId !== owner) return false;
    pending.delete(a.reqId);
    clearTimeout(p.timer);
    p.resolve(typeof a.why === 'string' ? a.why.slice(0, 300) : '');
    return true;
  }

  // owner: { tabId, s } -> each viewer of that session (only from the window that has its pty)
  function screen(owner, a) {
    const sessionId = a && typeof a.tabId === 'string' ? a.tabId : '';
    if (!owner || !hasPtyOrTab(owner, sessionId) || !a.s || typeof a.s !== 'object') return 0;
    const v = viewersOf(sessionId).filter((s) => s !== owner);
    for (const s of v) send(s, 'view:screen', { tabId: sessionId, s: a.s });
    return v.length;
  }

  // a window went away (closed / reloaded): its view ends; a gone owner fails its pending inputs
  function windowGone(state) {
    if (!state) return;
    if (state.view) close(state);
    for (const [id, p] of pending) {
      if (p.ownerId !== state) continue;
      pending.delete(id);
      clearTimeout(p.timer);
      p.resolve('作業台の窓が閉じました');
    }
  }

  return { emit, open, close, input, inputDone, screen, windowGone, ownerOf, viewersOf };
}

module.exports = { create, UUID_RE, WORK_OPS };
