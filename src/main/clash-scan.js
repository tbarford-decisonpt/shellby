// What each copy has changed, for clash warnings (clash.js does the comparing).
//
// Cheap on purpose, since it runs after every turn in a copy: names only, no
// diffs. A copy's changes are what its branch has committed since it left the
// branch it goes home to, plus anything uncommitted or untracked in its
// folder. Your checkout's are only what's uncommitted: that's what a merge
// would refuse to run over.
//
// worktrees.git: execFile with fixed arguments, fsmonitor off, a timeout, and
// nothing thrown. A folder that's gone, or git that won't answer, is null.
const fs = require('fs');
const { parseNamesZ, parseStatusZ } = require('./clash');
const worktrees = require('./worktrees');

const SCAN_TIMEOUT_MS = 15000;
// Optional locks off: git status otherwise writes a refreshed index under
// index.lock, and a git command Claude runs at the same moment would fail.
const OPTS = { timeout: SCAN_TIMEOUT_MS, env: { GIT_OPTIONAL_LOCKS: '0' } };

const statusOf = dir => worktrees.git(dir, ['status', '--porcelain', '-z', '--untracked-files=all'], OPTS);

/** A copy (tab.worktree) -> [path] it has changed, or null if it can't be read. */
async function changedInCopy(w) {
  if (worktrees.checkWorktree(w) || !fs.existsSync(w.path)) return null;
  const [committed, dirty] = await Promise.all([
    worktrees.git(w.path, ['diff', '--name-only', '-z', '--no-renames', `${w.base}...HEAD`, '--'], OPTS),
    statusOf(w.path),
  ]);
  if (!committed.ok && !dirty.ok) return null;
  return [...new Set([...(committed.ok ? parseNamesZ(committed.out) : []), ...(dirty.ok ? parseStatusZ(dirty.out) : [])])];
}

/** Your checkout -> { branch, files } uncommitted there, or null. */
async function changedInCheckout(root) {
  if (typeof root !== 'string' || !fs.existsSync(root)) return null;
  const [dirty, head] = await Promise.all([
    statusOf(root),
    worktrees.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], OPTS),
  ]);
  if (!dirty.ok) return null;
  return { branch: head.ok ? head.out.trim() || null : null, files: parseStatusZ(dirty.out) };
}

module.exports = { changedInCopy, changedInCheckout, SCAN_TIMEOUT_MS };
