// What an idle session waits for (PROGRESS 40): background commands, team members, subagents, the user — and waits that
// never end (the command's process is gone without its completion notice, its output stopped, it runs too long, or the
// whole team waits with nothing unread). No Electron imports (testable from plain Node); main.js gathers the probes
// (output file stat, process tree, team unread count) and pushes the result to the windows, the dashboard / widget,
// 「ルーターから」 (warn, key app:waits) and the manager's prompt. See CONTRACT.md "Waits".
//
// Input per session: the renderer's TabState (status, bg: [{ id, command, outFile, startedAt }] from Panel.summary,
// team / agents) + main's probes. Output: Wait = { kind, text, short, level, since, items, alerts } | null.
const MIN = 60 * 1000;
const DEFAULTS = { silentMin: 10, longMin: 60 };
const DEADLOCK_MS = 5 * MIN; // same as the backlog's 「待ち合い」 (renderer SCHED_DEADLOCK_MS)
const GONE_GRACE_MS = 60 * 1000; // a command younger than this is never "gone" (its process may not be listed yet)
const GONE_SCANS = 2; // consecutive process scans without it before it counts as gone
const CMD_MAX = 300;
// A subagent / team member still "running" that is stale is not waited for (listed with stale: true, left out of kind,
// the line and the counts). The rule is src/renderer/stale-agents.js, the same as the renderer's liveAgents: no
// transcript line for STALE_AGENT_MS after 作業完了 (PROGRESS 46), or for 60 min (20 min while an update holds) even
// without it (AT-autoclose). The renderer sends its clock in TabState.agentClock { base, staleMs, quiet }.
const SA = require('../renderer/stale-agents');
const STALE_AGENT_MS = SA.STALE_AGENT_MS;
// the 作業完了 part alone (a = { status, updatedAt }, doneAt = ms the session ended with 作業完了, 0 = not)
function staleAgent(a, now, doneAt, ms = STALE_AGENT_MS) {
  return !!num(doneAt) && SA.isStale(a, { now, doneAt, staleMs: ms, quiet: Number.MAX_SAFE_INTEGER });
}

const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const oneLine = (s, n) => str(s, 2000).replace(/\s+/g, ' ').trim().slice(0, n);

// Settings (manager-settings.json waitSilentMin / waitLongMin) -> { silentMin, longMin } within 1..1440.
function settingsOf(o) {
  const pick = (v, d) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 1 && n <= 1440 ? n : d;
  };
  return { silentMin: pick(o && o.silentMin, DEFAULTS.silentMin), longMin: pick(o && o.longMin, DEFAULTS.longMin) };
}

// ms -> 「26 分」「1 時間 5 分」「30 秒」
function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return '1 分未満'; // minutes only: the line changes at most once a minute (no redraw per tick)
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分`;
  return `${Math.floor(m / 60)} 時間${m % 60 ? ` ${m % 60} 分` : ''}`;
}
const durShort = (ms) => dur(ms).replace(/ /g, '');

// The command text for a line: first line, at most 60 chars.
// Long absolute paths are shortened to their last two parts (…/waits/dummy.js) so the script name stays visible.
function cmdLabel(c) {
  const s = oneLine(c, CMD_MAX)
    .split(' ')
    .map((w) => {
      const parts = w.replace(/\\/g, '/').split('/');
      return w.length > 24 && parts.length > 3 && /^([A-Za-z]:|~)?$/.test(parts[0]) ? '…/' + parts.slice(-2).join('/') : w;
    })
    .join(' ');
  return s.length > 80 ? s.slice(0, 79) + '…' : s || '（コマンド）';
}

// --- process matching -------------------------------------------------------------------
// Does a process command line run this command? Claude Code wraps it (bash -c -l "… eval '<cmd>' …", powershell
// -Command …), with its own quoting, so the words of the command are compared, not the raw text.
const SHELL_WORDS = new Set(['&&', '||', '|', ';', '>', '>>', '2>&1', '2>', '<', '&', 'cd', 'echo', 'set', 'export', 'then', 'do', 'done', 'fi']);
function words(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\\\\/g, '/')
    .replace(/\\/g, '/')
    .split(/[\s"'`]+/)
    .map((w) => w.replace(/^[(]+|[);,]+$/g, ''))
    .filter((w) => w.length >= 2 && !SHELL_WORDS.has(w));
}
function matchWords(line, want) {
  if (!want.length) return false;
  let hit = 0;
  for (const w of want) if (line.includes(w)) hit++;
  return hit >= Math.max(1, Math.ceil(want.length * 0.75));
}
function cmdMatches(cmdLine, command) {
  const line = ' ' + words(cmdLine).join(' ') + ' ';
  if (matchWords(line, [...new Set(words(command))].slice(0, 8))) return true;
  // a pipeline / list (`a > f 2>&1 | tail`, `x; y`): its parts run as their own processes once the wrapping shell is
  // gone from the list; a part of 3+ words that matches counts (PROGRESS 50)
  const parts = String(command || '').split(/\|\|?|&&|;/);
  if (parts.length < 2) return false;
  return parts.some((p) => {
    // `timeout 150 node x.mjs`: the child runs as `node x.mjs` (the wrappers' own words are not in its line)
    const core = p.replace(/^\s*(?:(?:timeout(?:\s+-\S+)*(?:\s+\/t)?\s+\S+|nohup|time|exec)\s+)+/i, '').replace(/\s\d?>&?\d?\s*$/g, '');
    const want = [...new Set(words(core))].filter((w) => !/^\d?>&\d$/.test(w)).slice(0, 8);
    // 3+ words, or 2 when one is a script path (x/y.mjs): `tail -40` alone never matches
    const specific = want.length >= 3 || (want.length >= 2 && want.some((w) => w.length >= 6 && /[/.]/.test(w) && /[a-z]/.test(w)));
    return specific && matchWords(line, want);
  });
}

