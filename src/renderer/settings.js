'use strict';
// ⚙ 設定 (UIUX U4, docs/concept-uiux.md §2.2・§2.6, docs/ui-copy.md). Owner: core.
// A modal over #overlay-root with every setting of the app. The values stay where they always were:
// localStorage 'notifySettings' through window.Notify.settings()/setSettings(), 'handoffSettings' through
// window.Handoff, 'autoYes' through renderer.js (window.AutoYes, synced to every window by main),
// <userData>/app-settings.json through api.appSettings()/setAppSettings() (GPU).
// Labels are short; the explanation of each item is in its tooltip (title) and the small「?」.
// Every input carries data-setting="<key>" (tests find them by it).
//
// window.Settings:
//   open(sectionId?) / close() / isOpen() / render()
//   register({ id, title, order, render(container) }) – another module's section, placed among the built-in ones
//                                                       by order; the same id replaces the earlier one.
(() => {
  const W = (window.Labels && window.Labels.WORDS) || {};
  const extra = new Map(); // id -> { id, title, order, render }
  let root = null;
  let lastSection = null;

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }
  const safe = (fn, fb) => {
    try {
      return fn();
    } catch (err) {
      console.error(err);
      return fb;
    }
  };
  const N = () => window.Notify;
  const ns = () => safe(() => N()?.settings?.(), null) || {};
  const setN = (patch) => safe(() => N()?.setSettings?.(patch));
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  // ---- controls ---------------------------------------------------------------
  function help(text) {
    const q = h('span', 'st-help', '?');
    q.title = text;
    q.tabIndex = 0;
    return q;
  }
  // one line: label, controls, optional「?」. tip also goes on the whole row.
  function row(label, controls, tip) {
    const r = h('div', 'st-row');
    const l = h('span', 'st-label', label);
    const c = h('span', 'st-ctl');
    c.append(...[].concat(controls).filter(Boolean).map((x) => (typeof x === 'string' ? h('span', 'st-unit', x) : x)));
    r.append(l, c);
    if (tip) {
      r.title = tip;
      r.append(help(tip));
    }
    return r;
  }
  function check(key, val, onChange) {
    const c = h('input');
    c.type = 'checkbox';
    c.dataset.setting = key;
    c.checked = !!val;
    c.addEventListener('change', () => onChange(c.checked));
    return c;
  }
  // a checkbox with its words on the right (the words are the label)
  function checkRow(key, val, label, tip, onChange) {
    const r = h('div', 'st-row');
    const l = h('label', 'st-check');
    l.append(check(key, val, onChange), h('span', 'st-label-r', label));
    r.append(l);
    if (tip) {
      r.title = tip;
      r.append(help(tip));
    }
    return r;
  }
  function num(key, val, { min, max, step = 1, width = '4.5em', round = false }, onChange) {
    const el = h('input', 'st-input');
    el.type = 'number';
    el.dataset.setting = key;
    el.min = String(min);
    el.max = String(max);
    el.step = String(step);
    el.style.width = width;
    el.value = String(val);
    el.addEventListener('change', () => {
      let v = Number(el.value);
      if (!Number.isFinite(v)) return;
      if (round) v = Math.round(v);
      v = clamp(v, min, max);
      el.value = String(v);
      onChange(v);
    });
    return el;
  }
  function select(key, val, options, onChange) {
    const el = h('select', 'st-input');
    el.dataset.setting = key;
    for (const [v, t, tip] of options) {
      const o = h('option', null, t);
      o.value = v;
      if (tip) o.title = tip;
      o.selected = val === v;
      el.append(o);
    }
    el.addEventListener('change', () => onChange(el.value));
    return el;
  }
  function button(text, onClick, tip) {
    const b = h('button', 'st-btn', text);
    b.type = 'button';
    if (tip) b.title = tip;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      onClick();
    });
    return b;
  }
  const note = (cls) => h('span', `st-note ${cls || ''}`.trim());

  // ---- built-in sections --------------------------------------------------------
  const BUILTIN = [
    {
      id: 'auto',
      title: '自動化',
      order: 10,
      render(box) {
        const s = ns();
        const ay = window.AutoYes;
        box.append(
          checkRow('autoYes', ay ? ay.get() : localStorage.getItem('autoYes') !== '0', W.autoYes || '安全な確認は自動で通す', `Claude Code の許可の確認のうち、既定が「はい」で危なくないものを自動で押します。全部のウィンドウで同じ設定です（${window.Labels.shortcutKey('autoYes')}）`, (v) => {
            if (ay) ay.set(v);
          }),
          checkRow('routedTeam', s.routedTeam !== false, 'サブエージェントに分担させる', '振り分けたセッションで Agent Teams を有効にし、サブエージェントやチームへの分担を促します。次に振り分けたセッションから効きます', (v) => setN({ routedTeam: v })),
        );
      },
    },
    {
      // UIUX U6 (依頼-42): the conversation view closes diffs and tool output by default (conversation.js)
      id: 'conv',
      title: '会話の表示',
      order: 15,
      render(box) {
        const C = window.Conversation;
        const s = C?.foldSettings?.() || {};
        box.append(
          checkRow('openDiffs', s.openDiffs === true, W.openDiffs || '差分を開いて表示', '編集・書き込みの差分を、最初から開いて出します。オフなら「ファイル名 +12 −3」の 1 行で、押すと開きます。新しく出る差分から効きます', (v) => C?.setFoldSettings?.({ openDiffs: v })),
          checkRow('openResults', s.openResults === true, W.openResults || '結果を開いて表示', 'コマンドの出力・サブエージェントの指示と結果を、最初から開いて出します。オフなら「出力 N 行」の 1 行で、押すと開きます。エラーはいつも開いて出します', (v) => C?.setFoldSettings?.({ openResults: v })),
        );
        // UA3 (docs/usage-analytics.md §5): the session window without the everyday parts (renderer.js SessionSlim)
        const S = window.SessionSlim;
        if (S) {
          box.append(checkRow('sessionSlim', S.get(), W.slimSession || 'セッション画面を問題のときの形にする', 'セッション画面を「問題が起きたときに開く画面」にします。サイドパネル・ペインの見出し（会話 / ターミナルの切り替え）を出さず、⋯ の「この作業の詳しく」「ターミナル」から開きます。オフで前の形に戻ります', (v) => S.set(v)));
        }
      },
    },
    {
      id: 'parallel',
      title: '同時に動かす作業',
      order: 20,
      render(box) {
        const s = ns();
        box.append(
          row('上限', [num('parallelMax', s.parallelMax ?? 3, { min: 1, max: 10, width: '3.5em' }, (v) => setN({ parallelMax: v })), '件'], '全部のフォルダで同時に動かす作業の数'),
          row('空きメモリ', [num('minFreeGB', s.minFreeGB ?? 1, { min: 0, max: 256, step: 0.5, width: '4em' }, (v) => setN({ minFreeGB: v })), 'GB 以上'], '空きメモリがこれより少ないあいだは、新しい作業を始めません（0 で見ない）'),
          row('CPU', [num('maxCpuPct', s.maxCpuPct ?? 80, { min: 0, max: 100, step: 5, width: '4em' }, (v) => setN({ maxCpuPct: v })), '% 以下'], 'CPU がこれを超え続けているあいだは、新しい作業を始めません（0 で見ない）'),
        );
      },
    },
    {
      // PM1 段 3 (依頼-189): how often the app compares PROGRESS.md with the backlogs (haiku). manager settings.json
      // progressCheckMinutes through main (progress:settings / progress:setSettings)
      id: 'pmo',
      title: W.pmo || 'PMO',
      order: 25,
      render(box) {
        const api = window.api;
        if (!api || typeof api.progressCheckSettings !== 'function') {
          box.append(h('div', 'st-empty', '—'));
          return;
        }
        const tip = 'アプリが各フォルダの PROGRESS.md と待ちを比べ、ずれがあるときだけ haiku に事実を並べさせて「PMO の記録」に出します。手を打つずれは PMO の見回りにも載せます。止めると回りません（1 日 1 回の棚卸しの前の確認も止まります）';
        const slot = h('span', 'st-ctl-slot');
        const r = row('進み具合の確認（haiku）', slot, tip);
        r.dataset.role = 'progress-check';
        const msg = note('nt-progress-note');
        r.append(msg);
        box.append(r);
        const draw = (st) => {
          if (!st || !Array.isArray(st.choices)) {
            msg.textContent = st === null ? '保存できませんでした' : '';
            return;
          }
          const opts = st.choices.map(([m, t]) => [String(m), t]);
          if (!opts.some(([v]) => v === String(st.minutes))) opts.push([String(st.minutes), `${st.minutes} 分`]);
          slot.replaceChildren(select('progressCheckMinutes', String(st.minutes), opts, (v) => {
            msg.textContent = '';
            Promise.resolve(safe(() => api.setProgressCheckSettings({ minutes: Number(v) }), null)).then((x) => (x ? draw(x) : (msg.textContent = '保存できませんでした'))).catch(() => (msg.textContent = '保存できませんでした'));
          }));
        };
        Promise.resolve(safe(() => api.progressCheckSettings(), null)).then(draw).catch(() => {});
      },
    },
    {
      id: 'rest',
      title: 'セッションの休止',
      order: 30,
      render(box) {
        const s = ns();
        box.append(
          row('完了の後', [num('doneStopMin', s.doneStopMin ?? 2, { min: 0, max: 1440, width: '4em' }, (v) => setN({ doneStopMin: v })), '分で止める'], '振り分けた作業が「作業完了」で終わってからこの時間がたつと、claude を止めてメモリを空けます。タブと会話は残り、開いて送ると続きから再開します（0 で止めない）'),
          row('使っていないタブ', [num('restIdleMin', s.restIdleMin ?? 30, { min: 0, max: 1440, step: 5, round: true }, (v) => setN({ restIdleMin: v })), '分で休ませる'], '最後に使ってからこの時間がたったタブの claude を休ませてメモリを空けます。開くか送ると続きから再開します。応答中・要対応・作業中のタブと PMO は休ませません（0 で休ませない）'),
        );
      },
    },
    {
      id: 'update',
      title: '更新',
      order: 40,
      render(box) {
        const s = ns();
        box.append(
          row('待つ時間', [num('updateHoldMin', s.updateHoldMin ?? 30, { min: 5, max: 1440, step: 5, round: true }, (v) => setN({ updateHoldMin: v })), '分'], '新しい版が入ってからこの時間がたっても作業が終わらなければ、ターンの合間で再起動します。実行中の作業は同じ会話の続きで再開します'),
          checkRow('showUpdateBar', s.showUpdateBar === true, '更新の帯を出す', '新しい版を待っているあいだ、上のバーに「更新待ち」を出します。出さなくても「PMO の記録」に残ります', (v) => {
            setN({ showUpdateBar: v });
            safe(() => window.dispatchEvent(new CustomEvent('bantodesk:update-bar')));
          }),
        );
      },
    },
    {
      id: 'notify',
      title: '通知と音',
      order: 50,
      render(box) {
        const s = ns();
        const kinds = s.kinds || {};
        const preview = (k) => safe(() => window.Sounds?.preview?.(k, ns().volume, ns().style));
        const vol = h('input', 'st-range');
        vol.type = 'range';
        vol.min = '0';
        vol.max = '1';
        vol.step = '0.05';
        vol.dataset.setting = 'volume';
        vol.value = String(s.volume ?? 0.5);
        vol.addEventListener('change', () => setN({ volume: Number(vol.value) }));
        box.append(
          checkRow('sound', s.sound !== false, '音を鳴らす', '', (v) => setN({ sound: v })),
          row('音量', vol),
          row('音の種類', [
            select('style', s.style || 'subtle', [['subtle', '控えめ', '柔らかい短い音'], ['clear', 'はっきり', '音程が動く目立つ音']], (v) => setN({ style: v })),
            button('試聴', () => preview('input'), '今の音量と種類で鳴らします'),
          ]),
        );
        for (const [k, label] of [['input', W.yourTurn || '要対応'], ['done', W.done || '完了'], ['error', W.error || 'エラー']]) {
          const r = row(label, [check(`kinds.${k}`, kinds[k] !== false, (v) => setN({ kinds: { [k]: v } })), button('試聴', () => preview(k))], `${label}になったときに知らせます`);
          r.querySelector('.st-label').title = `${label}の通知`;
          box.append(r);
        }
        box.append(
          row('鳴らさないとき', select('suppress', s.suppress || 'visible', [['visible', 'そのタブを見ている'], ['focused', 'このウィンドウを使っている'], ['never', 'いつも鳴らす']], (v) => setN({ suppress: v }))),
          checkRow('desktop', s.desktop !== false, 'デスクトップ通知', 'OS の通知を出します', (v) => setN({ desktop: v })),
        );
      },
    },
    {
      id: 'handoff',
      title: '引き継ぎ',
      order: 60,
      render(box) {
        const H = window.Handoff;
        if (!H) {
          box.append(h('div', 'st-empty', '—'));
          return;
        }
        const hs = safe(() => H.settings(), {}) || {};
        const set = (patch) => {
          safe(() => H.setSettings(patch));
          render();
        };
        box.append(
          row('満杯に近いとき', select('mode', hs.mode, [['confirm', '確認してから'], ['auto', '自動で'], ['notify', '知らせるだけ'], ['off', '何もしない']], (v) => set({ mode: v })), 'コンテキストが満杯に近づいたときに、新しいセッションへ引き継ぐかどうか'),
          row('しきい値', [num('threshold', hs.threshold, { min: 1, max: 99, width: '4em' }, (v) => set({ threshold: v })), '%'], 'コンテキストがこれを超えてターンが終わったときに引き継ぎます'),
          row('重いセッション', [num('memMb', hs.memMb, { min: 100, max: 32000, step: 100, width: '5.5em' }, (v) => {
            safe(() => H.setSettings({ memMb: v }));
            document.dispatchEvent(new CustomEvent('bantodesk:mem-threshold'));
            render();
          }), 'MB'], 'メモリがこれを超えたセッションを目立たせます（右クリック →「再起動」で軽くできます）'),
          checkRow('pmoAuto', hs.pmoAuto, 'PMO を自動で引き継ぐ', 'PMO のコンテキストかメモリが下の値を超えたら、ターンの合間に自動で新しいセッションへ引き継ぎます（1 時間に 1 回まで）', (v) => set({ pmoAuto: v })),
          row('PMO のしきい値', [
            num('pmoPct', hs.pmoPct, { min: 1, max: 99, width: '4em' }, (v) => set({ pmoPct: v })),
            '% か',
            num('pmoMemMb', hs.pmoMemMb, { min: 50, max: 32000, step: 50, width: '5.5em' }, (v) => set({ pmoMemMb: v })),
            'MB',
          ], 'コンテキストの % か、メモリの MB のどちらかを超えたら'),
        );
      },
    },
    {
      id: 'phone',
      title: W.phone || 'スマホ',
      order: 65,
      // UX5: the ON / OFF switch of remote (phone) access, URLs / QR and token while ON (remote-ui.js draws the parts)
      render(box) {
        const R = window.RemoteUI;
        if (!R || typeof R.renderSettings !== 'function') {
          box.append(h('div', 'st-empty', '—'));
          return;
        }
        R.renderSettings(box);
      },
    },
    {
      id: 'power',
      title: '電源・表示',
      order: 70,
      render(box) {
        const s = ns();
        box.append(checkRow('preventSleep', s.preventSleep !== false, 'スリープさせない', 'セッションの実行中は PC をスリープさせません', (v) => setN({ preventSleep: v })));
        // how sleep is avoided (52c, src/main/keepawake.js BLOCKER_OF): default 'display' on Windows, 'system' elsewhere
        const win = /Windows/i.test(navigator.userAgent || '');
        const defMode = win ? 'display' : 'system';
        const mode = s.sleepMode === 'display' || s.sleepMode === 'system' ? s.sleepMode : defMode;
        // UX4 (mac-polish M4): the Windows words only on Windows; the lid row below is Windows only (keepawake.js changes
        // the Windows lid action; elsewhere it never can)
        const modeTip = win
          ? '会議のアプリと同じ: Teams などの会議中と同じく〈画面を消さない〉要求を出します。会社の PC でスリープを止める要求が効かないときも効きます。実行中は画面が消えず、一定時間で自動でかかる画面のロックやスクリーン セーバーも、会議中と同じく起きなくなります（Windows キー + L の手のロックはいつでも使えます）。'
            + ' システムだけ: 画面は消えてよく、PC だけを起こしておく要求です（前からの方法）。Windows の会社の PC ではポリシーで効かないことがあります。'
            + ' どちらも、ふたを閉じたときのスリープは止めません（会議のアプリと同じ。下の設定を見てください）'
          : '会議のアプリと同じ: 会議中と同じく〈画面を消さない〉要求を出します。実行中は画面が消えず、自動の画面のロックやスクリーン セーバーも起きなくなります（⌃⌘Q の手のロックはいつでも使えます）。'
            + ' システムだけ: 画面は消えてよく、PC だけを起こしておく要求です（前からの方法）。'
            + ' どちらも、ふたを閉じたときのスリープは止めません（会議のアプリと同じ）';
        const modeRow = row('スリープを避ける方法', [
          select('sleepMode', mode, [
            ['display', `会議のアプリと同じ（画面を消さない）${defMode === 'display' ? '・既定' : ''}`, '実行中は画面が消えません。自動の画面のロックも会議中と同じく起きません'],
            ['system', `システムだけ（画面は消える）${defMode === 'system' ? '・既定' : ''}`, '前からの方法'],
          ], (v) => setN({ sleepMode: v })),
        ], modeTip);
        modeRow.dataset.role = 'sleep-mode';
        box.append(modeRow);
        // the lid close action (AC power only) while work runs, put back afterwards (src/main/keepawake.js, docs/keep-awake.md)
        const lid = checkRow('lidNoSleep', s.lidNoSleep !== false, 'ふたを閉じてもスリープしない', 'AC 電源のときだけ。実行中だけ Windows の「カバーを閉じたときの操作」を「何もしない」にし、終わったら戻します。組織のポリシーで変えられないときは、ふたを閉じるとスリープします（会議のアプリも同じ）。そのときは、ふたを開けたまま、または外部ディスプレイにつないで使ってください', (v) => setN({ lidNoSleep: v }));
        lid.dataset.role = 'lid-no-sleep';
        const lidNote = note('nt-lid-note');
        lid.append(lidNote);
        if (win) box.append(lid);
        Promise.resolve(safe(() => window.api?.powerState?.(), null))
          .then((st) => {
            const l = (st && st.lid) || {};
            const why = String(l.reason || l.note || '');
            // not changed (policy / refused / unreadable): closing the lid sleeps, as with a meeting app (52c)
            const sleeps = why && (l.state === 'blocked' || (l.state === 'off' && !/開発版・テスト|Windows のときだけ/.test(why)));
            const full = l.state === 'held' ? '今は「何もしない」にしています（終わったら元に戻します）' : l.state === 'already' ? 'もともと「何もしない」になっています' : sleeps ? `${why}。ふたを閉じるとスリープします（会議のアプリと同じ）` : why;
            lidNote.textContent = l.state === 'held' ? '今は「何もしない」' : l.state === 'already' ? 'もともと「何もしない」' : sleeps ? '変えられません（ふたを閉じるとスリープ）' : full.length > 24 ? full.slice(0, 24) + '…' : full;
            lidNote.title = full;
          })
          .catch(() => {});
        // PROGRESS 32: --disable-gpu (main reads <userData>/app-settings.json before 'ready': takes effect on the next start)
        const gpuNote = note('nt-gpu-note');
        let gpu = null;
        const show = (st) => {
          if (!gpu) return;
          if (!st || st.error) {
            gpuNote.textContent = st && st.error ? '保存できませんでした' : '';
            return;
          }
          gpu.checked = st.disableGpu === true;
          gpu.disabled = false;
          const now = !!(st.atStart && st.atStart.disableGpu);
          gpuNote.textContent = now !== (st.disableGpu === true) ? '再起動で反映' : now ? '今は使っていません' : '';
          gpuNote.title = now !== (st.disableGpu === true) ? 'アプリを再起動すると反映されます' : '';
        };
        const gpuRow = checkRow('disableGpu', false, 'GPU を使わない', '画面の乱れやドライバーの不調があるときに。次の起動から反映されます', (v) => {
          Promise.resolve(safe(() => window.api?.setAppSettings?.({ disableGpu: v }), null)).then(show).catch(() => {});
        });
        gpuRow.dataset.role = 'disable-gpu';
        gpu = gpuRow.querySelector('input');
        gpu.disabled = true;
        gpuRow.append(gpuNote);
        box.append(gpuRow);
        Promise.resolve(safe(() => window.api?.appSettings?.(), null)).then(show).catch(() => {});
      },
    },
    {
      // UA1 + UA2 (docs/usage-analytics.md §2.6・§3.1): 使い方の記録 ON / OFF・全部消す, the summary of 7 / 30 / all days
      // (src/main/usage-report.js summarize through api.usage.summary) and 集計を書き出す (the manager folder's
      // .bantodesk/usage/). Only ids and numbers come back; the tables show the ids as they are.
      id: 'usage',
      title: '使い方',
      order: 75,
      render(box) {
        // UA1 (docs/usage-analytics.md §2.6): 使い方の記録 ON / OFF and 全部消す. The records stay on this PC
        // (<userData>/usage/); main keeps only the listed ids, never text / names / paths.
        const useNote = note('nt-usage-note');
        const useRow = checkRow('usageRecord', false, '使い方の記録', 'どの画面・ボタンをどれだけ使ったかの数だけを、この PC のアプリのデータに残します（外へは送りません。文・名前・パスは入れません）。設計の見直しに使います', (v) => {
          Promise.resolve(safe(() => window.api?.usage?.set?.({ enabled: v }), null))
            .then((st) => {
              useNote.textContent = st ? (st.enabled ? '記録しています' : '止めています') : '保存できませんでした';
            })
            .catch(() => {});
        });
        useRow.dataset.role = 'usage-record';
        const useBox = useRow.querySelector('input');
        useBox.disabled = true;
        const wipe = h('button', 'st-btn', '全部消す');
        wipe.type = 'button';
        wipe.dataset.role = 'usage-clear';
        wipe.title = '使い方の記録をすべて消します（ON / OFF はそのまま）';
        wipe.addEventListener('click', () => {
          wipe.disabled = true;
          Promise.resolve(safe(() => window.api?.usage?.clear?.(), null))
            .then((r) => {
              useNote.textContent = r && r.cleared ? '消しました' : '消せませんでした';
              refreshUsage();
            })
            .catch(() => {})
            .finally(() => (wipe.disabled = false));
        });
        useRow.append(wipe, useNote);
        box.append(useRow);
        Promise.resolve(safe(() => window.api?.usage?.get?.(), null))
          .then((st) => {
            if (!st) return;
            useBox.checked = st.enabled === true;
            useBox.disabled = false;
          })
          .catch(() => {});
        const refreshUsage = renderUsage(box);
      },
    },
  ];

  // ---- UA2: the 使い方 tables (docs/usage-analytics.md §3.1) ------------------------------------------------------
  const USAGE_STATE = { permission: '許可', question: '質問', error: 'エラー', stuck: '黙った', failed: '失敗', done: '完了の後', working: '動いている', idle: '何もしていない', '-': '不明' };
  const USAGE_DID = { answer: '答えた', send: '送った', restart: '再起動', handoff: '引き継ぎ', terminal: 'ターミナル', none: '何もしない' };
  const USAGE_AUTO = { answer: '答える（後押し）', restart: '再起動', handoff: '引き継ぎ', nudge: '声かけ' };
  const usageSec = (n) => (n === null || n === undefined ? '—' : n >= 3600 ? `${Math.round(n / 360) / 10} 時間` : n >= 60 ? `${Math.round(n / 6) / 10} 分` : `${n} 秒`);
  function usageTable(role, head, rows) {
    const tb = h('table', 'st-utable');
    tb.dataset.role = role;
    const tr = h('tr');
    for (const x of head) tr.append(h('th', null, x));
    tb.append(tr);
    for (const r of rows) {
      const row = h('tr');
      for (const x of r) row.append(h('td', null, String(x)));
      tb.append(row);
    }
    if (!rows.length) {
      const row = h('tr');
      const td = h('td', 'st-empty', 'まだ記録がありません');
      td.colSpan = head.length;
      row.append(td);
      tb.append(row);
    }
    return tb;
  }
  // -> refresh(): draws the period switch, the tables and 集計を書き出す into box
  function renderUsage(box) {
    let period = 30;
    const wrap = h('div', 'st-usage');
    wrap.dataset.role = 'usage-summary';
    const bar = h('div', 'st-row');
    const seg = h('span', 'st-ctl');
    for (const [p, label] of [[7, '7 日'], [30, '30 日'], ['all', '全部']]) {
      const b = h('button', 'st-btn st-useg', label);
      b.type = 'button';
      b.dataset.role = 'usage-period';
      b.dataset.period = String(p);
      b.addEventListener('click', () => {
        period = p;
        refresh();
      });
      seg.append(b);
    }
    bar.append(h('span', 'st-label', '期間'), seg);
    const out = h('div', 'st-usage-body');
    // 集計を書き出す + 自動で書き出す (weekly, the first start on or after Monday)
    const exRow = h('div', 'st-row');
    const exNote = note('nt-usage-export');
    exNote.dataset.role = 'usage-export-note';
    const ex = h('button', 'st-btn', '集計を書き出す');
    ex.type = 'button';
    ex.dataset.role = 'usage-export';
    ex.title = '直近 30 日の集計を、管理フォルダの .bantodesk/usage/ に Markdown と JSON で書きます（id と数だけ。最新の 8 つを残します）。PMO や設計の作業が読みます';
    ex.addEventListener('click', () => {
      ex.disabled = true;
      Promise.resolve(safe(() => window.api?.usage?.exportReport?.(), null))
        .then((r) => {
          exNote.textContent = r && r.written ? `書き出しました（report-${r.day}）` : r && r.error === 'no manager folder' ? '管理フォルダがありません' : '書き出せませんでした';
        })
        .catch(() => {})
        .finally(() => (ex.disabled = false));
    });
    const autoRow = checkRow('usageAutoReport', true, '週に 1 回自動で書き出す', '月曜（その週の最初の起動）に、直近 30 日の集計を同じ場所に書きます。記録が OFF の間は書きません', (v) => {
      Promise.resolve(safe(() => window.api?.usage?.set?.({ autoReport: v }), null)).catch(() => {});
    });
    autoRow.dataset.role = 'usage-auto-report';
    const autoBox = autoRow.querySelector('input');
    autoBox.disabled = true;
    exRow.append(h('span', 'st-label', '書き出し'), h('span', 'st-ctl'));
    exRow.lastChild.append(ex, exNote);
    wrap.append(bar, out, exRow, autoRow);
    box.append(wrap);
    Promise.resolve(safe(() => window.api?.usage?.get?.(), null))
      .then((st) => {
        if (!st) return;
        autoBox.checked = st.autoReport !== false;
        autoBox.disabled = false;
      })
      .catch(() => {});

    function draw(s) {
      out.replaceChildren();
      if (!s || s.error) {
        out.append(h('div', 'st-empty', '集計を読めませんでした'));
        return;
      }
      out.append(h('div', 'st-note st-usage-range', `${s.from} 〜 ${s.to}（記録のある日 ${s.daysWithRecords} 日）`));
      out.append(h('h4', 'st-usub', '画面の時間の割合'));
      const screens = usageTable('usage-screens', ['画面', '時間', '割合'], s.screens.map((r) => [r.id, usageSec(r.sec), `${r.share}%`]));
      for (const [i, r] of s.screens.entries()) {
        const bar = h('span', 'st-ubar');
        bar.style.width = `${Math.max(2, Math.round(r.share * 0.8))}px`; // px: a % of the cell pushed the number out
        screens.rows[i + 1].cells[2].prepend(bar);
      }
      out.append(screens);
      out.append(h('h4', 'st-usub', '機能ごとの回数'));
      out.append(usageTable('usage-features', ['機能', '回数', '最後に使った日'], s.features.map((r) => [r.id, r.n, r.last])));
      out.append(h('h4', 'st-usub', '使われていない機能'));
      const un = h('div', 'st-uunused');
      un.dataset.role = 'usage-unused';
      if (!s.unused.judged) {
        un.dataset.judged = 'no';
        un.textContent = `まだ判断しない（記録が ${s.unused.minDays} 日に満たない: ${s.recordedDays} 日）`;
      } else {
        un.dataset.judged = 'yes';
        un.textContent = s.unused.ids.length ? '' : 'なし';
        for (const id of s.unused.ids) un.append(h('span', 'st-uchip', id));
      }
      out.append(un);
      const op = s.opens;
      out.append(h('h4', 'st-usub', 'セッションを開いた理由'));
      const lead = h('div', 'st-note st-uopen-lead', `開いた ${op.n} 回・問題で開いた割合 ${op.problemShare}%・開いていた時間の中央値 ${usageSec(op.sec.median)}`);
      lead.dataset.role = 'usage-open-lead';
      out.append(lead);
      const cols = Object.keys(USAGE_STATE).filter((st) => op.rows.some((r) => r.states[st]));
      out.append(usageTable('usage-opens', ['入口', '計', ...cols.map((st) => USAGE_STATE[st])], op.rows.map((r) => [`open.from.${r.from}`, r.n, ...cols.map((st) => r.states[st] || 0)])));
      const didT = usageTable('usage-did', ['開いて何をしたか', '回数'], Object.keys(USAGE_DID).map((k) => [USAGE_DID[k], op.did[k] || 0]));
      out.append(didT);
      out.append(h('h4', 'st-usub', '代わりにしてくれたこと'));
      out.append(usageTable('usage-auto', ['操作', 'アプリ・PMO', '手', 'アプリの割合'], s.auto.map((r) => [USAGE_AUTO[r.kind] || r.kind, r.auto, r.hand, `${r.autoShare}%`])));
    }
    function refresh() {
      for (const b of seg.children) b.classList.toggle('on', b.dataset.period === String(period));
      out.dataset.period = String(period);
      Promise.resolve(safe(() => window.api?.usage?.summary?.(period), null))
        .then((s) => {
          if (out.dataset.period === String(period)) draw(s);
        })
        .catch(() => draw(null));
    }
    refresh();
    return refresh;
  }

  // the built-in and registered sections together, by order (UX5: 作業とモデル (12) is second from the top)
  function sections() {
    return BUILTIN.concat([...extra.values()]).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  }

  // ---- the modal ------------------------------------------------------------------
  function onKey(e) {
    if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function build() {
    const box = h('div', 'st-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', W.settings || '設定');
    const head = h('div', 'st-head');
    const x = h('button', 'st-close', '×');
    x.type = 'button';
    x.title = '閉じる（Esc）';
    x.dataset.role = 'settings-close';
    x.addEventListener('click', close);
    head.append(h('span', 'st-title', W.settings || '設定'), x);
    const nav = h('nav', 'st-nav');
    const body = h('div', 'st-body');
    for (const sec of sections()) {
      const el = h('section', 'st-sec');
      el.dataset.section = sec.id;
      el.append(h('h3', 'st-sec-title', sec.title));
      const inner = h('div', 'st-sec-body');
      safe(() => sec.render(inner));
      el.append(inner);
      body.append(el);
      const link = h('button', 'st-nav-item', sec.title);
      link.type = 'button';
      link.dataset.nav = sec.id;
      link.addEventListener('click', () => scrollTo(sec.id));
      nav.append(link);
    }
    const main = h('div', 'st-main');
    main.append(nav, body);
    box.append(head, main);
    return box;
  }

  function scrollTo(id) {
    if (!root || !id) return;
    lastSection = id;
    const el = root.querySelector(`.st-sec[data-section="${CSS.escape(id)}"]`);
    if (el) safe(() => el.scrollIntoView({ block: 'start' }));
    for (const b of root.querySelectorAll('.st-nav-item')) b.classList.toggle('on', b.dataset.nav === id);
  }

  function isOpen() {
    return !!(root && root.isConnected);
  }

  function open(sectionId) {
    if (!isOpen()) {
      root = h('div', 'st-modal');
      root.dataset.role = 'settings';
      root.addEventListener('mousedown', (e) => {
        if (e.target === root) close();
      });
      root.append(build());
      (document.getElementById('overlay-root') || document.body).append(root);
      document.addEventListener('keydown', onKey, true);
    }
    if (sectionId) scrollTo(sectionId);
    if (!root.contains(document.activeElement)) safe(() => root.querySelector('.st-close').focus());
  }

  function close() {
    document.removeEventListener('keydown', onKey, true);
    if (root) root.remove();
    root = null;
  }

  // redraw the values in place (keeps the scroll position); no-op while closed
  function render() {
    if (!isOpen()) return;
    const body = root.querySelector('.st-body');
    const top = body ? body.scrollTop : 0;
    const focused = document.activeElement && root.contains(document.activeElement) ? document.activeElement.dataset?.setting : null;
    root.replaceChildren(build());
    const nb = root.querySelector('.st-body');
    if (nb) nb.scrollTop = top;
    if (lastSection) for (const b of root.querySelectorAll('.st-nav-item')) b.classList.toggle('on', b.dataset.nav === lastSection);
    if (focused) safe(() => root.querySelector(`[data-setting="${CSS.escape(focused)}"]`)?.focus());
  }

  function register(sec) {
    if (!sec || typeof sec.id !== 'string' || !sec.id || typeof sec.render !== 'function') return;
    extra.set(sec.id, { id: sec.id, title: String(sec.title || sec.id), order: Number(sec.order) || 0, render: sec.render });
    render();
  }

  window.Settings = { open, close, isOpen, render, register };
})();
