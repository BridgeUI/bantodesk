// When a subagent / team member that still shows "running" / "starting" is not waited for any more (stale). One rule
// for the renderer (liveAgents: backlogReady, workActivity, tabWorks, the update hold) and main's waits.js (the tab
// heads' wait line, the widget, manager/waits.json), so the PMO never sees a tab "waiting" for an agent the window no
// longer counts (AT-166 follow-up, T23). Loaded as a <script> (window.StaleAgents) and with require (main, tests).
//
//  - after 作業完了 (doneAt): no transcript line for STALE_AGENT_MS (PROGRESS 46; exits the parser cannot see)
//  - always: no transcript line for STALE_QUIET_MS, STALE_QUIET_HOLD_MS while an update holds (AT-166: a finished
//    in-process teammate the parser missed, a call never linked to its transcript). A row without a line counts from
//    its start, else from `base` (the tab's last prompt / reply / turn end / creation).
(function () {
  const MIN = 60_000;
  const STALE_AGENT_MS = 10 * MIN;
  const STALE_QUIET_MS = 60 * MIN;
  const STALE_QUIET_HOLD_MS = 20 * MIN;
  const ms0 = (v) => (typeof v === 'number' ? (Number.isFinite(v) && v > 0 ? v : 0) : Date.parse(v) || 0);
  const pos = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  // the quiet limit: o = { hold, quietMs, quietHoldMs } (ms; missing = the defaults)
  const quietLimit = (o = {}) => (o.hold ? pos(o.quietHoldMs) || STALE_QUIET_HOLD_MS : pos(o.quietMs) || STALE_QUIET_MS);
  // a = { status, updatedAt (its last transcript line, ms or ISO), startedAt }
  // o = { now, doneAt (ms of 作業完了, 0 = not), base (ms), staleMs, quiet (ms, the limit; else quietLimit(o)) }
  function isStale(a, o = {}) {
    if (!a || (a.status !== 'running' && a.status !== 'starting')) return false;
    const now = pos(o.now) || Date.now();
    const up = ms0(a.updatedAt);
    if (pos(o.doneAt) && up && now - up >= (pos(o.staleMs) || STALE_AGENT_MS)) return true;
    const at = up || ms0(a.startedAt) || pos(o.base);
    return !!at && now - at >= (pos(o.quiet) || quietLimit(o));
  }
  const api = { MIN, STALE_AGENT_MS, STALE_QUIET_MS, STALE_QUIET_HOLD_MS, quietLimit, isStale };
  if (typeof window !== 'undefined') window.StaleAgents = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
