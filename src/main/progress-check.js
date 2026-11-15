// 進み具合の確認 (PM1 段 3, docs/plan-pmo-models.md 3 章 (c) / 6 章): once an hour (manager settings
// progressCheckMinutes, default 60, 0 = off) the app compares each folder's PROGRESS.md with its backlog (done / active /
// pending) and lists the gaps it finds by code. When there are gaps, one `claude -p --model haiku` call for all folders
// (prompt on stdin, no tools, time limit, budget limit) turns them into a list of facts: no judgement, no proposals.
// The facts go to 「PMO から」 as one info per folder (key app:progress:<folder>); the same text is not raised again
// (notices.add replaces by key and keeps an unchanged one), and the info is resolved when the folder has no gap left.
// haiku failing or timing out: nothing is shown and nothing wakes the PMO; the next round tries again.
// The gaps to act on (done-open / pending-done whose row haiku listed) also go to the PMO's patrol block, one line each,
// once per key (main runPatrol, pmo.json reported; 依頼-188), and the check runs once before the daily stocktake.
// The interval can be changed on the settings screen (PMO → 進み具合の確認, progress:setSettings; 依頼-189).
// The claude -p runner is src/main/triage.js (段 1); main gives both its one shared runner (one call at a time).
// No Electron imports (testable from plain Node).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const triage = require('./triage'); // the claude -p runner (段 1)

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const DEFAULT_MINUTES = 60;
const MIN_MINUTES = 10;
const MAX_MINUTES = 24 * 60;
const FIRST_MS = 10 * MIN; // first round after start (off the startup path)
const DONE_WINDOW_MS = 7 * DAY; // done items newer than this are compared with the table
const STALE_DAYS = 2; // a 進行中 row not updated for this many days with nothing active in the folder
const GAPS_MAX = 10; // per folder
const FOLDERS_MAX = 20;
const HAIKU_TIMEOUT_MS = 180 * 1000;
const HAIKU_BUDGET_USD = '0.05';
const FACT_MAX = 300;
const KEY_PREFIX = 'app:progress:';

const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const norm = (p) => path.resolve(p).toLowerCase();
const keyOf = (folder) => KEY_PREFIX + folder;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// manager settings -> interval in ms, or 0 (off). progressCheckMinutes: 0 = off, else MIN_MINUTES..MAX_MINUTES.
function intervalOf(settings) {
  const v = settings && settings.progressCheckMinutes;
  if (v === 0 || v === false) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MINUTES * MIN;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(n))) * MIN;
}

// The setting as the screen shows it (依頼-189): { minutes } (0 = off). minutesOf(settings) = intervalOf / MIN.
const minutesOf = (settings) => intervalOf(settings) / MIN;
// What the screen asks for -> the value stored as progressCheckMinutes (0 = off, else clamped like intervalOf).
// Not a number -> null (nothing is written).
function normalizeMinutes(v) {
  if (v === 0 || v === false || v === '0') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n === 0) return 0;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(n)));
}
// The choices of the settings screen (minutes, words); a stored value not among them is shown as 「N 分」.
const CHOICES = [
  [0, '止める'],
  [30, '30 分'],
  [60, '1 時間（既定）'],
  [180, '3 時間'],
  [360, '6 時間'],
  [1440, '1 日'],
];

// The gaps the PMO acts on (依頼-188): a done item whose row is still open, a pending item whose row says 完了.
// They also go to the patrol block (pmo.formatPatrol) once per key; the others (stale / no-check / bad-state) stay info.
const ACT_KINDS = new Set(['done-open', 'pending-done']);
// actions (createProgressCheck().actions()) -> patrol findings (pmo.findStale's shape, kind 'progress-gap').
// key g:<folder>:<ref> (ref names the row, the kind and the backlog item), so a gap that changes is reported again.
function patrolFindings(actions, now = Date.now()) {
  return (actions || []).map((a) => ({
    key: `g:${norm(a.folder)}:${a.ref}`,
    kind: 'progress-gap',
    id: a.row,
    status: a.kind,
    since: now,
    age: 0,
    text: a.fact,
    folder: a.folder,
    name: a.name,
    inboxId: null,
    detail: a.kind === 'done-open' ? 'PROGRESS.md の行を直す' : 'バックログの項目か PROGRESS.md の行を直す',
  }));
}

