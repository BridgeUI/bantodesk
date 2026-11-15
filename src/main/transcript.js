// Claude Code transcript parsing + watching. No Electron imports: this module is also run from
// plain Node test scripts. See CONTRACT.md "Assist events" for the event shapes.
const path = require('path');
const os = require('os');
const fs = require('fs');

const projectsDir = path.join(os.homedir(), '.claude', 'projects');

const PROMPT_SKIP = [
  '<command-',
  '<local-command-',
  '<system-reminder>',
  'Caveat:',
  '<task-notification',
  '<bash-',
  '[Request interrupted',
];
const AGENT_TOOLS = new Set(['Agent', 'Task']);

// A message typed while a turn is running is queued by Claude Code and, when the model actually gets it,
// recorded as ONE attachment line (2.1.2xx–2.1.316; no user line is written for it):
//   {"type":"attachment","attachment":{"type":"queued_command","prompt":"…" | [{type:'image'},{type:'text',text}],
//    "commandMode":"prompt","origin":{"kind":"human"}, …}}
// The surrounding queue-operation lines (enqueue / remove / dequeue) are not used: an enqueue that is later
// dequeued at the end of the turn becomes a normal user line instead, so they would duplicate it.
// Other origins (task-notification, peer = cross-session message, coordinator = lead -> member) are not prompts.
function queuedPrompt(obj) {
  const a = obj.attachment;
  if (!a || a.type !== 'queued_command' || a.isMeta || obj.isMeta || obj.isSidechain) return null;
  if (a.commandMode !== 'prompt' || !a.origin || a.origin.kind !== 'human') return null;
  return a.prompt;
}

// Real human prompt text, or null. Shared with the history listing (sessions.js).
function promptText(obj) {
  if (!obj) return null;
  let c;
  if (obj.type === 'attachment') {
    c = queuedPrompt(obj);
    if (c == null) return null;
  } else {
    if (obj.type !== 'user' || obj.isMeta || obj.isSidechain || !obj.message) return null;
    c = obj.message.content;
  }
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === 'tool_result')) return null;
    text = c
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  if (typeof text !== 'string') return null;
  // Claude Code wraps a long paste as <pasted_content id="…">…</pasted_content>: show the pasted text itself.
  text = text.replace(/<\/?pasted_content\b[^>]*>/g, '').trim();
  if (!text || PROMPT_SKIP.some((p) => text.startsWith(p))) return null;
  // Agent Teams: teammate reports arrive as user lines wrapped in "Another Claude session sent a message: <teammate-message …>".
  if (/<teammate-message[\s>]/.test(text)) return null;
  return text.slice(0, PROMPT_MAX);
}
// The conversation view folds long prompts itself ("全文を表示"); this only bounds pathological pastes.
const PROMPT_MAX = 20000;

// Agent Teams: <teammate-message teammate_id="alpha" color="blue"> {"type":"idle_notification","from":"alpha",
// "idleReason":"available","result":"OK"} </teammate-message> (verified on 2.1.316). The body may also be plain text.
const TEAMMATE_RE = /<teammate-message\s+teammate_id="([^"]+)"[^>]*>([\s\S]*?)<\/teammate-message>/g;
function teammateMessages(text) {
  const out = [];
  if (!text || !text.includes('<teammate-message')) return out;
  TEAMMATE_RE.lastIndex = 0;
  let m;
  while ((m = TEAMMATE_RE.exec(text))) {
    const body = m[2].trim();
    let j = null;
    try {
      j = JSON.parse(body);
    } catch {}
    out.push({
      name: m[1],
      msgType: (j && typeof j.type === 'string' && j.type) || 'message',
      idleReason: (j && typeof j.idleReason === 'string' && j.idleReason) || null,
      summary: String((j && (j.result ?? j.summary ?? j.message ?? j.content)) ?? body).slice(0, 300),
    });
  }
  return out;
}

// Conversation view (5a): longer copies of tool output. Read-like tools are collapsed in the UI, so
// they get a smaller budget (keeps api.replay of long sessions small).
const OUTPUT_MAX = 8000;
const OUTPUT_MAX_READ = 2000;
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'ToolSearch']);
const PATCH_MAX_LINES = 300;

