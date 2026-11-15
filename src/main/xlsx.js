'use strict';
// 5b viewer, xlsx "table" view (docs/plan-viewer.md "xlsx の表"): a minimal xlsx / xlsm reader, fs + zlib only.
// readWorkbook(path) / readWorkbookBuffer(buf) -> { ms, sheets: [...], stats }. No Electron imports (runs on a worker).
// Chosen over Excel COM on 2026-11-03: the same values / formulas on a 50-sheet real file, ~80 ms instead of 13-21 s.
// Zip: read from the central directory, stored/deflate only, no zip64/encryption, size caps against zip bombs.
// Cell = [row, col, value, formula|null, fmt?] (0-based, A1 origin). value: number | string (dates as ISO) | boolean
// | null | { error: '#N/A' }. fmt = index into sheet.fmts (number format code) for numbers that are not General.
const fs = require('fs');
const zlib = require('zlib');

const LIMIT_FILE = 100 * 1024 * 1024;
const LIMIT_ENTRY = 50 * 1024 * 1024;
const LIMIT_TOTAL = 200 * 1024 * 1024;
const LIMIT_CELLS = 2000000; // over all sheets, formula-only cells included; the rest is cut (sheet.truncated)
const LIMIT_SHEETS = 1000;
const LIMIT_MERGES = 100000; // per sheet
const LIMIT_FORMULA_CHARS = 20000000; // characters of expanded shared formulas over the workbook

// ---------- zip ----------
function openZip(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD)');
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) throw new Error('multi-disk zip not supported');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new Error('zip64 not supported');
  if (cdOff + cdSize > buf.length) throw new Error('bad central directory');
  const entries = new Map();
  let p = cdOff;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const fl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + fl);
    if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) throw new Error('zip64 not supported');
    entries.set(name, { flags, method, csize, usize, lho });
    p += 46 + fl + el + cl;
  }
  let total = 0;
  return {
    has: (n) => entries.has(n),
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.flags & 1) throw new Error('encrypted zip not supported');
      if (e.usize > LIMIT_ENTRY) throw new Error(`entry too large: ${name}`);
      if (total + e.usize > LIMIT_TOTAL) throw new Error('zip total size limit exceeded');
      const h = e.lho;
      if (buf.readUInt32LE(h) !== 0x04034b50) throw new Error(`bad local header: ${name}`);
      const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
      const raw = buf.subarray(start, start + e.csize);
      let out;
      if (e.method === 0) out = raw;
      else if (e.method === 8) out = zlib.inflateRawSync(raw, { maxOutputLength: Math.min(LIMIT_ENTRY, e.usize + 1) });
      else throw new Error(`unsupported compression method ${e.method}: ${name}`);
      if (out.length !== e.usize) throw new Error(`size mismatch: ${name}`);
      total += out.length;
      return out.toString('utf8');
    },
  };
}

// ---------- xml helpers ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unesc(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e]);
}
// OOXML escapes control chars as _xHHHH_ inside strings
function unescOoxml(s) {
  return s.indexOf('_x') < 0 ? s : s.replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}
function attrs(s) {
  const o = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) o[m[1]] = unesc(m[2] !== undefined ? m[2] : m[3]);
  return o;
}
function textOf(xml) { // concat all <t>..</t> (no phonetic runs <rPh>)
  let body = '';
  for (let pos = 0; ;) {
    const i = xml.indexOf('<rPh', pos);
    if (i < 0) { body += xml.slice(pos); break; }
    body += xml.slice(pos, i);
    const k = xml.indexOf('</rPh>', i);
    if (k < 0) break;
    pos = k + 6;
  }
  let out = '';
  eachEl(body, 't', (_, inner) => { if (inner) out += inner; });
  return unescOoxml(unesc(out));
}

// Calls fn(attrString, inner | null) for each <tag …>…</tag> / <tag …/> in xml, scanning with indexOf (linear time:
// a missing close tag stops the scan instead of re-searching the rest for every open tag). fn returns false to stop.
// Same-name elements must not nest (true for every element read here).
function eachEl(xml, tag, fn) {
  const open = '<' + tag;
  const close = '</' + tag + '>';
  let pos = 0;
  for (;;) {
    const i = xml.indexOf(open, pos);
    if (i < 0) return;
    const ch = xml.charCodeAt(i + open.length);
    if (!(ch === 32 || ch === 62 || ch === 47 || ch === 9 || ch === 10 || ch === 13)) { pos = i + open.length; continue; }
    const j = xml.indexOf('>', i);
    if (j < 0) return;
    if (xml.charCodeAt(j - 1) === 47) {
      if (fn(xml.slice(i + open.length, j - 1), null) === false) return;
      pos = j + 1;
      continue;
    }
    const k = xml.indexOf(close, j + 1);
    if (k < 0) return;
    if (fn(xml.slice(i + open.length, j), xml.slice(j + 1, k)) === false) return;
    pos = k + close.length;
  }
}

