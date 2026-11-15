// Unit tests: stuck.js userList / checkUserAnswer / dangerOf (dashboard 確認待ちの一覧).
// env AT_APP_ROOT = app folder whose src is tested (default this repo)
const path = require('path');
const root = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.join(__dirname, '..', '..');
const s = require(path.join(root, 'src', 'main', 'stuck.js'));
let pass = 0, fail = 0;
const ok = (n, c, ev) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', n, c ? '' : JSON.stringify(ev)); };
const now = 1_000_000;
const perm = { key: 'perm0001', since: now - 5000, question: 'Do you want to proceed?', kind: 'permission', options: [{ n: 1, label: 'Yes' }, { n: 2, label: "Yes, and don't ask again" }, { n: 3, label: 'No' }], context: ['Bash command', 'rm -rf build'], complete: true };
const ask = { key: 'ask00001', since: now - 9000, question: 'Which one?', kind: 'question', options: [{ n: 1, label: 'Alpha' }, { n: 2, label: 'Beta' }, { n: 3, label: 'Type something.' }], context: ['Pick'], complete: true };
const multi = { key: 'mul00001', since: now - 1000, question: 'Fruits?', kind: 'multi', options: [{ n: 1, label: 'Apple' }, { n: 2, label: 'Banana' }, { n: 3, label: 'Cherry' }, { n: 4, label: 'Type something' }], context: [], complete: true };
const tab = (id, status, prompt, extra = {}) => ({ id, label: 'L' + id, status, prompt, choices: prompt ? { question: prompt.question, options: prompt.options.map((o) => ({ ...o })) } : null, ...extra });
const mt = tab('m', 'asking', multi);
mt.choices = { kind: 'multi', question: 'Fruits?', submitLabel: 'Submit', tabs: [{ label: 'Fruits', answered: false }], options: [{ n: 1, label: 'Apple', checked: true }, { n: 2, label: 'Banana', checked: false }, { n: 3, label: 'Cherry', checked: true }, { n: 4, label: 'Type something', checked: false, other: true }] };
const sessions = [
  { wcId: 1, workDir: 'C:\\w\\a', role: 'project', hidden: false, t: tab('p', 'asking', perm) },
  { wcId: 1, workDir: 'C:\\w\\a', role: 'project', hidden: false, t: tab('q', 'asking', ask) },
  { wcId: 2, workDir: 'C:\\w\\b', role: 'project', hidden: true, t: mt },
  { wcId: 2, workDir: 'C:\\w\\b', role: 'project', hidden: true, t: { id: 'u', label: 'login', status: 'idle', unread: { kind: 'input', at: now - 20000, text: 'needs you' }, screen: Array.from({ length: 30 }, (_, i) => 'line ' + i) } },
  { wcId: 2, workDir: 'C:\\w\\b', role: 'project', t: { id: 'e', status: 'idle', unread: { kind: 'error', at: now - 3000, text: 'API error' } } },
  { wcId: 2, workDir: 'C:\\w\\b', role: 'project', t: { id: 'd', status: 'idle', unread: { kind: 'done', at: now } } },
  { wcId: 2, workDir: 'C:\\w\\b', role: 'project', t: { id: 'r', status: 'running' } },
  { wcId: 3, workDir: 'C:\\w\\mgr', role: 'manager', t: tab('g', 'asking', { ...perm, key: 'mgr00001', context: ['npm test'] }) },
];
const L = s.userList(sessions, now);
ok('6 entries (input x5 incl. manager, error x1; done/running left out)', L.length === 6, L.map((e) => e.tabId));
ok('inputs first, oldest first; error last', L.map((e) => e.tabId).join() === 'u,q,p,g,m,e', L.map((e) => e.tabId));
const P = L.find((e) => e.tabId === 'p');
ok('permission rm -rf -> danger 削除', P.danger === '削除', P.danger);
ok('permission: prompt with options, no screen', P.prompt && P.prompt.options.length === 3 && P.screen.length === 0);
const Q = L.find((e) => e.tabId === 'q');
ok('question: Type something marked other', Q.prompt.options[2].other === true && !Q.prompt.options[0].other, Q.prompt.options);
ok('question: no danger', Q.danger === '');
const M = L.find((e) => e.tabId === 'm');
ok('multi: checked + other + submitLabel + tabs', M.prompt.options.map((o) => +o.checked).join('') === '1010' && M.prompt.options[3].other && M.prompt.submitLabel === 'Submit' && M.prompt.tabs.length === 1, M.prompt);
ok('multi: hidden window flagged', M.hidden === true && P.hidden === false);
const U = L.find((e) => e.tabId === 'u');
ok('unreadable: no prompt, last 15 screen lines', U.prompt === null && U.screen.length === 15 && U.screen[14] === 'line 29', U.screen);
ok('error entry kind + text', L.find((e) => e.tabId === 'e').kind === 'error' && L.find((e) => e.tabId === 'e').text === 'API error');
ok('manager session named ダッシュボード', L.find((e) => e.tabId === 'g').folderName === 'ダッシュボード');
ok('waitedMs from prompt.since', Q.waitedMs === 9000, Q.waitedMs);

