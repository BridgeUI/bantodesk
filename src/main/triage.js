// 見回りの前さばき (PM1 段 1, docs/plan-pmo-models.md 3 章 (a) / 6 章 / 5 章の線引き).
// Two parts, no Electron imports (testable from plain Node):
//   1. The `claude -p --model haiku` runner every app-side haiku call uses (this file and src/main/progress-check.js):
//      the program itself (no shell), the prompt on stdin, no tools / MCP / skills, a short system prompt (without these a
//      call read ~200k tokens, docs/plan-pmo-models.md 6 章), a budget limit, killed after the time limit (120 s by
//      default). createRunner adds: one call at a time across the app, and no call while free memory is under the
//      scheduler's mark (the caller's memOk) -> { ok: false } so the caller falls to its safe side.
//   2. The patrol's triage: the app keeps a summary of the state (inbox, backlogs, waits, sessions waiting on a prompt,
//      PROGRESS.md 確認待ち) in manager/pmo.json and diffs it by code each patrol. Changes the other triggers already wake
//      the ルーター for (new / changed inbox items, done / failed, a new wait alert, a prompt) and changes that mean nothing
//      (an item started, a wait ended) are dropped; only the unsure ones go to haiku, which lists facts and says whether
//      there is something the ルーター has to act on (no judgement of what to do: that stays with the ルーター). Failing / timing
//      out / busy / low memory -> the ルーター is woken. A change haiku let pass is woken for at the latest CAP_MS after the
//      last patrol wake. No unsure change -> no haiku call, nothing woken (the stale findings keep their own rule).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MIN = 60 * 1000;
const DEFAULT_PATROL_MINUTES = 5;
const MIN_PATROL_MINUTES = 1;
const MAX_PATROL_MINUTES = 60;
const CAP_MS = 30 * MIN; // a change haiku let pass wakes the ルーター at the latest this long after the last patrol wake
const TIMEOUT_MS = 120 * 1000;
const BUDGET_USD = '0.02';
const OUT_MAX = 256 * 1024;
const REFS_MAX = 600; // refs kept in the summary
const CHANGES_MAX = 30; // unsure changes given to haiku / kept as let pass
const POINT_MAX = 200;

const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const norm = (p) => path.resolve(p).toLowerCase();

// ---- settings ----------------------------------------------------------------------------------------------------
// manager settings -> the patrol interval in ms. patrolMinutes: default 5, 1..60.
function patrolEveryMs(settings) {
  const n = Number(settings && settings.patrolMinutes);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PATROL_MINUTES * MIN;
  return Math.min(MAX_PATROL_MINUTES, Math.max(MIN_PATROL_MINUTES, Math.round(n))) * MIN;
}
// manager settings -> is the haiku triage on (patrolTriage: default on, false = off)
const triageOn = (settings) => !(settings && settings.patrolTriage === false);

// ---- the runner --------------------------------------------------------------------------------------------------
// How to start claude for `-p` -> { file, pre: [] } | null (not found). No shell: the program itself (an .exe, or the
// node + script behind an npm .cmd shim on Windows). claudeCmd = src/main/claude-cmd.js.
function claudeProgram(claudeCmd, env = process.env, platform = process.platform) {
  if (platform !== 'win32') {
    const f = claudeCmd.findOnPosixPath('claude', env);
    return f ? { file: f, pre: [] } : null;
  }
  const exe = claudeCmd.findOnPath('claude', env);
  if (exe && /\.exe$/i.test(exe)) return { file: exe, pre: [] };
  const t = exe && /\.(cmd|bat)$/i.test(exe) ? claudeCmd.shimTarget(exe, env) : null;
  return t ? { file: t.file, pre: t.pre } : null;
}

// The args of one haiku call. --tools "" last (it may swallow what follows). No --bare (it does not read the login).
function haikuArgs({ systemPrompt, schema, budgetUsd = BUDGET_USD }) {
  return ['-p', '--model', 'haiku', '--no-session-persistence', '--output-format', 'json', '--max-budget-usd', String(budgetUsd), '--strict-mcp-config', '--disable-slash-commands', '--system-prompt', systemPrompt, '--json-schema', JSON.stringify(schema), '--tools', ''];
}