// A part as text. Some writers (the .NET OpenXML SDK) put a prefix on every element (<x:row>); drop it so the
// plain tag names match.
function readXml(zip, name) {
  const xml = zip.read(name);
  if (xml && /<[A-Za-z_][\w.-]*:(worksheet|workbook|sst|styleSheet|Relationships)\b/.test(xml.slice(0, 4096))) {
    return xml.replace(/<(\/?)[A-Za-z_][\w.-]*:(?=[A-Za-z_])/g, '<$1');
  }
  return xml;
}

// ---------- refs ----------
function colToNum(letters) { let n = 0; for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64); return n; }
function numToCol(n) { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; } return s; }
// Excel's grid: 1,048,576 rows x 16,384 columns (XFD). Refs outside it are not cells (null).
const MAX_ROWS = 1048576;
const MAX_COLS = 16384;
function parseCell(ref) {
  const m = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/.exec(ref);
  if (!m) return null;
  const r = parseInt(m[2], 10) - 1, c = colToNum(m[1]) - 1;
  return r >= 0 && r < MAX_ROWS && c >= 0 && c < MAX_COLS ? [r, c] : null;
}

// Shift relative refs of a shared formula by (dr, dc). String literals are kept as is.
function shiftFormula(f, dr, dc) {
  if (!dr && !dc) return f;
  return f.split(/("(?:[^"]|"")*")/).map((part, i) => {
    if (i % 2 === 1) return part;
    // A1-style refs (also after "Sheet!"), not function names "LOG10(" or sheet names "AB1!"
    return part.replace(/(^|[^A-Za-z0-9_.$'\]])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(!])/g, (m, pre, ca, col, ra, row) => {
      let c = colToNum(col), r = parseInt(row, 10);
      if (!ca) c += dc;
      if (!ra) r += dr;
      if (c < 1 || r < 1) return pre + '#REF!';
      return pre + ca + numToCol(c) + ra + r;
    });
  }).join('');
}

// ---------- dates ----------
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47,
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]); // 27-36,50-58: ja-JP builtin date formats
// Kind of a number format: 'date' (y m d, era g e; with h / s also a time), 'time' (h / s only: time of day),
// 'elapsed' ([h] [m] [s]: a duration), or null (a number format). The exponent of 0.00E+00 is not a date.
function dateKind(code) {
  const s = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/_./g, '').replace(/\*./g, '')
    .replace(/E[+-]/g, '').replace(/General/gi, '');
  if (/\[(h+|m+|s+)\]/i.test(s)) return 'elapsed';
  const t = s.replace(/\[[^\]]*\]/g, '');
  if (/[ydge]/i.test(t)) return 'date';
  if (/[hs]/i.test(t)) return 'time';
  if (/m/i.test(t)) return 'date'; // only "m" / "mmm": a month
  return null;
}
const isDateFormat = (code) => dateKind(code) !== null;
const pad2 = (n) => String(n).padStart(2, '0');
// serial -> 'YYYY-MM-DD' | 'YYYY-MM-DDTHH:MM:SS' (kind 'date'), 'HH:MM:SS' (kind 'time': the time of day),
// '[h]:MM:SS' total hours (kind 'elapsed'), or null when out of range
function serialToIso(v, date1904, kind = 'date') {
  if (!Number.isFinite(v)) return null;
  if (kind === 'time' || kind === 'elapsed') {
    if (v < 0 || v > 1e7) return null;
    const secs = Math.round((kind === 'time' ? v - Math.floor(v) : v) * 86400);
    const hh = kind === 'time' ? Math.floor(secs / 3600) % 24 : Math.floor(secs / 3600);
    return `${pad2(hh)}:${pad2(Math.floor(secs / 60) % 60)}:${pad2(secs % 60)}`;
  }
  if (v < 0 || v >= 2958466) return null; // Excel dates end at 9999-12-31
  let days = v;
  if (date1904) days += 1462;
  else if (v < 60) days += 1; // Lotus 1900-02-29 bug: serials before it are off by one
  else if (v >= 60 && v < 61) return '1900-02-29';
  const ms = Math.round((days - 25569) * 86400000);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const iso = d.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  if (v < 1 && v >= 0 && !date1904) return iso.slice(11, 19); // time only
  return Number.isInteger(v) ? iso.slice(0, 10) : iso.slice(0, 19);
}

