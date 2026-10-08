// Tiny git lookups: which repo a folder belongs to and when it was last
// committed to (streaks), and its branch and changed files (the chip under the
// tab strip). execFile with fixed arguments (no shell), short timeouts,
// never throws: anything that isn't a git repo is just null.
const { execFile } = require('child_process');
const path = require('path');

function git(args, timeout = 5000, maxBuffer = 64 * 1024) {
  return new Promise(resolve => {
    execFile('git', args, { windowsHide: true, timeout, maxBuffer }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
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

const MAX_CHANGED = 200;

/**
 * `git status --porcelain=v1 -b -z` -> { branch, upstream, ahead, behind, detached, files: [{ code, path }] }.
 * code is the two status letters ("M ", " M", "??", "R " …); paths are relative to the repo root.
 */
function parseStatus(out) {
  const entries = String(out || '').split('\0');
  const head = entries[0]?.startsWith('## ') ? entries.shift().slice(3) : '';
  const r = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false, files: [], more: 0 };
  const m = head.match(/^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
  if (head.startsWith('HEAD (no branch)')) r.detached = true;
  else if (m) {
    r.branch = m[1];
    r.upstream = m[2] || null;
    r.ahead = Number(m[3]?.match(/ahead (\d+)/)?.[1] || 0);
    r.behind = Number(m[3]?.match(/behind (\d+)/)?.[1] || 0);
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const code = e.slice(0, 2);
    if (r.files.length < MAX_CHANGED) r.files.push({ code, path: e.slice(3) });
    else r.more++;
    if (code[0] === 'R' || code[0] === 'C') i++; // the next entry is where it was renamed or copied from
  }
  return r;
}

/** The branch and changed files of the repo containing `dir`, or null outside a repo. */
async function statusOf(dir) {
  const repo = await repoOf(dir);
  if (!repo) return null;
  const out = await git(['-C', repo.root, 'status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'], 5000, 8 * 1024 * 1024);
  if (out == null) return null;
  return { root: repo.root, name: repo.name, ...parseStatus(out) };
}

module.exports = { repoOf, lastCommitAt, parseStatus, statusOf };
