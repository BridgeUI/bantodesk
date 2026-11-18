// 18 第 1 段: turning a pptx into one PNG per slide. A renderer is { name, avail() -> { ok, hint? }, render({ pptx, outDir, only, count, sigs }) ->
// { ok, files: [{ n, file }], reason?, detail? } }. Chosen by pickRenderer(): AT_PRESENT_RENDERER=fake (tests) > this OS's own tool.
//   Mac:     LibreOffice (soffice --headless --convert-to pdf) + poppler's pdftoppm (one PNG per page).
//            PowerPoint for Mac's AppleScript export was tried and hangs on the Automation / file-access consent: not used.
//   Windows: PowerPoint's COM, run by a script FILE (present-scripts/export-slides.ps1) with `-File` and the paths as arguments;
//            else LibreOffice (+ pdftoppm if present).
// What EDR sees: the app starts a known executable by absolute path (no shell), the paths as arguments, a timeout on
// every call, no code on the command line, no hidden window, nothing in a temp folder (work files are under .bantodesk/present/).
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cp = require('child_process');

const TIMEOUT_MS = 120_000;
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const firstExisting = (list) => list.find((p) => p && exists(p)) || '';

function run(file, args, { timeout = TIMEOUT_MS, cwd } = {}) {
  return new Promise((resolve) => {
    cp.execFile(file, args, { timeout, cwd, windowsHide: false, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, killed: !!(err && err.killed), code: err && err.code, out: String(stdout || ''), err: String(stderr || '') });
    });
  });
}

