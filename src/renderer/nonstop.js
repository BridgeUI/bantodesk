// UX10 止まらない B: the app repairs a stop on the spot (docs/ux-journey.md §1.6 rows 5・12・13・16, §4 B; the check
// table docs/ux10-check.md). The rules shared by the renderer (renderer.js backlogTick / routedProgress / onPtyExit) and
// main (main.js sched:plan / sched:limit, the 上限待ち notice). Loaded as a <script> (window.Nonstop) and with require
// (main, tmp/nonstop/unit-ux10.js). No DOM, no Electron.
//
//   5  a routed session settles without its mark: one fixed check text at once (CHECK_MS of quiet), not the ルーター's
//      nudge 2 min later. The 2 min stall notice / 30 min failure stay as the backstop.
//   12 the first prompt of an item not seen in time: sent again (Enter again when the box still holds it) up to
//      SEND_RETRIES times before the item fails.
//   13 an API usage limit: its reset time is read from the message (parseLimit); every new start waits (上限待ち HH:MM,
//      main's sched), the routed item stays active and gets LIMIT_RESUME_PROMPT once the time has passed, the ルーター's
//      prompt is sent again at that time instead of 1, 2, 5, 10 min.
//   16 the ルーター's claude ended: woken with `claude --resume` (restartTab) after WAKE_DELAY_MS, at most WAKE_MAX times in
//      WAKE_WINDOW_MS.
(function () {
  const MIN = 60_000;
  const CHECK_MS = 20_000; // quiet (turn over, nothing running, no mark) before the check text
  const SEND_RETRIES = 2; // first-prompt resends before the item fails
  const LIMIT_GRACE_MS = 60_000; // after the reset time before the work goes on
  const LIMIT_DEFAULT_MS = 30 * MIN; // a limit message without a time we can read
  const LIMIT_MAX_MS = 8 * 24 * 60 * MIN; // farther than this = not believed, the default instead
  const WAKE_DELAY_MS = 5_000;
  const WAKE_MAX = 3;
  const WAKE_WINDOW_MS = 60 * MIN;

  const CHECK_PROMPT =
    '（アプリから）最後の返答に完了の印がありませんでした。指示文の作業がすべて終わっていれば、最後の返答の末尾に「作業完了」の 1 行だけを書いてください。' +
    '途中で止めるなら「作業中断: <理由>」と書いてください。まだ続きがあれば、そのまま続けてください（ユーザーへの質問はせず、仮説で進めてください）。';
  const LIMIT_RESUME_PROMPT = '（アプリから）API の利用の上限が解けた時刻になりました。会話はそのまま続いています。中断したところから作業を続けてください（最初からやり直さないでください）。';

  // ---- 13: the usage limit message ----------------------------------------------------------------------------------
  // Claude Code's words (hypothesis, several versions): "Claude AI usage limit reached|1763290800" (epoch s),
  // "Claude usage limit reached. Your limit will reset at 5pm (Asia/Tokyo).", "5-hour limit reached ∙ resets 3am",
  // "You've hit your limit · resets 3pm (Asia/Tokyo)", "Weekly limit reached ∙ resets Mon 9am", "Opus limit reached …".
  const LIMIT_RE = /usage limit|limit reached|hit your (?:usage )?limit|limit will reset|out of (?:extra )?usage|利用(?:の)?上限/i;
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const TIME_RE = new RegExp(
    String.raw`resets?\s+(?:at\s+|on\s+)?` +
      String.raw`(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*,?\s+)?` +
      String.raw`(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?` +
      String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm)?` +
      String.raw`(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?`,
    'i',
  );
  const IN_RE = /resets?\s+in\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i;

  // ms the clock in `tz` is ahead of UTC at `at` (local time without tz; an unknown zone -> null)
  function offsetOf(tz, at) {
    if (!tz) return -new Date(at).getTimezoneOffset() * MIN;
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(at));
      const v = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
      const wall = Date.UTC(v.year, v.month - 1, v.day, v.hour === 24 ? 0 : v.hour, v.minute, v.second);
      return Math.round((wall - Math.floor(at / 1000) * 1000) / MIN) * MIN;
    } catch {
      return null;
    }
  }

  // the first moment after `now` whose wall clock (in tz) is h:m, on that weekday / that month-day when given
  function nextWall(now, { h, m, day = null, month = null, date = null }, tz) {
    let off = offsetOf(tz, now);
    if (off === null) off = offsetOf(null, now);
    const wallNow = new Date(now + off); // read with getUTC*
    for (let add = 0; add <= 400; add++) {
      const d = new Date(Date.UTC(wallNow.getUTCFullYear(), wallNow.getUTCMonth(), wallNow.getUTCDate() + add, h, m));
      if (day !== null && d.getUTCDay() !== day) continue;
      if (month !== null && (d.getUTCMonth() !== month || d.getUTCDate() !== date)) continue;
      let at = d.getTime() - off;
      const off2 = offsetOf(tz, at); // the offset on that day (summer time)
      if (off2 !== null && off2 !== off) at = d.getTime() - off2;
      if (at > now) return at;
    }
    return null;
  }

  // text (+ the error code) -> null when it is not a usage limit, else { resetAt (ms), read: did we read a time }
  function parseLimit(text, now = Date.now(), error = '') {
    const s = String(text || '');
    if (!LIMIT_RE.test(s) && !/usage_limit|limit_reached/i.test(String(error || ''))) return null;
    let at = null;
    const ep = /\|\s*(\d{10})\b/.exec(s);
    if (ep) at = Number(ep[1]) * 1000;
    if (at === null) {
      const r = IN_RE.exec(s);
      if (r && (r[1] || r[2])) at = now + (Number(r[1] || 0) * 60 + Number(r[2] || 0)) * MIN;
    }
    if (at === null) {
      const r = TIME_RE.exec(s);
      if (r) {
        let h = Number(r[4]);
        const m = r[5] ? Number(r[5]) : 0;
        const ap = r[6] ? r[6].toLowerCase() : '';
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        if (h <= 23 && m <= 59 && (ap || r[5] || r[1] || r[2])) {
          const day = r[1] ? DAYS.indexOf(r[1].toLowerCase()) : null;
          const month = r[2] ? MONTHS.indexOf(r[2].toLowerCase()) : null;
          at = nextWall(now, { h, m, day, month, date: r[3] ? Number(r[3]) : null }, r[7] || null);
        }
      }
    }
    if (at !== null && at <= now) at = now + MIN; // the time has just passed: try again in a minute
    if (at === null || at - now > LIMIT_MAX_MS) return { resetAt: now + LIMIT_DEFAULT_MS, read: false };
    return { resetAt: at, read: true };
  }

  const pad = (n) => String(n).padStart(2, '0');
  // "15:00", or "11/17 15:00" when it is not today (local time)
  function clock(at, now = Date.now()) {
    const d = new Date(at);
    const n = new Date(now);
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }
  const holdText = (rec, now = Date.now()) => `上限待ち ${clock(rec.resetAt, now)}（API の利用の上限。時刻になったら再開します）`;

  // main's record of the account-wide hold { resetAt, text, at } -> the sched reason while it holds, else null
  function holdOf(rec, now = Date.now()) {
    if (!rec || !(rec.resetAt > now)) return null;
    return { code: 'usage', text: holdText(rec, now) };
  }
  // a record sent by a window -> a valid one (resetAt within LIMIT_MAX_MS from now) | null
  function cleanHold(o, now = Date.now()) {
    if (!o || typeof o !== 'object') return null;
    const at = Number(o.resetAt);
    if (!Number.isFinite(at) || at <= now || at - now > LIMIT_MAX_MS + MIN) return null;
    return { resetAt: Math.round(at), text: typeof o.text === 'string' ? o.text.replace(/\s+/g, ' ').trim().slice(0, 200) : '', at: now };
  }
  // two holds -> the later one (one limit for the whole account)
  const laterHold = (a, b) => (!a ? b : !b ? a : b.resetAt > a.resetAt ? b : a);

  // ---- 16: waking the ルーター ---------------------------------------------------------------------------------------------
  // times = earlier wakes (ms) -> { ok, times } (times within the window, + now when ok)
  function wakeAllowed(times, now = Date.now(), max = WAKE_MAX, windowMs = WAKE_WINDOW_MS) {
    const kept = (Array.isArray(times) ? times : []).filter((t) => Number.isFinite(t) && now - t < windowMs);
    if (kept.length >= max) return { ok: false, times: kept };
    return { ok: true, times: kept.concat(now) };
  }

  // ---- 12: the first prompt -----------------------------------------------------------------------------------------
  // what to do when the item's prompt was not seen in time. tries = resends so far, box = { holds: the box still shows
  // our paste, empty: the box is empty }, ready = the session takes input now -> 'enter' | 'paste' | 'wait' | 'fail'
  function resendStep(tries, box, ready, max = SEND_RETRIES) {
    if (tries >= max) return 'fail';
    if (!ready) return 'wait';
    if (box && box.holds) return 'enter';
    if (box && box.empty) return 'paste';
    return 'wait'; // something else in the box (the user's text): do not paste over it
  }

  const api = {
    CHECK_MS,
    SEND_RETRIES,
    LIMIT_GRACE_MS,
    LIMIT_DEFAULT_MS,
    LIMIT_MAX_MS,
    WAKE_DELAY_MS,
    WAKE_MAX,
    WAKE_WINDOW_MS,
    CHECK_PROMPT,
    LIMIT_RESUME_PROMPT,
    parseLimit,
    offsetOf,
    clock,
    holdText,
    holdOf,
    cleanHold,
    laterHold,
    wakeAllowed,
    resendStep,
  };
  if (typeof window !== 'undefined') window.Nonstop = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