// ---------- workbook parts ----------
function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/'); parts.pop();
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
function readRels(zip, partPath) {
  const parts = partPath.split('/'); const file = parts.pop();
  const relPath = (parts.length ? parts.join('/') + '/' : '') + '_rels/' + file + '.rels';
  const xml = readXml(zip, relPath);
  const map = {};
  if (!xml) return map;
  eachEl(xml, 'Relationship', (s) => {
    const a = attrs(s);
    if (a.TargetMode === 'External' || !a.Id || !a.Target) return;
    map[a.Id] = { type: a.Type || '', target: resolvePath(partPath, a.Target) };
  });
  return map;
}

// Built-in number formats that are not General / dates (ECMA-376 18.8.30). Others fall back to General.
const BUILTIN_FMT = {
  1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 48: '##0.0E+0', 49: '@',
};
// built-in date / time ids -> kind (18-21, 45, 47: time of day; 46: [h]:mm:ss; ja-JP 32, 33: h"時"mm"分"…)
const BUILTIN_KIND = { 18: 'time', 19: 'time', 20: 'time', 21: 'time', 45: 'time', 46: 'elapsed', 47: 'time', 32: 'time', 33: 'time' };

// -> { kind: ('date'|'time'|'elapsed'|null)[], code: (string|null)[] } per cellXfs index
function readStyles(zip, path) {
  const xml = path && readXml(zip, path);
  const out = { kind: [], code: [] };
  if (!xml) return out;
  const custom = {};
  eachEl(xml, 'numFmt', (a) => { const o = attrs(a); custom[o.numFmtId] = o.formatCode || ''; });
  eachEl(xml, 'cellXfs', (_, inner) => {
    if (inner == null) return;
    eachEl(inner, 'xf', (a) => {
      const id = parseInt(attrs(a).numFmtId || '0', 10);
      const code = custom[id] !== undefined ? custom[id] : (BUILTIN_FMT[id] || null);
      out.kind.push(custom[id] !== undefined ? dateKind(custom[id]) : (BUILTIN_DATE.has(id) ? BUILTIN_KIND[id] || 'date' : null));
      out.code.push(code && !/^general$/i.test(code) ? code : null);
    });
    return false;
  });
  return out;
}

function readSst(zip, path) {
  const xml = path && readXml(zip, path);
  if (!xml) return [];
  const out = [];
  eachEl(xml, 'si', (_, inner) => { out.push(inner ? textOf(inner) : ''); });
  return out;
}