// Local midnight of YYYY-MM-DD -> whole days to now (null when no date)
function daysSince(ymd, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  const d = new Date(now);
  return Math.max(0, Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - t) / DAY));
}

// A row's # can name a backlog item: it has a letter (so 「9」 does not match 「9 分」) and is short.
const nameable = (n) => typeof n === 'string' && n.length >= 2 && n.length <= 24 && /[A-Za-z]/.test(n);
// Does a backlog item refer to this row? its number (no) is the row's #, or the # stands as a word in its title / head.
function refersTo(it, n) {
  if (!nameable(n)) return false;
  if (it.no && it.no === n) return true;
  const head = `${it.title || ''}\n${String(it.text || '').slice(0, 400)}`;
  return new RegExp(`(^|[^A-Za-z0-9-])${escRe(n)}(?![A-Za-z0-9]|-\\d)`).test(head);
}
const itemName = (it) => oneLine([it.no, it.title || oneLine(it.text, 60)].filter(Boolean).join(' '), 100) || it.id;

// The # of the rows listed in tmp/stable-check/run.mjs (item: '<n>'), or null when the folder has no such file.
function checkListOf(folder) {
  try {
    const text = fs.readFileSync(path.join(folder, 'tmp', 'stable-check', 'run.mjs'), 'utf8');
    const out = new Set();
    for (const m of text.matchAll(/\bitem:\s*'([^']{1,40})'/g)) out.add(m[1]);
    return out;
  } catch {
    return null;
  }
}

// Is a 確認待ち row in the run.mjs list? Its #, a name its 次の一手 runs with --only (「--only 23」, 「--only UX9,AT-1」),
// or the # without a suffix (23c -> 23, UX9-auto -> UX9, PM1-2 -> PM1). A real run (2026-11-14): haiku dropped
// 23c / UX9-auto as no gap, since their 次の一手 runs --only 23 / --only UX9.
function checkedIn(r, checkList) {
  const names = new Set([r.n]);
  for (const m of String(r.next || '').matchAll(/--only[ =]+([^\s）)、。]+)/g)) for (const x of m[1].split(',')) if (x) names.add(x);
  const head = /^([A-Za-z]*\d+)/.exec(r.n);
  if (head) names.add(head[1]);
  const dash = r.n.split('-')[0];
  if (dash) names.add(dash);
  return [...names].some((x) => checkList.has(x));
}

