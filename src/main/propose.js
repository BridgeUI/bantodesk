// UIUX U7 (依頼-50 A, docs/concept-uiux.md §4 U7, docs/plan-propose.md): a session the app routed puts "the next thing to
// do" into the inbox (依頼) instead of carrying on with it in the same, ever heavier session.
//
// The session writes a JSON file into its own folder: <folder>/.bantodesk/outbox/<name>.json (git-ignored by
// <folder>/.bantodesk/.gitignore = "*"). BN3: the former <folder>/.agent-terminal/outbox is still read (sessions started
// before the rename were told that place). The place of the file is the proof of the folder (no folder field is
// accepted). The app looks at the outbox of every open project window (a small synchronous look every POLL_MS, like
// the ルーター outbox's AT-202 poll), checks the file all or nothing, adds the proposals to the inbox (source 'session',
// status new: the ルーター gets them as 新規; hold over a limit, below) and moves the file to done/ (+ <name>.result.json)
// or failed/ (+ .error.txt).
//
// File = one proposal, an array of them, or { proposals: [...] }. Proposal =
//   { type: 'propose', title, text, kind?: research|implement|verify, touches?: [...], after?: [...], reason?, from? }
// from = the backlog id of the session's own work (the app adds 「この作業の id: …」 to a routed session's text);
// without it the folder's one active routed item is taken (none / several -> no backlog id).
// The project starter (docs/plan-starter.md) is to reuse this outbox for its own action types.
//
// Limits (依頼 2026-11-16): a proposal over the folder's 24 h limit (manager-settings.json proposeDayMax, default 30) or
// over the 10 of one work still goes to the inbox, as status hold with the note 「上限を超えた propose（…）」 (the ルーター
// takes it up at the stocktake; it is not offered as 新規), and the file goes to done/ with hold: true in its result.
// Only a runaway (more than HOLD_FACTOR × a limit) and a bad shape are refused (failed/).
// No Electron imports (testable from plain Node).
const path = require('path');
const fs = require('fs');

const { META_DIR, LEGACY_META_DIR } = require('./names');
const writeq = require('./writeq');

const OUTBOX_REL = path.join(META_DIR, 'outbox');
const LEGACY_OUTBOX_REL = path.join(LEGACY_META_DIR, 'outbox'); // BN3 compat: read only
const PER_FILE = 5; // 「一度に 5 件」: a file with more is refused as a whole
const PER_WORK = 10; // proposals of one backlog item (session) in all; more -> hold
const PER_FOLDER_DAY = 30; // default of proposals of one folder in 24 h (proposeDayMax); more -> hold
const DAY_MAX_RANGE = [1, 1000]; // proposeDayMax outside -> the default
const HOLD_FACTOR = 3; // runaway guard: past HOLD_FACTOR × a limit nothing more is added (failed/)
const HOLD_NOTE = '上限を超えた propose';
const SETTINGS_FILE = 'manager-settings.json'; // userData/manager-settings.json, next to inbox.json
const DAY_MS = 24 * 3600 * 1000;
const TITLE_MAX = 200;
const TEXT_MAX = 20000;
const REASON_MAX = 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const OPEN = new Set(['new', 'asking', 'hold']);
const POLL_MS = 2000;
const FILES_PER_TICK = 10;

