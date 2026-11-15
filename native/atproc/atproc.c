// atproc: the process list and the keep-awake power request for Agent Terminal, in the app's own process
// (SEC3, docs/security.md). Replaces the PowerShell Add-Type helpers (a C# compile, a DLL under %TEMP%).
//
// What it reads, nothing more: one NtQuerySystemInformation(SystemProcessInformation) snapshot -> per process the PID,
// parent PID, creation time, thread count, private bytes, image name and whether every thread waits as Suspended.
// No OpenProcess, no other process's memory, no command lines (CLAUDE.md: PID / parent / memory only).
// Tests only: suspendSelf() stops the calling process itself (its own pseudo-handle; SEC3b, the orphan-sweep e2e).
// Power: PowerCreateRequest + PowerSetRequest(PowerRequestSystemRequired) on this process; Windows drops the request
// when the process ends, so a crash cannot leave it behind.
//
// Build: native/atproc/build.md (node-gyp, N-API 8: one binary works in Node and in Electron).

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <powerbase.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <node_api.h>

// --- the snapshot -------------------------------------------------------------------------------------------------

// The x64 layout of SYSTEM_PROCESS_INFORMATION / SYSTEM_THREAD_INFORMATION (winternl.h hides most fields).
typedef struct {
  LARGE_INTEGER KernelTime, UserTime, CreateTime;
  ULONG WaitTime;
  PVOID StartAddress;
  HANDLE UniqueProcess, UniqueThread;
  LONG Priority, BasePriority;
  ULONG ContextSwitches, ThreadState, WaitReason;
} AT_THREAD;

typedef struct {
  ULONG NextEntryOffset, NumberOfThreads;
  LARGE_INTEGER WorkingSetPrivateSize;
  ULONG HardFaultCount, NumberOfThreadsHighWatermark;
  ULONGLONG CycleTime;
  LARGE_INTEGER CreateTime, UserTime, KernelTime;
  UNICODE_STRING ImageName;
  LONG BasePriority;
  HANDLE UniqueProcessId, InheritedFromUniqueProcessId;
  ULONG HandleCount, SessionId;
  ULONG_PTR UniqueProcessKey;
  SIZE_T PeakVirtualSize, VirtualSize;
  ULONG PageFaultCount;
  SIZE_T PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage;
  SIZE_T QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage, PrivatePageCount;
  LARGE_INTEGER ReadOperationCount, WriteOperationCount, OtherOperationCount;
  LARGE_INTEGER ReadTransferCount, WriteTransferCount, OtherTransferCount;
  AT_THREAD Threads[1];
} AT_PROC;

// compile-time checks of the x64 offsets (a negative array size fails the build)
#ifdef _WIN64
#define AT_CHECK(name, cond) typedef char at_check_##name[(cond) ? 1 : -1]
AT_CHECK(thread_size, sizeof(AT_THREAD) == 80);
AT_CHECK(image_name, offsetof(AT_PROC, ImageName) == 56);
AT_CHECK(pid, offsetof(AT_PROC, UniqueProcessId) == 80);
AT_CHECK(private_bytes, offsetof(AT_PROC, PrivatePageCount) == 200);
AT_CHECK(threads, offsetof(AT_PROC, Threads) == 256);
#endif

#define AT_NAME_MAX 260
#define AT_STATUS_INFO_LENGTH_MISMATCH ((NTSTATUS)0xC0000004L)
#define AT_WAITING 5    // KTHREAD_STATE Waiting
#define AT_SUSPENDED 5  // KWAIT_REASON Suspended

typedef struct {
  double pid, ppid, created, threads, priv;
  int suspended;
  size_t nameLen;
  WCHAR name[AT_NAME_MAX];
} AT_ROW;

typedef struct {
  AT_ROW *rows;
  size_t count;
  NTSTATUS status;
  char error[128];
} AT_SNAP;

static void snap_free(AT_SNAP *s) {
  free(s->rows);
  s->rows = NULL;
  s->count = 0;
}

