// UX4 (docs/ux-journey.md §5.7 = docs/mac-polish.md M2): the application menu on macOS only.
// Without an 編集 menu with its roles, ⌘C / ⌘V / ⌘A / ⌘Z do nothing in the input boxes on macOS, and ⌘Q / ⌘H / ⌘M
// do nothing either. Windows keeps no menu (the default menu's Ctrl+W etc. would swallow keys meant for the terminal).
// No item binds a key the terminal or the app's own shortcuts use: no ⌘W (close), no reload / devtools, no ⇧⌘ letter
// (the app's shortcuts, Labels.SHORTCUTS). A key the page handles itself (preventDefault) never reaches the menu.
'use strict';

// macTemplate({ appName, onSettings, onZoom }) -> a Menu template (plain objects; unit-tested in tmp/ux4/unit.js)
// UX18 (docs/ux-journey.md §5.7): with onZoom(dir) the 表示 items change the app's one zoom (every window, saved in
// app-settings.json) instead of the roles' per-page zoom: +1 拡大 (⌘+, and ⌘= without Shift), -1 縮小 (⌘-), 0 実際のサイズ (⌘0).
function macTemplate({ appName = 'BantoDesk', onSettings, onZoom } = {}) {
  const sep = { type: 'separator' };
  const zoom = typeof onZoom === 'function'
    ? [
      { id: 'resetZoom', label: '実際のサイズ', accelerator: 'Command+0', click: () => onZoom(0) },
      { id: 'zoomIn', label: '拡大', accelerator: 'Command+Plus', click: () => onZoom(1) },
      { id: 'zoomInEq', label: '拡大', accelerator: 'Command+=', visible: false, acceleratorWorksWhenHidden: true, click: () => onZoom(1) },
      { id: 'zoomOut', label: '縮小', accelerator: 'Command+-', click: () => onZoom(-1) },
    ]
    : [
      { role: 'resetZoom', label: '実際のサイズ' },
      { role: 'zoomIn', label: '拡大' },
      { role: 'zoomOut', label: '縮小' },
    ];
  return [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `${appName} について` },
        sep,
        { id: 'settings', label: '設定…', accelerator: 'Command+,', click: () => onSettings && onSettings() },
        sep,
        { role: 'hide', label: `${appName} を隠す` },
        { role: 'hideOthers', label: 'ほかを隠す' },
        { role: 'unhide', label: 'すべてを表示' },
        sep,
        { role: 'quit', label: `${appName} を終了` },
      ],
    },
    {
      label: '編集',
      submenu: [
        { role: 'undo', label: '取り消す' },
        { role: 'redo', label: 'やり直す' },
        sep,
        { role: 'cut', label: '切り取り' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: '貼り付け' },
        { role: 'selectAll', label: 'すべてを選択' },
      ],
    },
    {
      label: '表示',
      submenu: zoom,
    },
    {
      label: 'ウインドウ',
      role: 'window',
      submenu: [
        { role: 'minimize', label: 'しまう' },
        { role: 'zoom', label: '拡大／縮小' },
        sep,
        { role: 'front', label: 'すべてを手前に移動' },
      ],
    },
  ];
}

// install(Menu, { platform, ... }): macOS -> the menu above; elsewhere -> no menu (as before UX4)
function install(Menu, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return null;
  }
  const menu = Menu.buildFromTemplate(macTemplate(opts));
  Menu.setApplicationMenu(menu);
  return menu;
}

// DOCKID (依頼-131): the Dock's right-click menu on macOS. Its first item opens the dashboard (the Dock has one icon for
// the app; the windows below it are listed by their titles, the dashboard's starting with 「ダッシュボード」).
function dockTemplate({ onDashboard } = {}) {
  return [{ id: 'dock-dashboard', label: 'ダッシュボードを開く', click: () => onDashboard && onDashboard() }];
}

let dockMenu = null; // the menu set on the Dock (tmp/dockid/e2e.mjs clicks its first item: app.dock has no getMenu)
// installDock(app, Menu, { platform, onDashboard }): macOS -> app.dock.setMenu(dockTemplate); elsewhere nothing
function installDock(app, Menu, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'darwin' || !app || !app.dock || typeof app.dock.setMenu !== 'function') return null;
  dockMenu = Menu.buildFromTemplate(dockTemplate(opts));
  app.dock.setMenu(dockMenu);
  return dockMenu;
}

module.exports = { macTemplate, install, dockTemplate, installDock, getDockMenu: () => dockMenu };
