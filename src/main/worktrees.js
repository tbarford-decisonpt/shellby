// A copy of the project for each tab (opt-in).
//
// Two tabs in the same repo used to share one working folder: one tab's edits
// landed under the other's feet, and a diff for "this turn" could include the
// neighbour's work. With this on, a tab's first message in a git project gives
// it its own git worktree: a second checkout of the same repository, on its
// own branch, in Shellby's folder. The tab works there; your checkout is left
// exactly as it was.
//
// "Bring it home" commits whatever the tab left uncommitted, merges its branch
// into the branch it started from, and tidies the copy away. A conflict is
// backed out (git merge --abort) so your checkout is never left half-merged,
// and the tab can be asked to sort it out on its own branch instead.
//
// execFile with fixed arguments, short timeouts, nothing thrown to the caller.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BRANCH = /^shellby\/[a-z0-9-]{1,40}-[0-9a-f]{6}$/;

function git(cwd, args, { timeout = 30000 } = {}) {
  return new Promise(resolve => {
    execFile('git', ['-C', cwd, ...args], {
      windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' },
    }, (err, stdout, stderr) => resolve(err
      ? { ok: false, out: String(stdout || ''), error: String(stderr || err.message).trim() }
      : { ok: true, out: String(stdout) }));
  });
}

// The full spelling of a path that exists (8.3 short names expanded), or the
// path as given if it doesn't yet.
const longPath = p => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

const firstLine = s => String(s || '').trim().split('\n').filter(Boolean).pop() || '';

/** A branch name from a task's title: "Fix the login bug!" -> "shellby/fix-the-login-bug-1a2b3c". Pure. */
function branchName(title, suffix = crypto.randomBytes(3).toString('hex')) {
  const slug = String(title || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'task';
  return `shellby/${slug}-${suffix}`;
}

// ------------------------------------------------------------ when to make one
//
// A conversation starts in your checkout, and only moves into a copy the first
// time it goes to change something. Asking a question makes no branch, and by
// the time one is needed Claude knows enough about the work to name it.

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// Commands that only look. Anything not on this list counts as work, so a
// command Shellby doesn't recognise moves the conversation into its copy
// rather than running in your checkout.
const LOOKS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd', 'pwd', 'echo', 'printf',
  'wc', 'which', 'where', 'tree', 'file', 'stat', 'du', 'df', 'sort', 'cut', 'tr', 'jq', 'diff', 'cd', 'true', 'printenv', 'whoami', 'hostname', 'basename', 'dirname', 'realpath', 'readlink', 'sed',
  'get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'sls', 'get-location', 'set-location', 'test-path', 'resolve-path',
  'get-item', 'measure-object', 'select-object', 'where-object', 'sort-object', 'format-table', 'format-list', 'write-output', 'out-string',
]);
const GIT_LOOKS = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog', 'reflog', 'grep',
  'cat-file', 'merge-base', 'name-rev', 'for-each-ref', 'rev-list', 'whatchanged', 'count-objects',
]);
// Redirects that throw output away rather than writing a file.
const HARMLESS_REDIRECT = /\d?>\s*&\s*\d|\d?>\s*(\/dev\/null|\$null|nul)\b/gi;

function gitLooks(words) {
  let i = 1;
  while (words[i] === '--no-pager' || words[i] === '-C' || /^-c$/.test(words[i])) i += words[i] === '--no-pager' ? 1 : 2;
  const sub = words[i];
  const rest = words.slice(i + 1);
  if (GIT_LOOKS.has(sub)) return true;
  // `git branch foo` and `git tag v1` make one; listing them doesn't.
  if (sub === 'branch') return rest.every(w => /^(-a|-r|-v|-vv|-l|--list|--all|--remotes|--show-current)$/.test(w));
  if (sub === 'tag') return rest.length === 0 || rest.some(w => /^(-l|--list)$/.test(w));
  if (sub === 'remote') return rest.length === 0 || /^(-v|show|get-url)$/.test(rest[0]);
  if (sub === 'config') return rest.some(w => /^(--get|--get-all|--list|-l)$/.test(w));
  if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show';
  return false;
}

