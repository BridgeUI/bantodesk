'use strict';
// App settings that must be known before the app is ready (PROGRESS 32): <userData>/app-settings.json.
// The renderer's settings live in localStorage, which main cannot read before 'ready'; app.disableHardwareAcceleration()
// must be called before 'ready', so this setting is a small JSON file main reads first thing (docs/plan-tauri.md).
//
//   { disableGpu: false }   default: the GPU is used. true -> app.disableHardwareAcceleration() on the next start.
//   { zoom: 1 }             UX18 (docs/ux-journey.md §5.7): the zoom factor of every window (one value for the whole app),
//                           one of ZOOMS (0.8〜1.5). main applies it with webContents.setZoomFactor (src/main.js applyZoom).
//   { theme: 'os' }         UX18: a copy of the renderer's localStorage 'theme' (theme.js), so main can open a window with
//                           the right first ground (BrowserWindow backgroundColor) before the page is drawn.
//
// read(dir) -> settings (defaults filled; a missing or broken file = defaults)
// patch(dir, o) -> settings after writing (only known keys: disableGpu boolean, zoom a number, theme os/dark/light)
// applyEarly(app, dir) -> { disableGpu } as applied at this start (call once, before 'ready')
const fs = require('fs');
const path = require('path');

const FILE = 'app-settings.json';
const ZOOMS = Object.freeze([0.8, 0.9, 1, 1.1, 1.25, 1.5]);
const THEMES = Object.freeze(['os', 'dark', 'light']);
const DEFAULTS = Object.freeze({ disableGpu: false, zoom: 1, theme: 'os' });
// a number -> the nearest of ZOOMS (so 1.249 or a hand-edited 1.3 still lands on a step); not a number -> null
function snapZoom(z) {
  const n = Number(z);
  if (typeof z === 'boolean' || z === null || z === '' || !Number.isFinite(n)) return null;
  let best = ZOOMS[0];
  for (const v of ZOOMS) if (Math.abs(v - n) < Math.abs(best - n)) best = v;
  return best;
}
// step(z, dir): dir +1 / -1 -> the next step up / down (stays at the ends), 0 -> 1 (実際のサイズ)
function stepZoom(z, dir) {
  if (!dir) return 1;
  const i = ZOOMS.indexOf(snapZoom(z) || 1);
  return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + (dir > 0 ? 1 : -1)))];
}

const fileOf = (dir) => path.join(dir, FILE);

function read(dir) {
  let o = null;
  try {
    o = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
  } catch {}
  const s = { ...DEFAULTS };
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    if (typeof o.disableGpu === 'boolean') s.disableGpu = o.disableGpu;
    if (snapZoom(o.zoom) !== null) s.zoom = snapZoom(o.zoom);
    if (THEMES.includes(o.theme)) s.theme = o.theme;
  }
  return s;
}

// Keeps keys of the file this version does not know (a newer version may have written them).
function patch(dir, o) {
  let cur = {};
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) cur = j;
  } catch {}
  const next = { ...cur };
  if (o && typeof o === 'object' && typeof o.disableGpu === 'boolean') next.disableGpu = o.disableGpu;
  if (o && typeof o === 'object' && snapZoom(o.zoom) !== null) next.zoom = snapZoom(o.zoom);
  if (o && typeof o === 'object' && THEMES.includes(o.theme)) next.theme = o.theme;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${fileOf(dir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, fileOf(dir));
  return read(dir);
}

function applyEarly(app, dir) {
  const s = read(dir);
  if (s.disableGpu) app.disableHardwareAcceleration();
  return { disableGpu: s.disableGpu };
}

module.exports = { FILE, DEFAULTS, ZOOMS, THEMES, snapZoom, stepZoom, read, patch, applyEarly };
