// UX2 unit: src/renderer/paths.js with macOS and Windows sample paths. node tmp/ux2/unit.js
// Windows: the new helpers give exactly what the old renderer code gave (old copies below, from before UX2).
const path = require('node:path');
const APP = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.join(__dirname, '..', '..'); // AT_APP_ROOT = the app to test
const P = require(path.join(APP, 'src', 'renderer', 'paths.js'));

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};

// ---- old Windows-only code (renderer.js viewerAbsPath, composer.js joinPath, viewer.js resolveLocal, conversation.js) ----
const old = {
  viewerAbsPath(p, base) {
    const s = String(p || '').trim().replace(/^"(.*)"$/, '$1');
    if (!s || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\')) return s;
    return base ? `${base.replace(/[\\/]+$/, '')}\\${s.replace(/\//g, '\\')}` : s;
  },
  joinPath: (dir, rel) => (dir ? `${dir.replace(/[\\/]+$/, '')}\\${rel.replace(/\//g, '\\')}` : rel),
};
{
  const dirOf = (p) => String(p).replace(/[\\/][^\\/]*$/, '');
  const isAbs = (p) => /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
  const normalize = (p) => {
    let prefix = '';
    let rest = p.replace(/\//g, '\\');
    const unc = /^\\\\[^\\]+\\[^\\]+/.exec(rest);
    const drive = /^[A-Za-z]:/.exec(rest);
    if (unc) { prefix = unc[0]; rest = rest.slice(prefix.length); } else if (drive) { prefix = drive[0]; rest = rest.slice(2); }
    const out = [];
    for (const s of rest.split('\\')) { if (s === '..') out.pop(); else if (s !== '.' && s !== '') out.push(s); }
    return `${prefix}\\${out.join('\\')}`;
  };
  const rootOf = (p) => {
    const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.exec(p);
    if (unc) return unc[0];
    const drive = /^[A-Za-z]:/.exec(p);
    return drive ? drive[0] : '';
  };
  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  old.normalize = normalize;
  old.resolveLocal = (base, ref) => {
    let r = String(ref || '').replace(/[?#].*$/, '');
    if (!r) return null;
    if (/^file:/i.test(r)) {
      r = r.replace(/^file:/i, '').replace(/^\/\/(?=[^/])/, '\\\\');
      r = r.replace(/^\/+(?=[A-Za-z]:)/, '');
      return normalize(safeDecode(r));
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(r) && !/^[A-Za-z]:[\\/]/.test(r)) return null;
    r = safeDecode(r);
    if (isAbs(r)) return normalize(r);
    if (/^[\\/]/.test(r)) return normalize(rootOf(base) + r);
    return normalize(`${dirOf(base)}\\${r}`);
  };
  old.IMAGE_PATH_RE = /"([A-Za-z]:\\[^"\r\n]+?\.(?:png|jpe?g|gif|webp))"|([A-Za-z]:\\[^\s"]+?\.(?:png|jpe?g|gif|webp))(?=\s|$)/gi;
}
const images = (re, text) => [...String(text).matchAll(new RegExp(re.source, re.flags))].map((m) => m[1] || m[2]);

