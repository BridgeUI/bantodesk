'use strict';
// The dashboard's エージェント tab (roadmap 13, docs/plan-agents-view.md). Owner: core.
// Every open folder's sessions with their Agent Teams team (members) and subagents, by state.
//   関係図 (default): folder = lane, session = box, members / subagents = pills inside (parent-child = nesting);
//                    clicking a pill shows what it is doing under the box.
//   一覧: the same tree as table rows (folder → session → team members / subagents).
// Data: the dashboard's folder rows (dashboard.js rows(): sessions with `kind`, plus WidgetState fields
// `agents` { subagents, team }, `doing`, `contextPct`, `costUsd` from widget.js sessionOf).
// Waiting for confirmation is known per session only (a member's permission prompt shows in the lead's screen).
//
// window.AgentsView.body(rows, { api, rerender }) -> HTMLElement; counts(rows) -> { wait, run, all }
(() => {
  // the state words (UX5: the word table's, the same as the dashboard's session rows; not the old 確認待ち / 実行中 / 待機)
  const W = (k, d) => (window.Labels && window.Labels.WORDS && window.Labels.WORDS[k]) || d;
  const ST_JA = { wait: W('yourTurn', '要対応'), err: W('error', 'エラー'), run: W('running', '動作中'), idle: '待機中', done: W('done', '完了') };
  const ORDER = { wait: 0, err: 1, run: 2, idle: 3, done: 4 };
  const LS = 'agentsView';
  let opt = { mode: 'graph', waitOnly: false, foldDone: true };
  try {
    opt = { ...opt, ...JSON.parse(localStorage.getItem(LS) || '{}') };
  } catch {}
  let sel = ''; // selected pill (関係図): `${wcId}/${tabId}/${kind}/${id}`
  const save = () => {
    try {
      localStorage.setItem(LS, JSON.stringify(opt));
    } catch {}
  };

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }
  const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
  function rel(ts) {
    if (!ts) return '';
    const d = Date.now() - ts;
    if (d < 60e3) return 'たった今';
    if (d < 3600e3) return `${Math.floor(d / 60e3)}分前`;
    if (d < 86400e3) return `${Math.floor(d / 3600e3)}時間前`;
    return `${Math.floor(d / 86400e3)}日前`;
  }
  const ktok = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n || 0));
  const toolText = (t) => (t ? `${t.name}${t.arg ? ` ${t.arg}` : ''}` : '');

  // dashboard kindOf -> state; panel / transcript status -> state
  // fin (完了: claude stopped after 作業完了, PROGRESS 35) / rest (休止中, 31) / off -> 完了, not 待機
  const sessSt = (k) => (k === 'input' ? 'wait' : k === 'error' ? 'err' : k === 'busy' ? 'run' : k === 'off' || k === 'fin' || k === 'rest' ? 'done' : 'idle');
  const agentSt = (s) => (s === 'running' || s === 'starting' ? 'run' : s === 'idle' ? 'idle' : s === 'error' ? 'err' : 'done');
  const byState = (a, b) => ORDER[a.st] - ORDER[b.st] || (b.at || 0) - (a.at || 0);

  // folder rows -> [{ folder, name, sessions: [{ s, st, team, members, subs }] }]
  function model(rows) {
    const out = [];
    for (const r of rows) {
      if (!r.sessions.length) continue;
      const sessions = r.sessions.map((s) => {
        const a = s.agents || {};
        const team = a.team || null;
        const members = (team ? team.members : [])
          .map((m) => ({ kind: 'member', id: m.agentId || m.name, name: m.name, st: agentSt(m.status), at: m.updatedAt, m }))
          .sort(byState);
        const subs = (a.subagents || [])
          .map((x) => ({ kind: 'sub', id: x.agentId || '', name: x.agentType || 'agent', st: agentSt(x.status), at: x.updatedAt, m: x }))
          .sort(byState);
        return { s, st: sessSt(s.kind), team, members, subs };
      });
      out.push({ folder: r.folder, name: baseName(r.folder), sessions });
    }
    return out;
  }

  function counts(rows) {
    const c = { wait: 0, run: 0, all: 0, sessions: 0, teams: 0, folders: 0 };
    for (const f of model(rows)) {
      const live = f.sessions.filter((x) => x.s.kind !== 'fin' && x.s.kind !== 'rest');
      if (live.length) c.folders++;
      for (const x of live) {
        // 完了 / 休止中 sessions (claude stopped) are not counted (PROGRESS 35)
        c.sessions++;
        if (x.team && !x.team.removed) c.teams++;
        for (const y of [x, ...x.members, ...x.subs]) {
          c.all++;
          if (y.st === 'wait') c.wait++;
          if (y.st === 'run') c.run++;
        }
      }
    }
    return c;
  }

  const dot = (st) => h('span', `agv-dot agv-s-${st}`);
  const stWord = (st) => h('span', `agv-t-${st}`, ST_JA[st]);
  const shown = (y) => !(opt.foldDone && y.st === 'done');

  function body(rows, ctx) {
    const { api, rerender } = ctx;
    const focus = (s, extra) => api.dashboardFocus?.({ wcId: s.wcId, tabId: s.tabId, from: 'agents', ...(extra || {}) }); // from: UA1
    const wrap = h('div', 'agv');
    const c = counts(rows);

    // toolbar: totals, view switch, filters
    const bar = h('div', 'agv-bar');
    const tot = h('span', 'agv-tot');
    const num = (n, label, cls) => {
      const s = h('span', n && cls ? cls : '');
      s.append(h('b', '', String(n)), document.createTextNode(label));
      tot.append(s);
    };
    num(c.wait, ST_JA.wait, 'agv-t-wait');
    num(c.run, ST_JA.run);
    num(c.all, `エージェント（${c.folders} フォルダ・${c.sessions} セッション・${c.teams} チーム）`);
    const sw = h('span', 'agv-sw');
    for (const [m, label] of [['graph', '関係図'], ['list', '一覧']]) {
      const b = h('button', opt.mode === m ? 'on' : '', label);
      b.type = 'button';
      b.addEventListener('click', () => {
        opt.mode = m;
        save();
        rerender();
      });
      sw.append(b);
    }
    const check = (label, k) => {
      const l = h('label', 'agv-chk');
      const i = h('input');
      i.type = 'checkbox';
      i.checked = !!opt[k];
      i.addEventListener('change', () => {
        opt[k] = i.checked;
        save();
        rerender();
      });
      l.append(i, document.createTextNode(label));
      return l;
    };
    bar.append(sw, check(`${ST_JA.wait}だけ`, 'waitOnly'), check('終わったものを畳む', 'foldDone'), h('span', 'agv-sp'), tot);
    wrap.append(bar);

    let folders = model(rows);
    if (opt.waitOnly) folders = folders.map((f) => ({ ...f, sessions: f.sessions.filter((x) => x.st === 'wait') })).filter((f) => f.sessions.length);
    if (!folders.length) {
      wrap.append(h('div', 'agv-empty', opt.waitOnly ? `${ST_JA.wait}のセッションはありません。` : '開いているセッションがありません。'));
      return wrap;
    }
    wrap.append(opt.mode === 'list' ? list(folders, focus) : graph(folders, focus, rerender));
    return wrap;
  }

  // what an idle session waits for (session.wait, main's waits.js): { text, short, level }; null when not idle
  const waitOf = (x) => (x.st === 'idle' && x.s.status === 'idle' && x.s.wait && typeof x.s.wait === 'object' ? x.s.wait : null);
  const waitText = (w) => String(w.text || w.short || '').replace(/^待機中\s*[—–-]\s*/, '');
  const sessNow = (x) => {
    if (x.st === 'wait') return x.s.question || x.s.text || '';
    if (x.s.kind === 'rest') return '休止中（claude を止めています。開くと再開）'; // PROGRESS 31
    const w = waitOf(x);
    return w ? waitText(w) : x.s.doing || '';
  };

  // ---- 関係図 --------------------------------------------------------------------------------
  function graph(folders, focus, rerender) {
    const lanes = h('div', 'agv-lanes');
    for (const f of folders) {
      const lane = h('div', 'agv-lane');
      const head = h('div', 'agv-lane-h', f.name);
      head.title = f.folder;
      const nw = f.sessions.filter((x) => x.st === 'wait').length;
      const cnt = h('span', 'agv-cnt', `${f.sessions.length} セッション`);
      if (nw) cnt.append(h('span', 'agv-t-wait', ` ・ ${ST_JA.wait} ${nw}`));
      head.append(cnt);
      const lb = h('div', 'agv-lane-b');
      for (const x of f.sessions) lb.append(box(x, focus, rerender));
      lane.append(head, lb);
      lanes.append(lane);
    }
    return lanes;
  }

  function box(x, focus, rerender) {
    const s = x.s;
    const small = x.st === 'done' && opt.foldDone;
    const el = h('div', `agv-box agv-b-${x.st}${small ? ' agv-small' : ''}`);
    const head = h('div', 'agv-box-h');
    const t = h('button', 'agv-title', s.label || '(無題)');
    t.type = 'button';
    t.title = `${s.label}\nクリックでタブを開く`;
    t.addEventListener('click', () => focus(s));
    head.append(dot(x.st), t);
    if (!small && s.contextPct) head.append(h('span', 'agv-num', `${s.contextPct}%`));
    el.append(head);
    if (small) return el;
    const now = h('div', 'agv-now');
    now.append(stWord(x.st));
    const w = waitOf(x);
    const nt = sessNow(x);
    // the box is narrow: the short form of the wait (「コマンド 26分」), the whole sentence on hover
    if (w) now.append(document.createTextNode(' ・ '), h('span', `agv-wait${w.level === 'warn' ? ' warn' : ''}`, w.short || waitText(w)));
    else if (nt) now.append(document.createTextNode(` ・ ${nt}`));
    now.title = w ? String(w.text || '') : nt;
    el.append(now);
    // UX5: answered only on あなたの番; the box points there
    if (x.st === 'wait' && (s.options || []).length && window.Dashboard?.turnLink) el.append(window.Dashboard.turnLink());
    const key = (y) => `${s.wcId}/${s.tabId}/${y.kind}/${y.id || y.name}`;
    const pills = (items, cls) => {
      const p = h('div', 'agv-pills');
      for (const y of items.filter(shown)) {
        const b = h('button', `agv-pill agv-p-${y.st}${cls ? ` ${cls}` : ''}${sel === key(y) ? ' on' : ''}`);
        b.type = 'button';
        b.title = `${y.name}（${ST_JA[y.st]}）`;
        b.append(dot(y.st), h('span', '', y.name));
        b.addEventListener('click', () => {
          sel = sel === key(y) ? '' : key(y);
          rerender();
        });
        p.append(b);
      }
      const hid = items.length - items.filter(shown).length;
      if (hid) p.append(h('span', 'agv-hid', `＋完了 ${hid}`));
      return p;
    };
    if (x.team) {
      const g = h('div', 'agv-grp');
      g.append(h('div', 'agv-grp-h agv-team', `チーム ${x.team.name}${x.team.removed ? '（解散）' : ''}`), pills(x.members));
      el.append(g);
    }
    if (x.subs.length) {
      const g = h('div', 'agv-grp');
      g.append(h('div', 'agv-grp-h', 'サブエージェント'), pills(x.subs, 'agv-sub'));
      el.append(g);
    }
    const picked = [...x.members, ...x.subs].find((y) => sel === key(y));
    if (picked) el.append(detail(s, picked, focus));
    return el;
  }

  function detail(s, y, focus) {
    const d = h('div', 'agv-detail');
    const m = y.m;
    const top = h('div', 'agv-d-h');
    top.append(dot(y.st), h('b', '', y.name));
    if (m.agentType && m.agentType !== y.name) top.append(h('span', 'agv-num', m.agentType));
    top.append(stWord(y.st));
    d.append(top);
    const what = m.summary || m.description || '';
    if (what) d.append(h('div', 'agv-d-what', what));
    const meta = [toolText(m.lastTool) && `最後のツール: ${toolText(m.lastTool)}`, m.tokens ? `出力 ${ktok(m.tokens)} トークン` : '', rel(m.updatedAt)].filter(Boolean);
    if (meta.length) d.append(h('div', 'agv-num', meta.join(' ・ ')));
    if (m.agentId) {
      const b = h('button', 'agv-link', '会話を見る');
      b.type = 'button';
      b.addEventListener('click', () => focus(s, { agentId: m.agentId, name: y.name }));
      d.append(b);
    }
    return d;
  }

  // ---- 一覧 ----------------------------------------------------------------------------------
  function list(folders, focus) {
    const t = h('table', 'agv-table');
    const cg = h('colgroup');
    for (const w of ['32%', '76px', '', '170px', '96px']) {
      const col = h('col');
      if (w) col.style.width = w;
      cg.append(col);
    }
    t.append(cg);
    const hr = h('tr');
    for (const x of ['名前', '状態', 'いまの作業', 'コンテキスト / トークン', '']) hr.append(h('th', '', x));
    t.append(hr);
    const row = (cls, depth, st, nameEls, nowText, numText, act) => {
      const tr = h('tr', cls);
      const td = h('td');
      const nm = h('div', 'agv-nm');
      nm.style.paddingLeft = `${depth * 18}px`;
      if (st) nm.append(dot(st));
      nm.append(...nameEls);
      td.append(nm);
      const ts = h('td');
      if (st) ts.append(stWord(st));
      const tn = h('td', 'agv-now', nowText || '');
      tn.title = nowText || '';
      tr.append(td, ts, tn, h('td', 'agv-num', numText || ''), act || h('td'));
      t.append(tr);
      return tr;
    };
    const link = (label, fn) => {
      const td = h('td');
      const b = h('button', 'agv-link', label);
      b.type = 'button';
      b.addEventListener('click', fn);
      td.append(b);
      return td;
    };
    for (const f of folders) {
      const nw = f.sessions.filter((x) => x.st === 'wait').length;
      const tr = h('tr', 'agv-folder');
      const td = h('td', '', f.name);
      td.colSpan = 5;
      td.title = f.folder;
      const cnt = h('span', 'agv-cnt', `${f.sessions.length} セッション`);
      if (nw) cnt.append(h('span', 'agv-t-wait', ` ・ ${ST_JA.wait} ${nw}`));
      td.append(cnt);
      tr.append(td);
      t.append(tr);
      for (const x of f.sessions) {
        const s = x.s;
        const nums = [s.contextPct ? `${s.contextPct}%` : '', s.costUsd ? `$${s.costUsd}` : '', s.memMb ? `${s.memMb}MB` : ''].filter(Boolean).join(' ・ ');
        const sr = row(`agv-sess agv-r-${x.st}`, 0, x.st, [h('span', '', s.label || '(無題)')], sessNow(x), nums, link(x.st === 'wait' ? '答える' : 'タブを開く', () => focus(s)));
        if (waitOf(x)?.level === 'warn') sr.classList.add('agv-wait-warn');
        if (x.st === 'done' && opt.foldDone) continue;
        const agentRow = (y, depth, tag) => {
          const els = [];
          if (tag) els.push(h('span', 'agv-kind', tag));
          els.push(h('span', '', y.name));
          const m = y.m;
          const nowText = [m.summary || m.description, toolText(m.lastTool)].filter(Boolean).join(' ・ ');
          row(`agv-agent agv-r-${y.st}`, depth, y.st, els, nowText, m.tokens ? ktok(m.tokens) : '', m.agentId ? link('会話を見る', () => focus(s, { agentId: m.agentId, name: y.name })) : null);
        };
        if (x.team) {
          const live = x.members.filter((y) => y.st === 'run' || y.st === 'idle').length;
          row('agv-teamrow', 1, null, [h('span', 'agv-kind agv-team', 'チーム'), h('span', 'agv-mono', x.team.name)], `${live} / ${x.members.length} 人が動いている`, '', null);
          for (const y of x.members.filter(shown)) agentRow(y, 2, '');
          const hid = x.members.length - x.members.filter(shown).length;
          if (hid) row('agv-hidrow', 2, null, [h('span', 'agv-hid', `＋完了 ${hid} 人`)], '', '', null);
        }
        for (const y of x.subs.filter(shown)) agentRow(y, 1, 'サブ');
        const hs = x.subs.length - x.subs.filter(shown).length;
        if (hs) row('agv-hidrow', 1, null, [h('span', 'agv-hid', `＋完了したサブエージェント ${hs}`)], '', '', null);
      }
    }
    return t;
  }

  window.AgentsView = { body, counts, _model: model };
})();