function readSheet(xml, ctx, stats) {
  const sheet = { ref: null, rows: 0, cols: 0, freeze: { rows: 0, cols: 0 }, colWidths: [], merges: [], fmts: [], cells: [], truncated: false };
  const fmtIdx = new Map(); // code -> index into sheet.fmts
  const fmtOf = (s) => {
    const code = ctx.styles.code[s];
    if (!code) return -1;
    let i = fmtIdx.get(code);
    if (i === undefined) { i = sheet.fmts.length; sheet.fmts.push(code); fmtIdx.set(code, i); }
    return i;
  };
  const dim = /<dimension\b([^>]*?)\/?>/.exec(xml);
  if (dim) sheet.ref = attrs(dim[1]).ref || null;

  const pane = /<pane\b([^>]*?)\/?>/.exec(xml);
  if (pane) {
    const a = attrs(pane[1]);
    if (a.state === 'frozen' || a.state === 'frozenSplit') {
      sheet.freeze = { rows: Math.min(MAX_ROWS, parseInt(a.ySplit || '0', 10) || 0), cols: Math.min(MAX_COLS, parseInt(a.xSplit || '0', 10) || 0) };
    }
  }
  const fmt = /<sheetFormatPr\b([^>]*?)\/?>/.exec(xml);
  let defWidth = 8.43;
  if (fmt) {
    const a = attrs(fmt[1]);
    if (a.defaultColWidth) defWidth = parseFloat(a.defaultColWidth) || 8.43;
    else if (a.baseColWidth) defWidth = (parseFloat(a.baseColWidth) || 8) + 0.71; // rough: base + padding
  }
  const widths = [];
  eachEl(xml, 'cols', (_, inner) => {
    if (inner == null) return;
    eachEl(inner, 'col', (s) => {
      const a = attrs(s);
      const lo = parseInt(a.min, 10), hi = Math.min(parseInt(a.max, 10), MAX_COLS);
      const w = a.hidden === '1' || a.hidden === 'true' ? 0 : (a.width !== undefined ? parseFloat(a.width) || 0 : defWidth);
      for (let c = lo; c <= hi && c <= 1024; c++) widths[c - 1] = w; // cap expansion (max="16384" is common)
    });
    return false;
  });
  eachEl(xml, 'mergeCells', (_, inner) => {
    if (inner == null) return;
    eachEl(inner, 'mergeCell', (s) => {
      if (sheet.merges.length >= LIMIT_MERGES) return false;
      const ref = attrs(s).ref;
      if (ref) sheet.merges.push(ref);
    });
    return false;
  });

  // cells
  const sdStart = xml.indexOf('<sheetData');
  const sdEnd = xml.indexOf('</sheetData>');
  const shared = {}; // si -> { f, r, c }
  let maxR = -1, maxC = -1;
  const push = (cell) => {
    if (ctx.budget-- <= 0) { sheet.truncated = true; return false; }
    sheet.cells.push(cell);
    if (cell[0] > maxR) maxR = cell[0];
    if (cell[1] > maxC) maxC = cell[1];
    return true;
  };
  if (sdStart >= 0 && sdEnd > sdStart) {
    const sd = xml.slice(sdStart, sdEnd);
    let rowIdx = -1;
    let stop = false;
    eachEl(sd, 'row', (rowAttrs, rowBody) => {
      const ra = attrs(rowAttrs);
      rowIdx = ra.r ? parseInt(ra.r, 10) - 1 : rowIdx + 1;
      if (!(rowIdx >= 0 && rowIdx < MAX_ROWS)) return false; // past Excel's last row: the rest is not a sheet
      if (!rowBody) return;
      let colIdx = -1;
      eachEl(rowBody, 'c', (cellAttrs, body) => {
        const a = attrs(cellAttrs);
        let r = rowIdx, c = colIdx + 1;
        if (a.r) { const rc = parseCell(a.r); if (!rc) return; r = rc[0]; c = rc[1]; }
        if (c >= MAX_COLS) return;
        colIdx = c;
        if (!body) return;
        // formula
        let formula = null;
        const fm = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(body);
        if (fm) {
          const fa = attrs(fm[1]);
          const ftext = fm[2] !== undefined ? unesc(fm[2]) : '';
          stats.formulaCells++;
          if (fa.t === 'shared') {
            if (ftext) { shared[fa.si] = { f: ftext, r, c }; stats.sharedMasters++; formula = '=' + ftext; }
            else {
              stats.sharedChildren++;
              const base = shared[fa.si];
              // each child is a full copy of the master: cap the characters spent on them
              if (base && ctx.formulaChars >= base.f.length) {
                formula = '=' + shiftFormula(base.f, r - base.r, c - base.c);
                ctx.formulaChars -= formula.length;
              } else if (base) stats.formulasDropped++;
              else { formula = `=?shared:${fa.si}`; stats.sharedUnresolved++; }
            }
          } else {
            if (fa.t === 'array') stats.arrayFormulas++;
            formula = ftext ? '=' + ftext : null;
          }
        }
        const vm = /<v\b[^>]*>([\s\S]*?)<\/v>|<v\s*\/>/.exec(body);
        const t = a.t || 'n';
        let value;
        let fi = -1;
        if (t === 'inlineStr') {
          const is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body);
          if (!is && !vm) {
            if (formula) { stats.formulaNoValue++; if (!push([r, c, null, formula])) { stop = true; return false; } }
            return;
          }
          value = is ? textOf(is[1]) : unescOoxml(unesc(vm[1] || ''));
        } else {
          if (!vm || vm[1] === undefined || (vm[1] === '' && t !== 's' && t !== 'str')) { // empty <v></v>: no value (not 0)
            if (formula) { stats.formulaNoValue++; if (!push([r, c, null, formula])) { stop = true; return false; } }
            return;
          }
          const raw = unesc(vm[1]);
          if (t === 's') { value = ctx.sst[parseInt(raw, 10)]; if (value === undefined) value = null; }
          else if (t === 'str') value = unescOoxml(raw);
          else if (t === 'b') value = raw === '1' || raw === 'true';
          else if (t === 'e') value = { error: raw };
          else if (t === 'd') value = raw;
          else {
            const n = Number(raw);
            value = n;
            const s = a.s ? parseInt(a.s, 10) : 0;
            const kind = ctx.styles.kind[s];
            if (kind && Number.isFinite(n)) {
              const iso = serialToIso(n, ctx.date1904, kind);
              if (iso) { value = iso; stats.dateCells++; }
            }
            if (typeof value === 'number') fi = fmtOf(s);
          }
        }
        if (!push(fi >= 0 ? [r, c, value, formula, fi] : [r, c, value, formula])) { stop = true; return false; }
      });
      if (stop) return false;
    });
  }
  let end = null, start = null;
  if (sheet.ref) {
    const parts = sheet.ref.split(':');
    end = parseCell(parts[parts.length - 1]);
    start = parseCell(parts[0]);
  }
  if (!end) { end = [Math.max(0, maxR), Math.max(0, maxC)]; sheet.ref = maxR < 0 ? 'A1' : `A1:${numToCol(maxC + 1)}${maxR + 1}`; }
  sheet.rows = Math.min(MAX_ROWS, Math.max(end[0], maxR) + 1);
  sheet.cols = Math.min(MAX_COLS, Math.max(end[1], maxC) + 1);
  if (start && (start[0] > 0 || start[1] > 0)) stats.refNotFromA1++;
  for (let c = 0; c < sheet.cols; c++) sheet.colWidths.push(widths[c] !== undefined ? widths[c] : defWidth);
  return sheet;
}