// ---- macOS ----
const MW = '/Users/alice/work/proj';
eq('mac abs md stays', P.absPath('/Users/alice/work/proj/README.md', MW), '/Users/alice/work/proj/README.md');
eq('mac relative md joins with /', P.absPath('README.md', MW), '/Users/alice/work/proj/README.md');
eq('mac relative nested', P.absPath('docs/a b.md', `${MW}/`), '/Users/alice/work/proj/docs/a b.md');
eq('mac quoted abs', P.absPath('"/Users/alice/x y/p.png"', MW), '/Users/alice/x y/p.png');
eq('mac ./ relative', P.absPath('./docs/x.md', MW), '/Users/alice/work/proj/./docs/x.md');
eq('mac no base', P.absPath('README.md', ''), 'README.md');
eq('mac isAbs /x', P.isAbs('/Users/x'), true);
eq('mac isAbs rel', P.isAbs('docs/x.md'), false);
eq('mac sep', P.sepOf(MW), '/');
eq('mac join (@ mention)', P.join(MW, 'src/renderer/viewer.js'), '/Users/alice/work/proj/src/renderer/viewer.js');
eq('mac join trailing /', P.join(`${MW}/`, 'a.md'), '/Users/alice/work/proj/a.md');
eq('mac join root', P.join('/', 'tmp/a.md'), '/tmp/a.md');
eq('mac normalize ..', P.normalize('/Users/alice/work/proj/docs/../README.md'), '/Users/alice/work/proj/README.md');
const MD = '/Users/alice/work/proj/docs/guide.md';
eq('mac md link relative', P.resolveLocal(MD, 'other.md'), '/Users/alice/work/proj/docs/other.md');
eq('mac md link ..', P.resolveLocal(MD, '../README.md#top'), '/Users/alice/work/proj/README.md');
eq('mac md link ./img', P.resolveLocal(MD, './img/a%20b.png'), '/Users/alice/work/proj/docs/img/a b.png');
eq('mac md link abs', P.resolveLocal(MD, '/Users/alice/x.md'), '/Users/alice/x.md');
eq('mac md link file:///', P.resolveLocal(MD, 'file:///Users/alice/x.md'), '/Users/alice/x.md');
eq('mac md link file://localhost/', P.resolveLocal(MD, 'file://localhost/Users/alice/x.md'), '/Users/alice/x.md');
eq('mac md link file://host refused', P.resolveLocal(MD, 'file://server/share/x.md'), null);
eq('mac md link //host refused', P.resolveLocal(MD, '//server/share/x.md'), null);
eq('mac md link https -> null', P.resolveLocal(MD, 'https://example.com/a.md'), null);
eq('mac md link query dropped', P.resolveLocal(MD, 'b.md?x=1'), '/Users/alice/work/proj/docs/b.md');
eq('mac images in prompt', images(P.IMAGE_PATH_RE, 'see /Users/alice/a.png and "/Users/alice/x y/b.jpg"\n/tmp/c.webp'),
  ['/Users/alice/a.png', '/Users/alice/x y/b.jpg', '/tmp/c.webp']);
eq('mac images not in words / urls', images(P.IMAGE_PATH_RE, 'src/a.png https://x.com/b.png foo/c.gif'), []);
{
  const text = 'look\n/Users/alice/a.png';
  eq('mac image path removed from text', text.replace(P.IMAGE_PATH_RE, '').trim(), 'look');
}

// ---- Windows: same as before ----
const WW = 'C:\\Users\\alice\\work\\proj';
const winAbs = [
  ['README.md', WW], ['docs/a.md', WW], ['docs\\a.md', `${WW}\\`], ['C:\\x\\y.md', WW], ['C:/x/y.md', WW], ['"C:\\a b\\c.md"', WW],
  ['\\\\server\\share\\x.md', WW], ['/foo/x.md', WW], ['x.md', '\\\\server\\share\\dir'], ['x.md', 'C:/Users/alice'], ['x.md', ''], ['', WW],
];
for (const [p, b] of winAbs) eq(`win absPath ${p} @ ${b}`, P.absPath(p, b), old.viewerAbsPath(p, b));
for (const [d, r] of [[WW, 'src/main.js'], [`${WW}\\`, 'a\\b.md'], ['C:/Users/alice', 'x/y.md'], ['', 'a/b.md']]) {
  eq(`win join ${d} + ${r}`, P.join(d, r), old.joinPath(d, r));
}
const WMD = 'C:\\Users\\alice\\work\\proj\\docs\\guide.md';
const refs = ['other.md', '../README.md#top', './img/a%20b.png', 'C:/x/y.md', 'C:\\x\\y.md', '/root/x.md', '\\root\\x.md',
  '//server/share/x.md', 'file:///C:/x/y.md', 'file://server/share/x.md', 'file:///foo/bar.md', 'https://e.com/a', 'mailto:a@b', '',
  'b.md?x=1', '%E3%81%82.md'];
for (const r of refs) eq(`win resolveLocal ${r}`, P.resolveLocal(WMD, r), old.resolveLocal(WMD, r));
for (const r of ['x.md', '..\\..\\y.md', '/z.md']) {
  const unc = '\\\\server\\share\\d\\a.md';
  eq(`win UNC resolveLocal ${r}`, P.resolveLocal(unc, r), old.resolveLocal(unc, r));
}
for (const p of [WMD, 'C:\\a\\..\\b\\.\\c.md', '\\\\server\\share\\a\\..\\b.md', 'C:/x/y.md']) eq(`win normalize ${p}`, P.normalize(p), old.normalize(p));
const winText = 'see C:\\Users\\alice\\a.png and "C:\\a b\\c.jpg"\nD:\\x.gif';
eq('win images in prompt', images(P.IMAGE_PATH_RE, winText), images(old.IMAGE_PATH_RE, winText));
eq('win images found', images(P.IMAGE_PATH_RE, winText), ['C:\\Users\\alice\\a.png', 'C:\\a b\\c.jpg', 'D:\\x.gif']);

console.log(`\nux2 unit: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
