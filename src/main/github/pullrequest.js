// From a GitHub issue to a pull request, for workflows: a copy of the
// repository to work in (the "Make a copy" step), and the pull request made
// from what was done there (the "Open a pull request" step).
//
// The copy is a worktree of the clone on this PC (worktrees.js), on a fresh
// shellby/... branch started from the repository's default branch as GitHub
// has it, so the work doesn't carry whatever your checkout is in the middle of.
//
// The pull request step only ever works on one of Shellby's own copies: it
// learns the repository, branch and base from the folder (nothing a workflow
// hands it can point the push somewhere else), commits what's left, pushes
// that branch and nothing else, never with --force, and opens the pull request
// as a draft. The commit and the push run no hooks: Claude may have just edited
// a tracked one while working on an issue someone else wrote.
//
// Everything that touches git or GitHub comes in as deps, so tests run on a
// real repository with a pretend GitHub (test/pullrequest.test.js).
const fs = require('fs');
const path = require('path');
const { checkRepo, githubRepoOf } = require('../projects/remote');
const { BRANCH } = require('../worktrees');

const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];
const REF = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;
const TITLE_MAX = 250;
const BODY_MAX = 60000;
const PUSH_MS = 5 * 60000;

const firstLine = s => String(s || '').trim().split('\n').filter(Boolean).pop() || '';
const longPath = p => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const fail = error => ({ ok: false, error });

/** Is `dir` inside Shellby's folder of copies? */
function insideHome(dir, home) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || !home) return false;
  return (longPath(dir) + path.sep).toLowerCase().startsWith(longPath(home).toLowerCase() + path.sep);
}

/** The repository's default branch, from GitHub. */
async function defaultBranch(gh, repo) {
  const info = await gh.get(`/repos/${repo}`).catch(() => null);
  return typeof info?.default_branch === 'string' && REF.test(info.default_branch) ? info.default_branch : null;
}

/** The open pull request from this branch, if there is one. */
async function existingPr(gh, repo, branch) {
  const owner = repo.split('/')[0];
  const list = await gh.get(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`).catch(() => null);
  return Array.isArray(list) && Number.isInteger(list[0]?.number) ? list[0] : null;
}

/**
 * A copy of `repo` to work in, from its default branch.
 *   deps: { findRoot(repo) -> clone root | null, gh, git, create (worktrees.create), home, env }
 * -> { ok: true, path, branch, base, repo } | { ok: false, error }
 */
async function makeCopy({ repo, slug }, { findRoot, gh, git, create, home, env = {} }) {
  const r = checkRepo(String(repo || '').trim());
  if (!r) return fail(`“${String(repo || '').slice(0, 80)}” isn't a GitHub repository (owner/name).`);
  const root = await findRoot(r);
  if (!root) return fail(`${r} isn't cloned on this PC. Clone it from the Projects page first, so Shellby has somewhere to work.`);
  const base = await defaultBranch(gh, r);
  if (!base) return fail(`GitHub didn't say what ${r}'s main branch is.`);
  const fetched = await git(root, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], { timeout: 120000, env });
  // Offline, the copy starts from what this clone last saw of it.
  const known = fetched.ok || (await git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`], { timeout: 5000 })).ok;
  if (!known) return fail(`Couldn't get ${base} from GitHub: ${firstLine(fetched.error) || 'git refused.'}`);
  const made = await create(root, { home, title: slug || 'issue', start: `origin/${base}` });
  if (!made) return fail(`${root} isn't a git repository any more.`);
  if (!made.ok) return made;
  return { ok: true, path: made.worktree.path, branch: made.worktree.branch, base, repo: r };
}

/**
 * Commit what's left in a copy, push its branch and open a pull request.
 *   deps: { gh, git, home, env, web }
 * -> { ok: true, url, number, branch, repo, base, draft } | { ok: false, error }
 */
async function openPullRequest({ folder, title, body = '', draft = true }, { gh, git, home, env = {}, web = 'https://github.com' }) {
  if (!insideHome(folder, home) || !fs.existsSync(folder)) return fail('A pull request can only be opened from a copy Shellby made (a “Make a copy” step).');
  const top = await git(folder, ['rev-parse', '--show-toplevel'], { timeout: 5000 });
  const root = top.ok ? top.out.trim() : '';
  if (!root || !insideHome(root, home)) return fail('That folder isn\'t one of Shellby\'s copies.');
  const head = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 5000 });
  const branch = head.ok ? head.out.trim() : '';
  if (!BRANCH.test(branch)) return fail('That copy isn\'t on one of Shellby\'s branches.');
  const origin = await git(root, ['remote', 'get-url', 'origin'], { timeout: 5000 });
  const repo = origin.ok ? githubRepoOf(origin.out.trim()) : null;
  if (!repo) return fail('That copy\'s repository isn\'t on GitHub.');
  const base = await defaultBranch(gh, repo);
  if (!base) return fail(`GitHub didn't say what ${repo}'s main branch is.`);

  const name = String(title || '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) || `Work from Shellby on ${branch}`;
  const dirty = await git(root, ['status', '--porcelain'], { timeout: 15000 });
  if (dirty.ok && dirty.out.trim()) {
    const add = await git(root, ['add', '-A'], { timeout: 60000 });
    const commit = add.ok && await git(root, [...NO_HOOKS, 'commit', '--quiet', '-m', name], { timeout: 60000 });
    if (!commit?.ok) return fail(`Couldn't commit what's in the copy: ${firstLine((commit || add).error)}`);
  }
  const ahead = await git(root, ['rev-list', '--count', `refs/remotes/origin/${base}..HEAD`], { timeout: 15000 });
  if (!ahead.ok) return fail(`Couldn't compare the copy with ${base}: ${firstLine(ahead.error)}`);
  if (!Number(ahead.out.trim())) return fail('There\'s nothing to propose: the copy has no changes.');

  const push = await git(root, [...NO_HOOKS, 'push', '--quiet', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { timeout: PUSH_MS, env });
  if (!push.ok) return fail(`The push didn't go through: ${firstLine(push.error) || 'git refused it.'}`);

  const open = asDraft => gh.post(`/repos/${repo}/pulls`, { title: name, head: branch, base, body: String(body || '').slice(0, BODY_MAX), draft: asDraft });
  const why = e => `GitHub didn't open the pull request: ${e.detail || e.message}`;
  let pr;
  let existing = null;
  try {
    pr = await open(!!draft);
  } catch (e) {
    // GitHub says 422 "Validation Failed" for both of these, so look rather than read the message.
    // A retried step: the push went through last time, and so did the pull request.
    if (e.status === 422) existing = await existingPr(gh, repo, branch);
    if (existing) pr = existing;
    // Private repositories on free plans can't have drafts: an ordinary one, then.
    else if (!(draft && e.status === 422)) return fail(why(e));
    else try { pr = await open(false); } catch (e2) { return fail(why(e2)); }
  }
  if (!Number.isInteger(pr?.number)) return fail('GitHub didn\'t say which pull request it opened.');
  return { ok: true, url: `${web}/${repo}/pull/${pr.number}`, number: pr.number, branch, repo, base, draft: !!pr.draft, existing: !!existing };
}

module.exports = { makeCopy, openPullRequest, insideHome };
