// Decides how a tab's claude is started (launchSpec) and builds its arguments. No Electron imports
// (plain Node tests use it too). See CONTRACT.md "Claude settings file" and "How a tab's claude is started".
// Default: claude.exe straight under node-pty, no shell in between (a powershell.exe per tab cost ~55-63 MB,
// docs/memory-investigation.md proposal 1).
const path = require('path');
const fs = require('fs');
const os = require('os');
const guard = require('./pretool-guard');
const models = require('./models');

// Settings passed with --settings. preferredNotifChannel "ghostty" makes Claude Code emit
// OSC 777;notify;Claude Code;<body> when it waits for permission / input (docs/plan-notify.md).
// It is a plain setting, so the managed policy (allowManagedHooksOnly) does not block it, unlike hooks.
// TERM_PROGRAM is deliberately not changed: it would also switch on kitty keyboard mode etc.
// spinnerTipsEnabled false (PROGRESS 51c, docs/proc-leftovers.md 案 d): claude 2.1.318 judges its spinner tips at start,
// and the tip ide-upsell-external-terminal starts a process-list pipe through cmd with no time-out to find an IDE. While
// WMI does not answer, that pipe never ends and 3 processes stay behind per claude start. With the tips off claude skips
// that judgment (getRelevantTips); /ide by hand still works. Only in this file (--settings), never ~/.claude/settings.json.
const CLAUDE_SETTINGS = { preferredNotifChannel: 'ghostty', spinnerTipsEnabled: false };
const SETTINGS_NAME = 'claude-settings.json';

// permissions.allow: Read of Claude Code's own temp output files (<temp>\claude\<project>\<session>\tasks\*: the output
// of subagents / background commands). They lie outside the work folder, so every read asked for permission, and an
// unattended routed session stopped there for hours (bug 2026-11-04; why an allow rule and not a PMO-pressable
// verdict: docs/plan-dashboard.md "許可の確認が「ユーザーへの質問」と判定された件"). Read only (no Edit / Write), tasks/ only.
// Claude Code shows the path as /c/Users/USERNA~1/… (the 8.3 form of %TEMP%), so both that and the long form are
// listed. Rule syntax: //<path> = absolute path.
function tempReadRules(tmp = os.tmpdir()) {
  return TEMP_FORMS(tmp).map((p) => `Read(/${p}/claude/*/*/tasks/**)`);
}
// TEMP / TMP of a tab's claude in the long form (env copy, changed in place). Claude Code builds its temp paths from
// %TEMP%, which is often the 8.3 form (C:\Users\USERNA~1\…), and it asks for every read of an 8.3 path by hand
// ("suspicious Windows path pattern"), even with an allow rule that matches. Long form = the rule above applies.
function longTempEnv(env) {
  for (const k of Object.keys(env)) {
    if (!/^(TEMP|TMP)$/i.test(k) || !/~/.test(String(env[k]))) continue;
    try {
      env[k] = fs.realpathSync.native(env[k]);
    } catch {}
  }
  return env;
}
// SEC5 (src/main/pretool-guard.js, docs/security.md): every claude the app starts (folder tabs,
// routed sessions, the PMO, temp windows) gets
//   permissions.deny  globs for command lines endpoint security (EDR) products judges as malware. These work under the managed policy.
//   hooks.PreToolUse  node <pretool-guard.js> (the precise check with a reason). Ignored on a PC whose managed settings
//                     have allowManagedHooksOnly; kept for when that is lifted.
// PROGRESS 4: the tools of the app's own MCP server (src/main/mcp-server.js) need no permission dialog (an unattended
// session would stop at the first notify). Only these names; the server answers each tab with its own token.
const MCP_ALLOW = ['mcp__bantodesk__notify'];

