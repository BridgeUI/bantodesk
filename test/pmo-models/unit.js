// Unit test for PM1 段 2 (docs/plan-pmo-models.md): node tmp/pmo-models/unit.js   (AT_APP_ROOT = another app root)
//   T  the PMO template v30+: the section on subagent models (haiku: read / summarize / compare with evidence,
//      sonnet: drafts, outbox only by PMO, the actions only PMO decides), and 誤報の見込み in 終わらない待ち
//   U  an old v29 CLAUDE.md is upgraded and the user's part below the marker is kept
//   H  src/main/wait-hints.js: pipe / file output / a newer command after a gone one / the session moved on; nothing for
//      a plain command, a '|' inside quotes, 2>&1 alone or deadlock; the block under the waits lines
//   W  with waits.waitOf (real gone alert), and main.js adds the block to the manager's waits block
//   K  haiku's opinion (依頼-187, wait-hints createOpinions) with a fake ask: only the alerts the code had no reason for,
//      yes / no / unknown -> 「haiku の見立て」 line, failure / timeout / not JSON -> nothing, the same ref asked once,
//      busy -> asked again later, pending until settled, the prompt (row / command / tail on stdin), main.js wiring
// No model is called: the hints are code, haiku is a fake.
const path = require('path');
const fs = require('fs');
const root = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.resolve(__dirname, '..', '..');
const manager = require(path.join(root, 'src', 'main', 'manager.js'));
const W = require(path.join(root, 'src', 'main', 'waits.js'));
const H = require(path.join(root, 'src', 'main', 'wait-hints.js'));
let pass = 0;
let fail = 0;
const ok = (name, c, ev = '') => {
  c ? pass++ : fail++;
  console.log(c ? 'PASS' : 'FAIL', name, ev !== '' ? '| ' + (typeof ev === 'string' ? ev : JSON.stringify(ev)).slice(0, 400) : '');
};
const MIN = 60000;
const now = 10_000_000_000;

