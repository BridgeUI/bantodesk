// 見回りの検出 (依頼 r-imwhv61mef52568-25b7c136): the ways work stopped that the PMO missed in
// 2026-11-13〜15, found by code each patrol and told as facts (the same footing as 誤報の見込み: no model call, the
// haiku triage is not asked about them). No Electron imports (testable from plain Node); main.js gathers the inputs
// (the backlogs, the scheduler's reasons, the tabs' TabState, the outbox failed/ folders, git status counts, notices).
//
//   (2) not-start   the first pending item of a folder (no blocked reason, nothing active there) does not start for N min
//   (3) watch       a background command that never ends by itself (tail -f, an until / while loop with no limit), at once;
//                   and a command still running on a tab that already ended with 作業完了
//   (4) propose     a propose file the app refused (outbox/failed/, both the new and the former name), and a folder near
//                   its 24 h limit of proposals
//   (5) resume      an item failed with 「再起動の後に続きを送れません」: the folder's uncommitted change count with it
//   (6) no-target   (used by main's 印なし line) the last reply says it waits for a reply, but waits has nothing to wait on
//   (7) dirty       N or more uncommitted changes in a folder where nothing runs, for N hours
//   (8) deadline    a proposal notice past its 期限 with no answer
//
// Each finding = { key, kind, folder, name, text }. decide() reports a key once (like pmo.patrolDecision): the PMO is woken
// only when a key is new; keys that went away are forgotten (a recurrence is new again).
const path = require('path');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DEFAULTS = {
  notStartMin: 3, // (2)
  leftoverMin: 2, // (3) a command still running this long after 作業完了
  proposeNear: 25, // (4) of propose.PER_FOLDER_DAY (30)
  dirtyCount: 10, // (7)
  dirtyHours: 2, // (7)
};
const LIST_MAX = 8;
const TEXT_MAX = 900;
const STATE_MAX = 300;

const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const norm = (p) => path.resolve(String(p || '')).toLowerCase();
const folderName = (f) => path.basename(String(f || '')) || String(f || '');
function ago(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} 時間${m % 60 ? ` ${m % 60} 分` : ''}` : `${Math.floor(h / 24)} 日`;
}

// manager settings -> the limits (gapNotStartMin, gapDirtyCount, gapDirtyHours; others fixed). Bad values -> defaults.
function settingsOf(o) {
  const pick = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : d;
  };
  return {
    ...DEFAULTS,
    notStartMin: pick(o && o.gapNotStartMin, DEFAULTS.notStartMin, 1, 120),
    dirtyCount: pick(o && o.gapDirtyCount, DEFAULTS.dirtyCount, 1, 10000),
    dirtyHours: pick(o && o.gapDirtyHours, DEFAULTS.dirtyHours, 0.1, 72),
  };
}

// ---- (3) commands that never end by themselves ------------------------------------------------------------------
// Quoted parts are kept (a watch inside bash -c '…' still counts); a time limit anywhere (timeout N, Wait-Process
// -Timeout) or a counter in the loop's test makes it bounded.
const TAIL_FOLLOW_RE = /\btail\b[^|;&\n]*?\s(?:-[a-zA-Z]*[fF][a-zA-Z]*|--follow(?:=\w+)?)(?=\s|$)/;
const PS_WAIT_RE = /\bget-content\b[^|;\n]*\s-wait\b/i; // PowerShell's tail -f
const LOOP_RE = /(?:^|[\s;&|({])(until|while)\s/;
const COUNTER_RE = /\s-(?:gt|ge|lt|le|eq)\s+["']?\$?\w+|\(\(\s*[$\w]+\s*(?:<=?|>=?)\s*[$\w]+\s*\)\)|\$SECONDS\b|\bdate\s+\+%s\b|-(?:gt|ge|lt|le)\s+\d+/;
const SLEEP_FOREVER_RE = /\bsleep\s+(?:infinity|inf)\b/;
// command -> '' (ends by itself, as far as the text says) | the reason (a short Japanese phrase)
function endlessReason(command, timeoutOf = null) {
  const c = String(command || '');
  if (!c.trim()) return '';
  const limited = typeof timeoutOf === 'function' ? num(timeoutOf(c)) > 0 : /(^|[\s;&|(])timeout\s+(-\S+\s+)*\d/.test(c);
  if (limited) return '';
  if (TAIL_FOLLOW_RE.test(c)) return '`tail -f` は見張るファイルが終わっても止まらない';
  if (PS_WAIT_RE.test(c)) return '`Get-Content -Wait` は見張るファイルが終わっても止まらない';
  if (SLEEP_FOREVER_RE.test(c)) return '`sleep infinity` は止まらない';
  const m = LOOP_RE.exec(c);
  if (m && /\bdo\b/.test(c.slice(m.index)) && !COUNTER_RE.test(c.slice(m.index))) {
    return `打ち切りの無い \`${m[1]}\` の見張りは、待つものが来なければ止まらない`;
  }
  return '';
}