// One `claude -p` with the prompt on stdin -> { ok: true, stdout } | { ok: false, error }.
// program = { file, pre, env? }, args = haikuArgs(...), cwd = a scratch folder of the app. Killed after timeoutMs.
function runClaude(prompt, { program, args, cwd, env = process.env, timeoutMs = TIMEOUT_MS, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    if (!program || !program.file) return resolve({ ok: false, error: 'claude not found' });
    let child;
    try {
      if (cwd) fs.mkdirSync(cwd, { recursive: true });
      child = spawnFn(program.file, [...(program.pre || []), ...(args || [])], { cwd, env: program.env ? { ...env, ...program.env } : env, stdio: ['pipe', 'pipe', 'pipe'] }); // no windowsHide (CLAUDE.md: no script engine in a hidden window)
    } catch (err) {
      return resolve({ ok: false, error: String(err && err.message) });
    }
    let out = '';
    let errText = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ ok: false, error: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (b) => {
      if (out.length < OUT_MAX) out += b.toString('utf8');
    });
    child.stderr.on('data', (b) => {
      errText = (errText + b.toString('utf8')).slice(-2000);
    });
    child.on('error', (err) => finish({ ok: false, error: String(err && err.message) }));
    // claude -p --output-format json reports its errors on stdout: the tail of what it said, for the log
    child.on('close', (code) => finish(code === 0 ? { ok: true, stdout: out } : { ok: false, error: `exit ${code}: ${oneLine(errText || out, 300)}` }));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// createRunner({ cwd, memOk?: () => boolean, runFn? }) -> { run(prompt, { program, args, timeoutMs }), busy() }
// One call at a time (a second caller gets { ok: false, error: 'busy' } at once, it does not queue: both callers retry
// on their next round). memOk() false -> { ok: false, error: 'low memory' } without starting claude.
function createRunner({ cwd, memOk = () => true, runFn = runClaude, env } = {}) {
  let running = false;
  return {
    busy: () => running,
    async run(prompt, { program, args, timeoutMs = TIMEOUT_MS } = {}) {
      if (running) return { ok: false, error: 'busy' };
      let mem = true;
      try {
        mem = memOk() !== false;
      } catch {}
      if (!mem) return { ok: false, error: 'low memory' };
      running = true;
      try {
        return await runFn(prompt, { program, args, cwd, timeoutMs, ...(env ? { env } : {}) });
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      } finally {
        running = false;
      }
    },
  };
}

// The JSON out of `claude -p --output-format json`: structured_output (with --json-schema), else the JSON inside result,
// else the object itself. null = not readable / is_error.
function parseJsonOut(stdout) {
  let o;
  try {
    o = JSON.parse(String(stdout || '').trim());
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || o.is_error === true) return null;
  if (o.structured_output && typeof o.structured_output === 'object') return o.structured_output;
  if (typeof o.result === 'string') {
    const t = o.result;
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {}
    }
  }
  return o.type === 'result' ? null : o;
}

