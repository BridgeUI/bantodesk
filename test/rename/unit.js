// node tmp/rename/unit.js — RN (依頼-59 / 依頼-47 C): the manager prompt and the patrol lines say 依頼, not 受け箱.
//  1. notifyManager puts the new head 「依頼（inbox.json）と projects.json を確認して…」 on the manager's backlog.
//  2. a pending prompt with the old head 「受け箱と projects.json を確認して…」 is the same prompt: it is rewritten
//     (coalesced, one item) to the new head, never a second item.
//  3. patrol lines (pmo.formatPatrol, notices.patrolNotice) read 「[依頼 保留 3日]」, 「[依頼 保留] id」, 「依頼 <id>」.
//  plus the template: v25+, the new head, the old head named as the same prompt, the patrol line form; an older CLAUDE.md
//  is rewritten above USER_MARKER and the user's text below it is kept; a CLAUDE.md without the version line is left alone.
// Data names stay: inbox.json, status codes. AT_APP_ROOT (run.mjs --all-stable) tests that app's src.
const path = require('path');
const fs = require('fs');
const os = require('os');
const SRC = path.join(process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.join(__dirname, '..', '..'), 'src', 'main');
console.log('src:', SRC);
const pmo = require(path.join(SRC, 'pmo'));
const manager = require(path.join(SRC, 'manager'));
const notices = require(path.join(SRC, 'notices'));
const backlog = require(path.join(SRC, 'backlog'));

let pass = 0;
let fail = 0;
const ok = (name, c, info) => {
  if (c) pass++, console.log('PASS', name);
  else fail++, console.log('FAIL', name, info === undefined ? '' : String(info).slice(0, 600));
};
const OLD_WORD = '受け' + '箱'; // the old name, built so a grep for it finds only the data below
const OLD_HEAD = OLD_WORD + 'と projects.json を確認して、新しい項目を振り分けてください';
const NEW_HEAD = '依頼（inbox.json）と projects.json を確認して、新しい項目を振り分けてください';

