// 5b viewer (docs/plan-viewer.md, CONTRACT.md "Viewer"): which files a window may show, reading them, watching them,
// and the `atview:` protocol that serves HTML / images to the viewer panels.
//
// Security model (plan-viewer.md section 4):
// - Readable scope per window: its folder + folders the user granted (drop, file dialog, or "open outside?" confirm).
//   Every path is realpath'ed before the check, so links / `..` cannot leave the scope.
// - The renderer never gets "read any path": md text, md images (data: URLs) and atview: URLs only, all checked here.
// - atview://<token>/<relative path>: token = 128-bit random per viewer; it maps to the opened file's folder (root).
//   Only files inside that root, inside the scope, with no path segment starting with "." are served.
//   HTML runs in <iframe sandbox="allow-scripts"> (opaque origin, no window.api). Its CSP allows https: by default
//   (user decision 2026-11-03) and drops it when the viewer's 「外部の通信を止める」 toggle is on. http: / ws: never.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pathToFileURL, fileURLToPath } = require('url');
const { isInside, norm } = require('./sessions');

const SCHEME = 'atview';
const KINDS = {
  md: ['md', 'markdown'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'],
  html: ['html', 'htm'],
  pdf: ['pdf'],
  xlsx: ['xlsx', 'xlsm'], // table view (stage 2): parsed by ./xlsx.js on a worker; .xls (BIFF) is not read
};
const KIND_OF = new Map(Object.entries(KINDS).flatMap(([k, exts]) => exts.map((x) => [x, k])));
const MD_MAX = 5 * 1024 * 1024;
const ASSET_MAX = 20 * 1024 * 1024;
const DEBOUNCE_MS = 300;
const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', xml: 'application/xml',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  wasm: 'application/wasm', pdf: 'application/pdf',
};

// What atview: serves below a viewer's root (anything else: 404). Data files only next to the opened file.
const SERVE_EXTS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'map', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico',
  'avif', 'woff', 'woff2', 'ttf', 'otf', 'mp4', 'webm', 'mp3', 'wav', 'ogg', 'wasm']);
const DATA_EXTS = new Set(['json', 'csv', 'txt', 'xml']);
const SERVE_DEPTH = 4; // path segments below the root, file name included

const extOf = (p) => path.extname(String(p || '')).slice(1).toLowerCase();
// \\server\share, //server/share, \\?\…, \\.\…: touching them (even realpath) makes Windows talk SMB (NTLM) to that host.
const isUncLike = (p) => /^[\\/]{2}/.test(String(p || ''));
// A drive root or the user's home: granting the whole folder would expose far too much, so only the file is granted.
const isBroadDir = (d) => norm(d) === norm(path.parse(path.resolve(d)).root) || norm(d) === norm(os.homedir());
// realpath must not change the path (except case): blocks 8.3 short names (GIT~1 -> .git), links and junctions.
const samePath = (a, b) => norm(a) === norm(b);
const kindOf = (p) => KIND_OF.get(extOf(p)) || null;

// CSP of every atview: response. `online` adds https: (never http:, ws:, wss:).
function cspFor(online) {
  const net = online ? ' https:' : '';
  return [
    "default-src atview: data: blob:",
    `script-src atview: data: blob: 'unsafe-inline' 'unsafe-eval'${net}`,
    `style-src atview: data: 'unsafe-inline'${net}`,
    `img-src atview: data: blob:${net}`,
    `font-src atview: data:${net}`,
    `connect-src atview:${net}`,
    `media-src atview: data: blob:${net}`,
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

// Must run before app 'ready'.
function registerScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
}

let deps = null; // { ipcMain, protocol, dialog, shell, chokidar, stateOf(e), windowState(wcId) }
const viewers = new Map(); // token -> Viewer
const grants = new Map(); // wcId -> Set<normalized real dir>

async function real(p) {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return null;
  }
}

async function inScope(wcId, workDir, realPath) {
  const root = (await real(workDir)) || workDir;
  if (isInside(realPath, root)) return true;
  for (const g of grants.get(wcId) || []) {
    if (g.file ? norm(realPath) === g.file : isInside(realPath, g.dir)) return true;
  }
  return false;
}

