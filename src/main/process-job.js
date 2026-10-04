// Cleaning up after Claude Code. Everything a `claude` process starts (MCP
// servers like serena, shells, test copies of an app, python scripts) joins a
// Windows job object with it, and stays in it however deep the tree goes. When
// the conversation's process ends, sweep() ends whatever is still in the job.
//
// Why not taskkill /T? It walks parent links, and those break as soon as a
// middle process exits: uvx quits, and the python it started has no parent
// left to be found from. Job membership doesn't depend on the parent living.
//
// Why not JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE? It kills everything, and a
// browser or editor Claude happened to be the first to open is the user's to
// keep. sweep() leaves those (KEEP) running.
//
// A process started with CREATE_BREAKAWAY_FROM_JOB is let go: it means to
// outlive whoever started it, and refusing would fail its start. (node's own
// job lets grandchildren slip out of *it* silently; they stay in this one, so
// npm -> cmd -> electron is still found.)
//
// Best effort throughout: no koffi, not Windows, or a call that fails all mean
// "no job", and callers fall back to what they did before.
let koffi = null;
try { koffi = require('koffi'); } catch { /* no job objects: callers fall back to taskkill */ }

const PROCESS_TERMINATE = 0x1;
const PROCESS_SET_QUOTA = 0x100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const JOB_OBJECT_BASIC_LIMIT_INFORMATION = 2;
const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;
const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x800;
const LIMIT_BYTES = process.arch === 'ia32' ? 48 : 64;    // JOBOBJECT_BASIC_LIMIT_INFORMATION
const LIMIT_FLAGS_AT = 16;                                // after the two LARGE_INTEGER time limits
const MAX_IDS = 4096;
const ID_SIZE = process.arch === 'ia32' ? 4 : 8;           // ULONG_PTR
const LIST_BYTES = 8 + MAX_IDS * ID_SIZE;                 // two DWORD counts, then the ids

// Apps that belong to the user even when Claude started them: opening a link or
// a folder can make the first browser or Explorer window a child of Claude.
const KEEP = new Set([
  'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'arc.exe',
  'explorer.exe', 'code.exe', 'cursor.exe', 'windowsterminal.exe',
]);

let api = null;
function load() {
  if (api || !koffi || process.platform !== 'win32') return api;
  try {
    const k = koffi.load('kernel32.dll');
    api = {
      CreateJobObjectW: k.func('intptr_t __stdcall CreateJobObjectW(intptr_t attrs, intptr_t name)'),
      AssignProcessToJobObject: k.func('bool __stdcall AssignProcessToJobObject(intptr_t job, intptr_t proc)'),
      SetInformationJobObject: k.func('bool __stdcall SetInformationJobObject(intptr_t job, int cls, uint8_t *info, uint32_t len)'),
      QueryInformationJobObject: k.func('bool __stdcall QueryInformationJobObject(intptr_t job, int cls, _Out_ uint8_t *info, uint32_t len, intptr_t ret)'),
      IsProcessInJob: k.func('bool __stdcall IsProcessInJob(intptr_t proc, intptr_t job, _Out_ int32_t *result)'),
      OpenProcess: k.func('intptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
      TerminateProcess: k.func('bool __stdcall TerminateProcess(intptr_t proc, uint32_t code)'),
      QueryFullProcessImageNameW: k.func('bool __stdcall QueryFullProcessImageNameW(intptr_t h, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)'),
      CloseHandle: k.func('bool __stdcall CloseHandle(intptr_t h)'),
    };
  } catch {
    api = null;
    koffi = null; // don't keep retrying a load that fails
  }
  return api;
}

function exeName(a, h) {
  const buf = new Uint16Array(1024);
  const size = [1024];
  if (!a.QueryFullProcessImageNameW(h, 0, buf, size)) return '';
  return String.fromCharCode(...buf.slice(0, size[0])).split('\\').pop().toLowerCase();
}

/**
 * Put a just-started process in a job of its own, so everything it starts can
 * be found later. -> a job ({ handle }) for sweep(), or null when it can't be done.
 * Call it straight after spawn: anything started before it joins is missed.
 */
function adopt(pid) {
  const a = load();
  if (!a || !Number.isInteger(pid) || pid <= 0) return null;
  let job = 0, proc = 0;
  try {
    job = a.CreateJobObjectW(0, 0);
    if (!job) return null;
    const limits = Buffer.alloc(LIMIT_BYTES);
    limits.writeUInt32LE(JOB_OBJECT_LIMIT_BREAKAWAY_OK, LIMIT_FLAGS_AT);
    a.SetInformationJobObject(job, JOB_OBJECT_BASIC_LIMIT_INFORMATION, limits, LIMIT_BYTES);
    proc =a.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
    if (!proc || !a.AssignProcessToJobObject(job, proc)) { a.CloseHandle(job); return null; }
    return { handle: job };
  } catch {
    if (job) try { a.CloseHandle(job); } catch { /* ignore */ }
    return null;
  } finally {
    if (proc) try { a.CloseHandle(proc); } catch { /* ignore */ }
  }
}

/** The ids of the processes still in a job. */
function members(job) {
  const a = load();
  if (!a || !job?.handle) return [];
  try {
    const buf = Buffer.alloc(LIST_BYTES);
    // A full list fails with ERROR_MORE_DATA but still fills what fits.
    a.QueryInformationJobObject(job.handle, JOB_OBJECT_BASIC_PROCESS_ID_LIST, buf, LIST_BYTES, 0);
    const n = Math.min(buf.readUInt32LE(4), MAX_IDS);
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(ID_SIZE === 8 ? Number(buf.readBigUInt64LE(8 + i * 8)) : buf.readUInt32LE(8 + i * 4));
    return ids.filter(id => id > 0);
  } catch {
    return [];
  }
}

/**
 * End every process still in the job except the user's own apps (KEEP), then
 * let the job go. Synchronous, so it can run while Shellby quits. Safe to call
 * twice: the second time there's nothing left to do.
 * -> { ended, kept } (names), or null when there was no job.
 */
function sweep(job) {
  const a = load();
  if (!a || !job?.handle) return null;
  const ended = [], kept = [];
  for (const pid of members(job)) {
    let h = 0;
    try {
      h = a.OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!h) continue;
      // The id could have been reused since the list was taken: only end it if it's still ours.
      const inJob = [0];
      if (!a.IsProcessInJob(h, job.handle, inJob) || !inJob[0]) continue;
      const name = exeName(a, h);
      if (KEEP.has(name)) { kept.push(name); continue; }
      if (a.TerminateProcess(h, 1)) ended.push(name || String(pid));
    } catch { /* gone already, or not ours to end */ } finally {
      if (h) try { a.CloseHandle(h); } catch { /* ignore */ }
    }
  }
  try { a.CloseHandle(job.handle); } catch { /* ignore */ }
  job.handle = 0;
  return { ended, kept };
}

const available = () => !!load();

module.exports = { adopt, sweep, members, available, KEEP };
