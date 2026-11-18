'use strict';
// The dashboard's 全体図 tab (roadmap 14, docs/plan-overview-map.md 第 1 段). Owner: core.
// 上の帯（受付・振り分け・作業中・要対応・今日の完了）→ ルーター → フォルダの島（2 列。項目 → 作業 → 担当）。
// Data: main's overview:get (src/main/overview.js buildOverview), rules only (no LLM). The view keeps the last result and
// asks again at most once a second while it is drawn (a draw it caused itself does not ask again).
//   window.OverviewView.body({ api, rerender, openGraph(folder), openFolder(folder), openRequests() }) -> HTMLElement
//   window.OverviewView.sig() -> string (the data signature the dashboard's redraw check includes)
(() => {
  const W = (k, d) => (window.Labels && window.Labels.WORDS && window.Labels.WORDS[k]) || d;
  const GAP_MS = 1000;
  let data = null;
  let dataJson = '';
  let inflight = false;
  let lastAsk = 0;
  let own = false; // the next body() was drawn because of our own result: do not ask again at once
  let timer = 0;

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }

  function ask(o) {
    if (inflight || !o.api || !o.api.overviewGet) return;
    const wait = lastAsk + GAP_MS - Date.now();
    if (wait > 0) {
      if (!timer) timer = setTimeout(() => ((timer = 0), ask(o)), wait);
      return;
    }
    inflight = true;
    lastAsk = Date.now();
    Promise.resolve(o.api.overviewGet())
      .then((r) => {
        const json = JSON.stringify(r ? { ...r, updatedAt: 0 } : null);
        data = r || data;
        if (json !== dataJson) {
          dataJson = json;
          own = true;
          o.rerender();
        }
      })
      .catch(() => {})
      .finally(() => {
        inflight = false;
      });
  }

  const ST = { wait: W('yourTurn', '要対応'), err: W('error', 'エラー'), run: W('running', '動作中'), idle: '待機中', done: W('done', '完了') };
  const STATE_CLS = { 未着手: 'todo', 進行中: 'run', 確認待ち: 'you', 完了: 'done', 保留: 'idle' };

  function band(flow) {
    const row = h('div', 'ovm-band');
    const defs = [
      ['intake', '受付', ''],
      ['routed', '振り分け', ''],
      ['working', '作業中', 'run'],
      ['turn', W('yourTurn', '要対応'), 'you'],
      ['doneToday', '今日の完了', 'done'],
    ];
    for (const [k, label, cls] of defs) {
      const p = (flow && flow[k]) || { n: 0, names: [] };
      const c = h('div', `ovm-stage${cls ? ' ' + cls : ''}`);
      c.dataset.stage = k;
      const top = h('div', 'ovm-stage-top');
      top.append(h('b', 'ovm-n', String(p.n)), h('span', 'ovm-stage-name', label));
      c.append(top, h('div', 'ovm-stage-names', p.names.join('・') + (p.n > p.names.length ? ' …' : '')));
      row.append(c);
    }
    return row;
  }

  function whoRow(w, o, folder) {
    const row = h('div', 'ovm-who');
    const s = w.who && w.who.session;
    if (s) {
      const box = h('span', `ovm-sess st-${s.st}`, s.contextPct != null ? `${s.contextPct}%` : '—');
      box.title = `${s.label || 'セッション'}（${ST[s.st] || s.st}${s.doing ? '・' + s.doing : ''}）`;
      row.append(box);
    }
    for (const m of w.who.members || []) {
      const d = h('span', `ovm-mem st-${m.st}`, [...m.name][0] ? m.name.slice(0, 2) : '·');
      d.title = `${m.name}（${ST[m.st] || m.st}）`;
      row.append(d);
    }
    if (w.who.subagents) row.append(h('span', 'ovm-chip', `サブ ${w.who.subagents}`));
    if (w.who.cmds) row.append(h('span', 'ovm-chip', `コマンド ${w.who.cmds}`));
    if (s && s.doing) row.append(h('span', 'ovm-doing', s.doing));
    return row;
  }

  function workCard(w, o, folder) {
    const st = w.status === 'done' ? 'done' : w.status === 'failed' ? 'err' : w.who.session && w.who.session.st === 'wait' ? 'wait' : 'run';
    const b = h('button', `ovm-work st-${st}`);
    b.type = 'button';
    b.dataset.work = w.no || w.id;
    b.title = 'このフォルダの関係図を開く';
    const head = h('div', 'ovm-work-head');
    head.append(h('span', 'ovm-no', w.no || ''), h('b', 'ovm-wt', w.title));
    if (w.req) head.append(h('span', 'ovm-req', w.req));
    b.append(head);
    if (w.drift === 'no-owner') b.append(h('div', 'ovm-drift', '進行中なのに担当のセッションが見つからない'));
    if (w.status === 'done') b.append(h('div', 'ovm-sub', '完了'));
    else if (w.status === 'failed') b.append(h('div', 'ovm-sub', '失敗'));
    else b.append(whoRow(w, o, folder));
    b.addEventListener('click', () => o.openGraph(folder));
    return b;
  }

  function island(f, o) {
    const box = h('section', `ovm-island${f.quiet ? ' quiet' : ''}`);
    box.dataset.folder = f.name;
    const head = h('button', 'ovm-ihead');
    head.type = 'button';
    head.title = 'このプロジェクトの画面を開く';
    head.append(h('span', `ovm-dot${f.quiet ? '' : ' run'}`), h('b', 'ovm-iname', f.name));
    if (f.queued) head.append(h('span', 'ovm-chip', `順番待ち ${f.queued}`));
    if (f.quiet) head.append(h('span', 'ovm-quiet', '動いている作業なし'));
    head.addEventListener('click', () => o.openFolder(f.folder));
    box.append(head);
    const p = f.progress;
    if (p && p.total) {
      const bar = h('div', 'ovm-bar');
      const c = p.counts || {};
      for (const k of ['完了', '進行中', '確認待ち', '保留', '未着手']) {
        if (!c[k]) continue;
        const seg = h('i', `seg ${STATE_CLS[k]}`);
        seg.style.flex = String(c[k]);
        seg.title = `${k} ${c[k]}`;
        bar.append(seg);
      }
      box.append(bar, h('div', 'ovm-counts', ['完了', '進行中', '確認待ち', '未着手', '保留'].filter((k) => c[k]).map((k) => `${k} ${c[k]}`).join('  ')));
    }
    for (const g of f.goals) {
      const gr = h('div', 'ovm-goal');
      const gh = h('div', 'ovm-goal-head');
      gh.append(h('span', 'ovm-gno', `#${g.no}`), h('span', 'ovm-gt', g.title), h('span', `ovm-state ${STATE_CLS[g.state] || ''}`, g.state));
      if (g.drift === 'progress-stale') gh.append(h('span', 'ovm-drift', `PROGRESS は${g.state}のまま`));
      gr.append(gh);
      for (const w of g.works) gr.append(workCard(w, o, f.folder));
      box.append(gr);
    }
    if (f.loose.length) {
      const gr = h('div', 'ovm-goal loose');
      gr.append(h('div', 'ovm-goal-head', '目的なし（PROGRESS の項目と結べない作業）'));
      for (const w of f.loose) gr.append(workCard(w, o, f.folder));
      box.append(gr);
    }
    return box;
  }

  function legend() {
    const l = h('div', 'ovm-legend');
    const add = (cls, text) => {
      const s = h('span', 'ovm-leg');
      s.append(h('i', cls), document.createTextNode(text));
      l.append(s);
    };
    add('ovm-sess', 'セッション（コンテキスト %）');
    add('ovm-mem', 'チームのメンバー');
    add('ln', 'ルーター → フォルダ（作業を持っている）');
    add('sq you', W('yourTurn', '要対応'));
    add('sq run', W('running', '動作中'));
    add('sq done', W('done', '完了'));
    return l;
  }

  function body(o) {
    const root = h('div', 'ovm');
    root.dataset.overview = '1';
    if (own) own = false;
    else ask(o);
    if (!data) {
      root.append(h('div', 'ovm-empty', '読み込み中…'));
      return root;
    }
    root.append(band(data.flow));
    const r = h('div', `ovm-router${data.router && data.router.busy ? ' busy' : ''}`);
    r.append(h('span', 'ovm-dot run'), h('b', null, 'ルーター'));
    if (data.router && data.router.nudges) r.append(h('span', 'ovm-chip', `直近 10 分に声かけ ${data.router.nudges}`));
    root.append(r);
    const cols = h('div', 'ovm-cols');
    const a = h('div', 'ovm-col');
    const b = h('div', 'ovm-col');
    let wa = 0;
    let wb = 0;
    for (const f of data.folders) {
      const wt = f.quiet ? 1 : 3 + f.goals.length + f.loose.length + f.goals.reduce((n, g) => n + g.works.length, 0) * 2;
      if (wa <= wb) (a.append(island(f, o)), (wa += wt));
      else (b.append(island(f, o)), (wb += wt));
    }
    cols.append(a, b);
    root.append(cols);
    if (!data.folders.length) root.append(h('div', 'ovm-empty', 'まだプロジェクトがありません'));
    root.append(legend());
    return root;
  }

  window.OverviewView = { body, sig: () => dataJson };
})();
