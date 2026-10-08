// A new copy of the repository (worktrees.js) has every committed file but no
// node_modules, so the first test run in it fails until someone installs. When
// your own checkout already has exactly these packages installed, the copy
// gets the same ones before the conversation carries on there.
//
// The repository is a folder anyone could have written, and this runs without
// asking, so nothing of it may run:
//   - `npm ci --ignore-scripts`, npm found by absolute path with no shell, and
//     an environment with no tokens for a project's .npmrc to send anywhere
//     (depwatch.js findNpm and npmEnv).
//   - Only registry tarballs. --ignore-scripts doesn't cover a git dependency:
//     npm still runs its `prepare` to build it. A lockfile with any git, file
//     or plain-http package is left for you (or Claude, asking) to install.
//   - Only what you've installed yourself: the copy's lockfile is the one in
//     your checkout, byte for byte, and your node_modules was installed after
//     that lockfile last changed (or already holds every package it names,
//     the same tarball). Then the copy gets nothing you haven't already got
//     on this PC.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findNpm, npmEnv } = require('./depwatch');

const INSTALL_MS = 3 * 60 * 1000;
const ARGS = ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'];
const LOCK = 'package-lock.json';
const HIDDEN_LOCK = path.join('node_modules', '.package-lock.json'); // npm writes it on every install

const lastLine = s => String(s || '').trim().split('\n').map(l => l.trim()).filter(Boolean).pop() || '';
const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const inside = (p, dir) => (path.resolve(p) + path.sep).toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep);

/**
 * Does installing this lockfile fetch only registry tarballs? Workspace links
 * (link: true) are fine: they point inside the project and run nothing. Pure.
 */
function registryOnly(lockText) {
  let lock;
  try { lock = JSON.parse(lockText); } catch { return false; }
  if (!lock || typeof lock.packages !== 'object' || !lock.packages) return false;
  return Object.entries(lock.packages).every(([key, p]) => {
    if (key === '' || !p || typeof p !== 'object') return true;
    if (p.link === true) return typeof p.resolved === 'string' && !/^[a-z][a-z+]*:/i.test(p.resolved) && !path.isAbsolute(p.resolved);
    if (p.resolved === undefined) return p.inBundle === true; // bundled with its parent, which came from the registry
    return typeof p.resolved === 'string' && /^https:\/\//i.test(p.resolved);
  });
}

/**
 * Is every package in this lockfile already installed, the very same tarball,
 * per the record npm keeps in node_modules (`installed`)? Then installing it
 * gets nothing new onto this PC. Pure.
 */
function installedAlready(lockText, installedText) {
  let lock;
  let have;
  try { lock = JSON.parse(lockText); have = JSON.parse(installedText); } catch { return false; }
  if (!lock?.packages || typeof lock.packages !== 'object' || !have?.packages || typeof have.packages !== 'object') return false;
  return Object.entries(lock.packages).every(([key, p]) => {
    if (key === '') return true;
    const h = have.packages[key];
    if (!p || !h) return false;
    return p.link === true ? h.link === true && h.resolved === p.resolved : !!p.integrity && h.integrity === p.integrity && h.resolved === p.resolved;
  });
}

/**
 * Where in the copy to install, or null: the tab's own folder or the copy's
 * top, whichever has a package-lock.json first, as long as the same folder in
 * your checkout has node_modules and the copy doesn't yet.
 *   w: the worktree record (path, cwd, root)
 */
function installDir(w, { exists = fs.existsSync } = {}) {
  for (const dir of [...new Set([w.cwd, w.path])]) {
    if (!dir || !exists(path.join(dir, LOCK))) continue;
    const mine = path.join(w.root, path.relative(w.path, dir));
    return exists(path.join(mine, 'node_modules')) && !exists(path.join(dir, 'node_modules')) ? dir : null;
  }
  return null;
}

/**
 * Why the copy in `dir` shouldn't be installed, or null when it can be: the
 * reasons above, read from the files. -> string | null
 */