// ---- the patrol's summary and its diff -----------------------------------------------------------------------------
// snapshotOf({ inboxItems, backlogs: [{ folder, name?, items, progress? }], waits (manager/waits.json), sessions
// (manager/sessions.json) }) -> { refs: { [ref]: state }, names: { [ref]: label } }
//   i:<id> = inbox status · b:<folder>|<id> = backlog status (no m- items) · w:<tabKey> = wait kind + alert codes ·
//   s:<tabKey>|<promptKey> = a prompt waiting (stuck or not) · p:<folder> = the PROGRESS.md 確認待ち rows
function snapshotOf({ inboxItems = [], backlogs = [], waits = null, sessions = null } = {}) {
  const refs = {};
  const names = {};
  const put = (ref, state, name) => {
    if (Object.keys(refs).length >= REFS_MAX) return;
    refs[ref] = String(state);
    names[ref] = oneLine(name, 80);
  };
  for (const it of inboxItems || []) {
    if (it && typeof it.id === 'string') put(`i:${it.id}`, it.status, `依頼 ${it.reqNo || it.id} 「${oneLine(it.title || it.text, 40)}」`);
  }
  for (const b of backlogs || []) {
    if (!b || typeof b.folder !== 'string') continue;
    const name = b.name || path.basename(b.folder);
    for (const it of b.items || []) {
      if (!it || typeof it.id !== 'string' || it.id.startsWith('m-')) continue;
      put(`b:${norm(b.folder)}|${it.id}`, it.status, `${name} ${it.no ? it.no + ' ' : ''}${it.id} 「${oneLine(it.title || it.text, 40)}」`);
    }
    const pr = b.progress;
    if (pr && Array.isArray(pr.waiting)) put(`p:${norm(b.folder)}`, pr.waiting.map((r) => r.n).join(',') || '-', `${name} の PROGRESS.md 確認待ち`);
  }
  for (const s of (waits && Array.isArray(waits.sessions) && waits.sessions) || []) {
    if (!s || typeof s.tabKey !== 'string') continue;
    const codes = (s.alerts || []).map((a) => a && a.code).filter(Boolean).sort().join('+');
    put(`w:${s.tabKey}`, `${s.kind || 'wait'}${codes ? ':' + codes : ''}`, `${s.folderName || ''} ${s.label || s.tabKey} の待ち`);
  }
  for (const s of (sessions && Array.isArray(sessions.sessions) && sessions.sessions) || []) {
    if (!s || typeof s.tabKey !== 'string') continue;
    put(`s:${s.tabKey}|${s.promptKey || ''}`, s.stuck ? 'stuck' : 'asking', `${s.folderName || ''} ${s.label || s.tabKey} の確認「${oneLine(s.question, 40)}」`);
  }
  return { refs, names };
}

// How the app treats one change of a ref: 'handled' (another trigger already wakes the ルーター for it), 'quiet' (nothing
// to act on) or 'unsure' (haiku looks at it).
function classify(ref, from, to) {
  const kind = ref.slice(0, 2);
  if (kind === 'i:') return to === undefined ? 'quiet' : 'handled'; // inbox changes wake the ルーター (onInboxChange)
  if (kind === 's:') return to === undefined ? 'quiet' : 'handled'; // prompts: the stuck check (2 min)
  if (kind === 'b:') {
    if (to === 'done' || to === 'failed') return 'handled'; // 完了・失敗の知らせ
    if (to === undefined) return from === 'done' || from === 'failed' ? 'quiet' : 'unsure'; // an open item vanished
    if (from === undefined) return 'quiet'; // a new item (routed by the ルーター, or added by the user in that folder)
    if (from === 'pending' && to === 'active') return 'quiet'; // started as planned
    return 'unsure'; // active -> pending (re-queued), done -> pending (reopened), …
  }
  if (kind === 'w:') {
    if (to === undefined) return 'quiet'; // the wait ended
    if (from === undefined) return /:/.test(to) ? 'handled' : 'quiet'; // a new alert wakes the ルーター (checkWaits)
    const codes = (s) => new Set((String(s).split(':')[1] || '').split('+').filter(Boolean));
    const f = codes(from);
    if ([...codes(to)].some((c) => !f.has(c))) return 'handled'; // a new alert code wakes the ルーター (checkWaits)
    return String(from).split(':')[0] === String(to).split(':')[0] ? 'quiet' : 'unsure'; // alerts gone: quiet; another kind: unsure
  }
  if (kind === 'p:') return 'unsure';
  return 'unsure';
}

