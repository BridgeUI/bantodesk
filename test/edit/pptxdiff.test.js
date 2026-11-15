// 19 第 3 段: unit test of src/main/pptxdiff.js and fileedit.diff for pptx. Run: node tmp/edit/pptxdiff.test.js
// (AT_APP_ROOT = the app folder, default dev). Fixtures are built in tmp/edit/out-pptxdiff by pptx-fixture.cjs.
'use strict';
const fs = require('fs');
const path = require('path');
const { makePptx } = require('./pptx-fixture.cjs');

const appRoot = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.resolve(__dirname, '..', '..');
const pptxDiff = require(path.join(appRoot, 'src', 'main', 'pptxdiff.js'));
const fileEdit = require(path.join(appRoot, 'src', 'main', 'fileedit.js'));

let passes = 0, fails = 0;
const check = (name, cond, extra) => {
  cond ? passes++ : fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 600) : ''}`);
};

const out = path.join(__dirname, 'out-pptxdiff');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const title = (id, t) => ({ id, name: 'タイトル 1', ph: 'title', paras: [t] });
const body = (id, paras, geo = {}) => ({ id, name: 'テキスト プレースホルダー 2', ph: 'body', x: 100, y: 200, cx: 3000, cy: 2000, ...geo, paras });
const baseSlides = [
  { id: 256, shapes: [title(2, '売上の推移'), body(3, ['4 月は 120', '5 月は 135', '6 月は 150'])] },
  { id: 257, shapes: [title(2, '課題'), body(3, ['人手が足りない', '在庫 & 物流 <遅れ>'])] },
  { id: 258, shapes: [title(2, 'まとめ'), body(3, ['来期も伸ばす'])] },
  { id: 259, shapes: [title(2, '付録'), body(3, ['表 1'])] },
];
const base = path.join(out, 'base.pptx');
makePptx(base, baseSlides);

(async () => {
  // ---- same file -> nothing changed ----
  const same = await pptxDiff.compare(base, base);
  check('same deck: 4 slides, all same', same.counts.base === 4 && same.counts.work === 4 && same.counts.same === 4 && same.slides.every((s) => s.status === 'same' && !s.moved), same.counts);
  check('same deck: titles read from the title placeholder', same.slides.map((s) => s.title).join('|') === '売上の推移|課題|まとめ|付録', same.slides.map((s) => s.title));
  check('XML entities decoded', (await pptxDiff.readDeck(base)).slides[1].shapes[1].text[1] === '在庫 & 物流 <遅れ>');

  // ---- edits: text changed on 1, shape added + moved on 2, slide 3 removed, a new slide, slide 4 moved before 2 ----
  const work = path.join(out, 'work.pptx');
  makePptx(work, [
    { id: 256, file: 'slide1.xml', shapes: [title(2, '売上の推移'), body(3, ['4 月は 120', '5 月は 140（修正）', '6 月は 150', '7 月は 160'])] },
    { id: 259, file: 'slide4.xml', shapes: [title(2, '付録'), body(3, ['表 1'])] },
    { id: 257, file: 'slide2.xml', shapes: [title(2, '課題'), body(3, ['人手が足りない', '在庫 & 物流 <遅れ>'], { x: 500 }), { id: 4, name: '矢印 3', x: 1, y: 1, cx: 2, cy: 2, paras: ['ここが要点'] }] },
    { id: 260, file: 'slide5.xml', shapes: [title(2, '新しいスライド'), body(3, ['追加した内容'])] },
  ]);
  const r = await pptxDiff.compare(base, work);
  const by = (id) => r.slides.find((s) => s.id === String(id));
  check('counts: base 4, work 4, changed 2, added 1, removed 1', r.counts.base === 4 && r.counts.work === 4 && r.counts.changed === 2 && r.counts.added === 1 && r.counts.removed === 1, r.counts);
  const s1 = by(256);
  check('slide 1 changed: one paragraph replaced, one added, the rest context', s1.status === 'changed' && JSON.stringify(s1.shapes[0].text.map((t) => t.op + t.text)) === JSON.stringify(['=4 月は 120', '-5 月は 135', '+5 月は 140（修正）', '=6 月は 150', '+7 月は 160']), s1.shapes);
  check('slide 1 not moved', !s1.moved && s1.base === 1 && s1.work === 1);
  const s2 = by(257);
  check('slide 2: the body moved (geom) with the same text, the arrow added', s2.status === 'changed' && s2.shapes.some((s) => s.id === '3' && s.geom && !s.text.length) && s2.shapes.some((s) => s.id === '4' && s.status === 'added' && s.name === '矢印 3'), s2.shapes);
  check('slide 2 work index 3, base 2', s2.base === 2 && s2.work === 3);
  check('slide 3 removed', by(258).status === 'removed' && by(258).work === null && by(258).title === 'まとめ');
  check('new slide added at 4', by(260).status === 'added' && by(260).work === 4 && by(260).base === null);
  check('付録 / 課題 swapped: exactly one of them marked moved (the LCS of the common order stays), 付録 same content', by(259).status === 'same' && [by(257).moved, by(259).moved].filter(Boolean).length === 1 && !by(256).moved, [by(257).moved, by(259).moved]);
  const lines = r.text.split('\n');
  check('text: summary line first', /^スライド: 元 4 枚 → 作業用コピー 4 枚（変更 2・追加 1・削除 1）$/.test(lines[0]), lines[0]);
  check('text: a @@ line per changed / added / removed / moved slide', lines.filter((l) => l.startsWith('@@')).length === 4 + (by(259).moved ? 1 : 0), lines);
  check('text: -/+ lines of slide 1', lines.includes('-5 月は 135') && lines.includes('+5 月は 140（修正）') && lines.includes(' 4 月は 120'));
  check('text: shape added / moved marked', lines.includes('+［図形を追加］「矢印 3」') && lines.some((l) => l.includes('位置・大きさが変わりました')));
  check('text: removed slide lines start with -', lines.includes('-まとめ') && lines.includes('-来期も伸ばす'));
  check('text: no line starts with +++ or --- (the popup treats those as headers)', !lines.some((l) => l.startsWith('+++') || l.startsWith('---')));

  // ---- review findings (2026-11-13) ----
  // 1: one slide moved to the end -> only that slide is "moved"
  const mv = path.join(out, 'moved.pptx');
  makePptx(mv, [baseSlides[1], baseSlides[2], baseSlides[3], baseSlides[0]]);
  const rm = await pptxDiff.compare(base, mv);
  check('one slide moved: only it is marked moved', JSON.stringify(rm.slides.filter((x) => x.moved).map((x) => x.id)) === JSON.stringify(['256']), rm.slides.map((x) => [x.id, x.moved]));
  // 2: mc:AlternateContent (Choice + Fallback with the same cNvPr id) -> one shape
  const alt = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/></p:nvGrpSpPr><mc:AlternateContent><mc:Choice Requires="a14"><p:sp><p:nvSpPr><p:cNvPr id="5" name="数式"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>x=1</a:t></a:r></a:p></p:txBody></p:sp></mc:Choice><mc:Fallback><p:sp><p:nvSpPr><p:cNvPr id="5" name="数式"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>x=1</a:t></a:r></a:p></p:txBody></p:sp></mc:Fallback></mc:AlternateContent><p:sp><p:nvSpPr><p:cNvPr id="6" name="a"/></p:nvSpPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="6" name="dup"/></p:nvSpPr></p:sp></p:spTree>';
  const ps = pptxDiff.parseSlide(alt);
  check('AlternateContent / duplicate ids: one shape per id', ps.shapes.map((x) => x.id).join(',') === '5,6' && ps.shapes[0].text.join() === 'x=1', ps.shapes);
  // 3: paragraphs starting with + / - never make a "+++" / "---" line; shape names on one line
  const pm = path.join(out, 'pm.pptx');
  makePptx(pm, [{ id: 256, shapes: [title(2, '売上の推移'), body(3, ['++ 追加', '-- 削除'])] }, ...baseSlides.slice(1)]);
  const rp = await pptxDiff.compare(base, pm);
  const pl = rp.text.split('\n');
  check('+/- leading paragraphs: no +++ / --- lines', pl.includes('+ ++ 追加') && pl.includes('+ -- 削除') && !pl.some((l) => l.startsWith('+++') || l.startsWith('---')), pl);
  const nm = path.join(out, 'nm.pptx');
  makePptx(nm, [{ id: 256, shapes: [...baseSlides[0].shapes, { id: 9, name: '名前\n改行', paras: [] }] }, ...baseSlides.slice(1)]);
  const rn = (await pptxDiff.compare(base, nm)).text.split('\n');
  check('a shape name with a newline stays on one line', rn.includes('+［図形を追加］「名前 改行」'), rn);
  // 4: an unclosed <a:p> is linear (no backtracking)
  const big = '<a:p><a:r><a:t>x</a:t></a:r>'.repeat(20000);
  const t0 = Date.now();
  pptxDiff.paragraphs(big);
  check('unclosed <a:p> (540 KB) parsed fast', Date.now() - t0 < 200, Date.now() - t0);
  // 6: only something the parser does not read changed -> said so
  const same2 = await pptxDiff.compare(base, base);
  check('no text / shape change: the popup says what else changed', same2.text.includes('それ以外（画像・ノート・書式・グラフなど）が変わっています'));

  // ---- parse details ----
  const p = pptxDiff.paragraphs('<a:p><a:r><a:t>A</a:t></a:r><a:br/><a:r><a:t>B</a:t></a:r></a:p><a:p/><a:p><a:pPr/><a:r><a:t xml:space="preserve">  C  </a:t></a:r></a:p>');
  check('paragraphs: <a:br/> as a space, empty dropped, trimmed, a:pPr not a paragraph', JSON.stringify(p) === JSON.stringify(['A B', 'C']), p);
  check('diffLines: LCS', JSON.stringify(pptxDiff.diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])) === JSON.stringify([{ op: '=', text: 'a' }, { op: '-', text: 'b' }, { op: '+', text: 'x' }, { op: '=', text: 'c' }]));

  // ---- not a pptx -> throws (fileedit falls back to the hashes) ----
  const bad = path.join(out, 'bad.pptx');
  fs.writeFileSync(bad, 'PK\x03\x04 not really');
  let threw = false;
  try {
    await pptxDiff.compare(bad, bad);
  } catch {
    threw = true;
  }
  check('broken pptx throws', threw);

  // ---- fileedit.diff on an edit folder ----
  const orig = path.join(out, 'src', '資料.pptx');
  fs.mkdirSync(path.dirname(orig), { recursive: true });
  fs.copyFileSync(base, orig);
  const dir = path.join(out, 'e-test');
  fs.mkdirSync(dir, { recursive: true });
  const meta = await fileEdit.importFile(orig, dir);
  const d0 = await fileEdit.diff(dir);
  check('fileedit.diff unchanged pptx: changed false', d0 && d0.changed === false, d0);
  fs.copyFileSync(work, path.join(dir, meta.name));
  const d1 = await fileEdit.diff(dir);
  check('fileedit.diff changed pptx: kind text, format pptx, the same lines', d1 && d1.kind === 'text' && d1.format === 'pptx' && d1.changed === true && d1.diff.startsWith(r.text) && /作業用コピー: sha256 [0-9a-f]{64}/.test(d1.diff) && d1.counts.changed === 2, d1 && { kind: d1.kind, format: d1.format });
  fs.writeFileSync(path.join(dir, meta.name), 'PK\x03\x04 broken');
  const d2 = await fileEdit.diff(dir);
  check('fileedit.diff unreadable pptx: binary with hashes + error', d2 && d2.kind === 'binary' && d2.changed && !!d2.error && !!d2.workSha, d2);
  check('the original was never written', fs.readFileSync(orig).equals(fs.readFileSync(base)));

  // ---- a python-pptx deck (a backup of tmp/fileedit's real run, if present; read only, from a copy) ----
  const bk = path.join(appRoot, 'tmp', 'fileedit', 'ud', 'edit-backups');
  const sample = fs.existsSync(bk) && fs.readdirSync(bk).find((f) => f.endsWith('.pptx'));
  if (sample) {
    const copy = path.join(out, 'sample.pptx');
    fs.copyFileSync(path.join(bk, sample), copy);
    const s = await pptxDiff.compare(copy, copy);
    check('python-pptx deck: slides and titles read', s.counts.base > 0 && s.slides.every((x) => x.title), s.slides.map((x) => x.title));
  } else console.log('SKIP python-pptx deck (no tmp/fileedit/ud/edit-backups/*.pptx)');

  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
