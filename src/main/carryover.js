// Carry-over import (AT-carryover, docs/plan-carryover.md): when a folder is opened on a PC / userData that has no
// backlog for it yet, the unfinished rows of its own PROGRESS.md (進行中 / 確認待ち / 保留 / 未着手) and the docs/roadmap.md
// rows that PROGRESS.md does not list yet are put on the inbox as 'hold' items (source 'app'), and the ルーター is told to
// sort them (route / merge / drop). The backlog is never written here.
// Duplicates: every candidate has a key relative to the folder ("PROGRESS.md#AT-202", "docs/roadmap.md#14"), written
// as a 取り込みの印 line in the item's text; a key already imported (userData/carryover.json), already in the inbox
// (not dropped) or already a pending / active backlog item number of the folder is skipped. The key does not depend
// on the PC, so the same row imported on two PCs has the same mark.
// No Electron imports (plain Node tests). Reads only the folder's PROGRESS.md and docs/roadmap.md (never writes them).
const fs = require('fs');
const path = require('path');
const progress = require('./progress');

const STATE_FILE = 'carryover.json';
const ROADMAP = path.join('docs', 'roadmap.md');
const ROADMAP_KEY = 'docs/roadmap.md';
const ROADMAP_MAX_BYTES = 1024 * 1024;
const OPEN_STATES = ['進行中', '確認待ち', '保留', '未着手']; // the order candidates are listed in
const IMPORT_MAX = 30; // inbox items per import (the rest are counted in the ルーター line)
const FOLDERS_MAX = 200;
const KEYS_MAX = 500;
const MARK = '取り込みの印';
const MARK_RE = new RegExp(`${MARK}: (\\S+)`);

