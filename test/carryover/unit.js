// AT-carryover: 別の環境で開いたフォルダの積み残しを依頼に出す（src/main/carryover.js）と、PROGRESS.md の読み取りの上限の直し。
//   A progress.js: 64 KB を超える PROGRESS.md（a real project は 11-05〜11-13 に 124 KB）と 100 行を超える表が読める
//   B collect: 進行中 → 確認待ち → 保留 → 未着手 の順、完了は出ない。docs/roadmap.md の PROGRESS.md に無い行は 未着手 で後ろに。
//     空行で割れた表は続けて読み、次の表の見出しは行にしない。roadmap の 状態 列が 完了 の行は出ない
//   C plan: 自動は「この userData で取り込んだ記録が無い」かつ「バックログが空（dropped は数えない）」のときだけ。
//     手動はいつでも。取り込み済み・依頼にある（取り込みの印）・バックログの pending / active の番号は出さない。上限 30
//   D inboxItemOf + inbox.add(source app): hold・source app・statusBy app・folder・取り込みの印・履歴「アプリが取り込み」、
//     読み直しても source app のまま。renderer からの source は main が捨てる（inbox:add は text だけ渡す）
//   E manager.notifyManager({ imported }) -> PMO のバックログの指示文に「取り込みの候補: …」。雛形 v24 に「積み残しの取り込み」
//   F carryover.json の保存と読み直し、record
// node tmp/carryover/unit.js   （打ち切り 60 秒。AT_APP_ROOT = 別のアプリのフォルダ〈stable の確認〉）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

setTimeout(() => {
  console.log('TIMEOUT');
  process.exit(2);
}, 60000).unref();

const appRoot = process.env.AT_APP_ROOT || path.join(__dirname, '..', '..');
const src = (m) => require(path.join(appRoot, 'src', 'main', m));
const progress = src('progress');
const carryover = src('carryover');
const inboxStore = src('inbox');
const manager = src('manager');
const backlog = src('backlog');

