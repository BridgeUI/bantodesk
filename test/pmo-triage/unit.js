// Unit test for PM1 段 1 見回りの前さばき (docs/plan-pmo-models.md 6 章): node tmp/pmo-triage/unit.js   (AT_APP_ROOT = another app root)
//   S  patrolEveryMs (default 5 min, 1..60) / triageOn
//   D  snapshotOf + diffOf + classify: handled (inbox, done / failed, new wait alert, prompt) / quiet (started, ended,
//      new item) / unsure (active -> pending, an open item gone, done -> pending, 確認待ち changed, wait kind changed)
//   R  triageRound with a fake ask: no change / only handled -> no call, no wake; unsure -> one call; wake -> lines with
//      the points; quiet -> not woken, kept as passed; passed + 30 min -> woken (cap); fail / not JSON / throw -> woken;
//      fresh stale -> woken without a call; off -> no call, no wake; invented refs dropped
//   P  parseTriage / formatTriage / buildPrompt (facts only, the refs)
//   X  runClaude with tmp/pmo-triage/fake-haiku.js (a real child, not claude): stdin, the args (-p --model haiku,
//      --strict-mcp-config --disable-slash-commands --system-prompt, --tools "" last, no --bare), fail / time limit
//   Q  createRunner: one at a time (busy), low memory -> not started
//   M  main.js / progress-check.js wiring (the patrol interval from the settings, both share haikuRunner, template v31)
// No model is called.
const path = require('path');
const fs = require('fs');
const root = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.resolve(__dirname, '..', '..');
const T = require(path.join(root, 'src', 'main', 'triage.js'));
const FAKE = path.join(__dirname, 'fake-haiku.js');
let pass = 0;
let fail = 0;
const ok = (name, c, ev = '') => {
  c ? pass++ : fail++;
  console.log(c ? 'PASS' : 'FAIL', name, ev !== '' ? '| ' + (typeof ev === 'string' ? ev : JSON.stringify(ev)).slice(0, 400) : '');
};
const MIN = 60 * 1000;
const now = new Date(2026, 10, 14, 12, 0, 0).getTime();
const W = '/work/a';

const snap = ({ inbox = [], items = [], waiting = null, waits = [], sessions = [] } = {}) =>
  T.snapshotOf({
    inboxItems: inbox,
    backlogs: [{ folder: W, name: 'a', items, progress: waiting ? { waiting } : null }],
    waits: { sessions: waits },
    sessions: { sessions },
  });
const answer = (body) => ({ ok: true, stdout: JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: body }) });

