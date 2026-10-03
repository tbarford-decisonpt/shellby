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
// None of that leaves your machine. pushBase is the step that does: it takes
// in what the remote has first, then pushes your checkout's branch.
//
// execFile with fixed arguments, short timeouts, nothing thrown to the caller.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BRANCH = /^shellby\/[a-z0-9-]{1,40}-[0-9a-f]{6}$/;

// For the commits Shellby makes of Claude's work, and the merge that brings
// them home: no hooks. Claude can edit a tracked hook (.husky/pre-commit) in
// Auto-edit without a prompt, and git would then run it with your rights when
// you click. A push stays yours: its hooks run as from a terminal.
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

// fsmonitor off: a repository's own config could name a program to run on
// every status (one Shellby never asked for).
function git(cwd, args, { timeout = 30000 } = {}) {
  return new Promise(resolve => {
    execFile('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
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
const SESSION_ID = /^[\w-]{8,64}$/;
function carryTranscript({ configDir, sessionId, from, to }) {
  if (!SESSION_ID.test(sessionId || '')) return false;
  return copySession({ configDir, file: path.join(configDir, 'projects', projectDirName(from), `${sessionId}.jsonl`), to });
}

/**
 * Copy one of Claude Code's conversation files (and the folder of subagent
 * transcripts and large tool results beside it) to where Claude Code looks
 * for conversations in `to`. Leaves one that's already there alone. -> true | false
 */
function copySession({ configDir, file, to }) {
  const id = path.basename(String(file || ''), '.jsonl');
  if (!SESSION_ID.test(id) || !String(file).endsWith('.jsonl')) return false;
  const src = path.dirname(file);
  const dst = path.join(configDir, 'projects', projectDirName(to));
  try {
    if (!fs.existsSync(file)) return false;
    if (path.resolve(src).toLowerCase() === path.resolve(dst).toLowerCase()) return true;
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(file, path.join(dst, `${id}.jsonl`));
    if (fs.existsSync(path.join(src, id))) fs.cpSync(path.join(src, id), path.join(dst, id), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Where Claude Code keeps a conversation: under the folder it was in when it
 * was written, which may not be where its tab is now (it moved into a copy,
 * or the copy was brought home since). `prefer`: folders to look in first.
 * Otherwise the newest copy anywhere. -> path | null
 */
function findSession({ configDir, sessionId, prefer = [] }) {
  if (!SESSION_ID.test(sessionId || '')) return null;
  const projects = path.join(configDir, 'projects');
  for (const dir of prefer) {
    if (typeof dir !== 'string' || !dir) continue;
    const f = path.join(projects, projectDirName(dir), `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  let best = null;
  let names;
  try { names = fs.readdirSync(projects); } catch { return null; }
  for (const name of names) {
    const f = path.join(projects, name, `${sessionId}.jsonl`);
    try {
      const at = fs.statSync(f).mtimeMs;
      if (!best || at > best.at) best = { f, at };
    } catch { /* not in this one */ }
  }
  return best?.f || null;
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

const OBJECT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * A copy of the repository as it was at one moment of a conversation, for a
 * branch (branch.js). Checked out at `head` (the commit that was checked out
 * then), with the files made exactly `tree` (a snapshot from changes.js:
 * uncommitted and untracked work included). What differs from `head` shows as
 * uncommitted, just as it was, so "Bring it home" works the same as for any copy.
 *   repoRoot: the repository itself (never one of our copies: git worktrees share it)
 *   base: the branch to bring it home to. prefix: the tab's folder inside the repo.
 * -> { ok: true, worktree } | { ok: false, error, gone? }
 */
async function createAt({ repoRoot, base, head, tree, prefix = '', home, slug, originalCwd }) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot) || !fs.existsSync(repoRoot)) return { ok: false, error: 'That repository has moved.' };
  if (!OBJECT.test(tree || '') || !OBJECT.test(head || '')) return { ok: false, error: "That point in the conversation has no snapshot to start from." };
  if (typeof base !== 'string' || !REF.test(base)) return { ok: false, error: 'There is no branch to bring it home to.' };
  const rel = String(prefix || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (rel.split('/').includes('..')) return { ok: false, error: 'That folder is outside the repository.' };
  // Snapshots aren't referenced by any branch, so git tidies them away in time.
  const [hasTree, hasHead] = await Promise.all([
    git(repoRoot, ['cat-file', '-e', `${tree}^{tree}`], { timeout: 5000 }),
    git(repoRoot, ['cat-file', '-e', `${head}^{commit}`], { timeout: 5000 }),
  ]);
  if (!hasTree.ok || !hasHead.ok) return { ok: false, gone: true, error: 'git has tidied away the files from that point since.' };

  const branch = branchName(slug);
  const wt = path.join(home, branch.slice(-6), path.basename(repoRoot));
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const add = await git(repoRoot, ['worktree', 'add', '-b', branch, wt, head], { timeout: 120000 });
  if (!add.ok) return { ok: false, error: firstLine(add.error) || "git couldn't make the copy." };
  // The files as the snapshot has them (deletions too), then the index back
  // on `head`: the difference is uncommitted work, as it was at the time.
  const files = await git(wt, ['read-tree', '-u', '--reset', tree], { timeout: 120000 });
  const index = files.ok && await git(wt, ['reset', '-q'], { timeout: 60000 });
  if (!index?.ok) {
    await remove({ path: wt, root: repoRoot, branch, base }, { force: true });
    return { ok: false, error: `Couldn't put the files back as they were: ${firstLine((index || files).error)}` };
  }
  // The tab's folder inside the copy, unless a link would lead it out of it.
  const sub = rel ? path.join(wt, ...rel.split('/')) : wt;
  const real = longPath(sub);
  const cwd = fs.existsSync(sub) && (real + path.sep).toLowerCase().startsWith(longPath(wt).toLowerCase() + path.sep) ? sub : wt;
  return {
    ok: true,
    worktree: { path: wt, cwd, branch, base, root: path.resolve(repoRoot), originalCwd: path.resolve(originalCwd || repoRoot) },
  };
}

/**
 * Where a copy should start when the snapshot didn't say which commit was
 * checked out (transcripts from before it did): where the original's own copy
 * started, or what your checkout has now. -> sha | null
 */
async function startingPoint({ repoRoot, worktree }) {
  const r = worktree && !checkWorktree(worktree)
    ? await git(repoRoot, ['merge-base', worktree.base, worktree.branch], { timeout: 10000 })
    : await git(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeout: 5000 });
  const sha = r.ok ? r.out.trim() : '';
  return OBJECT.test(sha) ? sha : null;
}

/** The branch a checkout is on, or null (detached, or not a repo). */
async function branchOf(root) {
  const r = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 5000 });
  const b = r.ok ? r.out.trim() : '';
  return REF.test(b) ? b : null;
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
    const commit = add.ok && await git(w.path, [...NO_HOOKS, 'commit', '-q', '--no-verify', '-m', String(message || 'Work from Shellby').slice(0, 200)]);
    if (!commit?.ok) return { ok: false, error: `Couldn't commit the copy's changes: ${firstLine(commit?.error || add.error)}` };
  }

  const ahead = await git(w.root, ['rev-list', '--count', `${w.base}..${w.branch}`], { timeout: 15000 });
  const commits = ahead.ok ? Number(ahead.out.trim()) || 0 : 0;
  if (commits) {
    const on = await git(w.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 5000 });
    if (!on.ok || on.out.trim() !== w.base) {
      return { ok: false, error: `Your checkout is on ${on.out.trim() || 'no branch'} now. Switch back to ${w.base} to bring this home.` };
    }
    const merge = await git(w.root, [...NO_HOOKS, 'merge', '--no-verify', '--no-edit', '-m', `Bring home ${w.branch}`, w.branch], { timeout: 60000 });
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

// ------------------------------------------------------------ sending it to GitHub
//
// Bringing a copy home only ever touches your checkout. Pushing is the
// separate, deliberate step that publishes it: fetch, merge in whatever the
// remote has that you don't (a merge, never a rebase, so the "Bring home"
// merges stay as they were), then a plain push. Never a force push, and a
// clash is backed out exactly like bringHome's.

// Branch and remote names as git would print them; nothing that reads as an option.
const REF = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;
const lastLines = (s, n = 15) => String(s || '').trim().split('\n').filter(Boolean).slice(-n).join('\n');

/** Where a branch pushes to: its upstream, or origin (or the only remote) under the same name. -> { remote, dest, upstream, tracked } | null */
async function upstreamOf(root, branch) {
  const [remote, merge] = await Promise.all([
    git(root, ['config', '--get', `branch.${branch}.remote`], { timeout: 5000 }),
    git(root, ['config', '--get', `branch.${branch}.merge`], { timeout: 5000 }),
  ]);
  const r = remote.ok ? remote.out.trim() : '';
  const m = merge.ok ? merge.out.trim().replace(/^refs\/heads\//, '') : '';
  if (r && r !== '.' && m && REF.test(r) && REF.test(m)) return { remote: r, dest: m, upstream: `${r}/${m}`, tracked: true };
  const list = await git(root, ['remote'], { timeout: 5000 });
  const remotes = list.ok ? list.out.split(/\r?\n/).map(s => s.trim()).filter(s => REF.test(s)) : [];
  const pick = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null;
  return pick ? { remote: pick, dest: branch, upstream: `${pick}/${branch}`, tracked: false } : null;
}

/** -> { ahead, behind } of branch against upstream (behind 0 when the remote has no such branch yet). */
async function aheadBehind(root, branch, upstream) {
  const has = await git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${upstream}`], { timeout: 5000 });
  if (!has.ok) {
    const all = await git(root, ['rev-list', '--count', branch], { timeout: 15000 });
    return { ahead: all.ok ? Number(all.out.trim()) || 0 : 0, behind: 0 };
  }
  const r = await git(root, ['rev-list', '--left-right', '--count', `${branch}...refs/remotes/${upstream}`], { timeout: 15000 });
  const [ahead, behind] = r.ok ? r.out.trim().split(/\s+/).map(n => Number(n) || 0) : [0, 0];
  return { ahead, behind };
}

/**
 * How your checkout stands against its remote. fetch: ask the remote first
 * (slow, needs the network); otherwise it's as of the last fetch.
 *   -> { ok: true, branch, remote, upstream, ahead, behind, fetched } | { ok: true, branch, remote: null } | { ok: false, error }
 */
async function remoteStatus(root, { fetch = false } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return { ok: false, error: 'That is not a repository.' };
  const on = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 5000 });
  const branch = on.ok ? on.out.trim() : '';
  if (!REF.test(branch)) return { ok: false, error: 'Your checkout is not on a branch (detached HEAD), so there is nothing to push.' };
  const up = await upstreamOf(root, branch);
  if (!up) return { ok: true, branch, remote: null };
  let fetched = false;
  if (fetch) {
    const f = await git(root, ['fetch', '--quiet', up.remote], { timeout: 90000 });
    if (!f.ok) return { ok: false, error: `Couldn't reach ${up.remote}: ${firstLine(f.error)}` };
    fetched = true;
  }
  return { ok: true, branch, ...up, ...await aheadBehind(root, branch, up.upstream), fetched };
}

/**
 * Push your checkout's branch. base: refuse unless the checkout is on it (a
 * copy brought home lands on its base, and that's what should go out).
 *   -> { ok: true, branch, remote, pushed, pulled } | { ok: false, error, conflict?, detail? }
 */
async function pushBase(root, { base } = {}) {
  const s = await remoteStatus(root, { fetch: true });
  if (!s.ok) return s;
  if (base && s.branch !== base) return { ok: false, error: `Your checkout is on ${s.branch} now. Switch back to ${base} to push it.` };
  if (!s.remote) return { ok: false, error: `${s.branch} has nowhere to go: this repository has no remote.` };

  let pulled = 0;
  if (s.behind) {
    const merge = await git(root, ['merge', '--no-edit', '-m', `Merge ${s.upstream} into ${s.branch}`, `refs/remotes/${s.upstream}`], { timeout: 60000 });
    if (!merge.ok) {
      const conflict = /CONFLICT|Automatic merge failed/i.test(merge.out + merge.error);
      if (conflict) await git(root, ['merge', '--abort'], { timeout: 15000 });
      return {
        ok: false, conflict, upstream: s.upstream,
        error: conflict
          ? `${s.upstream} has ${s.behind} commit${s.behind === 1 ? '' : 's'} that clash with yours. Nothing was merged or pushed.`
          : `Couldn't take in ${s.upstream} first: ${firstLine(merge.error) || 'git refused the merge.'}`,
      };
    }
    pulled = s.behind;
  }

  const { ahead } = pulled ? await aheadBehind(root, s.branch, s.upstream) : s;
  if (!ahead) return { ok: true, branch: s.branch, remote: s.remote, pushed: 0, pulled };
  // Long timeout: a pre-push hook may run the whole test suite.
  const push = await git(root, ['push', ...(s.tracked ? [] : ['-u']), s.remote, `refs/heads/${s.branch}:refs/heads/${s.dest}`], { timeout: 10 * 60000 });
  if (!push.ok) {
    const rejected = /\[rejected\]|non-fast-forward|fetch first/i.test(push.error);
    return {
      ok: false,
      error: rejected
        ? `${s.remote} moved on while pushing. Try again.`
        // "failed to push some refs" is git's last word for a hook's refusal
        // too; the reason is in the detail.
        : /failed to push some refs/i.test(push.error)
          ? `${s.remote} didn't take the push. Nothing went.`
          : `The push didn't go through: ${firstLine(push.error) || 'git refused it.'}`,
      // A pre-push hook's own words are what explain a refusal.
      detail: lastLines(push.error) || undefined,
      pulled,
    };
  }
  return { ok: true, branch: s.branch, remote: s.remote, pushed: ahead, pulled };
}

/**
 * Bring several copies home, one after another, into the branch your checkout
 * is on. Stops at the first that clashes; the ones before it stay merged.
 * Copies started from another branch are skipped, not merged somewhere else.
 *   -> { ok, results: [{ branch, ok, merged, commits, error?, conflict?, skipped? }], stopped? }
 */
async function bringAllHome(list, { messageFor = () => 'Work from Shellby' } = {}) {
  const results = [];
  for (const w of list) {
    const bad = checkWorktree(w);
    if (bad) { results.push({ branch: w?.branch, ok: false, skipped: true, error: bad }); continue; }
    const on = await git(w.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 5000 });
    if (!on.ok || on.out.trim() !== w.base) {
      results.push({ branch: w.branch, ok: false, skipped: true, error: `started from ${w.base}` });
      continue;
    }
    const r = await bringHome(w, { message: messageFor(w) });
    results.push({ branch: w.branch, ...r });
    if (!r.ok && !/gone/.test(r.error || '')) return { ok: false, results, stopped: w.branch };
  }
  return { ok: true, results };
}

module.exports = {
  create, createAt, startingPoint, branchOf, status, bringHome, remove, branchName, checkWorktree, BRANCH,
  remoteStatus, pushBase, bringAllHome, upstreamOf,
  startsWork, onlyLooks, suggestedName, projectDirName, carryTranscript, copySession, findSession,
};
