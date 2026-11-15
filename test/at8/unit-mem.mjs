// AT-8: free memory on macOS (src/main/memfree.js) and its use in the scheduler (src/main/sched.js).
// node tmp/at8/unit-mem.mjs  -> "ok ..." / "FAIL ..." lines, "N/M", exit 1 on any failure.
// Last block prints the real numbers on this machine (os.freemem vs the mac value vs total).
import { createRequire } from 'module';
import os from 'os';
const require = createRequire(import.meta.url);
const memfree = require('../../src/main/memfree');
const sched = require('../../src/main/sched');

let pass = 0;
let total = 0;
function ok(name, cond, detail) {
  total++;
  if (cond) pass++;
  console.log(`${cond ? 'ok' : 'FAIL'} ${name}${cond || detail === undefined ? '' : ' | ' + JSON.stringify(detail)}`);
}
const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) < 0.01;
const GB = 1024;
const THRESH = { minFreeGB: 1 };

// --- parse + assembly -------------------------------------------------------------------------------------------
const sample = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                                    12718.',
  'Pages active:                                 495107.',
  'Pages inactive:                               494146.',
  'Pages speculative:                               283.',
  'Pages throttled:                                   0.',
  'Pages wired down:                             177036.',
  'Pages purgeable:                               10646.',
  '"Translation faults":                     1214894052.',
  'File-backed pages:                            239793.',
].join('\n');
const info = memfree.parseVmStat(sample);
ok('parse: page size', info && info.pageSize === 16384, info);
ok('parse: free / inactive / speculative / purgeable', info && info.free === 12718 && info.inactive === 494146 && info.speculative === 283 && info.purgeable === 10646, info);
ok('parse: garbage -> null', memfree.parseVmStat('nothing here') === null);
ok('parse: non-string -> null', memfree.parseVmStat(undefined) === null);
const expectMB = ((12718 + 494146 + 283 + 10646) * 16384) / 1048576;
ok('assemble: (free+inactive+speculative+purgeable) x page size', near(memfree.macAvailableMB(info), expectMB), memfree.macAvailableMB(info));
ok('assemble: 4 KB pages', near(memfree.macAvailableMB({ pageSize: 4096, free: 256, inactive: 256, speculative: 0, purgeable: 0 }), 2));
ok('assemble: missing speculative/purgeable count as 0', near(memfree.macAvailableMB({ pageSize: 16384, free: 64, inactive: 0 }), 1));
ok('assemble: no page size -> null', memfree.macAvailableMB({ free: 1, inactive: 1 }) === null);
ok('assemble: no inactive -> null', memfree.macAvailableMB({ pageSize: 16384, free: 1 }) === null);

// --- threshold (1 GB) -----------------------------------------------------------------------------------------
const lowFreeHighInactive = memfree.macAvailableMB({ pageSize: 16384, free: 6000, inactive: 300000, speculative: 100, purgeable: 2000 }); // free ~0.09 GB, total ~4.8 GB
const trulyLow = memfree.macAvailableMB({ pageSize: 16384, free: 6000, inactive: 20000, speculative: 100, purgeable: 500 }); // ~0.4 GB
ok('threshold: low free + high inactive passes 1 GB', sched.overOf({ freeMB: lowFreeHighInactive }, THRESH).length === 0, lowFreeHighInactive);
ok('threshold: same sample by free pages alone would fail', sched.overOf({ freeMB: (6000 * 16384) / 1048576 }, THRESH).length === 1);
ok('threshold: truly low fails 1 GB', sched.overOf({ freeMB: trulyLow }, THRESH).length === 1, trulyLow);

// --- reader (fake execFile / execFileSync) ------------------------------------------------------------------------
{
  let clock = 0;
  const calls = [];
  let pendingCb = null;
  const execFile = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    pendingCb = cb;
  };
  const r = memfree.createMacMemReader({ cacheMs: 10000 }, { execFile, execFileSync: () => sample, now: () => clock });
  const first = r.read();
  ok('reader: first value read synchronously', near(first.mb, expectMB) && calls.length === 0, first);
  clock = 5000;
  r.read();
  ok('reader: cached inside cacheMs (no run)', calls.length === 0);
  clock = 10000;
  r.read();
  ok('reader: refresh after cacheMs runs /usr/bin/vm_stat with no args and a timeout', calls.length === 1 && calls[0].file === '/usr/bin/vm_stat' && calls[0].args.length === 0 && calls[0].opts.timeout > 0, calls);
  r.read();
  ok('reader: no second run while one is busy', calls.length === 1);
  pendingCb(null, sample.replace('494146', '100000'));
  const after = r.read();
  ok('reader: async result replaces the value', near(after.mb, ((12718 + 100000 + 283 + 10646) * 16384) / 1048576), after);
  clock = 20000;
  r.read();
  pendingCb(new Error('timeout'), '');
  ok('reader: failed refresh keeps the last value', near(r.read().mb, ((12718 + 100000 + 283 + 10646) * 16384) / 1048576));
  r.stop();
  clock = 40000;
  const n = calls.length;
  r.read();
  ok('reader: stop() ends refreshes', calls.length === n);
}
{
  const r = memfree.createMacMemReader({}, { execFile: () => {}, execFileSync: false, now: () => 0 });
  ok('reader: pending before the first value', r.read().pending === true && r.read().mb === null);
  const rf = memfree.createMacMemReader({}, { execFile: () => {}, execFileSync: () => { throw new Error('x'); }, now: () => 0 });
  ok('reader: failed first read -> failed', rf.read().failed === true);
}

