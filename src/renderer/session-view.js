'use strict';
// UX13 (docs/ux-journey.md §5.1 B・J5 段 2・J7, docs/ux13-check.md): the main window (the dashboard) opens a session's
// conversation in place, instead of jumping to the folder window. The session stays in its owner window (the
// workbench); main relays its transcript events and screen state here only while it is open (src/main/oneview.js),
// and what is typed here goes to the owner's pty through the owner's own send path. ← ホーム closes it (the relay
// stops). A second Conversation instance (conversation.js create(tab, { hooks })) draws it.
// UX14 (docs/ux14-check.md): the folder / title are in the top bar's breadcrumb (dashboard.js paintCrumb; this view calls
// Dashboard.viewChanged when it opens / closes); the head keeps ← ホーム and the workbench's doors: ターミナル (the
// folder window shows that session as a terminal) and 作業台で開く.
// UX15 (docs/ux15-check.md): 「この作業」 on the right (panel.js renderWork, the data relayed by the owner with its screen
// state: s.work). Its 再起動 / 引き継ぐ / 自動で送る go to the owner (view:input type 'work'), フォルダを開く to main, a
// changed file opens with the OS (main shell:openFile). Narrower than 1180px it is folded behind the head's 「この作業」.
//
// window.SessionView:
//   init({ host })                      – dash-mode only (renderer.js): the view is a sibling of #dashboard
//   open({ wcId, tabId, folder, title, from })  -> Promise<boolean>
//   close()                             – back to the home
//   current()                           -> { tabId, owned, ... } | null (tests, dashboard.js)
(() => {
  const api = window.api;
  const W = () => window.Labels?.WORDS || {};
  let root = null; // #session-view
  let dashEl = null;
  let cur = null; // { tab, wcId, tabId, folder, title, owned, queue, seen }
  let seq = 0;

  const h = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };
  const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
  // the same key as renderer.js startReplay (an event that came live while the history loaded is drawn once)
  const evtKey = (e) =>
    [e.kind, e.ts, e.uuid ? `${e.uuid}:${e.idx ?? 0}` : e.msgId || e.toolUseId || e.agentId || '', e.kind === 'subagent' ? `${e.status}|${e.updatedAt}|${e.toolCount}` : ''].join('|');

  function init(o) {
    dashEl = (o && o.host) || document.getElementById('dashboard');
    if (!dashEl || root) return;
    root = h('section', 'sv conv-host');
    root.id = 'session-view';
    root.hidden = true;
    dashEl.parentNode.insertBefore(root, dashEl.nextSibling);
    api.onViewEvent?.((evt) => {
      if (!cur || !evt || evt.sessionId !== cur.tabId) return;
      if (cur.queue) {
        cur.queue.push(evt);
        return;
      }
      feed(evt);
    });
    api.onViewScreen?.((m) => {
      if (!cur || !m || m.tabId !== cur.tabId || !cur.tab.conv) return;
      cur.screen = m.s;
      window.Conversation?.onScreen?.(cur.tab, m.s);
      paintWork();
    });
    // Alt+← / ⌘[ : back to the home (Esc stays the conversation's: it interrupts a turn)
    document.addEventListener('keydown', (e) => {
      if (!cur || root.hidden) return;
      const back = (e.altKey && e.key === 'ArrowLeft') || ((e.metaKey || e.ctrlKey) && e.key === '[');
      if (!back) return;
      e.preventDefault();
      close();
    });
  }

  function feed(evt) {
    if (evt.kind === 'title' && evt.title && cur) {
      cur.title = cur.title || String(evt.title).slice(0, 80);
      paintHead();
    }
    window.Conversation?.onEvent?.(cur.tab, evt);
  }

  // this view's hooks: everything that acts goes to main (view:input) and on to the owner window
  function hooksFor(state) {
    const put = (type, value) => {
      if (cur !== state) return Promise.resolve('');
      return Promise.resolve(api.viewInput?.({ tabId: state.tabId, type, value })).catch(() => '送れませんでした');
    };
    return {
      send: (tab, text) => {
        if (!state.owned) return `${W().sessionClosed || 'このセッションは閉じています'}（${W().openWorkbench || '作業台で開く'}と送れます）`;
        put('text', text).then((why) => {
          if (!why || cur !== state || !tab.conv) return;
          tab.conv.showNotice?.(`送れませんでした — ${why}`);
          if (!tab.conv.input.value) tab.conv.input.value = text; // the text comes back to the box
        });
        return '';
      },
      choose: (_tab, n) => put('choice', String(n)),
      key: (_tab, name) => put('key', name),
      queue: () => '待ちに入れるのは作業台の会話からです',
      restart: null, // 「再開」: a send wakes a resting tab (the owner's convSend)
      composed: null,
      setMode: null,
      peek: null,
      sent: null,
      saveDraft: null,
      history: () => [],
    };
  }

  // 「この作業」 (UX15): redrawn only when the relayed data changed; a closed session (no owner) shows a short line
  function paintWork() {
    const state = cur;
    if (!state || !state.work) return;
    const d = state.screen && state.screen.work;
    const sig = d ? JSON.stringify(d) : state.owned ? 'wait' : 'closed';
    if (sig === state.workSig) return;
    state.workSig = sig;
    const box = state.work;
    const top = box.scrollTop;
    box.replaceChildren(h('div', 'sv-work-title', 'この作業'));
    if (!d) {
      box.append(h('div', 'pn-empty-line', state.owned ? '読み込み中…' : `${W().sessionClosed || 'このセッションは閉じています'}（${W().openWorkbench || '作業台で開く'}と再開・引き継ぎができます）`));
      return;
    }
    if (!window.Panel?.renderWork) return;
    box.append(window.Panel.renderWork(d, { usage: 'dash.view', act: (op, arg) => workAct(state, d, op, arg) }));
    box.scrollTop = top;
  }
  function workAct(state, d, op, arg) {
    if (cur !== state) return;
    if (op === 'folder') return safe(() => api.openFolder?.(d.cwd || state.folder));
    if (op === 'file') return safe(() => api.openFile?.(String(arg || '')));
    const value = op === 'auto' ? (arg ? 'auto-on' : 'auto-off') : op;
    Promise.resolve(api.viewInput?.({ tabId: state.tabId, type: 'work', value }))
      .catch(() => '送れませんでした')
      .then((why) => {
        if (!why || cur !== state) return;
        state.tab.conv?.showNotice?.(`${op === 'restart' ? '再起動' : op === 'handoff' ? '引き継ぎ' : '切り替え'}できませんでした — ${why}`);
        state.workSig = ''; // the switch goes back to what the owner has
        paintWork();
      });
  }

  function paintHead() {
    if (!cur) return;
    const head = cur.head;
    head.replaceChildren();
    const back = h('button', 'sv-back', `← ${W().home || 'ホーム'}`);
    back.type = 'button';
    back.title = `${W().home || 'ホーム'}に戻る（${window.Labels?.key?.('alt+←') || 'Alt+←'}）`;
    back.addEventListener('click', close);
    head.append(back);
    // UX14: the folder / title live in the breadcrumb; without one (no top bar crumb) they stay here
    if (!document.getElementById('crumb')) {
      const crumb = h('span', 'sv-crumb');
      crumb.append(h('span', 'sv-folder', base(cur.folder) || '—'), h('span', 'sv-sep', ' / '), h('span', 'sv-title', cur.title || cur.tabId.slice(0, 8)));
      crumb.title = [cur.folder, cur.title].filter(Boolean).join('\n');
      head.append(crumb);
    }
    if (!cur.owned) head.append(h('span', 'sv-note', W().sessionClosed || 'このセッションは閉じています'));
    head.append(h('span', 'cv-spacer'));
    if (cur.owned) {
      const tm = h('button', 'sv-terminal', W().terminal || 'ターミナル');
      tm.type = 'button';
      tm.dataset.usage = 'dash.view.terminal';
      tm.title = 'このセッションのターミナルを作業台（フォルダの窓）で開きます';
      tm.addEventListener('click', () => openWorkbench('term'));
      head.append(tm);
    }
    // narrow: 「この作業」 is folded (dashboard.css); this shows / hides it
    const wk = h('button', `sv-worktoggle${root.classList.contains('sv-work-open') ? ' on' : ''}`, 'この作業');
    wk.type = 'button';
    wk.title = 'この作業の欄を出す / しまう';
    wk.addEventListener('click', () => {
      root.classList.toggle('sv-work-open');
      wk.classList.toggle('on', root.classList.contains('sv-work-open'));
    });
    head.append(wk);
    const wb = h('button', 'sv-workbench', W().openWorkbench || '作業台で開く');
    wb.type = 'button';
    wb.dataset.usage = 'dash.view.workbench';
    wb.title = 'ターミナル・並べる・ビューアはフォルダの窓（作業台）で使えます';
    wb.addEventListener('click', () => openWorkbench());
    head.append(wb);
    safe(() => window.Dashboard?.viewChanged?.()); // the breadcrumb's title / the nav's mark
  }

  // the folder window (as 「会話を開く」 did before UX13). The view here stays open; main sends each event once
  // per window, so nothing is doubled.
  // mode: 'term' = the folder window shows the session as a terminal (UX14 ターミナル)
  function openWorkbench(mode) {
    if (!cur) return;
    const state = cur;
    const from = ['turn', 'project', 'request', 'log', 'notif', 'tray', 'tab', 'palette', 'agents', 'nav'].includes(state.from) ? state.from : 'project';
    if (state.owned && state.wcId != null) api.dashboardFocus?.({ wcId: state.wcId, tabId: state.tabId, from, ...(mode ? { mode } : {}) });
    else if (state.folder) {
      api.dashboardOpenSession?.({ folder: state.folder, tabId: state.tabId });
      // the folder window takes a moment to open the session: then this view can send (owner found)
      setTimeout(() => { if (cur === state) reown(state); }, 2500);
    }
  }
  async function reown(state) {
    const r = await Promise.resolve(api.viewOpen?.({ tabId: state.tabId })).catch(() => null);
    if (cur !== state || !r || !r.ok) return;
    if (r.owned && !state.owned) {
      state.owned = true;
      if (r.folder) state.folder = r.folder;
      paintHead();
      paintWork();
    }
  }

  async function open(o) {
    if (!root || !o || typeof o.tabId !== 'string') return false;
    if (cur && cur.tabId === o.tabId && !root.hidden) return true;
    if (cur) closeQuiet();
    const tab = { id: o.tabId, cwd: o.folder || '', sv: true };
    const state = { tab, wcId: o.wcId ?? null, tabId: o.tabId, folder: o.folder || '', title: o.title || '', from: o.from || 'project', owned: o.wcId != null, queue: [], n: ++seq };
    cur = state;
    tab.conv = window.Conversation?.create?.(tab, { hooks: hooksFor(state), noComposer: true }) || null;
    if (!tab.conv) {
      cur = null;
      return false;
    }
    tab.conv.input.placeholder = `${W().directTalk || 'このセッションに直接話す（ルーターを通さない）'}（${window.Labels?.key?.('mod+Enter') || ''} で送信）`;
    state.head = h('div', 'member-head sv-head');
    state.work = h('aside', 'sv-work pn-host');
    root.replaceChildren(state.head, tab.conv.el, state.work);
    root.classList.remove('sv-work-open');
    paintHead();
    dashEl.hidden = true;
    root.hidden = false;
    document.body.classList.add('sv-on');
    let r = null;
    try {
      r = await api.viewOpen({ tabId: o.tabId });
    } catch (err) {
      console.error('view:open failed', err);
    }
    if (cur !== state) return false;
    if (!r || !r.ok) {
      tab.conv.empty.textContent = '会話を開けませんでした';
      state.queue = null;
      return false;
    }
    state.owned = !!r.owned;
    if (r.folder) state.folder = r.folder;
    paintHead();
    paintWork();
    const seen = new Set();
    const C = window.Conversation;
    C.beginBulk?.(tab);
    for (const e of r.events || []) {
      seen.add(evtKey(e));
      feed(e);
    }
    C.endBulk?.(tab);
    const q = state.queue || [];
    state.queue = null;
    for (const e of q) if (!seen.has(evtKey(e))) feed(e);
    if (!(r.events || []).length) tab.conv.empty.textContent = 'この会話はまだありません';
    if (state.owned) C.focus?.(tab); // a closed session: the head says so (no 「claude は終了しました」 line)
    return true;
  }

  function closeQuiet() {
    if (!cur) return;
    cur = null;
    safe(() => api.viewClose?.());
  }
  function close() {
    if (!root) return;
    closeQuiet();
    root.hidden = true;
    root.replaceChildren();
    if (dashEl) dashEl.hidden = false;
    document.body.classList.remove('sv-on');
    safe(() => window.Dashboard?.viewChanged?.()); // UX14: the breadcrumb back to ホーム, the nav's mark
  }

  function safe(fn) {
    try {
      return fn();
    } catch (err) {
      console.error(err);
      return undefined;
    }
  }

  window.SessionView = {
    init,
    open,
    close,
    ready: () => !!root,
    isOpen: () => !!cur && !!root && !root.hidden,
    openWorkbench: (mode) => openWorkbench(mode), // UX16 the palette's ターミナル ('term')
    current: () => (cur ? { tabId: cur.tabId, wcId: cur.wcId, folder: cur.folder, title: cur.title, owned: cur.owned, screen: cur.screen || null, work: (cur.screen && cur.screen.work) || null } : null),
  };
})();