// The folder of a file the user picked / dropped / confirmed (MD images, HTML assets next to it), or just the file.
function grant(wcId, realFile) {
  if (!grants.has(wcId)) grants.set(wcId, []);
  const dir = path.dirname(realFile);
  grants.get(wcId).push(isBroadDir(dir) ? { file: norm(realFile) } : { dir: norm(dir) });
}

const urlOf = (v) => `${SCHEME}://${v.token}/${encodeURIComponent(path.basename(v.path))}?g=${v.gen}`;

function publicInfo(v, extra = {}) {
  const info = { ok: true, id: v.token, path: v.path, name: path.basename(v.path), kind: v.kind, offline: v.offline };
  if (v.kind === 'html' || v.kind === 'image') info.url = urlOf(v);
  if (v.kind === 'pdf') info.fileUrl = pathToFileURL(v.path).href;
  return { ...info, ...extra };
}

function viewerOf(e, id) {
  const s = deps.stateOf(e);
  const v = typeof id === 'string' ? viewers.get(id) : null;
  return s && v && v.wcId === e.sender.id ? v : null;
}

// --- watching -------------------------------------------------------------------------------------------------
function startWatch(v) {
  const opts = {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    ignored: (p) => /[\\/](node_modules|\.git)([\\/]|$)/.test(p),
  };
  if (v.kind === 'html' && !isBroadDir(v.root)) {
    opts.depth = 2;
    v.watcher = deps.chokidar.watch(v.root, opts);
  } else {
    v.watcher = deps.chokidar.watch(v.path, opts);
  }
  const fire = () => {
    clearTimeout(v.timer);
    v.timer = setTimeout(async () => {
      if (!viewers.has(v.token)) return;
      let gone = false;
      try {
        gone = !(await fs.promises.stat(v.path)).isFile();
      } catch {
        gone = true;
      }
      const s = deps.windowState(v.wcId);
      if (s && !s.win.isDestroyed()) s.win.webContents.send('viewer:changed', { id: v.token, gone });
    }, DEBOUNCE_MS);
  };
  v.watcher.on('all', fire);
  v.watcher.on('error', (err) => console.warn('[viewer] watch error', err && err.message));
}

// --- xlsx ---------------------------------------------------------------------------------------------------------
// Each xlsx viewer has its own worker thread (eval source like offthread.js; the parser is required by absolute path).
// The worker parses and keeps the workbook; main only relays: the sheet list, then one sheet at a time as a JSON
// string (cloning a string is a copy, not a walk over millions of cells, so main never stalls or holds the workbook).
// A call that takes longer than XLSX_TIMEOUT_MS kills the worker; the next call starts a new one. Closing the viewer
// kills it too.
const XLSX_TIMEOUT_MS = 30000;
const XLSX_WORKER_SRC = `
const { parentPort, workerData } = require('worker_threads');
const X = require(workerData.mod);
let wb = null;
parentPort.on('message', (m) => {
  try {
    if (m.op === 'parse') {
      wb = null;
      wb = X.readWorkbook(m.path);
      parentPort.postMessage({ seq: m.seq, ok: true, sheets: wb.sheets.map((s) => ({ name: s.name, hidden: s.hidden, rows: s.rows, cols: s.cols, note: s.note || null })) });
    } else if (m.op === 'sheet') {
      const s = wb && wb.sheets[m.i];
      parentPort.postMessage(s ? { seq: m.seq, ok: true, json: JSON.stringify(s) } : { seq: m.seq, ok: false, reason: 'nosheet' });
    }
  } catch (err) {
    parentPort.postMessage({ seq: m.seq, ok: false, reason: String(err && err.message || err) });
  }
});`;

function xlsxWorkerStop(v) {
  const x = v.xw;
  if (!x) return;
  v.xw = null;
  v.xKey = null;
  for (const done of x.pending.values()) done({ ok: false, reason: 'stopped' });
  x.pending.clear();
  x.worker.terminate().catch(() => {});
}

