// SCH-AS (docs/sched-assigned.md): a routed item given a new tab must start there within START_MS. Loaded as a <script>
// (window.StartWatch, renderer.js backlogStartWatch) and with require (tests).
//
// A window starts a routed item (r-…) the scheduler let start by making a new tab for it (renderer.js startRouted: tabId
// set, still pending); the item becomes active when its text is sent to that tab (backlogSend), which waits until the tab
// is ready (backlogReady: claude started, idle, its input prompt on the screen, no dialog). Before, nothing watched that
// wait: a tab that never got ready kept the item 「割り当て済み・未開始」 while main counted it as running (limit, overlap),
// so the items behind it waited for 10 / 58 min (SSA-161, AT-147, AT-149).
// Now: not started within START_MS of the assignment (the clock starts when this window first sees it, so a restart
// starts it again; it stands still while an update holds the queue, while the tab has another item active, or while the
// tab's auto send is off) -> the item goes back to the queue without the tab (a new tab takes it, the old one closes) and
// assignTries counts it; the TRIES-th time (the first assignment + 2 retries) it fails and the ルーター is told (sched:alert
// nostart, a 見回り line). Main stops counting such an item as running a little later on its own (src/main/sched.js
// routedRunning), so a window that does not act does not hold the queue either.
(function () {
  const START_MS = 60_000;
  const TRIES = 3;

  const ROUTED_RE = /^r-/;

  /**
   * -> [{ id, tabId, action: 'retry' | 'fail', tries }] for the items whose start was not confirmed in time.
   * items: this window's backlog items; watch: Map id -> { tabId, since } (kept by the caller, updated here);
   * live(item) -> boolean: its tab exists (a closed tab is backlogSweep's); hold(item) -> boolean: the clock stands still.
   */
  function check({ items, watch, now = Date.now(), live = () => true, hold = () => false, startMs = START_MS, tries = TRIES } = {}) {
    const out = [];
    const keep = new Set();
    for (const it of Array.isArray(items) ? items : []) {
      if (!it || typeof it.id !== 'string' || !ROUTED_RE.test(it.id) || it.status !== 'pending' || !it.tabId) continue;
      if (!live(it)) continue;
      keep.add(it.id);
      let w = watch.get(it.id);
      if (!w || w.tabId !== it.tabId) {
        watch.set(it.id, { tabId: it.tabId, since: now });
        continue;
      }
      if (hold(it)) {
        w.since = now;
        continue;
      }
      if (now - w.since < startMs) continue;
      const n = (Number.isInteger(it.assignTries) && it.assignTries > 0 ? it.assignTries : 0) + 1;
      watch.delete(it.id);
      keep.delete(it.id);
      out.push({ id: it.id, tabId: it.tabId, action: n >= tries ? 'fail' : 'retry', tries: n });
    }
    for (const id of [...watch.keys()]) if (!keep.has(id)) watch.delete(id);
    return out;
  }

  // The item's note for an action (why = what the tab was doing, '' when not known).
  function noteOf(a, why = '', startMs = START_MS) {
    const sec = Math.round(startMs / 1000);
    const w = why ? `（${why}）` : '';
    if (a.action === 'fail') return `割り当てたセッションで開始を確かめられませんでした（${a.tries} 回割り当てて、どれも ${sec} 秒のうちに始まりませんでした）${w}`;
    return `割り当てたセッションで ${sec} 秒のうちに開始を確かめられなかったため、割り当てを外してやり直します（${a.tries} 回目）${w}`;
  }

  // SCH-FR (docs/sched-assigned.md「SCH-FR」): the window's 1 s tick did not run for a while — the timers of a window
  // the user does not look at were throttled to one wake-up a minute (AT-165 waited 7 min in its new tab, AT-166 failed
  // after 3 tries in 17:3x), or the PC slept. The start / send clocks do not count that time: the session was not too
  // slow, nobody looked. createPauses().tick(now) at each tick -> ms the tick was late (0 = on time; a gap up to gapMs is
  // a slow tick, not a pause); after(t) -> ms of the pauses after t (kept for KEEP_MS).
  const GAP_MS = 5000;
  const KEEP_MS = 2 * 60 * 60_000;
  function createPauses({ gapMs = GAP_MS, periodMs = 1000 } = {}) {
    let last = 0;
    const list = []; // { at: the tick that ended the pause, ms }
    return {
      tick(now) {
        const gap = last ? now - last : 0;
        last = now;
        while (list.length && list[0].at < now - KEEP_MS) list.shift();
        if (!(gap > gapMs)) return 0;
        const ms = gap - periodMs;
        list.push({ at: now, ms });
        return ms;
      },
      after(t) {
        let s = 0;
        for (const p of list) s += Math.max(0, Math.min(p.ms, p.at - (Number(t) || 0)));
        return s;
      },
    };
  }
  // the watched items' clocks move on by ms (a pause of the window)
  function shift(watch, ms) {
    if (!(ms > 0)) return;
    for (const w of watch.values()) if (w && typeof w.since === 'number') w.since += ms;
  }

  const api = { START_MS, TRIES, GAP_MS, check, noteOf, createPauses, shift };
  if (typeof window !== 'undefined') window.StartWatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
