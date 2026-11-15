/* BantoDesk — LAN remote mobile UI (vanilla JS, no dependencies). */
(function () {
  'use strict';

  var STATUS = {
    asking: { label: '回答待ち', cls: 'asking', order: 0 },
    running: { label: '実行中', cls: 'running', order: 1 },
    starting: { label: '起動中', cls: 'running', order: 2 },
    idle: { label: '待機中', cls: 'idle', order: 3 },
    exited: { label: '終了', cls: 'exited', order: 4 },
  };
  var KEYS = [
    { v: 'up', t: '↑' }, { v: 'down', t: '↓' }, { v: 'enter', t: 'Enter' }, { v: 'esc', t: 'Esc' },
    { v: 'tab', t: 'Tab' }, { v: 'shift-tab', t: '⇧Tab' }, { v: 'ctrl-c', t: 'Ctrl+C', danger: true },
  ];

  var state = null;
  var askingKeys = null; // Set of "wcId:tabId" currently asking (null until first state)
  var route = null; // null = list, or { wcId, tabId }
  var detail = null; // DOM refs of the detail view for in-place updates
  var authLost = false;

  var $ = function (id) { return document.getElementById(id); };
  var view = $('view');

  // ---------- tiny DOM helper ----------
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    if (kids != null) {
      (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
        if (c == null || c === false) return;
        el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
      });
    }
    return el;
  }

  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = isErr ? 'err' : '';
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 2200);
  }

  function st(tab) { return STATUS[tab.status] || { label: tab.status || '?', cls: 'idle', order: 5 }; }
  function keyOf(wcId, tabId) { return wcId + ':' + tabId; }
  function findTab(wcId, tabId) {
    if (!state) return null;
    for (var i = 0; i < state.projects.length; i++) {
      var p = state.projects[i];
      if (p.wcId !== wcId) continue;
      for (var j = 0; j < (p.tabs || []).length; j++) if (p.tabs[j].id === tabId) return { project: p, tab: p.tabs[j] };
    }
    return null;
  }
  function todoProgress(todos) {
    todos = (todos || []).filter(function (t) { return t && t.status !== 'deleted'; });
    var done = todos.filter(function (t) { return t.status === 'completed'; }).length;
    return { done: done, total: todos.length };
  }
  function runningSubs(subs) {
    return (subs || []).filter(function (s) { return s && s.status === 'running'; }).length;
  }
  function pct(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v) : null; }

  // ---------- connection ----------
  function setConn(mode) {
    var c = $('conn');
    var labels = { live: 'ライブ', poll: 'ポーリング', off: '再接続中…', auth: '要再認証' };
    c.className = 'conn ' + mode;
    $('conn-text').textContent = labels[mode] || mode;
  }

  var es = null, sseFails = 0, pollTimer = null, sseRetryTimer = null;
  function startSse() {
    if (authLost) return;
    if (!window.EventSource) return startPolling();
    stopPolling();
    try { es = new EventSource('/api/events'); } catch (e) { return startPolling(); }
    es.addEventListener('open', function () { sseFails = 0; setConn('live'); });
    es.addEventListener('state', function (ev) {
      try { onState(JSON.parse(ev.data)); } catch (e) { /* ignore bad frame */ }
    });
    es.addEventListener('error', function () {
      sseFails++;
      setConn('off');
      if (es.readyState === 2 || sseFails >= 3) {
        es.close(); es = null;
        startPolling();
        clearTimeout(sseRetryTimer);
        sseRetryTimer = setTimeout(startSse, 30000);
      }
    });
  }
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
  function startPolling() {
    stopPolling();
    var tick = function () {
      fetch('/api/state', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) {
          if (r.status === 401) { onAuthLost(); throw new Error('401'); }
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then(function (j) { if (!es) setConn('poll'); onState(j); })
        .catch(function () { if (!authLost && !es) setConn('off'); })
        .then(function () { if (!authLost && !es) pollTimer = setTimeout(tick, 2000); });
    };
    tick();
  }
  function onAuthLost() {
    authLost = true;
    if (es) { es.close(); es = null; }
    stopPolling();
    clearTimeout(sseRetryTimer);
    setConn('auth');
    view.textContent = '';
    detail = null;
    view.appendChild(h('div', { class: 'empty' }, [
      h('h2', { text: '認証が切れました' }),
      h('p', { text: 'トークンが再生成された可能性があります。PC の「Remote」に表示される新しい URL / QR コードを開き直してください。' }),
    ]));
  }

  // ---------- actions ----------
  function sendAction(wcId, tabId, type, value) {
    return fetch('/api/action', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wcId: wcId, tabId: tabId, type: type, value: value }),
    }).then(function (r) {
      if (r.status === 401) { onAuthLost(); return false; }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.ok) { toast('送信失敗: ' + (j.error || r.status), true); return false; }
        return true;
      });
    }).catch(function () { toast('送信失敗（通信エラー）', true); return false; });
  }

  // ---------- state handling ----------
  function onState(s) {
    if (!s || !Array.isArray(s.projects)) return;
    state = s;
    var now = new Set();
    s.projects.forEach(function (p) {
      (p.tabs || []).forEach(function (t) { if (t.status === 'asking') now.add(keyOf(p.wcId, t.id)); });
    });
    if (askingKeys) {
      var fresh = false;
      now.forEach(function (k) { if (!askingKeys.has(k)) fresh = true; });
      if (fresh) {
        try { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); } catch (e) { /* ignore */ }
        if (!route) toast('回答待ちのエージェントがあります');
      }
    }
    askingKeys = now;
    document.title = (now.size ? '(' + now.size + ') ' : '') + 'BantoDesk Remote';
    render();
  }

  // ---------- routing ----------
  function parseRoute() {
    var m = /^#\/tab\/(\d+)\/(.+)$/.exec(location.hash);
    if (!m) return null;
    var tabId;
    try { tabId = decodeURIComponent(m[2]); } catch (e) { return null; }
    return { wcId: Number(m[1]), tabId: tabId };
  }
  var openedFromList = false;
  function go(r) {
    openedFromList = !!r && !route;
    location.hash = r ? '#/tab/' + r.wcId + '/' + encodeURIComponent(r.tabId) : '';
  }
  window.addEventListener('hashchange', function () {
    route = parseRoute();
    if (!route) openedFromList = false;
    detail = null;
    render();
    window.scrollTo(0, 0);
  });
  $('back').addEventListener('click', function () {
    if (openedFromList) history.back(); // keep history clean: list → detail → back
    else go(null);
  });

  function render() {
    if (authLost) return;
    $('back').hidden = !route;
    if (!state) {
      view.textContent = '';
      view.appendChild(h('div', { class: 'empty' }, h('p', { text: '読み込み中…' })));
      return;
    }
    if (route) renderDetail(); else renderList();
  }

  // ---------- list view ----------
  function renderList() {
    detail = null;
    $('title-main').textContent = 'BantoDesk';
    var total = 0;
    state.projects.forEach(function (p) { total += (p.tabs || []).length; });
    $('title-sub').textContent = state.projects.length + ' ウィンドウ / ' + total + ' エージェント';

    var frag = document.createDocumentFragment();
    if (!state.projects.length) {
      frag.appendChild(h('div', { class: 'empty' }, h('p', { text: '開いているプロジェクトウィンドウがありません。' })));
    }
    var projects = state.projects.slice().sort(function (a, b) {
      return minOrder(a) - minOrder(b) || String(a.name).localeCompare(String(b.name));
    });
    projects.forEach(function (p) {
      var tabs = (p.tabs || []).slice().sort(function (a, b) { return st(a).order - st(b).order; });
      var sec = h('section', { class: 'project' }, [
        h('div', { class: 'proj-head' }, [
          h('span', { class: 'proj-name', text: p.name }),
          h('span', { class: 'proj-dir', text: p.workDir }),
        ]),
      ]);
      if (!tabs.length) sec.appendChild(h('div', { class: 'muted small pad', text: 'エージェントタブなし' }));
      tabs.forEach(function (t) { sec.appendChild(card(p, t)); });
      frag.appendChild(sec);
    });
    view.textContent = '';
    view.appendChild(frag);
  }
  function minOrder(p) {
    var m = 9;
    (p.tabs || []).forEach(function (t) { m = Math.min(m, st(t).order); });
    return m;
  }

  function card(p, t) {
    var s = st(t);
    var tp = todoProgress(t.todos);
    var subs = runningSubs(t.subagents);
    var cp = pct(t.contextPct);
    var meta = [];
    if (cp != null) meta.push(h('span', { class: 'chip' + (cp >= 80 ? ' warn' : '') }, 'ctx ' + cp + '%'));
    if (tp.total) meta.push(h('span', { class: 'chip' }, '✓ ' + tp.done + '/' + tp.total));
    if (subs) meta.push(h('span', { class: 'chip mauve' }, 'サブ ' + subs));
    if (t.team && !t.team.removed) {
      var tm = t.team.members || [];
      var live = tm.filter(function (m) { return m.status === 'running' || m.status === 'starting'; }).length;
      meta.push(h('span', { class: 'chip mauve' }, 'チーム ' + (live ? live + '/' : '') + tm.length));
    }
    if (t.worktree) meta.push(h('span', { class: 'chip' }, '⎇ ' + t.worktree));
    if (t.active) meta.push(h('span', { class: 'chip dim' }, '表示中'));

    var kids = [
      h('div', { class: 'card-top' }, [
        h('span', { class: 'badge ' + s.cls, text: s.label }),
        h('span', { class: 'card-label', text: t.label || t.id }),
      ]),
    ];
    if (t.status === 'asking' && t.choices && t.choices.question) {
      kids.push(h('div', { class: 'card-q', text: t.choices.question }));
    }
    if (meta.length) kids.push(h('div', { class: 'card-meta' }, meta));
    if (tp.total) {
      var bar = h('div', { class: 'prog-fill' });
      bar.style.width = Math.round((tp.done / tp.total) * 100) + '%';
      kids.push(h('div', { class: 'prog' }, bar));
    }
    return h('button', {
      type: 'button',
      class: 'card ' + s.cls,
      onclick: function () { go({ wcId: p.wcId, tabId: t.id }); },
    }, kids);
  }

  // ---------- detail view ----------
  function renderDetail() {
    var found = findTab(route.wcId, route.tabId);
    if (!found) {
      detail = null;
      $('title-main').textContent = 'タブが見つかりません';
      $('title-sub').textContent = '';
      view.textContent = '';
      view.appendChild(h('div', { class: 'empty' }, [
        h('p', { text: 'このタブは閉じられたか、ウィンドウが終了しました。' }),
        h('button', { type: 'button', class: 'btn', onclick: function () { go(null); } }, '一覧へ戻る'),
      ]));
      return;
    }
    if (!detail) buildDetail();
    updateDetail(found.project, found.tab);
  }

  function buildDetail() {
    var r = route;
    var d = {};
    d.badge = h('span', { class: 'badge' });
    d.meta = h('div', { class: 'card-meta' });
    d.screen = h('pre', { class: 'screen' });
    d.screenWrap = h('div', { class: 'screen-wrap' }, d.screen);
    d.choices = h('div', { class: 'choices' });
    d.todos = h('ul', { class: 'todos' });
    d.subs = h('ul', { class: 'subs' });
    d.todoSec = h('section', { class: 'block' }, [h('h3', { text: 'TODO' }), d.todos]);
    d.subSec = h('section', { class: 'block' }, [h('h3', { text: 'サブエージェント' }), d.subs]);
    d.members = h('ul', { class: 'subs' });
    d.teamTitle = h('h3', { text: 'チーム' });
    d.teamSec = h('section', { class: 'block' }, [d.teamTitle, d.members,
      h('div', { class: 'sub-last', text: 'メンバーの画面: ↓ でメンバーを選び Enter（戻るときは Esc）' })]);
    d.snipSec = h('section', { class: 'block' });

    d.input = h('textarea', { class: 'input', rows: '2', placeholder: 'テキストを送信（Enter で改行、送信ボタンで実行）', maxlength: '4000' });
    var sendBtn = h('button', { type: 'button', class: 'btn primary send' }, '送信');
    sendBtn.addEventListener('click', function () {
      var v = d.input.value;
      if (!v.trim()) { d.input.focus(); return; }
      sendBtn.disabled = true;
      sendAction(r.wcId, r.tabId, 'text', v).then(function (ok) {
        sendBtn.disabled = false;
        if (ok) { d.input.value = ''; toast('送信しました'); }
      });
    });

    var keybar = h('div', { class: 'keybar' }, KEYS.map(function (k) {
      return h('button', {
        type: 'button',
        class: 'key' + (k.danger ? ' danger' : ''),
        onclick: function () {
          if (k.v === 'ctrl-c' && !confirm('Ctrl+C を送信しますか？（実行中の処理が中断されます）')) return;
          sendAction(r.wcId, r.tabId, 'key', k.v);
        },
      }, k.t);
    }));

    view.textContent = '';
    view.appendChild(h('div', { class: 'detail' }, [
      h('div', { class: 'detail-head' }, [d.badge, d.meta]),
      d.choices,
      d.screenWrap,
      keybar,
      h('div', { class: 'compose' }, [d.input, sendBtn]),
      d.snipSec,
      d.teamSec,
      d.todoSec,
      d.subSec,
    ]));
    buildSnippets(d, r);
    d.firstScroll = true;
    detail = d;
  }

  function buildSnippets(d, r) {
    var snips = (state.snippets || []).filter(function (s) { return s && s.text; });
    d.snipSec.textContent = '';
    d.snipKey = JSON.stringify(snips.map(function (s) { return [s.id, s.title, s.submit]; }));
    if (!snips.length) { d.snipSec.hidden = true; return; }
    d.snipSec.hidden = false;
    d.snipSec.appendChild(h('h3', { text: 'スニペット' }));
    var wrap = h('div', { class: 'snips' });
    snips.forEach(function (s) {
      wrap.appendChild(h('button', {
        type: 'button',
        class: 'snip' + (s.submit ? '' : ' fill'),
        title: s.text,
        onclick: function () {
          if (s.submit) {
            sendAction(r.wcId, r.tabId, 'text', s.text).then(function (ok) { if (ok) toast('送信: ' + (s.title || 'スニペット')); });
          } else {
            d.input.value = s.text;
            d.input.focus();
          }
        },
      }, s.title || s.text.slice(0, 20)));
    });
    d.snipSec.appendChild(wrap);
  }

  function updateDetail(p, t) {
    var d = detail;
    var s = st(t);
    $('title-main').textContent = t.label || t.id;
    $('title-sub').textContent = p.name + (t.worktree ? ' ⎇ ' + t.worktree : '');
    d.badge.className = 'badge ' + s.cls;
    d.badge.textContent = s.label;

    d.meta.textContent = '';
    var cp = pct(t.contextPct);
    if (t.model) d.meta.appendChild(h('span', { class: 'chip dim', text: t.model }));
    if (cp != null) d.meta.appendChild(h('span', { class: 'chip' + (cp >= 80 ? ' warn' : '') }, 'ctx ' + cp + '%'));
    if (typeof t.costUsd === 'number') d.meta.appendChild(h('span', { class: 'chip dim' }, '$' + t.costUsd.toFixed(2)));

    // choices
    var cKey = JSON.stringify(t.choices || null);
    if (cKey !== d.cKey) {
      d.cKey = cKey;
      d.choices.textContent = '';
      var c = t.choices;
      if (c && Array.isArray(c.options) && c.options.length) {
        if (c.question) d.choices.appendChild(h('div', { class: 'question', text: c.question }));
        c.options.forEach(function (o) {
          var n = Number(o.n);
          var valid = Number.isInteger(n) && n >= 1 && n <= 9;
          var b = h('button', {
            type: 'button',
            class: 'choice' + (o.selected ? ' selected' : ''),
            disabled: !valid,
          }, [h('span', { class: 'num', text: String(o.n) }), h('span', { class: 'clabel', text: o.label || '' })]);
          b.addEventListener('click', function () {
            Array.prototype.forEach.call(d.choices.querySelectorAll('button'), function (x) { x.disabled = true; });
            sendAction(route.wcId, route.tabId, 'choice', n).then(function (ok) {
              if (ok) toast(n + ' を送信しました');
              setTimeout(function () {
                Array.prototype.forEach.call(d.choices.querySelectorAll('button'), function (x) { x.disabled = false; });
              }, 800);
            });
          });
          d.choices.appendChild(b);
        });
        d.choices.hidden = false;
      } else {
        d.choices.hidden = true;
      }
    }

    // screen
    var text = (t.screen || []).join('\n');
    if (text !== d.screenText) {
      var w = d.screenWrap;
      var nearBottom = d.firstScroll || w.scrollHeight - w.scrollTop - w.clientHeight < 40;
      d.screenText = text;
      d.screen.textContent = text || '（画面データなし）';
      if (nearBottom) w.scrollTop = w.scrollHeight;
      d.firstScroll = false;
    }

    // todos
    var todos = (t.todos || []).filter(function (x) { return x && x.status !== 'deleted'; });
    d.todoSec.hidden = !todos.length;
    d.todos.textContent = '';
    todos.forEach(function (x) {
      var icon = x.status === 'completed' ? '✓' : x.status === 'in_progress' ? '▶' : '○';
      d.todos.appendChild(h('li', { class: 'todo ' + (x.status || '') }, [
        h('span', { class: 'ticon', text: icon }),
        h('span', { text: x.text || x.content || x.subject || '' }),
      ]));
    });

    // subagents
    var subs = t.subagents || [];
    d.subSec.hidden = !subs.length;
    d.subs.textContent = '';
    subs.forEach(function (x) {
      var cls = x.status === 'running' ? 'running' : x.status === 'error' ? 'error' : 'done';
      var lab = x.status === 'running' ? '実行中' : x.status === 'error' ? 'エラー' : '完了';
      var last = x.lastTool ? (x.lastTool.name || '') + (x.lastTool.arg ? ' ' + x.lastTool.arg : '') : '';
      d.subs.appendChild(h('li', { class: 'sub' }, [
        h('div', { class: 'sub-top' }, [
          h('span', { class: 'sbadge ' + cls, text: lab }),
          h('span', { class: 'sub-type', text: x.agentType || 'agent' }),
        ]),
        x.description ? h('div', { class: 'sub-desc', text: x.description }) : null,
        last ? h('div', { class: 'sub-last', text: last }) : null,
      ]));
    });

    // Agent Teams members
    var team = t.team;
    var members = team ? team.members || [] : [];
    d.teamSec.hidden = !team;
    d.teamTitle.textContent = team ? 'チーム' + (team.removed ? '（片付け済み）' : '') + ' · ' + members.length + ' 人' : 'チーム';
    d.members.textContent = '';
    var MCOL = { blue: '#89b4fa', green: '#a6e3a1', red: '#f38ba8', yellow: '#f9e2af', purple: '#cba6f7', magenta: '#cba6f7', orange: '#fab387', cyan: '#94e2d5', pink: '#f5c2e7' };
    members.forEach(function (m) {
      var running = m.status === 'running' || m.status === 'starting';
      var cls = running ? 'running' : m.status === 'error' ? 'error' : 'done';
      var lab = m.status === 'starting' ? '起動中' : running ? '実行中' : m.status === 'idle' ? '待機中' : m.status === 'error' ? 'エラー' : '完了';
      var dot = h('span', { class: 'sub-type', text: '● ' });
      dot.style.color = MCOL[m.color] || '#6c7086';
      var last = m.lastTool ? (m.lastTool.name || '') + (m.lastTool.arg ? ' ' + m.lastTool.arg : '') : '';
      d.members.appendChild(h('li', { class: 'sub' }, [
        h('div', { class: 'sub-top' }, [
          h('span', { class: 'sbadge ' + cls, text: lab }),
          dot,
          h('span', { class: 'sub-type', text: '@' + m.name + (m.agentType ? ' · ' + m.agentType : '') }),
        ]),
        last && running ? h('div', { class: 'sub-last', text: last }) : null,
      ]));
    });

    // snippets may change while the view is open
    var snipKey = JSON.stringify((state.snippets || []).filter(function (x) { return x && x.text; })
      .map(function (x) { return [x.id, x.title, x.submit]; }));
    if (snipKey !== d.snipKey) buildSnippets(d, route);
  }

  // ---------- boot ----------
  route = parseRoute();
  render();
  startSse();
})();
