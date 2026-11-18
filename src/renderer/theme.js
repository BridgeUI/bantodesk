'use strict';
// UX17 (docs/ux-journey.md §5.6): the ground — 暗い / 明るい / OS に合わせる (default). Loaded in <head> before the body is
// drawn, so the first paint already has the right colours. tokens.css has the dark values on :root and the light ones on
// :root[data-theme="light"]; this sets data-theme to 'dark' or 'light' (OS: from prefers-color-scheme, and follows it).
// The choice is localStorage 'theme' ('os' | 'dark' | 'light'); every window has the same storage, so a change in one
// window reaches the others through the 'storage' event (no IPC).
// window.Theme: get() -> 'os'|'dark'|'light', set(v), resolved() -> 'dark'|'light', onChange(fn)
// UX18: the choice is also copied to main (app-settings.json theme, api.setAppSettings) so a new window opens with the
// right first ground (BrowserWindow backgroundColor). Copied when set, and once at load when main's copy is older
// (localStorage 'themeSent' = the value last copied).
(() => {
  const KEY = 'theme';
  const VALUES = ['os', 'dark', 'light'];
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  const fns = [];
  const read = () => {
    let v = null;
    try { v = localStorage.getItem(KEY); } catch {}
    return VALUES.includes(v) ? v : 'os';
  };
  const resolve = (v) => (v === 'os' ? (mq && mq.matches ? 'light' : 'dark') : v);
  function apply() {
    const r = resolve(read());
    if (document.documentElement.dataset.theme !== r) document.documentElement.dataset.theme = r;
    for (const fn of fns) { try { fn(r); } catch {} }
  }
  apply();
  if (mq) {
    const on = () => { if (read() === 'os') apply(); };
    if (mq.addEventListener) mq.addEventListener('change', on); else if (mq.addListener) mq.addListener(on);
  }
  window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) apply(); });
  const mirror = (v) => {
    try {
      if (!window.api || typeof window.api.setAppSettings !== 'function') return;
      if (localStorage.getItem('themeSent') === v) return;
      Promise.resolve(window.api.setAppSettings({ theme: v })).then((r) => { if (r && !r.error) { try { localStorage.setItem('themeSent', v); } catch {} } }).catch(() => {});
    } catch {}
  };
  mirror(read());
  // UX18: the app's zoom (main, app-settings.json zoom) as --zoom on <html>, for the few lengths that are screen pixels,
  // not page pixels: the space beside the macOS traffic lights (style.css #topbar) stays 78 screen px at every zoom.
  const setZoom = (z) => { const n = Number(z); if (n > 0) document.documentElement.style.setProperty('--zoom', String(n)); };
  try {
    if (window.api && typeof window.api.appSettings === 'function') Promise.resolve(window.api.appSettings()).then((st) => st && setZoom(st.zoom)).catch(() => {});
    if (window.api && typeof window.api.onZoomChanged === 'function') window.api.onZoomChanged(setZoom);
  } catch {}
  window.Theme = {
    get: read,
    set(v) {
      if (!VALUES.includes(v)) return;
      try { localStorage.setItem(KEY, v); } catch {}
      apply();
      mirror(v);
    },
    resolved: () => resolve(read()),
    onChange(fn) { if (typeof fn === 'function') fns.push(fn); },
  };
})();