(async () => {
  // --- the constant
  ok('0a INBOX_PROMPT_HEAD is the new head', manager.INBOX_PROMPT_HEAD === NEW_HEAD, manager.INBOX_PROMPT_HEAD);
  ok('0b old head kept as INBOX_PROMPT_OLD_HEADS', Array.isArray(manager.INBOX_PROMPT_OLD_HEADS) && manager.INBOX_PROMPT_OLD_HEADS.includes(OLD_HEAD));
  ok('0c isInboxPrompt: new, old, other', manager.isInboxPrompt(NEW_HEAD + '（新規: x）') && manager.isInboxPrompt(OLD_HEAD + '（新規: x）') && !manager.isInboxPrompt('ほかの作業') && !manager.isInboxPrompt(null));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-'));
  const bdir = path.join(root, 'backlog');
  const mdir = path.join(root, 'manager');
  fs.mkdirSync(mdir);
  const items = async () => (await backlog.getBacklog(bdir, mdir)).items;
  try {
    // --- 1. new head
    ok('1a prompt added', (await manager.notifyManager(bdir, mdir, { newItems: [{ id: 'iA', reqNo: '依頼-1', text: 'あたらしい' }] })) === 'added');
    let it = await items();
    ok('1b one pending item with the new head', it.length === 1 && it[0].status === 'pending' && it[0].text.startsWith(NEW_HEAD) && it[0].text.includes('新規: iA（依頼-1）'), JSON.stringify(it));
    ok('1c no old word in the prompt', !it[0].text.includes(OLD_WORD), it[0].text);

    // --- 2. an old-head item still pending (queued by an older app) is the same prompt
    await backlog.saveBacklog(bdir, mdir, {
      items: [{ id: 'm-old1', text: OLD_HEAD + '（新規: iOld 「古い」）', tabId: null, status: 'pending', createdAt: Date.now() - 60e3, startedAt: null, doneAt: null, note: '' }],
      auto: {},
    });
    ok('2a old pending prompt is rewritten, not added', (await manager.notifyManager(bdir, mdir, { newItems: [{ id: 'iB', text: 'つぎ' }] })) === 'updated');
    it = await items();
    ok('2b still one item, same id, now the new head', it.length === 1 && it[0].id === 'm-old1' && it[0].text.startsWith(NEW_HEAD) && it[0].text.includes('新規: iB'), JSON.stringify(it));
    const pat = pmo.formatPatrol([{ key: 'i:iH:hold', kind: 'inbox', id: 'iH', status: 'hold', since: 0, age: 4 * 86400e3, text: '保留の依頼', detail: '保留: 来月' }]);
    ok('2c a patrol on top keeps it one item', (await manager.notifyManager(bdir, mdir, { patrol: pat })) === 'updated' && (await items()).length === 1);
    // the old item was picked up (done) -> the next prompt is a new item with the new head
    await backlog.saveBacklog(bdir, mdir, { items: (await items()).map((x) => ({ ...x, status: 'done' })), auto: {} });
    ok('2d after pickup a new item', (await manager.notifyManager(bdir, mdir, { newItems: [{ id: 'iC', text: 'みっつめ' }] })) === 'added');
    it = (await items()).filter((x) => x.status === 'pending');
    ok('2e the new one has the new head', it.length === 1 && it[0].text.startsWith(NEW_HEAD), JSON.stringify(it));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // --- 3. patrol lines
  const now = Date.now();
  const f = [
    { key: 'i:iN:new', kind: 'inbox', id: 'iN', status: 'new', since: now - 3600e3, age: 3600e3, text: '新しい依頼', detail: '' },
    { key: 'i:iA:asking', kind: 'inbox', id: 'iA', status: 'asking', since: now - 2 * 86400e3, age: 2 * 86400e3, text: '質問中', detail: '質問の回答待ち: 色は？' },
    { key: 'i:iR:routed', kind: 'inbox', id: 'iR', status: 'routed', since: now - 2 * 86400e3, age: 2 * 86400e3, text: '振った', detail: '' },
    { key: 'i:iH:hold', kind: 'inbox', id: 'iH', status: 'hold', since: now - 4 * 86400e3, age: 4 * 86400e3, text: '保留の依頼', detail: '保留: 来月' },
    { key: 'b:x:p1:pending', kind: 'backlog', id: 'p1', status: 'pending', since: now - 2 * 86400e3, age: 2 * 86400e3, text: '待ち', name: 'alpha', folder: '/x/alpha', inboxId: 'iR', detail: '' },
  ];
  const t = pmo.formatPatrol(f, new Set(['i:iH:hold']), { stocktake: true, held: [{ id: 'iHeld', title: '来週', text: '来週の件', status: 'hold', note: '予算待ち' }] });
  console.log('---\n' + t + '\n---');
  const line = (id) => t.split('\n').find((l) => l.includes(` ${id} `)) || '';
  ok('3a new -> [依頼 受付 1時間]', line('iN').startsWith('[依頼 受付 1時間] iN'), line('iN'));
  ok('3b asking -> [依頼 あなたの番 2日]', line('iA').startsWith('[依頼 要対応 2日] iA') && line('iA').includes('質問の回答待ち'), line('iA'));
  ok('3c routed -> [依頼 対応中 2日]', line('iR').startsWith('[依頼 対応中 2日] iR'), line('iR'));
  ok('3d hold finding -> [新] [依頼 保留 4日]', line('iH').startsWith('[新] [依頼 保留 4日] iH'), line('iH'));
  ok('3e held list -> [依頼 保留] iHeld', line('iHeld').startsWith('[依頼 保留] iHeld 「来週」（予算待ち）'), line('iHeld'));
  ok('3f backlog line links 依頼 iR', line('p1').startsWith('[alpha pending 2日] p1') && line('p1').includes('（依頼 iR）'), line('p1'));
  ok('3g no old word in the patrol text', !t.includes(OLD_WORD), t);
  ok('3h inboxWhere exported', pmo.inboxWhere && pmo.inboxWhere('hold') === '依頼 保留');
  // findStale: an inbox item without a folder is named 依頼; routed with finished backlog says 依頼は対応中（routed）
  const fs1 = pmo.findStale({
    now,
    inboxItems: [
      { id: 'iR2', status: 'routed', text: 'r', updatedAt: now - 3 * 86400e3, links: [] },
      { id: 'iN2', status: 'new', text: 'n', updatedAt: now - 3600e3 },
    ],
    backlogs: [{ folder: '/x/alpha', items: [{ id: 'r-iR2-aa', status: 'done', text: 'x', doneAt: now - 86400e3 }] }],
  });
  const r2 = (Array.isArray(fs1) ? fs1 : []).find((x) => x.id === 'iR2');
  const n2 = (Array.isArray(fs1) ? fs1 : []).find((x) => x.id === 'iN2');
  ok('3i findStale: folderless inbox finding named 依頼', !!n2 && n2.name === '依頼', JSON.stringify(fs1));
  ok('3j findStale: routed detail says 依頼は対応中（routed）のまま', !!r2 && /依頼は対応中（routed）のまま|振り分け先のバックログに項目が見つかりません/.test(r2.detail) && !r2.detail.includes(OLD_WORD), r2 && r2.detail);
  const pn = notices.patrolNotice(f, pmo.ageText);
  ok('3k dashboard notice lines say 依頼 保留', !!pn && pn.text.includes('- 依頼 保留・4日: 保留の依頼') && pn.text.includes('- 依頼 要対応・2日') && !pn.text.includes(OLD_WORD), pn && pn.text);

  // --- template
  const tm = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-m-'));
  manager.ensureManagerDir(tm); // a fresh manager folder: the template as written
  const md = fs.readFileSync(path.join(tm, 'CLAUDE.md'), 'utf8');
  fs.rmSync(tm, { recursive: true, force: true });
  ok('4a template v25+', manager.CLAUDE_MD_VERSION >= 25 && md.startsWith(`<!-- bantodesk manager v${manager.CLAUDE_MD_VERSION} -->`));
  ok('4b template names the new head and the old one as the same prompt', md.includes(`「${NEW_HEAD}」を積みます`) && md.includes(`前の版の「${OLD_HEAD}」で始まる項目も同じ依頼の文`));
  ok('4c template patrol line form', md.includes('[新] [依頼 状態|フォルダ名 status 経過時間]') && md.includes('保留 = hold') && md.includes('[依頼 保留] id'));
  ok('4c2 template names the patrol row word 要対応 = asking (the word line() prints), あなたの番 only as the older one', md.includes('要対応 = asking') && md.split('あなたの' + '番').length === 2);
  ok('4d no other old word in the template', md.split(OLD_HEAD).join('').split(OLD_WORD + ' hold').join('').indexOf(OLD_WORD) < 0);
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-md-'));
  try {
    const file = path.join(td, 'CLAUDE.md');
    fs.writeFileSync(file, `<!-- agent-terminal manager v24 -->\n${OLD_HEAD} の古い本文\n${manager.USER_MARKER}\n## ユーザーと決めたこと\n- 自分のメモ\n`);
    ok('4e an older CLAUDE.md is rewritten', manager.ensureManagerDir(td) === true);
    const now1 = fs.readFileSync(file, 'utf8');
    ok('4f new text above the marker, the user text below kept', now1.includes(`「${NEW_HEAD}」を積みます`) && !now1.includes('の古い本文') && now1.endsWith(`${manager.USER_MARKER}\n## ユーザーと決めたこと\n- 自分のメモ\n`), now1.slice(-200));
    ok('4g same version -> left alone', manager.ensureManagerDir(td) === false);
    fs.writeFileSync(file, '# 手で書いた CLAUDE.md\n');
    ok('4h no version line -> never touched', manager.ensureManagerDir(td) === false && fs.readFileSync(file, 'utf8') === '# 手で書いた CLAUDE.md\n');
  } finally {
    fs.rmSync(td, { recursive: true, force: true });
  }

  // 5. the leftovers (the rest of RN): no old word in the app's src outside the kept places — labels.js (the rename
  //    table), manager.js (the old prompt head / old patrol line form), the widget (removed in AT-25), native/.
  {
    const root = path.dirname(SRC);
    const keep = (rel) => /^(renderer\/labels\.js|main\/manager\.js|widget\/|main\/widget\.js|main\/native\/)/.test(rel);
    const left = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        const rel = path.relative(root, p).split(path.sep).join('/');
        if (e.isDirectory()) { if (!keep(rel + '/')) walk(p); continue; }
        if (!/\.(js|html|css)$/.test(e.name) || keep(rel)) continue;
        fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (l.includes(OLD_WORD)) left.push(`${rel}:${i + 1}`); });
      }
    };
    walk(root);
    ok('5a no old word left in src (labels / manager / widget aside)', left.length === 0, left.join(' '));
    const cc = fs.readFileSync(path.join(SRC, 'claude-cmd.js'), 'utf8');
    ok('5b routed-session preface says 依頼やバックログから', cc.includes('依頼やバックログから振り分けられた作業'));
    const st = fs.readFileSync(path.join(SRC, 'stuck.js'), 'utf8');
    ok('5c ルーター stuck notice says 振り分けや後押し (U4 wording)', st.includes('答えるまで ルーターは振り分けや後押しを進められません'));
  }

  console.log(`total: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('FAIL crashed', e && e.stack);
  process.exit(1);
});
