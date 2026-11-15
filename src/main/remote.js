'use strict';
// LAN remote: serves a small mobile web UI (src/remote) over plain HTTP so a phone on the same
// network can watch agent tabs and answer prompts. Off by default. See CONTRACT.md "main.js ↔ remote.js".
//
// The HTTP part (createServer) has no Electron dependency and can be exercised from plain Node.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const DEFAULT_PORT = 8790;
const PORT_TRIES = 10;
const COOKIE = 'at_remote';
const MAX_BODY = 16 * 1024;
const MAX_TEXT = 4000;
const PUSH_THROTTLE_MS = 300;
const HEARTBEAT_MS = 15000;
const KEYS = ['enter', 'esc', 'up', 'down', 'left', 'right', 'tab', 'shift-tab', 'ctrl-c'];
const STATIC_DIR = path.join(__dirname, '..', 'remote');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const AUTH_FAIL_WINDOW_MS = 60 * 1000;
const AUTH_FAIL_MAX = 10;

const newToken = () => crypto.randomBytes(18).toString('base64url');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
  }
  return out;
}

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Length': buf.length, ...headers });
  res.end(buf);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

const PAGE_401 = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>401</title></head>
<body style="background:#1e1e2e;color:#cdd6f4;font-family:sans-serif;padding:24px">
<h2>認証が必要です</h2><p>PC の BantoDesk の「Remote」から表示される URL / QR コードを開いてください。</p>
<p>トークンが再生成された場合は、新しい URL を開き直してください。</p></body></html>`;

function send401(res, api) {
  if (api) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  // The 401 page uses an inline style; give it its own CSP that allows only that.
  send(res, 401, PAGE_401, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
}

/** Validate an action payload against state. Returns { ok, error?, action? } */
function validateAction(body, state) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'bad body' };
  const { wcId, tabId, type } = body;
  let { value } = body;
  if (!Number.isInteger(wcId)) return { ok: false, error: 'bad wcId' };
  if (typeof tabId !== 'string' || !tabId || tabId.length > 200) return { ok: false, error: 'bad tabId' };
  if (type === 'text') {
    if (typeof value !== 'string' || !value.length || value.length > MAX_TEXT) return { ok: false, error: 'bad text' };
  } else if (type === 'choice') {
    if (typeof value === 'string' && /^[1-9]$/.test(value)) value = Number(value);
    if (!Number.isInteger(value) || value < 1 || value > 9) return { ok: false, error: 'bad choice' };
  } else if (type === 'key') {
    if (!KEYS.includes(value)) return { ok: false, error: 'bad key' };
  } else {
    return { ok: false, error: 'bad type' };
  }
  const proj = (state && state.projects || []).find((p) => p.wcId === wcId);
  if (!proj) return { ok: false, error: 'unknown window' };
  if (!(proj.tabs || []).some((t) => t && t.id === tabId)) return { ok: false, error: 'unknown tab' };
  return { ok: true, action: { wcId, tabId, type, value } };
}

/**
 * Plain-Node HTTP server.
 * opts: { getState(): object, onAction({wcId,tabId,type,value}): boolean|void, getToken(): string,
 *         staticDir?, log? }
 * returns { server, listen(port, host) → Promise<port>, close() → Promise, push(), dropClients(), clientCount() }
 */
function createServer(opts) {
  const getToken = opts.getToken || (() => opts.token);
  const staticDir = opts.staticDir || STATIC_DIR;
  const log = opts.log || (() => {});
  const clients = new Set();
  const authFails = new Map(); // ip -> { count, since }
  let pushTimer = null;
  let lastPush = 0;

  const ipOf = (req) => req.socket.remoteAddress || '?';
  const isBlocked = (ip) => {
    const f = authFails.get(ip);
    if (!f) return false;
    if (Date.now() - f.since > AUTH_FAIL_WINDOW_MS) { authFails.delete(ip); return false; }
    return f.count >= AUTH_FAIL_MAX;
  };
  const noteFail = (ip) => {
    const now = Date.now();
    const f = authFails.get(ip);
    if (!f || now - f.since > AUTH_FAIL_WINDOW_MS) authFails.set(ip, { count: 1, since: now });
    else f.count++;
    if (authFails.size > 1000) authFails.clear();
  };

  const authed = (req) => {
    const token = getToken();
    const c = parseCookies(req.headers.cookie)[COOKIE];
    if (c && safeEqual(c, token)) return true;
    const a = req.headers.authorization;
    if (a && a.startsWith('Bearer ') && safeEqual(a.slice(7).trim(), token)) return true;
    return false;
  };

  const stateJson = () => {
    let st;
    try { st = opts.getState(); } catch (e) { log('getState failed', e); st = { projects: [], snippets: [] }; }
    return JSON.stringify({ ...st, serverTime: Date.now() });
  };

  // A client that stopped reading (phone asleep, half-open TCP) would make Node buffer every push
  // (each up to ~100 KB, one per few seconds) until the socket dies. Past the limit it is dropped;
  // EventSource reconnects (retry: 3000) and gets the full state again.
  const SSE_MAX_BUFFERED = 2 * 1024 * 1024;
  function sseWrite(res, data) {
    try {
      if (res.writableLength > SSE_MAX_BUFFERED) {
        clients.delete(res);
        res.destroy();
        return;
      }
      res.write(data);
    } catch { /* closed */ }
  }

  function doPush() {
    pushTimer = null;
    lastPush = Date.now();
    if (!clients.size) return;
    const data = `event: state\ndata: ${stateJson()}\n\n`;
    for (const res of [...clients]) sseWrite(res, data);
  }
  function push() {
    if (pushTimer) return;
    const wait = Math.max(0, PUSH_THROTTLE_MS - (Date.now() - lastPush));
    pushTimer = setTimeout(doPush, wait);
  }

  const heartbeat = setInterval(() => {
    for (const res of [...clients]) sseWrite(res, `: hb ${Date.now()}\n\n`);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  function dropClients() {
    for (const res of clients) { try { res.end(); } catch { /* ignore */ } }
    clients.clear();
  }

  function serveStatic(res, name, type) {
    fs.readFile(path.join(staticDir, name), (err, buf) => {
      if (err) return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      send(res, 200, buf, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    });
  }

  function handleSse(req, res) {
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: state\ndata: ${stateJson()}\n\n`);
    clients.add(res);
    const done = () => clients.delete(res);
    req.on('close', done);
    res.on('error', done);
  }

  function handleAction(req, res) {
    const ct = String(req.headers['content-type'] || '');
    if (!ct.toLowerCase().startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'json only' });
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_BODY) { sendJson(res, 413, { ok: false, error: 'too large' }); req.destroy(); return; }
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY) {
        aborted = true;
        sendJson(res, 413, { ok: false, error: 'too large' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
      let st;
      try { st = opts.getState(); } catch { st = { projects: [] }; }
      const v = validateAction(body, st);
      if (!v.ok) return sendJson(res, 400, v);
      let r;
      try { r = opts.onAction(v.action); } catch (e) { log('onAction failed', e); r = false; }
      if (r === false) return sendJson(res, 409, { ok: false, error: 'window not available' });
      sendJson(res, 200, { ok: true });
    });
    req.on('error', () => {});
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'bad request'); }
    const p = url.pathname;
    const ip = ipOf(req);
    const api = p.startsWith('/api/');

    // Token login: GET /?t=token → cookie + redirect to "/" (token removed from the address bar)
    if (req.method === 'GET' && p === '/' && url.searchParams.has('t')) {
      if (isBlocked(ip)) return send(res, 429, 'too many attempts', { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' });
      if (safeEqual(url.searchParams.get('t'), getToken())) {
        authFails.delete(ip);
        return send(res, 302, '', {
          Location: '/',
          'Cache-Control': 'no-store',
          'Set-Cookie': `${COOKIE}=${encodeURIComponent(getToken())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
        });
      }
      noteFail(ip);
      return send401(res, false);
    }

    if (!authed(req)) {
      if (isBlocked(ip)) return send(res, 429, 'too many attempts', { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' });
      // Only count attempts that actually present credentials (stale cookies / bearer).
      if (req.headers.authorization || parseCookies(req.headers.cookie)[COOKIE]) noteFail(ip);
      return send401(res, api);
    }

    if (req.method === 'GET' && STATIC[p]) return serveStatic(res, STATIC[p][0], STATIC[p][1]);
    if (req.method === 'GET' && p === '/api/state') {
      return send(res, 200, stateJson(), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    }
    if (req.method === 'GET' && p === '/api/events') return handleSse(req, res);
    if (p === '/api/action') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' });
      return handleAction(req, res);
    }
    if (api) return sendJson(res, 404, { ok: false, error: 'not found' });
    send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  });
  server.keepAliveTimeout = 5000;

  function listen(port, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      const onErr = (e) => { server.off('listening', onOk); reject(e); };
      const onOk = () => { server.off('error', onErr); resolve(server.address().port); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, host);
    });
  }

  function close() {
    clearInterval(heartbeat);
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    dropClients();
    return new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return { server, listen, close, push, dropClients, clientCount: () => clients.size };
}

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (v4 && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  // Prefer typical private LAN ranges first (192.168 → 10 → 172.16-31 → others).
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

// ---------------------------------------------------------------------------------------------
// Electron side

let ctx = null; // { ipcMain, app, listWindows, getSnippets }
let cfg = { enabled: false, port: DEFAULT_PORT, token: '' };
let srv = null; // createServer() result while running
let boundPort = null;
let lastError = null;
let qrCache = { url: null, dataUrl: null };
const tabsByWc = new Map(); // wcId -> TabState[]

const cfgFile = () => path.join(ctx.app.getPath('userData'), 'remote.json');

function loadCfg() {
  try {
    const j = JSON.parse(fs.readFileSync(cfgFile(), 'utf8'));
    if (typeof j.enabled === 'boolean') cfg.enabled = j.enabled;
    if (Number.isInteger(j.port) && j.port > 0 && j.port < 65536) cfg.port = j.port;
    if (typeof j.token === 'string' && j.token.length >= 16) cfg.token = j.token;
  } catch { /* first run */ }
  if (!cfg.token) { cfg.token = newToken(); saveCfg(); }
}

function saveCfg() {
  try {
    fs.mkdirSync(path.dirname(cfgFile()), { recursive: true });
    fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2));
  } catch (e) { console.error('[remote] save failed', e); }
}

function windows() {
  try { return (ctx.listWindows() || []).filter((w) => w && w.win && !w.win.isDestroyed()); } catch { return []; }
}

const pick = (t) => ({
  id: String(t.id), label: t.label, status: t.status, active: !!t.active, cwd: t.cwd, worktree: t.worktree || null,
  model: t.model || null, contextPct: t.contextPct ?? null, costUsd: t.costUsd ?? null,
  todos: Array.isArray(t.todos) ? t.todos.slice(0, 100) : [],
  subagents: Array.isArray(t.subagents) ? t.subagents.slice(0, 50) : [],
  team: t.team && Array.isArray(t.team.members)
    ? { name: String(t.team.name || ''), removed: !!t.team.removed, members: t.team.members.slice(0, 30) }
    : null,
  screen: Array.isArray(t.screen) ? t.screen.slice(-80).map((l) => String(l).slice(0, 400)) : [],
  choices: t.choices && Array.isArray(t.choices.options) ? t.choices : null,
  updatedAt: t.updatedAt || null,
});

function getState() {
  const projects = windows().map((w) => ({
    wcId: w.wcId,
    workDir: w.workDir || '',
    name: w.workDir ? path.basename(w.workDir) || w.workDir : '(no folder)',
    tabs: tabsByWc.get(w.wcId) || [],
  }));
  let snippets = [];
  try {
    snippets = (ctx.getSnippets() || []).filter((s) => s && typeof s.text === 'string')
      .map((s) => ({ id: s.id, group: s.group || '', title: s.title || '', text: s.text, submit: s.submit !== false }));
  } catch { /* ignore */ }
  return { projects, snippets };
}

function deliver(action) {
  const w = windows().find((x) => x.wcId === action.wcId);
  if (!w) return false;
  w.win.webContents.send('remote:action', { tabId: action.tabId, type: action.type, value: action.value });
  return true;
}

async function status() {
  const running = !!srv && boundPort != null;
  const urls = running ? lanAddresses().map((ip) => `http://${ip}:${boundPort}/?t=${cfg.token}`) : [];
  let qrDataUrl = null;
  if (urls[0]) {
    if (qrCache.url === urls[0]) qrDataUrl = qrCache.dataUrl;
    else {
      try {
        qrDataUrl = await require('qrcode').toDataURL(urls[0], { margin: 1, width: 240 });
        qrCache = { url: urls[0], dataUrl: qrDataUrl };
      } catch (e) { console.error('[remote] qr failed', e); }
    }
  }
  return {
    enabled: running,
    port: running ? boundPort : cfg.port,
    urls,
    qrDataUrl,
    error: lastError || (running && !urls.length ? 'LAN の IPv4 アドレスが見つかりません（ネットワーク未接続？）' : null),
  };
}

async function broadcast() {
  const st = await status();
  for (const w of windows()) { try { w.win.webContents.send('remote:status', st); } catch { /* ignore */ } }
  return st;
}

async function start() {
  if (srv) return true;
  lastError = null;
  const base = cfg.port;
  for (let i = 0; i < PORT_TRIES; i++) {
    const port = base + i;
    if (port > 65535) break;
    const s = createServer({ getState, onAction: deliver, getToken: () => cfg.token, log: (...a) => console.error('[remote]', ...a) });
    try {
      boundPort = await s.listen(port, '0.0.0.0');
      srv = s;
      srv.server.on('error', (e) => console.error('[remote] server error', e));
      if (boundPort !== cfg.port) { cfg.port = boundPort; saveCfg(); }
      return true;
    } catch (e) {
      await s.close();
      if (e.code === 'EADDRINUSE') continue;
      lastError = e.code === 'EACCES'
        ? `ポート ${port} を開けません（権限がありません: EACCES）`
        : `サーバーを起動できません: ${e.code || e.message}`;
      boundPort = null;
      return false;
    }
  }
  boundPort = null;
  lastError = `ポート ${base}〜${base + PORT_TRIES - 1} はすべて使用中です`;
  return false;
}

async function stop() {
  const s = srv;
  srv = null;
  boundPort = null;
  if (s) await s.close();
}

async function setEnabled(on) {
  if (on) {
    const ok = await start();
    cfg.enabled = ok;
  } else {
    await stop();
    cfg.enabled = false;
    lastError = null;
  }
  saveCfg();
  return broadcast();
}

async function regenToken() {
  cfg.token = newToken();
  saveCfg();
  qrCache = { url: null, dataUrl: null };
  if (srv) srv.dropClients();
  return broadcast();
}

function init(o) {
  ctx = o;
  loadCfg();
  const { ipcMain, app } = o;

  ipcMain.on('remote:state', (e, payload) => {
    const wcId = e.sender.id;
    if (!windows().some((w) => w.wcId === wcId)) return;
    const tabs = payload && Array.isArray(payload.tabs) ? payload.tabs.filter((t) => t && t.id != null).slice(0, 50).map(pick) : [];
    tabsByWc.set(wcId, tabs);
    if (srv) srv.push();
  });
  ipcMain.handle('remote:getStatus', () => status());
  ipcMain.handle('remote:setEnabled', (_e, on) => setEnabled(!!on));
  ipcMain.handle('remote:regenToken', () => regenToken());

  app.on('before-quit', () => { if (srv) srv.close(); });

  // Always start OFF: opening a LAN port that can drive the agents must be an explicit choice
  // each run, never a side effect of launching the app.
  cfg.enabled = false;
}

function windowClosed(wcId) {
  tabsByWc.delete(wcId);
  if (srv) srv.push();
}

module.exports = { init, windowClosed };
// Internal, for tests only.
module.exports._internal = { createServer, validateAction, lanAddresses, KEYS };
