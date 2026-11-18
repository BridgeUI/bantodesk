// UX9 止まらない A: 前決め (docs/ux-journey.md §4 A, §6 UX9). Plain node: node tmp/nonstop/unit.js
//   1. settings: base / routed / manager files, the SEC5 deny + hook unchanged in each, no allow rule is a deny rule,
//      deny -> ask -> allow order on sample commands (SEC5 shapes stay denied, risky shapes ask, the work runs)
//   2. main picks the file by the kind of claude (settingsPathFor)
//   3. the routed prompt (docs/prompts/routed-session.md + fallback): no AskUserQuestion, 仮説で決めたこと, SEC5 in short
//   4. the ルーター template: qa and route together, no waiting on asking, proposals with a default and a deadline
//   5. handoff.js: a routed session hands off as auto (also with an active item, which moves to the new tab)
// Command names the SEC5 rules block are built from pieces (CLAUDE.md "マルウェアと判定される動きをしない").
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const app = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : root; // AT_APP_ROOT = the app to test (src, docs)
const claudeCmd = require(path.join(app, 'src', 'main', 'claude-cmd.js'));
const guard = require(path.join(app, 'src', 'main', 'pretool-guard.js'));
const manager = require(path.join(app, 'src', 'main', 'manager.js'));
const J = (...p) => p.join('');