const label = (c) => {
  const s = oneLine(c, 200);
  return s.length > 60 ? s.slice(0, 59) + '…' : s;
};

// sessions = widget.sessionsSnapshot() ([{ wcId, workDir, role, t: TabState }]) -> findings.
// (a) any live tab with an endless background command (busy or idle: no silent / long wait);
// (b) a tab that ended with 作業完了 (doneAt) whose claude still lives and still has a command running leftoverMin after.
function findWatches(sessions, { now = Date.now(), timeoutOf = null, leftoverMin = DEFAULTS.leftoverMin } = {}) {
  const out = [];
  for (const x of sessions || []) {
    const t = x && x.t;
    if (!t || x.role === 'manager' || t.rest) continue; // a resting tab: claude was stopped (its tree with it)
    const where = folderName(x.workDir);
    for (const b of (Array.isArray(t.bg) ? t.bg : []).slice(0, 10)) {
      if (!b || typeof b.id !== 'string') continue;
      const why = endlessReason(b.command, timeoutOf);
      const done = num(t.doneAt) && now - num(t.doneAt) >= leftoverMin * MIN && num(b.startedAt) <= num(t.doneAt);
      if (!why && !done) continue;
      const parts = [why, done ? `作業完了の ${ago(now - num(t.doneAt))} 後も動いている` : ''].filter(Boolean);
      out.push({
        key: `watch:${t.id}:${b.id}`,
        kind: 'watch',
        folder: x.workDir || '',
        name: where,
        tabKey: String(t.id),
        backlogId: typeof t.backlogId === 'string' ? t.backlogId : null,
        text: `タブ ${oneLine(t.label, 40) || t.id}（tabKey ${t.id}${t.backlogId ? `、${t.backlogId}` : ''}）のバックグラウンドのコマンド \`${label(b.command)}\`（開始から ${ago(now - (num(b.startedAt) || now))}）: ${parts.join('。')}`,
      });
    }
  }
  return out;
}

// ---- (4) proposals the app refused -------------------------------------------------------------------------------
// failed = [{ folder, dir (the failed/ folder), name, error, title, at }] (main reads outbox/failed/ of each folder);
// counts = [{ folder, day (proposals of the folder in 24 h), max }].
function findProposals(failed, counts, { near = DEFAULTS.proposeNear } = {}) {
  const out = [];
  for (const f of failed || []) {
    if (!f || !f.name) continue;
    const limit = /too many proposals/i.test(f.error || '');
    out.push({
      key: `propose:${norm(f.folder)}|${f.dir ? path.basename(path.dirname(path.dirname(f.dir))) : ''}|${f.name}`,
      kind: 'propose',
      folder: f.folder,
      name: folderName(f.folder),
      at: num(f.at) || null,
      text:
        `${limit ? '' : '上限ではなく形の誤りで入らなかった: '}${path.join(path.basename(path.dirname(path.dirname(f.dir || ''))) || '.bantodesk', 'outbox', 'failed', f.name)}` +
        `${f.title ? ` 「${oneLine(f.title, 60)}」` : ''}（${oneLine(f.error, 120) || '理由なし'}）`,
    });
  }
  for (const c of counts || []) {
    if (!c || !c.folder || num(c.day) < near) continue;
    out.push({
      key: `propose-near:${norm(c.folder)}`,
      kind: 'propose',
      folder: c.folder,
      name: folderName(c.folder),
      text: `このフォルダの propose が 24 時間で ${c.day} 件（上限 ${c.max || 30} 件）。超えた分は依頼に入らず outbox/failed/ に落ちる`,
    });
  }
  return out;
}

