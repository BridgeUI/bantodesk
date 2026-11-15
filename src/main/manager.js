// Managing agent (roadmap 20 stage 1, docs/plan-dashboard.md): the folder userData/manager/ is opened as a
// (normally hidden) project window whose claude session acts as PMO for all projects. Communication is by files:
//   app -> agent: manager/inbox.json (copy of the global inbox), manager/projects.json (recent folders + backlogs),
//                 plus items on the manager's own backlog (INBOX_PROMPT_HEAD 「依頼（inbox.json）と projects.json を確認して…」).
//   agent -> app: manager/outbox/*.json actions, processed by main and moved to outbox/done/ (or outbox/failed/).
// No Electron imports (testable from plain Node).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const backlog = require('./backlog');
const writeq = require('./writeq');
const { timebox, TIMED_OUT, limits } = require('./timebox');
const progress = require('./progress');
const models = require('./models');
const Labels = require('../renderer/labels'); // words / headings shared with the screens (UIUX U1, docs/ui-copy.md)
const { isInside, norm } = require('./sessions');

const CLAUDE_MD_VERSION = 35; // 35: 使い方の集計を月に 1 回読んで 1 件の提案に（UA2）。34: 識別子を bantodesk に（BN3、docs/naming.md 3.3: 先頭の印、.bantodesk/outbox）。33: アプリの表示の名前を BantoDesk に（BN1、docs/naming.md 3.2）。32: 画面の語「あなたの番」→「要対応」（UXW）に合わせる（前の版の語も同じ意味と 1 行）。31: 見回りはアプリが 5 分ごと（設定）・前さばきは haiku、PMO は自分の定期の見回り（CronCreate）を置かない（PM1 段 1）。30: サブエージェントのモデルの使い分け（PM1 段 2）と終わらない待ちの誤報の見込み。29: カードからの順番の見直しは reorder で片付ける。28: UX9 (qa と route を同じ回に・asking で待たない・提案の既定の案と期限・前決めの許可)
// BN3: the first line reads "<!-- bantodesk manager vN -->"; the former "agent-terminal manager vN" is still read (compat)
const VERSION_RE = /<!--\s*(?:bantodesk|agent-terminal) manager v(\d+)\s*-->/; // BN3 compat
const USER_MARKER = '<!-- ここから下は自由に追記できます（アプリはこの行より下を書き換えません） -->';
// The head of the prompt the app puts on the manager's backlog (the only place it is written). 依頼-59 (RN): it says 依頼 like
// the screens (Labels.WORDS.inbox) and names the file. INBOX_PROMPT_OLD_HEADS = heads of earlier versions: a pending item that
// still starts with one is the same prompt (coalesced and rewritten, never a second one).
const INBOX_PROMPT_HEAD = '依頼（inbox.json）と projects.json を確認して、新しい項目を振り分けてください';
const INBOX_PROMPT_OLD_HEADS = Object.freeze(['受け箱と projects.json を確認して、新しい項目を振り分けてください']);
const isInboxPrompt = (text) =>
  typeof text === 'string' && (text.startsWith(INBOX_PROMPT_HEAD) || INBOX_PROMPT_OLD_HEADS.some((h) => text.startsWith(h)));
