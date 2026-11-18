// UX16 (docs/ux-journey.md §5.4): the one drop band. While files from the OS are dragged over the window, one band
// shows under the top bar with two targets: 「見る」 opens them in a viewer panel (the window's see hook, renderer.js;
// MD / HTML / images / PDF / xlsx) and 「直す」 opens them in edit mode (19 第 3 段: a new edit window on a working copy,
// main.js openEditWindow via edit:open). It was two bands (ビューアで開く and 編集モードで開く) stacked, where where one
// dropped changed what happened. Dropping on a pane / the composer still pastes / attaches the paths as before.
// window.EditDrop.open(paths) / see(paths) are the same as a drop of those files on 直す / 見る (the e2e calls them: a
// synthetic drop has no paths). setSee(fn | null): the window's viewer (null: no viewer here, only 直す shows).
(() => {
  'use strict';
  const api = window.api || {};
  const MAX_FILES = 5;
  const W = () => (window.Labels && window.Labels.WORDS) || {};
  const style = document.createElement('style');
  style.textContent = `
.ed-dropnote[hidden] { display: none !important; }
.ed-dropnote { position: fixed; top: calc(var(--topbar-h, 40px) + 64px); left: 50%; transform: translateX(-50%); z-index: 2001; max-width: 70%;
  padding: var(--s2) var(--s3); font-size: var(--fs-s); color: var(--text); background: var(--surface); border: 1px solid var(--faint);
  border-radius: var(--r1); box-shadow: 0 4px 16px color-mix(in srgb, var(--shade) 40%, transparent); }`;
  document.head.append(style);

  const band = document.createElement('div');
  band.className = 'drop-band';
  band.hidden = true;
  const target = (cls, word, sub) => {
    const t = document.createElement('div');
    t.className = `drop-target ${cls}`;
    const b = document.createElement('b');
    b.textContent = word;
    const s = document.createElement('span');
    s.textContent = sub;
    t.append(b, s);
    band.append(t);
    return t;
  };
  const seeT = target('k-see', W().dropSee || '見る', 'ビューアで開く（MD / HTML / 画像 / PDF / xlsx）');
  const editT = target('k-edit', W().dropEdit || '直す', '編集モードで開く（作業用コピーで直し、書き戻すまで元は変わりません）');
  const note = document.createElement('div');
  note.className = 'ed-dropnote';
  note.hidden = true;
  const mount = () => (document.getElementById('content') || document.body).append(band, note);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  let seeFn = null;
  let noteTimer = null;
  function tell(text, ms = 4000) {
    note.textContent = text;
    note.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => (note.hidden = true), ms);
  }

  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const usable = () => !!api.editOpen || !!seeFn;
  function hide() {
    depth = 0;
    band.hidden = true;
    seeT.classList.remove('over');
    editT.classList.remove('over');
  }
  function show() {
    seeT.hidden = !seeFn;
    editT.hidden = !api.editOpen;
    band.hidden = false;
  }
  // capture phase: the panes stop the propagation of their own drops
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !usable()) return;
    depth++;
    show();
  }, true);
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) hide();
  }, true);
  window.addEventListener('drop', hide, true);
  window.addEventListener('dragend', hide, true);
  for (const t of [seeT, editT]) {
    t.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      t.classList.add('over');
    });
    t.addEventListener('dragleave', () => t.classList.remove('over'));
  }
  const pathsOf = (e) => [...(e.dataTransfer?.files || [])].map((f) => {
    try {
      return api.pathForFile(f);
    } catch {
      return '';
    }
  });
  const uniq = (paths) => [...new Set((paths || []).filter((p) => typeof p === 'string' && p))];

  // 直す -> the number of files sent to main (it imports each into its own edit window; errors show as main's dialogs)
  function open(paths) {
    const list = uniq(paths);
    if (!list.length || !api.editOpen) {
      tell('ファイルではないため編集モードで開けません');
      return 0;
    }
    const go = list.slice(0, MAX_FILES);
    for (const p of go) api.editOpen({ path: p });
    tell(list.length > MAX_FILES ? `最初の ${MAX_FILES} 件を編集モードで開きます（1 件ずつ別のウィンドウ）` : go.length > 1 ? `${go.length} 件を編集モードで開きます（1 件ずつ別のウィンドウ）` : `編集モードで開きます: ${go[0].split(/[\\/]/).pop()}`);
    return go.length;
  }
  // 見る -> the number of files the window's viewer opens
  function see(paths) {
    const list = uniq(paths);
    if (!seeFn) return 0;
    try {
      return Number(seeFn(list)) || 0;
    } catch (err) {
      console.error('[edit-drop] see', err);
      return 0;
    }
  }
  editT.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const paths = pathsOf(e);
    hide();
    open(paths);
  });
  seeT.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const paths = pathsOf(e);
    hide();
    see(paths);
  });

  window.EditDrop = {
    open,
    see,
    setSee: (fn) => {
      seeFn = typeof fn === 'function' ? fn : null;
    },
    band,
    targets: { see: seeT, edit: editT },
    note,
  };
})();