// ---- pure helpers (unit-tested) ----
// pdftoppm names pages <prefix>-<n>.png, n padded to the digit count of the page total
const pageNumber = (name, prefix) => {
  const m = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.png$`).exec(name);
  return m ? Number(m[1]) : 0;
};
const comFiles = (names) => names.map((f) => ({ n: Number((/^(\d+)\.png$/.exec(f) || [])[1] || 0), f })).filter((x) => x.n > 0);

// ---- LibreOffice (+ pdftoppm) ----
const SOFFICE = {
  darwin: ['/Applications/LibreOffice.app/Contents/MacOS/soffice', '/opt/homebrew/bin/soffice', '/usr/local/bin/soffice'],
  win32: ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'],
  linux: ['/usr/bin/soffice', '/usr/local/bin/soffice'],
};
const PDFTOPPM = {
  darwin: ['/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm', '/opt/local/bin/pdftoppm'],
  win32: [],
  linux: ['/usr/bin/pdftoppm', '/usr/local/bin/pdftoppm'],
};
const fileUrl = (p) => `file://${p.startsWith('/') ? '' : '/'}${p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/%3A/i, ':')}`;
function libreOffice(platform = process.platform) {
  const soffice = () => firstExisting(SOFFICE[platform] || []);
  const pdftoppm = () => firstExisting(PDFTOPPM[platform] || []);
  return {
    name: 'LibreOffice',
    async avail() {
      if (!soffice()) return { ok: false, hint: platform === 'darwin' ? 'LibreOffice を入れてください（brew install --cask libreoffice）' : 'LibreOffice か PowerPoint を入れてください' };
      if (!pdftoppm()) return { ok: false, hint: platform === 'darwin' ? 'poppler を入れてください（brew install poppler）' : 'poppler（pdftoppm）を入れてください' };
      return { ok: true };
    },
    async render({ pptx, outDir }) {
      const so = soffice(), pp = pdftoppm();
      if (!so || !pp) return { ok: false, reason: 'notool' };
      const profile = path.join(outDir, 'lo-profile'); // its own profile: a LibreOffice window the user has open does not block this
      const a = await run(so, ['--headless', '--norestore', `-env:UserInstallation=${fileUrl(profile)}`, '--convert-to', 'pdf', '--outdir', outDir, pptx]);
      const pdf = path.join(outDir, `${path.basename(pptx, path.extname(pptx))}.pdf`);
      if (!a.ok || !exists(pdf)) return { ok: false, reason: a.killed ? 'timeout' : 'error', detail: a.err.slice(-300) };
      const b = await run(pp, ['-png', '-r', '120', pdf, path.join(outDir, 'page')]);
      if (!b.ok) return { ok: false, reason: b.killed ? 'timeout' : 'error', detail: b.err.slice(-300) };
      const files = fs.readdirSync(outDir).map((f) => ({ n: pageNumber(f, 'page'), file: path.join(outDir, f) })).filter((x) => x.n > 0);
      return { ok: true, files };
    },
  };
}

// ---- PowerPoint COM (Windows) ----
function powerPointCom() {
  const SCRIPT = path.join(__dirname, 'present-scripts', 'export-slides.ps1');
  const SHELL = () => firstExisting([path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]);
  const hasPowerPoint = () => firstExisting([
    'C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE', 'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\POWERPNT.EXE',
    'C:\\Program Files\\Microsoft Office\\Office16\\POWERPNT.EXE', 'C:\\Program Files (x86)\\Microsoft Office\\Office16\\POWERPNT.EXE',
  ]);
  return {
    name: 'PowerPoint',
    async avail() {
      if (!SHELL() || !hasPowerPoint()) return { ok: false, hint: 'PowerPoint を入れてください（または LibreOffice）' };
      return { ok: true };
    },
    async render({ pptx, outDir, only }) {
      const sh = SHELL();
      if (!sh) return { ok: false, reason: 'notool' };
      const script = path.join(outDir, 'export-slides.ps1'); // a copy next to the output (the app's own folder under .bantodesk/present/)
      fs.copyFileSync(SCRIPT, script);
      const r = await run(sh, ['-NoProfile', '-NonInteractive', '-File', script, pptx, outDir, '1600', only && only.length ? only.join(',') : ''], { timeout: TIMEOUT_MS });
      if (!r.ok) return { ok: false, reason: r.killed ? 'timeout' : 'error', detail: r.err.slice(-300) };
      return { ok: true, files: comFiles(fs.readdirSync(outDir)).map((x) => ({ n: x.n, file: path.join(outDir, x.f) })) };
    },
  };
}

// ---- fake (tests): a solid picture whose colour comes from the slide's signature, so a changed slide looks different ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const t = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
// a w x h PNG: background colour [r, g, b], a darker bar along the bottom third (something to point at)
function solidPng(w, h, [r, g, b]) {
  const row = Buffer.alloc(1 + w * 3);
  const raw = Buffer.alloc(row.length * h);
  for (let y = 0; y < h; y++) {
    const k = y > (h * 2) / 3 ? 0.6 : 1;
    const o = y * row.length;
    raw[o] = 0;
    for (let x = 0; x < w; x++) { raw[o + 1 + x * 3] = r * k; raw[o + 2 + x * 3] = g * k; raw[o + 3 + x * 3] = b * k; }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const colorOf = (sig) => { const n = parseInt(String(sig).slice(0, 6), 16) || 0; return [80 + ((n >> 16) & 0x7f), 80 + ((n >> 8) & 0x7f), 80 + (n & 0x7f)]; };
function fake({ delayMs = 0 } = {}) {
  return {
    name: 'fake',
    async avail() { return { ok: true }; },
    async render({ outDir, only, count, sigs }) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const files = [];
      for (let n = 1; n <= count; n++) {
        if (only && !only.includes(n)) continue;
        const file = path.join(outDir, `fake-${n}.png`);
        fs.writeFileSync(file, solidPng(640, 360, colorOf((sigs && sigs[n - 1]) || String(n))));
        files.push({ n, file });
      }
      return { ok: true, files };
    },
  };
}

// no tool: the pane says what to install
const none = (hint) => ({ name: 'none', async avail() { return { ok: false, hint }; }, async render() { return { ok: false, reason: 'notool' }; } });

function pickRenderer({ env = process.env, platform = process.platform } = {}) {
  if (env.AT_PRESENT_RENDERER === 'fake') return fake({ delayMs: Number(env.AT_PRESENT_FAKE_DELAY_MS) || 0 });
  const lo = libreOffice(platform);
  if (platform === 'win32') {
    const com = powerPointCom();
    return {
      name: 'PowerPoint / LibreOffice',
      async avail() { const a = await com.avail(); return a.ok ? a : lo.avail(); },
      async render(o) { return (await com.avail()).ok ? com.render(o) : lo.render(o); },
    };
  }
  return lo;
}

module.exports = { pickRenderer, libreOffice, powerPointCom, fake, none, solidPng, pageNumber, comFiles, colorOf, fileUrl };