// checkUserAnswer
let r = s.checkUserAnswer({ tabId: 'q', promptKey: 'zzzz', choice: 1 }, L);
ok('stale key -> changed', r.error && r.changed, r);
r = s.checkUserAnswer({ tabId: 'nope', promptKey: 'ask00001', choice: 1 }, L);
ok('unknown tab -> changed', r.error && r.changed, r);
r = s.checkUserAnswer({ tabId: 'q', promptKey: 'ask00001', choice: 7 }, L);
ok('choice not an option -> error', r.error && !r.changed, r);
r = s.checkUserAnswer({ tabId: 'q', promptKey: 'ask00001', choice: 2 }, L);
ok('choice ok', r.ok && r.action.mode === 'choice' && r.action.n === 2, r);
r = s.checkUserAnswer({ tabId: 'p', promptKey: 'perm0001', choice: 1 }, L);
ok('dangerous: the user may still press it', r.ok && r.action.n === 1, r);
r = s.checkUserAnswer({ tabId: 'q', promptKey: 'ask00001', text: '  自由に \r\n 書く ' }, L);
ok('text -> other digit + trimmed text', r.ok && r.action.mode === 'text' && r.action.n === 3 && r.action.text === '自由に \n 書く', r);
r = s.checkUserAnswer({ tabId: 'p', promptKey: 'perm0001', text: 'x' }, L);
ok('text without a free slot -> error', r.error, r);
r = s.checkUserAnswer({ tabId: 'm', promptKey: 'mul00001', want: [1, 2] }, L);
ok('multi toggles only the changed boxes (2 on, 3 off), Tab once', r.ok && r.action.toggle.join() === '2,3' && r.action.next === 1 && r.action.other === null, r);
r = s.checkUserAnswer({ tabId: 'm', promptKey: 'mul00001', want: [1, 3], text: 'Kiwi' }, L);
ok('multi unchanged boxes + free text', r.ok && r.action.toggle.length === 0 && r.action.other === 4 && r.action.text === 'Kiwi', r);
r = s.checkUserAnswer({ tabId: 'm', promptKey: 'mul00001', want: [4] }, L);
ok('multi: the free slot is not a box', r.error, r);
r = s.checkUserAnswer({ tabId: 'u', promptKey: 'x', choice: 1 }, L);
ok('unreadable -> open the tab', r.error && /タブを開いて/.test(r.error), r);
r = s.checkUserAnswer({ tabId: 'e', promptKey: 'x', choice: 1 }, L);
ok('error entry -> not waiting', r.error, r);
r = s.checkUserAnswer({ tabId: 'q', wcId: 9, promptKey: 'ask00001', choice: 1 }, L);
ok('wrong window -> changed', r.error && r.changed, r);
ok('dangerOf: secrets', s.dangerOf({ ...perm, context: ['Read .env'] }) === '秘密情報（.env・鍵・パスワード）');
ok('dangerOf: multi / null -> none', s.dangerOf({ ...multi, context: ['rm -rf'] }) === '' && s.dangerOf(null) === '');
console.log(`${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