// UX9 (docs/ux-journey.md §4 A): permissions decided at the start, so an unattended session does not stop at a
// permission dialog. Two more settings files next to the base one, by the kind of claude:
//   routed   a session the app started for a routed item (claude.delegate): reads and edits in its work folder (cwd)
//            and Claude Code's temp folders, reads under the home folder except the secret stores, and a fixed list of
//            commands (git incl. push, file tools, node <file>, npm run / test). User QA (UX9 #2): deleting, git push and
//            the outside of the folder need no confirmation; only kernel / malware-like moves do.
//   manager  the PMO's resident session: reads and edits in the manager folder (cwd, with outbox/), reads under the home
//            folder except the secret stores (the projects' PROGRESS.md / docs), read-only commands.
// Claude Code checks deny, then ask, then allow (the first match wins), and the PreToolUse hook runs before them, so the
// SEC5 deny rules and the hook stay above every allow here. The ask rules below put the shapes that used to ask (and
// that the PMO never presses for: inline code, heredocs, find -exec, the secret stores, force push, .git) back to a
// dialog even when an allow rule would match them. Nothing denied by SEC5 is allowed: tmp/nonstop/unit.js checks that
// no allow rule is a deny rule and that the deny list is the SEC5 one unchanged.
// Rule syntax: ./x = the cwd (the work folder), ~/x = the home folder, //x = an absolute path.
const bashRules = (...cmds) => cmds.flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]);
// Commands a routed session runs without a dialog. Each is matched per subcommand (a pipe / && / ; starts a new one).
const ROUTED_BASH = [
  ...['status', 'diff', 'log', 'show', 'add', 'commit', 'restore', 'branch', 'rev-parse', 'ls-files', 'grep', 'stash', 'mv', 'rm', 'fetch', 'pull', 'push', 'switch', 'checkout', 'merge', 'blame', 'describe', 'tag', 'worktree list'].map((c) => `git ${c}`),
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'diff', 'sort', 'uniq', 'cut', 'tr', 'jq', 'file', 'stat', 'du', 'pwd', 'echo',
  'printf', 'date', 'which', 'basename', 'dirname', 'realpath', 'sed -n', 'test', 'true', 'sleep', 'cd', 'mkdir', 'touch', 'cp', 'mv', 'rm',
  'node', 'npm test', 'npm run', 'npm ls', 'timeout * node', 'timeout * npm run', 'timeout * npm test',
];
// The PMO: read-only commands (it edits nothing outside the manager folder, manager.js "他のフォルダのファイルを自分で編集しない").
const MANAGER_BASH = [
  ...['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'branch', 'blame'].map((c) => `git ${c}`), 'git -C * status', 'git -C * log', 'git -C * diff', 'git -C * show',
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'diff', 'sort', 'jq', 'stat', 'pwd', 'date', 'sed -n', 'cd', 'sleep',
];
// Secret stores (CLAUDE.md: no reading of credentials) and the user's stable app data (CLAUDE.md: never touched): a read
// there asks even though ~/** is allowed.
const SECRET_PATHS = [
  '~/.ssh/**', '~/.aws/**', '~/.gnupg/**', '~/.config/gh/**', '~/.netrc', '~/.npmrc', '~/.docker/**', '~/.kube/**', '~/.claude/.credentials.json',
  '~/Library/Keychains/**', '~/Library/Cookies/**', '~/Library/Application Support/Google/**', '~/Library/Application Support/Firefox/**',
  '~/Library/Application Support/Microsoft Edge/**', '~/Library/Application Support/bantodesk/**', '~/Library/Application Support/bantodesk-dev/**',
  '~/Library/Application Support/agent-terminal/**', // BN3 compat: the former userData
  '~/AppData/Roaming/Microsoft/**', '~/AppData/Local/Microsoft/**', '~/AppData/Local/Google/**', '~/AppData/Roaming/Mozilla/**', '~/AppData/Roaming/bantodesk/**', '~/AppData/Roaming/bantodesk-dev/**',
  '~/AppData/Roaming/agent-terminal/**', // BN3 compat: the former userData
  './**/.env', './**/.env.*',
];
// Shapes that ask even when an allow rule above matches (ask is checked before allow).
const ASK_BASH = [
  // code handed to an interpreter inline / on stdin (SEC5: write it to a file and run node <file>)
  '*<<*', 'node -e*', 'node *-e *', 'node --eval*', 'node *--eval*', 'node -p*', 'node *-p *', 'node --print*', 'node *--print*', 'node --input-type*', 'node -',
  // find running a command
  'find * -exec*', 'find * -execdir*', 'find * -ok *', 'find * -okdir *',
  // the whole home / root, and the repository itself (.git/index.lock is never removed by hand)
  'rm -rf /', 'rm -rf ~', 'rm -rf ~/', 'rm -fr /', 'rm -fr ~', 'rm -fr ~/', 'rm -rf /*', 'rm -fr /*', 'rm -rf ~/*', 'rm -fr ~/*', 'rm *.git', 'rm *.git/*', 'rm *index.lock*',
  // a push that rewrites or deletes the remote's history
  'git push *--force*', 'git push *-f', 'git push *-f *', 'git push -f*', 'git push *--delete*', 'git push *--mirror*', 'git push * :*',
  // AT-135: making a repository, changing who can see it, and pointing the work
  // folder at another remote need the user. Ask, not the SEC5 deny:
  // the OSS release uses gh repo create --public with the user's OK. stuck.js REPO_RE keeps the
  // PMO from pressing these dialogs.
  ...REPO_ASK_BASH(),
];
// gh repo create / edit (--visibility) / delete / rename / archive / fork, gh api calls that write (-X / --method other
// than GET, or fields, which make gh send a POST), git remote add / set-url / rename / remove, remote.* in git config,
// and pushes that copy everything, set an upstream or go to a URL. Matched per subcommand and case-sensitively.
function REPO_ASK_BASH() {
  const gh = ['create', 'edit', 'delete', 'rename', 'archive', 'unarchive', 'fork'].flatMap((c) => [`gh repo ${c}*`, `gh * repo ${c}*`]);
  const methods = ['POST', 'PATCH', 'PUT', 'DELETE', 'post', 'patch', 'put', 'delete'];
  const api = [
    ...methods.flatMap((m) => [`gh api *-X ${m}*`, `gh api *-X${m}*`, `gh api *--method ${m}*`, `gh api *--method=${m}*`]),
    ...['-f', '-F', '--field', '--raw-field', '--input'].flatMap((f) => [`gh api * ${f} *`, `gh api * ${f}=*`]),
  ];
  const remote = ['add', 'set-url', 'rename', 'remove', 'rm'].flatMap((c) => [`git remote ${c}*`, `git -C * remote ${c}*`]);
  const push = ['git push *--all*', 'git push -u*', 'git push * -u*', 'git push *--set-upstream*', 'git push *://*', 'git push *git@*', 'git -C * push *'];
  return [...gh, ...api, ...remote, 'git config *remote.*', 'git -C * config *remote.*', ...push];
}
function TEMP_FORMS(tmp = os.tmpdir()) {
  const forms = new Set([tmp]);
  try {
    forms.add(fs.realpathSync.native(tmp));
  } catch {}
  return [...forms].map((f) => f.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`)).filter((p) => p.startsWith('/'));
}
// Claude Code's own temp folders (scratchpad, task output): <tmp>/claude/** on Windows, /tmp/claude-<uid>/** on macOS.
function claudeTempRules(tool, tmp) {
  const out = TEMP_FORMS(tmp).map((p) => `${tool}(/${p}/claude/**)`);
  if (process.platform !== 'win32') out.push(`${tool}(//tmp/claude-*/**)`, `${tool}(//private/tmp/claude-*/**)`);
  return out;
}
// The ask rules every kind but the PMO carries (the PMO edits nothing outside its folder, so no Edit asks there).
const askRules = () => [...SECRET_PATHS.map((p) => `Read(${p})`), ...SECRET_PATHS.map((p) => `Edit(${p})`), ...ASK_BASH.map((p) => `Bash(${p})`)];
function roleRules(kind, tmp) {
  if (kind === 'routed') {
    return {
      allow: ['Read(./**)', 'Edit(./**)', 'Read(~/**)', ...claudeTempRules('Read', tmp), ...claudeTempRules('Edit', tmp), 'Edit(~/.claude/projects/*/memory/**)', 'WebSearch', ...bashRules(...ROUTED_BASH)],
      ask: askRules(),
    };
  }
  if (kind === 'manager') {
    return {
      allow: ['Read(./**)', 'Edit(./**)', 'Read(~/**)', ...claudeTempRules('Read', tmp), ...bashRules(...MANAGER_BASH)],
      ask: [...SECRET_PATHS.map((p) => `Read(${p})`), ...ASK_BASH.map((p) => `Bash(${p})`)],
    };
  }
  // base (folder tabs opened by hand, temp windows): no allow rules (a dialog as before), but the same ask rules as a
  // routed session. 依頼-171 (案 A): the app passes no --permission-mode, so the user's defaultMode (e.g. auto)
  // decides; under auto a shape with no rule is decided by the auto classifier and runs, so without these asks a tab
  // read ./.env, ran find -exec or force-pushed with no dialog (the maintainers' test notes, the auto section). auto stays
  // the user's choice; the SEC5 deny rules stay above these.
  return { allow: [], ask: askRules() };
}
const SETTINGS_KINDS = ['base', 'routed', 'manager'];
const settingsName = (kind) => (kind === 'base' || !kind ? SETTINGS_NAME : `claude-settings-${kind}.json`);

// kind: 'base' (folder tabs opened by hand, temp windows), 'routed', 'manager' (roleRules above).
function claudeSettings(tmp, kind = 'base') {
  const r = roleRules(kind, tmp);
  const deny = guard.denyRules();
  // an allow rule that is also a SEC5 deny rule is dropped (e.g. Bash(node) alone: SEC5 denies code piped into it)
  const denied = new Set(deny);
  const permissions = { allow: [...tempReadRules(tmp), ...MCP_ALLOW, ...r.allow].filter((a) => !denied.has(a)), deny };
  // likewise an ask rule that is a deny rule (deny is checked first, so it never asks; e.g. Bash(node -))
  const ask = r.ask.filter((a) => !denied.has(a));
  if (ask.length) permissions.ask = ask;
  return { ...CLAUDE_SETTINGS, permissions, hooks: guard.hookSettings() };
}

// Writes <dir>/claude-settings.json (or claude-settings-<kind>.json). Returns its path, or null when it could not be written.
function writeClaudeSettings(dir, kind = 'base') {
  const file = path.join(dir, settingsName(kind));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(claudeSettings(undefined, kind), null, 1));
    return file;
  } catch (err) {
    console.warn('[claude-cmd] settings file not written', err);
    return null;
  }
}
// All three -> { base, routed, manager } (paths or null).
function writeAllClaudeSettings(dir) {
  return Object.fromEntries(SETTINGS_KINDS.map((k) => [k, writeClaudeSettings(dir, k)]));
}

// PowerShell single-quoted string literal. Inside '...' only quote characters are special;
// PowerShell also treats the typographic quotes U+2018/U+2019/U+201A/U+201B as single quotes, so
// every one of them is doubled.
function psQuote(s) {
  return `'${String(s).replace(/['‘’‚‛]/g, (c) => c + c)}'`;
}

// Only PowerShell understands the quoting above; another AGENT_TERMINAL_SHELL gets no --settings / prompt.
function isPowerShell(shellExe) {
  return /^(powershell|pwsh)(\.exe)?$/i.test(path.basename(String(shellExe || '')));
}

// Passed with --append-system-prompt to the claude of every folder tab (not the manager / temp windows):
// the folder's progress file (src/main/progress.js, CONTRACT.md "Progress file"). Kept to one line without double
// quotes so AGENT_TERMINAL_SHELL=PowerShell (whose 5.1 native-argument quoting breaks on them) and the cmd.exe fallback
// (cmdArg) pass it unchanged too.
const PROGRESS_PROMPT = [
  'このフォルダの作業の進み具合は、フォルダ直下の PROGRESS.md に Markdown の表 | # | 項目 | 状態 | 次の一手 | 更新日 | で残す（状態は 未着手 / 進行中 / 確認待ち / 完了 / 保留 のどれか、更新日は YYYY-MM-DD）。',
  '項目に着手したとき・終えたとき・ユーザーの確認待ちになったときなど区切りで更新する。',
  'ファイルがなく、ユーザーの作業が複数の項目に分かれるときは作る（1 回で終わる小さな作業では作らない）。',
].join(' ');

// Passed with --append-system-prompt to every claude the app starts (manager and temp windows too), first: what to do
// when a SEC5 deny rule (claudeSettings) stops a command. A permissions.deny refusal carries no reason, so the fixes are
// here. One line without double quotes (same reason as PROGRESS_PROMPT). It goes on claude.exe's command line, so it
// names no command, no interpreter flag and no process-start function (EDR products read command lines).
const GUARD_PROMPT = [
  'シェルのツールのコマンドが permission の deny や SEC5 のフックで止められたら、それはエンドポイントの監視（EDR）にマルウェアと判定される形を止める守り（docs/security.md）。',
  '守りを外したり、言い換え・分割・別のツールで迂回したりせず、書き直す: インタプリタにコードを直に渡す形（コマンド行の引数や heredoc に書いたコード）はやめ、コードをファイルに書いてから node <ファイル> で動かす。',
  'ファイルの中でも、疑われやすいコマンド名は分けて組み立てる。コミットのメッセージにそれらの名前が入るときは、メッセージをファイルに書いて git commit -F <ファイル> を使う。',
  'エンコードした実行・取ってきてそのまま実行・その場のコンパイル・ネットワークやプロセスの調べ回りは、そもそも行わない。書き直しても要るときは、ユーザーに理由を書いて聞く。',
].join(' ');

// Appended (after PROGRESS_PROMPT) for a session the app started for a routed inbox / backlog item (tab.forBacklog,
// setting on): nudges it to split parallel work over subagents / Agent Teams. The wording lives in
// docs/prompts/routed-session.md (its ```text block), read at every start; this is used when that file is missing.
const ROUTED_PROMPT_FALLBACK = [
  'このセッションは、依頼やバックログから振り分けられた作業を、ユーザーが画面を見ていない状態で進めている。',
  '並行できる作業（調べもの、複数ファイルの読み取り、差分のレビュー、動作確認、独立した小さな実装）は、Agent ツールのサブエージェントや Agent Teams のチームメンバーに分担して並行に進める。',
  '1 回で終わる小さな作業は分けずに自分でやる。開発サーバーや Electron を起動するときは、ポートと user-data-dir をエージェントごとに分ける。',
  // docs/plan-backlog-sched.md "同じフォルダで並列に動くときのコミット"
  '同じフォルダで別の作業が並列に動いていることがある。コミットは自分が触ったファイルだけを git commit -m <メッセージ> -- <ファイル> で入れ、新しいファイルは先に git add -N -- <ファイル> する。パスなしの git commit、git commit -a、git add . / -A は使わない。',
  'index.lock や cannot lock ref のエラー、新しいファイルの pathspec did not match が出たら、少し待って add からやり直す。.git/index.lock は消さない。',
  // PROGRESS 40: no endless waits
  '長いコマンドや外部の処理には必ず打ち切り時間を付ける。バックグラウンドで待つときは、何を何分くらい待つ見込みかを返答に書く。待っている相手が止まったと思ったら、待ち続けずに出力とプロセスを確かめる。チームの担当に完了の通知を待つだけの役をさせない。',
  // UX9: no questions to the user, the hypotheses in the last reply, the permissions decided at the start, SEC5 in short
  'ユーザーへの質問（AskUserQuestion）は使わない。指示文の事前の QA の回答（空欄は仮説どおり）、リポジトリの決まり、いまのコードから仮説を立てて進め、最後の返答に 仮説で決めたこと（何を・なぜ・違ったときの直し方）と 事後の確認 を書く。',
  '本当に決められないもの（目的が分からない、取り返しがつかない、費用がかかる）だけは、決められる部分を済ませてから、propose で依頼に出すか 作業中断: <理由> で返す。',
  '許可は起動のときに決めてある: 作業フォルダの中の読み取り・編集、git（push を含む）、ファイルの道具、node <ファイル>、npm run / test は確認なしで動く。',
  'SEC5 の要点: コードはファイルに書いて node <ファイル> で動かす（コマンド行の引数や heredoc に書かない）。禁止のコマンド名は分けて組み立てる。コミットのメッセージに禁止の名前が入るときは git commit -F <ファイル>。',
  // UIUX U7: the next work goes to the inbox (src/main/propose.js, docs/prompts/routed-session.md)
  '指示文の範囲が終わったら、続きの作業を自分で始めない（同じセッションで続けると重くなる）。指示文の範囲の中の小さな直し（テストの直し、書き漏れ）は、今のセッションで済ませてよい。',
  '範囲の外の作業や、大きな作業（1 時間を超える、ほかのファイル群に広がる）が次に要ると分かったら、次にやること（propose）として依頼に出す。迷ったら出す。出した後は、今の作業を区切りよく終えて 作業完了 で終える。',
  '出し方: 作業フォルダの直下の .bantodesk/outbox/ に、名前が .json で終わるファイルを 1 つ書く（例 .bantodesk/outbox/propose-1.json。.bantodesk は git に入らない）。中身は JSON のオブジェクト 1 つか、その配列（一度に 5 件まで）。欄は type（propose と書く）、title（20 字程度の見出し）、text（新しいセッションがそれだけで作業できる指示文: 目的、背景、やること、完了の条件、確かめ方）、reason（なぜ次に要るか）、from（この作業の id。指示文の末尾の この作業の id）、任意で kind（research / implement / verify）、touches（変えるファイル・フォルダの相対パスの配列）、after（先に終わっている必要がある作業の id の配列）。',
  'アプリが数秒で読み取り、.bantodesk/outbox/done/ に移して結果を <名前>.result.json に置く。不正なものは failed/ に移り、理由が <名前>.error.txt に残るので、直して書き直す。出した項目は依頼に入り、PMO が目的と重複を見て振り分ける。自分で振り分けたり、出した作業を自分で始めたりしない。',
  // the app reads this mark to judge the routed item done / stopped
  '作業をすべて終えたら、最後の返答の末尾に 作業完了 の 1 行だけを書く。途中で止める場合は 作業中断: <理由> と書く。サブエージェントやチームメンバー、バックグラウンドのコマンドの結果を待つ間は書かない（この印でアプリが完了を判定する）。',
].join('\n');

// The ```text block of a routed-session.md file (trimmed), or the fallback when the file / block is missing or empty.
function routedPrompt(file) {
  try {
    const m = /```text\r?\n([\s\S]*?)\r?\n```/.exec(fs.readFileSync(file, 'utf8'));
    const t = m && m[1].trim();
    if (t) return t.slice(0, 4000);
  } catch {}
  return ROUTED_PROMPT_FALLBACK;
}

// id / worktree must already be validated (UUID, WORKTREE_RE). Returns the argv after "claude".
// Used as-is for the direct start: node-pty joins it with the CommandLineToArgvW rules (quotes, backslashes),
// so Japanese, quotes and line breaks reach claude unchanged.
// model / effort (AT-6, src/main/models.js): --model / --effort on every start, --resume too; only valid values.
// mcpConfigPath (PROGRESS 4, src/main/mcp-server.js): the tab's --mcp-config file (the app's localhost MCP server).
function buildClaudeArgs({ mode, id, worktree, team, settingsPath, mcpConfigPath, appendPrompt, model, effort }) {
  const a = [];
  if (settingsPath) a.push('--settings', settingsPath);
  if (mcpConfigPath) a.push('--mcp-config', mcpConfigPath);
  if (appendPrompt) a.push('--append-system-prompt', String(appendPrompt));
  if (models.isModel(model)) a.push('--model', model);
  if (models.isEffort(effort)) a.push('--effort', effort);
  if (mode === 'resume') a.push('--resume', id);
  else {
    a.push('--session-id', id);
    if (worktree) a.push('--worktree', worktree);
  }
  if (team) a.push('--teammate-mode', 'in-process');
  return a;
}

// PowerShell command line (AGENT_TERMINAL_SHELL only). appendPrompt loses line breaks and double quotes here:
// PowerShell 5.1 re-quotes native arguments and would split the text at an embedded ".
function buildClaudeCmd(o) {
  const a = buildClaudeArgs({ ...o, appendPrompt: o.appendPrompt ? String(o.appendPrompt).replace(/[\r\n"]+/g, ' ') : null });
  // --model: an alias like opus[1m] would be a glob in sh / zsh (single quotes mean the same in sh and PowerShell)
  const quoted = new Set(['--settings', '--mcp-config', '--append-system-prompt', '--model']);
  return ['claude', ...a.map((v, i) => (quoted.has(a[i - 1]) ? psQuote(v) : v))].join(' ');
}

// Windows env lookup by any case (a copied env object is case-sensitive, process.env is not).
function envGet(env, key) {
  const k = Object.keys(env || {}).find((n) => n.toUpperCase() === key);
  return k === undefined ? undefined : env[k];
}

// First <dir>\<name><ext> over PATH dirs in order and PATHEXT extensions in order (as cmd.exe resolves a
// command, minus the current directory). Returns the full path or null. onlyExts: look for these extensions only.
// A found path is remembered (docs/perf.md 第 3 段, 案 7): the walk over PATH x PATHEXT with a sync stat each took
// 80-240 ms of main at a tab restore (once per tab). The next call with the same name / PATH / extensions checks the
// remembered file with one stat (gone -> walk again); kept 5 min, so a claude put earlier on PATH is found after that.
// Not found (null) is not remembered: a claude installed meanwhile is found at the next start.
const FOUND_TTL_MS = 5 * 60 * 1000;
const found = new Map(); // key -> { file, at }
function remembered(key, walk) {
  const hit = found.get(key);
  if (hit && Date.now() - hit.at < FOUND_TTL_MS) {
    try {
      if (fs.statSync(hit.file).isFile()) return hit.file;
    } catch {}
  }
  found.delete(key);
  const file = walk();
  if (file) {
    found.set(key, { file, at: Date.now() });
    while (found.size > 32) found.delete(found.keys().next().value);
  }
  return file;
}
function findOnPath(name, env = process.env, onlyExts = null) {
  const key = ['win', name, envGet(env, 'PATH') || '', onlyExts ? onlyExts.join(';') : envGet(env, 'PATHEXT') || ''].join('\0');
  return remembered(key, () => walkPath(name, env, onlyExts));
}
function walkPath(name, env, onlyExts) {
  const exts = onlyExts || String(envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim()).filter(Boolean);
  for (const raw of String(envGet(env, 'PATH') || '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const f = path.join(dir, name + ext.toLowerCase());
      try {
        if (fs.statSync(f).isFile()) return f;
      } catch {}
    }
  }
  return null;
}

// Splits one cmd.exe line into tokens ("quoted" or bare; quotes removed). Only the part after the last & / | outside
// quotes is kept (npm's cmd-shim ends with `endLocal & goto … || title %COMSPEC% & "%_prog%" "<js>" %*`).
function shimTokens(line) {
  let toks = [];
  let cur = null;
  let q = false;
  for (const ch of line) {
    if (ch === '"') {
      q = !q;
      cur = cur ?? '';
    } else if (!q && (ch === '&' || ch === '|')) {
      toks = [];
      cur = null;
    } else if (!q && /\s/.test(ch)) {
      if (cur !== null) toks.push(cur);
      cur = null;
    } else cur = (cur ?? '') + ch;
  }
  if (cur !== null) toks.push(cur);
  if (toks[0]) toks[0] = toks[0].replace(/^@/, '');
  return q ? null : toks.filter((t) => t !== '');
}

// What a .cmd / .bat shim of claude runs, so the app can start it itself without a shell (SEC4c):
//   "<dir>\x.exe" %*                     → { file: x.exe, pre: [] }
//   node | "%_prog%" | "<node.exe>"  "<script.js>" %*   (npm's cmd-shim, a hand-written `@node "<js>" %*`)
//                                        → { file: node.exe, pre: [script.js] }
// Only the last line that ends with %* is read; %~dp0 / %dp0% become the shim's folder. Any other shape (another
// variable, more arguments, a file that does not exist) → null, and the app falls back to cmd.exe.
function shimTarget(shim, env = process.env) {
  let text;
  try {
    if (fs.statSync(shim).size > 64 * 1024) return null;
    text = fs.readFileSync(shim, 'utf8');
  } catch {
    return null;
  }
  const dir = path.dirname(shim);
  const line = text.split(/\r?\n/).map((l) => l.trim()).reverse().find((l) => /%\*$/.test(l));
  const toks = line && shimTokens(line);
  if (!toks || toks.pop() !== '%*') return null;
  const expand = (t) => t.replace(/%~dp0|%dp0%/gi, dir + path.sep);
  const isFile = (f) => {
    try {
      return path.isAbsolute(f) && fs.statSync(f).isFile();
    } catch {
      return false;
    }
  };
  if (toks.length === 1) {
    const exe = path.normalize(expand(toks[0]));
    return !exe.includes('%') && /\.exe$/i.test(exe) && isFile(exe) ? { file: exe, pre: [] } : null;
  }
  if (toks.length !== 2) return null;
  const script = path.normalize(expand(toks[1]));
  if (script.includes('%') || !/\.(c|m)?js$/i.test(script) || !isFile(script)) return null;
  const prog = toks[0];
  const local = path.join(dir, 'node.exe');
  let node = null;
  if (/^%_prog%$/i.test(prog)) node = isFile(local) ? local : findOnPath('node', env, ['.exe']);
  else if (/^node(\.exe)?$/i.test(prog)) node = findOnPath('node', env, ['.exe']);
  else {
    const p = path.normalize(expand(prog));
    if (!p.includes('%') && /(^|[\\/])node\.exe$/i.test(p) && isFile(p)) node = p;
  }
  return node ? { file: node, pre: [script] } : null;
}

// One argument of the cmd.exe fallback: quoted; line breaks, " and % become spaces (a batch argument cannot carry them:
// a line break ends the command, a " ends the quoting so & | < > would run as cmd operators, and cmd expands %VAR% even
// inside quotes). Trailing backslashes are doubled so the closing quote stays a quote for the program behind the shim.
function cmdArg(v) {
  return `"${String(v).replace(/[\r\n"%]+/g, ' ').replace(/(\\+)$/, '$1$1')}"`;
}

// How to start a tab's claude → { kind, file, args } for pty.spawn (args: array, or a raw command-line string).
//   shell     AGENT_TERMINAL_SHELL is set: <shell> -NoLogo -NoExit -Command "claude …" (the old way; the shell stays
//             after claude exits). --settings / --append-system-prompt only when it is powershell / pwsh.
//   override  AGENT_TERMINAL_CMD (tests) with no shell set: cmd.exe /d /s /c "<override>" (exits with the command).
//   direct    claude resolves to an .exe on PATH: claude.exe <args>, no shell (default).
//   shim      claude resolves to a .cmd / .bat shim of a known shape (npm install, shimTarget): the program behind it
//             (node.exe <cli.js> <args>, or the .exe) started directly, no shell. Arguments arrive unchanged.
//   fallback  claude is not found, or is a shim of another shape: %ComSpec% /d /v:off /s /c ""<shim>" <args>" (exits
//             with claude). Arguments go through cmdArg (line breaks, " and % become spaces).
// No kind starts PowerShell unless AGENT_TERMINAL_SHELL asks for it (SEC4c, docs/security.md:
// the old fallback was powershell.exe -Command, a script engine endpoint security (EDR) products watches).
// claude: { mode, id, worktree, team, settingsPath, appendPrompt } (validated).
function launchSpec({ shell, override, claude, env = process.env, platform = process.platform }) {
  if (platform !== 'win32') return posixLaunchSpec({ shell, override, claude, env });
  const legacy = (kind, sh) => {
    const ps = isPowerShell(sh);
    const cmd = override ?? buildClaudeCmd({ ...claude, settingsPath: ps ? claude.settingsPath : null, mcpConfigPath: ps ? claude.mcpConfigPath : null, appendPrompt: ps ? claude.appendPrompt : null });
    return { kind, file: sh, args: ['-NoLogo', '-NoExit', '-Command', cmd] };
  };
  if (shell) return legacy('shell', shell);
  if (override != null) {
    // raw string: node-pty would otherwise escape the override's own quotes as \" (which cmd.exe does not understand)
    return { kind: 'override', file: envGet(env, 'COMSPEC') || 'cmd.exe', args: `/d /s /c "${override}"` };
  }
  const exe = findOnPath('claude', env);
  if (exe && /\.exe$/i.test(exe)) return { kind: 'direct', file: exe, args: buildClaudeArgs(claude) };
  const target = exe && /\.(cmd|bat)$/i.test(exe) ? shimTarget(exe, env) : null;
  if (target) return { kind: 'shim', file: target.file, args: [...target.pre, ...buildClaudeArgs(claude)] };
  const head = exe && /\.(cmd|bat)$/i.test(exe) ? cmdArg(exe) : 'claude';
  const args = [head, ...buildClaudeArgs(claude).map(cmdArg)].join(' ');
  // raw string, as for override: node-pty would escape the quotes as \" (which cmd.exe does not understand)
  return { kind: 'fallback', file: envGet(env, 'COMSPEC') || 'cmd.exe', args: `/d /v:off /s /c "${args}"` };
}

// macOS / Linux: the claude binary on PATH (':'-separated, executable bit), else the usual install folders, since an
// app started from Finder / the Dock gets launchd's short PATH (/usr/bin:/bin:/usr/sbin:/sbin) without ~/.local/bin.
// Started directly under the pty with an argument array (node-pty on unix does not take a raw command-line string).
const POSIX_CLAUDE_DIRS = ['.local/bin', '.claude/local', '.npm-global/bin', '.bun/bin'];
function findOnPosixPath(name, env = process.env) {
  return remembered(['posix', name, env.PATH || '', env.HOME || ''].join('\0'), () => walkPosixPath(name, env));
}
function walkPosixPath(name, env) {
  const home = env.HOME || '';
  const dirs = [
    ...String(env.PATH || '').split(':'),
    ...POSIX_CLAUDE_DIRS.map((d) => (home ? path.join(home, d) : '')),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const f = path.join(dir, name);
    try {
      if (fs.statSync(f).isFile()) {
        fs.accessSync(f, fs.constants.X_OK);
        return f;
      }
    } catch {}
  }
  return null;
}
function posixLaunchSpec({ shell, override, claude, env }) {
  if (shell) {
    const cmd = override ?? buildClaudeCmd({ ...claude, settingsPath: null, mcpConfigPath: null, appendPrompt: null });
    return { kind: 'shell', file: shell, args: ['-l', '-i', '-c', cmd] };
  }
  if (override != null) return { kind: 'override', file: '/bin/sh', args: ['-c', String(override)] };
  const exe = findOnPosixPath('claude', env);
  // not found: still 'claude' (node-pty reports the failure in the tab, as the Windows fallback does when cmd.exe cannot find it)
  return { kind: exe ? 'direct' : 'fallback', file: exe || 'claude', args: buildClaudeArgs(claude) };
}

module.exports = { ROUTED_BASH, MANAGER_BASH, SECRET_PATHS, ASK_BASH, SETTINGS_KINDS, settingsName, roleRules, writeAllClaudeSettings, MCP_ALLOW, findOnPosixPath, CLAUDE_SETTINGS, SETTINGS_NAME, tempReadRules, claudeSettings, longTempEnv, GUARD_PROMPT, PROGRESS_PROMPT, ROUTED_PROMPT_FALLBACK, routedPrompt, writeClaudeSettings, psQuote, isPowerShell, buildClaudeArgs, buildClaudeCmd, findOnPath, shimTokens, shimTarget, cmdArg, launchSpec };