function refusal(w, dir) {
  const mine = path.join(w.root, path.relative(w.path, dir));
  const copyLock = path.join(dir, LOCK);
  if (isLink(copyLock) || isLink(dir)) return 'its package-lock.json is a link';
  let real;
  try { real = fs.realpathSync.native(dir); } catch { return "the folder couldn't be read"; }
  if (!inside(real, fs.realpathSync.native(w.path)) && path.resolve(dir) !== path.resolve(w.path)) return 'the folder leads outside the copy';
  let text;
  let theirs;
  try { text = fs.readFileSync(copyLock, 'utf8'); theirs = fs.readFileSync(path.join(mine, LOCK), 'utf8'); } catch { return "your checkout's package-lock.json couldn't be read"; }
  if (text !== theirs) return "its package-lock.json isn't the one installed in your checkout";
  try {
    // A pull that brought a new lockfile, with no install since. Still fine
    // when every package it names is one your checkout already has.
    if (fs.statSync(path.join(mine, HIDDEN_LOCK)).mtimeMs < fs.statSync(path.join(mine, LOCK)).mtimeMs
      && !installedAlready(text, fs.readFileSync(path.join(mine, HIDDEN_LOCK), 'utf8'))) {
      return "package-lock.json changed after you last installed, and names packages your checkout doesn't have (npm ci there, and the next copies get them)";
    }
  } catch { return "your checkout's node_modules wasn't installed by npm"; }
  if (!registryOnly(text)) return 'it has packages from git or a folder, which npm would build by running their scripts';
  return null;
}

function runNpm(npm, cwd) {
  return new Promise(resolve => {
    try {
      execFile(npm.file, [...npm.pre, ...ARGS], {
        cwd, shell: false, windowsHide: true, timeout: INSTALL_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: npmEnv(npm),
      }, (err, _stdout, stderr) => resolve(err
        ? { ok: false, error: err.killed ? 'npm took too long' : lastLine(stderr) || err.message }
        : { ok: true }));
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

/**
 * Install the copy's packages if it needs them and may have them.
 * -> { installed: true, dir } | { installed: false, error, dir } | { skipped: true, why?, dir? }
 */
async function installCopyDeps(w, { exists, check = refusal, find = findNpm, run = runNpm } = {}) {
  const dir = installDir(w, { exists });
  if (!dir) return { skipped: true };
  const why = check(w, dir);
  if (why) return { skipped: true, why, dir };
  const npm = find();
  if (!npm) return { installed: false, dir, error: "npm isn't on PATH" };
  const r = await run(npm, dir);
  return r.ok ? { installed: true, dir } : { installed: false, dir, error: r.error };
}

/** The sentence about packages in what Claude is told when it moves into the copy. Pure. */
function depsSentence(result, w) {
  const where = result.dir && path.resolve(result.dir) !== path.resolve(w.path) ? ` in ${result.dir}` : '';
  if (result.installed) {
    return `It has every committed file, and Shellby has run \`npm ci --ignore-scripts\`${where}, so node_modules is there but no package's install script has run (a binary some packages download then, say). `
      + "Anything else uncommitted or ignored in the original (build output, .env files) isn't in it. ";
  }
  if (result.error) {
    return `It has every committed file. Shellby tried \`npm ci --ignore-scripts\`${where} and it failed (${result.error}), so install the dependencies yourself if you need them. `
      + "Anything else uncommitted or ignored in the original isn't in it either. ";
  }
  if (result.why) {
    return `It has every committed file but no node_modules: Shellby didn't install them${where} because ${result.why}. Ask before installing them yourself. `
      + "Anything else uncommitted or ignored in the original isn't in it either. ";
  }
  return "It has every committed file; anything uncommitted or ignored in the original (node_modules, build output) isn't in it. ";
}

module.exports = { installCopyDeps, installDir, refusal, registryOnly, installedAlready, depsSentence, ARGS };