static void snap_take(AT_SNAP *s) {
  ULONG size = 1 << 20;
  BYTE *buf = NULL;
  NTSTATUS st = AT_STATUS_INFO_LENGTH_MISMATCH;
  s->rows = NULL;
  s->count = 0;
  s->status = 0;
  s->error[0] = 0;
  for (int i = 0; i < 10 && st == AT_STATUS_INFO_LENGTH_MISMATCH; i++) {
    free(buf);
    buf = (BYTE *)malloc(size);
    if (!buf) {
      strcpy_s(s->error, sizeof s->error, "out of memory");
      return;
    }
    ULONG ret = 0;
    st = NtQuerySystemInformation(SystemProcessInformation, buf, size, &ret);
    if (st == AT_STATUS_INFO_LENGTH_MISMATCH) size = (ret > size ? ret : size * 2) + (256 << 10);
  }
  if (st < 0) {
    s->status = st;
    sprintf_s(s->error, sizeof s->error, "NtQuerySystemInformation 0x%08lX", (unsigned long)st);
    free(buf);
    return;
  }
  size_t n = 0;
  for (size_t off = 0;;) {
    const AT_PROC *p = (const AT_PROC *)(buf + off);
    n++;
    if (!p->NextEntryOffset) break;
    off += p->NextEntryOffset;
  }
  s->rows = (AT_ROW *)calloc(n ? n : 1, sizeof(AT_ROW));
  if (!s->rows) {
    strcpy_s(s->error, sizeof s->error, "out of memory");
    free(buf);
    return;
  }
  size_t k = 0;
  for (size_t off = 0;;) {
    const AT_PROC *p = (const AT_PROC *)(buf + off);
    AT_ROW *r = &s->rows[k++];
    ULONG_PTR pid = (ULONG_PTR)p->UniqueProcessId;
    r->pid = (double)pid;
    r->ppid = (double)(ULONG_PTR)p->InheritedFromUniqueProcessId;
    r->threads = (double)p->NumberOfThreads;
    r->priv = (double)p->PrivatePageCount;
    // FILETIME (100 ns since 1601) -> ms since 1970; 0 = unknown
    LONGLONG ct = p->CreateTime.QuadPart;
    LONGLONG ms = ct > 0 ? ct / 10000 - 11644473600000LL : 0;
    r->created = ms > 0 ? (double)ms : 0;
    ULONG susp = 0;
    for (ULONG t = 0; t < p->NumberOfThreads; t++) {
      const AT_THREAD *th = &p->Threads[t];
      if (th->ThreadState == AT_WAITING && th->WaitReason == AT_SUSPENDED) susp++;
    }
    r->suspended = p->NumberOfThreads > 0 && susp == p->NumberOfThreads;
    if (pid == 0) {
      const WCHAR *idle = L"System Idle Process";
      r->nameLen = wcslen(idle);
      wmemcpy(r->name, idle, r->nameLen);
    } else if (p->ImageName.Buffer && p->ImageName.Length) {
      size_t len = p->ImageName.Length / sizeof(WCHAR);
      if (len > AT_NAME_MAX) len = AT_NAME_MAX;
      wmemcpy(r->name, p->ImageName.Buffer, len);
      r->nameLen = len;
    }
    if (!p->NextEntryOffset || k >= n) break;
    off += p->NextEntryOffset;
  }
  s->count = k;
  free(buf);
}

static napi_value snap_to_js(napi_env env, const AT_SNAP *s) {
  napi_value arr, row, v;
  napi_create_array_with_length(env, s->count, &arr);
  for (size_t i = 0; i < s->count; i++) {
    const AT_ROW *r = &s->rows[i];
    napi_create_object(env, &row);
#define AT_NUM(key, val)                 \
  napi_create_double(env, (val), &v);    \
  napi_set_named_property(env, row, key, v);
    AT_NUM("pid", r->pid);
    AT_NUM("ppid", r->ppid);
    AT_NUM("created", r->created);
    AT_NUM("threads", r->threads);
    AT_NUM("priv", r->priv);
#undef AT_NUM
    napi_get_boolean(env, r->suspended != 0, &v);
    napi_set_named_property(env, row, "suspended", v);
    napi_create_string_utf16(env, (const char16_t *)r->name, r->nameLen, &v);
    napi_set_named_property(env, row, "name", v);
    napi_set_element(env, arr, (uint32_t)i, row);
  }
  return arr;
}

// list() -> Promise<[{ pid, ppid, created (ms, 0 = unknown), threads, priv, suspended, name }]>, on a libuv worker
typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  AT_SNAP snap;
} AT_JOB;

static void job_execute(napi_env env, void *data) {
  (void)env;
  snap_take(&((AT_JOB *)data)->snap);
}

static void job_complete(napi_env env, napi_status status, void *data) {
  AT_JOB *job = (AT_JOB *)data;
  if (status != napi_ok || job->snap.error[0]) {
    napi_value msg, err;
    napi_create_string_utf8(env, job->snap.error[0] ? job->snap.error : "atproc: the list was cancelled", NAPI_AUTO_LENGTH, &msg);
    napi_create_error(env, NULL, msg, &err);
    napi_reject_deferred(env, job->deferred, err);
  } else {
    napi_resolve_deferred(env, job->deferred, snap_to_js(env, &job->snap));
  }
  snap_free(&job->snap);
  napi_delete_async_work(env, job->work);
  free(job);
}

// Every N-API step is checked (SEC3b): a failed step throws (before the promise exists) or rejects the promise, so
// list() never hands back a promise that is never settled.
static napi_value js_list(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value promise, name, msg, err;
  AT_JOB *job = (AT_JOB *)calloc(1, sizeof(AT_JOB));
  if (!job) {
    napi_throw_error(env, NULL, "atproc: out of memory");
    return NULL;
  }
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok) {
    free(job);
    napi_throw_error(env, NULL, "atproc: napi_create_promise failed");
    return NULL;
  }
  const char *fail = NULL;
  if (napi_create_string_utf8(env, "atproc.list", NAPI_AUTO_LENGTH, &name) != napi_ok) fail = "atproc: napi_create_string_utf8 failed";
  else if (napi_create_async_work(env, NULL, name, job_execute, job_complete, job, &job->work) != napi_ok) fail = "atproc: napi_create_async_work failed";
  else if (napi_queue_async_work(env, job->work) != napi_ok) {
    napi_delete_async_work(env, job->work);
    fail = "atproc: napi_queue_async_work failed";
  }
  if (fail) {
    if (napi_create_string_utf8(env, fail, NAPI_AUTO_LENGTH, &msg) == napi_ok && napi_create_error(env, NULL, msg, &err) == napi_ok) {
      napi_reject_deferred(env, job->deferred, err);
    } else {
      napi_value undef;
      napi_get_undefined(env, &undef);
      napi_reject_deferred(env, job->deferred, undef);
    }
    free(job);
  }
  return promise;
}

