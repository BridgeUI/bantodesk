// Unit test for PM1 段 3 (docs/plan-pmo-models.md 6 章): node tmp/progress-check/unit.js   (AT_APP_ROOT = another app root)
//   G  collectGaps: done-open / pending-done / stale / no-check / bad-state, none for a folder that agrees, row # matching
//   P  parseFacts: structured_output, JSON inside result, garbage / is_error -> null
//   C  createProgressCheck with a fake haiku: no gap -> no call + no notice; gaps -> one call for all folders, one info per
//      folder (key app:progress:<folder>); the same gaps -> no call, the notice unchanged; haiku fails -> nothing shown;
//      invented rows / folders dropped; gaps gone -> resolved; gaps changed -> asked again, the same notice replaced
//   H  runHaiku with tmp/progress-check/fake-haiku.js (a real child process, not claude): prompt on stdin, the args
//      (-p --model haiku, no --bare), exit 1 / not JSON / no answer before the time limit -> not ok
//   A  the gaps to act on (依頼-188): actions() = done-open / pending-done whose row haiku listed; patrolFindings ->
//      one line each in pmo.formatPatrol, once per key (patrolDecision reported), again in the stocktake; stocktakeDue;
//      haiku fails -> the last actions stay; gaps gone -> none
//   I  intervalOf (default 60 min, 0 = off, clamped), normalizeMinutes / minutesOf / CHOICES (the settings screen, 依頼-189)
//   M  main.js wiring (the run before the stocktake, the IPC, off wins over the test interval), preload, settings.js
// No model is called.
const path = require('path');
const fs = require('fs');
const os = require('os');
const root = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.resolve(__dirname, '..', '..');
const PC = require(path.join(root, 'src', 'main', 'progress-check.js'));
const NS = require(path.join(root, 'src', 'main', 'notices.js'));
const PF = require(path.join(root, 'src', 'main', 'progress.js'));
const FAKE = path.join(__dirname, 'fake-haiku.js');
let pass = 0;
let fail = 0;
const ok = (name, c, ev = '') => {
  c ? pass++ : fail++;
  console.log(c ? 'PASS' : 'FAIL', name, ev !== '' ? '| ' + (typeof ev === 'string' ? ev : JSON.stringify(ev)).slice(0, 400) : '');
};
const DAY = 24 * 60 * 60 * 1000;
const now = new Date(2026, 10, 14, 12, 0, 0).getTime();
const table = (rows) => PF.parseProgress(['| # | 項目 | 状態 | 次の一手 | 更新日 |', '|---|---|---|---|---|', ...rows].join('\n'));

