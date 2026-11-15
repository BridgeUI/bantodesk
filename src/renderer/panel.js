// Assist panel (owner: panel). Renders the active tab into per-section containers (Panel.attach) and,
// while it exists, the legacy all-in-one <aside id="panel">.
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
    if (!s || s.v !== 2) return { model: '', contextTokens: 0, contextPct: 0, costUsd: 0, todos: [], subagents: [], team: null, errors: 0, bg: [] };
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
  function toolClass(name) {
    if (name === 'Auto-yes') return 'approve';
    if (/^(Bash|PowerShell|BashOutput|KillShell)$/.test(name)) return 'sh';
    if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(name)) return 'read';
    if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return 'write';
    if (/^(Agent|Task)$/.test(name)) return 'agent';
    if (/^(WebFetch|WebSearch)$/.test(name)) return 'web';
    return 'other';
  }

  const pure = { newStats, applyEvent, addLocalTo, computeView, taskList, agentList, teamView, teammateName, summaryOf, relPath, absPath, fmtK, fmtCost, fmtElapsed };

  // Node (tests): export the pure part only.
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) module.exports = pure;
    return;
  }

  // =================================================================== DOM
  // Two ways to show the panel:
  //  - Sections (Panel.SECTIONS): core gives one container per section (a dock panel each) via Panel.attach(id, el).
  //    The dock tab is the title, so a container holds only the section body (no head / chevron).
  //  - Legacy: everything in #panel with collapsible section heads (kept until core switches over).
  // Visual rule (see conversation.css header): no cards. Plain rows, spacing / hairlines, coloured text and
  // small glyphs for status, a thin left rule only for nested detail.
  const STATUS_LABEL = { starting: '起動中', running: '実行中', asking: '入力待ち', idle: '待機中', exited: '終了' };
  const AGENT_STATUS_LABEL = { starting: '開始中', running: '実行中', idle: '待機中', done: '完了', error: 'エラー' };
  const SECTIONS = [
    { id: 'overview', title: '概要' },
    { id: 'tasks', title: 'タスク' },
    { id: 'team', title: 'チーム' },
    { id: 'agents', title: 'エージェント' },
    { id: 'files', title: '変更ファイル' },
    { id: 'tools', title: 'ツール' },
  ];
  const SECTION_IDS = new Set(SECTIONS.map((x) => x.id));
  const EMPTY_TEXT = {
    overview: 'まだアクティビティがありません。ターンが実行されると使用量がここに表示されます。',
    tasks: 'タスクはまだありません',
    team: 'このセッションにチームはありません',
    agents: 'サブエージェントはまだありません',
    files: '変更されたファイルはまだありません',
    tools: 'ツール呼び出しはまだありません',
  };
  const LEGACY = '#panel';
  const hosts = new Map(); // section id -> container element (Panel.attach)
  const dirty = new Set(); // LEGACY and / or section ids waiting for a render
  let panelEl = null;
  let currentTab;
  let rafPending = false;
  let retryTimer = 0;
  let collapsed;
  try {
    collapsed = new Set(JSON.parse(localStorage.getItem('panel.collapsed') || '[]'));
  } catch {
    collapsed = new Set();
  }

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
    chevron: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.5 5 6.5 8 3.5"/></svg>',
    check: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.3 5 8.7 9.5 3.6"/></svg>',
    cross: '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l6 6M9 3 3 9"/></svg>',
    branch: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-3 3-7 4"/></svg>',
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
  function elapsedEl(ms, live, startedAt) {
    const el = h('span', 'pn-elapsed', ms ? fmtElapsed(ms) : '');
    if (live && startedAt) el.dataset.start = String(startedAt);
    return el;
  }
  function lastToolEl(lastTool) {
    const lt = h('div', 'pn-alast');
    lt.append(h('b', null, lastTool.name || ''), document.createTextNode(' ' + String(lastTool.arg ?? '').slice(0, 160)));
    return lt;
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

  function badgesOf(m) {
    const out = {};
    for (const sec of SECTIONS) out[sec.id] = { badge: '', cls: '', empty: true };
    if (!m) return out;
    const { s, v, tasks, team, agents } = m;
    out.overview = { badge: v.messages ? `≈ ${fmtCost(v.costUsd)}` : '', cls: '', empty: false };
    const done = tasks.filter((t) => t.status === 'completed').length;
    out.tasks = { badge: tasks.length ? `${done}/${tasks.length}` : '', cls: '', empty: !tasks.length };
    if (team) {
      const live = team.members.filter((x) => isLive(x.status)).length;
      out.team = {
        badge: team.removed ? '終了' : live ? `${live} 実行中` : `${team.members.length} 人`,
        cls: live && !team.removed ? 'live' : '',
        empty: false,
      };
    }
    const running = agents.filter((a) => isLive(a.status)).length;
    out.agents = { badge: agents.length ? (running ? `${running} 実行中` : String(agents.length)) : '', cls: running ? 'live' : '', empty: !agents.length };
    out.files = { badge: s.files.size ? String(s.files.size) : '', cls: '', empty: !s.files.size };
    out.tools = {
      badge: [s.toolTotal ? fmt(s.toolTotal) : '', s.errors ? `${s.errors} err` : ''].filter(Boolean).join(' · '),
      cls: s.errors ? 'errb' : '',
      empty: !s.tools.length,
    };
    return out;
  }

  // ---- overview: session header + usage
  function renderHeader(tab, s) {
    const box = h('div', 'pn-head');
    box.append(h('div', 'pn-name', tab.label || ''));
    const meta = h('div', 'pn-meta');
    const add = (el) => {
      if (meta.childElementCount) meta.append(h('span', 'pn-sep', '·'));
      meta.append(el);
    };
    if (tab.status) add(h('span', `pn-status st-${tab.status}`, STATUS_LABEL[tab.status] || tab.status));
    if (s.model) add(h('span', 'pn-model', s.model));
    if (tab.worktree) {
      const wt = h('span', 'pn-worktree');
      wt.append(icon(ICONS.branch), document.createTextNode(` ${tab.worktree}`));
      wt.title = 'git worktree';
      add(wt);
    }
    if (meta.childElementCount) box.append(meta);
    if (tab.cwd) {
      const cwd = h('div', 'pn-cwd', normPath(tab.cwd).split('/').slice(-2).join('/'));
      cwd.title = tab.cwd;
      box.append(cwd);
    }
    const id = h('div', 'pn-id', tab.id || '');
    id.title = 'セッションID（選択してコピー）';
    box.append(id);
    return box;
  }

  function kv(k, v, cls) {
    const row = h('div', 'pn-kv-row' + (cls ? ' ' + cls : ''));
    row.append(h('span', 'k', k));
    const val = h('span', 'v');
    if (v instanceof Node) val.append(v);
    else val.textContent = v;
    row.append(val);
    return row;
  }

  // Session memory (roadmap 22, docs/memory-investigation.md): tab.memMb comes from main's pty:mem (core).
  // Over the mark ("重いセッションの目安", stored with the handoff settings) the row turns orange and offers
  // 再起動 (core listens for the document event 'bantodesk:restart' { tabId }).
  function memRow(tab) {
    if (!tab || tab.exited || tab.memMb == null) return null;
    const mark = (window.Handoff && window.Handoff.settings().memMb) || 800;
    const heavy = tab.memMb >= mark;
    const text = tab.memMb >= 1000 ? `${(tab.memMb / 1024).toFixed(1)}GB` : `${Math.round(tab.memMb)}MB`;
    const val = h('span', 'pn-mem');
    val.append(document.createTextNode(text));
    if (heavy) {
      const btn = h('button', 'pn-restart', '再起動');
      btn.dataset.usage = 'session.panel.restart'; // UA1
      btn.type = 'button';
      btn.title = `目安の ${mark}MB を超えています。claude を同じ会話のまま（--resume）起動し直すと軽くなります`;
      btn.addEventListener('click', () => document.dispatchEvent(new CustomEvent('bantodesk:restart', { detail: { tabId: tab.id } })));
      val.append(btn);
    }
    const row = kv('メモリ', val, heavy ? 'warn' : '');
    row.title = 'このセッションの claude とその子プロセスのプライベートメモリ（約 1 分ごとに更新）';
    return row;
  }

  function renderUsage(s, v, tab) {
    const box = h('div', 'pn-usage');
    const mem = memRow(tab);
    if (!v.messages) {
      box.append(emptyLine(EMPTY_TEXT.overview));
      if (s.autoYes || mem) {
        const list = h('div', 'pn-kv');
        if (mem) list.append(mem);
        if (s.autoYes) list.append(kv('自動承認', fmt(s.autoYes)));
        box.append(list);
      }
      return box;
    }
    const pct = v.contextPct;
    const level = pct > 85 ? 'danger' : pct > 70 ? 'warn' : '';
    const ctx = h('div', 'pn-ctx' + (level ? ' ' + level : ''));
    const top = h('div', 'pn-ctx-top');
    top.append(h('span', 'k', 'コンテキスト'), h('span', 'v', `${fmtK(v.contextTokens)} / ${fmtK(v.contextWindow)}`), h('span', 'pn-pct', `${pct.toFixed(pct < 10 ? 1 : 0)}%`));
    const bar = h('div', 'pn-bar' + (level ? ' ' + level : ''));
    const fill = document.createElement('i');
    fill.style.width = `${pct.toFixed(1)}%`;
    bar.append(fill);
    ctx.append(top, bar);
    // Context handoff (handoff.js, docs/plan-handoff.md): from min(80 %, threshold) a button starts it by
    // hand (core listens for the document event 'bantodesk:handoff' { tabId }); its progress below.
    const H = window.Handoff;
    const hoText = H && tab ? H.statusText(tab) : '';
    const hoFrom = H ? Math.min(80, H.threshold()) : 80;
    if (pct >= hoFrom || hoText) {
      ctx.append(h('div', 'pn-hint', hoText || 'コンテキストが残りわずかです — /compact で縮めるか、新しいセッションへ引き継ぐ'));
      if (H && tab && !tab.exited && !tab.handedOff && !/中|待って|起動/.test(hoText)) {
        const btn = h('button', 'pn-handoff', '新しいセッションへ引き継ぐ');
        btn.dataset.usage = 'session.panel.handoff'; // UA1
        btn.type = 'button';
        btn.title = 'このセッションに引き継ぎメモを書かせ、同じフォルダの新しいセッションで続きを始めます（古いタブは終了済みとして残ります）';
        btn.addEventListener('click', () => document.dispatchEvent(new CustomEvent('bantodesk:handoff', { detail: { tabId: tab.id } })));
        ctx.append(btn);
      }
    }
    box.append(ctx);

    const list = h('div', 'pn-kv');
    const cost = kv('概算コスト', `≈ ${fmtCost(v.costUsd)}`);
    cost.title = 'API 定価での概算（pricing.js）。サブスクリプション利用時の実請求とは異なります。';
    if (mem) list.append(mem);
    list.append(
      cost,
      kv('ターン', fmt(v.turns)),
      kv('出力トークン', fmtK(s.output)),
      kv('キャッシュヒット', `${v.cacheHitPct.toFixed(1)}%`),
    );
    if (s.autoYes) list.append(kv('自動承認', fmt(s.autoYes)));
    if (s.errors) list.append(kv('ツールエラー', fmt(s.errors), 'err'));
    box.append(list);
    box.append(h('div', 'pn-detail', `入力 ${fmtK(s.input)} · キャッシュ書込 ${fmtK(s.cacheCreate)} · 読込 ${fmtK(s.cacheRead)} · ${fmt(v.messages)} msgs`));
    return box;
  }

  // ---- tasks
  function renderTasks(list) {
    const done = list.filter((t) => t.status === 'completed').length;
    const box = h('div', 'pn-tasks');
    const bar = h('div', 'pn-bar thin');
    const fill = document.createElement('i');
    fill.style.width = `${list.length ? (done / list.length) * 100 : 0}%`;
    bar.append(fill);
    box.append(bar);
    const ul = h('ul', 'pn-tasklist');
    for (const t of list) {
      const li = h('li', `t-${t.status}`);
      const mark = h('span', 'pn-tmark');
      if (t.status === 'completed') mark.append(icon(ICONS.check));
      else if (t.status === 'in_progress') mark.append(h('span', 'pn-spin'));
      else mark.append(h('span', 'pn-ring'));
      li.append(mark);
      const text = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.text;
      const span = h('span', 'pn-ttext', text);
      if (text !== t.text) span.title = t.text;
      li.append(span);
      if (t.id) li.append(h('span', 'pn-tid', `#${t.id}`));
      ul.append(li);
    }
    box.append(ul);
    return box;
  }

  // ---- subagents
  function renderAgents(list) {
    const ul = h('ul', 'pn-agents');
    for (const a of list) {
      const li = h('li', `pn-agent a-${a.status}`);
      const top = h('div', 'pn-arow');
      top.append(statusGlyph(a.status), h('span', 'pn-atype', a.agentType), elapsedEl(a.elapsedMs, isLive(a.status), a.startedAt));
      li.append(top);
      if (a.description) li.append(h('div', 'pn-adesc', a.description));
      const meta = [];
      if (a.status === 'starting') meta.push('起動待ち…');
      if (a.toolCount) meta.push(`${a.toolCount} tools`);
      if (a.tokens) meta.push(`${fmtK(a.tokens)} tok`);
      const showLast = a.lastTool && isLive(a.status);
      if (meta.length || showLast) {
        const nest = h('div', 'pn-nest');
        if (showLast) nest.append(lastToolEl(a.lastTool));
        if (meta.length) nest.append(h('div', 'pn-ameta', meta.join(' · ')));
        li.append(nest);
      }
      ul.append(li);
    }
    return ul;
  }

  // ---- Agent Teams
  // Teammate colors as named in ~/.claude/teams/<team>/config.json.
  const TEAM_COLORS = {
    blue: 'var(--blue)', green: 'var(--green)', red: 'var(--red)', yellow: 'var(--yellow)',
    purple: 'var(--mauve)', magenta: 'var(--mauve)', orange: 'var(--peach)', cyan: 'var(--teal)', pink: '#f5c2e7',
  };
  // Clicking a member asks core to open that member's conversation (read-only) in a dock panel.
  // Core listens for the document event 'bantodesk:open-member' { tabId, agentId, name }.
  function renderTeam(team, tab) {
    const box = h('div', 'pn-team');
    box.append(h('div', 'pn-team-name', team.name + (team.removed ? '（片付け済み）' : '')));
    const ul = h('ul', 'pn-agents pn-members');
    for (const m of team.members) {
      const li = h('li', `pn-agent a-${m.status}`);
      if (m.agentId && tab) {
        li.classList.add('pn-clickable');
        li.title = `クリックで @${m.name} の会話を表示`;
        li.addEventListener('click', () => {
          document.dispatchEvent(new CustomEvent('bantodesk:open-member', { detail: { tabId: tab.id, agentId: m.agentId, name: m.name } }));
        });
      }
      const top = h('div', 'pn-arow');
      const dot = h('span', 'pn-mdot');
      dot.style.background = TEAM_COLORS[m.color] || 'var(--overlay)';
      top.append(dot, h('span', 'pn-atype', '@' + m.name), statusGlyph(m.status), h('span', 'pn-mstat', AGENT_STATUS_LABEL[m.status] || m.status));
      top.append(elapsedEl(m.elapsedMs, isLive(m.status), m.startedAt));
      li.append(top);
      if (m.description) li.append(h('div', 'pn-adesc', m.description));
      const meta = [m.agentType, m.model].filter(Boolean);
      if (m.status === 'starting') meta.push('起動待ち…');
      if (m.toolCount) meta.push(`${m.toolCount} tools`);
      if (m.tokens) meta.push(`${fmtK(m.tokens)} tok`);
      const showSum = m.summary && m.status !== 'running';
      const showLast = m.lastTool && m.status === 'running';
      if (showSum || showLast || meta.length) {
        const nest = h('div', 'pn-nest');
        if (showSum) nest.append(h('div', 'pn-msum', m.summary));
        if (showLast) nest.append(lastToolEl(m.lastTool));
        if (meta.length) nest.append(h('div', 'pn-ameta', meta.join(' · ')));
        li.append(nest);
      }
      ul.append(li);
    }
    box.append(ul);
    if (!team.members.length) box.append(emptyLine('メンバーはまだいません'));
    box.append(h('div', 'pn-team-hint', 'メンバーをクリックすると会話を表示します（Claude Code のメンバー画面は、ターミナルで ↓ キー → Enter）'));
    return box;
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

  // ---- tool calls: one line "Name  arg  time"; click expands the full argument / error under a left rule.
  function renderTools(s) {
    const ul = h('ul', 'pn-tools');
    for (const t of s.tools) {
      const li = h('li', `pn-tool ${toolClass(t.name)}${t.error ? ' err' : ''}${t.open ? ' open' : ''}`);
      const row = h('div', 'pn-trow');
      row.append(h('span', 'name', t.name), h('span', 'arg', t.arg), h('span', 'time', t.time));
      row.title = 'クリックで詳細を表示/折りたたみ';
      row.addEventListener('click', () => {
        const sel = window.getSelection && window.getSelection();
        if (sel && !sel.isCollapsed && li.contains(sel.anchorNode)) return;
        t.open = !t.open;
        li.classList.toggle('open', t.open);
      });
      const det = h('div', 'pn-tdetail');
      if (t.arg) det.append(h('div', 'pn-targ', t.arg));
      if (t.error) det.append(h('div', 'pn-errtext', t.error));
      li.append(row, det);
      ul.append(li);
    }
    return ul;
  }

  // Body of one section, or null when it has nothing to show.
  function sectionBody(id, m) {
    const { tab, s, v, tasks, team, agents } = m;
    switch (id) {
      case 'overview': {
        const frag = document.createDocumentFragment();
        frag.append(renderHeader(tab, s), renderUsage(s, v, tab));
        return frag;
      }
      case 'tasks': return tasks.length ? renderTasks(tasks) : null;
      case 'team': return team ? renderTeam(team, tab) : null;
      case 'agents': return agents.length ? renderAgents(agents) : null;
      case 'files': return s.files.size ? renderFiles(tab, s) : null;
      case 'tools': return s.tools.length ? renderTools(s) : null;
      default: return null;
    }
  }

  // Content of an attached section container.
  function buildSection(id, tab, m) {
    const view = h('div', `pn-view pn-v-${id}`);
    if (!tab) {
      view.append(emptyLine('セッションがありません'));
      return view;
    }
    const body = sectionBody(id, m || modelOf(tab));
    view.append(body || emptyLine(EMPTY_TEXT[id]));
    return view;
  }

  // ---- legacy all-in-one #panel
  function legacySection(key, title, badge, body, cls) {
    const sec = h('section', 'pn-sec' + (collapsed.has(key) ? ' collapsed' : ''));
    const head = h('div', 'pn-sec-head');
    head.append(icon(ICONS.chevron, 'pn-chev'), h('span', 'pn-sec-title', title));
    if (badge) head.append(h('span', 'pn-badge' + (cls ? ' ' + cls : ''), badge));
    head.addEventListener('click', () => {
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      try {
        localStorage.setItem('panel.collapsed', JSON.stringify([...collapsed]));
      } catch {}
      sec.classList.toggle('collapsed');
    });
    const wrap = h('div', 'pn-sec-body');
    wrap.append(body);
    sec.append(head, wrap);
    return sec;
  }

  function buildLegacy(tab, model) {
    const frag = document.createDocumentFragment();
    if (!tab) {
      frag.append(emptyLine('セッションがありません'));
      return frag;
    }
    const m = model || modelOf(tab);
    const b = badgesOf(m);
    frag.append(renderHeader(tab, m.s));
    frag.append(legacySection('usage', '使用量', b.overview.badge, renderUsage(m.s, m.v, m.tab)));
    for (const { id, title } of SECTIONS) {
      if (id === 'overview') continue;
      const body = sectionBody(id, m);
      if (body) frag.append(legacySection(id, title, b[id].badge, body, b[id].cls));
      else if (id === 'tools') frag.append(legacySection(id, title, '', emptyLine(EMPTY_TEXT.tools)));
    }
    return frag;
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
  const liveFree = function (k, v) {
    return k === 'elapsedMs' && isLive(this.status) ? undefined : v; // ticks by itself (the 1 s timer below)
  };
  function sectionSig(id, m) {
    if (!m) return 'none';
    const { tab, s, v, tasks, team, agents } = m;
    switch (id) {
      case 'overview': {
        const H = window.Handoff;
        return JSON.stringify([
          tab.id, tab.label, tab.status, tab.worktree, tab.cwd, tab.memMb, !!tab.exited, !!tab.handedOff, s.model,
          v.messages, v.costUsd, v.turns, v.contextTokens, v.contextWindow, v.contextPct, v.cacheHitPct,
          s.input, s.output, s.cacheRead, s.cacheCreate, s.autoYes, s.errors,
          H ? [H.statusText(tab), H.threshold(), H.settings().memMb] : null,
        ]);
      }
      case 'tasks': return JSON.stringify(tasks.map((t) => [t.id, t.status, t.text, t.activeForm]));
      case 'team': return JSON.stringify([tab.id, team], liveFree);
      case 'agents': return JSON.stringify(agents, liveFree);
      case 'files': {
        let k = `${tab.id}|${tab.cwd}|${filesMore.get(tab.id) || 0}|${s.files.size}`;
        for (const [key, f] of s.files) k += `|${key}:${f.count}:${f.lastTs}`;
        return k;
      }
      case 'tools': return JSON.stringify([s.toolTotal, s.errors, s.tools.map((t) => [t.name, t.arg, t.time, t.error, !!t.open])]);
      default: return null;
    }
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

  // Ticks the elapsed time of running subagents / members in every container without a full re-render.
  setInterval(() => {
    if (document.hidden) return;
    const now = Date.now();
    const roots = [...hosts.values()];
    if (panelEl) roots.push(panelEl);
    for (const root of roots) {
      for (const el of root.querySelectorAll('.pn-elapsed[data-start]')) {
        const start = Number(el.dataset.start);
        if (start) el.textContent = fmtElapsed(now - start);
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
    _pure: pure,
  };
})();
