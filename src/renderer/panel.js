// Assist panel (owner: panel). UX15: one column, 「この作業」 (the request, who started it, state and last move, what
// happens next, the next items, changed files, team, weight, and the one door for 再起動 / 引き継ぐ), in the dock
// container (Panel.attach) or the legacy <aside id="panel">. The main window's session view draws the same with
// Panel.renderWork from the data its owner window relays (Panel.workData).
// Pure state handling (newStats / applyEvent / computeView / summary) is DOM-free so it can be
// unit-tested in Node; the DOM part only runs in the browser.
(function () {
  const MAX_TOOLS = 50;
  const MAX_EDITS_PER_FILE = 30;
  const MAX_EDIT_CHARS = 4000;
  const CTX_DEFAULT = 200000;
  const CTX_LARGE = 1000000;
  const AGENT_TOOLS = new Set(['Agent', 'Task']);
  const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  const STOP_TOOLS = new Set(['TaskStop', 'KillShell', 'KillBash']);
  // tool_result texts that start a background task (verified on 2.1.317): "Command running in background with ID: x",
  // "…was moved to the background (ID: x)", "Monitor started (task x, …"
  const BG_START_RE = /running in background with ID: ([A-Za-z0-9_-]+)|moved to the background \(ID: ([A-Za-z0-9_-]+)\)|^Monitor started \(task ([A-Za-z0-9_-]+)/;
  const MAX_BG = 200;
  const CMD_RECENT_MS = 15 * 60 * 1000; // summary().cmds keeps an ended command this long (関係図: 「終わった」)
  // "… Output is being written to: C:\…\tasks\b01t3em1l.output. You will be notified …" (2.1.31x)
  const BG_OUT_RE = /Output is being written to:\s*(.+?\.output)\b/;
  const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);
  // tools that read a background task's state; their result may say it ended ("<status>completed</status>", "Status: …")
  const BG_READ_TOOLS = new Set(['BashOutput', 'TaskOutput']);
  const BG_READ_END_RE = /<status>\s*(completed|failed|killed|stopped|exited)\s*<\/status>|^\s*status:\s*(completed|failed|killed|stopped|exited)\b/im;
  // An end notice that arrived before the task's start (PROGRESS 50): when a foreground command is moved to the
  // background just as it finishes, the transcript has the <task-notification> line BEFORE the tool_result that names
  // the task; the start then must not leave it "running" forever. taskId / toolUseId -> { status, at }
  const MAX_BG_ENDED = 100;
  function rememberEnd(s, keys, status, at) {
    if (!s.bgEnded) s.bgEnded = new Map();
    for (const k of keys) if (k) s.bgEnded.set(String(k), { status, at });
    while (s.bgEnded.size > MAX_BG_ENDED) s.bgEnded.delete(s.bgEnded.keys().next().value);
  }

  const Pricing = (typeof window !== 'undefined' && window.Pricing) ||
    (typeof require === 'function' ? require('./pricing.js') : null);

  // ------------------------------------------------------------------ state
  function newStats() {
    return {
      v: 2,
      // usage (deduped by msgId)
      msgs: new Map(), // msgId -> { input, output, read, create, cost, model }
      lastMsgId: null,
      input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: 0,
      maxContext: 0,
      model: '',
      prompts: 0, turnEnds: 0,
      // tool calls
      tools: [], toolTotal: 0, toolIdx: new Map(), errors: 0, autoYes: 0,
      // tasks
      taskMode: null, // 'todo' | 'task'
      todos: [], // [{ content, status, activeForm }]
      tasks: new Map(), // id -> { id, subject, activeForm, status }
      pendingTasks: new Map(), // toolUseId -> { subject, activeForm }
      // subagents
      agents: new Map(), // agentId -> latest snapshot
      agentCalls: new Map(), // toolUseId -> { toolUseId, agentType, description, startedAt, result }
      // Agent Teams: { name, members:[{agentId,name,agentType,color,model,joinedAt}], removed } | null
      team: null,
      memberState: new Map(), // teammate name -> { type, summary, at } from <teammate-message>
      // names that were team members and have left the team's config (shut down / stopped): their subagent
      // snapshot never gets a final status, so it would stay 'running' (and hold the backlog) forever
      formerMembers: new Set(),
      // background commands (Bash run_in_background / moved to the background, Monitor): taskId -> { toolUseId,
      // startedAt, endedAt, status }. Ended by the <task-notification> (transcript event task_notification) or TaskStop.
      bg: new Map(),
      // shell tool calls still waiting for their result: toolUseId -> command text (the bg entry takes it over)
      bgCmd: new Map(),
      // changed files
      files: new Map(), // key -> { abs, count, edits: [], lastTs }
      editIdx: new Map(), // toolUseId -> [edit objects]
    };
  }

  const toMs = (v) => {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v;
    const n = Date.parse(v);
    return Number.isNaN(n) ? 0 : n;
  };
  const cap = (s, n = MAX_EDIT_CHARS) => {
    s = s == null ? '' : String(s);
    return s.length > n ? s.slice(0, n) + `\n… (${(s.length - n).toLocaleString()} 文字省略)` : s;
  };
  function timeStr(ts) {
    const d = ts ? new Date(toMs(ts) || Date.now()) : new Date();
    return d.toLocaleTimeString('ja-JP', { hour12: false });
  }

  function summarizeInput(input) {
    if (!input) return '';
    const v = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ??
      input.query ?? input.description ?? input.subject ?? (input.taskId != null ? `#${input.taskId} → ${input.status || ''}` : null) ??
      JSON.stringify(input);
    return String(v).slice(0, 200);
  }

  const isAbs = (p) => /^([A-Za-z]:[\\/]|[\\/])/.test(p);
  const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  function absPath(p, cwd) {
    if (!p || isAbs(p) || !cwd) return p;
    const sep = cwd.includes('\\') ? '\\' : '/';
    return cwd.replace(/[\\/]+$/, '') + sep + p.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep);
  }
  function relPath(abs, cwd) {
    if (!cwd || !abs) return abs || '';
    const a = normPath(abs);
    const c = normPath(cwd);
    if (a.toLowerCase().startsWith(c.toLowerCase() + '/')) return a.slice(c.length + 1);
    return abs;
  }
  const fileKey = (abs) => normPath(abs).toLowerCase();

  function usageRecord(model, u) {
    const create = u.cache_creation_input_tokens || 0;
    return {
      model,
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      read: u.cache_read_input_tokens || 0,
      create,
      cost: Pricing ? Pricing.cost(model, u) : 0,
    };
  }
  function addRec(s, r, sign) {
    s.input += sign * r.input;
    s.output += sign * r.output;
    s.cacheRead += sign * r.read;
    s.cacheCreate += sign * r.create;
    s.costUsd += sign * r.cost;
  }

  function recordEdit(s, evt, cwd) {
    const inp = evt.input || {};
    const rawPath = inp.file_path || inp.notebook_path;
    if (!rawPath) return;
    const abs = absPath(String(rawPath), cwd);
    const key = fileKey(abs);
    let f = s.files.get(key);
    if (!f) {
      f = { abs, count: 0, edits: [], lastTs: 0 };
      s.files.set(key, f);
    }
    f.count += 1;
    f.lastTs = toMs(evt.ts) || Date.now();
    const base = { ts: evt.ts, toolUseId: evt.toolUseId, failed: false };
    const list = [];
    if (evt.name === 'Edit') list.push({ ...base, kind: 'edit', old: cap(inp.old_string), new: cap(inp.new_string) });
    else if (evt.name === 'Write') list.push({ ...base, kind: 'write', old: '', new: cap(inp.content) });
    else if (evt.name === 'MultiEdit') {
      for (const e of inp.edits || []) list.push({ ...base, kind: 'edit', old: cap(e.old_string), new: cap(e.new_string) });
    } else if (evt.name === 'NotebookEdit') {
      list.push({ ...base, kind: 'notebook', old: '', new: cap(inp.new_source), note: [inp.edit_mode, inp.cell_id].filter(Boolean).join(' ') });
    }
    f.edits.push(...list);
    if (f.edits.length > MAX_EDITS_PER_FILE) f.edits.splice(0, f.edits.length - MAX_EDITS_PER_FILE);
    if (evt.toolUseId) s.editIdx.set(evt.toolUseId, list);
  }

  function setTaskFromUpdate(s, inp) {
    const id = String(inp.taskId);
    if (inp.status === 'deleted') {
      s.tasks.delete(id);
      return;
    }
    let t = s.tasks.get(id);
    if (!t) {
      t = { id, subject: `Task #${id}`, activeForm: '', status: 'pending' };
      s.tasks.set(id, t);
    }
    if (inp.status) t.status = inp.status;
    if (inp.subject) t.subject = inp.subject;
    if (inp.activeForm) t.activeForm = inp.activeForm;
  }

  // Applies one assist event to a stats object. `cwd` resolves relative file paths.
  function applyEvent(s, evt, cwd) {
    if (!s || !evt) return;
    switch (evt.kind) {
      case 'usage': {
        const u = evt.usage || {};
        const id = evt.msgId || `anon-${evt.ts || Math.random()}`;
        const model = evt.model && evt.model !== '<synthetic>' ? evt.model : '';
        const prev = s.msgs.get(id);
        if (prev) addRec(s, prev, -1);
        const rec = usageRecord(model || (prev && prev.model) || s.model, u);
        addRec(s, rec, 1);
        s.msgs.set(id, rec);
        // synthetic / empty messages (e.g. API errors, interrupted turns) must not reset the context gauge
        if (!prev && evt.model !== '<synthetic>' && rec.input + rec.read + rec.create > 0) s.lastMsgId = id;
        if (model) s.model = model;
        if (id === s.lastMsgId) {
          const ctx = rec.input + rec.read + rec.create;
          if (ctx > s.maxContext) s.maxContext = ctx;
        }
        break;
      }
      case 'prompt':
        s.prompts += 1;
        break;
      case 'turn_end':
        s.turnEnds += 1;
        break;
      case 'tool_use': {
        const name = evt.name || '?';
        const inp = evt.input || {};
        s.toolTotal += 1;
        const entry = { name, arg: summarizeInput(inp), time: timeStr(evt.ts), id: evt.toolUseId || null, error: null, open: false };
        s.tools.unshift(entry);
        if (entry.id) s.toolIdx.set(entry.id, entry);
        while (s.tools.length > MAX_TOOLS) {
          const old = s.tools.pop();
          if (old.id) s.toolIdx.delete(old.id);
        }
        if (SHELL_TOOLS.has(name) && evt.toolUseId) {
          if (!s.bgCmd) s.bgCmd = new Map();
          // 600: main's waits.js reads the redirect target / timeout from it (often past the first 300 chars of a loop)
          const cmd = String(inp.command ?? inp.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
          s.bgCmd.set(evt.toolUseId, cmd);
          while (s.bgCmd.size > 50) s.bgCmd.delete(s.bgCmd.keys().next().value);
        }
        if (BG_READ_TOOLS.has(name) && evt.toolUseId) {
          if (!s.bgRead) s.bgRead = new Map();
          s.bgRead.set(evt.toolUseId, String(inp.task_id ?? inp.bash_id ?? inp.shell_id ?? inp.id ?? ''));
          while (s.bgRead.size > 50) s.bgRead.delete(s.bgRead.keys().next().value);
        }
        if (name === 'TodoWrite' && Array.isArray(inp.todos)) {
          s.taskMode = 'todo';
          s.todos = inp.todos.map((t) => ({ content: String(t.content ?? ''), status: t.status || 'pending', activeForm: t.activeForm || '' }));
        } else if (name === 'TaskCreate') {
          s.taskMode = 'task';
          if (evt.toolUseId) s.pendingTasks.set(evt.toolUseId, { subject: String(inp.subject ?? ''), activeForm: inp.activeForm || '' });
        } else if (name === 'TaskUpdate' && inp.taskId != null) {
          s.taskMode = 'task';
          setTaskFromUpdate(s, inp);
        } else if (AGENT_TOOLS.has(name) && (inp.subagent_type || inp.prompt || inp.description) && evt.toolUseId) {
          s.agentCalls.set(evt.toolUseId, {
            toolUseId: evt.toolUseId,
            name: typeof inp.name === 'string' ? inp.name : '', // teammate name (Agent Teams)
            agentType: inp.subagent_type || 'general-purpose',
            description: String(inp.description || ''),
            background: !!inp.run_in_background,
            startedAt: toMs(evt.ts) || Date.now(),
            result: null,
          });
        } else if (EDIT_TOOLS.has(name)) {
          recordEdit(s, evt, cwd);
        } else if (STOP_TOOLS.has(name)) {
          const t = s.bg.get(String(inp.task_id ?? inp.shell_id ?? inp.id ?? ''));
          if (t && t.status === 'running') {
            t.status = 'stopped';
            t.endedAt = toMs(evt.ts) || Date.now();
          }
        }
        break;
      }
      case 'tool_result': {
        const id = evt.toolUseId;
        if (evt.isError) {
          s.errors += 1;
          const entry = id && s.toolIdx.get(id);
          if (entry) entry.error = evt.text || '(error)';
          const edits = id && s.editIdx.get(id);
          if (edits) for (const e of edits) e.failed = true;
        }
        // Only needed until this result marks the edits failed; kept, it held every edit's text for the tab's life.
        if (id) s.editIdx.delete(id);
        if (id && s.pendingTasks.has(id)) {
          const p = s.pendingTasks.get(id);
          s.pendingTasks.delete(id);
          let taskId = evt.taskId;
          if (taskId == null) {
            const m = /Task #(\w+) created/.exec(evt.text || '');
            if (m) taskId = m[1];
          }
          if (!evt.isError && taskId != null) {
            const tid = String(taskId);
            const existing = s.tasks.get(tid);
            s.tasks.set(tid, { id: tid, subject: p.subject || `Task #${tid}`, activeForm: p.activeForm, status: existing ? existing.status : 'pending' });
          }
        }
        const command = id && s.bgCmd ? s.bgCmd.get(id) : undefined;
        if (id && s.bgCmd) s.bgCmd.delete(id);
        if (!evt.isError) {
          const bm = BG_START_RE.exec(evt.text || '');
          const bid = bm && (bm[1] || bm[2] || bm[3]);
          if (bid && !s.bg.has(bid)) {
            const om = BG_OUT_RE.exec(evt.output || evt.text || '');
            const ended = s.bgEnded && (s.bgEnded.get(bid) || (id && s.bgEnded.get(id)));
            s.bg.set(bid, {
              toolUseId: id || null,
              startedAt: toMs(evt.ts) || Date.now(),
              endedAt: ended ? ended.at : 0,
              status: ended ? ended.status : 'running',
              command: command || '',
              outFile: om ? om[1].trim() : '',
            });
            while (s.bg.size > MAX_BG) s.bg.delete(s.bg.keys().next().value);
          }
          // BashOutput / TaskOutput said the task ended (its notification may never come, or came before)
          const readOf = id && s.bgRead ? s.bgRead.get(id) : undefined;
          if (readOf !== undefined) {
            s.bgRead.delete(id);
            const em = BG_READ_END_RE.exec(evt.output || evt.text || '');
            const t = readOf && s.bg.get(readOf);
            if (em && t && t.status === 'running') {
              t.status = (em[1] || em[2]).toLowerCase();
              t.endedAt = toMs(evt.ts) || Date.now();
            }
          }
        }
        const call = id && s.agentCalls.get(id);
        // Background agents / Agent Teams teammates return at once ("Async agent launched…",
        // "Spawned successfully…"): that is a launch, not completion.
        const launched = /^(Async agent launched|Spawned successfully)/.test(evt.text || '');
        if (call && !call.result && (evt.isError || !launched)) {
          call.result = evt.isError ? 'error' : 'done';
          call.endedAt = toMs(evt.ts) || Date.now();
        }
        break;
      }
      case 'task_notification': {
        // a background task (command / Monitor / agent) ended; Monitor events in between are not ends
        const st = String(evt.status || '');
        if (/^(running|progress|event|update|started)$/i.test(st)) break;
        let t = evt.taskId && s.bg.get(String(evt.taskId));
        if (!t && evt.toolUseId) for (const x of s.bg.values()) if (x.toolUseId === evt.toolUseId) t = x;
        if (t && t.status === 'running') {
          t.status = st || 'completed';
          t.endedAt = toMs(evt.ts) || Date.now();
        } else if (!t) rememberEnd(s, [evt.taskId, evt.toolUseId], st || 'completed', toMs(evt.ts) || Date.now()); // its start comes later
        break;
      }
      case 'teammate':
        // idle_notification = the teammate finished its current work and waits for messages.
        if (evt.name) s.memberState.set(evt.name, { type: evt.msgType || 'message', summary: evt.summary || '', at: toMs(evt.ts) || Date.now() });
        break;
      case 'subagent':
        if (evt.agentId) s.agents.set(evt.agentId, { ...evt });
        break;
      case 'team':
        if (evt.removed) {
          if (s.team) s.team = { ...s.team, removed: true };
        } else {
          const members = Array.isArray(evt.members) ? evt.members : [];
          const now = new Set(members.map((m) => m && m.name).filter(Boolean));
          if (s.team && s.team.name === evt.team) for (const m of s.team.members) if (m && m.name && !now.has(m.name)) s.formerMembers.add(m.name);
          for (const n of now) s.formerMembers.delete(n); // (re)joined
          s.team = { name: evt.team, members, removed: false };
        }
        break;
      default:
        break;
    }
  }

  function addLocalTo(s, { name, arg } = {}) {
    if (name === 'Auto-yes') s.autoYes += 1;
    s.tools.unshift({ name: name || 'local', arg: String(arg ?? '').slice(0, 220), time: timeStr(), id: null, error: null, open: false, local: true });
    while (s.tools.length > MAX_TOOLS) {
      const old = s.tools.pop();
      if (old.id) s.toolIdx.delete(old.id);
    }
  }

  // ----------------------------------------------------------- derived view
  function taskList(s) {
    if (s.taskMode === 'task' || (!s.taskMode && s.tasks.size)) {
      return [...s.tasks.values()].map((t) => ({ id: t.id, text: t.subject, status: t.status, activeForm: t.activeForm }));
    }
    return s.todos.map((t) => ({ text: t.content, status: t.status, activeForm: t.activeForm }));
  }

  function agentList(s, now = Date.now()) {
    const seen = new Set();
    const out = [];
    for (const a of s.agents.values()) {
      if (a.toolUseId) seen.add(a.toolUseId);
      const call = a.toolUseId && s.agentCalls.get(a.toolUseId);
      const startedAt = toMs(a.startedAt) || (call && call.startedAt) || 0;
      const name = (call && call.name) || teammateName(a.agentId);
      let status = a.status || 'running';
      if (status === 'running' && name && s.formerMembers && s.formerMembers.has(name)) status = 'done'; // left the team
      const end = status === 'running' ? now : toMs(a.updatedAt) || now;
      out.push({
        agentId: a.agentId,
        name,
        toolUseId: a.toolUseId,
        agentType: a.agentType || (call && call.agentType) || 'agent',
        description: a.description || (call && call.description) || '',
        status,
        toolCount: a.toolCount || 0,
        lastTool: a.lastTool || null,
        tokens: a.tokens || 0,
        startedAt,
        updatedAt: toMs(a.updatedAt) || 0, // its last transcript line (renderer liveAgents: stale after 作業完了, PROGRESS 46)
        elapsedMs: startedAt ? Math.max(0, end - startedAt) : 0,
      });
    }
    for (const c of s.agentCalls.values()) {
      if (seen.has(c.toolUseId)) continue;
      const status = c.result || 'starting';
      const end = c.result ? c.endedAt || now : now;
      out.push({
        agentId: null, name: c.name || '', toolUseId: c.toolUseId, agentType: c.agentType, description: c.description,
        status, toolCount: 0, lastTool: null, tokens: 0, startedAt: c.startedAt,
        elapsedMs: Math.max(0, end - c.startedAt),
      });
    }
    const rank = { running: 0, starting: 1, error: 2, done: 3 };
    out.sort((a, b) => (rank[a.status] ?? 4) - (rank[b.status] ?? 4) || b.startedAt - a.startedAt);
    return out;
  }

  // In-process teammates are stored as subagents named "a<name>-<hash>" (verified on 2.1.316).
  function teammateName(agentId) {
    const m = /^a(.+)-[0-9a-f]{8,}$/.exec(agentId || '');
    return m ? m[1] : '';
  }

  // Team members joined with their subagent activity (status, last tool, elapsed).
  function teamView(s, agents = agentList(s)) {
    if (!s.team) return null;
    const members = s.team.members.map((m) => {
      const a = agents.find((x) => x.name && x.name === m.name);
      const ms = s.memberState && s.memberState.get(m.name);
      let status = a ? a.status : 'starting';
      // Teammates go idle (not done) after each piece of work; newer activity flips them back to running.
      const snap = a && a.agentId ? s.agents.get(a.agentId) : null;
      const lastActivity = snap ? toMs(snap.updatedAt) : 0;
      if (ms && /idle/.test(ms.type) && ms.at >= lastActivity - 500) status = 'idle';
      if (ms && /shutdown|terminated|stopped/.test(ms.type)) status = 'done';
      if (s.team.removed) status = status === 'error' ? 'error' : 'done';
      return {
        name: m.name,
        agentId: (a && a.agentId) || null, // subagent transcript id (a<name>-<hex>); null until it has run
        color: m.color || '',
        agentType: m.agentType || (a && a.agentType) || '',
        model: m.model || '',
        status,
        summary: ms ? ms.summary : '',
        description: a ? a.description : '',
        toolCount: a ? a.toolCount : 0,
        tokens: a ? a.tokens : 0,
        lastTool: a ? a.lastTool : null,
        startedAt: a ? a.startedAt : toMs(m.joinedAt),
        updatedAt: a ? a.updatedAt || 0 : 0,
        elapsedMs: a ? a.elapsedMs : 0,
      };
    });
    return { name: s.team.name, removed: !!s.team.removed, members };
  }

  function computeView(s) {
    const last = s.lastMsgId ? s.msgs.get(s.lastMsgId) : null;
    const contextTokens = last ? last.input + last.read + last.create : 0;
    const window1m = s.maxContext > CTX_DEFAULT || /\[1m\]/i.test(s.model);
    const contextWindow = window1m ? CTX_LARGE : CTX_DEFAULT;
    const contextPct = contextWindow ? Math.min(100, (contextTokens / contextWindow) * 100) : 0;
    const promptTotal = s.input + s.cacheRead + s.cacheCreate;
    return {
      messages: s.msgs.size,
      turns: s.prompts || s.turnEnds || 0,
      contextTokens,
      contextWindow,
      contextPct,
      cacheHitPct: promptTotal ? (s.cacheRead / promptTotal) * 100 : 0,
      costUsd: Math.max(0, s.costUsd),
    };
  }

  function summaryOf(tab) {
    const s = tab && tab.stats;
    if (!s || s.v !== 2) return { model: '', contextTokens: 0, contextPct: 0, costUsd: 0, todos: [], subagents: [], team: null, errors: 0, bg: [], cmds: [] };
    const v = computeView(s);
    const agents = agentList(s);
    const team = teamView(s, agents);
    const memberNames = new Set(team ? team.members.map((m) => m.name) : []);
    return {
      model: s.model,
      contextTokens: v.contextTokens,
      contextPct: Math.round(v.contextPct * 10) / 10,
      costUsd: Math.round(v.costUsd * 10000) / 10000,
      todos: taskList(s).map((t) => ({ text: t.status === 'in_progress' && t.activeForm ? t.activeForm : t.text, status: t.status })),
      subagents: agents.filter((a) => !memberNames.has(a.name)).map((a) => ({
        agentType: a.agentType,
        description: a.description,
        status: a.status === 'starting' ? 'running' : a.status,
        lastTool: a.lastTool ? { name: a.lastTool.name, arg: String(a.lastTool.arg ?? '').slice(0, 80) } : null,
        updatedAt: a.updatedAt || 0,
      })),
      team: team && {
        name: team.name,
        removed: team.removed,
        members: team.members.map((m) => ({
          name: m.name,
          color: m.color,
          agentType: m.agentType,
          status: m.status,
          summary: m.summary ? String(m.summary).slice(0, 160) : '',
          lastTool: m.lastTool ? { name: m.lastTool.name, arg: String(m.lastTool.arg ?? '').slice(0, 80) } : null,
          updatedAt: m.updatedAt || 0,
        })),
      },
      errors: s.errors,
      // background tasks still running: [{ id, startedAt, command, outFile }] (the backlog does not count those older than
      // its item; main's waits.js shows what an idle session waits for and watches the output file)
      bg: [...(s.bg || new Map())]
        .filter(([, t]) => t.status === 'running')
        .slice(-10)
        .map(([id, t]) => ({ id, startedAt: t.startedAt, command: t.command || '', outFile: t.outFile || '' })),
      // 関係図 (agents-view.js, 依頼-481): the background commands as boxes — running ones and those that ended in the last
      // CMD_RECENT_MS, newest 8: [{ id, command, startedAt, endedAt, status }] (from the transcript only; no process list)
      cmds: [...(s.bg || new Map())]
        .filter(([, t]) => t.status === 'running' || (t.endedAt && Date.now() - t.endedAt < CMD_RECENT_MS))
        .slice(-8)
        .map(([id, t]) => ({ id, command: String(t.command || '').slice(0, 300), startedAt: t.startedAt || 0, endedAt: t.endedAt || 0, status: t.status || 'running' })),
    };
  }

  // ------------------------------------------------------------- formatting
  const fmt = (n) => Math.round(n || 0).toLocaleString();
  function fmtK(n) {
    n = n || 0;
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
    return String(Math.round(n));
  }
  function fmtCost(usd) {
    if (usd < 0.01) return usd > 0 ? '< $0.01' : '$0.00';
    return `$${usd.toFixed(usd >= 100 ? 0 : 2)}`;
  }
  function fmtElapsed(ms) {
    const sec = Math.floor((ms || 0) / 1000);
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m ${String(sec % 60).padStart(2, '0')}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  }

  const pure = { newStats, applyEvent, addLocalTo, computeView, taskList, agentList, teamView, teammateName, summaryOf, relPath, absPath, fmtK, fmtCost, fmtElapsed };

  // Node (tests): export the pure part only.
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) module.exports = pure;
    return;
  }

  // =================================================================== DOM
  // Two ways to show the panel (UX15: one section, 「この作業」):
  //  - Sections (Panel.SECTIONS): core gives the container (a dock panel) via Panel.attach(id, el).
  //  - Legacy: the same in #panel (no dock).
  // Visual rule (see conversation.css header): no cards. Plain rows, spacing / hairlines, coloured text and
  // small glyphs for status, a thin left rule only for nested detail.
  const STATUS_LABEL = { starting: '起動中', running: '実行中', asking: '入力待ち', idle: '待機中', exited: '終了' };
  const AGENT_STATUS_LABEL = { starting: '開始中', running: '実行中', idle: '待機中', done: '完了', error: 'エラー' };
  const SECTIONS = [{ id: 'work', title: 'この作業' }];
  const SECTION_IDS = new Set(SECTIONS.map((x) => x.id));
  const LEGACY = '#panel';
  const hosts = new Map(); // section id -> container element (Panel.attach)
  const dirty = new Set(); // LEGACY and / or section ids waiting for a render
  let panelEl = null;
  let currentTab;
  let rafPending = false;
  let retryTimer = 0;

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }
  function icon(svg, cls) {
    const span = h('span', cls || 'pn-ico');
    span.innerHTML = svg; // static markup only
    return span;
  }
  const ICONS = {
    check: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.3 5 8.7 9.5 3.6"/></svg>',
    cross: '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l6 6M9 3 3 9"/></svg>',
    file: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M4 1.75h5l3 3v9.5H4z"/><path d="M9 1.75v3h3"/></svg>',
  };
  const isLive = (st) => st === 'running' || st === 'starting';
  const emptyLine = (text) => h('div', 'pn-empty-line', text);

  // Small status glyph shared by subagents and team members.
  function statusGlyph(status) {
    const st = h('span', 'pn-astat');
    st.title = AGENT_STATUS_LABEL[status] || status;
    if (status === 'running') st.append(h('span', 'pn-spin'));
    else if (status === 'starting') st.append(h('span', 'pn-ring'));
    else if (status === 'idle') st.append(h('span', 'pn-idle-ic'));
    else if (status === 'done') st.append(icon(ICONS.check));
    else st.append(icon(ICONS.cross));
    return st;
  }
  // ---- derived model shared by all sections and badges
  function modelOf(tab) {
    const s = tab.stats && tab.stats.v === 2 ? tab.stats : (tab.stats = newStats());
    const v = computeView(s);
    const tasks = taskList(s);
    const allAgents = agentList(s);
    const team = teamView(s, allAgents);
    const memberNames = new Set(team ? team.members.map((m) => m.name) : []);
    const agents = allAgents.filter((a) => !memberNames.has(a.name));
    return { tab, s, v, tasks, team, agents };
  }

  function badgesOf() {
    const out = {};
    for (const sec of SECTIONS) out[sec.id] = { badge: '', cls: '', empty: false };
    return out;
  }

  // ---- この作業 (UX15, docs/ux15-check.md, docs/ux-journey.md §5.3): the one column of the workbench and of the main
  // window's session view. workData() makes plain data (JSON-safe: main relays it to the main window while it views
  // the session, src/main/oneview.js), renderWork() draws it in either window. The former tabs タスク / エージェント /
  // ツール are in the conversation itself; 再起動 / 引き継ぐ have their one door at the bottom.
  // ext = the core's part (renderer.js Panel.setInfo(fn), fn(tab) ->):
  //   { item: { id, no, title, text } | null, by: 'ルーター' | 'あなた' | '', startedAt, lastMoveAt, after: { short, full } | null,
  //     next: [{ no, title, why }], auto: boolean | null, autoWhy, busy: [string] }
  let infoOf = null;
  const WORK_FILES_RELAYED = 30;
  function workData(tab, m, ext) {
    const { s, v, team } = m;
    const e = ext || (infoOf ? infoOf(tab) || {} : {});
    const H = window.Handoff;
    const hoText = H ? H.statusText(tab) || '' : '';
    const files = [...s.files.values()].sort((a, b) => b.lastTs - a.lastTs);
    return {
      tabId: tab.id || '',
      label: tab.label || '',
      cwd: tab.cwd || '',
      status: tab.status || '',
      exited: !!tab.exited,
      rest: tab.rest || null,
      handedOff: !!tab.handedOff,
      item: e.item || null,
      by: e.by || '',
      startedAt: e.startedAt || 0,
      lastMoveAt: e.lastMoveAt || 0,
      after: e.after || null,
      next: Array.isArray(e.next) ? e.next.slice(0, 5) : [],
      auto: typeof e.auto === 'boolean' ? e.auto : null,
      autoWhy: e.autoWhy || '',
      busy: Array.isArray(e.busy) ? e.busy : [],
      files: files.slice(0, WORK_FILES_RELAYED).map((f) => ({ abs: f.abs, rel: relPath(f.abs, tab.cwd), count: f.count })),
      filesTotal: files.length,
      team: team ? { name: team.name || '', removed: !!team.removed, members: team.members.map((x) => ({ name: x.name, status: x.status, agentId: x.agentId || null })) } : null,
      ctxPct: v.messages ? Math.round(v.contextPct) : null,
      memMb: tab.exited || tab.rest || tab.memMb == null ? null : Math.round(tab.memMb),
      memMark: (H && H.settings().memMb) || 800,
      handoffText: hoText,
      canHandoff: !!(H && !tab.exited && !tab.handedOff && !tab.rest && !/中|待って|起動/.test(hoText)),
      model: s.model || '',
      costUsd: v.messages ? v.costUsd : null,
      turns: v.turns || 0,
    };
  }

  const R = () => (typeof window !== 'undefined' && window.Reassure) || null;
  const LW = (k, d) => (window.Labels && window.Labels.WORDS && window.Labels.WORDS[k]) || d; // labels.js (docs/ui-copy.md)
  const agoText = (at) => (R() ? R().ago(at) : timeStr(at));
  const clockText = (at) => (R() ? R().clock(at) : timeStr(at));
  const memText = (mb) => (mb >= 1000 ? `${(mb / 1024).toFixed(1)}GB` : `${Math.round(mb)}MB`);
  function stateWord(d) {
    if (d.rest === 'done') return '完了（claude は止めています）';
    if (d.rest) return '休止中';
    if (d.exited) return '終了';
    if (d.handedOff) return '引き継ぎ済み';
    return STATUS_LABEL[d.status] || d.status || '—';
  }

  // o: { act(op, arg), files?: Node (the workbench's own list: the diff dialog and プレビュー), usage: id prefix }
  function renderWork(d, o = {}) {
    const box = h('div', 'wk');
    const pre = o.usage || 'session.panel';
    const act = (op, arg) => o.act && o.act(op, arg);
    const row = (k, label, v, cls) => {
      const r = h('div', `wk-row${cls ? ' ' + cls : ''}`);
      r.dataset.k = k;
      r.append(h('span', 'wk-k', label));
      const val = h('div', 'wk-v');
      if (v instanceof Node) val.append(v);
      else val.textContent = v;
      r.append(val);
      box.append(r);
      return r;
    };
    // 依頼
    if (d.item) {
      const v = h('div', 'wk-item');
      if (d.item.no) v.append(h('span', 'wk-no', d.item.no), document.createTextNode(' '));
      v.append(document.createTextNode(d.item.title || ''));
      v.title = d.item.text || '';
      row('item', '依頼', v);
    } else row('item', '依頼', 'なし（このセッションで直接）', 'dim');
    // 始めた人と時刻
    if (d.by || d.startedAt) row('by', '始めた', [d.by, d.startedAt ? clockText(d.startedAt) : ''].filter(Boolean).join(' · '));
    // 状態と最後の動き
    const st = h('div', 'wk-state');
    st.append(h('span', `wk-st st-${d.rest ? 'rest' : d.exited ? 'exited' : d.status}`, stateWord(d)));
    if (d.lastMoveAt) {
      st.append(document.createTextNode(' · 最後の動き '));
      const a = h('span', 'wk-ago', agoText(d.lastMoveAt));
      a.dataset.at = String(d.lastMoveAt);
      a.title = clockText(d.lastMoveAt);
      st.append(a);
    }
    row('state', '状態', st);
    // この後に起きること
    if (d.after) row('after', 'この後', d.after.short).title = d.after.full || d.after.short;
    // 次（このセッションの待ち・この作業を前提に待つもの）
    if (d.next.length) {
      const ul = h('ul', 'wk-next');
      for (const n of d.next) {
        const li = h('li', null);
        if (n.no) li.append(h('span', 'wk-no', n.no), document.createTextNode(' '));
        li.append(document.createTextNode(n.title || ''));
        if (n.why) li.append(h('span', 'wk-why', ` · ${n.why}`));
        ul.append(li);
      }
      row('next', '次', ul);
    } else row('next', '次', 'なし', 'dim');
    // 一通り終わったら自動で送る (was the backlog panel's switch)
    if (d.auto !== null) {
      const lab = h('label', 'wk-auto');
      const c = h('input');
      c.type = 'checkbox';
      c.checked = d.auto;
      c.dataset.usage = `${pre}.auto`;
      c.addEventListener('change', () => act('auto', c.checked));
      lab.append(c, document.createTextNode(` ${LW('autoSend', '一通り終わったら自動で送る')}`));
      const v = h('div', null);
      v.append(lab);
      if (d.autoWhy) v.append(h('div', 'wk-why', d.autoWhy));
      row('auto', '待ち', v).title = 'このセッションの待ちの項目を、手が空いたら順に送ります（外すと送りません）';
    }
    // 変えたファイル
    if (d.filesTotal) {
      let list = o.files || null;
      if (!list) {
        list = h('ul', 'wk-files');
        for (const f of d.files) {
          const parts = normPath(f.rel).split('/');
          const base = parts.pop();
          const li = h('li', 'wk-file');
          li.tabIndex = 0;
          li.title = `${f.abs}\nクリックで開く（差分は作業台の「この作業」で見られます）`;
          li.append(h('span', 'pn-fbase', base), h('span', 'pn-fdir', parts.join('/')), h('span', 'pn-fcount', `×${f.count}`));
          li.addEventListener('click', () => act('file', f.abs));
          ul2key(li, () => act('file', f.abs));
          list.append(li);
        }
        if (d.filesTotal > d.files.length) list.append(h('li', 'wk-why', `ほか ${d.filesTotal - d.files.length} 件（作業台で見られます）`));
      }
      row('files', `変えたファイル ${d.filesTotal}`, list, 'wk-block');
    } else row('files', '変えたファイル', 'まだありません', 'dim');
    // チーム
    if (d.team) {
      const live = d.team.members.filter((x) => isLive(x.status)).length;
      const v = h('div', null);
      v.append(document.createTextNode(`${d.team.name || 'チーム'}${d.team.removed ? '（片付け済み）' : ''} · ${d.team.members.length} 人${live ? `（${live} 実行中）` : ''}`));
      const ul = h('ul', 'wk-members');
      for (const mbr of d.team.members) {
        const li = h('li', `a-${mbr.status}`);
        li.append(statusGlyph(mbr.status), document.createTextNode(` @${mbr.name}`));
        if (mbr.agentId && o.member) {
          li.classList.add('pn-clickable');
          li.title = `クリックで @${mbr.name} の会話を表示`;
          li.addEventListener('click', () => o.member(mbr));
        }
        ul.append(li);
      }
      v.append(ul);
      row('team', 'チーム', v);
    }
    // 重さ（文脈・メモリ）
    const heavy = d.memMb != null && d.memMb >= d.memMark;
    const ctxLevel = d.ctxPct == null ? '' : d.ctxPct > 85 ? 'danger' : d.ctxPct > 70 ? 'warn' : '';
    const wv = h('div', 'wk-weight');
    const parts = [];
    if (d.ctxPct != null) parts.push(h('span', `wk-ctx${ctxLevel ? ' ' + ctxLevel : ''}`, `文脈 ${d.ctxPct}%`));
    if (d.memMb != null) {
      const mm = h('span', `wk-mem${heavy ? ' heavy' : ''}`, `メモリ ${memText(d.memMb)}`);
      mm.title = heavy ? `目安の ${d.memMark}MB を超えています。下の「再起動」で同じ会話のまま軽くなります` : 'このセッションの claude とその子プロセスのメモリ（約 1 分ごとに更新）';
      parts.push(mm);
    }
    parts.forEach((p, i) => wv.append(...(i ? [document.createTextNode(' · '), p] : [p])));
    if (!parts.length) wv.textContent = 'まだ分かりません';
    if (d.costUsd != null) {
      const c = h('div', 'wk-why', `≈ ${fmtCost(d.costUsd)} · ${fmt(d.turns)} ターン${d.model ? ` · ${d.model}` : ''}`);
      c.title = 'API 定価での概算（pricing.js）。サブスクリプション利用時の実請求とは異なります。';
      wv.append(c);
    }
    if (d.handoffText) wv.append(h('div', 'wk-why', d.handoffText));
    else if (ctxLevel === 'danger') wv.append(h('div', 'wk-why', '文脈が残りわずかです — 下の「引き継ぐ」で新しいセッションへ'));
    row('weight', '重さ', wv, heavy || ctxLevel ? 'warn' : '');
    // the one door for 再起動 / 引き継ぐ (§5.4 まとめる) and フォルダを開く
    const bar = h('div', 'wk-acts');
    const btn = (op, label, title, extra = '') => {
      const b = h('button', `wk-act wk-${op}${extra}`, label);
      b.type = 'button';
      b.dataset.op = op;
      b.dataset.usage = `${pre}.${op}`;
      b.title = title;
      b.addEventListener('click', () => act(op));
      bar.append(b);
      return b;
    };
    if (!d.handedOff) {
      const resume = d.exited || d.rest;
      const busy = d.busy.length ? `\n\nいま: ${d.busy.join('、')}` : '';
      btn('restart', resume ? LW('resume', '再開') : LW('restart', '再起動'), resume ? '同じ会話のまま claude を起動します（--resume）' : `同じ会話のまま claude を起動し直して、メモリを空けます${busy}`, heavy ? ' primary' : '');
    }
    if (d.canHandoff) btn('handoff', LW('handoff', '引き継ぐ'), 'このセッションに引き継ぎメモを書かせ、同じフォルダの新しいセッションで続きを始めます（古いタブは終了済みとして残ります）', ctxLevel === 'danger' ? ' primary' : '');
    if (d.cwd) btn('folder', LW('openFolder', 'フォルダを開く'), `${d.cwd}\nFinder / エクスプローラーで開きます`);
    box.append(bar);
    return box;
  }
  function ul2key(el, fn) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') fn();
    });
  }

  // the workbench's own actions (core listens for the document events; same as the earlier panel buttons)
  function ownAct(tab) {
    return (op, arg) => {
      const fire = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));
      if (op === 'restart') fire('bantodesk:restart', { tabId: tab.id });
      else if (op === 'handoff') fire('bantodesk:handoff', { tabId: tab.id });
      else if (op === 'folder') fire('bantodesk:open-folder', { tabId: tab.id, path: tab.cwd });
      else if (op === 'auto') fire('bantodesk:auto-send', { tabId: tab.id, on: !!arg });
    };
  }
  function workOf(m) {
    if (!m.w) m.w = workData(m.tab, m);
    return m.w;
  }
  function renderWorkFor(tab, m) {
    const d = workOf(m);
    return renderWork(d, {
      act: ownAct(tab),
      files: d.filesTotal ? renderFiles(tab, m.s) : null,
      member: (mbr) => document.dispatchEvent(new CustomEvent('bantodesk:open-member', { detail: { tabId: tab.id, agentId: mbr.agentId, name: mbr.name } })),
    });
  }

  // ---- changed files
  // UX7 (docs/mac-polish.md J3): the newest FILES_SHOWN, 「もっと見る」 adds FILES_SHOWN more (per tab, kept through redraws).
  // The tool list is already the last MAX_TOOLS (50) calls.
  const FILES_SHOWN = 100;
  const filesMore = new Map(); // tab id -> files shown past FILES_SHOWN
  function renderFiles(tab, s) {
    const ul = h('ul', 'pn-files');
    const all = [...s.files.values()].sort((a, b) => b.lastTs - a.lastTs);
    const tk = tab && tab.id;
    const files = all.slice(0, FILES_SHOWN + (filesMore.get(tk) || 0));
    for (const f of files) {
      const rel = relPath(f.abs, tab.cwd);
      const parts = normPath(rel).split('/');
      const base = parts.pop();
      const li = h('li', 'pn-file');
      li.tabIndex = 0;
      li.title = `${f.abs}\nクリックで差分を表示`;
      li.append(h('span', 'pn-fbase', base), h('span', 'pn-fdir', parts.length ? parts.join('/') : ''), h('span', 'pn-fcount', `×${f.count}`));
      const pv = previewButton(f.abs, tab, 'pn-fpreview');
      if (pv) li.append(pv);
      const open = () => openFileModal(tab, f);
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') open();
      });
      ul.append(li);
    }
    if (all.length > files.length) {
      const li = h('li', 'pn-file-more');
      const b = h('button', 'pn-more', `もっと見る（ほか ${all.length - files.length} 件）`);
      b.type = 'button';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        filesMore.set(tk, (filesMore.get(tk) || 0) + FILES_SHOWN);
        ul.replaceWith(renderFiles(tab, s));
      });
      li.append(b);
      ul.append(li);
    }
    return ul;
  }

  // 「プレビュー」: MD / HTML / images / PDF open in a viewer panel (roadmap 5b; core owns opening, CONTRACT.md "Viewer").
  // No button when viewer.js is not loaded.
  function previewButton(abs, tab, cls) {
    if (!abs || !(window.Viewer && window.Viewer.canOpen && window.Viewer.canOpen(abs))) return null;
    const b = h('button', cls, 'プレビュー');
    b.type = 'button';
    b.title = `${abs}
ビューアで開く（変更すると自動で読み直します）`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent('bantodesk:open-viewer', { detail: { path: abs, tabId: tab && tab.id } }));
    });
    b.addEventListener('keydown', (e) => e.stopPropagation());
    return b;
  }

  // Body of the one section (この作業).
  function buildSection(id, tab, m) {
    const view = h('div', `pn-view pn-v-${id}`);
    if (!tab) {
      view.append(emptyLine('セッションがありません'));
      return view;
    }
    view.append(renderWorkFor(tab, m || modelOf(tab)));
    return view;
  }
  // the legacy all-in-one #panel (no dock): the same column
  function buildLegacy(tab, model) {
    return buildSection('work', tab, model);
  }

  // ---- render loop
  function targetEl(key) {
    if (key === LEGACY) return (panelEl = panelEl || document.getElementById('panel'));
    return hosts.get(key) || null;
  }

  function selectionIn(el) {
    const sel = window.getSelection && window.getSelection();
    return !!(sel && !sel.isCollapsed && sel.anchorNode && el.contains(sel.anchorNode));
  }

  // A container that is not on screen: out of the document (the legacy #panel once the sections are docked, a closed
  // section) or in a dock group behind another tab (display: none). docs/perf.md 第 3 段: a tab switch rebuilt all 6
  // sections and the detached legacy panel (158 ms of the 358 ms); now only the shown ones at once, the hidden ones at
  // an idle moment (or when they are shown: Panel.shown).
  function offScreen(el) {
    return !el.isConnected || el.getClientRects().length === 0;
  }

  let idleId = 0;
  function flushHiddenSoon() {
    if (idleId) return;
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
    idleId = idle(
      () => {
        idleId = 0;
        flush(true);
      },
      { timeout: 2000 },
    );
  }

  // UX8 (docs/mac-polish.md J4, docs/ux-journey.md §5.5): while output streams, the flush used to rebuild every
  // container and read the next one's layout (getClientRects / scrollTop) right after writing the previous one, a
  // layout per container per frame. Now (1) a section is rebuilt only when what it shows changed (its signature), (2)
  // the flush reads every container first and writes after, the scroll positions last, and (3) nothing is drawn while
  // the user scrolls with the wheel (the panel follows SCROLL_QUIET_MS after the last wheel event, at most
  // SCROLL_MAX_DEFER_MS late).
  const sigs = new Map(); // container key -> signature of what it shows now
  function sectionSig(id, m) {
    if (!m) return 'none';
    if (id !== 'work') return null;
    const { tab, s } = m;
    let k = JSON.stringify(workOf(m));
    k += `|${tab.id}|${filesMore.get(tab.id) || 0}`;
    for (const [key, f] of s.files) k += `|${key}:${f.count}:${f.lastTs}`;
    return k;
  }
  let sigSeq = 0;
  function sigOf(key, m) {
    if (!m) return `none|${currentTab === undefined ? 'u' : 'n'}`;
    try {
      if (key !== LEGACY) return `${m.tab.id}|${sectionSig(key, m)}`;
      return m.tab.id + SECTIONS.map((x) => '|' + sectionSig(x.id, m)).join('');
    } catch {
      return `err|${++sigSeq}`; // cannot tell: draw it
    }
  }

  const SCROLL_QUIET_MS = 150;
  const SCROLL_MAX_DEFER_MS = 1000;
  let wheelAt = 0;
  let wheelSince = 0; // start of the current run of wheel events
  let scrollTimer = 0;
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener(
      'wheel',
      (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('.pn-host, #panel')) return; // scrolling the panel itself
        const now = performance.now();
        if (now - wheelAt > SCROLL_QUIET_MS) wheelSince = now;
        wheelAt = now;
      },
      { capture: true, passive: true },
    );
  }
  // ms to wait before drawing because the user scrolls; 0 = draw now
  function scrollWait() {
    const now = performance.now();
    if (now - wheelAt >= SCROLL_QUIET_MS || now - wheelSince >= SCROLL_MAX_DEFER_MS) return 0;
    return SCROLL_QUIET_MS - (now - wheelAt);
  }

  // (4) while events stream, the shown containers are drawn at most every FLUSH_GAP_MS. At once: another tab, a
  // container never drawn or empty, a section just brought to the front (Panel.shown).
  const FLUSH_GAP_MS = 1000;
  let flushedAt = 0;
  let flushedTab = null;
  const shownNow = new Set();
  function urgent() {
    if (currentTab !== flushedTab || shownNow.size) return true;
    for (const k of dirty) {
      const el = targetEl(k);
      if (el && (!sigs.has(k) || !el.firstChild)) return true;
    }
    return false;
  }
  function flush(all = false) {
    if (all !== true) rafPending = false;
    clearTimeout(retryTimer);
    const since = performance.now() - flushedAt;
    const wait = Math.max(scrollWait(), all !== true && since < FLUSH_GAP_MS && !urgent() ? FLUSH_GAP_MS - since : 0);
    if (wait > 0) {
      if (!scrollTimer) scrollTimer = setTimeout(() => {
        scrollTimer = 0;
        schedule();
      }, wait + 10);
      return;
    }
    let deferred = false;
    let hidden = false;
    // read: which containers to draw and where they are scrolled (layout reads, before any write)
    const jobs = [];
    for (const key of [...dirty]) {
      const el = targetEl(key);
      if (!el) {
        dirty.delete(key);
        continue;
      }
      if (!el.isConnected) continue; // stays dirty: drawn when it is attached / shown again
      if (all !== true && offScreen(el)) {
        hidden = true;
        continue;
      }
      if (selectionIn(el)) {
        // don't destroy a selection the user is making (e.g. copying the session id)
        deferred = true;
        continue;
      }
      jobs.push({ key, el, top: el.scrollTop });
    }
    if (jobs.length) {
      flushedAt = performance.now();
      flushedTab = currentTab;
    }
    shownNow.clear();
    // write: rebuild only the containers whose content changed, then put the scroll positions back
    let model; // one model per flush for every container (it was made again for each)
    const moved = [];
    for (const j of jobs) {
      dirty.delete(j.key);
      if (model === undefined) model = currentTab ? modelOf(currentTab) : null;
      const sig = sigOf(j.key, model);
      if (sig === sigs.get(j.key) && j.el.firstChild) continue;
      sigs.set(j.key, sig);
      j.el.replaceChildren(j.key === LEGACY ? buildLegacy(currentTab, model) : buildSection(j.key, currentTab, model));
      if (j.top) moved.push(j);
    }
    for (const j of moved) j.el.scrollTop = j.top;
    if (hidden) flushHiddenSoon();
    if (deferred) retryTimer = setTimeout(flush, 600);
  }

  // A section container came on screen (its dock tab was selected): draw it now if it still waits.
  function shown(id) {
    if (!dirty.has(id)) return;
    shownNow.add(id);
    schedule();
  }

  function schedule() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(flush);
  }

  function render(tab) {
    currentTab = tab;
    dirty.add(LEGACY);
    for (const id of hosts.keys()) dirty.add(id);
    schedule();
  }

  function attach(id, el) {
    if (!SECTION_IDS.has(id) || !el) return;
    const prev = hosts.get(id);
    if (prev && prev !== el) prev.classList.remove('pn-host', `pn-host-${id}`);
    el.classList.add('pn-host', `pn-host-${id}`);
    hosts.set(id, el);
    sigs.delete(id);
    dirty.add(id);
    schedule();
  }

  function detach(id) {
    const el = hosts.get(id);
    if (!el) return;
    el.classList.remove('pn-host', `pn-host-${id}`);
    hosts.delete(id);
    dirty.delete(id);
  }

  function badges(tab) {
    return badgesOf(tab ? modelOf(tab) : null);
  }

  // Ticks 「最後の動き 40 秒前」 in every container without a full re-render.
  setInterval(() => {
    if (document.hidden) return;
    const roots = [...hosts.values()];
    if (panelEl) roots.push(panelEl);
    for (const root of roots) {
      for (const el of root.querySelectorAll('.wk-ago[data-at]')) {
        const at = Number(el.dataset.at);
        if (at) el.textContent = agoText(at);
      }
    }
  }, 1000);

  // ------------------------------------------------------------ diff modal
  let modal = null;

  function closeModal() {
    if (!modal) return;
    document.removeEventListener('keydown', modal.onKey, true);
    modal.root.remove();
    const prev = modal.prevFocus;
    modal = null;
    if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus();
  }

  function diffPre(text) {
    const pre = h('pre', 'pn-diff');
    for (const line of String(text).split('\n')) {
      let cls = '';
      if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) cls = 'meta';
      else if (line.startsWith('@@')) cls = 'hunk';
      else if (line.startsWith('+')) cls = 'add';
      else if (line.startsWith('-')) cls = 'del';
      pre.append(h('span', cls ? 'l ' + cls : 'l', line + '\n'));
    }
    return pre;
  }

  function editsView(f) {
    const box = h('div', 'pn-edits');
    if (!f.edits.length) {
      box.append(h('div', 'pn-empty', '記録された編集はありません。'));
      return box;
    }
    f.edits.forEach((e, i) => {
      const card = h('div', 'pn-edit' + (e.failed ? ' failed' : ''));
      const kind = { edit: 'Edit', write: 'Write', notebook: 'NotebookEdit' }[e.kind] || e.kind;
      const head = h('div', 'pn-edit-head', `#${i + 1} ${kind}${e.note ? ' · ' + e.note : ''} · ${timeStr(e.ts)}${e.failed ? ' · 失敗' : ''}`);
      card.append(head);
      const pre = h('pre', 'pn-diff');
      if (e.old) for (const l of e.old.split('\n')) pre.append(h('span', 'l del', '-' + l + '\n'));
      if (e.new) for (const l of e.new.split('\n')) pre.append(h('span', 'l add', '+' + l + '\n'));
      if (!e.old && !e.new) pre.append(h('span', 'l', '(空)\n'));
      card.append(pre);
      box.append(card);
    });
    return box;
  }

  function openFileModal(tab, f) {
    closeModal();
    const root = document.getElementById('overlay-root') || document.body;
    const backdrop = h('div', 'pn-backdrop');
    const dlg = h('div', 'pn-modal');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.tabIndex = -1;
    const rel = relPath(f.abs, tab.cwd);

    const head = h('div', 'pn-modal-head');
    const title = h('div', 'pn-modal-title');
    title.append(icon(ICONS.file), h('span', null, rel));
    title.title = f.abs;
    const seg = h('div', 'pn-seg');
    const bGit = h('button', 'pn-segbtn', 'Git diff');
    const bRec = h('button', 'pn-segbtn', `記録された編集 (${f.edits.length})`);
    seg.append(bGit, bRec);
    const openBtn = h('button', 'pn-btn primary', 'VS Codeで開く');
    openBtn.addEventListener('click', () => window.api && window.api.openFile(f.abs));
    const closeBtn = h('button', 'pn-btn icon', null);
    closeBtn.append(icon(ICONS.cross));
    closeBtn.title = '閉じる (Esc)';
    closeBtn.addEventListener('click', closeModal);
    const pv = previewButton(f.abs, tab, 'pn-btn');
    if (pv) pv.addEventListener('click', closeModal);
    head.append(title, seg, ...(pv ? [pv] : []), openBtn, closeBtn);

    const status = h('div', 'pn-modal-status', '差分を取得中…');
    const body = h('div', 'pn-modal-body');
    dlg.append(head, status, body);
    backdrop.append(dlg);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) closeModal();
    });

    let gitResult = null;
    const show = (which) => {
      bGit.classList.toggle('on', which === 'git');
      bRec.classList.toggle('on', which === 'rec');
      if (which === 'git') {
        if (!gitResult) {
          status.textContent = '差分を取得中…';
          body.replaceChildren();
        } else if (gitResult.ok && gitResult.diff && gitResult.diff.trim()) {
          status.textContent = gitResult.untracked ? 'git: 未追跡ファイル（全体を追加として表示）' : 'git diff HEAD';
          body.replaceChildren(diffPre(gitResult.diff));
        } else {
          status.textContent = gitResult.error ? `git diff 失敗: ${gitResult.error}` : gitResult.isGit === false ? 'git リポジトリではありません' : 'git 上の差分はありません';
          body.replaceChildren(h('div', 'pn-empty', '表示できる git の差分がありません。「記録された編集」を確認してください。'));
        }
      } else {
        status.textContent = 'このセッションで Claude が行った編集（トランスクリプトから記録）';
        body.replaceChildren(editsView(f));
      }
    };
    bGit.addEventListener('click', () => show('git'));
    bRec.addEventListener('click', () => show('rec'));

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeModal();
      }
    };
    modal = { root: backdrop, onKey, prevFocus: document.activeElement };
    document.addEventListener('keydown', onKey, true);
    root.append(backdrop);
    dlg.focus();
    show('git');

    const myModal = modal;
    const fileArg = rel !== f.abs ? rel : f.abs;
    Promise.resolve(window.api && window.api.gitDiff ? window.api.gitDiff({ cwd: tab.cwd, file: fileArg }) : { ok: false, isGit: false })
      .catch((err) => ({ ok: false, error: String((err && err.message) || err) }))
      .then((res) => {
        if (modal !== myModal) return;
        gitResult = res || { ok: false };
        const hasDiff = gitResult.ok && gitResult.diff && gitResult.diff.trim();
        show(hasDiff ? 'git' : 'rec');
      });
  }

  // ------------------------------------------------------------ public API
  window.Panel = {
    newStats,
    onEvent(tab, evt) {
      if (!tab) return;
      if (!tab.stats || tab.stats.v !== 2) tab.stats = newStats();
      applyEvent(tab.stats, evt, (evt && evt.cwd) || tab.cwd);
    },
    addLocal(tab, entry) {
      if (!tab) return;
      if (!tab.stats || tab.stats.v !== 2) tab.stats = newStats();
      addLocalTo(tab.stats, entry);
    },
    render,
    SECTIONS,
    attach,
    detach,
    shown,
    badges,
    summary: summaryOf,
    // UX15: the core's part of この作業 (fn(tab) -> ext, see workData), the data for the main window's view, its drawing
    setInfo(fn) {
      infoOf = typeof fn === 'function' ? fn : null;
    },
    workData: (tab) => (tab ? workData(tab, modelOf(tab)) : null),
    renderWork,
    _pure: pure,
  };
})();
