// Free memory for the scheduler's resource check (AT-8).
// Windows / Linux: os.freemem() (Windows = available physical memory, Linux = MemAvailable), unchanged.
// macOS: os.freemem() (and Electron's process.getSystemMemoryInfo().free) count only the "free" pages, often
// 0.05-0.3 GB, while the OS can hand out the inactive, speculative and purgeable pages at once. So on darwin the value is
// (free + inactive + speculative + purgeable) pages x page size, read from /usr/bin/vm_stat.
// Node and Electron have no API for these counts, so this is one short external process (execFile, no shell, fixed
// absolute path, no arguments, time limit), cached: at most one run per cacheMs, never on every sample.
'use strict';

const os = require('os');

const VM_STAT = '/usr/bin/vm_stat';

// vm_stat text -> { pageSize, free, inactive, speculative, purgeable } (page counts), or null if it does not parse.
function parseVmStat(text) {
  if (typeof text !== 'string') return null;
  const ps = /page size of (\d+) bytes/.exec(text);
  const count = (label) => {
    const m = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const info = {
    pageSize: ps ? Number(ps[1]) : null,
    free: count('free'),
    inactive: count('inactive'),
    speculative: count('speculative'),
    purgeable: count('purgeable'),
  };
  if (!info.pageSize || info.free === null || info.inactive === null) return null;
  return info;
}

// { pageSize, free, inactive, speculative?, purgeable? } -> MB the OS can use now, or null.
function macAvailableMB(info) {
  if (!info || !(info.pageSize > 0)) return null;
  const n = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
  if (!Number.isFinite(info.free) || !Number.isFinite(info.inactive)) return null;
  const pages = n(info.free) + n(info.inactive) + n(info.speculative) + n(info.purgeable);
  return (pages * info.pageSize) / 1048576;
}

/**
 * Cached reader of the macOS value. The first value is read once, synchronously, when the reader is made (vm_stat
 * takes a few ms), so the first sample is right; after that read() never waits: it returns the last value and starts
 * an async refresh when it is older than cacheMs.
 * -> { read({ fresh = true }) -> { mb: number|null, pending: boolean, failed: boolean }, refresh(), stop() }
 * deps (tests): { execFile(file, args, opts, cb), execFileSync(file, args, opts) -> string | false (skip), now: () => ms }
 */
function createMacMemReader({ cacheMs = 10000, timeoutMs = 3000 } = {}, deps = {}) {
  const run = deps.execFile || require('child_process').execFile;
  const now = deps.now || (() => Date.now());
  let mb = null;
  let at = -Infinity;
  let busy = false;
  let failures = 0;
  let stopped = false;
  const opts = { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 };

  const runSync = deps.execFileSync === undefined ? require('child_process').execFileSync : deps.execFileSync;
  if (runSync) {
    at = now();
    try {
      const v = macAvailableMB(parseVmStat(String(runSync(VM_STAT, [], { ...opts, encoding: 'utf8' }) || '')));
      if (Number.isFinite(v)) mb = v;
      else failures++;
    } catch {
      failures++;
    }
  }

  function refresh() {
    if (busy || stopped) return;
    busy = true;
    at = now();
    try {
      run(VM_STAT, [], opts, (err, stdout) => {
        busy = false;
        const v = err ? null : macAvailableMB(parseVmStat(String(stdout || '')));
        if (Number.isFinite(v)) {
          mb = v;
          failures = 0;
        } else {
          failures++;
        }
      });
    } catch {
      busy = false;
      failures++;
    }
  }

  // fresh: false -> only the cached value, no vm_stat run (nobody is asking: sched.js over())
  function read({ fresh = true } = {}) {
    if (fresh && !stopped && !busy && now() - at >= cacheMs) refresh();
    return { mb, pending: mb === null && failures === 0, failed: mb === null && failures > 0 };
  }

  return {
    read,
    refresh,
    stop() {
      stopped = true;
    },
  };
}

/**
 * Free MB for one sample. platform !== 'darwin' (or no reader): sys.freemem(), exactly as before.
 * darwin: the reader's value; null while the first vm_stat run is still pending (= not known yet, not "low");
 * os.freemem() if vm_stat failed and nothing was read yet.
 */
function freeMBOf({ platform = process.platform, sys = os, macReader = null, fresh = true } = {}) {
  if (platform === 'darwin' && macReader) {
    const r = macReader.read({ fresh });
    if (Number.isFinite(r.mb)) return r.mb;
    if (r.pending) return null;
  }
  return sys.freemem() / 1048576;
}

module.exports = { parseVmStat, macAvailableMB, createMacMemReader, freeMBOf, VM_STAT };
