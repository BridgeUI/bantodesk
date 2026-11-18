// SEC5 (docs/security.md): stops command lines that endpoint security (EDR) products judges as malware
// (e.g. a node -e argument with a process-start call next to a command name) BEFORE they run.
// No Electron imports. Three uses, one rule list:
//   1. Claude Code PreToolUse hook (node <this file>): reads the hook JSON on stdin, prints a deny decision with a
//      reason the agent can act on. Registered in <userData>\claude-settings.json (claude-cmd.js). NOTE: on a PC whose
//      managed settings have allowManagedHooksOnly, Claude Code ignores hooks from --settings / user settings.
//   2. denyRules(): permissions.deny globs for the same settings file. These DO apply under that policy. Coarser than
//      the hook (a glob cannot say "A and B in any order"): when in doubt they block (SEC5 QA 2).
//   3. check() from stuck.js: the ルーター never presses Yes on a permission dialog whose command this denies (a Bash
//      heredoc is not matched by deny rules, it asks for approval instead).
//
// Command names and process-start names are built from pieces (J) so that this file, and any command line that
// shows it, never holds them whole next to each other (CLAUDE.md "マルウェアと判定される動きをしない").
'use strict';

const J = (...p) => p.join('');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- words ----------------------------------------------------------------------------------------------------------
const PS_TOOL = J('Power', 'Shell'); // the Claude Code tool name
const PS = [J('power', 'shell'), J('pw', 'sh')];
// CLAUDE.md "マルウェアと判定される動きをしない": names never to put next to process-start code
const NAMES = [
  J('net', 'stat'), ...PS, J('task', 'list'), J('wm', 'ic'), J('cm', 'd'), J('cs', 'c'),
  J('rund', 'll32'), J('regs', 'vr32'), J('msh', 'ta'), J('cert', 'util'), J('bits', 'admin'),
];
// process-start code (exec covers execFile / execSync / execa, spawn covers spawnSync)
const LAUNCHERS = [
  J('ex', 'ec'), J('sp', 'awn'), J('fo', 'rk('), J('child', '_process'), J('Start', '-Process'), J('Invoke', '-Expression'),
  J('Invoke', '-Item'), J('Invoke', '-Command'), J('Start', '-Job'), J('sys', 'tem('), J('Po', 'pen'), J('sub', 'process'),
  J('Shell', 'Execute'), J('Process', '.Start'), J('Diagnostics', '.Process'),
];
const wordRe = (list) => new RegExp(`(?<![\\w-])(?:${list.map(esc).join('|')})(?:\\.exe)?(?![\\w-])`, 'i');
const anyRe = (list) => new RegExp(list.map(esc).join('|'), 'i');
const NAME_RE = wordRe(NAMES);
// exec as a word (exec / execFile / execSync / execa, .exec( ): not "ExecutionPolicy" / "executable"
const LAUNCH_RE = new RegExp([`\\b${J('ex', 'ec')}(?:File|Sync|FileSync|a)?\\b`, ...LAUNCHERS.slice(1).map(esc)].join('|'), 'i');
const PS_ALT = PS.map(esc).join('|');
const WIN_SHELL = J('cm', 'd');
const CS_COMPILER = J('cs', 'c');
const after = (re, c) => {
  const m = re.exec(c);
  return m ? c.slice(m.index + m[0].length) : null;
};

