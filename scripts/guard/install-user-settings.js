// SEC5 (docs/security.md): adds the SEC5 guard to a Claude Code settings file, for claude sessions
// opened by hand outside BantoDesk. Run only when the user decided to (SEC5 QA 1); the agent does not run it.
//
//   node scripts/guard/install-user-settings.js                 dry run: shows what would change in ~/.claude/settings.json
//   node scripts/guard/install-user-settings.js --apply         writes it (a copy of the old file next to it first)
//   node scripts/guard/install-user-settings.js --remove --apply  takes the SEC5 rules / hook out again
//   --file <path>   another settings file (e.g. a project's .claude/settings.local.json, or a copy to try on)
//
// Adds permissions.deny (src/main/pretool-guard.js denyRules: works under the managed policy allowManagedHooksOnly) and
// hooks.PreToolUse (node <pretool-guard.js>: ignored under that policy, works where hooks are allowed). Keeps every other
// key and rule. Uses only node built-ins; starts no process.
//
// Which deny rules are SEC5's: the ones this script added, listed in the marker file <settings>.sec5-rules.json next to
// the settings file (a rule the user already had before is not listed, so --remove leaves it). --apply takes the listed
// rules out first and then puts today's in, so a rule that left the judgment goes away too. With no marker: if at least
// half of today's rules are in the file it is an install from before the marker, and the rules equal to today's are
// taken as SEC5's (a rule of an older judgment stays, as before); otherwise it is a first install.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const guard = require('../../src/main/pretool-guard');

const markerPath = (file) => `${file}.sec5-rules.json`;
const isOurs = (h) => h && typeof h.command === 'string' && /pretool-guard\.js"?$/.test(h.command);

function readMarker(file) {
  const m = markerPath(file);
  if (!fs.existsSync(m)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(m, 'utf8'));
    return Array.isArray(j.deny) ? j.deny.filter((r) => typeof r === 'string') : null;
  } catch {
    return null;
  }
}

// -> { out, text, deny: rules to list in the marker (null on remove), stats }. Pure apart from reading the files.
function plan({ file, remove = false, rules = guard.denyRules(), hook = guard.hookSettings() }) {
  let text = '';
  let s = {};
  if (fs.existsSync(file)) {
    text = fs.readFileSync(file, 'utf8');
    try {
      s = JSON.parse(text);
    } catch (e) {
      throw new Error(`${file} is not valid JSON (${e.message}); nothing changed.`);
    }
  }
  const ruleSet = new Set(rules);
  const listed = readMarker(file);
  s.permissions = s.permissions || {};
  const before = Array.isArray(s.permissions.deny) ? s.permissions.deny : [];
  // SEC5's rules in the file now: the marker's list. No marker: an install from before the marker if at least half of
  // today's rules are there (then the ones equal to today's are SEC5's), else a first install (none are SEC5's yet).
  const same = before.filter((r) => ruleSet.has(r));
  const legacy = !listed && same.length * 2 >= rules.length;
  const oursSet = new Set(listed || (legacy ? same : []));
  const kept = before.filter((r) => !oursSet.has(r)); // the user's own
  const keptSet = new Set(kept);
  const add = remove ? [] : rules.filter((r) => !keptSet.has(r)); // not one the user already has
  s.permissions.deny = [...kept, ...add];
  if (!s.permissions.deny.length) delete s.permissions.deny;
  if (!Object.keys(s.permissions).length) delete s.permissions;

  s.hooks = s.hooks || {};
  const pre = (Array.isArray(s.hooks.PreToolUse) ? s.hooks.PreToolUse : [])
    .map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !isOurs(h)) }))
    .filter((m) => m.hooks.length);
  if (!remove) pre.push(...hook.PreToolUse);
  if (pre.length) s.hooks.PreToolUse = pre;
  else delete s.hooks.PreToolUse;
  if (!Object.keys(s.hooks).length) delete s.hooks;

  const out = JSON.stringify(s, null, 2) + '\n';
  const beforeOurs = before.filter((r) => oursSet.has(r));
  const beforeSet = new Set(before);
  const addSet = new Set(add);
  return {
    out,
    text,
    deny: remove ? null : add,
    markerSame: remove ? listed === null : listed !== null && listed.length === add.length && listed.every((r) => addSet.has(r)),
    stats: {
      before: before.length,
      after: (s.permissions && s.permissions.deny ? s.permissions.deny : []).length,
      kept: kept.length,
      removed: beforeOurs.filter((r) => remove || !addSet.has(r)).length,
      added: add.filter((r) => !beforeSet.has(r)).length,
      total: add.length,
      marker: listed ? 'marker' : legacy ? "no marker, an older install: rules equal to today's taken as SEC5's" : 'no marker, first install',
    },
  };
}

function run({ file, apply = false, remove = false, rules, hook, log = console.log }) {
  const p = plan({ file, remove, rules, hook });
  const st = p.stats;
  log(`${file}`);
  log(`  permissions.deny: ${st.before} -> ${st.after} (SEC5 rules: ${remove ? `removed ${st.removed}` : `removed ${st.removed} old, added ${st.added}, ${st.total} in all`}; others kept ${st.kept}; ${st.marker})`);
  log(`  hooks.PreToolUse: ${remove ? 'SEC5 hook removed' : (hook || guard.hookSettings()).PreToolUse[0].hooks[0].command}`);
  if (p.out === p.text && p.markerSame) {
    log('  no change');
    return { changed: false, ...p };
  }
  if (!apply) {
    log('  dry run: nothing written (add --apply to write)');
    return { changed: false, ...p };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (p.text && p.out !== p.text) {
    const bak = `${file}.sec5-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(bak, p.text);
    log(`  old file kept as ${bak}`);
  }
  fs.writeFileSync(file, p.out);
  const m = markerPath(file);
  if (remove) {
    if (fs.existsSync(m)) fs.unlinkSync(m);
  } else {
    fs.writeFileSync(m, JSON.stringify({ note: 'SEC5 deny rules added by scripts/guard/install-user-settings.js (taken out again by --apply / --remove)', deny: p.deny }, null, 2) + '\n');
  }
  log(`  written${remove ? '' : ` (SEC5 rules listed in ${m})`}. Restart the claude sessions you opened by hand for it to apply.`);
  return { changed: true, ...p };
}

module.exports = { plan, run, markerPath };

if (require.main === module) {
  const args = process.argv.slice(2);
  const fileArg = args.indexOf('--file');
  const file = fileArg >= 0 && args[fileArg + 1] ? path.resolve(args[fileArg + 1]) : path.join(os.homedir(), '.claude', 'settings.json');
  try {
    run({ file, apply: args.includes('--apply'), remove: args.includes('--remove') });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
