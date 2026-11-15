// Folder progress file: <folder>/PROGRESS.md, a Markdown table `| # | 項目 | 状態 | 次の一手 | 更新日 |`
// kept by the folder's own session (see CONTRACT.md "Progress file"). No Electron imports (plain Node tests).
// Tolerant: the first table whose header has 項目 and 状態 is used; other columns are optional.
const fs = require('fs');
const path = require('path');

const FILE = 'PROGRESS.md';
// AT-carryover: was 64 KB / 100 rows. a project's PROGRESS.md grew to 124 KB (2026-11-05..13) and readProgress
// returned null (projects.json progress empty); agent_terminal's has > 100 rows (counts cut at 100). Long tables are normal.
const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 2000;
const STATES = ['未着手', '進行中', '確認待ち', '完了', '保留'];
const OTHER = 'その他';

const cellsOf = (line) => {
  let s = line.trim();
  if (!s.startsWith('|')) return null;
  s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
};
const isSep = (cells) => cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
// strip light Markdown (bold, code, links) so the dashboard shows plain text
const plain = (s) =>
  String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

function normState(s) {
  const t = plain(s);
  return STATES.find((x) => t.includes(x)) || OTHER;
}

// text -> { rows, counts, done, total } | null (no table with 項目 + 状態)
function parseProgress(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i++) {
    const head = cellsOf(lines[i]);
    if (!head) continue;
    const sep = cellsOf(lines[i + 1]);
    if (!sep || !isSep(sep)) continue;
    const col = (re) => head.findIndex((c) => re.test(plain(c)));
    const ci = col(/項目/);
    const cs = col(/状態/);
    if (ci < 0 || cs < 0) continue;
    const cn = col(/^(#|No\.?|番号)$/i);
    const cx = col(/次の一手|次/);
    const cu = col(/更新/);
    const rows = [];
    for (let j = i + 2; j < lines.length && rows.length < MAX_ROWS; j++) {
      const c = cellsOf(lines[j]);
      if (!c) break; // table ends at the first non-table line
      if (isSep(c)) continue;
      const item = plain(c[ci]);
      if (!item) continue;
      rows.push({
        n: cn >= 0 ? plain(c[cn]) : String(rows.length + 1),
        item,
        state: normState(c[cs]),
        next: cx >= 0 ? plain(c[cx]) : '',
        updated: cu >= 0 ? plain(c[cu]) : '',
      });
    }
    const counts = {};
    for (const s of [...STATES, OTHER]) counts[s] = 0;
    for (const r of rows) counts[r.state]++;
    return { rows, counts, done: counts['完了'], total: rows.length };
  }
  return null;
}

// Cached by (size, mtime). -> { rows, counts, done, total, mtime } | null (no file / too big / no table)
const cache = new Map(); // folder -> { mtime, size, value }
function readProgress(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return null;
  const file = path.join(folder, FILE);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    cache.delete(folder);
    return null;
  }
  if (!st.isFile() || st.size > MAX_BYTES) return null;
  const hit = cache.get(folder);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.value;
  let value = null;
  try {
    const p = parseProgress(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    value = p ? { ...p, mtime: st.mtimeMs } : null;
  } catch {
    value = null;
  }
  if (cache.size > 200) cache.clear();
  cache.set(folder, { mtime: st.mtimeMs, size: st.size, value });
  return value;
}

// 確認待ち / 保留 rows in projects.json and the patrol (roadmap 48): at most LISTED_MAX rows, short texts.
const LISTED_MAX = 10;
const ITEM_MAX = 80;
const NEXT_MAX = 120;
const listed = (rows, state) =>
  rows
    .filter((r) => r.state === state)
    .slice(0, LISTED_MAX)
    .map((r) => ({ n: r.n.slice(0, 12), item: r.item.slice(0, ITEM_MAX), next: r.next.slice(0, NEXT_MAX), updated: /^\d{4}-\d{2}-\d{2}$/.test(r.updated) ? r.updated : '' }));

// Small summary for projects.json: { done, total, inProgress: string[] ≤ 5, updated, waiting, waitingCount, held, heldCount } | null
// waiting = 確認待ち rows, held = 保留 rows: [{ n, item, next, updated }] (≤ LISTED_MAX, table order; updated = YYYY-MM-DD or '').
function progressSummary(folder) {
  const p = readProgress(folder);
  if (!p) return null;
  const dates = p.rows.map((r) => r.updated).filter(Boolean).sort();
  return {
    done: p.done,
    total: p.total,
    inProgress: p.rows.filter((r) => r.state === '進行中').slice(0, 5).map((r) => r.item.slice(0, 120)),
    updated: dates.length ? dates[dates.length - 1] : new Date(p.mtime).toISOString().slice(0, 10),
    waiting: listed(p.rows, '確認待ち'),
    waitingCount: p.counts['確認待ち'],
    held: listed(p.rows, '保留'),
    heldCount: p.counts['保留'],
  };
}

module.exports = { FILE, MAX_BYTES, MAX_ROWS, STATES, OTHER, LISTED_MAX, parseProgress, readProgress, progressSummary, cellsOf, isSep, plain, normState };