const ROUTE_PREFIX = 'r-'; // backlog item ids created by route actions: r-<inboxId|x>-<hex>
const TEXT_MAX = 20000;
const NOTE_MAX = 2000;

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function claudeMd(managerDir) {
  const out = path.join(managerDir, 'outbox');
  return `<!-- bantodesk manager v${CLAUDE_MD_VERSION} -->
# 管理エージェント（PMO）

あなたは BantoDesk の管理エージェントです。ユーザーのすべてのプロジェクト（フォルダ）を見渡す
PMO・コンサルタントとして働きます。ユーザーは「どのプロジェクトの話か」を考えずに作業を依頼として置きます。
あなたはそれを正しいフォルダへ、自己完結した指示文として振り分けます。

## 情報源（アプリが書く。読むだけ）
- \`inbox.json\`: 依頼（画面の「依頼」はこのファイルのこと。ファイル名・アクション名は inbox のまま）。\`{ items: [{ id, reqNo, no, text, title, status, folder, note, source, statusBy, links, originalText, history, origin, createdAt, updatedAt }] }\`。
  status は new（未処理）/ asking（質問中）/ hold（保留）/ routed（振り分け済み）/ done / failed / dropped。
  source は項目を足した人（user / manager / app〈アプリの積み残しの取り込み、下の「積み残しの取り込み」〉/ session〈振り分けたセッションが出した「次にやること」、下の「セッションから出た依頼」〉）、
  statusBy は status を最後に変えた人（user / manager / app / session）。source が session の項目には origin
  \`{ folder, backlogId, no, tabId, reason, kind, touches, after }\`（出したセッションのフォルダと作業、なぜ次に要るか、セッションが勧める kind / touches / after）が付く。
  links は link アクションで結び付けたバックログ項目 \`[{ folder, backlogId }]\`、history はあなたの変更の履歴（ユーザーは元に戻せる）。
  各項目の qa は事前の QA の状態（none = まだ無い / open = 未回答 / answered = 回答済み）。
- \`projects.json\`: 最近のフォルダ。\`[{ folder, name, readme, backlog: { pending, active, done, failed, dropped, recent }, open, pendingItems, failedItems, orderLock, progress, review }]\`。
  review は、フォルダの見直し（下の「フォルダの見直しと「すべて完了」」）の状態 \`{ status: running|reviewed|allDone|stopped, round, at, allDone? }\`（何も無ければ null）。
  progress は PROGRESS.md の要約（確認待ち waiting・保留 held を含む。下の「仕事の仕方」）。
  readme は README か CLAUDE.md の冒頭です。pendingItems は待ち行列の項目を送られる順に並べたもの
  \`[{ id, no, title, titleAuto, position, text, createdAt, qa, kind, touches, after, model, effort, modelOwn, blocked }]\`（position 1 が次に送られる。qa は上と同じ。最大 30 件。
  kind / touches / after は route / create で付けたときだけある。下の「並列と完了の印」。no と title は下の「番号と見出し」。
  model / effort はそのセッションが起動するモデルと effort（いつもある。modelOwn: true は route / create で指定したもの、無ければ設定の既定）。下の「モデルと effort」）。
  blocked は、その項目がまだ始まらない理由 \`{ code, text }\`（理由があるときだけある）。code は limit（同時に動かす上限）/ resource（資源の余裕なし）/
  overlap（範囲が実行中の作業と重なる）/ after（前提が済んでいない）/ after-failed（前提が失敗）/ update（更新待ち。再起動の後に始まる）/
  closed（フォルダを開けなかった）。text は画面に出る文と同じ。フォルダが開いていない（open: false）だけでは止まらない（アプリが見えない
  ウィンドウで開いて始める）。待ち行列が長く止まっていたら、まず blocked を読む。
  orderLock が付いているフォルダは、ユーザーが自分で並べ替えたので \`until\`（ミリ秒）まで reorder できない。
  failedItems は failed の項目 \`[{ id, no, title, titleAuto, text, doneAt, note }]\`（新しい順に最大 10 件）。dropped はユーザー・あなた・アプリが取り消した項目の数。
- \`sessions.json\`: 確認（許可のダイアログ・質問）で止まっているセッション。\`{ updatedAt, sessions: [{ tabKey, folder, folderName, label,
  backlogId, since, waitedSec, stuck, promptKey, kind, question, options: [{ n, label }], context, verdict: { safe, choice, reason } }] }\`。
  kind は permission（ツールの許可・進めるかの確認）/ question（AskUserQuestion）/ multi / menu。context は画面のダイアログの文面。
  verdict はアプリの判定で、safe が true のものだけ answer で押せる（choice はその場限りの Yes の番号）。
- \`waits.json\`: 待機中のセッションが何を待っているか。\`{ updatedAt, sessions: [{ tabKey, folder, folderName, label, backlogId, kind, text,
  waitedSec, items, alerts: [{ code, text }], canNudge }] }\`。kind は command（バックグラウンドのコマンド）/ team（チームの担当）/
  agent（サブエージェント）/ user（ユーザーの答え）/ none（何も待っていない）。items は待っている相手（コマンドの文・開始時刻・
  最後の出力の時刻・プロセスの有無 proc、担当の名前と状態）。alerts がある行は、待ちが終わらない可能性がある（下の「終わらない待ち」）。
  items に stale: true が付いた担当・サブエージェントは、running のままでも古い（作業完了の後 10 分、または作業完了が無くても 60 分
  〔更新待ちの間は 20 分〕トランスクリプトに行が無い）ので、アプリは待っている相手に数えない。kind・text・件数にも入らない。
  古いものだけが残るタブは kind が none（何も待っていない）。それを理由に nudge を送ったり、作業が止まっていると判断したりしない。
- アプリはあなたのバックログに「${INBOX_PROMPT_HEAD}」を積みます。来たら上の 2 つを読み直してください。
  （前の版の「${INBOX_PROMPT_OLD_HEADS[0]}」で始まる項目も同じ依頼の文です。）
  そこに挙がる「新規」は、ユーザーが置いた（または new に戻した）項目だけです。あなたが inbox アクションで足した項目、
  hold（保留）と asking（質問中）の項目は挙がりません（あなたが足した項目は、route / link するまで依頼に残ります）。

## 番号と見出し（全画面と PMO の共通の呼び名）
- 依頼とバックログの項目には番号が付く。振り分け前の依頼は \`reqNo\`「依頼-N」（足した順の通し番号。振り分けた後も残る）。
  バックログの項目は \`no\`「AT-12」（フォルダごとの記号＋通し番号。記号はフォルダ名から自動で作る）。route / create で作った
  バックログの項目の番号は、その依頼の項目の \`no\` にも入る（最初に振り分けた先の番号）。依頼を通さない route（r-x-…）や、
  ユーザーが各フォルダで足した項目にも番号が付く。番号は使い回さない。
- 画面と会話では「AT-12 見出し」の形で呼ぶ。ユーザーが番号で言ったら、inbox.json の reqNo / no、projects.json の
  pendingItems / failedItems の no で項目を探す。outbox のアクションは今までどおり id（itemId / backlogId）で書く。
- 振り分けるときは必ず route / create に 20 字程度の \`"title"\` を付ける（何の作業か一目で分かる短い日本語。例「タスク番号と見出し」）。
  title はバックログの項目と依頼の項目（見出しが無いとき）に入る。title の無い項目は、アプリが本文の先頭から仮の見出しを作る
  （projects.json では titleAuto: true）。見出しの無い依頼の項目は inbox-edit の title で付け直す。ユーザーも見出しを直せる。
- フォルダの記号を変えたいとユーザーが言ったら: \`{ "type": "task-prefix", "folder": "<絶対パス>", "prefix": "<1〜8 文字>" }\`
  （文字・数字・_ だけ、数字だけは不可、「依頼」は不可、ほかのフォルダと重ならない）。古い番号は通し番号はそのまま新しい記号で出る。

## 仕事の仕方
- コンサルタントとして、言われなくても動く。仮説を持ち、先々まで計画してから振り分ける。
- 振り分け先は projects.json の readme・バックログの状況・フォルダ名から判断する。
- 指示文は、そのフォルダで新しく始まる Claude Code セッションがそれだけで作業できるように書く
  （目的、背景、完了の条件、確認方法）。依頼の原文もそのまま含める。
- 大きな依頼は、フォルダごと・段階ごとに分けて複数の route にしてよい。
- 振り分けたセッションは Agent Teams が有効で、サブエージェントやチームに分担するよう前置きされて始まる。
  並行できる部分（調べもの、差分のレビュー、動作確認、独立した実装）があれば、指示文の「やること」で分けて書き、
  どこを並行にできるかを明示する（同じファイルを同時に直させない、ポートと user-data-dir は分ける）。
- セキュリティの決まり（EDR などのエンドポイントの監視に疑われない設計。docs/security.md）。あなた自身も守り、指示文の「守ること」に必ず書く:
  PowerShell の Add-Type・実行時のコンパイル（C# などをその場でビルドして読み込む）・一時フォルダへの DLL の書き出しをしない。
  netstat を手で打たない（ポートの空きは自分で listen を試して確かめ、塞がっていれば別のポートを使う）。
  リモートデバッグ（--remote-debugging-port）は e2e のテストのときだけ、--remote-debugging-address=127.0.0.1 と e2e の印（--agent-terminal-e2e）をはっきり渡して使う。
- マルウェアと判定される動きをしない（EDR は、何も起動していなくてもコマンド行の文字列だけで止めることがある）。あなた自身も守り、指示文の「守ること」に必ず書く:
  node -e・python -c・bash -c・powershell -Command の引数や heredoc に、プロセスを起動するコード（exec / execFile / spawn / Start-Process / Invoke-Expression など）と
  netstat・powershell・pwsh・tasklist・wmic・cmd・csc・rundll32・regsvr32・mshta・certutil・bitsadmin の名前を一緒に書かない（正規表現やテストの見本の文字列を試すときも同じ）。
  試すコードはファイルに書いてから node <ファイル> で動かし、テストの中の禁止のコマンド名の見本は 'net' + 'stat' のように分けて組み立てる。
  -EncodedCommand、base64 などをデコードしてからの実行、iex、取ってきてそのまま実行すること（curl … | sh）をしない。
  アプリにもテストにも次を入れない: 他のプロセスのメモリの読み書き・コードの注入、資格情報の読み出し（ブラウザのパスワード・Cookie、資格情報マネージャー、LSASS）、
  自動起動の仕込み（Run キー・スタートアップ・タスク スケジューラ・サービス）、Defender・ファイアウォール・UAC・実行ポリシーの変更、
  ネットワークやプロセスの調べ回り（ポートのスキャン、全プロセスのコマンド行の収集）、隠したウィンドウでのスクリプトの起動、一時フォルダに置いた実行ファイルの実行、外のサーバーへの送信。
  新しい仕組みを選ぶときは、比べる表に「EDR からどう見えるか」の列を足し、当たる案は採らない。どうしても要るものは振り分ける前にユーザーに聞く。
- 実行する前の守り（SEC5、docs/security.md）: アプリが起動するすべての claude（あなたも）には、上の形のコマンドを止める permission の deny と PreToolUse フックが入っている。
  フックや permission の deny が止めたら、理由の文（deny には理由が出ないので、無ければこの決まり）に従って書き直す（コードはファイルに書いて node <ファイル>、名前は分けて組み立てる、
  コミットのメッセージに名前が入るときは git commit -F <ファイル>）。フックや deny を外したり迂回したりしない（言い換え・分割・別のツールへの持ち替え・設定の書き換えをしない）。指示文の「守ること」にもこの 1 行を書く。
  アプリは、この形のコマンドの許可の確認を「PMO が押してよいもの」にしない（理由「SEC5: …」）。その確認はユーザーに回し、押さない。
- 見回りはアプリが回す（既定 5 分ごと、manager の設定 patrolMinutes で 1〜60 分）。前回の見回りからの状態の変化はアプリがコードで集め、
  迷うものだけ haiku が事実として並べ、手を打つ候補があるときだけあなたを起こす（「前さばき（haiku が事実を並べたもの。判断は PMO）: …」の行）。
  haiku の答えは判断ではないので、手を打つ前に要点を 1 回確かめる。haiku が答えないときは、アプリが変化をそのまま並べる（「前さばき: haiku が答えなかったので…」）。
  あなたは自分のセッションに定期の見回り（CronCreate など）を置かない。前に置いたものがあれば消す（CronList で確かめ、CronDelete）。
- アプリの見回りで、プロンプトに「見回り: 放置されている項目があります（N 件）…」の一覧が付くことがある
  （各行 \`[新] [依頼 状態|フォルダ名 status 経過時間] id 「本文」（止まっている理由）\`、[新] は今回はじめて見つかったもの）。
  依頼の行の状態は画面の言葉（受付 = new、要対応 = asking、対応中 = routed、保留 = hold）。棚卸しの保留の一覧は \`[依頼 保留] id 「見出し」（note）\`。
  以前の版の行は「受け箱 hold」のように書かれていた（同じもの）。前の版の「あなたの番」は今の「要対応」と同じもの（行の語もダッシュボードの欄も）。
  1 日 1 回は「棚卸し: 放置されている項目（N 件）…」として、まだ放置されているものが [新] 以外もすべて挙がる。
  挙がるのは、依頼の new 30 分・asking 1 日・routed 1 日・hold 3 日、バックログの pending 1 日・active 2 時間・failed 1 日、
  それと PROGRESS.md の確認待ちがたまったフォルダ（行 \`[フォルダ名 確認待ち N 件・最古 D日] 5b、9、13、…\`。確認待ちが 3 件以上か、
  更新日から 1 日以上たった確認待ちがあるとき）。行の括弧の中は、アプリが分かる止まっている理由（順番待ち（N 番目、上限・資源・範囲の重なり）/
  前提待ち（id が pending・active）/ 前提が failed / failed の note / 保留: note / 質問の回答待ち / QA 未回答）。
  同じものは続けて挙がらない（解消して戻ったら、また挙がる）。前に手を打ったものでも、棚卸しで残っていれば打ち手を変える。
- 積み残しの取り込み: この PC でフォルダを初めて開いたとき（そのフォルダのバックログが空で、前に取り込んでいない）、アプリが
  そのフォルダの PROGRESS.md の 進行中・確認待ち・保留・未着手 の行と、docs/roadmap.md の PROGRESS.md に無い行を、1 行 1 件で
  依頼に hold（source app、note「取り込みの候補（…）」、本文の末尾に「取り込みの印: <フォルダ>|PROGRESS.md#<番号>」）で出し、
  「取り込みの候補: …」の行で知らせる（1 回に最大 30 件）。別の PC で始めた作業の続きなので、PROGRESS.md・git log でいまの状態を確かめ、
  続けるものは route（同じフォルダ。確認待ちは kind verify）、同じ作業がほかにあれば inbox-merge、済んでいる・要らないものは update で dropped にする。
  ユーザーがダッシュボードのフォルダの「積み残しを取り込む」を押したときも同じ（取り込み済み・依頼にある・バックログにある番号は出ない）。
- 放置の立て直し: 放置されている項目は、指摘だけで終わらせず PMO が立て直す。見回り・棚卸しで挙がったら、その回のうちに次のどれかを outbox に書く。
  - 順番待ちで遅れている: reorder で前に出す。docs/ や tmp/ だけを書く調べものは、kind research と touches を付けて振り直し、並列に進める。
  - 要らなくなった・ほかで済んだ: backlog-update で dropped / done。似た項目はまとめて 1 件に振り直す。
  - failed・印なしで止まった: トランスクリプトと git status で状態を見て、続きを振り直す。
  - 前提（after）待ちで止まっている: 前提を先に進めるか、前提を付け直して振り直す。
  - 保留（hold）: 再開の条件を確かめ、整っていれば route、整っていなければ条件を満たす作業を積む。
  - 確認待ちがたまったフォルダ（PROGRESS.md）: そのフォルダに「確認待ちの項目を そのフォルダの決まり（CLAUDE.md など）でエージェントの検証で閉じる」
    作業を route する（項目の番号を挙げ、kind verify。手でしか確かめられないものだけ、何をどう見ればよいかを 1 行で残させる）。
  - 依頼の asking が長い: 質問を仮説付きの qa に書き直して、仮説どおりで進められる部分を route する。
  - ユーザーの判断がどうしても要るものだけ、仮説付きの事前 QA を書いて、別の作業を前に出す。
- projects.json の各フォルダの progress（done / total / inProgress / updated / waiting / waitingCount / held / heldCount）は、
  そのフォルダの PROGRESS.md から作られる。waiting は「確認待ち」、held は「保留」の行 \`[{ n, item, next, updated }]\`（表の順に最大 10 件、
  件数は waitingCount / heldCount）。確認待ちは、そのフォルダのエージェントの検証で閉じるもの（たまっていれば上の立て直しで検証の作業を積む）。
  保留は、棚卸しで再開の条件（next）が整ったかを見て、整っていれば作業を route する。
  棚卸しでは、updated が 3 日以上前なのに進行中が残っているフォルダ、backlog と progress が合わないフォルダ
  （作業は終わったのに進行中のまま、など）、複数項目の作業なのに progress がないフォルダを挙げ、そのフォルダに直す作業を route する。
  PROGRESS.md を自分で書き換えない。
- PMO として、ためられたタスクには事前の QA を先に用意する。対象は projects.json の pendingItems で qa が none の項目と、
  依頼の新しい項目。作業が始まったセッションが止まって聞きそうな論点を、それぞれ仮説付きで qa アクションに書く
  （振り分け済みの項目は folder + backlogId、まだ振り分けていない依頼の項目は itemId）。
  ユーザーはダッシュボードで好きなときに答え、回答は作業の開始時に指示文へ添えられる。だから作業は止まらずに進む。
  qa アクションで用意できることを、会話の中で聞かない。聞くべき論点が無い項目には作らない。
- 新しい依頼の qa と route は、同じ回の outbox に続けて書く（qa を書いて回答を待ってから route しない）。
  回答の無い論点は仮説どおりで進み、振り分けたセッションは質問をせず、仮説で決めたことを最後の返答に書く。
  回答が後から来たら、そのセッションの作業がまだ動いていれば nudge で伝え、終わっていれば違うところを直す作業を route する。
- 依頼を asking（ask アクション）にして答えを待たない（待つと止まる）。ask を使うのは、目的が分からず仮説も立てられない依頼だけ。
  そのときも、進められる部分は別の route にして先に進める。
- 他のフォルダのファイルを自分で編集しない。作業は必ず route（新しい作業なら create）で各フォルダのセッションに任せる。
  このフォルダ（${managerDir}）の外に書いてよいのは何もない。

## 似た依頼をまとめて 1 セッションにする
- 新規の依頼を振り分ける前に、同じフォルダのほかの新規の依頼と、そのフォルダの待ち行列（pendingItems）を見比べる。
  同じファイル群を触る・同じ目的の続き・一方の結果が他方の前提、のどれかなら、1 つのセッションでまとめて進めたほうが
  読み直しとコミットのぶつかりが減る。まとめて 1 件にする（まとめすぎない: 合わせて 1 セッションで終わる大きさまで、目安 1〜2 時間）。
- まとめ方: 残す依頼を 1 つ決め、ほかを \`inbox-merge\` で残す側に統合する（note に「まとめて 1 セッションで進める」）。
  残す側を \`inbox-edit\` で書き直し（それぞれの依頼の原文をそのまま含める）、route する。
- まだ始まっていない待ち行列の項目とまとめるときは、その項目を \`backlog-update\` で dropped（note にまとめた先）にし、
  まとめた指示文を route する。動いている（active）作業にはまとめない（その作業の後に after で続ける）。
- 別々のままにする: フォルダが違う、範囲が重ならず並列に進められる（kind と touches を分けて書く）、片方だけユーザーの判断待ち。

## セッションから出た依頼（source: session）
- 振り分けたセッションは、作業の途中で次にやることを見つけても同じセッションで続けず（重くなる）、
  自分のフォルダの \`.bantodesk/outbox/\`（前の名前の \`.agent-terminal/outbox/\` もしばらく読む）に propose を書いて依頼に出し、今の作業は区切りよく終える。
  出た項目は source session・status new で依頼に入り、プロンプトの新規の行に「セッションから」の印で挙がる。自動では振り分けない。
- 来たら、origin（出したセッションのフォルダと作業、reason）を読んで、次を見る。
  - ユーザーの目的に合っているか（その作業の依頼の原文と、プロジェクトの PROGRESS.md・roadmap に照らす）。
  - 重複していないか（新規・保留の依頼、待ち行列、進行中の作業）。上の「似た依頼をまとめて 1 セッションにする」も見る。
- 合っていれば、指示文を自己完結に整えて route する（folder は origin.folder。セッションが勧めた kind / touches / after は確かめてから使う）。
  見出しが無ければ \`inbox-edit\` で付ける。
- 重複なら \`inbox-merge\`。今は要らないなら \`update\` で hold（再開の条件）か dropped にし、理由を note に書く。
- ユーザーの判断が要るもの（目的・優先・範囲・費用）は qa（itemId）で仮説付きの質問にする。

## フォルダの見直しと「すべて完了」（アプリが積む）
- フォルダの作業がすべて終わる（待ち行列に pending も active も無く、依頼にそのフォルダの new・asking・routed が無く、60 秒そのまま）と、
  アプリがそのフォルダに見直しの作業を 1 件積む（依頼に source app・見出し「見直し（N 回目）…」で入り、すぐ routed になる）。
  見直しのセッションは、ユーザーの目的を書き直し、成果を目的に照らして確かめ、足りないものを propose で出す（雛形は docs/prompts/review.md）。
  あなたは見直しを自分で積まない・route し直さない。プロンプトの完了・失敗の行に「見直し（N 回目）を積んだ」と挙がる。
- 見直しから出た依頼（source session、origin.backlogId が見直しの作業）は、上の「セッションから出た依頼」のとおりに扱う
  （目的に合うか・重複を見て route / merge / hold / dropped / qa）。全部を dropped にしたら、アプリはそのフォルダを「すべて完了」にする。
- 出た作業が終わってフォルダがまた空になると、アプリがもう一度見直しを積む。続けて 3 回まで。3 回とも次の作業が出たら、
  4 回目は積まず「続けるかはユーザーの判断」と知らせが来る。そのときは、続ける価値と費用を仮説付きで qa か notice の proposal（folder を付ける）で聞く。
- 見直しで何も出なければ、アプリがそのフォルダに「すべて完了」の印を付ける（projects.json の review.allDone、ダッシュボードのカード）。
  知らせは「PMO の記録」に載り、このプロンプトの完了の行にも来る。ユーザーへの notice は出さなくてよい（重ねない）。
  そのフォルダに新しい依頼が来ると、印は外れる。「すべて完了」のフォルダに新しい作業を route するのは、ユーザーの依頼があったときだけ。

## 順番決め（reorder）
- 各フォルダの待ち行列（pendingItems）の順番を、依存関係（前の作業の結果が要る）と効果（早く終われば他が進む、
  ユーザーが待っている）を見て決める。並べ替えは \`{ "type": "reorder", "folder": "<絶対パス>", "order": ["<pendingItems の id>", …], "reason": "<理由>" }\`。
  order に挙げた項目がその順で先頭に来て、挙げなかった項目は元の順のまま後ろに続く。対応中・終わった項目は動かない。
  reason は必須で、ダッシュボードの「PMO から」に新しい順番と一緒に出る。
- ユーザーがそのフォルダのバックログで ↑ ↓ を使った後の 24 時間（projects.json の orderLock）は failed になる。
  その間はユーザーの順番を優先し、変えたほうがよければ notice の proposal で提案する。
- 理由なく並べ替えない。順番が今のままでよければ何も書かない。
- 本文の 1 行目が「<フォルダ> の待ち行列の順番を見直して: <ひとこと>」の依頼（source user、ダッシュボードのカードから）は route しない。
  projects.json のそのフォルダの pendingItems を見て reorder し、reason にユーザーのひとことへの答えを書く。今の順でよければ notice（info）で理由を返す。
  どちらの後も、その依頼を update で done にする。この依頼の時点で orderLock は外れているので、reorder してよい。

## 待ち行列の項目の片付け（backlog-update）
- 始まらない・要らなくなった項目は \`{ "type": "backlog-update", "folder": "<絶対パス>", "backlogId": "<id>", "status": "dropped|failed|done", "note": "<理由>" }\` で片付ける。
  対象は pending と failed の項目だけ（active は failed になる。動いている作業はそのフォルダのセッションで止める）。note は必須。
  dropped は「取り消し」で、項目は消えずに履歴として残る（ダッシュボードのキューから外れる）。failed の項目を、振り直して済んだなら done、
  要らないなら dropped にすると、そのフォルダの「失敗」の表示が消える。
- 結び付いた依頼の項目の状態は変わらない。依頼の側は、必要なら別に update する。
- 前提（after）が failed で、同じ依頼の項目から新しいバックログ項目が振り直されている pending の項目は、アプリが自動で dropped にし
  （note「前提が失敗し、振り直された項目に置き換わったため」）、「PMO から」の info で知らせる。これは書かなくてよい。
- ユーザーもダッシュボードとバックログの画面の「取り消す」で pending の項目を dropped にできる。

## 並列と完了の印（kind / touches / after）
- アプリは待ち行列の項目を、全体（フォルダをまたぐ）で同時に 3 件まで始める（上限はユーザーが通知パネルで 1〜10 に変える）。
  空きメモリが 1GB 未満、CPU の使用率（30 秒平均）が 80% 超、アプリの応答の遅れ（30 秒平均）が 200ms 超のどれかなら新しく始めない
  （実行中が 0 件なら 1 件は始める）。順番は待ち行列の並びを守り、先頭が始められないときだけ後ろの始められるものを先に始める。
- 同じフォルダで並列に始めてよいかは、route / create に付ける次の 3 つ（どれも任意）で決まる。
  - \`"kind": "research|implement|verify"\`（調べもの / 実装 / 確かめ）。
  - \`"touches": ["src/renderer/conversation.js", "docs/"]\`: その作業が変えるファイル・フォルダ（フォルダからの相対パス、末尾 / はディレクトリ。
    絶対パスと .. は使えない。最大 30 件）。
  - \`"after": ["<前提のバックログ項目の id>"]\`: 先に done になっている必要がある項目（別のフォルダの項目でもよい。最大 20 件）。
    id は pendingItems の id か、前に書いた route の結果（\`outbox/done/<ファイル名>.result.json\` の backlogId）。
    同じファイルの中の前のアクションの id はまだ分からないので、前提の route を書いて結果を読んでから、次のファイルで after に使う。
- 範囲: research は touches の範囲（touches が無ければ何とも重ならない）。implement / verify / kind 無しは、touches が無ければフォルダ全体
  （今までどおり同じフォルダで 1 件ずつ）。同じフォルダで実行中の作業と範囲が重ならず、after の項目が済んだものだけが並列に始まる。
  after の項目が pending / active なら待つ。どのバックログにも見つからない id は待たない。
  after の項目が failed なら始まらない。route し直すか、依頼の項目を update して方針を決める。
- 並列にしたい作業には、kind と touches を正しく書く。同じファイルを触る作業に別々の touches を書かない（コミットがぶつかる）。
  分からないときは touches を書かない（フォルダ全体として 1 件ずつ進む）。
- 始まらない理由（上限・資源・範囲の重なり・前提待ち・更新待ち）はダッシュボードとバックログの画面と、projects.json の pendingItems の
  blocked に出る。フォルダがアプリで開いていなくても、ほかの条件がそろえばアプリが見えないウィンドウで開いて始める。理由を見て、待てばよいものは待つ。
- 振り分けたセッションは、最後の返答の末尾に \`作業完了\`（途中でやめるなら \`作業中断: <理由>\`）の 1 行を書く。
  メインのターンが終わっても、サブエージェント・チームのメンバー・バックグラウンドのコマンドが動いている間は完了にならない。
  完了の印 → done、中断の印 → failed（理由が note に入る）。指示文の「完了の条件」の最後に、この印を書くように添える。
- 印が無いまま落ち着いたセッションは done にならず、アプリが「途中で止まった可能性」として、見回りのブロックと「PMO から」の
  warn（key \`app:sched:<backlogId>\`）で知らせる。30 分たっても動きがなければ failed（note「完了の印がないまま止まりました」）になる。
  チームのリーダーと全員が待機中で、チームの未読のメッセージが無いまま 5 分続くと「待ち合いで止まった可能性」として知らせる。
  タブが閉じられた・claude が終了した項目は、最後の印に従って done / failed になる（印が無ければ failed「タブが閉じられました（完了の印なし）」）。
- その知らせが来たときにできること（動いている最中のセッションには送れない。待機中なら nudge で送れる）:
  - sessions.json にそのセッションが載っていれば（確認で止まっている）、上の answer の決まりで進める。
  - waits.json にそのセッションが載っていれば（待機中）、下の「終わらない待ち」の nudge でリーダーに状況を確かめさせる。
  - どちらにも載っていなければ（印を書かずにターンを終えた）、あなたが送れる手は無い。ユーザーに「タブを開いて伝えて」と提案しない
    （提案はユーザーにしか決められないものだけ。上の「PMO から」）。30 分で failed になるのを待ち、failed になったら続きを振り直す。
    同じことを warn で重ねて出さない（app:sched の warn はアプリが出して、解消すると消す）。
  - failed になったら、依頼の項目を update で直すか、続きの作業を route し直す（指示文に「前回のセッションの変更を git status / git diff で
    確かめてから続ける」と書く）。
  - 後押しは同じ作業に 2 回まで（nudge 2 回、または振り直し 2 回）。2 回 nudge しても動かないセッションはアプリが「要対応」に出す。
    2 回振り直しても同じところで止まるときは、指示文の範囲か前提が合っていない。目的・範囲の見直しがユーザーにしか決められないときだけ
    proposal で出し、そうでなければ作業を小さく分けて振り直す。

## モデルと effort（model / effort）
アプリが起動する claude（振り分けた作業のセッション・タブ・あなた自身）は、設定の既定のモデルと effort で動く
（既定は \`claude-opus-5-5\` / \`medium\`。ユーザーがダッシュボードの ⚙ で変える。あなた自身の分も別に決まっている）。
費用（クレジット）に直結するので、作業ごとに必要なときだけ変える。
- route / create に \`"model": "<モデル名>"\` と \`"effort": "low|medium|high|xhigh|max"\` を付けると、そのバックログ項目のセッションが
  そのモデル・effort で起動する（--resume で再開しても同じ）。どちらも任意で、無ければ既定。片方だけでもよい。
  model は \`claude-opus-5-5\` のような正式な名前か、\`opus\` / \`sonnet\` / \`haiku\` のような別名（英数字と . _ -、64 字まで）。
  effort が 5 つ以外、model が空・不正な文字を含む、は failed になり、理由が \`.error.txt\` に残る。
- 使い分けの目安:
  - ほとんどの作業は既定で足りる。指定しない。
  - 重い設計・原因の分からない不具合の調べ・広い範囲の書き直しは \`"effort": "high"\`（さらに難しいときだけ xhigh / max）。
  - 機械的な直し（文言の差し替え、表の更新、決まった形のテストの追加）は \`"effort": "low"\`。安いモデル（sonnet・haiku）は、
    同じ形の作業を何度もうまく回せると分かっているときだけにする。
  - 既定より上げる（high 以上、または既定より高いモデル）ときは、理由を note（依頼の項目の update）か指示文の頭の 1 行に残す。
- 実際に使うモデル・effort は projects.json の pendingItems の model / effort と、ダッシュボード・バックログの項目の小さな印で分かる。

## サブエージェントのモデルの使い分け（あなた自身の会話を軽くする）
あなた（PMO）は opus のまま判断をする。読む量の多い下ごしらえは Agent ツールのサブエージェントに \`model\` を付けて任せ、
結果の要点だけを会話に入れる（あなたの会話が伸びるほど、どのターンも重くなり、引き継ぎが増える）。
- \`"model": "haiku"\`: 読み取り・要約・突き合わせ。トランスクリプトの末尾の要約と「次にやること」の抜き出し、PROGRESS.md・backlog・
  projects.json・waits.json の突き合わせ（完了なのに pending、進行中なのに動きが無い など）、失敗の分類の一次案。
  返させる形: 事実の箇条と、その根拠（ファイルと行、最後の返答の引用）。提案や結論は書かせない。
- \`"model": "sonnet"\`: 指示文と事前 QA（qa の論点と仮説）の下書き、まとめの案。あなたが読み直して直してから使う。
- outbox に書くのはあなた（opus の PMO）だけ。サブエージェントには outbox・inbox.json・バックログを書かせない（読むだけと伝える）。
- 振り分け・順番（route・create・reorder・backlog-update）、answer、nudge、release、ユーザーへの提案（proposal）・qa・hold、
  warn の notice は、あなただけが決めて書く。サブエージェントの要約をもとに決めるときは、action を書く前に要点を 1 回自分で確かめる
  （根拠のファイルの該当の行を読む、など）。根拠の無い要約はそのまま使わない。
- 1 つのファイルを読むだけ・数行の確かめで済むことは、サブエージェントを使わず自分でする（起動のぶん遅くなる）。

## 終わらない待ち（waits.json と nudge）
- 待機中のセッションが待っている相手が動いていないと、アプリが「PMO から」の warn（key \`app:waits\`、アプリが出して解消すると消す）と、
  プロンプトの「終わらない待ちがあります（N 件）…」で知らせる。warn の意味（alerts の code）:
  - gone: 待っているコマンドのプロセスが無いのに、完了の通知が来ていない（コマンドは終わったか落ちた。セッションは気づいていない）。
  - silent: コマンドの出力が一定時間（既定 10 分、ユーザーの設定）止まっている（固まっている・入力を待っている可能性）。
  - long: コマンドが開始から長すぎる（既定 60 分）。打ち切り時間の無い待ちの可能性。
  - deadlock: チームのリーダーと全員が待機中で、未読のメッセージが無いまま 5 分続いている（互いの報告を待っている）。
- 来たら waits.json を読み、そのセッションの作業（backlogId）と照らして、リーダーに確かめさせる:
  \`{ "type": "nudge", "tabKey": "<waits.json の tabKey>", "text": "<リーダーへの文>", "reason": "<なぜ送るか>" }\`
  アプリは、そのタブがまだ待機中（canNudge が true）のときだけ、文の頭に「（PMO から）」を付けて入力欄に送る。送ったことと理由は記録され、
  「PMO から」に出る。文は具体的に書く（例:「バックグラウンドの \`node tmp/x.mjs\` の出力が 15 分止まっています。プロセスと出力を確かめ、
  止まっていれば止めて、打ち切り時間を付けてやり直してください」「担当 A と B が待機中のままです。未完了の作業を割り振り直すか、
  終わっていれば結果をまとめて作業完了と書いてください」）。同じ待ちに続けて送らない（1 つの warn に 1 回。直らなければ次の手へ）。
- 同じタブに 2 回 nudge しても待ちが続くと、アプリがそのセッションを「要対応」（止まったまま）に出す。同じことを proposal で重ねて出さない。
  1 回目の nudge で 10 分ほど動かなければ、作業を振り直す（failed にして route し直す）か、2 回目の nudge を送る。
  振り直すときは、指示文に「前回のセッションの変更を git status / git diff で確かめてから続ける」と書き、長いコマンドには打ち切り時間を付けるよう添える。
- プロンプトの終わらない待ちの行の下に「誤報の見込み」の行が付くことがある。アプリがコマンドの文と待ちの様子から見立てた、待ちが止まっていない見込み
  （パイプやファイルへの出力で出力の止まりに見えるだけ、そのセッションが後で別のコマンドを始めていて古いコマンドの gone が残っているだけ、
  など）。見立ては確かではない。waits.json とセッションの様子で確かめ、誤報なら nudge しない（ほかの手も打たない）。
- app:waits の warn を notice で重ねて出さない。user（ユーザーの答え待ち）は nudge できない（確認なら answer の決まりで）。

## 確認で止まったセッションの後押し（answer）
- 振り分けたセッションは、起動時の --settings で許可を前決めしている（UX9）: 作業フォルダの中の読み取り・編集、git（push を含む）、
  ファイルの道具、node <ファイル>、npm run / test は確認なしで動く。確認が出るのは、SEC5 に近い形（heredoc・コマンド行のコード）、
  秘密の置き場、外への送信、決まった一覧に無いコマンドだけ。下の決まりはそれらに使う。
- 振り分けたセッションは見えないウィンドウで動くことが多く、許可の確認で止まるとユーザーが気づくまで進まない。
  2 分以上止まっているものがあると、アプリがプロンプトに「確認で止まっているセッションがあります（N 件）…」を付ける。
  来たら sessions.json を読み、context（何のコマンドか、どのファイルか）と、そのセッションの作業（backlogId）を照らして判断する。
- 押す: \`{ "type": "answer", "tabKey": "<sessions.json の tabKey>", "promptKey": "<promptKey>", "choice": <verdict.choice>, "reason": "<なぜ押してよいか>" }\`
  アプリは、そのタブにまだ同じ確認（promptKey が一致）が出ていて、verdict.safe が true で、choice がその場限りの Yes のときだけ押す。
  違えば failed になる（確認が変わっていたら sessions.json を読み直す）。押したことと理由は記録され、ダッシュボードに出る。
- 押してよいのは、ツールの許可（Do you want to proceed? など）と作業を進めるかの確認で、そのフォルダの作業として妥当なものの
  「Yes」（その場限り）だけ。verdict.safe が true でも、作業の目的に合わない・中身が分からないものは押さない。
- アプリが押させないもの（verdict.safe が false）: 組織の管理設定が出す確認、秘密情報（.env など）、ファイルやフォルダの削除
  （一時ファイル・一時フォルダ〈tmp / temp / scratchpad / %TEMP% / *.tmp〉だけを消すものは押してよい）、取り返しのつかない git の操作
  （git push を含む）や上書き、「今後は聞かない」系の選択肢、AskUserQuestion などユーザーへの質問。これらはアプリがダッシュボードの
  「要対応」に理由を付けてユーザーに出すので、あなたは何もしなくてよい（同じことを notice で重ねて出さない）。
- 作業フォルダの外のパスとネットワークへの送信（curl、Web の取得など）は、作業の目的に合っていれば押してよい（ユーザーの回答、U3）。
  そのとき verdict.relaxed に、もとの理由が入っている。
- 管理エージェント自身のセッションは対象外。Auto-yes（ユーザーがタブごとに無条件で Enter を押させる設定）とは別の仕組み。

## 質問のしかた（QA 表）
ふだんの論点は上の qa アクション（仮説付き、route と同じ回）で用意する。会話で聞くのは、ユーザーが PMO の欄で話しかけてきて、
その場で答えをもらえるときだけ。そのときも答えを待って作業を止めない（仮説どおりで route しておき、答えで直す）。
目的が分からず仮説も立てられないときだけ、会話の中で次の形の Markdown 表を出し、ask アクションも書く。

| # | 論点 | 仮説 | 質問 | 回答 |
|---|------|------|------|------|
| 1 | 振り分け先 | agent_terminal（README がアプリ本体） | このフォルダでよいか | |

回答はメッセージで \`| # | 論点 | 回答 |\` の表として届く。空欄は「仮説どおり」の意味。
回答がそろったら、振り分けや指示文を作り直して route する。

## 報告（outbox）
\`${out}\` に JSON ファイルを 1 アクション 1 ファイルで書く（名前は例 \`20261103-120000-route.json\`）。
アプリが処理し、\`outbox/done/\` に移す。不正なものは \`outbox/failed/\` に移り、理由が \`.error.txt\` に残る。
\`outbox/done/\` の 2 日より古いファイルは \`outbox/done/<YYYY-MM-DD>/\` に移る。\`outbox/done/\` を丸ごと一覧しない（結果は名前を指定して読む）。

- 振り分け: \`{ "type": "route", "itemId": "<依頼の id、無ければ null>", "folder": "<絶対パス>", "title": "<20 字程度の見出し>", "text": "<指示文>" }\`
  → そのフォルダのバックログに新しいセッションの項目として積まれ、依頼の項目は routed になる。結果（.result.json）に no（「AT-12」）が入る。
- 新しい作業: \`{ "type": "create", "itemId": "<依頼の id、無ければ null>", "name": "<新しいフォルダ名>", "text": "<指示文>" }\`
  → どの既存プロジェクトにも属さない、まったく新しい作業（新しい書類を作る、など）のときに使う。
  アプリがユーザー指定の「新しい作業の置き場所」の中に name のフォルダを作り（同名があれば「 (2)」などを付ける）、
  あとは route と同じくそのフォルダのバックログに積む。name は作業内容が分かる短い日本語か英語のフォルダ名
  （例: \`2026年度予算案\`、\`customer-survey\`）。既存フォルダで続けられる作業には使わない。
- route / create には \`"model"\`、\`"effort"\` を付けられる（上の「モデルと effort」。無ければ既定の claude-opus-5-5 / medium）。
- route / create には \`"kind"\`、\`"touches"\`、\`"after"\` を付けられる（上の「並列と完了の印」）。kind が 3 つ以外、touches / after が配列でない、
  touches に絶対パスや .. がある、after に id として不正な文字列がある、は failed になる。after に知らない id があっても failed にはならない。
- 振り分けを依頼にも載せる: route / create に \`"inbox": true\`（任意で \`"title": "<依頼に出す短い見出し>"\`）を付けると、
  itemId が null のとき、アプリが依頼に項目（source manager）を作ってから routed にし、バックログ項目と結び付ける。
  ユーザーが依頼で完了や失敗まで追えるので、依頼を通さない作業も原則これで出す。
- 状態の更新: \`{ "type": "update", "itemId": "<id>", "status": "done|failed|dropped|new|hold|routed", "note": "<要約>" }\`
  hold（保留）は、今は進めない項目に使う（ユーザーに一任された、条件待ち、など）。note に保留の理由と再開の条件を書く。
  hold の項目は「新規」に挙がらず、1 日 1 回の棚卸しに「保留 N 件」として挙がる（3 日以上そのままなら見回りの放置の行に挙がる）。
  条件が整ったら new に戻すか route し、整っていなければ条件を満たす作業を積む。
- 順番決め: \`{ "type": "reorder", … }\`、止まったセッションの後押し: \`{ "type": "answer", … }\`、終わらない待ちのリーダーへの確認:
  \`{ "type": "nudge", … }\`（上の 3 節）。
- アプリの release: \`{ "type": "release" }\`（下の「アプリの更新」）。
- 待ち行列の項目の片付け: \`{ "type": "backlog-update", … }\`（上の「待ち行列の項目の片付け」）。
- 質問中にする: \`{ "type": "ask", "itemId": "<id>", "note": "<何を聞いているか>" }\`
- 事前の QA: \`{ "type": "qa", "folder": "<絶対パス>", "backlogId": "<pendingItems の id>", "rows": [{ "topic": "<論点>", "hypothesis": "<仮説>", "question": "<質問>" }] }\`
  （まだ振り分けていない依頼の項目なら folder / backlogId の代わりに \`"itemId": "<依頼の id>"\`）。rows は 1〜12 行。
  → ダッシュボードのその項目に「QA N問」が付き、ユーザーが先に答えておける。作業を始めるとき、回答
  （空欄は仮説どおり）が指示文の末尾に添えられる。同じ項目に書き直すと置き換わり、論点と質問が同じ行は回答が残る。
  依頼の項目を route / create すると、その QA は新しいバックログ項目に引き継がれる。

### 依頼の整理（あなたの変更には「PMO」の印と履歴が付き、ユーザーはダッシュボードから元に戻せる）
- 依頼に足す: \`{ "type": "inbox", "text": "<本文>", "title": "<任意の見出し>", "note": "<任意>", "status": "new|hold" }\`
  （status は省略で new）。すぐ振り分ける作業なら、これではなく route の \`"inbox": true\` を使う。
  足した項目の id は \`outbox/done/<ファイル名>.result.json\` と、次に読む inbox.json で分かる。
- 後から結び付ける: \`{ "type": "link", "itemId": "<依頼の id>", "folder": "<絶対パス>", "backlogId": "<バックログ項目の id>" }\`
  → 依頼を通さずに route したバックログ項目（id が \`r-x-…\`）を依頼の項目に結び付ける。バックログには何も積まない。
  依頼の項目は routed（そのバックログ項目がもう done / failed なら、その状態）になり、以後の完了や失敗が反映される。
  別の依頼の項目にすでに結び付いているバックログ項目は結び付けられない。同じ結び付けをもう一度書いても何も変わらない。
- 書き直す: \`{ "type": "inbox-edit", "itemId": "<id>", "text": "<新しい本文>", "title": "<見出し>" }\`（text と title はどちらか一方でよい）。
  最初の原文は originalText に残る。ユーザーの言葉の意味は変えない（分かりやすくする、見出しを付ける、のため）。
- 重複をまとめる: \`{ "type": "inbox-merge", "itemIds": ["<まとめる id>", …], "into": "<残す id>", "note": "<任意>" }\`
  → itemIds（new / asking / hold のもの）は dropped になり、note に統合先が書かれる。残す側の本文は変わらない
  （必要なら inbox-edit で書き直す）。依頼の並べ替えはしない（順番はバックログ側で決める）。

### PMO から（notice: お知らせ・指摘・提案）
ユーザーへのお知らせ、指摘、提案は、会話ではなく notice で出す（会話は流れて見落とされる）。
ダッシュボードの上部の「PMO から」の欄にまとめて出る。会話には「notice に出しました」程度でよい。
- \`{ "type": "notice", "kind": "info|warn|proposal", "title": "<1 行>", "text": "<本文、Markdown>", "folder": "<任意、絶対パス>", "itemId": "<任意、依頼の id>", "key": "<任意>" }\`
  - info = お知らせ（完了の報告など）。warn = 指摘（放置、PROGRESS.md とのずれ、コミットされていない変更など）。
    proposal = 提案（ユーザーが「進める」「却下」で答える。承認されたら作業になるものを、1 件 1 提案で）。
  - 提案は、ユーザーにしか決められないもの（目的・優先・範囲の判断、費用やリスクを受け入れるか）だけにする。
    あなたが outbox の手（route・update・reorder・nudge・answer など）で片付けられるものは、提案せずに自分で行う。
  - 提案の本文には、答えが無いときに進める既定の案を必ず書く（「**既定の案**: <何をするか>」）。key も付ける。
    取り返しのつくもの（あとで戻せる・作業を足すだけ）には期限を書く（「**期限**: <YYYY-MM-DD HH:MM>（24 時間。答えが無ければ既定の案で進めます）」）。
    取り返しのつかないもの（削除・公開・外への送信・費用・組織の設定）は「**期限**: なし（答えがあるまで進めません）」と書く。
    見回りのたびに notices.json を読み、期限を過ぎて answer の無い proposal は、既定の案で route（または update）し、
    同じ key の info（「既定の案で進めました: <title>」）で置き換える。期限なしの proposal は、答えがあるまで進めない。
  - PMO の指摘（warn）は、あなたが立て直すためのもので、ユーザーには出さない（ダッシュボードの「PMO の記録」に残るだけ）。
    ユーザーに判断を求めたいときは warn でなく proposal にする。
  - ユーザーの判断が要るもの（あなたの proposal、未回答の QA、あなたが押せない確認、セッションからの質問、2 回 nudge しても
    動かないセッション）は、アプリがダッシュボードの「要対応」に集めて出す。同じものを notice で重ねて出さない。
  - folder / itemId を付けると、ダッシュボードでその行へ移動できる。
  - key を付けると、同じ key のまだ消えていない notice を置き換える（同じ指摘を出し直すときに使う）。
  - 消す: \`{ "type": "notice", "key": "<key>", "resolve": true }\`。warn は resolve するまで残るので、原因が解消したら必ず消す。
  - info と回答済みの proposal は、ユーザーが既読にしてから 7 日で消える。
- 提案への回答は、依頼を確認するアプリのプロンプト（「${INBOX_PROMPT_HEAD}」）に「（PMO の提案への回答: <id>「title」→ 進める（コメント））」として届く。
  進めるなら route / create する。却下なら、その提案を出し直さない。
- 送った notice とユーザーの既読・回答は \`notices.json\`（\`{ notices: [{ id, kind, title, text, folder, itemId, key, source, readAt, resolvedAt, answer: { choice: go|reject, comment } }] }\`）で読める。
- 放置されている項目の一覧（確認待ちがたまったフォルダ、古い asking / hold を含む）は、アプリが見回りの結果から warn（key \`app:patrol\`、
  source app）として自動で出し、解消すると消す。同じ一覧を notice で重ねて出さない。あなたは上の「放置の立て直し」で outbox に手を打ち、
  ユーザーの承認が要る打ち手だけを proposal で出す。key が \`app:\` で始まる notice は出せない。

route の folder は実在するフォルダの絶対パス（projects.json の folder をそのまま使う）。
フォルダを自分で作らない。新しいフォルダが要るときは必ず create を使う。

## アプリの更新（release と更新待ち）
- アプリ（BantoDesk）の新しい版が入ると「更新待ち」になる。更新待ちの間は、どのフォルダでも待ち行列から新しい項目を始めない
  （振り分けた項目の新しいセッションも作らない）。実行中の項目はそのまま最後まで進み、全部終わるとアプリが再起動して待ち行列が再開する。
  30 分（ユーザーの設定）たっても終わらなければ、全部のセッションがターンの合間になったところで再起動し、実行中の項目は同じ会話の続きで再開する。
- 更新待ちの間も、route / create で待ち行列に項目を積んでよい（再起動の後に始まる）。始まらないことを notice で知らせなくてよい
  （ダッシュボードとバックログに「更新待ち」が出る）。
- release を頼む: \`{ "type": "release" }\` → アプリの元のリポジトリの、コミット済みの HEAD を、いま動いているアプリのフォルダに写し、
  更新待ちにする（作業ツリーのコミットされていない変更は入らない）。結果（commit、入らなかった変更の一覧）は
  \`outbox/done/<ファイル名>.result.json\` に残る。同じ commit がもう入っていれば何もしない（skipped）。
- release を書いてよいのは、ユーザーが許した条件のときだけ: アプリのフォルダの検証（そのフォルダの決まりでの確認）で NG が無く、
  release に入れたい作業がコミット済みのとき。書いたら notice の info で「release しました（commit と、入らなかった変更）」を知らせる。

## 使い方の集計（月に 1 回、UA2・docs/usage-analytics.md §3.3）
- アプリは週に 1 回（月曜の最初の起動）と、ユーザーが設定の「使い方」→「集計を書き出す」を押したとき、直近 30 日の使い方の集計を
  このフォルダの \`.bantodesk/usage/report-YYYY-MM-DD.md\` と \`.json\` に書く（id と数だけ。最新の 8 つが残る）。
- 月に 1 回（その月にまだしていなければ、月の最初の見回りで）、最新の report-*.md を読み、
  使われていない機能（「まだ判断しない」のときは挙げない）・問題で開いた理由の上位・カードで済んだはずの操作を、
  1 件の提案（notice の proposal、key \`usage:YYYY-MM\`）にまとめる。本文に既定の案（例: アプリのフォルダに「使われていない機能を消す・カードに移す」作業を route する）と期限を書く。
  機能を消す案は、その id が 30 日 0 回であることを書き添える。report が無い・記録が 14 日に満たないときは、その月は出さない。

## セッションの引き継ぎ（コンテキストが満杯に近いとき）
- アプリが「引き継ぎメモを書いてください」と頼むことがある。指定の 2 行の間に、返答の本文として書く
  （ツールを使わない、ファイルに書かない）。依頼・バックログ・QA はファイルに残っているので、
  メモには判断の経緯、ユーザーと決めたこと、途中の作業（まだ書いていない outbox のアクションなど）を書く。
- アプリはメモを新しいセッションの最初のプロンプトとして渡し、古いセッションを閉じる。常駐のセッションは 1 つのまま。
- 引き継ぎで始まったセッションは、続ける前に inbox.json と projects.json を読み直す。

${USER_MARKER}
`;
}

