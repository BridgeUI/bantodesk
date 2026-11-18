// Model and effort of every claude the app starts (AT-6). No Electron imports (plain Node tests use it too).
// Passed as claude's own options --model <model> --effort <level> (Claude Code 2.1.316 `claude --help`), on every start
// and on --resume too, so a session keeps its model after a restart:
//   - not the settings file (--settings): one file for every tab, so it cannot differ per routed item;
//   - not ANTHROPIC_MODEL / CLAUDE_EFFORT: env reaches the tools' child processes too (CLAUDE_EFFORT of the parent
//     claude is already removed from a tab's env, src/main.js INHERITED_SESSION_ENV).
// Defaults: userData/manager-settings.json { claudeModel, claudeEffort, pmoModel, pmoEffort }; missing or bad ->
// claude-opus-5-5 / medium. A routed item may carry its own { model, effort } (the ルーター's route / create action).
// MODEL-KIND (依頼-476): a routed item's session also has a default by its kind (research / implement / verify), so
// ordinary work runs on sonnet: manager-settings.json { implementModel, implementEffort, verifyModel, ... }, missing or
// bad -> KIND_DEFAULTS. Order per field: the item's own > the default of its kind > the session default (no kind).

const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_EFFORT = 'medium';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const KINDS = ['research', 'implement', 'verify'];
// built-in defaults by kind (Opus 5.5 $4/$20 per MTok, Sonnet 5.5 $2/$10: src/renderer/pricing.js)
const KIND_DEFAULTS = {
  research: { model: 'claude-opus-5-5', effort: 'medium' }, // 調べもの・設計・原因の分からない不具合（重いものは route で high）
  implement: { model: 'claude-sonnet-5-5', effort: 'medium' }, // ふつうの実装
  verify: { model: 'claude-sonnet-5-5', effort: 'low' }, // 動作確認・機械的な直し
};
// a full model name (claude-opus-5-5, claude-sonnet-5-5-20261001) or an alias (opus, sonnet, fable, haiku, opus[1m]):
// letters, digits, . _ - and one trailing [..] suffix, ≤ 80 chars, no spaces / quotes / leading dash (it goes on the
// command line as one argument after --model)
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\[[A-Za-z0-9]{1,8}\])?$/;

const isModel = (v) => typeof v === 'string' && MODEL_RE.test(v);
const isEffort = (v) => typeof v === 'string' && EFFORTS.includes(v);

// The defaults from manager-settings.json (any object; bad / missing values -> built-in default).
// -> { session: { model, effort }, pmo: { model, effort }, kinds: { research, implement, verify: { model, effort } } }
function fromSettings(o) {
  const s = o && typeof o === 'object' ? o : {};
  const kinds = {};
  for (const k of KINDS) {
    const d = KIND_DEFAULTS[k];
    kinds[k] = { model: isModel(s[k + 'Model']) ? s[k + 'Model'] : d.model, effort: isEffort(s[k + 'Effort']) ? s[k + 'Effort'] : d.effort };
  }
  return {
    session: { model: isModel(s.claudeModel) ? s.claudeModel : DEFAULT_MODEL, effort: isEffort(s.claudeEffort) ? s.claudeEffort : DEFAULT_EFFORT },
    pmo: { model: isModel(s.pmoModel) ? s.pmoModel : DEFAULT_MODEL, effort: isEffort(s.pmoEffort) ? s.pmoEffort : DEFAULT_EFFORT },
    kinds,
  };
}
const MODEL_KEYS = ['claudeModel', 'pmoModel', ...KINDS.map((k) => k + 'Model')];
const EFFORT_KEYS = ['claudeEffort', 'pmoEffort', ...KINDS.map((k) => k + 'Effort')];

// A settings change from the screen -> { fields } to merge into manager-settings.json, or { error }.
// o = { claudeModel?, claudeEffort?, pmoModel?, pmoEffort?, <kind>Model?, <kind>Effort? }; '' / null = back to the
// built-in default (field removed; for a kind, KIND_DEFAULTS).
function settingsPatch(o) {
  if (!o || typeof o !== 'object') return { error: 'not an object' };
  const fields = {};
  for (const k of MODEL_KEYS) {
    if (!(k in o)) continue;
    const v = typeof o[k] === 'string' ? o[k].trim() : o[k];
    if (v === '' || v === null) fields[k] = undefined;
    else if (isModel(v)) fields[k] = v;
    else return { error: `bad model ${JSON.stringify(o[k])}` };
  }
  for (const k of EFFORT_KEYS) {
    if (!(k in o)) continue;
    const v = o[k];
    if (v === '' || v === null) fields[k] = undefined;
    else if (isEffort(v)) fields[k] = v;
    else return { error: `bad effort ${JSON.stringify(v)} (${EFFORTS.join(', ')})` };
  }
  return { fields };
}

// model / effort of a route / create action -> { fields: { model?, effort? } } or { error } (the action fails).
// Absent / null = the default when the session starts (nothing stored on the item).
function actionHints(a) {
  const fields = {};
  if (a.model !== undefined && a.model !== null) {
    if (!isModel(a.model)) return { error: `bad model ${JSON.stringify(a.model)} (a model name such as ${DEFAULT_MODEL}, or an alias such as opus / sonnet)` };
    fields.model = a.model;
  }
  if (a.effort !== undefined && a.effort !== null) {
    if (!isEffort(a.effort)) return { error: `bad effort ${JSON.stringify(a.effort)} (${EFFORTS.join(', ')})` };
    fields.effort = a.effort;
  }
  return { fields };
}

// What one claude start uses: the item's / tab's own value when valid, else the default for its role.
// defaults = fromSettings(...); role 'manager' = the ルーター's session. own = { model?, effort?, kind? } (a routed
// item / its tab): a known kind picks that kind's default (not for the ルーター). -> { model, effort }
function pick(defaults, role, own) {
  const o = own && typeof own === 'object' ? own : {};
  const kinds = defaults.kinds || fromSettings(null).kinds;
  const d = role === 'manager' ? defaults.pmo : (KINDS.includes(o.kind) && kinds[o.kind]) || defaults.session;
  return { model: isModel(o.model) ? o.model : d.model, effort: isEffort(o.effort) ? o.effort : d.effort };
}

module.exports = { DEFAULT_MODEL, DEFAULT_EFFORT, EFFORTS, KINDS, KIND_DEFAULTS, MODEL_RE, isModel, isEffort, fromSettings, settingsPatch, actionHints, pick };