function readWorkbook(path) {
  if (fs.statSync(path).size > LIMIT_FILE) throw new Error('file too large');
  return readWorkbookBuffer(fs.readFileSync(path));
}

function readWorkbookBuffer(buf) {
  const t0 = process.hrtime.bigint();
  if (buf.length > LIMIT_FILE) throw new Error('file too large');
  const zip = openZip(buf);
  const rootRels = readRels(zip, '');
  let wbPath = 'xl/workbook.xml';
  for (const id in rootRels) if (/\/officeDocument$/.test(rootRels[id].type)) wbPath = rootRels[id].target;
  const wbXml = readXml(zip, wbPath);
  if (!wbXml) throw new Error('workbook.xml not found');
  const rels = readRels(zip, wbPath);
  const pick = (suffix) => { for (const id in rels) if (rels[id].type.endsWith(suffix)) return rels[id].target; return null; };
  const pr = /<workbookPr\b([^>]*?)\/?>/.exec(wbXml);
  const date1904 = pr ? /^(1|true)$/.test(attrs(pr[1]).date1904 || '') : false;
  const ctx = { sst: readSst(zip, pick('/sharedStrings')), styles: readStyles(zip, pick('/styles')), date1904, budget: LIMIT_CELLS, formulaChars: LIMIT_FORMULA_CHARS };
  const stats = { formulaCells: 0, sharedMasters: 0, sharedChildren: 0, sharedUnresolved: 0, formulasDropped: 0, arrayFormulas: 0, formulaNoValue: 0, dateCells: 0, refNotFromA1: 0, sheetsDropped: 0, sharedStrings: ctx.sst.length, date1904 };
  const sheets = [];
  const empty = (name, hidden, note) => ({ name, hidden, ref: null, rows: 0, cols: 0, freeze: { rows: 0, cols: 0 }, colWidths: [], merges: [], fmts: [], cells: [], truncated: false, note });
  eachEl(wbXml, 'sheet', (s) => {
    if (sheets.length >= LIMIT_SHEETS) { stats.sheetsDropped++; return false; }
    const a = attrs(s);
    const name = String(a.name || `Sheet${sheets.length + 1}`).slice(0, 200);
    const rid = a['r:id'] || Object.keys(a).filter((k) => /:id$/.test(k)).map((k) => a[k])[0];
    const rel = rels[rid];
    const hidden = a.state === 'hidden' || a.state === 'veryHidden';
    const xml = rel && /\/worksheet$/.test(rel.type) ? readXml(zip, rel.target) : null;
    sheets.push(xml ? { name, hidden, ...readSheet(xml, ctx, stats) } : empty(name, hidden, 'not a worksheet'));
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, sheets, stats };
}

module.exports = { readWorkbook, readWorkbookBuffer, shiftFormula, serialToIso, isDateFormat, dateKind };
