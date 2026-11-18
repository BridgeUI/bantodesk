// 15 場所を指定したコメント (docs/plan-pin-comment.md): the layer shared by the built-in browser, the PDF / image viewer and
// (later) the slides of 18. It works on a SNAPSHOT (a picture of the place, taken by main): the pane shows the picture over
// itself, the user clicks (a pin) or drags (an area), types a short comment, and sends. Nothing is injected into a page.
// PinComment.open({ host, dataUrl, source, pageInput, page (a fixed page / slide number put on every comment), onSend(text, files) -> bool, onClose }) -> { close(), el }
(() => {
  // two corners (px in a w x h picture) -> { x, y, w, h } fractions 0..1; a tiny drag is a point (w = h = 0)
  const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
  function normRect(a, b, w, h, minDrag = 6) {
    if (!(w > 0) || !(h > 0) || !a || !b) return null;
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
    const point = x2 - x1 < minDrag && y2 - y1 < minDrag;
    const r = point
      ? { x: clamp01(a.x / w), y: clamp01(a.y / h), w: 0, h: 0 }
      : { x: clamp01(x1 / w), y: clamp01(y1 / h), w: clamp01((x2 - x1) / w), h: clamp01((y2 - y1) / h) };
    r.w = Math.min(r.w, 1 - r.x);
    r.h = Math.min(r.h, 1 - r.y);
    return r;
  }
  // a rectangle of the picture to cut for a comment: the area itself, or a window around a point (so the pin has context)
  function cropBox(r, iw, ih) {
    if (!r) return { x: 0, y: 0, w: iw, h: ih };
    if (r.w > 0 || r.h > 0) return { x: Math.round(r.x * iw), y: Math.round(r.y * ih), w: Math.max(1, Math.round(r.w * iw)), h: Math.max(1, Math.round(r.h * ih)) };
    const w = Math.round(Math.min(iw, Math.max(200, iw * 0.4))), h = Math.round(Math.min(ih, Math.max(150, ih * 0.3)));
    const x = Math.min(Math.max(0, Math.round(r.x * iw - w / 2)), iw - w), y = Math.min(Math.max(0, Math.round(r.y * ih - h / 2)), ih - h);
    return { x, y, w, h };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { normRect, cropBox };
  if (typeof document === 'undefined') return;

  const h = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };

  function open({ host, dataUrl, source, pageInput = false, page: fixedPage = '', onSend, onClose }) {
    const api = window.api;
    const el = h('div', 'pc-layer');
    const stage = h('div', 'pc-stage');
    const img = h('img', 'pc-img');
    img.draggable = false;
    img.src = dataUrl;
    // the marks live in an overlay laid exactly over the picture (the picture may be letterboxed in the stage: a slide), so a mark's
    // percent is a percent of the PICTURE, the same as the rect that is saved
    const overlay = h('div', 'pc-overlay');
    stage.append(img, overlay);
    const place = () => {
      const s = stage.getBoundingClientRect(), r = img.getBoundingClientRect();
      Object.assign(overlay.style, { left: `${r.left - s.left}px`, top: `${r.top - s.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    img.addEventListener('load', place);
    let ro = null;
    try { ro = new ResizeObserver(place); ro.observe(stage); ro.observe(img); } catch {}
    const panel = h('div', 'pc-panel');
    const title = h('div', 'pc-title', '場所を指定したコメント');
    const help = h('div', 'pc-help', 'クリックでピン、ドラッグで範囲を指定して、コメントを書きます');
    const list = h('ol', 'pc-list');
    const edit = h('div', 'pc-edit');
    edit.hidden = true;
    const ta = h('textarea', 'pc-text');
    ta.rows = 3;
    ta.placeholder = '直してほしいこと（Enter で追加、Shift+Enter で改行、Esc でやめる）';
    const page = h('input', 'pc-page');
    page.type = 'text';
    page.placeholder = 'ページ（任意）';
    page.setAttribute('aria-label', 'ページ');
    page.hidden = !pageInput;
    const addBtn = h('button', 'ev-btn', '追加');
    const wholeBtn = h('button', 'ev-btn', 'ページ全体へのコメント');
    const sendBtn = h('button', 'ev-btn', '送る');
    const quitBtn = h('button', 'ev-btn', 'やめる');
    for (const b of [addBtn, wholeBtn, sendBtn, quitBtn]) b.type = 'button';
    const row1 = h('div', 'pc-row');
    row1.append(page, addBtn);
    edit.append(ta, row1);
    const row2 = h('div', 'pc-row');
    row2.append(wholeBtn, sendBtn, quitBtn);
    const status = h('div', 'pc-status');
    panel.append(title, help, list, edit, row2, status);
    el.append(stage, panel);
    host.append(el);

    const items = []; // { rect, text, page }
    let draft = null; // rect being commented (null = the whole page when whole = true)
    let whole = false;
    let sel = null;
    let drag = null;
    const marks = [];

    const mark = (r, n, pending) => {
      const m = h('div', `pc-mark${r && (r.w > 0 || r.h > 0) ? ' pc-area' : ' pc-pin'}${pending ? ' pc-pending' : ''}`);
      if (r) {
        m.style.left = `${r.x * 100}%`;
        m.style.top = `${r.y * 100}%`;
        if (r.w > 0 || r.h > 0) { m.style.width = `${r.w * 100}%`; m.style.height = `${r.h * 100}%`; }
      }
      m.dataset.n = String(n);
      return m;
    };
    const redraw = () => {
      for (const m of marks.splice(0)) m.remove();
      items.forEach((c, i) => { if (c.rect) { const m = mark(c.rect, i + 1, false); marks.push(m); overlay.append(m); } });
      if (draft && !whole) { const m = mark(draft, items.length + 1, true); marks.push(m); overlay.append(m); }
      list.replaceChildren(...items.map((c, i) => {
        const li = h('li', 'pc-item');
        const t = h('span', 'pc-item-text', `${c.page ? `p.${c.page} ` : ''}${c.rect ? '' : '[全体] '}${c.text}`);
        const del = h('button', 'ev-btn', '消す');
        del.type = 'button';
        del.addEventListener('click', () => { items.splice(i, 1); redraw(); });
        li.append(t, del);
        return li;
      }));
      sendBtn.disabled = !items.length;
      sendBtn.textContent = items.length ? `送る（${items.length} 件）` : '送る';
    };
    const startEdit = (r, isWhole) => {
      draft = r;
      whole = !!isWhole;
      edit.hidden = false;
      redraw();
      ta.focus();
    };
    const commit = () => {
      const text = ta.value.trim();
      if (!text) return;
      items.push({ rect: whole ? null : draft, text, page: pageInput ? page.value.trim() : String(fixedPage || '') });
      ta.value = '';
      draft = null;
      whole = false;
      edit.hidden = true;
      redraw();
    };

    const pt = (e) => {
      const r = img.getBoundingClientRect();
      return { x: Math.min(Math.max(0, e.clientX - r.left), r.width), y: Math.min(Math.max(0, e.clientY - r.top), r.height), w: r.width, h: r.height };
    };
    img.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      drag = pt(e);
      try { img.setPointerCapture(e.pointerId); } catch {}
      sel = h('div', 'pc-mark pc-area pc-pending');
      overlay.append(sel);
    });
    img.addEventListener('pointermove', (e) => {
      if (!drag || !sel) return;
      const p = pt(e);
      const r = normRect(drag, p, p.w, p.h, 0);
      if (!r) return;
      Object.assign(sel.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
    });
    const finish = (e) => {
      if (!drag) return;
      const p = pt(e);
      const r = normRect(drag, p, p.w, p.h);
      drag = null;
      sel && sel.remove();
      sel = null;
      if (r) startEdit(r, false);
    };
    img.addEventListener('pointerup', finish);
    img.addEventListener('pointercancel', () => { drag = null; sel && sel.remove(); sel = null; });

    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); draft = null; whole = false; ta.value = ''; edit.hidden = true; redraw(); }
    });
    addBtn.addEventListener('click', commit);
    wholeBtn.addEventListener('click', () => startEdit(null, true));
    quitBtn.addEventListener('click', () => close());

    // cut the picture for each comment (the area, or a window around a pin) as a PNG data URL
    const loaded = new Promise((res) => (img.complete && img.naturalWidth ? res() : img.addEventListener('load', res, { once: true })));
    async function cropOf(r) {
      await loaded;
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const b = cropBox(r, iw, ih);
      const c = document.createElement('canvas');
      c.width = b.w;
      c.height = b.h;
      c.getContext('2d').drawImage(img, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
      return c.toDataURL('image/png');
    }
    let sending = false;
    sendBtn.addEventListener('click', async () => {
      if (sending) return;
      if (draft || ta.value.trim()) commit();
      if (!items.length) return;
      sending = true;
      sendBtn.disabled = true;
      status.textContent = '送っています…';
      try {
        const comments = [];
        for (const c of items) comments.push({ rect: c.rect, text: c.text, page: c.page, crop: await cropOf(c.rect) });
        const r = await api.commentsSave({ source, comments });
        if (!r || !r.ok) { status.textContent = r?.reason === 'nofolder' ? '作業フォルダがありません' : '保存できませんでした'; return; }
        const ok = onSend ? onSend(r.message, r.cropPaths) : false;
        if (ok) { close(); return; }
        status.textContent = `入力欄に渡せませんでした（保存先: ${r.store}）`;
      } catch {
        status.textContent = '送れませんでした';
      } finally {
        sending = false;
        sendBtn.disabled = !items.length;
      }
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && edit.hidden) close(); });
    el.tabIndex = -1;

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      try { ro && ro.disconnect(); } catch {}
      el.remove();
      onClose && onClose();
    }
    redraw();
    return { close, el, _items: items };
  }

  window.PinComment = { open, normRect, cropBox };
})();