// diffOf(prev, cur) -> [{ ref, from, to, cls, name }] (prev null = the first patrol: no change at all)
function diffOf(prev, cur) {
  if (!prev || !prev.refs || !cur || !cur.refs) return [];
  const out = [];
  const keys = new Set([...Object.keys(prev.refs), ...Object.keys(cur.refs)]);
  for (const ref of keys) {
    const from = prev.refs[ref];
    const to = cur.refs[ref];
    if (from === to) continue;
    out.push({ ref, from, to, cls: classify(ref, from, to), name: (cur.names && cur.names[ref]) || (prev.names && prev.names[ref]) || ref });
  }
  return out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

// A change in one line (the app's own words, for the prompt and for the ルーター when haiku is not asked)
function changeLine(c) {
  const st = (v) => (v === undefined ? 'なし' : v);
  return `${c.name}: ${st(c.from)} → ${st(c.to)}`;
}

// ---- haiku ----------------------------------------------------------------------------------------------------------
const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    wake: { type: 'boolean' },
    points: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, fact: { type: 'string' } }, required: ['ref', 'fact'] } },
  },
  required: ['wake', 'points'],
};
const SYSTEM_PROMPT = 'You read a list of state changes of a task manager and only list facts, in Japanese, as the JSON the user asks for.';
const HAIKU_ARGS = haikuArgs({ systemPrompt: SYSTEM_PROMPT, schema: TRIAGE_SCHEMA });

// The prompt (stdin). changes = the unsure ones (≤ CHANGES_MAX), context = a few lines the app knows (optional).
function buildPrompt(changes, context = []) {
  const lines = [
    'あなたは見回りの前さばきの係です。アプリが前回の見回り（数分前）からの状態の変化をコードで集めました。',
    '下の変化のうち、ルーター（作業の振り分け役）が手を打つ必要がありそうなもの（止まった・戻された・消えた・確認待ちが増えた など）を事実として 1 文で挙げてください。',
    '決まり: 事実だけを書く。何をすべきか・提案・推測は書かない。一覧に無い ref を作らない。手を打つ必要がなさそうなら points は空、wake は false。',
    '答えは JSON だけ: {"wake": <手を打つ候補があれば true>, "points": [{"ref": "<一覧の [ ] の中の文字だけ>", "fact": "<事実の 1 文、日本語、100 字まで>"}]}',
    '',
    '## 変化（ref: 名前: 前 → 今）',
    ...changes.slice(0, CHANGES_MAX).map((c) => `- [${c.ref}] ${changeLine(c)}`),
  ];
  if (context.length) lines.push('', '## いまの様子（参考）', ...context.slice(0, 10).map((l) => `- ${oneLine(l, 200)}`));
  return lines.join('\n') + '\n';
}

// stdout -> { wake, points: [{ ref, fact }] } | null. Points about refs not in changes are dropped; a wake without a point
// is kept as a wake (the app lists the changes by code then).
function parseTriage(stdout, changes) {
  const body = parseJsonOut(stdout);
  if (!body || typeof body.wake !== 'boolean') return null;
  const known = (changes || []).map((c) => c.ref);
  // a real haiku (2026-11-14) gave the ref with its brackets, once with the whole line: take the known ref inside it
  const refOf = (r) => {
    const t = String(r || '').trim();
    const m = /^\[([^\]]+)\]/.exec(t);
    const inner = m ? m[1] : t;
    if (known.includes(inner)) return inner;
    return known.filter((k) => t.includes(`[${k}]`))[0] || null;
  };
  const points = [];
  for (const p of Array.isArray(body.points) ? body.points : []) {
    const ref = p && typeof p.fact === 'string' && p.fact.trim() ? refOf(p.ref) : null;
    if (ref && !points.some((x) => x.ref === ref) && points.length < CHANGES_MAX) points.push({ ref, fact: oneLine(p.fact, POINT_MAX) });
  }
  return { wake: body.wake || points.length > 0, points };
}

