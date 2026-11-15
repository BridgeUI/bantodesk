// DOCKID (依頼-131): tell the dashboard window (role 'manager') apart in the Windows taskbar and the macOS Dock.
// - Windows: the dashboard window gets its own icon (the app's disc with a dashboard badge: a peach tile of 2x2 squares
//   in the lower right) and the title 「ダッシュボード — BantoDesk」. Folder windows keep electron's icon and their
//   titles. The taskbar group stays one app button (no separate AppUserModelID, no overlay icon: an overlay is per
//   window but a grouped button shows only one, which would mark the whole group as the dashboard).
// - macOS: BrowserWindow.setIcon does not exist (the Dock has one icon per app). The title (Dock's right-click list and
//   the ウインドウ menu) and the Dock menu's 「ダッシュボードを開く」 (src/main/appmenu.js dockTemplate) tell it apart.
// The images are static files in src/main/icons/ (drawn by drawDashboardPng below, written by
// `node tmp/dockid/make-icons.mjs`, checked by tmp/dockid/unit.js): nothing is fetched or drawn at run time.
'use strict';
const fs = require('fs');
const path = require('path');

const ICON_DIR = path.join(__dirname, 'icons');
const SIZES = [16, 32, 48, 256];
const dashboardIconFile = (size) => path.join(ICON_DIR, `dashboard-${size}.png`);
const DASHBOARD_ICON = dashboardIconFile(256); // the path recorded for the window (iconPathOf)

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// size px: the tray's disc (Catppuccin blue with a lighter core, widget.js iconPng) and a badge in the lower right: a
// rounded peach square with a dark ring and 2x2 dark tiles. -> PNG Buffer
function drawDashboardPng(size) {
  const { _encodePng: encodePng } = require('./widget');
  const px = Buffer.alloc(size * size * 4);
  const blue = hex('#89b4fa');
  const core = hex('#b4befe');
  const ring = hex('#11111b');
  const peach = hex('#fab387');
  const S = 4; // supersampling per axis
  const cx = size / 2;
  const r = size * 0.44;
  const rc = size * 0.17;
  // badge: a square [b0, b1]² with corner radius br, a ring of width bw around it
  const b0 = size * 0.44;
  const b1 = size * 0.98;
  const br = size * 0.1;
  const bw = size * 0.06;
  const inRound = (x, y, x0, x1, rad) => {
    const qx = Math.max(x0 + rad - x, 0, x - (x1 - rad));
    const qy = Math.max(x0 + rad - y, 0, y - (x1 - rad));
    return x >= x0 && x <= x1 && y >= x0 && y <= x1 && Math.hypot(qx, qy) <= rad;
  };
  // tiles: 2x2 inside the badge, a gap g between them and to the badge's edge
  const t0 = b0 + (b1 - b0) * 0.2;
  const t1 = b1 - (b1 - b0) * 0.2;
  const g = (t1 - t0) * 0.16;
  const tw = (t1 - t0 - g) / 2;
  const inTile = (x, y) => {
    if (x < t0 || x > t1 || y < t0 || y > t1) return false;
    const ix = x - t0 <= tw ? 0 : x - t0 >= tw + g ? 1 : -1;
    const iy = y - t0 <= tw ? 0 : y - t0 >= tw + g ? 1 : -1;
    return ix >= 0 && iy >= 0;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let R = 0, G = 0, B = 0, A = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const fx = x + (sx + 0.5) / S;
          const fy = y + (sy + 0.5) / S;
          let c = null;
          if (inRound(fx, fy, b0, b1, br)) c = inTile(fx, fy) ? ring : peach;
          else if (inRound(fx, fy, b0 - bw, b1 + bw, br + bw)) c = ring;
          else {
            const d = Math.hypot(fx - cx, fy - cx);
            if (d <= rc) c = core;
            else if (d <= r) c = blue;
          }
          if (c) {
            R += c[0];
            G += c[1];
            B += c[2];
            A += 1;
          }
        }
      }
      const i = (y * size + x) * 4;
      if (A) {
        px[i] = Math.round(R / A);
        px[i + 1] = Math.round(G / A);
        px[i + 2] = Math.round(B / A);
        px[i + 3] = Math.round((A / (S * S)) * 255);
      }
    }
  }
  return encodePng(size, px);
}

// The dashboard icon as a NativeImage with every size in src/main/icons/ (null when the files are missing).
let cached = null;
function dashboardImage(nativeImage) {
  if (cached && !cached.isEmpty()) return cached;
  let img = null;
  for (const s of SIZES) {
    let buf;
    try {
      buf = fs.readFileSync(dashboardIconFile(s));
    } catch {
      continue;
    }
    if (!img) img = nativeImage.createFromBuffer(buf, { scaleFactor: 1 });
    // the other sizes as scale factors of the first (16 px): 32 = 2x, 48 = 3x, 256 = 16x
    else img.addRepresentation({ scaleFactor: s / SIZES[0], buffer: buf });
  }
  cached = img && !img.isEmpty() ? img : null;
  return cached;
}

// win -> { path, applied } for the windows given an icon here (the e2e reads it: iconPathOf)
const given = new WeakMap();

// The dashboard window: its icon (Windows / Linux; macOS has no per-window icon). -> true when setIcon ran
function applyDashboardIcon(win, { nativeImage, platform = process.platform } = {}) {
  if (!win || win.isDestroyed?.()) return false;
  let applied = false;
  if (platform !== 'darwin' && typeof win.setIcon === 'function' && nativeImage) {
    const img = dashboardImage(nativeImage);
    if (img) {
      try {
        win.setIcon(img);
        applied = true;
      } catch (err) {
        console.warn('[winicon] setIcon failed', err);
      }
    }
  }
  given.set(win, { path: DASHBOARD_ICON, applied });
  return applied;
}

const iconPathOf = (win) => given.get(win)?.path || null;
const iconAppliedOf = (win) => !!given.get(win)?.applied;

// The dashboard window's title (Windows taskbar, the Dock's window list and the ウインドウ menu on macOS)
const dashboardTitle = (dev = false) => `ダッシュボード — BantoDesk${dev ? ' [DEV]' : ''}`;

module.exports = { SIZES, ICON_DIR, DASHBOARD_ICON, dashboardIconFile, drawDashboardPng, dashboardImage, applyDashboardIcon, iconPathOf, iconAppliedOf, dashboardTitle };
