// Tiny git lookups for streaks: which repo a folder belongs to, and when it was
// last committed to. execFile with fixed arguments (no shell), short timeouts,
// never throws: anything that isn't a git repo is just null.
const { execFile } = require('child_process');
const path = require('path');

function git(args, timeout = 5000) {
  return new Promise(resolve => {
    execFile('git', args, { windowsHide: true, timeout, maxBuffer: 64 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

/** { root, key, name } for the repo containing `dir`, or null. key is case-folded on Windows. */
async function repoOf(dir) {
  if (typeof dir !== 'string' || !dir || dir.length > 400 || !path.isAbsolute(dir)) return null;
  const top = await git(['-C', dir, 'rev-parse', '--show-toplevel']);
  if (!top) return null;
  const root = path.resolve(top);
  return { root, key: process.platform === 'win32' ? root.toLowerCase() : root, name: path.basename(root) };
}

/** Newest commit time in ms (any branch's HEAD as checked out), or null. */
async function lastCommitAt(root) {
  const out = await git(['-C', root, 'log', '-1', '--format=%ct']);
  const s = Number(out);
  return Number.isFinite(s) && s > 0 ? s * 1000 : null;
}

module.exports = { repoOf, lastCommitAt };
