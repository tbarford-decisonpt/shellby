// Tiny git lookups for streaks and stickers: which repo a folder belongs to,
// when it was last committed to, and what a shipped project is. execFile with
// fixed arguments (no shell), short timeouts, never throws: anything that isn't
// a git repo is just null.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { normalizeRemote, projectId } = require('./stickers');

const STICKER_FILE_MAX = 16 * 1024;
const LS_FILES_MAX = 5000;

function git(args, timeout = 5000, maxBuffer = 64 * 1024) {
  return new Promise(resolve => {
    // fsmonitor off: a repository's config must not choose a program for us to run.
    execFile('git', ['-c', 'core.fsmonitor=false', ...args], { windowsHide: true, timeout, maxBuffer }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

// A local folder only: never a network share (git would reach out to it) or a device path.
const okDir = dir => typeof dir === 'string' && !!dir && dir.length <= 400 && path.isAbsolute(dir) && !/^[\\/]{2}/.test(dir);

/** { root, key, name } for the repo containing `dir`, or null. key is case-folded on Windows. */
async function repoOf(dir) {
  if (!okDir(dir)) return null;
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

/**
 * The project a folder belongs to, for stickers: { id, root, name, remote }.
 * A git worktree (like the copies Shellby makes for tabs) resolves to the
 * repository it was made from, so a copy never counts as a project of its own.
 */
async function projectOf(dir) {
  const repo = await repoOf(dir);
  if (!repo) return null;
  let root = repo.root;
  const common = await git(['-C', repo.root, 'rev-parse', '--git-common-dir']);
  if (common) {
    const abs = path.resolve(repo.root, common);
    if (path.basename(abs).toLowerCase() === '.git') root = path.dirname(abs);
  }
  const url = await git(['-C', root, 'config', '--get', 'remote.origin.url']);
  const remote = normalizeRemote(url);
  const name = (remote ? remote.split('/').pop() : path.basename(root)) || path.basename(root);
  return { id: projectId(remote, root), root, name, remote };
}

/** Up to 5,000 tracked file names (for working out the language), or []. */
async function trackedFiles(root) {
  const out = await git(['-C', root, 'ls-files'], 3000, 4 * 1024 * 1024);
  return out ? out.split('\n').slice(0, LS_FILES_MAX) : [];
}

/**
 * The repo's own sticker, .shellby/sticker.json, as parsed JSON (stickers.js
 * validates it), or null. Small files only, never followed out of the repo.
 */
async function stickerFile(root) {
  let handle = null;
  try {
    const file = path.join(root, '.shellby', 'sticker.json');
    // Where it really is, links and junctions followed, must still be inside the repo.
    const [real, realRoot] = await Promise.all([fs.promises.realpath(file), fs.promises.realpath(root)]);
    if (!real.toLowerCase().startsWith(realRoot.toLowerCase() + path.sep)) return null;
    handle = await fs.promises.open(real, 'r');
    if (!(await handle.stat()).isFile()) return null;
    const buf = Buffer.alloc(STICKER_FILE_MAX + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead > STICKER_FILE_MAX) return null;
    return JSON.parse(buf.toString('utf8', 0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// "2026-09-29 04:00:00 +0000": a date every git parses the same way.
const gitDate = ms => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000');
const COMMITS_MAX = 1000;

/**
 * Your commits on any local branch between two times (ms), oldest first:
 * [{ at, subject }]. "Yours" is the repo's user.email when there is one. For
 * the time tracker's invoice lines and estimates (timetrack.js).
 */
async function commitsBetween(root, from, to) {
  if (!okDir(root) || !Number.isFinite(from) || !Number.isFinite(to)) return [];
  const [email, out] = await Promise.all([
    git(['-C', root, 'config', '--get', 'user.email']),
    git(['-C', root, 'log', '--branches', '--no-merges', `-n${COMMITS_MAX}`, `--since=${gitDate(from)}`, `--until=${gitDate(to)}`, '--format=%ct%x09%ae%x09%s'], 8000, 1024 * 1024),
  ]);
  if (!out) return [];
  const me = (email || '').toLowerCase();
  return out.split('\n').map(line => {
    const [ct, author, ...rest] = line.split('\t');
    // Anyone who can push writes these: no control, bidi or zero-width characters.
    const subject = rest.join('\t').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, ' ').trim().slice(0, 200);
    return { at: Number(ct) * 1000, author: (author || '').toLowerCase(), subject };
  }).filter(c => Number.isFinite(c.at) && c.at >= from && c.at < to && (!me || c.author === me))
    .map(({ at, subject }) => ({ at, subject })).sort((a, b) => a.at - b.at);
}

/** The git reflogs that change when HEAD moves anywhere in the repo (commit, checkout, pull), worktrees included. */
async function headLogs(root) {
  if (!okDir(root)) return [];
  const gitDir = path.join(root, '.git');
  const out = [path.join(gitDir, 'logs', 'HEAD')];
  try {
    for (const e of await fs.promises.readdir(path.join(gitDir, 'worktrees'), { withFileTypes: true })) {
      if (e.isDirectory()) out.push(path.join(gitDir, 'worktrees', e.name, 'logs', 'HEAD'));
    }
  } catch { /* no worktrees */ }
  return out.slice(0, 20);
}

/** git's user.name, for "Prepared by" on a timesheet, or ''. */
async function userName() {
  return (await git(['config', '--global', '--get', 'user.name'])) || '';
}

module.exports = { repoOf, lastCommitAt, projectOf, trackedFiles, stickerFile, commitsBetween, headLogs, userName, gitDate };
