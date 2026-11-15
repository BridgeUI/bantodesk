'use strict';
// Notification store + sound settings (roadmap 3, docs/plan-notify.md). Owner: core.
// Core (renderer.js) decides WHEN something is notified (signals, suppression, sounds); this module keeps the
// list (tab unread state) and the settings. The 通知 panel is gone (UIUX U4): its settings are drawn by
// settings.js (⚙ 設定), the things to answer are in the dashboard's「あなたの番」, the rest in「PMO の記録」.
//
// window.Notify:
//   init({ open(tabId), label(tabId) -> string, onChange() })
//   push({ tabId, kind: 'done'|'input'|'error', title, body }) -> entry
//   list() -> entries (newest first; no read state: UX5)
//   settings() / setSettings(patch)           – localStorage 'notifySettings' (global, like autoYes). Also holds the
//                                               scheduler / rest / update settings (parallelMax, doneStopMin, …)
//                                               and showUpdateBar (the 更新待ち note in the top bar, default off).
//   panel() / render()                        – kept for old callers: an empty element / no-op
(() => {
  const MAX = 200;
  const DEFAULTS = { sound: true, volume: 0.5, style: 'subtle', preventSleep: true, lidNoSleep: true, kinds: { done: true, input: true, error: true }, suppress: 'visible', desktop: true, showUpdateBar: false };
  let hooks = {};
  let items = [];
  let seq = 0;
  let emptyPanel = null;

  function settings() {
    let s = {};
    try {
      s = JSON.parse(localStorage.getItem('notifySettings') || '{}') || {};
    } catch {}
    return { ...DEFAULTS, ...s, kinds: { ...DEFAULTS.kinds, ...(s.kinds || {}) } };
  }
  function setSettings(patch) {
    const next = { ...settings(), ...patch };
    if (patch.kinds) next.kinds = { ...settings().kinds, ...patch.kinds };
    localStorage.setItem('notifySettings', JSON.stringify(next));
  }

  function push({ tabId, kind, title, body }) {
    const e = { id: ++seq, tabId, kind, title: String(title || ''), body: String(body || '').slice(0, 300), ts: Date.now() };
    items.unshift(e);
    if (items.length > MAX) items.length = MAX;
    hooks.onChange?.();
    return e;
  }

  window.Notify = {
    init(o) {
      hooks = o || {};
    },
    push,
    list: () => items.slice(),
    settings,
    setSettings,
    panel: () => (emptyPanel ||= document.createElement('div')),
    render() {},
  };
})();
