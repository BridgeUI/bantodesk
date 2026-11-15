'use strict';
// Backlog (roadmap 8, "issues"): things to do later. Items wait in a queue per session; when the
// session has finished its current work, core (renderer.js) sends the next item as a prompt.
// This module keeps the state and renders the バックログ dock panel. Owner: core.
//
// window.Backlog:
//   init({ load() -> Promise<BacklogState>, save(state), tabs() -> [{id,label}], activeId() -> id,
//          sendNow(tabId, item) -> '' | reason, onChange() })
//   add(tabId, text) / next(tabId) -> item | null / start(id) / finish(id, ok, note) / items(tabId?)
//   auto(tabId) -> boolean / setAuto(tabId, on, rec?) / panel() / render() / merge() / reorder(order) (manager's reorder)
//   autoOff(tabId) -> record | null / setAutoOff(tabId, rec | null) / resumeAuto(tabId) (why the auto send waits or
//   stopped after an API error, src/renderer/autosend.js; setAuto on clears it, resumeAuto = 再開 on あなたの番)
//   requeue(id, note) (an active item back to the queue: the PMO's prompt is sent again after an API error)
//   loaded() -> boolean (init's load is done; changes before it are joined into the loaded state, then saved)
//   note(id, text) (progress note of an item, saved only when it changes) / unassign(id) (a routed item back to the queue)
//   waitReasons() / setWaitReasons({ [id]: { code, text } }) (why routed items do not start yet, from main's sched:plan)
//   drop(id) (the user's 取り消す: a pending item -> dropped, kept as history) / applyStatuses([{ id, status, note, doneAt }])
//   (main changed statuses: the dashboard's 取り消す, the manager's backlog-update, the auto clean-up of replaced items)
// BacklogState = { items: Item[], auto: { [tabId]: boolean }, autoOff?: { [tabId]: AutoSend record }, userOrderAt?: ms }
//   markResume() / resumed(id) / setHold(text | null) (update hold, src/main/autorestart.js: banner; running items that
//   continue in the same conversation after a restart at a turn gap)
// Item = { id, text, tabId, status: 'pending'|'active'|'done'|'failed'|'dropped', createdAt, startedAt, doneAt, note,
//          kind?, touches?, after? (routed items: how they may run in parallel, src/main/sched.js),
//          resume? { at } (active item marked just before an update restart: continues instead of starting over),
//          seq?, no? ("AT-12", given by main when it saves, UIUX U1), title? (short heading; none -> made from the text) }