function xlsxCall(v, msg) {
  if (!v.xw) {
    let worker;
    try {
      const { Worker } = require('worker_threads');
      worker = new Worker(XLSX_WORKER_SRC, { eval: true, workerData: { mod: path.join(__dirname, 'xlsx.js') }, resourceLimits: { maxOldGenerationSizeMb: 1536 } });
    } catch (err) {
      return Promise.resolve({ ok: false, reason: `worker: ${err && err.message}` });
    }
    const x = { worker, seq: 0, pending: new Map() };
    const fail = (reason) => {
      if (v.xw !== x) return;
      for (const done of x.pending.values()) done({ ok: false, reason });
      x.pending.clear();
      v.xw = null;
      v.xKey = null;
    };
    worker.on('message', (r) => {
      const done = x.pending.get(r && r.seq);
      x.pending.delete(r && r.seq);
      if (done) done(r);
    });
    worker.on('error', (err) => fail(String(err && err.message || err)));
    worker.on('exit', () => fail('worker exited'));
    worker.unref();
    v.xw = x;
  }
  const x = v.xw;
  return new Promise((resolve) => {
    const seq = ++x.seq;
    const timer = setTimeout(() => {
      x.pending.delete(seq);
      resolve({ ok: false, reason: 'timeout' });
      if (v.xw === x) xlsxWorkerStop(v);
    }, XLSX_TIMEOUT_MS);
    x.pending.set(seq, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    x.worker.postMessage({ ...msg, seq });
  });
}

// Parse once per version of the file (mtime + size). A call for a newer version never takes over a parse of an
// older one; the worker runs calls in order, so a sheet request always reads the latest parse.
function xlsxParsed(v, key) {
  if (v.xKey === key && v.xSheets) return Promise.resolve({ ok: true, sheets: v.xSheets });
  if (!v.xJob || v.xJob.key !== key) {
    const job = { key, p: xlsxCall(v, { op: 'parse', path: v.path }) };
    v.xJob = job;
    job.p.then((r) => {
      if (v.xJob !== job) return;
      v.xJob = null;
      if (r.ok) {
        v.xKey = key;
        v.xSheets = r.sheets;
      }
    });
  }
  return v.xJob.p;
}

const XLSX_REASON = { 'file too large': 'toolarge', timeout: 'timeout' };
// { id } -> { ok, kind: 'xlsx', mtime, sheets: [{ name, hidden, rows, cols, note }] } (parses again when the file changed)
// { id, sheet: i } -> { ok, mtime, sheetJson } (one sheet per call: a whole workbook can be MBs of JSON)
async function readXlsx(v, o) {
  let st;
  try {
    // the path was realpath'ed when it was opened: a link swapped in later must not lead outside the scope
    if (!samePath((await real(v.path)) || '', v.path)) return { ok: false, reason: 'missing' };
    st = await fs.promises.stat(v.path);
    if (!st.isFile()) return { ok: false, reason: 'missing' };
  } catch {
    return { ok: false, reason: 'missing' };
  }
  const key = `${st.mtimeMs}:${st.size}`;
  const r = await xlsxParsed(v, key);
  if (!viewers.has(v.token)) return { ok: false, reason: 'noviewer' };
  if (!r.ok) return { ok: false, reason: XLSX_REASON[r.reason] || r.reason };
  if (!Number.isInteger(o && o.sheet)) return { ok: true, kind: 'xlsx', mtime: st.mtimeMs, sheets: r.sheets };
  const s = await xlsxCall(v, { op: 'sheet', i: o.sheet });
  if (!viewers.has(v.token)) return { ok: false, reason: 'noviewer' };
  if (!s.ok) return { ok: false, reason: XLSX_REASON[s.reason] || s.reason };
  return { ok: true, mtime: st.mtimeMs, sheetJson: s.json };
}

function closeViewer(v) {
  if (!v) return;
  viewers.delete(v.token);
  xlsxWorkerStop(v);
  v.xSheets = null;
  clearTimeout(v.timer);
  try {
    v.watcher?.close();
  } catch {}
}

// --- open -------------------------------------------------------------------------------------------------------
// o = { path, source: 'drop'|'dialog'|'link'|'event'|'conversation' }. A path outside the scope opens without asking
// only for a drop or the file dialog (the user picked it); anything else asks in a native dialog first.
async function open(e, o) {
  const s = deps.stateOf(e);
  if (!s) return { ok: false, reason: 'nowindow' };
  const raw = o && typeof o.path === 'string' ? o.path.trim() : '';
  if (!raw || raw.length > 4096 || raw.includes('\0')) return { ok: false, reason: 'badpath' };
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(s.workDir, raw);
  if ((isUncLike(raw) || isUncLike(abs)) && !isUncLike(s.workDir)) return { ok: false, reason: 'unc' };
  const kind = kindOf(abs);
  if (!kind) return { ok: false, reason: 'unsupported' };
  const rp = await real(abs);
  if (!rp) return { ok: false, reason: 'missing' };
  // the kind is decided by the real file too (a link "x.pdf" -> evil.html must not load as an unsandboxed PDF frame)
  if (kindOf(rp) !== kind) return { ok: false, reason: 'unsupported' };
  try {
    if (!(await fs.promises.stat(rp)).isFile()) return { ok: false, reason: 'missing' };
  } catch {
    return { ok: false, reason: 'missing' };
  }
  const wcId = e.sender.id;
  if (!(await inScope(wcId, s.workDir, rp))) {
    const source = o && o.source;
    if (source !== 'drop' && source !== 'dialog') {
      // automated checks (tmp/viewer/e2e.mjs) cannot click a native dialog: AGENT_TERMINAL_VIEWER_OUTSIDE=deny answers it
      if (process.env.AGENT_TERMINAL_VIEWER_OUTSIDE === 'deny') return { ok: false, reason: 'outside' };
      const r = await deps.dialog.showMessageBox(s.win, {
        type: 'question',
        buttons: ['開く', 'キャンセル'],
        defaultId: 1,
        cancelId: 1,
        title: 'ビューア',
        message: '作業フォルダの外のファイルです。ビューアで開きますか？',
        detail: `${rp}\n\n開くと、このファイルのフォルダもこのウィンドウのビューアから読めるようになります。`,
        noLink: true,
      });
      if (r.response !== 0) return { ok: false, reason: 'outside' };
    }
    grant(wcId, rp);
  }
  for (const v of viewers.values()) {
    if (v.wcId === wcId && norm(v.path) === norm(rp)) return publicInfo(v, { existing: true });
  }
  const v = {
    token: crypto.randomBytes(16).toString('hex'),
    wcId,
    path: rp,
    root: path.dirname(rp),
    kind,
    offline: false,
    gen: 1,
    watcher: null,
    timer: 0,
  };
  viewers.set(v.token, v);
  startWatch(v);
  return publicInfo(v);
}

// --- atview: ------------------------------------------------------------------------------------------------------
const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });

