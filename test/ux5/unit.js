// UX5 (docs/ux-journey.md §5.4・§6): 片付け（消す・まとめる 第 1 弾） — unit checks (no Electron).
//   A. removed names are not in src: the picker window, 未読の近道 (U / K) and the unread count, the hidden top-bar
//      buttons, #layout-btn, waitTop(), the unused dashboard CSS, preload's three unused calls, the answer choices on
//      the project rows and the 関係図 boxes, the band's ⚙
//   B. words: no old word of the word table (Labels.RENAMED, the rename/unit form) in the screen text of the files UX5
//      touched, 「再開（--resume）」 -> 「再開」, the 関係図 words are the current ones, the drop band names xlsx
//   C. moved: settings 「作業とモデル」 second from the top, a 「スマホ」 section, the band shows スマホ only while ON
//   D. 依頼 counts: the tab's number and the 対応中 list use the same statuses (OPEN_REQ)
// AT_APP_ROOT (run.mjs --all-stable) tests that app's src.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const AT = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : root;
console.log('app:', AT);
const exists = (f) => fs.existsSync(path.join(AT, f));
const src = (f) => {
  try {
    return fs.readFileSync(path.join(AT, f), 'utf8');
  } catch {
    return '';
  }
};
// the code without comments (line comments, block comments, HTML comments); strings stay
const code = (f) =>
  src(f)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
const Labels = require(path.join(AT, 'src/renderer/labels.js'));

let pass = 0;
let fail = 0;
const ok = (name, c, info) => {
  if (c) pass++, console.log('PASS', name);
  else fail++, console.log('FAIL', name, info === undefined ? '' : JSON.stringify(info).slice(0, process.env.UX5_FULL ? 1e6 : 600));
};
const REN = 'src/renderer/';
const rfiles = fs.readdirSync(path.join(AT, REN)).filter((f) => /\.(js|html|css)$/.test(f)).map((f) => REN + f);
const all = [...rfiles, 'src/preload.js', 'src/main.js'];
// files whose code (comments aside) contains the name
const where = (name, files = all) => files.filter((f) => code(f).includes(name));

