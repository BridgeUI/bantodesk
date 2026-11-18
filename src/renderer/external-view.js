// IOS-SIM / 内蔵ブラウザ (docs/plan-ios-sim.md 6.3): the shell of a pane that shows something from outside the page —
// the iOS Simulator now (sim-view.js), the built-in browser next (PROGRESS 6). The drawing differs (a canvas here, a
// native view laid over the pane there); what they share is here:
//   - opening (one pane per kind, a next one on request), closing, and the dockview layout save / restore: a panel of
//     a registered kind is built from its id by createComponent, so it also comes back after a restart
//   - "is it seen?": the panel is the visible tab of its group, the window is not hidden / minimised / locked
//     (document.hidden, <html data-unseen> + 'bantodesk:seen' from win:seen). The view gets setVisible(bool) on every change
//   - the top bar: a place on the left (what to show), buttons on the right
//   - handing a picture to the session: the view saves a file in <folder>/.bantodesk/<kind>/ and gives the path here;
//     handPath() puts it in the active session's input (renderer.js sets the function with setHandPath)
// A view is { el, setVisible(visible), dispose() }; register(kind, factory) with factory({ id, shell }) -> view.
(() => {
  const kinds = new Map(); // kind -> { factory, title }
  const views = new Map(); // panel id -> { kind, view, visible, panelVisible, api }
  let handPath = () => false;
  let handText = () => false;

  const h = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const safe = (fn, fb) => {
    try {
      return fn();
    } catch {
      return fb;
    }
  };

  const windowSeen = () => !document.hidden && !document.documentElement.hasAttribute('data-unseen');

  function applySeen(rec) {
    const v = !!rec.panelVisible && windowSeen() && !(rec.coverable && covered);
    if (rec.visible === v) return;
    rec.visible = v;
    safe(() => rec.view.setVisible(v));
  }
  // A native view (the built-in browser) is drawn above the page's DOM, so it is taken off while an overlay (command palette,
  // settings, a dialog) is open. Views registered with { coverable: true } only.
  let covered = false;
  // .popover = the context menus (tab menu, ...); .dv-tab--dragging = a dockview tab being dragged
  const COVER = '.pal-back:not([hidden]), .st-modal, .modal-backdrop, .pc-layer, .popover, .dv-tab--dragging';
  // a drag (a session tab onto the layout, a dockview tab): the drop zones are DOM, so the view is off until it ends
  let dragging = false;
  const setDragging = (d) => { if (dragging === d) return; dragging = d; checkCover(); };
  const onWindowSeen = () => views.forEach(applySeen);
  let coverTimer = 0;
  const checkCover = () => {
    coverTimer = 0;
    const c = dragging || !!document.querySelector(COVER);
    if (c === covered) return;
    covered = c;
    onWindowSeen();
  };
  safe(() => new MutationObserver(() => { if (!coverTimer) coverTimer = setTimeout(checkCover, 30); })
    .observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] }));
  document.addEventListener('dragstart', () => setDragging(true), true);
  for (const t of ['dragend', 'drop']) document.addEventListener(t, () => setTimeout(() => setDragging(false), 0), true);
  document.addEventListener('visibilitychange', onWindowSeen);
  window.addEventListener('bantodesk:seen', onWindowSeen);

  // the top bar: left = what to show, status in the middle, right = buttons
  function bar() {
    const el = h('div', 'ev-bar');
    const left = h('div', 'ev-left');
    const status = h('span', 'ev-status');
    const right = h('div', 'ev-right');
    el.append(left, status, right);
    const button = (label, title, onClick) => {
      const b = h('button', 'ev-btn', label);
      b.type = 'button';
      if (title) b.title = title;
      b.addEventListener('click', onClick);
      return b;
    };
    return { el, left, right, status, button, setStatus: (t) => (status.textContent = t || '') };
  }

  function register(kind, factory, title, opts = {}) {
    kinds.set(kind, { factory, title: title || kind, coverable: !!opts.coverable });
  }
  const has = (kind) => kinds.has(kind);
  const kindOfId = (id) => /^(.+)-\d+$/.exec(String(id || ''))?.[1] || '';

  // dockview createComponent for a registered kind: built from the id, so a restored layout shows it again
  function component(kind, id) {
    const reg = kinds.get(kind);
    const host = h('div', 'ev-host');
    const rec = { kind, view: null, visible: null, panelVisible: true, api: null, coverable: reg.coverable };
    try {
      rec.view = reg.factory({ id, params: takeParams(id), shell: { bar, h, handPath: (p) => handPath(p), handText: (t, f) => handText(t, f) } });
      host.append(rec.view.el);
    } catch (e) {
      console.error('external view failed', kind, e);
      host.append(h('div', 'ev-msg', '開けませんでした'));
    }
    views.set(id, rec);
    return {
      element: host,
      init: (p) => {
        rec.api = p.api;
        rec.panelVisible = p.api.isVisible !== false;
        applySeen(rec);
        p.api.onDidVisibilityChange((ev) => {
          rec.panelVisible = !!ev.isVisible;
          applySeen(rec);
        });
      },
      dispose: () => {
        views.delete(id);
        safe(() => rec.view && rec.view.dispose());
      },
    };
  }

  // start values for a pane about to be built (a new browser tab's URL): taken once by the factory (params)
  const initParams = new Map();
  const takeParams = (id) => { const p = initParams.get(id) || null; initParams.delete(id); return p; };
  // open (or bring forward) a pane of the kind; position = a dockview position or none
  function open(dock, kind, { title, position, again = false, params } = {}) {
    if (!dock || !kinds.has(kind)) return null;
    const existing = [...views.entries()].filter(([, r]) => r.kind === kind && r.api);
    if (existing.length && !again) {
      safe(() => existing[0][1].api.setActive());
      return existing[0][0];
    }
    let n = 0;
    for (const p of dock.panels || []) {
      const m = /^(.+)-(\d+)$/.exec(p.id);
      if (m && m[1] === kind) n = Math.max(n, Number(m[2]));
    }
    const id = `${kind}-${n + 1}`;
    if (params) initParams.set(id, params);
    dock.addPanel({ id, component: kind, title: title || kinds.get(kind).title, position });
    return id;
  }

  window.ExternalView = {
    register, has, component, open, bar, kindOfId,
    setHandPath: (fn) => (handPath = fn),
    setHandText: (fn) => (handText = fn),
    handText: (t, f) => safe(() => handText(t, f), false),
    handPath: (p) => safe(() => handPath(p), false),
    seen: windowSeen,
    _views: views,
  };
})();
