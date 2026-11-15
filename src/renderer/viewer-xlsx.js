// 5b viewer, stage 2: xlsx / xlsm as a table (docs/plan-viewer.md "xlsx の表"). Drawing only: main parses the file
// (src/main/xlsx.js on a worker) and hands it over one sheet at a time through viewerRead({ id, sheet }).
// - Virtual scrolling: an empty scroller gives the scrollbars, the cells are drawn into clipped layers above it
//   (frozen rows / columns stay put). Only the visible cells exist in the DOM, and their nodes are reused.
// - The bar above shows the selected cell's address and its formula (or its raw value).
// - Numbers use the cell's number format (a common subset: 0 # ? . , % literals, sections, [Red]); anything else
//   falls back to General. Fonts, fills, borders and row heights are not shown.
(() => {
  const ROW_H = 22;
  const HDR_H = 22;
  const MAX_COL_PX = 640;
  const SPILL_MAX = 12; // columns a text may run over into empty neighbours

  const colName = (c) => {
    let s = '';
    for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };
  // xlsx width is in "characters" (max digit width of the default font, ~7 px at 11 pt) plus padding
  const colPx = (w) => (w > 0 ? Math.min(MAX_COL_PX, Math.max(12, Math.round(w * 7 + 5))) : 0);

  // ---- number formats --------------------------------------------------------------------------------------------
  const general = (v) => {
    if (!Number.isFinite(v)) return String(v);
    if (Number.isInteger(v) && Math.abs(v) < 1e11) return String(v);
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-9 || a >= 1e11)) return v.toExponential(5).replace(/\.?0+e/, 'e').toUpperCase();
    let s = String(Number(v.toPrecision(10)));
    if (s.length > 11) s = String(Number(v.toPrecision(Math.max(1, 10 - (s.length - 11)))));
    return s;
  };

  const splitSections = (code) => {
    const out = [];
    let cur = '';
    let q = false;
    let br = false;
    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      if (ch === '\\' && !q && i + 1 < code.length) { cur += ch + code[++i]; continue; }
      if (ch === '"' && !br) q = !q;
      else if (ch === '[' && !q) br = true;
      else if (ch === ']' && !q) br = false;
      if (ch === ';' && !q && !br) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  };

  // one section -> { pre, post, minInt, minDec, maxDec, dot, group, pct, scale, digits, red } or null (unsupported)
  const compileSection = (sec) => {
    const o = { pre: '', post: '', minInt: 0, minDec: 0, maxDec: 0, dot: false, group: false, pct: 0, scale: 0, digits: false, red: false };
    let s = sec;
    let bad = false;
    s = s.replace(/\[([^\]]*)\]/g, (m, inner) => {
      if (/^red$/i.test(inner)) { o.red = true; return ''; }
      if (/^(black|blue|cyan|green|magenta|white|yellow|color\d+)$/i.test(inner)) return '';
      const cur = /^\$([^-]*)(-[0-9A-Fa-f]+)?$/.exec(inner);
      if (cur) return cur[1] ? `"${cur[1].replace(/"/g, '')}"` : '';
      bad = true; // conditions [>100], elapsed time [h], …
      return '';
    });
    if (bad) return null;
    let inDec = false;
    let pendingComma = 0;
    const lit = (t) => { if (o.digits) o.post += t; else o.pre += t; };
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') {
        const j = s.indexOf('"', i + 1);
        lit(j < 0 ? s.slice(i + 1) : s.slice(i + 1, j));
        i = j < 0 ? s.length : j;
      } else if (ch === '\\') { lit(s[i + 1] || ''); i++; }
      else if (ch === '_') { lit(' '); i++; }
      else if (ch === '*') { i++; }
      else if (ch === '0' || ch === '#' || ch === '?') {
        if (o.post) return null; // literal between digits ("000-0000"): not supported
        if (pendingComma) { o.group = true; pendingComma = 0; }
        o.digits = true;
        if (inDec) { o.maxDec++; if (ch === '0') o.minDec++; } else if (ch === '0') o.minInt++;
      } else if (ch === '.' && !inDec && (o.digits || /[0#?]/.test(s.slice(i + 1, i + 2)))) {
        if (o.post) return null;
        inDec = true; o.dot = true; o.digits = true;
        if (pendingComma) { o.scale += pendingComma; pendingComma = 0; }
      } else if (ch === ',' && o.digits && !o.post) {
        if (inDec) o.scale++; // "0.0,," : commas after the decimals divide by 1000 each
        else pendingComma++;
      } else if (ch === '%') { o.pct++; lit('%'); }
      else if (ch === 'E' || ch === 'e' || ch === '@' || /[ymdhsgAP]/.test(ch)) return null;
      else lit(ch);
    }
    if (pendingComma) o.scale += pendingComma; // trailing commas: thousands scaling
    return o;
  };

  const fmtCache = new Map();
  const compile = (code) => {
    if (fmtCache.has(code)) return fmtCache.get(code);
    const secs = splitSections(code).map(compileSection);
    const f = secs.some((x, i) => i < 3 && x === null) ? null : secs;
    fmtCache.set(code, f);
    return f;
  };

  const withSection = (n, o, neg) => {
    if (!o.digits) return o.pre + o.post;
    const x = Math.abs(n) * 100 ** o.pct / 1000 ** o.scale;
    if (x >= 1e15) return null; // past exact doubles (and toFixed's exponent form): General
    // round half up on the decimal value Excel shows (2.675 -> 2.68), not on the binary one toFixed sees (2.67)
    const d = Math.min(15, o.maxDec);
    const m = 10 ** d;
    const s = (Math.round(x * m * (1 + Number.EPSILON)) / m).toFixed(d);
    let [ip, fp = ''] = s.split('.');
    while (fp.length > o.minDec && fp.endsWith('0')) fp = fp.slice(0, -1);
    if (ip === '0' && o.minInt === 0) ip = '';
    while (ip.length < o.minInt) ip = '0' + ip;
    if (o.group) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const num = ip + (o.dot ? '.' + fp : '');
    const zero = !/[1-9]/.test(num);
    return (neg && !zero ? '-' : '') + o.pre + num + o.post;
  };

  // -> { text, red }
  const formatNumber = (v, code) => {
    const secs = code ? compile(code) : null;
    if (!secs || !Number.isFinite(v)) return { text: general(v), red: false };
    let o;
    let neg = false;
    if (secs.length === 1) { o = secs[0]; neg = v < 0; }
    else if (v < 0) { o = secs[1]; }
    else if (v === 0 && secs.length >= 3) o = secs[2];
    else o = secs[0];
    const text = o ? withSection(v, o, neg) : null;
    if (text == null) return { text: general(v), red: false };
    return { text, red: o.red };
  };

  // ---- the table ---------------------------------------------------------------------------------------------------
  // ctx = { api, info, body, tools, h, btn, on, cleanups, showMsg, failMsg, isDisposed }
  function create(ctx) {
    const { api, info, body, h, on, cleanups } = ctx;
    const wrap = h('div', 'vx');
    const bar = h('div', 'vx-bar');
    const addr = h('span', 'vx-addr', '');
    const fbox = h('span', 'vx-formula', '');
    bar.append(addr, fbox);
    const grid = h('div', 'vx-grid');
    const scroller = h('div', 'vx-scroll');
    const sizer = h('div', 'vx-sizer');
    scroller.append(sizer);
    const view = h('div', 'vx-view');
    view.tabIndex = 0;
    const mk = (cls) => { const n = h('div', `vx-layer ${cls}`); n._pool = []; n._used = 0; view.append(n); return n; };
    // order matters: later layers paint above earlier ones
    const L = {
      main: mk('vx-cells'), top: mk('vx-cells vx-frz'), left: mk('vx-cells vx-frz'), corner: mk('vx-cells vx-frz'),
      colHdr: mk('vx-hdr'), colHdrF: mk('vx-hdr'), rowHdr: mk('vx-hdr'), rowHdrF: mk('vx-hdr'), knob: mk('vx-hdr vx-knob'),
    };
    grid.append(scroller, view);
    const tabs = h('div', 'vx-tabs');
    const note = h('div', 'vx-note', '');
    note.hidden = true;
    wrap.append(bar, note, grid, tabs);

    let sheets = [];
    let cur = -1; // sheet index
    let S = null; // { sheet, X, cells: Map, covered: Map, merges, rows, cols, fr, fc, rowHdrW }
    let sel = { r: 0, c: 0 };
    let raf = 0;
    const scrollMemo = new Map(); // sheet name -> { top, left, sel }

    const key = (r, c) => r * 16384 + c; // main clamps to Excel's grid (c < 16384), so keys never collide

    function model(sheet) {
      const cols = Math.max(1, sheet.cols);
      const rows = Math.max(1, sheet.rows);
      const X = new Float64Array(cols + 1);
      for (let c = 0; c < cols; c++) X[c + 1] = X[c] + colPx(sheet.colWidths[c] ?? 8.43);
      const cells = new Map();
      for (const cell of sheet.cells) cells.set(key(cell[0], cell[1]), cell);
      const merges = [];
      const covered = new Map();
      let budget = 500000;
      for (const ref of sheet.merges || []) {
        const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(String(ref));
        if (!m) continue;
        const cn = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        const g = { r1: +m[2] - 1, c1: cn(m[1]), r2: +(m[4] || m[2]) - 1, c2: cn(m[3] || m[1]) };
        if (g.r2 < g.r1 || g.c2 < g.c1) continue;
        merges.push(g);
        for (let r = g.r1; r <= g.r2 && budget > 0; r++) for (let c = g.c1; c <= g.c2 && budget > 0; c++, budget--) covered.set(key(r, c), g);
      }
      const fr = Math.min(sheet.freeze?.rows || 0, rows - 1, 50);
      const fc = Math.min(sheet.freeze?.cols || 0, cols - 1, 30);
      const rowHdrW = 14 + 8 * String(rows).length;
      return { sheet, X, cells, covered, merges, rows, cols, fr, fc, rowHdrW };
    }

    const display = (cell) => {
      if (!cell) return { text: '', cls: '' };
      const v = cell[2];
      if (v == null) return { text: '', cls: '' };
      if (typeof v === 'number') {
        const code = cell[4] != null ? S.sheet.fmts[cell[4]] : null;
        const f = formatNumber(v, code);
        return { text: f.text, cls: f.red ? 'vx-n vx-red' : 'vx-n' };
      }
      if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', cls: 'vx-m' };
      if (typeof v === 'object') return { text: String(v.error || '#ERR'), cls: 'vx-m vx-err' };
      const s = String(v);
      if (/^\d{4}-\d\d-\d\d(T\d\d:\d\d:\d\d)?$|^\d{2,}:\d\d:\d\d$/.test(s)) return { text: s.replace('T', ' '), cls: 'vx-n' };
      return { text: s, cls: 'vx-s' };
    };

    // first index i in [lo, hi) with X[i + 1] > x
    const findCol = (x, lo, hi) => {
      let a = lo;
      let b = hi - 1;
      while (a < b) {
        const m = (a + b) >> 1;
        if (S.X[m + 1] > x) b = m; else a = m + 1;
      }
      return a;
    };

    const take = (layer) => {
      let n = layer._pool[layer._used];
      if (!n) { n = document.createElement('div'); layer.append(n); layer._pool.push(n); }
      layer._used++;
      n.hidden = false;
      return n;
    };
    const begin = (layer) => { layer._used = 0; };
    const end = (layer) => { for (let i = layer._used; i < layer._pool.length; i++) layer._pool[i].hidden = true; };
    const place = (n, x, y, w, ht) => {
      n.style.left = `${x}px`;
      n.style.top = `${y}px`;
      n.style.width = `${w}px`;
      n.style.height = `${ht}px`;
    };
    const box = (layer, x, y, w, ht) => {
      layer.style.left = `${x}px`;
      layer.style.top = `${y}px`;
      layer.style.width = `${Math.max(0, w)}px`;
      layer.style.height = `${Math.max(0, ht)}px`;
    };

    // a band of one axis: indexes [i0, i1) drawn, position of index i = pos(i)
    function colBand(frozen, sx, width) {
      const { X, fc, cols } = S;
      if (frozen) {
        const list = [];
        for (let c = 0; c < fc; c++) list.push(c);
        return { list, pos: (c) => X[c] };
      }
      const base = X[fc] + sx;
      const list = [];
      for (let c = findCol(base, fc, cols); c < cols && X[c] < base + width; c++) list.push(c);
      return { list, pos: (c) => X[c] - base };
    }
    function rowBand(frozen, sy, height) {
      const { fr, rows } = S;
      if (frozen) {
        const list = [];
        for (let r = 0; r < fr; r++) list.push(r);
        return { list, pos: (r) => r * ROW_H };
      }
      const base = fr * ROW_H + sy;
      const list = [];
      for (let r = Math.max(fr, Math.floor(base / ROW_H)); r < rows && r * ROW_H < base + height; r++) list.push(r);
      return { list, pos: (r) => r * ROW_H - base };
    }

    function drawCells(layer, rb, cb) {
      begin(layer);
      if (!rb.list.length || !cb.list.length) { end(layer); return; }
      const { X, cells, covered, merges } = S;
      const r0 = rb.list[0], r1 = rb.list[rb.list.length - 1];
      const c0 = cb.list[0], c1 = cb.list[cb.list.length - 1];
      for (const g of merges) {
        if (g.r2 < r0 || g.r1 > r1 || g.c2 < c0 || g.c1 > c1) continue;
        const n = take(layer);
        const d = display(cells.get(key(g.r1, g.c1)));
        n.className = `vx-c vx-merge ${d.cls}${sel.r >= g.r1 && sel.r <= g.r2 && sel.c >= g.c1 && sel.c <= g.c2 ? ' vx-sel' : ''}`;
        n.textContent = d.text;
        n.dataset.r = g.r1;
        n.dataset.c = g.c1;
        place(n, cb.pos(g.c1), rb.pos(g.r1), X[g.c2 + 1] - X[g.c1], (g.r2 - g.r1 + 1) * ROW_H);
      }
      for (const r of rb.list) {
        const y = rb.pos(r);
        let skipTo = -1;
        for (const c of cb.list) {
          const w = X[c + 1] - X[c];
          if (!w || c <= skipTo) continue;
          const k = key(r, c);
          if (covered.has(k)) continue;
          const cell = cells.get(k);
          const d = display(cell);
          let span = w;
          if (d.cls === 'vx-s' && d.text) {
            // text runs over into the empty cells on its right, like Excel
            let e = c;
            const lim = Math.min(S.cols - 1, c + SPILL_MAX, c1);
            while (e < lim && !cells.has(key(r, e + 1)) && !covered.has(key(r, e + 1))) e++;
            if (e > c) { span = X[e + 1] - X[c]; skipTo = e; }
          }
          const n = take(layer);
          n.className = `vx-c ${d.cls}${r === sel.r && c === sel.c ? ' vx-sel' : ''}`;
          n.textContent = d.text;
          n.dataset.r = r;
          n.dataset.c = c;
          place(n, cb.pos(c), y, span, ROW_H);
        }
      }
      end(layer);
    }
    function drawColHdr(layer, cb) {
      begin(layer);
      for (const c of cb.list) {
        const w = S.X[c + 1] - S.X[c];
        if (!w) continue;
        const n = take(layer);
        n.className = `vx-h${c === sel.c ? ' vx-hsel' : ''}`;
        n.textContent = colName(c);
        delete n.dataset.r;
        n.dataset.c = c;
        place(n, cb.pos(c), 0, w, HDR_H);
      }
      end(layer);
    }
    function drawRowHdr(layer, rb) {
      begin(layer);
      for (const r of rb.list) {
        const n = take(layer);
        n.className = `vx-h vx-rh${r === sel.r ? ' vx-hsel' : ''}`;
        n.textContent = String(r + 1);
        delete n.dataset.c;
        n.dataset.r = r;
        place(n, 0, rb.pos(r), S.rowHdrW, ROW_H);
      }
      end(layer);
    }

    function render() {
      raf = 0;
      if (!S || ctx.isDisposed()) return;
      const W = scroller.clientWidth;
      const H = scroller.clientHeight;
      view.style.width = `${W}px`;
      view.style.height = `${H}px`;
      const sx = scroller.scrollLeft;
      const sy = scroller.scrollTop;
      const fw = S.X[S.fc];
      const fh = S.fr * ROW_H;
      const left = S.rowHdrW;
      // layers end where the sheet ends (the frozen edge lines would otherwise run on below the last row)
      const mw = Math.max(0, Math.min(W - left - fw, S.X[S.cols] - fw - sx));
      const mh = Math.max(0, Math.min(H - HDR_H - fh, (S.rows - S.fr) * ROW_H - sy));
      const cbS = colBand(false, sx, mw);
      const cbF = colBand(true);
      const rbS = rowBand(false, sy, mh);
      const rbF = rowBand(true);
      box(L.main, left + fw, HDR_H + fh, mw, mh);
      box(L.top, left + fw, HDR_H, mw, fh);
      box(L.left, left, HDR_H + fh, fw, mh);
      box(L.corner, left, HDR_H, fw, fh);
      box(L.colHdr, left + fw, 0, mw, HDR_H);
      box(L.colHdrF, left, 0, fw, HDR_H);
      box(L.rowHdr, 0, HDR_H + fh, left, mh);
      box(L.rowHdrF, 0, HDR_H, left, fh);
      box(L.knob, 0, 0, left, HDR_H);
      drawCells(L.main, rbS, cbS);
      drawCells(L.top, rbF, cbS);
      drawCells(L.left, rbS, cbF);
      drawCells(L.corner, rbF, cbF);
      drawColHdr(L.colHdr, cbS);
      drawColHdr(L.colHdrF, cbF);
      drawRowHdr(L.rowHdr, rbS);
      drawRowHdr(L.rowHdrF, rbF);
      L.top.classList.toggle('vx-edge-b', S.fr > 0);
      L.corner.classList.toggle('vx-edge-b', S.fr > 0);
      L.left.classList.toggle('vx-edge-r', S.fc > 0);
      L.corner.classList.toggle('vx-edge-r', S.fc > 0);
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(render); };
    cleanups.push(() => { if (raf) cancelAnimationFrame(raf); });

    function showSel() {
      if (!S) { addr.textContent = ''; fbox.textContent = ''; return; }
      const g = S.covered.get(key(sel.r, sel.c));
      const r = g ? g.r1 : sel.r;
      const c = g ? g.c1 : sel.c;
      const cell = S.cells.get(key(r, c));
      addr.textContent = g ? `${colName(g.c1)}${g.r1 + 1}:${colName(g.c2)}${g.r2 + 1}` : `${colName(c)}${r + 1}`;
      let t = '';
      if (cell) {
        if (cell[3]) t = cell[3];
        else if (cell[2] && typeof cell[2] === 'object') t = String(cell[2].error || '');
        else if (typeof cell[2] === 'boolean') t = cell[2] ? 'TRUE' : 'FALSE';
        else if (cell[2] != null) t = String(cell[2]);
      }
      fbox.textContent = t;
      fbox.title = t;
    }

    function ensureVisible() {
      const W = scroller.clientWidth;
      const H = scroller.clientHeight;
      if (sel.r >= S.fr) {
        const y = (sel.r - S.fr) * ROW_H;
        const mh = H - HDR_H - S.fr * ROW_H;
        if (y < scroller.scrollTop) scroller.scrollTop = y;
        else if (y + ROW_H > scroller.scrollTop + mh) scroller.scrollTop = y + ROW_H - mh;
      }
      if (sel.c >= S.fc) {
        const x = S.X[sel.c] - S.X[S.fc];
        const w = S.X[sel.c + 1] - S.X[sel.c];
        const mw = W - S.rowHdrW - S.X[S.fc];
        if (x < scroller.scrollLeft) scroller.scrollLeft = x;
        else if (x + w > scroller.scrollLeft + mw) scroller.scrollLeft = Math.min(x, x + w - mw);
      }
    }
    function select(r, c, reveal) {
      if (!S) return;
      sel = { r: Math.max(0, Math.min(S.rows - 1, r)), c: Math.max(0, Math.min(S.cols - 1, c)) };
      showSel();
      if (reveal) ensureVisible();
      schedule();
    }

    on(scroller, 'scroll', schedule, { passive: true });
    on(view, 'wheel', (e) => {
      if (e.ctrlKey || e.metaKey) return; // pinch / zoom
      e.preventDefault();
      const unit = e.deltaMode === 1 ? ROW_H : e.deltaMode === 2 ? scroller.clientHeight : 1;
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      scroller.scrollLeft += dx * unit;
      scroller.scrollTop += dy * unit;
    }, { passive: false });
    on(view, 'mousedown', (e) => {
      const n = e.target.closest && e.target.closest('[data-r], [data-c]');
      view.focus({ preventScroll: true });
      if (!n || !S) return;
      const r = n.dataset.r != null ? +n.dataset.r : null;
      const c = n.dataset.c != null ? +n.dataset.c : null;
      select(r ?? sel.r, c ?? sel.c, false);
    });
    on(view, 'keydown', (e) => {
      if (!S) return;
      const page = Math.max(1, Math.floor((scroller.clientHeight - HDR_H) / ROW_H) - 1 - S.fr);
      const moves = {
        ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-page, 0], PageDown: [page, 0],
        Enter: [e.shiftKey ? -1 : 1, 0], Tab: [0, e.shiftKey ? -1 : 1],
      };
      // UX4: mod = ⌘ on Mac, Ctrl on Windows (Labels.modOf)
      const mod = window.Labels ? window.Labels.modOf(e) : e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'c' || e.key === 'C')) {
        const g = S.covered.get(key(sel.r, sel.c)); // inside a merge: its top-left cell holds the value
        const cell = S.cells.get(g ? key(g.r1, g.c1) : key(sel.r, sel.c));
        navigator.clipboard?.writeText(display(cell).text).catch(() => {});
        e.preventDefault();
        return;
      }
      if (e.key === 'Home') { select(mod ? 0 : sel.r, 0, true); e.preventDefault(); return; }
      if (e.key === 'End' && mod) { select(S.rows - 1, S.cols - 1, true); e.preventDefault(); return; }
      const m = moves[e.key];
      if (!m || e.altKey) return;
      e.preventDefault();
      if (mod && !/^Page|Enter|Tab/.test(e.key)) select(m[0] ? (m[0] < 0 ? 0 : S.rows - 1) : sel.r, m[1] ? (m[1] < 0 ? 0 : S.cols - 1) : sel.c, true);
      else select(sel.r + m[0], sel.c + m[1], true);
    });
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(schedule);
      ro.observe(grid);
      cleanups.push(() => ro.disconnect());
    }

    // the tab strip has no scrollbar: the wheel scrolls it sideways
    on(tabs, 'wheel', (e) => {
      if (!e.deltaY || e.deltaX) return;
      e.preventDefault();
      tabs.scrollLeft += e.deltaY;
    }, { passive: false });

    function drawTabs() {
      const nodes = sheets.map((s, i) => {
        const b = h('button', `vx-tab${i === cur ? ' vx-tab-on' : ''}${s.hidden ? ' vx-tab-hidden' : ''}`, s.name);
        b.type = 'button';
        b.title = s.hidden ? `${s.name}（非表示のシート）` : `${s.name}（${s.rows} 行 × ${s.cols} 列）`;
        b.addEventListener('click', () => { if (i !== cur) openSheet(i); });
        return b;
      });
      tabs.replaceChildren(...nodes);
      const active = tabs.children[cur];
      if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    let seq = 0;
    // Each sheet keeps its own scroll position and selection while the viewer is open (also across file reloads).
    async function openSheet(i, retried = false) {
      const my = ++seq;
      if (S && cur >= 0 && sheets[cur]) scrollMemo.set(sheets[cur].name, { top: scroller.scrollTop, left: scroller.scrollLeft, sel });
      let res;
      try { res = await api.viewerRead({ id: info.id, sheet: i }); } catch (err) { res = { ok: false, reason: String(err && err.message || err) }; }
      if (ctx.isDisposed() || my !== seq) return false;
      let sheet = null;
      if (res && res.ok) {
        try { sheet = JSON.parse(res.sheetJson); } catch { res = { ok: false, reason: 'badsheet' }; }
      }
      if (!res || !res.ok || !sheet) { ctx.showMsg(ctx.failMsg(res && res.reason)); return false; }
      // the file changed since the tab list was read (sheets moved / removed): read the list again first
      if (sheets[i] && sheet.name !== sheets[i].name && !retried) return loadList(true);
      res.sheet = sheet;
      cur = i;
      S = model(res.sheet);
      const msgs = [];
      if (res.sheet.note) msgs.push('このシートは表ではありません（グラフのシートなど）');
      if (res.sheet.truncated) msgs.push('セルが多すぎるため、途中までだけ表示しています');
      note.textContent = msgs.join(' / ');
      note.hidden = !msgs.length;
      sizer.style.width = `${S.rowHdrW + S.X[S.cols] + 80}px`;
      sizer.style.height = `${HDR_H + S.rows * ROW_H + ROW_H * 2}px`;
      if (!body.contains(wrap)) body.replaceChildren(wrap);
      body.classList.remove('vw-dim');
      const memo = scrollMemo.get(res.sheet.name);
      scroller.scrollTop = memo ? memo.top : 0;
      scroller.scrollLeft = memo ? memo.left : 0;
      sel = memo ? { r: Math.min(memo.sel.r, S.rows - 1), c: Math.min(memo.sel.c, S.cols - 1) } : { r: 0, c: 0 };
      drawTabs();
      showSel();
      render();
      return true;
    }

    async function loadList(retried = false) {
      let res;
        try { res = await api.viewerRead({ id: info.id }); } catch (err) { res = { ok: false, reason: String(err && err.message || err) }; }
        if (ctx.isDisposed()) return false;
        if (!res || !res.ok) { ctx.showMsg(ctx.failMsg(res && res.reason)); return false; }
        const prevName = cur >= 0 && sheets[cur] ? sheets[cur].name : null;
        sheets = res.sheets || [];
        if (!sheets.length) { ctx.showMsg('シートがありません'); return false; }
        let i = prevName != null ? sheets.findIndex((s) => s.name === prevName) : -1;
        if (i < 0) i = Math.max(0, sheets.findIndex((s) => !s.hidden));
        return openSheet(i, retried);
    }

    return {
      load: () => loadList(false),
      // for tests (tmp/viewer/e2e-xlsx.mjs)
      _state: () => ({ cur, sheets: sheets.map((s) => s.name), sel, addr: addr.textContent, formula: fbox.textContent }),
    };
  }

  window.ViewerXlsx = { create, formatNumber, general, colName };
})();
