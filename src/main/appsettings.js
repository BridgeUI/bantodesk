'use strict';
// App settings that must be known before the app is ready (PROGRESS 32): <userData>/app-settings.json.
// The renderer's settings live in localStorage, which main cannot read before 'ready'; app.disableHardwareAcceleration()
// must be called before 'ready', so this setting is a small JSON file main reads first thing (docs/plan-tauri.md).
//
//   { disableGpu: false }   default: the GPU is used. true -> app.disableHardwareAcceleration() on the next start.
//
// read(dir) -> settings (defaults filled; a missing or broken file = defaults)
// patch(dir, o) -> settings after writing (only known keys, booleans)
// applyEarly(app, dir) -> { disableGpu } as applied at this start (call once, before 'ready')
const fs = require('fs');
const path = require('path');

const FILE = 'app-settings.json';
const DEFAULTS = Object.freeze({ disableGpu: false });

const fileOf = (dir) => path.join(dir, FILE);

function read(dir) {
  let o = null;
  try {
    o = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
  } catch {}
  const s = { ...DEFAULTS };
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    if (typeof o.disableGpu === 'boolean') s.disableGpu = o.disableGpu;
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

module.exports = { FILE, DEFAULTS, read, patch, applyEarly };
