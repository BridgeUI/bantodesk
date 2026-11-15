// A minimal pptx (zip of OOXML parts, deflate) for the 19 第 3 段 tests; no python-pptx needed.
// makePptx(file, slides): slides = [{ id?: number (p:sldId id, default 256 + i), shapes: [{ id, name, ph?: 'title'|'body',
//   x?, y?, cx?, cy?, paras: string[] }] }]. The slide part names follow the order given (slide1.xml …) unless `file` is set.
'use strict';
const fs = require('fs');
const zlib = require('zlib');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function zip(files) {
  const locals = [];
  const central = [];
  let off = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameB = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    locals.push(lh, nameB, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(off, 42);
    central.push(ch, nameB);
    off += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

function shapeXml(s) {
  const ph = s.ph ? `<p:nvPr><p:ph type="${s.ph}"/></p:nvPr>` : '<p:nvPr/>';
  const xfrm = s.x == null ? '' : `<a:xfrm><a:off x="${s.x}" y="${s.y || 0}"/><a:ext cx="${s.cx || 100}" cy="${s.cy || 100}"/></a:xfrm>`;
  const paras = (s.paras || []).map((t) => (t === '' ? '<a:p/>' : `<a:p><a:r><a:rPr lang="ja-JP"/><a:t>${esc(t)}</a:t></a:r></a:p>`)).join('');
  return `<p:sp><p:nvSpPr><p:cNvPr id="${s.id}" name="${esc(s.name || '')}"/><p:cNvSpPr/>${ph}</p:nvSpPr><p:spPr>${xfrm}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`;
}

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function makePptx(file, slides) {
  const files = [];
  const rels = [];
  const ids = [];
  slides.forEach((sl, i) => {
    const part = sl.file || `slide${i + 1}.xml`;
    const rid = `rId${i + 10}`;
    rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/${part}"/>`);
    ids.push(`<p:sldId id="${sl.id || 256 + i}" r:id="${rid}"/>`);
    files.push([`ppt/slides/${part}`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sl.shapes.map(shapeXml).join('')}</p:spTree></p:cSld></p:sld>`]);
  });
  rels.push('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>');
  files.unshift(
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${NS}><p:sldIdLst>${ids.join('')}</p:sldIdLst></p:presentation>`],
    ['ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`],
  );
  fs.writeFileSync(file, zip(files));
}

module.exports = { makePptx, zip };