async function main() {
  // ---- S ----
  ok('S1 patrolEveryMs default 5 min', T.patrolEveryMs({}) === 5 * MIN && T.patrolEveryMs(null) === 5 * MIN && T.DEFAULT_PATROL_MINUTES === 5);
  ok('S2 patrolEveryMs clamped 1..60', T.patrolEveryMs({ patrolMinutes: 0.2 }) === 1 * MIN && T.patrolEveryMs({ patrolMinutes: 999 }) === 60 * MIN && T.patrolEveryMs({ patrolMinutes: 12 }) === 12 * MIN && T.patrolEveryMs({ patrolMinutes: 'x' }) === 5 * MIN);
  ok('S3 triageOn: default on, false = off', T.triageOn({}) && T.triageOn(null) && !T.triageOn({ patrolTriage: false }));

  // ---- D ----
  const base = snap({
    inbox: [{ id: 'q1', status: 'new', text: '依頼' }],
    items: [
      { id: 'r-1', status: 'pending', text: 'one' },
      { id: 'r-2', status: 'active', text: 'two' },
      { id: 'r-3', status: 'active', text: 'three' },
      { id: 'r-4', status: 'done', text: 'four' },
      { id: 'r-5', status: 'pending', text: 'five' },
      { id: 'm-1', status: 'pending', text: 'manager' },
    ],
    waiting: [{ n: 'A1' }],
    waits: [{ tabKey: 't1', kind: 'bg', alerts: [] }, { tabKey: 't2', kind: 'bg', alerts: [{ code: 'silent' }] }],
  });
  ok('D1 snapshot refs (no m- item)', base.refs['i:q1'] === 'new' && base.refs[`b:${path.resolve(W).toLowerCase()}|r-1`] === 'pending' && !Object.keys(base.refs).some((k) => k.includes('m-1')) && base.refs[`p:${path.resolve(W).toLowerCase()}`] === 'A1' && base.refs['w:t2'] === 'bg:silent', base.refs);
  ok('D2 the first patrol (no prev) -> no change', T.diffOf(null, base).length === 0);
  const next = snap({
    inbox: [{ id: 'q1', status: 'routed', text: '依頼' }],
    items: [
      { id: 'r-1', status: 'active', text: 'one' }, // started: quiet
      { id: 'r-2', status: 'done', text: 'two' }, // handled
      { id: 'r-3', status: 'pending', text: 'three' }, // re-queued: unsure
      { id: 'r-4', status: 'pending', text: 'four' }, // reopened: unsure
      // r-5 gone while pending: unsure
      { id: 'r-6', status: 'pending', text: 'six' }, // new: quiet
    ],
    waiting: [{ n: 'A1' }, { n: 'A2' }], // unsure
    waits: [{ tabKey: 't1', kind: 'bg', alerts: [{ code: 'gone' }] }, { tabKey: 't3', kind: 'bg', alerts: [] }], // t1 new alert: handled; t2 ended: quiet; t3 new no alert: quiet
    sessions: [{ tabKey: 't9', promptKey: 'k', stuck: true, question: 'ok?' }], // handled
  });
  const ch = T.diffOf(base, next);
  const cls = Object.fromEntries(ch.map((c) => [c.ref.replace(/^b:[^|]*\|/, 'b:').replace(/^p:.*/, 'p:'), c.cls]));
  ok('D3 handled: inbox change, done, new wait alert, a prompt', cls['i:q1'] === 'handled' && cls['b:r-2'] === 'handled' && cls['w:t1'] === 'handled' && cls['s:t9|k'] === 'handled', cls);
  ok('D4 quiet: started, new item, wait ended, new wait without alert', cls['b:r-1'] === 'quiet' && cls['b:r-6'] === 'quiet' && cls['w:t2'] === 'quiet' && cls['w:t3'] === 'quiet', cls);
  ok('D5 unsure: re-queued, reopened, an open item gone, 確認待ち changed', cls['b:r-3'] === 'unsure' && cls['b:r-4'] === 'unsure' && cls['b:r-5'] === 'unsure' && cls['p:'] === 'unsure', cls);
  ok('D6 wait: alerts gone -> quiet, another kind -> unsure', T.classify('w:x', 'bg:silent', 'bg') === 'quiet' && T.classify('w:x', 'bg', 'team') === 'unsure' && T.classify('b:x', 'done', undefined) === 'quiet');

  // ---- R ----
  let calls = 0;
  const prompts = [];
  const asker = (r) => async (p) => {
    calls++;
    prompts.push(p);
    return typeof r === 'function' ? r(p) : r;
  };
  let r = await T.triageRound({ prev: base, cur: base, now, ask: asker(answer({ wake: true, points: [] })) });
  ok('R1 no change -> no call, not woken', !r.wake && !r.called && calls === 0, r);
  const onlyHandled = snap({ ...{ inbox: [{ id: 'q1', status: 'routed' }] }, items: [{ id: 'r-1', status: 'pending' }, { id: 'r-2', status: 'active' }, { id: 'r-3', status: 'active' }, { id: 'r-4', status: 'done' }, { id: 'r-5', status: 'pending' }], waiting: [{ n: 'A1' }], waits: [{ tabKey: 't1', kind: 'bg', alerts: [] }, { tabKey: 't2', kind: 'bg', alerts: [{ code: 'silent' }] }] });
  r = await T.triageRound({ prev: base, cur: onlyHandled, now, ask: asker(answer({ wake: true, points: [] })) });
  ok('R2 only handled changes -> no call, not woken', !r.wake && !r.called && calls === 0, r);
  const reQ = ch.find((c) => c.ref.endsWith('|r-3')).ref;
  r = await T.triageRound({ prev: base, cur: next, now, lastWakeAt: now - 1 * MIN, ask: asker(answer({ wake: true, points: [{ ref: reQ, fact: 'three が active から pending に戻った' }, { ref: 'b:/made/up|x', fact: '作り話' }] })) });
  ok('R3 unsure -> one call, woken, the point first, invented ref dropped', r.wake && r.called && calls === 1 && r.reason === 'changes' && r.points.length === 1 && /three が active から pending/.test(r.lines[0]) && !r.lines.some((l) => /作り話/.test(l)), r.lines);
  ok('R4 the prompt lists only the unsure refs, facts only', /\[b:[^\]]*\|r-3\]/.test(prompts[0]) && !/r-2\]/.test(prompts[0]) && !/\[i:q1\]/.test(prompts[0]) && /事実だけを書く/.test(prompts[0]) && /一覧に無い ref を作らない/.test(prompts[0]), prompts[0]);
  ok('R5 formatTriage names haiku and that the PMO decides', /前さばき（haiku が事実を並べたもの。判断は PMO）/.test(T.formatTriage(r)) && T.formatTriage(r).length <= 1000);
  r = await T.triageRound({ prev: base, cur: next, now, lastWakeAt: now - 1 * MIN, ask: asker(answer({ wake: false, points: [] })) });
  ok('R6 haiku: nothing to act on -> not woken, the changes kept as passed', !r.wake && r.called && r.ok && r.passed.length === 4, r.passed.map((c) => c.ref));
  const passed = r.passed;
  r = await T.triageRound({ prev: next, cur: next, passed, now: now + 10 * MIN, lastWakeAt: now - 1 * MIN, ask: asker(answer({ wake: false, points: [] })) });
  ok('R7 passed, no new change, < 30 min -> no call, not woken, still passed', !r.wake && !r.called && r.passed.length === 4, r);
  r = await T.triageRound({ prev: next, cur: next, passed, now: now + 30 * MIN, lastWakeAt: now - 1 * MIN, ask: asker(answer({ wake: false, points: [] })) });
  ok('R8 passed + 30 min since the last wake -> woken (cap) without a call, passed cleared', r.wake && r.reason === 'cap' && !r.called && r.passed.length === 0 && r.lines.length === 4 && /30 分/.test(T.formatTriage(r)), r);
  const backAgain = snap({ items: [{ id: 'r-3', status: 'active' }] });
  r = await T.triageRound({ prev: next, cur: backAgain, passed, now: now + 40 * MIN, lastWakeAt: now - 1 * MIN, enabled: false, ask: asker(answer({ wake: false, points: [] })) });
  ok('R9 a passed change back where it was is dropped', !r.passed.some((c) => c.ref.endsWith('|r-3')), r.passed.map((c) => c.ref));
  const c0 = calls;
  r = await T.triageRound({ prev: base, cur: next, now, ask: asker({ ok: false, error: 'exit 1: boom' }) });
  ok('R10 haiku fails -> woken, the changes by code', r.wake && !r.ok && r.reason === 'haiku-failed' && r.lines.length === 4 && /答えなかった/.test(T.formatTriage(r)) && calls === c0 + 1, r);
  r = await T.triageRound({ prev: base, cur: next, now, ask: asker({ ok: true, stdout: 'not json' }) });
  ok('R11 not JSON -> woken', r.wake && r.reason === 'haiku-failed', r);
  r = await T.triageRound({ prev: base, cur: next, now, ask: async () => { throw new Error('x'); } });
  ok('R12 ask throws -> woken', r.wake && r.reason === 'haiku-failed');
  const c1 = calls;
  r = await T.triageRound({ prev: base, cur: next, fresh: true, now, ask: asker(answer({ wake: false, points: [] })) });
  ok('R13 fresh stale findings -> woken without a call, the changes by code', r.wake && r.reason === 'stale' && !r.called && calls === c1 && r.lines.length === 4);
  r = await T.triageRound({ prev: base, cur: next, enabled: false, now, ask: asker(answer({ wake: true, points: [] })) });
  ok('R14 triage off -> no call, not woken (as before 段 1), kept as passed', !r.wake && !r.called && calls === c1 && r.passed.length === 4);
  r = await T.triageRound({ prev: base, cur: next, now, lastWakeAt: now - 1 * MIN, ask: asker(answer({ wake: true, points: [] })) });
  ok('R15 wake without a point -> woken, the changes by code', r.wake && r.reason === 'changes' && r.lines.length === 4);

  // ---- P ----
  ok('P1 parseTriage: is_error / no wake -> null', T.parseTriage(JSON.stringify({ is_error: true }), []) === null && T.parseTriage(JSON.stringify({ type: 'result', result: 'hi' }), []) === null && T.parseTriage('x', []) === null);
  ok('P2 parseTriage: JSON inside result', T.parseTriage(JSON.stringify({ type: 'result', result: '```json\n{"wake":false,"points":[]}\n```' }), []).wake === false);
  const pr = T.parseTriage(JSON.stringify({ structured_output: { wake: true, points: [{ ref: '[b:/w|r-1]', fact: 'a' }, { ref: '[p:/w] sample の確認待ち: S-0 → S-0,S-4', fact: 'b' }, { ref: 'b:/w|r-1', fact: 'dup' }, { ref: '[b:/w|zz]', fact: 'c' }] } }), [{ ref: 'b:/w|r-1' }, { ref: 'p:/w' }]);
  ok('P2b parseTriage: the ref with brackets / the whole line (real haiku) -> the known ref, once; unknown dropped', pr && pr.points.length === 2 && pr.points[0].ref === 'b:/w|r-1' && pr.points[1].ref === 'p:/w', pr);
  ok('P3 formatTriage: not woken -> empty', T.formatTriage({ wake: false, lines: ['x'] }) === '' && T.formatTriage(null) === '');

  // ---- X: runClaude with a real child (the fake) ----
  const log = path.join(__dirname, 'unit-args.log');
  fs.rmSync(log, { force: true });
  const env = { ...process.env, FAKE_HAIKU_LOG: log, FAKE_HAIKU_MODE: 'wake' };
  const prog = { file: process.execPath, pre: [FAKE] };
  const x1 = await T.runClaude('- [b:x|r-1] one: active → pending\n', { program: prog, args: T.HAIKU_ARGS, env, cwd: path.join(__dirname, 'unit-cwd'), timeoutMs: 20000 });
  const parsed = x1.ok ? T.parseTriage(x1.stdout, [{ ref: 'b:x|r-1' }]) : null;
  ok('X1 the prompt on stdin, the answer read back', parsed && parsed.wake && parsed.points[0].ref === 'b:x|r-1', x1);
  const args = JSON.parse(fs.readFileSync(log, 'utf8').split('\n')[0]);
  ok('X2 args: -p --model haiku, no MCP / skills, short system prompt, schema, --tools "" last, no --bare', args[0] === '-p' && args[1] === '--model' && args[2] === 'haiku' && args.includes('--strict-mcp-config') && args.includes('--disable-slash-commands') && args.includes('--system-prompt') && args.includes('--json-schema') && args.includes('--max-budget-usd') && args.includes('--no-session-persistence') && args[args.length - 2] === '--tools' && args[args.length - 1] === '' && !args.includes('--bare'), args);
  const x2 = await T.runClaude('x', { program: prog, args: T.HAIKU_ARGS, env: { ...env, FAKE_HAIKU_MODE: 'fail' }, timeoutMs: 20000 });
  ok('X3 exit 1 -> not ok', !x2.ok && /exit 1/.test(x2.error), x2);
  const t0 = Date.now();
  const x3 = await T.runClaude('x', { program: prog, args: T.HAIKU_ARGS, env: { ...env, FAKE_HAIKU_MODE: 'slow' }, timeoutMs: 1500 });
  ok('X4 no answer in time -> killed, timeout', !x3.ok && x3.error === 'timeout' && Date.now() - t0 < 6000, x3);
  const x4 = await T.runClaude('x', { program: null, args: T.HAIKU_ARGS });
  ok('X5 no claude -> not ok', !x4.ok && /not found/.test(x4.error));
  ok('X6 default time limit 120 s', T.TIMEOUT_MS === 120 * 1000);
  fs.rmSync(log, { force: true });
  fs.rmSync(path.join(__dirname, 'unit-cwd'), { recursive: true, force: true });

  // ---- Q: the shared runner ----
  let release;
  let started = 0;
  const runner = T.createRunner({ runFn: () => { started++; return new Promise((res) => (release = () => res({ ok: true, stdout: '{}' }))); } });
  const p1 = runner.run('a', {});
  const q2 = await runner.run('b', {});
  ok('Q1 a second call while one runs -> busy, not started', !q2.ok && q2.error === 'busy' && started === 1 && runner.busy());
  release();
  const q1 = await p1;
  ok('Q2 the first one finishes; then a new one may start', q1.ok && !runner.busy());
  const low = T.createRunner({ memOk: () => false, runFn: () => { started++; return { ok: true }; } });
  const q3 = await low.run('c', {});
  ok('Q3 low memory -> not started', !q3.ok && q3.error === 'low memory' && started === 1);
  const thr = T.createRunner({ runFn: () => { throw new Error('bad'); } });
  const q4 = await thr.run('d', {});
  ok('Q4 a throwing run -> not ok, not busy after', !q4.ok && !thr.busy());

  // ---- M: wiring ----
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  ok('M1 main.js: the patrol interval from the settings (triage.patrolEveryMs), tests via _EVERY_MS with the e2e mark', /triage\.patrolEveryMs\(loadManagerSettings\(\)\)/.test(main) && /e2e && Number\(process\.env\.AGENT_TERMINAL_PATROL_EVERY_MS\)/.test(main) && !/tick\(pmo\.PATROL_EVERY_MS\)/.test(main));
  ok('M2 runPatrol runs triageRound and the PMO only on d.report || t.wake', /triage\.triageRound\(/.test(main) && /if \(d\.report \|\| t\.wake\)/.test(main) && /triage\.formatTriage\(t\)/.test(main));
  ok('M3 the patrol, the progress check and the waits opinion (依頼-187) share haikuRunner (one at a time, memory)', (main.match(/haikuRunner\(\)\.run\(/g) || []).length === 3 && /memOk: \(\) => !schedMon\(\)\.over\(/.test(main));
  const pc = fs.readFileSync(path.join(root, 'src', 'main', 'progress-check.js'), 'utf8');
  ok('M4 progress-check.js uses triage.runClaude (no own spawn)', /triage\.runClaude\(/.test(pc) && !/require\('child_process'\)/.test(pc));
  const tsrc = fs.readFileSync(path.join(root, 'src', 'main', 'triage.js'), 'utf8');
  ok('M5 no shell, no windowsHide, no --bare in triage.js', !/shell:\s*true/.test(tsrc) && !/windowsHide:\s*true/.test(tsrc) && !T.HAIKU_ARGS.includes('--bare'));
  const manager = require(path.join(root, 'src', 'main', 'manager.js'));
  const md = fs.readFileSync(path.join(root, 'src', 'main', 'manager.js'), 'utf8');
  ok('M6 template v31+: the app patrols every 5 min, no own CronCreate patrol', manager.CLAUDE_MD_VERSION >= 31 && /定期の見回り（CronCreate など）を置かない/.test(md) && /既定 5 分ごと/.test(md));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
