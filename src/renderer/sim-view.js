// IOS-SIM (docs/plan-ios-sim.md 6.1): the iOS Simulator pane. Drawing and the top bar; main (src/main/simview.js) takes
// the pictures. The shell (open / close / layout / seen) is external-view.js. Latest picture only: a picture that arrives
// while one is being decoded replaces the waiting one.
(() => {
  const api = window.api;
  if (!api || !window.ExternalView) return;
  const DEVICE_KEY = 'simDevice';
  const instances = new Map(); // panel id -> { frame(f), state(s) }
  api.onSimFrame?.((f) => f && instances.get(f.id)?.frame(f));
  api.onSimState?.((s) => s && instances.get(s.id)?.state(s));

  const lsGet = () => {
    try {
      return localStorage.getItem(DEVICE_KEY) || '';
    } catch {
      return '';
    }
  };
  const lsSet = (v) => {
    try {
      localStorage.setItem(DEVICE_KEY, v);
    } catch {}
  };

  function create({ id, shell }) {
    const { h } = shell;
    const bar = shell.bar();
    const el = h('div', 'ev-view');
    const body = h('div', 'sim-body');
    const canvas = h('canvas', 'sim-canvas');
    const over = h('div', 'sim-over');
    over.hidden = true;
    body.append(canvas, over);
    el.append(bar.el, body);
    const g = canvas.getContext('2d');

    const select = h('select', 'ev-select');
    select.title = '映す端末';
    const refresh = bar.button('↻', '端末の一覧を読み直す', () => load());
    const pauseBtn = bar.button('⏸', '映すのを止める / 続ける', () => setPaused(!paused));
    pauseBtn.setAttribute('aria-pressed', 'false');
    const bootBtn = bar.button('端末を止める', '選んだ端末を止める（シミュレータの電源を切る）', () => stopDevice());
    const openBtn = bar.button('Simulator で開く', '本物の Simulator の窓で開く（触るときはこちら）', () => openApp());
    const shotBtn = bar.button('スクショを渡す', '今の絵を保存して、入力欄にパスを差し込む', () => shot());
    bar.left.append(select, refresh);
    bar.right.append(pauseBtn, bootBtn, openBtn, shotBtn);

    let devices = [];
    let udid = lsGet();
    let paused = false;
    let seen = false;
    let attached = '';
    let disposed = false;
    let busy = false;
    let haveFrame = false;
    let pending = null;
    let drawing = false;
    let nFrames = 0;

    const dev = () => devices.find((d) => d.udid === udid) || null;
    const message = (html, btn) => {
      over.replaceChildren();
      if (html) over.append(h('div', '', html));
      if (btn) over.append(btn);
      over.hidden = !html;
    };

    function render() {
      select.replaceChildren();
      if (!devices.length) select.append(new Option('端末がありません', ''));
      for (const d of devices) select.append(new Option(`${d.state === 'Booted' ? '● ' : ''}${d.name}（${d.runtime}）`, d.udid));
      if (dev()) select.value = udid;
      const d = dev();
      bootBtn.hidden = !d || d.state !== 'Booted';
      shotBtn.disabled = !haveFrame;
      openBtn.disabled = !d || d.state !== 'Booted';
      if (!d) {
        bar.setStatus('');
        message(devices.length ? '映す端末を選んでください' : 'シミュレータの端末が見つかりません（Xcode の設定で端末を作ります）');
      } else if (d.state === 'Booted') {
        if (!haveFrame) message('画面を待っています…');
        bar.setStatus(paused ? '止めています' : '');
      } else if (d.state === 'Shutdown') {
        haveFrame = false;
        const b = bar.button('起動する（画面は出しません）', '', () => startDevice());
        b.disabled = busy;
        message('この端末は止まっています', b);
        bar.setStatus('止まっています');
      } else {
        message(`${d.state === 'Booting' ? '起動しています…' : d.state}`);
        bar.setStatus(d.state);
      }
    }

    async function load() {
      const r = await api.simList().catch(() => null);
      if (disposed) return;
      if (!r || !r.ok) {
        devices = [];
        message('シミュレータを使えません（Xcode が要ります）');
        return;
      }
      devices = r.devices;
      if (!dev()) udid = (devices.find((d) => d.state === 'Booted') || {}).udid || '';
      render();
      sync();
    }

    // follow the device: attach when it is Booted and the pane is seen, detach otherwise
    let syncing = false;
    let again = false;
    async function sync() {
      if (syncing) { again = true; return; } // one attach at a time
      syncing = true;
      try {
        do {
          again = false;
          await syncOnce();
        } while (again && !disposed);
      } finally {
        syncing = false;
      }
    }
    async function syncOnce() {
      const d = dev();
      const want = d && d.state === 'Booted' ? d.udid : '';
      if (want === attached) return;
      if (attached) api.simDetach({ id });
      attached = '';
      haveFrame = false;
      if (!want) return;
      const r = await api.simAttach({ id, udid: want, visible: seen, paused }).catch(() => null);
      if (disposed) return api.simDetach({ id });
      if (r && r.ok) {
        attached = want;
      } else if (r && r.reason === 'notbooted') {
        load();
      } else {
        bar.setStatus('映せません');
      }
    }

    async function startDevice() {
      busy = true;
      render();
      const r = await api.simBoot({ udid }).catch(() => null);
      let tries = 0;
      // boot may outlast simctl's 10 s limit: look again a few times
      while (!disposed && tries++ < 8) {
        await load();
        if (dev()?.state === 'Booted') break;
        if (r && !r.ok && !r.timedOut) break;
        await new Promise((res) => setTimeout(res, 2500));
      }
      busy = false;
      render();
    }
    async function stopDevice() {
      const d = dev();
      if (!d || d.state !== 'Booted') return;
      attached = '';
      busy = true;
      await api.simShutdown({ udid: d.udid }).catch(() => null);
      busy = false;
      haveFrame = false;
      load();
    }
    async function openApp() {
      if (!udid) return;
      await api.simOpenApp({ udid, id }).catch(() => null);
    }
    async function shot() {
      const r = await api.simSave({ id }).catch(() => null);
      if (!r || !r.ok) return bar.setStatus(r?.reason === 'nofolder' ? '作業フォルダがありません' : '渡せませんでした');
      const ok = shell.handPath(r.path);
      bar.setStatus(ok ? 'パスを入力欄に入れました' : `保存しました: ${r.path}`);
    }
    function setPaused(v) {
      paused = !!v;
      pauseBtn.textContent = paused ? '▶' : '⏸';
      pauseBtn.setAttribute('aria-pressed', String(paused));
      api.simPaused({ id, paused });
      render();
    }

    async function draw(f) {
      drawing = true;
      try {
        const bmp = await createImageBitmap(new Blob([f.jpeg], { type: 'image/jpeg' }));
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        g.drawImage(bmp, 0, 0);
        bmp.close();
        nFrames++;
        canvas.dataset.frames = String(nFrames);
        canvas.dataset.drawnAt = String(Date.now());
        if (!haveFrame) {
          haveFrame = true;
          message('');
          render();
        }
      } catch {}
      drawing = false;
      if (pending) {
        const p = pending;
        pending = null;
        draw(p);
      }
    }

    instances.set(id, {
      frame: (f) => (drawing ? (pending = f) : draw(f)),
      state: (s) => {
        if (s.error) bar.setStatus('画面を撮れません（端末を確かめてください）');
      },
    });
    canvas.addEventListener('mousedown', () => api.simActivity({ id }));
    select.addEventListener('change', () => {
      udid = select.value;
      lsSet(udid);
      render();
      sync();
    });
    render();
    load();

    return {
      el,
      setVisible: (v) => {
        const was = seen;
        seen = !!v;
        if (seen === was) return;
        api.simVisible({ id, visible: seen });
        if (seen) load(); // devices may have changed while it was away
      },
      dispose: () => {
        disposed = true;
        instances.delete(id);
        api.simDetach({ id });
      },
      _state: () => ({ udid, attached, frames: nFrames, haveFrame }),
    };
  }

  window.ExternalView.register('sim', create, 'iOS シミュレータ');
  window.SimView = { create };
})();
