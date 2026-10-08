// The git repositories on this PC that the Projects page shows. Shellby never
// goes looking on its own: the list is the projects he already knows (streaks,
// stickers) plus the ones you added. "Scan a folder" looks through one folder
// you picked, once, and returns what it found for you to choose from; it adds
// nothing itself.
//
// Every git call goes through the runner it's given (tests pass a fake), with
// fixed arguments and no shell (leaving.js git()). Nothing here throws.
const fs = require('fs');
const path = require('path');
const { git, mainRoot, okDir } = require('../leaving');
const { githubRepoOf } = require('./remote');
const { forgeRepoOf } = require('../gitlab/remote');

const SCAN_DEPTH = 2;
const SCAN_MAX = 200;           // repos found before the scan stops
const SCAN_DIRS_MAX = 5000;     // folders looked at before the scan stops
// Folders that are never a repo you'd want listed, and can be huge.
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', 'appdata', 'windows', 'program files', 'program files (x86)']);

/**
 * One folder -> { root, name, remote, forge, branch } for the repository it belongs to, or null.
 * remote: "owner/name" on GitHub. forge: { host, path } when origin is somewhere else
 * (a GitLab, say: gitlab/remote.js decides which hosts are).
 */
async function readRepo(dir, run = git) {
  if (!okDir(dir)) return null;
  const root = await mainRoot(dir, run);
  if (!root) return null;
  const [remote, branch] = await Promise.all([
    run(['-C', root, 'remote', 'get-url', 'origin']),
    run(['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']),
  ]);
  const github = githubRepoOf(remote?.trim());
  return {
    root,
    name: path.basename(root),
    remote: github,
    forge: github ? null : forgeRepoOf(remote?.trim()),
    branch: branch?.trim() && branch.trim() !== 'HEAD' ? branch.trim().slice(0, 120) : null,
  };
}

/** Many folders -> repos, deduplicated by the main checkout's root, a few at a time. */
async function readRepos(dirs, run = git, { concurrency = 4 } = {}) {
  const queue = [...new Set((dirs || []).filter(okDir))];
  const byRoot = new Map();
  const worker = async () => {
    while (queue.length) {
      const r = await readRepo(queue.shift(), run).catch(() => null);
      if (r) byRoot.set(process.platform === 'win32' ? r.root.toLowerCase() : r.root, r);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return [...byRoot.values()];
}

const isRepo = dir => { try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; } };

/**
 * The repositories inside `parent` (itself, its children, their children),
 * without going into a repository once found. -> { found: [dir], truncated }.
 * signal: an AbortSignal that stops it early (what was found so far comes back).
 */
async function scanFolder(parent, { signal = null, depth = SCAN_DEPTH, max = SCAN_MAX } = {}) {
  const found = [];
  let looked = 0;
  let truncated = false;
  if (!okDir(parent)) return { found, truncated };
  const walk = async (dir, level) => {
    if (signal?.aborted || found.length >= max || looked >= SCAN_DIRS_MAX) { truncated ||= !signal?.aborted; return; }
    looked++;
    if (isRepo(dir)) { found.push(dir); return; }
    if (level >= depth) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      // Real folders only: a junction or link could lead anywhere, even back here.
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue;
      await walk(path.join(dir, e.name), level + 1);
    }
  };
  await walk(path.resolve(parent), 0);
  return { found, truncated };
}

module.exports = { readRepo, readRepos, scanFolder, SCAN_DEPTH, SCAN_MAX };
