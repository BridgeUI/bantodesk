// UX11 止まらない C: 見張りの抜けを埋める (docs/ux-journey.md §1.6 rows 6・7・8・9・11・17・20, §4 C; the check table
// docs/ux11-check.md). The rules main uses for the gaps of its watchers. No Electron imports (testable from plain Node,
// tmp/nonstop/unit2.js); main.js gathers the inputs. The other halves live where their data is: the quiet running
// session in waits.js (runningOf / checkInterrupt), the ルーター's outbox failures in manager.js (onFailed / outbox の失敗).
//
//   9  after-failed: a pending item whose prerequisite failed waits forever. afterFailed() turns the scheduler's
//      reasons (code after-failed) into one 見回り line per item for the ルーター, at once (not at the next patrol).
//   11 closed folders: the queues of folders without a window were read only from recent-folders.json (≤ 12, and a
//      folder opened hidden for a route is never put there). knownFolders() adds every folder the backlog's number
//      registry (backlog/numbers.json) knows.
//   17 the ルーター's heartbeat: heartbeat() = when it last took a prompt (an m- item started) and how many wait;
//      wakeOf() decides whether to wake it (Esc when its claude is stuck 実行中, a restart when it sits idle / ended).
//   outlook: the ルーター's one-line view of a folder's card (outbox outlook -> manager/outlook.json -> projects.json).
const path = require('path');

const MIN = 60 * 1000;
const HEART_STALE_MS = 20 * MIN; // no prompt taken for this long while one waits -> wake the ルーター
const OUTLOOK_MAX = 120;
const OUTLOOK_FOLDERS_MAX = 200;

const norm = (p) => path.resolve(String(p || '')).toLowerCase();
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const folderName = (f) => path.basename(String(f || '')) || String(f || '');

// ---- 11 ------------------------------------------------------------------------------------------------------------
// recent (recent-folders.json, newest first) + registry (backlog numbers.json folders) -> one list, recent first, no
// duplicates (case-insensitive paths), only those ok(folder) accepts (an existing directory with a backlog file, not the
// manager folder). -> [folder]
function knownFolders(recent, registry, ok = () => true) {
  const out = [];
  const seen = new Set();
  for (const f of [...(Array.isArray(recent) ? recent : []), ...(Array.isArray(registry) ? registry : [])]) {
    if (typeof f !== 'string' || !f) continue;
    const k = norm(f);
    if (seen.has(k)) continue;
    seen.add(k);
    let good = false;
    try {
      good = !!ok(f);
    } catch {}
    if (good) out.push(f);
  }
  return out;
}

// ---- 9 -------------------------------------------------------------------------------------------------------------
// waiting = [{ folder, reasons: { [id]: { code, text } } }] (the scheduler's), itemOf(folder, id) -> { no, title, text } |
// null. -> [{ key, id, folder, line }] for the after-failed reasons (key = `${id}\nafter-failed`, told once by main)
function afterFailed(waiting, itemOf = () => null) {
  const out = [];
  for (const w of Array.isArray(waiting) ? waiting : []) {
    if (!w || typeof w.folder !== 'string' || !w.reasons || typeof w.reasons !== 'object') continue;
    for (const [id, r] of Object.entries(w.reasons)) {
      if (!r || r.code !== 'after-failed') continue;
      let it = null;
      try {
        it = itemOf(w.folder, id);
      } catch {}
      const name = it && it.no ? it.no : id;
      const title = it ? oneLine(it.title || it.text, 40) : '';
      out.push({
        key: `${id}\nafter-failed`,
        id,
        folder: w.folder,
        line: `前提の失敗: [${folderName(w.folder)}] ${name}${title ? ` 「${title}」` : ''}は${oneLine(r.text, 80)}（このままでは始まりません。前提を直して振り直すか、after を付け直すか、dropped に）`,
      });
    }
  }
  return out;
}

// ---- outbox failures (row 20) ---------------------------------------------------------------------------------------
// { name, errors, applied } (manager.js onFailed) -> one line for the next prompt
function outboxFailLine(f) {
  if (!f || typeof f.name !== 'string') return '';
  const errs = (Array.isArray(f.errors) ? f.errors : []).map((e) => oneLine(e, 120)).filter(Boolean);
  return `${oneLine(f.name, 80)}: ${errs.join(' / ') || '理由不明'}${num(f.applied) ? `（${f.applied} 件は適用済み）` : ''}`;
}

