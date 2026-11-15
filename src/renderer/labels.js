// 画面の言葉の表（UIUX 再定義の段 U1。docs/ui-copy.md、docs/concept-uiux.md §1.4・§2.6）
// main の Node からも renderer からも読む。DOM や Electron を使わない。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Labels = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 振り分け前の番号「依頼-N」の記号（旧「受-N」）
  const REQ_PREFIX = '依頼';

  // 画面の呼び名。キーは英語、値は画面に出す日本語。
  const WORDS = Object.freeze({
    // 受け箱の新しい名前。concept-uiux.md §6 論点 1 の最終決定は、ここ 1 か所を変えれば全画面が変わる。
    // ファイル名 inbox.json・IPC inbox:*・outbox のアクション名 inbox / inbox-edit / inbox-merge は互換のため変えない。
    inbox: '依頼',
    inboxOpen: '対応中',
    inboxHistory: '対応履歴',
    yourTurn: '要対応', // ユーザーにしか決められないもの（旧 あなたの番・確認待ち / 入力待ち / 回答待ち。タブ名は名詞: docs/ui-wording.md）
    checking: '確認中', // PMO が受け持つ確認
    queue: '待ち', // 旧 キュー / バックログ / 待ち行列
    pmo: 'PMO', // 旧 管理エージェント
    done: '完了', // タブの rest（旧 休止）も含む
    hold: '保留', // 依頼の hold（旧 休止）
    resume: '再開', // --resume を見せない
    autoYes: '安全な確認は自動で通す', // 旧 Auto-yes
    projects: 'プロジェクト', // 旧 受け箱・フォルダ
    allDone: 'すべて完了', // U8: 見直しで次の作業が出なかったフォルダの印（新しい依頼で外れる）
    reviewing: '見直し中', // U8: アプリが積んだ見直しが動いている
    pmoLog: 'PMO の記録', // 旧 PMO から（お知らせ・解決した指摘）
    settings: '設定',
    dashboard: 'ダッシュボード',
    running: '動作中',
    failed: '失敗',
    error: 'エラー',
    dropReq: '取り下げ', // 依頼をやめる
    dropTask: '取り消し', // 待ちのタスクをやめる
    proposal: '提案',
    pmoChat: 'PMO に相談',
    newReq: '受付',
    stalled: '止まって', // 「止まって 4 分」（旧 放置）
    // U5: ダッシュボードの「新しいセッション」の欄（旧 フォルダを開く窓 picker）
    newSession: '新しいセッション',
    pickFolder: 'フォルダを選ぶ…', // 旧 Browse for folder…
    recentFolders: '最近のフォルダ', // 旧 Recent
    newWork: '新しい作業', // 置き場所の下に新しいフォルダを作って開く
    tempSession: '一時セッション',
    editFile: 'ファイルを編集…',
    keptEdits: '編集中のファイル（残したもの）',
    openNow: '開いている', // 旧 OPEN
    // U6: セッション画面の上のバー（常に出すのは 新しいセッション・ダッシュボード・その他・設定・サイドパネル）
    more: 'その他', // 「⋯」のメニュー（ビューア・待ちの一覧・チートシート・リモート・新しいセッションの選択肢）
    sessionOptions: '新しいセッション・履歴',
    viewer: 'ファイルをビューアで開く',
    queueList: '待ちの一覧', // 旧 バックログの窓
    cheatsheet: 'チートシート',
    remote: 'リモート（スマホから）',
    hiddenTabs: '入りきらないタブ', // 右端の「▾ N」
    sidePanel: 'サイドパネル',
    // U6: 会話ビュー（依頼-42）
    ops: '件の操作', // 古いターンのツールの行をまとめた 1 行「12 件の操作」
    openDiffs: '差分を開いて表示', // 設定。既定はオフ（差分は 1 行の要約で閉じる）
    openResults: '結果を開いて表示', // 設定。既定はオフ（Bash などの出力は 1 行の要約で閉じる）
    // 待ちの順番（docs/queue-order.md）: ホームのカードの待ちの欄
    queueOrder: '送る順', // カードの待ちの欄の見出し。上から順に新しいセッションで始める
    nextStart: '次', // 全体（フォルダをまたぐ）で次に始まるタスクの行の状態（旧 次に始まる）
    nextTask: '次のタスク', // プロジェクトのタブの上の 1 行の見出し「次のタスク: A · AT-61 見出し」（src/main/queueorder.js の line）
    startSoon: 'まもなく開始', // 空きがあり、次の見回りで始まるタスク（旧 すぐ始まる）
    orderLocked: '手で並べた順', // ↑ ↓ の後 24 時間は PMO が並べ替えない印（残り時間を添える）
    askPmoOrder: '順番の見直し', // ひとこと書いて PMO への依頼に足すボタン（旧 PMO に順番を見直してもらう）
    pmoReordered: 'PMO の並べ替え', // PMO の最後の reorder と理由
    // UX5: 設定の節
    workAndModel: '作業とモデル', // 旧「ダッシュボード」の節（置き場所・モデル・止まりの見張り）。上から 2 番目
    phone: 'スマホ', // スマホから操作する（リモート）の ON / OFF の節。ホームの上の帯には ON のときだけ印
    // UA3: 問題のときのセッション画面（docs/usage-analytics.md §5）
    workDetail: 'この作業の詳しく', // ⋯ の中。旧 サイドパネル（アシストパネル）を出す
    showTerminal: 'ターミナル', // ⋯ の中。会話 ⇄ ターミナルの切り替え（旧 ペインの見出しのボタン）
    slimSession: 'セッション画面を問題のときの形にする', // 設定（会話の表示）。既定はオン
    backToDash: 'ダッシュボードに戻る', // 問題の帯。問題が消えたら出す
  });

  // 古い語 → 新しい語（docs/ui-copy.md の一覧と同じ内容）
  const RENAMED = Object.freeze([
    { from: '受け箱', to: WORDS.inbox, note: '§6 論点 1 の仮説。最終の名前は WORDS.inbox で変える' },
    { from: '受け箱: 対応前', to: WORDS.inboxOpen, note: '依頼タブの絞り込み' },
    { from: '受け箱: 対応済み', to: WORDS.inboxHistory, note: '依頼タブの絞り込み' },
    { from: '受け箱・フォルダ', to: WORDS.projects, note: 'フォルダの進み具合はプロジェクトタブへ' },
    { from: '受-N', to: REQ_PREFIX + '-N', note: '振り分け前の仮の番号' },
    { from: '確認待ち', to: WORDS.yourTurn, note: 'ユーザー宛て。PMO が受け持つものは「確認中」' },
    { from: '入力待ち', to: WORDS.yourTurn, note: 'ユーザー宛て。PMO が受け持つものは「確認中」' },
    { from: '回答待ち', to: WORDS.yourTurn, note: 'ユーザー宛て。PMO が受け持つものは「確認中」' },
    { from: 'キュー', to: WORDS.queue, note: '' },
    { from: 'バックログ', to: WORDS.queue, note: '' },
    { from: '待ち行列', to: WORDS.queue, note: '' },
    { from: '管理エージェント', to: WORDS.pmo, note: '' },
    { from: '休止（タブ）', to: WORDS.done, note: 'タブの rest。「完了（休止中）」も「完了」' },
    { from: '休止（受け箱の hold）', to: WORDS.hold, note: '' },
    { from: '再開（--resume）', to: WORDS.resume, note: 'CLI のオプション名を見せない' },
    { from: 'Auto-yes', to: WORDS.autoYes, note: '上部バーから外し、設定に置く' },
    { from: 'PMO から', to: WORDS.pmoLog, note: 'お知らせと解決した指摘。提案は「要対応」' },
    { from: 'あなたの番', to: WORDS.yourTurn, note: 'タブ名は名詞にする（docs/ui-wording.md）' },
    { from: '次に始まる', to: WORDS.nextTask, note: '見出しは名詞。行の状態は「次」' },
    { from: '待機中 / 待機', to: WORDS.queue, note: 'タスクの pending の語を「待ち」にそろえる。セッションの idle の呼び名は U6 で決める' },
    { from: '振り分け済み', to: WORDS.inboxOpen, note: '依頼の routed' },
    { from: '放置', to: '止まって N 分', note: 'アプリの内部の語を見せない' },
    { from: '見回り', to: '（出さない）', note: '結果は「PMO の記録」に残す' },
    { from: '待ちが長い / 待ちの見張り', to: '止まって N 分', note: '' },
  ]);

  const INBOX_STATUS = Object.freeze({
    new: { short: '受付', full: 'PMO がまだ振り分けていない依頼' },
    asking: { short: '要対応', full: 'PMO が質問しています。「要対応」で答えてください' },
    hold: { short: '保留', full: '保留にした依頼。再開するまで PMO は振り分けません' },
    routed: { short: '対応中', full: 'PMO がプロジェクトのタスクに振り分けました' },
    done: { short: '完了', full: '振り分けたタスクが済みました' },
    failed: { short: '失敗', full: '振り分けたタスクが失敗しました' },
    dropped: { short: '取り下げ', full: '取り下げた依頼' },
  });

  const BACKLOG_STATUS = Object.freeze({
    pending: { short: '待ち', full: '始まるのを待っているタスク' },
    active: { short: '動作中', full: 'セッションで動いているタスク' },
    done: { short: '完了', full: '済んだタスク' },
    failed: { short: '失敗', full: '失敗したタスク' },
    dropped: { short: '取り消し', full: '取り消したタスク' },
  });

  // src/main/sched.js の待ちの理由（code）。full は今の text と同じ意味（数や名前の入らない形）。
  // 数や名前を入れた全文は sched の text をそのまま使う。
  const WAIT_REASON = Object.freeze({
    'after-failed': { short: '待ち（前提が失敗）', full: '前提のタスクが失敗しています' },
    after: { short: '待ち（前提）', full: '前提のタスクが済んでいません' },
    overlap: { short: '待ち（重なり）', full: '同じファイルを触るタスクが動いています' },
    limit: { short: '待ち（上限）', full: '同時に動かす上限に達しています' },
    resource: { short: '待ち（資源）', full: '資源の余裕がありません' },
    update: { short: '待ち（更新）', full: '更新の再起動の後に始めます' },
    closed: { short: '待ち（閉じている）', full: 'フォルダを開くと始まります' },
  });

  // 「PMO の記録」の種類（UIUX U4。src/main/notices.js forLog の kind）。short は絞り込みの印、full はツールチップ。
  const LOG_KIND = Object.freeze({
    push: { short: '後押し', full: '止まったセッションの確認を PMO が押した・待っているセッションに声をかけた' },
    route: { short: '振り分け', full: '依頼をフォルダのタスクに分けた' },
    order: { short: '順番', full: '待ちのタスクの順番を変えた' },
    fix: { short: '立て直し', full: 'タスクの状態を直した・止まりが解けた' },
    clean: { short: '片付け', full: '要らなくなったタスクを片付けた' },
    done: { short: '完了', full: 'タスクが済んだ・失敗した' },
    release: { short: '更新', full: '新しい版を入れた（release）・再起動' },
    handoff: { short: '引き継ぎ', full: 'コンテキストやメモリが満ちて新しいセッションへ引き継いだ' },
    info: { short: 'お知らせ', full: 'PMO やアプリからのお知らせ' },
    warn: { short: '指摘', full: 'PMO やアプリの見回りで見つけたこと（PMO が立て直します）' },
  });

  const TABLES = { inbox: INBOX_STATUS, backlog: BACKLOG_STATUS, wait: WAIT_REASON, log: LOG_KIND };

  function status(kind, code) {
    const t = TABLES[kind];
    const hit = t && typeof code === 'string' && Object.prototype.hasOwnProperty.call(t, code) ? t[code] : null;
    if (hit) return { short: hit.short, full: hit.full };
    return { short: code == null ? '' : String(code), full: '' };
  }

  function oneLine(s) {
    return String(s).replace(/\s+/g, ' ').trim();
  }

  function provisionalTitle(text, max) {
    if (max === undefined || max === null) max = 20;
    if (typeof text !== 'string') return '';
    const line = text.split(/\r?\n/).find((l) => l.trim() !== '');
    if (!line) return '';
    let s = line.trim();
    s = s.replace(/^#{1,6}(\s+|$)/, '');
    s = s.replace(/^(?:[-*+]|\d+[.)])\s+/, '');
    s = s.replace(/^(?:>\s?)+/, '');
    s = s.replace(/\*\*|__|`/g, '');
    s = oneLine(s);
    const cps = Array.from(s);
    if (cps.length > max) return cps.slice(0, max).join('') + '…';
    return s;
  }

  function taskNo(item) {
    if (!item) return '';
    if (typeof item.no === 'string' && item.no) return item.no;
    if (typeof item.reqNo === 'string' && item.reqNo) return item.reqNo;
    return '';
  }

  function taskTitle(item, max) {
    if (!item) return '';
    const t = typeof item.title === 'string' ? oneLine(item.title) : '';
    if (t) return t;
    return provisionalTitle(item.text, max === undefined || max === null ? 20 : max);
  }

  function taskName(item, opts) {
    return [taskNo(item), taskTitle(item, opts && opts.max)].filter(Boolean).join(' ');
  }

  // number filter: a part of any number of the item, case-insensitive ('AT-12' / 'at-12' / '12'). An inbox item is hit by
  // its own task number (no), its request number (reqNo, 依頼-N) and the task numbers of the backlog items it was routed
  // to (more: ['AT-3', …], e.g. the ones tied by links for requests routed before U1). Empty query -> false.
  function matchNo(item, query, more) {
    if (typeof query !== 'string') return false;
    const q = query.trim().toLowerCase();
    if (!q) return false;
    const nos = [item && item.no, item && item.reqNo].concat(Array.isArray(more) ? more : []);
    return nos.some((no) => typeof no === 'string' && no !== '' && no.toLowerCase().includes(q));
  }

  // AT-6: the small mark of the model / effort a routed item's session starts with. item.model / item.effort = set by
  // the PMO at route / create (own); defaults = { model, effort } of the settings (models:get session), optional.
  // -> { text: 'opus-5-5 · high', title, own } or null (nothing to show: no own value and no defaults)
  function modelMark(item, defaults) {
    const it = item || {};
    const d = defaults || {};
    const model = it.model || d.model || '';
    const effort = it.effort || d.effort || '';
    if (!model && !effort) return null;
    const own = !!(it.model || it.effort);
    const short = String(model).replace(/^claude-/, '');
    const text = [short, effort].filter(Boolean).join(' · ');
    const title = `モデル: ${model || '既定'}${it.model ? '（PMO の指定）' : '（既定）'}\neffort: ${effort || '既定'}${it.effort ? '（PMO の指定）' : '（既定）'}`;
    return { text, title, own };
  }

  // ---- キーと近道（UX4 = docs/mac-polish.md M2〜M4、docs/ux-journey.md §5.7） ----
  // 近道の表は 1 つ（UX16 のコマンドパレットも同じ表を使う）。keys は 'mod+shift+B' の形で書く: mod は Mac で ⌘
  // （metaKey）、Windows で Ctrl（ctrlKey）。ctrl は両方で Control のキー。画面の表記は key() で出し分け、画面の文に
  // 「Ctrl」を直に書かない（Claude Code 自身のキーは Mac でも Ctrl なので、それだけはそのまま書く）。
  // sheet: チートシートの「BantoDesk」に出す。
  const SHORTCUTS = Object.freeze([
    { id: 'newTab', keys: 'mod+shift+T', label: '新しいセッション（タブ）', sheet: true },
    { id: 'closeTab', keys: 'mod+shift+W', label: 'タブを閉じる', sheet: true },
    { id: 'folder', keys: 'mod+shift+O', label: 'フォルダを切り替え', sheet: true },
    { id: 'autoYes', keys: 'mod+shift+Y', label: '安全な確認は自動で通す の ON / OFF', sheet: true },
    { id: 'layout', keys: 'mod+shift+L', label: 'レイアウトのプリセット切替（1 / 2 / 2×2）', sheet: true },
    { id: 'history', keys: 'mod+shift+H', label: 'セッション履歴', sheet: true },
    { id: 'cheatsheet', keys: 'mod+shift+P', label: 'チートシート', sheet: true },
    { id: 'viewMode', keys: 'mod+shift+M', label: '会話 → ターミナル → 並べる の切り替え', sheet: true },
    { id: 'backlog', keys: 'mod+shift+B', label: '待ちの一覧', sheet: true },
    { id: 'viewer', keys: 'mod+shift+F', label: 'ファイルをビューアで開く', sheet: true },
    { id: 'pmoLog', keys: 'mod+shift+E', label: 'PMO の記録', sheet: true },
    { id: 'tempSession', keys: 'mod+shift+N', label: '一時セッション（別ウィンドウ）', sheet: true },
    { id: 'cycleTab', keys: 'ctrl+Tab', label: '次のタブへ（Shift で前へ）', sheet: true, shiftAny: true },
  ]);

  function detectOs() {
    try {
      if (typeof navigator !== 'undefined' && navigator && typeof navigator.platform === 'string' && navigator.platform) {
        if (/^mac|darwin/i.test(navigator.platform)) return 'darwin';
        if (/^win/i.test(navigator.platform)) return 'win32';
      }
    } catch (_) {}
    if (typeof process !== 'undefined' && process && process.platform) return process.platform;
    return 'win32';
  }
  let OS = null;
  function os(o) {
    if (o) return o;
    if (!OS) OS = detectOs();
    return OS;
  }
  function isMac(o) {
    return os(o) === 'darwin';
  }

  const MAC_SYM = { ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘', cmd: '⌘', meta: '⌘' };
  const WIN_WORD = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', mod: 'Ctrl', cmd: 'Win', meta: 'Win' };
  const MAC_ORDER = ['ctrl', 'alt', 'shift', 'mod', 'cmd', 'meta'];
  const WIN_ORDER = ['mod', 'ctrl', 'alt', 'shift', 'cmd', 'meta'];

  // key('mod+shift+B') -> Mac '⇧⌘B' / Windows 'Ctrl+Shift+B'; key('mod+Enter') -> '⌘Enter' / 'Ctrl+Enter'.
  function key(spec, o) {
    const parts = String(spec || '').split('+').filter(Boolean);
    if (!parts.length) return '';
    const last = parts[parts.length - 1];
    const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
    const mac = isMac(o);
    const order = mac ? MAC_ORDER : WIN_ORDER;
    const sorted = mods.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const k = last.length === 1 ? last.toUpperCase() : last;
    if (mac) return sorted.map((m) => MAC_SYM[m] || m).join('') + k;
    return sorted.map((m) => WIN_WORD[m] || m).concat([k]).join('+');
  }

  // the event's modifiers as the table writes them: mod = metaKey on Mac, ctrlKey on Windows
  function modOf(e, o) {
    return isMac(o) ? !!e.metaKey : !!e.ctrlKey;
  }
  // "mod or the other one" for send keys (⌘Enter on Mac, Ctrl+Enter on Windows; both are accepted on both, as before)
  function sendMod(e) {
    return !!(e && (e.ctrlKey || e.metaKey));
  }
  function codeOf(k) {
    if (/^[A-Za-z]$/.test(k)) return 'Key' + k.toUpperCase();
    if (/^[0-9]$/.test(k)) return 'Digit' + k;
    return k;
  }
  // does the keydown e match spec? Exact modifiers (shiftAny: Shift either way). Mac only: a 'mod+shift+X' shortcut also
  // answers to Ctrl+Shift+X (as before UX4; Claude Code has no Ctrl+Shift keys and the e2e send them).
  function matchKey(e, spec, o, shiftAny) {
    if (!e) return false;
    const parts = String(spec || '').split('+').filter(Boolean);
    const k = parts[parts.length - 1];
    const want = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
    if (e.code !== codeOf(k)) return false;
    const mac = isMac(o);
    const need = { ctrl: want.has('ctrl'), meta: false, alt: want.has('alt'), shift: want.has('shift') };
    if (want.has('mod')) {
      if (mac) need.meta = true;
      else need.ctrl = true;
    }
    const same = (n) => !!e.ctrlKey === n.ctrl && !!e.metaKey === n.meta && !!e.altKey === n.alt && (shiftAny || !!e.shiftKey === n.shift);
    if (same(need)) return true;
    if (mac && want.has('mod') && want.has('shift') && !want.has('ctrl')) return same({ ctrl: true, meta: false, alt: need.alt, shift: true });
    return false;
  }
  // the shortcut id of a keydown, or null
  function shortcutOf(e, o) {
    if (!e || (e.type && e.type !== 'keydown')) return null;
    for (const s of SHORTCUTS) if (matchKey(e, s.keys, o, s.shiftAny)) return s.id;
    return null;
  }
  function shortcutKey(id, o) {
    const s = SHORTCUTS.find((x) => x.id === id);
    return s ? key(s.keys, o) : '';
  }

  return {
    SHORTCUTS,
    os,
    isMac,
    key,
    modOf,
    sendMod,
    matchKey,
    shortcutOf,
    shortcutKey,
    REQ_PREFIX,
    WORDS,
    RENAMED,
    INBOX_STATUS,
    BACKLOG_STATUS,
    WAIT_REASON,
    LOG_KIND,
    status,
    provisionalTitle,
    taskNo,
    taskTitle,
    taskName,
    matchNo,
    modelMark,
  };
});