const outboxOf = (folder) => path.join(folder, OUTBOX_REL);
// the outboxes that are read: the new one, then the former one
const outboxesOf = (folder) => [outboxOf(folder), path.join(folder, LEGACY_OUTBOX_REL)];
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const normKey = (s) => squash(s).toLowerCase();
const sameFolder = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// manager settings ({ proposeDayMax }) -> the folder's 24 h limit. Missing / bad / out of range -> PER_FOLDER_DAY.
function dayLimitOf(settings) {
  const n = Number(settings && typeof settings === 'object' ? settings.proposeDayMax : undefined);
  return Number.isInteger(n) && n >= DAY_MAX_RANGE[0] && n <= DAY_MAX_RANGE[1] ? n : PER_FOLDER_DAY;
}
// <dir>/manager-settings.json (a write still queued in writeq counts) -> the limit
function readDayLimit(dir) {
  try {
    return dayLimitOf(JSON.parse(writeq.readTextSync(path.join(dir, SETTINGS_FILE))));
  } catch {
    return PER_FOLDER_DAY;
  }
}
// ctx.dayLimit (number | () => number) when given, else the settings next to the inbox file (ctx.settingsDir or
// dirname(inbox.file) = userData), else the default. Read for every file, so a change applies without a restart.
function dayLimitFor(ctx) {
  const c = ctx || {};
  if (c.dayLimit !== undefined && c.dayLimit !== null) {
    let v = c.dayLimit;
    try {
      if (typeof v === 'function') v = v();
    } catch {
      v = undefined;
    }
    return dayLimitOf({ proposeDayMax: v });
  }
  const dir = c.settingsDir || (c.inbox && typeof c.inbox.file === 'string' ? path.dirname(c.inbox.file) : null);
  return dir ? readDayLimit(dir) : PER_FOLDER_DAY;
}

// <folder>/.bantodesk/outbox (+ the .gitignore that keeps .bantodesk/ out of git). -> outbox path | null
function ensureOutbox(folder) {
  try {
    const base = path.join(folder, META_DIR);
    fs.mkdirSync(path.join(base, 'outbox'), { recursive: true });
    const gi = path.join(base, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
    return path.join(base, 'outbox');
  } catch {
    return null;
  }
}

// The shape check of one file, all or nothing. hints(a) = manager.schedHints (kind / touches / after).
// -> { proposals: [{ title, text, reason, from, fields }] } | { error }
function validate(raw, hints) {
  let list = raw;
  if (raw && !Array.isArray(raw) && typeof raw === 'object' && Array.isArray(raw.proposals)) list = raw.proposals;
  if (!Array.isArray(list)) list = [list];
  if (!list.length) return { error: 'no proposals' };
  if (list.length > PER_FILE) return { error: `too many proposals in one file (${list.length}, max ${PER_FILE}); nothing was added` };
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const at = list.length > 1 ? `#${i + 1}: ` : '';
    if (!a || typeof a !== 'object' || Array.isArray(a)) return { error: `${at}not an object` };
    if (a.type !== 'propose') return { error: `${at}type must be "propose" (got ${JSON.stringify(a.type)})` };
    if (a.folder !== undefined) return { error: `${at}folder is not accepted (the file's place decides the folder)` };
    const text = typeof a.text === 'string' ? a.text.trim() : '';
    if (!text) return { error: `${at}text is required (a self-contained instruction)` };
    if (text.length > TEXT_MAX) return { error: `${at}text too long (max ${TEXT_MAX})` };
    if (a.title !== undefined && typeof a.title !== 'string') return { error: `${at}title must be a string` };
    const title = squash(a.title).slice(0, TITLE_MAX);
    if (a.reason !== undefined && typeof a.reason !== 'string') return { error: `${at}reason must be a string` };
    const reason = squash(a.reason).slice(0, REASON_MAX);
    if (a.from !== undefined && a.from !== null && (typeof a.from !== 'string' || !ID_RE.test(a.from))) return { error: `${at}bad from ${JSON.stringify(a.from)} (the backlog id of this work)` };
    const h = hints ? hints(a) : { fields: {} };
    if (h.error) return { error: at + h.error };
    out.push({ title, text, reason, from: a.from || null, fields: h.fields || {} });
  }
  return { proposals: out };
}

// The session the file came from: `from` when it is a backlog item of the folder, else the one active routed item.
// -> { backlogId, no, tabId } (each may be null)
function whoProposed(from, backlogItems) {
  const items = Array.isArray(backlogItems) ? backlogItems : [];
  let it = from ? items.find((i) => i && i.id === from) : null;
  if (!it && !from) {
    const act = items.filter((i) => i && i.status === 'active' && typeof i.id === 'string' && i.id.startsWith('r-'));
    if (act.length === 1) it = act[0];
  }
  if (!it) return { backlogId: null, no: null, tabId: null };
  return { backlogId: it.id, no: it.no || null, tabId: typeof it.tabId === 'string' ? it.tabId : null };
}