// The refused files told once: seen = { key: mtime } (pmo.json gaps.proposeSeen). A failed/ file already told with the
// same name and mtime is dropped (the PMO cannot remove it from another folder); a changed mtime tells it again.
// -> { findings (the rest), seen (only the files still there), held (the dropped count, for the daily stocktake) }
function holdProposals(findings, seen = {}) {
  const prev = seen && typeof seen === 'object' ? seen : {};
  const next = {};
  let held = 0;
  const out = [];
  for (const f of findings || []) {
    if (!f || !String(f.key || '').startsWith('propose:') || !f.at) {
      out.push(f);
      continue;
    }
    const sig = String(f.at);
    if (prev[f.key] === sig) held++;
    else out.push(f);
    next[f.key] = sig;
  }
  return { findings: out, seen: next, held };
}

// a failed/ file's JSON text -> its title(s) (one line, '' when none)
function titleOf(text) {
  try {
    const o = JSON.parse(String(text || '').trim());
    const list = Array.isArray(o) ? o : [o];
    return list
      .map((p) => (p && typeof p === 'object' ? oneLine(p.title || p.text, 40) : ''))
      .filter(Boolean)
      .slice(0, 3)
      .join(' / ');
  } catch {
    return '';
  }
}

// ---- (7) uncommitted changes piling up ---------------------------------------------------------------------------
// folders = [{ folder, count (git status lines; null = not a repo / unknown), busy (any session works there / an item
// is active) }]; since = { [norm folder]: ms the count was first seen ≥ dirtyCount while nothing ran } (kept by main).
// -> { findings, since (the new map) }
function findDirty(folders, since = {}, { now = Date.now(), dirtyCount = DEFAULTS.dirtyCount, dirtyHours = DEFAULTS.dirtyHours } = {}) {
  const next = {};
  const out = [];
  for (const f of folders || []) {
    if (!f || !f.folder || f.count == null) continue;
    const k = norm(f.folder);
    if (f.busy || f.count < dirtyCount) continue; // a run in progress resets the clock
    next[k] = num(since && since[k]) || now;
    if (now - next[k] >= dirtyHours * HOUR) {
      out.push({
        key: `dirty:${k}`,
        kind: 'dirty',
        folder: f.folder,
        name: folderName(f.folder),
        text: `作業ツリーに未コミットの変更が ${f.count} 件、どの作業も動いていないまま ${ago(now - next[k])} 残っている`,
      });
    }
  }
  return { findings: out, since: next };
}

// ---- (8) proposals past their 期限 --------------------------------------------------------------------------------
// The PMO writes 「**期限**: YYYY-MM-DD HH:MM」 in a proposal's text (manager.js template). -> ms (local time) | 0
function deadlineOf(text) {
  const m = /期限\**\s*[:：]\s*\**\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T　]+(\d{1,2}):(\d{2}))?/.exec(String(text || ''));
  if (!m) return 0;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] ? Number(m[4]) : 23, m[5] ? Number(m[5]) : 59).getTime();
  return Number.isFinite(t) ? t : 0;
}
// notices = the live notices (notices.list()) -> findings
function findDeadlines(notices, { now = Date.now() } = {}) {
  const out = [];
  for (const n of notices || []) {
    if (!n || n.kind !== 'proposal' || n.resolvedAt || n.answer) continue;
    const at = deadlineOf(n.text);
    if (!at || now < at) continue;
    out.push({
      key: `deadline:${n.id}`,
      kind: 'deadline',
      folder: n.folder || '',
      name: n.folder ? folderName(n.folder) : 'PMO',
      text: `提案 ${n.id}「${oneLine(n.title, 60)}」${n.key ? `（key ${n.key}）` : ''}の期限 ${new Date(at).toLocaleString('ja-JP', { hour12: false })} を ${ago(now - at)} 過ぎ、答えが無い`,
    });
  }
  return out;
}

