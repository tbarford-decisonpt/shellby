// What the reef reads from a project's folder (docs/REEF.md), and nothing more:
// `git grep` over what's committed, `git diff --shortstat` against the commit the
// count started from, and coverage files a test run already wrote. execFile
// with fixed arguments (no shell), hidden windows, short timeouts, the repo's
// fsmonitor switched off, never a program from the project; never throws.
// Nothing here runs the project's code. The counting is in reef/signals.js.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const signals = require('./signals');
const detail = require('./detail');

const TIMEOUT_MS = 5000;
const MAX_TRACKED = 20000;          // bigger repos aren't grepped at all
const GREP_BUFFER = 8 * 1024 * 1024;
const MAX_COVERAGE_BYTES = 5 * 1024 * 1024;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
// What's never counted: other people's code and built files.
const EXCLUDE = [':!node_modules', ':!vendor', ':!dist', ':!build', ':!*.min.*', ':!third_party'];

// Never a program the repository chooses: no fsmonitor, no hooks, no external
// diff or textconv drivers, and no optional locks taken on its index.
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '--no-optional-locks'];
const NO_DRIVERS = ['--no-ext-diff', '--no-textconv'];

/** The full argument list for one git command in `root` (exported for test/reef-probe.test.js). */
function gitArgs(root, args) {
  const [cmd, ...rest] = args;
  const drivers = cmd === 'diff' ? NO_DRIVERS : cmd === 'grep' ? ['--no-textconv'] : [];
  return [...SAFE_CONFIG, '-C', root, cmd, ...drivers, ...rest];
}

function git(root, args, { timeout = TIMEOUT_MS, maxBuffer = 1024 * 1024 } = {}) {
  return new Promise(resolve => {
    execFile('git', gitArgs(root, args), { windowsHide: true, timeout, maxBuffer }, (err, stdout) => {
      // git grep says 1 when nothing matched: that's a count of 0, not a failure.
      if (err && !(args[0] === 'grep' && err.code === 1)) return resolve(null);
      resolve(String(stdout || ''));
    });
  });
}

// A local folder only: never a network share (git would reach out to it) or a device path.
const okDir = dir => typeof dir === 'string' && !!dir && dir.length <= 400 && path.isAbsolute(dir) && !/^[\\/]{2}/.test(dir);

/** HEAD's commit, or null. */
async function headOf(root) {
  if (!okDir(root)) return null;
  const out = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD']))?.trim();
  return out && /^[0-9a-f]{40}$/.test(out) ? out : null;
}

/** How many files git tracks, or null. */
async function trackedCount(root) {
  const out = await git(root, ['ls-files', '-z'], { maxBuffer: 32 * 1024 * 1024 });
  return out === null ? null : out.split('\0').filter(Boolean).length;
}

/**
 * Escape hatches (ts-ignore, any, eslint-disable, noqa…) in HEAD's tracked text
 * files: -> { count, head, detail: { files, kinds } } | { skipped: 'too-big' | 'no-repo' | 'failed' }.
 */
async function escapes(root) {
  const head = await headOf(root);
  if (!head) return { skipped: 'no-repo' };
  const files = await trackedCount(root);
  if (files === null) return { skipped: 'failed' };
  if (files > MAX_TRACKED) return { skipped: 'too-big' };
  // Each line comes as "<head>:<path>:<text>": the path is kept for Fix this, the text never is.
  const out = await git(root, ['grep', '-I', '-E', '--no-color', signals.ESCAPE_GREP, head, '--', '.', ...EXCLUDE], { maxBuffer: GREP_BUFFER });
  if (out === null) return { skipped: 'failed' };
  const scan = detail.escapeScan(out, head);
  return { count: scan.count, head, detail: { files: scan.files, kinds: scan.kinds } };
}

/**
 * The share of the code deleted since `base` (0 to 1): lines deleted since then
 * over every line `base` had. 0 when either commit can't be read.
 */
async function deletedShare(root, base, head) {
  if (!okDir(root) || !/^[0-9a-f]{40}$/.test(base || '') || !/^[0-9a-f]{40}$/.test(head || '') || base === head) return 0;
  const [all, since] = await Promise.all([
    git(root, ['diff', '--shortstat', '--no-renames', EMPTY_TREE, base, '--', '.', ...EXCLUDE]),
    git(root, ['diff', '--shortstat', '--no-renames', base, head, '--', '.', ...EXCLUDE]),
  ]);
  const total = signals.shortstat(all).insertions;
  return total > 0 ? signals.shortstat(since).deletions / total : 0;
}

/**
 * Line coverage from the first coverage file that's there, read only when it's
 * newer than `sinceMtime` and under 5 MB: -> { pct, mtime, file, files: [[path, pct, uncovered]] } | null.
 * Never follows a link out of the repo.
 */
async function coverage(root, sinceMtime = 0) {
  if (!okDir(root)) return null;
  let realRoot;
  try { realRoot = await fs.promises.realpath(root); } catch { return null; }
  for (const [rel, parse] of signals.COVERAGE_FILES) {
    const file = path.join(root, rel);
    try {
      const real = await fs.promises.realpath(file);
      if (!real.toLowerCase().startsWith(realRoot.toLowerCase() + path.sep)) continue;
      const st = await fs.promises.stat(real);
      if (!st.isFile() || st.size > MAX_COVERAGE_BYTES) continue;
      if (st.mtimeMs <= sinceMtime) return null; // the newest file hasn't changed: nothing new to read
      const text = await fs.promises.readFile(real, 'utf8');
      const pct = parse(text);
      if (pct !== null) return { pct, mtime: st.mtimeMs, file: rel, files: detail.coverageFiles(rel, text, root) };
    } catch { /* not there */ }
  }
  return null;
}

module.exports = { gitArgs, escapes, deletedShare, coverage, headOf, MAX_TRACKED, TIMEOUT_MS, MAX_COVERAGE_BYTES };