// structuredPatch of Edit / Write results -> [{ oldStart, newStart, lines: [' ctx', '-old', '+new'] }], capped.
function patchOf(tur) {
  const sp = tur && typeof tur === 'object' && Array.isArray(tur.structuredPatch) ? tur.structuredPatch : null;
  if (!sp || !sp.length) return null;
  const out = [];
  let budget = PATCH_MAX_LINES;
  for (const hunk of sp) {
    if (!hunk || !Array.isArray(hunk.lines) || budget <= 0) break;
    const lines = hunk.lines.slice(0, budget).map((l) => String(l).slice(0, 400));
    budget -= lines.length;
    out.push({ oldStart: Number(hunk.oldStart) || 0, newStart: Number(hunk.newStart) || 0, lines });
  }
  return out.length ? out : null;
}

function resultText(content, max = 500) {
  let s = '';
  if (typeof content === 'string') s = content;
  else if (Array.isArray(content)) {
    s = content
      .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : b && b.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return s.slice(0, max);
}

function fullResultText(content) {
  return resultText(content, Infinity);
}

// Short human-readable summary of a tool input (for subagent lastTool.arg).
function argSummary(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick =
    input.file_path || input.notebook_path || input.path
      ? path.basename(String(input.file_path || input.notebook_path || input.path))
      : input.command ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.subject ?? input.skill ?? input.prompt ?? '';
  const s = String(pick).replace(/\s+/g, ' ').trim();
  return s.length > 80 ? s.slice(0, 79) + '…' : s;
}

const toMs = (ts) => {
  const n = typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isFinite(n) ? n : Date.now();
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
};
const readJsonAsync = async (file) => {
  try {
    return JSON.parse((await fs.promises.readFile(file, 'utf8')).replace(/^﻿/, ''));
  } catch {
    return null;
  }
};

// Classify a path below ~/.claude/projects by its shape.
function classify(file) {
  const base = path.basename(file);
  const dir = path.dirname(file);
  let m;
  if (path.basename(dir) === 'subagents') {
    const sessionId = path.basename(path.dirname(dir));
    if ((m = /^agent-(.+)\.meta\.json$/.exec(base))) return { type: 'meta', sessionId, agentId: m[1] };
    if ((m = /^agent-(.+)\.jsonl$/.exec(base))) return { type: 'sub', sessionId, agentId: m[1] };
    return null;
  }
  if (base === 'custom-title.json') return { type: 'title', sessionId: path.basename(dir) };
  if (base.endsWith('.jsonl')) return { type: 'main', sessionId: base.slice(0, -6) };
  return null;
}

// Agent Teams / named subagents (in-process teammates, meta taskKind "in_process_teammate"): the Agent call returns at
// once ("Spawned successfully", status teammate_spawned) and no task-notification / meta.finished ever comes. The member
// ends by approving the lead's shutdown_request with its own SendMessage (verified on 2.1.318):
//   tool_use  SendMessage { to: "team-lead", message: { type: "shutdown_response", request_id, approve: true }, … }
//   tool_result {"success":true,"message":"Shutdown approved. Sent confirmation to team-lead. Agent <name> is now exiting."}
// and nothing more is written to its file (no system / attachment line marks it, in its file or the lead's).
// -> true (approved), false (declined: it keeps working), null (not a shutdown_response)
function shutdownAnswer(t) {
  if (!t || t.name !== 'SendMessage' || !t.input || typeof t.input !== 'object') return null;
  const m = t.input.message && typeof t.input.message === 'object' ? t.input.message : t.input;
  if (!m || m.type !== 'shutdown_response') return null;
  return m.approve === true;
}
const EXIT_RE = /Shutdown approved\b|\bis now exiting\b/;

const NOTIF_RE = /<task-notification>[\s\S]*?<tool-use-id>([^<]+)<\/tool-use-id>[\s\S]*?<status>([^<]+)<\/status>/g;
// One whole <task-notification> block (its fields are read one by one: task-id / tool-use-id / status).
const TASK_NOTIF_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g;

// Stateful line parser. emit(evt) receives every assist event.
class Parser {
  constructor(emit) {
    this.emit = emit;
    this.sessions = new Map(); // sessionId -> session state
  }

  sess(sessionId) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        cwd: undefined,
        title: undefined,
        agentCalls: new Map(), // toolUseId -> { agentType, description, background, prompt }
        toolDone: new Map(), // toolUseId -> 'done' | 'error'   (agent completion seen)
        agentToTool: new Map(), // agentId -> toolUseId
        subagents: new Map(), // agentId -> snapshot (with private fields)
        turnEnded: new Set(), // msgIds already reported as turn_end
        toolNames: new Map(), // toolUseId -> tool name (main thread; for the output budget)
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  base(kind, sessionId, ts, s) {
    const e = { kind, sessionId, ts: ts || new Date().toISOString() };
    if (s.cwd) e.cwd = s.cwd;
    return e;
  }

  // Dispatch by file kind. `line` is one JSONL line (main/sub) or ignored for meta/title.
  handleFile(file, info = classify(file)) {
    if (!info) return;
    if (info.type === 'meta') this.handleMeta(file, info);
    else if (info.type === 'title') this.handleTitleFile(file, info);
  }

  handleLine(file, line, info = classify(file)) {
    if (!info || (info.type !== 'main' && info.type !== 'sub')) return;
    if (!this.wanted(line, info)) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (!obj || typeof obj !== 'object') return;
    if (info.type === 'sub') this.subLine(info, obj);
    else this.mainLine(info, obj);
  }

  // Cheap pre-filter before JSON.parse (subagent files can be hundreds of MB, mostly tool output).
  wanted(line, info) {
    const head = line.slice(0, 400);
    if (info.type === 'main') {
      if (head.startsWith('{"type":"api-request') || head.startsWith('{"type":"file-history')) return false;
      // Attachment lines are noise, except queued prompts (see queuedPrompt).
      if (head.includes('"attachment":{"type":"queued_command"')) return true;
      return !(head.includes('"attachment":{') && !head.includes('"message":'));
    }
    // api-request / api-request-blob lines (2.1.318) copy the request's messages but have no timestamp: they would set
    // updatedAt to "now" on every replay (the stale rule in waits.js reads updatedAt as the last write).
    if (head.startsWith('{"type":"api-request')) return false;
    if (head.includes('"role":"assistant"') || head.includes('"type":"assistant"') || head.includes('"parentUuid":null')) {
      return true;
    }
    // User lines matter only when they carry the result of a (nested) Agent call.
    if (!line.includes('"tool_result"')) return false;
    if (EXIT_RE.test(line)) return true; // a teammate's shutdown approved (see shutdownAnswer)
    const s = this.sessions.get(info.sessionId);
    if (!s) return false;
    const own = s.subagents.get(info.agentId);
    if (own && own._exitTool && line.includes(own._exitTool)) return true; // the result of its shutdown_response

    for (const id of s.agentCalls.keys()) if (!s.toolDone.has(id) && line.includes(id)) return true;
    return false;
  }

  setTitle(sessionId, title, ts) {
    const s = this.sess(sessionId);
    if (typeof title !== 'string' || !title.trim() || s.title === title) return;
    s.title = title;
    this.emit({ ...this.base('title', sessionId, ts, s), title });
  }

  handleTitleFile(file, info, j = readJson(file)) {
    if (j && typeof j.customTitle === 'string') this.setTitle(info.sessionId, j.customTitle);
  }

  mainLine(info, obj) {
    if (obj.isSidechain) return; // legacy in-file sidechains: not main-thread activity
    // The file name is the id the tab started claude with (--session-id / --resume keep it).
    const sessionId = info.sessionId || obj.sessionId;
    const s = this.sess(sessionId);
    if (typeof obj.cwd === 'string' && obj.cwd) s.cwd = obj.cwd;
    const ts = obj.timestamp;

    if (obj.type === 'custom-title') return this.setTitle(sessionId, obj.customTitle, ts);
    if (obj.type === 'queue-operation' && typeof obj.content === 'string') {
      return this.notifications(sessionId, obj.content, ts);
    }
    if (obj.type === 'attachment') {
      // a task notification delivered to the model as a queued command (also seen as a queue-operation enqueue)
      const a = obj.attachment;
      if (a && a.type === 'queued_command') {
        const p = a.prompt;
        if (typeof p === 'string') this.notifications(sessionId, p, ts);
        else if (Array.isArray(p)) for (const b of p) if (b && b.type === 'text') this.notifications(sessionId, b.text, ts);
      }
      const text = promptText(obj); // a message typed mid-turn, delivered to the model
      if (text) this.emit({ ...this.base('prompt', sessionId, ts, s), text });
      return;
    }

    if (obj.type === 'assistant' && obj.message) {
      const m = obj.message;
      // A failed API call is written as a synthetic assistant line (model "<synthetic>",
      // stop_reason "stop_sequence", so no turn_end follows). Its text still becomes assistant_text below.
      if (obj.isApiErrorMessage === true) {
        const text = Array.isArray(m.content)
          ? m.content
              .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text)
              .join('\n')
          : typeof m.content === 'string'
            ? m.content
            : '';
        this.emit({
          ...this.base('api_error', sessionId, ts, s),
          text: text.trim().slice(0, 500),
          error: String(obj.error ?? '').slice(0, 200), // e.g. "server_error"
        });
      }
      if (m.usage && m.id) {
        this.emit({ ...this.base('usage', sessionId, ts, s), msgId: m.id, model: m.model, usage: m.usage });
      }
      if (Array.isArray(m.content)) {
        for (const [idx, c] of m.content.entries()) {
          if (c && c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
            this.emit({ ...this.base('assistant_text', sessionId, ts, s), msgId: m.id || null, uuid: obj.uuid || null, idx, text: c.text });
            continue;
          }
          if (!c || c.type !== 'tool_use') continue;
          if (c.id) s.toolNames.set(c.id, c.name);
          this.emit({ ...this.base('tool_use', sessionId, ts, s), toolUseId: c.id, name: c.name, input: c.input });
          if (AGENT_TOOLS.has(c.name)) this.agentCall(sessionId, c, ts);
        }
      }
      if (m.stop_reason === 'end_turn') {
        const key = m.id || obj.uuid;
        if (!key || !s.turnEnded.has(key)) {
          if (key) s.turnEnded.add(key);
          this.emit(this.base('turn_end', sessionId, ts, s));
        }
      }
      return;
    }

    if (obj.type === 'user' && obj.message) {
      const c = obj.message.content;
      const teammates = (t) => {
        for (const tm of teammateMessages(t)) this.emit({ ...this.base('teammate', sessionId, ts, s), ...tm });
      };
      if (typeof c === 'string') {
        this.notifications(sessionId, c, ts);
        if (!obj.isSidechain) teammates(c);
      }
      if (Array.isArray(c)) {
        for (const b of c) {
          if (!b) continue;
          if (b.type === 'text' && typeof b.text === 'string') {
            this.notifications(sessionId, b.text, ts);
            if (!obj.isSidechain) teammates(b.text);
          }
          if (b.type !== 'tool_result') continue;
          const full = fullResultText(b.content);
          const max = READ_TOOLS.has(s.toolNames.get(b.tool_use_id)) ? OUTPUT_MAX_READ : OUTPUT_MAX;
          s.toolNames.delete(b.tool_use_id);
          const e = {
            ...this.base('tool_result', sessionId, ts, s),
            toolUseId: b.tool_use_id,
            isError: !!b.is_error,
            text: full.slice(0, 500),
            output: full.slice(0, max),
            outputLen: full.length,
          };
          const patch = patchOf(obj.toolUseResult);
          if (patch) e.patch = patch;
          const tid = obj.toolUseResult && obj.toolUseResult.task && obj.toolUseResult.task.id;
          if (tid !== undefined && tid !== null) e.taskId = String(tid);
          this.emit(e);
          this.agentResult(sessionId, b, obj.toolUseResult, ts);
        }
      }
      const text = promptText(obj);
      if (text) this.emit({ ...this.base('prompt', sessionId, ts, s), text });
    }
  }

  // --- subagents ----------------------------------------------------------
  agentCall(sessionId, c, ts) {
    const s = this.sess(sessionId);
    const input = c.input || {};
    s.agentCalls.set(c.id, {
      agentType: input.subagent_type || 'general-purpose',
      description: input.description || '',
      background: !!input.run_in_background,
      prompt: typeof input.prompt === 'string' ? input.prompt.trim() : null,
    });
    // An already-known agent waiting for this info (meta arrived first).
    for (const [agentId, snap] of s.subagents) {
      if (snap.toolUseId === c.id) this.touch(sessionId, agentId, {}, ts);
    }
  }

  // tool_result for some tool_use (in the main file or inside a subagent, for nested agents).
  agentResult(sessionId, b, tur, ts) {
    const s = this.sess(sessionId);
    const toolUseId = b.tool_use_id;
    if (tur && typeof tur === 'object' && typeof tur.agentId === 'string' && toolUseId) {
      s.agentToTool.set(tur.agentId, toolUseId); // authoritative link from the Agent tool's own result
      const snap = s.subagents.get(tur.agentId);
      if (snap && !(snap._meta && snap._meta.toolUseId)) snap.toolUseId = toolUseId;
    }
    const isAgent = s.agentCalls.has(toolUseId) || [...s.agentToTool.values()].includes(toolUseId);
    if (!isAgent) return;
    const text = resultText(b.content);
    // Background agents and Agent Teams teammates return immediately; they are not finished yet.
    const launched =
      (tur && typeof tur === 'object' && (tur.status === 'async_launched' || tur.isAsync === true)) ||
      /^(Async agent launched|Spawned successfully)/.test(text);
    if (b.is_error) this.finish(sessionId, toolUseId, 'error', ts);
    else if (!launched) this.finish(sessionId, toolUseId, 'done', ts);
  }

  notifications(sessionId, text, ts) {
    if (typeof text !== 'string' || !text.includes('<task-notification>')) return;
    NOTIF_RE.lastIndex = 0;
    let m;
    while ((m = NOTIF_RE.exec(text))) {
      const status = m[2].trim();
      // Also fires for background Bash tasks; harmless since only agent toolUseIds are looked up.
      this.finish(sessionId, m[1].trim(), status === 'completed' ? 'done' : 'error', ts);
    }
    // task_notification { taskId, toolUseId, status }: once per taskId + status (the same notification arrives
    // as a queue-operation enqueue and again as a queued_command attachment).
    const s = this.sess(sessionId);
    if (!s.notifSeen) s.notifSeen = new Set();
    TASK_NOTIF_RE.lastIndex = 0;
    while ((m = TASK_NOTIF_RE.exec(text))) {
      const body = m[1];
      const field = (name) => {
        const r = new RegExp(`<${name}>([^<]*)</${name}>`).exec(body);
        return r ? r[1].trim() : null;
      };
      const taskId = field('task-id');
      const toolUseId = field('tool-use-id');
      const status = field('status');
      if (!status || (!taskId && !toolUseId)) continue;
      const key = `${taskId || toolUseId}\n${status}`;
      if (s.notifSeen.has(key)) continue;
      s.notifSeen.add(key);
      if (s.notifSeen.size > 2000) s.notifSeen.delete(s.notifSeen.values().next().value);
      this.emit({ ...this.base('task_notification', sessionId, ts, s), taskId, toolUseId, status });
    }
  }

  finish(sessionId, toolUseId, status, ts) {
    const s = this.sess(sessionId);
    s.toolDone.set(toolUseId, status);
    for (const [agentId, snap] of s.subagents) {
      if (snap.toolUseId === toolUseId) this.touch(sessionId, agentId, {}, ts);
    }
  }

  // j: the parsed file when the caller read it already (the live watcher reads async, perf2)
  handleMeta(file, info, ts, j = readJson(file)) {
    if (!j) return;
    const s = this.sess(info.sessionId);
    if (j.toolUseId) s.agentToTool.set(info.agentId, j.toolUseId);
    if (ts === undefined && !s.subagents.has(info.agentId)) {
      try {
        ts = fs.statSync(file).birthtimeMs;
      } catch {}
    }
    this.touch(info.sessionId, info.agentId, { meta: j }, ts);
  }

  subLine(info, obj) {
    const sessionId = info.sessionId;
    if (obj.type !== 'user' && obj.type !== 'assistant') return;
    const agentId = obj.agentId || info.agentId;
    const s = this.sess(sessionId);
    const ts = obj.timestamp;
    const patch = {};
    if (obj.type === 'user' && obj.message) {
      const c = obj.message.content;
      // First prompt of the subagent: match it to the parent's Agent call when nothing else links them.
      // (Forks start with the parent's context, so only calls not yet linked to another agent count.)
      if (!obj.parentUuid && typeof c === 'string' && !s.agentToTool.has(agentId)) {
        const p = c.trim();
        const linked = new Set(s.agentToTool.values());
        const calls = [...s.agentCalls].reverse();
        for (const [tid, call] of calls) {
          if (call.prompt && call.prompt === p && !linked.has(tid)) {
            s.agentToTool.set(agentId, tid);
            break;
          }
        }
      }
      if (Array.isArray(c)) {
        const own = s.subagents.get(agentId);
        for (const b of c) {
          if (!b || b.type !== 'tool_result') continue;
          this.agentResult(sessionId, b, obj.toolUseResult, ts);
          // its shutdown_response failed: it did not exit
          if (b.is_error && own && own._exitTool && b.tool_use_id === own._exitTool) patch.alive = true;
          else if (!b.is_error && EXIT_RE.test(resultText(b.content, 2000))) patch.exit = { id: b.tool_use_id || null, msgId: null };
        }
      }
    } else if (obj.type === 'assistant' && obj.message) {
      const m = obj.message;
      if (m.usage && m.id) patch.usage = { msgId: m.id, out: Number(m.usage.output_tokens) || 0 };
      if (Array.isArray(m.content)) {
        const tools = m.content.filter((b) => b && b.type === 'tool_use');
        if (tools.length) {
          patch.tools = tools;
          for (const t of tools) if (AGENT_TOOLS.has(t.name)) this.agentCall(sessionId, t, ts);
          for (const t of tools) if (shutdownAnswer(t) === true) patch.exit = { id: t.id || null, msgId: m.id || null };
        }
      }
      // it went on after an approved shutdown (another message): still alive
      const own = s.subagents.get(agentId);
      if (!patch.exit && own && own._exited && m.id && own._exitMsg && m.id !== own._exitMsg) patch.alive = true;
    }
    this.touch(sessionId, agentId, patch, ts);
  }

  // Apply a change to a subagent snapshot and emit it when anything visible changed.
  touch(sessionId, agentId, patch, ts) {
    const s = this.sess(sessionId);
    let snap = s.subagents.get(agentId);
    const now = toMs(ts);
    if (!snap) {
      snap = {
        agentId,
        toolUseId: null,
        agentType: null,
        description: '',
        status: 'running',
        toolCount: 0,
        lastTool: null,
        tokens: 0,
        startedAt: now,
        updatedAt: now,
        _out: new Map(),
        _meta: null,
        _seen: new Set(),
        _last: '',
      };
      s.subagents.set(agentId, snap);
    }
    if (patch.meta) snap._meta = patch.meta;
    if (snap._meta && snap._meta.toolUseId) snap.toolUseId = snap._meta.toolUseId; // authoritative
    else if (!snap.toolUseId) snap.toolUseId = s.agentToTool.get(agentId) || null;
    const call = snap.toolUseId ? s.agentCalls.get(snap.toolUseId) : null;
    snap.agentType = (snap._meta && snap._meta.agentType) || (call && call.agentType) || snap.agentType || 'agent';
    snap.description = (snap._meta && snap._meta.description) || (call && call.description) || snap.description || '';
    if (patch.usage) {
      snap._out.set(patch.usage.msgId, patch.usage.out);
      let sum = 0;
      for (const v of snap._out.values()) sum += v;
      snap.tokens = sum;
    }
    if (patch.tools) {
      for (const t of patch.tools) {
        if (t.id && snap._seen.has(t.id)) continue;
        if (t.id) snap._seen.add(t.id);
        snap.toolCount++;
        snap.lastTool = { name: t.name, arg: argSummary(t.name, t.input) };
      }
    }
    if (patch.exit) {
      snap._exited = true;
      if (patch.exit.id) snap._exitTool = patch.exit.id;
      if (patch.exit.msgId) snap._exitMsg = patch.exit.msgId;
    } else if (patch.alive) snap._exited = false;
    const done = snap.toolUseId ? s.toolDone.get(snap.toolUseId) : undefined;
    if (done === 'error') snap.status = 'error';
    else if (done === 'done' || (snap._meta && snap._meta.finished === true) || snap._exited) snap.status = 'done';
    else snap.status = 'running';
    if (now < snap.startedAt) snap.startedAt = now;
    if (now > snap.updatedAt) snap.updatedAt = now;

    const out = {
      agentId,
      toolUseId: snap.toolUseId,
      agentType: snap.agentType,
      description: snap.description,
      status: snap.status,
      toolCount: snap.toolCount,
      lastTool: snap.lastTool,
      tokens: snap.tokens,
      startedAt: snap.startedAt,
      updatedAt: snap.updatedAt,
    };
    const key = JSON.stringify({ ...out, updatedAt: 0 });
    if (key === snap._last) return;
    snap._last = key;
    this.emit({ ...this.base('subagent', sessionId, typeof ts === 'string' ? ts : new Date(now).toISOString(), s), ...out });
  }
}

