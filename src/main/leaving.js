// "Is it safe to leave?" Before you lock the PC, shut it down or sign out,
// Shellby looks for work that only exists on this machine or is still in
// flight: commits no remote has, changes nobody committed, stashes, Claude
// still working or waiting on you, and commands a turn left running in the
// background. "2 projects have unpushed work."
//
// Two halves:
//   - probe():   the git side, for one project. Every git call goes through the
//                runner it's given (tests pass a fake), with fixed arguments and
//                no shell, and a repo that can't be read is reported as such,
//                never as clean.
//   - verdict(): pure. The probes plus what's running become { safe, headline,
//                lines }.
//
// Work that's still to go out is also looked over for secrets (secretscan.js),
// since "Tidy up" asks Claude to commit and push all of it.
//
// Projects are the repos you've worked in lately (main.js passes the folders).
// A Shellby copy (git worktree) is checked as part of the repo it was made
// from, so its uncommitted work shows up under that project's name.
const { execFile } = require('child_process');
const path = require('path');

const GIT_TIMEOUT_MS = 8000;
const MAX_PROJECTS = 20;
const MAX_WORKTREES = 12;   // per project
const MAX_BRANCHES = 30;    // per project, when naming the unpushed ones
const MAX_NAMED = 3;        // branches named in a line before "and N more"
const CONCURRENCY = 3;