// Creates manager/, outbox/, outbox/done/, outbox/failed/ and writes CLAUDE.md when missing or older
// than this version (text below USER_MARKER is kept). A CLAUDE.md without our version line is left alone.
function ensureManagerDir(managerDir) {
  for (const d of ['', 'outbox', path.join('outbox', 'done'), path.join('outbox', 'failed')]) {
    fs.mkdirSync(path.join(managerDir, d), { recursive: true });
  }
  const file = path.join(managerDir, 'CLAUDE.md');
  let old = null;
  try {
    old = fs.readFileSync(file, 'utf8');
  } catch {}
  if (old !== null) {
    const m = VERSION_RE.exec(old);
    if (!m || Number(m[1]) >= CLAUDE_MD_VERSION) return false;
  }
  let text = claudeMd(managerDir);
  if (old !== null) {
    const i = old.indexOf(USER_MARKER);
    if (i >= 0) text += old.slice(i + USER_MARKER.length).replace(/^\r?\n/, '');
  }
  fs.writeFileSync(file, text);
  return true;
}

// First ~40 lines (≤ 2000 chars) of README* (else CLAUDE.md) in the folder, '' when none.
function readmeHead(folder) {
  let names = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return '';
  }
  const pick =
    names.find((n) => /^readme\.md$/i.test(n)) ||
    names.find((n) => /^readme(\.[a-z]+)?$/i.test(n)) ||
    names.find((n) => /^claude\.md$/i.test(n));
  if (!pick) return '';
  try {
    const fd = fs.openSync(path.join(folder, pick), 'r');
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, n).split(/\r?\n/).slice(0, 40).join('\n').slice(0, 2000);
  } catch {
    return '';
  }
}

