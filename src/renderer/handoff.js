'use strict';
// Context handoff (roadmap 21, docs/plan-handoff.md). Owner: core.
// When a session's context is nearly full, the old session writes a handoff memo (as the text of its
// reply: nothing is written to the project), a new session starts in the same folder with that memo
// as its first prompt, and the old tab stays as an ended entry (the user closes it). The manager
// window keeps ONE resident session: there the old tab is closed once the new one has the memo.
//
// window.Handoff:
//   init(hooks)          – core calls once (hooks below)
//   tick(now)            – core calls every second: trigger check, delivery to the new session
//   onEvent(tab, evt)    – core forwards every LIVE assist event (prompt / assistant_text / turn_end / api_error)
//   start(tab)           – manual start (panel button, tab menu); while the turn runs it is queued
//   holds(tab)           – true while the backlog must not send to this tab (handoff in progress)
//   statusText(tab)      – '' or a short Japanese line for the panel
//   threshold()          – current threshold in % (panel shows its button from min(80, threshold))
//   settings() / setSettings(patch) – localStorage 'handoffSettings' { mode, threshold, memMb, pmoAuto, pmoPct, pmoMemMb }
//                          (global; memMb = the session-memory mark of roadmap 22, default 800; pmo* = the PMO's
//                          automatic handoff below, default on / 70 % / 800 MB)
//   pmoStatus()          – manager window: { lastAt, last: { at, reason } } of the automatic handoffs (tests)
//
// The PMO (the manager window's resident session, PROGRESS 45) hands off by itself when it gets heavy: context >= pmoPct
// or its claude >= pmoMemMb. Only between turns: not while the user types in its input box, a dialog / Auto-yes is up,
// a turn runs (an app request being answered, an outbox being written) or a backlog item of it is active. At most once
// an hour (localStorage 'pmoHandoffAt'). Memory alone also hands off (not --resume): the long conversation is the weight.
// When the memo went over, 「PMO から」 gets an info notice (hooks.notice).
//   attachBar(tab)       – core calls after Conversation.create: the confirm bar in the composer dock
// hooks: { tabs(), summary(tab), ready(tab, now), blocked(tab), send(tab, text), createTab(opts),
//          closeTab(id), activate(id), activeId(), raise(tab, kind, text), render(tab), ptyClose(id),
//          markExited(tab, note), isManager, mem(tab) -> MB | null, typing(tab) -> bool, notice({ kind, title, text, key }),
//          carryDraft(old, next) }
(() => {
  const DEFAULTS = { mode: 'confirm', threshold: 85, memMb: 800, pmoAuto: true, pmoPct: 70, pmoMemMb: 800 };
  const PMO_EVERY_MS = 60 * 60_000; // automatic PMO handoffs: at most one per hour
  const PMO_AT_KEY = 'pmoHandoffAt';
  const MODES = ['auto', 'confirm', 'notify', 'off'];
  const STABLE_MS = 3000; // idle on the main screen this long before a handoff starts / the memo is sent
  const WRITE_TIMEOUT_MS = 10 * 60_000; // the old session must finish the memo within this
  const DELIVER_TIMEOUT_MS = 3 * 60_000; // the new session must be ready within this
  const REOFFER_STEP = 5; // after 今はしない / a notice, ask again only when the context grew this many points
  const MEMO_MAX = 18000;
  const MEMO_MIN = 40;
  const START = '=== 引き継ぎメモ ここから ===';
  const END = '=== 引き継ぎメモ ここまで ===';

  let hooks = {};

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }

  function settings() {
    let s = {};
    try {
      s = JSON.parse(localStorage.getItem('handoffSettings') || '{}') || {};
    } catch {}
    const mode = MODES.includes(s.mode) ? s.mode : DEFAULTS.mode;
    const t = Math.round(Number(s.threshold));
    const threshold = Number.isFinite(t) && t >= 1 && t <= 99 ? t : DEFAULTS.threshold;
    // Session memory (roadmap 22, docs/memory-investigation.md) shares this store: from memMb a session is
    // marked heavy (tab badge, panel, dashboard) and its 再起動 is offered. Read by core via memThreshold().
    const m = Math.round(Number(s.memMb));
    const memMb = Number.isFinite(m) && m >= 100 && m <= 32000 ? m : DEFAULTS.memMb;
    const pp = Math.round(Number(s.pmoPct));
    const pmoPct = Number.isFinite(pp) && pp >= 1 && pp <= 99 ? pp : DEFAULTS.pmoPct;
    const pm = Math.round(Number(s.pmoMemMb));
    const pmoMemMb = Number.isFinite(pm) && pm >= 50 && pm <= 32000 ? pm : DEFAULTS.pmoMemMb;
    const pmoAuto = typeof s.pmoAuto === 'boolean' ? s.pmoAuto : DEFAULTS.pmoAuto;
    return { mode, threshold, memMb, pmoAuto, pmoPct, pmoMemMb };
  }
  // UX9 (docs/ux-journey.md §4 A): a session the app started for a routed item (tab.forBacklog) runs unattended, so a
  // confirm bar / notice would stop it until the user looks: it hands off by itself ('auto') unless handoff is 'off'.
  // The manager window's resident session has its own automatic handoff (pmoTick) and keeps the setting.
  function modeOf(tab, s = settings()) {
    if (tab && tab.forBacklog && !hooks.isManager && s.mode !== 'off') return 'auto';
    return s.mode;
  }
  function setSettings(patch) {
    const next = { ...settings(), ...(patch || {}) };
    localStorage.setItem('handoffSettings', JSON.stringify(next));
    for (const t of hooks.tabs?.() || []) {
      if (t.handoff?.phase === 'offered' && next.mode !== 'confirm') clear(t);
      hooks.render?.(t);
    }
  }
  const threshold = () => settings().threshold;

  const pctOf = (tab) => {
    const p = Number(hooks.summary?.(tab)?.contextPct);
    return Number.isFinite(p) ? p : 0;
  };
  const busy = (st) => st && (st.phase === 'queued' || st.phase === 'writing' || st.phase === 'starting');

  // ---- prompts ---------------------------------------------------------------------------
  function memoRequest(reason) {
    const items = hooks.isManager
      ? [
          '- 目的（管理エージェントとしていま追っていること）',
          '- ここまでの作業（振り分けた項目と先、ユーザーと決めたこと、依頼の項目 id と状態）',
          '- 残り作業（次の一手を具体的に。まだ書いていない outbox のアクション、返事待ちの QA）',
          '- 関係するファイル（パス）',
          '- 注意点（ユーザーの好み、やってはいけないこと、未解決の問題）',
        ]
      : [
          '- 目的',
          '- ここまでの作業（決まったこと、変更したファイル、コミット）',
          '- 残り作業（次の一手を具体的に）',
          '- 関係するファイル（パス）',
          '- 注意点（未解決の問題、ユーザーの好み、やってはいけないこと）',
        ];
    return [
      reason
        ? `（BantoDesk より）このセッションが重くなったので（${reason}）、新しいセッションへ引き継ぎます。`
        : '（BantoDesk より）このセッションのコンテキストが残り少なくなったので、新しいセッションへ引き継ぎます。',
      '新しいセッションがこのメモだけで作業を続けられるように、引き継ぎメモを書いてください。',
      '- ツールは使わず、ファイルも作らず、この返答の本文としてだけ書いてください。',
      `- メモは次の 2 行の間に書いてください（2 行はそのまま写す）。\n${START}\n${END}`,
      '- 書く項目:',
      ...items,
    ].join('\n');
  }

  const transcriptHint = (tab) => {
    const enc = String(tab.cwd || '').replace(/[^A-Za-z0-9]/g, '-');
    return enc ? `~/.claude/projects/${enc}/${tab.id}.jsonl` : '';
  };

  function firstPrompt(old, memo, reason) {
    const lines = [
      reason
        ? `（BantoDesk より）前のセッション「${old.label}」が重くなったので（${reason}）、新しいセッションに引き継ぎました。`
        : `（BantoDesk より）前のセッション「${old.label}」のコンテキストが満杯に近づいたので、新しいセッションに引き継ぎました。`,
      '以下は前のセッションが書いた引き継ぎメモです。内容を確かめてから、残り作業を続けてください。',
    ];
    if (hooks.isManager) lines.push('続ける前に inbox.json と projects.json を読み直し、メモの内容といまの状態を突き合わせてください。');
    // UX9: a routed item continues in the new session, which must end it with the mark (renderer.js routedProgress)
    if (old.forBacklog && !hooks.isManager) lines.push('この作業は振り分けられた依頼の続きです。ユーザーに質問せず仮説で進め、すべて終えたら最後の返答の末尾に「作業完了」の 1 行を書いてください（途中でやめるなら「作業中断: <理由>」）。');
    const hint = transcriptHint(old);
    if (hint) lines.push(`前のセッションの記録が必要なときだけ ${hint} を読んでください（大きいので必要な箇所だけ）。`);
    lines.push('', memo);
    return lines.join('\n');
  }

  // The memo = the text between the LAST start marker and the end marker after it; without markers the
  // whole reply (Claude may drop them). Too short → null.
  function extractMemo(text) {
    const s = String(text || '');
    const a = s.lastIndexOf(START);
    let memo = s;
    if (a >= 0) {
      const b = s.indexOf(END, a + START.length);
      memo = s.slice(a + START.length, b >= 0 ? b : undefined);
    }
    memo = memo.trim();
    if (memo.length < MEMO_MIN) return null;
    return memo.length > MEMO_MAX ? `${memo.slice(0, MEMO_MAX)}\n…（長いので途中で切りました）` : memo;
  }

  // ---- flow ------------------------------------------------------------------------------
  function clear(tab) {
    tab.handoff = null;
    updateBar(tab);
    hooks.render?.(tab);
  }

  function setPhase(tab, patch) {
    tab.handoff = { ...(tab.handoff || {}), ...patch };
    updateBar(tab);
    hooks.render?.(tab);
  }

  function start(tab, how = 'manual') {
    if (!tab || tab.exited) return 'セッションは終了しています';
    if (tab.handedOff) return 'このセッションは引き継ぎ済みです';
    if (tab.handoffFrom && !tab.handoffDelivered) return '引き継ぎメモを受け取る前です';
    const st = tab.handoff;
    if (busy(st)) return '';
    // Never while a turn / dialog / Auto-yes / subagent is going: queue it, tick() starts it when ready.
    if (!readyNow(tab, Date.now())) {
      setPhase(tab, { phase: 'queued', how, at: Date.now() });
      return '';
    }
    return begin(tab, how);
  }

  function readyNow(tab, now) {
    if (hooks.blocked?.(tab)) return false;
    if (tab.autoYesAns) return false; // Auto-yes is answering a dialog
    if ((tab.lastPromptAt || 0) > (tab.lastTurnEndAt || 0)) return false; // the turn has not ended
    return !!hooks.ready?.(tab, now);
  }

  function begin(tab, how, reason = '') {
    const why = hooks.blocked?.(tab);
    if (why) return why;
    // UA1: the app / PMO handed off by itself (not the user's 引き継ぐ)
    if (how === 'auto' || how === 'pmo') {
      try {
        window.Usage?.track?.('auto', 'auto.handoff');
      } catch (_) {}
    }
    const at = Date.now();
    setPhase(tab, { phase: 'writing', how, reason, at, askedAt: at, promptSeen: false, texts: new Map(), pct: pctOf(tab) });
    hooks.send?.(tab, memoRequest(reason));
    return '';
  }

  function fail(tab, why) {
    const pct = pctOf(tab);
    setPhase(tab, { phase: 'failed', error: why, at: Date.now(), offeredPct: pct });
    hooks.raise?.(tab, 'error', `引き継ぎできませんでした: ${why}`);
  }

  function finishMemo(tab) {
    const st = tab.handoff;
    if (!st || st.phase !== 'writing') return;
    const memo = extractMemo([...st.texts.values()].join('\n\n'));
    if (!memo) return fail(tab, '引き継ぎメモを読み取れませんでした（返答が短すぎます）');
    const wasActive = hooks.activeId?.() === tab.id;
    const label = continuedLabel(tab.label);
    // the PMO keeps a name the user gave it (otherwise core shows 「PMO」 for every resident session)
    const manual = hooks.isManager && tab.manualLabel && tab.manualText ? tab.manualText : '';
    const next = hooks.createTab?.({ cwd: tab.cwd, team: !!tab.team, delegate: !!tab.delegate, forBacklog: !!tab.forBacklog, model: tab.model || null, effort: tab.effort || null, label: manual || label, manualLabel: !!manual, background: !wasActive && !hooks.isManager });
    if (!next) return fail(tab, '新しいセッションを開けませんでした');
    if (!manual) next.promptLabel = label; // keep the label: the first prompt is the long handoff text
    next.handoffFrom = tab.id;
    next.handoffDelivered = false;
    next.handoffPrompt = firstPrompt(tab, memo, st.how === 'pmo' ? st.reason : '');
    setPhase(tab, { phase: 'starting', at: Date.now(), nextId: next.id, texts: null });
    if (wasActive || hooks.isManager) hooks.activate?.(next.id);
  }

  function continuedLabel(label) {
    const m = String(label || '').match(/^(.*) \(続き(\d*)\)$/);
    if (!m) return `${label} (続き)`;
    return `${m[1]} (続き${(Number(m[2]) || 1) + 1})`;
  }

  function deliver(next, old, now) {
    if (!readyNow(next, now)) {
      next.handoffReadySince = 0;
      return;
    }
    next.handoffReadySince ||= now;
    if (now - next.handoffReadySince < STABLE_MS) return;
    hooks.send?.(next, next.handoffPrompt);
    next.handoffDelivered = true;
    next.handoffPrompt = '';
    complete(old, next);
  }

  // The new session has the memo: its backlog items move over, the old session ends.
  function complete(old, next) {
    const B = window.Backlog;
    if (B) {
      const moved = B.items(old.id).filter((i) => i.status === 'pending');
      for (const it of moved) it.tabId = next.id;
      // UX9: a routed session's active item goes on in the new session. startedAt = now: the new session's prompt / turn
      // end / mark are newer than it (renderer.js backlogTick), not the old session's.
      const act = old.forBacklog && !hooks.isManager ? B.activeOf?.(old.id) : null;
      if (act) {
        act.tabId = next.id;
        act.startedAt = Date.now();
      }
      // also saves the reassignment. An auto send stopped by API errors is not carried: a new session, a new context
      // (autosend.js handoff); one switched off by hand is
      const AS = window.AutoSend;
      const rec = B.autoOff?.(old.id) || (AS ? AS.legacy(B.state(), old.id) : null) || null;
      if (rec && rec.why === 'api') B.setAuto(next.id, true);
      else B.setAuto(next.id, B.auto(old.id), rec);
    }
    old.handedOff = true;
    old.handedOffTo = next.id;
    const how = old.handoff?.how;
    const reason = old.handoff?.reason || '';
    setPhase(old, { phase: 'done', at: Date.now() });
    if (hooks.isManager && how === 'pmo') {
      lastPmo = { at: Date.now(), reason };
      safe(() => hooks.notice?.({
        kind: 'info',
        title: `PMO を引き継ぎました。理由: ${reason}`,
        text: `PMO のセッションが重くなったので、引き継ぎメモを書かせて新しいセッションに移りました（自動、1 時間に 1 回まで）。相談は「PMO に相談」の欄でそのまま続けられます。前のセッションの記録は履歴に残っています。\n\n**理由**: ${reason}`,
        key: `app:pmo-handoff:${old.id}`,
      }));
    }
    if (hooks.isManager) {
      safe(() => hooks.carryDraft?.(old, next)); // an unsent draft in the old input box is not lost
      // one resident session: the old one goes (its transcript stays in the history)
      setTimeout(() => hooks.closeTab?.(old.id), 4000);
      safe(() => hooks.send?.(old, '/exit'));
      return;
    }
    safe(() => hooks.send?.(old, '/exit'));
    setTimeout(() => {
      hooks.ptyClose?.(old.id);
      hooks.markExited?.(old, `引き継ぎ済み — 新しいセッション「${next.label}」で続けています`);
    }, 3000);
  }

  function safe(fn) {
    try {
      return fn();
    } catch (err) {
      console.error(err);
      return undefined;
    }
  }

  function tickTab(tab, now, s) {
    if (tab.exited || tab.handedOff) return;
    const st = tab.handoff;
    // waiting for the memo in a new session
    if (tab.handoffFrom && !tab.handoffDelivered) return; // handled by the old tab's 'starting'
    if (st?.phase === 'queued') {
      if (readyNow(tab, now)) begin(tab, st.how);
      return;
    }
    if (st?.phase === 'writing') {
      if (now - st.askedAt > WRITE_TIMEOUT_MS) fail(tab, '引き継ぎメモが時間内に書き終わりませんでした');
      return;
    }
    if (st?.phase === 'starting') {
      const next = (hooks.tabs?.() || []).find((t) => t.id === st.nextId);
      if (!next || next.exited) return fail(tab, '新しいセッションが終了しました');
      if (now - st.at > DELIVER_TIMEOUT_MS) {
        tab.handoff = { ...st, phase: 'failed', error: '新しいセッションの準備を確認できませんでした' };
        next.handoffDelivered = true; // give up holding it; the user can paste the memo by hand
        hooks.raise?.(tab, 'error', '引き継ぎできませんでした: 新しいセッションの準備を確認できませんでした');
        updateBar(tab);
        hooks.render?.(tab);
        return;
      }
      deliver(next, tab, now);
      return;
    }
    // the PMO's own automatic handoff (manager window): before the generic offer / notice
    if (hooks.isManager && s.pmoAuto && pmoTick(tab, now, s)) return;
    // trigger check
    const pct = pctOf(tab);
    if (st && (st.phase === 'offered' || st.phase === 'dismissed' || st.phase === 'notified' || st.phase === 'failed')) {
      if (pct < s.threshold) return clear(tab); // e.g. after /compact
      if (st.phase === 'offered') return;
      if (pct < (st.offeredPct || 0) + REOFFER_STEP) return;
    }
    const mode = modeOf(tab, s);
    if (mode === 'off' || pct < s.threshold) return;
    if (!readyNow(tab, now)) {
      tab.handoffReadySince = 0;
      return;
    }
    tab.handoffReadySince ||= now;
    if (now - tab.handoffReadySince < STABLE_MS) return;
    // a backlog item is still being finished; a routed session's item goes over with the handoff (complete) instead
    if (window.Backlog?.activeOf?.(tab.id) && !(tab.forBacklog && mode === 'auto')) return;
    const p = Math.round(pct);
    if (mode === 'auto') {
      begin(tab, 'auto');
    } else if (mode === 'confirm') {
      setPhase(tab, { phase: 'offered', at: now, offeredPct: pct });
      hooks.raise?.(tab, 'input', `コンテキスト ${p}%: 新しいセッションへ引き継ぎますか？`);
    } else {
      setPhase(tab, { phase: 'notified', at: now, offeredPct: pct });
      hooks.raise?.(tab, 'input', `コンテキスト ${p}%: パネルの「新しいセッションへ引き継ぐ」で切り替えられます`);
    }
  }

  // ---- the PMO's automatic handoff (PROGRESS 45) ------------------------------------------------
  let lastPmo = null;
  const pmoAt = () => {
    const v = Number(localStorage.getItem(PMO_AT_KEY));
    return Number.isFinite(v) ? v : 0;
  };
  // why the PMO is heavy ('' = it is not): 'コンテキスト 72%' / 'メモリ 830MB' / both
  function pmoReason(tab, s) {
    const pct = pctOf(tab);
    const mb = Number(hooks.mem?.(tab));
    const out = [];
    if (pct >= s.pmoPct) out.push(`コンテキスト ${Math.round(pct)}%`);
    if (Number.isFinite(mb) && mb > 0 && mb >= s.pmoMemMb) out.push(`メモリ ${Math.round(mb)}MB`);
    return out.join('、');
  }
  // true = this tick belongs to the PMO path (waiting or started); false = let the generic trigger run
  function pmoTick(tab, now, s) {
    if (tab.handoffFrom && !tab.handoffDelivered) return false;
    const st = tab.handoff;
    if (st && st.phase !== 'offered' && st.phase !== 'dismissed' && st.phase !== 'notified' && st.phase !== 'failed') return false;
    const reason = pmoReason(tab, s);
    tab.pmoWait = '';
    if (!reason) return false;
    if (now - pmoAt() < PMO_EVERY_MS) return false; // once an hour: the generic offer may still come
    // between turns only
    const wait = pmoWaitWhy(tab, now);
    if (wait) {
      tab.pmoWait = wait;
      tab.handoffReadySince = 0;
      return true;
    }
    tab.handoffReadySince ||= now;
    if (now - tab.handoffReadySince < STABLE_MS) {
      tab.pmoWait = 'ターンの合間を待っています';
      return true;
    }
    if (st) tab.handoff = null; // a pending offer is replaced by the automatic handoff
    localStorage.setItem(PMO_AT_KEY, String(now));
    const why = begin(tab, 'pmo', reason);
    if (why) {
      tab.pmoWait = why;
      localStorage.setItem(PMO_AT_KEY, String(now - PMO_EVERY_MS + 60_000)); // could not send: try again in a minute
    }
    return true;
  }
  // '' = may start now; else what it waits for (Japanese, for tests)
  function pmoWaitWhy(tab, now) {
    if (safe(() => hooks.typing?.(tab))) return 'ユーザーが入力中';
    if (tab.choices || tab.autoYesAns) return '確認待ち';
    if ((tab.lastPromptAt || 0) > (tab.lastTurnEndAt || 0)) return 'ターンの途中';
    if (window.Backlog?.activeOf?.(tab.id)) return '依頼の返答の途中';
    const why = hooks.blocked?.(tab);
    if (why) return why;
    if (!hooks.ready?.(tab, now)) return 'ターンの合間を待っています';
    return '';
  }

  function tick(now = Date.now()) {
    const s = settings();
    for (const t of hooks.tabs?.() || []) safe(() => tickTab(t, now, s));
  }

  function onEvent(tab, evt) {
    const st = tab?.handoff;
    if (!st || st.phase !== 'writing' || !evt) return;
    if (evt.kind === 'prompt') {
      st.promptSeen = true; // the first prompt after the request (its text may be wrapped as pasted content)
    } else if (evt.kind === 'assistant_text' && st.promptSeen) {
      st.texts.set(evt.uuid || `${evt.msgId}:${st.texts.size}`, String(evt.text || ''));
    } else if (evt.kind === 'turn_end' && st.promptSeen) {
      setTimeout(() => finishMemo(tab), 300); // text blocks of the same line may still be in flight
    } else if (evt.kind === 'api_error' && st.promptSeen) {
      fail(tab, `API エラー（${evt.text || evt.error || ''}）`);
    }
  }

  function holds(tab) {
    if (!tab) return false;
    if (busy(tab.handoff)) return true;
    return !!tab.handoffFrom && !tab.handoffDelivered;
  }

  function statusText(tab) {
    if (!tab) return '';
    if (tab.handedOff) return '引き継ぎ済み（新しいセッションで続けています）';
    if (tab.handoffFrom && !tab.handoffDelivered) return '前のセッションの引き継ぎメモを待っています…';
    const st = tab.handoff;
    switch (st?.phase) {
      case 'queued': return 'ターンが終わったら引き継ぎます…';
      case 'writing': return '引き継ぎメモを書いています…';
      case 'starting': return '新しいセッションを起動しています…';
      case 'failed': return `引き継ぎできませんでした: ${st.error || ''}`;
      default: return '';
    }
  }

  // ---- confirm bar (top of the composer dock: visible in rich / term / split mode) -----------
  function attachBar(tab) {
    const dock = tab?.conv?.dock;
    if (!dock || tab.handoffBar) return;
    const bar = h('div', 'handoff-bar');
    bar.hidden = true;
    bar.addEventListener('mousedown', (e) => e.stopPropagation());
    dock.prepend(bar);
    tab.handoffBar = bar;
  }

  function button(text, cls, onClick) {
    const b = h('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function updateBar(tab) {
    const bar = tab.handoffBar;
    if (!bar) return;
    const st = tab.handoff;
    const phase = st?.phase;
    bar.replaceChildren();
    bar.className = 'handoff-bar';
    if (phase === 'offered') {
      bar.append(h('span', 'hb-text', `コンテキストが ${Math.round(st.offeredPct || pctOf(tab))}% です。新しいセッションへ引き継ぎますか？`));
      bar.append(button('引き継ぐ', 'hb-go', () => start(tab, 'confirm')));
      bar.append(button('今はしない', 'hb-no', () => setPhase(tab, { phase: 'dismissed', offeredPct: pctOf(tab) })));
    } else if (busy(st)) {
      bar.classList.add('busy');
      bar.append(h('span', 'hb-text', statusText(tab)));
      if (phase !== 'starting') bar.append(button('中止', 'hb-no', () => setPhase(tab, { phase: 'dismissed', offeredPct: pctOf(tab) })));
    } else if (phase === 'failed') {
      bar.classList.add('err');
      bar.append(h('span', 'hb-text', statusText(tab)));
      bar.append(button('もう一度', 'hb-go', () => start(tab, 'manual')));
      bar.append(button('閉じる', 'hb-no', () => setPhase(tab, { phase: 'dismissed', offeredPct: pctOf(tab) })));
    } else {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
  }

  window.Handoff = {
    init(o) {
      hooks = o || {};
    },
    tick,
    onEvent,
    start,
    holds,
    statusText,
    pmoStatus: () => ({ lastAt: pmoAt(), last: lastPmo }),
    threshold,
    settings,
    setSettings,
    modeOf,
    attachBar,
    MODES,
    _extractMemo: extractMemo, // tests
  };
})();
