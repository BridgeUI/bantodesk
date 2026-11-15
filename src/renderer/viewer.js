// 5b viewer: shows a local file (MD / image / HTML / PDF / xlsx as a table) inside a dockview panel.
// The xlsx table lives in viewer-xlsx.js (window.ViewerXlsx).
// Drawing only. renderer.js owns the panel, main owns reading / watching / the atview: protocol.
// Security notes (docs/plan-viewer.md section 4):
// - MD goes through a private marked instance + DOMPurify; images become data: URLs read by main.
// - HTML runs in <iframe sandbox="allow-scripts"> only (opaque origin, no window.api, no navigation).
// - The app window must never navigate: every link click inside an MD is intercepted.
(() => {
  const EXTS = {
    md: ['md', 'markdown'],
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'],
    html: ['html', 'htm'],
    pdf: ['pdf'],
    xlsx: ['xlsx', 'xlsm'],
  };
  const EXT_KIND = new Map();
  for (const [kind, list] of Object.entries(EXTS)) for (const e of list) EXT_KIND.set(e, kind);

  const kindOf = (p) => {
    const m = /\.([^.\\/]+)$/.exec(String(p || ''));
    return (m && EXT_KIND.get(m[1].toLowerCase())) || null;
  };
  const canOpen = (p) => kindOf(p) !== null;

  // Separate instance: the conversation view configures the global marked differently (escapes raw HTML).
  let mdParser = null;
  const parser = () => (mdParser ||= new window.marked.Marked({ gfm: true }));

  const PURIFY = {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed',
      'video', 'audio', 'source', 'picture', 'track', 'svg', 'math', 'link', 'meta', 'base', 'area', 'map'],
    FORBID_ATTR: ['style', 'srcset', 'poster', 'background', 'ping'],
    ALLOW_DATA_ATTR: false,
  };
  // Own DOMPurify instance (the conversation view's global one stays untouched). Nothing in an MD may make the page
  // fetch by itself: the app page is file:, so a scheme-less `//host/x` would resolve to file://host (SMB, NTLM).
  // Only a[href] (clicks are intercepted) and img[src] survive; img src is parked in data-vw-src and resolved by main.
  let purifier = null;
  const URL_ATTRS = new Set(['src', 'href', 'xlink:href', 'action', 'formaction', 'data', 'cite', 'longdesc', 'manifest', 'icon', 'dynsrc', 'lowsrc']);
  const purify = () => {
    if (purifier) return purifier;
    purifier = window.DOMPurify(window);
    purifier.addHook('afterSanitizeAttributes', (node) => {
      if (!node.getAttributeNames) return;
      for (const a of node.getAttributeNames()) {
        const n = a.toLowerCase();
        // the app's own classes could dress MD content up as app UI; keep only marked's code language hint
        if (n === 'class') {
          if (!(node.nodeName === 'CODE' && /^language-[\w+#-]{1,40}$/.test(node.getAttribute(a)))) node.removeAttribute(a);
          continue;
        }
        if (!URL_ATTRS.has(n)) continue;
        if (node.nodeName === 'A' && n === 'href') continue;
        const v = node.getAttribute(a);
        node.removeAttribute(a);
        if (node.nodeName === 'IMG' && n === 'src' && v) node.setAttribute('data-vw-src', v);
      }
    });
    return purifier;
  };

  const h = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const btn = (label, cls, onClick) => {
    const b = h('button', cls ? `vw-btn ${cls}` : 'vw-btn', label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };
  const hms = (d = new Date()) => d.toTimeString().slice(0, 8);

  // ---- path helpers (UX2: Windows and macOS, src/renderer/paths.js) ----
  const { normalize, resolveLocal } = window.AtPath;
  const safeDecode = (s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  };
  // GitHub-like slug (simple): lowercase, drop punctuation, spaces -> '-'.
  const slug = (t) => String(t).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

  function create(info, opts = {}) {
    const api = window.api;
    const kind = info.kind || kindOf(info.path);
    const cleanups = [];
    const on = (target, ev, fn, o) => {
      target.addEventListener(ev, fn, o);
      cleanups.push(() => target.removeEventListener(ev, fn, o));
    };

    let disposed = false;
    let visible = true;
    let stale = false;
    let gone = false;
    let loadedOnce = false;
    let busy = null; // running reload promise
    let again = false; // another reload requested while busy
    let freshTimer = 0;

    // ---- header ----
    const el = h('div', `vw-host vw-kind-${kind || 'unknown'}`);
    const head = h('div', 'vw-head');
    const name = h('span', 'vw-name', info.name || String(info.path).split(/[\\/]/).pop());
    name.title = info.path;
    const status = h('span', 'vw-status', '');
    const tools = h('span', 'vw-tools');
    const reloadBtn = btn('再読み込み', 'vw-reload', () => reload());
    const extBtn = btn('既定のアプリで開く', 'vw-ext', () => api.viewerOpenExternal({ id: info.id }));
    const dirBtn = btn('フォルダを開く', 'vw-dir', () => api.viewerShowInFolder({ id: info.id }));
    head.append(name, status, tools, reloadBtn, extBtn, dirBtn);
    const body = h('div', 'vw-body');
    el.append(head, body);

    const setStatus = (auto) => {
      if (gone) return;
      status.textContent = `最終読み込み ${hms()}`;
      status.classList.remove('vw-gone-msg');
      clearTimeout(freshTimer);
      status.classList.toggle('vw-fresh', !!auto);
      if (auto) freshTimer = setTimeout(() => status.classList.remove('vw-fresh'), 2500);
    };
    const showMsg = (text) => {
      body.classList.remove('vw-dim');
      body.replaceChildren(h('div', 'vw-msg', text));
    };
    const failMsg = (reason) => `読み込めませんでした（${reason || '不明なエラー'}）`;

    // ---- per kind renderers: each returns { load(auto), dispose?() } ----
    const xlsxRenderer = () => window.ViewerXlsx.create({
      api, info, body, tools, h, btn, on, cleanups, showMsg, failMsg, isDisposed: () => disposed,
    });
    const renderers = { md: mdRenderer, image: imageRenderer, html: htmlRenderer, pdf: pdfRenderer, xlsx: window.ViewerXlsx ? xlsxRenderer : null };
    const r = renderers[kind] ? renderers[kind]() : { load: async () => showMsg(failMsg('この形式は表示できません')) };

    function mdRenderer() {
      let ratio = 0;
      const box = h('div', 'vw-md');

      const scrollTo = (anchor) => {
        const want = slug(safeDecode(anchor));
        const t = [...box.querySelectorAll('[data-vw-anchor]')].find((n) => n.dataset.vwAnchor === want || n.dataset.vwAnchor === anchor);
        if (t) t.scrollIntoView({ block: 'start' });
      };

      on(box, 'click', (e) => {
        const a = e.target.closest && e.target.closest('a, area');
        if (!a || !box.contains(a)) return;
        e.preventDefault();
        const href = a.getAttribute('href') || '';
        if (!href) return;
        if (href.startsWith('#')) { scrollTo(href.slice(1)); return; }
        if (/^(https?|mailto):/i.test(href)) { api.openExternal(href); return; }
        const abs = resolveLocal(info.path, href);
        if (!abs || !kindOf(abs)) return;
        if (abs.toLowerCase() === normalize(info.path).toLowerCase()) {
          const frag = /#(.+)$/.exec(href);
          if (frag) scrollTo(frag[1]);
          return;
        }
        if (opts.onOpenPath) opts.onOpenPath(abs);
      });
      // Middle click / auxclick could otherwise open a new window.
      on(box, 'auxclick', (e) => { if (e.target.closest && e.target.closest('a')) e.preventDefault(); });

      const build = async (text) => {
        const html = purify().sanitize(parser().parse(String(text || ''), { async: false }), PURIFY);
        const frag = h('div', 'vw-md-inner');
        frag.innerHTML = html;
        // Ids from the document would land in the app's global id space: move them to data attributes.
        for (const n of frag.querySelectorAll('[id], a[name]')) {
          const v = n.getAttribute('id') || n.getAttribute('name');
          n.removeAttribute('id');
          n.removeAttribute('name');
          if (v) n.dataset.vwAnchor = v;
        }
        const used = new Map();
        for (const hd of frag.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
          if (hd.dataset.vwAnchor) continue;
          const base = slug(hd.textContent) || 'section';
          const n = used.get(base) || 0;
          used.set(base, n + 1);
          hd.dataset.vwAnchor = n ? `${base}-${n}` : base;
        }
        for (const code of frag.querySelectorAll('pre code')) {
          try {
            if (window.hljs && code.textContent.length < 200000) window.hljs.highlightElement(code);
          } catch { /* plain text is fine */ }
        }
        await Promise.all([...frag.querySelectorAll('img')].map(async (img) => {
          const src = img.getAttribute('data-vw-src') || '';
          img.removeAttribute('data-vw-src');
          const replace = (text) => img.replaceWith(h('span', 'vw-muted', text));
          if (!src) { replace('読めない画像: （src なし）'); return; }
          if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^file:/i.test(src) && !/^[A-Za-z]:[\\/]/.test(src)) {
            replace(`外部の画像（表示しません）: ${src}`);
            return;
          }
          let url = null;
          try { url = await api.viewerAsset({ id: info.id, src }); } catch { url = null; }
          if (typeof url === 'string' && /^data:/i.test(url)) img.src = url;
          else replace(`読めない画像: ${src}`);
        }));
        return frag;
      };

      return {
        async load() {
          if (body.contains(box) && body.scrollHeight > body.clientHeight) {
            ratio = body.scrollTop / (body.scrollHeight - body.clientHeight);
          }
          let res;
          try { res = await api.viewerRead({ id: info.id }); } catch (err) { res = { ok: false, reason: String(err && err.message || err) }; }
          if (disposed) return false;
          if (!res || !res.ok) { showMsg(failMsg(res && res.reason)); return false; }
          const inner = await build(res.text);
          if (disposed) return false;
          box.replaceChildren(inner);
          body.classList.remove('vw-dim');
          if (!body.contains(box)) body.replaceChildren(box);
          if (ratio) body.scrollTop = ratio * (body.scrollHeight - body.clientHeight);
          return true;
        },
      };
    }

    function imageRenderer() {
      let zoom = 'fit'; // 'fit' or a scale (1 = 100%)
      const wrap = h('div', 'vw-img');
      const img = h('img');
      img.alt = info.name || '';
      img.draggable = false;
      wrap.append(img);
      const fitBtn = btn('全体', 'vw-fit', () => setZoom('fit'));
      const oneBtn = btn('100%', 'vw-one', () => setZoom(1));
      const pct = h('span', 'vw-pct', '');
      tools.append(pct, fitBtn, oneBtn);

      const apply = () => {
        const fit = zoom === 'fit';
        wrap.classList.toggle('vw-fitmode', fit);
        fitBtn.setAttribute('aria-pressed', String(fit));
        oneBtn.setAttribute('aria-pressed', String(zoom === 1));
        if (fit) {
          img.style.width = '';
          img.style.height = '';
          pct.textContent = img.naturalWidth ? `${Math.round((img.clientWidth / img.naturalWidth) * 100)}%` : '';
        } else {
          img.style.width = `${Math.max(1, Math.round(img.naturalWidth * zoom))}px`;
          img.style.height = 'auto';
          pct.textContent = `${Math.round(zoom * 100)}%`;
        }
      };
      const setZoom = (z) => {
        zoom = z === 'fit' ? 'fit' : Math.min(32, Math.max(0.02, z));
        apply();
      };
      on(img, 'click', () => setZoom(zoom === 'fit' ? 1 : 'fit'));
      on(body, 'wheel', (e) => {
        if (!(e.ctrlKey || e.metaKey) || !img.naturalWidth) return; // Ctrl+wheel, a Mac pinch (ctrlKey) or ⌘+wheel
        e.preventDefault();
        const cur = zoom === 'fit' ? img.clientWidth / img.naturalWidth : zoom;
        setZoom(cur * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      }, { passive: false });
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(() => { if (zoom === 'fit') apply(); });
        ro.observe(body);
        cleanups.push(() => ro.disconnect());
      }

      return {
        load() {
          return new Promise((resolve) => {
            const done = (ok) => {
              img.onload = img.onerror = null;
              if (disposed) { resolve(false); return; }
              if (!ok) { showMsg(failMsg('画像を開けません')); resolve(false); return; }
              body.classList.remove('vw-dim');
              if (!body.contains(wrap)) body.replaceChildren(wrap);
              apply();
              resolve(true);
            };
            img.onload = () => done(true);
            img.onerror = () => done(false);
            if (!body.contains(wrap)) body.replaceChildren(wrap);
            img.src = loadedOnce ? `${info.url}${info.url.includes('?') ? '&' : '?'}t=${Date.now()}` : info.url;
          });
        },
      };
    }

    function htmlRenderer() {
      let url = info.url;
      let offline = !!info.offline;
      const frame = h('iframe', 'vw-frame');
      frame.setAttribute('sandbox', 'allow-scripts'); // exactly this: never add same-origin / navigation / popups / forms
      frame.title = info.name || '';
      const offBtn = btn('', 'vw-offline', async () => {
        offBtn.disabled = true;
        try {
          const res = await api.viewerSetOffline({ id: info.id, offline: !offline });
          if (disposed) return;
          if (res && res.ok) {
            offline = !offline;
            if (res.url) url = res.url;
            label();
            frame.src = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
            setStatus(false);
          }
        } finally {
          offBtn.disabled = false;
        }
      });
      const label = () => {
        offBtn.textContent = offline ? '外部の通信: 停止中' : '外部の通信を止める';
        offBtn.setAttribute('aria-pressed', String(offline));
        offBtn.classList.toggle('vw-on', offline);
      };
      label();
      tools.append(offBtn);
      return {
        async load() {
          body.classList.remove('vw-dim');
          if (!body.contains(frame)) body.replaceChildren(frame);
          frame.src = loadedOnce ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}` : url;
          return true;
        },
      };
    }

    function pdfRenderer() {
      const frame = h('iframe', 'vw-frame');
      frame.title = info.name || '';
      let tick = 0;
      cleanups.push(() => clearTimeout(tick));
      return {
        async load() {
          body.classList.remove('vw-dim');
          if (!body.contains(frame)) body.replaceChildren(frame);
          if (!loadedOnce) { frame.src = info.fileUrl; return true; }
          // file: URLs cannot be cache-busted with a query; blank first, then back on the next tick.
          frame.src = 'about:blank';
          clearTimeout(tick);
          tick = setTimeout(() => { if (!disposed) frame.src = info.fileUrl; }, 0);
          return true;
        },
      };
    }

    // ---- reload orchestration ----
    async function reload(auto = false) {
      if (disposed) return;
      if (busy) { again = true; return busy; }
      stale = false;
      busy = (async () => {
        try {
          const ok = await r.load(auto);
          if (ok && !disposed) {
            loadedOnce = true;
            gone = false;
            body.classList.remove('vw-dim');
            setStatus(auto);
          }
        } catch (err) {
          if (!disposed) showMsg(failMsg(String(err && err.message || err)));
        } finally {
          busy = null;
          if (again && !disposed) { again = false; reload(auto); }
        }
      })();
      return busy;
    }

    function changed(isGone) {
      if (disposed) return;
      if (isGone) {
        gone = true;
        clearTimeout(freshTimer);
        status.classList.remove('vw-fresh');
        status.classList.add('vw-gone-msg');
        status.textContent = 'ファイルがありません（戻れば表示し直します）';
        body.classList.add('vw-dim');
        return;
      }
      if (gone) { gone = false; status.classList.remove('vw-gone-msg'); }
      if (visible) reload(true);
      else stale = true;
    }

    function setVisible(v) {
      visible = !!v;
      if (visible && stale && !gone && !disposed) reload(true);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(freshTimer);
      for (const fn of cleanups.splice(0)) {
        try { fn(); } catch { /* ignore */ }
      }
      if (kind === 'html' || kind === 'pdf') {
        const f = body.querySelector('iframe');
        if (f) f.src = 'about:blank';
      }
    }

    reload(false);
    return { el, info, reload: () => reload(false), setVisible, changed, dispose };
  }

  window.Viewer = { EXTS, kindOf, canOpen, create };
})();