// --- whole-file helpers ---------------------------------------------------
function findTranscript(sessionId, root = projectsDir) {
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const f = path.join(root, d.name, sessionId + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// Async read (one file at a time) so a huge session does not freeze the main process in one go.
async function feedWholeFile(parser, file) {
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch {
    return;
  }
  const info = classify(file);
  for (const line of text.split('\n')) if (line.trim()) parser.handleLine(file, line, info);
}

// Full event list of an existing session: main file, then subagents (meta + lines), then title file.
// Subagent snapshots are collapsed to the final one per agent. Returns a Promise.
async function replay(sessionId, root = projectsDir) {
  const file = findTranscript(sessionId, root);
  if (!file) return [];
  const events = [];
  const parser = new Parser((e) => events.push(e));
  await feedWholeFile(parser, file);
  const sdir = path.join(file.slice(0, -6), 'subagents');
  // perf2: readdir / meta.json / custom-title.json async too (a meta.json read held main 837 ms at a tab restore)
  let names = [];
  try {
    names = await fs.promises.readdir(sdir);
  } catch {}
  for (const n of names) {
    if (!n.endsWith('.meta.json')) continue;
    const f = path.join(sdir, n);
    const info = classify(f);
    const j = await readJsonAsync(f);
    if (!info || !j) continue;
    const ts = await fs.promises.stat(f).then((s) => s.birthtimeMs, () => undefined);
    parser.handleMeta(f, info, ts, j);
  }
  for (const n of names) if (n.endsWith('.jsonl')) await feedWholeFile(parser, path.join(sdir, n));
  const tf = path.join(file.slice(0, -6), 'custom-title.json');
  const tj = await readJsonAsync(tf);
  if (tj) parser.handleTitleFile(tf, classify(tf), tj);

  const lastSub = new Map();
  events.forEach((e, i) => e.kind === 'subagent' && lastSub.set(e.agentId, i));
  return events.filter((e, i) => e.kind !== 'subagent' || lastSub.get(e.agentId) === i);
}

// Conversation events of one subagent / Agent Teams member (read-only member view in the UI).
// The sidechain file is fed through a Parser as if it were a main transcript, so the same
// prompt / assistant_text / tool_use / tool_result events come out. The member's instructions
// (<teammate-message …> from the lead, or the plain first prompt) become `prompt` events.
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
async function replayAgent(sessionId, agentId, root = projectsDir) {
  if (!AGENT_ID_RE.test(String(agentId || ''))) return [];
  const main = findTranscript(sessionId, root);
  if (!main) return [];
  const file = path.join(main.slice(0, -6), 'subagents', `agent-${agentId}.jsonl`);
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  const parser = new Parser((e) => {
    if (e.kind !== 'subagent' && e.kind !== 'teammate' && e.kind !== 'api_error') events.push(e); // api_error: main thread only
  });
  const info = { type: 'main', sessionId };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    obj.isSidechain = false;
    if (obj.type === 'user' && obj.message && !obj.isMeta) {
      const c = obj.message.content;
      const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
      TEAMMATE_RE.lastIndex = 0;
      let m;
      let found = false;
      while ((m = TEAMMATE_RE.exec(raw))) {
        found = true;
        const from = m[1];
        events.push({ kind: 'prompt', sessionId, ts: obj.timestamp, cwd: obj.cwd, text: `@${from}: ${m[2].trim()}`.slice(0, 4000) });
      }
      if (found) continue;
    }
    try {
      parser.mainLine(info, obj);
    } catch {}
  }
  return events;
}

// --- live watcher -----------------------------------------------------------
// Pre-existing files: only new activity. Files created after startup: read from the start.
function startWatcher(emit, opts = {}) {
  const { chokidar, root = projectsDir } = opts;
  if (!fs.existsSync(root)) return null;
  // While a chunk of lines is processed, subagent snapshots are coalesced (last one per agent wins).
  let batch = null;
  const parser = new Parser((e) => {
    if (batch && e.kind === 'subagent') batch.set(e.sessionId + ':' + e.agentId, e);
    else emit(e);
  });
  const offsets = new Map();
  // perf2 (docs/perf.md 案 2): opening a freshly written jsonl can take 10-200 ms on this PC, so the
  // reads are async. One read loop per file keeps the offsets in order; change events that arrive
  // while a file is being read are folded into one more pass after it (`again`).
  const reading = new Map(); // file -> { again, info, done: Promise }
  const CHUNK = opts.chunk || 4 * 1024 * 1024; // at most this much per pass; the rest is read on the next pass

  function readNew(file, info) {
    const cur = reading.get(file);
    if (cur) {
      cur.again = true;
      cur.info = info;
      return cur.done;
    }
    const st = { again: false, info };
    reading.set(file, st);
    st.done = (async () => {
      try {
        let more = true;
        while (more) {
          st.again = false;
          more = (await readOnce(file, st.info)) || st.again;
        }
      } catch (err) {
        console.warn('[transcript] read error', err);
      } finally {
        reading.delete(file);
      }
    })();
    return st.done;
  }

  // One pass: returns true when unread complete data is left (the chunk cap was hit).
  async function readOnce(file, info) {
    let stat;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      return false;
    }
    const prev = offsets.get(file) ?? 0;
    if (stat.size <= prev) {
      offsets.set(file, stat.size);
      return false;
    }
    // A pre-existing subagent seen for the first time: load its meta.json (skipped at startup).
    if (info.type === 'sub' && !parser.sess(info.sessionId).subagents.has(info.agentId)) {
      const meta = path.join(path.dirname(file), `agent-${info.agentId}.meta.json`);
      let j = null;
      try {
        j = JSON.parse((await fs.promises.readFile(meta, 'utf8')).replace(/^﻿/, ''));
      } catch {}
      if (j && !parser.sess(info.sessionId).subagents.has(info.agentId)) parser.handleMeta(meta, { ...info, type: 'meta' }, stat.birthtimeMs, j);
    }
    let fh;
    let buf;
    let left = false;
    try {
      fh = await fs.promises.open(file, 'r');
      let want = Math.min(stat.size - prev, CHUNK);
      for (;;) {
        buf = Buffer.alloc(want);
        const { bytesRead } = await fh.read(buf, 0, want, prev);
        buf = buf.subarray(0, bytesRead);
        // A single line longer than the chunk: read the rest of the file in one go.
        if (buf.lastIndexOf(0x0a) < 0 && bytesRead === want && prev + want < stat.size) {
          want = stat.size - prev;
          continue;
        }
        break;
      }
      left = prev + buf.length < stat.size;
    } catch {
      return false;
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
    // Another reader may not have moved the offset (one loop per file), but a truncation could have.
    if ((offsets.get(file) ?? 0) !== prev) return true;
    // Only consume complete lines; a partially written tail is re-read next time.
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return false;
    offsets.set(file, prev + end + 1);
    batch = new Map();
    try {
      for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
        if (line.trim()) {
          try {
            parser.handleLine(file, line, info);
          } catch (err) {
            console.warn('[transcript] line error', err);
          }
        }
      }
    } finally {
      const pending = batch;
      batch = null;
      for (const e of pending.values()) emit(e);
    }
    return left;
  }

  // meta.json / custom-title.json, read async like the jsonl (perf2: a freshly written meta.json took up to
  // 180 ms to open). One read per file at a time; a change meanwhile reads it once more afterwards.
  const smallReading = new Map(); // file -> { again, info, done }
  function readSmall(file, info) {
    const cur = smallReading.get(file);
    if (cur) {
      cur.again = true;
      cur.info = info;
      return cur.done;
    }
    const st = { again: true, info };
    smallReading.set(file, st);
    st.done = (async () => {
      try {
        while (st.again) {
          st.again = false;
          const inf = st.info;
          let j = null;
          try {
            j = JSON.parse((await fs.promises.readFile(file, 'utf8')).replace(/^﻿/, ''));
          } catch {}
          if (!j) continue;
          if (inf.type === 'meta') {
            let ts;
            if (!parser.sess(inf.sessionId).subagents.has(inf.agentId)) {
              ts = await fs.promises.stat(file).then((s) => s.birthtimeMs, () => undefined);
            }
            parser.handleMeta(file, inf, ts, j);
          } else if (inf.type === 'title') parser.handleTitleFile(file, inf, j);
        }
      } catch (err) {
        console.warn('[transcript] meta read error', err);
      } finally {
        smallReading.delete(file);
      }
    })();
    return st.done;
  }

  const ignored = (p) => {
    const b = path.basename(p);
    if (b === 'tool-results' || b === 'memory' || b === 'tasks') return true;
    if (!path.extname(b)) return false; // directories (encoded names / session ids have no dots)
    return !(b.endsWith('.jsonl') || b.endsWith('.meta.json') || b === 'custom-title.json');
  };
  // root/<project>/<session>/subagents/agent-x.jsonl -> 3 directory levels below root.
  const watcher = chokidar.watch(root, { depth: 3, ignored, ignoreInitial: false });
  let ready = false;
  watcher.on('ready', () => {
    ready = true;
  });
  const onFile = (f, isAdd) => {
    const info = classify(f);
    if (!info) return;
    if (info.type === 'main' || info.type === 'sub') {
      if (isAdd && !ready) {
        try {
          offsets.set(f, fs.statSync(f).size);
        } catch {}
      } else readNew(f, info);
    } else if (ready || !isAdd) {
      // meta.json / custom-title.json: pre-existing ones are read lazily (meta) or ignored (title).
      readSmall(f, info);
    }
  };
  watcher.on('add', (f) => onFile(f, true));
  watcher.on('change', (f) => onFile(f, false));
  watcher.on('error', (err) => console.warn('[transcript] watcher error', err));

  // Resolves when no file is being read (tests).
  const idle = async () => {
    while (reading.size || smallReading.size) await Promise.all([...reading.values(), ...smallReading.values()].map((s) => s.done));
  };
  return { watcher, parser, offsets, readNew, idle };
}

module.exports = { projectsDir, Parser, classify, promptText, teammateMessages, argSummary, findTranscript, replay, replayAgent, startWatcher, readJson };