function git(args) {
  return new Promise(resolve => {
    // fsmonitor off: a repository's config must not choose a program for us to
    // run. No optional locks: status mustn't take the index lock out from under
    // whatever you (or Claude) are doing in there.
    execFile('git', ['-c', 'core.fsmonitor=false', '--no-optional-locks', ...args],
      { windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// A local folder only: never a network share (git would reach out to it) or a device path.
const okDir = dir => typeof dir === 'string' && !!dir && dir.length <= 400 && path.isAbsolute(dir) && !/^[\\/]{2}/.test(dir);
const keyOf = p => (process.platform === 'win32' ? p.toLowerCase() : p);
const lines = out => String(out || '').split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean);

/** The repository a folder belongs to, as the main checkout's root (a worktree resolves to its repo), or null. */
async function mainRoot(dir, run = git) {
  if (!okDir(dir)) return null;
  const top = (await run(['-C', dir, 'rev-parse', '--show-toplevel']))?.trim();
  if (!top) return null;
  const root = path.resolve(top);
  const common = (await run(['-C', root, 'rev-parse', '--git-common-dir']))?.trim();
  if (common) {
    const abs = path.resolve(root, common);
    if (path.basename(abs).toLowerCase() === '.git') return path.dirname(abs);
  }
  return root;
}

/** `git worktree list --porcelain` → [{ path, branch, main }], skipping bare and vanished ones. */
function parseWorktrees(out) {
  const list = [];
  for (const block of String(out || '').replace(/\r/g, '').split('\n\n')) {
    const fields = lines(block);
    const at = fields.find(l => l.startsWith('worktree '));
    if (!at || fields.some(l => l === 'bare' || l.startsWith('prunable'))) continue;
    const branch = fields.find(l => l.startsWith('branch '))?.slice('branch refs/heads/'.length) || null;
    list.push({ path: path.resolve(at.slice('worktree '.length)), branch, main: list.length === 0 });
  }
  return list;
}

/** `git status --porcelain=v1` → { changed, untracked } file counts. */
function parseStatus(out) {
  let changed = 0, untracked = 0;
  for (const l of lines(out)) {
    if (l.startsWith('??')) untracked++;
    else if (!l.startsWith('!!')) changed++;
  }
  return { changed, untracked };
}

/** Where a remote's work lands: its HEAD, else its main, else its master (origin's, if there is an origin). */
async function landingRef(root, remotes, run) {
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  const out = await run(['-C', root, 'for-each-ref', '--format=%(refname)',
    ...['HEAD', 'main', 'master'].map(b => `refs/remotes/${remote}/${b}`)]);
  return lines(out)[0] || null; // sorted by name, which is that order
}

/**
 * Commits on local branches that no remote-tracking branch has, less those
 * whose change already landed on the remote's main line under another hash:
 * a rebase merge, or a squash of a one-commit branch, on GitHub leaves the
 * branch's own commits behind, and they aren't work only this PC has.
 * `git cherry` matches them by patch, one commit at a time, so a squash of
 * several commits still counts (too many, never too few).
 * -> { commits, branches: [names] } | null when git couldn't say.
 */
async function branchWork(root, remotes, run) {
  const listed = await run(['-C', root, 'rev-list', '--branches', '--not', '--remotes']);
  if (listed === null) {
    // Too many to list (git()'s buffer): just count them, unmatched and unnamed.
    const n = await run(['-C', root, 'rev-list', '--count', '--branches', '--not', '--remotes']);
    return n === null ? null : { commits: Number(n.trim()) || 0, branches: [] };
  }
  const pending = new Set(lines(listed));
  if (!pending.size) return { commits: 0, branches: [] };

  // A branch has commits no remote has exactly when its tip is one of them
  // (a tip a remote has brings all its history along). Newest first, so the
  // line names what you were just working on.
  const tips = lines(await run(['-C', root, 'for-each-ref', '--sort=-committerdate', '--format=%(objectname) %(refname)', 'refs/heads']))
    .map(l => l.split(' '))
    .filter(([sha]) => pending.has(sha))
    .slice(0, MAX_BRANCHES);
  const base = await landingRef(root, remotes, run);
  const mine = []; // [name, tip, its commits no remote has | null: couldn't match them by patch]
  for (const [tip, ref] of tips) {
    const name = ref.replace(/^refs\/heads\//, '');
    const marked = base && (await run(['-C', root, 'cherry', base, ref]));
    if (!marked) { mine.push([name, tip, null]); continue; } // no landing branch, or cherry failed: count it all
    const kept = [];
    for (const l of lines(marked)) {
      const [mark, sha] = l.split(' ');
      if (mark === '-') pending.delete(sha);
      else if (pending.has(sha)) kept.push(sha);
    }
    mine.push([name, tip, kept]);
  }
  // Checked after every branch's matches are in: a later branch can show one
  // this branch kept has landed. cherry leaves merge commits out, so a pending
  // tip names its branch either way.
  const branches = mine
    .filter(([, tip, kept]) => kept === null || pending.has(tip) || kept.some(sha => pending.has(sha)))
    .map(([name]) => name);
  return { commits: pending.size, branches };
}

/**
 * Everything at risk in one repository:
 * { root, name, ok, worktrees: [{ path, branch, main, changed, untracked }],
 *   unpushed: { commits, branches: [names] } | null (no remote to push to),
 *   stashes }
 * ok is false when git couldn't read it at all.
 */
async function probe(root, run = git) {
  const name = path.basename(root);
  const unreadable = { root, name, ok: false, worktrees: [], unpushed: null, stashes: 0 };
  // Any answer git couldn't give makes the whole project "couldn't check":
  // a failed command must never pass for a clean one.
  const count = out => (out === null ? null : Number(out.trim()) || 0);
  const wtOut = await run(['-C', root, 'worktree', 'list', '--porcelain']);
  if (wtOut === null) return unreadable;
  // Never a network share, even if a worktree record points at one.
  const trees = parseWorktrees(wtOut).filter(wt => okDir(wt.path)).slice(0, MAX_WORKTREES);
  const worktrees = [];
  for (const wt of trees) {
    const st = await run(['-C', wt.path, 'status', '--porcelain=v1', '--untracked-files=normal']);
    if (st === null) return unreadable;
    worktrees.push({ ...wt, ...parseStatus(st) });
  }

  // Commits on local branches that no remote-tracking branch has, plus any
  // made on a detached HEAD in a copy, which no branch holds at all. A repo
  // with no remote has nowhere to push, so that's not "unpushed".
  let unpushed = null;
  const remotes = await run(['-C', root, 'remote']);
  if (remotes === null) return unreadable;
  if (lines(remotes).length) {
    const local = await branchWork(root, lines(remotes), run);
    if (local === null) return unreadable;
    let { commits } = local;
    const { branches } = local;
    for (const wt of worktrees.filter(w => !w.branch)) {
      const n = count(await run(['-C', wt.path, 'rev-list', '--count', 'HEAD', '--not', '--branches', '--remotes']));
      if (n === null) return unreadable;
      if (n) { commits += n; branches.push(`detached HEAD in ${path.basename(wt.path)}`); }
    }
    unpushed = { commits, branches };
  }

  const stashOut = await run(['-C', root, 'stash', 'list', '--format=%gd']);
  if (stashOut === null) return unreadable;
  return { root, name, ok: true, worktrees, unpushed, stashes: lines(stashOut).length };
}

/**
 * What looks like a secret in the work that's still to go out (secretscan.js
 * atRisk): only for a project with unpushed or uncommitted work, since
 * anything else has either left already or has nothing to send.
 * -> { findings, more, partial } | null
 */
async function secretsIn(p, scan) {
  const dirs = p.worktrees.filter(wt => wt.changed + wt.untracked).map(wt => wt.path);
  const unpushed = !!p.unpushed?.commits;
  if (!scan || !p.ok || (!dirs.length && !unpushed)) return null;
  try {
    const r = await scan(p.root, { dirs, unpushed });
    return r?.findings?.length ? { findings: r.findings, more: r.more || 0, partial: !!r.partial } : null;
  } catch { return null; }
}

/**
 * The folders' repositories, deduplicated by main root and probed a few at a
 * time. When git itself can't run, that's one unreadable entry, not an empty
 * (and so "safe") list. scan: secretscan.atRisk, to look for secrets in what's
 * still to go out (left out, no project carries `secrets`).
 */
async function check(dirs, run = git, { scan = null } = {}) {
  const wanted = [...new Set((dirs || []).filter(okDir))];
  if (wanted.length && (await run(['--version'])) === null) {
    return [{ root: null, name: "your projects (git didn't run)", ok: false, worktrees: [], unpushed: null, stashes: 0 }];
  }
  const roots = new Map();
  for (const dir of wanted) {
    if (roots.size >= MAX_PROJECTS) break;
    const root = await mainRoot(dir, run);
    if (root && !roots.has(keyOf(root))) roots.set(keyOf(root), root);
  }
  const queue = [...roots.values()];
  const out = [];
  const worker = async () => {
    while (queue.length) {
      const p = await probe(queue.shift(), run);
      const secrets = await secretsIn(p, scan);
      out.push(secrets ? { ...p, secrets } : p);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const named = list => (list.length > MAX_NAMED ? `${list.slice(0, MAX_NAMED).join(', ')} and ${list.length - MAX_NAMED} more` : list.join(', '));
const dirty = wt => wt.changed + wt.untracked;

/** One project's problems as short phrases, or [] when it's safe. */
function projectIssues(p) {
  const issues = [];
  if (p.unpushed?.commits) {
    const where = p.unpushed.branches.length ? ` (${named(p.unpushed.branches)})` : '';
    issues.push(`${plural(p.unpushed.commits, 'commit')} not pushed${where}`);
  }
  for (const wt of p.worktrees.filter(dirty)) {
    const files = plural(dirty(wt), 'file');
    issues.push(wt.main ? `${files} not committed` : `${files} not committed in the copy ${wt.branch || path.basename(wt.path)}`);
  }
  if (p.stashes) issues.push(`${plural(p.stashes, 'stash', 'stashes')}`);
  if (p.secrets?.findings.length) {
    const n = p.secrets.findings.length + p.secrets.more;
    issues.push(`${n === 1 ? 'something that looks' : `${n} things that look`} like a secret (${named(p.secrets.findings.map(f => f.line ? `${f.file}:${f.line}` : f.file))})`);
  }
  return issues;
}

/**
 * The answer. projects: from check(). running: what main.js sees right now:
 * { working: [title], waiting: [title], background: [{ program, project }],
 *   servers: [{ project, port }] (dev servers Shellby runs, devservers/service.js) }.
 * Returns { safe, hold, headline, lines: [string], counts }.
 *
 * safe: nothing at all to mention. hold: worth holding up a shutdown for, which
 * is a narrower question: work only this PC has (unpushed, uncommitted) or
 * Claude mid-turn. A stash, a dev server left running, a secret waiting to go
 * out (safe on this disk; it's pushing it that hurts) or a repo git couldn't
 * read is worth a line, but not a "Shut down anyway" on every shutdown.
 */
function verdict(projects = [], running = {}) {
  const ok = projects.filter(p => p.ok);
  const counts = {
    unpushed: ok.filter(p => p.unpushed?.commits).length,
    uncommitted: ok.filter(p => p.worktrees.some(dirty)).length,
    stashed: ok.filter(p => p.stashes).length,
    secrets: ok.filter(p => p.secrets?.findings.length).length,
    working: (running.working || []).length,
    waiting: (running.waiting || []).length,
    background: (running.background || []).length,
    servers: (running.servers || []).length,
    unreadable: projects.length - ok.length,
  };
  const has = (n, verb) => `${plural(n, 'project')} ${n === 1 ? 'has' : 'have'} ${verb}`;
  const parts = [
    counts.unpushed && has(counts.unpushed, 'unpushed work'),
    counts.uncommitted && has(counts.uncommitted, 'uncommitted changes'),
    counts.stashed && has(counts.stashed, 'stashed changes'),
    counts.secrets && has(counts.secrets, 'something that looks like a secret waiting to go out'),
    counts.working && `Claude is still working in ${plural(counts.working, 'conversation')}`,
    counts.waiting && `${plural(counts.waiting, 'conversation')} waiting on you`,
    counts.background && `${plural(counts.background, 'command')} still running in the background`,
    counts.servers && `${plural(counts.servers, 'dev server')} still running`,
    counts.unreadable && `${plural(counts.unreadable, 'project')} couldn't be checked`,
  ].filter(Boolean);

  const out = [];
  for (const p of ok) {
    const issues = projectIssues(p);
    if (issues.length) out.push(`${p.name}: ${issues.join(', ')}`);
  }
  for (const t of running.working || []) out.push(`Still working: ${t}`);
  for (const t of running.waiting || []) out.push(`Waiting on you: ${t}`);
  for (const b of running.background || []) out.push(`In the background: ${b.program}${b.project ? ` in ${b.project}` : ''}`);
  for (const s of running.servers || []) out.push(`Dev server: ${s.project}${s.port ? ` on :${s.port}` : ''}`);
  for (const p of projects.filter(x => !x.ok)) out.push(`Couldn't check ${p.name}`);

  const safe = !parts.length;
  return {
    safe,
    hold: !!(counts.unpushed || counts.uncommitted || counts.working || counts.waiting),
    headline: safe ? 'Safe to leave: nothing unpushed, uncommitted, stashed or running.' : `${parts.join(' · ')}.`.replace(/^./, c => c.toUpperCase()),
    lines: out,
    counts,
  };
}

module.exports = { check, probe, mainRoot, verdict, parseWorktrees, parseStatus, landingRef, git, okDir, MAX_PROJECTS };
