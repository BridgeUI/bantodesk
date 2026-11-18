// 内蔵ブラウザ (PROGRESS 6, docs/plan-browser.md): one WebContentsView per `browser` pane, laid over the pane's rectangle in
// the window. Sandboxed, no preload, an own persistent partition, http(s) only, every permission refused, downloads only after
// a confirmation, a new window = a new tab (pane) in the renderer. Not seen = taken off the window (the page stays alive);
// closed = removed and webContents.close()d, the reference dropped.
const fs = require('fs');
const path = require('path');

const PARTITION = 'persist:bantodesk-browser';
const MAX_URL = 4096;
const MAX_VIEWS = 12;
// files a page may not put in the Downloads folder (a program / script / shortcut an EDR would watch)
const RISKY_EXT = /\.(exe|msi|bat|cmd|com|scr|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|jar|dll|sh|command|app|pkg|dmg|appimage|reg|cpl|msc|iso)$/i;

// What the address box got -> an http(s) URL string, or '' (nothing usable). A bare host gets a scheme: http for localhost /
// 127.0.0.1 / [::1] / an IPv4 address, https for the rest. Other schemes (file:, javascript:, data:, ...) are refused.
function normalizeUrl(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s || s.length > MAX_URL || /[\s\u0000-\u001f]/.test(s)) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return urlAllowed(s) ? s : '';
  if (!/^[^/?#:]+:\d+([/?#]|$)/.test(s) && /^[a-z][a-z0-9+.-]*:/i.test(s)) return ''; // javascript:, data:, mailto:, file: ...
  const host = s.split(/[/?#]/)[0].replace(/:\d+$/, '');
  const local = /^(localhost|\[::1\]|\d{1,3}(\.\d{1,3}){3})$/i.test(host) || /\.localhost$/i.test(host);
  s = (local ? 'http://' : 'https://') + s;
  return urlAllowed(s) ? s : '';
}
function urlAllowed(u) {
  try {
    const x = new URL(String(u));
    return (x.protocol === 'http:' || x.protocol === 'https:') && !!x.hostname && String(u).length <= MAX_URL;
  } catch {
    return false;
  }
}
const rectOk = (r) => !!r && [r.x, r.y, r.w, r.h].every((n) => Number.isFinite(n));
const idOk = (id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);

function uniquePath(dir, name, exists = fs.existsSync) {
  const base = path.basename(String(name || 'download')).replace(/^\.+/, '') || 'download';
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let p = path.join(dir, base);
  for (let n = 2; exists(p) && n < 1000; n++) p = path.join(dir, `${stem} (${n})${ext}`);
  return p;
}

function create({ ipcMain, WebContentsView, session, dialog = null, downloadsDir = () => '', windowOf, workDirOf, now = () => Date.now(), fsx = fs }) {
  const views = new Map(); // `${wcId}:${paneId}` -> { key, wcId, id, win, view, wc, attached, url }
  const stats = { created: 0, closed: 0, shots: 0 };
  let sessionReady = false;
  const approved = new Set(); // download URLs the user allowed
  const pendingAsk = new Set();

  const sess = () => session.fromPartition(PARTITION);
  function prepareSession() {
    if (sessionReady) return;
    sessionReady = true;
    const s = sess();
    s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    s.setPermissionCheckHandler(() => false);
    s.on('will-download', (_e, item, wc) => {
      const url = item.getURL();
      if (approved.delete(url)) {
        const dir = downloadsDir();
        if (!dir) return item.cancel();
        item.setSavePath(uniquePath(dir, item.getFilename()));
        return;
      }
      item.cancel(); // never silently
      if (!dialog || pendingAsk.size > 0 || RISKY_EXT.test(item.getFilename())) return; // one question at a time; programs / scripts are not offered
      pendingAsk.add(url);
      const owner = [...views.values()].find((r) => r.wc === wc);
      Promise.resolve(dialog.showMessageBox(owner?.win && !owner.win.isDestroyed() ? owner.win : undefined, {
        type: 'question', buttons: ['ダウンロードする', 'やめる'], defaultId: 1, cancelId: 1,
        message: `「${item.getFilename()}」をダウンロードしますか？`, detail: url.slice(0, 300),
      })).then((r) => {
        if (r && r.response === 0 && owner && !owner.wc.isDestroyed()) {
          approved.add(url);
          owner.wc.downloadURL(url);
        }
      }).catch(() => {}).finally(() => pendingAsk.delete(url));
    });
  }

  const send = (r, ch, payload) => {
    try {
      if (!r.win.isDestroyed() && !r.win.webContents.isDestroyed()) r.win.webContents.send(ch, payload);
    } catch {}
  };
  function state(r) {
    const wc = r.wc;
    if (!wc || wc.isDestroyed()) return;
    const nh = wc.navigationHistory;
    send(r, 'browser:state', {
      id: r.id,
      url: wc.getURL() || r.url || '',
      title: wc.getTitle() || '',
      loading: wc.isLoading(),
      canBack: nh ? nh.canGoBack() : wc.canGoBack(),
      canForward: nh ? nh.canGoForward() : wc.canGoForward(),
      error: r.error || '',
    });
  }

  function attach(e, id, url) {
    if (!idOk(id)) return { ok: false, reason: 'id' };
    const win = windowOf(e);
    if (!win || win.isDestroyed()) return { ok: false, reason: 'nowindow' };
    const key = `${e.sender.id}:${id}`;
    if (views.has(key)) return { ok: true, again: true };
    prepareSession();
    const view = new WebContentsView({
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
    });
    const r = { key, wcId: e.sender.id, id, win, view, wc: view.webContents, attached: false, url: '', error: '' };
    views.set(key, r);
    stats.created++;
    const wc = r.wc;
    wc.setWindowOpenHandler(({ url: u }) => {
      const t = now();
      // a page opening windows in a loop: at most one new tab a second per pane, and no more than MAX_VIEWS views
      if (urlAllowed(u) && t - (r.lastTab || 0) >= 1000 && views.size < MAX_VIEWS) { r.lastTab = t; send(r, 'browser:newtab', { id, url: u }); }
      return { action: 'deny' };
    });
    const guard = (ev, u) => { if (!urlAllowed(u)) ev.preventDefault(); };
    wc.on('will-navigate', (ev, u) => guard(ev, u));
    wc.on('will-redirect', (ev, u) => guard(ev, u));
    wc.on('will-frame-navigate', (ev) => guard(ev, ev.url)); // iframes too: no external-protocol handler gets started
    for (const n of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) wc.on(n, () => { if (n === 'did-start-loading') r.error = ''; state(r); });
    wc.on('did-fail-load', (_ev, code, desc, _u, isMain) => { if (isMain && code !== -3) { r.error = desc || String(code); state(r); } });
    wc.on('render-process-gone', () => { r.error = 'ページの表示が止まりました'; state(r); });
    const first = normalizeUrl(url);
    if (first) { r.url = first; wc.loadURL(first).catch(() => {}); }
    return { ok: true };
  }

  function removeFromWindow(r) {
    if (!r.attached) return;
    r.attached = false;
    try { if (!r.win.isDestroyed()) r.win.contentView.removeChildView(r.view); } catch {}
  }
  function place(e, o) {
    const r = views.get(`${e.sender.id}:${o && o.id}`);
    if (!r) return;
    const rect = o.rect;
    if (!o.visible || !rectOk(rect) || rect.w < 2 || rect.h < 2 || r.win.isDestroyed()) return removeFromWindow(r);
    const z = r.win.webContents.getZoomFactor() || 1;
    const b = { x: Math.round(rect.x * z), y: Math.round(rect.y * z), width: Math.max(1, Math.round(rect.w * z)), height: Math.max(1, Math.round(rect.h * z)) };
    if (!r.attached) {
      r.win.contentView.addChildView(r.view);
      r.attached = true;
    }
    r.view.setBounds(b);
  }

  function close(key) {
    const r = views.get(key);
    if (!r) return;
    views.delete(key);
    removeFromWindow(r);
    try { if (!r.wc.isDestroyed()) r.wc.close(); } catch {}
    r.view = null;
    r.wc = null;
    stats.closed++;
  }
  const windowGone = (wcId) => { for (const r of [...views.values()]) if (r.wcId === wcId) close(r.key); };
  const stopAll = () => { for (const k of [...views.keys()]) close(k); };

  function nav(e, o) {
    const r = views.get(`${e.sender.id}:${o && o.id}`);
    if (!r || !r.wc || r.wc.isDestroyed()) return { ok: false };
    const wc = r.wc;
    const nh = wc.navigationHistory;
    if (o.action === 'go') {
      const u = normalizeUrl(o.url);
      if (!u) return { ok: false, reason: 'url' };
      r.url = u;
      wc.loadURL(u).catch(() => {});
    } else if (o.action === 'back') (nh ? nh.canGoBack() : wc.canGoBack()) && (nh ? nh.goBack() : wc.goBack());
    else if (o.action === 'forward') (nh ? nh.canGoForward() : wc.canGoForward()) && (nh ? nh.goForward() : wc.goForward());
    else if (o.action === 'reload') wc.reload();
    else if (o.action === 'stop') wc.stop();
    else return { ok: false, reason: 'action' };
    return { ok: true, url: r.url };
  }

  async function save(e, o) {
    const r = views.get(`${e.sender.id}:${o && o.id}`);
    if (!r || !r.wc || r.wc.isDestroyed()) return { ok: false, reason: 'gone' };
    const dir = workDirOf(e);
    if (!dir) return { ok: false, reason: 'nofolder' };
    const img = await r.wc.capturePage();
    if (!img || img.isEmpty()) return { ok: false, reason: 'empty' };
    const d = new Date(now());
    const p2 = (n) => String(n).padStart(2, '0');
    const name = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}.png`;
    const folder = path.join(dir, '.bantodesk', 'browser');
    fsx.mkdirSync(folder, { recursive: true });
    const gi = path.join(dir, '.bantodesk', '.gitignore');
    if (!fsx.existsSync(gi)) { try { fsx.writeFileSync(gi, '*\n'); } catch {} }
    const p = path.join(folder, name);
    fsx.writeFileSync(p, img.toPNG());
    stats.shots++;
    return { ok: true, path: p };
  }

  // a picture of the page for the pin layer (15): not saved to a file, handed to the renderer as a PNG data URL
  async function snap(e, o) {
    const r = views.get(`${e.sender.id}:${o && o.id}`);
    if (!r || !r.wc || r.wc.isDestroyed()) return { ok: false, reason: 'gone' };
    const img = await r.wc.capturePage();
    if (!img || img.isEmpty()) return { ok: false, reason: 'empty' };
    return { ok: true, dataUrl: `data:image/png;base64,${img.toPNG().toString('base64')}`, url: r.wc.getURL(), title: r.wc.getTitle() };
  }

  function init() {
    ipcMain.handle('browser:snap', (e, o) => snap(e, o).catch(() => ({ ok: false, reason: 'error' })));
    ipcMain.handle('browser:attach', (e, o) => { try { return attach(e, o && o.id, o && o.url); } catch { return { ok: false, reason: 'error' }; } });
    ipcMain.on('browser:place', (e, o) => { try { if (o) place(e, o); } catch {} });
    ipcMain.on('browser:detach', (e, o) => o && idOk(o.id) && close(`${e.sender.id}:${o.id}`));
    ipcMain.handle('browser:nav', (e, o) => { try { return nav(e, o); } catch { return { ok: false }; } });
    ipcMain.handle('browser:save', (e, o) => save(e, o).catch(() => ({ ok: false, reason: 'error' })));
    ipcMain.handle('browser:stats', () => ({ ...stats, open: views.size, attached: [...views.values()].filter((r) => r.attached).length }));
  }

  return { init, attach, place, close, windowGone, stopAll, nav, save, snap, stats: () => ({ ...stats, open: views.size }), _views: views };
}

module.exports = { RISKY_EXT, create, normalizeUrl, urlAllowed, uniquePath, PARTITION };
