// UA1 (docs/usage-analytics.md §2): how this window is used, sent to main's src/main/usage.js (api.usage.track), which
// keeps only the ids / values listed in src/main/usage-ids.js, on this PC only. Nothing here reads text, names or paths.
//   - clicks: one click listener on document (capture) counts elements with data-usage="<id>" (data-usage-v: a listed value)
//   - screen time: while the window has the focus, is visible and had input in the last 2 minutes, the seconds go to the
//     view the page names (Usage.setView(() => id)); one view line every 60 s and when the view changes / stops
//   - a session opened (open.from.<from>, v = its state) and closed (close, v = seconds, r = resolved / still / none)
// window.Usage = { track(k, id, v?, r?), key(shortcutId), setView(fn), open(from, state, probe), close(), state() }
(function () {
  'use strict';
  const api = window.api;
  const send = (k, id, w, v, r) => {
    try {
      if (api && api.usage && typeof api.usage.track === 'function') api.usage.track(k, id, w, v, r);
    } catch (_) {}
  };
  const PROBLEM = new Set(['permission', 'question', 'error', 'stuck', 'failed']);
  const TICK_MS = 5000;
  const IDLE_MS = 2 * 60_000;
  const VIEW_EVERY_S = 60;
  const BLUR_CLOSE_MS = 3000; // a short blur (a native dialog, a quick look elsewhere) does not end an open

  // the window kind: the settings modal over anything, else the dashboard (manager window) or a session window
  function win() {
    try {
      if (window.Settings && window.Settings.isOpen && window.Settings.isOpen()) return 'settings';
    } catch (_) {}
    const role = typeof info === 'object' && info ? info.role : null; // renderer.js's global (app:info)
    return role === 'manager' ? 'dash' : 'session';
  }
  const track = (k, id, v, r) => send(k, id, win(), v, r);
  const kebab = (s) => String(s).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

  // ---- clicks ------------------------------------------------------------------------------
  document.addEventListener(
    'click',
    (e) => {
      const el = e.target && e.target.closest ? e.target.closest('[data-usage]') : null;
      if (!el || !el.dataset.usage) return;
      track('click', el.dataset.usage, el.dataset.usageV || undefined);
    },
    true,
  );

  // ---- screen time -------------------------------------------------------------------------
  let lastInput = Date.now();
  const touched = () => {
    lastInput = Date.now();
  };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'mousemove']) window.addEventListener(ev, touched, { capture: true, passive: true });
  let viewOf = () => null;
  let cur = { id: null, ms: 0 };
  let lastTick = Date.now();
  const active = () => {
    try {
      return document.hasFocus() && document.visibilityState === 'visible' && Date.now() - lastInput < IDLE_MS;
    } catch (_) {
      return false;
    }
  };
  function emitView() {
    const s = Math.round(cur.ms / 1000);
    if (cur.id && s >= 1) track('view', cur.id, s);
    cur.ms = 0;
  }
  function tick() {
    const now = Date.now();
    const dt = Math.min(now - lastTick, TICK_MS * 2);
    lastTick = now;
    let id = null;
    if (active()) {
      try {
        id = viewOf() || null;
      } catch (_) {}
    }
    if (id !== cur.id) {
      if (cur.id) cur.ms += dt; // the time up to this switch still belongs to the old view
      emitView();
      cur = { id, ms: 0 };
      return;
    }
    if (!id) return;
    cur.ms += dt;
    if (cur.ms >= VIEW_EVERY_S * 1000) emitView();
  }
  setInterval(tick, TICK_MS);
  window.addEventListener('blur', () => setTimeout(tick, 0));
  document.addEventListener('visibilitychange', () => {
    tick();
    if (document.visibilityState === 'hidden') close();
  });
  window.addEventListener('pagehide', () => {
    tick();
    emitView();
    close();
  });

  // ---- a session opened / closed (§2.3) ------------------------------------------------------
  let opened = null; // { at, state, probe }
  let blurT = 0;
  function open(from, state, probe) {
    if (opened) close();
    track('open', 'open.from.' + from, state);
    opened = { at: Date.now(), state, probe: typeof probe === 'function' ? probe : () => state };
  }
  function close() {
    clearTimeout(blurT);
    if (!opened) return;
    const o = opened;
    opened = null;
    let r = 'none';
    if (PROBLEM.has(o.state)) {
      let now = null;
      try {
        now = o.probe();
      } catch (_) {}
      r = PROBLEM.has(now) ? 'still' : 'resolved';
    }
    track('close', 'close', (Date.now() - o.at) / 1000, r);
  }
  window.addEventListener('blur', () => {
    if (!opened) return;
    clearTimeout(blurT);
    blurT = setTimeout(() => !document.hasFocus() && close(), BLUR_CLOSE_MS);
  });
  window.addEventListener('focus', () => clearTimeout(blurT));

  window.Usage = {
    track,
    key: (shortcutId) => track('key', 'key.' + kebab(shortcutId)),
    setView: (fn) => {
      if (typeof fn === 'function') viewOf = fn;
    },
    open,
    close,
    isOpen: () => !!opened,
    tick, // tests
  };
})();
