// UIUX U7 (依頼-50 A / 依頼-52 B / 依頼-54 / 依頼-71): a routed session's "next thing to do" (src/main/propose.js),
// the inbox's session source (src/main/inbox.js), the ルーター's prompt and CLAUDE.md (src/main/manager.js), the routed-session
// preface (docs/prompts/routed-session.md, claude-cmd fallback; the tail -f line), the limits -> hold (7: proposeDayMax in
// manager-settings.json, default 30, runaway 3 x -> failed). Plain Node, no Electron.
// Run: node tmp/propose/unit.js   (AT_APP_ROOT=<app> tests another copy, e.g. the stable one)
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.resolve(__dirname, '..', '..');
const propose = require(path.join(root, 'src/main/propose'));
const inboxStore = require(path.join(root, 'src/main/inbox'));
const manager = require(path.join(root, 'src/main/manager'));
const backlog = require(path.join(root, 'src/main/backlog'));
const launcher = require(path.join(root, 'src/main', 'claude-' + 'cmd.js'));

const kill = setTimeout(() => {
  console.log('TIMEOUT');
  process.exit(2);
}, 60000);
let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && extra !== undefined ? ` -- ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`);
};
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'propose-')));
const mk = (...p) => {
  const d = path.join(tmp, ...p);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = (o = {}) => ({ type: 'propose', title: '次の見出し', text: '自己完結した指示文', reason: 'テストが足りない', ...o });

(async () => {
  const hints = manager.schedHints;
  ok('manager exports schedHints', typeof hints === 'function');

  // --- 1. shape --------------------------------------------------------------------------------------------------
  {
    const v = propose.validate(P({ kind: 'implement', touches: ['src/a.js', 'docs/'], after: ['r-x-0001'], from: 'r-i1-abcd' }), hints);
    ok('1a one object -> 1 proposal with kind / touches / after / from', v.proposals && v.proposals.length === 1 && v.proposals[0].fields.kind === 'implement' && v.proposals[0].fields.touches.length === 2 && v.proposals[0].from === 'r-i1-abcd', v);
    ok('1b array of 5 ok', propose.validate([1, 2, 3, 4, 5].map((n) => P({ text: 't' + n })), hints).proposals?.length === 5);
    ok('1c { proposals: [...] } ok', propose.validate({ proposals: [P()] }, hints).proposals?.length === 1);
    const six = propose.validate([1, 2, 3, 4, 5, 6].map((n) => P({ text: 't' + n })), hints);
    ok('1d 6 in one file -> error (max 5, nothing added)', /max 5/.test(six.error || ''), six);
    ok('1e wrong type -> error', /type must be/.test(propose.validate({ type: 'route', text: 'x' }, hints).error || ''));
    ok('1f no text -> error', /text is required/.test(propose.validate(P({ text: '  ' }), hints).error || ''));
    ok('1g folder field refused', /folder is not accepted/.test(propose.validate(P({ folder: '/x' }), hints).error || ''));
    ok('1h bad kind -> error (schedHints)', /bad kind/.test(propose.validate(P({ kind: 'build' }), hints).error || ''));
    ok('1i touches with .. -> error', /bad touches/.test(propose.validate(P({ touches: ['../x'] }), hints).error || ''));
    ok('1j absolute touches -> error', /bad touches/.test(propose.validate(P({ touches: [path.join(tmp, 'x')] }), hints).error || ''));
    ok('1k bad from -> error', /bad from/.test(propose.validate(P({ from: 'a b' }), hints).error || ''));
    ok('1l the error names the entry (#2)', /^#2: /.test(propose.validate([P(), P({ type: 'x' })], hints).error || ''));
    ok('1m empty array -> error', !!propose.validate([], hints).error);
  }

  // --- 2. who proposed ---------------------------------------------------------------------------------------------
  {
    const items = [
      { id: 'r-i1-aaaa', status: 'active', no: 'AT-3', tabId: '11111111-1111-4111-8111-111111111111' },
      { id: 'bManual', status: 'active', no: 'AT-4', tabId: null },
      { id: 'r-x-bbbb', status: 'done', no: 'AT-2', tabId: '22222222-2222-4222-8222-222222222222' },
    ];
    const a = propose.whoProposed('r-x-bbbb', items);
    ok('2a from = a backlog item of the folder (done too) -> its id / no / tabId', a.backlogId === 'r-x-bbbb' && a.no === 'AT-2' && a.tabId.startsWith('2222'), a);
    const b = propose.whoProposed(null, items);
    ok('2b no from, one active routed item -> that one', b.backlogId === 'r-i1-aaaa' && b.no === 'AT-3', b);
    const c = propose.whoProposed(null, [...items, { id: 'r-x-cccc', status: 'active' }]);
    ok('2c no from, two active routed items -> unknown', c.backlogId === null, c);
    const d = propose.whoProposed('r-zzz', items);
    ok('2d unknown from -> unknown (not guessed)', d.backlogId === null, d);
  }

  // --- 3. inbox: session source, origin, limits, duplicates -----------------------------------------------------------
  const W = mk('work', 'agent_terminal');
  const W2 = mk('work', 'other');
  const inboxFile = path.join(tmp, 'inbox.json');
  const events = [];
  const inbox = inboxStore.createInbox(inboxFile, { onChange: (_s, info) => events.push(info) });
  const bl = [{ id: 'r-i1-aaaa', status: 'active', no: 'AT-3', tabId: '11111111-1111-4111-8111-111111111111' }];
  {
    const v = propose.validate([P({ title: 'テストを足す', text: '指示文 A', kind: 'verify', touches: ['tmp/x/'] }), P({ title: '文書を直す', text: '指示文 B' })], hints);
    const r = propose.apply({ folder: W, proposals: v.proposals, backlogItems: bl, inbox });
    ok('3a two added', r.results && r.results.length === 2 && r.results.every((x) => x.itemId && !x.duplicate), r);
    const it = inbox.find(r.results[0].itemId);
    ok('3b source session, statusBy session, status new', it.source === 'session' && it.statusBy === 'session' && it.status === 'new', it);
    ok('3c title kept, folder = the session folder', it.title === 'テストを足す' && it.folder === W, it);
    ok('3d origin: folder, backlogId, no, tabId, reason, kind, touches', it.origin && it.origin.folder === W && it.origin.backlogId === 'r-i1-aaaa' && it.origin.no === 'AT-3' && it.origin.tabId.startsWith('1111') && it.origin.reason === 'テストが足りない' && it.origin.kind === 'verify' && it.origin.touches[0] === 'tmp/x/', it.origin);
    ok('3e it got a 依頼-N', /^依頼-\d+$/.test(it.reqNo), it.reqNo);
    ok('3f onChange add with source session', events.some((e) => e.type === 'add' && e.source === 'session'));
    ok('3g no history (not a ルーター change, nothing to undo)', it.history.length === 0);
    // duplicates
    const again = propose.apply({ folder: W, proposals: propose.validate([P({ title: 'テストを足す', text: '別の本文' }), P({ title: '新しい', text: '指示文 B' })], hints).proposals, backlogItems: bl, inbox });
    ok('3h same title (same folder) / same text -> duplicate, names the existing id', again.results.every((x) => x.duplicate) && again.results[0].itemId === r.results[0].itemId && again.results[1].itemId === r.results[1].itemId, again);
    const inFile = propose.apply({ folder: W, proposals: propose.validate([P({ title: 'C', text: '指示文 C' }), P({ title: 'C2', text: '指示文 C' })], hints).proposals, backlogItems: bl, inbox });
    ok('3i duplicate inside one file -> the first added, the second names it', !inFile.results[0].duplicate && inFile.results[1].duplicate && inFile.results[1].itemId === inFile.results[0].itemId, inFile);
    const user = inbox.add({ text: 'ユーザーの依頼の本文' });
    const vsUser = propose.apply({ folder: W, proposals: propose.validate(P({ title: 'U', text: 'ユーザーの依頼の本文' }), hints).proposals, backlogItems: bl, inbox });
    ok('3j the same text as an open user request -> duplicate of it', vsUser.results[0].duplicate && vsUser.results[0].itemId === user.id, vsUser);
    const other = propose.apply({ folder: W2, proposals: propose.validate(P({ title: 'テストを足す', text: '別のフォルダの本文' }), hints).proposals, backlogItems: [], inbox });
    ok('3k same title from another folder -> not a duplicate', !other.results[0].duplicate, other);
    ok('3l another folder, nothing active -> origin.backlogId null', inbox.find(other.results[0].itemId).origin.backlogId === null);
    inbox.update(r.results[0].itemId, { status: 'dropped' }, { source: 'manager' });
    const afterDrop = propose.apply({ folder: W, proposals: propose.validate(P({ title: 'テストを足す', text: '指示文 A' }), hints).proposals, backlogItems: bl, inbox });
    ok('3m a dropped one does not count as a duplicate', !afterDrop.results[0].duplicate, afterDrop);
    // per-work limit: AT-3 has 4 proposals now (A, B, C, A again) -> 6 more would be 10, 7 more 11
    const n = inbox.get().items.filter((i) => i.origin && i.origin.backlogId === 'r-i1-aaaa').length;
    // checked proposals as validate makes them (more than one file's 5, as if several files came in)
    const many = (k, tag) => Array.from({ length: k }, (_, j) => ({ title: `${tag}${j}`, text: `${tag} 本文 ${j}`, reason: '', from: null, fields: {} }));
    const workOf = () => inbox.get().items.filter((i) => i.origin && i.origin.backlogId === 'r-i1-aaaa');
    const over = propose.apply({ folder: W, proposals: many(propose.PER_WORK - n + 1, 'M').map((p) => ({ ...p, from: 'r-i1-aaaa' })), backlogItems: bl, inbox });
    const overItems = (over.results || []).map((x) => inbox.find(x.itemId));
    ok(`3n more than ${propose.PER_WORK} from one work -> the ones up to ${propose.PER_WORK} new, the one over it hold (note 上限を超えた propose), result hold: true`, !over.error && overItems.length === propose.PER_WORK - n + 1 && overItems.slice(0, -1).every((i) => i.status === 'new') && overItems.at(-1).status === 'hold' && overItems.at(-1).note.startsWith('上限を超えた propose') && /この作業 AT-3 の上限 10 件/.test(overItems.at(-1).note) && over.results.at(-1).hold === true && !over.results[0].hold, over);
    const runaway = propose.apply({ folder: W, proposals: many(propose.PER_WORK * propose.HOLD_FACTOR - workOf().length + 1, 'R').map((p) => ({ ...p, from: 'r-i1-aaaa' })), backlogItems: bl, inbox });
    ok(`3n2 more than ${propose.HOLD_FACTOR} x ${propose.PER_WORK} from one work (runaway) -> error, nothing added`, /too many proposals from the work/.test(runaway.error || '') && workOf().length === propose.PER_WORK + 1, runaway);
    // per-folder day limit (with an unknown work, so only the folder limit applies); W2 has 1 session item (3k)
    const before = inbox.get().items.length;
    const day = propose.apply({ folder: W2, proposals: many(propose.PER_FOLDER_DAY, 'D'), backlogItems: [], inbox });
    const dayItems = (day.results || []).map((x) => inbox.find(x.itemId));
    ok(`3o more than ${propose.PER_FOLDER_DAY} from one folder in 24 h -> up to ${propose.PER_FOLDER_DAY} new, the rest hold`, !day.error && inbox.get().items.length === before + propose.PER_FOLDER_DAY && dayItems.filter((i) => i.status === 'new').length === propose.PER_FOLDER_DAY - 1 && dayItems.at(-1).status === 'hold' && /このフォルダの 24 時間の上限 30 件/.test(dayItems.at(-1).note), day.error || dayItems.map((i) => i.status).join(','));
    const dayRun = propose.apply({ folder: W2, proposals: many(propose.PER_FOLDER_DAY * propose.HOLD_FACTOR - propose.PER_FOLDER_DAY, 'E'), backlogItems: [], inbox });
    ok(`3o2 past ${propose.HOLD_FACTOR} x ${propose.PER_FOLDER_DAY} from one folder in 24 h (runaway) -> error naming the limit, nothing added`, /today .*limit 30, held up to 90/.test(dayRun.error || '') && inbox.get().items.length === before + propose.PER_FOLDER_DAY, dayRun);
    // sanitize keeps origin through a reload; a non-session item has no origin
    await sleep(50);
    inbox.saveSync?.();
    const re = inboxStore.sanitizeInbox(JSON.parse(fs.readFileSync(inboxFile, 'utf8')));
    const back = re.items.find((i) => i.id === r.results[1].itemId);
    ok('3p origin survives a save + load', back && back.origin && back.origin.backlogId === 'r-i1-aaaa' && back.source === 'session', back);
    ok('3q a user item has no origin field', !('origin' in re.items.find((i) => i.id === user.id)));
    ok('3r origin with a relative folder is dropped', inboxStore.sanitizeItem({ id: 'ix', source: 'session', origin: { folder: 'rel' } }).origin === null);
    ok('3s a renderer add cannot claim source session fields', (() => {
      const it2 = inbox.add({ text: 'renderer の追加', title: 'x' });
      return it2.source === 'user' && it2.title === '' && it2.origin === undefined;
    })());
  }

  // --- 4. the folder outbox: processFile and watch ------------------------------------------------------------------
  {
    const F = mk('work', 'proj');
    const out = propose.ensureOutbox(F);
    ok('4a ensureOutbox -> .bantodesk/outbox + .gitignore *', out === path.join(F, '.bantodesk', 'outbox') && fs.readFileSync(path.join(F, '.bantodesk', '.gitignore'), 'utf8').trim() === '*');
    const inbox2 = inboxStore.createInbox(path.join(tmp, 'inbox2.json'));
    const added = [];
    const failed = [];
    const ctx = {
      inbox: inbox2,
      hints,
      backlogItems: async () => [{ id: 'r-x-1234', status: 'active', no: 'P-1', tabId: null }],
      onAdded: (folder, res) => added.push({ folder, res }),
      onFailed: (folder, name, err) => failed.push({ folder, name, err }),
    };
    fs.writeFileSync(path.join(out, 'a.json'), JSON.stringify([P({ title: 'A1', text: 'a1' }), P({ title: 'A2', text: 'a2' })]));
    const ra = await propose.processFile(path.join(out, 'a.json'), F, ctx);
    ok('4b processFile ok -> done/a.json + a.json.result.json with the ids', ra.ok && fs.existsSync(path.join(out, 'done', 'a.json')) && JSON.parse(fs.readFileSync(path.join(out, 'done', 'a.json.result.json'), 'utf8')).length === 2, ra);
    ok('4c onAdded called, items in the inbox with origin.no P-1', added.length === 1 && inbox2.get().items.length === 2 && inbox2.get().items[0].origin.no === 'P-1');
    fs.writeFileSync(path.join(out, 'b.json'), '{ not json');
    const rb = await propose.processFile(path.join(out, 'b.json'), F, ctx);
    ok('4d bad JSON -> failed/b.json + .error.txt', !rb.ok && fs.existsSync(path.join(out, 'failed', 'b.json')) && /invalid JSON/.test(fs.readFileSync(path.join(out, 'failed', 'b.json.error.txt'), 'utf8')) && failed.length === 1);
    fs.writeFileSync(path.join(out, 'c.json'), JSON.stringify([1, 2, 3, 4, 5, 6].map((k) => P({ title: 'C' + k, text: 'c' + k }))));
    const rc = await propose.processFile(path.join(out, 'c.json'), F, ctx);
    ok('4e 6 proposals -> failed, nothing added', !rc.ok && /max 5/.test(fs.readFileSync(path.join(out, 'failed', 'c.json.error.txt'), 'utf8')) && inbox2.get().items.length === 2);
    // watch: picks up a file once it is settled (>= 1 s old and the same size twice)
    const w = propose.watch(() => [F, path.join(tmp, 'missing')], ctx, { intervalMs: 60_000 });
    fs.writeFileSync(path.join(out, 'd.json'), JSON.stringify(P({ title: 'D', text: 'd' })));
    await w.tick();
    ok('4f watch: a brand-new file is not taken on the first look', fs.existsSync(path.join(out, 'd.json')));
    await sleep(1100);
    await w.tick();
    ok('4g watch: taken on a later look (done/)', !fs.existsSync(path.join(out, 'd.json')) && fs.existsSync(path.join(out, 'done', 'd.json')) && inbox2.get().items.length === 3);
    fs.writeFileSync(path.join(out, 'x.result.json'), '[]');
    await w.tick();
    await sleep(1100);
    await w.tick();
    ok('4h watch: *.result.json in the outbox top is left alone', fs.existsSync(path.join(out, 'x.result.json')));
    w.close();
  }

  // --- 5. the ルーター: the new-work line and CLAUDE.md -------------------------------------------------------------------
  {
    const bdir = mk('backlog');
    const mdir = mk('manager');
    const item = inbox.get().items.find((i) => i.source === 'session' && i.origin.no === 'AT-3' && i.status === 'new');
    const userItem = inbox.get().items.find((i) => i.source === 'user');
    await manager.notifyManager(bdir, mdir, { newItems: [userItem, item] });
    const st = await backlog.getBacklog(bdir, mdir);
    const p = st.items.find((i) => manager.isInboxPrompt(i.text));
    ok('5a the ルーター prompt lists the session item as 新規 with [セッションから: agent_terminal AT-3]', p && p.text.includes(`[セッションから: agent_terminal AT-3] ${item.id}`), p && p.text);
    ok('5b the user item has no such mark', p && p.text.includes(`、${userItem.id}`) === false && p.text.includes(`新規: ${userItem.id}`), p && p.text);
    manager.ensureManagerDir(mdir);
    const md = fs.readFileSync(path.join(mdir, 'CLAUDE.md'), 'utf8');
    ok('5c CLAUDE.md version >= 26', manager.CLAUDE_MD_VERSION >= 26 && md.includes(`manager v${manager.CLAUDE_MD_VERSION}`));
    ok('5d source session + origin documented', md.includes('session〈振り分けたセッションが出した') && md.includes('origin'));
    ok('5e section: セッションから出た依頼 (fit the goal, duplicates, route / inbox-merge / hold / dropped / qa)', /## セッションから出た依頼[\s\S]*目的に合っているか[\s\S]*重複[\s\S]*route[\s\S]*inbox-merge[\s\S]*hold[\s\S]*dropped[\s\S]*qa/.test(md));
    ok('5f section: 似た依頼をまとめて 1 セッションにする (依頼-54) with inbox-merge + inbox-edit + route', /## 似た依頼をまとめて 1 セッションにする[\s\S]*inbox-merge[\s\S]*inbox-edit[\s\S]*route/.test(md));
    ok('5g the old "ask the user to open the tab" proposal is gone (依頼-71)', !md.includes('ユーザーにタブを開いてリーダーへ伝えてほしい文面'));
    ok('5h stopped session: no proposal to open the tab, wait for failed and re-route; 後押し 2 回まで', md.includes('ユーザーに「タブを開いて伝えて」と提案しない') && md.includes('後押しは同じ作業に 2 回まで'));
    ok('5i template has no unescaped template breakage (inline code kept)', md.includes('`inbox-merge` で残す側に統合する'));
  }

  // --- 6. the routed-session preface -------------------------------------------------------------------------------------
  {
    const file = path.join(root, 'docs', 'prompts', 'routed-session.md');
    const t = launcher.routedPrompt(file);
    ok('6a preface: do not start the next work yourself', t.includes('続きの作業を自分で始めない'));
    ok('6b preface: small fixes inside the scope are fine', t.includes('小さな直し（テストの直し、書き漏れ）'));
    ok('6c preface: outside the scope / over 1 h / other files -> propose; 迷ったら出す', t.includes('1 時間を超える') && t.includes('propose') && t.includes('迷ったら出す'));
    ok('6d preface: where and how (.bantodesk/outbox, 5 件まで, fields, from)', t.includes('.bantodesk/outbox/') && t.includes('5 件まで') && /type（propose と書く）[\s\S]*title[\s\S]*text[\s\S]*reason[\s\S]*from/.test(t));
    ok('6e preface: then end with 作業完了', t.includes('出した後は、今の作業を区切りよく終えて 作業完了 で終える'));
    ok('6f preface: no double quotes (PowerShell start), under 4000 chars', !t.includes('"') && t.length < 4000, t.length);
    ok('6g fallback has the propose lines too', launcher.ROUTED_PROMPT_FALLBACK.includes('.bantodesk/outbox/') && launcher.ROUTED_PROMPT_FALLBACK.includes('迷ったら出す'));
    ok('6h the preface still ends with the 作業完了 rule', /作業完了 の 1 行だけを書く[^\n]*$/.test(t));
    const tailRule = /バックグラウンドの見張りに tail -f \/ tail -F を使わない[^\n]*コマンドの完了の通知を待ち[^\n]*その都度 tail -n で読む/;
    ok('6i preface: no tail -f / tail -F for a background watch, wait for the completion notice, read with tail -n', tailRule.test(t), t.length);
    ok('6j fallback has the same tail -f line', tailRule.test(launcher.ROUTED_PROMPT_FALLBACK));
  }

  // --- 7. the limits go to hold (依頼 2026-11-16), the folder limit from manager-settings.json ------------------------------
  {
    ok('7a default limit 30, hold factor 3, note 上限を超えた propose', propose.PER_FOLDER_DAY === 30 && propose.HOLD_FACTOR === 3 && propose.HOLD_NOTE === '上限を超えた propose');
    ok('7b dayLimitOf: missing / bad / out of range -> 30, a whole number in 1..1000 -> it', propose.dayLimitOf(null) === 30 && propose.dayLimitOf({}) === 30 && propose.dayLimitOf({ proposeDayMax: 'x' }) === 30 && propose.dayLimitOf({ proposeDayMax: 0 }) === 30 && propose.dayLimitOf({ proposeDayMax: 2.5 }) === 30 && propose.dayLimitOf({ proposeDayMax: 1001 }) === 30 && propose.dayLimitOf({ proposeDayMax: 5 }) === 5 && propose.dayLimitOf({ proposeDayMax: '12' }) === 12);
    const sdir = mk('settings');
    ok('7c readDayLimit: no manager-settings.json -> 30', propose.readDayLimit(sdir) === 30);
    fs.writeFileSync(path.join(sdir, 'manager-settings.json'), JSON.stringify({ workRoot: '/x', proposeDayMax: 3 }));
    ok('7d readDayLimit: manager-settings.json proposeDayMax 3 -> 3', propose.readDayLimit(sdir) === 3);
    const ib = inboxStore.createInbox(path.join(sdir, 'inbox.json'));
    ok('7e the inbox tells its file; dayLimitFor reads the settings next to it', ib.file === path.join(sdir, 'inbox.json') && propose.dayLimitFor({ inbox: ib }) === 3);
    ok('7f dayLimitFor: ctx.dayLimit (number / function) wins, a bad one -> 30, nothing -> 30', propose.dayLimitFor({ inbox: ib, dayLimit: 7 }) === 7 && propose.dayLimitFor({ inbox: ib, dayLimit: () => 9 }) === 9 && propose.dayLimitFor({ inbox: ib, dayLimit: -1 }) === 30 && propose.dayLimitFor({}) === 30 && propose.dayLimitFor({ settingsDir: sdir }) === 3);
    ok('7s 依頼-414: DAY_MAX_RANGE 1..1000 exported (the settings screen bounds)', Array.isArray(propose.DAY_MAX_RANGE) && propose.DAY_MAX_RANGE[0] === 1 && propose.DAY_MAX_RANGE[1] === 1000);
    {
      const mainSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
      const pre = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'preload.js'), 'utf8');
      const st = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'settings.js'), 'utf8');
      ok('7t 依頼-414: main saves proposeDayMax (other keys kept), preload / settings screen use it', /ipcMain\.handle\('propose:setSettings'/.test(mainSrc) && /\.\.\.loadManagerSettings\(\), proposeDayMax: n/.test(mainSrc) && /setProposeSettings/.test(pre) && /num\('proposeDayMax'/.test(st));
    }
    // apply with dayMax 3: exactly 3 -> all new; the 4th -> hold
    const F = mk('work', 'limit');
    const many = (k, tag) => Array.from({ length: k }, (_, j) => ({ title: `${tag}${j}`, text: `${tag} 本文 ${j}`, reason: '', from: null, fields: {} }));
    const r3 = propose.apply({ folder: F, proposals: many(3, 'L'), backlogItems: [], inbox: ib, dayMax: 3 });
    ok('7g exactly the limit (3 of 3) -> all new, no hold', !r3.error && r3.results.length === 3 && r3.results.every((x) => !x.hold && ib.find(x.itemId).status === 'new'), r3);
    const r4 = propose.apply({ folder: F, proposals: many(2, 'K'), backlogItems: [], inbox: ib, dayMax: 3 });
    const held = r4.results && ib.find(r4.results[1].itemId);
    ok('7h over the limit -> added as hold, note 上限を超えた propose（このフォルダの 24 時間の上限 3 件を超えた）, source / statusBy session, origin kept', !r4.error && r4.results.every((x) => x.hold === true && x.itemId) && held.status === 'hold' && held.note === '上限を超えた propose（このフォルダの 24 時間の上限 3 件を超えた）' && held.source === 'session' && held.statusBy === 'session' && held.origin && held.origin.folder === F && held.history.length === 0, held);
    ok('7i the result names hold + the note', r4.results[0].note === held.note && /^依頼-\d+$/.test(r4.results[0].reqNo || ''), r4.results[0]);
    const dupHeld = propose.apply({ folder: F, proposals: [{ title: 'other', text: 'K 本文 1', reason: '', from: null, fields: {} }], backlogItems: [], inbox: ib, dayMax: 3 });
    ok('7j the same text as a held one -> duplicate (hold is open)', dupHeld.results[0].duplicate === true && dupHeld.results[0].itemId === held.id, dupHeld);
    const run = propose.apply({ folder: F, proposals: many(5, 'Z'), backlogItems: [], inbox: ib, dayMax: 3 });
    ok('7k past 3 x the limit (5 + 5 > 9) -> refused, nothing added', /too many proposals from this folder today \(5 in 24 h, limit 3, held up to 9\)/.test(run.error || '') && ib.get().items.length === 5, run);
    ok('7l a renderer / user add cannot set hold or a note', (() => {
      const u = ib.add({ text: 'ユーザーの保留', status: 'hold', note: 'n' });
      return u.status === 'new' && u.note === '';
    })());
    // processFile: the limit comes from manager-settings.json next to the inbox; hold -> done/ with hold in the result
    const G = mk('work', 'limit-file');
    const out = propose.ensureOutbox(G);
    const ib2 = inboxStore.createInbox(path.join(sdir, 'inbox2.json')); // same dir: proposeDayMax 3
    const added = [];
    const failed = [];
    const ctx = { inbox: ib2, hints, backlogItems: async () => [], onAdded: (f, res) => added.push(res), onFailed: (f, n, e) => failed.push(e) };
    fs.writeFileSync(path.join(out, 'p1.json'), JSON.stringify([1, 2, 3, 4].map((k) => P({ title: 'P' + k, text: 'p' + k }))));
    const rp = await propose.processFile(path.join(out, 'p1.json'), G, ctx);
    const res1 = JSON.parse(fs.readFileSync(path.join(out, 'done', 'p1.json.result.json'), 'utf8'));
    ok('7m processFile, setting 3, 4 in a file -> done/, result: 3 without hold, the 4th hold: true + note', rp.ok && res1.length === 4 && res1.slice(0, 3).every((x) => !x.hold) && res1[3].hold === true && res1[3].note.startsWith('上限を超えた propose') && !fs.existsSync(path.join(out, 'failed', 'p1.json')), res1);
    ok('7n the inbox: 3 new + 1 hold; onAdded got all 4', ib2.get().items.filter((i) => i.status === 'new').length === 3 && ib2.get().items.filter((i) => i.status === 'hold').length === 1 && added.length === 1 && added[0].length === 4);
    fs.writeFileSync(path.join(out, 'p2.json'), JSON.stringify(P({ title: 'bad', text: 'x', folder: '/elsewhere' })));
    const rb = await propose.processFile(path.join(out, 'p2.json'), G, ctx);
    ok('7o a bad shape over the limit -> still failed/ + .error.txt, nothing added', !rb.ok && fs.existsSync(path.join(out, 'failed', 'p2.json')) && /folder is not accepted/.test(fs.readFileSync(path.join(out, 'failed', 'p2.json.error.txt'), 'utf8')) && ib2.get().items.length === 4 && failed.length === 1);
    // the setting changed -> the next file uses it (no restart); a setting of 10 lets the next ones in as new
    fs.writeFileSync(path.join(sdir, 'manager-settings.json'), JSON.stringify({ workRoot: '/x', proposeDayMax: 10 }));
    fs.writeFileSync(path.join(out, 'p3.json'), JSON.stringify(P({ title: 'P5', text: 'p5' })));
    await propose.processFile(path.join(out, 'p3.json'), G, ctx);
    const res3 = JSON.parse(fs.readFileSync(path.join(out, 'done', 'p3.json.result.json'), 'utf8'));
    ok('7p the setting raised to 10 -> the next file is new (read for every file)', res3.length === 1 && !res3[0].hold && ib2.find(res3[0].itemId).status === 'new', res3);
    // default 30 when there is no setting: 30 new, the 31st hold
    const sdir2 = mk('settings-none');
    const ib3 = inboxStore.createInbox(path.join(sdir2, 'inbox.json'));
    const H = mk('work', 'limit-default');
    const out3 = propose.ensureOutbox(H);
    const ctx3 = { inbox: ib3, hints, backlogItems: async () => [] };
    for (let k = 0; k < 7; k++) {
      fs.writeFileSync(path.join(out3, `d${k}.json`), JSON.stringify([0, 1, 2, 3, 4].map((j) => P({ title: `D${k}-${j}`, text: `d${k}-${j}` }))));
      await propose.processFile(path.join(out3, `d${k}.json`), H, ctx3);
    }
    const st3 = ib3.get().items;
    ok('7q no setting -> default 30: 35 proposals = 30 new + 5 hold, all files done/', st3.length === 35 && st3.filter((i) => i.status === 'new').length === 30 && st3.filter((i) => i.status === 'hold').length === 5 && st3.slice(30).every((i) => i.status === 'hold') && fs.readdirSync(path.join(out3, 'done')).filter((n) => !/result/.test(n)).length === 7, st3.map((i) => i.status).join(','));
    // the patrol's near-limit line tells hold, not failed/
    const pg = require(path.join(root, 'src/main/patrol-gaps'));
    const near = pg.findProposals([], [{ folder: H, day: 26, max: 30 }]);
    ok('7r patrol: near the limit says the rest go to the inbox as 保留 (not outbox/failed/)', near.length === 1 && /保留（note「上限を超えた propose」）で入る/.test(near[0].text) && !/failed/.test(near[0].text), near);
    // the ルーター template line
    const mdir = mk('manager-limit');
    manager.ensureManagerDir(mdir);
    const md = fs.readFileSync(path.join(mdir, 'CLAUDE.md'), 'utf8');
    ok('7s ルーター CLAUDE.md v37+: over the limit -> hold (note 上限を超えた propose), picked up at the stocktake', manager.CLAUDE_MD_VERSION >= 37 && /上限を超えただけの propose は依頼に hold（note「上限を超えた propose」）で入る/.test(md) && /棚卸しの保留の一覧/.test(md));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  clearTimeout(kill);
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.log('FAIL crashed', err && err.stack);
  process.exit(1);
});
