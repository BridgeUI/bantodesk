// 誤報の見込み for the manager's 「終わらない待ちがあります」 block (PM1 段 2, docs/plan-pmo-models.md 5 章).
// Most waits alerts ルーター got were false (docs/plan-pmo-models.md 2 章: 16 turns, 31% no change): the command pipes or
// writes its output to a file, or the session already moved on to another command and only the old one's gone stays.
// This looks at the command text and the wait (no probes, no processes, no model call) and says why an alert may be
// false. It is a hint: ルーター still checks waits.json and decides whether to nudge.
// For the alerts the code has no reason for (a plain command's gone / silent / long), createOpinions asks haiku once
// per ref through 段 1's runner (src/main/triage.js: claude -p, stdin, no tools, 120 s, one call at a time) with the
// waits row, the command and the tail of its output file, and the answer is added as 「haiku の見立て: …」. Failing /
// timing out adds nothing (the ルーター is told as before). No Electron imports (testable from plain Node).
const triage = require('./triage');
const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const MIN = 60 * 1000;

// Remove quoted parts so a '|' or '>' inside a string or a regex does not count.
function unquoted(cmd) {
  return String(cmd || '').replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, ' ');
}
// a | b (not ||), PowerShell pipes too
const PIPE_RE = /(^|[^|])\|(?!\|)/;
// > file, >> file, 1> / 2> file (not 2>&1, not -> / =>), tee, Out-File / Tee-Object / Set-Content / Add-Content
const REDIRECT_RE = /(^|[\s\d])>{1,2}(?!&)\s*[^\s&>]/;
const FILE_WORDS = ['tee', 'out-file', 'tee-object', 'set-content', 'add-content'];

function pipes(cmd) {
  return PIPE_RE.test(unquoted(cmd));
}
function writesFile(cmd) {
  const u = unquoted(cmd);
  if (REDIRECT_RE.test(u.replace(/2>&1|>&2|[-=]>/g, ' '))) return true;
  const w = u.toLowerCase().split(/[\s|;&()]+/);
  return FILE_WORDS.some((x) => w.includes(x));
}

const label = (c) => {
  const s = oneLine(c, 200);
  return s.length > 60 ? s.slice(0, 59) + '…' : s;
};

// One waits entry ({ wait: { since, items, alerts } }) -> [{ ref, code, reasons: [string] }] (only alerts with a reason)
function hintsFor(entry) {
  const w = entry && entry.wait;
  if (!w || !Array.isArray(w.alerts) || !w.alerts.length) return [];
  const cmds = (Array.isArray(w.items) ? w.items : []).filter((i) => i && i.type === 'command');
  const out = [];
  for (const a of w.alerts) {
    if (!a || !['gone', 'silent', 'long'].includes(a.code)) continue; // deadlock: no command to look at
    const id = String(a.ref || '').replace(/:(gone|silent|long)$/, '');
    const it = cmds.find((c) => c.id === id);
    if (!it) continue;
    const reasons = [];
    if (pipes(it.command)) reasons.push('出力をパイプで次のコマンドに渡している（出力の止まりやプロセスの有無がずれて見えることがある）');
    if (writesFile(it.command) || (Array.isArray(it.files) && it.files.length)) {
      reasons.push('出力をファイルに書いている（画面の出力が止まって見えても、書き込み先で進んでいることがある）');
    }
    if (a.code === 'gone') {
      const newer = cmds.filter((c) => c !== it && num(c.startedAt) > num(it.startedAt)).sort((x, y) => num(y.startedAt) - num(x.startedAt))[0];
      if (newer) reasons.push(`このセッションはその後に別のコマンド \`${label(newer.command)}\` を始めている（古いコマンドの gone が残っているだけかもしれない）`);
      else if (num(w.since) && num(it.startedAt) && num(w.since) - num(it.startedAt) >= 2 * MIN) {
        reasons.push(`このセッションはコマンドの開始の後も ${Math.round((num(w.since) - num(it.startedAt)) / MIN)} 分動いてから待機に入った（結果をもう受け取っているかもしれない）`);
      }
    }
    if (reasons.length) out.push({ ref: a.ref, code: a.code, command: it.command, reasons });
  }
  return out;
}

