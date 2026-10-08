// Starting a dev server's cmd.exe straight through CreateProcessW.
//
// A server outlives Shellby, so it can't be one of node's own children: libuv
// puts those in a job that ends with Shellby, and its `detached` gives the
// process no console at all. A console program started from a console-less
// cmd gets a brand new console of its own, which shows up as a window and
// takes over that program's output handles, so the log stays empty.
//
// So cmd is started here, with CREATE_NO_WINDOW: it gets a hidden console that
// npm, node and everything under them share, its output handles are the log
// file, and it leaves any job Shellby is in. This used to be a small Node
// script run by Shellby's own exe as Node (ELECTRON_RUN_AS_NODE), but the
// packaged app now turns that off (the runAsNode fuse, package.json).
'use strict';
let koffi = null;
try { koffi = require('koffi'); } catch { /* no native launch: start() reports it */ }

const GENERIC_READ = 0x80000000;
const FILE_APPEND_DATA = 0x4;          // without FILE_WRITE_DATA: every write lands at the end, so trimLog is safe
const SHARE_ALL = 0x7;                 // read, write and delete: Shellby tails, trims and cleans the log
const SHARE_READ_WRITE = 0x3;
const OPEN_EXISTING = 3;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const STARTF_USESTDHANDLES = 0x100;
const CREATE_NEW_PROCESS_GROUP = 0x200;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
const CREATE_NO_WINDOW = 0x08000000;
const INVALID_HANDLE = -1;
const MAX_COMMAND_LINE = 32767;

let api;
function load() {
  if (api !== undefined) return api;
  api = null;
  if (!koffi || process.platform !== 'win32') return api;
  try {
    const k32 = koffi.load('kernel32.dll');
    koffi.struct('SHELLBY_SECURITY_ATTRIBUTES', { nLength: 'uint32_t', lpSecurityDescriptor: 'void *', bInheritHandle: 'int' });
    koffi.struct('SHELLBY_STARTUPINFOW', {
      cb: 'uint32_t', lpReserved: 'void *', lpDesktop: 'void *', lpTitle: 'void *',
      dwX: 'uint32_t', dwY: 'uint32_t', dwXSize: 'uint32_t', dwYSize: 'uint32_t',
      dwXCountChars: 'uint32_t', dwYCountChars: 'uint32_t', dwFillAttribute: 'uint32_t', dwFlags: 'uint32_t',
      wShowWindow: 'uint16_t', cbReserved2: 'uint16_t', lpReserved2: 'void *',
      hStdInput: 'intptr_t', hStdOutput: 'intptr_t', hStdError: 'intptr_t',
    });
    koffi.struct('SHELLBY_PROCESS_INFORMATION', { hProcess: 'intptr_t', hThread: 'intptr_t', dwProcessId: 'uint32_t', dwThreadId: 'uint32_t' });
    api = {
      startupSize: koffi.sizeof('SHELLBY_STARTUPINFOW'),
      saSize: koffi.sizeof('SHELLBY_SECURITY_ATTRIBUTES'),
      CreateFileW: k32.func('intptr_t __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, SHELLBY_SECURITY_ATTRIBUTES *sa, uint32_t disposition, uint32_t flags, intptr_t template)'),
      CreateProcessW: k32.func('int __stdcall CreateProcessW(str16 app, _Inout_ uint16_t *cmdline, void *pa, void *ta, int inherit, uint32_t flags, void *env, str16 cwd, SHELLBY_STARTUPINFOW *si, _Out_ SHELLBY_PROCESS_INFORMATION *pi)'),
      CloseHandle: k32.func('int __stdcall CloseHandle(intptr_t h)'),
    };
  } catch (e) {
    console.warn('[shellby] native launch unavailable:', e.message);
    api = null;
  }
  return api;
}

/**
 * An environment block for CreateProcessW: "k=v\0" each, sorted the way
 * Windows keeps them (case-insensitively), and one more \0 at the end.
 */
function envBlock(env) {
  const entries = Object.entries(env)
    .filter(([k, v]) => k && v != null && !k.includes('\0') && !String(v).includes('\0'))
    .sort(([a], [b]) => a.toUpperCase().localeCompare(b.toUpperCase()));
  return Buffer.from(`${entries.map(([k, v]) => `${k}=${v}\0`).join('')}\0`, 'utf16le');
}

const wide = s => { const b = new Uint16Array(s.length + 1); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };

/**
 * Start `app` with the full `commandLine`, detached from Shellby, with no
 * window, stdin on NUL and stdout and stderr appended to `logFile`.
 * -> { pid } | null (no native access, or Windows refused). Never throws.
 */
function launch({ app, commandLine, cwd, env, logFile }) {
  const a = load();
  if (!a || commandLine.length >= MAX_COMMAND_LINE) return null;
  const sa = { nLength: a.saSize, lpSecurityDescriptor: null, bInheritHandle: 1 };
  let log = INVALID_HANDLE, nul = INVALID_HANDLE;
  try {
    log = a.CreateFileW(logFile, FILE_APPEND_DATA, SHARE_ALL, sa, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    nul = a.CreateFileW('NUL', GENERIC_READ, SHARE_READ_WRITE, sa, OPEN_EXISTING, 0, 0);
    if (log === INVALID_HANDLE || nul === INVALID_HANDLE) return null;
    const si = { cb: a.startupSize, dwFlags: STARTF_USESTDHANDLES, hStdInput: nul, hStdOutput: log, hStdError: log };
    const block = envBlock(env);
    const base = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT;
    // Leaving Shellby's job (if it's in one) is what lets the server outlive
    // it. A job that doesn't allow breaking away refuses the whole start, so
    // try once more without: the server then ends with Shellby, but it runs.
    for (const flags of [base | CREATE_BREAKAWAY_FROM_JOB, base]) {
      const pi = {};
      if (!a.CreateProcessW(app, wide(commandLine), null, null, 1, flags, block, cwd, si, pi)) continue;
      a.CloseHandle(pi.hThread);
      a.CloseHandle(pi.hProcess);
      return { pid: pi.dwProcessId };
    }
    return null;
  } catch (e) {
    console.warn('[shellby] dev server launch failed:', e.message);
    return null;
  } finally {
    // The child has its own copies now.
    if (log !== INVALID_HANDLE) a.CloseHandle(log);
    if (nul !== INVALID_HANDLE) a.CloseHandle(nul);
  }
}

module.exports = { launch, envBlock, available: () => !!load() };
