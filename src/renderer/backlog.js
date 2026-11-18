'use strict';
// Backlog (roadmap 8, "issues"): things to do later. Items wait in a queue per session; when the
// session has finished its current work, core (renderer.js) sends the next item as a prompt.
// This module keeps the state. Owner: core. UX15 (docs/ux15-check.md): the バックログ (待ちの一覧) panel is gone: the
// queue is on the home's project card (↑↓ 取り消す 戻す 完了にする), 一通り終わったら自動で送る is in 「この作業」.
//
// window.Backlog:
//   init({ load() -> Promise<BacklogState>, save(state), onChange(), onRender()?, restoring()? })
//   add(tabId, text) / next(tabId) -> item | null / start(id) / finish(id, ok, note) / items(tabId?)
//   auto(tabId) -> boolean / setAuto(tabId, on, rec?) / render() (hooks.onRender: 「この作業」 follows) / merge() / reorder(order)
//   reopen(id, note?) (戻す: a done / failed / dropped item back to the queue; the card's row menu via main backlog:set)
//   autoOff(tabId) -> record | null / setAutoOff(tabId, rec | null) / resumeAuto(tabId) (why the auto send waits or
//   stopped after an API error, src/renderer/autosend.js; setAuto on clears it, resumeAuto = 再開 on あなたの番)
//   requeue(id, note) (an active item back to the queue: the ルーター's prompt is sent again after an API error)
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
  let waits = {}; // routed item id -> { code, text }: why it does not start yet (not saved)
  let hold = null; // update reserved: the banner text (renderer.js setHold), nothing starts meanwhile
  const RESUME_KEEP_MS = 15 * 60_000; // a resume mark older than this (the restart did not come back soon) is dropped
  const newId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

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
    delete it.handoff; // SCH-HO: set by a context handoff (handoff.js complete) only
    changed();
  }
  function requeue(id, note) {
    const it = byId(id);
    if (!it || it.status !== 'active') return;
    it.status = 'pending';
    it.startedAt = null;
    it.note = String(note || '').slice(0, 500);
    delete it.resume;
    delete it.handoff;
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
  // back to the queue without its tab (a new session takes it). SCH-AS: note / tries when its start was not confirmed
  function unassign(id, note, tries) {
    const it = byId(id);
    if (!it || it.status !== 'pending' || !it.tabId) return;
    it.tabId = null;
    if (typeof note === 'string') it.note = note.slice(0, 500);
    if (Number.isInteger(tries) && tries > 0) it.assignTries = tries;
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
  // 24 h lock starts then) or the user handed the order to the ルーター (null: the lock is lifted); undefined = the ルーター's reorder.
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

  // 戻す (UX15: the card's row menu; was the panel's button): a finished / cancelled item waits again, as before
  function reopen(id, note = '') {
    const it = byId(id);
    if (!it || !['done', 'failed', 'dropped'].includes(it.status)) return false;
    it.status = 'pending';
    it.doneAt = null;
    it.note = String(note || '').slice(0, 500);
    changed();
    return true;
  }

  // 見出しを直す (the card's row menu via main backlog:set, was the panel's 編集): empty = made from the text (titleAuto)
  function setTitle(id, title) {
    const it = byId(id);
    if (!it) return false;
    const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if ((it.title || '') === t) return true;
    if (t) it.title = t;
    else delete it.title;
    changed();
    return true;
  }

  // Nothing is drawn here any more: 「この作業」 (panel.js) and the tab marks follow the state through hooks.onRender.
  function render() {
    hooks.onRender?.();
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
    reopen,
    setTitle,
    render,
  };
})();
