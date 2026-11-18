// 18 プレゼンのブラッシュアップモード 第 1 段 (docs/plan-present.md 「第 1 段の作り」): the 「資料」 pane. A pptx as pictures made by main
// (src/main/present.js): one slide large, a strip of thumbnails below, ←→ to turn the page, and 「コメント」 puts the 15 pin layer
// (pin-comment.js) on the slide being shown (source.kind 'slide', the slide number goes on every comment). When the file is saved main
// sends present:update with the new signatures, and only the slides whose signature changed are fetched again.
// Drawing only; the shell (open / close / layout / seen) is external-view.js.
(() => {
  const api = window.api;
  if (!api || !window.ExternalView) return;
  const instances = new Map(); // panel id -> { update(u) }
  api.onPresentUpdate?.((u) => u && instances.get(u.id)?.update(u));

  const KEY = (id) => `presentPath:${id}`;
  const lsGet = (k) => { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } };
  const lsSet = (k, v) => { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch {} };
  const REASONS = {
    unsupported: 'pptx のファイルを選んでください',
    missing: 'ファイルが見つかりません',
    outside: 'この作業フォルダの外のファイルです（「ファイルを選ぶ」から開いてください）',
    unreadable: 'pptx として読めませんでした',
    timeout: '画像にするのに時間がかかりすぎました',
    norender: '画像にできませんでした',
  };

  function create({ id, params, shell }) {
    const { h } = shell;
    const bar = shell.bar();
    const el = h('div', 'ev-view pr-view');
    el.tabIndex = 0;
    const body = h('div', 'pr-body');
    const stage = h('div', 'pr-stage');
    const big = h('img', 'pr-big');
    big.alt = '';
    big.draggable = false;
    big.hidden = true;
    const over = h('div', 'pr-over');
    stage.append(big, over);
    const strip = h('div', 'pr-strip');
    strip.hidden = true;
    body.append(stage, strip);
    el.append(bar.el, body);

    const pickBtn = bar.button('ファイルを選ぶ', 'pptx を選んで開く', () => pick());
    const prev = bar.button('←', '前のスライド', () => go(cur - 1));
    const next = bar.button('→', '次のスライド', () => go(cur + 1));
    const pos = h('span', 'pr-pos', '');
    const pinBtn = bar.button('コメント', '今のスライドの上に場所を指定してコメントを書き、入力欄に渡す', () => pin());
    bar.left.append(pickBtn, prev, pos, next);
    bar.right.append(pinBtn);
    prev.disabled = next.disabled = pinBtn.disabled = true;

    let file = (params && params.path) || lsGet(KEY(id));
    let info = null; // { name, path, count, sigs }
    let sigs = [];
    let cur = 1;
    let disposed = false;
    let pinning = null;
    const full = new Map(); // `${n}:${sig}` -> data URL (the large picture)
    const thumbs = new Map(); // `${n}:${sig}` -> data URL
    const thumbEls = [];

    const message = (text, btn) => {
      over.replaceChildren();
      if (text) over.append(h('div', '', text));
      if (btn) over.append(btn);
      over.hidden = !text;
    };
    const ready = () => !!info && sigs.length > 0;

    async function imageOf(n, thumb) {
      const sig = sigs[n - 1];
      if (!sig) return '';
      const cache = thumb ? thumbs : full;
      const k = `${n}:${sig}`;
      if (cache.has(k)) return cache.get(k);
      const r = await api.presentImage({ id, n, thumb: !!thumb }).catch(() => null);
      if (!r || !r.ok || !r.dataUrl) return '';
      cache.set(`${n}:${r.sig}`, r.dataUrl);
      return r.dataUrl;
    }
    function dropOld() {
      const live = new Set(sigs.map((s, i) => `${i + 1}:${s}`));
      for (const c of [full, thumbs]) for (const k of [...c.keys()]) if (!live.has(k)) c.delete(k);
    }

    async function showBig() {
      if (!ready()) return;
      const n = cur;
      const url = await imageOf(n, false);
      if (disposed || n !== cur) return;
      if (url) { big.src = url; big.hidden = false; big.dataset.n = String(n); big.dataset.sig = sigs[n - 1]; message(''); }
      else { big.hidden = true; message('このスライドはまだ画像にできていません'); }
    }
    async function fillThumb(i) {
      const t = thumbEls[i - 1];
      if (!t) return;
      const sig = sigs[i - 1];
      if (t.img.dataset.sig === sig && t.img.src) return;
      const url = await imageOf(i, true);
      if (disposed || sigs[i - 1] !== sig) return;
      if (url) { t.img.src = url; t.img.dataset.sig = sig; }
    }
    function buildStrip() {
      strip.replaceChildren();
      thumbEls.length = 0;
      sigs.forEach((_s, i) => {
        const n = i + 1;
        const b = h('button', 'pr-thumb');
        b.type = 'button';
        b.title = `スライド ${n}${info && info.titles && info.titles[i] ? `: ${info.titles[i]}` : ''}`;
        const img = h('img', 'pr-thumb-img');
        img.alt = '';
        img.draggable = false;
        const num = h('span', 'pr-thumb-n', String(n));
        b.append(img, num);
        b.addEventListener('click', () => go(n));
        strip.append(b);
        thumbEls.push({ b, img });
      });
      strip.hidden = !sigs.length;
      thumbEls.forEach((_t, i) => fillThumb(i + 1));
      markCur();
    }
    function markCur() {
      thumbEls.forEach((t, i) => t.b.classList.toggle('pr-cur', i + 1 === cur));
      const t = thumbEls[cur - 1];
      if (t && t.b.scrollIntoView) t.b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      pos.textContent = ready() ? `${cur} / ${sigs.length}` : '';
      prev.disabled = !ready() || cur <= 1;
      next.disabled = !ready() || cur >= sigs.length;
      pinBtn.disabled = !ready() || !!pinning;
    }
    function go(n) {
      if (!ready() || pinning) return;
      const m = Math.min(Math.max(1, n), sigs.length);
      if (m === cur && big.dataset.n === String(m)) return;
      cur = m;
      markCur();
      showBig();
    }

    // the sigs came back (open, or a save of the file): only the slides whose signature differs are drawn again
    function applySigs(newSigs, changed) {
      const old = sigs;
      sigs = newSigs.slice();
      dropOld();
      if (sigs.length !== thumbEls.length) buildStrip();
      else sigs.forEach((s, i) => { if (s !== old[i]) { thumbEls[i].b.classList.add('pr-fresh'); setTimeout(() => thumbEls[i] && thumbEls[i].b.classList.remove('pr-fresh'), 2500); fillThumb(i + 1); } });
      if (cur > sigs.length) cur = Math.max(1, sigs.length);
      markCur();
      if (!big.dataset.sig || big.dataset.n !== String(cur) || big.dataset.sig !== sigs[cur - 1]) showBig();
      const n = (changed || []).length;
      if (n) bar.setStatus(`スライド ${changed.slice(0, 6).join('・')}${n > 6 ? ' ほか' : ''} を更新しました`);
    }

    let retried = false;
    async function open(path) {
      if (!path) { message('pptx を選んでください', pickBtn2()); return; }
      file = path;
      lsSet(KEY(id), path);
      bar.setStatus('画像にしています…');
      message('画像にしています…');
      let r = await api.presentOpen({ id, path }).catch(() => null);
      // right after the window starts its folder may not be known to main yet: one more try
      if (r && r.reason === 'outside' && !retried) { retried = true; await new Promise((z) => setTimeout(z, 1000)); if (!disposed) r = await api.presentOpen({ id, path }).catch(() => null); }
      if (disposed) return;
      if (!r || !r.ok) {
        info = null;
        sigs = [];
        big.hidden = true;
        big.dataset.sig = '';
        buildStrip();
        markCur();
        bar.setStatus('');
        if (r && r.reason === 'notool') message(`この PC では画像化できません（${r.hint || '画像にする道具を入れてください'}）`);
        else message(`${REASONS[r && r.reason] || '開けませんでした'}${r && r.detail ? `（${String(r.detail).slice(0, 120)}）` : ''}`, pickBtn2());
        return;
      }
      info = { name: r.name, path: r.path, titles: r.titles || [] };
      file = r.path;
      lsSet(KEY(id), r.path);
      cur = 1;
      big.dataset.sig = '';
      sigs = [];
      buildStrip();
      applySigs(r.sigs, []);
      bar.setStatus(`${r.name}（${r.count} 枚）`);
    }
    const pickBtn2 = () => { const b = h('button', 'ev-btn', 'ファイルを選ぶ'); b.type = 'button'; b.addEventListener('click', () => pick()); return b; };
    async function pick() {
      const r = await api.presentPick().catch(() => null);
      if (r && r.ok) open(r.path);
    }

    function update(u) {
      if (disposed || !info) return;
      if (u.state === 'rendering') { bar.setStatus('更新を画像にしています…'); return; }
      if (u.state === 'error') { bar.setStatus(`更新できませんでした${u.reason === 'unreadable' ? '（保存の途中かもしれません）' : ''}`); return; }
      if (u.state === 'ready') {
        info.titles = u.titles || info.titles;
        applySigs(u.sigs || [], u.changed || []);
        if (!(u.changed || []).length) bar.setStatus(`${info.name}（${sigs.length} 枚）`);
      }
    }

    async function pin() {
      if (!ready() || pinning || disposed) return;
      const dataUrl = await imageOf(cur, false);
      if (!dataUrl) { bar.setStatus('画像がまだありません'); return; }
      pinning = window.PinComment.open({
        host: stage, dataUrl, page: String(cur), source: { kind: 'slide', path: info.path, title: info.name },
        onSend: (text, files) => (window.ExternalView ? window.ExternalView.handText(text, files) : false),
        onClose: () => { pinning = null; markCur(); el.focus(); },
      });
      markCur();
    }

    el.addEventListener('keydown', (e) => {
      if (pinning || e.target.closest?.('input, textarea, select')) return;
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(cur - 1); }
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(cur + 1); }
      else if (e.key === 'Home') { e.preventDefault(); go(1); }
      else if (e.key === 'End') { e.preventDefault(); go(sigs.length); }
    });
    stage.addEventListener('pointerdown', () => { if (!pinning) el.focus(); });

    instances.set(id, { update });
    if (!window.PinComment) pinBtn.hidden = true;
    open(file);

    return {
      el,
      setVisible() {},
      dispose() {
        disposed = true;
        instances.delete(id);
        try { pinning && pinning.close(); } catch {}
        api.presentClose?.({ id });
        lsSet(KEY(id), '');
      },
      _state: () => ({ cur, sigs: sigs.slice(), pinning: !!pinning }),
    };
  }

  window.ExternalView.register('present', create, '資料');
})();
