// UX2 (docs/ux-journey.md §6 = docs/mac-polish.md MP2/M1): local paths in the renderer, for Windows and macOS.
// The separator comes from the path itself (like panel.js absPath): a drive (C:), a UNC (\\server) or any backslash
// is a Windows path and keeps the old behavior exactly; anything else is POSIX ("/" separated, "/" at the start is
// absolute). Loaded as a plain script (window.AtPath) and by node for the unit test (tmp/ux2/unit.js).
(function (root) {
  const str = (p) => String(p == null ? '' : p);
  const isWinAbs = (p) => /^[A-Za-z]:[\\/]/.test(str(p)) || /^[\\/]{2}[^\\/]/.test(str(p));
  const isWinStyle = (p) => /^[A-Za-z]:/.test(str(p)) || str(p).includes('\\');
  const sepOf = (p) => (isWinStyle(p) ? '\\' : '/');
  // Absolute in the style of `base` (a Windows base: only drives and UNC, as before; else also "/…").
  const isAbsIn = (base, p) => (sepOf(base) === '\\' ? isWinAbs(p) : isWinAbs(p) || /^\//.test(str(p)));
  const isAbs = (p) => isWinAbs(p) || (!isWinStyle(p) && /^\//.test(str(p)));

  // rel joined onto dir with dir's separator (rel's separators converted).
  function join(dir, rel) {
    const d = str(dir);
    const r = str(rel);
    if (!d) return r;
    const sep = sepOf(d);
    return `${d.replace(/[\\/]+$/, '')}${sep}${r.replace(/[\\/]/g, sep)}`;
  }

  // A path typed or linked somewhere (maybe quoted, maybe relative) -> absolute against base (a folder).
  function absPath(p, base) {
    const s = str(p).trim().replace(/^"(.*)"$/, '$1');
    if (!s || isAbsIn(base, s) || !base) return s;
    return join(base, s);
  }

  const dirOf = (p) => str(p).replace(/[\\/][^\\/]*$/, '');

  // Collapses "." / ".." / repeated separators. Windows: "C:\…" or "\\server\share\…" (as before). POSIX: "/…".
  // `win` forces the Windows form (a Windows document's links); by default it comes from p.
  function normalize(p, win = isWinStyle(p) || /^[\\/]{2}[^\\/]/.test(str(p))) {
    const s = str(p);
    if (win) {
      let prefix = '';
      let rest = s.replace(/\//g, '\\');
      const unc = /^\\\\[^\\]+\\[^\\]+/.exec(rest);
      const drive = /^[A-Za-z]:/.exec(rest);
      if (unc) { prefix = unc[0]; rest = rest.slice(prefix.length); }
      else if (drive) { prefix = drive[0]; rest = rest.slice(2); }
      const out = [];
      for (const seg of rest.split('\\')) {
        if (seg === '..') out.pop();
        else if (seg !== '.' && seg !== '') out.push(seg);
      }
      return `${prefix}\\${out.join('\\')}`;
    }
    const out = [];
    for (const seg of s.split('/')) {
      if (seg === '..') out.pop();
      else if (seg !== '.' && seg !== '') out.push(seg);
    }
    return `/${out.join('/')}`;
  }

  // Windows: the drive or \\server\share of p; POSIX: '' (a leading "/" is already the root).
  function rootOf(p) {
    const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.exec(str(p));
    if (unc) return unc[0];
    const drive = /^[A-Za-z]:/.exec(str(p));
    return drive ? drive[0] : '';
  }

  const safeDecode = (s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  };

  // href / src of a document at `base` (a file): relative, absolute, or file: -> absolute path in base's style,
  // or null (other schemes, file://host on macOS).
  function resolveLocal(base, ref) {
    let r = str(ref).replace(/[?#].*$/, '');
    if (!r) return null;
    const win = sepOf(base) === '\\';
    if (/^file:/i.test(r)) {
      r = r.replace(/^file:/i, '');
      if (win) {
        r = r.replace(/^\/\/(?=[^/])/, '\\\\'); // file://server/share -> UNC
        r = r.replace(/^\/+(?=[A-Za-z]:)/, ''); // file:///C:/x -> C:/x
        return normalize(safeDecode(r), true);
      }
      r = r.replace(/^\/\/(localhost)?(?=\/)/i, ''); // file:///x, file://localhost/x -> /x
      if (/^\/\//.test(r) || !/^\//.test(r)) return null; // file://host/… : never another host
      return normalize(safeDecode(r), false);
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(r) && !/^[A-Za-z]:[\\/]/.test(r)) return null;
    r = safeDecode(r);
    if (win) {
      if (isWinAbs(r)) return normalize(r, true);
      if (/^[\\/]/.test(r)) return normalize(rootOf(base) + r, true);
      return normalize(`${dirOf(base)}\\${r}`, true);
    }
    if (/^\/\//.test(r)) return null; // //host/… : not a local path on macOS
    if (/^\//.test(r)) return normalize(r, false);
    return normalize(`${dirOf(base)}/${r}`, false);
  }

  // Absolute image paths in a prompt (attachments): Windows "C:\…" as before, and POSIX "/…" (at the start or after
  // white space, so "a/b.png" and URLs are not taken). Quoted when the path has spaces. Groups: 1 quoted, 2 bare.
  const IMAGE_EXT = '\\.(?:png|jpe?g|gif|webp)';
  const IMAGE_PATH_RE = new RegExp(
    `"((?:[A-Za-z]:\\\\|/)[^"\\r\\n]+?${IMAGE_EXT})"|((?:[A-Za-z]:\\\\|(?<![^\\s])/)[^\\s"]+?${IMAGE_EXT})(?=\\s|$)`,
    'gi',
  );

  const api = { isAbs, isAbsIn, isWinAbs, sepOf, join, absPath, dirOf, normalize, rootOf, resolveLocal, IMAGE_PATH_RE };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AtPath = api;
})(typeof window !== 'undefined' ? window : null);