// Adds checked proposals to the inbox. Duplicates (an open item from a session of the same folder with the same text
// or title, or an open item of anyone with the same text) are not added again; their result names the existing id.
// The limits: a fresh proposal past the folder's 24 h limit (dayMax) or past PER_WORK of its work is added as hold with
// the note HOLD_NOTE (in file order: the ones still under both limits are new). The runaway guard (HOLD_FACTOR × a limit)
// is checked before anything is added (all or nothing).
// -> { results: [{ type, itemId, reqNo, duplicate?, hold?, note? }] } | { error }
function apply({ folder, proposals, backlogItems, inbox, now = Date.now(), dayMax = PER_FOLDER_DAY }) {
  const limit = dayLimitOf({ proposeDayMax: dayMax });
  const items = inbox.get().items;
  const fromFolder = items.filter((i) => i.source === 'session' && sameFolder(i.folder, folder));
  // plan = { p, who, dupItem (an existing inbox item) | dupOf (an earlier plan of this file) | neither }
  const plans = [];
  const same = (tk, ti, text, title) => normKey(text) === tk || (!!ti && normKey(title) === ti);
  for (const p of proposals) {
    const who = whoProposed(p.from, backlogItems);
    const tk = normKey(p.text);
    const ti = p.title ? normKey(p.title) : '';
    const dupItem =
      items.find((i) => OPEN.has(i.status) && normKey(i.text) === tk) ||
      fromFolder.find((i) => OPEN.has(i.status) && ti && normKey(i.title) === ti) ||
      null;
    const dupOf = dupItem ? null : plans.find((x) => !x.dupItem && !x.dupOf && same(tk, ti, x.p.text, x.p.title)) || null;
    plans.push({ p, who, dupItem, dupOf, dup: !!(dupItem || dupOf) });
  }
  const fresh = plans.filter((x) => !x.dup);
  let day = fromFolder.filter((i) => now - (i.createdAt || 0) < DAY_MS).length;
  const dayHard = limit * HOLD_FACTOR;
  if (day + fresh.length > dayHard) return { error: `too many proposals from this folder today (${day} in 24 h, limit ${limit}, held up to ${dayHard}); nothing was added` };
  const perWork = new Map(); // backlogId -> proposals of that work so far
  const adding = new Map();
  for (const x of fresh) if (x.who.backlogId) adding.set(x.who.backlogId, (adding.get(x.who.backlogId) || 0) + 1);
  const workHard = PER_WORK * HOLD_FACTOR;
  for (const [id, n] of adding) {
    const had = fromFolder.filter((i) => i.origin && i.origin.backlogId === id).length;
    if (had + n > workHard) return { error: `too many proposals from the work ${id} (${had} before, limit ${PER_WORK}, held up to ${workHard}); nothing was added` };
    perWork.set(id, had);
  }
  const results = [];
  for (const x of plans) {
    if (x.dup) {
      const d = x.dupItem || (x.dupOf && x.dupOf.added) || null;
      results.push({ type: 'propose', itemId: d ? d.id : null, reqNo: d ? d.reqNo || null : null, duplicate: true });
      continue;
    }
    const id = x.who.backlogId;
    const overDay = day >= limit;
    const overWork = !!id && perWork.get(id) >= PER_WORK;
    const note = overDay || overWork ? `${HOLD_NOTE}（${overDay ? `このフォルダの 24 時間の上限 ${limit} 件` : `この作業 ${x.who.no || id} の上限 ${PER_WORK} 件`}を超えた）` : '';
    const origin = { folder, backlogId: id, no: x.who.no, tabId: x.who.tabId, reason: x.p.reason, ...x.p.fields };
    const it = inbox.add({ text: x.p.text, title: x.p.title, source: 'session', folder, origin, ...(note ? { status: 'hold', note } : {}) });
    if (!it) return { error: 'the inbox refused the item', results };
    x.added = it;
    day++;
    if (id) perWork.set(id, perWork.get(id) + 1);
    results.push({ type: 'propose', itemId: it.id, reqNo: it.reqNo || null, ...(note ? { hold: true, note } : {}) });
  }
  return { results };
}

