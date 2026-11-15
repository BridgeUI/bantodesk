// Sessions stopped at a choice prompt (roadmap 27): the manager agent (PMO) can read them in manager/sessions.json and
// press the plain "Yes" of a permission prompt with the outbox action `answer`. Hooks are not available (organisation
// setting allowManagedHooksOnly, docs/plan-notify.md), so the prompt comes from the renderer's screen parser
// (TabState.prompt, see renderer.js scan) and the answer is a digit key sent to the pty.
// The app itself decides what may be pressed (classify): the agent can only ask, never widen it.
// No Electron imports (testable from plain Node).
const path = require('path');
const { isInside } = require('./sessions');
const guard = require('./pretool-guard'); // SEC5

const STUCK_MS = 2 * 60 * 1000; // a prompt waiting this long is reported to the manager
const CONTEXT_MAX = 30;
const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const KEY_RE = /^[0-9a-z]{4,40}$/;

// TabState.prompt from the renderer -> sanitized prompt | null.
// prompt = { key, since, question, kind: 'permission'|'question'|'multi'|'menu', options: [{ n, label }], context: string[], complete }
function promptOf(t) {
  const p = t && t.prompt;
  if (!p || typeof p !== 'object' || typeof p.key !== 'string' || !KEY_RE.test(p.key)) return null;
  const since = Number(p.since);
  if (!Number.isFinite(since)) return null;
  return asPermission({
    key: p.key,
    since,
    question: str(p.question, 500),
    kind: ['permission', 'question', 'multi', 'menu'].includes(p.kind) ? p.kind : 'question',
    options: Array.isArray(p.options)
      ? p.options
          .filter((o) => o && Number.isInteger(Number(o.n)) && Number(o.n) >= 1 && Number(o.n) <= 9)
          .slice(0, 9)
          .map((o) => ({ n: Number(o.n), label: str(o.label, 200) }))
      : [],
    context: Array.isArray(p.context) ? p.context.slice(-CONTEXT_MAX).map((l) => str(l, 300)) : [],
    complete: p.complete === true, // the whole dialog (from its top border) was on the screen
    // SEC5: lines were dropped or cut here, so the command is not read whole (classify fails closed)
    truncated: Array.isArray(p.context) && (p.context.length > CONTEXT_MAX || p.context.some((l) => String(l).length > 300)),
  });
}

