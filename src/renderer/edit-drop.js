// 19 第 3 段: drop a file on the window -> open it in edit mode (a new edit window on a working copy; main.js
// openEditWindow via edit:open). While files are dragged over the window, a band 「ここにドロップして編集モードで開く」
// shows under the viewer's band (renderer.js 「ビューアで開く」). Dropping on a pane / the composer still pastes /
// attaches the paths as before; only a drop on this band opens edit mode.
// window.EditDrop.open(paths) is the same as a drop of those files (the e2e calls it: a synthetic drop has no paths).
(() => {
  'use strict';
  const api = window.api || {};
  const MAX_FILES = 5;
  const style = document.createElement('style');
  style.textContent = `
.ed-dropband { position: fixed; top: calc(var(--topbar-h, 40px) + 56px); left: 12px; right: 12px; height: 44px; z-index: 2000; display: flex;
  align-items: center; justify-content: center; box-sizing: border-box; padding: 0 12px; font-size: 12px;
  color: var(--green); background: rgba(30, 30, 46, .88); border: 2px dashed var(--green); border-radius: 8px;
  transition: background-color .15s, color .15s; }
.ed-dropband.over { background: rgba(166, 227, 161, .2); color: var(--text); border-style: solid; }
.ed-dropband[hidden], .ed-dropnote[hidden] { display: none !important; }
.ed-dropnote { position: fixed; top: calc(var(--topbar-h, 40px) + 56px); left: 50%; transform: translateX(-50%); z-index: 2001; max-width: 70%;
  padding: 8px 14px; font-size: 12px; color: var(--text); background: var(--mantle, #181825); border: 1px solid var(--overlay, #6c7086);
  border-radius: 6px; box-shadow: 0 4px 16px rgba(0, 0, 0, .4); }`;
  document.head.append(style);

  const band = document.createElement('div');
  band.className = 'ed-dropband';
  band.textContent = 'ここにドロップして編集モードで開く（作業用コピーで直します。書き戻すまで元のファイルは変わりません）';
  band.hidden = true;
  const note = document.createElement('div');
  note.className = 'ed-dropnote';
  note.hidden = true;
  const mount = () => (document.getElementById('content') || document.body).append(band, note);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  let noteTimer = null;
  function tell(text, ms = 4000) {
    note.textContent = text;
    note.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => (note.hidden = true), ms);
  }

  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  function hide() {
    depth = 0;
    band.hidden = true;
    band.classList.remove('over');
  }
  // capture phase: the panes stop the propagation of their own drops
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !api.editOpen) return;
    depth++;
    band.hidden = false;
  }, true);
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) hide();
  }, true);
  window.addEventListener('drop', hide, true);
  window.addEventListener('dragend', hide, true);
  band.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    band.classList.add('over');
  });
  band.addEventListener('dragleave', () => band.classList.remove('over'));

  // -> the number of files sent to main (it imports each into its own edit window; errors show as main's dialogs)
  function open(paths) {
    const list = [...new Set((paths || []).filter((p) => typeof p === 'string' && p))];
    if (!list.length) {
      tell('ファイルではないため編集モードで開けません');
      return 0;
    }
    const go = list.slice(0, MAX_FILES);
    for (const p of go) api.editOpen({ path: p });
    tell(list.length > MAX_FILES ? `最初の ${MAX_FILES} 件を編集モードで開きます（1 件ずつ別のウィンドウ）` : go.length > 1 ? `${go.length} 件を編集モードで開きます（1 件ずつ別のウィンドウ）` : `編集モードで開きます: ${go[0].split(/[\\/]/).pop()}`);
    return go.length;
  }
  band.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const paths = [...(e.dataTransfer?.files || [])].map((f) => {
      try {
        return api.pathForFile(f);
      } catch {
        return '';
      }
    });
    hide();
    open(paths);
  });

  window.EditDrop = { open, band, note };
})();
