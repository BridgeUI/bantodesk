// Agent Teams watcher: ~/.claude/teams/<team>/config.json -> `team` assist events.
// No Electron imports (testable from plain Node). See CONTRACT.md "Agent Teams" and docs/agent-teams-plan.md.
//
// Verified on Claude Code 2.1.316 (in-process teammates):
//   config.json = { name, leadSessionId, leadProcess:{pid}, members:[{agentId:'<name>@<team>', name,
//                   agentType, color, model, prompt, cwd, joinedAt, tmuxPaneId, backendType?}] }
//   The lead is the member named 'team-lead'. The whole team folder is deleted when the team is cleaned up.
const path = require('path');
const fs = require('fs');
const os = require('os');

const teamsDir = path.join(os.homedir(), '.claude', 'teams');
const known = new Map(); // team name -> { sessionId, key, evt }

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const teamOf = (file) => path.basename(path.dirname(file));

function toEvent(team, cfg) {
  if (!cfg || typeof cfg.leadSessionId !== 'string') return null;
  const all = Array.isArray(cfg.members) ? cfg.members : [];
  const lead = all.find((m) => m && (m.name === 'team-lead' || m.agentType === 'team-lead'));
  const members = all
    .filter((m) => m && typeof m.name === 'string' && m !== lead)
    .map((m) => ({
      agentId: String(m.agentId || ''),
      name: m.name.slice(0, 60),
      agentType: typeof m.agentType === 'string' ? m.agentType : '',
      color: typeof m.color === 'string' ? m.color : '',
      model: typeof m.model === 'string' ? m.model : '',
      joinedAt: Number(m.joinedAt) || 0,
    }));
  return {
    kind: 'team',
    sessionId: cfg.leadSessionId,
    team,
    members,
    ts: new Date().toISOString(),
    ...(lead && typeof lead.cwd === 'string' ? { cwd: lead.cwd } : {}),
  };
}

function handle(file, emit) {
  const team = teamOf(file);
  const evt = toEvent(team, readJson(file));
  if (!evt) return; // partially written or not a team config; the next change event retries
  const key = JSON.stringify(evt.members);
  const prev = known.get(team);
  if (prev && prev.key === key && prev.sessionId === evt.sessionId) return;
  known.set(team, { sessionId: evt.sessionId, key, evt });
  emit(evt);
}

function removed(file, emit) {
  const team = teamOf(file);
  const prev = known.get(team);
  if (!prev) return;
  known.delete(team);
  emit({ kind: 'team', sessionId: prev.sessionId, team, members: [], removed: true, ts: new Date().toISOString() });
}

/** Current team events whose lead is `sessionId` (used by assist:replay). */
function eventsFor(sessionId) {
  return [...known.values()].filter((t) => t.sessionId === sessionId).map((t) => t.evt);
}

function startWatcher(emit, { chokidar }) {
  try {
    fs.mkdirSync(teamsDir, { recursive: true }); // Claude Code creates it on first use; watching needs it to exist
  } catch {}
  const watcher = chokidar.watch(path.join(teamsDir, '*', 'config.json'), {
    depth: 1,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  watcher.on('add', (f) => handle(f, emit));
  watcher.on('change', (f) => handle(f, emit));
  watcher.on('unlink', (f) => removed(f, emit));
  watcher.on('error', (err) => console.warn('[teams] watcher error', err));
  return watcher;
}

const TEAM_NAME_RE = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * Unread inbox messages of a team: ~/.claude/teams/<team>/inboxes/*.json are arrays of messages; counts the elements
 * whose `read` is not true. -> Promise<number>, -1 when the name is invalid or the folder / a file is missing or unreadable.
 */
async function unreadCount(team, dir = teamsDir) {
  if (typeof team !== 'string' || !TEAM_NAME_RE.test(team) || team === '.' || team === '..') return -1;
  const inboxes = path.join(dir, team, 'inboxes');
  let names;
  try {
    names = (await fs.promises.readdir(inboxes)).filter((n) => n.toLowerCase().endsWith('.json'));
  } catch {
    return -1;
  }
  let n = 0;
  for (const name of names) {
    let arr;
    try {
      arr = JSON.parse(await fs.promises.readFile(path.join(inboxes, name), 'utf8'));
    } catch {
      return -1; // partially written: the caller asks again later
    }
    if (!Array.isArray(arr)) return -1;
    for (const m of arr) if (!m || m.read !== true) n++;
  }
  return n;
}

module.exports = { startWatcher, eventsFor, toEvent, teamsDir, unreadCount, TEAM_NAME_RE };