let pass = 0;
let fail = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// ---- a Claude Code permission rule matcher (enough for these rules) ---------------------------------------------------
// Bash(<glob>): * = any characters; "x *" also matches "x" alone. Read / Edit(<path glob>): ** = any path, * = one segment.
function globRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') re += '[\\s\\S]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
function bashMatches(rule, cmd) {
  const m = /^Bash\(([\s\S]*)\)$/.exec(rule);
  if (!m) return rule === 'Bash' ? true : false;
  const g = m[1];
  if (globRe(g).test(cmd)) return true;
  return g.endsWith(' *') && cmd === g.slice(0, -2);
}
function pathMatches(rule, tool, p, cwd, home) {
  const m = new RegExp(`^${tool}\\(([\\s\\S]*)\\)$`).exec(rule);
  if (!m) return false;
  let g = m[1];
  if (g.startsWith('./')) g = cwd + g.slice(1);
  else if (g.startsWith('~/')) g = home + g.slice(1);
  else if (g.startsWith('//')) g = g.slice(1);
  else return false;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    if (g[i] === '*' && g[i + 1] === '*' && g[i + 2] === '/') {
      re += '(?:.*/)?'; // **/ = zero or more folders
      i += 2;
    } else if (g[i] === '*' && g[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (g[i] === '*') re += '[^/]*';
    else re += g[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(p);
}
// deny -> ask -> allow; none = 'default' (Claude Code asks)
function decide(perms, match) {
  for (const k of ['deny', 'ask', 'allow']) if ((perms[k] || []).some(match)) return k;
  return 'default';
}
// Bash as Claude Code does it: the command is split into subcommands at | || && ;. deny / ask when the whole command or any
// subcommand matches; allow only when every subcommand is allowed.
// Claude Code 2.1.316 (tmp/nonstop/real.mjs, the maintainers' test notes): a heredoc, $( ) and backticks are never allowed by
// a rule ("can't be checked before it runs" = a dialog) even when every part is allowed; a plain > redirect is not that.
const UNCHECKABLE = /<<|\$\(|`/;
function bashDecide(perms, cmd) {
  const subs = cmd.split(/\s*(?:\|\||&&|\||;)\s*/).filter(Boolean);
  const any = (k) => (perms[k] || []).some((r) => [cmd, ...subs].some((c) => bashMatches(r, c)));
  if (any('deny')) return 'deny';
  if (any('ask') || UNCHECKABLE.test(cmd)) return 'ask';
  if (subs.every((c) => (perms.allow || []).some((r) => bashMatches(r, c)))) return 'allow';
  return 'default';
}

// ---- 1. settings ------------------------------------------------------------------------------------------------------
const base = claudeCmd.claudeSettings();
const routed = claudeCmd.claudeSettings(undefined, 'routed');
const mgr = claudeCmd.claudeSettings(undefined, 'manager');

t('1a every kind keeps the SEC5 deny rules and the PreToolUse hook unchanged', () => {
  for (const [k, s] of [['base', base], ['routed', routed], ['manager', mgr]]) {
    assert.deepStrictEqual(s.permissions.deny, guard.denyRules(), k);
    assert.deepStrictEqual(s.hooks, guard.hookSettings(), k);
    assert.strictEqual(s.preferredNotifChannel, 'ghostty', k);
    assert.strictEqual(s.spinnerTipsEnabled, false, k);
  }
});
t('1b base: the old allow (temp task reads + MCP only) and the routed ask rules (依頼-171 案 A: auto inherited)', () => {
  assert.deepStrictEqual(base.permissions.allow, [...claudeCmd.tempReadRules(), ...claudeCmd.MCP_ALLOW]);
  assert.deepStrictEqual(base.permissions.ask, routed.permissions.ask);
  for (const r of ['Read(./**/.env)', 'Edit(./**/.env)', 'Read(~/.ssh/**)', 'Edit(~/.ssh/**)', 'Bash(*<<*)', 'Bash(node -e*)', 'Bash(find * -exec*)', 'Bash(git push *--force*)']) assert.ok(base.permissions.ask.includes(r), r);
  // no ask rule is a deny rule (deny is checked first, so it would be dead) and none asks for a whole tool
  const deny = new Set(base.permissions.deny);
  for (const k of base.permissions.ask) {
    assert.ok(!deny.has(k), k);
    assert.ok(!/^(Bash|Edit|Read)(\(\*\*?\))?$/.test(k), k);
  }
});
t('1c no allow rule is a deny rule, none allows a whole tool (Bash / PowerShell / Edit / Read / WebFetch)', () => {
  for (const s of [routed, mgr]) {
    const deny = new Set(s.permissions.deny);
    for (const a of s.permissions.allow) {
      assert.ok(!deny.has(a), a);
      assert.ok(!/^(Bash|PowerShell|Edit|Write|Read|WebFetch)$/.test(a), a);
      assert.ok(!/^PowerShell\(/.test(a), a);
      assert.ok(!/^(Bash|Edit|Read)\(\*\*?\)$/.test(a), a);
    }
  }
});
t('1d routed allow: work folder read / edit, git push, node <file>; ask: heredoc, inline node, secrets', () => {
  const a = routed.permissions.allow;
  for (const r of ['Read(./**)', 'Edit(./**)', 'Bash(git push)', 'Bash(git push *)', 'Bash(node *)', 'Bash(rm *)', 'Bash(npm run *)', 'mcp__bantodesk__notify']) assert.ok(a.includes(r), r);
  const k = routed.permissions.ask;
  for (const r of ['Bash(*<<*)', 'Bash(node -e*)', 'Read(~/.ssh/**)', 'Edit(~/.ssh/**)', 'Bash(git push *--force*)']) assert.ok(k.includes(r), r);
});
t('1e manager allow: manager folder (outbox) read / edit, read-only commands; no push, no rm, no node', () => {
  const a = mgr.permissions.allow;
  for (const r of ['Read(./**)', 'Edit(./**)', 'Read(~/**)', 'Bash(git status)', 'Bash(git log *)']) assert.ok(a.includes(r), r);
  for (const r of a) assert.ok(!/^Bash\((git push|git commit|rm|node|npm|mv|cp)\b/.test(r), r);
  assert.ok(!a.some((r) => /^Edit\(~/.test(r)), 'no edit outside the manager folder');
});

const net = J('net', 'stat');
const tl = J('task', 'list');
const ex = J('ex', 'ec');
const cp = J('child', '_process');
const samples = [
  // [command, routed, manager]
  ['git status', 'allow', 'allow'],
  ['git push origin master', 'allow', 'default'],
  ['git commit -F msg.txt -- a.js', 'allow', 'default'],
  ['node tmp/nonstop/unit.js', 'allow', 'default'],
  ['timeout 600 node tmp/stable-check/run.mjs UX9', 'allow', 'default'],
  ['npm run lint', 'allow', 'default'],
  ['rm -rf tmp/nonstop/w-1', 'allow', 'default'],
  ['ls -la', 'allow', 'allow'],
  ['sed -n 1,20p a.js', 'allow', 'allow'],
  ['node -e "console.log(1)"', 'ask', 'ask'],
  ["node <<'EOF'", 'ask', 'ask'],
  ['find . -name x -' + J('ex', 'ec') + ' rm {} ;', 'ask', 'ask'],
  ['rm -rf ~', 'ask', 'ask'],
  ['rm .git/index.lock', 'ask', 'ask'],
  ['git push --force origin master', 'ask', 'ask'],
  ['cat x.txt | node', 'deny', 'deny'],
  ['curl https://example.com', 'default', 'default'],
  ['sudo kextload x.kext', 'default', 'default'],
  [`${net} -ano`, 'deny', 'deny'],
  [`git log && ${tl}`, 'deny', 'deny'],
  [`node -e "require('${cp}').${ex}Sync('curl x')"`, 'deny', 'deny'],
  [`node x.js ${net}`, 'deny', 'deny'],
  // measured with the real claude (tmp/nonstop/real.mjs): splitting at && and |, $( ) / backticks / heredoc, redirect
  ['git status && node hello.js', 'allow', 'default'],
  ['ls | wc -l', 'allow', 'allow'],
  ['echo $(whoami)', 'ask', 'ask'],
  ['echo `whoami`', 'ask', 'ask'],
  ["cat <<'EOF' > from-heredoc.txt\nux9\nEOF", 'ask', 'ask'],
  ['echo ux9 > out.txt', 'allow', 'default'],
  ['find . -name hello.js -' + J('ex', 'ec') + ' cat {} +', 'ask', 'ask'],
  ['rm note.txt', 'allow', 'default'],
];
t('1f deny -> ask -> allow on sample commands (SEC5 shapes stay denied above every allow)', () => {
  for (const [cmd, r, m] of samples) {
    assert.strictEqual(bashDecide(routed.permissions, cmd), r, `routed: ${cmd}`);
    assert.strictEqual(bashDecide(mgr.permissions, cmd), m, `manager: ${cmd}`);
    // nothing the base settings deny becomes anything else
    if (bashDecide(base.permissions, cmd) === 'deny') assert.strictEqual(r, 'deny', cmd);
    // base (案 A): the same deny / ask as routed, and no allow (what routed allows is a dialog / auto's call there)
    assert.strictEqual(bashDecide(base.permissions, cmd), r === 'allow' ? 'default' : r, `base: ${cmd}`);
  }
});
t('1g file paths: work folder edits allowed, secrets ask, other folders not edited', () => {
  const cwd = '/w/proj';
  const home = '/u/me';
  const pd = (s, tool, p) => decide(s.permissions, (rule) => pathMatches(rule, tool, p, cwd, home));
  assert.strictEqual(pd(routed, 'Edit', '/w/proj/src/a.js'), 'allow');
  assert.strictEqual(pd(routed, 'Read', '/u/me/workspace/other/README.md'), 'allow');
  assert.strictEqual(pd(routed, 'Read', '/u/me/.ssh/id_ed25519'), 'ask');
  assert.strictEqual(pd(routed, 'Read', '/w/proj/.env'), 'ask');
  assert.strictEqual(pd(routed, 'Edit', '/u/me/Library/LaunchAgents/x.plist'), 'default');
  // measured with the real claude (tmp/nonstop/real.mjs): a file outside ~ and the temp claude/ folders is not read freely
  assert.strictEqual(pd(routed, 'Read', '/private/var/folders/x/T/at-ux9-real-1/dummy.txt'), 'default');
  assert.strictEqual(pd(routed, 'Edit', '/u/me/.at-ux9-real-outside/new.txt'), 'default');
  assert.strictEqual(pd(mgr, 'Read', '/u/me/.at-ux9-real-outside/dummy.txt'), 'allow');
  assert.strictEqual(pd(mgr, 'Edit', '/w/proj/outbox/1-route.json'), 'allow');
  assert.strictEqual(pd(mgr, 'Edit', '/u/me/workspace/other/a.js'), 'default');
  assert.strictEqual(pd(mgr, 'Read', '/u/me/Library/Application Support/agent-terminal/x.json'), 'ask');
  assert.strictEqual(pd(mgr, 'Read', '/u/me/Library/Application Support/bantodesk/x.json'), 'ask'); // BN3
  // base (依頼-171 案 A): the secret stores ask (read and edit); the rest has no rule (a dialog, or auto's call)
  assert.strictEqual(pd(base, 'Read', '/w/proj/.env'), 'ask');
  assert.strictEqual(pd(base, 'Edit', '/w/proj/.env.local'), 'ask');
  assert.strictEqual(pd(base, 'Read', '/u/me/.ssh/id_ed25519'), 'ask');
  assert.strictEqual(pd(base, 'Edit', '/u/me/.aws/credentials'), 'ask');
  assert.strictEqual(pd(base, 'Read', '/u/me/Library/Application Support/agent-terminal/x.json'), 'ask');
  assert.strictEqual(pd(base, 'Read', '/u/me/Library/Application Support/bantodesk/x.json'), 'ask'); // BN3
  assert.strictEqual(pd(base, 'Edit', '/w/proj/src/a.js'), 'default');
  assert.strictEqual(pd(base, 'Read', '/u/me/workspace/other/README.md'), 'default');
});
t('1h writeAllClaudeSettings writes the three files', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'at-nonstop-w-'));
  try {
    const p = claudeCmd.writeAllClaudeSettings(dir);
    assert.deepStrictEqual(Object.keys(p).sort(), ['base', 'manager', 'routed']);
    assert.strictEqual(path.basename(p.base), 'claude-settings.json');
    assert.strictEqual(path.basename(p.routed), 'claude-settings-routed.json');
    assert.strictEqual(path.basename(p.manager), 'claude-settings-manager.json');
    for (const k of Object.keys(p)) {
      const s = JSON.parse(fs.readFileSync(p[k], 'utf8'));
      assert.deepStrictEqual(s.permissions.deny, guard.denyRules(), k);
    }
    assert.strictEqual(claudeCmd.writeClaudeSettings(dir), p.base, 'old call = the base file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 2. main ----------------------------------------------------------------------------------------------------------
t('2a main writes all three and passes the file by kind', () => {
  const src = fs.readFileSync(path.join(app, 'src', 'main.js'), 'utf8');
  assert.ok(/claudeSettingsPaths = claudeCmd\.writeAllClaudeSettings\(app\.getPath\('userData'\)\)/.test(src));
  const fn = /function settingsPathFor\(s, claude\) \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(fn, 'settingsPathFor');
  assert.ok(/s\.role === 'manager'\) return p\.manager/.test(fn[1]));
  assert.ok(/!s\.temp && claude\.delegate\) return p\.routed/.test(fn[1]));
  assert.ok(/settingsPath: settingsPathFor\(s, claude\)/.test(src));
});

// ---- 3. routed prompt -------------------------------------------------------------------------------------------------
const promptFile = path.join(app, 'docs', 'prompts', 'routed-session.md');
const filePrompt = claudeCmd.routedPrompt(promptFile);
t('3a the routed prompt (file and fallback): no AskUserQuestion, 仮説で決めたこと, what cannot be decided, permissions, SEC5', () => {
  assert.notStrictEqual(filePrompt, claudeCmd.ROUTED_PROMPT_FALLBACK, 'the file block is read');
  for (const [k, p] of [['file', filePrompt], ['fallback', claudeCmd.ROUTED_PROMPT_FALLBACK]]) {
    assert.ok(/ユーザーへの質問（AskUserQuestion）は使わない/.test(p), k);
    assert.ok(/仮説で決めたこと/.test(p) && /事後の確認/.test(p), k);
    assert.ok(/propose で依頼に出すか 作業中断: <理由> で返す/.test(p), k);
    assert.ok(/許可は起動のときに決めてある/.test(p) && /git（push を含む）/.test(p), k);
    assert.ok(/SEC5 の要点: コードはファイルに書いて node <ファイル> で動かす/.test(p) && /git commit -F <ファイル>/.test(p), k);
    assert.ok(/作業完了/.test(p), k);
  }
});
t('3b the prompts are safe on a command line (no double quote, no blocked name, no launcher, < 4000)', () => {
  const words = [net, tl, J('wm', 'ic'), J('power', 'shell'), J('pw', 'sh'), ex, J('sp', 'awn'), cp, '-e ', '--eval'];
  for (const p of [filePrompt, claudeCmd.ROUTED_PROMPT_FALLBACK, claudeCmd.GUARD_PROMPT]) {
    assert.ok(!p.includes('"'), 'no double quote');
    assert.ok(p.length < 4000, `length ${p.length}`);
    for (const w of words) assert.ok(!p.toLowerCase().includes(w), w);
    assert.ok(!guard.check(p).deny, 'the SEC5 check passes it');
  }
});

// ---- 4. ルーター template --------------------------------------------------------------------------------------------------
t('4a ルーター template v28+: qa and route together, no waiting on asking, proposals with a default and a deadline', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'at-nonstop-m-'));
  try {
    manager.ensureManagerDir(dir);
    const md = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(manager.CLAUDE_MD_VERSION >= 28 && md.startsWith(`<!-- bantodesk manager v${manager.CLAUDE_MD_VERSION} -->`));
    assert.ok(/新しい依頼の qa と route は、同じ回の outbox に続けて書く/.test(md));
    assert.ok(/依頼を asking（ask アクション）にして答えを待たない/.test(md));
    assert.ok(/\*\*既定の案\*\*/.test(md) && /\*\*期限\*\*: <YYYY-MM-DD HH:MM>（24 時間/.test(md) && /\*\*期限\*\*: なし/.test(md));
    assert.ok(/期限を過ぎて answer の無い proposal は、既定の案で/.test(md));
    assert.ok(/起動時の --settings で許可を前決めしている/.test(md));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 5. handoff -------------------------------------------------------------------------------------------------------
function loadHandoff() {
  const store = new Map();
  const el = () => ({ className: '', textContent: '', hidden: true, classList: { add() {}, remove() {}, toggle() {} }, append() {}, replaceChildren() {}, addEventListener() {}, querySelector: () => null });
  const timers = [];
  const ctx = {
    window: {},
    document: { createElement: el },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    setTimeout: (fn) => timers.push(fn),
    clearTimeout() {},
    console,
    Date,
    Math,
    JSON,
    Map,
    Set,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(app, 'src', 'renderer', 'handoff.js'), 'utf8'), ctx);
  return { H: ctx.window.Handoff, win: ctx.window, timers };
}
t('5a modeOf: routed -> auto (unless off), a hand-opened tab and the ルーター keep the setting', () => {
  const { H } = loadHandoff();
  H.init({ isManager: false });
  assert.strictEqual(H.settings().mode, 'confirm', 'default');
  assert.strictEqual(H.modeOf({ forBacklog: true }), 'auto');
  assert.strictEqual(H.modeOf({ forBacklog: false }), 'confirm');
  H.setSettings({ mode: 'notify' });
  assert.strictEqual(H.modeOf({ forBacklog: true }), 'auto');
  H.setSettings({ mode: 'off' });
  assert.strictEqual(H.modeOf({ forBacklog: true }), 'off');
  const m = loadHandoff();
  m.H.init({ isManager: true });
  assert.strictEqual(m.H.modeOf({ forBacklog: true }), 'confirm');
});
t('5b a routed session with an active item hands off by itself; the item moves to the new tab', () => {
  const { H, win, timers } = loadHandoff();
  const item = { id: 'b1', tabId: 'old', status: 'active', startedAt: 1000 };
  const items = [item, { id: 'b2', tabId: 'old', status: 'pending' }];
  win.Backlog = {
    activeOf: (id) => items.find((i) => i.status === 'active' && i.tabId === id) || null,
    items: (id) => items.filter((i) => i.tabId === id),
    auto: () => true,
    setAuto() {},
  };
  const sent = [];
  const created = [];
  const old = { id: 'old', label: 'AT-1 作業', cwd: '/w', forBacklog: true, delegate: true, team: true, lastPromptAt: 1, lastTurnEndAt: 2 };
  let next = null;
  H.init({
    isManager: false,
    tabs: () => [old, ...(next ? [next] : [])],
    summary: (tb) => ({ contextPct: tb === old ? 90 : 5 }),
    ready: () => true,
    blocked: () => '',
    send: (tb, text) => sent.push([tb.id, text]),
    createTab: (o) => {
      created.push(o);
      next = { id: 'new', label: o.label, cwd: o.cwd, forBacklog: !!o.forBacklog, delegate: !!o.delegate, lastPromptAt: 0, lastTurnEndAt: 0 };
      return next;
    },
    activeId: () => 'other',
    raise() {},
    render() {},
    activate() {},
  });
  const t0 = Date.now();
  H.tick(t0);
  H.tick(t0 + 3500); // STABLE_MS
  assert.strictEqual(old.handoff && old.handoff.phase, 'writing', 'auto, no confirm bar');
  assert.strictEqual(sent.length, 1);
  assert.ok(/引き継ぎメモ/.test(sent[0][1]));
  H.onEvent(old, { kind: 'prompt' });
  H.onEvent(old, { kind: 'assistant_text', uuid: 'u1', text: '=== 引き継ぎメモ ここから ===\n目的: UX9 の続き。残り: unit を通す。関係するファイル: src/main/claude-cmd.js tmp/nonstop/unit.js\n=== 引き継ぎメモ ここまで ===' });
  H.onEvent(old, { kind: 'turn_end' });
  for (const fn of timers.splice(0)) fn();
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].forBacklog, true, 'the new tab is routed too');
  assert.strictEqual(created[0].delegate, true);
  assert.ok(/作業完了/.test(next.handoffPrompt) && /質問せず仮説で進め/.test(next.handoffPrompt), 'the mark line');
  const t1 = Date.now();
  H.tick(t1);
  H.tick(t1 + 3500);
  assert.strictEqual(old.handedOff, true);
  assert.strictEqual(item.tabId, 'new', 'active item moved');
  assert.ok(item.startedAt >= t1 - 5, 'startedAt renewed');
  assert.strictEqual(items[1].tabId, 'new', 'pending item moved');
  assert.ok(sent.some(([id, x]) => id === 'new' && /引き継ぎメモです/.test(x)), 'the memo went to the new tab');
});
t('5c a hand-opened tab with an active item still waits (confirm, not auto)', () => {
  const { H, win } = loadHandoff();
  win.Backlog = { activeOf: () => ({ id: 'x' }), items: () => [], auto: () => true, setAuto() {} };
  const tab = { id: 'a', label: 'x', forBacklog: false, lastPromptAt: 1, lastTurnEndAt: 2 };
  const raised = [];
  H.init({ isManager: false, tabs: () => [tab], summary: () => ({ contextPct: 90 }), ready: () => true, blocked: () => '', send() {}, raise: (tb, k, x) => raised.push(x), render() {} });
  const t0 = Date.now();
  H.tick(t0);
  H.tick(t0 + 3500);
  assert.strictEqual(tab.handoff, undefined);
  assert.strictEqual(raised.length, 0);
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      pass++;
      console.log(`ok   ${name}`);
    } catch (err) {
      fail++;
      console.log(`NG   ${name}\n     ${err && err.message}`);
    }
  }
  console.log(`\nnonstop unit: ${pass} ok, ${fail} NG`);
  process.exit(fail ? 1 : 0);
})();
