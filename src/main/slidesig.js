// 18 プレゼン (docs/plan-present.md 「第 1 段の作り」): which slides of a pptx changed. Pure Node (reuses pptxdiff's zip reader):
// the signature of a slide = sha1 of its slideN.xml + its .rels + (name, CRC32) of every part it points at (media, charts, its layout)
// + what the layout points at (the master / theme). The CRC32 comes from the zip's central directory, so a big picture is not read.
// sigs(file) -> { slides: [{ id, file, sig }] } in presentation order; changed(oldSigs, newSigs) -> [1-based index].
'use strict';
const crypto = require('crypto');
const { openZip, readParts, readDeck } = require('./pptxdiff');

const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? m[1] : null; };
const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1);
function resolve(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const out = [];
  for (const s of (dirOf(base) + target).split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
  return out.join('/');
}
const relsOf = (part) => `${dirOf(part)}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`;
function targets(part, xml) {
  const out = [];
  for (const m of (xml || '').matchAll(/<Relationship\b[^>]*>/g)) {
    const t = attr(m[0], 'Target');
    if (t && attr(m[0], 'TargetMode') !== 'External') out.push(resolve(part, t));
  }
  return out;
}

async function sigs(file) {
  const deck = await readDeck(file); // order + part names (also rejects a non-pptx)
  const zip = await openZip(file);
  const crc = (name) => { const e = zip.entries.get(name); return e ? `${name}:${e.crc >>> 0}:${e.size}` : `${name}:-`; };
  const slides = [];
  for (const s of deck.slides) {
    const rp = relsOf(s.file);
    const got = await readParts(zip, [s.file, rp]);
    const h = crypto.createHash('sha1');
    h.update(got.get(s.file) || '');
    h.update('\0');
    h.update(got.get(rp) || '');
    const tg = targets(s.file, got.get(rp));
    for (const t of tg) {
      h.update(`\0${crc(t)}`);
      if (/\/slideLayouts\//.test(t)) { // one level more: the layout's master / images
        const lr = await readParts(zip, [t, relsOf(t)]);
        h.update(`\0${lr.get(t) ? crypto.createHash('sha1').update(lr.get(t)).digest('hex') : ''}`);
        for (const u of targets(t, lr.get(relsOf(t)))) h.update(`\0${crc(u)}`);
      }
    }
    slides.push({ id: s.id, file: s.file, sig: h.digest('hex').slice(0, 16), title: s.title });
  }
  return { slides };
}

// 1-based indexes of slides whose signature differs (or that are new); slides that went away are not listed (count shrinks)
function changed(oldSigs, newSigs) {
  const out = [];
  newSigs.forEach((s, i) => { if (oldSigs[i] !== s) out.push(i + 1); });
  return out;
}

module.exports = { sigs, changed };
