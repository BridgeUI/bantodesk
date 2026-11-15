'use strict';
// Folder progress (PROGRESS.md, dashboard:progress) on the dashboard's folder rows. Owner: core.
// window.ProgressView:
//   line(progress, { id, onToggle }) -> element: "進捗 12/20 · 進行中: <items>" (a button; toggles the table)
//   table(progress, { id }) -> element | null: the table, read-only (null when not expanded)
//   isOpen(id) -> bool
//   sig() -> string: the expanded / filter / paging state (the dashboard's redraw signature)
// The expanded set lives here, so it survives the dashboard's frequent re-renders.
// UX7 (docs/ux-journey.md §6, docs/mac-polish.md J3): the table shows 完了以外 by default with state chips above it
// (すべて + the five states; several can be chosen), ROWS (40) rows then 「ほか N 行」 (ROWS more per click). The built table
// is kept per folder until PROGRESS.md (mtime / rows) or the chips / paging change; a redraw gets a copy of it
// (cloneNode), so the clicks are handled by one listener on the document (data-pgv-*), not on the elements.
(() => {
  const open = new Set(); // folder ids (lower-cased paths)
  const CLS = { 未着手: 'todo', 進行中: 'doing', 確認待ち: 'wait', 完了: 'done', 保留: 'hold', その他: 'other' };
  const STATES = ['未着手', '進行中', '確認待ち', '保留', '完了'];
  const ROWS = 40; // UX7: 50 rows put the プロジェクト tab at 624 elements (perf big); 40 keeps it under 600
  const DEFAULT = ['未着手', '進行中', '確認待ち', '保留', 'その他']; // 完了以外
  const filters = new Map(); // id -> Set of states shown (absent = DEFAULT; empty Set = すべて)
  const more = new Map(); // id -> rows shown past ROWS
  const cache = new Map(); // id -> { key, el }
  const toggles = new Map(); // id -> the last onToggle (the dashboard's render)

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }
  const filterOf = (id) => (filters.has(id) ? filters.get(id) : new Set(DEFAULT));
  const stateOf = (r) => (CLS[r.state] && r.state !== 'その他' ? r.state : 'その他');
  const isDefault = (id) => !filters.has(id);

  function line(p, o = {}) {
    const id = o.id || '';
    if (o.onToggle) toggles.set(id, o.onToggle);
    const b = h('button', `pgv-line${open.has(id) ? ' on' : ''}`);
    b.type = 'button';
    const nums = h('span', 'pgv-count');
    nums.append(document.createTextNode('進捗 '), h('b', '', `${p.done}/${p.total}`));
    b.append(nums);
    const doing = p.rows.filter((r) => r.state === '進行中').map((r) => r.item);
    const wait = p.rows.filter((r) => r.state === '確認待ち').length;
    if (doing.length) b.append(h('span', 'pgv-doing', doing.length > 3 ? `${doing.slice(0, 3).join('、')} ほか ${doing.length - 3}` : doing.join('、')));
    else if (wait) b.append(h('span', 'pgv-wait', `確認待ち ${wait}`));
    else if (p.total && p.done === p.total) b.append(h('span', 'pgv-alldone', 'すべて完了'));
    b.title = `PROGRESS.md（このフォルダのセッションが更新）\n${doing.length ? `進行中: ${doing.slice(0, 10).join('\n　')}${doing.length > 10 ? `\n　ほか ${doing.length - 10}` : ''}\n` : ''}クリックで表を${open.has(id) ? '閉じる' : '開く'}`;
    b.addEventListener('click', () => {
      if (open.has(id)) open.delete(id);
      else open.add(id);
      o.onToggle && o.onToggle();
    });
    return b;
  }

  function build(p, id) {
    const f = filterOf(id);
    const all = !f.size;
    const wrap = h('div', 'pgv-panel');
    wrap.dataset.k = 'pgv'; // the dashboard's patch matches it by key inside the card
    wrap.dataset.pgv = id;
    // chips: すべて + each state with its count (その他 only when there is one)
    const counts = {};
    for (const r of p.rows) counts[stateOf(r)] = (counts[stateOf(r)] || 0) + 1;
    const bar = h('div', 'pgv-chips');
    const chip = (label, st, on, title) => {
      const c = h('button', `pgv-chip${on ? ' on' : ''}${st && st !== '*' ? ` pgv-c-${CLS[st] || 'other'}` : ''}`, label);
      c.type = 'button';
      c.dataset.pgvChip = st;
      c.setAttribute('aria-pressed', String(on));
      if (title) c.title = title;
      bar.append(c);
    };
    chip(`すべて ${p.rows.length}`, '*', all, '状態で絞らない');
    for (const st of [...STATES, 'その他']) {
      if (st === 'その他' && !counts[st]) continue;
      chip(`${st} ${counts[st] || 0}`, st, !all && f.has(st), isDefault(id) && st !== '完了' ? '既定は完了以外（押すとその状態だけ）' : '');
    }
    wrap.append(bar);
    const rows = all ? p.rows : p.rows.filter((r) => f.has(stateOf(r)));
    const n = Math.min(rows.length, ROWS + (more.get(id) || 0));
    if (rows.length) {
      const t = h('table', 'pgv-table');
      const thead = h('thead');
      const tr0 = h('tr');
      for (const c of ['#', '項目', '状態', '次の一手', '更新日']) tr0.append(h('th', '', c));
      thead.append(tr0);
      const tbody = h('tbody');
      for (const r of rows.slice(0, n)) {
        const tr = h('tr', `pgv-r-${CLS[r.state] || 'other'}`);
        tr.append(h('td', 'pgv-n', r.n), h('td', 'pgv-item', r.item), h('td', 'pgv-state', r.state), h('td', 'pgv-next', r.next), h('td', 'pgv-upd', r.updated));
        tbody.append(tr);
      }
      t.append(thead, tbody);
      wrap.append(t);
    } else wrap.append(h('div', 'pgv-none', '絞り込みに合う行はありません'));
    if (rows.length > ROWS) {
      const mb = h('div', 'pgv-morebar');
      if (n < rows.length) {
        const b = h('button', 'pgv-more', `ほか ${rows.length - n} 行`);
        b.type = 'button';
        b.dataset.pgvMore = '1';
        if (rows.length - n > ROWS) b.title = `${ROWS} 行ずつ開きます`;
        mb.append(b);
      }
      if (n > ROWS) {
        const c = h('button', 'pgv-more', '畳む');
        c.type = 'button';
        c.dataset.pgvFold = '1';
        mb.append(c);
      }
      wrap.append(mb);
    }
    if (p.mtime) wrap.append(h('div', 'pgv-foot', `PROGRESS.md · ${new Date(p.mtime).toLocaleString('ja-JP')} 更新`));
    return wrap;
  }

  function table(p, o = {}) {
    const id = o.id || '';
    if (!open.has(id)) return null;
    const key = JSON.stringify([p.mtime || 0, p.rows.length, p.done, p.total, [...filterOf(id)], filters.has(id), more.get(id) || 0, p.mtime ? '' : p.rows.map((r) => [r.n, r.state, r.item, r.next, r.updated])]);
    let c = cache.get(id);
    if (!c || c.key !== key) {
      c = { key, el: build(p, id) };
      cache.set(id, c);
    }
    return c.el.cloneNode(true);
  }

  // one listener for every table (the drawn tables are copies)
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('[data-pgv-chip], [data-pgv-more], [data-pgv-fold]') : null;
    const wrap = t && t.closest('.pgv-panel');
    if (!wrap) return;
    const id = wrap.dataset.pgv || '';
    if (t.dataset.pgvChip) {
      const st = t.dataset.pgvChip;
      if (st === '*') filters.set(id, new Set());
      else {
        // from the default (完了以外) or すべて, a chip shows that state alone; then chips add / remove states
        const f = isDefault(id) || !filterOf(id).size ? new Set() : new Set(filterOf(id));
        if (f.has(st)) f.delete(st);
        else f.add(st);
        if (f.size) filters.set(id, f);
        else filters.delete(id); // nothing chosen -> back to the default
      }
      more.delete(id);
    } else if (t.dataset.pgvMore) more.set(id, (more.get(id) || 0) + ROWS);
    else if (t.dataset.pgvFold) more.delete(id);
    const fn = toggles.get(id);
    if (fn) fn();
  });

  const sig = () => JSON.stringify([[...open], [...filters].map(([k, v]) => [k, [...v]]), [...more]]);
  window.ProgressView = { line, table, isOpen: (id) => open.has(id), sig };
})();