async function main() {
  // ---- G: gaps by code -------------------------------------------------------------------------
  const progA = table([
    '| AT-143 | 見回りの前さばき | 進行中 | 実装 | 2026-11-13 |',
    '| PM1-2 | 段 2 | 完了 | — | 2026-11-14 |',
    '| PM1 | 設計 | 進行中 | 書く | 2026-11-10 |',
    '| UX6 | 再描画 | 確認待ち | stable | 2026-11-14 |',
    '| UX7 | 何か | 確認待ち | stable | 2026-11-14 |',
    '| 9 | 一時セッション | なにこれ | — | 2026-11-14 |',
    '| 40 | 待ち | 未着手 | — | 2026-11-14 |',
  ]);
  const itemsA = [
    { id: 'r-a-1', no: 'AT-143', title: '見回りの前さばき', status: 'done', doneAt: now - DAY, text: '' },
    { id: 'r-a-2', title: '[PM1-2] 続き', status: 'pending', text: '' },
    { id: 'r-a-3', title: '40 分ごとに何か', status: 'done', doneAt: now - DAY, text: '' }, // 「40」 alone is not a row name
    { id: 'm-1', title: 'PM1 の起こし', status: 'done', doneAt: now, text: 'PM1' }, // manager item, skipped
  ];
  const gA = PC.collectGaps({ progress: progA, items: itemsA, now, checkList: new Set(['UX6']) });
  const kinds = gA.map((g) => `${g.row}:${g.kind}`).sort();
  ok('G1 done-open (AT-143 done, row 進行中)', kinds.includes('AT-143:done-open') && /AT-143 .*完了しているが.*「進行中」/.test(gA.find((g) => g.kind === 'done-open').fact), gA);
  ok('G2 pending-done (row PM1-2 完了, its item pending)', kinds.includes('PM1-2:pending-done'), kinds);
  ok('G3 stale (PM1 進行中 4 days, nothing active)', kinds.includes('PM1:stale') && /4 日更新がなく/.test(gA.find((g) => g.kind === 'stale').fact), kinds);
  ok('G4 no-check (UX7 確認待ち, not in run.mjs) but not UX6', kinds.includes('UX7:no-check') && !kinds.includes('UX6:no-check'), kinds);
  ok('G5 bad-state (row 9)', kinds.includes('9:bad-state'), kinds);
  ok('G6 nothing for 「40」 (digits only) / the m- item / PM1 vs PM1-2', !kinds.some((k) => k.startsWith('40:')) && kinds.filter((k) => k.startsWith('PM1:')).length === 1 && kinds.length === 5, kinds);
  const gActive = PC.collectGaps({ progress: progA, items: [...itemsA, { id: 'r-a-9', title: 'x', status: 'active', text: '' }], now, checkList: new Set(['UX6']) });
  ok('G7 an active item in the folder -> no stale', !gActive.some((g) => g.kind === 'stale'), gActive.map((g) => g.kind));
  const gNoList = PC.collectGaps({ progress: progA, items: itemsA, now, checkList: null });
  ok('G8 no run.mjs in the folder -> no no-check', !gNoList.some((g) => g.kind === 'no-check'));
  const progW = table(['| 23c | ime | 確認待ち | run.mjs --only 23（ime.mjs） | 2026-11-13 |', '| UX9-auto | auto | 確認待ち | stable で x | 2026-11-14 |', '| Q-1 | q | 確認待ち | node tmp/stable-check/run.mjs --only Z9,Q7 | 2026-11-14 |', '| R-1 | r | 確認待ち | x | 2026-11-14 |']);
  const gW = PC.collectGaps({ progress: progW, items: [], now, checkList: new Set(['23', 'UX9', 'Q7']) });
  ok('G8b no-check: --only <name> in 次の一手 / the # without its suffix count as listed (real run 2026-11-14)', gW.length === 1 && gW[0].row === 'R-1', gW.map((g) => g.row));
  const progOk = table(['| A-1 | x | 完了 | — | 2026-11-14 |', '| A-2 | y | 進行中 | z | 2026-11-14 |']);
  ok('G9 a folder that agrees -> no gap', PC.collectGaps({ progress: progOk, items: [{ id: 'r-1', no: 'A-1', status: 'done', doneAt: now }, { id: 'r-2', no: 'A-2', status: 'active' }], now }).length === 0);
  ok('G10 refersTo word bounds', PC.refersTo({ title: 'AT-143: 続き' }, 'AT-143') && !PC.refersTo({ title: 'AT-1430: x' }, 'AT-143') && !PC.refersTo({ title: 'AT-14: x' }, 'AT-143') && !PC.refersTo({ title: 'PM1-2: x' }, 'PM1') && PC.refersTo({ title: '[PM1] x' }, 'PM1'));
  // G11-G13: only explicit links (2026-11-17 patrol false alarms: U9 ← AT-34, UX18 ← AT-163; both rows really 未着手)
  const progFP = table([
    '| U2 | UIUX ダッシュボードを 4 タブに組み直す | 完了 | — | 2026-11-13 |',
    '| U9 | UIUX スマホのダッシュボード | 未着手 | 待ち: U3 の後に ルーターが振り分ける | 2026-11-05 |',
    '| UX10 | UX 止まらない B: アプリがその場で直す | 完了 | — | 2026-11-16 |',
    '| UX18 | UX 拡大率と狭い幅の仕上げ（80〜150%、720〜1440px） | 未着手 | UX17 の後 | 2026-11-16 |',
  ]);
  const itemsFP = [
    { id: 'r-imwfp034aaaaaaa-11111111', no: 'AT-34', title: 'U2 の続き 申し送りの残り', status: 'done', doneAt: now - DAY,
      text: 'U2 の申し送りの残りを片づける。U9（スマホのダッシュボード）は保留中の機能の依頼なので触らない。PROGRESS.md の U2 の行は完了のまま。' },
    { id: 'r-imwfp163bbbbbbb-22222222', no: 'AT-163', title: 'UX10 止まらない B（その場で直す）', status: 'done', doneAt: now - DAY,
      text: 'UX10 の B。拡大率と狭い幅は UX18 で UX17 の後にやるので、ここでは触らない。UX18 の行は変えない。' },
  ];
  const gFP = PC.collectGaps({ progress: progFP, items: itemsFP, now });
  ok('G11 the 2026-11-17 false alarms: no gap for U9 ← AT-34 nor UX18 ← AT-163', !gFP.some((g) => g.row === 'U9' || g.row === 'UX18'), gFP);
  ok('G11b refersTo: a row # only mentioned in the title / text is not a link', !PC.refersTo(itemsFP[0], progFP.rows[1]) && !PC.refersTo(itemsFP[1], progFP.rows[3]) && !PC.refersTo(itemsFP[0], progFP.rows[0]) && !PC.refersTo(itemsFP[1], progFP.rows[2]));
  const rowU9 = progFP.rows[1];
  ok('G12 explicit links: no, title label, 「PROGRESS.md の <行> を」',
    PC.refersTo({ id: 'r-x-1', no: 'U9' }, rowU9) &&
    PC.refersTo({ id: 'r-x-2', title: 'U9: スマホ' }, rowU9) && PC.refersTo({ id: 'r-x-3', title: '[U9] スマホ' }, rowU9) &&
    PC.refersTo({ id: 'r-x-4', title: 'x', text: '終えたら PROGRESS.md の U9 を確認待ちにする' }, rowU9) &&
    PC.refersTo({ id: 'r-x-5', title: 'x', text: 'PROGRESS.md の行 U9 を完了に' }, rowU9) &&
    PC.refersTo({ id: 'r-x-6', title: 'x', text: 'PROGRESS.md の「U9」の行を直す' }, rowU9) &&
    !PC.refersTo({ id: 'r-x-7', title: 'x', text: 'PROGRESS.md の U99 を直す' }, rowU9) &&
    !PC.refersTo({ id: 'r-x-8', title: 'x', text: 'PROGRESS.md の U9-2 を直す' }, rowU9));
  const progId = table(['| UX18 | 拡大率（r-imwfp777ccccccc-33333333） | 進行中 | 続き | 2026-11-16 |']);
  const itId = { id: 'r-imwfp777ccccccc-33333333', no: 'AT-190', title: '拡大率', status: 'done', doneAt: now - DAY, text: '' };
  ok('G13 the row carries the item work id -> linked (done-open)', PC.refersTo(itId, progId.rows[0]) && PC.collectGaps({ progress: progId, items: [itId], now }).some((g) => g.row === 'UX18' && g.kind === 'done-open'));
  // G15: C3O (2026-11-17) — a 完了 row whose 次の一手 names the pending follow-up work is no gap; the 項目 work id still links
  const progC3O = table(['| C3O | 停止条件の選択肢の調べもの（作業 r-imwjtw8d3d5a6dc-9c960338） | 完了 | 実装は SSA-263（r-imwk1lg0tfe5ede-5b12b41a、SSA-258 の実測の後） | 2026-11-17 |']);
  const itNext = { id: 'r-imwk1lg0tfe5ede-5b12b41a', no: 'SSA-263', title: '停止条件 3 を E＋F で実装', status: 'pending', text: '' };
  const itOwn = { id: 'r-imwjtw8d3d5a6dc-9c960338', no: 'SSA-250', title: '停止条件の選択肢', status: 'pending', text: '' };
  ok('G15 a pending follow-up in 次の一手 -> no pending-done', !PC.refersTo(itNext, progC3O.rows[0]) && !PC.collectGaps({ progress: progC3O, items: [itNext], now }).some((g) => g.row === 'C3O'));
  ok('G15b the 項目 work id pending -> pending-done as before', PC.collectGaps({ progress: progC3O, items: [itOwn], now }).some((g) => g.row === 'C3O' && g.kind === 'pending-done'));
  // G14: the old Windows rows renamed W-AT-N (2026-11-17: 「行 AT-192 は完了だが、バックログの AT-192 は pending」)
  const progWin = table(['| W-AT-192 | SEC3b の e2e（Windows の AT-192 を Mac で） | 完了 | — | 2026-11-17 |']);
  const itWin = { id: 'r-imwk0000aaaaaaa-11111111', no: 'AT-192', title: 'AT-192: モデルの既定', status: 'pending', text: 'PROGRESS.md の AT-192 を確認待ちにする' };
  ok('G14 a W-AT-N row is not linked to the backlog AT-N (no pending-done)', !PC.refersTo(itWin, progWin.rows[0]) && !PC.collectGaps({ progress: progWin, items: [itWin], now }).some((g) => g.row === 'W-AT-192'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'at-progress-check-'));
  try {
    fs.mkdirSync(path.join(work, 'f', 'tmp', 'stable-check'), { recursive: true });
    fs.writeFileSync(path.join(work, 'f', 'tmp', 'stable-check', 'run.mjs'), "const TESTS = [\n  { item: 'UX6', name: 'a' },\n  { item: '9', name: 'b' },\n];\n");
    const cl = PC.checkListOf(path.join(work, 'f'));
    ok('G11 checkListOf reads item: \'<n>\'', cl && cl.has('UX6') && cl.has('9') && cl.size === 2 && PC.checkListOf(path.join(work, 'none')) === null);

    // ---- P: parsing --------------------------------------------------------------------------
    const p1 = PC.parseFacts(JSON.stringify({ type: 'result', is_error: false, structured_output: { facts: [{ folder: 0, row: 'A', fact: ' x  y ' }] } }));
    const p2 = PC.parseFacts(JSON.stringify({ type: 'result', is_error: false, result: '```json\n{"facts":[{"folder":1,"row":"B","fact":"z"}]}\n```' }));
    ok('P1 structured_output / JSON inside result', p1 && p1[0].fact === 'x y' && p2 && p2[0].folder === 1 && p2[0].row === 'B', [p1, p2]);
    ok('P2 garbage / is_error / no facts -> null', PC.parseFacts('nope') === null && PC.parseFacts(JSON.stringify({ is_error: true, result: '{"facts":[]}' })) === null && PC.parseFacts(JSON.stringify({ result: 'hi' })) === null);

    // ---- C: the round -------------------------------------------------------------------------
    const notices = NS.createNotices(path.join(work, 'notices.json'));
    const fA = path.join(work, 'agent_terminal');
    const fB = path.join(work, 'other');
    const fC = path.join(work, 'quiet');
    let data = [
      { folder: fA, progress: progA, items: itemsA, checkList: new Set(['UX6']) },
      { folder: fB, progress: table(['| B-1 | b | 未着手 | — | 2026-11-14 |']), items: [{ id: 'r-b', no: 'B-1', status: 'done', doneAt: now - DAY }] },
      { folder: fC, progress: progOk, items: [] },
    ];
    let calls = [];
    let answer = (prompt) => {
      calls.push(prompt);
      const facts = [];
      let folder = -1;
      for (const line of prompt.split('\n')) {
        const h = /^## フォルダ (\d+):/.exec(line);
        if (h) folder = Number(h[1]);
        const m = /^- 行 (\S+) \(([\w-]+)\): (.+)$/.exec(line);
        if (m) facts.push({ folder, row: m[1], fact: m[3] });
      }
      facts.push({ folder: 0, row: 'NOPE', fact: 'invented row' }, { folder: 7, row: 'AT-143', fact: 'invented folder' });
      return JSON.stringify({ type: 'result', is_error: false, structured_output: { facts } });
    };
    const pc = PC.createProgressCheck({ notices, folders: async () => data, ask: async (p) => answer(p) });

    const r0 = await PC.createProgressCheck({ notices, folders: async () => [data[2]], ask: async () => { throw new Error('must not be called'); } }).runOnce(now);
    ok('C1 no gap anywhere -> haiku not called, no notice', r0.called === false && notices.list().length === 0, r0);

    const r1 = await pc.runOnce(now);
    const nA = notices.findKey(PC.KEY_PREFIX + fA);
    const nB = notices.findKey(PC.KEY_PREFIX + fB);
    ok('C2 gaps -> one call for all folders', r1.called && calls.length === 1 && /## フォルダ 0: agent_terminal/.test(calls[0]) && /## フォルダ 1: other/.test(calls[0]) && !/quiet/.test(calls[0]), r1);
    ok('C3 the prompt asks for facts only (no judgement / proposals)', /事実だけを書く/.test(calls[0]) && /提案/.test(calls[0]) && /\| AT-143 \| 見回りの前さばき \| 進行中 \|/.test(calls[0]));
    ok('C4 one info per folder with gaps, key app:progress:<folder>, source app', nA && nB && nA.kind === 'info' && nA.source === 'app' && nA.folder === fA && r1.shown === 2 && notices.list().length === 2, notices.list().map((n) => n.key));
    ok('C5 the text lists the rows; invented rows / folders dropped', /行 AT-143:/.test(nA.text) && /行 UX7:/.test(nA.text) && !/invented/.test(nA.text) && /5 件/.test(nA.title), nA.text);

    const before = JSON.stringify(notices.all());
    const r2 = await pc.runOnce(now + 1000);
    ok('C6 the same gaps -> haiku not called again, the notices unchanged', r2.called === false && calls.length === 1 && r2.shown === 0 && JSON.stringify(notices.all()) === before, r2);

    // gaps of A change (AT-143 row now 完了): asked again; A replaced in place (same id), B unchanged
    data = [{ ...data[0], progress: table(['| AT-143 | 見回りの前さばき | 完了 | — | 2026-11-14 |', '| UX7 | 何か | 確認待ち | stable | 2026-11-14 |']) }, data[1], data[2]];
    const r3 = await pc.runOnce(now + 2000);
    const nA2 = notices.findKey(PC.KEY_PREFIX + fA);
    ok('C7 changed gaps -> asked again, A replaced (same id, 1 件), B unchanged', r3.called && calls.length === 2 && nA2.id === nA.id && /1 件/.test(nA2.title) && !/AT-143/.test(nA2.text) && r3.shown === 1, r3);

    // haiku fails: nothing new, no throw; the next round asks again
    data = [{ ...data[0], items: [...itemsA, { id: 'r-a-7', no: 'UX8', status: 'done', doneAt: now }] }, data[1], data[2]];
    data[0].progress = table(['| UX8 | z | 進行中 | — | 2026-11-14 |']);
    const keep = JSON.stringify(notices.all());
    answer = (p) => (calls.push(p), null);
    const r4 = await pc.runOnce(now + 3000);
    ok('C8 haiku failed -> ok false, nothing shown or changed', r4.called && r4.ok === false && r4.shown === 0 && JSON.stringify(notices.all()) === keep, r4);
    answer = (p) => (calls.push(p), 'garbage');
    const r5 = await pc.runOnce(now + 4000);
    ok('C9 haiku not JSON -> asked again next round, still nothing shown', r5.called && r5.ok === false && calls.length === 4 && JSON.stringify(notices.all()) === keep, r5);
    answer = (p) => {
      throw new Error('x');
    };
    const r6 = await pc.runOnce(now + 5000);
    ok('C10 ask throws -> no throw out of runOnce', r6 && r6.ok === false);

    // every gap gone -> every app:progress info resolved
    data = [{ folder: fA, progress: progOk, items: [] }, { folder: fB, progress: progOk, items: [] }];
    const r7 = await pc.runOnce(now + 6000);
    ok('C11 gaps gone -> no call, the infos resolved', r7.called === false && r7.resolved === 2 && notices.list().length === 0, r7);
    ok('C12 a manager notice is left alone', (() => {
      notices.add({ kind: 'info', title: 'ルーターの知らせ', key: 'app:pmo-x', source: 'manager' });
      return true;
    })() && (await pc.runOnce(now + 7000)) && notices.findKey('app:pmo-x') !== null);

    // ---- A: the gaps to act on -> the patrol block (依頼-188) ----------------------------------
    const ルーター = require(path.join(root, 'src', 'main', 'pmo.js'));
    let aData = [
      { folder: fA, progress: progA, items: itemsA, checkList: new Set(['UX6']) },
      { folder: fB, progress: table(['| B-1 | b | 未着手 | — | 2026-11-14 |']), items: [{ id: 'r-b', no: 'B-1', status: 'done', doneAt: now - DAY }] },
    ];
    let aAnswer = 'all'; // all | noB (haiku drops B-1) | fail
    const aCalls = [];
    const pa = PC.createProgressCheck({
      notices: NS.createNotices(path.join(work, 'notices-a.json')),
      folders: async () => aData,
      ask: async (p) => {
        aCalls.push(p);
        if (aAnswer === 'fail') return null;
        const facts = [];
        let folder = -1;
        for (const line of p.split('\n')) {
          const h = /^## フォルダ (\d+):/.exec(line);
          if (h) folder = Number(h[1]);
          const m = /^- 行 (\S+) \(([\w-]+)\): (.+)$/.exec(line);
          if (m && !(aAnswer === 'noB' && m[1] === 'B-1')) facts.push({ folder, row: m[1], fact: m[3] });
        }
        return JSON.stringify({ type: 'result', is_error: false, structured_output: { facts } });
      },
    });
    ok('A1 no round yet -> no actions', pa.actions().length === 0);
    const ra = await pa.runOnce(now);
    const acts = pa.actions();
    const actRows = acts.map((a) => `${a.row}:${a.kind}`).sort();
    ok('A2 actions = done-open / pending-done only (not stale / no-check / bad-state)', JSON.stringify(actRows) === JSON.stringify(['AT-143:done-open', 'B-1:done-open', 'PM1-2:pending-done']) && ra.actions === 3, actRows);
    const pf = PC.patrolFindings(acts, now);
    ok('A3 patrolFindings: kind progress-gap, key g:<folder>:<ref>, the code fact', pf.length === 3 && pf.every((f) => f.kind === 'progress-gap' && f.key.startsWith('g:') && f.key.includes(path.resolve(f.folder).toLowerCase())) && /完了しているが/.test(pf.find((f) => f.id === 'AT-143').text), pf.map((f) => f.key));
    // the patrol: one line each in the block, once per key (reported), again in the stocktake
    const stale = [{ key: 'b:x:r-1:failed', kind: 'backlog', id: 'r-1', status: 'failed', since: now - 2 * DAY, age: 2 * DAY, text: '落ちた作業', folder: fA, name: 'agent_terminal', inboxId: null, detail: '' }];
    const fs1 = stale.concat(pf);
    const d1 = ルーター.patrolDecision(fs1, [], { lastStocktake: now - 3600e3, now });
    const block = ルーター.formatPatrol(fs1, d1.fresh, { stocktake: d1.stocktake });
    const gapLines = block.split('\n').filter((l) => /進み具合のずれ/.test(l));
    ok('A4 the block has one line per gap ([新] [<folder> 進み具合のずれ] 行 <#>: <fact>（直す所）)', d1.report && !d1.stocktake && gapLines.length === 3 && gapLines.every((l) => /^\[新\] \[(agent_terminal|other) 進み具合のずれ\] 行 \S+: .+（.+を直す）$/.test(l)), gapLines);
    const d2 = ルーター.patrolDecision(fs1, d1.keys, { lastStocktake: now - 3600e3, now: now + 300e3 });
    ok('A5 the same gaps next round -> not reported again (pmo.json reported)', d2.report === false && d2.fresh.size === 0, d2);
    const d3 = ルーター.patrolDecision(fs1, d1.keys, { lastStocktake: now - 2 * DAY, now });
    const block3 = ルーター.formatPatrol(fs1, d3.fresh, { stocktake: d3.stocktake });
    ok('A6 the stocktake lists them again (no [新])', d3.report && d3.stocktake && /^棚卸し:/.test(block3) && block3.split('\n').filter((l) => /^\[(agent_terminal|other) 進み具合のずれ\]/.test(l)).length === 3, block3);
    ok('A7 stocktakeDue: never / ≥ 24 h -> yes, 1 h -> no', ルーター.stocktakeDue(0, now) && ルーター.stocktakeDue(now - DAY, now) && !ルーター.stocktakeDue(now - 3600e3, now));
    // haiku leaves a row out -> no action for it; haiku fails -> the last actions stay; gaps gone -> none
    aAnswer = 'noB';
    aData = [aData[0], { ...aData[1], items: [{ id: 'r-b2', no: 'B-1', status: 'done', doneAt: now - DAY }] }]; // a new ref -> asked again
    await pa.runOnce(now + 1000);
    ok('A8 a row haiku did not list -> not an action', !pa.actions().some((a) => a.row === 'B-1') && pa.actions().length === 2, pa.actions().map((a) => a.row));
    aAnswer = 'fail';
    aData = [aData[0], { ...aData[1], items: [{ id: 'r-b3', no: 'B-1', status: 'done', doneAt: now - DAY }] }];
    const rf = await pa.runOnce(now + 2000);
    ok('A9 haiku fails -> the last actions stay (nothing changes)', rf.ok === false && pa.actions().length === 2, pa.actions().map((a) => a.row));
    aData = [{ folder: fA, progress: progOk, items: [] }];
    await pa.runOnce(now + 3000);
    ok('A10 gaps gone -> no actions', pa.actions().length === 0);
    ok('A11 the copy from actions() is not the inner list', (() => {
      const x = pa.actions();
      x.push({});
      return pa.actions().length === 0;
    })());

    // ---- H: the runner with a real child process (the fake, not claude) -----------------------
    const log = path.join(work, 'args.log');
    const program = (mode) => ({ file: process.execPath, pre: [FAKE], env: { FAKE_HAIKU_MODE: mode, FAKE_HAIKU_LOG: log } });
    const prompt = '## フォルダ 0: a\n- 行 X-1 (stale): 事実の文\n';
    const h1 = await PC.runHaiku(prompt, { program: program('ok'), cwd: path.join(work, 'scratch'), timeoutMs: 20000 });
    const f1 = h1.ok && PC.parseFacts(h1.stdout);
    ok('H1 prompt on stdin -> facts back', f1 && f1.length === 1 && f1[0].row === 'X-1' && f1[0].fact === '事実の文', h1);
    const args = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]);
    ok('H2 args: -p --model haiku --no-session-persistence --output-format json --max-budget-usd, --tools "" last, no --bare, no prompt', args[0] === '-p' && args.join(' ').includes('--model haiku') && args.includes('--no-session-persistence') && args.includes('--max-budget-usd') && args[args.length - 2] === '--tools' && args[args.length - 1] === '' && !args.includes('--bare') && !args.some((a) => a.includes('事実の文')), args);
    const h2 = await PC.runHaiku(prompt, { program: program('fail'), timeoutMs: 20000 });
    ok('H3 exit 1 -> not ok', h2.ok === false && /exit 1/.test(h2.error), h2);
    const h3 = await PC.runHaiku(prompt, { program: program('garbage'), timeoutMs: 20000 });
    ok('H4 not JSON -> ok but parseFacts null', h3.ok && PC.parseFacts(h3.stdout) === null);
    const t0 = Date.now();
    const h4 = await PC.runHaiku(prompt, { program: program('slow'), timeoutMs: 1500 });
    ok('H5 no answer before the time limit -> timeout, killed', h4.ok === false && h4.error === 'timeout' && Date.now() - t0 < 6000, h4);
    const h5 = await PC.runHaiku(prompt, { program: null });
    ok('H6 claude not found -> not ok', h5.ok === false);
    const h6 = await PC.runHaiku(prompt, { program: { file: path.join(work, 'no-such-program') }, timeoutMs: 5000 });
    ok('H7 a program that cannot start -> not ok (no throw)', h6.ok === false, h6);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  // ---- I: interval ------------------------------------------------------------------------------
  const M = 60000;
  ok('I1 intervalOf', PC.intervalOf({}) === 60 * M && PC.intervalOf(null) === 60 * M && PC.intervalOf({ progressCheckMinutes: 0 }) === 0 && PC.intervalOf({ progressCheckMinutes: 3 }) === 10 * M && PC.intervalOf({ progressCheckMinutes: 120 }) === 120 * M && PC.intervalOf({ progressCheckMinutes: 99999 }) === 1440 * M && PC.intervalOf({ progressCheckMinutes: 'x' }) === 60 * M);

  // the setting from the screen (依頼-189): what progress:setSettings stores -> intervalOf
  const stored = (v) => PC.intervalOf({ progressCheckMinutes: PC.normalizeMinutes(v) });
  ok('I2 normalizeMinutes -> intervalOf: 0 / "0" = off, 30, "180", clamped, garbage -> null (not written)', stored(0) === 0 && stored('0') === 0 && stored(30) === 30 * M && stored('180') === 180 * M && stored(5) === 10 * M && stored(5000) === 1440 * M && PC.normalizeMinutes('x') === null && PC.normalizeMinutes(-1) === null && PC.normalizeMinutes(undefined) === null);
  ok('I3 minutesOf / CHOICES (止める, 1 時間 = 既定)', PC.minutesOf({}) === 60 && PC.minutesOf({ progressCheckMinutes: 0 }) === 0 && PC.CHOICES[0][0] === 0 && /止める/.test(PC.CHOICES[0][1]) && PC.CHOICES.some(([m, t]) => m === 60 && /既定/.test(t)) && PC.CHOICES.every(([m]) => PC.normalizeMinutes(m) === m));

  // ---- M: main.js wiring ------------------------------------------------------------------------
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  ok('M4 runPatrol: the progress check before a stocktake (unless off), the actions join the findings', /pmo\.stocktakeDue\(lastStocktake, now\) && progressChecker && progressCheck\.intervalOf\(loadManagerSettings\(\)\)\) \{\s*try \{\s*await progressChecker\.runOnce\(\)/.test(main) && /progressCheck\.patrolFindings\(progressChecker\.actions\(\), now\)/.test(main) && /const findings = stale\.concat\(gaps\);\s*const d = pmo\.patrolDecision\(findings, reported/.test(main));
  ok('M5 IPC progress:settings / progress:setSettings write progressCheckMinutes (other keys kept) and re-arm the timer', /ipcMain\.handle\('progress:setSettings'/.test(main) && /\{ \.\.\.loadManagerSettings\(\), progressCheckMinutes: m \}/.test(main) && /if \(progressTick\) progressTick\(\);/.test(main));
  ok('M6 off (0) wins over the test interval', /const v = progressCheck\.intervalOf\(loadManagerSettings\(\)\);\s*return v && \(\(e2e && Number\(process\.env\.AGENT_TERMINAL_PROGRESS_EVERY_MS\)\) \|\| v\);/.test(main));
  const pre = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
  const st = fs.readFileSync(path.join(root, 'src', 'renderer', 'settings.js'), 'utf8');
  ok('M7 preload + the settings screen row (data-setting progressCheckMinutes)', /progressCheckSettings: \(\) => ipcRenderer\.invoke\('progress:settings'\)/.test(pre) && /setProgressCheckSettings: \(o\) => ipcRenderer\.invoke\('progress:setSettings', o\)/.test(pre) && /select\('progressCheckMinutes'/.test(st) && /進み具合の確認（haiku）/.test(st));
  ok('M1 main.js requires progress-check and starts it after the patrol', /require\('\.\/main\/progress-check'\)/.test(main) && /startPatrol\(\);\n\s*startProgressCheck\(\);/.test(main));
  ok('M2 the fake haiku only with the e2e mark; the interval from the manager settings', /const fake = e2e \? process\.env\.AGENT_TERMINAL_HAIKU_CMD : null/.test(main) && /progressCheck\.intervalOf\(loadManagerSettings\(\)\)/.test(main) && /progressCheck\.claudeProgram\(claudeCmd\)/.test(main));
  const src = fs.readFileSync(path.join(root, 'src', 'main', 'progress-check.js'), 'utf8');
  ok('M3 no shell, no windowsHide, no --bare in progress-check.js', !/shell:\s*true/.test(src) && !/windowsHide:\s*true/.test(src) && !PC.HAIKU_ARGS.includes('--bare'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