const norm = (p) => path.resolve(p).toLowerCase();
const cut = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// docs/roadmap.md: rows of every table whose header has 項目 and a number column (#, No, 番号).
// A table with a 状態 column gives each row's state (完了 rows dropped); otherwise the state is ''.
// -> [{ n, item, state }] (first occurrence of a number wins)
function parseRoadmap(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (let i = 0; i + 1 < lines.length; i++) {
    const head = progress.cellsOf(lines[i]);
    const sep = head && progress.cellsOf(lines[i + 1]);
    if (!head || !sep || !progress.isSep(sep)) continue;
    const col = (re) => head.findIndex((c) => re.test(progress.plain(c)));
    const cn = col(/^(#|No\.?|番号)$/i);
    const ci = col(/項目|内容|タスク/);
    const cs = col(/状態/);
    if (cn < 0 || ci < 0) continue;
    // a table may be split by blank lines (roadmap.md has one); rows continue while lines are table rows or blank
    let j = i + 2;
    for (; j < lines.length; j++) {
      if (!lines[j].trim()) {
        const nx = progress.cellsOf(lines[j + 1] || '');
        const after = progress.cellsOf(lines[j + 2] || '');
        if (nx && nx.length === head.length && !progress.isSep(nx) && !(after && progress.isSep(after))) continue;
        break;
      }
      const c = progress.cellsOf(lines[j]);
      if (!c) break;
      if (progress.isSep(c)) continue;
      const n = progress.plain(c[cn]);
      const item = progress.plain(c[ci]);
      if (!n || !item || seen.has(n)) continue;
      const state = cs >= 0 ? progress.normState(c[cs]) : '';
      seen.add(n);
      if (state === '完了') continue;
      out.push({ n, item, state });
    }
    i = j - 1;
  }
  return out;
}

function readRoadmap(folder) {
  try {
    const file = path.join(folder, ROADMAP);
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > ROADMAP_MAX_BYTES) return [];
    return parseRoadmap(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return [];
  }
}

// -> Candidate[] in OPEN_STATES order (PROGRESS.md rows), then the roadmap rows that PROGRESS.md does not have.
// Candidate = { key, source: 'PROGRESS.md'|'docs/roadmap.md', n, item, state, next, updated }
function collect(folder) {
  const p = progress.readProgress(folder);
  const rows = (p && p.rows) || [];
  const out = [];
  for (const st of OPEN_STATES) {
    for (const r of rows) {
      if (r.state !== st) continue;
      out.push({ key: `${progress.FILE}#${r.n}`, source: progress.FILE, n: r.n, item: r.item, state: r.state, next: r.next, updated: r.updated });
    }
  }
  const known = new Set(rows.map((r) => r.n));
  for (const r of readRoadmap(folder)) {
    if (known.has(r.n)) continue;
    if (r.state && !OPEN_STATES.includes(r.state)) continue; // その他 etc.
    out.push({ key: `${ROADMAP_KEY}#${r.n}`, source: ROADMAP_KEY, n: r.n, item: r.item, state: r.state || '未着手', next: '', updated: '' });
  }
  return out;
}

// --- userData/carryover.json: { folders: { [norm(folder)]: { folder, at, keys: { [key]: { at, inboxId } } } } } ---------------
function loadState(userData) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(userData, STATE_FILE), 'utf8'));
    return o && typeof o === 'object' && o.folders && typeof o.folders === 'object' ? { folders: o.folders } : { folders: {} };
  } catch {
    return { folders: {} };
  }
}
function saveState(userData, state) {
  const names = Object.keys(state.folders);
  if (names.length > FOLDERS_MAX) {
    names.sort((a, b) => (state.folders[a].at || 0) - (state.folders[b].at || 0));
    for (const k of names.slice(0, names.length - FOLDERS_MAX)) delete state.folders[k];
  }
  for (const f of Object.values(state.folders)) {
    const ks = Object.keys(f.keys || {});
    if (ks.length > KEYS_MAX) for (const k of ks.slice(0, ks.length - KEYS_MAX)) delete f.keys[k];
  }
  const file = path.join(userData, STATE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}
const folderState = (state, folder) => state.folders[norm(folder)] || null;

// The 取り込みの印 keys of a folder already in the inbox (any status but dropped).
function inboxKeys(inboxItems, folder) {
  const out = new Set();
  const want = norm(folder);
  for (const it of inboxItems || []) {
    if (!it || it.status === 'dropped') continue;
    const m = MARK_RE.exec(it.text || '');
    if (!m) continue;
    const at = m[1].lastIndexOf('|');
    if (at < 0) continue;
    if (norm(m[1].slice(0, at)) === want) out.add(m[1].slice(at + 1));
  }
  return out;
}

// Decides what to import. o = { folder, manual, backlogItems, inboxItems, state, now }
// -> { run: boolean, reason, add: Candidate[], skipped: { key, why }[], more: number, total: number }
// Auto (manual false): only when this userData has no record for the folder and the folder's backlog has no item
// (dropped ones ignored). Manual: always, still without duplicates.
function plan({ folder, manual = false, backlogItems = [], inboxItems = [], state = { folders: {} } }) {
  const rec = folderState(state, folder);
  const live = (backlogItems || []).filter((i) => i && i.status !== 'dropped');
  if (!manual && rec) return { run: false, reason: '前に取り込んだ', add: [], skipped: [], more: 0, total: 0 };
  if (!manual && live.length) return { run: false, reason: 'バックログが空でない', add: [], skipped: [], more: 0, total: 0 };
  const cands = collect(folder);
  const done = new Set(Object.keys((rec && rec.keys) || {}));
  const inInbox = inboxKeys(inboxItems, folder);
  const nos = new Set(live.filter((i) => i.status === 'pending' || i.status === 'active').map((i) => i.no).filter(Boolean));
  const skipped = [];
  const fresh = [];
  for (const c of cands) {
    if (done.has(c.key)) skipped.push({ key: c.key, why: '取り込み済み' });
    else if (inInbox.has(c.key)) skipped.push({ key: c.key, why: '依頼にある' });
    else if (nos.has(c.n)) skipped.push({ key: c.key, why: 'バックログにある' });
    else fresh.push(c);
  }
  const add = fresh.slice(0, IMPORT_MAX);
  return { run: true, reason: manual ? '手動' : '初めて開いた', add, skipped, more: fresh.length - add.length, total: cands.length };
}

// The inbox item for a candidate: { text, title, note, status: 'hold', folder }
function inboxItemOf(folder, c, today) {
  const name = path.basename(folder);
  const lines = [
    '## 目的',
    `${name} の ${c.source} の ${c.n}「${cut(c.item, 200)}」（${c.state}）を続ける。`,
    '',
  ];
  if (c.next && c.next !== '—') lines.push('## 次の一手（' + c.source + ' より）', cut(c.next, 1500), '');
  lines.push(
    '## 背景',
    `- このフォルダをこの環境で開いたとき、アプリが ${c.source} の未完了の行から取り込んだ候補（${today}）。`,
    '- ルーターが今の状態（PROGRESS.md・git log）と照らして仕分ける: 続けるなら route、ほかの項目と同じなら merge、済んでいれば drop。',
    `- フォルダ: ${folder}`,
  );
  if (c.updated) lines.push(`- 更新日: ${c.updated}`);
  lines.push(`- ${MARK}: ${folder}|${c.key}`);
  return {
    text: lines.join('\n'),
    title: cut(`${c.n} ${c.item}`, 120),
    note: `取り込みの候補（${c.source}・${c.state}）`,
    status: 'hold',
    folder,
  };
}

// The line for the ルーター's prompt (manager.notifyManager imported).
function pmoLine(folder, added, more) {
  const nos = added.map((a) => a.reqNo).filter(Boolean);
  const range = nos.length > 1 ? `${nos[0]}〜${nos[nos.length - 1]}` : nos[0] || '';
  return `${folder} を開いたので、積み残し ${added.length} 件を依頼に保留（hold、source app、note「取り込みの候補」）で出した${range ? `（${range}）` : ''}` +
    (more ? `。ほかに ${more} 件（上限で出していない。手動の取り込みで続きが出る）` : '') +
    '。PROGRESS.md と git log で今の状態を確かめ、route / merge / drop で仕分けて';
}

// Records the imported keys. -> new state (mutated in place)
function record(state, folder, entries, now = Date.now()) {
  const k = norm(folder);
  const rec = state.folders[k] || { folder, at: now, keys: {} };
  rec.folder = folder;
  rec.at = now;
  rec.keys = rec.keys || {};
  for (const e of entries) rec.keys[e.key] = { at: now, inboxId: e.inboxId || '' };
  state.folders[k] = rec;
  return state;
}

module.exports = { STATE_FILE, OPEN_STATES, IMPORT_MAX, MARK, parseRoadmap, readRoadmap, collect, loadState, saveState, inboxKeys, plan, inboxItemOf, pmoLine, record };