// ---- T: template ----------------------------------------------------------------------------
const work = fs.mkdtempSync(path.join(__dirname, 'work-'));
try {
  const mdir = path.join(work, 'manager');
  manager.ensureManagerDir(mdir);
  const md = fs.readFileSync(path.join(mdir, 'CLAUDE.md'), 'utf8');
  ok(`T1 template v${manager.CLAUDE_MD_VERSION} >= 30`, manager.CLAUDE_MD_VERSION >= 30 && md.startsWith(`<!-- bantodesk manager v${manager.CLAUDE_MD_VERSION} -->`), md.slice(0, 60));
  const sec = (md.split('## サブエージェントのモデルの使い分け')[1] || '').split('\n## ')[0];
  ok('T2 the section exists', sec.length > 100);
  ok('T3 haiku: reading / summary / comparing, with evidence, no proposals', /"model": "haiku"/.test(sec) && /読み取り・要約・突き合わせ/.test(sec) && /根拠/.test(sec) && /提案や結論は書かせない/.test(sec));
  ok('T4 sonnet: drafts of instructions and QA, PMO checks', /"model": "sonnet"/.test(sec) && /指示文と事前 QA/.test(sec) && /下書き/.test(sec) && /直してから使う/.test(sec));
  ok('T5 outbox only by PMO (opus); subagents read only', /outbox に書くのはあなた（opus の PMO）だけ/.test(sec) && /読むだけと伝える/.test(sec));
  ok('T6 actions only PMO decides: route create reorder answer nudge release proposal qa warn', ['route', 'create', 'reorder', 'answer', 'nudge', 'release', 'proposal', 'qa', 'warn'].every((w) => sec.includes(w)) && /あなただけが決めて書く/.test(sec));
  ok('T7 PMO checks the summary before an action', /要点を 1 回自分で確かめる/.test(sec));
  const wsec = (md.split('## 終わらない待ち（waits.json と nudge）')[1] || '').split('\n## ')[0];
  ok('T8 終わらない待ち explains 誤報の見込み (pipe / file / newer command gone) and not to nudge a false one', /誤報の見込み/.test(wsec) && /パイプ/.test(wsec) && /ファイル/.test(wsec) && /gone が残っているだけ/.test(wsec) && /誤報なら nudge しない/.test(wsec));

  // ---- U: upgrade from v29 -----------------------------------------------------------------------
  const m2 = path.join(work, 'm2');
  fs.mkdirSync(m2, { recursive: true });
  fs.writeFileSync(path.join(m2, 'CLAUDE.md'), `<!-- agent-terminal manager v29 -->\nold\n${manager.USER_MARKER}\nmine: 5 分ごとの見回り\n`);
  manager.ensureManagerDir(m2);
  const up = fs.readFileSync(path.join(m2, 'CLAUDE.md'), 'utf8');
  ok('U1 v29 -> current, the user part kept', up.startsWith(`<!-- bantodesk manager v${manager.CLAUDE_MD_VERSION} -->`) && up.includes('## サブエージェントのモデルの使い分け') && up.includes('mine: 5 分ごとの見回り') && !up.includes('\nold\n'), up.slice(0, 60));
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

// ---- H: hints ---------------------------------------------------------------------------------
ok('H1 pipes', H.pipes('node a.js 2>&1 | tail -40') && H.pipes('node a.js | Out-File o.txt') && !H.pipes('node a.js || echo no') && !H.pipes("grep -E 'a|b' f.txt") && !H.pipes('node a.js'));
ok('H2 writes a file', H.writesFile('node a.js > out.txt 2>&1') && H.writesFile('node a.js >> logs/a.log') && H.writesFile('node a.js | tee x.log') && H.writesFile('node a.js | Out-File o.txt') &&
  !H.writesFile('node a.js 2>&1') && !H.writesFile('node a.js') && !H.writesFile("node -p \"'a>b'\"") && !H.writesFile('npm run x -- --arrow=>'));
const ent = (wait, extra = {}) => ({ tabKey: 't1', folder: '/w/a', folderName: 'a', label: 'AT-1', backlogId: 'r-1', wait, ...extra });
const cmd = (id, command, startedAt, files = []) => ({ type: 'command', id, command, startedAt, files });
{
  const e = ent({ since: now - 20 * MIN, items: [cmd('b1', 'node tmp/x.mjs 2>&1 | tail -20', now - 30 * MIN)], alerts: [{ code: 'silent', ref: 'b1:silent', text: 'x' }] });
  const h = H.hintsFor(e);
  ok('H3 silent + pipe -> a pipe reason', h.length === 1 && h[0].code === 'silent' && /パイプ/.test(h[0].reasons.join()), h);
}
{
  const e = ent({ since: now - 20 * MIN, items: [cmd('b1', 'node tmp/x.mjs', now - 30 * MIN, ['/w/a/out.txt'])], alerts: [{ code: 'silent', ref: 'b1:silent', text: 'x' }] });
  ok('H4 silent + files the command writes (outTargets) -> a file reason', /ファイルに書いている/.test(H.hintsFor(e).map((x) => x.reasons.join()).join()), H.hintsFor(e));
}
{
  const e = ent({ since: now - 1 * MIN, items: [cmd('b1', 'node old.js', now - 40 * MIN), cmd('b2', 'node tmp/new-run.mjs --only 40', now - 5 * MIN)], alerts: [{ code: 'gone', ref: 'b1:gone', text: 'x' }] });
  const h = H.hintsFor(e);
  ok('H5 gone + a newer command -> 「その後に別のコマンド」 names the newer one', h.length === 1 && /その後に別のコマンド `node tmp\/new-run\.mjs --only 40`/.test(h[0].reasons.join()) && /gone が残っているだけ/.test(h[0].reasons.join()), h);
}
{
  const e = ent({ since: now - 2 * MIN, items: [cmd('b1', 'node old.js', now - 30 * MIN)], alerts: [{ code: 'gone', ref: 'b1:gone', text: 'x' }] });
  const h = H.hintsFor(e);
  ok('H6 gone, the session worked 28 min after the start -> moved-on reason', h.length === 1 && /28 分動いてから待機に入った/.test(h[0].reasons.join()), h);
}
{
  const plain = ent({ since: now - 29 * MIN, items: [cmd('b1', 'node tmp/x.mjs', now - 30 * MIN)], alerts: [{ code: 'gone', ref: 'b1:gone', text: 'x' }, { code: 'long', ref: 'b1:long', text: 'y' }] });
  ok('H7 a plain command right before the idle -> no hint (really stopped stays told plainly)', H.hintsFor(plain).length === 0 && H.block([plain]) === '', H.hintsFor(plain));
  const dl = ent({ since: now - 10 * MIN, items: [{ type: 'member', name: 'A' }], alerts: [{ code: 'deadlock', ref: 'team:deadlock', text: 'z' }] });
  ok('H8 deadlock / no alerts -> nothing', H.hintsFor(dl).length === 0 && H.hintsFor(ent({ since: now, items: [], alerts: [] })).length === 0 && H.block([]) === '' && H.block(null) === '');
}
{
  const e = ent({ since: now - 20 * MIN, items: [cmd('b1', 'node a.js > out.txt 2>&1', now - 30 * MIN)], alerts: [{ code: 'silent', ref: 'b1:silent', text: 'x' }] });
  const b = H.block([e]);
  ok('H9 block: the caveat line + 「- 誤報の見込み [a] tabKey t1 の silent（`…`）: …」', /^（誤報の見込み: .*確かではない.*誤報なら nudge しない）/.test(b) && /\n- 誤報の見込み \[a\] tabKey t1 の silent（`node a\.js > out\.txt 2>&1`）: 出力をファイルに書いている/.test(b), b);
}

// ---- W: with waits.waitOf and main.js ----------------------------------------------------------
{
  const t = { status: 'idle', bg: [{ id: 'b1', command: 'node tmp/x.mjs 2>&1 | tail -40', startedAt: now - 30 * MIN }, { id: 'b2', command: 'node tmp/y.mjs', startedAt: now - 3 * MIN }] };
  const procs = new Map([['b1', 'gone'], ['b2', 'alive']]);
  const wait = W.waitOf(t, { now, idleSince: now - 2 * MIN, procs, goneScans: new Map([['b1', 3]]) });
  const e = ent(wait);
  const base = W.formatForManager([e]);
  const b = H.block([e]);
  ok('W1 waitOf gone alert for the old piped command', wait && wait.alerts.some((a) => a.code === 'gone' && a.ref === 'b1:gone'), wait && wait.alerts);
  ok('W2 block names the pipe and the newer command', /パイプ/.test(b) && /その後に別のコマンド `node tmp\/y\.mjs`/.test(b), b);
  ok('W3 the manager block = waits lines + the hints', /^終わらない待ちがあります（1 件）/.test(base) && [base, b].filter(Boolean).join('\n').split('\n').length >= 4);
}
{
  const src = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  ok('W4 main.js checkWaits joins waitHints.block(project, …) to formatForManager', /require\('\.\/main\/wait-hints'\)/.test(src) && /\[waits\.formatForManager\(project\), waitHints\.block\(project, 10, opinions && opinions\.opinionOf\)\]\.filter\(Boolean\)\.join\('\\n'\)/.test(src));
  ok('K10 main.js: createOpinions on the shared runner (HAIKU_ARGS, 120 s), off with patrolTriage false / e2e without a fake, asking refs held back', /waitHints\.createOpinions\(/.test(src) && /haikuRunner\(\)\.run\(prompt, \{ program: haikuProgram\(\), args: waitHints\.HAIKU_ARGS, timeoutMs: triage\.TIMEOUT_MS \}\)/.test(src) &&
    /triage\.triageOn\(loadManagerSettings\(\)\)/.test(src) && /isE2E\(\) && !process\.env\.AGENT_TERMINAL_HAIKU_CMD\) return null/.test(src) &&
    /const fresh = refs\.filter\(\(r\) => !waitsReported\.has\(r\) && !asking\.has\(r\)\)/.test(src) && /waitsReported = new Set\(refs\.filter\(\(r\) => !asking\.has\(r\)\)\)/.test(src));
}

// ---- K: haiku's opinion (fake ask) ------------------------------------------------------------------------------------
(async () => {
  const out = (o) => ({ ok: true, stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: o }) });
  const plain = (id, code, command = `node tmp/${id}.mjs`) => ent({ since: now - 29 * MIN, kind: 'command', items: [cmd(id, command, now - 30 * MIN)], alerts: [{ code, ref: `${id}:${code}`, text: `${code} の知らせ` }] }, { tabKey: `t-${id}` });
  ok('K1 needsHaiku: a plain command alert yes, a piped one (code has a reason) / deadlock no', H.needsHaiku(plain('c1', 'silent')).length === 1 && H.needsHaiku(plain('c2', 'silent', 'node a.js | tail -5')).length === 0 &&
    H.needsHaiku(ent({ since: now, items: [], alerts: [{ code: 'deadlock', ref: 'team:deadlock', text: 'z' }] })).length === 0);
  ok('K1b HAIKU_ARGS: -p --model haiku, json-schema with falseAlarm, --tools "" last, no --bare', H.HAIKU_ARGS.includes('-p') && H.HAIKU_ARGS[H.HAIKU_ARGS.indexOf('--model') + 1] === 'haiku' && /falseAlarm/.test(H.HAIKU_ARGS[H.HAIKU_ARGS.indexOf('--json-schema') + 1]) &&
    H.HAIKU_ARGS.slice(-2).join('|') === '--tools|' && !H.HAIKU_ARGS.includes('--bare'));

  const asked = [];
  const answers = {
    'node tmp/y1.mjs': out({ falseAlarm: 'yes', reason: '出力の末尾に「done」があり、もう終わっている' }),
    'node tmp/n1.mjs': out({ falseAlarm: 'no', reason: '出力が 20 分前の行で止まっている' }),
    'node tmp/u1.mjs': out({ falseAlarm: 'unknown', reason: '材料が足りない' }),
    'node tmp/f1.mjs': { ok: false, error: 'exit 1: boom' },
    'node tmp/t1.mjs': { ok: false, error: 'timeout' },
    'node tmp/j1.mjs': { ok: true, stdout: 'not json' },
  };
  let busyLeft = 1;
  let clock = now;
  const op = H.createOpinions({
    now: () => clock,
    readTail: async (e, item) => (item.id === 'y1' ? 'line1\nall done' : ''),
    ask: async (prompt) => {
      const c = /## コマンド\n(.*)\n/.exec(prompt)[1];
      asked.push({ c, prompt });
      if (c === 'node tmp/b1.mjs' && busyLeft-- > 0) return { ok: false, error: 'busy' };
      if (c === 'node tmp/b1.mjs') return out({ falseAlarm: 'no', reason: '二度目' });
      return answers[c];
    },
  });
  const es = [plain('y1', 'silent'), plain('n1', 'gone'), plain('u1', 'long'), plain('f1', 'silent'), plain('t1', 'gone'), plain('j1', 'silent'), plain('p1', 'silent', 'node a.js | tail -5')];
  const p1 = op.update(es);
  ok('K2 first update: the 6 plain alerts are pending, the piped one is not', p1.size === 6 && p1.has('t-y1:y1:silent') && !p1.has('t-p1:p1:silent'), [...p1]);
  await op.idle();
  ok('K3 one call per alert, one at a time in order', asked.length === 6 && asked.map((a) => a.c.replace('node tmp/', '').slice(0, 2)).join(',') === 'y1,n1,u1,f1,t1,j1', asked.map((a) => a.c));
  const y = asked[0].prompt;
  ok('K4 the prompt: the waits row (alert code / text, item), the command, the tail of the output (none -> （なし）)', /## waits の行/.test(y) && /"alert":\{"code":"silent","text":"silent の知らせ"\}/.test(y) && /"id":"y1"/.test(y) && /"waitedSec":1740/.test(y) && /## 出力ファイルの末尾\nline1\nall done/.test(y) &&
    /## 出力ファイルの末尾\n（なし）/.test(asked[1].prompt) && /falseAlarm/.test(y), y);
  const p2 = op.update(es);
  await op.idle();
  ok('K5 settled -> nothing pending, the same refs are not asked again', p2.size === 0 && asked.length === 6, [...p2]);
  ok('K6 opinions: yes / no / unknown kept, failure / timeout / not JSON -> none', op.opinionOf('t-y1:y1:silent').falseAlarm === 'yes' && op.opinionOf('t-n1:n1:gone').falseAlarm === 'no' && op.opinionOf('t-u1:u1:long').falseAlarm === 'unknown' &&
    op.opinionOf('t-f1:f1:silent') === null && op.opinionOf('t-t1:t1:gone') === null && op.opinionOf('t-j1:j1:silent') === null);
  const b = H.block(es, 10, op.opinionOf);
  ok('K7 block: 「haiku の見立て: 誤報らしい（yes） — …」 / 本当に止まっていそう（no） / 分からない（unknown）, the code hint kept, no line for failure / timeout', /haiku の見立て/.test(b.split('\n')[0]) &&
    /\n- 誤報の見込み \[a\] tabKey t-y1 の silent（`node tmp\/y1\.mjs`）: haiku の見立て: 誤報らしい（yes） — 出力の末尾に「done」があり、もう終わっている/.test(b) &&
    /tabKey t-n1 の gone（`node tmp\/n1\.mjs`）: haiku の見立て: 本当に止まっていそう（no）/.test(b) && /tabKey t-u1 の long.*分からない（unknown）/.test(b) && /tabKey t-p1 の silent.*パイプ/.test(b) &&
    !/t-f1|t-t1|t-j1/.test(b), b);
  ok('K8 without opinions the block is as before (no haiku line, the old caveat)', !/haiku/.test(H.block(es)) && /^（誤報の見込み: アプリがコマンドの文と待ちの様子から見立てたもの。確かではない/.test(H.block(es)));

  // busy: asked again on a later update within the retry time; pending meanwhile
  const eb = [plain('b1', 'silent')];
  const q1 = op.update(eb);
  await op.idle();
  const q2 = op.update(eb);
  ok('K9 busy -> still pending and asked again on the next update', q1.has('t-b1:b1:silent') && q2.has('t-b1:b1:silent') && asked.filter((a) => a.c === 'node tmp/b1.mjs').length >= 1);
  await op.idle();
  const q3 = op.update(eb);
  ok('K9b the second try answers -> settled, opinion kept, asked twice in all', q3.size === 0 && op.opinionOf('t-b1:b1:silent').reason === '二度目' && asked.filter((a) => a.c === 'node tmp/b1.mjs').length === 2);
  busyLeft = 99;
  const eb2 = [plain('b2', 'silent', 'node tmp/b1.mjs')];
  op.update(eb2);
  await op.idle();
  clock += 2 * MIN; // past busyRetryMs
  op.update(eb2);
  await op.idle();
  const q4 = op.update(eb2);
  ok('K9c busy past the retry time -> given up (no opinion, not pending)', q4.size === 0 && op.opinionOf('t-b2:b2:silent') === null);
  // ask throws -> settled with nothing
  const op2 = H.createOpinions({ ask: async () => { throw new Error('x'); } });
  op2.update([plain('z1', 'gone')]);
  await op2.idle();
  ok('K11 ask throws -> no opinion, not pending', op2.update([plain('z1', 'gone')]).size === 0 && op2.opinionOf('t-z1:z1:gone') === null);
  ok('K12 parseOpinion: a bad falseAlarm -> null, the result string form read', H.parseOpinion(JSON.stringify({ structured_output: { falseAlarm: 'maybe', reason: 'x' } })) === null &&
    H.parseOpinion(JSON.stringify({ type: 'result', result: '{"falseAlarm":"no","reason":"r"}' })).falseAlarm === 'no');
})()
  .catch((err) => ok('K threw', false, String(err && err.stack)))
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  });
