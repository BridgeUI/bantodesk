// UX6 / J2 (docs/mac-polish.md): drop a window's save whose content equals the last save that went through for that
// folder. The first save of a folder always goes through (nothing is remembered yet), and every write main makes to the
// folder's file forgets the entry, so a later window save equal to an older snapshot is written again.
function create() {
  const last = new Map(); // key (norm(folder)) -> JSON of the last window save written

  // -> true when json equals the remembered save of key (skip the write)
  const same = (key, json) => typeof json === 'string' && last.get(key) === json;
  const remember = (key, json) => {
    if (typeof json === 'string') last.set(key, json);
  };
  const forget = (key) => {
    last.delete(key);
  };
  return { same, remember, forget, size: () => last.size };
}

// Wraps the writing functions of a module (e.g. backlog.saveBacklog) so a call forgets the folder's entry first.
// keyOf(args) -> key. The wrapped functions keep their result and their `this`.
function forgetOnWrite(mod, names, dedupe, keyOf) {
  for (const n of names) {
    const fn = mod[n];
    if (typeof fn !== 'function' || fn.__forgets) continue;
    const w = function (...args) {
      try {
        dedupe.forget(keyOf(args));
      } catch {}
      return fn.apply(this, args);
    };
    w.__forgets = true;
    mod[n] = w;
  }
}

module.exports = { create, forgetOnWrite };