// ---- inline code (code handed straight to an interpreter on the command line) ---------------------------------------
// Every pattern is linear or quadratic at worst: no repeated group can split the same text two ways (a node regex with
// (\s+--?[\w-]+)*? took seconds on 30 flags; stuck.js runs check() on Electron's main thread).
// ["']? after the name: a quoted path ("C:/Program Files/nodejs/node.exe" -e …).
const SHELL_INLINE = [
  /\b(?:bash|sh|zsh|dash|ksh)(?:\.exe)?["']?(?:\s+-\w+)*?\s+-\w*c(?=[\s"']|$)/,
  new RegExp(`\\b(?:${PS_ALT})(?:\\.exe)?["']?(?=\\s)[^\\n]*?\\s[-/](?:c|co|com|comm|comma|comman|command)(?=[\\s"']|$)`, 'i'),
  new RegExp(`\\b${esc(WIN_SHELL)}(?:\\.exe)?["']?\\s+(?:/\\w\\s+)*/[ck](?!\\w)`, 'i'),
  /(?:^|[;&|(`\s])eval\s/,
];
// a PS start whose code is positional (no -Command: ps -NoProfile "…")
const PS_START = new RegExp(`(?:^|[\\s;&|(\`"'\\\\/])(?:${PS_ALT})(?:\\.exe)?["']?(?=\\s|$)`, 'i');
const INLINE = [
  /\bnode(?:\.exe)?["']?(?=\s)[^\n|;&]*?\s(?:-e|-p|-pe|--eval|--print)(?=[\s"'=]|$)/i,
  /\b(?:python[\d.]*|py)(?:\.exe)?["']?(?=\s)[^\n|;&]*?\s-\w*c(?=[\s"']|$)/i,
  /\b(?:perl|ruby)(?:\.exe)?["']?(?=\s)[^\n|;&]*?\s-\w*e(?=[\s"']|$)/i,
  ...SHELL_INLINE,
  // a heredoc or a pipe that feeds code to an interpreter's stdin
  new RegExp(`\\b(?:node|python[\\d.]*|py|bash|sh|zsh|perl|ruby|${PS_ALT})(?:\\.exe)?\\b[^\\n|]*<<`, 'i'),
  new RegExp(`\\|\\s*(?:\\S*[\\\\/])?(?:node|python[\\d.]*|py|bash|sh|zsh|perl|ruby|${PS_ALT})(?:\\.exe)?\\s*(?:-s?\\s*)?(?:$|[;&|)\\n])`, 'i'),
];
const isInline = (c) => INLINE.some((re) => re.test(c));
// stdin of an interpreter fed by a pipe (curl … | sh): the interpreter reads its code from the pipe
const PIPE_RUN = new RegExp(`\\|\\s*(?:\\S*[\\\\/])?(?:sh|bash|zsh|node|python[\\d.]*|py|iex|${PS_ALT})(?:\\.exe)?\\s*(?:-s?\\s*)?(?:$|[;&|)\\n])`, 'i');
const FETCH = /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer)\b|DownloadString|DownloadData|DownloadFile|Net\.WebClient/i;
const IEX = /(?<![\w-])iex(?![\w-])|Invoke-Expression|ScriptBlock\]::Create|NewScriptBlock|InvokeCommand\b|\.InvokeScript\b|&\s*\(\s*(?:gcm|Get-Command)\b/i;
// search commands: their pattern is data, not a start (grep -- --remote-debugging-port src)
const SEARCH = /^\s*(?:grep|rg|egrep|fgrep|git\s+(?:grep|log|diff|show)|Select-String|findstr|sls)\b/i;

// ---- the rules ------------------------------------------------------------------------------------------------------
const FIX_FILE = 'コードは Write ツールでファイル（スクラッチパッドや tmp/ の下）に書いてから node <ファイル> / python <ファイル> で動かす（シェルの echo・cat > ・heredoc・Set-Content でファイルに書くのも同じくコマンド行に載るので使わない）。';
const FIX_SPLIT = 'ファイルの中でも、禁止のコマンド名の見本は \'net\' + \'stat\' のように分けて組み立てる。';
const TEMP_DIR = String.raw`(?:%te?mp%|\$env:te?mp\b|\$\{?(?:TEMP|TMP|TMPDIR)\b|AppData[\\/]Local[\\/]Temp|LOCALAPPDATA%?[\\/]Temp|os\.tmpdir|(?:^|[\s"'=])/tmp/|Windows[\\/]Temp|[\\/]Downloads[\\/])`;
const RUNNABLE = String.raw`\.(?:dll|exe|scr|sys|ocx|cpl|ps1|psm1|bat|c[m]d|vbs|vbe|wsf|hta)\b`;

const RULES = [
  {
    id: 'inline-launch',
    label: 'インタプリタに直に渡したコードに、プロセスを起動するコードとコマンド名が一緒にある',
    test: (c) => isInline(c) && LAUNCH_RE.test(c) && NAME_RE.test(c),
    fix: `${FIX_FILE}${FIX_SPLIT}正規表現やテストの見本を試すときも同じ。`,
  },
  {
    id: 'shell-inline-name',
    label: 'シェルに直に渡したコードの中でコマンド名を起動している',
    test: (c) => {
      for (const re of SHELL_INLINE) {
        const rest = after(re, c);
        if (rest !== null && NAME_RE.test(rest)) return true;
      }
      const rest = after(PS_START, c);
      return rest !== null && (NAME_RE.test(rest) || LAUNCH_RE.test(rest));
    },
    fix: `シェルを入れ子で起こさない。要る処理は ${FIX_FILE}`,
  },
  {
    id: 'launch-and-name',
    label: 'コマンド行に、プロセスを起動する名前とコマンド名が並んでいる（ファイルへの書き出し・検索の見本も同じ）',
    test: (c) => LAUNCH_RE.test(c) && NAME_RE.test(c),
    fix: `${FIX_FILE}探すときはシェルの grep ではなく Grep ツールを使う。${FIX_SPLIT}`,
  },
  {
    id: 'encoded',
    label: 'エンコードしたコマンド（-EncodedCommand とその略記）',
    test: (c) => new RegExp(`\\b(?:${PS_ALT})(?:\\.exe)?\\b[^\\n]*?\\s[-/]e(?:c|n\\w*)?(?=\\s|$)`, 'i').test(c) || /-EncodedCommand\b/i.test(c),
    fix: 'エンコードしたコマンドは使わない。処理は .ps1 ではなく node <ファイル> で書き直すか、コマンドを平文でそのまま書く。',
  },
  {
    id: 'decode-run',
    label: 'デコードしてから実行する形（base64・文字コードの配列）',
    test: (c) =>
      /FromBase64|b64decode|base64\.decode|base64\s+(?:-d|--decode|-D)\b|\batob\s*\(|['"]base64['"]|fromCharCode|\[char\[\]\]|-join\s*\[char\]/i.test(c) &&
      (IEX.test(c) || /\beval\b|\bFunction\s*\(|Assembly\]::Load|\bexec\s*\(/i.test(c) || PIPE_RUN.test(c) || LAUNCH_RE.test(c)),
    fix: 'デコードしてから実行することはしない。動かしたいコードは平文のままファイルに書き、node <ファイル> で動かす。',
  },
  {
    id: 'iex',
    label: '文字列をコードとして実行する（iex / Invoke-Expression / ScriptBlock::Create など）',
    test: (c) => IEX.test(c),
    fix: '文字列をその場で実行しない。処理はファイルに書いて node <ファイル> で動かす。',
  },
  {
    id: 'fetch-run',
    label: '取ってきてそのまま実行する形（curl / wget … | sh など）',
    test: (c) =>
      (FETCH.test(c) && (PIPE_RUN.test(c) || /(?:^|[;&|\s])(?:sh|bash|zsh|source|\.)\s+\S+\.(?:sh|ps1|py|js|mjs)\b/i.test(c))) ||
      /(?:<\(|\$\(|`)\s*(?:curl|wget)\b/i.test(c),
    fix: '取ってきた中身を実行しない。要るファイルは取ってきて中身を確かめ、ユーザーに確かめてから使う。',
  },
  {
    id: 'compile',
    label: `Add-Type・その場のコンパイル（${CS_COMPILER} など）・アセンブリの読み込み`,
    test: (c) =>
      /Add-Type\b|CSharpCodeProvider|CompileAssemblyFromSource|Assembly\]::Load|\[Reflection\.Assembly\]|AppDomain\]::CurrentDomain\.Load|\b(?:vbc|jsc|ilasm)\.exe\b/i.test(c) ||
      new RegExp(`(?<![\\w-])${esc(CS_COMPILER)}(?:\\.exe)?(?=[\\s"']|$)`, 'i').test(c),
    fix: 'Add-Type やその場のコンパイルはしない（SEC2b）。要るときは作る前にユーザーに聞く（SEC3 のネイティブモジュールの形）。',
  },
  {
    id: 'temp-binary',
    label: '一時フォルダ・ダウンロードフォルダの実行ファイル・DLL・スクリプト',
    test: (c) => new RegExp(`${TEMP_DIR}[^\\s"'|;&]*${RUNNABLE}`, 'i').test(c),
    fix: '一時フォルダに実行ファイル・DLL・.ps1 などを書き出したり、そこから動かしたりしない。スクリプトは node の .js / .mjs にして、作業フォルダの tmp/ の下に置く。',
  },
  {
    id: 'enum',
    label: `ネットワークやプロセスの調べ回り（${[J('net', 'stat'), J('task', 'list'), J('wm', 'ic')].join('・')}・WMI・接続の一覧）`,
    test: (c) =>
      wordRe([J('net', 'stat'), J('task', 'list'), J('wm', 'ic'), 'gwmi', 'gcim', 'tnc', 'nmap']).test(c) ||
      /Get-NetTCPConnection|Get-NetUDPEndpoint|Get-WmiObject|Get-CimInstance|Invoke-CimMethod|Invoke-WmiMethod|Win32_Process\b|GetActiveTcpConnections|GetActiveTcpListeners|IPGlobalProperties|Test-NetConnection/i.test(c),
    fix: 'ポートの空きは 127.0.0.1 に listen を試して確かめる。プロセスは自分の起動した PID・user-data-dir で絞る。',
  },
  {
    id: 'lolbin',
    label: `${[J('rund', 'll32'), J('regs', 'vr32'), J('msh', 'ta'), J('cert', 'util'), J('bits', 'admin')].join('・')} の起動`,
    test: (c) => wordRe([J('rund', 'll32'), J('regs', 'vr32'), J('msh', 'ta'), J('cert', 'util'), J('bits', 'admin')]).test(c),
    fix: 'これらは使わない。ファイルの取得・変換は node <ファイル> で書く。',
  },
  {
    id: 'remote-debug',
    label: 'e2e の印と 127.0.0.1 の無いリモートデバッグ（node --inspect の外向きも）',
    test: (c) => {
      if (SEARCH.test(c)) return false;
      if (/--inspect(?:-brk|-wait)?=(?!(?:127\.0\.0\.1|localhost)(?::|\s|$))(?:\d+\.\d+\.\d+\.\d+|\[|[a-z])/i.test(c)) return true;
      if (!/--remote-debugging-port\b/i.test(c)) return false;
      const addrs = [...c.matchAll(/--remote-debugging-address[= ]["']?([^\s"']+)/gi)].map((m) => m[1]);
      return !(/--agent-terminal-e2e\b/.test(c) && addrs.length > 0 && addrs.every((a) => a === '127.0.0.1'));
    },
    fix: 'リモートデバッグは e2e のテストのときだけ、--remote-debugging-address=127.0.0.1 と --agent-terminal-e2e を一緒に渡す（起動はスクリプトのファイルに書き、コマンド行には書かない）。探すときは Grep ツールを使う。',
  },
  {
    id: 'hidden',
    label: '隠したウィンドウでの起動',
    test: (c) => /-(?:w|wi|win|wind|windo|window|windows|windowst\w*)\s+['"]?(?:h|hi|hid|hidd|hidde|hidden|1)\b/i.test(c) && new RegExp(`\\b(?:${PS_ALT}|Start-Process)\\b`, 'i').test(c),
    fix: '隠したウィンドウでスクリプトを起こさない。',
  },
  {
    id: 'persist',
    label: '自動起動の仕込み（Run キー・スタートアップ・タスク スケジューラ・サービス）',
    test: (c) =>
      /CurrentVersion[\\/]+Run|\bschtasks\b|Register-ScheduledTask|New-ScheduledTask|New-Service|\bsc(?:\.exe)?\s+(?:create|config)\b|Start Menu[\\/]+Programs[\\/]+Startup|shell:startup/i.test(c),
    fix: '自動起動は仕込まない。ユーザーが頼んだときだけ、何をどこに足すかを先に示す。',
  },
  {
    id: 'security-settings',
    label: 'セキュリティの設定の変更（Defender・ファイアウォール・UAC・実行ポリシー）',
    test: (c) =>
      /Set-MpPreference|Add-MpPreference|advfirewall|\bnetsh\s+firewall|New-NetFirewallRule|Set-NetFirewall\w*|Set-ExecutionPolicy|-(?:ExecutionPolicy|ep|ex|exec)\s+['"]?(?:Bypass|Unrestricted)|EnableLUA|ConsentPromptBehavior/i.test(c),
    fix: 'セキュリティの設定は変えない。ファイアウォールの規則は足さない・変えない。',
  },
  {
    id: 'credentials',
    label: '資格情報の読み出し（LSASS・SAM・資格情報マネージャー・ブラウザの保存データ）',
    test: (c) => /\blsass\b|sekurlsa|\bprocdump\b|\breg(?:\.exe)?\s+save\b|\bcmdkey\b|\bvaultcmd\b|Get-StoredCredential|Login Data|Cookies\.sqlite|[\\/]Network[\\/]Cookies/i.test(c),
    fix: '資格情報は読まない。',
  },
];

// git commit / tag messages are prose, not code: a message may name what a fix stops. Only plain messages are taken
// out: "…" without \ $ ` ; & | (an escaped quote could end the message early in one shell and not in the other), '…'.
function stripMessages(c) {
  return c.replace(/(\bgit\b[^\n;&|]*?\s(?:-m|--message)(?:=|\s+))("[^"\\$`;&|]*"|'[^']*')/g, '$1""');
}

// command -> { deny: true, id, label, reason } | { deny: false }
function check(command) {
  const c = stripMessages(String(command || ''));
  // also tried: a dialog wrapping a long command over several lines (breaks taken out), and names split by quotes or
  // escapes (n''etstat, n^etstat)
  const forms = [...new Set([c, c.replace(/\r?\n\s*/g, ''), c.replace(/(?<=\w)(?:''|""|[`^])(?=\w)/g, '')])];
  for (const r of RULES) {
    if (forms.some((f) => r.test(f))) {
      return { deny: true, id: r.id, label: r.label, reason: `SEC5 の守り（docs/security.md）: ${r.label}。直し方: ${r.fix} このフック（守り）は外したり迂回したりしない。` };
    }
  }
  return { deny: false };
}

// hook input (parsed JSON) -> hook output object, or null (no decision: the normal permission flow goes on)
function decide(input) {
  const tool = input && input.tool_name;
  if (tool !== 'Bash' && tool !== PS_TOOL) return null;
  const v = check((input.tool_input || {}).command);
  if (!v.deny) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: v.reason } };
}

// ---- permissions.deny globs -----------------------------------------------------------------------------------------
// Measured on Claude Code 2.1.322 (docs/security.md): Bash rules are matched against each
// subcommand (split at && ; | and line breaks outside quotes), case-sensitively; a heredoc is not matched at all (it
// asks instead). PS-tool rules are matched against the whole command, case-insensitively. * matches line breaks.
// Only letters, digits, space and * . _ : / - = , are used in a pattern (GLOB_OK): some other character made a Bash
// rule match every command (6 章).
const GLOB_OK = /^[A-Za-z0-9 *._:/=,-]+$/;
// Bash spellings: as written, lower, upper, Title-Case per word, and the usual mixed forms
const MIXED = [[PS[0], PS_TOOL], ['executionpolicy', 'ExecutionPolicy'], ['encodedcommand', 'EncodedCommand'], ['windowstyle', 'WindowStyle'], [J('net', 'stat'), J('Net', 'Stat')], ['tcpconnection', 'TCPConnection'], ['wmiobject', 'WmiObject'], ['ciminstance', 'CimInstance']];
const title = (s) => s.toLowerCase().replace(/[a-z]+/g, (w) => w[0].toUpperCase() + w.slice(1));
const mixed = (s) => MIXED.reduce((a, [k, v]) => a.replace(new RegExp(k, 'gi'), v), s);
const caseForms = (s) => [...new Set([s, s.toLowerCase(), s.toUpperCase(), title(s), mixed(title(s)), mixed(s.toLowerCase())])];

function denyGlobs() {
  const g = [];
  const add = (p) => g.push(p);
  // anywhere in a command
  const anywhere = [
    J('net', 'stat'), J('task', 'list'), J('wm', 'ic'), J('rund', 'll32'), J('regs', 'vr32'), J('msh', 'ta'), J('cert', 'util'), J('bits', 'admin'),
    'Get-Net', 'Get-NetTCPConnection', 'Get-NetUDPEndpoint', 'Get-WmiObject', 'Get-CimInstance', 'Invoke-CimMethod', 'Invoke-WmiMethod', 'Win32_Process',
    'GetActiveTcp', 'IPGlobalProperties', 'Test-NetConnection',
    'Add-Type', 'EncodedCommand', 'FromBase64', 'Invoke-Expression', 'ScriptBlock*::Create', 'NewScriptBlock', 'InvokeScript', 'DownloadString', 'DownloadData',
    'CSharpCodeProvider', 'CompileAssemblyFromSource', 'Assembly*::Load', 'CurrentDomain.Load', 'Set-MpPreference', 'Add-MpPreference', 'advfirewall',
    'NetFirewallRule', 'Set-NetFirewall', 'ExecutionPolicy', 'CurrentVersion*Run', 'Programs*Startup', 'schtasks',
    'Register-ScheduledTask', 'New-ScheduledTask', 'New-Service', 'lsass', 'sekurlsa', 'vaultcmd', 'cmdkey', 'WindowStyle*Hidden',
    '--remote-debugging-port', '--inspect=0.0.0.0', 'base64 -d', 'base64 --decode', 'b64decode', 'reg save', 'reg.exe save',
  ];
  for (const w of anywhere) add(`*${w}*`);
  // iex / gwmi / gcim as a command (Bash: a pipe starts a new subcommand)
  for (const w of ['iex', 'gwmi', 'gcim']) for (const p of [`${w}`, `${w} *`, `* ${w} *`, `* ${w}`]) add(p);
  // the C# compiler and the other compilers as a command
  for (const n of [CS_COMPILER, 'vbc', 'jsc']) for (const p of [`${n} *`, `*${n}.exe*`, `* ${n} *`]) add(p);
  // the PS -EncodedCommand abbreviations / -ExecutionPolicy short forms / -WindowStyle Hidden abbreviations
  const psFlags = ['-e', '-ec', '-en', '-enc', '-enco', '-encod', '-encode', '-encoded', '/e', '/ec', '/en', '/enc', '-ex', '-ep', '-w h', '-w hidden', '-win h', '-win hidden', '-w 1'];
  for (const p of PS) for (const f of psFlags) for (const ff of new Set([f, title(f)])) add(`*${p}* ${ff} *`);
  // inline code + a process-start word, a shell name or a fetch (sh -c "$(curl …)")
  // (Bash matches case-sensitively: -Command / -C are listed next to -c. A trailing space after node -e keeps -e2e /
  // --exec out.)
  const inline = [
    'node *-e ', 'node *--eval', 'node *-p ', 'node *-pe ', 'node *--print', 'node.exe -e', 'node.exe* -e',
    'python* -c', 'py -c', 'sh -c', 'sh -lc', 'sh -ic', 'perl *-e', 'ruby *-e', 'eval ',
    ...PS.flatMap((p) => [`${p}* -c`, `${p}* -C`, `${p}* /c`]), `${WIN_SHELL} /c`, `${WIN_SHELL} /C`, `${WIN_SHELL} /k`, `${WIN_SHELL}.exe /c`, `${WIN_SHELL}.exe /C`, `${WIN_SHELL}.exe /k`,
  ];
  const tokens = [...LAUNCHERS.map((t) => t.replace('(', '')).map((t) => (t === J('sys', 'tem') ? J('os.sys', 'tem') : t)), ...PS, WIN_SHELL, CS_COMPILER, 'curl', 'wget'];
  for (const i of inline) for (const t of tokens) add(`*${i}*${t}*`);
  // a process-start word and a shell name on one command line, in either order (echo … > x.js, grep patterns, a
  // positional PS command). The shell names only: the other names are denied anywhere above.
  for (const t of LAUNCHERS.map((x) => x.replace('(', '')).filter((x) => x !== J('sys', 'tem'))) {
    for (const nm of [...PS, `${WIN_SHELL} /`, `${WIN_SHELL}.exe`, CS_COMPILER]) {
      add(`*${t}*${nm}*`);
      add(`*${nm}*${t}*`);
    }
  }
  // fed to an interpreter's stdin (Bash: a pipe ends the subcommand, so the interpreter alone is the subcommand)
  for (const n of ['sh', 'bash', 'zsh', 'node', 'python', 'python3', 'py', 'perl', 'ruby', '/bin/sh', '/bin/bash', '/usr/bin/sh', '/usr/bin/bash', ...PS]) {
    add(n);
    add(`${n} -`);
    add(`${n} -s*`);
  }
  // process substitution: bash <(curl …) has a "(" ; matched as "sh …curl" instead
  for (const p of ['*sh *curl*', '*sh *wget*', '*source *curl*', '*source *wget*']) add(p);
  // PS tool: the whole command is matched, pipes included (written without "|": fetch … then an interpreter at the end)
  for (const f of ['curl', 'wget', 'iwr', 'irm', 'Invoke-WebRequest', 'Invoke-RestMethod']) {
    for (const t of ['sh', 'bash', 'node', 'python', 'iex', ...PS]) {
      add(`*${f}* ${t}`);
      add(`*${f}* ${t} -`);
      add(`*${f}* ${t} -s*`);
    }
  }
  // temp / downloads + something runnable (no backslash, $ or %: Temp covers AppData Local Temp, $env:TEMP, %TEMP%)
  // (not TMP: the PS tool's case-insensitive match would take the work folder's tmp\ for it)
  for (const d of ['Temp', 'TEMP', 'Downloads']) for (const x of ['.dll', '.exe', '.scr', '.ps1', '.bat', '.vbs', '.hta']) add(`*${d}*${x}*`);
  return g;
}

// -> ["Bash(…)", "<PS tool>(…)", …] for permissions.deny. Bash gets the case forms of every pattern (its match is
// case-sensitive); the PS tool's match ignores case.
function denyRules() {
  const out = new Set();
  for (const p of denyGlobs()) {
    if (!GLOB_OK.test(p)) throw new Error(`SEC5 glob with a character outside GLOB_OK: ${p}`);
    out.add(`${PS_TOOL}(${p})`);
    for (const f of caseForms(p)) out.add(`Bash(${f})`);
  }
  return [...out];
}

// The hook entry for a settings file. command = node <this file> only (no inline code on the hook's command line).
function hookSettings(file = __filename) {
  return { PreToolUse: [{ matcher: `Bash|${PS_TOOL}`, hooks: [{ type: 'command', command: `node "${file.replace(/\\/g, '/')}"`, timeout: 10 }] }] };
}

module.exports = { RULES, check, decide, denyGlobs, denyRules, hookSettings, isInline, stripMessages };

// ---- hook entry -----------------------------------------------------------------------------------------------------
if (require.main === module) {
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (s += d));
  process.stdin.on('end', () => {
    let input;
    try {
      input = JSON.parse(s);
    } catch {
      process.exit(0); // not hook input: no decision
    }
    const out = decide(input);
    if (out) process.stdout.write(JSON.stringify(out));
    process.exit(0);
  });
}
