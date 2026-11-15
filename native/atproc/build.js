// Build src/main/native/atproc.node from native/atproc (SEC3, docs/security.md). Run by a developer, never
// by the app: node native/atproc/build.js
//   - needs Visual Studio 2022 Build Tools (C++ workload, Windows SDK) and node-gyp (npm's own copy is used)
//   - N-API 8: the same binary loads in Node (tests) and in Electron (the app); no rebuild per Electron version
//   - the result is committed under src/main/native and shipped with src (release.js copies src)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const here = __dirname;
const out = path.join(here, '..', '..', 'src', 'main', 'native', 'atproc.node');

function nodeGyp() {
  if (process.env.NODE_GYP) return process.env.NODE_GYP;
  // npm's bundled node-gyp, next to the running node (plain installs) or in Volta's image of this node version
  const cands = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
    path.join(process.env.LOCALAPPDATA || '', 'Volta', 'tools', 'image', 'node', process.versions.node, 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
  ];
  const f = cands.find((c) => fs.existsSync(c));
  if (!f) throw new Error('node-gyp not found; set NODE_GYP=<path to node-gyp.js>');
  return f;
}

execFileSync(process.execPath, [nodeGyp(), 'rebuild', '--release', '--arch=x64'], { cwd: here, stdio: 'inherit', timeout: 15 * 60 * 1000 });
const built = path.join(here, 'build', 'Release', 'atproc.node');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(built, out);
const m = require(out);
const rows = m.listSync();
console.log(`built ${out} (${fs.statSync(out).size} bytes); ${rows.length} processes listed`);
