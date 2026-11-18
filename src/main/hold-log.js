// HOLD-LOG (依頼-497): the update hold, as the app saw it, where an agent can read it without opening the user's data folder.
//
// PMO-SEND (the maintainers' test notes) wants, after a release: when the hold (autorestart 'pending') began and ended, and
// whether the ルーター kept taking its m- prompts meanwhile (heartbeat lastReceivedAt). Until now that was only in
// <userData> (manager/heartbeat.json, logs/update.jsonl), which agents may not read (CLAUDE.md, Unauthorized Access).
// This module turns autorestart's events (opts.record) and the heartbeats taken during a hold into lines that main writes
//   - to 「ルーターの記録」 (pmo-actions.jsonl type 'update-hold', notices.forLog): the user sees them on the dashboard,
//   - to <from>/.bantodesk/update/hold.jsonl, <from> = RELEASE.json's `from` (the dev repo the release came from; its
//     .bantodesk is not in git): the agents working in that repo read it. Times, versions and counts only: no prompt
//     text, no file content, no process. Nothing is sent anywhere.
// Pure: no fs, no Electron; main does the writing (tests drive it with plain objects).
//
// Line: { ev, version (the new release), startVersion (running), via?, since (ISO, hold began), heldSec?, received
//   (m- prompts the ルーター took since the hold began), lastReceivedAt (ISO | null), pending (m- prompts waiting),
//   oldestPendingAt (ISO | null) }
//   ev: start | reserve | received (lastReceivedAt moved during the hold) | waiting (the first heartbeat of a hold
//       with prompts waiting and none taken yet) | now | postpone | restart | read-fail | watch-fail
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function createHoldLog({ now = Date.now } = {}) {
  let hold = null; // { since (ms), version, startVersion, lastSeen (ms), received, waitingNoted }
  let lastHb = null;

  const takenSince = (items, since) =>
    (Array.isArray(items) ? items : []).filter((i) => i && typeof i.id === 'string' && i.id.startsWith('m-') && num(i.startedAt) >= since).length;

  function line(ev, extra) {
    const t = now();
    const hb = lastHb || {};
    return {
      ev,
      version: hold ? hold.version : null,
      startVersion: hold ? hold.startVersion : null,
      since: hold ? iso(hold.since) : null,
      heldSec: hold ? Math.max(0, Math.round((t - hold.since) / 1000)) : null,
      received: hold ? hold.received : null,
      lastReceivedAt: iso(num(hb.lastReceivedAt)),
      pending: hb.pending == null ? null : num(hb.pending),
      oldestPendingAt: iso(num(hb.oldestPendingAt)),
      ...(extra || {}),
    };
  }

  // autorestart's record({ ev, version, startVersion, state, via?, prev?, ... }) -> lines to write
  function onEvent(e) {
    if (!e || typeof e.ev !== 'string') return [];
    const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]]));
    switch (e.ev) {
      case 'start':
        return [{ ...line('start'), version: e.startVersion || null, startVersion: e.startVersion || null }];
      case 'reserve': {
        // a newer release during a hold keeps its start (one hold until the restart)
        const keep = hold && hold.ended !== true;
        const since = keep ? hold.since : now();
        const lastSeen = num(lastHb && lastHb.lastReceivedAt);
        hold = { since, version: e.version || null, startVersion: e.startVersion || null, lastSeen: keep ? hold.lastSeen : lastSeen, received: keep ? hold.received : 0, waitingNoted: keep ? hold.waitingNoted : false };
        return [line('reserve', pick(e, ['via', 'prev']))];
      }
      case 'now':
        if (!hold) return [];
        if (hold.ended) hold = { ...hold, ended: false, since: now(), received: 0, waitingNoted: false }; // reserved again from 後で
        return [line('now')];
      case 'postpone': {
        if (!hold) return [];
        const out = [line('postpone')];
        hold.ended = true;
        return out;
      }
      case 'restart':
        return [line('restart', pick(e, ['resume']))];
      case 'read-fail':
        return [line('read-fail', pick(e, ['via', 'name']))];
      case 'watch-fail':
        return [line('watch-fail', pick(e, ['code']))];
      default:
        return [];
    }
  }

  // every heartbeat (main checkHeartbeat): hb = lookout.heartbeat(), items = the manager folder's backlog items,
  // state = autorestart status().state -> lines to write (only while the hold holds)
  function onHeartbeat(hb, items, state) {
    if (hb && typeof hb === 'object') lastHb = hb;
    if (!hold || hold.ended || state !== 'pending' || !lastHb) return [];
    const last = num(lastHb.lastReceivedAt);
    const out = [];
    if (last > hold.lastSeen && last >= hold.since) {
      hold.lastSeen = last;
      hold.received = Math.max(hold.received + 1, takenSince(items, hold.since));
      out.push(line('received'));
    } else if (!hold.waitingNoted && num(lastHb.pending) > 0) {
      hold.waitingNoted = true;
      out.push(line('waiting'));
    }
    return out;
  }

  return { onEvent, onHeartbeat, _hold: () => hold };
}

// 「ルーターの記録」's title for a line (notices.forLog, type 'update-hold') -> { title, bad }
function titleOf(a) {
  const hhmmss = (s) => {
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  };
  const held = a.heldSec != null ? `${a.heldSec} 秒待った` : '';
  const got = a.received != null ? `ルーターの受け取り ${a.received} 件` : '';
  const last = a.lastReceivedAt ? `最後の受け取り ${hhmmss(a.lastReceivedAt)}` : '';
  const wait = num(a.pending) > 0 ? `受け取っていない知らせ ${a.pending} 件` : '';
  const parts = (...xs) => xs.filter(Boolean).join('、');
  const ver = a.version ? String(a.version).slice(0, 20) : '';
  const VIA = { watch: 'フォルダの知らせ', retry: '読み直し', poll: '定期の読み直し' };
  switch (a.ev) {
    case 'reserve':
      return { title: `更新待ちを始めた（${parts(ver, VIA[a.via] ? `${VIA[a.via]}で見つけた` : '')}）`, bad: false };
    case 'received':
      return { title: `更新待ちの間にルーターが知らせを受け取った（${parts(last, `待ち始めから ${a.heldSec} 秒`, got, wait)}）`, bad: false };
    case 'waiting':
      return { title: `更新待ちの間、ルーターへの知らせが待っている（${parts(wait, last)}）`, bad: false };
    case 'now':
      return { title: `「今すぐ更新」: ターンの合間で再起動する（${parts(held, got)}）`, bad: false };
    case 'postpone':
      return { title: `更新待ちを「後で」でやめた（${parts(held, got, last)}）`, bad: false };
    case 'restart':
      return { title: `更新待ちを終えて再起動する（${parts(ver, held, got, last, wait)}）`, bad: false };
    case 'read-fail':
      return { title: 'RELEASE.json を読めなかった（読み直す）', bad: true };
    case 'watch-fail':
      return { title: `アプリのフォルダの見張りを始められなかった（${a.code || '?'}、定期の読み直しだけで見る）`, bad: true };
    default:
      return null; // start: only in hold.jsonl
  }
}

module.exports = { createHoldLog, titleOf };
