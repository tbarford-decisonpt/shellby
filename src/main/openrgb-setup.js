// Getting OpenRGB onto the PC and running, so desk lighting is one switch
// rather than a download, an installer and a settings page to find.
//
// Installing goes through winget (OpenRGB's own MSI from its GitHub release;
// Windows asks for admin itself) and only after the isolated confirm window.
// Starting it passes --server, which opens the SDK port Shellby paints through,
// and --startminimized, so it sits in the tray instead of over your work.
//
// Everything that touches the system is injected, so the decisions (where to
// look, what to run, what an exit code means) are unit-tested.
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const WINGET_ID = 'OpenRGB.OpenRGB';
const DEFAULT_PORT = 6742;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;   // a UAC prompt can sit unanswered for a while
// winget's "already installed, nothing newer": as good as a fresh install here.
const WINGET_ALREADY_INSTALLED = 0x8A15002B;
// The MSI was cancelled (UAC declined, or its own Cancel).
const WINGET_INSTALL_CANCELLED = [0x8A150011, 1602];

/** Where OpenRGB ends up: the MSI's Program Files folder, or a portable copy winget linked. */
function candidates(env = process.env) {
  const out = [];
  for (const base of [env.ProgramFiles, env['ProgramW6432'], env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]) {
    if (base) out.push(path.join(base, 'OpenRGB', 'OpenRGB.exe'));
  }
  if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'OpenRGB.exe'));
  return [...new Set(out)];
}

/** The OpenRGB.exe on this PC, or null. */
function findOpenRgb({ env = process.env, exists = fs.existsSync } = {}) {
  return candidates(env).find(p => { try { return exists(p); } catch { return false; } }) || null;
}

function launchArgs(port = DEFAULT_PORT) {
  const args = ['--server', '--startminimized'];
  // OpenRGB only accepts 1024-65535 here; anything else keeps its default.
  if (port !== DEFAULT_PORT && Number.isInteger(port) && port >= 1024 && port <= 65535) args.push('--server-port', String(port));
  return args;
}

// The copy we started, until it exits. Its first device scan can take minutes
// on SMBus boards; a second copy started meanwhile fights it for the bus and
// neither opens the port.
let started = null;
const stillStarting = () => !!started;

/** Start OpenRGB detached: it's the user's app, and outlives Shellby. */
function launchOpenRgb(exe, port, { spawn = childProcess.spawn } = {}) {
  try {
    const child = spawn(exe, launchArgs(port), { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(exe) });
    child.on?.('error', () => { /* reported by the probe that follows */ });
    child.on?.('exit', () => { if (started === child) started = null; });
    child.unref?.();
    started = child;
    return true;
  } catch {
    return false;
  }
}

const INSTALL_ARGS = [
  'install', '--id', WINGET_ID, '--exact', '--source', 'winget', '--silent',
  '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity',
];

/** What winget's exit tells us. code: a number, or 'ENOENT' when winget isn't there. */
function installOutcome(code) {
  if (code === 0 || code == null) return { ok: true };
  if (code === 'ENOENT') return { ok: false, noWinget: true, error: "Windows' package manager (winget) isn't on this PC." };
  const n = Number(code) >>> 0;
  if (n === WINGET_ALREADY_INSTALLED) return { ok: true };
  if (WINGET_INSTALL_CANCELLED.includes(n)) return { ok: false, error: 'The install was cancelled.' };
  return { ok: false, error: `winget stopped with code 0x${n.toString(16).toUpperCase()}.` };
}

/** Install OpenRGB with winget. -> { ok } | { ok: false, error, noWinget? } */
function installOpenRgb({ execFile = childProcess.execFile } = {}) {
  return new Promise(resolve => {
    execFile('winget', INSTALL_ARGS, { windowsHide: true, timeout: INSTALL_TIMEOUT_MS }, err => {
      if (err?.killed) return resolve({ ok: false, error: 'The install took too long and was stopped.' });
      resolve(installOutcome(err ? err.code : 0));
    });
  });
}

/**
 * Make sure OpenRGB's server is answering: probe, and if nothing's there but
 * OpenRGB is installed, start it and wait for the port to open.
 *   probe: () => Promise<{ ok }>
 *   -> { ok, started? } | { ok: false, missing: true } | { ok: false, error }
 */
async function ensureRunning({ probe, port = DEFAULT_PORT, find = findOpenRgb, launch = launchOpenRgb, isStarting = stillStarting, wait = ms => new Promise(r => setTimeout(r, ms)), tries = 90, everyMs = 1000 }) {
  const first = await probe();
  if (first.ok) return first;
  const exe = find();
  if (!exe) return { ok: false, missing: true, error: 'OpenRGB isn\'t installed yet.' };
  // Ours is still scanning: wait for it rather than start a rival.
  if (!isStarting() && !launch(exe, port)) return { ok: false, error: "Couldn't start OpenRGB." };
  // It scans every controller before the server opens: seconds for USB, a minute or more over SMBus.
  for (let i = 0; i < tries; i++) {
    await wait(everyMs);
    const r = await probe();
    if (r.ok) return { ...r, started: true };
  }
  return { ok: false, error: 'OpenRGB is running (its icon is in the tray, under ^) but its SDK server hasn\'t answered. If it\'s still finding devices, give it a minute and test again; otherwise open it from the tray and turn on Settings → SDK Server.' };
}

module.exports = { WINGET_ID, INSTALL_ARGS, candidates, findOpenRgb, launchArgs, launchOpenRgb, installOutcome, installOpenRgb, ensureRunning };