// --- matching by image name (SEC3: the process list reads no command lines, docs/security.md) ---------
// The programs a command starts: the first word of each part of a pipeline / list, after wrappers (timeout 150,
// nohup, env A=b, cd x &&), as image base names ("node", "python"). Launchers whose process has another image name map
// to it (npm -> node). Shells are left out: Claude Code runs every command inside one, so a shell says nothing.
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh']);
const ALIASES = { npm: ['node'], npx: ['node'], pnpm: ['node'], yarn: ['node'], tsx: ['node'], electron: ['electron', 'node'], python3: ['python', 'python3', 'py'], py: ['py', 'python'], pip: ['pip', 'python'], uv: ['uv', 'python'], git: ['git'] };
const SH_HEADS = new Set(['for', 'case', 'select', 'foreach', 'done', 'fi', 'esac', '}', ')']);
const SH_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '(', '&', 'try', 'begin', 'process']);
const baseName = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.(exe|cmd|bat|com|ps1)$/, '');
function programsOf(command) {
  const out = new Set();
  for (const part of String(command || '').split(/\|\|?|&&|;|\r?\n/)) {
    const ws = part
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/^["'(]+|["');]+$/g, ''))
      .filter(Boolean);
    let i = 0;
    // a loop / case head (`for n in 1 2`, `case $x in`) starts nothing; `done` / `fi` / `esac` neither
    if (ws.length && SH_HEADS.has(ws[0].toLowerCase())) continue;
    while (i < ws.length) {
      const w = ws[i].toLowerCase();
      if (SH_KEYWORDS.has(w) || /^[a-z_][a-z0-9_]*=/i.test(ws[i]) || w === 'env' || w === 'nohup' || w === 'time' || w === 'exec' || w === 'command' || w === 'start') i++;
      else if (w === 'timeout') {
        i++;
        while (i < ws.length && /^(-|\/t$)/i.test(ws[i])) i++;
        i++; // the duration
      } else break;
    }
    if (i >= ws.length) continue;
    const prog = baseName(ws[i]);
    if (!prog || /^[0-9]/.test(prog) || prog === 'cd' || prog === 'echo' || prog === 'set' || prog === 'export' || SHELLS.has(prog)) continue;
    for (const a of ALIASES[prog] || [prog]) out.add(a);
    if (/\.(m?js|cjs)$/i.test(ws[i])) out.add('node');
  }
  return out;
}

// procs = [{ pid, ppid, cmd, name }] (one src/main/proclist.js list; cmd null = not read, then the image name is used),
// root = the pty's pid -> 'alive' | 'gone' | 'unknown' (unknown: no list, the pty itself is not in it, or no match
// while a descendant may still be the command: an unread line with no name, or a shell that may be running it).
// since (ms, the command's start; 0 = unknown): a process created more than SINCE_SLACK_MS before it cannot be the
// command or its shell (the fake / real claude itself, an MCP server node.exe), so its name is not looked at.
const SINCE_SLACK_MS = 5000;
function procState(procs, root, command, { since = 0 } = {}) {
  if (!Array.isArray(procs) || !procs.length || !root) return 'unknown';
  const kids = new Map();
  let rootSeen = false;
  for (const p of procs) {
    if (p.pid === root) rootSeen = true;
    if (p.pid === p.ppid) continue;
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  if (!rootSeen) return 'unknown';
  const stack = [...(kids.get(root) || [])];
  const seen = new Set();
  let blind = false;
  let progs = null;
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    if (p.cmd == null) {
      const img = baseName(p.name);
      const older = since > 0 && Number.isFinite(p.created) && p.created < since - SINCE_SLACK_MS;
      if (older && !SHELLS.has(img)) {
        // a program started before the command: not it (its children are still looked at). An older shell still
        // counts as "may be running it" below: `since` can be later than the real start (a late transcript line).
      } else if (!img) blind = true;
      else {
        if (!progs) progs = programsOf(command);
        if (progs.has(img)) return 'alive';
        // no program known for the command, or a shell that may be running it (a builtin, a script): cannot tell
        if (!progs.size || SHELLS.has(img)) blind = true;
      }
    } else if (p.cmd && cmdMatches(p.cmd, command)) return 'alive';
    for (const c of kids.get(p.pid) || []) stack.push(c);
  }
  return blind ? 'unknown' : 'gone';
}

// "pid<TAB>ppid<TAB>commandline" lines -> [{ pid, ppid, cmd }]
function parseProcs(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\t(\d+)\t(.*)$/.exec(line);
    if (m) out.push({ pid: +m[1], ppid: +m[2], cmd: m[3] });
  }
  return out;
}

