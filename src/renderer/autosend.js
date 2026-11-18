// The backlog's automatic send after an API error (依頼 r-imwgluzxr7b744b-0b27af15). One rule for the renderer
// (renderer.js backlogTick, handoff.js, backlog.js) and main (backlog.js keeps the records, attention.js puts a stopped
// ルーター on 「あなたの番」). Loaded as a <script> (window.AutoSend) and with require (main, tests).
//
// Before: an API error failed the item and switched the tab's auto send off for good. Only a new item with no tab
// switched it on again (the manager's backlogAssignNew), but the ルーター's prompt is coalesced into the one still pending
// (src/main/manager.js notifyManager), so no new item came and the ルーター got nothing for a day.
//
// Now a tab's record autoOff[tabId] = { why, n, at, retryAt, stopped, text } says why its auto send waits / stopped:
//   why 'api'   n API errors in a row, the last at `at`. retry (the ルーター: its prompt only says "check the inbox", so it
//               may be sent again): the item goes back to the queue and is sent again at retryAt (1, 2, 5, 10 min
//               after the 1st … 4th error); the 5th error stops it (stopped). No retry (other tabs: their item may
//               have done half of its work): stopped at once.
//   why 'user'  switched off with the panel's checkbox. Not resumed by the app.
// A stopped 'api' record is cleared (auto on again) when a later turn of the tab got a reply without an API error (the
// tab is alive), by the 「再開」 button on あなたの番, or by a handoff (a new session).
(function () {
  const MIN = 60_000;
  const RETRY_MS = [1 * MIN, 2 * MIN, 5 * MIN, 10 * MIN];
  const LIMIT = RETRY_MS.length; // retries; the error after the last one stops the auto send
  const STALL_MS = 15 * MIN; // a ルーター item pending this long without being sent goes to あなたの番
  const TEXT_MAX = 200;
  const LEGACY_NOTE = /^API エラー/; // the note the old code left on the failed item
  const pos = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const mins = (ms) => `${Math.max(1, Math.round(ms / MIN))}分`;

  // anything -> a valid record | null (main keeps only these)
  function clean(r) {
    if (!r || typeof r !== 'object' || (r.why !== 'api' && r.why !== 'user')) return null;
    const out = { why: r.why, at: pos(r.at) };
    if (!out.at) return null;
    if (r.why === 'api') {
      out.n = Math.max(1, Math.min(99, Math.round(pos(r.n)) || 1));
      out.retryAt = pos(r.retryAt);
      out.stopped = !!r.stopped;
    }
    if (typeof r.text === 'string' && r.text) out.text = r.text.slice(0, TEXT_MAX);
    return out;
  }

  // An API error at `now`. prev = the tab's record (null), retry = may the item be sent again (the ルーター). -> record
  function apiError(prev, now, text = '', retry = true) {
    const n = (prev && prev.why === 'api' ? prev.n || 0 : 0) + 1;
    const stopped = !retry || n > LIMIT;
    const r = { why: 'api', n, at: now, retryAt: stopped ? 0 : now + RETRY_MS[n - 1], stopped };
    if (text) r.text = String(text).slice(0, TEXT_MAX);
    return r;
  }

  // May the next item be sent now? (auto itself is checked by the caller)
  function canSend(rec, now) {
    if (!rec) return true;
    if (rec.why !== 'api' || rec.stopped) return false;
    return now >= (rec.retryAt || 0);
  }

  // The tab answered a turn after the record was made, without an API error: it is alive. t = the tab's clocks
  // { lastPromptAt, lastAssistantAt, lastTurnEndAt, apiErrorAt } (ms). Only an 'api' record is cleared this way.
  function turnOk(rec, t) {
    if (!rec || rec.why !== 'api' || !t) return false;
    const prompt = pos(t.lastPromptAt);
    return prompt > rec.at && pos(t.lastAssistantAt) > prompt && pos(t.lastTurnEndAt) > prompt && pos(t.apiErrorAt) < prompt;
  }

  // A tab switched off by the old code (auto false, no record): its last finished item failed with 「API エラー…」 ->
  // an 'api' record as if it had just failed once (the ルーター: sent again at once; others: stopped). Else null.
  function legacy(state, tabId, retry = true) {
    if (!state || !tabId || !state.auto || state.auto[tabId] !== false) return null;
    if (state.autoOff && state.autoOff[tabId]) return null;
    let last = null;
    for (const it of state.items || []) {
      if (!it || it.tabId !== tabId || !['done', 'failed', 'dropped'].includes(it.status)) continue;
      if (!last || pos(it.doneAt) >= pos(last.doneAt)) last = it;
    }
    if (!last || last.status !== 'failed' || !LEGACY_NOTE.test(String(last.note || ''))) return null;
    const at = pos(last.doneAt) || pos(last.startedAt) || 1;
    return { why: 'api', n: 1, at, retryAt: retry ? at + RETRY_MS[0] : 0, stopped: !retry };
  }

  // The record the new session of a handoff starts with: an API stop is not carried (a new session, a new context).
  const handoff = (rec) => (rec && rec.why === 'api' ? null : rec || null);

  // Words for the reason (あなたの番, the panel)
  function whyText(rec, now = Date.now()) {
    if (!rec) return '';
    if (rec.why === 'user') return '手で止めました';
    const err = rec.text ? `: ${String(rec.text).replace(/\s+/g, ' ').slice(0, 80)}` : '';
    if (rec.stopped) return `API エラーが ${rec.n} 回続きました${err}`;
    const left = pos(rec.retryAt) - now;
    return `API エラー ${rec.n} 回目${err}。${left > 0 ? `${mins(left)}後に` : 'すぐに'}送り直します`;
  }

  // PMO-SEND (docs/pmo-send.md): does the update reserved after a release (src/main/autorestart.js, app:update
  // { state }) hold this window's queue? pmo = the manager window: its queue is only the ルーター's 「依頼を確認して」
  // prompts, which start no work by themselves (the routed items they make wait in their folders' queues).
  //   pending     holds routed / hand-queued items until the restart, not the ルーター's prompts. Before, a release held
  //               them too for up to the hold limit (更新の待ち, 30 min) and the ルーター got nothing meanwhile: 7 of the
  //               8 prompts that waited 10 min or more on 2026-11-15〜17 came right after a release.
  //   restarting  holds everything (the windows are closing)
  function updateHolds(update, pmo = false) {
    const s = update && typeof update === 'object' ? update.state : '';
    if (s === 'restarting') return true;
    return s === 'pending' && !pmo;
  }

  // Why a ルーター prompt is not sent, from what main knows of the ルーター's tab (o.tabs[tabId] = { status, quiet }).
  // -> '' = it works (running, its transcript moves): not a stall, the prompt goes when the turn ends
  function slowWhy(tab, o) {
    if (o.hold === 'limit') return 'API の利用上限の待ちです。上限が戻ると送ります';
    if (o.hold === 'restart') return 'アプリの更新の再起動の途中です。再起動の後に送ります';
    if (!tab) return 'ルーターが応答の途中か、送れる状態になっていません';
    const st = String(tab.status || '');
    if (st === 'rest' || st === 'exited') return 'ルーターのセッションが終了しています';
    if (st === 'running') return tab.quiet ? 'ルーターの応答が止まったまま進んでいません' : '';
    if (st === 'asking') return 'ルーターが確認の画面で止まっています';
    return 'ルーターは応答していませんが、送れる状態になっていません';
  }

  // The manager's backlog state { items, auto, autoOff } -> what the user should know about the ルーター's auto send:
  // [{ tabId, kind: 'off' | 'slow', since, why, itemId, count }]
  //   off   a tab with pending items whose auto send is off (stopped by API errors, or by hand)
  //   slow  pending items not sent for stallMs while nothing is active on that tab (a retry waiting, the ルーター stuck, …)
  // o (main, optional) = { tabs: { [tabId]: { status: 'running'|'idle'|'asking'|'starting'|'exited'|'rest', quiet } },
  //   hold: 'limit' | 'restart' | '' }. quiet is true too when main never saw a transcript event of the tab. PMO-SEND: a ルーター tab in a turn whose transcript moves (quiet false) is working, not stalled:
  //   no slow for it (a long reply to the user, a long check); quiet (no transcript line for 15 min) still is.
  function stalls(state, now = Date.now(), stallMs = STALL_MS, o = {}) {
    const out = [];
    if (!state || !Array.isArray(state.items)) return out;
    const byTab = new Map();
    const active = new Set();
    for (const it of state.items) {
      if (!it) continue;
      if (it.status === 'active') active.add(it.tabId || '');
      if (it.status !== 'pending') continue;
      const k = it.tabId || '';
      if (!byTab.has(k)) byTab.set(k, []);
      byTab.get(k).push(it);
    }
    for (const [k, list] of byTab) {
      const first = list.reduce((a, b) => (pos(b.createdAt) < pos(a.createdAt) ? b : a));
      const rec = (state.autoOff && k && clean(state.autoOff[k])) || legacy(state, k) || null;
      const off = !!k && !!state.auto && state.auto[k] === false;
      if (off) {
        const why = rec ? whyText(rec, now) : '自動送信が切られています';
        out.push({ tabId: k, kind: 'off', since: (rec && rec.at) || pos(first.createdAt) || now, why, itemId: first.id, count: list.length });
        continue;
      }
      if (active.has(k) || now - pos(first.createdAt) < stallMs) continue;
      const tabs = o && o.tabs && typeof o.tabs === 'object' ? o.tabs : null;
      const why = rec && rec.why === 'api' ? whyText(rec, now) : k ? slowWhy(tabs ? tabs[k] : null, o || {}) : 'ルーターのセッションがありません';
      if (!why) continue; // it works: the prompt goes at the end of its turn
      out.push({ tabId: k || null, kind: 'slow', since: pos(first.createdAt) || now, why, itemId: first.id, count: list.length });
    }
    return out;
  }

  const api = { MIN, RETRY_MS, LIMIT, STALL_MS, clean, apiError, canSend, turnOk, legacy, handoff, whyText, updateHolds, slowWhy, stalls };
  if (typeof window !== 'undefined') window.AutoSend = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
