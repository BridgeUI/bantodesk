'use strict';
// TK3: the lean preamble (TK2, claude-cmd.js leanPreambleFor) from the dashboard's settings: the app-wide switch
// (manager-settings.json leanPreamble) and the folders it is off for (leanPreambleOff, absolute paths). Pure functions;
// main.js reads / writes the file (lean:set). Only these two keys are touched; the rest of the file is kept.
const path = require('path');

const norm = (p) => {
  const r = path.resolve(String(p));
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

// settings -> { on: boolean, off: [absolute folder, …] } (what the screen shows)
function view(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const off = Array.isArray(s.leanPreambleOff) ? s.leanPreambleOff.filter((f) => typeof f === 'string' && path.isAbsolute(f)) : [];
  return { on: s.leanPreamble !== false, off };
}

// (settings, { on?: boolean, folder?: absolute path, keep?: boolean }) -> { next } | { error }
//   on: the app-wide switch (true removes the key: the default). folder + keep: true adds it to leanPreambleOff
//   (このフォルダでは削らない), keep: false takes it (and the same path in another spelling) out. Other keys -> error.
function patch(settings, o) {
  if (!o || typeof o !== 'object') return { error: 'bad request' };
  const known = new Set(['on', 'folder', 'keep']);
  for (const k of Object.keys(o)) if (!known.has(k)) return { error: `unknown key: ${k}` };
  if (o.on === undefined && o.folder === undefined) return { error: 'nothing to change' };
  if (o.on !== undefined && typeof o.on !== 'boolean') return { error: 'on must be a boolean' };
  if (o.folder !== undefined) {
    if (typeof o.folder !== 'string' || !path.isAbsolute(o.folder)) return { error: 'folder must be an absolute path' };
    if (typeof o.keep !== 'boolean') return { error: 'keep must be a boolean' };
  } else if (o.keep !== undefined) return { error: 'keep needs a folder' };
  const next = { ...(settings && typeof settings === 'object' ? settings : {}) };
  if (o.on === true) delete next.leanPreamble;
  else if (o.on === false) next.leanPreamble = false;
  if (o.folder !== undefined) {
    const f = path.resolve(o.folder);
    const list = view(next).off.filter((x) => norm(x) !== norm(f));
    if (o.keep) list.push(f);
    if (list.length) next.leanPreambleOff = list;
    else delete next.leanPreambleOff;
  }
  return { next };
}

// is this folder itself listed (the card's toggle; a folder under a listed one is off too, leanPreambleFor)
function listed(settings, folder) {
  if (typeof folder !== 'string' || !folder) return false;
  return view(settings).off.some((x) => norm(x) === norm(folder));
}

module.exports = { view, patch, listed };
