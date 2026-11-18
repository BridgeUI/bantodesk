// 18 プレゼンのブラッシュアップモード 第 1 段 (docs/plan-present.md 「第 1 段の作り」): the main side of the 「資料」 pane.
// Opens a pptx, has a renderer (present-render.js: PowerPoint / LibreOffice / a fake for tests) turn it into one PNG per slide, keeps
// the pictures under <folder>/.bantodesk/present/<key>/<n>.<sig>.png, and watches the file (fs.watch on its folder, debounced):
// when the saved deck's slide signatures (slidesig.js) differ, only the changed slides are swapped and the pane is told.
// Nothing leaves the PC; the renderer only gets file paths.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sigs, changed } = require('./slidesig');
const { isInside, norm } = require('./sessions');

const MAX_SLIDES = 300;
const DEBOUNCE_MS = 800;
const isUncLike = (p) => /^[\\/]{2}/.test(String(p || ''));
const keyOf = (p) => crypto.createHash('sha1').update(norm(p)).digest('hex').slice(0, 12);

// pure: the file name of a slide's picture, and the ones to delete
const imageName = (n, sig) => `${n}.${String(sig).slice(0, 8)}.png`;
const staleImages = (names, sigList) => {
  const keep = new Set(sigList.map((s, i) => imageName(i + 1, s)));
  return names.filter((f) => /^\d+\.[0-9a-f]{8}\.png$/.test(f) && !keep.has(f));
};

