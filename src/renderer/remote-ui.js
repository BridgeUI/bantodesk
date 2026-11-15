/* RemoteUI (owner: remote) — #remote-btn pill and its popover (enable, URLs, QR, token regen), and the same parts as
   the settings modal's 「スマホ」 section (UX5: the ON/OFF switch lives in 設定 > スマホ). */
(function () {
  'use strict';

  var ICON =
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="4.5" y="1.75" width="7" height="12.5" rx="1.5"/><path d="M7.25 11.75h1.5"/></svg>';

  var status = { enabled: false, port: null, urls: [], qrDataUrl: null, error: null };
  var btn = null, pop = null, busy = false;
  var secHost = null; // the container of 設定 > スマホ (settings.js 'phone' section; last render)
  var SEC_ID = 'phone'; // settings.js section id

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function renderBtn() {
    if (!btn) return;
    btn.classList.toggle('rmt-on', !!status.enabled);
    btn.classList.toggle('rmt-err', !status.enabled && !!status.error);
    btn.querySelector('.rmt-state').textContent = status.enabled ? 'ON' : 'OFF';
    btn.title = status.enabled
      ? 'リモート ON（ポート ' + status.port + '）。押すと URL と QR を表示'
      : 'リモート（スマホから）';
  }

  function copy(text, el) {
    var done = function () {
      if (!el) return;
      var old = el.textContent;
      el.textContent = 'コピーしました';
      setTimeout(function () { el.textContent = old; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
  }

  // the popover and the settings section draw the same parts; redraw both
  function renderPop() {
    if (pop) fill(pop, false);
    if (secHost && secHost.isConnected) fill(secHost, true);
  }

  function fill(pop, inSettings) {
    pop.textContent = '';

    var head = h('div', 'rmt-head');
    head.appendChild(h('div', 'rmt-title', inSettings ? 'スマホから操作する' : 'リモートアクセス（LAN）'));
    var sw = h('label', 'rmt-switch');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!status.enabled;
    cb.disabled = busy;
    cb.dataset.role = 'remote-switch';
    cb.addEventListener('change', function () { setEnabled(cb.checked); });
    sw.appendChild(cb);
    sw.appendChild(h('span', 'rmt-slider'));
    head.appendChild(sw);
    pop.appendChild(head);

    pop.appendChild(h('div', 'rmt-desc',
      'スマホなど同じネットワーク上のブラウザから、全ウィンドウのエージェントの状態確認・回答・テキスト送信ができます。'));

    if (status.error) pop.appendChild(h('div', 'rmt-error', status.error));
    if (busy) pop.appendChild(h('div', 'rmt-muted', '処理中…'));

    if (status.enabled) {
      if (status.qrDataUrl) {
        var qrWrap = h('div', 'rmt-qr');
        var img = document.createElement('img');
        img.src = status.qrDataUrl;
        img.alt = 'QR コード';
        img.width = 180;
        img.height = 180;
        qrWrap.appendChild(img);
        qrWrap.appendChild(h('div', 'rmt-muted', 'スマホのカメラで読み取ってください'));
        pop.appendChild(qrWrap);
      }
      var list = h('div', 'rmt-urls');
      (status.urls || []).forEach(function (u) {
        var row = h('div', 'rmt-url');
        var code = h('input', 'rmt-url-text');
        code.readOnly = true;
        code.value = u;
        code.addEventListener('focus', function () { code.select(); });
        var cbtn = h('button', 'rmt-btn small', 'コピー');
        cbtn.type = 'button';
        cbtn.addEventListener('click', function () { copy(u, cbtn); });
        row.appendChild(code);
        row.appendChild(cbtn);
        list.appendChild(row);
      });
      pop.appendChild(list);
    }

    var actions = h('div', 'rmt-actions');
    var regen = h('button', 'rmt-btn', 'トークン再生成');
    regen.type = 'button';
    regen.disabled = busy;
    regen.title = '現在の URL を無効にし、接続中の端末を切断します';
    regen.addEventListener('click', function () {
      if (!confirm('トークンを再生成しますか？\n現在の URL / QR コードは使えなくなり、接続中の端末は切断されます。')) return;
      run(window.api.remoteRegenToken());
    });
    actions.appendChild(regen);
    if (status.port) actions.appendChild(h('span', 'rmt-muted', 'ポート ' + status.port));
    pop.appendChild(actions);

    var warn = h('div', 'rmt-warn');
    warn.appendChild(h('div', null,
      '⚠ この URL を知っている人は、同じネットワークからエージェントを操作できます。通信は暗号化されない HTTP です。自宅など信頼できるネットワークでのみ使用し、不要なときは OFF にしてください。'));
    // UX4 (mac-polish M4): the firewall note is about Windows only
    if (/Windows/i.test(navigator.userAgent || '')) warn.appendChild(h('div', null,
      '初めて ON にしたとき、Windows ファイアウォールがアクセス許可を求めることがあります（プライベートネットワークを許可してください）。'));
    pop.appendChild(warn);
  }

  function run(promise) {
    busy = true;
    renderPop();
    return Promise.resolve(promise).then(function (st) {
      if (st) status = st;
    }, function (e) {
      status = Object.assign({}, status, { error: String((e && e.message) || e) });
    }).then(function () {
      busy = false;
      renderBtn();
      renderPop();
    });
  }

  function setEnabled(on) { run(window.api.remoteSetEnabled(!!on)); }

  function open() {
    if (pop) return;
    pop = h('div', 'rmt-pop');
    pop.setAttribute('role', 'dialog');
    var root = document.getElementById('overlay-root') || document.body;
    root.appendChild(pop);
    position();
    renderPop();
    window.api.remoteGetStatus().then(function (st) { if (st) { status = st; renderBtn(); renderPop(); } }, function () {});
    setTimeout(function () {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', position);
    }, 0);
  }
  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', position);
  }
  function position() {
    if (!pop || !btn) return;
    var r = btn.getBoundingClientRect();
    pop.style.top = Math.round(r.bottom + 6) + 'px';
    pop.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
  }
  function onDocDown(e) {
    if (pop && !pop.contains(e.target) && !btn.contains(e.target)) close();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }

  // 設定 > スマホ (settings.js's 'phone' section calls this): the switch, URLs / QR and token while ON (UX5)
  function renderSettings(container) {
    secHost = container;
    fill(container, true);
    if (window.api && window.api.remoteGetStatus) {
      window.api.remoteGetStatus().then(function (st) { if (st) { status = st; renderBtn(); if (!busy) renderPop(); } }, function () {});
    }
  }

  function init() {
    if (!window.api) return;
    btn = document.getElementById('remote-btn');
    if (btn) {
      btn.classList.add('rmt-pill');
      btn.innerHTML = ICON + '<span>Remote</span><span class="rmt-state">OFF</span>';
      btn.addEventListener('click', function () { if (pop) close(); else open(); });
    }
    if (window.api.onRemoteStatus) {
      window.api.onRemoteStatus(function (st) {
        if (!st) return;
        status = st;
        renderBtn();
        if (!busy) renderPop();
      });
    }
    window.api.remoteGetStatus().then(function (st) { if (st) { status = st; renderBtn(); } }, function () {});
    renderBtn();
  }

  window.RemoteUI = { init: init, renderSettings: renderSettings, open: function () { if (window.Settings && window.Settings.open) window.Settings.open(SEC_ID); } };
})();