// One folder -> gaps (by code). progress = progress.parseProgress(...) | null, items = backlog items (with no).
//   Gap = { row: '<#>' (or the item id when no row), kind, fact (the app's own one-line statement), ref (stable id) }
// kinds: done-open (a done item, its row still 未着手 / 進行中), pending-done (a pending item, its row 完了),
//        stale (進行中, not updated for STALE_DAYS days, nothing active in the folder),
//        no-check (確認待ち, the folder has tmp/stable-check/run.mjs but the row's # is not in it),
//        bad-state (状態 is none of the 5 words).
function collectGaps({ progress, items = [], now = Date.now(), checkList = null } = {}) {
  if (!progress || !Array.isArray(progress.rows)) return [];
  const rows = progress.rows;
  const gaps = [];
  const push = (g) => gaps.length < GAPS_MAX && gaps.push(g);
  const list = (Array.isArray(items) ? items : []).filter((it) => it && typeof it.id === 'string' && !it.id.startsWith('m-'));
  const active = list.filter((it) => it.status === 'active');
  for (const r of rows) {
    if (r.state === 'その他') {
      push({ row: r.n, kind: 'bad-state', fact: `行 ${r.n}「${oneLine(r.item, 60)}」の状態が 未着手 / 進行中 / 確認待ち / 完了 / 保留 のどれでもない`, ref: `${r.n}:bad-state` });
      continue;
    }
    const refs = list.filter((it) => refersTo(it, r.n));
    if (r.state === '未着手' || r.state === '進行中') {
      const done = refs.filter((it) => it.status === 'done' && it.doneAt && now - it.doneAt <= DONE_WINDOW_MS);
      if (done.length && !refs.some((it) => it.status === 'active' || it.status === 'pending')) {
        push({ row: r.n, kind: 'done-open', fact: `バックログの ${itemName(done[0])} は完了しているが、PROGRESS.md の行 ${r.n} は「${r.state}」のまま（更新日 ${r.updated || 'なし'}）`, ref: `${r.n}:done-open:${done[0].id}` });
        continue;
      }
    }
    if (r.state === '完了') {
      const pend = refs.find((it) => it.status === 'pending');
      if (pend) push({ row: r.n, kind: 'pending-done', fact: `PROGRESS.md の行 ${r.n} は「完了」だが、バックログの ${itemName(pend)} は待ち（pending）のまま`, ref: `${r.n}:pending-done:${pend.id}` });
    }
    if (r.state === '進行中' && !active.length) {
      const d = daysSince(r.updated, now);
      if (d !== null && d >= STALE_DAYS) push({ row: r.n, kind: 'stale', fact: `行 ${r.n}「${oneLine(r.item, 60)}」は「進行中」で ${d} 日更新がなく、このフォルダで動いている作業（active）がない`, ref: `${r.n}:stale` });
    }
    if (r.state === '確認待ち' && checkList && nameable(r.n) && !checkedIn(r, checkList)) {
      push({ row: r.n, kind: 'no-check', fact: `行 ${r.n} は「確認待ち」だが、tmp/stable-check/run.mjs の一覧に ${r.n} の項目がない`, ref: `${r.n}:no-check` });
    }
  }
  return gaps;
}

// What the gaps of all folders look like (the same signature = haiku is not called again; its last facts are reused)
function signature(folders) {
  const s = folders.map((f) => `${norm(f.folder)}\n${f.gaps.map((g) => g.ref).sort().join('\n')}`).sort().join('\n\n');
  return crypto.createHash('sha1').update(s).digest('hex');
}

// The prompt for haiku (stdin). folders = [{ folder, name, gaps, rows (the rows the gaps name), items (the items they name) }]
function buildPrompt(folders) {
  const parts = [
    'あなたは進み具合の突き合わせの係です。アプリがフォルダごとに PROGRESS.md の表とバックログを比べ、ずれの候補を挙げました。',
    '候補ごとに、下の表の行とバックログの項目を見て、本当にずれているものだけを事実として 1 文で書いてください。',
    '決まり: 事実だけを書く。判断・提案・推測・「〜すべき」「〜してください」は書かない。候補に無いずれを足さない。ずれでない候補は出さない。',
    '答えは JSON だけ: {"facts":[{"folder":<フォルダの番号>,"row":"<行の #>","fact":"<事実の 1 文、日本語、150 字まで>"}]}',
    '',
  ];
  folders.forEach((f, i) => {
    parts.push(`## フォルダ ${i}: ${f.name}`);
    parts.push('ずれの候補:');
    for (const g of f.gaps) parts.push(`- 行 ${g.row} (${g.kind}): ${g.fact}`);
    if (f.rows.length) {
      parts.push('PROGRESS.md の該当の行（# | 項目 | 状態 | 次の一手 | 更新日）:');
      for (const r of f.rows) parts.push(`| ${r.n} | ${oneLine(r.item, 120)} | ${r.state} | ${oneLine(r.next, 200)} | ${r.updated} |`);
    }
    if (f.items.length) {
      parts.push('バックログの該当の項目:');
      for (const it of f.items) parts.push(`- ${itemName(it)} [${it.status}] ${oneLine(it.note, 200)}`);
    }
    parts.push('');
  });
  return parts.join('\n');
}

