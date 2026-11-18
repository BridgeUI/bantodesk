'use strict';
// Claude Code "code mode" (docs/plan-code-mode.md, 依頼-535). Experimental: the only switch is the environment variable
// CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 of the claude process (not a CLI option; ignored in a project's settings files,
// so it goes in the pty env, not --settings). A claude that does not know it ignores it, so an old version is harmless.
// Pure functions, no Electron imports. The preference is manager-settings.json { codeMode: 'on' | 'off' | 'auto' }.
const ENV_KEY = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE';
const MODES = ['auto', 'on', 'off'];
const DEFAULT_MODE = 'auto';

const isMode = (v) => typeof v === 'string' && MODES.includes(v);
const modeOf = (settings) => (settings && isMode(settings.codeMode) ? settings.codeMode : DEFAULT_MODE);

// Models the doc lists: Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.2 (full names, dated names and aliases; an unknown name -> false)
function supportedModel(model) {
  const m = String(model || '').toLowerCase().replace(/\[[a-z0-9]+\]$/, '');
  if (/^(opus|sonnet|haiku|fable)$/.test(m)) return true;
  return /^claude-(opus-5-5|sonnet-5-5|haiku-5-5|fable-5-\d+)(-\d{8})?$/.test(m);
}

// Environments the doc says code mode does not work in: gateway / Bedrock / Vertex-style / Foundry providers, no telemetry
const BLOCKING_ENV = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'ANTHROPIC_BASE_URL',
  'DISABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
];
const truthy = (v) => v !== undefined && v !== null && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false';

// "auto": on only where the doc says it pays (many similar edits, searches to narrow, independent commands in parallel):
// a routed session of kind implement / research. Off for verify (short mechanical runs), the ルーター, temp / edit windows,
// hand-opened tabs (no way to tell the work), Agent Teams tabs (need claude 2.1.326+, not known here), and wherever the
// doc says it cannot run (unsupported model or provider, telemetry off).
// o = { mode, role, kind, model, temp, team, env } -> { on: boolean, reason: string }
function decide(o) {
  const x = o || {};
  const mode = isMode(x.mode) ? x.mode : DEFAULT_MODE;
  if (mode === 'off') return { on: false, reason: 'off' };
  if (mode === 'on') return { on: true, reason: 'on' };
  const env = x.env || {};
  if (x.role === 'manager') return { on: false, reason: 'manager' };
  if (x.temp) return { on: false, reason: 'temp' };
  if (x.team) return { on: false, reason: 'team' };
  if (x.kind !== 'implement' && x.kind !== 'research') return { on: false, reason: x.kind === 'verify' ? 'verify' : 'no-kind' };
  if (!supportedModel(x.model)) return { on: false, reason: 'model' };
  for (const k of BLOCKING_ENV) if (truthy(env[k])) return { on: false, reason: 'env:' + k };
  return { on: true, reason: 'auto:' + x.kind };
}

// -> the env entries to add to the claude's env: '1' (on), '0' (off by the setting: wins over the user's own settings.json),
// nothing (auto and not matching: the user's own setting stays)
function envFor(o) {
  const mode = isMode(o && o.mode) ? o.mode : DEFAULT_MODE;
  const d = decide(o);
  if (d.on) return { [ENV_KEY]: '1' };
  if (mode === 'off') return { [ENV_KEY]: '0' };
  return {};
}

// A change from the screen: { codeMode: 'on'|'off'|'auto' } -> { next } | { error }
function patch(settings, o) {
  if (!o || typeof o !== 'object' || !isMode(o.codeMode)) return { error: `codeMode must be one of ${MODES.join(', ')}` };
  const next = { ...(settings && typeof settings === 'object' ? settings : {}) };
  if (o.codeMode === DEFAULT_MODE) delete next.codeMode;
  else next.codeMode = o.codeMode;
  return { next };
}

module.exports = { ENV_KEY, MODES, DEFAULT_MODE, isMode, modeOf, supportedModel, decide, envFor, patch };
