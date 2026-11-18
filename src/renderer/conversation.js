'use strict';
// Rich conversation view (roadmap 5a). Read-only rendering of transcript events plus an input box;
// the pty stays the source of truth (input is pasted into the terminal, choices are digit keys).
// Owner: core. See CONTRACT.md "Conversation view".
//
// window.Conversation:
//   init({ send(tab, text), choose(tab, n), key(tab, name), setMode(tab, mode), peek(tab, on), openFile(path), openUrl(url) })
//   create(tab)          -> state stored at tab.conv (tab.conv.el is the view's root element)
//   onEvent(tab, evt)    – every assist event of the tab (same stream as Panel.onEvent)
//   onScreen(tab, s)     – after each screen scan: { status, choices, spinner, needTerminal, mode, peek }
//   focus(tab)           – focus the input box
(() => {
  const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'ToolSearch']);
  const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
  const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
  const AGENT_TOOLS = new Set(['Agent', 'Task']);
  const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);
  const MAX_ITEMS = 500; // DOM cap per tab (oldest entries are dropped)
  const DIFF_PREVIEW = 60;
  const STATUS_JA = { pending: '未着手', in_progress: '進行中', completed: '完了', deleted: '削除' };

  let hooks = {};
  // UX13: a view may carry its own hooks (the main window's session view sends through main to the owner window);
  // the others use the window's hooks from init()
  const hk = (conv) => (conv && conv.hooks) || hooks;

  // ---- folding (UIUX U6, 依頼-42) ------------------------------------------------------
  // Diffs (Edit / Write), tool output (Bash ...) and an agent's prompt and result are closed by default: one line
  // (file, +12 −3, exit code, line count). Errors, dialogs, Claude's text and the user's input stay open.
  // ⚙ 設定 →「差分を開いて表示」「結果を開いて表示」open them by default (localStorage 'convFold', default off).
  // A fold the user opened stays open while the tab lives (tool.ui, kept across the redraw when the result comes).
  // Turns before the latest one fold their runs of tool rows into one line "12 件の操作" (the text stays).
  const FOLD_KEY = 'convFold';
  const OPS_MIN = 2; // a run of this many tool rows (or more) in an older turn becomes one "N 件の操作" line
  function foldSettings() {
    try {
      const v = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}');
      return { openDiffs: v?.openDiffs === true, openResults: v?.openResults === true };
    } catch {
      return { openDiffs: false, openResults: false };
    }
  }
  function setFoldSettings(patch) {
    const next = { ...foldSettings(), ...(patch || {}) };
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(next)); } catch {}
    return next;
  }
  // a fold whose open state is remembered on the tool (key: 'diff' | 'out' | 'agent' | 'gen')
  function toolFold(tool, key, summaryEls, build, dflt, cls) {
    if (!tool.ui) tool.ui = {};
    const open = typeof tool.ui[key] === 'boolean' ? tool.ui[key] : dflt;
    const d = fold(summaryEls, build, open, cls);
    d.dataset.fold = key;
    d.addEventListener('toggle', () => { tool.ui[key] = d.open; });
    return d;
  }
  const exitCodeOf = (text) => {
    const m = /^(?:Error: )?Exit code (\d+)/m.exec(String(text || '').slice(0, 400));
    return m ? Number(m[1]) : null;
  };

  // ---- helpers ---------------------------------------------------------------
  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }
  const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
  const oneLine = (s, max = 120) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const lineCount = (s) => (s ? String(s).split('\n').length : 0);

  function argSummary(name, input) {
    if (!input || typeof input !== 'object') return '';
    const p = input.file_path || input.notebook_path || input.path;
    if (p) return base(p) + (input.pattern ? `  ${input.pattern}` : '');
    return oneLine(input.command ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.subject ?? input.skill ?? input.prompt ?? '', 100);
  }

  // now (UX8): highlight at once (an entry added at the end of a conversation that is on screen and follows the end;
  // waiting for the observer would lay the list out once more in the next frame)
  function md(text, now = false) {
    const el = h('div', 'cv-md');
    const raw = String(text || '');
    if (window.marked && window.DOMPurify) {
      try {
        const html = window.marked.parse(raw, { gfm: true, breaks: false, async: false });
        el.innerHTML = window.DOMPurify.sanitize(html, {
          USE_PROFILES: { html: true },
          FORBID_TAGS: ['img', 'style', 'form', 'input', 'button', 'textarea', 'select'],
          FORBID_ATTR: ['style', 'id', 'name', 'class'],
          SANITIZE_NAMED_PROPS: true,
        });
      } catch (err) {
        console.error(err);
        el.textContent = raw;
      }
    } else {
      el.textContent = raw;
      el.classList.add('plain');
    }
    for (const pre of el.querySelectorAll('pre')) {
      if (now) highlightCode(pre);
      else highlightLater(pre);
      pre.append(copyBtn(() => pre.querySelector('code')?.textContent ?? pre.textContent));
    }
    for (const a of el.querySelectorAll('a[href]')) a.title = a.getAttribute('href');
    return el;
  }

  // Syntax highlighting of a fenced block whose language highlight.js knows (common bundle, vendored in
  // node_modules/@highlightjs/cdn-assets). hljs escapes the text itself, so its HTML is safe to insert after sanitizing.
  // UX8 (docs/mac-polish.md J5): unlabeled blocks stay plain (auto-detection ran every grammar: 77 ms in 4 s of
  // streaming), and a labeled block is highlighted when it comes near the screen (IntersectionObserver), not while the
  // message is parsed: a restored history or a block in a hidden tab costs nothing until it is looked at.
  const HL_MAX = 20000;
  let hlObserver = null;
  function highlightLater(pre) {
    if (!window.hljs || !String(pre.dataset.lang || '').trim()) return;
    if (typeof IntersectionObserver !== 'function') return highlightCode(pre);
    if (!hlObserver) {
      hlObserver = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            hlObserver.unobserve(e.target);
            highlightCode(e.target);
          }
        },
        { rootMargin: '400px 0px' },
      );
    }
    hlObserver.observe(pre);
  }
  const HL_ALIAS = { ps1: 'powershell', pwsh: 'powershell', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', jsonc: 'json', vue: 'xml', html: 'xml', svg: 'xml', tsx: 'typescript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript' };
  function highlightCode(pre) {
    const hljs = window.hljs;
    const code = pre.querySelector('code');
    if (!hljs || !code) return;
    const text = code.textContent;
    if (!text.trim() || text.length > HL_MAX) return;
    const want = String(pre.dataset.lang || '').toLowerCase();
    const lang = HL_ALIAS[want] || want;
    try {
      let r = null;
      if (lang && hljs.getLanguage(lang)) r = hljs.highlight(text, { language: lang, ignoreIllegals: true });
      if (!r) return;
      code.innerHTML = r.value;
      code.classList.add('hljs');
    } catch {}
  }

  function copyBtn(getText) {
    const b = h('button', 'cv-copy', 'コピー');
    b.type = 'button';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(getText() || '').then(() => {
        b.textContent = 'コピーしました';
        setTimeout(() => { b.textContent = 'コピー'; }, 1200);
      }).catch(() => {});
    });
    return b;
  }

  function pre(text, cls) {
    const p = h('pre', `cv-pre${cls ? ` ${cls}` : ''}`);
    p.textContent = text;
    return p;
  }

  // <details> with a one-line summary; body is built lazily on first open.
  function fold(summaryEls, build, open = false, cls = '') {
    const d = h('details', `cv-fold${cls ? ` ${cls}` : ''}`);
    const s = h('summary');
    s.append(...summaryEls);
    d.append(s);
    let built = false;
    const ensure = () => {
      if (built) return;
      built = true;
      const b = build();
      if (b) d.append(b);
    };
    d.addEventListener('toggle', () => d.open && ensure());
    if (open) {
      d.open = true;
      ensure();
    }
    d.rebuild = () => {
      if (!built) return;
      while (d.childNodes.length > 1) d.lastChild.remove();
      built = false;
      if (d.open) ensure();
    };
    return d;
  }

  // ---- diff ------------------------------------------------------------------
  function diffLinesFromInput(name, input) {
    if (!input) return [];
    if (name === 'Write') return String(input.content ?? '').split('\n').map((l) => `+${l}`);
    const edits = name === 'MultiEdit' && Array.isArray(input.edits) ? input.edits : [input];
    const out = [];
    for (const e of edits) {
      if (out.length) out.push(' …');
      for (const l of String(e.old_string ?? '').split('\n')) out.push(`-${l}`);
      for (const l of String(e.new_string ?? e.new_source ?? '').split('\n')) out.push(`+${l}`);
    }
    return out;
  }

  function diffView(tool) {
    const wrap = h('div', 'cv-diff');
    const rows = [];
    if (tool.result && Array.isArray(tool.result.patch)) {
      for (const hunk of tool.result.patch) {
        rows.push({ t: '@', text: `@@ -${hunk.oldStart} +${hunk.newStart} @@`, o: null, n: null });
        let o = hunk.oldStart;
        let n = hunk.newStart;
        for (const l of hunk.lines) {
          const c = l[0];
          if (c === '-') rows.push({ t: '-', text: l.slice(1), o: o++, n: null });
          else if (c === '+') rows.push({ t: '+', text: l.slice(1), o: null, n: n++ });
          else if (c === '\\') rows.push({ t: '@', text: l, o: null, n: null }); // "\ No newline at end of file"
          else rows.push({ t: ' ', text: l.slice(1), o: o++, n: n++ });
        }
      }
    } else {
      for (const l of diffLinesFromInput(tool.name, tool.input)) rows.push({ t: l[0], text: l.slice(1), o: null, n: null });
    }
    const draw = (limit) => {
      wrap.replaceChildren();
      const table = h('div', 'cv-diff-rows');
      for (const r of rows.slice(0, limit)) {
        const row = h('div', `cv-dl ${r.t === '+' ? 'add' : r.t === '-' ? 'del' : r.t === '@' ? 'hunk' : 'ctx'}`);
        row.append(h('span', 'cv-ln', r.t === '@' ? '' : String(r.n ?? r.o ?? '')), h('span', 'cv-sign', r.t === '@' || r.t === ' ' ? '' : r.t), h('span', 'cv-code', r.text));
        table.append(row);
      }
      wrap.append(table);
      if (rows.length > limit) {
        const more = h('button', 'cv-more', `残り ${rows.length - limit} 行を表示`);
        more.type = 'button';
        more.addEventListener('click', () => draw(Infinity));
        wrap.append(more);
      }
    };
    draw(DIFF_PREVIEW);
    return wrap;
  }

  // A long prompt (a pasted document) is folded to its head; "全文を表示" / "折りたたむ" toggle it.
  const PROMPT_FOLD_CHARS = 1200;
  const PROMPT_FOLD_LINES = 20;
  function promptBubble(text) {
    const lines = text.split('\n');
    let head = lines.length > PROMPT_FOLD_LINES ? lines.slice(0, PROMPT_FOLD_LINES).join('\n') : text;
    if (head.length > PROMPT_FOLD_CHARS) head = head.slice(0, PROMPT_FOLD_CHARS);
    if (head.length >= text.length) return h('div', 'cv-bubble', text);
    const wrap = h('div', 'cv-prompt-fold');
    const bubble = h('div', 'cv-bubble');
    const btn = h('button', 'cv-more');
    btn.type = 'button';
    const rest = text.length - head.length;
    const show = (full) => {
      bubble.textContent = full ? text : `${head.replace(/\s+$/, '')} …`;
      btn.textContent = full ? '折りたたむ' : `全文を表示（残り ${rest.toLocaleString()} 文字）`;
      wrap.classList.toggle('open', full);
    };
    btn.addEventListener('click', () => show(!wrap.classList.contains('open')));
    show(false);
    wrap.append(bubble, btn);
    return wrap;
  }

  // ---- tool cards ----------------------------------------------------------------
  function toolIcon(name) {
    if (SHELL_TOOLS.has(name)) return '$';
    if (EDIT_TOOLS.has(name)) return '✎';
    if (AGENT_TOOLS.has(name)) return '◆';
    if (TASK_TOOLS.has(name)) return '☐';
    if (READ_TOOLS.has(name)) return '⌕';
    return '•';
  }

  function resultBlock(tool) {
    const r = tool.result;
    if (!r) return h('div', 'cv-wait', '実行中…');
    const text = r.output ?? r.text ?? '';
    const box = h('div', 'cv-result');
    if (!text) box.append(h('div', 'cv-muted', '（出力なし）'));
    else box.append(pre(text, r.isError ? 'err' : ''));
    if (r.outputLen && r.outputLen > text.length) box.append(h('div', 'cv-muted', `…（全 ${r.outputLen.toLocaleString()} 文字のうち先頭のみ）`));
    return box;
  }

  function renderShell(tool, card) {
    const cmd = String(tool.input?.command ?? '');
    const head = h('div', 'cv-cmd');
    head.append(h('span', 'cv-prompt', tool.name === 'PowerShell' ? 'PS>' : '$'), h('span', 'cv-cmd-text', cmd));
    head.append(copyBtn(() => cmd));
    if (tool.input?.description) head.title = tool.input.description;
    card.append(head);
    if (tool.input?.run_in_background) card.append(h('div', 'cv-muted', 'バックグラウンドで実行'));
    const r = tool.result;
    if (!r) {
      card.append(h('div', 'cv-wait', '実行中…'));
      return;
    }
    const out = r.output ?? r.text ?? '';
    const n = lineCount(out);
    const code = exitCodeOf(out);
    const label = r.isError ? `エラー${code != null ? `（終了コード ${code}）` : ''}${out.trim() ? ` · ${n} 行` : ''}` : out.trim() ? `出力 ${n} 行` : '出力なし';
    if (!out.trim() && !r.isError) {
      card.append(h('div', 'cv-muted', '（出力なし）'));
      return;
    }
    card.append(toolFold(tool, 'out', [h('span', r.isError ? 'cv-err-label' : 'cv-muted', label)], () => resultBlock(tool), r.isError || foldSettings().openResults));
  }

  // +added −removed of an edit: from the patch when the result came, else from the input
  function editCounts(tool) {
    let add = 0;
    let del = 0;
    if (tool.result?.patch) {
      for (const hk of tool.result.patch) for (const l of hk.lines) { if (l[0] === '+') add++; else if (l[0] === '-') del++; }
    } else {
      for (const l of diffLinesFromInput(tool.name, tool.input)) { if (l[0] === '+') add++; else if (l[0] === '-') del++; }
    }
    return { add, del };
  }

  function renderEdit(tool, card) {
    const p = tool.input?.file_path || tool.input?.notebook_path || '';
    const head = h('div', 'cv-tool-head');
    const verb = tool.name === 'Write' ? (tool.result?.patch ? '書き込み' : '作成') : '編集';
    const file = h('a', 'cv-file', base(p));
    file.href = '#';
    file.title = `${p}\nクリックでエディタを開く`;
    file.addEventListener('click', (e) => {
      e.preventDefault();
      hooks.openFile?.(p);
    });
    head.append(h('span', 'cv-icon', '✎'), h('span', 'cv-verb', verb), file);
    // MD / HTML / images / PDF: 「プレビュー」 opens the file in a viewer panel (roadmap 5b, renderer.js opens it)
    if (p && window.Viewer?.canOpen?.(p)) {
      const pv = h('button', 'cv-preview', 'プレビュー');
      pv.type = 'button';
      pv.title = `${p}\nビューアで開く（変更すると自動で読み直します）`;
      pv.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        document.dispatchEvent(new CustomEvent('bantodesk:open-viewer', { detail: { path: p } }));
      });
      head.append(pv);
    }
    const { add, del } = editCounts(tool);
    head.append(h('span', 'cv-add', `+${add}`), h('span', 'cv-del', `−${del}`));
    card.append(head);
    if (tool.result?.isError) card.append(pre(tool.result.output ?? tool.result.text ?? '', 'err'));
    else card.append(toolFold(tool, 'diff', [h('span', 'cv-muted', '差分')], () => diffView(tool), foldSettings().openDiffs));
  }

  function renderTasks(tool, card) {
    const i = tool.input || {};
    if (tool.name === 'TodoWrite' && Array.isArray(i.todos)) {
      card.append(h('div', 'cv-tool-head cv-muted', 'タスク一覧を更新'));
      const ul = h('ul', 'cv-todos');
      for (const t of i.todos) {
        const li = h('li', `st-${t.status}`);
        li.append(h('span', 'cv-todo-mark', t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '○'), h('span', null, t.content || t.activeForm || ''));
        ul.append(li);
      }
      card.append(ul);
    } else if (tool.name === 'TaskCreate') {
      const id = tool.result?.taskId ? ` #${tool.result.taskId}` : '';
      card.append(h('div', 'cv-tool-head', `☐ タスク追加${id}: ${i.subject || ''}`));
    } else {
      card.append(h('div', 'cv-tool-head', `☐ タスク #${i.taskId ?? '?'} → ${STATUS_JA[i.status] || i.status || ''}`));
    }
  }

  function renderAgent(tool, card) {
    const i = tool.input || {};
    const sub = tool.sub;
    const status = sub ? sub.status : tool.result ? (tool.result.isError ? 'error' : 'done') : 'running';
    const head = h('div', 'cv-tool-head');
    head.append(
      h('span', `cv-agent-st ${status}`, status === 'running' ? '⟳' : status === 'error' ? '✕' : '✓'),
      h('span', 'cv-verb', i.name ? `チームメンバー ${i.name}` : 'サブエージェント'),
      h('span', null, i.description || ''),
      h('span', 'cv-muted', i.subagent_type || ''),
    );
    card.append(head);
    if (sub) {
      const parts = [`ツール ${sub.toolCount} 回`];
      if (sub.lastTool) parts.push(`最後: ${sub.lastTool.name} ${sub.lastTool.arg || ''}`);
      card.append(h('div', 'cv-muted cv-sub-line', parts.join(' · ')));
    }
    card.append(toolFold(tool, 'agent', [h('span', 'cv-muted', '指示と結果')], () => {
      const b = h('div');
      if (i.prompt) b.append(h('div', 'cv-label', '指示'), pre(String(i.prompt)));
      if (tool.result) b.append(h('div', 'cv-label', '結果'), resultBlock(tool));
      return b;
    }, !!tool.result?.isError || foldSettings().openResults));
  }

  function renderAsk(tool, card) {
    const qs = Array.isArray(tool.input?.questions) ? tool.input.questions : [];
    card.append(h('div', 'cv-tool-head', '？ 質問'));
    for (const q of qs) card.append(h('div', 'cv-ask-q', q.question || ''));
    if (tool.result) card.append(h('div', 'cv-ask-a', oneLine(tool.result.output ?? tool.result.text ?? '', 400)));
  }

  function renderGeneric(tool, card) {
    const head = h('div', 'cv-tool-head');
    head.append(h('span', 'cv-icon', toolIcon(tool.name)), h('span', 'cv-verb', tool.name), h('span', 'cv-arg', argSummary(tool.name, tool.input)));
    card.append(toolFold(tool, 'gen', [head], () => {
      const b = h('div');
      b.append(h('div', 'cv-label', '入力'), pre(JSON.stringify(tool.input ?? {}, null, 2)));
      b.append(h('div', 'cv-label', '結果'), resultBlock(tool));
      return b;
    }, !!tool.result?.isError));
  }

  function drawTool(tool) {
    const card = tool.el;
    card.replaceChildren();
    card.classList.toggle('error', !!tool.result?.isError);
    if (SHELL_TOOLS.has(tool.name)) renderShell(tool, card);
    else if (EDIT_TOOLS.has(tool.name)) renderEdit(tool, card);
    else if (TASK_TOOLS.has(tool.name)) renderTasks(tool, card);
    else if (AGENT_TOOLS.has(tool.name)) renderAgent(tool, card);
    else if (tool.name === 'AskUserQuestion') renderAsk(tool, card);
    else renderGeneric(tool, card);
  }

  // Consecutive read-like tools collapse into one line: "読み取り 3 件（Read ×2, Grep）".
  function drawGroup(g) {
    const counts = new Map();
    for (const t of g.tools) counts.set(t.name, (counts.get(t.name) || 0) + 1);
    const names = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ');
    const errs = g.tools.filter((t) => t.result?.isError).length;
    const running = g.tools.some((t) => !t.result);
    g.sumText.textContent = `読み取り ${g.tools.length} 件（${names}）${running ? ' …' : ''}`;
    g.errEl.textContent = errs ? `エラー ${errs}` : '';
    g.errEl.hidden = !errs;
    g.el.classList.toggle('error', !!errs);
    g.details.rebuild();
  }

  function groupBody(g) {
    const list = h('div', 'cv-group-list');
    for (const t of g.tools) {
      const row = h('div', 'cv-group-row');
      row.append(fold([h('span', 'cv-verb', t.name), h('span', 'cv-arg', argSummary(t.name, t.input))], () => resultBlock(t), !!t.result?.isError, t.result?.isError ? 'error' : ''));
      list.append(row);
    }
    return list;
  }

  // ---- QA tables: answer right in the table --------------------------------------------
  // A Markdown table from Claude with an answer column ("回答" / "Answer") becomes a small form:
  // each answer cell is a text box, and "回答を送る" sends the answers back as one message
  // (blank answers = "仮説どおり"). User request 2026-11-03: "QA 表にすぐそのまま入力したい".
  //
  // Only a real QA table (CLAUDE.md format | # | 論点 | 仮説 | 質問 | 回答 |) gets the form: it must have the
  // 回答, 論点, 仮説 and 質問 columns. A report table such as "| # | 回答 | 変更 |" stays a plain table (AT-88: it
  // was read as a QA table, its filled 回答 cells were sent back as answers, with a broken "| # | # | 回答 |" head).
  // Sent answers are remembered per table (hash of the head and the non-answer cells) in localStorage, so a
  // re-render, a restart or a handoff shows "回答済み" instead of an open form; only "もう一度送る" sends again.
  // Nothing here sends on its own: only the button / Ctrl+Enter in an answer box (a user action) does.
  const ANSWER_HEAD_RE = /^(回答|答え|answer|あなたの回答|ご回答)/i;
  const TOPIC_HEAD_RE = /^(論点|topic|issue)/i;
  const HYPO_HEAD_RE = /^(仮説|hypothesis)/i;
  const QUESTION_HEAD_RE = /^(質問|question)/i;
  const QA_PREFIX = 'QA 表への回答です。空欄は仮説どおりです。';
  const QA_SENT_KEY = 'qaSent';
  const QA_SENT_MAX = 300;

  function qaColumns(heads) {
    const find = (re) => heads.findIndex((t) => re.test(t));
    const cols = { ans: find(ANSWER_HEAD_RE), topic: find(TOPIC_HEAD_RE), hypo: find(HYPO_HEAD_RE), question: find(QUESTION_HEAD_RE) };
    return cols.ans >= 0 && cols.topic >= 0 && cols.hypo >= 0 && cols.question >= 0 ? cols : null;
  }

  // FNV-1a over the table's head and every cell except the answer column (the answers are what changes).
  function qaKey(heads, rows, ans) {
    const parts = [heads.join('|')];
    for (const tr of rows) parts.push([...tr.children].filter((_c, i) => i !== ans).map((c) => c.textContent.trim()).join('|'));
    let x = 0x811c9dc5;
    const s = parts.join('\n');
    for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 0x01000193) >>> 0;
    return `qa1:${x.toString(16)}:${s.length}`;
  }

  function qaSentAll() {
    try {
      const v = JSON.parse(localStorage.getItem(QA_SENT_KEY) || '{}');
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }
  const qaSentGet = (key) => qaSentAll()[key] || null;
  function qaSentSet(key, answers) {
    try {
      const all = qaSentAll();
      all[key] = { at: Date.now(), answers };
      const keys = Object.keys(all);
      if (keys.length > QA_SENT_MAX) {
        keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
        for (const k of keys.slice(0, keys.length - QA_SENT_MAX)) delete all[k];
      }
      localStorage.setItem(QA_SENT_KEY, JSON.stringify(all));
    } catch (err) {
      console.error(err);
    }
  }
  const qaWhen = (at) => {
    const d = new Date(at);
    return Number.isFinite(d.getTime()) ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
  };

  // "入力欄に入れる" then a send from the input box: mark that table as answered too.
  function qaNoteSent(conv, text) {
    const pend = conv.qaPending;
    if (!pend || !pend.size) return;
    const t = String(text || '').trim();
    for (const [key, p] of pend) {
      if (t.startsWith(p.text.trim())) {
        pend.delete(key);
        p.markSent();
      }
    }
  }

  function makeQaTables(root, tab, conv) {
    root.querySelectorAll('table').forEach((table) => {
      const heads = [...table.querySelectorAll('thead th, tr:first-child th')].map((th) => th.textContent.trim());
      const cols = qaColumns(heads);
      if (!cols) return;
      const { ans, topic } = cols;
      const rows = [...table.querySelectorAll('tbody tr')];
      if (!rows.length) return;
      const key = qaKey(heads, rows, ans);
      table.classList.add('cv-qa');
      table.dataset.qaKey = key;
      const boxes = [];
      for (const tr of rows) {
        const cell = tr.children[ans];
        if (!cell) continue;
        const prefilled = cell.textContent.trim();
        const box = h('textarea', 'cv-qa-input');
        box.rows = 1;
        box.placeholder = '仮説どおりなら空欄';
        box.value = prefilled;
        box.addEventListener('input', () => {
          box.style.height = 'auto';
          box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
        });
        // Enter = newline inside a cell; Ctrl+Enter sends all answers (like the composer).
        box.addEventListener('keydown', (e) => {
          if (e.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (!box.readOnly) send.click(); // an answered table never re-sends from the keyboard
          }
        });
        cell.replaceChildren(box);
        const cells = [...tr.children].map((c) => c.textContent.trim());
        boxes.push({ box, label: cells[0] || '', topic: tr.children[topic]?.textContent.trim() || '' });
      }
      const bar = h('div', 'cv-qa-bar');
      const send = h('button', 'cv-qa-send', '回答を送る');
      send.type = 'button';
      send.title = `${window.Labels.key('mod+Enter')}（どの回答欄からでも）`;
      const toBox = h('button', 'cv-qa-alt', '入力欄に入れる');
      toBox.type = 'button';
      const note = h('span', 'cv-qa-note');
      bar.append(send, toBox, note);
      table.after(bar);
      const showSent = (rec) => {
        if (rec && Array.isArray(rec.answers)) boxes.forEach((b, i) => { if (typeof rec.answers[i] === 'string') b.box.value = rec.answers[i]; });
        for (const b of boxes) b.box.readOnly = true;
        table.classList.add('cv-qa-done');
        send.textContent = 'もう一度送る';
        send.title = '同じ回答をもう一度送ります';
        send.dataset.resend = '1';
        toBox.disabled = true;
        note.textContent = `回答済み${rec && rec.at ? `（${qaWhen(rec.at)}）` : ''}`;
      };
      const markSent = () => {
        const answers = boxes.map((b) => b.box.value);
        qaSentSet(key, answers);
        showSent({ at: Date.now(), answers });
      };
      const prev = qaSentGet(key);
      if (prev) showSent(prev);
      const compose = () => {
        const lines = [QA_PREFIX, '', `| ${heads[0] || '#'} | ${heads[topic] || '論点'} | 回答 |`, '|---|---|---|'];
        for (const b of boxes) {
          const a = b.box.value.trim().replace(/\r?\n/g, ' / ').replace(/\|/g, '｜') || '仮説どおり';
          const label = b.label.replace(/\|/g, '｜');
          lines.push(`| ${label} | ${b.topic.replace(/\|/g, '｜')} | ${a} |`);
        }
        return lines.join('\n');
      };
      send.addEventListener('click', () => {
        const why = hk(conv).send ? hk(conv).send(tab, compose()) : 'not ready';
        if (why) {
          note.textContent = why;
          return;
        }
        conv.qaPending?.delete(key);
        markSent();
        note.textContent = `送りました（${qaWhen(Date.now())}）`;
      });
      toBox.addEventListener('click', () => {
        const text = compose();
        if (!conv.qaPending) conv.qaPending = new Map();
        conv.qaPending.set(key, { text, markSent });
        conv.input.value = text;
        conv.input.dispatchEvent(new Event('input'));
        conv.input.focus();
        note.textContent = `入力欄に入れました（${window.Labels.key('mod+Enter')} で送信）`;
      });
    });
  }

  // ---- attached images in prompts ------------------------------------------------
  // Absolute image paths (Windows C:\…, macOS /…), optionally quoted (paths with spaces are sent quoted). paths.js (UX2).
  const IMAGE_PATH_RE = window.AtPath.IMAGE_PATH_RE;

  function splitImagePaths(raw) {
    const images = [];
    const text = String(raw || '')
      .replace(IMAGE_PATH_RE, (_m, quoted, bare) => {
        images.push(quoted || bare);
        return '';
      })
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text, images };
  }

  function imageStrip(paths) {
    const strip = h('div', 'cv-images');
    for (const p of paths) {
      const fig = h('button', 'cv-image');
      fig.type = 'button';
      fig.title = `${p}\nクリックで開く`;
      fig.append(h('span', 'cv-image-ph', base(p)));
      fig.addEventListener('click', () => hooks.openFile?.(p));
      strip.append(fig);
      Promise.resolve(hooks.imageRead?.(p)).then((url) => {
        if (!url) {
          fig.classList.add('missing');
          fig.title = `${p}\n（画像を読み込めませんでした）`;
          return;
        }
        const img = h('img');
        img.src = url; // data: URL from main (CSP allows data: images)
        img.alt = base(p);
        fig.replaceChildren(img);
      }).catch(() => fig.classList.add('missing'));
    }
    return strip;
  }

  // ---- state ------------------------------------------------------------------
  // opts.readOnly: no input box / mode buttons (subagent and team member views).
  // opts.hooks (UX13): this view's own hooks (send / choose / key / queue ...; missing ones fall back to init's).
  // opts.noComposer: no composer.js (attachments, palette, drafts) – the main window's session view (session-view.js).
  function create(tab, opts = {}) {
    const own = opts.hooks && typeof opts.hooks === 'object' ? opts.hooks : null;
    const H = () => (own ? { ...hooks, ...own } : hooks);
    const el = h('div', `conv${opts.readOnly ? ' readonly' : ''}`);
    const list = h('div', 'cv-list');
    const empty = h('div', 'cv-empty', opts.readOnly ? '読み込み中…' : '会話はまだありません。下の入力欄から送信できます。');
    list.append(empty);
    const scroll = h('div', 'cv-scroll');
    scroll.append(list);
    const jump = h('button', 'cv-jump', '↓ 最新へ');
    jump.type = 'button';
    jump.hidden = true;

    const dock = h('div', 'cv-dock');
    const banner = h('div', 'cv-banner');
    banner.hidden = true;
    const status = h('div', 'cv-status');
    const choices = h('div', 'cv-choices');
    choices.hidden = true;
    const inputRow = h('div', 'cv-input-row');
    const input = h('textarea', 'cv-input');
    input.rows = 1;
    // Enter = newline, Ctrl+Enter = send (user's choice, 2026-11-03: IME-friendly, no accidental sends).
    input.placeholder = `メッセージ（${window.Labels.key('mod+Enter')} で送信、Enter で改行）`;
    input.spellcheck = false;
    // Just the text box (2026-11-03, user: the area was too busy). No send button (Ctrl+Enter), no
    // target line, no mode / interrupt / peek buttons: the pane tab's button cycles the view mode,
    // Esc interrupts, and the terminal is shown automatically when it is needed.
    inputRow.append(input);
    dock.append(banner, status, choices, inputRow);
    if (opts.readOnly) inputRow.hidden = true;
    el.append(scroll, jump, dock);

    const conv = {
      el, list, empty, scroll, jump, banner, status, choices, input, readOnly: !!opts.readOnly,
      hooks: own ? { ...hooks, ...own } : null, // UX13 (hk)
      dock, // the composer area (status, choices, input, mode buttons); core moves it under the terminal in 'term' mode
      items: [], // { el, kind }
      tools: new Map(), // toolUseId -> tool
      subs: new Map(), // toolUseId -> latest subagent snapshot
      texts: new Set(), // assistant_text keys already shown
      prompts: new Set(),
      lastGroup: null,
      history: [],
      histIdx: -1,
      draft: '',
      lastScreenKey: '', // onScreen: the status line's key (no spinner text)
      lastChoicesKey: '',
      spinText: null, // the running line's text element (the spinner text is replaced in place)
      stick: true,
      dropped: 0,
      turnStart: 0, // index in items where the latest turn starts (older turns fold their tool rows, UIUX U6)
    };

    scroll.addEventListener('scroll', () => {
      if (!scroll.clientHeight) return; // hidden (another tab in the pane): keep "at the end" for when it comes back
      const atEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
      if (!atEnd && conv.pinning) return; // scrollEnd is still settling the estimated heights
      conv.stick = atEnd;
      // UX3 (mac-polish 13): sit just above the scroll's bottom edge (the dock's height varies), not a fixed 96px
      if (!atEnd) jump.style.bottom = Math.max(0, el.clientHeight - scroll.offsetTop - scroll.clientHeight) + 10 + 'px';
      jump.hidden = conv.stick;
    });
    // Shown again (tab switch, the tab before it closed): a hidden view loses its scroll position, so a view that
    // was at the end goes to the end again instead of starting at the top.
    if (typeof ResizeObserver === 'function') {
      let wasShown = false;
      new ResizeObserver(() => {
        const shown = scroll.clientHeight > 0;
        if (shown && !wasShown && conv.stick) scrollEnd(conv);
        else if (shown && conv.problemPut) conv.problemPut(); // UA3: the problem's entry stays in view on a resize
        wasShown = shown;
        conv.shown = shown;
      }).observe(scroll);
    }
    jump.addEventListener('click', () => {
      conv.stick = true;
      scrollEnd(conv);
    });
    list.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a || a.classList.contains('cv-file')) return;
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) H().openUrl?.(href);
    });

    const autoGrow = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
      input.classList.toggle('cv-tall', input.scrollHeight > 220); // UX3: the scroll thumb only when it is needed
    };
    const notice = h('div', 'cv-notice');
    notice.hidden = true;
    dock.insertBefore(notice, inputRow);
    let noticeT = 0;
    const showNotice = (msg) => {
      notice.textContent = msg;
      notice.hidden = false;
      clearTimeout(noticeT);
      noticeT = setTimeout(() => { notice.hidden = true; }, 5000);
    };
    conv.showNotice = showNotice;
    const submit = () => {
      const comp = conv.composer;
      if (comp ? comp.isEmpty() : !input.value.trim()) return;
      const text = comp ? comp.compose() : input.value;
      const why = H().send ? H().send(tab, text) : 'not ready';
      if (why) {
        showNotice(why); // the text (and attachments) stay in the box
        return;
      }
      notice.hidden = true;
      qaNoteSent(conv, text);
      const typed = input.value.replace(/\s+$/, '');
      if (typed && conv.history[conv.history.length - 1] !== typed) conv.history.push(typed);
      if (conv.history.length > 200) conv.history.shift();
      if (typed) H().sent?.(tab, typed); // folder-wide send history (Ctrl+R)
      conv.histIdx = -1;
      input.value = '';
      comp?.clear();
      autoGrow();
      conv.stick = true;
    };
    input.addEventListener('input', () => {
      autoGrow();
      conv.lastInputAt = Date.now(); // the backlog waits while the user is typing
    });
    // IME composition (PROGRESS 23b): the automatic switch to the terminal hides this box, which ends the
    // composition with nothing committed. The core waits while conv.composing and scans again at the end.
    conv.composing = false;
    const compositionDone = () => {
      if (!conv.composing) return;
      conv.composing = false;
      H().composed?.(tab);
    };
    input.addEventListener('compositionstart', () => { conv.composing = true; });
    input.addEventListener('compositionend', compositionDone);
    // Focus moved elsewhere mid-composition: compositionend may never come. A window blur also fires focusout but
    // keeps the box as document.activeElement (and the composition), so that one keeps waiting.
    input.addEventListener('focusout', () => setTimeout(() => {
      if (document.activeElement !== input) compositionDone();
    }, 0));
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
        // Ctrl+Shift+Enter: not now — put it on the backlog (sent when the session is done).
        e.preventDefault();
        const comp = conv.composer;
        if (comp ? comp.isEmpty() : !input.value.trim()) return;
        const text = comp ? comp.compose() : input.value;
        const why = H().queue ? H().queue(tab, text) : '待ちの一覧がありません';
        if (why) {
          showNotice(why);
          return;
        }
        input.value = '';
        comp?.clear();
        autoGrow();
        showNotice(`待ちに追加しました（${window.Labels.shortcutKey('backlog')} で一覧）`);
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey) {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        // Esc reaches Claude Code only to interrupt a turn or cancel a dialog. While idle it does
        // nothing: a double Esc would open Claude Code's rewind screen, and clearing the box would
        // throw away a long multi-line draft.
        e.preventDefault();
        const sc = conv.screen || {};
        if (sc.status === 'running' || sc.status === 'asking') H().key?.(tab, 'esc');
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && conv.history.length) {
        const atTop = input.selectionStart === 0 && input.selectionEnd === 0;
        const atEnd = input.selectionStart === input.value.length;
        if (e.key === 'ArrowUp' && (atTop || !input.value)) {
          e.preventDefault();
          if (conv.histIdx < 0) {
            conv.draft = input.value;
            conv.histIdx = conv.history.length;
          }
          conv.histIdx = Math.max(0, conv.histIdx - 1);
          input.value = conv.history[conv.histIdx];
          autoGrow();
        } else if (e.key === 'ArrowDown' && conv.histIdx >= 0 && atEnd) {
          e.preventDefault();
          conv.histIdx++;
          if (conv.histIdx >= conv.history.length) {
            conv.histIdx = -1;
            input.value = conv.draft;
          } else input.value = conv.history[conv.histIdx];
          autoGrow();
        }
      }
    });
    conv.submit = submit; // Ctrl+Enter (and tests)

    // Attachments (dropped files, pasted images, @ search), "/" palette, Ctrl+R history, drafts:
    // composer.js. Without it, dropped files are not handled here (the pane inserts paths).
    if (!opts.readOnly && !opts.noComposer && window.Composer) {
      conv.history = (H().history?.() || []).slice(-200);
      try {
        conv.composer = window.Composer.attach(conv, tab, H());
      } catch (err) {
        console.error(err);
      }
    }
    return conv;
  }

  // Entries that were off screen have an estimated height (content-visibility: auto, conversation.css); the ones
  // scrolled into view get their real height a frame or two later. So keep going to the end for a few frames.
  const PIN_FRAMES = 4;
  function scrollEnd(conv) {
    if (conv.staging) return; // the restore draws the older part off the page
    const running = conv.pinning > 0;
    conv.pinning = PIN_FRAMES;
    if (running) return;
    const step = () => {
      conv.scroll.scrollTop = conv.scroll.scrollHeight;
      if (--conv.pinning > 0) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---- UA3: the entry of the problem (docs/usage-analytics.md §4 の 1) -------------------------------
  // The session is opened because something is wrong: show that place, not the newest line. permission / question /
  // stuck -> the last tool of the latest turn still without a result (the one the dialog asks about, the one that
  // hangs); error / failed -> the last tool with an error in the latest turn; else the last entry.
  function problemEntry(conv, kind) {
    const items = conv.items;
    if (!items.length) return null;
    const err = kind === 'error' || kind === 'failed';
    for (let i = items.length - 1; i >= Math.min(conv.turnStart || 0, items.length - 1); i--) {
      const ts = (items[i].toolIds || []).map((id) => conv.tools.get(id)).filter(Boolean);
      if (ts.some((t) => (err ? t.result?.isError : !t.result))) return items[i].el;
    }
    return items[items.length - 1].el;
  }
  function clearProblem(tab) {
    const conv = tab?.conv;
    if (!conv?.problemEl) return;
    conv.problemEl.classList.remove('cv-problem');
    conv.problemEl = null;
    conv.problemPut = null;
  }
  // marks the entry and scrolls it to the top of the view (a little room above); -> the entry or null
  function showProblem(tab, kind) {
    const conv = tab?.conv;
    if (!conv) return null;
    clearProblem(tab);
    const el = problemEntry(conv, kind);
    if (!el) return null;
    el.classList.add('cv-problem');
    conv.problemEl = el;
    for (let d = el.parentElement?.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true; // folded "N 件の操作"
    conv.stick = false;
    conv.pinning = 0; // a scrollEnd still settling would take the view back to the end
    const put = () => {
      const s = conv.scroll;
      if (!s.clientHeight || !el.isConnected) return;
      s.scrollTop = Math.max(0, el.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - 48);
    };
    // the entries above have estimated heights (content-visibility: auto) until they are laid out: a few frames.
    // A resize of the view (window width, the composer's height) puts it again, until the user scrolls themselves.
    conv.problemPut = () => {
      let n = 0;
      const step = () => {
        put();
        if (++n < PIN_FRAMES) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    if (!conv.problemHooked) {
      conv.problemHooked = true;
      for (const ev of ['wheel', 'pointerdown', 'keydown']) conv.scroll.addEventListener(ev, () => { conv.problemPut = null; }, { passive: true });
    }
    conv.problemPut();
    return el;
  }

  // ---- older turns: runs of tool rows -> one line "N 件の操作" (UIUX U6) ---------------------
  const OPS_KIND = (name) => (EDIT_TOOLS.has(name) ? '編集' : SHELL_TOOLS.has(name) ? 'コマンド' : READ_TOOLS.has(name) ? '読み取り' : AGENT_TOOLS.has(name) ? 'サブエージェント' : 'その他');
  // an error or a question stays where it is (open), and ends the run
  function keepShown(conv, it) {
    return (it.toolIds || []).some((id) => {
      const t = conv.tools.get(id);
      return t && (t.result?.isError || t.name === 'AskUserQuestion');
    });
  }
  function wrapOps(conv, run) {
    const names = [];
    for (const it of run) for (const id of it.toolIds || []) names.push(conv.tools.get(id)?.name || '');
    const counts = new Map();
    for (const n of names) counts.set(OPS_KIND(n), (counts.get(OPS_KIND(n)) || 0) + 1);
    const box = h('div', 'cv-item cv-ops');
    const d = h('details', 'cv-fold cv-ops-fold');
    const s = h('summary');
    const word = window.Labels?.WORDS?.ops || '件の操作';
    s.append(h('span', 'cv-icon', '≡'), h('span', 'cv-ops-sum', `${names.length} ${word}`), h('span', 'cv-muted', `（${[...counts].map(([k, c]) => `${k} ${c}`).join('・')}）`));
    const body = h('div', 'cv-ops-body');
    d.append(s, body);
    box.append(d);
    run[0].el.before(box);
    const wrap = { el: box, body };
    for (const it of run) {
      body.append(it.el);
      it.wrap = wrap;
    }
  }
  function collapseTurn(conv) {
    const items = conv.items;
    let run = [];
    const flush = () => {
      if (run.length && run.reduce((a, it) => a + (it.toolIds || []).length, 0) >= OPS_MIN) wrapOps(conv, run);
      run = [];
    };
    for (let i = Math.max(0, conv.turnStart || 0); i < items.length; i++) {
      const it = items[i];
      if ((it.kind === 'tool' || it.kind === 'group') && !it.wrap && !keepShown(conv, it)) run.push(it);
      else flush();
    }
    flush();
    conv.turnStart = items.length; // the new turn starts with the prompt pushed next
  }

  function push(conv, el, kind) {
    conv.empty.remove();
    conv.list.append(el);
    conv.items.push({ el, kind });
    if (!conv.staging) markFresh(conv, el);
    if (kind !== 'group') conv.lastGroup = null;
    trimOld(conv);
    if (conv.stick && !conv.staging) scrollEnd(conv);
  }

  // UX8: new entries skip content-visibility: auto until FRESH_MS later (conversation.css .cv-fresh), then all of them
  // go back to auto at once (one layout for the lot, not one per entry)
  const FRESH_MS = 3000;
  function markFresh(conv, el) {
    el.classList.add('cv-fresh');
    (conv.fresh ||= []).push(el);
    if (conv.freshTimer) return;
    conv.freshTimer = setTimeout(() => {
      conv.freshTimer = 0;
      const all = conv.fresh || [];
      conv.fresh = [];
      for (const x of all) x.classList.remove('cv-fresh');
    }, FRESH_MS);
  }

  function trimOld(conv) {
    while (conv.items.length > MAX_ITEMS) {
      const old = conv.items.shift();
      old.el.remove();
      if (old.wrap && !old.wrap.body.childElementCount) old.wrap.el.remove();
      if (conv.turnStart > 0) conv.turnStart--;
      // Forget the data behind the dropped entry (tool input / output can be large).
      for (const id of old.toolIds || []) {
        conv.tools.delete(id);
        conv.subs.delete(id);
      }
      if (conv.texts.size > MAX_ITEMS * 2) conv.texts = new Set([...conv.texts].slice(-MAX_ITEMS));
      if (conv.prompts.size > MAX_ITEMS) conv.prompts = new Set([...conv.prompts].slice(-MAX_ITEMS / 2));
      conv.dropped++;
      let note = conv.list.querySelector('.cv-dropped');
      if (!note) {
        note = h('div', 'cv-dropped');
        conv.list.prepend(note);
      }
      note.textContent = `古い ${conv.dropped} 件は省略しています（全文はターミナルか transcript で確認できます）`;
    }
  }

  function addTool(conv, evt) {
    if (!evt.toolUseId || conv.tools.has(evt.toolUseId)) return;
    const tool = { id: evt.toolUseId, name: evt.name, input: evt.input, result: null, sub: conv.subs.get(evt.toolUseId) || null, el: null, group: null };
    conv.tools.set(tool.id, tool);
    if (READ_TOOLS.has(tool.name)) {
      let g = conv.lastGroup;
      if (!g) {
        g = { tools: [], el: h('div', 'cv-item cv-group') };
        g.sumText = h('span', 'cv-group-sum');
        g.errEl = h('span', 'cv-err-label');
        g.details = fold([h('span', 'cv-icon', '⌕'), g.sumText, g.errEl], () => groupBody(g));
        g.el.append(g.details);
        push(conv, g.el, 'group');
        g.item = conv.items[conv.items.length - 1];
        g.item.toolIds = [];
        conv.lastGroup = g;
      }
      tool.group = g;
      g.tools.push(tool);
      g.item.toolIds.push(tool.id);
      drawGroup(g);
      return;
    }
    tool.el = h('div', `cv-item cv-tool t-${String(tool.name).replace(/[^A-Za-z0-9_-]/g, '')}`);
    drawTool(tool);
    push(conv, tool.el, 'tool');
    conv.items[conv.items.length - 1].toolIds = [tool.id];
  }

  // History replay: collect, then render only the tail that fits in MAX_ITEMS (markdown parsing of
  // thousands of old messages would freeze the window when several long sessions are restored).
  const ITEM_KINDS = new Set(['prompt', 'assistant_text', 'tool_use', 'teammate']);
  function beginBulk(tab) {
    if (!tab.conv) return;
    drainLive(tab); // events held back for the next batch go before the history
    tab.conv.bulk = [];
    tab.conv.restore = null; // an older part still being drawn is dropped (a new history comes)
    tab.conv.restoring = false;
  }
  function endBulk(tab) {
    const conv = tab.conv;
    if (!conv || !conv.bulk) return;
    const evts = conv.bulk;
    conv.bulk = null;
    let start = 0;
    let n = 0;
    for (let i = evts.length - 1; i >= 0; i--) {
      if (ITEM_KINDS.has(evts[i].kind) && ++n > MAX_ITEMS) {
        start = i + 1;
        break;
      }
    }
    let skipped = 0;
    for (let i = 0; i < start; i++) {
      if (evts[i].kind === 'subagent') applyEvent(tab, evts[i]); // cheap; may belong to a later tool
      else if (ITEM_KINDS.has(evts[i].kind)) skipped++;
    }
    if (skipped) {
      conv.dropped += skipped;
      const note = h('div', 'cv-dropped', `古い ${conv.dropped} 件は省略しています（全文はターミナルか transcript で確認できます）`);
      conv.empty.remove();
      conv.list.prepend(note);
    }
    // UX8 (docs/mac-polish.md J5): the last TAIL_ITEMS entries first (from a prompt when one is among them), the older
    // ones at idle moments, drawn off the page and put in front at once (restoring 200 turns was one 126 ms task).
    let split = -1;
    let cut = start;
    n = 0;
    for (let i = evts.length - 1; i >= start; i--) {
      if (!ITEM_KINDS.has(evts[i].kind)) continue;
      if (++n > TAIL_ITEMS) break;
      cut = i;
      if (evts[i].kind === 'prompt') split = i;
    }
    if (n <= TAIL_ITEMS) split = start; // short history: all at once
    else if (split < 0) split = cut; // no prompt among the last ones: cut at the count
    for (let i = split; i < evts.length; i++) applyEvent(tab, evts[i]);
    conv.stick = true;
    scrollEnd(conv);
    if (split > start) restoreOlder(tab, conv, evts, start, split);
  }

  const TAIL_ITEMS = 50;
  const RESTORE_SLICE_MS = 8;
  function restoreOlder(tab, conv, evts, from, to) {
    const tail = conv.items;
    const job = {
      evts, i: from, to, tail, atPrompt: tail.length > 0 && tail[0].kind === 'user',
      list: h('div', 'cv-list'), items: [], lastGroup: null, turnStart: 0, late: [],
    };
    // results / snapshots in the tail for tools drawn in the older part: applied again once those exist
    for (let i = to; i < evts.length; i++) if ((evts[i].kind === 'tool_result' || evts[i].kind === 'subagent') && evts[i].toolUseId && !conv.tools.has(evts[i].toolUseId)) job.late.push(evts[i]);
    conv.restore = job;
    conv.restoring = true;
    const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => RESTORE_SLICE_MS }), 16));
    const step = (deadline) => {
      if (conv.restore !== job) return;
      const t0 = performance.now();
      const real = { list: conv.list, items: conv.items, lastGroup: conv.lastGroup, turnStart: conv.turnStart, stick: conv.stick };
      conv.list = job.list;
      conv.items = job.items;
      conv.lastGroup = job.lastGroup;
      conv.turnStart = job.turnStart;
      conv.staging = true;
      try {
        const budget = deadline.didTimeout ? RESTORE_SLICE_MS : Math.min(RESTORE_SLICE_MS, Math.max(2, deadline.timeRemaining()));
        while (job.i < job.to && performance.now() - t0 < budget) applyEvent(tab, job.evts[job.i++]);
        if (job.i >= job.to && job.atPrompt) collapseTurn(conv); // the older part's last turn folds like any older turn
      } finally {
        job.lastGroup = conv.lastGroup;
        job.turnStart = conv.turnStart;
        conv.list = real.list;
        conv.items = real.items;
        conv.lastGroup = real.lastGroup;
        conv.turnStart = real.turnStart;
        conv.stick = real.stick; // a prompt in the older part must not pin the view to the end
        conv.staging = false;
      }
      if (job.i < job.to) return idle(step, { timeout: 1000 });
      mergeOlder(tab, conv, job);
    };
    idle(step, { timeout: 1000 });
  }
  function mergeOlder(tab, conv, job) {
    conv.restore = null;
    conv.restoring = false;
    const first = job.tail[0];
    const ref = first ? (first.wrap ? first.wrap.el : first.el) : null;
    // the tail's first entry was dropped meanwhile (more than MAX_ITEMS new ones): the older part is older still
    if (!ref || ref.parentNode !== conv.list || conv.items[0] !== first) return;
    const before = conv.stick ? 0 : conv.scroll.scrollHeight;
    const frag = document.createDocumentFragment();
    frag.append(...job.list.childNodes);
    conv.list.insertBefore(frag, ref);
    conv.items = job.items.concat(conv.items);
    conv.turnStart += job.items.length;
    trimOld(conv);
    for (const evt of job.late) applyEvent(tab, evt);
    if (conv.stick) scrollEnd(conv);
    else conv.scroll.scrollTop += conv.scroll.scrollHeight - before; // the entries on screen stay where they were
  }

  // UX8 (docs/mac-polish.md J4): while output streams (an event every few frames), each event appended an entry and
  // the list was laid out about 3 times for it (content-visibility: auto settles the sizes over the next frames): 60
  // layouts / s at 20 events / s. While events stream (the third or later within DENSE_MS, in other tasks) they are
  // now held and drawn together, at most every LIVE_BATCH_MS. One or two events after a quiet moment, and the ones of
  // the same task as one just drawn (a burst handed over at once), are drawn at once.
  const LIVE_BATCH_MS = 250;
  const DENSE_MS = 300;
  let sameTask = false;
  function markTask() {
    if (sameTask) return true;
    sameTask = true;
    queueMicrotask(() => (sameTask = false));
    return false;
  }
  function drainLive(tab) {
    const conv = tab.conv;
    if (!conv || !conv.liveQ) return;
    const q = conv.liveQ;
    conv.liveQ = null;
    clearTimeout(conv.liveTimer);
    for (const evt of q) applyEvent(tab, evt);
  }
  function onEvent(tab, evt) {
    const conv = tab.conv;
    if (!conv || !evt) return;
    if (conv.bulk) {
      conv.bulk.push(evt);
      return;
    }
    const now = performance.now();
    const inTask = markTask();
    const rec = (conv.liveRecent ||= []);
    if (!inTask) {
      rec.push(now);
      if (rec.length > 3) rec.shift();
    }
    const dense = rec.length >= 3 && now - rec[0] < DENSE_MS;
    const quiet = now - (conv.liveAt || -1e9) >= LIVE_BATCH_MS;
    if (conv.liveQ) conv.liveQ.push(evt);
    else if (!dense || quiet || (inTask && conv.liveTask)) {
      conv.liveAt = now;
      conv.liveTask = true;
      applyEvent(tab, evt);
    } else {
      conv.liveQ = [evt];
      conv.liveTimer = setTimeout(() => {
        conv.liveAt = performance.now();
        drainLive(tab);
      }, Math.max(0, LIVE_BATCH_MS - (now - conv.liveAt)));
    }
    if (!inTask) queueMicrotask(() => (conv.liveTask = false));
  }

  function applyEvent(tab, evt) {
    const conv = tab.conv;
    if (!conv || !evt) return;
    switch (evt.kind) {
      case 'prompt': {
        const key = `${evt.ts}|${evt.text}`;
        if (conv.prompts.has(key)) return;
        conv.prompts.add(key);
        collapseTurn(conv); // the turn before this one: its tool rows fold into "N 件の操作"
        const el = h('div', 'cv-item cv-user');
        // Attached images arrive as absolute paths in the text (composer: message + blank line + paths).
        // Show them as pictures, not as paths.
        const { text, images } = splitImagePaths(evt.text);
        if (text) el.append(promptBubble(text));
        if (images.length) el.append(imageStrip(images));
        push(conv, el, 'user');
        conv.stick = true;
        scrollEnd(conv);
        break;
      }
      case 'assistant_text': {
        const key = evt.uuid ? `${evt.uuid}:${evt.idx ?? 0}` : `${evt.msgId}|${evt.ts}|${evt.text.length}`;
        if (conv.texts.has(key)) return;
        conv.texts.add(key);
        const el = h('div', 'cv-item cv-text');
        const body = md(evt.text, conv.stick && conv.shown && !conv.staging);
        el.append(body);
        if (!conv.readOnly) makeQaTables(body, tab, conv);
        push(conv, el, 'text');
        break;
      }
      case 'tool_use':
        addTool(conv, evt);
        break;
      case 'tool_result': {
        const tool = conv.tools.get(evt.toolUseId);
        if (!tool) {
          if (conv.restore && !conv.staging) conv.restore.late.push(evt);
          return;
        }
        // Re-fed history (member views reload the whole file): keep the card (and its open folds).
        if (tool.result && tool.result.isError === !!evt.isError && tool.result.outputLen === evt.outputLen) return;
        tool.result = { isError: !!evt.isError, text: evt.text, output: evt.output, outputLen: evt.outputLen, patch: evt.patch, taskId: evt.taskId };
        if (tool.group) drawGroup(tool.group);
        else drawTool(tool);
        if (conv.stick) scrollEnd(conv);
        break;
      }
      case 'subagent': {
        if (!evt.toolUseId) return;
        conv.subs.set(evt.toolUseId, evt);
        const tool = conv.tools.get(evt.toolUseId);
        if (tool && !tool.group) {
          tool.sub = evt;
          drawTool(tool);
        }
        break;
      }
      case 'teammate': {
        const el = h('div', 'cv-item cv-note');
        el.textContent = `◆ ${evt.name}: ${evt.msgType === 'idle_notification' ? '待機中' : evt.msgType}${evt.summary ? ` — ${oneLine(evt.summary, 200)}` : ''}`;
        push(conv, el, 'note');
        break;
      }
      case 'turn_end':
        conv.lastGroup = null;
        break;
      default:
        break;
    }
  }

  // ---- screen-derived state (status line, choices, terminal hand-off) --------------
  function onScreen(tab, s) {
    const conv = tab.conv;
    if (!conv) return;
    conv.screen = s;
    const ch = s.choices && s.choices.options && s.choices.options.length ? s.choices : null;
    // UX8: the spinner text carries the elapsed seconds ("… (12s · ↑ 1.2k tokens)"); it changed the key every second and
    // rebuilt the status line and the choices. Now the key has no spinner: a new spinner text only replaces that text,
    // and the choices are rebuilt only when they change.
    const stKey = JSON.stringify([s.status, s.needTerminal, s.exited, s.rest || null]);
    const chKey = JSON.stringify(ch);
    if (stKey === conv.lastScreenKey && chKey === conv.lastChoicesKey) {
      if (conv.spinText && conv.spinText.textContent !== (s.spinner || '実行中…')) conv.spinText.textContent = s.spinner || '実行中…';
      return;
    }
    const choicesChanged = chKey !== conv.lastChoicesKey;
    conv.lastChoicesKey = chKey;
    if (stKey !== conv.lastScreenKey) {
      conv.lastScreenKey = stKey;
      drawStatus(conv, tab, s);
    } else if (conv.spinText) conv.spinText.textContent = s.spinner || '実行中…';
    if (choicesChanged) drawChoices(conv, tab, ch);
  }

  function drawStatus(conv, tab, s) {
    conv.spinText = null;
    conv.status.replaceChildren();
    conv.status.dataset.status = s.status || '';
    conv.status.dataset.rest = s.rest || '';
    if (s.exited) {
      // rest: claude stopped by the app (PROGRESS 35 'done' / 31 'idle'), the conversation stays
      const text = s.rest === 'done' ? '完了（休止中） — claude は止めています。「再開」か送信で起こします' : s.rest === 'idle' ? '休止中 — claude を休ませています' : 'claude は終了しました';
      conv.status.append(h('span', 'cv-st-text', text));
      if (hk(conv).restart) {
        const b = h('button', 'cv-restart', window.Labels?.WORDS?.resume || '再開');
        b.type = 'button';
        b.title = '同じ会話のまま claude を起動し直す';
        b.addEventListener('click', () => hk(conv).restart(tab));
        conv.status.append(b);
      }
    }
    else if (s.status === 'running') {
      conv.spinText = h('span', 'cv-st-text', s.spinner || '実行中…');
      conv.status.append(h('span', 'cv-spin'), conv.spinText);
    }
    else if (s.status === 'starting') conv.status.append(h('span', 'cv-spin'), h('span', 'cv-st-text', '起動中…'));
    conv.status.hidden = !conv.status.childNodes.length;

    conv.banner.hidden = !s.needTerminal;
    if (s.needTerminal) conv.banner.textContent = 'ターミナルで操作が必要です（メニューや全画面の表示）。ターミナルを表示しています。';
  }

  function drawChoices(conv, tab, ch) {
    conv.choices.replaceChildren();
    conv.choices.hidden = !ch;
    if (ch && ch.kind === 'multi') {
      // Multi-select question: boxes toggle with their digit (the cursor does not move, nothing is
      // sent); "Type something" and "Chat about this" are not offered (free text = terminal). The
      // button moves on with Tab: to the next question ("次へ") or to the review screen, whose
      // "1. Submit answers" then shows up as a normal choice.
      if (Array.isArray(ch.tabs) && ch.tabs.length > 1) {
        conv.choices.append(h('div', 'cv-qtabs', ch.tabs.map((t) => `${t.answered ? '✓ ' : ''}${t.label}`).join('  ·  ')));
      }
      if (ch.question) conv.choices.append(h('div', 'cv-q', `${ch.question}（複数選べます）`));
      const row = h('div', 'cv-opts');
      for (const o of ch.options) {
        if (o.other) continue;
        const b = h('button', `cv-opt cv-check${o.checked ? ' on' : ''}`);
        b.type = 'button';
        b.append(h('span', 'cv-box', o.checked ? '☑' : '☐'), h('span', null, o.label));
        b.addEventListener('click', () => hk(conv).choose?.(tab, o.n));
        row.append(b);
      }
      conv.choices.append(row);
      const next = h('button', 'cv-qa-send cv-multi-next', ch.submitLabel === 'Next' ? '次の質問へ' : '回答を確認する');
      next.type = 'button';
      next.title = ch.submitLabel === 'Next' ? 'Tab で次の質問へ進みます' : '確認画面へ進みます（そこで「Submit answers」を押すと送信）';
      next.addEventListener('click', () => {
        // From the last question Tab reaches the review screen; it stops there, so extra Tabs are harmless.
        const k = ch.submitLabel === 'Next' ? 1 : Math.max(1, (ch.tabs || []).length);
        for (let i = 0; i < k; i++) setTimeout(() => hk(conv).key?.(tab, 'tab'), i * 120);
      });
      const other = ch.options.find((o) => o.other);
      const bar = h('div', 'cv-qa-bar');
      bar.append(next);
      if (other) bar.append(h('span', 'cv-qa-note', `「${other.label}」の自由入力はターミナルで`));
      conv.choices.append(bar);
      if (conv.stick) scrollEnd(conv);
    } else if (ch) {
      if (ch.question) conv.choices.append(h('div', 'cv-q', ch.question));
      const row = h('div', 'cv-opts');
      for (const o of ch.options) {
        const b = h('button', `cv-opt${o.selected ? ' sel' : ''}`);
        b.type = 'button';
        // On the multi-question review screen "2. Cancel" throws all answers away: say so.
        const label = o.label === 'Cancel' && /submit your answers/i.test(ch.question || '') ? 'キャンセル（回答を破棄）' : o.label;
        b.append(h('span', 'cv-opt-n', String(o.n)), h('span', null, label));
        b.addEventListener('click', () => hk(conv).choose?.(tab, o.n));
        row.append(b);
      }
      conv.choices.append(row);
      if (conv.stick) scrollEnd(conv);
    }
  }

  function focus(tab) {
    const conv = tab?.conv;
    if (conv && conv.el.isConnected) conv.input.focus();
  }

  window.Conversation = {
    init(o) {
      hooks = o || {};
      if (window.marked?.use) {
        // Raw HTML in Claude's text (e.g. an unquoted "<div>" or "<b>") is shown as text instead of
        // being parsed and then stripped by the sanitizer, which would lose or restyle the prose.
        const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
        // Code blocks keep their language as data-lang (the sanitizer drops class="language-x"), for highlightCode().
        const code = (token) => {
          const lang = (String(token.lang ?? '').match(/^\S*/) || [''])[0];
          const body = String(token.text ?? '').replace(/\n$/, '');
          return `<pre${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${token.escaped ? body : esc(body)}\n</code></pre>\n`;
        };
        window.marked.use({ gfm: true, renderer: { html: (token) => esc(token.text ?? token.raw ?? ''), code } });
      }
    },
    create,
    onEvent,
    onScreen,
    focus,
    beginBulk,
    endBulk,
    foldSettings, // ⚙ 設定 →「差分を開いて表示」「結果を開いて表示」(settings.js)
    showProblem, // UA3: the problem band (renderer.js) scrolls the conversation to the problem
    clearProblem,
    setFoldSettings,
  };
})();
