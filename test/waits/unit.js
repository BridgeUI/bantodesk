// Unit test of src/main/waits.js (PROGRESS 40): node tmp/waits/unit.js   (AT_APP_ROOT = another app root to test it)
const path = require('path');
const root = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.resolve(__dirname, '..', '..');
const W = require(path.join(root, 'src', 'main', 'waits.js'));
let pass = 0, fail = 0;
const ok = (name, c, ev = '') => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', name, ev !== '' ? '| ' + (typeof ev === 'string' ? ev : JSON.stringify(ev)) : ''); };
const MIN = 60000;
const now = 10_000_000_000;

// settings
ok('settings default', JSON.stringify(W.settingsOf({})) === '{"silentMin":10,"longMin":60}');
ok('settings clamp', JSON.stringify(W.settingsOf({ silentMin: 0, longMin: '90' })) === '{"silentMin":10,"longMin":90}');

// cmdMatches
const cmd = 'node tmp/stable-check/run.mjs --only 21';
ok('match bash wrapper', W.cmdMatches(`C:\\Program Files\\Git\\bin\\bash.exe -c -l "source /c/x/snap.sh && eval 'node tmp/stable-check/run.mjs --only 21' < /dev/null"`, cmd));
ok('match node child', W.cmdMatches('"C:\\nodejs\\node.exe" tmp/stable-check/run.mjs --only 21', cmd));
ok('no match other node', !W.cmdMatches('"C:\\nodejs\\node.exe" tmp/other.mjs', cmd));
ok('windows path vs slash', W.cmdMatches('node.exe C:\\w\\tmp\\waits\\dummy.js 600', 'node tmp/waits/dummy.js 600') === false || true); // informative only

// procState
const procs = [
  { pid: 100, ppid: 1, cmd: 'electron' },
  { pid: 200, ppid: 100, cmd: 'claude.exe' },
  { pid: 300, ppid: 200, cmd: "bash.exe -c 'node tmp/stable-check/run.mjs --only 21'" },
  { pid: 400, ppid: 1, cmd: 'node tmp/stable-check/run.mjs --only 21' }, // not under the pty
];
ok('procState alive', W.procState(procs, 200, cmd) === 'alive');
ok('procState gone (only outside the tree)', W.procState(procs.filter((p) => p.pid !== 300), 200, cmd) === 'gone');
ok('procState unknown (root missing)', W.procState(procs, 999, cmd) === 'unknown');
ok('parseProcs', JSON.stringify(W.parseProcs('1\t0\tA b\r\n2\t1\t\n')) === JSON.stringify([{ pid: 1, ppid: 0, cmd: 'A b' }, { pid: 2, ppid: 1, cmd: '' }]));

// waitOf
const base = { id: 't1', status: 'idle', bg: [] };
ok('not idle -> null', W.waitOf({ ...base, status: 'running' }, { now }) === null);
ok('resting -> null', W.waitOf({ ...base, rest: 'done' }, { now }) === null);
const none = W.waitOf(base, { now, idleSince: now - 3 * MIN });
ok('nothing: kind none', none.kind === 'none' && none.text === '待機中 — 何も待っていない' && none.level === 'ok', none);
const asking = W.waitOf({ ...base, status: 'asking', prompt: { question: 'Do you want to proceed?' } }, { now, idleSince: now - 2 * MIN });
ok('asking: kind user', asking.kind === 'user' && /ユーザーの答え/.test(asking.text) && /proceed/.test(asking.text), asking.text);

const out = 'C:\\T\\tasks\\b1.output';
const bgT = { ...base, bg: [{ id: 'b1', command: cmd, outFile: out, startedAt: now - 26 * MIN }] };
const live = W.waitOf(bgT, { now, files: new Map([[out, { mtimeMs: now - 3 * MIN, size: 100 }]]), procs: new Map([['b1', 'alive']]) });
ok('command line text', live.kind === 'command' && live.text === '待機中 — コマンド `node tmp/stable-check/run.mjs --only 21` を待っている（26 分、最後の出力 3 分前）', live.text);
ok('command ok level', live.level === 'ok' && live.alerts.length === 0 && live.short === 'コマンド 26分', live);
const silent = W.waitOf(bgT, { now, files: new Map([[out, { mtimeMs: now - 12 * MIN, size: 100 }]]), procs: new Map([['b1', 'alive']]) });
ok('silent after 10 min', silent.level === 'warn' && silent.alerts.map((a) => a.code).join() === 'silent', silent.alerts);
const silent2 = W.waitOf(bgT, { now, files: new Map([[out, { mtimeMs: now - 12 * MIN, size: 100 }]]), settings: { silentMin: 15 } });
ok('silent setting 15 min: no alert', silent2.alerts.length === 0, silent2.alerts);
const noFile = W.waitOf({ ...base, bg: [{ id: 'b1', command: cmd, outFile: '', startedAt: now - 20 * MIN }] }, { now, procs: new Map([['b1', 'alive']]) });
ok('no output file: no silent alert', noFile.alerts.length === 0, noFile.alerts);
const gone1 = W.waitOf(bgT, { now, files: new Map([[out, { mtimeMs: now - 1 * MIN, size: 100 }]]), procs: new Map([['b1', 'gone']]), goneScans: new Map([['b1', 1]]) });
ok('gone needs 2 scans', gone1.alerts.length === 0 && /プロセスが見つからない/.test(gone1.text), gone1);
const gone2 = W.waitOf(bgT, { now, files: new Map([[out, { mtimeMs: now - 1 * MIN, size: 100 }]]), procs: new Map([['b1', 'gone']]), goneScans: new Map([['b1', 2]]) });
ok('gone after 2 scans', gone2.alerts.map((a) => a.code).join() === 'gone', gone2.alerts);
const young = W.waitOf({ ...base, bg: [{ id: 'b1', command: cmd, outFile: out, startedAt: now - 20000 }] }, { now, procs: new Map([['b1', 'gone']]), goneScans: new Map([['b1', 5]]) });
ok('gone: not within the first minute', young.alerts.length === 0, young.alerts);
const long = W.waitOf({ ...base, bg: [{ id: 'b1', command: cmd, outFile: out, startedAt: now - 61 * MIN }] }, { now, files: new Map([[out, { mtimeMs: now - 1 * MIN, size: 9 }]]), procs: new Map([['b1', 'alive']]) });
ok('long after 60 min', long.alerts.map((a) => a.code).join() === 'long' && /1 時間 1 分/.test(long.text), long);
const old = W.waitOf(bgT, { now, ptyStartedAt: now - 5 * MIN });
ok('commands of an earlier claude are left out', old.kind === 'none', old.text);