async function serve(req) {
  let u;
  try {
    u = new URL(req.url);
  } catch {
    return notFound();
  }
  const v = viewers.get(u.hostname);
  if (!v || (req.method !== 'GET' && req.method !== 'HEAD')) return notFound();
  let rel;
  try {
    rel = decodeURIComponent(u.pathname);
  } catch {
    return notFound();
  }
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  if (!segs.length || segs.length > SERVE_DEPTH) return notFound();
  if (segs.some((x) => x.startsWith('.') || x.includes(':') || x.includes('\0') || x.includes('~') || /[. ]$/.test(x))) return notFound();
  const ext = extOf(segs[segs.length - 1]);
  if (!SERVE_EXTS.has(ext) && !(DATA_EXTS.has(ext) && segs.length === 1)) return notFound();
  const abs = path.resolve(v.root, ...segs);
  if (!isInside(abs, v.root)) return notFound();
  const rp = await real(abs);
  const s = deps.windowState(v.wcId);
  if (!rp || !s || !samePath(rp, abs) || !(await inScope(v.wcId, s.workDir, rp))) return notFound();
  let st;
  try {
    st = await fs.promises.stat(rp);
  } catch {
    return notFound();
  }
  if (!st.isFile()) return notFound();
  const headers = {
    'Content-Type': MIME[extOf(rp)] || 'application/octet-stream',
    'Content-Length': String(st.size),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': cspFor(v.kind === 'html' && !v.offline),
    // the sandboxed page has an opaque origin: module scripts / fetch of its own files are cross-origin
    'Access-Control-Allow-Origin': '*',
  };
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(Readable.toWeb(fs.createReadStream(rp)), { status: 200, headers });
}