// --- what a command writes and how long it may run (PROGRESS 50) --------------------------------------
// A command that writes its output to a file (`> f`, `>> f`, `> f 2>&1`, `| tee f`, Out-File / Tee-Object / Add-Content /
// Set-Content) leaves Claude's .output empty; the file it writes is its output. A path argument of a known kind
// (`node x.js out/log.txt`) counts too: only an update after the command started is taken as output.
const FILE_ARG_RE = /\.(txt|log|out|json|jsonl|ndjson|csv|tsv|md|html?|xml)$/i;
const NULL_TARGET_RE = /^(\/dev\/null|\$null|nul|&\d?|-)$/i;
const VAR_RE = /[$%*?`{}]/;
const PS_WRITE = new Set(['out-file', 'tee-object', 'add-content', 'set-content']);
const PS_PATH_OPT = new Set(['-filepath', '-path', '-literalpath', '-file']);
// shell-ish words with quotes removed; | ; && || & kept as their own words
function shellWords(s) {
  const out = [];
  let cur = '';
  let q = '';
  let has = false;
  const push = () => {
    if (has) out.push(cur);
    cur = '';
    has = false;
  };
  const t = String(s || '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === q) q = '';
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      has = true;
    } else if (/\s/.test(c)) push();
    else if (c === ';' || c === '|' || (c === '&' && t[i + 1] === '&')) {
      push();
      if ((c === '|' || c === '&') && t[i + 1] === c) {
        out.push(c + c);
        i++;
      } else out.push(c);
    } else {
      cur += c;
      has = true;
    }
  }
  push();
  return out;
}
// Git Bash /c/Users/… -> C:/Users/…
const winPath = (p) => (/^\/[A-Za-z]\//.test(p) ? `${p[1].toUpperCase()}:${p.slice(2)}` : p);
const isAbs = (p) => /^([A-Za-z]:[\\/]|[\\/]{2})/.test(p);
function joinPath(dir, p) {
  const w = winPath(p);
  if (isAbs(w) || !dir) return w.replace(/\\/g, '/');
  if (/^~[\\/]/.test(w)) return w.replace(/\\/g, '/');
  const parts = winPath(dir).replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  for (const seg of w.replace(/\\/g, '/').split('/')) {
    if (seg === '..') parts.length > 1 && parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
// A target with a variable in its name ($n, %i%) -> the newest file of its directory whose name fits the rest
function targetOf(dir, p, weak = false) {
  if (!p || NULL_TARGET_RE.test(p) || p.length > 400) return null;
  const full = joinPath(dir, p);
  const cut = full.lastIndexOf('/');
  const base = full.slice(cut + 1);
  const folder = cut > 0 ? full.slice(0, cut) : '';
  if (VAR_RE.test(folder) || !base) return null;
  if (!VAR_RE.test(base)) return { file: full, weak };
  if (!folder) return null;
  const re = '^' + base.split(/(?:\$\{?\w+\}?|%\w+%|[*?`{}$%])+/).map((x) => x.replace(/[.+^()[\]|\\]/g, '\\$&')).join('.*') + '$';
  return { dir: folder, re, weak };
}
// command (+ the tab's cwd) -> [{ file, weak } | { dir, re, weak }] (at most 8). weak = a path argument, not a redirect.
function outTargets(command, cwd = '') {
  const w = shellWords(command);
  const out = [];
  const seen = new Set();
  let dir = cwd;
  const add = (t) => {
    if (!t) return;
    const k = t.file || `${t.dir}|${t.re}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  for (let i = 0; i < w.length && out.length < 8; i++) {
    const x = w[i];
    const prev = i ? w[i - 1] : '';
    const segStart = !prev || prev === ';' || prev === '&&' || prev === '||' || prev === '|' || /^(do|then|else)$/.test(prev);
    // cd <dir> at the start of a part: later relative paths are under it
    if (segStart && (x === 'cd' || /^(set-location|sl|pushd)$/i.test(x)) && w[i + 1] && !/^[;|&]/.test(w[i + 1])) {
      dir = joinPath(dir, w[i + 1]);
      i++;
      continue;
    }
    // > f, >> f, 1> f, 2> f, &> f, and the attached forms >f, 2>>f
    const rm = /^(\d|&)?>>?(.*)$/.exec(x);
    if (rm) {
      if (rm[1] === '2' && !rm[2] && w[i + 1] === '&1') continue;
      const target = rm[2] || w[i + 1] || '';
      if (!rm[2]) i++;
      if (!/^&/.test(target)) add(targetOf(dir, target));
      continue;
    }
    // | tee [-a] f …
    if (x === 'tee' && prev === '|') {
      for (let j = i + 1; j < w.length && !/^[;|&]/.test(w[j]) && !/^&&$/.test(w[j]); j++) if (!w[j].startsWith('-')) add(targetOf(dir, w[j]));
      continue;
    }
    // Out-File / Tee-Object / Add-Content / Set-Content [-FilePath] f
    if (PS_WRITE.has(x.toLowerCase())) {
      for (let j = i + 1; j < w.length && !/^[;|]/.test(w[j]); j++) {
        const o = w[j].toLowerCase();
        if (PS_PATH_OPT.has(o)) {
          add(targetOf(dir, w[j + 1]));
          break;
        }
        if (o.startsWith('-')) {
          if (!/^-(append|force|noclobber|nonewline|passthru)$/.test(o)) j++; // an option with a value
          continue;
        }
        add(targetOf(dir, w[j]));
        break;
      }
      continue;
    }
    if (prev !== '<' && !x.startsWith('-') && FILE_ARG_RE.test(x) && !/^[a-z]+:\/\//i.test(x)) add(targetOf(dir, x, true));
  }
  return out;
}
// The command's own time limit in ms (0 = none): `timeout [opts] N[smhd]` (GNU), `timeout /t N` (cmd),
// `Wait-Process … -Timeout N`, `Wait-Job … -Timeout N`. The largest one counts.
const UNIT = { s: 1000, m: MIN, h: 60 * MIN, d: 24 * 60 * MIN };
function timeoutOf(command) {
  const w = shellWords(command);
  let max = 0;
  for (let i = 0; i < w.length; i++) {
    const x = w[i].toLowerCase();
    if (x === 'timeout') {
      let j = i + 1;
      if ((w[j] || '').toLowerCase() === '/t') j++;
      while (j < w.length && /^-/.test(w[j])) j += /^-(k|s)$/.test(w[j]) ? 2 : 1; // -k 5, -s KILL, --kill-after=5 …
      const m = /^(\d+(?:\.\d+)?)([smhd]?)$/i.exec(w[j] || '');
      if (m) max = Math.max(max, Number(m[1]) * UNIT[(m[2] || 's').toLowerCase()]);
    } else if (/^(wait-process|wait-job)$/.test(x)) {
      for (let j = i + 1; j < w.length && !/^[;|]/.test(w[j]); j++) {
        if (w[j].toLowerCase() === '-timeout' && /^\d+$/.test(w[j + 1] || '')) max = Math.max(max, Number(w[j + 1]) * 1000);
      }
    }
  }
  return Math.round(max);
}
// UX11 (the SSA-210 false alarm, 2026-11-16): a command that only waits — `sleep 3660`, `timeout 600`, `Start-Sleep -Seconds
// 60`, `ping -n 60 127.0.0.1 > nul` is not in it, only sleep / timeout / Start-Sleep and a no-op (`true`, `:`, `echo …`)
// joined by ; && || — writes nothing on purpose, so its quiet output is not "silent" (its length is still "long").
// `timeout 600 node x.js` runs a program: not sleep-only.
function sleepOnly(command) {
  const parts = String(command || '')
    .split(/&&|\|\||;|\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return false;
  let sleeps = 0;
  for (const p of parts) {
    const w = shellWords(p).filter((x) => !/^\d?>/.test(x) && !NULL_TARGET_RE.test(x));
    if (!w.length) continue;
    const head = w[0].toLowerCase();
    if (head === 'sleep' || head === 'start-sleep') {
      if (w.slice(1).every((x) => /^(-\w+|\d+(?:\.\d+)?[smhd]?)$/i.test(x))) sleeps++;
      else return false;
    } else if (head === 'timeout') {
      // timeout [/t] N [/nobreak]  (cmd) or a bare `timeout N` — no program after the duration
      const rest = w.slice(1).filter((x) => !/^(\/t|\/nobreak|-\S+)$/i.test(x));
      if (rest.length === 1 && /^\d+(?:\.\d+)?[smhd]?$/i.test(rest[0])) sleeps++;
      else return false;
    } else if (head === 'true' || head === ':' || head === 'echo' || head === 'date') continue;
    else return false;
  }
  return sleeps > 0;
}

// targets (outTargets) -> { known: true, mtimeMs (newest, 0 = none yet), files: [the newest one(s)] } (main, per check)
async function newestOf(targets, fsp = require('fs').promises) {
  let best = 0;
  let file = '';
  const st = (f) => fsp.stat(f).then((s) => (s.isFile() ? s.mtimeMs : 0), () => 0);
  for (const t of (targets || []).slice(0, 8)) {
    if (t.file) {
      const m = await st(t.file);
      if (m > best) (best = m), (file = t.file);
      continue;
    }
    let names = [];
    try {
      names = await fsp.readdir(t.dir);
    } catch {}
    const re = new RegExp(t.re, 'i');
    for (const n of names.filter((n) => re.test(n)).slice(0, 200)) {
      const m = await st(`${t.dir}/${n}`);
      if (m > best) (best = m), (file = `${t.dir}/${n}`);
    }
  }
  const all = (targets || []).map((t) => t.file || `${t.dir}/`);
  return { known: all.length > 0, mtimeMs: best, files: file ? [file, ...all.filter((f) => f !== file)].slice(0, 4) : all.slice(0, 4) };
}
const TIMEOUT_GRACE_MS = MIN; // past its own time limit by this much, a command that still runs is not "within its limit"

// --- the wait of one session --------------------------------------------------------------
// t = TabState; o = {
//   now, idleSince (ms the tab became idle / asking, kept by main), ptyStartedAt (ms the tab's claude started; commands
//   started before belong to an earlier process and are left out),
//   files: Map(outFile -> { mtimeMs, size } | null), procs: Map(commandId -> 'alive'|'gone'|'unknown'),
//   goneScans: Map(commandId -> consecutive scans without the process), teamUnread: number|null (-1/null = unknown),
//   teamQuietSince: ms since when every member waits, settings: { silentMin, longMin } }
// -> Wait | null (null: not idle / asking, exited or resting)
function waitOf(t, o = {}) {
  if (!t || typeof t !== 'object') return null;
  const now = o.now || Date.now();
  const status = str(t.status, 20);
  if (t.rest || (status !== 'idle' && status !== 'asking')) return null;
  // ended with 作業完了 (its routed item done by the marker, or the last reply ends with it and the turn is over;
  // renderer doneMarkAt): finished, not waiting — no line, no alert, not in waits.json (PROGRESS 50)
  if (num(t.doneAt)) return null;
  // main passes settingsOf() values (tests may pass fractions of a minute); only missing ones fall back to the defaults
  const set = { silentMin: num(o.settings && o.settings.silentMin) || DEFAULTS.silentMin, longMin: num(o.settings && o.settings.longMin) || DEFAULTS.longMin };
  const since = num(o.idleSince) || now;
  const items = [];
  const alerts = [];

  if (status === 'asking') {
    const q = t.prompt && typeof t.prompt === 'object' ? oneLine(t.prompt.question, 80) : '';
    return {
      kind: 'user',
      text: `確認待ち — ユーザーの答えを待っている（${dur(now - since)}${q ? `、「${q}」` : ''}）`,
      short: `確認 ${durShort(now - since)}`,
      level: 'ok',
      since,
      items: [],
      alerts: [],
    };
  }

  // background commands of this claude process
  const born = num(o.ptyStartedAt);
  const bg = (Array.isArray(t.bg) ? t.bg : []).filter((b) => b && typeof b.id === 'string' && (!born || num(b.startedAt) >= born - 5000));
  for (const b of bg.slice(0, 10)) {
    const startedAt = num(b.startedAt) || now;
    const outFile = str(b.outFile, 500);
    const st = outFile && o.files ? o.files.get(outFile) : null;
    const claudeOutAt = st && st.size > 0 ? Math.max(startedAt, num(st.mtimeMs)) : 0;
    // the files the command writes (outTargets, stat by main): updated after it started = output (PROGRESS 50)
    const tg = o.targets ? o.targets.get(b.id) : null;
    const fileAt = tg && num(tg.mtimeMs) >= startedAt - 2000 ? num(tg.mtimeMs) : 0;
    const lastOutputAt = Math.max(claudeOutAt, fileAt);
    const proc = (o.procs && o.procs.get(b.id)) || 'unknown';
    const limitMs = timeoutOf(str(b.command, 2000));
    const it = {
      type: 'command',
      id: str(b.id, 60),
      command: oneLine(b.command, CMD_MAX),
      startedAt,
      hasOutput: !!outFile || !!(tg && tg.known),
      lastOutputAt,
      outBytes: st ? num(st.size) : 0,
      proc,
      files: tg && Array.isArray(tg.files) ? tg.files.slice(0, 4) : [],
      fileAt,
      timeoutSec: Math.round(limitMs / 1000),
    };
    items.push(it);
    const ref = `${it.id}`;
    const label = `コマンド \`${cmdLabel(it.command)}\``;
    // within its own time limit (timeout N, Wait-Process -Timeout N): neither silent nor long until then
    const withinLimit = limitMs > 0 && now - startedAt < limitMs + (o.timeoutGraceMs ?? TIMEOUT_GRACE_MS);
    // a file it writes was updated lately: its process tree may not show it (pipes, Out-File), but it works
    const writing = fileAt && now - fileAt < set.silentMin * MIN;
    const gone = proc === 'gone' && !writing && now - startedAt >= (o.goneGraceMs || GONE_GRACE_MS) && ((o.goneScans && o.goneScans.get(b.id)) || 0) >= GONE_SCANS;
    if (gone) alerts.push({ code: 'gone', ref: `${ref}:gone`, text: `${label} のプロセスが無いのに、完了の通知が来ていない（開始から ${dur(now - startedAt)}）` });
    const quietFrom = lastOutputAt || startedAt;
    if (sleepOnly(b.command)) it.sleepOnly = true; // UX11: waits on purpose, never "silent" (long still counts)
    if (!gone && !withinLimit && !it.sleepOnly && it.hasOutput && now - quietFrom >= set.silentMin * MIN) {
      const what = fileAt ? '出力（書き込み先のファイルを含む）' : lastOutputAt ? '出力' : it.files.length ? '出力（書き込み先のファイルも更新が無い）' : '出力（まだ何も出ていない）';
      alerts.push({ code: 'silent', ref: `${ref}:silent`, text: `${label} の${what}が ${dur(now - quietFrom)} 止まっている${limitMs ? `（打ち切り ${dur(limitMs)} を過ぎた）` : ''}` });
    }
    if (!gone && !withinLimit && now - startedAt >= set.longMin * MIN) {
      alerts.push({ code: 'long', ref: `${ref}:long`, text: `${label} が開始から ${dur(now - startedAt)} 続いている（目安 ${set.longMin} 分${limitMs ? `、打ち切り ${dur(limitMs)}` : ''}）` });
    }
  }

  // team members (Agent Teams) and subagents
  const ag = t.agents && typeof t.agents === 'object' ? t.agents : null;
  const team = (ag && ag.team) || (t.team && typeof t.team === 'object' ? t.team : null);
  // the renderer's clock for this tab (liveAgents); o.staleAgentMs / o.staleQuietMs (tests, env) win over it
  const clock = t.agentClock && typeof t.agentClock === 'object' ? t.agentClock : {};
  const sc = {
    now,
    doneAt: num(t.doneAt),
    base: num(clock.base),
    staleMs: num(o.staleAgentMs) || num(clock.staleMs) || STALE_AGENT_MS,
    quiet: num(o.staleQuietMs) || num(clock.quiet) || SA.quietLimit({ hold: !!o.updateHold }),
  };
  const isStale = (a) => SA.isStale(a, sc);
  const members = team && !team.removed && Array.isArray(team.members) ? team.members.filter((m) => m && m.name) : [];
  const liveMembers = members.filter((m) => (m.status === 'running' || m.status === 'starting' || m.status === 'idle') && !isStale(m));
  for (const m of liveMembers.slice(0, 20)) items.push({ type: 'member', name: str(m.name, 60), status: str(m.status, 20), updatedAt: num(m.updatedAt) });
  const allSubs = (ag && Array.isArray(ag.subagents) ? ag.subagents : Array.isArray(t.subagents) ? t.subagents : []).filter(
    (a) => a && (a.status === 'running' || a.status === 'starting'),
  );
  const subs = allSubs.filter((a) => !isStale(a));
  for (const a of subs.slice(0, 20)) {
    items.push({ type: 'agent', agentId: str(a.agentId, 100), agentType: str(a.agentType, 60), description: oneLine(a.description, 120), status: str(a.status, 20), updatedAt: num(a.updatedAt) });
  }
  // left out of kind, the line and the counts: stale (stale-agents.js), listed with stale: true
  for (const m of members.filter((m) => isStale(m)).slice(0, 20)) items.push({ type: 'member', name: str(m.name, 60), status: str(m.status, 20), updatedAt: num(m.updatedAt), stale: true });
  for (const a of allSubs.filter((a) => isStale(a)).slice(0, 20)) {
    items.push({ type: 'agent', agentId: str(a.agentId, 100), agentType: str(a.agentType, 60), description: oneLine(a.description, 120), status: str(a.status, 20), updatedAt: num(a.updatedAt), stale: true });
  }
  const working = liveMembers.filter((m) => m.status !== 'idle');
  if (liveMembers.length && !working.length && !subs.length && !bg.length) {
    const quiet = now - (num(o.teamQuietSince) || since);
    if (quiet >= (o.deadlockMs || DEADLOCK_MS) && o.teamUnread === 0) {
      alerts.push({
        code: 'deadlock',
        ref: `team:${str(team.name, 80)}:deadlock`,
        text: `チーム ${str(team.name, 80)} のリーダーと全員が ${dur(quiet)} 待機中で、未読のメッセージが無い（待ち合いで止まった可能性）`,
      });
    }
  }

  // the line
  const parts = [];
  const shorts = [];
  let kind = 'none';
  const cmds = items.filter((i) => i.type === 'command');
  if (cmds.length) {
    kind = 'command';
    const c = cmds[0];
    const extra = [`${dur(now - c.startedAt)}`];
    if (c.lastOutputAt) extra.push(now - c.lastOutputAt < MIN ? '最後の出力 1 分以内' : `最後の出力 ${dur(now - c.lastOutputAt)}前`);
    else if (c.hasOutput) extra.push('出力はまだ無い');
    if (c.timeoutSec) extra.push(`打ち切り ${dur(c.timeoutSec * 1000)}`);
    if (c.proc === 'gone') extra.push('プロセスが見つからない');
    parts.push(`コマンド \`${cmdLabel(c.command)}\` を待っている（${extra.join('、')}）${cmds.length > 1 ? ` ほか ${cmds.length - 1} 件` : ''}`);
    shorts.push(`コマンド ${durShort(now - c.startedAt)}`);
  }
  if (liveMembers.length) {
    if (kind === 'none') kind = 'team';
    const names = liveMembers.slice(0, 4).map((m) => `${m.name} ${m.status === 'idle' ? '待機中' : '動作中'}`).join('、');
    parts.push(`担当 ${liveMembers.length} 人の報告を待っている（${names}${liveMembers.length > 4 ? ' …' : ''}）`);
    shorts.push(`担当 ${liveMembers.length}人`);
  }
  if (subs.length) {
    if (kind === 'none') kind = 'agent';
    const d = subs.slice(0, 2).map((a) => oneLine(a.description || a.agentType, 30)).join('、');
    parts.push(`サブエージェント ${subs.length} 件を待っている（${d}）`);
    shorts.push(`サブ ${subs.length}件`);
  }
  if (!parts.length) {
    parts.push('何も待っていない');
    shorts.push('なし');
  }
  return {
    kind,
    text: `待機中 — ${parts.join(' / ')}`.slice(0, 400),
    short: shorts.join('・'),
    level: alerts.length ? 'warn' : 'ok',
    since,
    items,
    alerts,
  };
}

// --- UX11 (docs/ux-journey.md §1.6 row 6): a session still 実行中 whose work stopped -----------------------------
// waitOf looks at idle tabs only. A tab whose claude stays "running" (the spinner keeps repainting the screen, so the
// terminal output never stops) but writes no transcript line — no tool call, no reply, no subagent / member line, no new
// background command — for RUN_QUIET_MIN is told to the ルーター the same way (waits.json, the 終わらない待ち block), with
// canInterrupt: the ルーター stops it with the outbox interrupt (Esc, then 「状況を報告して」). A foreground command of
// Claude Code ends within 10 min (its own limit), so 15 min with no line is not a long command.
// t = TabState (status 'running', eventAt = ms of its last transcript event), o = { now, runningSince (ms the tab became
// running, kept by main), quietMs } -> Wait (kind 'running', one alert 'quiet') | null (not quiet / not running)
const RUN_QUIET_MIN = 15;
function runningOf(t, o = {}) {
  if (!t || typeof t !== 'object' || t.rest || t.exited || str(t.status, 20) !== 'running') return null;
  const now = o.now || Date.now();
  const quietMs = num(o.quietMs) || RUN_QUIET_MIN * MIN;
  const ag = t.agents && typeof t.agents === 'object' ? t.agents : null;
  const team = (ag && ag.team) || (t.team && typeof t.team === 'object' ? t.team : null);
  const subs = (ag && Array.isArray(ag.subagents) ? ag.subagents : Array.isArray(t.subagents) ? t.subagents : []).filter((a) => a && (a.status === 'running' || a.status === 'starting'));
  const members = team && !team.removed && Array.isArray(team.members) ? team.members : [];
  const bg = Array.isArray(t.bg) ? t.bg : [];
  const at = Math.max(
    num(o.runningSince),
    num(t.eventAt),
    ...subs.map((a) => num(a.updatedAt)),
    ...members.map((m) => num(m.updatedAt)),
    ...bg.map((b) => num(b && b.startedAt)),
  );
  if (!at || now - at < quietMs) return null;
  const d = dur(now - at);
  const extra = subs.length ? `、サブエージェント ${subs.length} 件も動きが無い` : '';
  return {
    kind: 'running',
    text: `実行中 — 会話の記録が ${d} 進んでいない（ツールも返答も出ていない${extra}）`,
    short: `実行中 無言 ${durShort(now - at)}`,
    level: 'warn',
    since: at,
    items: [],
    alerts: [{ code: 'quiet', ref: `running:quiet:${Math.round(at / 1000)}`, text: `実行中のまま会話の記録が ${d} 進んでいない（固まっている・確認の画面を待っている可能性。interrupt で止めて状況を聞ける）` }],
  };
}

// --- reports -----------------------------------------------------------------------------------
// entries = [{ tabKey, wcId, folder, folderName, label, backlogId, wait }] -> those with alerts
const alerting = (entries) => (entries || []).filter((e) => e && e.wait && e.wait.alerts && e.wait.alerts.length);

// For manager/waits.json (what the manager reads): every waiting session, alerts first.
function forManager(entries, now = Date.now()) {
  const list = (entries || []).filter((e) => e && e.wait);
  list.sort((a, b) => (b.wait.alerts.length ? 1 : 0) - (a.wait.alerts.length ? 1 : 0));
  return {
    updatedAt: now,
    sessions: list.map((e) => ({
      tabKey: e.tabKey,
      folder: e.folder,
      folderName: e.folderName,
      label: e.label,
      backlogId: e.backlogId || null,
      kind: e.wait.kind,
      text: e.wait.text,
      waitedSec: Math.round((now - e.wait.since) / 1000),
      items: e.wait.items,
      alerts: e.wait.alerts.map((a) => ({ code: a.code, text: a.text })),
      canNudge: e.wait.kind !== 'user' && e.wait.kind !== 'running',
      canInterrupt: e.wait.kind === 'running', // UX11: the outbox interrupt (Esc, then the report request)
    })),
  };
}

// The block for the manager's prompt (「終わらない待ちがあります（N 件）…」), '' when none.
function formatForManager(entries) {
  const list = alerting(entries);
  if (!list.length) return '';
  const lines = list.slice(0, 10).map((e) => `- [${e.folderName}] tabKey ${e.tabKey}${e.backlogId ? ` backlogId ${e.backlogId}` : ''}: ${e.wait.alerts.map((a) => a.text).join(' / ')}`);
  const running = list.some((e) => e.wait.kind === 'running');
  return [
    `終わらない待ちがあります（${list.length} 件）。waits.json を読み、待っている相手が止まっているなら nudge でリーダーに確かめさせてください${running ? '（実行中のまま黙っているもの〈kind running〉は nudge できない。interrupt で止めて状況を聞く）' : ''}:`,
    ...lines,
  ].join('\n');
}

// The warn notice in 「ルーターから」 (key app:waits), null when nothing alerts.
const NOTICE_KEY = 'app:waits';
function notice(entries) {
  const list = alerting(entries);
  if (!list.length) return null;
  const text = list
    .slice(0, 10)
    .map((e) => `- **${e.folderName}**（${oneLine(e.label, 40)}）: ${e.wait.alerts.map((a) => a.text).join(' / ')}`)
    .join('\n');
  return {
    kind: 'warn',
    title: `終わらない待ちの可能性があるセッション ${list.length} 件`,
    text: `${text}\n\n管理エージェントがリーダーに確かめさせます（nudge）。動かなければ、タブを開いて止めるか、作業を振り直してください。`,
    folder: list.length === 1 ? list[0].folder : null,
    key: NOTICE_KEY,
    source: 'app',
    refs: list.flatMap((e) => e.wait.alerts.map((a) => `${e.tabKey}:${a.ref}`)),
  };
}

// The manager's nudge action against the current entries. a = { tabKey, text, reason } -> { ok, entry, text } | { error }
const NUDGE_MAX = 2000;
function checkNudge(a, entries) {
  if (!a || typeof a.tabKey !== 'string' || !a.tabKey) return { error: 'tabKey missing' };
  if (typeof a.text !== 'string' || !a.text.trim()) return { error: 'text missing' };
  if (typeof a.reason !== 'string' || !a.reason.trim()) return { error: 'reason missing' };
  const entry = (entries || []).find((e) => e && e.tabKey === a.tabKey && e.wait);
  if (!entry) return { error: `tab ${a.tabKey} is not waiting (running, closed or never idle); read waits.json again` };
  if (entry.wait.kind === 'user') return { error: 'that session waits for the user (a dialog); use answer or leave it to the user' };
  if (entry.wait.kind === 'running') return { error: 'that session is still running (it does not take input); use interrupt' };
  const text = a.text.replace(/\r\n?/g, '\n').trim().slice(0, NUDGE_MAX);
  return { ok: true, entry, text: `（ルーターから）${text}` };
}

// UX11: the manager's interrupt action. a = { tabKey, reason, text? } -> { ok, entry, text } | { error }. Only a tab in
// the current entries as kind 'running' (実行中のまま黙っている, runningOf) — a working session is never stopped
// because the ルーター guessed. text: what is typed after Esc (default INTERRUPT_TEXT), with 「（ルーターから）」 in front.
const INTERRUPT_TEXT = '作業を一度止めました。いまの状況（やったこと・止まっていた理由・次の一手）を短く報告してから、続けられるなら続けてください。';
function checkInterrupt(a, entries) {
  if (!a || typeof a.tabKey !== 'string' || !a.tabKey) return { error: 'tabKey missing' };
  if (typeof a.reason !== 'string' || !a.reason.trim()) return { error: 'reason missing' };
  if (a.text !== undefined && typeof a.text !== 'string') return { error: 'text must be a string' };
  const entry = (entries || []).find((e) => e && e.tabKey === a.tabKey && e.wait);
  if (!entry || entry.wait.kind !== 'running') return { error: `tab ${a.tabKey} is not 実行中 with its work stopped (only kind running in waits.json can be interrupted); read waits.json again` };
  const text = (a.text && a.text.trim() ? a.text : INTERRUPT_TEXT).replace(/\r\n?/g, '\n').trim().slice(0, NUDGE_MAX);
  return { ok: true, entry, text: `（ルーターから）${text}` };
}

module.exports = {
  DEFAULTS,
  DEADLOCK_MS,
  STALE_AGENT_MS,
  staleAgent,
  NOTICE_KEY,
  settingsOf,
  dur,
  cmdMatches,
  procState,
  programsOf,
  parseProcs,
  outTargets,
  timeoutOf,
  sleepOnly,
  newestOf,
  waitOf,
  RUN_QUIET_MIN,
  runningOf,
  INTERRUPT_TEXT,
  checkInterrupt,
  forManager,
  formatForManager,
  notice,
  checkNudge,
  _words: words,
};
