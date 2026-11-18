'use strict';
// 全体図 (roadmap 14, docs/plan-overview-map.md 第 1 段): a pure function that regroups what the app already holds
// (sessions, inbox, backlogs, PROGRESS.md rows, the ルーターの記録) by purpose. No LLM, no process / network reading,
// no Electron imports (plain Node tests: tmp/overview-map/unit.js).
//
// buildOverview({ sessions, inbox, backlogs, projects, progressByFolder, log, now }) ->
//   { flow: { intake, routed, working, turn, doneToday: { n, names[≤3] } },
//     router: { busy, nudges },
//     folders: [{ name, folder, quiet, queued, progress: { done, total, counts } | null,
//                 goals: [{ no, title, state, drift, works[] }], loose: works[] }],
//     updatedAt }
//   work = { id, no, title, status: 'active'|'pending'|'done'|'failed', req, startedAt, doneAt, drift,
//            who: { session: { wcId, tabId, label, st, contextPct, doing } | null, members: [{ name, st }], subagents, cmds } }
// The link between a PROGRESS row and a work is made only by the leading number of a heading (/^(\d+[a-z]?)\s/) and the
// request's origin (the backlog item a proposal came from); a work that cannot be linked goes to `loose` (not hidden).

const HEAD_RE = /^(\d+[a-z]?)\s/i;
const NAMES_MAX = 3;
const DONE_SHOWN = 4; // finished works shown per folder (today's, newest first)
const NUDGE_MS = 10 * 60 * 1000;

const headOf = (t) => {
  const m = HEAD_RE.exec(String(t || '').trim());
  return m ? m[1].toLowerCase() : '';
};
const one = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
const startOfDay = (now) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// the same words as agents-view.js sessSt: wait (要対応) | err | run | idle | done
function sessionState(s) {
  if (s.attention === 'input') return 'wait';
  if (s.attention === 'error') return 'err';
  if (s.finished || s.rest) return 'done';
  if (s.status === 'running' || s.status === 'starting' || s.working) return 'run';
  return 'idle';
}
const agentState = (st) => (st === 'running' || st === 'starting' ? 'run' : st === 'error' ? 'err' : st === 'idle' ? 'idle' : 'done');

function whoOf(s) {
  if (!s) return { session: null, members: [], subagents: 0, cmds: 0 };
  const ag = s.agents || {};
  const team = ag.team && !ag.team.removed ? ag.team : null;
  return {
    session: { wcId: s.wcId, tabId: s.tabId, label: one(s.label, 60), st: sessionState(s), contextPct: Number.isFinite(s.contextPct) ? s.contextPct : null, doing: one(s.doing, 80) },
    members: team ? team.members.slice(0, 8).map((m) => ({ name: one(m.name, 30), st: agentState(m.status) })) : [],
    subagents: (ag.subagents || []).filter((x) => x.status === 'running' || x.status === 'starting').length,
    cmds: (s.cmds || []).filter((c) => c.status === 'running').length,
  };
}