const FACTS_SCHEMA = {
  type: 'object',
  properties: { facts: { type: 'array', items: { type: 'object', properties: { folder: { type: 'integer' }, row: { type: 'string' }, fact: { type: 'string' } }, required: ['folder', 'row', 'fact'] } } },
  required: ['facts'],
};

// The stdout of `claude -p --output-format json` -> [{ folder, row, fact }] | null (not readable).
// Takes structured_output (with --json-schema), else the JSON inside result.
function parseFacts(stdout) {
  let o;
  try {
    o = JSON.parse(String(stdout || '').trim());
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || o.is_error === true) return null;
  let body = o.structured_output && typeof o.structured_output === 'object' ? o.structured_output : null;
  if (!body && typeof o.result === 'string') {
    const t = o.result;
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        body = JSON.parse(t.slice(a, b + 1));
      } catch {}
    }
  }
  if (!body && Array.isArray(o.facts)) body = o;
  if (!body || !Array.isArray(body.facts)) return null;
  return body.facts
    .filter((x) => x && Number.isInteger(x.folder) && typeof x.row === 'string' && typeof x.fact === 'string' && x.fact.trim())
    .map((x) => ({ folder: x.folder, row: x.row.trim(), fact: oneLine(x.fact, FACT_MAX) }));
}

// Only facts about a row that a gap named in that folder (haiku cannot add folders or rows).
function factsByFolder(folders, facts) {
  const out = new Map();
  for (const x of facts || []) {
    const f = folders[x.folder];
    if (!f || !f.gaps.some((g) => g.row === x.row)) continue;
    const l = out.get(f.folder) || [];
    if (l.length < GAPS_MAX && !l.some((y) => y.row === x.row && y.fact === x.fact)) l.push({ row: x.row, fact: x.fact });
    out.set(f.folder, l);
  }
  return out;
}

// One folder's facts -> the notice (info). The text names the rows so the same facts give the same text.
function noticeOf(folder, name, facts) {
  return {
    kind: 'info',
    title: `進み具合のずれ: ${name}（${facts.length} 件）`,
    text: facts.map((x) => `- 行 ${x.row}: ${x.fact}`).join('\n') + '\n\n（アプリが PROGRESS.md とバックログを比べ、haiku が事実として並べたもの。判断はしていません。ずれが無くなると消えます）',
    folder,
    key: keyOf(folder),
    source: 'app',
    refs: facts.map((x) => `row:${x.row}`),
  };
}

// How to start claude for `-p`: src/main/triage.js (段 1) holds it now; kept here under the same name.
const claudeProgram = triage.claudeProgram;

// The default context (MCP servers, skills, the long system prompt) was ~200k tokens a turn and went over the budget
// (2026-11-14, real run): no MCP, no skills, a short system prompt. --tools "" last (it may swallow what follows).
const SYSTEM_PROMPT = 'You compare a project progress table with a task list and only list facts, in Japanese, as the JSON the user asks for.';
const HAIKU_ARGS = ['-p', '--model', 'haiku', '--no-session-persistence', '--output-format', 'json', '--max-budget-usd', HAIKU_BUDGET_USD, '--strict-mcp-config', '--disable-slash-commands', '--system-prompt', SYSTEM_PROMPT, '--json-schema', JSON.stringify(FACTS_SCHEMA), '--tools', ''];

// One `claude -p --model haiku` with the prompt on stdin -> { ok: true, stdout } | { ok: false, error }.
// program = { file, pre } (claudeProgram), cwd = a scratch folder of the app. Killed after timeoutMs.
function runHaiku(prompt, { program, cwd, env = process.env, timeoutMs = HAIKU_TIMEOUT_MS, spawnFn } = {}) {
  return triage.runClaude(prompt, { program, args: HAIKU_ARGS, cwd, env, timeoutMs, ...(spawnFn ? { spawnFn } : {}) });
}