// A tool permission dialog the screen parser took for a question (bug 2026-11-04: "Read file" / "Read agent output",
// options "1. Yes / 2. Yes, allow reading from … / 3. Nossion"): the "No" row was glued to leftover cells of a longer
// row. Same rule as renderer.js isPermissionMenu: a dialog asking "Do you want to …?" with option 1 exactly "Yes"
// whose last option is "No" + glued text, and no AskUserQuestion rows -> kind 'permission', that label cut to "No".
// AskUserQuestion menus always end with "Type something." / "Chat about this", so they are never upgraded.
const NO_GLUED_RE = /^No(?![\s,.(:;、。（]|$)/;
function asPermission(p) {
  if (p.kind !== 'question' || p.options.length < 2) return p;
  if (p.options.some((o) => /^(Type something\.?|Chat about this)$/i.test(o.label))) return p;
  const last = p.options[p.options.length - 1];
  if (!NO_GLUED_RE.test(last.label)) return p;
  if (p.options[0].label !== 'Yes' || !/^Do you want to /.test(p.question)) return p;
  return { ...p, kind: 'permission', options: [...p.options.slice(0, -1), { n: last.n, label: 'No' }] };
}

// What the app never lets the manager press (they go to the user as 「要対応」). Checked on the dialog's text
// (tool name, command, file path, question). Order = the reason shown first.
const DENY = [
  ['組織の管理設定による確認', /managed (settings|policy)|organi[sz]ation|enterprise|管理設定|組織/i],
  ['秘密情報（.env・鍵・パスワード）', /(^|[\\/\s"'`])\.env\b|\bcredential|\bsecrets?\b|password|passwd|\btokens?\b|api[_ -]?key|id_rsa|id_ed25519|\.pem\b|\.pfx\b|\.p12\b|\.npmrc\b|\.netrc\b/i],
  // AT-135: the ask rules claude-cmd.js REPO_ASK_BASH. Before 削除 / git /
  // ネットワーク: attention.pmoVerdict presses a ネットワーク dialog (gh), so these must never get that reason.
  ['リポジトリの作成・公開の状態・remote の変更', /\bgh\s+(?:\S+\s+)*?repo\s+(create|edit|delete|rename|archive|unarchive|fork)\b|\bgh\s+api\b[^\n]*(?:-X\s*|--method[=\s]+)(POST|PATCH|PUT|DELETE)\b|\bgh\s+api\b[^\n]*\s(-f|-F|--field|--raw-field|--input)[\s=]|\bgit\s+(?:-C\s+\S+\s+)?remote\s+(add|set-url|rename|remove|rm)\b|\bgit\s+(?:-C\s+\S+\s+)?config\b[^\n]*\bremote\.|\bgit\s+(?:-C\s+\S+\s+)?push\b[^\n]*(\s(--mirror|--all|-u|--set-upstream)\b|:\/\/|\bgit@)/i],
  ['削除', /\brm\b|\brmdir\b|\brd\b|\bdel\b|\berase\b|Remove-Item|\bri\s|\bunlink|rimraf|\bdelete\b|\bdeleting\b|削除|\bshred\b|Clear-Content|\btruncate\b|\bgit\s+rm\b/i],
  ['取り返しのつかない git の操作', /\bgit\s+(push|reset|clean|checkout\s+(--|\.)|restore|rebase|filter-branch|filter-repo|branch\s+-[dD]|stash\s+(drop|clear)|commit\s+--amend|tag\s+-d|reflog|gc|update-ref|replace)\b|--force\b|--hard\b/i],
  ['ネットワークへの送信', /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|ssh|scp|sftp|ftp|rsync|telnet|ncat|Send-MailMessage|Start-BitsTransfer|net\s+use)\b|\bnc\s|https?:\/\/|\bgh\s|\bnpm\s+publish|\bWebFetch\b|\bWeb ?Search\b|\bFetch\b/i],
  ['取り返しのつかない操作', /\bformat\b|\bmkfs|\bdd\s+if=|Stop-Computer|Restart-Computer|shutdown|\breg(\.exe)?\s+(add|delete|import)|Set-ItemProperty\s+.*HK|Set-ExecutionPolicy|\bchmod\b|\bchown\b|icacls|takeown|\bkill\b|Stop-Process|taskkill|\bsudo\b|runas|\bmv\b|Move-Item|\bmove\b|Rename-Item|\bren\b|>\s*[^\s|]|Out-File|Set-Content/i],
];
// The DENY patterns attention.pmoVerdict checks again after its U3 widening (one place for the rules: attention.js uses
// these very RegExp objects, no copies).
const DENY_RE = Object.fromEntries(DENY);
const RULES = { DELETE_RE: DENY_RE['削除'], GIT_RE: DENY_RE['取り返しのつかない git の操作'], IRREV_RE: DENY_RE['取り返しのつかない操作'] };
// "Yes" variants that widen the permission beyond this one prompt (never pressed)
const WIDE_YES_RE = /don.?t ask|always|\ball\b|session|remember|from now|今後|以降|常に|すべて/i;
const PLAIN_YES_RE = /^(yes|はい)\b/i;

// Absolute / home / parent paths in the text that lie outside `folder` -> the first one, or ''.
function outsidePath(text, folder) {
  if (/(^|[\s"'`(=])(~[\\/]|%[A-Z_]+%|\$env:|\$HOME\b|\$\{?HOME)/i.test(text)) return '~';
  if (/(^|[\s"'`(=\\/])\.\.([\\/]|$)/.test(text)) return '..';
  const re = /(?:^|[\s"'`(=])((?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^\s"'`|<>*?]*)/g;
  let m;
  while ((m = re.exec(text))) {
    const p = m[1].replace(/[.,;:)\]]+$/, '');
    if (!folder || !isInside(path.resolve(p), folder)) return p;
  }
  // Unix-style absolute paths (Git Bash: /c/Users/…, /tmp, /etc …)
  const ux = /(?:^|[\s"'`(=])(\/(?:[A-Za-z]\/|tmp\b|etc\b|usr\b|var\b|home\b|dev\b|proc\b)[^\s"'`|<>]*)/g;
  while ((m = ux.exec(text))) {
    const p = m[1];
    const drive = /^\/([A-Za-z])\/(.*)$/.exec(p);
    if (drive && folder && isInside(path.resolve(`${drive[1]}:\\${drive[2]}`), folder)) continue;
    return p;
  }
  return '';
}

// prompt (promptOf), folder of the session -> { safe: boolean, choice: n | null, reason }
// safe = the manager may press option `choice` (the plain "Yes" of a permission / proceed prompt).
function classify(prompt, folder) {
  if (!prompt) return { safe: false, choice: null, reason: '確認が出ていません' };
  if (prompt.kind === 'multi' || prompt.kind === 'menu' || !prompt.options.length) {
    return { safe: false, choice: null, reason: '数字で答えられない画面（ユーザーが操作する）' };
  }
  if (prompt.kind !== 'permission') return { safe: false, choice: null, reason: 'ユーザーへの質問（AskUserQuestion など。PMO は選ばない）' };
  if (!prompt.complete) return { safe: false, choice: null, reason: '確認の全体が画面に収まっていない（中身を読み切れない）' };
  const yes = prompt.options.find((o) => PLAIN_YES_RE.test(o.label) && !WIDE_YES_RE.test(o.label));
  if (!yes) return { safe: false, choice: null, reason: 'その場限りの「Yes」がない' };
  // option labels too: "2. Yes, allow reading from /c/…" may be the only place the path shows (bug 2026-11-04)
  const text = [...prompt.context, prompt.question, ...prompt.options.map((o) => o.label)].join('\n');
  if (/use this API key/i.test(text)) return { safe: false, choice: null, reason: 'API キーの確認' };
  // SEC5: a command the EDR would judge as malware (e.g. a heredoc, which deny rules do not match). Before DENY so that
  // attention.pmoVerdict, which widens some DENY reasons, never sees it as one of those.
  if (prompt.truncated) return { safe: false, choice: null, reason: 'SEC5: 確認の中身が長く、コマンドの全体を読み切れない' };
  const g = guard.check(text);
  if (g.deny) return { safe: false, choice: null, reason: `SEC5: マルウェアと判定される形のコマンド（${g.label}）` };
  for (const [reason, re] of DENY) if (re.test(text)) return { safe: false, choice: null, reason };
  const out = outsidePath(text, folder);
  if (out) return { safe: false, choice: null, reason: `作業フォルダの外のパス（${out.slice(0, 80)}）` };
  return { safe: true, choice: yes.n, reason: 'ツールの許可・作業を進めるかの確認（その場限りの Yes）' };
}

// sessions = [{ wcId, workDir, role, t: TabState }] -> waiting prompts of project windows (the manager's own session is
// never listed: it cannot answer itself) = [{ tabKey, wcId, folder, folderName, label, backlogId, since, waitedMs, stuck,
// prompt, verdict }], oldest first.
function waitingList(sessions, now = Date.now(), stuckMs = STUCK_MS) {
  const out = [];
  for (const s of sessions || []) {
    if (!s || s.role === 'manager' || !s.t) continue;
    const prompt = promptOf(s.t);
    if (!prompt || s.t.status !== 'asking') continue;
    const folder = (typeof s.t.cwd === 'string' && s.t.cwd) || s.workDir || '';
    const waitedMs = Math.max(0, now - prompt.since);
    out.push({
      tabKey: str(s.t.id, 100),
      wcId: s.wcId,
      folder: s.workDir || '',
      folderName: path.basename(s.workDir || '') || s.workDir || '',
      label: str(s.t.label, 200),
      backlogId: typeof s.t.backlogId === 'string' ? s.t.backlogId : null,
      since: prompt.since,
      waitedMs,
      stuck: waitedMs >= stuckMs,
      prompt,
      verdict: classify(prompt, folder),
    });
  }
  return out.sort((a, b) => a.since - b.since);
}

const mins = (ms) => `${Math.max(1, Math.round(ms / 60000))}分`;
// Stuck entries -> the block added to the manager's prompt (「確認で止まっているセッションがあります（N 件）…」).
function formatStuck(list) {
  const stuck = (list || []).filter((e) => e.stuck);
  if (!stuck.length) return '';
  const lines = stuck.slice(0, 10).map((e) => {
    const v = e.verdict.safe ? `押してよい: ${e.verdict.choice}` : `押せない: ${e.verdict.reason}`;
    return `- [${e.folderName} ${mins(e.waitedMs)}] tabKey ${e.tabKey} promptKey ${e.prompt.key}「${e.prompt.question.slice(0, 80)}」（${v}）`;
  });
  return [`確認で止まっているセッションがあります（${stuck.length} 件）。sessions.json を読み、押してよいものは answer で進めてください:`, ...lines].join('\n');
}

// The warn notice for stuck prompts the app will not let the manager press (null when none). Since U3 / U4 the user
// answers them in あなたの番 (attention.js, the same prompts with the reason); this notice only goes to 「PMO の記録」.
const STUCK_KEY = 'app:stuck';
function refusedNotice(list) {
  const refused = (list || []).filter((e) => e.stuck && !e.verdict.safe);
  if (!refused.length) return null;
  const text = refused
    .slice(0, 10)
    .map((e) => `- **${e.folderName}**（${mins(e.waitedMs)}待ち）「${e.prompt.question || e.label}」— ${e.verdict.reason}`)
    .join('\n');
  return {
    kind: 'warn',
    title: `確認で止まっているセッション ${refused.length} 件（PMO は押せません）`,
    text: `${text}\n\n「要対応」で答えてください。`,
    folder: refused.length === 1 ? refused[0].folder : null,
    key: STUCK_KEY,
    source: 'app',
    refs: refused.map((e) => `${e.tabKey}:${e.prompt.key}`),
  };
}

// The manager agent's own session stopped at a dialog (e.g. Auto-yes off and a permission prompt for its own outbox
// write): nobody answers it for the user. It is a card in あなたの番 (U3); this warn only goes to 「PMO の記録」 (U4)
// (null when none waits ≥ stuckMs).
const MGR_STUCK_KEY = 'app:mgr-stuck';
function managerStuckNotice(sessions, now = Date.now(), stuckMs = STUCK_MS) {
  const waiting = [];
  for (const s of sessions || []) {
    if (!s || s.role !== 'manager' || !s.t || s.t.status !== 'asking') continue;
    const prompt = promptOf(s.t);
    if (!prompt || now - prompt.since < stuckMs) continue;
    waiting.push({ tabKey: str(s.t.id, 100), prompt, waitedMs: now - prompt.since });
  }
  if (!waiting.length) return null;
  const text = waiting
    .slice(0, 5)
    .map((e) => {
      const cmd = e.prompt.context.filter((l) => l.trim() && l !== e.prompt.question).slice(-3).join(' / ');
      return `- （${mins(e.waitedMs)}待ち）「${e.prompt.question || '確認'}」${cmd ? `（${cmd.slice(0, 160)}）` : ''}`;
    })
    .join('\n');
  return {
    kind: 'warn',
    title: 'PMO が確認で止まっています',
    text: `${text}\n\n答えるまで PMO は振り分けや後押しを進められません。「要対応」の「確認（PMO）」のカードで答えてください。`,
    folder: null,
    key: MGR_STUCK_KEY,
    source: 'app',
    refs: waiting.map((e) => `${e.tabKey}:${e.prompt.key}`),
  };
}

// For sessions.json (what the manager reads): no wcId, ages in seconds.
function forManager(list, now = Date.now()) {
  return {
    updatedAt: now,
    sessions: (list || []).map((e) => ({
      tabKey: e.tabKey,
      folder: e.folder,
      folderName: e.folderName,
      label: e.label,
      backlogId: e.backlogId,
      since: e.since,
      waitedSec: Math.round(e.waitedMs / 1000),
      stuck: e.stuck,
      promptKey: e.prompt.key,
      kind: e.prompt.kind,
      question: e.prompt.question,
      options: e.prompt.options,
      context: e.prompt.context,
      verdict: e.verdict,
    })),
  };
}

// The answer action against the current waiting entry of that tab. -> { ok: true, entry, n } | { error }
function checkAnswer(a, entries) {
  if (!a || typeof a.tabKey !== 'string' || !a.tabKey) return { error: 'tabKey missing' };
  if (typeof a.promptKey !== 'string' || !a.promptKey) return { error: 'promptKey missing' };
  const n = Number(a.choice);
  if (!Number.isInteger(n) || n < 1 || n > 9) return { error: 'choice must be an option number (1-9)' };
  if (typeof a.reason !== 'string' || !a.reason.trim()) return { error: 'reason missing' };
  const entry = (entries || []).find((e) => e.tabKey === a.tabKey);
  if (!entry) return { error: `no prompt waiting in tab ${a.tabKey} (answered, closed or never stopped)` };
  if (entry.prompt.key !== a.promptKey) return { error: `the prompt in tab ${a.tabKey} changed (now ${entry.prompt.key}「${entry.prompt.question.slice(0, 80)}」); read sessions.json again` };
  if (!entry.verdict.safe) return { error: `refused: ${entry.verdict.reason} (left to the user)` };
  if (n !== entry.verdict.choice) return { error: `only option ${entry.verdict.choice} (the plain Yes) may be pressed` };
  return { ok: true, entry, n };
}

// --- the dashboard's あなたの番 (was the 確認待ち list; the user answers there; docs/plan-dashboard.md "確認待ちの一覧") ----------------

// A dialog the user should look twice at before pressing (red in the list, a confirm before a non-"No" option).
// Same rules as what the manager may never press (DENY + API key). '' when nothing matched.
function dangerOf(prompt) {
  if (!prompt || (prompt.kind !== 'permission' && prompt.kind !== 'question')) return '';
  const text = [...prompt.context, prompt.question].join('\n');
  if (/use this API key/i.test(text)) return 'API キーの確認';
  for (const [reason, re] of DENY) if (re.test(text)) return reason;
  return '';
}

const SCREEN_TAIL = 15;
// sessions = [{ wcId, workDir, role, hidden, t: TabState }] -> what waits for the user = [{ wcId, tabId, folder,
// folderName, label, kind: 'input'|'error', since, waitedMs, hidden, text, prompt | null, screen: string[], danger }],
// oldest first. prompt = { key, kind, question, options: [{ n, label, checked, other }], context, complete,
// submitLabel, tabs } only when the screen parser read a dialog with options; otherwise screen = the last lines.
function userList(sessions, now = Date.now()) {
  const out = [];
  for (const s of sessions || []) {
    const t = s && s.t;
    if (!t || typeof t !== 'object' || t.id == null) continue;
    const unread = t.unread && typeof t.unread === 'object' ? t.unread : null;
    const asking = t.status === 'asking';
    const kind = unread && unread.kind === 'error' && !asking ? 'error' : asking || (unread && unread.kind === 'input') ? 'input' : null;
    if (!kind) continue;
    let prompt = null;
    const p = asking ? promptOf(t) : null;
    const ch = t.choices && typeof t.choices === 'object' && Array.isArray(t.choices.options) ? t.choices : null;
    if (p && ch && p.options.length) {
      const extra = new Map(ch.options.filter((o) => o && typeof o === 'object').map((o) => [Number(o.n), o]));
      prompt = {
        ...p,
        options: p.options.map((o) => ({ ...o, checked: extra.get(o.n)?.checked === true, other: extra.get(o.n)?.other === true || (p.kind !== 'multi' && /^type something/i.test(o.label)) })),
        submitLabel: p.kind === 'multi' ? str(ch.submitLabel, 20) || 'Submit' : '',
        tabs: p.kind === 'multi' && Array.isArray(ch.tabs) ? ch.tabs.slice(0, 10).map((x) => ({ label: str(x && x.label, 60), answered: !!(x && x.answered) })) : [],
      };
    }
    const screen = prompt ? [] : (Array.isArray(t.screen) ? t.screen : []).slice(-SCREEN_TAIL).map((l) => str(l, 300));
    const since = p ? p.since : unread && Number.isFinite(unread.at) ? unread.at : Number.isFinite(t.updatedAt) ? t.updatedAt : now;
    out.push({
      wcId: s.wcId,
      tabId: str(t.id, 100),
      folder: s.workDir || '',
      folderName: s.role === 'manager' ? 'ダッシュボード' : path.basename(s.workDir || '') || s.workDir || '',
      label: str(t.label, 200),
      kind,
      since,
      waitedMs: Math.max(0, now - since),
      hidden: s.hidden === true,
      text: str(unread && unread.text ? unread.text : p ? p.question : '', 500),
      prompt,
      screen,
      danger: dangerOf(prompt),
    });
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.since - b.since : a.kind === 'input' ? -1 : 1));
}

// The user's answer from the dashboard against the current list. a = { tabId, promptKey, choice?: n, want?: n[],
// text?: string } -> { ok: true, entry, action } (action = what the renderer does) | { error, changed? }
function checkUserAnswer(a, entries) {
  if (!a || typeof a.tabId !== 'string' || !a.tabId) return { error: 'tabId missing' };
  const entry = (entries || []).find((e) => e.tabId === a.tabId && (a.wcId == null || e.wcId === a.wcId));
  if (!entry || entry.kind !== 'input') return { error: 'このセッションはもう確認待ちではありません', changed: true };
  const p = entry.prompt;
  if (!p) return { error: '選択肢を読めない確認です。タブを開いて答えてください' };
  if (typeof a.promptKey !== 'string' || p.key !== a.promptKey) return { error: '質問が変わりました', changed: true };
  const nums = new Set(p.options.map((o) => o.n));
  const other = p.options.find((o) => o.other);
  const text = typeof a.text === 'string' ? a.text.replace(/\r\n?/g, '\n').trim().slice(0, 2000) : '';
  if (p.kind === 'multi') {
    const want = Array.isArray(a.want) ? [...new Set(a.want.map(Number))] : [];
    if (want.some((n) => !nums.has(n) || (other && n === other.n))) return { error: 'choice must be one of the options' };
    if (text && !other) return { error: '自由記入の欄がありません' };
    const toggle = p.options.filter((o) => !o.other && o.checked !== want.includes(o.n)).map((o) => o.n);
    return { ok: true, entry, action: { mode: 'multi', toggle, other: text ? other.n : null, text, next: p.submitLabel === 'Next' ? 1 : Math.max(1, p.tabs.length) } };
  }
  if (text) {
    if (!other) return { error: '自由記入の欄がありません' };
    return { ok: true, entry, action: { mode: 'text', n: other.n, text } };
  }
  const n = Number(a.choice);
  if (!nums.has(n)) return { error: 'choice must be one of the options' };
  return { ok: true, entry, action: { mode: 'choice', n } };
}

module.exports = { STUCK_MS, STUCK_KEY, MGR_STUCK_KEY, managerStuckNotice, promptOf, classify, outsidePath, waitingList, formatStuck, refusedNotice, forManager, checkAnswer, dangerOf, userList, checkUserAnswer, RULES };
