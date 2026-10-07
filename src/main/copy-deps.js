// A new copy of the repository (worktrees.js) has every committed file but no
// node_modules, so the first test run in it fails until someone installs. When
// your own checkout already has them, the copy gets the same packages from the
// lockfile before the conversation carries on there.
//
// The repository is a folder anyone could have written, and this runs without
// asking, so nothing of it runs: `npm ci --ignore-scripts` (no install, prepare
// or postinstall scripts), npm found by absolute path with no shell, and an
// environment with no tokens for a project's .npmrc to send anywhere
// (depwatch.js findNpm and npmEnv). Only projects you've installed yourself, so
// the packages are ones you've already trusted on this PC.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findNpm, npmEnv } = require('./depwatch');

const INSTALL_MS = 3 * 60 * 1000;
const ARGS = ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'];

const lastLine = s => String(s || '').trim().split('\n').map(l => l.trim()).filter(Boolean).pop() || '';

/**
 * Where in the copy to install, or null: the tab's own folder or the copy's
 * top, whichever has a package-lock.json first, as long as the same folder in
 * your checkout has node_modules and the copy doesn't yet. Pure but for fs.
 *   w: the worktree record (path, cwd, root)
 */
function installDir(w, { exists = fs.existsSync } = {}) {
  for (const dir of [...new Set([w.cwd, w.path])]) {
    if (!dir || !exists(path.join(dir, 'package-lock.json'))) continue;
    const mine = path.join(w.root, path.relative(w.path, dir));
    return exists(path.join(mine, 'node_modules')) && !exists(path.join(dir, 'node_modules')) ? dir : null;
  }
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
 * Install the copy's packages if it needs them.
 * -> { installed: true, dir } | { installed: false, error, dir } | { skipped: true }
 */
async function installCopyDeps(w, { exists, find = findNpm, run = runNpm } = {}) {
  const dir = installDir(w, { exists });
  if (!dir) return { skipped: true };
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
  return "It has every committed file; anything uncommitted or ignored in the original (node_modules, build output) isn't in it. ";
}

module.exports = { installCopyDeps, installDir, depsSentence, ARGS };
