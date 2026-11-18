// UX16 (docs/ux-journey.md §6, docs/ux16-check.md): ⌘K のコマンドパレット. Owner: core.
// One box on top of the window: type to find an operation (Labels.COMMANDS, the one table that also makes the shortcuts
// and the cheat sheet's key list), a task by its number or title, a request, a live session, a folder, a file.
// ↑ ↓ choose, Enter runs, Esc / a click outside closes. The ⋯ その他 menu is gone: what it held is here.
// This file only draws and matches; the window says what there is and what each row does (renderer.js
// paletteSources):
//   window.Palette.init({ commands() -> [{ id, label, key, where, words }], run(id),
//                         items() -> [{ kind, label, hint, words, usage, run() }],
//                         files(query) -> Promise<[{ label, hint, usage, run() }]> })
//   open() / close() / toggle() / isOpen() / rows() (tests: the rows on screen, [{ kind, label, hint }])
//   match(query, text) -> score (0 = no match; tmp/palette/unit.js)
(() => {
  'use strict';
  const KIND = Object.freeze({ cmd: '操作', task: 'タスク', request: '依頼', session: 'セッション', folder: 'フォルダ', file: 'ファイル' });
  const ORDER = ['cmd', 'task', 'request', 'session', 'folder', 'file'];
  const PER_KIND = 8; // rows per kind (the operations: all of them on an empty query)
  const FILE_MIN = 2; // characters before files are searched (the search walks the folder)

  const style = document.createElement('style');
  style.textContent = `
.pal-back { position: fixed; inset: 0; z-index: 3000; background: color-mix(in srgb, var(--shade) 28%, transparent); }
.pal-back[hidden] { display: none !important; }
.pal-box { position: absolute; top: 12vh; left: 50%; transform: translateX(-50%); width: min(640px, calc(100vw - 32px));
  max-height: 70vh; display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden;
  background: var(--surface); color: var(--text); border: 1px solid var(--strong);
  border-radius: var(--r2); box-shadow: 0 12px 40px color-mix(in srgb, var(--shade) 45%, transparent); font-size: var(--fs-m); }
.pal-input { box-sizing: border-box; width: 100%; padding: var(--s3) var(--s3); border: 0; border-bottom: 1px solid var(--line);
  background: transparent; color: inherit; font: inherit; font-size: var(--fs-l); outline: none; }
.pal-list { overflow-y: auto; padding: var(--s1) 0 var(--s1); }
.pal-group { padding: var(--s2) var(--s3) var(--s1); font-size: var(--fs-xs); color: var(--muted); }
.pal-row { display: flex; align-items: center; gap: var(--s2); padding: var(--s1) var(--s3); cursor: pointer; min-width: 0; }
.pal-row.on { background: var(--hover); }
.pal-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pal-hint { flex: 0 1 auto; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: var(--fs-s); }
.pal-key { flex: 0 0 auto; color: var(--muted); font-size: var(--fs-s); font-family: var(--font-mono); }
.pal-empty { padding: var(--s3) var(--s3); color: var(--muted); }`;
  document.head.append(style);

  let src = { commands: () => [], run: () => {}, items: () => [], files: null };
  let back = null;
  let input = null;
  let list = null;
  let rows = []; // [{ kind, label, hint, key, usage, run }]
  let sel = 0;
  let prevFocus = null;
  let fileSeq = 0;
  let fileRows = [];

  // NFKC, lower case, katakana as hiragana (ターミ = たーみ), spaces squeezed
  function norm(s) {
    let t = String(s || '').normalize('NFKC').toLowerCase();
    t = t.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
    return t.replace(/\s+/g, ' ').trim();
  }
  // every word of the query is in the text; a hit at the start of the label counts more. 0 = no match
  function match(query, label, words) {
    const q = norm(query);
    if (!q) return 1;
    const l = norm(label);
    const all = l + ' ' + norm(words);
    const parts = q.split(' ');
    if (!parts.every((p) => all.includes(p))) return 0;
    if (l.startsWith(q)) return 4;
    if (l.includes(q)) return 3;
    return parts.every((p) => l.includes(p)) ? 2 : 1;
  }

  function build() {
    if (back) return;
    back = document.createElement('div');
    back.className = 'pal-back';
    back.hidden = true;
    const box = document.createElement('div');
    box.className = 'pal-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', (window.Labels && window.Labels.WORDS.palette) || 'コマンドパレット');
    input = document.createElement('input');
    input.className = 'pal-input';
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = (window.Labels && window.Labels.WORDS.palettePlaceholder) || '';
    list = document.createElement('div');
    list.className = 'pal-list';
    list.setAttribute('role', 'listbox');
    box.append(input, list);
    back.append(box);
    back.addEventListener('mousedown', (e) => {
      if (e.target === back) close();
    });
    input.addEventListener('input', () => {
      sel = 0;
      fileRows = [];
      paint();
      askFiles();
    });
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!rows.length) return;
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        mark();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        pick(sel);
      }
    });
    document.body.append(back);
  }

  function collect() {
    const q = input.value;
    const out = [];
    const cmds = (safe(() => src.commands(), []) || []).map((c) => ({ kind: 'cmd', label: c.label, hint: c.where && c.where !== 'どこでも' ? c.where : '', key: c.key || '', words: `${c.id} ${c.words || ''} ${c.key || ''}`, usage: 'palette.cmd.' + kebab(c.id), run: () => src.run(c.id) }));
    const items = safe(() => src.items(), []) || [];
    for (const kind of ORDER) {
      const pool = kind === 'cmd' ? cmds : kind === 'file' ? fileRows : items.filter((x) => x.kind === kind);
      let hits = pool.map((r, i) => ({ r, i, s: kind === 'file' ? 1 : match(q, r.label, r.words) })).filter((x) => x.s > 0);
      if (!norm(q) && kind !== 'cmd' && kind !== 'session') continue; // empty query: the operations and the live sessions
      hits.sort((a, b) => b.s - a.s || a.i - b.i);
      if (kind !== 'cmd' || norm(q)) hits = hits.slice(0, PER_KIND);
      for (const h of hits) out.push({ ...h.r, kind });
    }
    return out;
  }
  function paint() {
    rows = collect();
    if (sel >= rows.length) sel = Math.max(0, rows.length - 1);
    list.textContent = '';
    if (!rows.length) {
      const e = document.createElement('div');
      e.className = 'pal-empty';
      e.textContent = (window.Labels && window.Labels.WORDS.paletteEmpty) || '見つかりません';
      list.append(e);
      return;
    }
    let last = '';
    rows.forEach((r, i) => {
      if (r.kind !== last) {
        last = r.kind;
        const g = document.createElement('div');
        g.className = 'pal-group';
        g.textContent = KIND[r.kind] || '';
        list.append(g);
      }
      const row = document.createElement('div');
      row.className = 'pal-row';
      row.setAttribute('role', 'option');
      row.dataset.kind = r.kind;
      row.dataset.i = String(i);
      if (r.usage) row.dataset.usage = r.usage;
      const l = document.createElement('span');
      l.className = 'pal-label';
      l.textContent = r.label;
      row.title = r.label;
      row.append(l);
      if (r.hint) {
        const hh = document.createElement('span');
        hh.className = 'pal-hint';
        hh.textContent = r.hint;
        row.append(hh);
      }
      if (r.key) {
        const k = document.createElement('span');
        k.className = 'pal-key';
        k.textContent = r.key;
        row.append(k);
      }
      row.addEventListener('mousemove', () => {
        if (sel !== i) {
          sel = i;
          mark();
        }
      });
      row.addEventListener('click', () => pick(i));
      list.append(row);
    });
    mark();
  }
  function mark() {
    for (const el of list.querySelectorAll('.pal-row')) {
      const on = Number(el.dataset.i) === sel;
      el.classList.toggle('on', on);
      el.setAttribute('aria-selected', String(on));
      if (on) el.scrollIntoView({ block: 'nearest' });
    }
  }
  async function askFiles() {
    const q = input.value.trim();
    const seq = ++fileSeq;
    if (!src.files || q.length < FILE_MIN) return;
    const got = await Promise.resolve(safe(() => src.files(q), [])).catch(() => []);
    if (seq !== fileSeq || !isOpen()) return;
    fileRows = (Array.isArray(got) ? got : []).slice(0, PER_KIND);
    if (fileRows.length) paint();
  }
  function pick(i) {
    const r = rows[i];
    if (!r) return;
    close();
    safe(() => r.run());
  }

  function open() {
    build();
    if (isOpen()) return input.focus();
    prevFocus = document.activeElement;
    input.value = '';
    sel = 0;
    fileRows = [];
    back.hidden = false;
    paint();
    input.focus();
  }
  function close() {
    if (!isOpen()) return;
    back.hidden = true;
    fileSeq++;
    const pf = prevFocus;
    prevFocus = null;
    if (pf && pf.isConnected && typeof pf.focus === 'function') safe(() => pf.focus());
  }
  const isOpen = () => !!back && !back.hidden;
  const kebab = (s) => String(s).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  function safe(fn, dflt) {
    try {
      return fn();
    } catch (err) {
      console.error('[palette]', err);
      return dflt;
    }
  }

  window.Palette = {
    init(o) {
      src = { ...src, ...(o || {}) };
    },
    open,
    close,
    toggle: () => (isOpen() ? close() : open()),
    isOpen,
    rows: () => rows.map((r) => ({ kind: r.kind, label: r.label, hint: r.hint || '', key: r.key || '' })),
    match: (q, label, words) => match(q, label, words),
    KIND,
  };
})();