// The words table (window.Labels, labels.js, UIUX U1) is loaded by index.html before this script.
(() => {
  let hooks = {};
  let state = { items: [], auto: {} };
  let loaded = false;
  let editing = null; // item id being edited
  let showDone = false;
  // UX7 (docs/mac-polish.md J3): the other sessions' items, OTHERS_SHOWN then 「ほか N 件」 (kept through rebuilds)
  const OTHERS_SHOWN = 3;
  let showOthers = false;
  let waits = {}; // routed item id -> { code, text }: why it does not start yet (not saved)
  let hold = null; // update reserved: the banner text (renderer.js setHold), nothing starts meanwhile
  let modelDefaultsAt = 0;
  let modelDefaults = null; // AT-6: { model, effort } every routed session starts with unless its item has its own
  const loadModelDefaults = () => {
    try {
      Promise.resolve(window.api?.modelsGet?.())
        .then((v) => {
          const d = v && v.session ? v.session : null;
          if (JSON.stringify(d) !== JSON.stringify(modelDefaults)) {
            modelDefaults = d;
            if (loaded) render();
          }
        })
        .catch(() => {});
    } catch {}
  };
  const root = document.createElement('div');
  root.className = 'bl-panel';

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }
  const RESUME_KEEP_MS = 15 * 60_000; // a resume mark older than this (the restart did not come back soon) is dropped
  const newId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const firstLine = (t) => String(t || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';

  // main numbers items when it saves them (src/main/backlog.js): items added here get their no from the saved state
  // shortly after (a few tries, the save is debounced).
  const needsNo = (i) => !i.no && !String(i.id).startsWith('m-');
  let noTimer = 0;
  let noTries = 0;
  function fetchNos() {
    clearTimeout(noTimer);
    noTimer = setTimeout(async () => {
      let s = null;
      try {
        s = await hooks.load?.();
      } catch {}
      const byId = new Map(((s && s.items) || []).map((i) => [i.id, i]));
      let n = 0;
      for (const it of state.items) {
        const k = needsNo(it) && byId.get(it.id);
        if (!k || !k.no) continue;
        it.no = k.no;
        it.seq = k.seq;
        if (!it.title && k.title) it.title = k.title;
        n++;
      }
      if (n) {
        render();
        hooks.onChange?.();
      }
      if (state.items.some(needsNo) && ++noTries < 4) fetchNos();
      else noTries = 0;
    }, 1200);
  }

  function changed() {
    if (loaded) hooks.save?.(state);
    render();
    hooks.onChange?.();
    if (loaded && state.items.some(needsNo)) fetchNos();
  }

  function add(tabId, text) {
    const t = String(text || '').trim();
    if (!t) return null;
    const item = { id: newId(), text: t, tabId: tabId || null, status: 'pending', createdAt: Date.now(), startedAt: null, doneAt: null, note: '' };
    state.items.push(item);
    changed();
    return item;
  }
  const items = (tabId) => state.items.filter((i) => !tabId || i.tabId === tabId);
  const byId = (id) => state.items.find((i) => i.id === id) || null;
  const pendingOf = (tabId) => state.items.filter((i) => i.status === 'pending' && i.tabId === tabId);
  const activeOf = (tabId) => state.items.find((i) => i.status === 'active' && i.tabId === tabId) || null;

  function next(tabId) {
    return pendingOf(tabId)[0] || null;
  }
  function start(id) {
    const it = byId(id);
    if (!it) return;
    it.status = 'active';
    it.startedAt = Date.now();
    it.note = '';
    changed();
  }
  function requeue(id, note) {
    const it = byId(id);
    if (!it || it.status !== 'active') return;
    it.status = 'pending';
    it.startedAt = null;
    it.note = String(note || '').slice(0, 500);
    delete it.resume;
    changed();
  }
  function finish(id, ok, note) {
    const it = byId(id);
    if (!it) return;
    it.status = ok ? 'done' : 'failed';
    it.doneAt = Date.now();
    it.note = String(note || '').slice(0, 500);
    changed();
  }
  function note(id, text) {
    const it = byId(id);
    const t = String(text || '').slice(0, 500);
    if (!it || it.note === t) return;
    it.note = t;
    changed();
  }
  function unassign(id) {
    const it = byId(id);
    if (!it || it.status !== 'pending' || !it.tabId) return;
    it.tabId = null;
    changed();
  }
  // Update restart at a turn gap (src/main/autorestart.js, renderer.js showUpdate): the running items continue after the
  // restart instead of going back to the queue. -> number of items marked
  function markResume() {
    const at = Date.now();
    let n = 0;
    for (const it of state.items) {
      if (it.status !== 'active') continue;
      it.resume = { at };
      n++;
    }
    if (n) changed();
    return n;
  }
  // the restored tab got the 「続けてください」 prompt: from now on the item is judged as usual
  function resumed(id) {
    const it = byId(id);
    if (!it || !it.resume) return;
    delete it.resume;
    it.startedAt = Date.now();
    it.note = '再起動の後、同じ会話の続きで再開しました';
    changed();
  }
  function setHold(text) {
    const t = text ? String(text) : null;
    if (t === hold) return;
    hold = t;
    render();
  }
  function setWaitReasons(map) {
    const next = map && typeof map === 'object' ? map : {};
    if (JSON.stringify(next) === JSON.stringify(waits)) return;
    waits = next;
    render();
  }
  // 取り消す: the item stays (history, its inbox tie) with status dropped; it never starts.
  function drop(id, note = 'ユーザーが取り消しました') {
    const it = byId(id);
    if (!it || it.status !== 'pending') return false;
    it.status = 'dropped';
    it.doneAt = Date.now();
    it.note = String(note || '').slice(0, 500);
    changed();
    return true;
  }
  // main changed items' status (already on disk); an item this window started meanwhile (active) keeps running.
  function applyStatuses(list) {
    let n = 0;
    for (const s of Array.isArray(list) ? list : []) {
      const it = s && byId(s.id);
      if (!it || it.status === 'active' || it.status === s.status) continue;
      if (!['dropped', 'failed', 'done'].includes(s.status)) continue;
      it.status = s.status;
      it.note = typeof s.note === 'string' ? s.note.slice(0, 500) : it.note;
      it.doneAt = typeof s.doneAt === 'number' ? s.doneAt : Date.now();
      delete it.resume;
      n++;
    }
    if (n) changed();
    return n;
  }
  function remove(id) {
    state.items = state.items.filter((i) => i.id !== id);
    changed();
  }
  function move(id, dir) {
    const it = byId(id);
    if (!it) return;
    const same = state.items.filter((i) => i.status === 'pending' && i.tabId === it.tabId);
    const k = same.indexOf(it);
    const other = same[k + dir];
    if (!other) return;
    const a = state.items.indexOf(it);
    const b = state.items.indexOf(other);
    state.items[a] = other;
    state.items[b] = it;
    state.userOrderAt = Date.now(); // the user's order wins over the manager's reorder for 24 h (src/main/backlog.js)
    changed();
  }
  // The manager agent reordered this folder's queue (outbox reorder, main already checked it): pending items named in
  // `order` take the slots of the pending items in that order, the rest follow; active / done items do not move.
  // userAt (queue order, docs/queue-order.md): the order came from the user's ↑ / ↓ on the dashboard card (a number: the
  // 24 h lock starts then) or the user handed the order to the PMO (null: the lock is lifted); undefined = the PMO's reorder.
  function reorder(order, userAt) {
    if (!Array.isArray(order)) return false;
    let lockChanged = false;
    if (typeof userAt === 'number' && state.userOrderAt !== userAt) {
      state.userOrderAt = userAt;
      lockChanged = true;
    } else if (userAt === null && typeof state.userOrderAt === 'number') {
      delete state.userOrderAt;
      lockChanged = true;
    }
    const ids = order.filter((id) => typeof id === 'string');
    const slots = [];
    state.items.forEach((it, i) => it.status === 'pending' && slots.push(i));
    const pend = slots.map((i) => state.items[i]);
    const named = ids.map((id) => pend.find((it) => it.id === id)).filter(Boolean);
    const sorted = [...named, ...pend.filter((it) => !named.includes(it))];
    if (sorted.every((it, k) => it === pend[k])) {
      if (lockChanged) changed();
      return false;
    }
    slots.forEach((slot, k) => (state.items[slot] = sorted[k]));
    changed();
    return true;
  }
  const auto = (tabId) => state.auto[tabId] !== false; // on unless switched off
  // on: also clears the tab's autoOff record. off with rec: why it is off (the panel's checkbox: why 'user')
  function setAuto(tabId, on, rec = null) {
    state.auto[tabId] = !!on;
    if (on || rec) setOffRec(tabId, on ? null : rec);
    changed();
  }
  const autoOff = (tabId) => (state.autoOff && state.autoOff[tabId]) || null;
  function setOffRec(tabId, rec) {
    if (rec) (state.autoOff ||= {})[tabId] = rec;
    else if (state.autoOff) {
      delete state.autoOff[tabId];
      if (!Object.keys(state.autoOff).length) delete state.autoOff;
    }
  }
  function setAutoOff(tabId, rec) {
    if (!tabId || (!rec && !autoOff(tabId))) return;
    setOffRec(tabId, rec || null);
    changed();
  }
  const resumeAuto = (tabId) => tabId && setAuto(tabId, true);

  // ---- panel ---------------------------------------------------------------------
  // render() rebuilds the whole panel (on every tab activation and backlog change). The text boxes keep
  // what was typed, the caret and the focus; during an IME composition the rebuild waits for
  // compositionend (replacing the box mid-composition drops the unconverted text).
  let composing = false;
  let renderLater = false;
  root.addEventListener('compositionstart', () => {
    composing = true;
  });
  const compositionDone = () => {
    if (!composing) return;
    composing = false;
    if (renderLater) setTimeout(render, 0);
  };
  root.addEventListener('compositionend', compositionDone);
  root.addEventListener('focusout', compositionDone);
  let restoreEdit = null; // { id, value, sel } for build(): the edit box being rebuilt keeps its text
  let keepTitle = null; // { id, value }: the same for the heading box

  function render() {
    if (loaded && Date.now() - modelDefaultsAt > 60_000) {
      modelDefaultsAt = Date.now();
      loadModelDefaults();
    }
    if (composing) {
      renderLater = true;
      return;
    }
    renderLater = false;
    const act = document.activeElement;
    const sel = (el) => ({ s: el.selectionStart, e: el.selectionEnd, dir: el.selectionDirection });
    const nb = root.querySelector('.bl-new');
    const newTab = nb ? nb.dataset.tab : null;
    const newValue = nb ? nb.value : '';
    const newFocus = nb && act === nb ? sel(nb) : null;
    const eb = root.querySelector('.bl-edit');
    restoreEdit = eb && eb.dataset.id === editing ? { id: editing, value: eb.value, sel: act === eb ? sel(eb) : null } : null;
    const editSel = restoreEdit && restoreEdit.sel;
    const tb = root.querySelector('.bl-edit-title');
    keepTitle = tb && tb.dataset.id === editing ? { id: editing, value: tb.value } : null;
    const titleSel = keepTitle && act === tb ? sel(tb) : null;
    build();
    restoreEdit = null;
    keepTitle = null;
    const restore = (box, f) => {
      if (!box || !f) return;
      box.focus({ preventScroll: true });
      try {
        box.setSelectionRange(f.s, f.e, f.dir);
      } catch {}
    };
    if (titleSel) restore(root.querySelector('.bl-edit-title'), titleSel);
    if (editSel) restore(root.querySelector(`.bl-edit[data-id="${CSS.escape(editing)}"]`), editSel);
    const nb2 = root.querySelector('.bl-new');
    if (!nb2 || newTab !== nb2.dataset.tab) return; // another session: its box starts empty
    nb2.value = newValue;
    restore(nb2, newFocus);
  }

  function build() {
    const tabs = hooks.tabs?.() || [];
    const labels = new Map(tabs.map((t) => [t.id, t.label]));
    const active = hooks.activeId?.();
    root.replaceChildren();

    // header: target session + auto switch
    const head = h('div', 'bl-head');
    head.append(h('span', 'bl-target', active ? labels.get(active) || '' : 'セッションがありません'));
    if (active) {
      const lab = h('label', 'bl-auto');
      const c = h('input');
      c.type = 'checkbox';
      c.checked = auto(active);
      c.addEventListener('change', () => setAuto(active, c.checked, c.checked ? null : { why: 'user', at: Date.now() }));
      lab.append(c, document.createTextNode('一通り終わったら自動で送る'));
      head.append(lab);
      const off = autoOff(active);
      if (off && window.AutoSend) {
        const w = h('span', 'bl-auto-why', window.AutoSend.whyText(off));
        w.title = '自動送信が待っている・止まっている理由です。チェックを入れ直すと再開します';
        head.append(w);
      }
    }
    root.append(head);
    if (hold) root.append(h('div', 'bl-hold', hold));

    // add box
    if (active) {
      const box = h('textarea', 'bl-new');
      box.rows = 2;
      box.dataset.tab = active;
      box.placeholder = `あとでやることを書いて ${window.Labels.key('mod+Enter')} で追加（会話の入力欄では ${window.Labels.key('mod+shift+Enter')}）`;
      box.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          const text = box.value;
          box.value = ''; // before add(): its render() carries the box's text over to the new box
          if (!add(active, text)) box.value = text;
          requestAnimationFrame(() => root.querySelector('.bl-new')?.focus());
        }
      });
      root.append(box);
    }

    const list = h('div', 'bl-list');
    const mine = active ? state.items.filter((i) => i.tabId === active) : [];
    const others = state.items.filter((i) => i.tabId !== active && (i.status === 'pending' || i.status === 'active'));
    const act = mine.filter((i) => i.status === 'active');
    const pend = mine.filter((i) => i.status === 'pending');
    const finished = (i) => i.status === 'done' || i.status === 'failed' || i.status === 'dropped';
    const done = mine.filter(finished).slice(-30).reverse();

    if (!act.length && !pend.length) list.append(h('div', 'bl-empty', 'このセッションの待ちはありません'));
    for (const it of act) list.append(row(it, { label: '対応中' }));
    pend.forEach((it, i) => list.append(row(it, { label: i === 0 ? '次' : '', first: i === 0, last: i === pend.length - 1 })));
    // dropped items of no tab of this window (a routed item cancelled before it started): shown with the finished ones
    const tabIds = new Set(tabs.map((t) => t.id));
    const loose = state.items.filter((i) => i.status === 'dropped' && i.tabId !== active && (!i.tabId || !tabIds.has(i.tabId))).slice(-30);
    // finished items whose session tab was closed (a 完了 tab closes itself, PROGRESS 49): 「会話を開く」 brings it back
    const closed = state.items.filter((i) => i.status === 'done' && i.tabId && i.tabId !== active && !tabIds.has(i.tabId)).slice(-30);
    if (loose.length || closed.length) {
      done.push(...loose, ...closed);
      done.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    }
    if (others.length) {
      list.append(h('div', 'bl-sub', 'ほかのセッション'));
      for (const it of showOthers ? others : others.slice(0, OTHERS_SHOWN)) {
        const why = !it.tabId && it.status === 'pending' ? waits[it.id] : null;
        const label = it.tabId ? labels.get(it.tabId) || '（閉じたタブ）' : '振り分け待ち（新しいセッションで始まる）';
        list.append(row(it, { label: why ? `${label} · 待ち: ${why.text || why.code}` : label, other: true }));
      }
      if (others.length > OTHERS_SHOWN) {
        const t = h('button', 'bl-toggle bl-others-more', showOthers ? '畳む' : `ほか ${others.length - OTHERS_SHOWN} 件`);
        t.type = 'button';
        t.addEventListener('click', () => {
          showOthers = !showOthers;
          render();
        });
        list.append(t);
      }
    }
    if (done.length) {
      const t = h('button', 'bl-toggle', `${showDone ? '▾' : '›'} 終わったもの ${done.length}`);
      t.type = 'button';
      t.addEventListener('click', () => {
        showDone = !showDone;
        render();
      });
      list.append(t);
      if (showDone) {
        for (const it of done) {
          const gone = it.status === 'done' && it.tabId && it.tabId !== active && !tabIds.has(it.tabId);
          list.append(row(it, { label: it.status === 'failed' ? '失敗' : it.status === 'dropped' ? '取り消し' : gone ? '完了（タブは閉じました）' : '完了', done: true, closed: gone }));
        }
      }
    }
    root.append(list);
  }

  function row(it, o) {
    const r = h('div', `bl-item st-${it.status}${o.other ? ' other' : ''}`);
    const mark = h('span', 'bl-mark', it.status === 'active' ? '▶' : it.status === 'done' ? '✓' : it.status === 'failed' ? '✕' : it.status === 'dropped' ? '–' : '○');
    r.append(mark);
    const main = h('div', 'bl-main');
    if (editing === it.id) {
      // heading (UIUX U1): empty = made from the text
      const tl = h('input', 'bl-edit-title');
      tl.type = 'text';
      tl.dataset.id = it.id;
      tl.placeholder = `見出し（空なら「${window.Labels ? window.Labels.provisionalTitle(it.text) : firstLine(it.text).slice(0, 20)}」）`;
      tl.value = keepTitle && keepTitle.id === it.id ? keepTitle.value : it.title || '';
      tl.maxLength = 200;
      const ed = h('textarea', 'bl-edit');
      const keep = restoreEdit && restoreEdit.id === it.id ? restoreEdit : null; // rebuilt while editing
      ed.dataset.id = it.id;
      ed.value = keep ? keep.value : it.text;
      ed.rows = Math.min(8, Math.max(2, it.text.split('\n').length));
      const onKey = (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.target === tl)) {
          e.preventDefault();
          it.text = ed.value.trim() || it.text;
          const t = tl.value.replace(/\s+/g, ' ').trim();
          if (t) it.title = t;
          else delete it.title;
          editing = null;
          changed();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          editing = null;
          render();
        }
      };
      tl.addEventListener('keydown', onKey);
      ed.addEventListener('keydown', onKey);
      main.append(tl, ed);
      if (!keep) requestAnimationFrame(() => ed.focus()); // just opened (a rebuilt box: render() restores the caret)
    } else {
      // "AT-12 見出し" on top, the text below (full text in the tooltip)
      const name = h('div', 'bl-name');
      if (it.no) name.append(h('span', 'bl-no', it.no), document.createTextNode(' '));
      name.append(document.createTextNode(window.Labels ? window.Labels.taskTitle(it) : it.title || firstLine(it.text).slice(0, 20)));
      name.title = it.text;
      name.style.fontWeight = '600';
      const text = h('div', 'bl-text', it.text);
      text.title = it.text;
      main.append(name, text);
      const meta = [o.label, it.note].filter(Boolean).join(' · ');
      if (meta) main.append(h('div', 'bl-meta', meta));
      // AT-6: the model / effort its session starts / started with (small; the PMO's own choice stands out)
      const mm = (it.status === 'pending' || it.status === 'active') && window.Labels?.modelMark ? window.Labels.modelMark(it, modelDefaults) : null;
      if (mm) {
        const m = h('div', `bl-model${mm.own ? ' own' : ''}`, mm.text);
        m.title = mm.title;
        main.append(m);
      }
    }
    r.append(main);
    if (editing !== it.id) {
      const acts = h('span', 'bl-acts');
      const btn = (label, title, fn) => {
        const b = h('button', 'bl-act', label);
        b.type = 'button';
        b.title = title;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          fn();
        });
        acts.append(b);
      };
      if (it.status === 'pending') {
        btn('今すぐ送る', 'このセッションに今すぐ送る', () => {
          const why = hooks.sendNow?.(it.tabId, it);
          if (why) {
            it.note = why;
            render();
          }
        });
        if (!o.first) btn('↑', '上へ', () => move(it.id, -1));
        if (!o.last) btn('↓', '下へ', () => move(it.id, 1));
        btn('編集', `編集（${window.Labels.key('mod+Enter')} で保存、Esc で取り消し）`, () => {
          editing = it.id;
          render();
        });
        btn('取り消す', '始めずに取り消す（項目は「終わったもの」に取り消しとして残る）', () => {
          if (!window.confirm(`この項目を取り消しますか？\n\n${firstLine(it.text).slice(0, 120)}\n\n始めずに「取り消し」として残します（「戻す」で待ち行列に戻せます）。`)) return;
          drop(it.id);
        });
      }
      if (o.closed && hooks.openSession) {
        btn('会話を開く', 'この作業のセッションを開いて会話を見る（claude は止めたまま。「再開」か送信で --resume します）', () => {
          Promise.resolve(hooks.openSession(it.tabId)).then((why) => {
            if (why) window.alert(`開けませんでした: ${why}`);
          });
        });
      }
      if (it.status === 'failed' || it.status === 'done' || it.status === 'dropped') {
        btn('戻す', 'もう一度キューに入れる', () => {
          it.status = 'pending';
          it.doneAt = null;
          it.note = '';
          changed();
        });
      }
      if (it.status === 'active') btn('完了', '対応が終わったことにする', () => finish(it.id, true, '手動で完了'));
      btn('削除', '削除', () => remove(it.id));
      r.append(acts);
    }
    return r;
  }

  // main wrote this folder's backlog (e.g. the manager agent routed an item here): take over items
  // we don't have yet; local items win (their newer state may still be waiting for the save).
  async function merge() {
    let s = null;
    try {
      s = await hooks.load?.();
    } catch {}
    if (!s || !Array.isArray(s.items)) return;
    const have = new Map(state.items.map((i) => [i.id, i]));
    let added = 0;
    let numbered = 0;
    for (const it of s.items) {
      const mine = have.get(it.id);
      if (mine) {
        // the number main gave (and a heading set by the manager) reach the local copy
        if (it.no && mine.no !== it.no) {
          mine.no = it.no;
          mine.seq = it.seq;
          numbered++;
        }
        if (!mine.title && it.title) {
          mine.title = it.title;
          numbered++;
        }
        continue;
      }
      state.items.push(it.status === 'active' ? { ...it, status: 'pending', startedAt: null } : it);
      added++;
    }
    if (added) changed();
    else if (numbered) {
      render();
      hooks.onChange?.();
    }
  }

  window.Backlog = {
    merge,
    note,
    markResume,
    resumed,
    setHold,
    hold: () => hold,
    unassign,
    waitReasons: () => waits,
    setWaitReasons,
    reorder,
    drop,
    applyStatuses,
    move, // (id, -1 | 1): the user's ↑ / ↓ (also used by tests)
    async init(o) {
      hooks = o || {};
      // Changes made while the load is in flight (add from the composer, merge(), setAuto, ...) are joined into what was
      // saved instead of being replaced by it: saved items + the ones this window has and the file not (by id; the local
      // copy wins, it is the newer state). changed() does not save before the load, so nothing overwrote the file meanwhile.
      let early = false;
      try {
        const s = await hooks.load?.();
        if (s && Array.isArray(s.items)) {
          const mine = state;
          const local = new Map(mine.items.map((i) => [i.id, i]));
          const items = s.items.map((i) => local.get(i.id) || i);
          const seen = new Set(items.map((i) => i.id));
          for (const it of mine.items) if (!seen.has(it.id)) items.push(it);
          early = mine.items.length > 0 || Object.keys(mine.auto).length > 0 || typeof mine.userOrderAt === 'number';
          const userOrderAt = typeof mine.userOrderAt === 'number' ? mine.userOrderAt : s.userOrderAt;
          const offs = { ...(s.autoOff || {}), ...(mine.autoOff || {}) };
          state = { items, auto: { ...(s.auto || {}), ...mine.auto }, ...(Object.keys(offs).length ? { autoOff: offs } : {}), ...(typeof userOrderAt === 'number' ? { userOrderAt } : {}) };
        }
      } catch (err) {
        console.error(err);
      }
      // An item left 'active' by a crash / restart: one marked by markResume() just before an update restart at a turn
      // gap stays active and continues in its restored tab (renderer.js backlogResumeTick). AT-101: so does a routed item
      // (r-…) whose tab comes back (hooks.restoring: ids of the tabs being restored; not in the manager window): it keeps
      // its startedAt and gets the 「続けてください」 prompt instead of going back to the queue (that left it pending
      // with its tab still running, and the item text was sent again from scratch). A routed item whose tab is gone goes
      // back to the queue without the tab (a new session takes it). Other items go back to the queue as before.
      const now = Date.now();
      let restoring = null;
      try {
        const ids = await hooks.restoring?.();
        if (ids && typeof ids.has === 'function') restoring = ids;
      } catch {}
      let fixed = 0;
      for (const it of state.items) {
        if (it.status !== 'active') continue;
        if (it.resume && now - (it.resume.at || 0) < RESUME_KEEP_MS) continue;
        const routed = typeof it.id === 'string' && it.id.startsWith('r-');
        if (routed && restoring && it.tabId && restoring.has(it.tabId)) {
          it.resume = { at: now, restart: true };
          fixed++;
          continue;
        }
        it.status = 'pending';
        it.startedAt = null;
        delete it.resume;
        if (routed && restoring && it.tabId) it.tabId = null;
        fixed++;
      }
      if (fixed && restoring) early = true; // saved now, so the counts in main (sched) see it at once
      loaded = true;
      loadModelDefaults(); // AT-6: the marks' defaults (a settings change shows at the next load / render)
      if (early) hooks.save?.(state); // the early changes were not saved yet
      render();
      hooks.onChange?.();
    },
    add,
    next,
    start,
    finish,
    remove,
    items,
    activeOf,
    pendingOf,
    auto,
    setAuto,
    autoOff,
    setAutoOff,
    resumeAuto,
    requeue,
    state: () => state,
    loaded: () => loaded, // false until init's load is done: state() is not the whole backlog yet (do not save it)
    panel: () => root,
    render,
  };
})();
