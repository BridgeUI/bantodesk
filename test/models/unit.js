// Unit checks for AT-6 (default model claude-opus-5-5 / effort medium for every claude start; the ルーター picks another per
// routed item): src/main/models.js, claude-cmd buildClaudeArgs / buildClaudeCmd / launchSpec, backlog / sessions keep the
// fields, manager route / create check and store them, projects.json pendingItems, the ルーター CLAUDE.md template, the mark
// on the screens (labels.modelMark). No Electron, no claude.  Run: node tmp/models/unit.js
// AT_APP_ROOT = another app folder (e.g. the stable copy after a release): its src is tested
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.resolve(__dirname, '..', '..');
const models = require(path.join(ROOT, 'src/main/models'));
const claudeCmd = require(path.join(ROOT, 'src/main/claude-cmd'));
const backlog = require(path.join(ROOT, 'src/main/backlog'));
const sessions = require(path.join(ROOT, 'src/main/sessions'));
const manager = require(path.join(ROOT, 'src/main/manager'));
const Labels = require(path.join(ROOT, 'src/renderer/labels'));

let pass = 0;
let fail = 0;
const ok = (name, c, ev) => {
  c ? pass++ : fail++;
  console.log(c ? 'PASS' : 'FAIL', name, ev !== undefined && !c ? JSON.stringify(ev).slice(0, 400) : '');
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sp2 = (d) => ({ session: d.session, pmo: d.pmo }); // MODEL-KIND: kinds are checked in tmp/model-kind/unit.js
const after = (args, flag) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};