function create({ ipcMain, dialog, windowOf, workDirOf, userData, renderer, thumbOf, debounceMs = DEBOUNCE_MS, now = Date.now }) {
  const panes = new Map(); // `${webContents id}:${panel id}` -> pane
  const granted = new Map(); // webContents id -> Set(abs path) chosen in the file dialog
  const stats = { opened: 0, renders: 0, rendered: 0, updates: 0 };

  const rendererOf = () => (typeof renderer === 'function' ? renderer() : renderer);
  const send = (pane, payload) => {
    try {
      if (pane.sender && !pane.sender.isDestroyed()) { pane.sender.send('present:update', { id: pane.id, ...payload }); stats.updates++; }
    } catch {}
  };

  async function allowed(e, abs) {
    if (!abs || typeof abs !== 'string' || !path.isAbsolute(abs) || isUncLike(abs) || !/\.pptx$/i.test(abs)) return { ok: false, reason: 'unsupported' };
    let real;
    try { real = await fs.promises.realpath(abs); } catch { return { ok: false, reason: 'missing' }; }
    const st = await fs.promises.stat(real).catch(() => null);
    if (!st || !st.isFile()) return { ok: false, reason: 'missing' };
    const g = granted.get(e.sender.id);
    const dir = workDirOf(e);
    let dirReal = '';
    try { dirReal = dir ? await fs.promises.realpath(dir) : ''; } catch {}
    if ((g && g.has(norm(real))) || (dirReal && isInside(real, dirReal))) return { ok: true, real };
    return { ok: false, reason: 'outside' };
  }

  const rootOf = (e) => workDirOf(e) || userData();
  const cacheDir = (e, real) => path.join(rootOf(e), '.bantodesk', 'present', keyOf(real));

  // render the deck (or only some slides) into pane.dir; swap the pictures of the changed slides. -> { ok, changed[], reason? }
  async function refresh(pane, { first = false } = {}) {
    let deck;
    try { deck = await sigs(pane.file); } catch { return { ok: false, reason: 'unreadable' }; }
    const list = deck.slides.slice(0, MAX_SLIDES);
    const newSigs = list.map((s) => s.sig);
    const have = (n, sig) => fs.existsSync(path.join(pane.dir, imageName(n, sig)));
    let todo = changed(pane.sigs, newSigs);
    todo = todo.filter((n) => first ? !have(n, newSigs[n - 1]) : true); // reopening: pictures cached from last time are reused
    if (!todo.length && newSigs.length === pane.sigs.length) return { ok: true, changed: [] };
    if (todo.length) {
      const rd = rendererOf();
      fs.mkdirSync(pane.dir, { recursive: true });
      const gi = path.join(pane.root, '.bantodesk', '.gitignore');
      if (!fs.existsSync(gi)) { try { fs.writeFileSync(gi, '*\n'); } catch {} }
      const work = path.join(pane.dir, `.work-${process.pid}-${now()}`);
      fs.mkdirSync(work, { recursive: true });
      stats.renders++;
      let r;
      try {
        r = await rd.render({ pptx: pane.file, outDir: work, only: todo.length === newSigs.length ? null : todo, count: newSigs.length, sigs: newSigs });
      } catch (err) {
        r = { ok: false, reason: 'error', detail: String((err && err.message) || err) };
      }
      try {
        if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || 'error', detail: r && r.detail };
        const got = new Map((r.files || []).map((f) => [f.n, f.file]));
        let wrote = 0;
        for (const n of todo) {
          const src = got.get(n);
          if (!src || !fs.existsSync(src)) continue;
          fs.copyFileSync(src, path.join(pane.dir, imageName(n, newSigs[n - 1])));
          wrote++;
        }
        stats.rendered += wrote;
        if (!wrote) return { ok: false, reason: 'norender' };
      } finally {
        try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
      }
    }
    // a slide whose picture could not be made keeps no signature (it is tried again on the next save)
    pane.sigs = newSigs.map((s, i) => (have(i + 1, s) ? s : ''));
    for (const f of staleImages(fs.readdirSync(pane.dir), newSigs)) { try { fs.rmSync(path.join(pane.dir, f), { force: true }); } catch {} }
    try { fs.writeFileSync(path.join(pane.dir, 'meta.json'), JSON.stringify({ path: pane.file, sigs: pane.sigs, at: new Date(now()).toISOString() })); } catch {}
    pane.titles = list.map((s) => s.title);
    return { ok: true, changed: todo };
  }

  function schedule(pane) {
    clearTimeout(pane.timer);
    pane.timer = setTimeout(() => run(pane), debounceMs);
  }
  async function run(pane) {
    if (pane.closed) return;
    if (pane.busy) { pane.again = true; return; }
    pane.busy = true;
    send(pane, { state: 'rendering' });
    try {
      const r = await refresh(pane);
      if (pane.closed) return;
      if (r.ok) send(pane, { state: 'ready', count: pane.sigs.length, sigs: pane.sigs, titles: pane.titles, changed: r.changed });
      else send(pane, { state: 'error', reason: r.reason, detail: r.detail || '' });
    } finally {
      pane.busy = false;
      if (pane.again && !pane.closed) { pane.again = false; schedule(pane); }
    }
  }
  function watch(pane) {
    const dir = path.dirname(pane.file);
    const base = path.basename(pane.file).toLowerCase();
    try {
      pane.watcher = fs.watch(dir, { persistent: false }, (_ev, name) => {
        // an editor saves by writing a temp file and renaming (or by "~$name" lock files): react to the file's own name only
        if (!name || String(name).toLowerCase() === base) schedule(pane);
      });
      pane.watcher.on('error', () => {});
    } catch {}
  }
  function closePane(k) {
    const p = panes.get(k);
    if (!p) return;
    p.closed = true;
    clearTimeout(p.timer);
    try { p.watcher && p.watcher.close(); } catch {}
    panes.delete(k);
  }
  const keyFor = (e, id) => `${e.sender.id}:${String(id)}`;

  function init() {
    ipcMain.handle('present:available', async () => {
      try { return await rendererOf().avail(); } catch { return { ok: false, hint: '画像化の道具を確かめられませんでした' }; }
    });
    ipcMain.handle('present:pick', async (e) => {
      try {
        const win = windowOf(e);
        const r = await dialog.showOpenDialog(win, { title: '資料（pptx）を選ぶ', properties: ['openFile'], filters: [{ name: 'PowerPoint', extensions: ['pptx'] }], defaultPath: workDirOf(e) || undefined });
        if (r.canceled || !r.filePaths[0]) return { ok: false, reason: 'canceled' };
        const real = await fs.promises.realpath(r.filePaths[0]);
        if (!granted.has(e.sender.id)) granted.set(e.sender.id, new Set());
        granted.get(e.sender.id).add(norm(real));
        return { ok: true, path: real };
      } catch { return { ok: false, reason: 'error' }; }
    });
    ipcMain.handle('present:open', async (e, o) => {
      try {
        const id = o && o.id;
        if (typeof id !== 'string' || !id) return { ok: false, reason: 'bad' };
        const k = keyFor(e, id);
        closePane(k);
        const a = await allowed(e, o.path);
        if (!a.ok) return a;
        const av = await rendererOf().avail();
        if (!av.ok) return { ok: false, reason: 'notool', hint: av.hint || '' };
        const pane = { id, sender: e.sender, file: a.real, root: rootOf(e), dir: cacheDir(e, a.real), sigs: [], titles: [], busy: true, closed: false, timer: null, watcher: null, again: false };
        // the cached pictures of the last time (same signature) are shown at once
        try { const m = JSON.parse(fs.readFileSync(path.join(pane.dir, 'meta.json'), 'utf8')); if (m && m.path === a.real && Array.isArray(m.sigs)) pane.sigs = m.sigs.filter((s) => typeof s === 'string').slice(0, MAX_SLIDES); } catch {}
        panes.set(k, pane);
        stats.opened++;
        const r = await refresh(pane, { first: true });
        pane.busy = false;
        if (!r.ok) { closePane(k); return { ok: false, reason: r.reason, detail: r.detail || '', hint: r.reason === 'norender' ? '画像にできませんでした' : '' }; }
        watch(pane);
        return { ok: true, name: path.basename(a.real), path: a.real, count: pane.sigs.length, sigs: pane.sigs, titles: pane.titles, tool: rendererOf().name };
      } catch (err) {
        return { ok: false, reason: 'error', detail: String((err && err.message) || err) };
      }
    });
    ipcMain.handle('present:image', async (e, o) => {
      try {
        const pane = panes.get(keyFor(e, o && o.id));
        const n = Number(o && o.n);
        if (!pane || !Number.isInteger(n) || n < 1 || n > pane.sigs.length || !pane.sigs[n - 1]) return { ok: false };
        const f = path.join(pane.dir, imageName(n, pane.sigs[n - 1]));
        if (o.thumb && thumbOf) { const t = thumbOf(f); if (t) return { ok: true, sig: pane.sigs[n - 1], dataUrl: t }; }
        const buf = await fs.promises.readFile(f);
        return { ok: true, sig: pane.sigs[n - 1], dataUrl: `data:image/png;base64,${buf.toString('base64')}` };
      } catch { return { ok: false }; }
    });
    ipcMain.on('present:close', (e, o) => { try { closePane(keyFor(e, o && o.id)); } catch {} });
    ipcMain.handle('present:stats', () => ({ ...stats, panes: panes.size }));
  }
  function windowGone(wcId) {
    for (const k of [...panes.keys()]) if (k.startsWith(`${wcId}:`)) closePane(k);
    granted.delete(wcId);
  }
  function stopAll() { for (const k of [...panes.keys()]) closePane(k); }
  return { init, windowGone, stopAll, refresh, stats: () => ({ ...stats }), _panes: panes };
}

module.exports = { create, imageName, staleImages, keyOf };
