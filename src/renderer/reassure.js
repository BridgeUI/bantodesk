// UX12 安心の 1 行と留守の間 (docs/ux-journey.md §3.2 J4・J6, §4 「ユーザーに見せるもの」, §6 UX12; the check table
// docs/ux12-check.md). The rules that turn what main's watchers already know (UX10・UX11: waits, after-failed, the usage
// limit hold, manager/heartbeat.json, the update hold) into the words of the home page. Loaded as a <script>
// (window.Reassure, dashboard.js) and with require (main.js for the 事後の確認, tmp/reassure/unit.js). No DOM, no Electron.
//
//   line()          安心の 1 行: 止まっているものはありません / N 件 止まりかけ: AT-53（…） / ルーターが止まっています（…）
//   awayCounts()    留守の間: what happened since the user last looked (ルーターの記録 entries + the 事後の確認)
//   hypothesesOf()  事後の確認: the 「仮説で決めたこと」 / 「事後の確認」 headings of a routed session's last reply
//   proposalDue()   提案の期限: 「**期限**: YYYY-MM-DD HH:MM」 / 「なし」 and 「**既定の案**: …」 of a proposal (ルーター template v28)
//   afterOf()       a task row's 「この後」: what the app / the ルーター does next if nothing happens
//   lastMove()      a task row's 「最後の動き」 (the transcript's last event, else the last state change)
(function () {
  const MIN = 60_000;
  const RUN_QUIET_MIN = 15; // = waits.RUN_QUIET_MIN (UX11): 実行中 with no transcript line for this long -> the ルーター
  const RUN_SOON_MIN = 5; // a row says what happens next once it has been quiet this long
  const AWAY_MIN = 10; // 留守の間 shows when the user was away at least this long
  const WOKEN_SHOW_MS = 30 * MIN; // 「起こし直しました」 is told for this long after the wake
  const ITEM_MAX = 400;
  const LIST_MAX = 12;

  const pad = (n) => String(n).padStart(2, '0');
  const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  function clock(at, now = Date.now()) {
    const d = new Date(at);
    const n = new Date(now);
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }
  // 「40 秒前」「3 分前」「2 時間前」「11/15 09:00」
  function ago(at, now = Date.now()) {
    const ms = Math.max(0, now - at);
    if (ms < MIN) return `${Math.max(1, Math.round(ms / 1000 / 10) * 10)} 秒前`;
    if (ms < 60 * MIN) return `${Math.round(ms / MIN)} 分前`;
    if (ms < 24 * 60 * MIN) return `${Math.round(ms / 60 / MIN)} 時間前`;
    return clock(at, now);
  }
  const minsText = (ms) => `${Math.max(1, Math.round(ms / MIN))} 分`;

  // ---- 安心の 1 行 ---------------------------------------------------------------------------------------------------
  // a waits alert (waits.js: gone / silent / long / deadlock / quiet) -> the short words of the line
  const ALERT_WHY = {
    quiet: '実行中のまま記録が進まない。ルーターが止めて状況を聞きます',
    silent: '出力が止まっている。ルーターが確かめ中',
    long: '長く続いている。ルーターが確かめ中',
    gone: 'プロセスが無いのに終わらない。ルーターが確かめ中',
    deadlock: '待ち合い。ルーターがリーダーに伝えます',
  };
  // o = {
  //   now,
  //   heartbeat:   manager/heartbeat.json (lookout.heartbeat + woken) | null (not known: no claim about the ルーター)
  //   stalls:      [{ name, folderName, code, text }] the sessions waits flags (alerts) — code = the first alert's code
  //   afterFailed: [{ name, folderName, text }] pending items whose prerequisite failed (sched reason after-failed)
  //   usage:       { text } while the API usage limit holds every start (sched reason usage) | null
  //   update:      app:update { state, force, busy, blocked, deadline } | null
  //   running, limit, queued (順番待ち), eta? (min)
  // }
  // -> { level: 'ok' | 'warn' | 'stop', text, parts: [string], full, stalls: n }
  function line(o = {}) {
    const now = o.now || Date.now();
    const hb = o.heartbeat && typeof o.heartbeat === 'object' ? o.heartbeat : null;
    const stalls = (Array.isArray(o.stalls) ? o.stalls : []).filter((x) => x && x.name);
    const failed = (Array.isArray(o.afterFailed) ? o.afterFailed : []).filter((x) => x && x.name);
    const full = [];
    let level = 'ok';
    let text = '止まっているものはありません';
    const woken = hb && hb.woken && num(hb.woken.at) && now - hb.woken.at <= WOKEN_SHOW_MS ? hb.woken : null;
    if (hb && hb.status === 'none') {
      level = 'stop';
      text = 'ルーターのセッションがありません（依頼は振り分けられません）';
      full.push('ルーターのセッションが開いていません。ダッシュボードの右の欄で ルーターを始めると、依頼の振り分けが再開します');
    } else if (hb && (hb.status === 'stale' || hb.stale)) {
      level = 'stop';
      const since = Math.max(num(hb.oldestPendingAt), num(hb.lastReceivedAt)) || now;
      text = `ルーターが止まっています: 知らせ ${hb.pending || 0} 件を ${minsText(now - since)} 受け取っていません${woken ? `（${clock(woken.at, now)} に起こし直しました）` : '（アプリが起こし直します）'}`;
      full.push(`ルーターへの知らせが ${minsText(now - since)} 受け取られていません。アプリが 1 時間に 3 回まで自動で起こし直します（実行中のまま止まっていれば Esc、終わっていれば同じ会話で再開）`);
    }
    const warns = [];
    for (const s of stalls) warns.push({ name: s.name, folderName: s.folderName || '', why: ALERT_WHY[s.code] || 'ルーターが確かめ中', full: oneLine(s.text, 300) });
    for (const f of failed) warns.push({ name: f.name, folderName: f.folderName || '', why: '前提の失敗で始まらない。ルーターが直します', full: oneLine(f.text, 300) });
    if (level === 'ok' && warns.length) {
      level = 'warn';
      const first = warns[0];
      text = `${warns.length} 件 止まりかけ: ${first.name}（${first.why}）${warns.length > 1 ? ` ほか ${warns.length - 1} 件` : ''}`;
    }
    for (const w of warns) full.push(`${w.folderName ? `[${w.folderName}] ` : ''}${w.name}: ${w.why}${w.full ? `（${w.full}）` : ''}`);
    if (o.usage && o.usage.text) {
      if (level === 'ok') {
        level = 'warn';
        text = oneLine(o.usage.text, 120);
      } else full.push(oneLine(o.usage.text, 200));
    }
    // the tail: quiet facts (the band's 動いている moves here)
    const parts = [];
    if (Number.isFinite(o.running) && Number.isFinite(o.limit)) parts.push(`動作中 ${o.running}/上限 ${o.limit}`);
    if (num(o.queued)) parts.push(`順番待ち ${o.queued}${num(o.eta) ? `（目安 ${Math.round(o.eta)} 分）` : ''}`);
    // noAgo: the caller draws this one itself (the dashboard: a clock that follows the time without a redraw)
    if (hb && level !== 'stop' && num(hb.lastReceivedAt) && !o.noAgo) parts.push(`ルーター応答 ${ago(hb.lastReceivedAt, now)}`);
    if (woken && level !== 'stop') parts.push(`ルーターを起こし直しました ${clock(woken.at, now)}`);
    const up = updateText(o.update, now);
    if (up) {
      parts.push(up.short);
      full.push(up.full);
    }
    return { level, text, parts, full: [text, ...full].join('\n'), stalls: warns.length };
  }
  // the update hold (src/main/autorestart.js) -> { short, full } | null (J6 段 1: 「更新を待っています: …」)
  function updateText(u, now = Date.now()) {
    const st = u && u.state;
    if (st === 'restarting') return { short: '新しい版で再起動しています', full: '新しい版で再起動しています。実行中の作業は同じ会話の続きで再開します' };
    if (st === 'postponed') return { short: '新しい版あり（更新は後で）', full: '新しい版があります（更新は後で）。待ちのタスクは動いています' };
    if (st !== 'pending') return null;
    if (u.force) return { short: '更新を待っています: ターンの区切りまで', full: `ターンの合間で再起動します${u.blocked ? `（応答中・要対応のウィンドウ ${u.blocked}）` : ''}。実行中の作業は再起動の後、同じ会話の続きで再開します` };
    return {
      short: `更新を待っています${u.busy ? `: 実行中 ${u.busy} の終わりまで` : ''}${num(u.deadline) ? `（${clock(u.deadline, now)} まで）` : ''}`,
      full: `新しい作業は再起動の後に始めます${u.busy ? `（実行中のウィンドウ ${u.busy} の終わりを待っています${num(u.deadline) ? `、${clock(u.deadline, now)} を過ぎたらターンの合間で再起動` : ''}）` : ''}`,
    };
  }

  // ---- 留守の間 ------------------------------------------------------------------------------------------------------
  // entries = ルーターの記録 (notices.forLog: { at, kind: push|route|order|fix|clean|done|release|handoff|info|warn, bad }),
  // reviews = the 事後の確認 ([{ at }]), since = when the user last looked (ms).
  // -> { since, done, fixed, hypo, stops, total }
  //   done   終わった    kind done, not bad (a task / a folder's review finished)
  //   fixed  立て直した  kind fix (the ルーター / the app repaired a stop: backlog-update, a warn that resolved)
  //   hypo   仮説        事後の確認 that came in (a routed session went on by a hypothesis)
  //   stops  止まり      kind warn, or a done that failed
  function awayCounts(entries, since, reviews = []) {
    const t = num(since);
    const out = { since: t, done: 0, fixed: 0, hypo: 0, stops: 0, total: 0 };
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!e || !(num(e.at) > t)) continue;
      if (e.kind === 'done') e.bad ? out.stops++ : out.done++;
      else if (e.kind === 'fix') out.fixed++;
      else if (e.kind === 'warn') out.stops++;
    }
    for (const r of Array.isArray(reviews) ? reviews : []) if (r && num(r.at) > t) out.hypo++;
    out.total = out.done + out.fixed + out.hypo + out.stops;
    return out;
  }
  // seenAt (the last time the page was left), now -> since for the card, or 0 when the user was not away long
  const awaySince = (seenAt, now = Date.now(), minMin = AWAY_MIN) => (num(seenAt) && now - seenAt >= minMin * MIN ? seenAt : 0);

  // ---- 事後の確認 ----------------------------------------------------------------------------------------------------
  // The routed-session preamble (claude-cmd.js, docs/prompts/routed-session.md) asks for the headings 「仮説で決めたこと」
  // (what, why, how to fix it if wrong) and 「事後の確認」 in the last reply. A heading is a Markdown heading, a bold line
  // or a plain line with that text (an optional colon); its items are the bullet / numbered lines up to the next
  // heading (indented lines continue the item above). -> { hypotheses: [string], checks: [string] }
  const HEAD = { hypotheses: /^仮説で決めたこと$/, checks: /^事後の確認$/ };
  function hypothesesOf(text) {
    const out = { hypotheses: [], checks: [] };
    let cur = null;
    let last = null;
    for (const raw of String(text || '').split(/\r?\n/)) {
      const bare = raw.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/[*_`]/g, '').replace(/[:：]\s*$/, '').trim();
      const head = Object.keys(HEAD).find((k) => HEAD[k].test(bare));
      if (head) {
        cur = head;
        last = null;
        continue;
      }
      if (!cur) continue;
      if (/^\s{0,3}#{1,6}\s/.test(raw) || /^\s*\*\*[^*]+\*\*\s*[:：]?\s*$/.test(raw) || /^作業(完了|中断)/.test(raw.trim())) {
        cur = null; // another heading / the marker ends the list
        continue;
      }
      const m = /^\s*(?:[-*・+]|\d+[.)])\s+(.*)$/.exec(raw);
      if (m && !/^\s{4,}/.test(raw)) {
        const t = oneLine(m[1].replace(/\*\*/g, ''), ITEM_MAX);
        if (!t) continue;
        if (out[cur].length >= LIST_MAX) continue;
        out[cur].push(t);
        last = out[cur].length - 1;
      } else if (raw.trim() && last != null && /^\s+/.test(raw)) {
        out[cur][last] = oneLine(`${out[cur][last]} ${raw.replace(/^\s*(?:[-*・+]|\d+[.)])?\s*/, '').replace(/\*\*/g, '')}`, ITEM_MAX);
      } else if (raw.trim() && !out[cur].length && cur) {
        // a paragraph instead of bullets: one item
        out[cur].push(oneLine(raw.replace(/\*\*/g, ''), ITEM_MAX));
        last = 0;
      } else if (raw.trim()) cur = null; // a line that is not an item ends the list (a blank line keeps it open)
    }
    return out;
  }

  // ---- 提案の期限 ----------------------------------------------------------------------------------------------------
  // text = the proposal's Markdown. -> { at: ms | null, none: boolean, plan: string, short, full } | null (no 期限 line)
  function proposalDue(text, now = Date.now()) {
    const s = String(text || '');
    const dm = /(?:^|\n)\s*[-*]?\s*\**期限\**\s*[:：]\s*\**\s*([^\n]*)/.exec(s);
    const pm = /(?:^|\n)\s*[-*]?\s*\**既定の案\**\s*[:：]\s*\**\s*([^\n]*)/.exec(s);
    const plan = pm ? oneLine(pm[1].replace(/\*\*/g, ''), 200) : '';
    if (!dm) return plan ? { at: null, none: false, plan, short: '', full: `既定の案: ${plan}` } : null;
    const v = dm[1].replace(/\*\*/g, '');
    if (/^\s*なし/.test(v)) return { at: null, none: true, plan, short: '期限なし', full: `期限なし（答えがあるまで進めません）${plan ? `\n既定の案: ${plan}` : ''}` };
    const t = /(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(v);
    if (!t) return { at: null, none: false, plan, short: '', full: `期限: ${oneLine(v, 80)}` };
    const at = new Date(Number(t[1]), Number(t[2]) - 1, Number(t[3]), Number(t[4]), Number(t[5])).getTime();
    const short = dueText(at, now);
    return { at, none: false, plan, short, full: `${short}。答えが無ければ既定の案で進みます${plan ? `\n既定の案: ${plan}` : ''}` };
  }

  // a deadline -> 「期限 11/17 09:00（あと 5 時間）」 / 「期限を過ぎました（既定の案で進みます）」
  function dueText(at, now = Date.now()) {
    const left = at - now;
    if (left <= 0) return '期限を過ぎました（既定の案で進みます）';
    if (left < 60 * MIN) return `期限 ${clock(at, now)}（あと ${minsText(left)}）`;
    return `期限 ${clock(at, now)}（あと ${Math.round(left / 60 / MIN)} 時間）`;
  }

  // ---- タスクの行 ----------------------------------------------------------------------------------------------------
  // s = a dashboard session (WidgetState: at = last state change, eventAt = last transcript event, 10 s rounded)
  const lastMove = (s) => Math.max(num(s && s.eventAt), num(s && s.at)) || 0;
  // What happens next for a row, if nothing else happens (J4 段 2). s = its session | null, it = its backlog item | null,
  // why = its sched reason { code, text } | null. -> { short, full } | null
  const WAIT_NEXT = {
    limit: '動いている作業が終わったら始まります',
    resource: '資源が空いたら始まります',
    after: '前提が済んだら始まります',
    'after-failed': 'ルーターが前提を直すか振り直します',
    overlap: '重なる作業が終わったら始まります',
    update: '再起動の後に始まります',
  };
  function afterOf(s, it, why = null, now = Date.now()) {
    if (s) {
      if (s.rest || s.kind === 'fin' || s.kind === 'input' || s.kind === 'off') return null;
      const w = s.wait && typeof s.wait === 'object' ? s.wait : null;
      const alerts = w && Array.isArray(w.alerts) ? w.alerts : [];
      if (alerts.some((a) => a && a.code === 'quiet')) return { short: 'ルーターが止めて状況を聞きます', full: `実行中のまま会話の記録が ${RUN_QUIET_MIN} 分進んでいません。ルーターが止めて（Esc）状況を聞きます` };
      if (alerts.length) return { short: 'ルーターが確かめて後押しします', full: 'ルーターが確かめて後押しします（2 回で動かなければ要対応に出ます）' };
      if (s.kind === 'busy') {
        const quiet = now - lastMove(s);
        if (lastMove(s) && quiet >= RUN_SOON_MIN * MIN) {
          const left = Math.max(1, RUN_QUIET_MIN - Math.floor(quiet / MIN));
          return { short: `動きが無ければ あと ${left} 分で ルーターへ`, full: `会話の記録が ${minsText(quiet)} 進んでいません。${RUN_QUIET_MIN} 分を過ぎたら ルーターが止めて状況を聞きます` };
        }
        return null;
      }
      if (it && it.status === 'active' && (s.status === 'idle' || s.kind === 'idle' || s.kind === 'done'))
        return { short: '印が無ければアプリが確かめます', full: '完了の印が無いまま落ち着いたら、アプリが確かめ文を 1 回送ります（2 分止まれば ルーターへ）' };
      return null;
    }
    if (it && it.status === 'pending' && why && why.code) {
      if (why.code === 'usage') {
        const hm = /(\d{1,2}\/\d{1,2} )?\d{1,2}:\d{2}/.exec(String(why.text || ''));
        return { short: hm ? `${hm[0]} に再開します` : '上限が解けたら再開します', full: oneLine(why.text, 200) };
      }
      const t = WAIT_NEXT[why.code];
      return t ? { short: t, full: t } : null;
    }
    return null;
  }

  const api = { RUN_QUIET_MIN, RUN_SOON_MIN, AWAY_MIN, WOKEN_SHOW_MS, ALERT_WHY, clock, ago, line, updateText, awayCounts, awaySince, hypothesesOf, proposalDue, dueText, lastMove, afterOf };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else self.Reassure = api;
})();