// ---- A. removed ----
ok('A1 no picker.html / picker.js', !exists(REN + 'picker.html') && !exists(REN + 'picker.js'));
ok('A2 main.js: no picker window (showPicker / pickerWin / closePicker / picker.html)', !['showPicker', 'pickerWin', 'closePicker', 'picker.html'].some((n) => code('src/main.js').includes(n)), ['showPicker', 'pickerWin', 'closePicker', 'picker.html'].filter((n) => code('src/main.js').includes(n)));
ok('A3 main.js: no manager folder -> the OS folder dialog', /if \(!s\) return void chooseFolderFallback\(\)/.test(code('src/main.js')) && /showOpenDialog\(\{ title: 'フォルダを選ぶ', properties: \['openDirectory'\] \}\)/.test(code('src/main.js')));
ok('A4 no English title left on the folder dialog', !/'Open folder'/.test(code('src/main.js')));
const S = Labels.SHORTCUTS;
ok('A5 shortcut table: no 未読へ移動 (U) / すべて既読 (K)', !S.some((s) => /^(nextUnread|markAllRead)$/.test(s.id) || /shift\+(U|K)$/.test(s.keys)), S.map((s) => s.id));
for (const n of ['nextUnread', 'markAllRead', 'notifyBtn', 'notify-btn']) ok(`A6 no ${n} in src/renderer`, where(n, rfiles).length === 0, where(n, rfiles));
for (const n of ['topbar-hidden', 'newtab-menu', 'viewer-btn', 'backlog-btn', 'cheatsheet-btn', 'layout-btn', 'layoutBtn']) ok(`A7 no ${n} in src`, where(n).length === 0, where(n));
ok('A8 no waitTop() in dashboard.js', !/waitTop/.test(code(REN + 'dashboard.js')));
// dashboardWaiting stays in preload for the e2e tests (wait-answer, pmo-answer-real) but no screen calls it
for (const n of ['noticesRead', 'noticesAnnounced']) ok(`A9 preload: no ${n}`, !code('src/preload.js').includes(n) && where(n, rfiles).length === 0, where(n));
ok('A9 no screen calls dashboardWaiting', where('dashboardWaiting', rfiles).length === 0, where('dashboardWaiting', rfiles));
// every class a dashboard.css rule names is used by some renderer script (built names: a prefix that ends in -)
{
  const css = code(REN + 'dashboard.css');
  const classes = [...new Set([...css.matchAll(/\.(dbx-[a-z0-9-]+)/g)].map((m) => m[1]))];
  const js = rfiles.filter((f) => f.endsWith('.js')).map(code).join('\n');
  const unused = classes.filter((c) => {
    if (js.includes(c)) return false;
    // built names: 'dbx-foo-' + x / `dbx-foo-${x}`
    for (let i = c.length - 1; i > 4; i--) if (c[i] === '-' && (js.includes(`'${c.slice(0, i + 1)}'`) || js.includes(`\`${c.slice(0, i + 1)}\${`) || js.includes(`${c.slice(0, i + 1)}\${`))) return false;
    return true;
  });
  ok('A10 dashboard.css: no class that no renderer script uses', unused.length === 0, unused);
}
ok('A11 関係図: no answer choices on the boxes', !/function choices\(/.test(code(REN + 'agents-view.js')) && !/Dashboard\.answer/.test(code(REN + 'agents-view.js')));
ok('A12 band: no ⚙ chip (the top bar ⚙ is the one entry)', !/dbx-gear/.test(code(REN + 'dashboard.js')) && /settings-btn/.test(src(REN + 'index.html')));

// ---- B. words ----
const conv = code(REN + 'conversation.js');
ok('B1 no 「再開（--resume）」 on the screen', where('再開（--resume）', rfiles.filter((f) => f !== REN + 'labels.js')).length === 0, where('再開（--resume）', rfiles));
{
  // screen text = the string literals; the CLI option name must not be in one (docs/ui-copy.md rule 6)
  const files = [REN + 'conversation.js', REN + 'dashboard.js', REN + 'renderer.js', REN + 'agents-view.js', REN + 'settings.js'];
  const hits = [];
  for (const f of files) for (const m of code(f).matchAll(/(['`])((?:\\.|(?!\1)[^\\\n])*?)\1/g)) if (/--resume/.test(m[2]) && /[ぁ-んァ-ン一-龥]/.test(m[2])) hits.push(`${f}: ${m[2].slice(0, 80)}`);
  ok('B2 no --resume in Japanese screen text (UX5 files)', hits.length === 0, hits);
}
{
  // the rename/unit form: the old words of Labels.RENAMED (the plain ones) are not in the screen strings of the UX5 files
  const olds = Labels.RENAMED.map((r) => r.from).filter((w) => !/[ /:]/.test(w) && w !== '受-N' && !/（/.test(w));
  // the RENAMED words' own homes (labels.js) are not checked; the PROGRESS.md status names (進行中・確認待ち・…) are data
  // names, and INBOX_JA in dashboard.js is the fallback of Labels.status for an app without labels.js
  const files = [REN + 'agents-view.js', REN + 'dashboard.js', REN + 'settings.js', REN + 'conversation.js'];
  const hits = [];
  for (const f of files) {
    const c = code(f).replace(/const INBOX_JA = \{[^}]*\};/, '');
    for (const m of c.matchAll(/(['`])((?:\\.|(?!\1)[^\\\n])*?)\1/g)) for (const w of olds) if (m[2].includes(w) && !/PROGRESS/.test(m[2])) hits.push(`${f}: ${w} in 「${m[2].slice(0, 60)}」`);
  }
  ok('B3 no old word of the word table in the screen text (agents-view / dashboard / settings / conversation)', hits.length === 0, hits);
}
// UX16 made the two drop bands one (edit-drop.js: 見る / 直す); the 見る target still names xlsx
ok('B4 the viewer drop band names xlsx', /ビューアで開く（[^）]*xlsx[^）]*）/.test(code(REN + 'edit-drop.js')));
ok('B5 the 再開 button uses the word table', /cv-restart/.test(conv) && !/'再開（--resume）'/.test(conv));

// ---- C. moved ----
{
  const dash = code(REN + 'dashboard.js');
  const set = code(REN + 'settings.js');
  ok('C1 the word 作業とモデル', Labels.WORDS.workAndModel === '作業とモデル', Labels.WORDS.workAndModel);
  ok('C2 dashboard registers its settings section as 作業とモデル', /W\('workAndModel', '作業とモデル'\)/.test(dash));
  // the section orders: the modal's own sections (settings.js) and the dashboard's; 作業とモデル is second from the top
  const own = [...set.matchAll(/\{\s*id: '([a-zA-Z]+)',[^}]*?order: (\d+)/g)].map((m) => ({ id: m[1], order: Number(m[2]) }));
  const dOrder = Number((dash.match(/id: SETTINGS_ID,[\s\S]{0,200}?order: (\d+)/) || [])[1]);
  const phoneOrder = Number(((dash + set).match(/id: '(?:phone|remote)',[\s\S]{0,200}?order: (\d+)/) || [])[1]);
  const list = [...own, { id: 'dashboard', order: dOrder }, ...(Number.isFinite(phoneOrder) && !own.some((o) => o.id === 'phone' || o.id === 'remote') ? [{ id: 'phone', order: phoneOrder }] : [])].sort((a, b) => a.order - b.order);
  ok('C3 作業とモデル is second from the top of the settings', list.length > 2 && list[1].id === 'dashboard', list);
  ok('C4 a スマホ section in the settings', Number.isFinite(phoneOrder) || own.some((o) => o.id === 'phone' || o.id === 'remote'), list);
  ok('C5 the band shows スマホ only while it is on (no 「スマホ OFF」 chip)', !/'スマホ OFF'/.test(dash), null);
  ok('C6 no 「上部バーの Remote で切り替え」 left', !/上部バーの Remote/.test(dash), null);
}

// ---- D. 依頼 counts ----
{
  const dash = code(REN + 'dashboard.js');
  const i = dash.indexOf('function tabBar(');
  const tb = dash.slice(i, dash.indexOf('\n  }\n', i));
  ok('D1 the 依頼 tab count does not list the statuses by hand', !/\['new', 'asking', 'routed'\]\.includes/.test(tb), tb.slice(0, 400));
  ok('D2 the 依頼 tab count and the 対応中 list go through OPEN_REQ', /OPEN_REQ|openReq/.test(tb), tb.slice(0, 400));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
