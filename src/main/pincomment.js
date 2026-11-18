// 15 場所を指定したコメント (docs/plan-pin-comment.md): the main-side half. Pure helpers (rect -> percent, the text handed to
// claude, the safe source key) and a small store under <folder>/.bantodesk/comments/. The picture of the place (a crop of a
// snapshot) comes from the renderer as a PNG data URL; nothing is sent outside, nothing is injected into a page.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_COMMENTS = 20;
const MAX_TEXT = 2000;
const MAX_CROP = 8 * 1024 * 1024;
const KINDS = { web: 'Web ページ', pdf: 'PDF', image: '画像', slide: '資料' };
const UNITS = { slide: 'スライド', pdf: 'ページ' };

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const pct = (n) => Math.round(clamp01(n) * 100);

// "左上から (42%, 18%)〜(80%, 30%)" for an area, "左上から (42%, 18%)" for a point
function placeText(r) {
  if (!r) return 'ページ全体';
  const p1 = `(${pct(r.x)}%, ${pct(r.y)}%)`;
  if (!(r.w > 0) && !(r.h > 0)) return `左上から ${p1}`;
  return `左上から ${p1}〜(${pct(r.x + r.w)}%, ${pct(r.y + r.h)}%)`;
}

const kindOf = (k) => (Object.prototype.hasOwnProperty.call(KINDS, k) ? k : 'web');
const sourceKey = (src) => crypto.createHash('sha1').update(`${kindOf(src && src.kind)}|${String((src && (src.path || src.url)) || '')}`).digest('hex').slice(0, 12);

function cleanSource(src) {
  const s = src || {};
  return {
    kind: kindOf(s.kind),
    path: typeof s.path === 'string' ? s.path.slice(0, 1024) : '',
    url: typeof s.url === 'string' ? s.url.slice(0, 2048) : '',
    title: typeof s.title === 'string' ? s.title.slice(0, 200) : '',
  };
}
function cleanComments(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list.slice(0, MAX_COMMENTS) : []) {
    const text = String((c && c.text) || '').trim().slice(0, MAX_TEXT);
    if (!text) continue;
    const r = c.rect && typeof c.rect === 'object'
      ? { x: clamp01(c.rect.x), y: clamp01(c.rect.y), w: clamp01(c.rect.w), h: clamp01(c.rect.h) }
      : null;
    const page = typeof c.page === 'string' || typeof c.page === 'number' ? String(c.page).trim().slice(0, 20) : '';
    out.push({ text, rect: r, page, crop: typeof c.crop === 'string' ? c.crop : '' });
  }
  return out;
}

// the text put in the input: claude is asked to answer per comment (docs/plan-present.md 回答 3)
function formatMessage(src, comments, cropPaths = []) {
  const s = cleanSource(src);
  const unit = UNITS[s.kind] || 'ページ';
  const where = s.kind === 'web' ? `${s.title ? `${s.title} ` : ''}${s.url}`.trim() : s.path;
  const lines = [`場所を指定したコメントが ${comments.length} 件あります。コメントごとに「### コメント 番号」の見出しで返信してください。`, `対象: ${KINDS[s.kind]} ${where}`.trim()];
  comments.forEach((c, i) => {
    lines.push('', `### コメント ${i + 1}`);
    lines.push(`位置: ${c.page ? `${unit} ${c.page} / ` : ''}${placeText(c.rect)}`);
    lines.push(`指摘: 「${c.text.replace(/\s*\n\s*/g, ' ')}」`);
    if (cropPaths[i]) lines.push(`画像: ${cropPaths[i]}`);
  });
  return lines.join('\n');
}

function pngFromDataUrl(u) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(u || ''));
  if (!m || m[1].length > MAX_CROP * 1.4) return null;
  const buf = Buffer.from(m[1], 'base64');
  return buf.length > 8 && buf.subarray(0, 4).toString('hex') === '89504e47' && buf.length <= MAX_CROP ? buf : null;
}

const stamp = (t) => {
  const d = new Date(t);
  const p = (n, k = 2) => String(n).padStart(k, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// Write the crops and append the comments to <dir>/.bantodesk/comments/<key>.json. -> { ok, message, cropPaths, store }
function save(dir, src, rawComments, now = Date.now()) {
  if (!dir) return { ok: false, reason: 'nofolder' };
  const s = cleanSource(src);
  const comments = cleanComments(rawComments);
  if (!comments.length) return { ok: false, reason: 'empty' };
  const root = path.join(dir, '.bantodesk', 'comments');
  const cropDir = path.join(root, 'crops');
  fs.mkdirSync(cropDir, { recursive: true });
  const gi = path.join(dir, '.bantodesk', '.gitignore');
  if (!fs.existsSync(gi)) { try { fs.writeFileSync(gi, '*\n'); } catch {} }
  const key = sourceKey(s);
  const cropPaths = comments.map((c, i) => {
    const buf = pngFromDataUrl(c.crop);
    if (!buf) return '';
    const p = path.join(cropDir, `${stamp(now)}-${key}-${i + 1}.png`);
    fs.writeFileSync(p, buf);
    return p;
  });
  const store = path.join(root, `${key}.json`);
  let doc = { source: s, comments: [] };
  try {
    const old = JSON.parse(fs.readFileSync(store, 'utf8'));
    if (old && Array.isArray(old.comments)) doc = { source: s, comments: old.comments.slice(-200) };
  } catch {}
  comments.forEach((c, i) => doc.comments.push({ at: new Date(now).toISOString(), page: c.page, rect: c.rect, text: c.text, crop: cropPaths[i] || '', state: 'sent' }));
  fs.writeFileSync(store, JSON.stringify(doc, null, 2));
  return { ok: true, message: formatMessage(s, comments, cropPaths), cropPaths: cropPaths.filter(Boolean), store };
}

function create({ ipcMain, windowOf, workDirOf, now = Date.now }) {
  const stats = { saved: 0, captured: 0 };
  function init() {
    // a picture of a rectangle of the window (the PDF / image pane): the renderer draws pins over this picture
    ipcMain.handle('comments:capture', async (e, o) => {
      try {
        const win = windowOf(e);
        const r = o && o.rect;
        if (!win || win.isDestroyed() || !r || ![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.w < 8 || r.h < 8) return { ok: false };
        const z = (win.webContents.getZoomFactor && win.webContents.getZoomFactor()) || 1; // CSS px -> DIP
        const img = await win.webContents.capturePage({ x: Math.round(r.x * z), y: Math.round(r.y * z), width: Math.round(r.w * z), height: Math.round(r.h * z) });
        if (!img || img.isEmpty()) return { ok: false };
        stats.captured++;
        return { ok: true, dataUrl: `data:image/png;base64,${img.toPNG().toString('base64')}` };
      } catch {
        return { ok: false };
      }
    });
    ipcMain.handle('comments:save', (e, o) => {
      try {
        const r = save(workDirOf(e), o && o.source, o && o.comments, now());
        if (r.ok) stats.saved++;
        return r;
      } catch {
        return { ok: false, reason: 'error' };
      }
    });
    ipcMain.handle('comments:stats', () => ({ ...stats }));
  }
  return { init, stats: () => ({ ...stats }) };
}

module.exports = { placeText, formatMessage, sourceKey, cleanComments, cleanSource, pngFromDataUrl, save, create, MAX_COMMENTS };