// --- freeMBOf: platform switch ------------------------------------------------------------------------------------
const fakeSys = { freemem: () => 200 * 1048576 };
const fakeMac = (mb, pending = false) => ({ read: () => ({ mb, pending, failed: mb === null && !pending }) });
ok('freeMBOf: darwin uses the mac value', memfree.freeMBOf({ platform: 'darwin', sys: fakeSys, macReader: fakeMac(5000) }) === 5000);
ok('freeMBOf: win32 uses freemem even with a reader', memfree.freeMBOf({ platform: 'win32', sys: fakeSys, macReader: fakeMac(5000) }) === 200);
ok('freeMBOf: linux uses freemem', memfree.freeMBOf({ platform: 'linux', sys: fakeSys }) === 200);
ok('freeMBOf: darwin pending -> null (not known yet)', memfree.freeMBOf({ platform: 'darwin', sys: fakeSys, macReader: fakeMac(null, true) }) === null);
ok('freeMBOf: darwin failed -> freemem fallback', memfree.freeMBOf({ platform: 'darwin', sys: fakeSys, macReader: fakeMac(null) }) === 200);

// --- the monitor in sched.js --------------------------------------------------------------------------------------
{
  const fakeOs = { freemem: () => 100 * 1048576, totalmem: () => 24 * GB * 1048576, cpus: () => [] };
  const hist = { enable() {}, disable() {}, reset() {}, mean: 0 };
  const mk = (extra) => sched.createResourceMonitor({ sampleMs: 2000, windowMs: 10000 }, { os: fakeOs, now: () => 0, histogram: hist, timers: false, ...extra });
  const mac = mk({ platform: 'darwin', macMem: fakeMac(8 * GB) });
  ok('monitor darwin: freeMB is the mac value', mac.snapshot().freeMB === 8 * GB, mac.snapshot());
  ok('monitor darwin: passes the 1 GB threshold', mac.over(THRESH).length === 0, mac.over(THRESH));
  mac.stop();
  const macLow = mk({ platform: 'darwin', macMem: fakeMac(400) });
  ok('monitor darwin: truly low is over', macLow.over(THRESH).length === 1);
  macLow.stop();
  const win = mk({ platform: 'win32', macMem: fakeMac(8 * GB) });
  ok('monitor win32: freeMB = freemem', win.snapshot().freeMB === 100, win.snapshot());
  win.stop();
  const inj = mk({});
  ok('monitor: injected os without platform = freemem (old tests)', inj.snapshot().freeMB === 100, inj.snapshot());
  inj.stop();

  // vm_stat only while asked: a reader whose runs are counted (execFile stub), the clock moved by hand
  let t = 0;
  let runs = 0;
  const VM = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:      1000.\nPages inactive:      100000.\n';
  const reader = memfree.createMacMemReader({ cacheMs: 10000 }, { now: () => t, execFileSync: () => { runs++; return VM; }, execFile: (f, a, o, cb) => { runs++; cb(null, VM); } });
  ok('ask: the reader reads once at start', runs === 1, runs);
  const m = sched.createResourceMonitor({ sampleMs: 2000, windowMs: 10000 }, { os: fakeOs, now: () => t, histogram: hist, timers: false, platform: 'darwin', macMem: reader });
  for (t = 0; t <= 300000; t += 2000) m.sample(); // 5 min of samples, nobody asks
  ok('ask: no vm_stat run while nobody asks (5 min of samples)', runs === 1, runs);
  m.over(THRESH); // a plan asks after the quiet time: refresh at once
  ok('ask: over() after a quiet time refreshes', runs === 2, runs);
  const before = runs;
  for (let k = 0; k < 30; k++) { t += 2000; m.sample(); } // 60 s of samples right after the ask: at most one run / 10 s
  ok('ask: while asked, at most one run per 10 s', runs - before >= 4 && runs - before <= 6, runs - before);
  const after = runs;
  for (let k = 0; k < 60; k++) { t += 2000; m.sample(); } // 2 more minutes nobody asks
  ok('ask: stops again once nobody asks for 60 s', runs - after <= 1, runs - after);
  m.stop();
}

// --- real numbers on this machine ---------------------------------------------------------------------------------
{
  const real = sched.createResourceMonitor({ sampleMs: 2000, windowMs: 10000 });
  const snap = real.snapshot();
  real.stop();
  const f = (mb) => (mb === null ? 'null' : (mb / GB).toFixed(2) + ' GB');
  console.log(`real: platform=${process.platform} os.freemem=${f(os.freemem() / 1048576)} monitor.freeMB=${f(snap.freeMB)} total=${f(os.totalmem() / 1048576)} (${snap.totalMB ? Math.round((snap.freeMB / snap.totalMB) * 100) : '?'}% of total)`);
  ok('real: monitor gives a positive freeMB', snap.freeMB > 0, snap);
  if (process.platform === 'darwin') ok('real darwin: mac value >= os.freemem', snap.freeMB >= Math.floor(os.freemem() / 1048576), snap);
}

console.log(`${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
