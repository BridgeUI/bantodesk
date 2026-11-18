// UX4 (docs/ux-journey.md §6 = docs/mac-polish.md M2〜M4): Mac keys and menu — unit checks (no Electron).
//   A. Labels.key(): ⇧⌘B / Ctrl+Shift+B, ⌘Enter / Ctrl+Enter, ⌃Tab / Ctrl+Tab
//   B. the shortcut table: unique ids and keys, mod+shift letters (+ ctrl+Tab), shortcutOf() with metaKey on Mac,
//      ctrlKey on Windows (Mac also takes Ctrl+Shift as before), the renderer has an action for every id
//   C. no "Ctrl" left in the screen text of src/renderer (comments and Claude Code's own keys aside)
//   D. no keydown check on ctrlKey alone (each one also looks at metaKey, or goes through Labels, or is marked)
//   E. the macOS menu (src/main/appmenu.js): roles undo / redo / cut / copy / paste / selectAll / quit / hide /
//      minimize, no ⌘W / reload / devtools, no key the app's shortcuts use; Windows gets no menu
//   F. the Windows-only texts are guarded (settings lid row, remote firewall note, cheat sheet Alt+V)
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const AT = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : root;
const Labels = require(path.join(AT, 'src/renderer/labels.js'));
const appmenu = require(path.join(AT, 'src/main/appmenu.js'));
const src = (f) => fs.readFileSync(path.join(AT, f), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail !== undefined && !cond ? ' | ' + JSON.stringify(detail).slice(0, 400) : ''}`);
};

// ---- A. key() ----
const K = [
  ['mod+shift+B', '⇧⌘B', 'Ctrl+Shift+B'],
  ['mod+Enter', '⌘Enter', 'Ctrl+Enter'],
  ['mod+shift+Enter', '⇧⌘Enter', 'Ctrl+Shift+Enter'],
  ['ctrl+Tab', '⌃Tab', 'Ctrl+Tab'],
  ['shift+mod+t', '⇧⌘T', 'Ctrl+Shift+T'],
  ['alt+mod+X', '⌥⌘X', 'Ctrl+Alt+X'],
];
for (const [spec, mac, win] of K) {
  ok(`A key(${spec}) mac`, Labels.key(spec, 'darwin') === mac, Labels.key(spec, 'darwin'));
  ok(`A key(${spec}) win`, Labels.key(spec, 'win32') === win, Labels.key(spec, 'win32'));
}
ok('A shortcutKey(backlog)', Labels.shortcutKey('backlog', 'darwin') === '⇧⌘B' && Labels.shortcutKey('backlog', 'win32') === 'Ctrl+Shift+B');

// ---- B. the table ----
const S = Labels.SHORTCUTS;
// UX5 removed 未読へ移動 (U) and すべて既読 (K): 13 since then; an app from before UX5 still has 15
// UX14 removed 会話 → ターミナル → 並べる (M): 12 since then
const nShort = S.some((s) => s.id === 'nextUnread') ? 15 : S.some((s) => s.id === 'viewMode') ? 13 : 12;
ok(`B table has the ${nShort} shortcuts`, S.length === nShort, S.length);
ok('B ids unique', new Set(S.map((s) => s.id)).size === S.length);
ok('B keys unique', new Set(S.map((s) => s.keys.toLowerCase())).size === S.length);
// UX16: the palette is ⌘K on Mac (mod = ⌘, not a Claude Code key there); on Windows Ctrl+K is Claude Code's
// 「行末まで消す」, so it has its own Windows keys (win: mod+shift+K)
ok('B keys are mod+shift+<letter> or ctrl+Tab (palette: mod+K with a Windows mod+shift+K)', S.every((s) => /^mod\+shift\+[A-Z]$/.test(s.keys) || s.keys === 'ctrl+Tab' || (s.id === 'palette' && s.keys === 'mod+K' && s.win === 'mod+shift+K')), S.map((s) => s.keys));
ok('B no ⇧⌘W-like clash with Claude Code keys (no plain mod+<letter> on Windows)', S.every((s) => !/^mod\+[A-Z]$/.test(Labels.keysOf(s, 'win32'))) && Labels.shortcutKey('palette', 'darwin') === '⌘K' && Labels.shortcutKey('palette', 'win32') === 'Ctrl+Shift+K');
const ev = (code, m = {}) => ({ type: 'keydown', code, ctrlKey: !!m.ctrl, metaKey: !!m.meta, shiftKey: !!m.shift, altKey: !!m.alt });
const cases = [
  ['darwin', ev('KeyB', { meta: true, shift: true }), 'backlog'],
  ['darwin', ev('KeyB', { ctrl: true, shift: true }), 'backlog'], // as before UX4 (the e2e send Ctrl+Shift)
  ['darwin', ev('KeyB', { meta: true }), null], // ⌘B alone: not ours
  ['darwin', ev('KeyB', { meta: true, ctrl: true, shift: true }), null],
  ['darwin', ev('KeyT', { meta: true, shift: true }), 'newTab'],
  ['darwin', ev('KeyC', { ctrl: true }), null], // Ctrl+C goes to claude
  ['darwin', ev('Tab', { ctrl: true }), 'cycleTab'],
  ['darwin', ev('Tab', { ctrl: true, shift: true }), 'cycleTab'],
  ['darwin', ev('Tab', { meta: true }), null], // ⌘Tab is the OS's
  ['win32', ev('KeyB', { ctrl: true, shift: true }), 'backlog'],
  ['win32', ev('KeyB', { meta: true, shift: true }), null],
  ['win32', ev('KeyB', { ctrl: true, shift: true, alt: true }), null],
  ['win32', ev('Tab', { ctrl: true, shift: true }), 'cycleTab'],
  ['win32', ev('KeyP', { ctrl: true, shift: true }), 'cheatsheet'],
  ['win32', { ...ev('KeyP', { ctrl: true, shift: true }), type: 'keyup' }, null],
];
for (const [os, e, want] of cases) {
  const m = ['ctrl', 'meta', 'shift', 'alt'].filter((k) => e[k + 'Key']).join('+');
  ok(`B shortcutOf ${os} ${m}+${e.code} -> ${want}`, Labels.shortcutOf(e, os) === want, Labels.shortcutOf(e, os));
}
ok('B modOf: meta on Mac, ctrl on Windows', Labels.modOf({ metaKey: true }, 'darwin') && !Labels.modOf({ ctrlKey: true }, 'darwin') && Labels.modOf({ ctrlKey: true }, 'win32') && !Labels.modOf({ metaKey: true }, 'win32'));
const R = src('src/renderer/renderer.js');
// UX16: the actions are those of the whole command table (COMMAND_RUN), the shortcuts among them
const actBlock = (R.match(/const COMMAND_RUN = \{([\s\S]*?)\n\};/) || [])[1] || '';
const actIds = [...actBlock.matchAll(/^\s+([a-zA-Z]+):/gm)].map((m) => m[1]);
ok('B renderer has an action for every id (and no other)', Labels.COMMANDS.every((s) => actIds.includes(s.id)) && actIds.length === Labels.COMMANDS.length && S.every((s) => actIds.includes(s.id)), { actIds });
ok('B shortcutAction goes through Labels.shortcutOf', /function shortcutAction\(e\) \{[\s\S]{0,120}Labels\.shortcutOf\(e\)/.test(R));
const CS = src('src/renderer/cheatsheet.js');
ok('B cheat sheet builds its BantoDesk rows from the table', /L\.sheetRows\(\)/.test(CS));

// ---- C. no "Ctrl" in screen text ----
// comments out (line comments outside strings, block comments, HTML comments), then any "Ctrl" left is screen text
// Line based (a full JS lexer is not needed here): block comments out (kept as empty lines), then a line's "//" comment
// when the "//" starts the line or follows a space (not "://" in URLs). A string holding " //" would lose its tail: that
// can only hide text, and none of src/renderer's strings do.
function stripJs(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}
// Claude Code's own keys stay Ctrl on macOS too: the cheat sheet's 'Claude Code' group only
const CC_KEYS = new Set(['Ctrl+C', 'Ctrl+D', 'Ctrl+L', 'Ctrl+O', 'Ctrl+T', 'Ctrl+R', 'Ctrl+V']);
const dir = path.join(AT, 'src/renderer');
const left = [];
for (const f of fs.readdirSync(dir)) {
  // labels.js holds key()'s own Windows words (and a regex with a backtick the simple stripper cannot read): its
  // screen words are checked through the module below
  if (!/\.(js|html)$/.test(f) || f === 'labels.js') continue;
  let s = fs.readFileSync(path.join(dir, f), 'utf8');
  s = f.endsWith('.html') ? s.replace(/<!--[\s\S]*?-->/g, '') : stripJs(s);
  s.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/Ctrl[+\w]*/g)) {
      if (f === 'cheatsheet.js' && CC_KEYS.has(m[0]) && /\[\['Ctrl\+[A-Z]'\]/.test(line)) continue;
      left.push(`${f}: ${line.trim().slice(0, 120)}`);
    }
  });
}
ok('C Labels.WORDS and the table labels have no "Ctrl"', !JSON.stringify([Labels.WORDS, Labels.SHORTCUTS.map((x) => x.label)]).includes('Ctrl'));
ok('C no "Ctrl" in the screen text of src/renderer (Claude Code keys aside)', left.length === 0, left);
// the Claude Code group is all there is: every Ctrl row in the cheat sheet is in the 'Claude Code' group
const ccStart = CS.indexOf("group: 'Claude Code'");
const atStart = CS.indexOf("group: 'BantoDesk'");
const ctrlRows = [...CS.matchAll(/\[\['Ctrl\+[A-Z]'\]/g)].map((m) => m.index);
ok('C the cheat sheet\'s Ctrl rows are all in the Claude Code group', ctrlRows.length === 7 && ctrlRows.every((x) => x > ccStart && x < atStart), ctrlRows.length);

// ---- D. no ctrlKey-only checks ----
const lone = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.js')) continue;
  const s = stripJs(fs.readFileSync(path.join(dir, f), 'utf8'));
  const raw = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
  s.split('\n').forEach((line, i) => {
    if (!/\.ctrlKey/.test(line)) return;
    if (/metaKey|Labels\.|modOf|sendMod/.test(line)) return;
    // the line before says why (Claude Code's own key, Ctrl on Mac too)
    if (/ux4-ctrl-ok/.test(raw[i - 1] || '') || /ux4-ctrl-ok/.test(raw[i] || '')) return;
    if (f === 'labels.js') return;
    lone.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
}
ok('D no keydown check on ctrlKey alone in src/renderer', lone.length === 0, lone);
const term = (R.match(/attachCustomKeyEventHandler\(\(e\) => \{([\s\S]*?)\n  \}\);/) || [])[1] || '';
ok('D terminal copy: ⌘C on Mac, Ctrl+C (with a selection) on Windows', /mac \? e\.metaKey && !e\.ctrlKey : e\.ctrlKey && !e\.metaKey/.test(term) && /hasSelection\(\)/.test(term));
ok('D terminal ⌘A selects the terminal on Mac', /e\.code === 'KeyA' && e\.metaKey/.test(term) && /term\.selectAll\(\)/.test(term));

// ---- E. the macOS menu ----
const T = appmenu.macTemplate({ appName: 'BantoDesk', onSettings: () => {} });
const items = [];
const walk = (list) => list.forEach((x) => { items.push(x); if (Array.isArray(x.submenu)) walk(x.submenu); });
walk(T);
const roles = new Set(items.map((x) => x.role).filter(Boolean));
for (const r of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'quit', 'hide', 'hideOthers', 'minimize', 'zoomIn', 'zoomOut', 'resetZoom', 'about']) ok(`E menu has role ${r}`, roles.has(r));
for (const r of ['close', 'reload', 'forceReload', 'toggleDevTools', 'windowMenu', 'editMenu', 'fileMenu', 'viewMenu', 'appMenu']) ok(`E menu has no role ${r}`, !roles.has(r));
const accels = items.map((x) => x.accelerator).filter(Boolean);
ok('E menu: no ⌘W / ⌘R accelerator and no ⇧ letters', accels.every((a) => !/\+(W|R)$/i.test(a) && !/Shift/i.test(a)), accels);
ok('E menu: the settings item is ⌘,', items.some((x) => x.id === 'settings' && x.accelerator === 'Command+,'));
ok('E top-level menus: app / 編集 / 表示 / ウインドウ', T.map((x) => x.label).join(',') === 'BantoDesk,編集,表示,ウインドウ', T.map((x) => x.label));
const fake = () => { const calls = []; return { calls, setApplicationMenu: (m) => calls.push(['set', m]), buildFromTemplate: (t) => ({ t }) }; };
const fw = fake();
ok('E Windows: no menu (setApplicationMenu(null))', appmenu.install(fw, { platform: 'win32' }) === null && fw.calls.length === 1 && fw.calls[0][1] === null);
const fm = fake();
const mm = appmenu.install(fm, { platform: 'darwin' });
ok('E macOS: the menu is set', mm && fm.calls.length === 1 && fm.calls[0][1] === mm && Array.isArray(mm.t));
ok('E main.js installs it through appmenu (no bare setApplicationMenu(null))', /require\('\.\/main\/appmenu'\)\.install\(Menu/.test(src('src/main.js')) && !/Menu\.setApplicationMenu\(null\)/.test(src('src/main.js')));

// ---- F. Windows-only texts ----
const ST = src('src/renderer/settings.js');
ok('F settings: the lid row only on Windows', /if \(win\) box\.append\(lid\);/.test(ST));
ok('F settings: the mode tip has a text without "Windows"', /: '会議のアプリと同じ: 会議中と同じく/.test(ST));
const RU = src('src/renderer/remote-ui.js');
ok('F remote: the firewall note only on Windows', /if \(\/Windows\/i\.test\(navigator\.userAgent \|\| ''\)\) warn\.appendChild\(h\('div', null,\n\s+'初めて ON にしたとき、Windows ファイアウォール/.test(RU));
ok('F cheat sheet: Alt+V only on Windows', /win \? '画像を貼り付け（Windows では Alt\+V の場合あり）' : '画像を貼り付け'/.test(CS));
ok('F index.html loads labels.js before cheatsheet.js / remote-ui.js', (() => { const h = src('src/renderer/index.html'); const l = h.indexOf('src="labels.js"'); return l > 0 && l < h.indexOf('src="cheatsheet.js"') && l < h.indexOf('src="remote-ui.js"'); })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