// ---- haiku's opinion (only where the code had no reason) ---------------------------------------------------------
const CODES = ['gone', 'silent', 'long'];
// One waits entry -> [{ ref, code, alert, item }]: the command alerts hintsFor gave no reason for.
function needsHaiku(entry) {
  const w = entry && entry.wait;
  if (!w || !Array.isArray(w.alerts) || !w.alerts.length) return [];
  const told = new Set(hintsFor(entry).map((h) => h.ref));
  const cmds = (Array.isArray(w.items) ? w.items : []).filter((i) => i && i.type === 'command');
  const out = [];
  for (const a of w.alerts) {
    if (!a || !CODES.includes(a.code) || told.has(a.ref)) continue;
    const id = String(a.ref || '').replace(/:(gone|silent|long)$/, '');
    const item = cmds.find((c) => c.id === id);
    if (item) out.push({ ref: a.ref, code: a.code, alert: a, item });
  }
  return out;
}

const HAIKU_SCHEMA = {
  type: 'object',
  properties: { falseAlarm: { type: 'string', enum: ['yes', 'no', 'unknown'] }, reason: { type: 'string' } },
  required: ['falseAlarm', 'reason'],
};
const HAIKU_SYSTEM = 'You judge whether an alert about a background shell command of a coding agent is a false alarm, and answer only the JSON the user asks for, with the reason in Japanese.';
const HAIKU_ARGS = triage.haikuArgs({ systemPrompt: HAIKU_SYSTEM, schema: HAIKU_SCHEMA });
const TAIL_MAX = 1500;
const REASON_MAX = 160;

// The prompt (stdin): the waits row (as in waits.json, only this command), the command, the tail of its output (or none).
function haikuPrompt(entry, need, tail = '', now = Date.now()) {
  const w = entry.wait || {};
  const row = {
    folderName: entry.folderName,
    label: oneLine(entry.label, 120),
    kind: w.kind,
    waitedSec: num(w.since) ? Math.max(0, Math.round((now - num(w.since)) / 1000)) : undefined,
    alert: { code: need.code, text: oneLine(need.alert && need.alert.text, 300) },
    item: need.item,
  };
  const t = String(tail || '').slice(-TAIL_MAX);
  return [
    'あなたは「終わらない待ち」の知らせの見立て係です。コーディング エージェントが裏で動かしたコマンドについて、アプリが「止まっているかもしれない」と知らせました。',
    'gone = プロセスが見つからない、silent = 出力が長く止まっている、long = 打ち切り時間を過ぎても動いている。',
    'この知らせが誤報（実はちゃんと進んでいる・もう終わって結果が出ている・待つのが正しい）かを見立ててください。',
    '決まり: 下の材料だけで判断する。分からなければ unknown。reason は日本語 1 文（100 字まで）で、材料のどこからそう見たかを書く。',
    '答えは JSON だけ: {"falseAlarm": "yes" | "no" | "unknown", "reason": "<1 文>"}',
    '',
    '## waits の行（このコマンドの分）',
    JSON.stringify(row),
    '',
    '## コマンド',
    String(need.item && need.item.command || ''),
    '',
    '## 出力ファイルの末尾',
    t.trim() ? t : '（なし）',
  ].join('\n') + '\n';
}

// stdout -> { falseAlarm: 'yes'|'no'|'unknown', reason } | null
function parseOpinion(stdout) {
  const b = triage.parseJsonOut(stdout);
  if (!b || !['yes', 'no', 'unknown'].includes(b.falseAlarm)) return null;
  return { falseAlarm: b.falseAlarm, reason: oneLine(b.reason, REASON_MAX) };
}

const keyOf = (entry, ref) => `${entry.tabKey}:${ref}`; // the same key main.js uses for waitsReported