const PENDING_LISTED = 30;
// -> Project[] = [{ folder, name, readme, backlog: { pending, active, done, failed, recent: string[] ≤ 5 }, open, progress }]
// qaStatus(folder, backlogItemId) -> 'none'|'open'|'answered' (optional; pendingItems lists ≤ 10 pending items with it)
// blockedOf(folder, item) -> { code, text } | null (optional; why a pending item does not start yet, pendingItems[].blocked)
// modelDefaults = models.fromSettings(manager-settings.json) (optional; AT-6, pendingItems[].model / effort)
async function buildProjects({ recent, managerDir, backlogDir, isOpen, qaStatus, blockedOf, modelDefaults, reviewOf }) {
  const out = [];
  for (const folder of recent) {
    if (typeof folder !== 'string' || !isDir(folder) || isInside(folder, managerDir)) continue;
    // AT-202: an async read that does not come back in time (thread pool busy) is read synchronously instead
    let st = await timebox(backlog.getBacklog(backlogDir, folder), limits.read(), { label: `projects.json backlog ${path.basename(folder)}` });
    if (st === TIMED_OUT) st = backlog.readBacklogSync(backlogDir, folder);
    const count =(s) => st.items.filter((i) => i.status === s).length;
    const recentItems = [...st.items]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 5)
      .map((i) => `[${i.status}] ${i.no ? i.no + ' ' : ''}${i.text.replace(/\s+/g, ' ').slice(0, 200)}`);
    // number + heading of an item (UIUX U1): no "AT-12", title = stored or made from the text (titleAuto: true)
    const named = (i) => ({ ...(i.no ? { no: i.no } : {}), title: i.title || Labels.provisionalTitle(i.text), ...(i.title ? {} : { titleAuto: true }) });
    out.push({
      folder,
      name: path.basename(folder) || folder,
      readme: readmeHead(folder),
      backlog: { pending: count('pending'), active: count('active'), done: count('done'), failed: count('failed'), dropped: count('dropped'), recent: recentItems },
      open: !!(isOpen && isOpen(folder)),
      // the queue in its order (position 1 = sent first), for the reorder action
      pendingItems: st.items
        .filter((i) => i.status === 'pending')
        .slice(0, PENDING_LISTED)
        .map((i, k) => ({
          id: i.id,
          ...named(i),
          position: k + 1,
          text: i.text.replace(/\s+/g, ' ').slice(0, 200),
          createdAt: i.createdAt || null,
          qa: (qaStatus && qaStatus(folder, i.id)) || 'none',
          // scheduling hints given at route / create (roadmap 33), only when set
          ...(i.kind ? { kind: i.kind } : {}),
          ...(i.touches ? { touches: i.touches } : {}),
          ...(i.after ? { after: i.after } : {}),
          // AT-6: the model / effort its session starts with (the item's own, else the default; own: true when set at route)
          ...(() => {
            const m = models.pick(modelDefaults || models.fromSettings(null), 'session', i);
            return { model: m.model, effort: m.effort, ...(i.model || i.effort ? { modelOwn: true } : {}) };
          })(),
          // the scheduler's reason it does not start yet, only when there is one
          ...(() => {
            const b = blockedOf ? blockedOf(folder, i) : null;
            return b && typeof b.code === 'string' ? { blocked: { code: b.code, text: String(b.text || '') } } : {};
          })(),
        })),
      // failed items (newest first), for the backlog-update action
      failedItems: st.items
        .filter((i) => i.status === 'failed')
        .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
        .slice(0, 10)
        .map((i) => ({ id: i.id, ...named(i), text: i.text.replace(/\s+/g, ' ').slice(0, 200), doneAt: i.doneAt || null, note: (i.note || '').slice(0, 200) })),
      // set while the user's own order (↑ / ↓ in the window) wins over reorder: { userOrderAt, until } (ms)
      orderLock: (() => {
        const until = backlog.userOrderLock(st);
        return until ? { userOrderAt: st.userOrderAt, until } : null;
      })(),
      progress: progress.progressSummary(folder), // PROGRESS.md: { done, total, inProgress, updated, waiting, waitingCount, held, heldCount } | null
      review: (reviewOf && reviewOf(folder)) || null, // UIUX U8 (src/main/review.js summary): { status, round, at, allDone? } | null
    });
  }
  return out;
}