/** True when a shell command only reads. Conservative: unsure means no. Pure. */
function onlyLooks(command) {
  const cmd = String(command || '').replace(HARMLESS_REDIRECT, ' ');
  if (!cmd.trim() || /[>`]|\$\(|<\(/.test(cmd)) return false;
  return cmd.split(/&&|\|\||[;|\n]/).every(part => {
    const words = part.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const name = path.basename(words[0].replace(/^["']|["']$/g, '')).toLowerCase().replace(/\.exe$/, '');
    if (name === 'git') return gitLooks(words);
    if (name === 'sed') return !words.some(w => /^-[a-z]*i|^--in-place/.test(w));
    if (name === 'sort') return !words.some(w => /^-[a-z]*o|^--output/.test(w));
    if (name === 'find' || name === 'fd') return !words.some(w => /^-(delete|exec|execdir|ok|fprint)|^--exec/.test(w));
    if (/^(node|npm|python|python3|py|java|go|cargo|dotnet)$/.test(name)) return words.length === 2 && /^(-v|--version|version)$/.test(words[1]);
    return LOOKS.has(name);
  });
}

/** Would this tool call change files? (PreToolUse hook input). Pure. */
function startsWork(toolName, input) {
  if (EDIT_TOOLS.has(toolName)) return true;
  if (SHELL_TOOLS.has(toolName)) return !onlyLooks(input?.command);
  return false;
}

/** The branch name Claude suggested ("Branch: fix-login-redirect"), as a slug, or null. Pure. */
function suggestedName(text) {
  const m = /branch\s*:[\s`*"']*([a-z0-9][a-z0-9/_-]{1,60})/i.exec(String(text || ''));
  const slug = m && m[1].toLowerCase().replace(/^shellby\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || null;
}

/**
 * Claude Code keeps a conversation under <config>/projects/<folder, every
 * character but letters and digits as "-">/<session id>.jsonl, and only
 * resumes it from that folder. Copying it across lets the same conversation
 * carry on in the copy. -> true | false
 */
const projectDirName = dir => path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-');
function carryTranscript({ configDir, sessionId, from, to }) {
  if (!/^[\w-]{8,64}$/.test(sessionId || '')) return false;
  const src = path.join(configDir, 'projects', projectDirName(from));
  const dst = path.join(configDir, 'projects', projectDirName(to));
  try {
    if (!fs.existsSync(path.join(src, `${sessionId}.jsonl`))) return false;
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(path.join(src, `${sessionId}.jsonl`), path.join(dst, `${sessionId}.jsonl`));
    // Subagent transcripts and large tool results live beside it.
    if (fs.existsSync(path.join(src, sessionId))) fs.cpSync(path.join(src, sessionId), path.join(dst, sessionId), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Give a folder in a git repo its own worktree.
 *   dir:  where the tab would have worked (may be a subfolder of the repo)
 *   home: the folder worktrees live under (%APPDATA%/Shellby/worktrees)
 * -> { ok: true, worktree: { path, cwd, branch, base, root, originalCwd } } | { ok: false, error } | null (not a repo)
 */
async function create(dir, { home, title }) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || !fs.existsSync(dir)) return null;
  // Where the folder sits inside the repo, in git's own words: comparing paths
  // here would trip over 8.3 short names (C:\Users\RUNNER~1\...) that git
  // has already expanded.
  const top = await git(dir, ['rev-parse', '--show-toplevel', '--show-prefix'], { timeout: 5000 });
  const [topLine, prefix = ''] = top.ok ? top.out.split(/\r?\n/) : [];
  if (!topLine?.trim()) return null;
  const root = path.resolve(topLine.trim());
  // A tab that already works inside a worktree of ours gets no copy of a copy.
  if ((longPath(root) + path.sep).toLowerCase().startsWith(longPath(home).toLowerCase() + path.sep)) return null;
  const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeout: 5000 });
  if (!head.ok) return { ok: false, error: 'That repository has no commits yet, so there is nothing to copy.' };
  const base = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 5000 });
  if (!base.ok || !base.out.trim()) return { ok: false, error: 'Your checkout is not on a branch (detached HEAD), so there would be nowhere to bring it home to.' };

  const branch = branchName(title);
  // <home>/<suffix>/<repo name>: the folder keeps the project's own name, so
  // streaks, XP and the status line still say "shellby", not "shellby-1a2b3c".
  const wt = path.join(home, branch.slice(-6), path.basename(root));
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const add = await git(root, ['worktree', 'add', '-b', branch, wt, 'HEAD'], { timeout: 120000 });
  if (!add.ok) return { ok: false, error: firstLine(add.error) || "git couldn't make the copy." };
  const rel = prefix.trim().replace(/\/$/, '');
  const cwd = rel ? path.join(wt, ...rel.split('/')) : wt;
  return { ok: true, worktree: { path: wt, cwd: fs.existsSync(cwd) ? cwd : wt, branch, base: base.out.trim(), root, originalCwd: path.resolve(dir) } };
}

