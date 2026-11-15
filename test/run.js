// Runs every unit test under test/ (unit*.js, *-unit.js, test.js, *.test.js), one node process each, 120 s per file.
//   npm test            all
//   npm test -- xlsx    only the folders whose name contains "xlsx"
// A test passes when its process exits with 0. Unit tests use only node built-ins and ../../src (no Electron, no network).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const filter = process.argv[2] || '';
const files = [];
for (const d of fs.readdirSync(DIR, { withFileTypes: true })) {
  if (!d.isDirectory() || (filter && !d.name.includes(filter))) continue;
  for (const f of fs.readdirSync(path.join(DIR, d.name)).sort()) {
    if (/^(unit[\w-]*|[\w-]+-unit|test)\.(c?js|mjs)$|\.test\.(c?js|mjs)$/.test(f)) files.push(path.join(d.name, f));
  }
}
files.sort();

let failed = 0;
const t0 = Date.now();
for (const f of files) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { cwd: path.dirname(path.join(DIR, f)), encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  const ok = r.status === 0;
  if (!ok) failed++;
  const last = String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}  (${Date.now() - t} ms)  ${last.slice(0, 100)}`);
  if (!ok) {
    if (r.error) console.log(`      ${r.error.message}`);
    const out = (String(r.stdout || '') + String(r.stderr || '')).trim().split('\n').slice(-15).join('\n      ');
    if (out) console.log(`      ${out}`);
  }
}
console.log(`\n${files.length - failed}/${files.length} test files passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);