function buildOverview({ sessions, inbox, backlogs, projects, progressByFolder, log, now } = {}) {
  now = Number.isFinite(now) ? now : Date.now();
  sessions = Array.isArray(sessions) ? sessions : [];
  inbox = Array.isArray(inbox) ? inbox : [];
  backlogs = backlogs && typeof backlogs === 'object' ? backlogs : {};
  projects = Array.isArray(projects) ? projects : [];
  progressByFolder = progressByFolder && typeof progressByFolder === 'object' ? progressByFolder : {};
  log = Array.isArray(log) ? log : [];
  const today = startOfDay(now);

  const isRouter = (s) => s.folderName === 'ダッシュボード';
  const sessOf = (folder, tabId) => (tabId ? sessions.find((s) => !isRouter(s) && String(s.tabId) === String(tabId) && norm(s.folder) === norm(folder)) : null) || null;
  // the request that was routed to this backlog item (its AT-n in this folder)
  const inboxOf = (folder, no) => inbox.find((i) => no && i.no === no && norm(i.folder) === norm(folder)) || null;

  // folders: every folder of projects.json, every backlog, every window's sessions (no router tab)
  const order = [];
  const names = new Map();
  const add = (folder, name) => {
    const k = norm(folder);
    if (!k) return;
    if (!names.has(k)) {
      names.set(k, { folder, name: name || baseName(folder) });
      order.push(k);
    }
  };
  for (const p of projects) if (p && p.folder) add(p.folder, p.name);
  for (const f of Object.keys(backlogs)) add(f);
  for (const s of sessions) if (!isRouter(s) && s.folder) add(s.folder, s.folderName);

  const flowIntake = [];
  const flowRouted = [];
  const flowWorking = [];
  const flowDone = [];
  const folders = [];
  for (const k of order) {
    const { folder, name } = names.get(k);
    const bkey = Object.keys(backlogs).find((f) => norm(f) === k);
    const items = (bkey && Array.isArray(backlogs[bkey]) ? backlogs[bkey] : []).filter((i) => i && i.status !== 'dropped');
    const pkey = Object.keys(progressByFolder).find((f) => norm(f) === k);
    const prog = pkey ? progressByFolder[pkey] : null;
    const rows = prog && Array.isArray(prog.rows) ? prog.rows : [];
    const rowOf = (n) => rows.find((r) => String(r.n).toLowerCase() === n) || null;

    // which PROGRESS number a work belongs to: its own heading, else the heading of the backlog item its request came from
    // (origin), else the request's own heading
    const goalNo = (it, req) => {
      let n = headOf(it.title) || headOf(it.text);
      if (n) return n;
      if (req) {
        const ob = req.origin && req.origin.backlogId ? findItem(req.origin.folder, req.origin.backlogId) : null;
        n = (ob && (headOf(ob.title) || headOf(ob.text))) || headOf(req.title) || headOf(req.text);
        if (n) return n;
      }
      return '';
    };
    const findItem = (f, id) => {
      const key = Object.keys(backlogs).find((x) => norm(x) === norm(f));
      return key ? (backlogs[key] || []).find((i) => i && i.id === id) || null : null;
    };

    const works = [];
    let queued = 0;
    for (const it of items) {
      const status = it.status;
      const doneToday = status === 'done' && Number.isFinite(it.doneAt) && it.doneAt >= today;
      if (status === 'pending') {
        queued++;
        continue;
      }
      if (status === 'done' && !doneToday) continue;
      if (status !== 'active' && status !== 'done' && status !== 'failed') continue;
      if (status === 'failed' && !(Number.isFinite(it.doneAt) && it.doneAt >= today)) continue;
      const req = it.no ? inboxOf(folder, it.no) : null;
      const s = status === 'active' ? sessOf(folder, it.tabId) : null;
      works.push({
        id: it.id,
        no: it.no || '',
        title: one(it.title || it.text, 80),
        status,
        req: req ? req.reqNo || '' : '',
        startedAt: Number.isFinite(it.startedAt) ? it.startedAt : 0,
        doneAt: Number.isFinite(it.doneAt) ? it.doneAt : 0,
        drift: '',
        who: whoOf(s),
        _goal: goalNo(it, req),
      });
    }
    // finished ones: only the newest few
    const fin = works.filter((w) => w.status !== 'active').sort((a, b) => b.doneAt - a.doneAt);
    const keepFin = new Set(fin.slice(0, DONE_SHOWN));
    const shown = works.filter((w) => w.status === 'active' || keepFin.has(w));
    for (const w of shown) {
      if (w.status === 'active' && !w.who.session) w.drift = 'no-owner'; // 進行中なのに担当なし
    }

    // goals
    const goals = [];
    const loose = [];
    const byNo = new Map();
    for (const w of shown) {
      const row = w._goal ? rowOf(w._goal) : null;
      if (!row) {
        loose.push(w);
        continue;
      }
      let g = byNo.get(w._goal);
      if (!g) {
        g = { no: row.n, title: row.item, state: row.state, drift: '', works: [] };
        byNo.set(w._goal, g);
        goals.push(g);
      }
      g.works.push(w);
    }
    for (const g of goals) {
      // a work is moving but PROGRESS says 未着手 / 完了
      if ((g.state === '未着手' || g.state === '完了') && g.works.some((w) => w.status === 'active')) g.drift = 'progress-stale';
    }
    goals.sort((a, b) => (parseInt(a.no, 10) || 0) - (parseInt(b.no, 10) || 0));
    for (const w of shown) delete w._goal;

    // flow
    for (const w of shown) {
      if (w.status === 'active') flowWorking.push(w.title || w.no);
      else if (w.status === 'done') flowDone.push(w.title || w.no);
    }
    const counts = prog && prog.counts ? { ...prog.counts } : null;
    folders.push({
      name,
      folder,
      quiet: shown.length === 0,
      queued,
      progress: prog ? { done: prog.done || 0, total: prog.total || rows.length, counts } : null,
      goals,
      loose,
    });
  }
  folders.sort((a, b) => Number(a.quiet) - Number(b.quiet) || b.goals.length + b.loose.length - (a.goals.length + a.loose.length));

  // flow of requests
  const openBacklog = (req) => {
    const f = req.folder;
    const key = f ? Object.keys(backlogs).find((x) => norm(x) === norm(f)) : null;
    return key && req.no ? (backlogs[key] || []).find((i) => i && i.no === req.no) || null : null;
  };
  for (const r of inbox) {
    if (r.status === 'new' || r.status === 'asking') flowIntake.push(r.title || r.reqNo);
    else if (r.status === 'routed') {
      const b = openBacklog(r);
      if (!b || b.status === 'pending') flowRouted.push(r.title || r.reqNo);
    }
  }
  const part = (list) => ({ n: list.length, names: list.slice(0, NAMES_MAX).map((x) => one(x, 40)) });
  const turnList = sessions.filter((s) => !isRouter(s) && (s.attention === 'input' || s.attention === 'error')).map((s) => s.label || s.folderName);
  const nudges = log.filter((e) => {
    const t = Date.parse(e && e.at);
    return Number.isFinite(t) && now - t <= NUDGE_MS && /nudge|interrupt|answer/.test(String(e.action || e.kind || ''));
  }).length;

  return {
    flow: { intake: part(flowIntake), routed: part(flowRouted), working: part(flowWorking), turn: part(turnList), doneToday: part(flowDone) },
    router: { busy: sessions.some((s) => isRouter(s) && (s.status === 'running' || s.working)), nudges },
    folders,
    updatedAt: now,
  };
}

module.exports = { buildOverview, headOf, HEAD_RE };