// --- IPC --------------------------------------------------------------------------------------------------------
function init(d) {
  deps = d;
  const { ipcMain, protocol, dialog, shell } = d;
  protocol.handle(SCHEME, (req) => serve(req).catch(() => notFound()));
  // No permission (camera, mic, geolocation, clipboard, notifications, …) for viewer pages; others keep Electron's default.
  if (d.session) {
    const fromViewer = (wc, url) => /^atview:/i.test(String(url || '')) || false;
    d.session.defaultSession.setPermissionRequestHandler((wc, _perm, cb, details) => cb(!fromViewer(wc, details && (details.requestingUrl || details.securityOrigin))));
    d.session.defaultSession.setPermissionCheckHandler((wc, _perm, origin, details) => !fromViewer(wc, (details && details.requestingUrl) || origin));
  }

  ipcMain.handle('viewer:open', (e, o) => open(e, o).catch((err) => ({ ok: false, reason: String(err && err.message) })));

  ipcMain.handle('viewer:pick', async (e) => {
    const s = deps.stateOf(e);
    if (!s) return { ok: false, reason: 'nowindow' };
    const r = await dialog.showOpenDialog(s.win, {
      title: 'ビューアで開く',
      defaultPath: s.workDir,
      properties: ['openFile'],
      filters: [
        { name: 'ビューアで開けるファイル', extensions: [...KIND_OF.keys()] },
        { name: 'すべてのファイル', extensions: ['*'] },
      ],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, reason: 'cancelled' };
    return open(e, { path: r.filePaths[0], source: 'dialog' });
  });

  ipcMain.handle('viewer:read', async (e, o) => {
    const v = viewerOf(e, o && o.id);
    if (v && v.kind === 'xlsx') return readXlsx(v, o).catch((err) => ({ ok: false, reason: String(err && err.message) }));
    if (!v || v.kind !== 'md') return { ok: false, reason: 'noviewer' };
    try {
      const st = await fs.promises.stat(v.path);
      if (st.size > MD_MAX) return { ok: false, reason: 'toolarge' };
      const text = (await fs.promises.readFile(v.path, 'utf8')).replace(/^﻿/, '');
      return { ok: true, text, mtime: st.mtimeMs };
    } catch {
      return { ok: false, reason: 'missing' };
    }
  });

  // Images referenced by an md file: relative to it, absolute, or file:///. Any readable-scope image, as a data: URL.
  ipcMain.handle('viewer:asset', async (e, o) => {
    const v = viewerOf(e, o && o.id);
    const src = o && typeof o.src === 'string' ? o.src.trim() : '';
    if (!v || v.kind !== 'md' || !src || src.length > 4096) return null;
    let p;
    if (isUncLike(src) || /^file:\/\/(?!\/)/i.test(src)) return null; // UNC / file://host: never touch other hosts
    try {
      if (/^file:/i.test(src)) p = fileURLToPath(src);
      else if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[A-Za-z]:[\\/]/.test(src)) return null; // other schemes
      else {
        const clean = decodeURI(src.split(/[?#]/)[0]);
        p = path.isAbsolute(clean) ? path.resolve(clean) : path.resolve(path.dirname(v.path), clean);
      }
    } catch {
      return null;
    }
    const ext = extOf(p);
    if (!KINDS.image.includes(ext) || isUncLike(p)) return null;
    const rp = await real(p);
    if (rp && extOf(rp) !== ext) return null;
    const s = deps.stateOf(e);
    if (!rp || !(await inScope(v.wcId, s.workDir, rp))) return null;
    try {
      const st = await fs.promises.stat(rp);
      if (!st.isFile() || st.size > ASSET_MAX) return null;
      try {
        v.watcher?.add(rp);
      } catch {}
      return `data:${MIME[ext]};base64,${(await fs.promises.readFile(rp)).toString('base64')}`;
    } catch {
      return null;
    }
  });

  ipcMain.handle('viewer:setOffline', (e, o) => {
    const v = viewerOf(e, o && o.id);
    if (!v) return { ok: false };
    v.offline = !!(o && o.offline);
    v.gen++;
    return { ok: true, url: v.kind === 'html' || v.kind === 'image' ? urlOf(v) : null, offline: v.offline };
  });

  ipcMain.on('viewer:close', (e, o) => closeViewer(viewerOf(e, o && o.id)));
  ipcMain.on('viewer:openExternal', (e, o) => {
    const v = viewerOf(e, o && o.id);
    if (v) shell.openPath(v.path).catch(() => {});
  });
  ipcMain.on('viewer:showInFolder', (e, o) => {
    const v = viewerOf(e, o && o.id);
    if (v) shell.showItemInFolder(v.path);
  });
}

// A sub-frame of a window wants to navigate (main.js 'will-frame-navigate'). Returns 'allow' (stay: atview:, the PDF
// viewer), 'open' (http(s) link out of a viewer page: the default browser opens it), or 'deny'.
// A page may leave by script without a click, so: never while that viewer is offline, at most one per 10 s per
// viewer and 5 per viewer in total (then silently denied).
const EXTERNAL_GAP_MS = 10000;
const EXTERNAL_MAX = 5;
function frameTargetAllowed(toUrl) {
  const to = String(toUrl || '');
  if (/^atview:/i.test(to) || to === 'about:blank' || /^about:srcdoc$/i.test(to)) return true;
  if (/^file:/i.test(to) && /\.pdf$/i.test(to.split(/[?#]/)[0])) return true;
  return /^chrome-extension:\/\/mhjfbmdgcfjbbpaeojofohoefgiehjai\//i.test(to); // Chromium's PDF viewer
}
function viewerOfUrl(wcId, url) {
  try {
    const u = new URL(String(url || ''));
    const v = u.protocol === `${SCHEME}:` ? viewers.get(u.hostname) : null;
    return v && v.wcId === wcId ? v : null;
  } catch {
    return null;
  }
}
// atview: frames run out of process: Electron 33 does not emit will-frame-navigate for navigations they start, only
// did-start-navigation (not cancelable). The page CSP (frame-src 'self' atview:) blocks the load itself; main then
// opens an http(s) target in the browser (rules below) and tells the viewer to load its page again.
function frameLeft(wcId, initiatorUrl, toUrl) {
  if (frameTargetAllowed(toUrl)) return;
  const v = viewerOfUrl(wcId, initiatorUrl);
  if (!v) return;
  const verdict = frameNavigation(wcId, initiatorUrl, toUrl);
  // a page that leaves again right after loading would loop: reload at most once per 5 s (else the error page stays)
  const now = Date.now();
  const s = deps && deps.windowState(wcId);
  if (now - (v.bounceAt || 0) > 5000 && s && !s.win.isDestroyed()) {
    v.bounceAt = now;
    s.win.webContents.send('viewer:changed', { id: v.token, gone: false });
  }
  return verdict;
}
function frameNavigation(wcId, fromUrl, toUrl) {
  const to = String(toUrl || '');
  if (frameTargetAllowed(to)) return 'allow';
  if (!/^https?:\/\//i.test(to)) return 'deny';
  const v = viewerOfUrl(wcId, fromUrl);
  if (!v || v.offline) return 'deny';
  const now = Date.now();
  if ((v.externalCount || 0) >= EXTERNAL_MAX || now - (v.externalAt || 0) < EXTERNAL_GAP_MS) return 'deny';
  v.externalAt = now;
  v.externalCount = (v.externalCount || 0) + 1;
  return 'open';
}

// The window closed or its page reloaded: stop all its viewers (and forget its grants on close).
function windowGone(wcId, { closed = false } = {}) {
  for (const v of [...viewers.values()]) if (v.wcId === wcId) closeViewer(v);
  if (closed) grants.delete(wcId);
}

module.exports = { registerScheme, init, windowGone, frameNavigation, frameLeft, frameTargetAllowed, kindOf, cspFor, SCHEME, _viewers: viewers };