// listSync() -> the same rows, on the calling thread (tests and short tools; ~tens of ms)
static napi_value js_list_sync(napi_env env, napi_callback_info info) {
  (void)info;
  AT_SNAP s;
  snap_take(&s);
  if (s.error[0]) {
    napi_throw_error(env, NULL, s.error);
    snap_free(&s);
    return NULL;
  }
  napi_value arr = snap_to_js(env, &s);
  snap_free(&s);
  return arr;
}

// --- the power request ------------------------------------------------------------------------------------------

static HANDLE g_power = NULL;

// power(on, reason?) -> { ok, fallback } (on: PowerSetRequest(SystemRequired); when Windows refuses it,
// SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) on the calling thread, fallback true. off: both cleared.)
static napi_value js_power(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], out, v;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  bool on = false;
  if (argc > 0) napi_get_value_bool(env, argv[0], &on);
  bool ok = false, fallback = false;
  if (on) {
    if (!g_power) {
      WCHAR reason[256] = L"Agent Terminal";
      if (argc > 1) {
        size_t got = 0;
        if (napi_get_value_string_utf16(env, argv[1], (char16_t *)reason, 256, &got) != napi_ok) wcscpy_s(reason, 256, L"Agent Terminal");
      }
      REASON_CONTEXT rc;
      memset(&rc, 0, sizeof rc);
      rc.Version = POWER_REQUEST_CONTEXT_VERSION;
      rc.Flags = POWER_REQUEST_CONTEXT_SIMPLE_STRING;
      rc.Reason.SimpleReasonString = reason;
      HANDLE h = PowerCreateRequest(&rc);
      g_power = h == INVALID_HANDLE_VALUE ? NULL : h;
    }
    ok = g_power && PowerSetRequest(g_power, PowerRequestSystemRequired);
    if (!ok) fallback = SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) != 0;
  } else {
    if (g_power) PowerClearRequest(g_power, PowerRequestSystemRequired);
    SetThreadExecutionState(ES_CONTINUOUS);
    ok = true;
  }
  napi_create_object(env, &out);
  napi_get_boolean(env, ok, &v);
  napi_set_named_property(env, out, "ok", v);
  napi_get_boolean(env, fallback, &v);
  napi_set_named_property(env, out, "fallback", v);
  return out;
}

// executionState() -> the system's execution state flags (CallNtPowerInformation(SystemExecutionState), no admin;
// ES_SYSTEM_REQUIRED = 1), -1 when it cannot be read. Read only: the keep-awake tests check the request with it.
static napi_value js_exec_state(napi_env env, napi_callback_info info) {
  (void)info;
  ULONG st = 0;
  LONG r = CallNtPowerInformation(SystemExecutionState, NULL, 0, &st, sizeof st);
  napi_value v;
  napi_create_double(env, r == 0 ? (double)st : -1, &v);
  return v;
}

// --- self suspend (tests only) ----------------------------------------------------------------------------------

// suspendSelf() -> does not return: NtSuspendProcess on the calling process's own pseudo-handle (GetCurrentProcess,
// no OpenProcess, no other process touched). For the orphan-sweep e2e only (tmp/orphan-sweep/kid.cjs): a test's own
// child stops itself so that it looks like a CreateProcess cut short (every thread Suspended). The app never calls
// it (src/main/proclist.js does not export it). Returns the NTSTATUS only if the call failed.
NTSYSAPI NTSTATUS NTAPI NtSuspendProcess(HANDLE process);

static napi_value js_suspend_self(napi_env env, napi_callback_info info) {
  (void)info;
  NTSTATUS st = NtSuspendProcess(GetCurrentProcess());
  napi_value v;
  napi_create_double(env, (double)st, &v);
  return v;
}

// --- module -----------------------------------------------------------------------------------------------------

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    { "list", NULL, js_list, NULL, NULL, NULL, napi_enumerable, NULL },
    { "listSync", NULL, js_list_sync, NULL, NULL, NULL, napi_enumerable, NULL },
    { "power", NULL, js_power, NULL, NULL, NULL, napi_enumerable, NULL },
    { "executionState", NULL, js_exec_state, NULL, NULL, NULL, napi_enumerable, NULL },
    { "suspendSelf", NULL, js_suspend_self, NULL, NULL, NULL, napi_enumerable, NULL },
  };
  napi_define_properties(env, exports, sizeof props / sizeof props[0], props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
