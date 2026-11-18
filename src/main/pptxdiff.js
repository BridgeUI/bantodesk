// 19 第 3 段 「元と比べる」 for pptx: the text and the shapes of each slide, the original (base) against the working copy.
// Pure Node (fs + zlib): reads the zip's central directory and inflates only the XML parts it needs
// (ppt/presentation.xml, its rels, ppt/slides/slideN.xml). No external program, no temp files.
//
// compare(baseFile, workFile) -> {
//   counts: { base, work, changed, added, removed, same },
//   slides: [{ id, base: 1-based index | null, work: index | null, title, status: 'same'|'changed'|'added'|'removed',
//              moved: boolean, shapes: [{ id, name, status: 'added'|'removed'|'changed', geom: boolean,
//              text: [{ op: '=' | '-' | '+', text }] }] }],
//   text: the lines for the band's popup ('@@' a slide, '-' / '+' removed / added, ' ' context)
// }
// Slides are matched by <p:sldId id> (kept by PowerPoint and python-pptx when slides are edited, moved or added),
// shapes by <p:cNvPr id> within a slide.
'use strict';

const fs = require('fs');
const zlib = require('zlib');

const MAX_PART = 16 * 1024 * 1024; // one XML part, inflated (a slide's XML is KBs; images are not read)
const MAX_TOTAL = 128 * 1024 * 1024; // all parts of one deck, inflated (a zip bomb must not take main down)
const MAX_CD = 16 * 1024 * 1024; // the central directory
const MAX_SLIDES = 2000;

