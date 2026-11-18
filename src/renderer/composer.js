'use strict';
// Composer extras for the conversation input (roadmap 5c step 2, docs/input-ux.md):
//   - attachments as chips (dropped files, pasted images, @ file search); expanded to paths on send
//   - "/" palette: Claude Code commands, custom commands / skills, cheat-sheet snippets
//   - Ctrl+R: search the folder's send history
//   - draft persistence (text + attachments) through hooks
// Owner: core. Used by conversation.js: Composer.attach(conv, tab, hooks) after building the input row.
//
// hooks (from Conversation.init): filesSearch({cwd, query, limit}), commandsList({cwd}), imageSave({data, ext}),
//   snippets() -> Snippet[], history() -> string[], saveDraft(tab, draft|null), cwd(tab) -> string
(() => {
  const BUILTIN = [
    ['/clear', '会話を消して新しく始める'],
    ['/compact', '会話を要約して文脈を空ける'],
    ['/context', '文脈の使用量を表示'],
    ['/cost', 'このセッションの費用'],
    ['/usage', 'プランの使用状況'],
    ['/model', 'モデルを切り替え'],
    ['/config', '設定（全画面）'],
    ['/memory', 'メモリ（CLAUDE.md）を編集'],
    ['/resume', '過去の会話を再開'],
    ['/rewind', '会話やコードを巻き戻す'],
    ['/review', 'コードレビュー'],
    ['/init', 'CLAUDE.md を作る'],
    ['/agents', 'サブエージェントの管理'],
    ['/mcp', 'MCP サーバーの管理'],
    ['/permissions', '許可の設定'],
    ['/hooks', 'フックの設定'],
    ['/add-dir', '作業フォルダを追加'],
    ['/export', '会話を書き出す'],
    ['/status', '状態を表示'],
    ['/doctor', '環境の診断'],
    ['/help', 'ヘルプ'],
  ];
  const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
  const MAX_ATTACH = 20;

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }
  const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
  const quote = (p) => (/\s/.test(p) ? `"${p}"` : p);

  function attach(conv, tab, hooks) {
    const { input, dock } = conv;
    const inputRow = input.parentNode;
    const chips = h('div', 'cp-chips');
    chips.hidden = true;
    dock.insertBefore(chips, inputRow);
    const pop = h('div', 'cp-pop');
    pop.hidden = true;
    dock.append(pop);

    const state = { attachments: [], pop: null }; // pop: { kind: 'slash'|'mention'|'history', items, index, start }
    let draftT = 0;

    // ---- attachments -------------------------------------------------------------
    function renderChips() {
      chips.replaceChildren();
      chips.hidden = !state.attachments.length;
      state.attachments.forEach((a, i) => {
        const c = h('span', `cp-chip ${a.kind}`);
        c.title = a.path;
        if (a.kind === 'image' && a.thumb) {
          const img = h('img', 'cp-thumb');
          img.src = a.thumb; // data: URL (CSP img-src allows data:)
          img.alt = '';
          c.append(img);
        } else c.append(h('span', 'cp-ic', a.kind === 'image' ? '🖼' : '📄'));
        c.append(h('span', 'cp-name', a.name));
        const x = h('button', 'cp-x', '×');
        x.type = 'button';
        x.title = '添付を外す';
        x.addEventListener('click', () => {
          state.attachments.splice(i, 1);
          renderChips();
          saveDraftSoon();
          input.focus();
        });
        c.append(x);
        chips.append(c);
      });
    }

    function addAttachment(a) {
      if (!a || !a.path || state.attachments.some((x) => x.path === a.path)) return;
      if (state.attachments.length >= MAX_ATTACH) return;
      const att = { path: a.path, kind: a.kind || (IMAGE_RE.test(a.path) ? 'image' : 'file'), name: a.name || baseName(a.path), thumb: a.thumb };
      state.attachments.push(att);
      // Dropped / @-picked / restored image files: load a thumbnail through main.
      if (att.kind === 'image' && !att.thumb && hooks.imageRead) {
        Promise.resolve(hooks.imageRead(att.path)).then((url) => {
          if (url && state.attachments.includes(att)) {
            att.thumb = url;
            renderChips();
          }
        }).catch(() => {});
      }
      renderChips();
      saveDraftSoon();
    }

    // Dropped files -> chips (replaces the old "insert the path into the text" behaviour).
    const onDrop = (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      for (const f of [...(e.dataTransfer.files || [])]) {
        let p = '';
        try {
          p = window.api.pathForFile(f);
        } catch {}
        if (p) addAttachment({ path: p });
      }
      input.focus();
    };
    const onDragOver = (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    };
    for (const el of [conv.el, dock]) {
      el.addEventListener('dragover', onDragOver, true);
      el.addEventListener('drop', onDrop, true);
    }

    // Pasted images -> saved by main to a temp file -> image chip with a thumbnail.
    input.addEventListener('paste', (e) => {
      const cd = e.clipboardData;
      // Office (Excel / Word / PowerPoint) puts text AND a picture of the selection on the clipboard:
      // text wins. Screenshots (Win+Shift+S) and copied images have no text.
      if (cd && [...cd.types].includes('text/plain') && cd.getData('text/plain')) return;
      const items = [...(cd?.items || [])].filter((it) => it.kind === 'file' && IMAGE_EXT[it.type]);
      if (!items.length) return;
      e.preventDefault();
      for (const it of items) {
        const file = it.getAsFile();
        if (!file) continue;
        const ext = IMAGE_EXT[it.type];
        const reader = new FileReader();
        reader.onload = async () => {
          const thumb = String(reader.result || '');
          try {
            const buf = new Uint8Array(await file.arrayBuffer());
            const r = await hooks.imageSave?.({ data: buf, ext });
            if (r && r.ok) addAttachment({ path: r.path, kind: 'image', name: `画像 ${baseName(r.path)}`, thumb: thumb.length < 2_000_000 ? thumb : undefined });
            else conv.showNotice?.(`画像を保存できませんでした${r && r.error ? `: ${r.error}` : ''}`);
          } catch (err) {
            console.error(err);
            conv.showNotice?.('画像を保存できませんでした');
          }
        };
        reader.readAsDataURL(file);
      }
    });

    // ---- popup (slash palette / @ mention / history search) ---------------------------
    // Any async lookup (palette sources, @ search) started before this number changed is stale.
    let popSeq = 0;
    function closePop() {
      popSeq++;
      state.pop = null;
      pop.hidden = true;
      pop.replaceChildren();
    }

    // Opens the popup: the head (with the history search box) is built once per opening; typing
    // only redraws the list, so IME composition in the search box is never interrupted.
    function openPop(p) {
      state.pop = p;
      pop.hidden = false;
      p.listEl = h('div', 'cp-list');
      pop.replaceChildren(popHead(p), p.listEl);
      renderList();
    }

    function renderList() {
      const p = state.pop;
      if (!p) return;
      if (!p.items.length && p.kind !== 'history') {
        closePop();
        return;
      }
      p.listEl.replaceChildren();
      if (!p.items.length) {
        p.listEl.append(h('div', 'cp-empty', '一致する履歴はありません'));
        return;
      }
      p.items.forEach((it, i) => {
        const row = h('div', `cp-item${i === p.index ? ' sel' : ''}`);
        row.append(h('span', 'cp-label', it.label));
        if (it.desc) row.append(h('span', 'cp-desc', it.desc));
        if (it.tag) row.append(h('span', 'cp-tag', it.tag));
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          choose(i);
        });
        p.listEl.append(row);
      });
      p.listEl.children[p.index]?.scrollIntoView({ block: 'nearest' });
    }

    function popHead(p) {
      const head = h('div', 'cp-head');
      if (p.kind === 'history') {
        head.append(h('span', null, '履歴を検索'));
        const q = h('input', 'cp-query');
        q.value = p.query || '';
        q.placeholder = '語句で絞り込み（↑↓ で選択、Enter で入力欄へ、Esc で閉じる）';
        q.addEventListener('input', () => {
          p.query = q.value;
          p.items = historyItems(q.value);
          p.index = 0;
          renderList();
        });
        q.addEventListener('keydown', (e) => popKeys(e));
        // Leaving the search box (e.g. clicking back into the message box) closes the history popup,
        // so a later Enter in the message box is a newline, never "replace my draft with history".
        q.addEventListener('blur', () => setTimeout(() => {
          if (state.pop === p && !pop.contains(document.activeElement)) closePop();
        }, 0));
        head.append(q);
        requestAnimationFrame(() => q.focus());
      } else {
        head.append(h('span', null, p.kind === 'slash' ? 'コマンドとスニペット（Tab / Enter で選択）' : 'ファイルを添付（Tab / Enter で選択）'));
      }
      return head;
    }

    function choose(i) {
      const p = state.pop;
      const it = p && p.items[i];
      if (!it) return;
      if (p.kind === 'slash') {
        const before = input.value.slice(0, p.start);
        const after = input.value.slice(input.selectionStart);
        const text = it.insert;
        input.value = before + text + after.replace(/^\S*/, '');
        const pos = (before + text).length;
        input.setSelectionRange(pos, pos);
      } else if (p.kind === 'mention') {
        const before = input.value.slice(0, p.start);
        const after = input.value.slice(input.selectionStart);
        input.value = before + after;
        input.setSelectionRange(before.length, before.length);
        addAttachment({ path: it.abs, name: it.rel });
      } else if (p.kind === 'history') {
        input.value = it.full;
        input.setSelectionRange(input.value.length, input.value.length);
      }
      closePop();
      input.dispatchEvent(new Event('input'));
      input.focus();
    }

    function popKeys(e) {
      const p = state.pop;
      if (!p || e.isComposing || e.keyCode === 229) return false; // IME: arrows / Enter belong to the IME
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const n = p.items.length;
        if (n) p.index = (p.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        renderList();
        return true;
      }
      if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
        if (!p.items.length) return false;
        e.preventDefault();
        e.stopPropagation();
        choose(p.index);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closePop();
        input.focus();
        return true;
      }
      return false;
    }

    let slashSources = null; // { commands, snippets } loaded on first "/"
    async function loadSlashSources() {
      if (slashSources) return slashSources;
      let commands = [];
      try {
        commands = (await hooks.commandsList?.({ cwd: hooks.cwd?.(tab) })) || [];
      } catch {}
      slashSources = { commands, snippets: hooks.snippets?.() || [] };
      // Re-read later to pick up new commands / snippets; an empty first answer is retried soon.
      setTimeout(() => { slashSources = null; }, slashSources.snippets.length ? 60_000 : 2_000);
      return slashSources;
    }

    function slashItems(q, src) {
      const query = q.toLowerCase();
      const out = [];
      for (const [name, desc] of BUILTIN) out.push({ label: name, desc, insert: `${name} `, tag: 'コマンド', key: name });
      for (const c of src.commands || []) {
        const name = `/${c.name}`;
        out.push({ label: name, desc: c.description || '', insert: `${name} `, tag: /skill/.test(c.source) ? 'スキル' : 'カスタム', key: name });
      }
      for (const s of src.snippets || []) {
        if (!s || typeof s.text !== 'string') continue;
        out.push({ label: s.title || s.text.slice(0, 30), desc: s.text.replace(/\s+/g, ' ').slice(0, 80), insert: s.text, tag: 'スニペット', key: `/${s.title || ''} ${s.group || ''}` });
      }
      if (!query) return out.slice(0, 60);
      const score = (it) => {
        const k = it.key.toLowerCase();
        const l = it.label.toLowerCase();
        if (k.startsWith(`/${query}`) || l.startsWith(query)) return 0;
        if (k.includes(query) || l.includes(query)) return 1;
        if ((it.desc || '').toLowerCase().includes(query)) return 2;
        return 9;
      };
      return out.map((it) => [score(it), it]).filter(([s]) => s < 9).sort((a, b) => a[0] - b[0]).map(([, it]) => it).slice(0, 60);
    }

    function historyItems(q) {
      const hist = (hooks.history?.() || []).slice().reverse();
      const query = String(q || '').toLowerCase();
      const seen = new Set();
      const out = [];
      for (const t of hist) {
        if (seen.has(t)) continue;
        seen.add(t);
        if (query && !t.toLowerCase().includes(query)) continue;
        out.push({ label: t.replace(/\s+/g, ' ').slice(0, 120), full: t });
        if (out.length >= 50) break;
      }
      return out;
    }

    // Joins a search result onto the directory main actually searched (it may fall back to the
    // folder when the tab's cwd is outside it), so the attached absolute path always exists.
    // UX2: with the folder's separator ("/" on macOS), paths.js.
    const joinPath = (dir, rel) => window.AtPath.join(dir, rel);

    let suppressPop = false; // while restoring a draft
    let mentionT = 0;
    async function updatePopFromInput() {
      if (suppressPop) return;
      if (state.pop && state.pop.kind === 'history') return;
      const seq = ++popSeq;
      clearTimeout(mentionT);
      const v = input.value;
      const caret = input.selectionStart ?? v.length;
      const before = v.slice(0, caret);
      // Results of an async lookup apply only if nothing changed meanwhile (typing, send, close).
      const current = () => seq === popSeq && input.value.slice(0, input.selectionStart ?? 0) === before && document.activeElement === input;
      // "/" palette: only for a leading slash token (Claude Code commands start the message).
      const slash = /^\/(\S*)$/.exec(before);
      if (slash) {
        const src = await loadSlashSources();
        if (!current()) return;
        openPop({ kind: 'slash', items: slashItems(slash[1], src), index: 0, start: 0 });
        return;
      }
      // "@" mention: "@query" right before the caret, at the start or after whitespace. Debounced.
      const m = /(^|\s)@([^\s@]*)$/.exec(before);
      if (m) {
        const start = caret - m[2].length - 1;
        mentionT = setTimeout(async () => {
          let res = null;
          try {
            res = await hooks.filesSearch?.({ cwd: hooks.cwd?.(tab), query: m[2], limit: 30 });
          } catch {}
          if (!current()) return;
          const files = Array.isArray(res) ? res : (res && res.files) || [];
          const dir = (res && !Array.isArray(res) && res.cwd) || hooks.cwd?.(tab) || '';
          openPop({ kind: 'mention', items: files.map((r) => ({ label: r, rel: r, abs: joinPath(dir, r) })), index: 0, start });
        }, 120);
        return;
      }
      if (state.pop) closePop();
    }

    input.addEventListener('input', () => {
      updatePopFromInput();
      saveDraftSoon();
    });
    input.addEventListener('click', () => {
      if (state.pop && state.pop.kind === 'history') closePop();
      updatePopFromInput();
    });
    input.addEventListener('focus', () => {
      if (state.pop && state.pop.kind === 'history') closePop();
    });
    input.addEventListener('blur', () => setTimeout(() => {
      if (!pop.contains(document.activeElement)) closePop();
    }, 150));
    // Capture phase: runs before conversation.js's own keydown handler (send / history / Esc).
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      // The history popup is driven from its own search box only.
      if (state.pop && state.pop.kind !== 'history' && popKeys(e)) {
        e.stopImmediatePropagation();
        return;
      }
      // Ctrl+R on both OSes, like Claude Code's own history key (ux4-ctrl-ok: Claude Code's key, Ctrl on Mac too)
      if (e.key === 'r' && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closePop();
        openPop({ kind: 'history', items: historyItems(''), index: 0, query: '' });
      }
    }, true);

    // ---- drafts --------------------------------------------------------------------
    function draft() {
      const text = input.value;
      const attachments = state.attachments.map(({ path, kind, name }) => ({ path, kind, name }));
      return text || attachments.length ? { text, attachments } : null;
    }
    function saveDraftSoon() {
      clearTimeout(draftT);
      draftT = setTimeout(() => {
        draftT = 0;
        hooks.saveDraft?.(tab, draft());
      }, 500);
    }

    // ---- API for conversation.js -------------------------------------------------------
    return {
      // Text to send: the message plus attachment paths (Claude Code reads image paths as images).
      compose() {
        const paths = state.attachments.map((a) => quote(a.path));
        const text = input.value.replace(/\s+$/, '');
        if (!paths.length) return text;
        return text ? `${text}\n\n${paths.join(' ')}` : paths.join(' ');
      },
      isEmpty() {
        return !input.value.trim() && !state.attachments.length;
      },
      clear() {
        state.attachments = [];
        renderChips();
        closePop();
        clearTimeout(draftT);
        hooks.saveDraft?.(tab, null);
      },
      restore(d) {
        if (!d) return;
        suppressPop = true; // a restored "/x" or "@x" must not open a popup (possibly in a hidden tab)
        try {
          if (typeof d.text === 'string' && !input.value) input.value = d.text;
          for (const a of Array.isArray(d.attachments) ? d.attachments : []) addAttachment(a);
          input.dispatchEvent(new Event('input'));
        } finally {
          suppressPop = false;
        }
        closePop();
      },
      // Pending (debounced) draft written now, e.g. right before the window closes.
      flushDraft() {
        if (!draftT) return;
        clearTimeout(draftT);
        draftT = 0;
        hooks.saveDraft?.(tab, draft());
      },
      // 15: text handed from a pane (the pin comments) goes at the end of what is typed
      insertText(text) {
        if (!text) return;
        input.value = input.value ? `${input.value}${/\n$/.test(input.value) ? '' : '\n'}${text}` : text;
        input.dispatchEvent(new Event('input'));
        input.focus();
      },
      addFiles(paths) {
        for (const p of paths || []) addAttachment({ path: p });
      },
    };
  }

  window.Composer = { attach };
})();