/** Checks a worktree record that came back from history or the renderer. -> error | null */
function checkWorktree(w) {
  if (!w || typeof w !== 'object') return 'That conversation has no copy of its own.';
  if (!BRANCH.test(w.branch || '')) return 'That is not one of Shellby\'s branches.';
  for (const k of ['path', 'root']) if (typeof w[k] !== 'string' || !path.isAbsolute(w[k])) return 'That copy has gone missing.';
  if (typeof w.base !== 'string' || !w.base || /^-|\.\.|[\s~^:?*[\\]/.test(w.base)) return 'That copy has no branch to go home to.';
  return null;
}

/** How far the copy has got: uncommitted files, and commits the base doesn't have. */
async function status(w) {
  const bad = checkWorktree(w);
  if (bad) return { ok: false, error: bad };
  if (!fs.existsSync(w.path)) return { ok: false, gone: true, error: 'The copy is gone (deleted outside Shellby).' };
  const [dirty, ahead] = await Promise.all([
    git(w.path, ['status', '--porcelain', '-z', '--ignored=matching'], { timeout: 15000 }),
    git(w.root, ['rev-list', '--count', `${w.base}..${w.branch}`], { timeout: 15000 }),
  ]);
  const entries = dirty.ok ? dirty.out.split('\0').filter(Boolean) : [];
  return {
    ok: true,
    uncommitted: entries.filter(e => !e.startsWith('!! ')).length,
    // Ignored files (node_modules, .env.local, build output) aren't committed,
    // so they go when the copy does.
    ignored: entries.filter(e => e.startsWith('!! ')).map(e => e.slice(3)).slice(0, 5),
    ahead: ahead.ok ? Number(ahead.out.trim()) || 0 : 0,
  };
}

/**
 * Commit what's left in the copy and merge its branch into the base in your
 * checkout. Removing the copy is a separate step (remove()), because the tab's
 * Claude process has to be gone first: Windows won't delete a folder a
 * running process is working in.
 *   -> { ok: true, merged, commits } | { ok: false, error, conflict? }
 */
async function bringHome(w, { message }) {
  const bad = checkWorktree(w);
  if (bad) return { ok: false, error: bad };
  if (!fs.existsSync(w.path)) return { ok: false, error: 'The copy is gone (deleted outside Shellby).' };

  const dirty = await git(w.path, ['status', '--porcelain'], { timeout: 15000 });
  if (dirty.ok && dirty.out.trim()) {
    const add = await git(w.path, ['add', '-A']);
    const commit = add.ok && await git(w.path, ['commit', '-q', '-m', String(message || 'Work from Shellby').slice(0, 200)]);
    if (!commit?.ok) return { ok: false, error: `Couldn't commit the copy's changes: ${firstLine(commit?.error || add.error)}` };
  }

  const ahead = await git(w.root, ['rev-list', '--count', `${w.base}..${w.branch}`], { timeout: 15000 });
  const commits = ahead.ok ? Number(ahead.out.trim()) || 0 : 0;
  if (commits) {
    const on = await git(w.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 5000 });
    if (!on.ok || on.out.trim() !== w.base) {
      return { ok: false, error: `Your checkout is on ${on.out.trim() || 'no branch'} now. Switch back to ${w.base} to bring this home.` };
    }
    const merge = await git(w.root, ['merge', '--no-edit', '-m', `Bring home ${w.branch}`, w.branch], { timeout: 60000 });
    if (!merge.ok) {
      const conflict = /CONFLICT|Automatic merge failed/i.test(merge.out + merge.error);
      if (conflict) await git(w.root, ['merge', '--abort'], { timeout: 15000 });
      return {
        ok: false, conflict,
        error: conflict
          ? `${w.base} has changed in ways that clash with this copy. Nothing was merged.`
          : firstLine(merge.error) || "git couldn't merge it.",
      };
    }
  }
  return { ok: true, merged: commits > 0, commits };
}

/**
 * Remove the copy and its branch. force: also when it has work that was never
 * brought home (Throw away). Without force, an unmerged branch is kept.
 */
async function remove(w, { force = false } = {}) {
  const bad = checkWorktree(w);
  if (bad) return { ok: false, error: bad };
  // --force here only means "even with untracked files" (node_modules and the
  // like); everything worth keeping was committed by bringHome first.
  if (fs.existsSync(w.path)) {
    const r = await git(w.root, ['worktree', 'remove', '--force', w.path], { timeout: 60000 });
    if (!r.ok) return { ok: false, error: firstLine(r.error) || "git couldn't remove the copy." };
  }
  await git(w.root, ['worktree', 'prune'], { timeout: 15000 });
  await git(w.root, ['branch', force ? '-D' : '-d', w.branch], { timeout: 15000 });
  try { fs.rmdirSync(path.dirname(w.path)); } catch { /* not empty, or already gone */ }
  return { ok: true };
}

module.exports = {
  create, status, bringHome, remove, branchName, checkWorktree, BRANCH,
  startsWork, onlyLooks, suggestedName, projectDirName, carryTranscript,
};
