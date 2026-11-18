// 内蔵ブラウザ (docs/plan-browser.md): the top bar and the place of the pane. The page itself is a WebContentsView that main
// (src/main/browserview.js) lays over `.br-body`; this file measures the body and tells main (browser:place), and shows the
// state main reports (url / title / loading / back / forward). The shell (open / close / layout / seen) is external-view.js.
(() => {
  const api = window.api;
  if (!api || !window.ExternalView) return;
  const instances = new Map(); // panel id -> { state(s), newtab }
  api.onBrowserState?.((s) => s && instances.get(s.id)?.state(s));
  api.onBrowserNewTab?.((s) => s && window.dispatchEvent(new CustomEvent('bantodesk:browser-newtab', { detail: s })));

  let unloading = false;
  window.addEventListener('beforeunload', () => { unloading = true; });
  const KEY = (id) => `browserUrl:${id}`;
  const lsGet = (k) => {
    try {
      return sessionStorage.getItem(k) || '';
    } catch {
      return '';
    }
  };
  const lsSet = (k, v) => {
    try {
      v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k);
    } catch {}
  };

  function create({ id, params, shell }) {
    const { h } = shell;
    const bar = shell.bar();
    const el = h('div', 'ev-view');
    const body = h('div', 'br-body');
    const hint = h('div', 'br-hint', 'アドレスを入れてください（例: localhost:3000）');
    body.append(hint);
    el.append(bar.el, body);

    const back = bar.button('←', '戻る', () => nav('back'));
    const fwd = bar.button('→', '進む', () => nav('forward'));
    const reload = bar.button('↻', '読み直す（読み込み中は止める）', () => nav(loading ? 'stop' : 'reload'));
    const input = h('input', 'br-address');
    input.type = 'text';
    input.placeholder = 'アドレス（例: localhost:3000）';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'アドレス');
    const pinBtn = bar.button('コメント', 'ページの上に場所を指定してコメントを書き、入力欄に渡す', () => pin());
    const shotBtn = bar.button('スクショを渡す', '今の画面を保存して、入力欄にパスを差し込む', () => shot());
    bar.left.append(back, fwd, reload);
    bar.left.style.flex = '1 1 auto';
    bar.left.append(input);
    bar.right.append(pinBtn, shotBtn);
    back.disabled = fwd.disabled = true;
    shotBtn.disabled = true;
    pinBtn.disabled = true;
    let pinning = null;

    let attached = false; // main has the view
    let attaching = null;
    let seen = false;
    let disposed = false;
    let loading = false;
    let url = (params && params.url) || lsGet(KEY(id));
    let ro = null;
    let raf = 0;
    let lastKey = '';

    function ensure() {
      if (attached || disposed) return Promise.resolve();
      if (!attaching) {
        attaching = api.browserAttach({ id, url }).catch(() => null).then((r) => {
          attaching = null;
          if (disposed) return api.browserDetach({ id });
          if (!r || !r.ok) return bar.setStatus('開けませんでした');
          attached = true;
          lastKey = '';
          if (url) hint.hidden = true;
        });
      }
      return attaching;
    }
    function place() {
      raf = 0;
      if (disposed || !attached) return;
      const r = body.getBoundingClientRect();
      const rect = { x: r.left, y: r.top, w: r.width, h: r.height };
      const key = `${seen}|${rect.x}|${rect.y}|${rect.w}|${rect.h}`;
      if (key === lastKey) return;
      lastKey = key;
      api.browserPlace({ id, visible: seen, rect });
    }
    const schedule = () => { if (!raf && !disposed) raf = requestAnimationFrame(place); };
    function nav(action, u) {
      return api.browserNav({ id, action, url: u }).catch(() => null);
    }
    async function go(text) {
      await ensure();
      const r = await nav('go', text);
      if (!r || !r.ok) return bar.setStatus('開けないアドレスです（http と https だけ開けます）');
      url = r.url;
      lsSet(KEY(id), url);
      hint.hidden = true;
      bar.setStatus('');
      schedule();
    }
    async function shot() {
      const r = await api.browserSave({ id }).catch(() => null);
      if (!r || !r.ok) return bar.setStatus(r?.reason === 'nofolder' ? '作業フォルダがありません' : '渡せませんでした');
      const ok = shell.handPath(r.path);
      bar.setStatus(ok ? 'パスを入力欄に入れました' : `保存しました: ${r.path}`);
    }
    // 15: take a picture of the page, then lay the pin layer (a DOM layer: the native view is taken off while it is open)
    async function pin() {
      if (pinning || !window.PinComment) return;
      const r = await api.browserSnap({ id }).catch(() => null);
      if (!r || !r.ok) return bar.setStatus('ページの画像を取れませんでした');
      pinning = window.PinComment.open({
        host: body, dataUrl: r.dataUrl, source: { kind: 'web', url: r.url || url, title: r.title || '' },
        onSend: (text, files) => shell.handText(text, files),
        onClose: () => { pinning = null; schedule(); },
      });
      bar.setStatus('場所を指定してコメントを書いてください');
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        e.preventDefault();
        go(input.value);
      }
    });

    instances.set(id, {
      state: (s) => {
        loading = !!s.loading;
        back.disabled = !s.canBack;
        fwd.disabled = !s.canForward;
        reload.textContent = loading ? '✕' : '↻';
        shotBtn.disabled = !s.url;
        pinBtn.disabled = !s.url;
        if (s.url && document.activeElement !== input) input.value = s.url;
        if (s.url && s.url !== url) {
          url = s.url;
          lsSet(KEY(id), url);
        }
        body.dataset.url = s.url || '';
        body.dataset.title = s.title || '';
        bar.setStatus(s.error ? `読み込めませんでした: ${s.error}` : loading ? '読み込み中…' : s.title || '');
      },
    });
    if (url) input.value = url;

    ro = new ResizeObserver(schedule);
    ro.observe(body);
    window.addEventListener('resize', schedule);
    // the body may move without changing its size (a neighbour changes): look again while it is on the window
    const poll = setInterval(() => { if (seen && attached) schedule(); }, 400);

    return {
      el,
      setVisible: (v) => {
        seen = !!v;
        if (seen) {
          if (url || attached) ensure().then(schedule);
          else setTimeout(() => !disposed && seen && input.focus(), 50);
        }
        schedule();
      },
      dispose: () => {
        disposed = true;
        instances.delete(id);
        window.removeEventListener('resize', schedule);
        clearInterval(poll);
        try { ro.disconnect(); } catch {}
        if (raf) cancelAnimationFrame(raf);
        if (!unloading) lsSet(KEY(id), ''); // closed by the user (not the window going away): forget its address
        if (pinning) pinning.close();
        api.browserDetach({ id });
      },
      focusAddress: () => input.focus(),
      _state: () => ({ attached, seen, url }),
    };
  }

  window.ExternalView.register('browser', create, 'ブラウザ', { coverable: true });
  window.BrowserView = { create };
})();