// ---- one round ------------------------------------------------------------------------------------------------------
// triageRound({ prev, cur, fresh, enabled, passed, lastWakeAt, now, ask, context }) -> {
//   wake: boolean, reason: 'stale'|'changes'|'haiku-failed'|'cap'|null, called, ok, points, lines (for the ルーター),
//   unsure, passed (to keep: unsure changes haiku let pass since the last wake), error? }
// fresh = the patrol already wakes the ルーター (new stale findings / the stocktake): the unsure changes are added by code,
// haiku is not asked. ask(prompt) -> { ok, stdout } | { ok: false, error }.
async function triageRound({ prev = null, cur, fresh = false, enabled = true, passed = [], lastWakeAt = 0, now = Date.now(), ask, context = [] } = {}) {
  const changes = diffOf(prev, cur);
  const unsure = changes.filter((c) => c.cls === 'unsure');
  // let-pass changes whose ref is back to where it was are dropped (nothing left to say)
  const carry = (passed || []).filter((c) => c && typeof c.ref === 'string' && cur && cur.refs && cur.refs[c.ref] === c.to && !unsure.some((u) => u.ref === c.ref));
  const res = { wake: false, reason: null, called: false, ok: true, points: [], lines: [], unsure, passed: carry };
  const byCode = (list) => list.slice(0, CHANGES_MAX).map((c) => changeLine(c));
  if (fresh) {
    res.wake = true;
    res.reason = 'stale';
    res.lines = byCode([...carry, ...unsure]);
    res.passed = [];
    return res;
  }
  if (!unsure.length) {
    if (carry.length && now - (Number(lastWakeAt) || 0) >= CAP_MS) {
      res.wake = true;
      res.reason = 'cap';
      res.lines = byCode(carry);
      res.passed = [];
    }
    return res;
  }
  if (!enabled) {
    res.passed = [...carry, ...unsure].slice(-CHANGES_MAX); // off: as before 段 1, changes alone do not wake the ルーター
    return res;
  }
  res.called = true;
  let r;
  try {
    r = await ask(buildPrompt(unsure, context));
  } catch (err) {
    r = { ok: false, error: String((err && err.message) || err) };
  }
  const parsed = r && r.ok ? parseTriage(r.stdout, unsure) : null;
  if (!parsed) {
    res.ok = false;
    res.error = (r && r.error) || 'not JSON';
    res.wake = true; // failing is the waking side (docs/plan-pmo-models.md 3 章 (a))
    res.reason = 'haiku-failed';
    res.lines = byCode([...carry, ...unsure]);
    res.passed = [];
    return res;
  }
  if (parsed.wake) {
    res.wake = true;
    res.reason = 'changes';
    res.points = parsed.points;
    const named = new Set(parsed.points.map((p) => p.ref));
    const nameOf = new Map(unsure.map((c) => [c.ref, c.name]));
    res.lines = [...parsed.points.map((p) => `${nameOf.get(p.ref) || p.ref}: ${p.fact}`), ...byCode([...carry, ...unsure.filter((c) => !named.has(c.ref))])];
    res.passed = [];
    return res;
  }
  res.passed = [...carry, ...unsure].slice(-CHANGES_MAX);
  if (now - (Number(lastWakeAt) || 0) >= CAP_MS) {
    res.wake = true;
    res.reason = 'cap';
    res.lines = byCode(res.passed);
    res.passed = [];
  }
  return res;
}

// The part of the 見回り block for the ルーター (≤ 1000 chars), '' when nothing to say.
function formatTriage(r) {
  if (!r || !r.wake || !r.lines.length) return '';
  const head =
    r.reason === 'changes'
      ? '前さばき（haiku が事実を並べたもの。判断は ルーター）: 前回の見回りからの変化で、手を打つ候補があります。'
      : r.reason === 'haiku-failed'
        ? '前さばき: haiku が答えなかったので、前回の見回りからの変化をアプリがそのまま並べます。'
        : r.reason === 'cap'
          ? '前さばき: 30 分の間に haiku が「手を打つものなし」とした変化です。念のため確かめてください。'
          : '前回の見回りからの変化（アプリが集めたもの）:';
  return (head + '\n' + r.lines.map((l) => `- ${l}`).join('\n')).slice(0, 1000);
}

module.exports = {
  patrolEveryMs,
  triageOn,
  claudeProgram,
  haikuArgs,
  runClaude,
  createRunner,
  parseJsonOut,
  snapshotOf,
  classify,
  diffOf,
  buildPrompt,
  parseTriage,
  triageRound,
  formatTriage,
  HAIKU_ARGS,
  TRIAGE_SCHEMA,
  CAP_MS,
  TIMEOUT_MS,
  DEFAULT_PATROL_MINUTES,
};