// createProgressCheck({ folders: async () => [{ folder, name?, progress, items, checkList? }], notices, ask: async (prompt) => stdout|null })
//   runOnce(now) -> { folders, gaps, called, ok, shown, resolved, actions }
//   actions() -> [{ folder, name, row, kind, fact, ref }] the done-open / pending-done gaps of the last good round
//                whose row haiku also listed (for the patrol block, patrolFindings)
// One round: gaps by code; no gap anywhere -> no haiku, every app:progress info resolved. Gaps -> haiku once for all
// folders (not again while the gaps stay the same: the last facts are reused). haiku failed -> nothing changes.
function createProgressCheck({ folders, notices, ask }) {
  let last = { sig: null, facts: null };
  let running = false;
  let acts = [];
  async function runOnce(now = Date.now()) {
    if (running) return null;
    running = true;
    try {
      const all = (await folders()) || [];
      const withGaps = [];
      const seen = new Set();
      for (const f of all.slice(0, FOLDERS_MAX)) {
        if (!f || typeof f.folder !== 'string' || seen.has(norm(f.folder))) continue;
        seen.add(norm(f.folder));
        const gaps = collectGaps({ progress: f.progress, items: f.items, now, checkList: f.checkList || null });
        if (!gaps.length) continue;
        const rowsNamed = new Set(gaps.map((g) => g.row));
        withGaps.push({
          folder: f.folder,
          name: f.name || path.basename(f.folder),
          gaps,
          rows: ((f.progress && f.progress.rows) || []).filter((r) => rowsNamed.has(r.n)),
          items: (f.items || []).filter((it) => [...rowsNamed].some((n) => refersTo(it, n))).slice(0, 20),
        });
      }
      const res = { folders: all.length, gaps: withGaps.reduce((s, f) => s + f.gaps.length, 0), called: false, ok: true, shown: 0, resolved: 0 };
      const live = new Set(withGaps.map((f) => keyOf(f.folder)));
      // folders with no gap any more: their info goes
      for (const n of notices.list()) {
        if (n.key && n.key.startsWith(KEY_PREFIX) && !live.has(n.key) && notices.resolve(n.key)) res.resolved++;
      }
      if (!withGaps.length) {
        last = { sig: null, facts: null };
        acts = [];
        res.actions = 0;
        return res;
      }
      const sig = signature(withGaps);
      let facts = last.sig === sig ? last.facts : null;
      if (!facts) {
        res.called = true;
        let stdout = null;
        try {
          stdout = await ask(buildPrompt(withGaps));
        } catch {
          stdout = null;
        }
        const parsed = stdout == null ? null : parseFacts(stdout);
        if (!parsed) {
          res.ok = false; // quiet: the next round tries again (nothing wakes the PMO)
          return res;
        }
        facts = factsByFolder(withGaps, parsed);
        last = { sig, facts };
      }
      const nextActs = [];
      for (const f of withGaps) {
        const l = facts.get(f.folder) || [];
        if (!l.length) {
          if (notices.resolve(keyOf(f.folder))) res.resolved++; // haiku found no real gap here
          continue;
        }
        const r = notices.add(noticeOf(f.folder, f.name, l));
        if (r && !r.unchanged) res.shown++;
        const confirmed = new Set(l.map((x) => x.row));
        for (const g of f.gaps) if (ACT_KINDS.has(g.kind) && confirmed.has(g.row)) nextActs.push({ folder: f.folder, name: f.name, row: g.row, kind: g.kind, fact: g.fact, ref: g.ref });
      }
      acts = nextActs;
      res.actions = acts.length;
      return res;
    } finally {
      running = false;
    }
  }
  return { runOnce, actions: () => acts.slice() };
}

module.exports = {
  createProgressCheck,
  collectGaps,
  checkListOf,
  refersTo,
  buildPrompt,
  parseFacts,
  factsByFolder,
  noticeOf,
  signature,
  intervalOf,
  minutesOf,
  normalizeMinutes,
  patrolFindings,
  ACT_KINDS,
  CHOICES,
  claudeProgram,
  runHaiku,
  HAIKU_ARGS,
  KEY_PREFIX,
  FIRST_MS,
  DEFAULT_MINUTES,
  HAIKU_TIMEOUT_MS,
};
