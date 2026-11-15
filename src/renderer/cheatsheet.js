// Prompt cheat sheet (owner: panel). Snippets insert into the active terminal via the insert
// callback from CheatSheet.init; plus a read-only key binding reference.
(function () {
  const DEFAULT_SNIPPETS = [
    { id: 'd-plan', group: 'ワークフロー', title: '計画してから実装', submit: false,
      text: 'まだコードは変更しないでください。まず関連するファイルを読んで現状を把握し、実装計画（変更するファイル・手順・リスク・確認方法）を箇条書きで示してください。私が承認してから実装に入ってください。\n対象: ' },
    { id: 'd-review', group: 'ワークフロー', title: '変更差分をレビュー', submit: true,
      text: 'git diff で現在の変更差分を確認し、バグ・エッジケース・セキュリティ・可読性の観点でレビューしてください。指摘は重要度の高い順に、ファイル名と行番号を付けて挙げてください。まだ修正はしないでください。' },
    { id: 'd-test', group: 'ワークフロー', title: 'テストを書いて実行', submit: true,
      text: '今回の変更に対するテストを、既存テストの書き方と配置に合わせて追加し、実行してください。失敗したら原因を調べて修正し、すべて通るまで繰り返してください。最後に結果を要約してください。' },
    { id: 'd-debug', group: 'ワークフロー', title: '原因調査（推測で直さない）', submit: false,
      text: '次の問題の原因を調査してください。推測で修正せず、まずログ・コード・再現手順で根拠を確認し、原因とその根拠を説明してから修正方針を提案してください。修正は私の確認後に行ってください。\n問題: ' },
    { id: 'd-impact', group: 'ワークフロー', title: '影響範囲を調べる', submit: false,
      text: 'この変更の影響範囲（呼び出し元・関連テスト・設定・ドキュメント）を調べて一覧にしてください。コードはまだ変更しないでください。\n変更内容: ' },
    { id: 'd-commit', group: 'ワークフロー', title: 'コミットメッセージ作成', submit: true,
      text: '現在の変更（git diff と git diff --staged）を読んで、Conventional Commits 形式のコミットメッセージを提案してください（1行目は50文字程度の要約、本文に理由）。コミットはまだ実行しないでください。' },
    { id: 'd-brief', group: 'ワークフロー', title: '説明を簡潔に', submit: true,
      text: 'ここまでの内容を「結論 → 理由 → 次のアクション」の順で、5行以内で簡潔に説明してください。' },
    { id: 'd-continue', group: 'ワークフロー', title: '続けて', submit: true, text: '続けてください。' },
    { id: 's-compact', group: 'スラッシュコマンド', title: '/compact 会話を要約して圧縮', submit: true, text: '/compact' },
    { id: 's-clear', group: 'スラッシュコマンド', title: '/clear 会話をリセット', submit: true, text: '/clear' },
    { id: 's-context', group: 'スラッシュコマンド', title: '/context コンテキスト使用状況', submit: true, text: '/context' },
    { id: 's-model', group: 'スラッシュコマンド', title: '/model モデル切替', submit: true, text: '/model' },
    { id: 's-resume', group: 'スラッシュコマンド', title: '/resume 過去の会話を再開', submit: true, text: '/resume' },
    { id: 's-rewind', group: 'スラッシュコマンド', title: '/rewind 以前の状態に巻き戻し', submit: true, text: '/rewind' },
    { id: 's-review', group: 'スラッシュコマンド', title: '/review コードレビュー', submit: true, text: '/review' },
    { id: 's-init', group: 'スラッシュコマンド', title: '/init CLAUDE.md を生成', submit: true, text: '/init' },
  ];

  // Only bindings we are confident about (Claude Code 2.x). Keys are shown as <kbd> chips. Claude Code's own keys are
  // Ctrl on macOS too (left as written); the BantoDesk rows come from the one shortcut table (Labels.SHORTCUTS,
  // ⇧⌘ on Mac, UX4). Built when the sheet opens: labels.js may load after this file.
  function keyGroups() {
    const win = /Windows/i.test(navigator.userAgent || '');
    const L = window.Labels;
    const app = L ? L.SHORTCUTS.filter((s) => s.sheet).map((s) => [[L.key(s.keys)], s.label]) : [];
    return [
      { group: 'Claude Code', rows: [
        [['Esc'], '実行中の処理を中断'],
        [['Esc', 'Esc'], '巻き戻し（以前のメッセージに戻る / 入力が空のとき）'],
        [['Shift+Tab'], '権限モード切替（通常 → 自動承認 → プラン）'],
        [['Ctrl+C'], '入力をクリア / 中断（2回で終了）'],
        [['Ctrl+D'], 'Claude Code を終了'],
        [['Ctrl+L'], '画面をクリア（会話は保持）'],
        [['Ctrl+O'], 'トランスクリプト（詳細表示）の切替'],
        [['Ctrl+T'], 'Todo / タスクリストの表示切替'],
        [['Ctrl+R'], '入力履歴を検索'],
        [['↑', '↓'], '入力履歴をたどる'],
        [['\\', 'Enter'], '改行（送信せずに複数行入力）'],
        [['Ctrl+V'], win ? '画像を貼り付け（Windows では Alt+V の場合あり）' : '画像を貼り付け'],
        [['!'], '行頭で bash モード（コマンドを直接実行）'],
        [['@'], 'ファイル / フォルダを参照'],
        [['/'], 'スラッシュコマンド一覧'],
      ] },
      { group: 'BantoDesk', rows: app.concat([
        [['ドラッグ&ドロップ'], 'ファイルをターミナルへ落としてパスを挿入'],
      ]) },
    ];
  }

  const ICON_EDIT = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M10.5 2.5l3 3L6 13H3v-3z"/></svg>';
  const ICON_DEL = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/></svg>';
  const ICON_X = '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l6 6M9 3 3 9"/></svg>';

  let insertFn = null;
  let snippets = null; // Snippet[]
  let loading = null;
  let ui = null; // open modal state

  const clone = (list) => list.map((s) => ({ ...s }));
  const newId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }
  function iconBtn(svg, cls, title) {
    const b = h('button', cls);
    b.type = 'button';
    b.innerHTML = svg; // static markup only
    if (title) b.title = title;
    return b;
  }

  function load() {
    if (snippets) return Promise.resolve(snippets);
    if (!loading) {
      const p = window.api && window.api.snippetsGet ? window.api.snippetsGet() : Promise.resolve(null);
      loading = Promise.resolve(p)
        .catch(() => null)
        .then((list) => {
          snippets = Array.isArray(list) ? list.filter((s) => s && typeof s.text === 'string').map((s) => ({
            id: s.id || newId(), group: s.group || 'その他', title: s.title || s.text.slice(0, 30), text: s.text, submit: !!s.submit,
          })) : clone(DEFAULT_SNIPPETS);
          return snippets;
        });
    }
    return loading;
  }

  function save() {
    if (window.api && window.api.snippetsSet) window.api.snippetsSet(snippets.map((s) => ({ ...s })));
  }

  function matches(q, ...fields) {
    if (!q) return true;
    const hay = fields.join('\n').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  // ---------------------------------------------------------------- render
  function renderSnippets() {
    const col = ui.snipCol;
    col.replaceChildren();
    const head = h('div', 'cs-col-head');
    head.append(h('div', 'eyebrow', 'プロンプト スニペット'));
    const btns = h('div', 'cs-form-btns');
    const reset = h('button', 'pn-btn', '初期化');
    reset.type = 'button';
    reset.title = 'スニペットを既定のセットに戻します';
    reset.addEventListener('click', () => {
      if (!confirm('スニペットを初期値に戻しますか？（追加・編集した内容は失われます）')) return;
      snippets = clone(DEFAULT_SNIPPETS);
      save();
      ui.editing = null;
      renderSnippets();
    });
    const add = h('button', 'pn-btn primary', '＋ 追加');
    add.type = 'button';
    add.addEventListener('click', () => {
      ui.editing = { id: null, group: lastGroup(), title: '', text: '', submit: false };
      renderSnippets();
    });
    btns.append(reset, add);
    head.append(btns);
    col.append(head);

    // keep the live form (and whatever was typed into it) when only the search changed
    if (ui.editing) col.append(ui.form && ui.formFor === ui.editing ? ui.form : renderForm(ui.editing));

    const q = ui.search.value.trim();
    const visible = snippets.filter((s) => matches(q, s.group, s.title, s.text));
    if (!visible.length) {
      col.append(h('div', 'cs-empty', q ? '一致するスニペットはありません。' : 'スニペットがありません。「＋ 追加」で作成できます。'));
      return;
    }
    const groups = new Map();
    for (const s of visible) {
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group).push(s);
    }
    for (const [g, list] of groups) {
      col.append(h('div', 'cs-group', g));
      const ul = h('ul', 'cs-list');
      for (const s of list) ul.append(renderItem(s));
      col.append(ul);
    }
  }

  function lastGroup() {
    const g = snippets.filter((s) => !s.text.startsWith('/')).pop();
    return g ? g.group : 'マイ スニペット';
  }

  function renderItem(s) {
    const li = h('li', 'cs-item');
    li.tabIndex = 0;
    li.dataset.id = s.id;
    const top = h('div', 'cs-item-top');
    top.append(h('span', 'cs-item-title', s.title));
    const enter = h('span', 'cs-enter' + (s.submit ? '' : ' no'), s.submit ? '⏎ 送信' : '挿入のみ');
    enter.title = s.submit ? '挿入後に Enter を送信します' : '挿入のみ（続きを入力してから送信）';
    const actions = h('span', 'cs-actions');
    const edit = iconBtn(ICON_EDIT, 'cs-act', '編集');
    edit.tabIndex = -1;
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      ui.editing = { ...s };
      renderSnippets();
    });
    const del = iconBtn(ICON_DEL, 'cs-act del', '削除');
    del.tabIndex = -1;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`「${s.title}」を削除しますか？`)) return;
      snippets = snippets.filter((x) => x.id !== s.id);
      save();
      renderSnippets();
    });
    // "挿入": put the text at the cursor of the input box without sending, even for "⏎ 送信" snippets.
    const ins = h('button', 'cs-ins', '挿入');
    ins.type = 'button';
    ins.tabIndex = -1;
    ins.title = '送信せずに入力欄のカーソル位置へ挿入（Shift+Enter）';
    ins.addEventListener('click', (e) => {
      e.stopPropagation();
      doInsert(s, false);
    });
    actions.append(ins, edit, del);
    top.append(actions, enter);
    li.append(top);
    if (s.text.trim() !== s.title.trim()) li.append(h('div', 'cs-item-text', s.text));
    li.title = s.text;
    li.addEventListener('click', () => doInsert(s));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        doInsert(s, e.shiftKey ? false : undefined);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveFocus(li, e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Delete') {
        del.click();
      } else if (e.key === 'F2') {
        edit.click();
      }
    });
    return li;
  }

  function moveFocus(from, dir) {
    const items = [...ui.root.querySelectorAll('.cs-item')];
    const i = items.indexOf(from);
    const next = items[i + dir];
    if (next) next.focus();
    else if (dir < 0) ui.search.focus();
  }

  function renderForm(ed) {
    const form = h('form', 'cs-form');
    const row = h('div', 'cs-form-row');
    const gLabel = h('label', null, 'グループ');
    const gIn = h('input');
    gIn.type = 'text';
    gIn.value = ed.group || '';
    const dl = h('datalist');
    dl.id = 'cs-groups';
    for (const g of new Set(snippets.map((s) => s.group))) {
      const o = h('option');
      o.value = g;
      dl.append(o);
    }
    gIn.setAttribute('list', 'cs-groups');
    gLabel.append(gIn, dl);
    const tLabel = h('label', null, 'タイトル');
    const tIn = h('input');
    tIn.type = 'text';
    tIn.value = ed.title || '';
    tIn.placeholder = '例: リファクタリング方針を相談';
    tLabel.append(tIn);
    row.append(gLabel, tLabel);
    const xLabel = h('label', null, '本文（ターミナルに挿入されるテキスト）');
    const xIn = h('textarea');
    xIn.value = ed.text || '';
    xLabel.append(xIn);
    const sLabel = h('label', 'inline');
    const sIn = h('input');
    sIn.type = 'checkbox';
    sIn.checked = !!ed.submit;
    sLabel.append(sIn, document.createTextNode('挿入後に自動で Enter を送信する'));
    const btns = h('div', 'cs-form-btns');
    const cancel = h('button', 'pn-btn', 'キャンセル');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      ui.editing = null;
      renderSnippets();
    });
    const ok = h('button', 'pn-btn primary', ed.id ? '保存' : '追加');
    ok.type = 'submit';
    btns.append(cancel, ok);
    form.append(row, xLabel, sLabel, btns);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = xIn.value;
      const title = tIn.value.trim() || text.trim().split('\n')[0].slice(0, 40);
      if (!text.trim()) {
        xIn.focus();
        return;
      }
      const rec = { id: ed.id || newId(), group: gIn.value.trim() || 'マイ スニペット', title, text, submit: sIn.checked };
      const i = snippets.findIndex((s) => s.id === rec.id);
      if (i >= 0) snippets[i] = rec;
      else snippets.push(rec);
      save();
      ui.editing = null;
      renderSnippets();
      const el = ui.root.querySelector(`.cs-item[data-id="${CSS.escape(rec.id)}"]`);
      if (el) {
        el.scrollIntoView({ block: 'nearest' });
        el.focus();
      }
    });
    xIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener('keydown', (e) => e.stopPropagation()); // keep item/search shortcuts out of the form
    ui.form = form;
    ui.formFor = ed;
    setTimeout(() => (ed.id ? xIn : tIn).focus(), 0);
    return form;
  }

  function renderKeys() {
    const col = ui.keyCol;
    col.replaceChildren();
    col.append(h('div', 'eyebrow', 'キー操作リファレンス'));
    const q = ui.search.value.trim();
    let any = false;
    for (const sec of keyGroups()) {
      const rows = sec.rows.filter(([keys, desc]) => matches(q, sec.group, keys.join(' '), desc));
      if (!rows.length) continue;
      any = true;
      col.append(h('div', 'cs-group', sec.group));
      const table = h('table', 'cs-keys');
      for (const [keys, desc] of rows) {
        const tr = h('tr');
        const k = h('td');
        for (const key of keys) k.append(h('kbd', 'cs-kbd', key));
        tr.append(k, h('td', null, desc));
        table.append(tr);
      }
      col.append(table);
    }
    if (!any) col.append(h('div', 'cs-empty', '一致するキー操作はありません。'));
  }

  // ---------------------------------------------------------------- modal
  // submit: undefined -> the snippet's own setting; false -> insert only.
  function doInsert(s, submit) {
    close();
    if (insertFn) insertFn(s.text, submit === undefined ? !!s.submit : !!submit);
  }

  function open() {
    if (ui) return;
    const root = document.getElementById('overlay-root') || document.body;
    const backdrop = h('div', 'pn-backdrop');
    const dlg = h('div', 'pn-modal cs-modal');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    const head = h('div', 'cs-head');
    head.append(h('div', 'cs-title', 'チートシート'));
    const search = h('input', 'cs-search');
    search.type = 'search';
    search.placeholder = 'スニペット・キー操作を検索…（Enter で先頭を挿入、↓ で選択）';
    const closeBtn = iconBtn(ICON_X, 'pn-btn icon', '閉じる (Esc)');
    closeBtn.addEventListener('click', close);
    head.append(search, closeBtn);
    const body = h('div', 'cs-body');
    const snipCol = h('div', 'cs-col');
    const keyCol = h('div', 'cs-col');
    body.append(snipCol, keyCol);
    const foot = h('div', 'cs-foot', 'クリック / Enter で入力欄（会話ビュー）かターミナルに挿入。「⏎ 送信」は自動で Enter を押します。送らずに入れるだけなら「挿入」か Shift+Enter。F2 で編集、Delete で削除。');
    dlg.append(head, body, foot);
    backdrop.append(dlg);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });

    const onKey = (e) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      if (ui.editing && ui.form && ui.form.contains(document.activeElement)) {
        ui.editing = null;
        renderSnippets();
        search.focus();
      } else close();
    };
    ui = { root: backdrop, search, snipCol, keyCol, editing: null, form: null, onKey, prevFocus: document.activeElement };
    document.addEventListener('keydown', onKey, true);

    search.addEventListener('input', () => {
      renderSnippets();
      renderKeys();
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        const first = ui.root.querySelector('.cs-item');
        if (first) first.click();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const first = ui.root.querySelector('.cs-item');
        if (first) first.focus();
      }
    });

    root.append(backdrop);
    snipCol.append(h('div', 'cs-empty', '読み込み中…'));
    renderKeys();
    search.focus();
    const mine = ui;
    load().then(() => {
      if (ui === mine) renderSnippets();
    });
  }

  function close() {
    if (!ui) return;
    document.removeEventListener('keydown', ui.onKey, true);
    ui.root.remove();
    const prev = ui.prevFocus;
    ui = null;
    if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus();
  }

  function init(opts = {}) {
    // UX5: no toolbar button; opened from ⋯ and the cheatsheet shortcut (renderer.js) via CheatSheet.toggle
    insertFn = typeof opts.insert === 'function' ? opts.insert : null;
    load();
  }

  function toggle() {
    if (ui) close();
    else open();
  }

  window.CheatSheet = { init, toggle, open, close, defaults: () => clone(DEFAULT_SNIPPETS) };
})();