// ---- 17 ------------------------------------------------------------------------------------------------------------
// items = the manager folder's backlog items (m- prompts: pending = not taken yet; startedAt = when the ルーター's tab took
// it), inboxNew = inbox items still new, pmo = the ルーター tab's TabState | null.
// -> { updatedAt, lastReceivedAt, pending, inboxNew, oldestPendingAt, status, stale }
//    status: 'ok' | 'busy' (it works on a prompt) | 'waiting' (a prompt waits, not long yet) | 'stale' (HEART_STALE_MS
//    without taking one while one waits) | 'none' (no ルーター tab)
function heartbeat({ items = [], inboxNew = 0, pmo = null, now = Date.now(), staleMs = HEART_STALE_MS } = {}) {
  const ms = (Array.isArray(items) ? items : []).filter((i) => i && typeof i.id === 'string' && i.id.startsWith('m-'));
  const pend = ms.filter((i) => i.status === 'pending');
  const lastReceivedAt = Math.max(0, ...ms.map((i) => num(i.startedAt)));
  const oldestPendingAt = pend.length ? Math.min(...pend.map((i) => num(i.createdAt) || now)) : 0;
  const working = ms.some((i) => i.status === 'active');
  let status = 'ok';
  if (!pmo) status = 'none';
  else if (pend.length) {
    const since = Math.max(oldestPendingAt, lastReceivedAt);
    status = now - since >= staleMs ? 'stale' : 'waiting';
  } else if (working) status = 'busy';
  return {
    updatedAt: now,
    lastReceivedAt: lastReceivedAt || null,
    pending: pend.length,
    inboxNew: Math.max(0, Math.round(num(inboxNew))),
    oldestPendingAt: oldestPendingAt || null,
    status,
    stale: status === 'stale',
  };
}
// hb = heartbeat(), pmo = the ルーター tab's TabState, quiet = waits.runningOf(pmo) is not null (its claude 実行中 with no
// transcript line for 15 min), allowed = Nonstop.wakeAllowed(...).ok. -> { mode: 'esc'|'restart', why } | null
//   running + quiet -> Esc (the pending prompt is sent when it is idle again); running with lines -> not woken (it works,
//   the prompt waits for its turn); idle / starting / ended -> restart (claude --resume); asking -> not (a dialog:
//   stuck.managerStuckNotice tells the user)
function wakeOf(hb, pmo, { quiet = false, allowed = true } = {}) {
  if (!hb || !hb.stale || !pmo || pmo.rest || !allowed) return null;
  const st = String(pmo.status || '');
  if (st === 'asking') return null;
  if (st === 'running') return quiet ? { mode: 'esc', why: 'running-quiet' } : null;
  return { mode: 'restart', why: st || 'unknown' };
}

// ---- outlook -------------------------------------------------------------------------------------------------------
// { folder, text } from the outbox -> { folder, text } | { error }. folder: absolute; text: ≤ OUTLOOK_MAX chars on one
// line ('' clears it).
function cleanOutlook(a) {
  if (!a || typeof a.folder !== 'string' || !path.isAbsolute(a.folder)) return { error: 'folder must be an absolute path' };
  if (typeof a.text !== 'string') return { error: 'text missing' };
  const text = oneLine(a.text, 2000);
  if (text.length > OUTLOOK_MAX) return { error: `text too long (${text.length} > ${OUTLOOK_MAX} chars)` };
  return { folder: path.resolve(a.folder), text };
}
// The store (manager/outlook.json = { folders: { [norm(folder)]: { folder, text, at } } }); read / write are injected.
function createOutlooks({ read = () => null, write = () => {} } = {}) {
  let data = null;
  const load = () => {
    if (data) return data;
    data = { folders: {} };
    try {
      const raw = read();
      for (const [k, v] of Object.entries((raw && raw.folders) || {})) {
        if (v && typeof v.folder === 'string' && typeof v.text === 'string' && v.text) data.folders[k] = { folder: v.folder, text: oneLine(v.text, OUTLOOK_MAX), at: num(v.at) || null };
      }
    } catch {}
    return data;
  };
  return {
    get(folder) {
      return load().folders[norm(folder)] || null;
    },
    set(folder, text, now = Date.now()) {
      const d = load();
      const k = norm(folder);
      if (!text) delete d.folders[k];
      else d.folders[k] = { folder: path.resolve(folder), text, at: now };
      const keys = Object.keys(d.folders);
      if (keys.length > OUTLOOK_FOLDERS_MAX) {
        keys.sort((a, b) => (d.folders[a].at || 0) - (d.folders[b].at || 0));
        for (const x of keys.slice(0, keys.length - OUTLOOK_FOLDERS_MAX)) delete d.folders[x];
      }
      write(d);
      return d.folders[k] || null;
    },
  };
}

module.exports = { HEART_STALE_MS, OUTLOOK_MAX, knownFolders, afterFailed, outboxFailLine, heartbeat, wakeOf, cleanOutlook, createOutlooks };
