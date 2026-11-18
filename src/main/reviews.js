// UX12 事後の確認 (docs/ux-journey.md §3.2 J3 段 4, §4 「ユーザーに見せるもの」; docs/ux12-check.md). A routed session
// goes on by hypotheses instead of asking (UX9) and writes them under 「仮説で決めたこと」 in its last reply. When its item
// ends with 作業完了, the window sends that reply (review:add); main keeps the headings here and the home shows them under
// 要対応 as 事後の確認 (no answer needed). 「違う」 on one of them puts a request in the inbox for the ルーター (it stacks the fix).
// Store: manager/reviews.json = { items: Review[] } (read / write injected, plain Node tests: tmp/reassure/unit.js).
//   Review = { id, at, folder, itemId, no, title, tabId, hypotheses: string[], checks: string[],
//              answers: { [index]: { choice: 'wrong' | 'ok', note, at } }, seenAt: ms | null }
// Kept KEEP_MS after it came in (an answered or seen one too: the record keeps the rest); ≤ MAX items.
const path = require('path');

const KEEP_MS = 3 * 24 * 60 * 60 * 1000;
const MAX = 100;
const ID_RE = /^rv-[a-z0-9-]{4,80}$/;
const str = (v, n) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, n);
const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const list = (v, max, n) => (Array.isArray(v) ? v.map((x) => oneLine(x, n)).filter(Boolean).slice(0, max) : []);

function clean(r) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
  const hypotheses = list(r.hypotheses, 12, 400);
  const checks = list(r.checks, 12, 400);
  if (!hypotheses.length && !checks.length) return null;
  const answers = {};
  for (const [k, a] of Object.entries(r.answers && typeof r.answers === 'object' ? r.answers : {})) {
    if (!/^[hc]\d{1,2}$/.test(k) || !a || (a.choice !== 'wrong' && a.choice !== 'ok')) continue;
    answers[k] = { choice: a.choice, note: str(a.note, 1000), at: num(a.at) };
  }
  return {
    id: r.id,
    at: num(r.at),
    folder: typeof r.folder === 'string' && path.isAbsolute(r.folder) ? r.folder : '',
    itemId: str(r.itemId, 120),
    no: str(r.no, 40),
    title: oneLine(r.title, 200),
    tabId: str(r.tabId, 80),
    hypotheses,
    checks,
    answers,
    seenAt: num(r.seenAt) || null,
  };
}

// -> the text of the inbox request a 「違う」 makes (the ルーター reads it as a request and stacks the fix)
function wrongText(r, key, note) {
  const kind = key[0] === 'h' ? '仮説' : '事後の確認';
  const text = (key[0] === 'h' ? r.hypotheses : r.checks)[Number(key.slice(1))] || '';
  const where = `${r.folder ? `[${path.basename(r.folder)}] ` : ''}${r.no || r.itemId}${r.title ? `「${r.title}」` : ''}`;
  return [
    `事後の確認で「違う」: ${where} の${kind}`,
    '',
    `> ${text}`,
    '',
    note ? `ユーザーの一言: ${oneLine(note, 1000)}` : 'ユーザーの一言: （なし）',
    '',
    `（アプリから）この${kind}は違う、とユーザーが押しました。${r.folder ? `フォルダ ${r.folder} の ` : ''}${r.no || r.itemId} で入ったものを、この前提で直す作業を積んでください。どう直すかが分からなければ、提案（既定の案と期限）で聞いてください。`,
  ].join('\n');
}

function createReviews({ read = () => null, write = () => {}, now: clock = () => Date.now() } = {}) {
  let items = null;
  const load = () => {
    if (items) return items;
    items = [];
    try {
      const raw = read();
      for (const r of (raw && Array.isArray(raw.items) ? raw.items : [])) {
        const c = clean(r);
        if (c) items.push(c);
      }
    } catch {}
    return items;
  };
  const save = () => {
    try {
      write({ items });
    } catch {}
  };
  const prune = (now) => {
    const before = load().length;
    items = items.filter((r) => now - r.at < KEEP_MS).slice(-MAX);
    return items.length !== before;
  };
  let seq = 0;
  return {
    // { folder, itemId, no, title, tabId, hypotheses, checks } -> Review | null (nothing to show). The same item once.
    add(o, now = clock()) {
      const id = `rv-${now.toString(36)}-${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const r = clean({ ...o, id, at: now, answers: {} });
      if (!r) return null;
      load();
      prune(now);
      const same = r.itemId && items.find((x) => x.itemId === r.itemId && x.folder.toLowerCase() === r.folder.toLowerCase());
      if (same) {
        // a later 作業完了 of the same item (resumed after a check text): the newer headings, the answers stay
        Object.assign(same, { hypotheses: r.hypotheses, checks: r.checks, at: now, no: r.no || same.no, title: r.title || same.title });
        save();
        return same;
      }
      items.push(r);
      save();
      return r;
    },
    list(now = clock()) {
      load();
      if (prune(now)) save();
      return items.slice().sort((a, b) => b.at - a.at);
    },
    get: (id) => load().find((r) => r.id === id) || null,
    // { id, key: 'h0' | 'c1' …, choice: 'wrong' | 'ok', note } -> { review, wrong: text | null } | { error }
    answer(o, now = clock()) {
      const r = o && typeof o.id === 'string' ? load().find((x) => x.id === o.id) : null;
      if (!r) return { error: 'unknown review' };
      const key = o && typeof o.key === 'string' && /^[hc]\d{1,2}$/.test(o.key) ? o.key : null;
      const arr = key ? (key[0] === 'h' ? r.hypotheses : r.checks) : null;
      if (!key || !arr[Number(key.slice(1))]) return { error: 'unknown line' };
      if (o.choice !== 'wrong' && o.choice !== 'ok') return { error: 'choice must be wrong or ok' };
      if (r.answers[key] && r.answers[key].choice === 'wrong') return { review: r, wrong: null }; // told once
      const note = str(o.note, 1000);
      r.answers[key] = { choice: o.choice, note, at: now };
      save();
      return { review: r, wrong: o.choice === 'wrong' ? wrongText(r, key, note) : null };
    },
    // 「見た」: the card folds (it stays in the list until KEEP_MS)
    seen(id, now = clock()) {
      const r = load().find((x) => x.id === id);
      if (!r) return null;
      r.seenAt = now;
      save();
      return r;
    },
  };
}

module.exports = { createReviews, clean, wrongText, KEEP_MS, MAX };
