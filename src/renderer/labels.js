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
    checking: '確認中', // ルーターが受け持つ確認
    queue: '待ち', // 旧 キュー / バックログ / 待ち行列
    pmo: 'ルーター', // 旧 PMO・管理エージェント（表示だけ。内部の名前 pmo・manager・pmo: の key は互換のため変えない）
    done: '完了', // タブの rest（旧 休止）も含む
    hold: '保留', // 依頼の hold（旧 休止）
    resume: '再開', // --resume を見せない
    autoYes: '安全な確認は自動で通す', // 旧 Auto-yes
    projects: 'プロジェクト', // 旧 受け箱・フォルダ
    allDone: 'すべて完了', // U8: 見直しで次の作業が出なかったフォルダの印（新しい依頼で外れる）
    reviewing: '見直し中', // U8: アプリが積んだ見直しが動いている
    pmoLog: 'ルーターの記録', // 旧 PMO から（お知らせ・解決した指摘）
    settings: '設定',
    dashboard: 'ダッシュボード',
    running: '動作中',
    failed: '失敗',
    error: 'エラー',
    dropReq: '取り下げ', // 依頼をやめる
    dropTask: '取り消し', // 待ちのタスクをやめる
    proposal: '提案',
    pmoChat: 'ルーターに相談',
    newReq: '受付',
    stalled: '止まって', // 「止まって 4 分」（旧 放置）
    // UX12: ホームの安心の 1 行と要対応の下の欄（docs/ux12-check.md、src/renderer/reassure.js）
    away: '留守の間', // 最後に画面を離れてから起きたことの数
    postCheck: '事後の確認', // 仮説で進めたことの見直し（答えなくても進む）
    wrongHypo: '違う', // 事後の確認の 1 行を ルーターに返す
    lastMove: '最後の動き',
    afterThis: 'この後', // 何も起きなければ次にアプリ・ルーターがすること
    needWindows: 'Windows の PC が要るもの',
    needHands: '手で見てほしいもの',
    notUrgent: '急ぎでない',
    // UX13: ホームの中で会話を開く（src/renderer/session-view.js、docs/ux13-check.md）
    home: 'ホーム', // 会話から戻る先（「← ホーム」）
    workbench: '作業台', // フォルダの窓（ターミナル・並べる・ビューア）
    openWorkbench: '作業台で開く',
    directTalk: 'このセッションに直接話す（ルーターを通さない）', // ホームの会話の入力欄
    sessionClosed: 'このセッションは閉じています',
    // UX14: メインの窓の左のナビとパンくず、作業台の入口（docs/ux14-check.md）
    terminal: 'ターミナル', // 会話の上の行: 作業台でこのセッションをターミナルで開く
    modeConv: '会話', // 作業台のペインの表示（会話 / ターミナル / 並べる をメニューで選ぶ）
    modeSplit: '並べる',
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
    // UX16: ⌘K のコマンドパレット（旧「⋯ その他」のメニューの中身もここ）
    palette: 'コマンドパレット',
    palettePlaceholder: '操作・タスクの番号・フォルダ・ファイルを探す',
    paletteEmpty: '見つかりません',
    paletteKinds: '操作 / タスク / 依頼 / セッション / フォルダ / ファイル', // 結果の段の名前（下の PALETTE_KIND）
    dropSee: '見る', // ドロップの帯の左の的: ビューアで開く（MD / HTML / 画像 / PDF / xlsx）
    dropEdit: '直す', // ドロップの帯の右の的: 編集モード（作業用コピー）で開く
    sessionOptions: '新しいセッション・履歴',
    viewer: 'ファイルをビューアで開く',
    queueList: 'ホームで待ちを見る', // UX15: ホームをこのフォルダに絞る（旧 待ちの一覧 = バックログのパネル）
    cheatsheet: 'チートシート',
    remote: 'リモート（スマホから）',
    hiddenTabs: '入りきらないタブ', // 右端の「▾ N」
    sidePanel: 'サイドパネル',
    // U6: 会話ビュー（依頼-42）
    ops: '件の操作', // 古いターンのツールの行をまとめた 1 行「12 件の操作」
    openDiffs: '差分を開いて表示', // 設定。既定はオフ（差分は 1 行の要約で閉じる）
    openResults: '結果を開いて表示', // 設定。既定はオフ（Bash などの出力は 1 行の要約で閉じる）
    leanPreamble: '前置きを削る', // TK3。⚙ 設定のスイッチ（アプリ全体、manager-settings.json leanPreamble）
    leanPreambleTip: '切ると使えなくなるもの: claude.ai のコネクタ（Gmail・Drive・Adobe など）と、アカウントの skill・プラグイン（docx・pptx・xlsx・deep-research など）。次に起動する claude から効きます（動いている claude は変わりません）', // TK3。スイッチの説明の 1 行
    leanKeep: 'このフォルダでは削らない', // TK3。ホームのカード。leanPreambleOff に足す
    leanKeepOn: 'このフォルダは削らない', // TK3。足したあとの印（押すと外す = 削る に戻す）
    pmoMaxTok: 'ルーターの文脈の上限', // TK1。設定 > 引き継ぎ。トークン数（既定 200000、0 で使わない）
    look: '見た目', // UX17。設定の節
    theme: '地の色', // UX17。設定 > 見た目。暗い / 明るい / OS に合わせる（localStorage theme、theme.js）
    themeOs: 'OS に合わせる',
    themeDark: '暗い',
    themeLight: '明るい',
    zoom: '拡大率', // UX18。設定 > 見た目。80〜150%。全部のウィンドウで同じ（app-settings.json zoom）
    zoomNormal: '標準',
    zoomTip: '画面の文字と部品の大きさ。全部のウィンドウで同じです。キーでも変えられます: {keys}', // {keys} = Labels.key の mod+= / mod+- / mod+0
    zoomTipTerm: 'ターミナルの中では、縮小と 100% のキーは Claude Code に送ります', // UX18。Windows だけ添える（Ctrl+- は Claude Code の取り消し）
    themeTip: '窓の地の色。OS に合わせるなら、OS のダーク / ライトの切り替えについていきます。全部のウィンドウで同じ設定です。ターミナルは明るい地でも暗いままです（Claude Code が暗い地の色で描くため）',
    // 待ちの順番（docs/queue-order.md）: ホームのカードの待ちの欄
    queueOrder: '送る順', // カードの待ちの欄の見出し。上から順に新しいセッションで始める
    nextStart: '次', // 全体（フォルダをまたぐ）で次に始まるタスクの行の状態（旧 次に始まる）
    nextTask: '次のタスク', // プロジェクトのタブの上の 1 行の見出し「次のタスク: A · AT-61 見出し」（src/main/queueorder.js の line）
    startSoon: 'まもなく開始', // 空きがあり、次の見回りで始まるタスク（旧 すぐ始まる）
    orderLocked: '手で並べた順', // ↑ ↓ の後 24 時間は ルーターが並べ替えない印（残り時間を添える）
    askPmoOrder: '順番の見直し', // ひとこと書いて ルーターへの依頼に足すボタン（旧 PMO に順番を見直してもらう）
    pmoReordered: 'ルーターの並べ替え', // ルーターの最後の reorder と理由
    // UX5: 設定の節
    workAndModel: '作業とモデル', // 旧「ダッシュボード」の節（置き場所・モデル・止まりの見張り）。上から 2 番目
    phone: 'スマホ', // スマホから操作する（リモート）の ON / OFF の節。ホームの上の帯には ON のときだけ印
    // UA3: 問題のときのセッション画面（docs/usage-analytics.md §5）
    workDetail: 'この作業', // パレット（旧 ⋯ の中）。「この作業」の欄を出す・しまう（旧 この作業の詳しく = アシストパネル）
    // UX15: 「この作業」の欄（作業台とホームの会話の右）とカードの行のメニュー
    thisWork: 'この作業', // 欄の名前（旧 アシストパネルの 6 タブ: 概要・タスク・チーム・エージェント・変更ファイル・ツール）
    autoSend: '一通り終わったら自動で送る', // この作業の「待ち」の行（旧 バックログのパネルの見出し）
    restart: '再起動', // この作業の下（再起動の入口はここだけ。終わった claude の「再開」はタブのメニューと帯にも残る）
    handoff: '引き継ぐ', // この作業の下（引き継ぎの入口はここだけ）
    openFolder: 'フォルダを開く', // この作業の下。Finder / エクスプローラーで開く
    markDone: '完了にする', // カードの行の ⋯（動作中のタスク。旧 バックログのパネルの「完了」）
    fixTitle: '見出しを直す', // カードの行の ⋯（待ちのタスク）と依頼の ⋯。空なら本文の先頭から（旧 バックログのパネルの「編集」の見出し）
    reopen: '戻す', // カードの行の ⋯（完了・失敗・取り消しのタスクをもう一度待ちに）
    showTerminal: 'ターミナル', // パレット（旧 ⋯ の中）。会話 ⇄ ターミナルの切り替え（旧 ペインの見出しのボタン）
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
    { from: '確認待ち', to: WORDS.yourTurn, note: 'ユーザー宛て。ルーターが受け持つものは「確認中」' },
    { from: '入力待ち', to: WORDS.yourTurn, note: 'ユーザー宛て。ルーターが受け持つものは「確認中」' },
    { from: '回答待ち', to: WORDS.yourTurn, note: 'ユーザー宛て。ルーターが受け持つものは「確認中」' },
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
    { from: '見回り', to: '（出さない）', note: '結果は「ルーターの記録」に残す' },
    { from: '待ちが長い / 待ちの見張り', to: '止まって N 分', note: '' },
  ]);

  const INBOX_STATUS = Object.freeze({
    new: { short: '受付', full: 'ルーターがまだ振り分けていない依頼' },
    asking: { short: '要対応', full: 'ルーターが質問しています。「要対応」で答えてください' },
    hold: { short: '保留', full: '保留にした依頼。再開するまで ルーターは振り分けません' },
    routed: { short: '対応中', full: 'ルーターがプロジェクトのタスクに振り分けました' },
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

  // 「ルーターの記録」の種類（UIUX U4。src/main/notices.js forLog の kind）。short は絞り込みの印、full はツールチップ。
  const LOG_KIND = Object.freeze({
    push: { short: '後押し', full: '止まったセッションの確認を ルーターが押した・待っているセッションに声をかけた' },
    route: { short: '振り分け', full: '依頼をフォルダのタスクに分けた' },
    order: { short: '順番', full: '待ちのタスクの順番を変えた' },
    fix: { short: '立て直し', full: 'タスクの状態を直した・止まりが解けた' },
    clean: { short: '片付け', full: '要らなくなったタスクを片付けた' },
    done: { short: '完了', full: 'タスクが済んだ・失敗した' },
    release: { short: '更新', full: '新しい版を入れた（release）・再起動' },
    handoff: { short: '引き継ぎ', full: 'コンテキストやメモリが満ちて新しいセッションへ引き継いだ' },
    info: { short: 'お知らせ', full: 'ルーターやアプリからのお知らせ' },
    warn: { short: '指摘', full: 'ルーターやアプリの見回りで見つけたこと（ルーターが立て直します）' },
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
  // the ルーター at route / create (own); defaults = { model, effort } of the settings (models:get session, or kinds[kind]
  // for an item with a kind, MODEL-KIND), optional.
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
    const dflt = it.kind ? `（${it.kind} の既定）` : '（既定）';
    const title = `モデル: ${model || '既定'}${it.model ? '（ルーターの指定）' : dflt}\neffort: ${effort || '既定'}${it.effort ? '（ルーターの指定）' : dflt}`;
    return { text, title, own };
  }

  // ---- 操作の表（UX16 = docs/ux-journey.md §6、docs/ux16-check.md。UX4 の近道の表を広げた） ----
  // 操作は表 1 つ: ここからコマンドパレット（palette.js）・近道（shortcutOf）・チートシートのキーの一覧（cheatsheet.js）
  // を作る。何をするかだけは renderer.js の COMMAND_RUN（id → 関数）にある。
  //   id: 操作の名前（usage の key.* / palette.cmd.* にも使う）。label: パレットとキーの一覧に出す文
  //   keys: 近道（無ければパレットだけ）。'mod+shift+B' の形で書く: mod は Mac で ⌘（metaKey）、Windows で Ctrl（ctrlKey）。
  //         ctrl は両方で Control のキー。画面の表記は key() で出し分け、画面の文に「Ctrl」を直に書かない（Claude Code
  //         自身のキーは Mac でも Ctrl なので、それだけはそのまま書く）。
  //   win: Windows だけの近道（keys が Claude Code のキーとぶつかるとき。Ctrl+K は Claude Code の「行末まで消す」）
  //   where: どこで効くか（パレットに出す場所）: 'all' どこでも / 'work' 作業台（フォルダの窓）/ 'home' ホーム（メインの窓）
  //   sheet: チートシートの「BantoDesk」に出す（keys があるものだけ）。words: 探すときの別の言い方
  // Auto-yes（安全な確認は自動で通す）は設定の中だけ（UX16。旧 ⋯ と ⇧⌘Y）。
  const WHERE = Object.freeze({ all: 'どこでも', work: '作業台', home: 'ホーム' });
  const COMMANDS = Object.freeze([
    { id: 'palette', keys: 'mod+K', win: 'mod+shift+K', label: 'コマンドパレット（操作・タスク・フォルダ・ファイルを探す）', where: 'all', sheet: true, words: '探す 検索 search' },
    { id: 'newTab', keys: 'mod+shift+T', label: '新しいセッション（タブ）', where: 'work', sheet: true },
    { id: 'closeTab', keys: 'mod+shift+W', label: 'タブを閉じる', where: 'work', sheet: true },
    { id: 'cycleTab', keys: 'ctrl+Tab', label: '次のタブへ（Shift で前へ）', where: 'work', sheet: true, shiftAny: true },
    { id: 'layout', keys: 'mod+shift+L', label: 'レイアウトのプリセット切替（1 / 2 / 2×2）', where: 'work', sheet: true },
    { id: 'terminal', label: 'ターミナルを表示（会話 ⇄ ターミナル）', where: 'all', words: 'terminal 作業台 端末' },
    { id: 'detail', label: '「この作業」の欄を出す / しまう', where: 'work', words: 'パネル 概要' },
    { id: 'viewer', keys: 'mod+shift+F', label: 'ファイルをビューアで開く', where: 'work', sheet: true, words: 'プレビュー 見る' },
    { id: 'sim', label: 'iOS シミュレータを表示', where: 'work', words: 'simulator ios iphone アプリ 画面 スマホ' }, // IOS-SIM（Mac で simctl があるときだけパレットに出す）
    { id: 'present', label: '資料（pptx）を開く', where: 'work', words: 'present スライド パワポ powerpoint プレゼン 資料 pptx' }, // 18 資料パネル
    { id: 'browser', label: 'ブラウザを開く', where: 'work', words: 'browser web サイト localhost url 内蔵 ページ' }, // 内蔵ブラウザ（PROGRESS 6）
    { id: 'editFile', label: 'ファイルを編集…（作業用コピーで直して書き戻す）', where: 'all', words: '直す 編集 edit' },
    { id: 'backlog', keys: 'mod+shift+B', label: 'ホームでこのフォルダの待ちを見る', where: 'work', sheet: true, words: '待ち バックログ キュー' }, // UX15（旧 待ちの一覧）
    { id: 'history', keys: 'mod+shift+H', label: 'セッション履歴・新しいセッションの種類', where: 'work', sheet: true, words: 'チーム ワークツリー 再開' },
    { id: 'newSession', label: '新しいセッション（フォルダを開く・新しい作業）', where: 'home', words: 'フォルダ 作業' },
    { id: 'tempSession', keys: 'mod+shift+N', label: '一時セッション（別ウィンドウ）', where: 'all', sheet: true },
    { id: 'folder', keys: 'mod+shift+O', label: 'フォルダを切り替え', where: 'all', sheet: true },
    { id: 'home', label: 'ホームを開く', where: 'work', words: 'ダッシュボード あなたの番' },
    { id: 'pmoLog', keys: 'mod+shift+E', label: 'ルーターの記録', where: 'all', sheet: true, words: 'ログ 履歴 通知' },
    { id: 'remote', label: 'リモート（スマホから）', where: 'work', words: 'スマホ remote' },
    { id: 'settings', label: '設定', where: 'all', words: '安全な確認は自動で通す 通知 引き継ぎ settings' },
    { id: 'cheatsheet', keys: 'mod+shift+P', label: 'チートシート（キーの一覧）', where: 'all', sheet: true, words: 'キー 近道 ショートカット' },
  ]);
  // 近道のあるものだけ（UX4 からの名前。usage の key.* はこの id）
  const SHORTCUTS = Object.freeze(COMMANDS.filter((c) => c.keys));

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
  // a command's keys on this OS (win: the Windows one when it has one)
  function keysOf(c, o) {
    if (!c || !c.keys) return '';
    return !isMac(o) && c.win ? c.win : c.keys;
  }
  // the shortcut id of a keydown, or null
  function shortcutOf(e, o) {
    if (!e || (e.type && e.type !== 'keydown')) return null;
    for (const s of SHORTCUTS) if (matchKey(e, keysOf(s, o), o, s.shiftAny)) return s.id;
    return null;
  }
  function shortcutKey(id, o) {
    const s = SHORTCUTS.find((x) => x.id === id);
    return s ? key(keysOf(s, o), o) : '';
  }
  // the cheat sheet's BantoDesk rows: [[key], label] for each command with keys and sheet (UX16: from the one table, so a
  // removed key cannot stay in the list)
  function sheetRows(o) {
    return SHORTCUTS.filter((s) => s.sheet).map((s) => [[key(keysOf(s, o), o)], s.label]);
  }
  // the palette's command rows for a window: where 'all' and the window's own ('work' | 'home')
  // -> [{ id, label, key, where, words }]
  function paletteCommands(place, o) {
    return COMMANDS.filter((c) => c.where === 'all' || c.where === place).map((c) => ({ id: c.id, label: c.label, key: c.keys ? key(keysOf(c, o), o) : '', where: WHERE[c.where] || '', words: c.words || '' }));
  }

  return {
    COMMANDS,
    WHERE,
    SHORTCUTS,
    keysOf,
    sheetRows,
    paletteCommands,
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
