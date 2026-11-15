'use strict';
// Notification earcons synthesized with WebAudio (no asset files; the page's CSP allows media-src blob:). docs/plan-notify.md.
// Two styles (settings: notifySettings.style):
//   subtle (default) – soft sines, short, almost no pitch movement; fit for client offices.
//     done: one soft bell tone / input: two gentle taps / error: one low muted tone, slight bend down
//   clear – the first, more distinctive set: done rising triad / input questioning 4th twice /
//     error low falling tritone (filtered square and saw timbres)
// window.Sounds: play(kind, volume, style), preview(kind, volume, style), warm(), ready(), state()
//
// How it sounds (docs/perf.md 第 3 段): the same graph is rendered once per (style, kind, volume) in an
// OfflineAudioContext (no audio device; the rendering runs off the window's thread), kept as a WAV blob: URL and
// played with an <audio> element. Before, `new AudioContext()` opened the audio device synchronously and held the
// window 1-5.6 s (even when made ahead at an idle moment). Fallback when that path fails: the old live AudioContext.
(() => {
  let ctx = null; // live AudioContext, only for the fallback
  let master = null; // the gain node the notes go into while a graph is being built (live or offline)

  function clampVol(volume) {
    return Math.max(0, Math.min(1, volume ?? 0.6));
  }

  // master gain -> compressor -> dest; returns the master gain
  function chain(c, dest, volume) {
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    const g = c.createGain();
    g.connect(comp);
    comp.connect(dest);
    g.gain.value = clampVol(volume);
    return g;
  }

  function audio(volume) {
    if (!ctx) {
      ctx = new AudioContext();
      master = chain(ctx, ctx.destination, volume);
      ctx.__master = master;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    master = ctx.__master;
    master.gain.value = clampVol(volume);
    return ctx;
  }

  // ---- pre-rendered WAV (the normal path)
  const RATE = 44100;
  const LEN_S = 0.9; // the longest earcon ends at ~0.62 s
  const MAX_CACHED = 24;
  const wavs = new Map(); // key -> Promise<url>
  let wavFailed = false;
  let lastWav = 0; // performance.now() of the last WAV made (perf check)

  function wavKey(style, kind, volume) {
    return `${style}|${kind}|${Math.round(clampVol(volume) * 100)}`;
  }

  // 16-bit PCM WAV from an AudioBuffer
  function encodeWav(buf) {
    const ch = buf.numberOfChannels;
    const n = buf.length;
    const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF');
    out.setUint32(4, 36 + n * ch * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    out.setUint32(16, 16, true);
    out.setUint16(20, 1, true);
    out.setUint16(22, ch, true);
    out.setUint32(24, buf.sampleRate, true);
    out.setUint32(28, buf.sampleRate * ch * 2, true);
    out.setUint16(32, ch * 2, true);
    out.setUint16(34, 16, true);
    str(36, 'data');
    out.setUint32(40, n * ch * 2, true);
    const data = [];
    for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        const v = Math.max(-1, Math.min(1, data[c][i]));
        out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([out.buffer], { type: 'audio/wav' });
  }

  function makeWav(style, kind, volume) {
    const key = wavKey(style, kind, volume);
    let p = wavs.get(key);
    if (p) {
      wavs.delete(key); // keep the most recent at the end
      wavs.set(key, p);
      return p;
    }
    const fn = (STYLES[style] || SUBTLE)[kind];
    const c = new OfflineAudioContext(2, Math.ceil(RATE * LEN_S), RATE);
    master = chain(c, c.destination, volume);
    fn(c);
    p = c.startRendering().then((buf) => {
      lastWav = performance.now();
      return URL.createObjectURL(encodeWav(buf));
    });
    p.catch(() => wavs.delete(key));
    wavs.set(key, p);
    while (wavs.size > MAX_CACHED) {
      const [k, old] = wavs.entries().next().value;
      wavs.delete(k);
      old.then((u) => URL.revokeObjectURL(u), () => {});
    }
    return p;
  }

  function playWav(style, kind, volume) {
    return makeWav(style, kind, volume).then((url) => {
      const a = new Audio(url);
      window.__soundsLast = { via: 'wav', kind, style, at: Date.now() }; // perf / e2e check
      return a.play();
    });
  }

  // One enveloped oscillator note into `dest`.
  function note(c, dest, { type, freq, start, attack, decay, peak, detune = 0, vibrato = null, bend = 1 }) {
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    if (bend !== 1) {
      const t0 = c.currentTime + start;
      osc.frequency.setValueAtTime(freq, t0);
      osc.frequency.exponentialRampToValueAtTime(freq * bend, t0 + attack + decay);
    }
    osc.detune.value = detune;
    const g = c.createGain();
    const t = c.currentTime + start;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(1e-4, t + attack + decay);
    osc.connect(g);
    g.connect(dest);
    if (vibrato) {
      const lfo = c.createOscillator();
      lfo.frequency.value = vibrato.rate;
      const depth = c.createGain();
      depth.gain.value = vibrato.depth;
      lfo.connect(depth);
      depth.connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + attack + decay + 0.05);
    }
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
  }

  function lowpass(c, freq, q = 0.7) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    f.Q.value = q;
    f.connect(master);
    return f;
  }

  // 'subtle' (default, 2026-11-03: the user found the first set too game-like for client sites):
  // soft sines only, gentle attack, short, almost no pitch movement — closer to a quiet office chime.
  const SUBTLE = {
    // one soft bell-like tone (fundamental + faint octave), slow fade
    done(c) {
      note(c, master, { type: 'sine', freq: 784, start: 0, attack: 0.012, decay: 0.55, peak: 0.16 });
      note(c, master, { type: 'sine', freq: 1568, start: 0, attack: 0.012, decay: 0.3, peak: 0.025 });
    },
    // two gentle taps on the same pitch ("knock knock"): asks for attention without melody
    input(c) {
      for (const start of [0, 0.16]) {
        note(c, master, { type: 'sine', freq: 932.33, start, attack: 0.008, decay: 0.16, peak: 0.15 });
        note(c, master, { type: 'sine', freq: 1864.66, start, attack: 0.008, decay: 0.08, peak: 0.02 });
      }
    },
    // one low, muted tone with a small downward bend
    error(c) {
      const f = lowpass(c, 900);
      note(c, f, { type: 'sine', freq: 330, start: 0, attack: 0.015, decay: 0.45, peak: 0.2, bend: 0.94 });
      note(c, f, { type: 'triangle', freq: 330, start: 0, attack: 0.015, decay: 0.25, peak: 0.04, bend: 0.94 });
    },
  };

  // 'clear': the first, more distinctive set (rising triad / questioning fourth / falling tritone).
  const CLEAR = {
    done(c) {
      const notes = [[659.25, 0, 0.18], [987.77, 0.075, 0.18], [1318.51, 0.15, 0.42]];
      for (const [freq, start, decay] of notes) {
        note(c, master, { type: 'triangle', freq, start, attack: 0.004, decay, peak: 0.3 });
        note(c, master, { type: 'sine', freq: freq * 2, start, attack: 0.004, decay, peak: 0.06 });
      }
    },
    input(c) {
      const f = lowpass(c, 1800);
      for (const base of [0, 0.32]) {
        note(c, f, { type: 'square', freq: 440, start: base, attack: 0.006, decay: 0.084, peak: 0.14 });
        note(c, f, { type: 'square', freq: 587.33, start: base + 0.12, attack: 0.006, decay: 0.084, peak: 0.14 });
      }
    },
    error(c) {
      const f = lowpass(c, 1100);
      for (const detune of [-12, 12]) {
        note(c, f, { type: 'sawtooth', freq: 233.08, start: 0, attack: 0.008, decay: 0.14, peak: 0.16, detune });
        note(c, f, { type: 'sawtooth', freq: 164.81, start: 0.16, attack: 0.008, decay: 0.32, peak: 0.16, detune, vibrato: { rate: 7, depth: 8 } });
      }
    },
  };

  const STYLES = { subtle: SUBTLE, clear: CLEAR };

  // Render the WAVs of the current style and volume ahead, while the window is quiet (docs/perf.md 案 3 / 第 3 段), so
  // the first sound at the end of a turn plays at once. A few seconds after the page loaded, at an idle callback, not
  // within 2 s of a key / pointer / wheel input. No audio device is opened here (OfflineAudioContext).
  // Not when sounds are off in the settings (play() still makes them on demand if they are turned on later).
  let lastInput = 0;
  for (const ev of ['keydown', 'pointerdown', 'wheel']) {
    addEventListener(ev, () => (lastInput = performance.now()), { capture: true, passive: true });
  }
  const QUIET_MS = 2000;
  function soundsOn() {
    try {
      const s = window.Notify && window.Notify.settings && window.Notify.settings();
      return !s || s.sound !== false;
    } catch {
      return true;
    }
  }
  function settings() {
    try {
      return (window.Notify && window.Notify.settings && window.Notify.settings()) || {};
    } catch {
      return {};
    }
  }
  let warmed = false;
  function warm() {
    if (warmed || !soundsOn()) return;
    warmed = true;
    const s = settings();
    const style = STYLES[s.style] ? s.style : 'subtle';
    const t0 = performance.now();
    try {
      for (const kind of Object.keys(SUBTLE)) makeWav(style, kind, s.volume).catch(() => {});
      window.__soundsWarmMs = Math.round(performance.now() - t0); // perf check (tmp/perf1, tmp/perf3): the window's sync part
    } catch (err) {
      wavFailed = true;
      console.warn('sound warm-up failed', err);
    }
  }
  function warmWhenQuiet(delay) {
    setTimeout(() => {
      const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 0));
      idle(
        () => {
          if (warmed) return;
          if (performance.now() - lastInput < QUIET_MS) return warmWhenQuiet(QUIET_MS);
          warm();
        },
        { timeout: 10000 },
      );
    }, delay);
  }
  if (document.readyState === 'complete') warmWhenQuiet(4000);
  else addEventListener('load', () => warmWhenQuiet(4000), { once: true });

  function play(kind, volume, style = 'subtle') {
    const fn = (STYLES[style] || SUBTLE)[kind];
    if (!fn) return;
    const live = () => {
      try {
        fn(audio(volume));
        window.__soundsLast = { via: 'live', kind, style, at: Date.now() };
      } catch (err) {
        console.error('sound failed', err);
      }
    };
    if (wavFailed || typeof OfflineAudioContext !== 'function') return live();
    try {
      playWav(style, kind, volume).catch((err) => {
        // NotAllowedError / a decode error: play it the old way once and keep using that
        console.warn('sound (wav) failed, using the live AudioContext', err);
        wavFailed = true;
        live();
      });
    } catch (err) {
      wavFailed = true;
      live();
    }
  }

  window.Sounds = {
    play,
    preview: play,
    warm,
    ready: () => wavs.size > 0 || !!ctx,
    state: () => (ctx ? `live-${ctx.state}` : wavFailed ? 'none' : wavs.size ? 'wav' : 'none'),
    info: () => ({ wavs: wavs.size, wavFailed, live: !!ctx, lastWav }),
    kinds: Object.keys(SUBTLE),
    styles: Object.keys(STYLES),
  };
})();