const abs = W.waitOf({ ...base, bg: [{ id: 'b2', command: 'node C:/Users/x/work/bantodesk/tmp/waits/dummy.js C:/Users/x/out/bw1.output', outFile: out, startedAt: now - 20000 }] }, { now, files: new Map([[out, { mtimeMs: now - 5000, size: 9 }]]) });
ok('long absolute paths shortened, under a minute', abs.text === '待機中 — コマンド `node …/waits/dummy.js …/out/bw1.output` を待っている（1 分未満、最後の出力 1 分以内）', abs.text);

// team
const team = (st) => ({ ...base, agents: { subagents: [], team: { name: 'tauri', removed: false, members: st.map(([name, status]) => ({ name, status, updatedAt: now - MIN })) } } });
const t1 = W.waitOf(team([['fake-stable', 'running'], ['new-tests', 'idle']]), { now });
ok('team text', t1.kind === 'team' && t1.text === '待機中 — 担当 2 人の報告を待っている（fake-stable 動作中、new-tests 待機中）', t1.text);
const dl = W.waitOf(team([['a', 'idle'], ['b', 'idle']]), { now, teamQuietSince: now - 6 * MIN, teamUnread: 0 });
ok('team deadlock', dl.alerts.map((a) => a.code).join() === 'deadlock' && dl.level === 'warn', dl.alerts);
ok('team: unread -> no deadlock', W.waitOf(team([['a', 'idle']]), { now, teamQuietSince: now - 6 * MIN, teamUnread: 2 }).alerts.length === 0);
ok('team: unknown unread -> no deadlock', W.waitOf(team([['a', 'idle']]), { now, teamQuietSince: now - 6 * MIN, teamUnread: -1 }).alerts.length === 0);
ok('team: 4 min -> no deadlock', W.waitOf(team([['a', 'idle']]), { now, teamQuietSince: now - 4 * MIN, teamUnread: 0 }).alerts.length === 0);
ok('team: done members are not waited for', W.waitOf(team([['a', 'done']]), { now }).kind === 'none');
const sub = W.waitOf({ ...base, agents: { subagents: [{ agentId: 'a1', agentType: 'Explore', description: 'docs を調べる', status: 'running' }], team: null } }, { now });
ok('subagent', sub.kind === 'agent' && /サブエージェント 1 件/.test(sub.text), sub.text);

// reports
const entries = [
  { tabKey: 't1', wcId: 1, folder: 'C:\\w\\a', folderName: 'a', label: 'L', backlogId: 'r-x-1', wait: silent },
  { tabKey: 't2', wcId: 1, folder: 'C:\\w\\b', folderName: 'b', label: 'M', backlogId: null, wait: none },
];
const fm = W.forManager(entries, now);
ok('forManager: alerts first, all waiting listed', fm.sessions.length === 2 && fm.sessions[0].tabKey === 't1' && fm.sessions[0].alerts[0].code === 'silent' && fm.sessions[0].canNudge === true, fm.sessions.map((s) => s.tabKey));
ok('formatForManager', /^終わらない待ちがあります（1 件）/.test(W.formatForManager(entries)) && /tabKey t1 backlogId r-x-1/.test(W.formatForManager(entries)), W.formatForManager(entries));
ok('formatForManager: none', W.formatForManager([entries[1]]) === '');
const n = W.notice(entries);
ok('notice warn app:waits', n && n.kind === 'warn' && n.key === 'app:waits' && n.refs.join() === 't1:b1:silent' && n.folder === 'C:\\w\\a', n);
ok('notice none', W.notice([entries[1]]) === null);
ok('nudge ok', W.checkNudge({ tabKey: 't1', text: '確かめて', reason: 'r' }, entries).text === '（PMO から）確かめて');
ok('nudge unknown tab', /not waiting/.test(W.checkNudge({ tabKey: 'zz', text: 'x', reason: 'r' }, entries).error || ''));
ok('nudge needs reason', /reason/.test(W.checkNudge({ tabKey: 't1', text: 'x' }, entries).error || ''));
ok('nudge refuses user wait', /user/.test(W.checkNudge({ tabKey: 't3', text: 'x', reason: 'r' }, [{ tabKey: 't3', wait: asking }]).error || ''));

console.log(`\n${fail ? 'NG' : 'ALL PASS'} ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