// ---- (2) the first pending item does not start -------------------------------------------------------------------
// backlogs = [{ folder, items }] (backlog order: the first pending is sent first, manager.js pendingItems position 1).
// Only routed items (r-) start by themselves (sched.closedWaiting); the user's own items wait for the user, so the head is
// the first pending r- item;
// blocked(folder, item) -> { code, text } | null (main: schedBlockedOf, the same reason projects.json shows);
// seen = { [norm folder]: { id, blocked, from } } kept by main between patrols.
// The clock starts at the latest of: the item's createdAt, the last end / start of another item of the folder, and the
// patrol that first saw it unblocked after being blocked (a blocked head never counts). -> { findings, seen }
function findNotStarting(backlogs, seen = {}, { now = Date.now(), blocked = () => null, notStartMin = DEFAULTS.notStartMin } = {}) {
  const next = {};
  const out = [];
  for (const b of backlogs || []) {
    if (!b || typeof b.folder !== 'string' || !Array.isArray(b.items)) continue;
    const head = b.items.find((i) => i && i.status === 'pending' && typeof i.id === 'string' && i.id.startsWith('r-'));
    if (!head) continue;
    const k = norm(b.folder);
    let why = null;
    try {
      why = blocked(b.folder, head);
    } catch {}
    if (why) {
      next[k] = { id: head.id, blocked: true, from: 0 };
      continue;
    }
    const others = b.items.filter((i) => i && i !== head);
    const base = Math.max(num(head.createdAt), ...others.map((i) => Math.max(num(i.doneAt), num(i.startedAt))), 0);
    const prev = seen && seen[k];
    const from = prev && prev.id === head.id ? (prev.blocked ? now : num(prev.from) || base) : base;
    next[k] = { id: head.id, blocked: false, from };
    if (!from || now - from < notStartMin * MIN) continue;
    const active = others.filter((i) => i.status === 'active').length;
    out.push({
      key: `not-start:${k}|${head.id}`,
      kind: 'not-start',
      folder: b.folder,
      name: folderName(b.folder),
      text:
        `${head.no ? head.no + ' ' : ''}${head.id} 「${oneLine(head.title || head.text, 50)}」が待ち行列の先頭で、始まらない理由（前提・順番・資源）が無いのに ${ago(now - from)} 始まらない` +
        `（動いている作業 ${active} 件${head.tabId ? `、タブ ${head.tabId} に割り当て済み` : ''}）`,
    });
  }
  return { findings: out, seen: next };
}

// ---- (5) failed: the resume after a restart could not be sent ----------------------------------------------------
const RESUME_FAILED_RE = /^再起動の後に\s*(?:続きを送れ|claude が終了)/;
// backlogs as above; counts = { [norm folder]: number | null } (uncommitted changes, main's git status). Only items that
// ended within withinMs (3 days) are listed.
function findResumeFailed(backlogs, counts = {}, { now = Date.now(), withinMs = 3 * 24 * HOUR } = {}) {
  const out = [];
  for (const b of backlogs || []) {
    if (!b || typeof b.folder !== 'string' || !Array.isArray(b.items)) continue;
    const k = norm(b.folder);
    for (const it of b.items) {
      if (!it || it.status !== 'failed' || !RESUME_FAILED_RE.test(String(it.note || ''))) continue;
      if (num(it.doneAt) && now - num(it.doneAt) > withinMs) continue;
      const c = counts ? counts[k] : undefined;
      const changes = c == null ? '未コミットの変更の数は分からない' : c > 0 ? `作業ツリーに未コミットの変更が ${c} 件残っている` : '未コミットの変更は無い';
      out.push({
        key: `resume:${k}|${it.id}`,
        kind: 'resume',
        folder: b.folder,
        name: folderName(b.folder),
        text: `${it.no ? it.no + ' ' : ''}${it.id} 「${oneLine(it.title || it.text, 50)}」が「${oneLine(it.note, 60)}」で failed（${num(it.doneAt) ? ago(now - num(it.doneAt)) + '前' : '時刻不明'}）。${changes}`,
      });
    }
  }
  return out;
}

