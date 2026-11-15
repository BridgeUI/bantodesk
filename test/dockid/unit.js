// DOCKID unit (依頼-131): the dashboard window's icon / title and the Dock menu, without electron.
// node tmp/dockid/unit.js   (AT_APP_ROOT=<stable> to check that copy's src)
'use strict';
const fs = require('fs');
const path = require('path');

const root = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.resolve(__dirname, '..', '..');
const winicon = require(path.join(root, 'src/main/winicon.js'));
const appmenu = require(path.join(root, 'src/main/appmenu.js'));
let pass = 0;
let fail = 0;
const ok = (name, cond, ev) => {
  if (cond) pass++;
  else fail++;
  console.log(cond ? 'PASS' : 'FAIL', name, !cond && ev !== undefined ? '| ' + JSON.stringify(ev).slice(0, 300) : '');
};

// 1. the static images are the drawn ones (node tmp/dockid/make-icons.mjs after a change)
for (const s of winicon.SIZES) {
  const f = winicon.dashboardIconFile(s);
  const has = fs.existsSync(f);
  ok(`icon file ${path.basename(f)} exists`, has);
  if (has) {
    const buf = fs.readFileSync(f);
    ok(`icon ${s}px is a ${s}x${s} PNG`, buf.slice(1, 4).toString() === 'PNG' && buf.readUInt32BE(16) === s && buf.readUInt32BE(20) === s);
    ok(`icon ${s}px matches drawDashboardPng`, buf.equals(winicon.drawDashboardPng(s)));
  }
}
ok('icons live in src/main/icons', path.relative(path.join(root, 'src', 'main'), winicon.ICON_DIR) === 'icons');
// the badge (lower right) is peach, the upper left is the blue disc or transparent: tells it from the tray icon
{
  const zlib = require('zlib');
  const buf = fs.readFileSync(winicon.dashboardIconFile(48));
  let o = 8;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.slice(o + 4, o + 8).toString();
    if (type === 'IDAT') idat.push(buf.slice(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const at = (x, y) => [...raw.slice(y * (48 * 4 + 1) + 1 + x * 4, y * (48 * 4 + 1) + 1 + x * 4 + 4)];
  const badge = at(44, 30); // inside the badge, right of the tiles
  ok('badge pixel is peach (#fab387)', badge[0] === 0xfa && badge[1] === 0xb3 && badge[2] === 0x87 && badge[3] === 255, badge);
  const disc = at(12, 14);
  ok('upper left is the blue disc', disc[2] > disc[0] && disc[3] === 255, disc);
}

// 2. title
ok('dashboard title', winicon.dashboardTitle(false) === 'ダッシュボード — BantoDesk', winicon.dashboardTitle(false));
ok('dashboard title [DEV]', winicon.dashboardTitle(true) === 'ダッシュボード — BantoDesk [DEV]', winicon.dashboardTitle(true));

// 3. applyDashboardIcon: setIcon on Windows, nothing on macOS, the path recorded either way
const fakeImage = {
  createFromBuffer: (buf) => {
    const reps = [buf];
    return { isEmpty: () => false, addRepresentation: (r) => reps.push(r.buffer), reps };
  },
};
const fakeWin = () => {
  const w = { icons: [], isDestroyed: () => false, setIcon: (i) => w.icons.push(i) };
  return w;
};
{
  const w = fakeWin();
  const r = winicon.applyDashboardIcon(w, { nativeImage: fakeImage, platform: 'win32' });
  ok('win32: setIcon ran', r === true && w.icons.length === 1);
  ok('win32: the image has every size', w.icons[0] && w.icons[0].reps.length === winicon.SIZES.length, w.icons[0]?.reps.length);
  ok('win32: path recorded', winicon.iconPathOf(w) === winicon.DASHBOARD_ICON && winicon.iconAppliedOf(w) === true);
  const m = fakeWin();
  ok('darwin: no setIcon', winicon.applyDashboardIcon(m, { nativeImage: fakeImage, platform: 'darwin' }) === false && m.icons.length === 0);
  ok('darwin: path recorded, not applied', winicon.iconPathOf(m) === winicon.DASHBOARD_ICON && winicon.iconAppliedOf(m) === false);
  ok('a window not given an icon has none', winicon.iconPathOf(fakeWin()) === null);
}

// 4. Dock menu
{
  const t = appmenu.dockTemplate({ onDashboard: () => (clicked = true) });
  let clicked = false;
  ok('dock menu first item 「ダッシュボードを開く」', t[0] && t[0].label === 'ダッシュボードを開く', t);
  t[0].click();
  ok('dock menu first item calls onDashboard', clicked);
  const Menu = { buildFromTemplate: (x) => ({ items: x }) };
  let set = null;
  const app = { dock: { setMenu: (m) => (set = m) } };
  ok('installDock: darwin sets the Dock menu', appmenu.installDock(app, Menu, { platform: 'darwin' }) === set && !!set && appmenu.getDockMenu() === set);
  ok('installDock: win32 does nothing', appmenu.installDock({ dock: { setMenu: () => { throw new Error('no'); } } }, Menu, { platform: 'win32' }) === null);
  ok('installDock: no app.dock does nothing', appmenu.installDock({}, Menu, { platform: 'darwin' }) === null);
}

// 5. main.js wiring
{
  const src = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  ok('main: dashboard title at creation', /role === 'manager' && !temp \? winIcon\.dashboardTitle\(isDev\)/.test(src));
  ok('main: win:title keeps the dashboard title', /s\.role === 'manager' && !s\.temp \? winIcon\.dashboardTitle\(isDev\)/.test(src));
  ok('main: applyDashboardIcon for the manager window', /winIcon\.applyDashboardIcon\(win/.test(src));
  ok('main: installDock opens the dashboard', /installDock\(app, Menu, \{ onDashboard: \(\) => !quitting && openStart\(\) \}\)/.test(src));
  ok('main: activate shows the dashboard when no window shows', /app\.on\('activate'[\s\S]{0,300}if \(!shown && [^\n]*openStart\(\)/.test(src));
  ok('main: no AppUserModelID per window / overlay icon', !/setAppDetails|setOverlayIcon/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