(async () => {
  // --- models.js: defaults and checks ---------------------------------------------------------------------
  ok('built-in default is claude-opus-5-5 / medium', models.DEFAULT_MODEL === 'claude-opus-5-5' && models.DEFAULT_EFFORT === 'medium');
  ok('efforts are low / medium / high / xhigh / max', same(models.EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']));
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'opus', 'sonnet', 'fable', 'haiku', 'opus[1m]', 'claude-sonnet-5-5-20261001', 'a.b_c-d']) ok(`model ok: ${m}`, models.isModel(m));
  const badModels = ['', ' ', ' opus', 'opus ', '-opus', '--model', 'op us', 'opus;rm', 'opus"', "opus'", 'opus$X', 'a/b', 'a\\b', 'x'.repeat(65), 'opus[1m', 'opus[]', null, 5, {}, ['opus']];
  for (const m of badModels) ok(`model refused: ${JSON.stringify(m)}`, !models.isModel(m));
  for (const e of models.EFFORTS) ok(`effort ok: ${e}`, models.isEffort(e));
  for (const e of ['', 'Medium', 'HIGH', 'ultra', 'none', 'auto', null, 3]) ok(`effort refused: ${JSON.stringify(e)}`, !models.isEffort(e));

  // fromSettings: missing / bad -> built-in default; session and ルーター separate
  const D = { model: 'claude-opus-5-5', effort: 'medium' };
  ok('fromSettings(null) = defaults for both', same(sp2(models.fromSettings(null)), { session: D, pmo: D }));
  ok('fromSettings({}) = defaults', same(sp2(models.fromSettings({ workRoot: '/x' })), { session: D, pmo: D }));
  ok('fromSettings reads both', same(sp2(models.fromSettings({ claudeModel: 'sonnet', claudeEffort: 'low', pmoModel: 'claude-opus-5-5', pmoEffort: 'high' })), { session: { model: 'sonnet', effort: 'low' }, pmo: { model: 'claude-opus-5-5', effort: 'high' } }));
  ok('fromSettings: bad values -> default', same(sp2(models.fromSettings({ claudeModel: 'bad model', claudeEffort: 'ultra', pmoModel: '', pmoEffort: 7 })), { session: D, pmo: D }));

  // settingsPatch (the ⚙ screen)
  ok('settingsPatch: values', same(models.settingsPatch({ claudeModel: ' sonnet ', claudeEffort: 'high' }).fields, { claudeModel: 'sonnet', claudeEffort: 'high' }));
  const clr = models.settingsPatch({ claudeModel: '', pmoEffort: null }).fields;
  ok("settingsPatch: '' / null = back to the default (undefined)", 'claudeModel' in clr && clr.claudeModel === undefined && 'pmoEffort' in clr && clr.pmoEffort === undefined);
  ok('settingsPatch: bad model refused', /bad model/.test(models.settingsPatch({ pmoModel: 'a b' }).error || ''));
  ok('settingsPatch: bad effort refused', /bad effort/.test(models.settingsPatch({ claudeEffort: 'turbo' }).error || ''));
  ok('settingsPatch: unknown keys ignored', same(models.settingsPatch({ workRoot: '/x' }).fields, {}));

  // pick: own value wins when valid, else the role's default
  const defs = models.fromSettings({ claudeModel: 'sonnet', claudeEffort: 'low', pmoModel: 'opus', pmoEffort: 'high' });
  ok('pick: session default', same(models.pick(defs, 'project', null), { model: 'sonnet', effort: 'low' }));
  ok('pick: manager = ルーター default', same(models.pick(defs, 'manager', {}), { model: 'opus', effort: 'high' }));
  ok('pick: own values win', same(models.pick(defs, 'project', { model: 'haiku', effort: 'max' }), { model: 'haiku', effort: 'max' }));
  ok('pick: only own effort', same(models.pick(defs, 'project', { effort: 'xhigh' }), { model: 'sonnet', effort: 'xhigh' }));
  ok('pick: bad own values -> default', same(models.pick(defs, 'project', { model: 'x y', effort: 'ultra' }), { model: 'sonnet', effort: 'low' }));

  // actionHints (route / create)
  ok('actionHints: none -> no fields', same(models.actionHints({}).fields, {}) && same(models.actionHints({ model: null, effort: null }).fields, {}));
  ok('actionHints: both', same(models.actionHints({ model: 'claude-sonnet-5-5', effort: 'high' }).fields, { model: 'claude-sonnet-5-5', effort: 'high' }));
  for (const [a, re] of [[{ model: '' }, /bad model/], [{ model: 'a b' }, /bad model/], [{ model: 5 }, /bad model/], [{ effort: 'ultra' }, /bad effort/], [{ effort: '' }, /bad effort/], [{ effort: 'HIGH' }, /bad effort/]]) {
    ok(`actionHints refused: ${JSON.stringify(a)}`, re.test(models.actionHints(a).error || ''));
  }

  // --- claude-cmd: the arguments --------------------------------------------------------------------------
  const id = '11111111-2222-4333-8444-555555555555';
  let a = claudeCmd.buildClaudeArgs({ mode: 'new', id, model: 'claude-opus-5-5', effort: 'medium' });
  ok('new: --model claude-opus-5-5 --effort medium', after(a, '--model') === 'claude-opus-5-5' && after(a, '--effort') === 'medium' && after(a, '--session-id') === id, a);
  a = claudeCmd.buildClaudeArgs({ mode: 'resume', id, model: 'sonnet', effort: 'high', settingsPath: '/s.json', appendPrompt: 'p' });
  ok('resume: same model / effort with --resume', after(a, '--model') === 'sonnet' && after(a, '--effort') === 'high' && after(a, '--resume') === id && after(a, '--settings') === '/s.json', a);
  a = claudeCmd.buildClaudeArgs({ mode: 'new', id });
  ok('no model / effort given -> no flags (claudeLaunch always gives them)', !a.includes('--model') && !a.includes('--effort'), a);
  a = claudeCmd.buildClaudeArgs({ mode: 'new', id, model: '--dangerously-skip-permissions', effort: 'ultra' });
  ok('bad values never reach the command line', !a.includes('--model') && !a.includes('--effort') && !a.includes('--dangerously-skip-permissions'), a);
  a = claudeCmd.buildClaudeArgs({ mode: 'new', id, model: 'opus', effort: 'low', team: true, worktree: 'w1' });
  ok('model / effort with team + worktree', after(a, '--model') === 'opus' && after(a, '--effort') === 'low' && a.includes('--teammate-mode') && after(a, '--worktree') === 'w1', a);
  const cmd = claudeCmd.buildClaudeCmd({ mode: 'new', id, model: 'opus[1m]', effort: 'high' });
  ok("shell command: --model quoted ('opus[1m]' is no glob), --effort plain", cmd.includes("--model 'opus[1m]'") && cmd.includes('--effort high'), cmd);

  // launchSpec: every kind passes them
  const claude = { mode: 'new', id, model: 'claude-opus-5-5', effort: 'medium' };
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'at6-bin-'));
  const fake = path.join(bin, 'claude');
  fs.writeFileSync(fake, '#!/bin/sh\n');
  fs.chmodSync(fake, 0o755);
  let sp = claudeCmd.launchSpec({ claude, env: { PATH: bin, HOME: '/nonexistent' }, platform: 'darwin' });
  ok('posix direct: argv has --model / --effort', sp.kind === 'direct' && sp.file === fake && after(sp.args, '--model') === 'claude-opus-5-5' && after(sp.args, '--effort') === 'medium', sp);
  sp = claudeCmd.launchSpec({ claude, env: { PATH: '/nonexistent-dir', HOME: '/nonexistent' }, platform: 'linux' });
  ok('posix not found (fallback): argv has them', after(sp.args, '--model') === 'claude-opus-5-5', sp);
  sp = claudeCmd.launchSpec({ claude, env: { PATH: '', COMSPEC: 'cmd.exe' }, platform: 'win32' });
  ok('win32 fallback: cmd line has "--model" "claude-opus-5-5" "--effort" "medium"', sp.kind === 'fallback' && sp.args.includes('"--model" "claude-opus-5-5"') && sp.args.includes('"--effort" "medium"'), sp);
  sp = claudeCmd.launchSpec({ shell: 'powershell.exe', claude, env: {}, platform: 'win32' });
  ok("win32 shell: --model 'claude-opus-5-5' --effort medium", sp.kind === 'shell' && sp.args[3].includes("--model 'claude-opus-5-5' --effort medium"), sp);
  sp = claudeCmd.launchSpec({ override: 'node fake.js', claude, env: {}, platform: 'darwin' });
  ok('override (tests): the command replaces claude (unchanged behaviour)', sp.kind === 'override' && !JSON.stringify(sp.args).includes('--model'), sp);
  fs.rmSync(bin, { recursive: true, force: true });

  // --- sessions.json and backlog keep the fields --------------------------------------------------------------
  const st = sessions.sanitizeTabs([
    { id, label: 'x', cwd: '/w', model: 'sonnet', effort: 'high', delegate: true },
    { id: '11111111-2222-4333-8444-555555555556', label: 'y', cwd: '/w', model: 'a b', effort: 'ultra' },
    { id: '11111111-2222-4333-8444-555555555557', label: 'z', cwd: '/w' },
  ]);
  ok('sessions: model / effort kept', st[0].model === 'sonnet' && st[0].effort === 'high', st[0]);
  ok('sessions: bad values dropped', !('model' in st[1]) && !('effort' in st[1]), st[1]);
  ok('sessions: none -> no keys', !('model' in st[2]) && !('effort' in st[2]), st[2]);

  const base = (x = {}) => ({ id: 'a1', text: 't', tabId: null, status: 'pending', createdAt: 1, startedAt: null, doneAt: null, note: '', ...x });
  ok('backlog: no model -> same shape as before', same(Object.keys(backlog.sanitizeItem(base())), ['id', 'text', 'tabId', 'status', 'createdAt', 'startedAt', 'doneAt', 'note']));
  const bi = backlog.sanitizeItem(base({ model: 'claude-sonnet-5-5', effort: 'low' }));
  ok('backlog: model / effort kept', bi.model === 'claude-sonnet-5-5' && bi.effort === 'low', bi);
  const bb = backlog.sanitizeItem(base({ model: '', effort: 'ultra' }));
  ok('backlog: bad values dropped', !('model' in bb) && !('effort' in bb), bb);

  // --- route / create -------------------------------------------------------------------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'at6-'));
  const bdir = path.join(tmp, 'backlog');
  const folder = path.join(tmp, 'proj');
  fs.mkdirSync(folder);
  const real = fs.realpathSync.native(folder);
  const inbox = {
    items: [],
    find: (x) => inbox.items.find((i) => i.id === x) || null,
    get: () => ({ items: inbox.items }),
    add: (o) => {
      const it = { id: `i${inbox.items.length + 1}`, status: 'new', ...o };
      inbox.items.push(it);
      return it;
    },
    update: (x, patch) => Object.assign(inbox.find(x) || {}, patch),
  };
  const routed = [];
  const ctx = { inbox, backlogDir: bdir, userData: path.join(tmp, 'ud'), workRoot: path.join(tmp, 'work'), onRouted: (f, it) => routed.push(it) };
  const items = async () => (await backlog.getBacklog(bdir, real)).items;

  let res = await manager.processActions({ type: 'route', itemId: null, folder: real, text: 'plain' }, ctx);
  let its = await items();
  ok('route without model / effort: nothing stored (the default applies at start)', res.ok && !('model' in its[0]) && !('effort' in its[0]) && !('model' in res.results[0]), { res, its });

  res = await manager.processActions({ type: 'route', itemId: null, folder: real, text: 'heavy', model: 'claude-opus-5-5', effort: 'high', kind: 'research' }, ctx);
  its = await items();
  const hv = its.find((i) => i.text === 'heavy');
  ok('route with model / effort ok', res.ok, res.errors);
  ok('stored on the backlog item', hv && hv.model === 'claude-opus-5-5' && hv.effort === 'high' && hv.kind === 'research', hv);
  ok('in the result', res.results[0].model === 'claude-opus-5-5' && res.results[0].effort === 'high', res.results[0]);
  ok('onRouted (the window copy) carries them', routed.at(-1).model === 'claude-opus-5-5' && routed.at(-1).effort === 'high');

  res = await manager.processActions({ type: 'route', itemId: null, folder: real, text: 'light', effort: 'low' }, ctx);
  ok('effort only', res.ok && (await items()).find((i) => i.text === 'light').effort === 'low' && !('model' in (await items()).find((i) => i.text === 'light')), res.errors);
  res = await manager.processActions({ type: 'route', itemId: null, folder: real, text: 'nulls', model: null, effort: null }, ctx);
  ok('null = not given', res.ok && !('model' in (await items()).find((i) => i.text === 'nulls')), res.errors);

  const before = (await items()).length;
  for (const [extra, re] of [
    [{ model: '' }, /bad model/],
    [{ model: '   ' }, /bad model/],
    [{ model: 'opus; echo' }, /bad model/],
    [{ model: '--settings' }, /bad model/],
    [{ model: 7 }, /bad model/],
    [{ effort: 'ultra' }, /bad effort/],
    [{ effort: 'Medium' }, /bad effort/],
    [{ effort: '' }, /bad effort/],
    [{ effort: 2 }, /bad effort/],
  ]) {
    const r = await manager.processActions({ type: 'route', itemId: null, folder: real, text: 'bad', ...extra }, ctx);
    ok(`route refused: ${JSON.stringify(extra)}`, !r.ok && re.test(r.errors[0]), r.errors);
  }
  ok('refused routes added nothing', (await items()).length === before);
  const nIn = inbox.items.length;
  await manager.processActions({ type: 'route', itemId: null, folder: real, text: 'bad', inbox: true, effort: 'x' }, ctx);
  ok('refused route with inbox:true adds no inbox item', inbox.items.length === nIn);

  res = await manager.processActions({ type: 'create', itemId: null, name: 'at6-new', text: 'new work', model: 'sonnet', effort: 'xhigh' }, ctx);
  const cIt = res.ok ? (await backlog.getBacklog(bdir, res.results[0].folder)).items : [];
  ok('create with model / effort', res.ok && cIt[0] && cIt[0].model === 'sonnet' && cIt[0].effort === 'xhigh', { res, cIt });
  fs.mkdirSync(path.join(tmp, 'work'), { recursive: true });
  const wBefore = fs.readdirSync(path.join(tmp, 'work')).length;
  res = await manager.processActions({ type: 'create', itemId: null, name: 'at6-bad', text: 'x', effort: 'turbo' }, ctx);
  ok('create refused before making a folder', !res.ok && /bad effort/.test(res.errors[0]) && fs.readdirSync(path.join(tmp, 'work')).length === wBefore, res.errors);

  // outbox file -> failed/ + .error.txt
  const mgrDir = path.join(tmp, 'mgr');
  const outbox = path.join(mgrDir, 'outbox');
  fs.mkdirSync(outbox, { recursive: true });
  const badFile = path.join(outbox, '20261113-000000-route.json');
  fs.writeFileSync(badFile, JSON.stringify({ type: 'route', itemId: null, folder: real, text: 'x', effort: 'ultra' }));
  await manager.processOutboxFile(badFile, ctx);
  const failedDir = path.join(outbox, 'failed');
  const errTxt = fs.existsSync(failedDir) ? fs.readdirSync(failedDir).filter((f) => f.endsWith('.error.txt')) : [];
  ok('outbox: bad effort -> outbox/failed/ with .error.txt naming it', errTxt.length === 1 && /bad effort/.test(fs.readFileSync(path.join(failedDir, errTxt[0]), 'utf8')), errTxt);

  // --- projects.json pendingItems ---------------------------------------------------------------------------------
  let pr = await manager.buildProjects({ recent: [real], managerDir: mgrDir, backlogDir: bdir });
  let pi = pr[0].pendingItems;
  const pPlain = pi.find((i) => i.text === 'plain');
  const pHeavy = pi.find((i) => i.text === 'heavy');
  const pLight = pi.find((i) => i.text === 'light');
  ok('pendingItems: plain item shows the default (opus 5.5 / medium), no modelOwn', pPlain.model === 'claude-opus-5-5' && pPlain.effort === 'medium' && !pPlain.modelOwn, pPlain);
  ok('pendingItems: own values + modelOwn', pHeavy.model === 'claude-opus-5-5' && pHeavy.effort === 'high' && pHeavy.modelOwn === true, pHeavy);
  ok('pendingItems: effort only -> default model + own effort', pLight.model === 'claude-opus-5-5' && pLight.effort === 'low' && pLight.modelOwn === true, pLight);
  pr = await manager.buildProjects({ recent: [real], managerDir: mgrDir, backlogDir: bdir, modelDefaults: models.fromSettings({ claudeModel: 'sonnet', claudeEffort: 'low' }) });
  pi = pr[0].pendingItems;
  ok('pendingItems follow the settings default', pi.find((i) => i.text === 'plain').model === 'sonnet' && pi.find((i) => i.text === 'plain').effort === 'low' && pi.find((i) => i.text === 'heavy').model === 'claude-opus-5-5');

  // --- ルーター CLAUDE.md template ------------------------------------------------------------------------------------
  const mgr = path.join(tmp, 'mgr2');
  fs.mkdirSync(mgr, { recursive: true });
  fs.writeFileSync(path.join(mgr, 'CLAUDE.md'), `<!-- agent-terminal manager v21 -->\nold\n${manager.USER_MARKER}\nmine\n`);
  ok('v21 CLAUDE.md is rewritten', manager.ensureManagerDir(mgr) === true);
  const md = fs.readFileSync(path.join(mgr, 'CLAUDE.md'), 'utf8');
  ok(`template version ${manager.CLAUDE_MD_VERSION} (>= 22)`, manager.CLAUDE_MD_VERSION >= 22 && md.startsWith(`<!-- bantodesk manager v${manager.CLAUDE_MD_VERSION} -->`));
  ok('user text below the marker kept', md.trimEnd().endsWith('mine'));
  ok('template: model / effort section', md.includes('## モデルと effort（model / effort）') && md.includes('"model": "<モデル名>"') && md.includes('"effort": "low|medium|high|xhigh|max"'));
  ok('template: default named', md.includes('claude-opus-5-5') && md.includes('medium'));
  ok('template: when to use (default / high / low, the reason in note)', md.includes('既定で足りる') && md.includes('"effort": "high"') && md.includes('"effort": "low"') && md.includes('理由を note'));
  ok('template: failed + .error.txt on bad values', /effort が 5 つ以外[\s\S]{0,80}failed/.test(md));
  ok('template: outbox list mentions model / effort', md.includes('route / create には \\`"model"\\`'.replace(/\\`/g, '`')));
  ok('template: pendingItems lists model / effort / modelOwn', md.includes('after, model, effort, modelOwn, blocked'));

  // --- the small mark on the screens ----------------------------------------------------------------------------
  const dflt = { model: 'claude-opus-5-5', effort: 'medium' };
  let mm = Labels.modelMark({}, dflt);
  ok('mark: default', mm && mm.text === 'opus-5-5 · medium' && mm.own === false && /既定/.test(mm.title), mm);
  mm = Labels.modelMark({ model: 'claude-sonnet-5-5', effort: 'high' }, dflt);
  ok('mark: own', mm.text === 'sonnet-5-5 · high' && mm.own === true && /ルーターの指定/.test(mm.title), mm);
  mm = Labels.modelMark({ effort: 'low' }, null);
  ok('mark: own effort without defaults', mm.text === 'low' && mm.own === true, mm);
  ok('mark: nothing known -> null', Labels.modelMark({}, null) === null);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