let pass = 0;
let fail = 0;
const ok = (name, cond, ev = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${ev !== '' ? '  | ' + (typeof ev === 'string' ? ev : JSON.stringify(ev)).slice(0, 400) : ''}`);
};

const base = fs.mkdtempSync(path.join(__dirname, 'w-'));
const mk = (rel, text) => {
  const f = path.join(base, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
};
const head = '# 進捗\n\n| # | 項目 | 状態 | 次の一手 | 更新日 |\n|---|---|---|---|---|\n';
const row = (n, item, st, next = '—', d = '2026-11-12') => `| ${n} | ${item} | ${st} | ${next} | ${d} |\n`;

(async () => {
  try {
    // --- A ---------------------------------------------------------------------------------------------------------------
    const long = 'あ'.repeat(1400); // ~4 KB per row in UTF-8
    let big = head;
    for (let i = 1; i <= 40; i++) big += row(`T${i}`, `項目 ${i}`, i === 7 ? '進行中' : i % 10 === 0 ? '確認待ち' : '完了', long);
    mk('big/PROGRESS.md', big);
    ok('A0 the big PROGRESS.md is over the old 64 KB limit', Buffer.byteLength(big) > 64 * 1024, Buffer.byteLength(big));
    const pb = progress.readProgress(path.join(base, 'big'));
    ok('A1 a PROGRESS.md over 64 KB is read (was null -> projects.json progress empty)', !!pb && pb.total === 40 && pb.counts['進行中'] === 1 && pb.counts['確認待ち'] === 4, pb && { total: pb.total, counts: pb.counts });
    let many = head;
    for (let i = 1; i <= 130; i++) many += row(`R${i}`, `行 ${i}`, i > 120 ? '未着手' : '完了');
    mk('many/PROGRESS.md', many);
    const pm = progress.readProgress(path.join(base, 'many'));
    ok('A2 a table over 100 rows is counted whole (was cut at 100)', !!pm && pm.total === 130 && pm.counts['未着手'] === 10, pm && { total: pm.total, counts: pm.counts });
    const sum = progress.progressSummary(path.join(base, 'big'));
    ok('A3 progressSummary of the big file has waiting rows', !!sum && sum.waitingCount === 4 && sum.inProgress.length === 1, sum && { waitingCount: sum.waitingCount });

    // --- B ---------------------------------------------------------------------------------------------------------------
    const W = path.join(base, 'work');
    mk('work/PROGRESS.md', head +
      row('1', '準備', '完了') +
      row('2', '未着手のもの', '未着手', 'まず設計') +
      row('3', '保留のもの', '保留', '条件待ち') +
      row('4', '進めているもの', '進行中', '続きを書く') +
      row('5', '確かめるもの', '確認待ち', 'stable で回す') +
      row('6', '終わったもの', '完了'));
    mk('work/docs/roadmap.md', '# 計画\n\n| # | 項目 | 規模 |\n|---|---|---|\n| 1 | 準備 | 小 |\n| 2 | 未着手のもの | 中 |\n| 7 | 計画だけにあるもの | 大 |\n\n| 8 | 空行のあとの行 | 中 |\n\n' +
      '## 別の表\n\n| # | 項目 | 状態 |\n|---|---|---|\n| 9 | 状態の列で完了 | 完了 |\n| 10 | 状態の列で未着手 | 未着手 |\n');
    const cands = carryover.collect(W);
    const keys = cands.map((c) => c.key);
    ok('B1 order 進行中 → 確認待ち → 保留 → 未着手, 完了 left out', keys.slice(0, 4).join(',') === 'PROGRESS.md#4,PROGRESS.md#5,PROGRESS.md#3,PROGRESS.md#2', keys);
    ok('B2 roadmap rows missing from PROGRESS.md come after, as 未着手', keys.slice(4).join(',') === 'docs/roadmap.md#7,docs/roadmap.md#8,docs/roadmap.md#10' && cands.slice(4).every((c) => c.state === '未着手'), keys);
    ok('B3 next / updated carried from PROGRESS.md', cands[0].next === '続きを書く' && cands[0].updated === '2026-11-12', cands[0]);
    const rm = carryover.parseRoadmap('| # | 項目 |\n|---|---|\n| 1 | a |\n\n| # | 項目 |\n|---|---|\n| 2 | b |\n');
    ok('B4 a second table after a blank line: its header is not a row', rm.map((r) => r.n).join(',') === '1,2', rm);
    ok('B5 no PROGRESS.md and no roadmap -> no candidates', carryover.collect(path.join(base, 'nothing')).length === 0);

    // --- C ---------------------------------------------------------------------------------------------------------------
    const empty = { folders: {} };
    const p1 = carryover.plan({ folder: W, backlogItems: [], inboxItems: [], state: empty });
    ok('C1 auto, no record, empty backlog -> runs with 7 candidates', p1.run && p1.add.length === 7 && p1.reason === '初めて開いた', p1);
    const p2 = carryover.plan({ folder: W, backlogItems: [{ id: 'a', status: 'done', no: 'X-1' }], state: empty });
    ok('C2 auto, backlog has an item (done) -> does not run', !p2.run && p2.reason === 'バックログが空でない', p2);
    const p3 = carryover.plan({ folder: W, backlogItems: [{ id: 'a', status: 'dropped' }], state: empty });
    ok('C3 auto, only dropped items -> runs', p3.run && p3.add.length === 7);
    const st = carryover.record({ folders: {} }, W, [{ key: 'PROGRESS.md#4', inboxId: 'i1' }]);
    const p4 = carryover.plan({ folder: W, state: st });
    ok('C4 auto, imported before on this userData -> does not run', !p4.run && p4.reason === '前に取り込んだ', p4);
    const p5 = carryover.plan({ folder: W.toUpperCase() === W ? W : W, state: st, manual: true });
    ok('C5 manual -> runs, the imported key is skipped', p5.run && p5.add.length === 6 && p5.skipped.some((s) => s.key === 'PROGRESS.md#4' && s.why === '取り込み済み'), p5.skipped);
    const inb = [{ status: 'hold', text: `x\n- ${carryover.MARK}: ${W}|PROGRESS.md#5` }, { status: 'dropped', text: `x\n- ${carryover.MARK}: ${W}|PROGRESS.md#3` }];
    const p6 = carryover.plan({ folder: W, manual: true, inboxItems: inb, backlogItems: [{ id: 'b', status: 'pending', no: '2' }, { id: 'c', status: 'done', no: '7' }], state: empty });
    const why = Object.fromEntries(p6.skipped.map((s) => [s.key, s.why]));
    ok('C6 manual: marked inbox item (not dropped) and pending backlog number skipped; dropped mark / done number not', why['PROGRESS.md#5'] === '依頼にある' && why['PROGRESS.md#2'] === 'バックログにある' && !why['PROGRESS.md#3'] && !why['docs/roadmap.md#7'] && p6.add.length === 5, why);
    let lots = head;
    for (let i = 1; i <= 45; i++) lots += row(`L${i}`, `残り ${i}`, '未着手');
    mk('lots/PROGRESS.md', lots);
    const p7 = carryover.plan({ folder: path.join(base, 'lots'), state: empty });
    ok('C7 at most 30 per import, the rest counted in more', p7.add.length === carryover.IMPORT_MAX && p7.more === 15, { add: p7.add.length, more: p7.more });

    // --- D ---------------------------------------------------------------------------------------------------------------
    const ibFile = path.join(base, 'inbox.json');
    const ib = inboxStore.createInbox(ibFile, {});
    const spec = carryover.inboxItemOf(W, cands[0], '2026-11-13');
    const it = ib.add({ ...spec, source: 'app' });
    ok('D1 the item: hold, source app, statusBy app, folder set, title "4 進めているもの"', it && it.status === 'hold' && it.source === 'app' && it.statusBy === 'app' && it.folder === W && it.title === '4 進めているもの', it);
    ok('D2 text has 目的 / 次の一手 / 取り込みの印 and the history says アプリが取り込み', /## 目的/.test(it.text) && /続きを書く/.test(it.text) && it.text.includes(`${carryover.MARK}: ${W}|PROGRESS.md#4`) && it.history[0].note === 'アプリが取り込み' && it.note.startsWith('取り込みの候補'), it.text);
    ok('D3 inboxKeys finds the mark', carryover.inboxKeys(ib.get().items, W).has('PROGRESS.md#4'));
    await ib.flush();
    const back = inboxStore.sanitizeInbox(JSON.parse(fs.readFileSync(ibFile, 'utf8')));
    ok('D4 read back: source app kept', back.items[0].source === 'app' && back.items[0].status === 'hold');
    const plain = ib.add({ text: 'ふつうの依頼' });
    ok('D5 a plain add stays source user / new', plain.source === 'user' && plain.status === 'new' && plain.folder === null);
    const mainSrc = fs.readFileSync(path.join(appRoot, 'src', 'main.js'), 'utf8');
    ok('D6 main: inbox:add passes only text; app adds do not raise the new-work line', /inbox\.add\(\{ text: o\.text \}\)/.test(mainSrc) && /info\.type === 'add' && \(info\.source === 'user' \|\| info\.source === 'session'\)\) notifyManager/.test(mainSrc)); // U7: a session's propose is new work too
    ok('D7 main: the automatic import is off under the e2e mark unless AGENT_TERMINAL_CARRYOVER=1', /isE2E\(\) && process\.env\.AGENT_TERMINAL_CARRYOVER !== '1'\) return/.test(mainSrc));

    // --- E ---------------------------------------------------------------------------------------------------------------
    const bdir = path.join(base, 'backlog');
    const mdir = path.join(base, 'manager');
    fs.mkdirSync(mdir, { recursive: true });
    const line = carryover.pmoLine(W, [{ reqNo: '依頼-3' }, { reqNo: '依頼-9' }], 2);
    ok('E1 pmoLine: count, range, more, what to do', /積み残し 2 件/.test(line) && /依頼-3〜依頼-9/.test(line) && /ほかに 2 件/.test(line) && /route \/ merge \/ drop/.test(line), line);
    await manager.notifyManager(bdir, mdir, { imported: line });
    const mb = await backlog.getBacklog(bdir, mdir);
    const pend = mb.items.find((i) => i.status === 'pending');
    ok('E2 the PMO prompt has 取り込みの候補', !!pend && pend.text.includes('（取り込みの候補: ') && pend.text.includes('依頼-3〜依頼-9'), pend && pend.text);
    manager.ensureManagerDir(mdir);
    const md = fs.readFileSync(path.join(mdir, 'CLAUDE.md'), 'utf8');
    ok('E3 template v24+ explains 積み残しの取り込み', manager.CLAUDE_MD_VERSION >= 24 && md.includes('積み残しの取り込み') && md.includes('取り込みの印'));

    // --- F ---------------------------------------------------------------------------------------------------------------
    const ud = path.join(base, 'ud');
    fs.mkdirSync(ud, { recursive: true });
    ok('F1 no carryover.json -> empty state', JSON.stringify(carryover.loadState(ud)) === '{"folders":{}}');
    carryover.saveState(ud, carryover.record(carryover.loadState(ud), W, [{ key: 'PROGRESS.md#4', inboxId: it.id }]));
    const s2 = carryover.loadState(ud);
    const rec = Object.values(s2.folders)[0];
    ok('F2 saved and read back: folder + key + inboxId; no temp file left', rec && rec.folder === W && rec.keys['PROGRESS.md#4'].inboxId === it.id && !fs.readdirSync(ud).some((n) => n.endsWith('.tmp')), s2);
  } catch (err) {
    ok('no exception', false, String(err && err.stack));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  console.log(`${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