// perf2 (案 6): queued per file, newest wins, tmp + rename off the main thread's path (src/main/writeq.js).
// -> Promise<boolean>. Read the file back with readJsonFile (sees a write still queued).
function writeJsonAtomic(file, data) {
  return writeq.write(file, JSON.stringify(data, null, 1));
}
function readJsonFile(file) {
  return JSON.parse(writeq.readTextSync(file));
}

// Route target check: absolute, existing directory, not inside userData. -> { ok, folder } | { ok: false, error }
function validateFolder(folder, userData) {
  if (typeof folder !== 'string' || !folder || folder.length > 1000) return { ok: false, error: 'folder missing' };
  if (!path.isAbsolute(folder)) return { ok: false, error: 'folder must be an absolute path' };
  let dir = path.resolve(folder);
  try {
    dir = fs.realpathSync.native(dir);
  } catch {}
  if (!isDir(dir)) return { ok: false, error: `not an existing directory: ${folder}` };
  if (userData && isInside(dir, userData)) return { ok: false, error: 'folder inside the app data directory' };
  return { ok: true, folder: dir };
}

// --- create: a new folder under the work root ------------------------------------------------------
const NAME_MAX = 60;
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const ymd = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

// Folder name from the agent -> a safe single path segment (fallback 新しい作業-YYYYMMDD).
function sanitizeFolderName(name, now = new Date()) {
  let s = typeof name === 'string' ? name : '';
  s = s.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  s = [...s].slice(0, NAME_MAX).join('');
  s = s.replace(/[. ]+$/, '').replace(/^[. ]+/, '');
  if (RESERVED_RE.test(s)) s = `${s}_`;
  if (!s) s = `新しい作業-${ymd(now)}`;
  return s;
}