function moveTo(dir, file) {
  fs.mkdirSync(dir, { recursive: true });
  let dest = path.join(dir, path.basename(file));
  if (fs.existsSync(dest)) dest = path.join(dir, `${Date.now()}-${path.basename(file)}`);
  fs.renameSync(file, dest);
  return dest;
}

// One file of <folder>/.bantodesk/outbox (or the former .agent-terminal/outbox). ctx = { inbox, hints(a), backlogItems(folder) -> items | Promise,
// onAdded?(folder, results), dayLimit?, settingsDir? (dayLimitFor) }. -> { ok, error?, results }
async function processFile(file, folder, ctx) {
  let res;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, error: 'gone', results: [] };
    res = { ok: false, error: `invalid JSON: ${err && err.message}`, results: [] };
  }
  if (!res) {
    const v = validate(raw, ctx.hints);
    if (v.error) res = { ok: false, error: v.error, results: [] };
    else {
      let items = [];
      try {
        items = (await ctx.backlogItems(folder)) || [];
      } catch {}
      const a = apply({ folder, proposals: v.proposals, backlogItems: items, inbox: ctx.inbox, dayMax: dayLimitFor(ctx) });
      res = a.error ? { ok: false, error: a.error, results: a.results || [] } : { ok: true, results: a.results };
    }
  }
  const outbox = path.dirname(file);
  try {
    if (res.ok) {
      const dest = moveTo(path.join(outbox, 'done'), file);
      fs.writeFileSync(dest + '.result.json', JSON.stringify(res.results, null, 1) + '\n');
    } else {
      const dest = moveTo(path.join(outbox, 'failed'), file);
      fs.writeFileSync(dest + '.error.txt', res.error + '\n');
    }
  } catch (err) {
    console.warn('[propose] moving the file failed', err && err.message);
  }
  if (res.ok && ctx.onAdded) {
    try {
      ctx.onAdded(folder, res.results);
    } catch {}
  }
  if (!res.ok && ctx.onFailed) {
    try {
      ctx.onFailed(folder, path.basename(file), res.error);
    } catch {}
  }
  return res;
}

// Looks at the outbox of folders() every intervalMs. A file is taken once its size did not change since the last look
// and it is at least 1 s old (written completely); files are handled one at a time. -> { close(), tick() }
function watch(folders, ctx, { intervalMs = POLL_MS } = {}) {
  let sizes = new Map();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const next = new Map();
      const ready = [];
      const now = Date.now();
      let list = [];
      try {
        list = folders() || [];
      } catch {}
      for (const folder of list) {
        for (const box of outboxesOf(folder)) {
        let names;
        try {
          names = fs.readdirSync(box);
        } catch {
          continue; // no outbox yet
        }
        for (const n of names) {
          if (!/\.json$/i.test(n) || /\.result\.json$/i.test(n)) continue;
          const f = path.join(box, n);
          let st;
          try {
            st = fs.statSync(f);
          } catch {
            continue;
          }
          if (!st.isFile()) continue;
          next.set(f, st.size);
          if (sizes.get(f) === st.size && now - st.mtimeMs >= 1000) ready.push({ f, folder });
        }
        }
      }
      sizes = next;
      for (const r of ready.slice(0, FILES_PER_TICK)) {
        await processFile(r.f, r.folder, ctx).catch((err) => console.warn('[propose]', err && err.message));
        sizes.delete(r.f);
      }
    } finally {
      busy = false;
    }
  };
  const t = setInterval(tick, intervalMs);
  if (t.unref) t.unref();
  return { close: () => clearInterval(t), tick };
}

module.exports = { OUTBOX_REL, LEGACY_OUTBOX_REL, outboxesOf, PER_FILE, PER_WORK, PER_FOLDER_DAY, DAY_MAX_RANGE, HOLD_FACTOR, HOLD_NOTE, SETTINGS_FILE, dayLimitOf, readDayLimit, dayLimitFor, outboxOf, ensureOutbox, validate, whoProposed, apply, processFile, watch };
