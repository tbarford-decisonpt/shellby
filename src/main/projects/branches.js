// Branches gone stale in one repository, and how much of each exists only on
// this PC, for the Projects page's inbox (inbox.js). Also the same two facts
// (last commit, commits only here) for Shellby's copies of it, which are
// branches checked out in their own folders.
//
// A branch is "merged" when the main line the remote lands work on already
// has every change on it, by hash or by patch (git cherry, so a rebase merge on
// GitHub counts; a squash of several commits doesn't, which errs towards
// keeping). Otherwise its "only here" count is the commits no other branch or
// remote-tracking branch has: deleting it would lose exactly those.
//
// git through leaving.js's runner: read-only, no optional locks, short timeouts.
const path = require('path');
const { landingRef } = require('../leaving');

const DAY = 24 * 60 * 60 * 1000;
const STALE_DAYS = 21;      // an unmerged branch nobody has committed to in this long
const MERGED_GRACE_DAYS = 1; // a merged branch, once the merge has had a day to settle
const MAX_REFS = 300;
const MAX_CHECKED = 25;     // branches per repo looked into (cherry / rev-list), oldest first
const REF = /^(?!-)(?!.*\.\.)(?!.*\/\/)[\w./-]{1,200}$/;

const lines = out => String(out || '').split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean);

/**
 * `git for-each-ref refs/heads` with NUL-separated fields ->
 * [{ name, at, upstream, gone, checkedOut, path, sha }]. Pure.
 */
function parseRefs(out) {
  const list = [];
  for (const l of lines(out).slice(0, MAX_REFS)) {
    const [name, unix, upstream, track, wt, sha] = l.split('\0');
    if (!REF.test(name || '')) continue;
    const at = Number(unix) * 1000;
    list.push({
      name,
      at: Number.isFinite(at) && at > 0 ? at : null,
      upstream: upstream && REF.test(upstream) ? upstream : null,
      gone: /\[gone\]/.test(track || ''),
      checkedOut: !!wt,
      path: wt ? path.resolve(wt) : null,
      sha: /^[0-9a-f]{40,64}$/.test(sha || '') ? sha : null,
    });
  }
  return list;
}

/**
 * Which of a repo's branches belong in the inbox, given what was learned about
 * each: [{ name, at, gone, merged, only }] -> the stale ones, merged first, then
 * oldest. A merged branch is listed after a day; any other once nobody has
 * touched it for STALE_DAYS (or its remote branch was deleted). Pure.
 */
function stale(branches, now) {
  const old = (b, days) => b.at !== null && now - b.at >= days * DAY;
  return branches
    // Pushed but not merged (an open pull request's branch) is work in progress, not clutter: it waits like the rest.
    .filter(b => (b.merged ? old(b, MERGED_GRACE_DAYS) || b.gone : b.gone || old(b, STALE_DAYS)))
    .sort((a, b) => Number(!!b.merged) - Number(!!a.merged) || (a.at || 0) - (b.at || 0));
}

/** The remote branch work lands on, as "origin/main", or null (no remote). */
async function landingOf(root, run) {
  const remotes = lines(await run(['-C', root, 'remote']));
  const ref = remotes.length ? await landingRef(root, remotes, run) : null;
  return ref ? ref.replace(/^refs\/remotes\//, '') : null;
}

/** Has the main line got everything on `name`? -> { merged, only } | null when git couldn't say. */
async function weigh(root, name, landing, run) {
  if (landing) {
    const cherry = await run(['-C', root, 'cherry', landing, `refs/heads/${name}`]);
    if (cherry !== null && !lines(cherry).some(l => l.startsWith('+'))) return { merged: true, only: 0 };
  }
  // --exclude applies to the --branches after it: every other branch, and every remote.
  const n = await run(['-C', root, 'rev-list', '--count', `refs/heads/${name}`, '--not', `--exclude=${name}`, '--branches', '--remotes']);
  if (n === null) return null;
  return { merged: false, only: Number(n.trim()) || 0 };
}

/**
 * One repository's stale branches and its copies' branches.
 * isCopy(path): is this worktree one of Shellby's copies?
 * -> { ok, main: 'main' | null, branches: [...stale()], copies: [{ path, branch, at, merged, only }] }
 */
async function read(root, { run, now = Date.now(), isCopy = () => false }) {
  const out = await run(['-C', root, 'for-each-ref', '--sort=committerdate',
    '--format=%(refname:short)%00%(committerdate:unix)%00%(upstream:short)%00%(upstream:track)%00%(worktreepath)%00%(objectname)', 'refs/heads']);
  if (out === null) return { ok: false, main: null, branches: [], copies: [] };
  const refs = parseRefs(out);
  const landing = await landingOf(root, run);
  const main = landing ? landing.replace(/^[^/]+\//, '') : null;

  const copies = [];
  for (const b of refs.filter(r => r.checkedOut && isCopy(r.path))) {
    const w = await weigh(root, b.name, landing, run);
    copies.push({ path: b.path, branch: b.name, at: b.at, merged: !!w?.merged, only: w ? w.only : null });
  }
  // Oldest first (for-each-ref's sort), so a repo with hundreds looks at the likeliest.
  const candidates = refs.filter(r => !r.checkedOut && r.name !== main && r.name !== 'HEAD').slice(0, MAX_CHECKED);
  const weighed = [];
  for (const b of candidates) {
    const w = await weigh(root, b.name, landing, run);
    if (w) weighed.push({ name: b.name, at: b.at, sha: b.sha, upstream: b.upstream, gone: b.gone, ...w });
  }
  return { ok: true, main, branches: stale(weighed, now), copies };
}

/** Still safe to delete without asking? Looked at again right before: -> { ok, merged, only, checkedOut, at, sha } */
async function recheck(root, name, run) {
  if (!REF.test(name || '')) return { ok: false };
  const refs = parseRefs(await run(['-C', root, 'for-each-ref', '--format=%(refname:short)%00%(committerdate:unix)%00%00%00%(worktreepath)%00%(objectname)', `refs/heads/${name}`]));
  const b = refs.find(r => r.name === name);
  if (!b) return { ok: false, gone: true };
  const w = await weigh(root, name, await landingOf(root, run), run);
  return w ? { ok: true, ...w, checkedOut: b.checkedOut, at: b.at, sha: b.sha } : { ok: false };
}

module.exports = { read, recheck, parseRefs, stale, weigh, REF, STALE_DAYS };