// ---- (6) the last reply waits for someone, but nothing is waited on ------------------------------------------------
const WAIT_WORDS_RE = /待つ|待ち|待って|返事|返信|報告を|通知を|wait(?:ing)?\b|reply/i;
// lastReply = the tail of the session's last reply (the renderer's lastAssistantText); wait = its waits entry's wait
// (null / kind 'none' = nothing). -> '' | the line to add to 印なし
function noTarget(lastReply, wait) {
  const t = String(lastReply || '');
  if (!t.trim() || !WAIT_WORDS_RE.test(t)) return '';
  const kind = wait && typeof wait === 'object' ? wait.kind : 'none';
  if (kind && kind !== 'none') return '';
  const m = WAIT_WORDS_RE.exec(t);
  const at = Math.max(0, m.index - 30);
  const quote = oneLine(t.slice(at, m.index + 40), 80);
  return `待つ相手がいない: 最後の返答は「…${quote}…」と待つことを書いているが、waits は none（バックグラウンドのコマンド・担当・サブエージェントのどれも待っていない）`;
}

// ---- report -------------------------------------------------------------------------------------------------------
// findings, reported (keys told before) -> { report, fresh: Set, keys }
function decide(findings, reported = []) {
  const known = new Set(Array.isArray(reported) ? reported : []);
  const keys = (findings || []).map((f) => f.key);
  const fresh = new Set(keys.filter((k) => !known.has(k)));
  return { report: fresh.size > 0, fresh, keys: keys.slice(0, STATE_MAX) };
}

const KIND_WORD = {
  'not-start': '始まらない',
  watch: '終わらない見張り',
  propose: '上限で入らなかった依頼',
  resume: '続きを送れなかった作業',
  dirty: '未コミットのたまり',
  deadline: '期限切れの提案',
};
const KIND_ORDER = Object.keys(KIND_WORD);

// The block for the PMO (≤ TEXT_MAX chars), '' when nothing to say. The meaning and the moves of each kind are in the
// PMO's CLAUDE.md (manager.js, 見回りの節).
// opts.stocktake + opts.held: the daily stocktake adds one line for the refused files told before (holdProposals).
function format(findings, fresh = new Set(), { stocktake = false, held = 0 } = {}) {
  const heldLine = stocktake && held > 0 ? `- ${KIND_WORD.propose} ${held} 件（前に挙げたもの。手当て済みかは PMO が判断）` : '';
  if ((!findings || !findings.length) && !heldLine) return '';
  const list = [...(findings || [])].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const lines = list.slice(0, LIST_MAX).map((f) => `- ${fresh.has(f.key) ? '[新] ' : ''}${KIND_WORD[f.kind] || f.kind} [${f.name}] ${f.text}`);
  if (list.length > LIST_MAX) lines.push(`- ほか ${list.length - LIST_MAX} 件`);
  if (heldLine) lines.push(heldLine);
  return ['見回りの検出（アプリがコードで見つけた事実。haiku には回していない。打ち手は CLAUDE.md の「見回りの検出」）:', ...lines].join('\n').slice(0, TEXT_MAX);
}

module.exports = {
  DEFAULTS,
  settingsOf,
  endlessReason,
  findWatches,
  findProposals,
  holdProposals,
  titleOf,
  findDirty,
  deadlineOf,
  findDeadlines,
  findNotStarting,
  findResumeFailed,
  noTarget,
  decide,
  format,
  KIND_WORD,
};
