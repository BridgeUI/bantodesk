'use strict';
// The dashboard's エージェント tab (roadmap 13, docs/plan-agents-view.md). Owner: core.
// Every open folder's sessions with their Agent Teams team (members) and subagents, by state.
//   関係図 (default): folder = lane, session = box; inside it, an arrow from the session to each team member, subagent
//                    and background command (依頼-481), each one a small box with its state and time. The arrow's colour
//                    is the child's state (blue moving = 指示中 / 実行中, peach = 止まっている, red = エラー, grey = 待機・終わった).
//                    Above the lanes sits the ルーター's box (AGV-ROUTER, 依頼-493): each session it gave work to (its active backlog item)
//                    gets an arrow from it (blue moving 指示中 while the task runs) and a small mark for what it just did
//                    to it (声をかけた / 止めて声をかけた / 確認に答えた, 10 minutes). From the backlog + 「ルーターの記録」 only.
//                    Clicking a member / subagent shows what it is doing under the box; a command opens the session's tab.
//   一覧: the same tree as table rows (folder → session → team members / subagents).
// Data: the dashboard's folder rows (dashboard.js rows(): sessions with `kind`, plus WidgetState fields
// `agents` { subagents, team }, `doing`, `contextPct`, `costUsd`, `cmds` from widget.js sessionOf).
// Commands: the session's background commands from its transcript (Panel.summary cmds: running + ended in the last 15 min),
// 止まっている from main's waits.js alerts (silent / gone) on the session's wait — no process list of its own (EDR rules).
// Waiting for confirmation is known per session only (a member's permission prompt shows in the lead's screen).
//
// window.AgentsView.body(rows, { api, rerender, log }) -> HTMLElement; (log = the dashboard's ルーターの記録 entries) counts(rows) -> { wait, run, all }
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
  // ms -> 「26分」「1時間5分」「1分未満」 (the same steps as waits.js durShort)
  function span(ms) {
    const m = Math.floor(Math.max(0, ms) / 60e3);
    if (m < 1) return '1分未満';
    if (m < 60) return `${m}分`;
    return `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}`;
  }
  // a command's text for its box: first line, long absolute paths as their last two parts (waits.js cmdLabel)
  function cmdLabel(c) {
    const t = String(c || '').split(/\r?\n/)[0].trim().split(/\s+/)
      .map((w) => {
        const parts = w.replace(/\\/g, '/').split('/');
        return w.length > 24 && parts.length > 3 && /^([A-Za-z]:|~)?$/.test(parts[0]) ? '…/' + parts.slice(-2).join('/') : w;
      })
      .join(' ');
    return t || '（コマンド）';
  }
  // the command's own words (依頼-481): 動いている / 止まっている / 終わった
  const CMD_JA = { run: '動いている', stall: '止まっている', done: '終わった', err: '失敗' };
  const CMD_ORDER = { stall: 0, run: 1, err: 2, done: 3 };

  // dashboard kindOf -> state; panel / transcript status -> state
  // fin (完了: claude stopped after 作業完了, PROGRESS 35) / rest (休止中, 31) / off -> 完了, not 待機
  const sessSt = (k) => (k === 'input' ? 'wait' : k === 'error' ? 'err' : k === 'busy' ? 'run' : k === 'off' || k === 'fin' || k === 'rest' ? 'done' : 'idle');
  const agentSt = (s) => (s === 'running' || s === 'starting' ? 'run' : s === 'idle' ? 'idle' : s === 'error' ? 'err' : 'done');
  const byState = (a, b) => ORDER[a.st] - ORDER[b.st] || (b.at || 0) - (a.at || 0);

  // a team is shown while it has members (or was disbanded); the lead-only team Claude Code makes per session is not
  const teamShown = (x) => !!x.team && (x.team.removed || x.members.length > 0);

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
          .map((x) => ({ kind: 'sub', id: x.agentId || '', name: x.teamName || x.agentType || 'agent', st: agentSt(x.status), at: x.updatedAt, m: x }))
          .sort(byState);
        return { s, st: sessSt(s.kind), team, members, subs, cmds: cmdsOf(s) };
      });
      out.push({ folder: r.folder, name: baseName(r.folder), backlog: r.backlog || [], sessions });
    }
    return out;
  }

  // session -> [{ kind: 'cmd', id, name, st, at, c, why }] newest first by state. A running command of an idle session that
  // main's wait does not list belongs to an earlier claude of the tab (waits.js: started before its pty) and is left out.
  function cmdsOf(s) {
    const w = s.wait && typeof s.wait === 'object' ? s.wait : null;
    const alerts = w && Array.isArray(w.alerts) ? w.alerts : [];
    const listed = w && Array.isArray(w.items) && w.kind !== 'running' ? new Set(w.items.filter((i) => i && i.type === 'command').map((i) => i.id)) : null;
    const out = [];
    for (const c of Array.isArray(s.cmds) ? s.cmds : []) {
      if (!c || !c.id) continue;
      const running = c.status === 'running';
      if (running && listed && s.status === 'idle' && !listed.has(c.id)) continue;
      let st = running ? 'run' : c.status === 'completed' || c.status === 'exited' ? 'done' : 'err';
      let why = '';
      if (running) {
        const a = alerts.find((x) => x && (x.ref === `${c.id}:gone` || x.ref === `${c.id}:silent`));
        if (a) {
          st = 'stall';
          why = a.code === 'gone' ? 'プロセスが無い' : '出力が止まっている';
          why = { short: why, text: String(a.text || '') };
        }
      }
      out.push({ kind: 'cmd', id: c.id, name: cmdLabel(c.command), st, at: c.startedAt || 0, c, why: why || null });
    }
    return out.sort((a, b) => CMD_ORDER[a.st] - CMD_ORDER[b.st] || (b.at || 0) - (a.at || 0));
  }

  // ---- ルーター → セッション (AGV-ROUTER, 依頼-493) ----------------------------------------------------
  // What the app already holds, nothing looked up: the folder's backlog (an active item with the session's tabId = the ルーター
  // gave it this work) and the 「ルーターの記録」 lines of the last 10 minutes (answer / nudge / interrupt carry the session's tabKey).
  const PUSH_MS = 10 * 60e3;
  const PUSH_JA = { nudge: '声をかけた', interrupt: '止めて声をかけた', answer: '確認に答えた' };
  function routerOf(f, x, log, now) {
    const tabId = String(x.s.tabId ?? '');
    const item = tabId ? (f.backlog || []).find((i) => i && i.status === 'active' && String(i.tabId ?? '') === tabId) || null : null;
    const marks = [];
    for (const e of Array.isArray(log) ? log : []) {
      if (!e || !PUSH_JA[e.type] || e.bad || !tabId || String(e.tabKey || '') !== tabId || !(now - e.at < PUSH_MS) || now < e.at) continue;
      marks.push({ type: e.type, at: e.at, word: PUSH_JA[e.type], text: e.title || '' });
    }
    marks.sort((a, b) => b.at - a.at);
    if (!item && !marks.length) return null;
    return { item, marks, st: item ? 'run' : 'idle' };
  }
  const taskName = (i) => [i.no, i.title].filter(Boolean).join(' ') || i.id || '';

  function counts(rows) {
    const c = { wait: 0, run: 0, all: 0, sessions: 0, teams: 0, folders: 0, cmd: 0, cmdRun: 0, cmdStall: 0 };
    for (const f of model(rows)) {
      const live = f.sessions.filter((x) => x.s.kind !== 'fin' && x.s.kind !== 'rest');
      if (live.length) c.folders++;
      for (const x of live) {
        // 完了 / 休止中 sessions (claude stopped) are not counted (PROGRESS 35)
        c.sessions++;
        if (teamShown(x) && !x.team.removed) c.teams++;
        for (const y of [x, ...x.members, ...x.subs]) {
          c.all++;
          if (y.st === 'wait') c.wait++;
          if (y.st === 'run') c.run++;
        }
        for (const y of x.cmds) {
          if (y.st === 'done' || y.st === 'err') continue;
          c.cmd++;
          if (y.st === 'run') c.cmdRun++;
          if (y.st === 'stall') c.cmdStall++;
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
    // 依頼-481: the commands that run now; the stopped ones in peach
    if (c.cmd) {
      num(c.cmd, "コマンド");
      if (c.cmdStall) num(c.cmdStall, CMD_JA.stall, 'agv-t-stall');
    }
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
    wrap.append(opt.mode === 'list' ? list(folders, focus) : graph(folders, focus, rerender, ctx.log));
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

  // a command's state word and time: 「動いている」「開始から 3分」 / 「終わった」「2分で 5分前」
  function cmdWords(y) {
    const c = y.c;
    const ended = y.st === 'done' || y.st === 'err';
    const word = y.st === 'err' ? `${CMD_JA.done}（${c.status === 'failed' ? '失敗' : '止めた'}）` : CMD_JA[y.st];
    const t = ended
      ? [c.endedAt && c.startedAt ? `${span(c.endedAt - c.startedAt)}で終了` : '', rel(c.endedAt)].filter(Boolean).join(' ・ ')
      : c.startedAt
        ? `開始から ${span(Date.now() - c.startedAt)}`
        : '';
    return { word, t };
  }

  // ---- 関係図 --------------------------------------------------------------------------------
  function graph(folders, focus, rerender, log) {
    const now = Date.now();
    const lanes = h('div', 'agv-lanes');
    let nRun = 0;
    let nMark = 0;
    for (const f of folders) for (const x of f.sessions) {
      x.rt = routerOf(f, x, log, now);
      if (x.rt && x.rt.item) nRun++;
      if (x.rt) nMark += x.rt.marks.length;
    }
    // the ルーター's box: who it is working through now (the arrows below start here)
    const rb = h('div', 'agv-router');
    rb.append(h('span', 'agv-router-n', 'ルーター'));
    rb.append(h('span', 'agv-router-s', nRun ? `${nRun} セッションに指示中` : '指示中のセッションはありません'));
    if (nMark) rb.append(h('span', 'agv-mark', `後押し ${nMark}（10分以内）`));
    rb.title = 'ルーターが作業を振り分けたセッションへ、上から矢印が出ます（青＝振り分けた作業が進行中）。声をかけた・止めた・確認に答えた直後の 10 分は印が付きます。';
    lanes.append(rb);
    for (const f of folders) {
      const lane = h('div', 'agv-lane');
      const head = h('div', 'agv-lane-h', f.name);
      head.title = f.folder;
      const nw = f.sessions.filter((x) => x.st === 'wait').length;
      const cnt = h('span', 'agv-cnt', `${f.sessions.length} セッション`);
      if (nw) cnt.append(h('span', 'agv-t-wait', ` ・ ${ST_JA.wait} ${nw}`));
      head.append(cnt);
      const lb = h('div', 'agv-lane-b');
      for (const x of f.sessions) lb.append(box(x, focus, rerender, f));
      lane.append(head, lb);
      lanes.append(lane);
    }
    return lanes;
  }

  function box(x, focus, rerender) {
    const s = x.s;
    const rt = x.rt || null;
    const small = x.st === 'done' && opt.foldDone;
    const el = h('div', `agv-box agv-b-${x.st}${small ? ' agv-small' : ''}${rt ? ' agv-routed' : ''}`);
    // the arrow from the ルーター: its task while it runs (指示中), a mark per recent push
    if (rt) {
      const rin = h('div', 'agv-rin');
      const arrow = h('span', `agv-redge agv-e-${rt.st}`);
      rin.append(arrow);
      const lab = h('span', 'agv-rin-t');
      if (rt.item) {
        lab.append(h('span', 'agv-rin-run', '指示中'), document.createTextNode(` ・ ${taskName(rt.item)}`));
        lab.title = `ルーターが振り分けた作業: ${taskName(rt.item)}（進行中）`;
      } else lab.append(h('span', 'agv-t-idle', 'ルーターから'));
      rin.append(lab);
      for (const m of rt.marks.slice(0, 2)) {
        const mk = h('span', `agv-mark agv-mk-${m.type}`, `${m.word} ${rel(m.at)}`);
        mk.title = m.text;
        rin.append(mk);
      }
      el.append(rin);
    }
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
    // one child: the arrow from the session (its colour = the child's state; 指示中 / 実行中 while it works) and its box
    const edge = (y) => {
      const e = h('span', `agv-edge agv-e-${y.st}`);
      const verb = y.st === 'run' ? (y.kind === 'cmd' ? '実行中' : '指示中') : '';
      if (verb) e.append(h('span', 'agv-e-l', verb));
      return e;
    };
    const agentNode = (y, cls) => {
      const b = h('button', `agv-pill agv-node agv-n-${y.st} agv-p-${y.st}${cls ? ` ${cls}` : ''}${sel === key(y) ? ' on' : ''}`);
      b.type = 'button';
      const m = y.m || {};
      const what = m.summary || m.description || toolText(m.lastTool) || '';
      b.title = `${y.name}（${ST_JA[y.st]}）${what ? `\n${what}` : ''}`;
      // a subagent started at a known time: 「開始から N分」 while it works; otherwise its last move
      const t = y.st === 'run' && y.kind === 'sub' && m.startedAt ? `開始から ${span(Date.now() - m.startedAt)}` : rel(m.updatedAt);
      if (y.kind === 'sub' && m.teamName) b.title = `チームメンバー ${b.title}`;
      b.append(dot(y.st), h('span', 'agv-n-name', y.name), h('span', `agv-n-st agv-t-${y.st}`, ST_JA[y.st]));
      if (y.kind === 'sub' && m.teamName) b.append(h('span', 'agv-kind', 'チームメンバー'));
      if (t) b.append(h('span', 'agv-n-t', t));
      b.addEventListener('click', () => {
        sel = sel === key(y) ? '' : key(y);
        rerender();
      });
      return b;
    };
    const cmdNode = (y) => {
      const c = y.c;
      const b = h('button', `agv-node agv-cmd agv-n-${y.st}`);
      b.type = 'button';
      const { word, t } = cmdWords(y);
      b.title = [String(c.command || ''), `${word}${t ? ` ・ ${t}` : ''}`, y.why ? y.why.text : '', 'クリックでタブを開く'].filter(Boolean).join('\n');
      b.append(dot(y.st), h('span', 'agv-n-name', y.name), h('span', `agv-n-st agv-t-${y.st}`, y.why ? `${word}（${y.why.short}）` : word));
      if (t) b.append(h('span', 'agv-n-t', t));
      b.addEventListener('click', () => focus(s));
      return b;
    };
    const group = (title, titleCls, items, node, hidWord) => {
      const g = h('div', 'agv-grp');
      g.append(h('div', `agv-grp-h${titleCls ? ` ${titleCls}` : ''}`, title));
      for (const y of items.filter(shown)) {
        const r = h('div', 'agv-row');
        r.append(edge(y), node(y));
        g.append(r);
      }
      const hid = items.length - items.filter(shown).length;
      if (hid) {
        const r = h('div', 'agv-row agv-row-hid');
        r.append(h('span', 'agv-edge agv-e-done'), h('span', 'agv-hid', `＋${hidWord} ${hid}`));
        g.append(r);
      }
      el.append(g);
    };
    if (teamShown(x)) {
      // AGV-TEAM: a team with nobody but its lead (Claude Code makes one per session) has no head; a disbanded one keeps its note
      const nm = x.members.length;
      group(`チーム ${x.team.name}${x.team.removed ? '（解散）' : ` ・ ${nm} 人`}`, 'agv-team', x.members, (y) => agentNode(y), '完了');
    }
    if (x.subs.length) group('サブエージェント', '', x.subs, (y) => agentNode(y, 'agv-sub'), '完了');
    if (x.cmds.length) group('コマンド', 'agv-cmds', x.cmds, cmdNode, CMD_JA.done);
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
    for (const w of ['30%', '120px', '', '160px', '96px']) {
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
        if (teamShown(x)) {
          const live = x.members.filter((y) => y.st === 'run' || y.st === 'idle').length;
          row('agv-teamrow', 1, null, [h('span', 'agv-kind agv-team', 'チーム'), h('span', 'agv-mono', x.team.name)], `${live} / ${x.members.length} 人が動いている`, '', null);
          for (const y of x.members.filter(shown)) agentRow(y, 2, '');
          const hid = x.members.length - x.members.filter(shown).length;
          if (hid) row('agv-hidrow', 2, null, [h('span', 'agv-hid', `＋完了 ${hid} 人`)], '', '', null);
        }
        for (const y of x.subs.filter(shown)) agentRow(y, 1, y.m.teamName ? 'チームメンバー' : 'サブ');
        const hs = x.subs.length - x.subs.filter(shown).length;
        if (hs) row('agv-hidrow', 1, null, [h('span', 'agv-hid', `＋完了したサブエージェント ${hs}`)], '', '', null);
        // 依頼-481: the background commands (動いている / 止まっている / 終わった, from the transcript and main's waits)
        for (const y of x.cmds.filter(shown)) {
          const { word, t } = cmdWords(y);
          const tr = row(`agv-agent agv-cmdrow agv-r-${y.st}`, 1, y.st, [h('span', 'agv-kind', 'コマンド'), h('span', 'agv-mono', y.name)], [y.why && y.why.short, t].filter(Boolean).join(' ・ '), '', link('タブを開く', () => focus(s)));
          tr.children[1].replaceChildren(h('span', `agv-t-${y.st}`, word));
          tr.children[2].title = [y.c.command, y.why && y.why.text].filter(Boolean).join('\n');
        }
        const hc = x.cmds.length - x.cmds.filter(shown).length;
        if (hc) row('agv-hidrow', 1, null, [h('span', 'agv-hid', `＋終わったコマンド ${hc}`)], '', '', null);
      }
    }
    return t;
  }

  window.AgentsView = { body, counts, _model: model, _teamShown: teamShown, _routerOf: routerOf };
})();