// ---- zip (central directory) ----
async function openZip(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('not a zip');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff + cdSize > size || cdSize > MAX_CD || count * 46 > cdSize) throw new Error('bad central directory');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOff);
    const entries = new Map();
    for (let p = 0, n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const size0 = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const local = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      entries.set(name, { method, compSize, size: size0, local, crc: cd.readUInt32LE(p + 16) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { file, entries, inflated: 0 };
  } finally {
    await fh.close();
  }
}

async function readParts(zip, names) {
  const out = new Map();
  const fh = await fs.promises.open(zip.file, 'r');
  try {
    for (const name of names) {
      const e = zip.entries.get(name);
      if (!e) continue;
      if (e.size > MAX_PART || e.compSize > MAX_PART) throw new Error(`part too large: ${name}`);
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, e.local);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header: ${name}`);
      const start = e.local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const data = Buffer.alloc(e.compSize);
      await fh.read(data, 0, e.compSize, start);
      let raw;
      if (e.method === 0) raw = data;
      else if (e.method === 8) raw = zlib.inflateRawSync(data, { maxOutputLength: MAX_PART });
      else throw new Error(`compression ${e.method}: ${name}`);
      zip.inflated += raw.length;
      if (zip.inflated > MAX_TOTAL) throw new Error('deck too large');
      out.set(name, raw.toString('utf8'));
    }
  } finally {
    await fh.close();
  }
  return out;
}

// ---- XML bits (regular expressions over the OOXML parts; no DOM in main) ----
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, k) => {
    if (k[0] !== '#') return ENT[k];
    const cp = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    try {
      return String.fromCodePoint(cp);
    } catch {
      return m;
    }
  });
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : null;
};

// paragraphs of an XML fragment: the runs (<a:t>) of each <a:p>, <a:br/> as a space; empty paragraphs dropped.
// A linear scan (indexOf), not one regular expression over the fragment: an unclosed <a:p> must not backtrack.
function paragraphs(xml) {
  const out = [];
  const open = /<a:p(?=[\s>/])/g;
  let m;
  while ((m = open.exec(xml))) {
    const gt = xml.indexOf('>', m.index);
    if (gt < 0) break;
    if (xml[gt - 1] === '/') continue; // <a:p/>
    const end = xml.indexOf('</a:p>', gt);
    if (end < 0) break;
    const body = xml.slice(gt + 1, end);
    open.lastIndex = end + 6;
    let t = '';
    const rr = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g;
    let r;
    while ((r = rr.exec(body))) t += r[1] !== undefined ? unescapeXml(r[1]) : ' ';
    t = t.replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
  }
  return out;
}

// shapes of a slide: one per <p:cNvPr> (sp, pic, graphicFrame, grpSp, cxnSp); the part up to the next <p:cNvPr> holds
// that shape's position (the first a:off / a:ext) and its own text (a group's children have their own cNvPr).
// mc:AlternateContent holds a shape twice (mc:Choice and mc:Fallback, the same cNvPr id): the Fallback is dropped, and
// of shapes with the same id only the first is kept.
function parseSlide(xml) {
  const a = xml.indexOf('<p:spTree');
  const z = xml.lastIndexOf('</p:spTree>');
  const body = (a >= 0 && z > a ? xml.slice(a, z) : xml).replace(/<mc:Fallback\b[^>]*>[\s\S]*?<\/mc:Fallback>/g, '');
  const shapes = [];
  const re = /<p:cNvPr\b[^>]*>/g;
  const starts = [];
  let m;
  while ((m = re.exec(body))) starts.push({ at: m.index, tag: m[0] });
  for (let i = 0; i < starts.length; i++) {
    const { at, tag } = starts[i];
    const chunk = body.slice(at, i + 1 < starts.length ? starts[i + 1].at : body.length);
    const off = /<a:off\b[^>]*\/>/.exec(chunk);
    const ext = /<a:ext\b[^>]*\/>/.exec(chunk);
    const ph = /<p:ph\b[^>]*\/?>/.exec(chunk);
    shapes.push({
      id: attr(tag, 'id') || String(i + 1),
      name: attr(tag, 'name') || '',
      ph: ph ? attr(ph[0], 'type') || 'body' : null,
      geom: off && ext ? [attr(off[0], 'x'), attr(off[0], 'y'), attr(ext[0], 'cx'), attr(ext[0], 'cy')].join(',') : '',
      text: paragraphs(chunk),
    });
  }
  // the spTree itself has a cNvPr (id 1, name ""): not a shape
  if (shapes.length && shapes[0].name === '' && shapes[0].id === '1' && !shapes[0].text.length) shapes.shift();
  const seen = new Set();
  for (let i = 0; i < shapes.length; i++) {
    if (seen.has(shapes[i].id)) shapes.splice(i--, 1);
    else seen.add(shapes[i].id);
  }
  const titleShape = shapes.find((s) => s.ph === 'title' || s.ph === 'ctrTitle');
  const title = (titleShape && titleShape.text.join(' ')) || (shapes.find((s) => s.text.length) || { text: [''] }).text[0];
  return { shapes, title: title || '' };
}

function relTarget(target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = ('ppt/' + target).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

// -> { slides: [{ id, file, title, shapes }] } in presentation order
async function readDeck(file) {
  const zip = await openZip(file);
  const head = await readParts(zip, ['ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels']);
  const pres = head.get('ppt/presentation.xml');
  const rels = head.get('ppt/_rels/presentation.xml.rels');
  if (!pres || !rels) throw new Error('not a pptx');
  const relMap = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target && /\/slide$/.test(attr(m[0], 'Type') || '')) relMap.set(id, relTarget(target));
  }
  const list = [];
  const lst = /<p:sldIdLst\b[\s\S]*?<\/p:sldIdLst>/.exec(pres);
  for (const m of (lst ? lst[0] : '').matchAll(/<p:sldId\b[^>]*>/g)) {
    const rid = attr(m[0], 'r:id');
    const f = rid && relMap.get(rid);
    if (f) list.push({ id: attr(m[0], 'id') || f, file: f });
    if (list.length >= MAX_SLIDES) break;
  }
  const parts = await readParts(zip, list.map((s) => s.file));
  return { slides: list.map((s) => ({ ...s, ...parseSlide(parts.get(s.file) || '') })) };
}

// ---- diff ----
// LCS of two string arrays -> [{ op, text }]; very long inputs fall back to all removed + all added
function diffLines(a, b) {
  if (a.length * b.length > 250000) return [...a.map((t) => ({ op: '-', text: t })), ...b.map((t) => ({ op: '+', text: t }))];
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: '=', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', text: a[i++] });
    else out.push({ op: '+', text: b[j++] });
  }
  while (i < n) out.push({ op: '-', text: a[i++] });
  while (j < m) out.push({ op: '+', text: b[j++] });
  return out;
}

const shapeLabel = (s) => (s.name ? `「${s.name.replace(/\s+/g, ' ').trim()}」` : `#${s.id}`);
// a sign + a paragraph: a space between when the text itself starts with + / - (the popup reads "+++" / "---" as headers)
const signed = (op, t) => `${op}${/^[+-]/.test(t) ? ' ' : ''}${t}`;

function diffSlide(b, w) {
  const shapes = [];
  const bMap = new Map(b.shapes.map((s) => [s.id, s]));
  const wMap = new Map(w.shapes.map((s) => [s.id, s]));
  for (const ws of w.shapes) {
    const bs = bMap.get(ws.id);
    if (!bs) {
      shapes.push({ id: ws.id, name: ws.name, status: 'added', geom: false, text: ws.text.map((t) => ({ op: '+', text: t })) });
      continue;
    }
    const textSame = bs.text.length === ws.text.length && bs.text.every((t, i) => t === ws.text[i]);
    const geom = bs.geom !== ws.geom;
    if (textSame && !geom) continue;
    shapes.push({ id: ws.id, name: ws.name || bs.name, status: 'changed', geom, text: textSame ? [] : diffLines(bs.text, ws.text) });
  }
  for (const bs of b.shapes) {
    if (!wMap.has(bs.id)) shapes.push({ id: bs.id, name: bs.name, status: 'removed', geom: false, text: bs.text.map((t) => ({ op: '-', text: t })) });
  }
  return shapes;
}

function render(res) {
  const c = res.counts;
  const lines = [`スライド: 元 ${c.base} 枚 → 作業用コピー ${c.work} 枚（変更 ${c.changed}・追加 ${c.added}・削除 ${c.removed}）`];
  const STATUS = { changed: '変更', added: '追加', removed: '削除' };
  for (const s of res.slides) {
    if (s.status === 'same' && !s.moved) continue;
    const no = s.work != null ? `スライド ${s.work}` : `（元のスライド ${s.base}）`;
    const what = [s.status !== 'same' ? STATUS[s.status] : '', s.moved ? `順番 ${s.base} → ${s.work}` : ''].filter(Boolean).join('・');
    lines.push(`@@ ${no}${s.title ? `「${s.title}」` : ''} — ${what}`);
    if (s.status === 'added' || s.status === 'removed') {
      const sign = s.status === 'added' ? '+' : '-';
      for (const sh of s.shapes) for (const t of sh.text) lines.push(signed(sign, t.text));
      continue;
    }
    for (const sh of s.shapes) {
      if (sh.status === 'added') lines.push(`+［図形を追加］${shapeLabel(sh)}`);
      else if (sh.status === 'removed') lines.push(`-［図形を削除］${shapeLabel(sh)}`);
      else lines.push(` ［${shapeLabel(sh)}］${sh.geom ? ' 位置・大きさが変わりました' : ''}`);
      for (const t of sh.text) lines.push(t.op === '=' ? ` ${t.text}` : signed(t.op, t.text));
    }
  }
  if (!c.changed && !c.added && !c.removed && !res.slides.some((s) => s.moved)) lines.push('テキスト・図形・スライドの順番は同じです。それ以外（画像・ノート・書式・グラフなど）が変わっています');
  const same = res.slides.filter((s) => s.status === 'same' && !s.moved).map((s) => s.work);
  if (same.length) lines.push('', `変わっていないスライド: ${same.join(', ')}`);
  return lines.join('\n');
}

async function compare(baseFile, workFile) {
  const [b, w] = await Promise.all([readDeck(baseFile), readDeck(workFile)]);
  const bById = new Map(b.slides.map((s, i) => [s.id, { s, i }]));
  const wIds = new Set(w.slides.map((s) => s.id));
  // order among the slides in both: the longest common subsequence stayed, the others were moved
  // (A B C D -> B C D A: only A moved)
  const commonB = b.slides.filter((s) => wIds.has(s.id)).map((s) => s.id);
  const commonW = w.slides.filter((s) => bById.has(s.id)).map((s) => s.id);
  const stayed = new Set(diffLines(commonB, commonW).filter((d) => d.op === '=').map((d) => d.text));
  const slides = [];
  w.slides.forEach((ws, wi) => {
    const hit = bById.get(ws.id);
    if (!hit) {
      slides.push({ id: ws.id, base: null, work: wi + 1, title: ws.title, status: 'added', moved: false, shapes: ws.shapes.map((sh) => ({ id: sh.id, name: sh.name, status: 'added', geom: false, text: sh.text.map((t) => ({ op: '+', text: t })) })) });
      return;
    }
    const shapes = diffSlide(hit.s, ws);
    slides.push({ id: ws.id, base: hit.i + 1, work: wi + 1, title: ws.title || hit.s.title, status: shapes.length ? 'changed' : 'same', moved: !stayed.has(ws.id), shapes });
  });
  b.slides.forEach((bs, bi) => {
    if (!wIds.has(bs.id)) {
      slides.push({ id: bs.id, base: bi + 1, work: null, title: bs.title, status: 'removed', moved: false, shapes: bs.shapes.map((sh) => ({ id: sh.id, name: sh.name, status: 'removed', geom: false, text: sh.text.map((t) => ({ op: '-', text: t })) })) });
    }
  });
  const count = (st) => slides.filter((s) => s.status === st).length;
  const res = { counts: { base: b.slides.length, work: w.slides.length, changed: count('changed'), added: count('added'), removed: count('removed'), same: count('same') }, slides };
  res.text = render(res);
  return res;
}

module.exports = { compare, readDeck, parseSlide, paragraphs, diffLines, openZip, readParts };
