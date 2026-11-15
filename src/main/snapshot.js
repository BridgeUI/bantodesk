// UX6 (docs/ux-journey.md §6, docs/mac-polish.md J2): dashboard:snapshot, one invoke for the dashboard's refresh
// instead of ~19 + 2N. It runs the read-only invoke handlers main registered (the original functions, recorded when
// ipcMain.handle was called; not ipcMain._invokeHandlers, which the perf tests wrap to count IPC) and answers
// { sig, same: true } in place of a value the caller already has.
//
// Request: { calls: { [name]: [channel, arg?] }, sigs?: { [name]: string } }
// Reply:   { [name]: { sig, value } | { sig, same: true } | { error: string } }
const crypto = require('node:crypto');

// The dashboard's refresh reads (preload name -> channel). Only these channels may be called.
const CHANNELS = Object.freeze({
  inboxGet: 'inbox:get',
  dashboardSessions: 'dashboard:sessions',
  dashboardWorkRoot: 'dashboard:workRoot',
  modelsGet: 'models:get',
  waitSettings: 'waits:settings',
  dashboardStale: 'dashboard:stale',
  qaList: 'qa:list',
  noticesList: 'notices:list',
  pmoLog: 'pmo:log',
  schedState: 'sched:state',
  procLeftovers: 'proc:leftovers',
  remoteGetStatus: 'remote:getStatus',
  pickerList: 'picker:list',
  dashboardProjects: 'dashboard:projects',
  backlogGetFolder: 'backlog:getFolder',
  dashboardProgress: 'dashboard:progress',
  queueOrder: 'queue:order',
  attentionList: 'attention:list',
});
const ALLOWED = new Set(Object.values(CHANNELS));
const MAX_CALLS = 80;
const NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

// Short content signature of a value (what the renderer keeps to skip unchanged parts).
function sigOf(value) {
  const json = JSON.stringify(value);
  return crypto.createHash('sha1').update(json === undefined ? 'undefined' : json).digest('hex').slice(0, 16);
}

// o: { allowed?: Iterable<string>, max?: number }
function create(o = {}) {
  const allowed = o.allowed ? new Set(o.allowed) : ALLOWED;
  const max = o.max || MAX_CALLS;
  const handlers = new Map(); // channel -> the original handler fn

  // Wrap ipcMain.handle / removeHandler so every handler registered from now on is recorded; both keep working as before.
  function record(ipcMain) {
    if (!ipcMain || ipcMain.__snapshotRecorded) return;
    const handle = ipcMain.handle.bind(ipcMain);
    const remove = typeof ipcMain.removeHandler === 'function' ? ipcMain.removeHandler.bind(ipcMain) : null;
    ipcMain.handle = (channel, fn) => {
      const r = handle(channel, fn); // throws on a second handler, as before (then nothing is recorded)
      handlers.set(channel, fn);
      return r;
    };
    if (remove) {
      ipcMain.removeHandler = (channel) => {
        handlers.delete(channel);
        return remove(channel);
      };
    }
    Object.defineProperty(ipcMain, '__snapshotRecorded', { value: true });
  }

  async function one(e, call, known) {
    if (!Array.isArray(call) || typeof call[0] !== 'string') return { error: 'bad call' };
    const channel = call[0];
    const fn = allowed.has(channel) ? handlers.get(channel) : null;
    if (!fn) return { error: 'not allowed' };
    try {
      const value = await (call.length > 1 ? fn(e, call[1]) : fn(e));
      const sig = sigOf(value);
      return known === sig ? { sig, same: true } : { sig, value };
    } catch (err) {
      return { error: String((err && err.message) || err || 'failed') };
    }
  }

  // Runs the calls in parallel, each with the caller's event.
  async function run(e, req) {
    const calls = req && typeof req.calls === 'object' && req.calls ? req.calls : {};
    const sigs = req && typeof req.sigs === 'object' && req.sigs ? req.sigs : {};
    const out = {};
    const all = Object.keys(calls).filter((n) => n !== '__proto__');
    // a name main does not take is answered with an error (not dropped: the caller must not read it as 「unchanged」)
    for (const n of all) if (!NAME_RE.test(n)) out[n] = { error: 'bad name' };
    const names = all.filter((n) => NAME_RE.test(n));
    await Promise.all(names.map(async (name, i) => {
      const known = Object.prototype.hasOwnProperty.call(sigs, name) && typeof sigs[name] === 'string' ? sigs[name] : null;
      out[name] = i < max ? await one(e, calls[name], known) : { error: 'too many calls' };
    }));
    return out;
  }

  return { record, run, handlers };
}

module.exports = { create, sigOf, CHANNELS, ALLOWED, MAX_CALLS };