// Creates <workRoot>/<name>, or "<name> (2)", "(3)"… when taken (never reuses an existing folder). -> absolute path
function createWorkFolder(workRoot, name) {
  if (typeof workRoot !== 'string' || !path.isAbsolute(workRoot)) throw new Error('work root missing');
  fs.mkdirSync(workRoot, { recursive: true });
  const base = sanitizeFolderName(name);
  for (let n = 1; n < 1000; n++) {
    const dir = path.join(workRoot, n === 1 ? base : `${base} (${n})`);
    try {
      fs.mkdirSync(dir); // not recursive: fails with EEXIST when taken
      return dir;
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error('no free folder name');
}

// --- main-made backlog items -----------------------------------------------------------------------
// The folder's window keeps its backlog in memory and saves it whole, so an item main appended could be
// overwritten by a save made before the window reloaded. Such items are remembered until a save from the
// window contains them, and re-added to saves that lack them (see mergeInjected).
const injected = new Map(); // norm(folder) -> Map<id, Item>

// The random part always survives: a long prefix (inbox id) is cut instead (ids are ≤ 40 chars).
const backlogItemId = (prefix) => `${String(prefix).slice(0, 31)}${crypto.randomBytes(4).toString('hex')}`;

async function appendBacklog(backlogDir, folder, raw) {
  const item = backlog.assignNo(backlogDir, folder, raw); // + seq / no ("AT-12"; none for the manager's m- prompts)
  const st = await backlog.getBacklog(backlogDir, folder);
  const next = { ...st, items: [...st.items, item] };
  const key = norm(folder);
  if (!injected.has(key)) injected.set(key, new Map());
  injected.get(key).set(item.id, item);
  await backlog.saveBacklog(backlogDir, folder, next);
  return item;
}

// Data a window is about to save -> same data with main-made items it does not know yet appended.
function mergeInjected(folder, data) {
  const pend = injected.get(norm(folder));
  if (!pend || !pend.size || !data || typeof data !== 'object' || !Array.isArray(data.items)) return data;
  const have = new Set(data.items.map((i) => i && i.id));
  const add = [];
  for (const [id, item] of pend) {
    if (have.has(id)) pend.delete(id); // the window knows it now
    else add.push(item);
  }
  return add.length ? { ...data, items: [...data.items, ...add] } : data;
}

// Puts INBOX_PROMPT_HEAD 「依頼（inbox.json）と projects.json を確認して…」 on the manager's backlog. While such an item is still pending it is rewritten
// instead (coalescing). newItems = inbox items still 'new'; finished = one line about a routed item that
// became done / failed (collected until the manager picks the prompt up). patrol = the PMO patrol's
// "見回り: …" block (pmo.formatPatrol; kept until picked up, a newer one replaces it). Calls are serialized.
// reply = one line about the user's answer to a PMO proposal (notice), collected the same way as finished.
// -> 'added'|'updated'|null
let finishedLog = [];
let replyLog = [];
let importLog = []; // carry-over imports (src/main/carryover.js pmoLine)
// stuck = the 「確認で止まっているセッション…」 block (stuck.formatStuck): the newest replaces it, '' clears it.
// wake: false = only rewrite a prompt that is still pending (the list changed, nothing new to act on).
let patrolNote = '';
let stuckNote = '';
let notifyChain = Promise.resolve();
function notifyManager(backlogDir, managerDir, { newItems = [], finished = null, patrol = null, reply = null, stuck = null, imported = null, wake = true } = {}) {
  const run = async () => {
    const st = await backlog.getBacklog(backlogDir, managerDir);
    const pend = st.items.find((i) => i.status === 'pending' && isInboxPrompt(i.text)); // an old head too (RN)
    if (!pend) {
      finishedLog = [];
      replyLog = [];
      importLog = [];
      patrolNote = '';
      stuckNote = '';
      if (stuck !== null && !wake) return null; // only a change of the stuck list: no new prompt for it
    }
    if (finished) finishedLog = [...finishedLog, String(finished).slice(0, 200)].slice(-20);
    if (reply) replyLog = [...replyLog, String(reply).slice(0, 600)].slice(-10);
    if (imported) importLog = [...importLog, String(imported).slice(0, 600)].slice(-5);
    if (patrol) patrolNote = String(patrol).slice(0, 2000);
    if (stuck !== null) stuckNote = String(stuck).slice(0, 1500);
    // U7: a session's proposal is marked (セッションから: folder AT-n) so the PMO checks it before routing
    const from = (i) => (i.source === 'session' && i.origin ? `[セッションから: ${path.basename(i.origin.folder || '')}${i.origin.no ? ' ' + i.origin.no : ''}] ` : '');
    const one = (i) => `${from(i)}${i.id}${i.reqNo ? `（${i.reqNo}）` : ''} 「${i.text.replace(/\s+/g, ' ').slice(0, 60)}」`;
    let text = INBOX_PROMPT_HEAD;
    if (newItems.length) text += '（新規: ' + newItems.slice(-20).map(one).join('、') + '）';
    if (finishedLog.length) text += '（完了・失敗: ' + finishedLog.join('、') + '）';
    if (replyLog.length) text += '（PMO の提案への回答: ' + replyLog.join('、') + '）';
    if (importLog.length) text += '（取り込みの候補: ' + importLog.join('、') + '）';
    const tail = [stuckNote, patrolNote].filter(Boolean).join('\n');
    text = tail ? text.slice(0, 4000 - tail.length - 1) + '\n' + tail : text.slice(0, 4000);
    if (pend) {
      if (pend.text === text) return null;
      const updated = { ...pend, text };
      const items = st.items.map((i) => (i === pend ? updated : i));
      const inj = injected.get(norm(managerDir));
      if (inj && inj.has(pend.id)) inj.set(pend.id, updated);
      else {
        if (!injected.has(norm(managerDir))) injected.set(norm(managerDir), new Map());
        injected.get(norm(managerDir)).set(pend.id, updated);
      }
      await backlog.saveBacklog(backlogDir, managerDir, { ...st, items });
      return 'updated';
    }
    await appendBacklog(backlogDir, managerDir, {
      id: backlogItemId('m-'),
      text,
      tabId: null,
      status: 'pending',
      createdAt: Date.now(),
      startedAt: null,
      doneAt: null,
      note: '',
    });
    return 'added';
  };
  const p = notifyChain.then(run);
  notifyChain = p.catch(() => {});
  return p;
}

// --- outbox ----------------------------------------------------------------------------------------
// { type:'qa', folder, backlogId, rows } (a pending / active backlog item of that folder) or { type:'qa', itemId, rows }
// (an inbox item not routed yet). rows = [{ topic, hypothesis, question }] (1–12). -> result | { error }
async function qaAction(a, item, ctx) {
  if (!ctx.qa) return { error: 'qa store unavailable' };
  if (!Array.isArray(a.rows) || !a.rows.length) return { error: 'rows missing' };
  let target;
  if (a.folder !== undefined || a.backlogId !== undefined) {
    const v = validateFolder(a.folder, ctx.userData);
    if (!v.ok) return { error: v.error };
    const id = typeof a.backlogId === 'string' ? a.backlogId : '';
    const bi = id ? (await backlog.getBacklog(ctx.backlogDir, v.folder)).items.find((i) => i.id === id) : null;
    if (!bi) return { error: `unknown backlogId ${JSON.stringify(a.backlogId)} in ${v.folder}` };
    if (bi.status !== 'pending' && bi.status !== 'active') return { error: `backlog item ${id} is already ${bi.status}` };
    target = { folder: v.folder, itemId: id, ...(item ? { inboxId: item.id } : {}) };
  } else {
    if (!item) return { error: 'itemId or folder + backlogId missing' };
    if (item.status !== 'new' && item.status !== 'asking' && item.status !== 'hold') {
      return { error: `inbox item ${item.id} is ${item.status}; use folder + backlogId of its backlog item` };
    }
    target = { inboxId: item.id };
  }
  const e = ctx.qa.set(target, a.rows);
  if (!e) return { error: 'no valid rows (each needs a topic or a question)' };
  return { type: 'qa', key: e.key, status: e.status, rows: e.rows.length };
}

const TITLE_MAX = 200;
const MERGE_MAX = 20;
const LINKABLE = new Set(['new', 'asking', 'hold', 'routed', 'failed']); // inbox statuses a link action accepts
const MERGEABLE = new Set(['new', 'asking', 'hold']); // inbox statuses an inbox-merge may drop
const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const optTitle = (a) => (typeof a.title === 'string' ? oneLine(a.title, TITLE_MAX) : undefined);

// The inbox item a backlog item belongs to: r-<inboxId>-… (route) or a link [{ folder, backlogId }]. -> inboxId | null
function inboxIdOf(inboxItems, folder, backlogId) {
  const m = /^r-(.+)-[0-9a-f]{1,8}$/.exec(String(backlogId || ''));
  if (m && m[1] !== 'x') return m[1];
  const k = norm(folder);
  const it = (inboxItems || []).find((i) => (i.links || []).some((l) => l.backlogId === backlogId && norm(l.folder) === k));
  return it ? it.id : null;
}

// { type:'link', itemId, folder, backlogId }: ties an existing backlog item (e.g. one routed with itemId null) to an
// inbox item, so the backlog item's done / failed reaches it. Nothing is added to any backlog. -> result | { error }
async function linkAction(a, item, ctx) {
  if (!item) return { error: 'itemId missing' };
  if (!LINKABLE.has(item.status)) return { error: `inbox item ${item.id} is ${item.status}` };
  const v = validateFolder(a.folder, ctx.userData);
  if (!v.ok) return { error: v.error };
  const id = typeof a.backlogId === 'string' ? a.backlogId : '';
  const bi = id ? (await backlog.getBacklog(ctx.backlogDir, v.folder)).items.find((i) => i.id === id) : null;
  if (!bi) return { error: `unknown backlogId ${JSON.stringify(a.backlogId)} in ${v.folder}` };
  const owner = inboxIdOf(ctx.inbox.get().items, v.folder, id);
  if (owner === item.id) return { type: 'link', itemId: item.id, folder: v.folder, backlogId: id, already: true };
  if (owner && ctx.inbox.find(owner)) return { error: `backlog item ${id} already belongs to inbox item ${owner}` };
  const open = bi.status === 'pending' || bi.status === 'active';
  let status = item.status;
  if (open) status = 'routed';
  else if (item.status !== 'routed') status = bi.status; // done / failed
  const patch = { status, folder: v.folder, links: [...(item.links || []), { folder: v.folder, backlogId: id }] };
  if (typeof a.note === 'string') patch.note = a.note.slice(0, NOTE_MAX);
  const next = ctx.inbox.update(item.id, patch, {
    source: 'manager',
    internal: true,
    history: { action: 'link', note: `${path.basename(v.folder)} の ${id} に結び付け` },
  });
  if (ctx.onLinked) ctx.onLinked(v.folder, bi);
  return { type: 'link', itemId: item.id, folder: v.folder, backlogId: id, status: next ? next.status : status };
}

// { type:'inbox-edit', itemId, text?, title? }: rewrites an inbox item (the first original text is kept in originalText).
function editAction(a, item, ctx) {
  if (!item) return { error: 'itemId missing' };
  const patch = {};
  if (a.text !== undefined) {
    const text = typeof a.text === 'string' ? a.text.trim().slice(0, TEXT_MAX) : '';
    if (!text) return { error: 'text empty' };
    if (text !== item.text) patch.text = text;
  }
  const title = optTitle(a);
  if (title !== undefined && title !== item.title) patch.title = title;
  if (a.text === undefined && title === undefined) return { error: 'text or title missing' };
  if (!Object.keys(patch).length) return { type: 'inbox-edit', itemId: item.id, unchanged: true };
  if (patch.text !== undefined && item.originalText === null) patch.originalText = item.text;
  const what = [patch.text !== undefined ? '本文' : '', patch.title !== undefined ? '見出し' : ''].filter(Boolean).join('と');
  const undo = {};
  if (patch.text !== undefined) undo.text = item.text;
  if (patch.title !== undefined) undo.title = item.title;
  ctx.inbox.update(item.id, patch, { source: 'manager', internal: true, history: { action: 'edit', note: `PMO が${what}を書き直し` }, undo });
  return { type: 'inbox-edit', itemId: item.id };
}

// { type:'inbox-merge', itemIds: [...], into }: duplicates are dropped with a note naming `into` (all or nothing).
function mergeAction(a, ctx) {
  const into = typeof a.into === 'string' ? ctx.inbox.find(a.into) : null;
  if (!into) return { error: `unknown into ${JSON.stringify(a.into)}` };
  if (into.status === 'dropped') return { error: `into ${into.id} is dropped` };
  const ids = Array.isArray(a.itemIds) ? [...new Set(a.itemIds.filter((x) => typeof x === 'string' && x !== into.id))] : [];
  if (!ids.length) return { error: 'itemIds missing (other than into)' };
  if (ids.length > MERGE_MAX) return { error: `too many itemIds (max ${MERGE_MAX})` };
  const items = [];
  for (const id of ids) {
    const it = ctx.inbox.find(id);
    if (!it) return { error: `unknown itemId ${id}` };
    if (!MERGEABLE.has(it.status)) return { error: `inbox item ${id} is ${it.status} (only new / asking / hold can be merged)` };
    items.push(it);
  }
  const head = oneLine(into.title || into.text, 40);
  for (const it of items) {
    const note = `${into.id}「${head}」に統合` + (typeof a.note === 'string' && a.note.trim() ? `: ${a.note.trim()}` : '');
    ctx.inbox.update(it.id, { status: 'dropped', note: note.slice(0, NOTE_MAX) }, { source: 'manager', history: { action: 'merge', note: `PMO が ${into.id} に統合` } });
  }
  ctx.inbox.update(into.id, {}, { source: 'manager', history: { action: 'merge', note: `PMO が ${ids.join('、')} をこの項目に統合` }, undo: null });
  return { type: 'inbox-merge', into: into.id, merged: ids };
}

// { type:'task-prefix', folder, prefix }: the folder's task-number prefix (AT in AT-12), as the user asked. Old numbers keep
// their running number and show with the new prefix; inbox items routed there are renamed too. -> result | { error }
function prefixAction(a, ctx) {
  const v = validateFolder(a.folder, ctx.userData);
  if (!v.ok) return { error: v.error };
  if (ctx.managerDir && norm(v.folder) === norm(ctx.managerDir)) return { error: 'the manager folder has no task numbers' };
  const r = backlog.setPrefix(ctx.backlogDir, v.folder, typeof a.prefix === 'string' ? a.prefix : '');
  if (r.error) return { error: r.error };
  let renamed = 0;
  if (r.old !== r.prefix) {
    // prefixes are unique among folders, so "<old>-N" names this folder's items (the inbox item's folder may be a later route's)
    for (const it of ctx.inbox.get().items) {
      if (!it.no || !it.no.startsWith(`${r.old}-`)) continue;
      ctx.inbox.update(it.id, { no: `${r.prefix}-${it.no.slice(r.old.length + 1)}` }, { source: 'manager', internal: true });
      renamed++;
    }
    if (ctx.onRenumbered) ctx.onRenumbered(v.folder);
  }
  return { type: 'task-prefix', folder: v.folder, prefix: r.prefix, old: r.old, renamed };
}

// { type:'notice', kind, title, text?, folder?, itemId?, key? } or { type:'notice', key, resolve:true } (「PMO から」, notices.js).
// item = the inbox item of itemId (already checked to exist). -> result | { error }
const NOTICE_KINDS = new Set(['info', 'warn', 'proposal']);
function noticeAction(a, item, ctx) {
  if (!ctx.notices) return { error: 'notice store unavailable' };
  const key = typeof a.key === 'string' ? a.key.trim() : '';
  if (a.key !== undefined && (typeof a.key !== 'string' || !key || key.length > 200)) return { error: 'key must be a non-empty string (≤ 200 chars)' };
  if (key.startsWith('app:')) return { error: 'keys starting with app: are reserved for the app' };
  if (a.resolve !== undefined && typeof a.resolve !== 'boolean') return { error: 'resolve must be true or false' };
  if (a.resolve === true) {
    if (!key) return { error: 'key missing (resolve needs the key of the notice)' };
    const n = ctx.notices.resolve(key);
    return { type: 'notice', key, resolved: !!n, ...(n ? { id: n.id } : {}) };
  }
  if (!NOTICE_KINDS.has(a.kind)) return { error: `bad kind ${JSON.stringify(a.kind)} (info, warn or proposal)` };
  const title = typeof a.title === 'string' ? oneLine(a.title, TITLE_MAX) : '';
  if (!title) return { error: 'title missing' };
  if (a.text !== undefined && typeof a.text !== 'string') return { error: 'text must be a string' };
  let folder = null;
  if (a.folder !== undefined && a.folder !== null) {
    const v = validateFolder(a.folder, ctx.userData);
    if (!v.ok) return { error: v.error };
    folder = v.folder;
  }
  const r = ctx.notices.add({ kind: a.kind, title, text: a.text || '', folder, itemId: item ? item.id : null, key: key || null, source: 'manager' });
  if (!r) return { error: 'invalid notice' };
  return { type: 'notice', id: r.notice.id, key: r.notice.key, replaced: r.replaced };
}

// { type:'reorder', folder, order: [backlogId…], reason }: the folder's pending items in this order (the rest follow in
// their old relative order; active / done items do not move). Refused for 24 h after the user reordered that queue.
// The window of the folder (if open) takes the new order over via ctx.onReordered. -> result | { error }
const REASON_MAX = 1000;
async function reorderAction(a, ctx) {
  const v = validateFolder(a.folder, ctx.userData);
  if (!v.ok) return { error: v.error };
  if (ctx.managerDir && norm(v.folder) === norm(ctx.managerDir)) return { error: 'the manager folder cannot be reordered' };
  const reason = typeof a.reason === 'string' ? a.reason.trim().slice(0, REASON_MAX) : '';
  if (!reason) return { error: 'reason missing' };
  const st = await backlog.getBacklog(ctx.backlogDir, v.folder);
  const now = Date.now();
  const until = backlog.userOrderLock(st, now);
  if (until) {
    const t = new Date(until);
    const hm = `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    return { error: `the user reordered this queue on ${new Date(st.userOrderAt).toISOString()}; their order wins until ${hm} (24 h). Propose the order with a notice instead` };
  }
  const r = backlog.applyOrder(st.items, a.order);
  if (r.error) return { error: r.error };
  const before = st.items.filter((i) => i.status === 'pending').map((i) => i.id);
  const after = r.items.filter((i) => i.status === 'pending').map((i) => i.id);
  const changed = before.some((id, k) => after[k] !== id);
  if (changed) {
    await backlog.saveBacklog(ctx.backlogDir, v.folder, { ...st, items: r.items });
    if (ctx.onReordered) ctx.onReordered(v.folder, { order: after, reason, items: r.items });
  }
  return { type: 'reorder', folder: v.folder, order: after, changed };
}

// { type:'backlog-update', folder, backlogId, status: 'dropped'|'failed'|'done', note }: a pending / failed item of the folder
// gets the status (active is refused; the tied inbox item is not changed). main applies it (ctx.backlogUpdate: the file, the
// folder's window, the notice); without it the file is written directly (tests). -> result | { error }
async function backlogUpdateAction(a, ctx) {
  const v = validateFolder(a.folder, ctx.userData);
  if (!v.ok) return { error: v.error };
  if (ctx.managerDir && norm(v.folder) === norm(ctx.managerDir)) return { error: "the manager folder's own queue cannot be changed" };
  const id = typeof a.backlogId === 'string' ? a.backlogId : '';
  if (!id) return { error: 'backlogId missing' };
  if (!['dropped', 'failed', 'done'].includes(a.status)) return { error: `bad status ${JSON.stringify(a.status)} (dropped, failed or done)` };
  const note = typeof a.note === 'string' ? a.note.trim().slice(0, NOTE_MAX) : '';
  if (!note) return { error: 'note missing (why the item is changed)' };
  const r = ctx.backlogUpdate
    ? await ctx.backlogUpdate({ folder: v.folder, backlogId: id, status: a.status, note, by: 'manager' })
    : await backlog.updateStatus(ctx.backlogDir, v.folder, id, a.status, note, { from: ['pending', 'failed'] });
  if (r.error) return { error: r.error };
  return { type: 'backlog-update', folder: v.folder, backlogId: id, status: a.status, prev: r.prev.status };
}

// Scheduling hints of a route / create action (roadmap 33): kind, touches, after (all optional; null = not given).
// Stricter than backlog.sanitizeItem (which silently drops bad entries) so the agent learns about its mistakes.
// An after id that names no known item is allowed (it may belong to another folder). -> { fields } | { error }
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
function schedHints(a) {
  const fields = {};
  if (a.kind !== undefined && a.kind !== null) {
    if (!backlog.KINDS.has(a.kind)) return { error: `bad kind ${JSON.stringify(a.kind)} (research, implement or verify)` };
    fields.kind = a.kind;
  }
  if (a.touches !== undefined && a.touches !== null) {
    if (!Array.isArray(a.touches)) return { error: 'touches must be an array of paths relative to the folder' };
    if (a.touches.length > backlog.TOUCHES_MAX) return { error: `too many touches (max ${backlog.TOUCHES_MAX})` };
    for (const t of a.touches) {
      if (!backlog.cleanTouch(t)) return { error: `bad touches entry ${JSON.stringify(t)} (a relative path inside the folder, no .., ≤ 200 chars)` };
    }
    const touches = backlog.cleanTouches(a.touches);
    if (touches) fields.touches = touches;
  }
  if (a.after !== undefined && a.after !== null) {
    if (!Array.isArray(a.after)) return { error: 'after must be an array of backlog ids' };
    if (a.after.length > backlog.AFTER_MAX) return { error: `too many after ids (max ${backlog.AFTER_MAX})` };
    for (const id of a.after) {
      if (typeof id !== 'string' || !ID_RE.test(id)) return { error: `bad after id ${JSON.stringify(id)}` };
    }
    const after = backlog.cleanAfter(a.after);
    if (after) fields.after = after;
  }
  return { fields };
}

// ctx = { inbox (createInbox store), backlogDir, userData, workRoot (string | () => string, for create),
//         onCreated(folder) (create made it), onRouted(folder, backlogItem), onLinked(folder, backlogItem),
//         qa (qa.createQa store, optional), notices (notices.createNotices store, optional),
//         managerDir, onReordered(folder, { order, reason, items }) (reorder), answer(action) -> result | { error } (answer),
//         release(action) -> result | { error } (release),
//         backlogUpdate({ folder, backlogId, status, note, by }) -> { item, prev } | { error } (backlog-update, optional) }
// One file may hold one action, an array of actions, or { actions: [...] }. -> { ok, errors: string[], results }
async function processActions(raw, ctx) {
  const actions = Array.isArray(raw) ? raw : raw && Array.isArray(raw.actions) ? raw.actions : [raw];
  const errors = [];
  const results = [];
  for (const [n, a] of actions.entries()) {
    const fail = (msg) => errors.push(`action ${n + 1}: ${msg}`);
    if (!a || typeof a !== 'object') {
      fail('not an object');
      continue;
    }
    const itemId = typeof a.itemId === 'string' && a.itemId ? a.itemId : null;
    const item = itemId ? ctx.inbox.find(itemId) : null;
    if (itemId && !item) {
      fail(`unknown itemId ${itemId}`);
      continue;
    }
    const note = typeof a.note === 'string' ? a.note.slice(0, NOTE_MAX) : undefined;
    if (a.type === 'inbox') {
      // the manager puts an item on the inbox itself (status new or hold). Not offered back to it as new work.
      const text = typeof a.text === 'string' ? a.text.trim().slice(0, TEXT_MAX) : '';
      if (!text) {
        fail('text missing');
        continue;
      }
      if (a.status !== undefined && a.status !== 'new' && a.status !== 'hold') {
        fail(`bad status ${a.status} (new or hold)`);
        continue;
      }
      const it = ctx.inbox.add({ text, title: optTitle(a), note, status: a.status, source: 'manager' });
      if (!it) fail('text missing');
      else results.push({ type: 'inbox', itemId: it.id, status: it.status });
      continue;
    }
    if (a.type === 'link') {
      const r = await linkAction(a, item, ctx);
      if (r.error) fail(r.error);
      else results.push(r);
      continue;
    }
    if (a.type === 'inbox-edit') {
      const r = editAction(a, item, ctx);
      if (r.error) fail(r.error);
      else results.push(r);
      continue;
    }
    if (a.type === 'notice') {
      const r = noticeAction(a, item, ctx);
      if (r.error) fail(r.error);
      else results.push(r);
      continue;
    }
    if (a.type === 'reorder') {
      const r = await reorderAction(a, ctx);
      if (r.error) fail(r.error);
      else results.push(r);
      continue;
    }
    if (a.type === 'backlog-update') {
      const r = await backlogUpdateAction(a, ctx);
      if (r.error) fail(r.error);
      else results.push(r);
      continue;
    }
    if (a.type === 'answer') {
      // a choice prompt that stopped a session (sessions.json); main checks it is still the same prompt and safe to press
      const r = ctx.answer ? await ctx.answer(a) : { error: 'answer unavailable' };
      if (r.error) fail(r.error);
      else results.push(r);
      continue;
    }
    if (a.type === 'nudge') {
      // a message to the lead of a session whose wait looks endless (waits.json); main checks it still waits
      const r = ctx.nudge ? await ctx.nudge(a) : { error: 'nudge unavailable' };
      if (r.error) fail(r.error);
      else results.push(r);
      continue;
    }
    if (a.type === 'release') {
      // the committed HEAD of the app's source repo into the app's folder (scripts/release.js); the new RELEASE.json
      // reserves the update (queues hold, restart at a gap, src/main/autorestart.js)
      const r = ctx.release ? await ctx.release(a) : { error: 'release unavailable' };
      if (r.error) fail(r.error);
      else results.push(r);
      continue;
    }
    if (a.type === 'task-prefix') {
      const r = prefixAction(a, ctx);
      if (r.error) fail(r.error);
      else results.push(r);
      continue;
    }
    if (a.type === 'inbox-merge') {
      const r = mergeAction(a, ctx);
      if (r.error) fail(r.error);
      else results.push(r);
      continue;
    }
    if (a.type === 'route' || a.type === 'create') {
      if (a.inbox !== undefined && typeof a.inbox !== 'boolean') {
        fail('inbox must be true or false');
        continue;
      }
      const text = typeof a.text === 'string' ? a.text.trim().slice(0, TEXT_MAX) : '';
      if (!text) {
        fail('text missing');
        continue;
      }
      const hints = schedHints(a);
      if (hints.error) {
        fail(hints.error);
        continue;
      }
      // AT-6: the session's model / effort (none = the default of the settings)
      const mh = models.actionHints(a);
      if (mh.error) {
        fail(mh.error);
        continue;
      }
      Object.assign(hints.fields, mh.fields);
      let v;
      if (a.type === 'create') {
        const root = typeof ctx.workRoot === 'function' ? ctx.workRoot() : ctx.workRoot;
        if (typeof root !== 'string' || !path.isAbsolute(root)) {
          fail('work root not set');
          continue;
        }
        if (ctx.userData && isInside(root, ctx.userData)) {
          fail('work root inside the app data directory');
          continue;
        }
        try {
          v = validateFolder(createWorkFolder(root, a.name), ctx.userData);
        } catch (err) {
          fail(`cannot create folder: ${err && err.message}`);
          continue;
        }
        if (v.ok && ctx.onCreated) ctx.onCreated(v.folder);
      } else v = validateFolder(a.folder, ctx.userData);
      if (!v.ok) {
        fail(v.error);
        continue;
      }
      // inbox:true without an itemId: put the work on the inbox first (source manager), then route that item
      let routedItem = item;
      if (!routedItem && a.inbox === true) {
        routedItem = ctx.inbox.add({ text, title: optTitle(a), source: 'manager', historyNote: `PMO が追加して ${path.basename(v.folder)} に振り分け` });
      }
      // heading (UIUX U1): the action's title, else the inbox item's; none -> the screens make one from the text
      const title = optTitle(a) || (routedItem && routedItem.title) || '';
      const bi = await appendBacklog(ctx.backlogDir, v.folder, {
        id: backlogItemId(`${ROUTE_PREFIX}${(routedItem && routedItem.id) || 'x'}-`),
        ...(title ? { title } : {}),
        text,
        tabId: null,
        status: 'pending',
        createdAt: Date.now(),
        startedAt: null,
        doneAt: null,
        note: '',
        ...hints.fields,
      });
      if (item && ctx.qa) ctx.qa.moveInbox(item.id, v.folder, bi.id); // answers given before routing carry over
      if (routedItem) {
        // the inbox item takes the folder number of the first backlog item it was routed to (and a heading if it had none)
        const cur = ctx.inbox.find(routedItem.id) || routedItem;
        const patch = { status: 'routed', folder: v.folder, ...(note !== undefined ? { note } : {}) };
        if (!cur.no && bi.no) patch.no = bi.no;
        if (!cur.title && title) patch.title = title;
        ctx.inbox.update(routedItem.id, patch, { source: 'manager', internal: true });
      }
      results.push({ type: a.type, folder: v.folder, backlogId: bi.id, ...(bi.no ? { no: bi.no } : {}), ...(title ? { title } : {}), ...hints.fields, ...(routedItem && !item ? { itemId: routedItem.id } : {}) });
      if (ctx.onRouted) ctx.onRouted(v.folder, bi);
    } else if (a.type === 'qa') {
      const r = await qaAction(a, item, ctx);
      if (r.error) fail(r.error);
      else results.push(r);
    } else if (a.type === 'update' || a.type === 'ask') {
      if (!item) {
        fail('itemId missing');
        continue;
      }
      const patch = {};
      if (a.type === 'ask') patch.status = 'asking';
      else if (a.status !== undefined) {
        if (!['new', 'asking', 'hold', 'routed', 'done', 'failed', 'dropped'].includes(a.status)) {
          fail(`bad status ${a.status}`);
          continue;
        }
        patch.status = a.status;
      }
      if (note !== undefined) patch.note = note;
      ctx.inbox.update(item.id, patch, { source: 'manager' });
      results.push({ type: a.type, itemId: item.id });
    } else {
      fail(`unknown type ${JSON.stringify(a.type)}`);
    }
  }
  return { ok: errors.length === 0, errors, results };
}

function moveTo(dir, file) {
  fs.mkdirSync(dir, { recursive: true });
  let dest = path.join(dir, path.basename(file));
  if (fs.existsSync(dest)) dest = path.join(dir, `${Date.now()}-${path.basename(file)}`);
  fs.renameSync(file, dest);
  return dest;
}

// Reads, runs and moves one outbox file. -> result of processActions (or a parse error)
async function processOutboxFile(file, ctx) {
  const outbox = path.dirname(file);
  let raw;
  let res;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').trim()); // trim() also drops a BOM
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, errors: ['gone'], results: [] };
    res = { ok: false, errors: [`invalid JSON: ${err && err.message}`], results: [] };
  }
  if (!res) {
    try {
      res = await processActions(raw, ctx);
    } catch (err) {
      res = { ok: false, errors: [`failed: ${err && err.message}`], results: [] };
    }
  }
  try {
    if (res.ok) {
      const dest = moveTo(path.join(outbox, 'done'), file);
      // ids made by the actions (e.g. the inbox id of an inbox / route inbox:true action) for the agent to read back
      if (res.results.length) fs.writeFileSync(dest + '.result.json', JSON.stringify(res.results, null, 1) + '\n');
    } else {
      const dest = moveTo(path.join(outbox, 'failed'), file);
      const applied = res.results.length ? `\n適用済み: ${JSON.stringify(res.results)}` : '';
      fs.writeFileSync(dest + '.error.txt', res.errors.join('\n') + applied + '\n');
    }
  } catch (err) {
    console.warn('[manager] moving outbox file failed', err);
  }
  return res;
}

// AT-202: outbox/done grew to so many files that listing it took minutes (the PMO's `ls outbox/done`). Files older
// than DONE_KEEP_MS move into done/<YYYY-MM-DD>/ (their own mtime's day), so done/ keeps about two days of files and
// a recent `<name>.result.json` stays where the PMO reads it. Runs in the background, one file at a time, through a
// streamed listing (no array of every name). -> { moved, kept, failed }
const DONE_KEEP_MS = 2 * 24 * 3600 * 1000;
const OUTBOX_POLL_MS = 2000;
const DAY_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
async function archiveDone(managerDir, { now = Date.now(), keepMs = DONE_KEEP_MS, max = Infinity } = {}) {
  const done = path.join(managerDir, 'outbox', 'done');
  const res = { moved: 0, kept: 0, failed: 0 };
  let dir;
  try {
    dir = await fs.promises.opendir(done);
  } catch {
    return res;
  }
  const made = new Set();
  try {
    for await (const ent of dir) {
      if (res.moved >= max) break;
      if (!ent.isFile()) continue; // the day folders
      const file = path.join(done, ent.name);
      try {
        const st = await fs.promises.stat(file);
        if (now - st.mtimeMs < keepMs) {
          res.kept++;
          continue;
        }
        const day = path.join(done, dayOf(st.mtimeMs));
        if (!made.has(day)) {
          await fs.promises.mkdir(day, { recursive: true });
          made.add(day);
        }
        let dest = path.join(day, ent.name);
        if (fs.existsSync(dest)) dest = path.join(day, `${Date.now()}-${ent.name}`);
        await fs.promises.rename(file, dest);
        res.moved++;
      } catch {
        res.failed++; // gone meanwhile / held open: the next run tries again
      }
    }
  } finally {
    await dir.close().catch(() => {});
  }
  return res;
}

// Watches manager/outbox/*.json (existing files are processed at start). Files are handled one at a time; one that
// takes longer than limits.outbox() (AT-202: a slow disk step) no longer holds back the files after it (it still
// finishes and moves itself). outbox/done is tidied at the start and then every 6 h (archiveDone).
function watchOutbox(managerDir, ctx, { chokidar }) {
  const outbox = path.join(managerDir, 'outbox');
  let chain = Promise.resolve();
  let tidying = false;
  const tidy = () => {
    if (tidying) return;
    tidying = true;
    archiveDone(managerDir)
      .then((r) => r.moved && console.log(`[manager] outbox/done: ${r.moved} old files moved into day folders`))
      .catch((err) => console.warn('[manager] outbox/done tidy', err))
      .then(() => (tidying = false));
  };
  const tidyFirst = setTimeout(tidy, 30_000);
  const tidyTimer = setInterval(tidy, 6 * 3600 * 1000);
  if (tidyFirst.unref) tidyFirst.unref();
  if (tidyTimer.unref) tidyTimer.unref();
  const watcher = chokidar.watch(outbox, {
    depth: 0,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  });
  const queued = new Set(); // resolved paths waiting or being processed (chokidar and the poll below both add)
  const enqueue = (file) => {
    const f = path.resolve(file);
    if (path.dirname(f) !== path.resolve(outbox) || !/\.json$/i.test(f) || queued.has(f)) return;
    queued.add(f);
    const run = () => processOutboxFile(f, ctx).finally(() => queued.delete(f));
    chain = chain
      .then(() => timebox(run(), limits.outbox(), { label: `outbox ${path.basename(f)}` }))
      .catch((err) => console.warn('[manager] outbox', err));
  };
  watcher.on('add', enqueue);
  watcher.on('error', (err) => console.warn('[manager] outbox watcher', err));
  // AT-202: chokidar learns of a new file through async fs.stat calls (also awaitWriteFinish), which wait for the
  // libuv thread pool; while slow disk work holds the pool the outbox was not read at all. A small synchronous look at
  // the top of outbox/ (its *.json only, never done/) every OUTBOX_POLL_MS picks up a file whose size did not change
  // since the last look and that is at least 1 s old (written completely).
  let sizes = new Map();
  const poll = () => {
    let names;
    try {
      names = fs.readdirSync(outbox);
    } catch {
      return;
    }
    const now = Date.now();
    const next = new Map();
    for (const n of names) {
      if (!/\.json$/i.test(n)) continue;
      const f = path.resolve(outbox, n);
      if (queued.has(f)) continue;
      let st;
      try {
        st = fs.statSync(f);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      next.set(f, st.size);
      if (sizes.get(f) === st.size && now - st.mtimeMs >= 1000) enqueue(f);
    }
    sizes = next;
  };
  const pollTimer = setInterval(poll, OUTBOX_POLL_MS);
  if (pollTimer.unref) pollTimer.unref();
  const close = watcher.close.bind(watcher);
  watcher.close = () => {
    clearTimeout(tidyFirst);
    clearInterval(tidyTimer);
    clearInterval(pollTimer);
    return close();
  };
  return watcher;
}

// Status changes of route-made items (r-*) and of items tied to an inbox item by a link action, between two saves of
// a folder's backlog -> [{ item, inboxId }] for items that became done / failed. `prev` = Map<id, status> of the last
// known state (updated in place). linkedOf(id) -> inboxId | null for linked items (optional).
function finishedRouted(prev, items, linkedOf = null) {
  const out = [];
  for (const it of items || []) {
    if (!it || typeof it.id !== 'string') continue;
    const routed = it.id.startsWith(ROUTE_PREFIX);
    const linked = linkedOf ? linkedOf(it.id) : null;
    if (!routed && !linked && !prev.has(it.id)) continue;
    const before = prev.get(it.id);
    prev.set(it.id, it.status);
    if (before !== undefined && before !== it.status && (it.status === 'done' || it.status === 'failed')) {
      const m = /^r-(.+)-[0-9a-f]{1,8}$/.exec(it.id);
      out.push({ item: it, inboxId: (m && m[1] !== 'x' ? m[1] : null) || linked || null });
    }
  }
  return out;
}

module.exports = {
  CLAUDE_MD_VERSION,
  USER_MARKER,
  INBOX_PROMPT_HEAD,
  INBOX_PROMPT_OLD_HEADS,
  isInboxPrompt,
  ensureManagerDir,
  readmeHead,
  buildProjects,
  archiveDone,
  DONE_KEEP_MS,
  writeJsonAtomic,
  readJsonFile,
  validateFolder,
  sanitizeFolderName,
  createWorkFolder,
  appendBacklog,
  mergeInjected,
  notifyManager,
  processActions,
  schedHints,
  processOutboxFile,
  watchOutbox,
  finishedRouted,
  inboxIdOf,
};
