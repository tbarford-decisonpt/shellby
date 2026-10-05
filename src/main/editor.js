// "Open in VS Code": one file of a turn's diff in VS Code's own diff view.
//
// The renderer names a file of a change main reported (main.js changeRef), and
// nothing else: both sides are read out of git here, into a temp folder of
// Shellby's own with names made safe, and VS Code is started with fixed
// arguments. When the file in the project is still exactly as the turn left
// it, the right side is that real file, so an edit made in the diff lands in
// the project.
//
// code.cmd is a batch file, so cmd.exe runs it (a .cmd can't be started on its
// own), and every path on that line is one Shellby made or checked for
// characters cmd would read as anything but a path. The pickers are pure;
// open() never throws.
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CMD } = require('./system32');
const { checkRef } = require('./changes');

const TEMP_NAME = 'shellby-vsdiff';
const MAX_BLOB = 50 * 1024 * 1024;
const MAX_TEMP_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_NAME = 80;
// Characters that mean something to cmd.exe even inside quotes (or that a
// Windows path can't hold anyway): such a path is never put on a command line.
const UNSAFE_PATH_RE = /["%!^\r\n\0]/;

/**
 * Where VS Code (or Insiders, or Cursor) keeps its command-line launcher, in
 * the order to try. PATH entries first, then the usual install folders. Pure.
 */
function editorCandidates(env = process.env) {
  const out = [];
  const add = p => { if (p && path.isAbsolute(p) && !out.some(o => o.toLowerCase() === p.toLowerCase())) out.push(p); };
  const names = ['code.cmd', 'code-insiders.cmd', 'cursor.cmd'];
  for (const dir of String(env.PATH || env.Path || '').split(';').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    if (!path.isAbsolute(dir)) continue; // a relative PATH entry means "wherever we happen to be"
    for (const n of names) add(path.join(dir, n));
  }
  const local = env.LOCALAPPDATA;
  const pf = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
  if (local) add(path.join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'));
  for (const p of pf) add(path.join(p, 'Microsoft VS Code', 'bin', 'code.cmd'));
  if (local) add(path.join(local, 'Programs', 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'));
  for (const p of pf) add(path.join(p, 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'));
  if (local) add(path.join(local, 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd'));
  return out;
}

/** The first launcher that exists and can go on a command line, or null. */
function findEditor(env = process.env, exists = p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) {
  return editorCandidates(env).find(p => !UNSAFE_PATH_RE.test(p) && exists(p)) || null;
}

/** A file's name, made safe for a temp file: letters, digits, dot, dash, underscore. Pure. */
function safeName(file) {
  const base = String(file || '').split(/[\\/]/).pop() || '';
  const clean = base.replace(/[^\w.-]/g, '_').replace(/^\.+/, '').replace(/\.{2,}/g, '.').slice(-MAX_NAME);
  return clean && !/^[_.-]*$/.test(clean) ? clean : 'file';
}

/** cmd's command line for `code --diff a b`. Every path is ours and already checked. Pure. */
function diffCommandLine(editor, left, right) {
  for (const p of [editor, left, right]) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || UNSAFE_PATH_RE.test(p)) return null;
  }
  return `""${editor}" --diff "${left}" "${right}""`;
}

/** Temp folders from earlier runs that are past a day old. entries: [{ name, mtimeMs }]. Pure. */
function staleTemp(entries, now = Date.now(), maxAgeMs = MAX_TEMP_AGE_MS) {
  return (entries || []).filter(e => e && /^[0-9a-f]{12}$/.test(e.name) && now - e.mtimeMs > maxAgeMs).map(e => e.name);
}

function tidyTemp(base, now = Date.now()) {
  try {
    const entries = fs.readdirSync(base).map(name => ({ name, mtimeMs: fs.statSync(path.join(base, name)).mtimeMs }));
    for (const name of staleTemp(entries, now)) fs.rmSync(path.join(base, name), { recursive: true, force: true });
  } catch { /* nothing there yet */ }
}

/** One file as it was in a snapshot tree, as bytes; an empty buffer when it isn't there. */
function blobAt(root, tree, file) {
  return new Promise(resolve => {
    execFile('git', ['-C', root, 'cat-file', 'blob', `${tree}:${file.replace(/\\/g, '/')}`], {
      windowsHide: true, timeout: 20000, maxBuffer: MAX_BLOB, encoding: 'buffer',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/**
 * Open one file of a change in the editor's diff.
 *   ref: { root, before, after, file, status } from changeRef (status: A, M, D…)
 * -> { ok: true, live } | { ok: false, error, notFound? }
 */
async function open(ref, { env = process.env, spawnImpl = spawn, tmp = os.tmpdir(), editor = undefined } = {}) {
  const bad = checkRef(ref);
  if (bad || !ref.file) return { ok: false, error: bad || 'Not a file in this change.' };
  const code = editor === undefined ? findEditor(env) : editor;
  if (!code) return { ok: false, notFound: true, error: "Shellby couldn't find VS Code on this PC. Install it (or tick \"Add to PATH\" when you do), then try again." };
  const base = path.join(tmp, TEMP_NAME);
  tidyTemp(base);
  const [before, after] = await Promise.all([
    ref.status === 'A' ? Buffer.alloc(0) : blobAt(ref.root, ref.before, ref.file),
    ref.status === 'D' ? Buffer.alloc(0) : blobAt(ref.root, ref.after, ref.file),
  ]);
  if (!before || !after) return { ok: false, error: 'Those changes have been tidied away by git since.' };
  const dir = path.join(base, crypto.randomBytes(6).toString('hex'));
  const name = safeName(ref.file);
  const left = path.join(dir, `before-${name}`);
  let right = path.join(dir, `after-${name}`);
  // The file in the project, if it's still what the turn left: edits land in the real thing.
  const real = path.resolve(ref.root, ref.file);
  let live = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(left, before);
    const inside = real.toLowerCase().startsWith(path.resolve(ref.root).toLowerCase() + path.sep);
    if (inside && ref.status !== 'D' && !UNSAFE_PATH_RE.test(real) && fs.existsSync(real) && fs.statSync(real).size === after.length && fs.readFileSync(real).equals(after)) {
      right = real;
      live = true;
    } else {
      fs.writeFileSync(right, after);
    }
  } catch (e) {
    return { ok: false, error: `Couldn't write the two sides: ${e.message}` };
  }
  const line = diffCommandLine(code, left, right);
  if (!line) return { ok: false, error: 'That path has characters Shellby won\'t hand to the command line.' };
  try {
    const child = spawnImpl(CMD, ['/d', '/s', '/c', line], {
      cwd: dir, windowsHide: true, windowsVerbatimArguments: true, detached: true, stdio: 'ignore',
      env: { ...env, NoDefaultCurrentDirectoryInExePath: '1', ELECTRON_RUN_AS_NODE: undefined },
    });
    child.on?.('error', () => {});
    child.unref?.();
  } catch (e) {
    return { ok: false, error: `Couldn't start VS Code: ${e.message}` };
  }
  return { ok: true, live };
}

module.exports = { editorCandidates, findEditor, safeName, diffCommandLine, staleTemp, open, UNSAFE_PATH_RE, TEMP_NAME };