// createOpinions({ ask, readTail, now, busyRetryMs }) -> { update(entries) -> Set of pending keys, opinionOf(key), size() }
//   ask(prompt) -> { ok, stdout } | { ok: false, error } (main: the shared haiku runner). readTail(entry, item) -> string.
//   Each key is asked once (one call at a time, in order). Failing / timing out / not JSON -> settled with no opinion.
//   'busy' (the runner is on another call) / 'low memory' -> asked again on a later update for busyRetryMs, then given up.
//   A key is pending from the update that first sees it until its call settles: main holds back the ルーター's wake for it
//   (at most the runner's time limit + one round) so the opinion goes with the first notice.
function createOpinions({ ask, readTail = async () => '', now = () => Date.now(), busyRetryMs = 60 * 1000, max = 300 } = {}) {
  const state = new Map(); // key -> { st: 'queued'|'asking'|'retry'|'done', firstAt, op, entry, need }
  let chain = Promise.resolve();
  const settle = (s, op) => {
    s.st = 'done';
    s.op = op;
    s.entry = s.need = null;
  };
  const runOne = async (s) => {
    s.st = 'asking';
    let tail = '';
    try {
      tail = String((await readTail(s.entry, s.need.item)) || '');
    } catch {}
    let r;
    try {
      r = await ask(haikuPrompt(s.entry, s.need, tail, now()));
    } catch (err) {
      r = { ok: false, error: String((err && err.message) || err) };
    }
    if (r && r.ok) return settle(s, parseOpinion(r.stdout));
    const err = String((r && r.error) || '');
    if ((err === 'busy' || err === 'low memory') && now() - s.firstAt < busyRetryMs) s.st = 'retry';
    else settle(s, null);
  };
  const start = (s) => {
    s.st = 'queued';
    chain = chain.then(() => runOne(s)).catch(() => settle(s, null));
  };
  return {
    update(entries) {
      const pending = new Set();
      for (const e of entries || []) {
        for (const need of needsHaiku(e)) {
          const key = keyOf(e, need.ref);
          let s = state.get(key);
          if (!s) {
            s = { st: 'new', firstAt: now(), op: null, entry: e, need };
            state.set(key, s);
            while (state.size > max) state.delete(state.keys().next().value);
            start(s);
          } else if (s.st === 'retry') {
            s.entry = e;
            s.need = need;
            start(s);
          }
          if (s.st !== 'done') pending.add(key);
        }
      }
      return pending;
    },
    opinionOf: (key) => (state.get(key) && state.get(key).op) || null,
    size: () => state.size,
    idle: () => chain, // tests: settles when the queued calls are done
  };
}

const OPINION_WORD = { yes: '誤報らしい', no: '本当に止まっていそう', unknown: '分からない' };

// entries (as for waits.formatForManager) -> the lines to add under the block, '' when none.
// opinionOf(key) (optional, createOpinions) adds 「haiku の見立て」 for the alerts the code had no reason for.
function block(entries, max = 10, opinionOf = null) {
  const lines = [];
  let haiku = false;
  for (const e of (entries || []).filter((x) => x && x.wait && x.wait.alerts && x.wait.alerts.length).slice(0, max)) {
    for (const h of hintsFor(e)) {
      lines.push(`- 誤報の見込み [${e.folderName}] tabKey ${e.tabKey} の ${h.code}（\`${label(h.command)}\`）: ${h.reasons.join(' / ')}`);
    }
    if (typeof opinionOf !== 'function') continue;
    for (const n of needsHaiku(e)) {
      const op = opinionOf(keyOf(e, n.ref));
      if (!op) continue;
      haiku = true;
      lines.push(`- 誤報の見込み [${e.folderName}] tabKey ${e.tabKey} の ${n.code}（\`${label(n.item.command)}\`）: haiku の見立て: ${OPINION_WORD[op.falseAlarm]}（${op.falseAlarm}）${op.reason ? ' — ' + op.reason : ''}`);
    }
  }
  if (!lines.length) return '';
  const how = haiku ? 'アプリがコマンドの文と待ちの様子から見立てたもの、「haiku の見立て」は haiku に waits の行と出力の末尾を見せて聞いたもの' : 'アプリがコマンドの文と待ちの様子から見立てたもの';
  return [`（誤報の見込み: ${how}。確かではないので、waits.json とセッションの様子で確かめ、誤報なら nudge しない）`, ...lines].join('\n');
}

module.exports = { hintsFor, block, pipes, writesFile, needsHaiku, haikuPrompt, parseOpinion, createOpinions, HAIKU_ARGS, HAIKU_SCHEMA };
