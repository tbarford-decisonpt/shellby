// Releases on a project's page: what's unreleased in a clone, and "Cut release",
// the bump, CHANGELOG and tag routine done the way you'd do it by hand:
//
//   1. package.json (and package-lock.json) set to the new version
//   2. the entry added to the top of CHANGELOG.md (or the one already there kept)
//   3. one commit, "0.71.0: Title", on the main branch
//   4. an annotated tag, v0.71.0
//   5. the branch and the tag pushed together (if you ticked it), or later with Push
//
// It stops before touching anything when the clone isn't ready: another
// branch, changes that aren't part of a release, behind its remote, the tag
// taken, or new commits since the draft you read. The repository's own hooks
// never run (they're its code, not Shellby's), and every git call has fixed
// arguments and no shell. The decisions are in releases.js; tests drive this
// against real git in a temp folder (test/projects-release-git.test.js).
const fs = require('fs');
const path = require('path');
const R = require('./releases');
const { verdict } = require('../github/ci');

const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];
const MAX_COMMITS = 400;
const MAX_FILES_NAMED = 5;
const READ_MS = 15000;
const PUSH_MS = 2 * 60 * 1000;
const SHA_RE = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;
const REMOTE_RE = /^(?!-)[\w.-]{1,100}$/;
const CHANGELOG_RE = /^(changelog|changes|history)\.md$/i;
const LOCK = 'package-lock.json';
const PKG = 'package.json';
const NOTES_DIR = 'changes';
const MAX_NOTES = 200;

const firstLine = s => String(s || '').trim().split('\n').filter(Boolean).pop() || '';
const fail = error => ({ ok: false, error });

// A release file that's a link (a repository can hold one) could point anywhere: never read or written through.
const isLink = file => { try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; } };

function readText(file) {
  if (isLink(file)) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** The CHANGELOG's file name in `root` (whatever its case), or null. */
function changelogName(root) {
  try { return fs.readdirSync(root).find(n => CHANGELOG_RE.test(n) && fs.statSync(path.join(root, n)).isFile()) || null; } catch { return null; }
}

/**
 * The change notes waiting for the next release: changes/*.md (README.md is
 * the folder's own), oldest name first. Only committed ones (`tracked`, from
 * git ls-files): a note still being written isn't part of what's released.
 * Links and anything huge are left out.
 * -> [{ name: 'changes/x.md', file, text }]
 */
function readNotes(root, tracked) {
  const dir = path.join(root, NOTES_DIR);
  if (isLink(dir)) return [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isFile() && /\.md$/i.test(e.name) && !/^readme\.md$/i.test(e.name) && tracked.has(`${NOTES_DIR}/${e.name}`))
    .map(e => e.name).sort().slice(0, MAX_NOTES)
    .map(n => ({ name: `${NOTES_DIR}/${n}`, file: path.join(dir, n), text: readText(path.join(dir, n)) }))
    .filter(n => n.text !== null && n.text.length <= R.NOTES_MAX);
}

function packageVersion(root) {
  const text = readText(path.join(root, PKG));
  if (text === null) return null;
  try { const v = JSON.parse(text).version; return typeof v === 'string' ? v : null; } catch { return null; }
}

/** `git status --porcelain=v1 -z` -> [path] of tracked files with changes (renames by their new name). */
function parseChanged(out) {
  const parts = String(out || '').split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    files.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') i++; // the old name follows
  }
  return files;
}

/** `git log` with %x1f between fields and %x1e after each commit -> [{ sha, author, at, subject, body }]. */
function parseLog(out) {
  return String(out || '').split('\x1e').map(r => r.replace(/^\s+/, '')).filter(Boolean).map(r => {
    const [sha, author, at, subject, body] = r.split('\x1f');
    return { sha, author, at: Number(at) * 1000 || null, subject: subject || '', body: (body || '').slice(0, 2000) };
  }).filter(c => SHA_RE.test(c.sha));
}

/** The branch a remote calls its main one, as this clone last saw it: origin/HEAD, else main, else master. */
async function defaultBranchOf(root, remote, git) {
  if (remote) {
    const head = await git(root, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], { timeout: READ_MS });
    const name = head.ok ? head.out.trim().slice(remote.length + 1) : '';
    if (BRANCH_RE.test(name)) return name;
  }
  const refs = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/main', 'refs/heads/master'], { timeout: READ_MS });
  return refs.ok ? refs.out.split('\n').map(s => s.trim()).find(Boolean) || null : null;
}

/**
 * Where a clone stands for its next release.
 * -> { ok: true, head, branch, defaultBranch, onDefault, last, total, truncated, groups,
 *      file, lock, changelog, next, draft, changes, upstream, unpushedTag }
 *  | { ok: false, error }
 */
async function readRelease(root, { git, now = Date.now } = {}) {
  const headR = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { timeout: READ_MS });
  const head = headR.ok ? headR.out.trim() : '';
  if (!SHA_RE.test(head)) return fail('This repository has no commits yet.');

  const [branchR, tagsR, statusR, upR, remotesR] = await Promise.all([
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: READ_MS }),
    git(root, ['tag', '--merged', 'HEAD', '--list'], { timeout: READ_MS }),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no'], { timeout: READ_MS }),
    git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { timeout: READ_MS }),
    git(root, ['remote'], { timeout: READ_MS }),
  ]);
  const branch = branchR.ok && BRANCH_RE.test(branchR.out.trim()) ? branchR.out.trim() : null;
  const remotes = remotesR.ok ? remotesR.out.split('\n').map(s => s.trim()).filter(r => REMOTE_RE.test(r)) : [];
  const remote = remotes.includes('origin') ? 'origin' : remotes[0] || null;
  const defaultBranch = await defaultBranchOf(root, remote, git);

  // The last release: the highest version tag this commit has in its history.
  const last = R.latestTag(tagsR.ok ? tagsR.out.split('\n') : []);
  if (last) {
    const at = await git(root, ['log', '-1', '--format=%ct', `refs/tags/${last.tag}^{commit}`], { timeout: READ_MS });
    last.at = at.ok ? Number(at.out.trim()) * 1000 || null : null;
  }
  const range = last ? `refs/tags/${last.tag}..HEAD` : 'HEAD';
  const [logR, countR] = await Promise.all([
    git(root, ['log', '--no-merges', '-n', String(MAX_COMMITS), '--format=%H%x1f%an%x1f%ct%x1f%s%x1f%b%x1e', range], { timeout: READ_MS }),
    git(root, ['rev-list', '--count', '--no-merges', range], { timeout: READ_MS }),
  ]);
  const commits = parseLog(logR.out);
  const total = countR.ok ? Number(countR.out.trim()) || commits.length : commits.length;
  const groups = R.groupCommits(commits);

  // Upstream: how far this branch is ahead of / behind its remote, as last fetched.
  let upstream = null;
  const upName = upR.ok ? upR.out.trim() : '';
  if (upName && BRANCH_RE.test(upName)) {
    const counts = await git(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], { timeout: READ_MS });
    const [behind, ahead] = counts.ok ? counts.out.trim().split(/\s+/).map(Number) : [0, 0];
    upstream = { name: upName, behind: behind || 0, ahead: ahead || 0 };
  }
  // A release tagged here whose commit the remote doesn't have yet: it still has to be pushed.
  let unpushedTag = null;
  if (last && upstream) {
    const pushed = await git(root, ['merge-base', '--is-ancestor', `refs/tags/${last.tag}^{commit}`, '@{upstream}'], { timeout: READ_MS });
    if (!pushed.ok) unpushedTag = last.tag;
  }

  const fileVersion = packageVersion(root);
  const lockExists = fs.existsSync(path.join(root, LOCK));
  const clName = changelogName(root);
  const clText = clName ? readText(path.join(root, clName)) || '' : '';
  const style = R.changelogStyle(clText);
  // Notes written alongside the work say it better than commit subjects can, so they're the draft when there are any.
  const trackedR = await git(root, ['ls-files', '-z', '--', NOTES_DIR], { timeout: READ_MS });
  const notes = readNotes(root, new Set(trackedR.ok ? trackedR.out.split('\0').filter(Boolean) : []));
  const sections = R.parseNotes(notes);
  const { bump, why } = R.withNotesBump(R.suggestBump(groups, last?.version || fileVersion), sections);
  const next = { ...R.nextVersions({ tagVersion: last?.version || null, fileVersion, bump }), bump, why };

  // Uncommitted changes: the files a release writes are fine (a CHANGELOG you or Claude wrote); others aren't.
  const releaseFiles = new Set([PKG, LOCK, clName || 'CHANGELOG.md'].map(f => f.toLowerCase()));
  const changed = parseChanged(statusR.out);
  const changes = {
    release: changed.filter(f => releaseFiles.has(f.toLowerCase())),
    other: changed.filter(f => !releaseFiles.has(f.toLowerCase())),
  };

  return {
    ok: true, head, branch, defaultBranch, onDefault: !defaultBranch || branch === defaultBranch, remote,
    last, total, truncated: total > commits.length, groups,
    file: fileVersion !== null ? { name: PKG, version: fileVersion } : null,
    lock: lockExists,
    changelog: { name: clName || 'CHANGELOG.md', exists: !!clName, style, hasEntry: R.hasEntry(clText, next.suggested) },
    next,
    draft: { notes: sections.length ? R.notesBody(sections, style) : R.draftBody(groups, style), date: R.dayOf(now()) },
    notes: notes.map(n => n.name),
    changes, upstream, unpushedTag,
    prefix: last?.prefix ?? 'v',
  };
}

/** What stops a release right now, in words, or null. state: readRelease's. */
function blocker(state) {
  if (!state?.ok) return state?.error || 'Couldn\'t read the repository.';
  if (!state.branch) return 'This clone isn\'t on a branch. Check out the main one first.';
  if (!state.onDefault) return `Releases are cut from ${state.defaultBranch}, and this clone is on ${state.branch}. Merge it first, then cut the release from ${state.defaultBranch}.`;
  if (state.changes.other.length) {
    const named = state.changes.other.slice(0, MAX_FILES_NAMED).join(', ');
    const more = state.changes.other.length - MAX_FILES_NAMED;
    return `There are uncommitted changes that aren't part of a release (${named}${more > 0 ? ` and ${more} more` : ''}). Commit them or put them away first.`;
  }
  if (state.upstream?.behind) return `${state.branch} is ${state.upstream.behind} commit${state.upstream.behind === 1 ? '' : 's'} behind ${state.upstream.name}. Pull first, so the release has everything.`;
  if (state.unpushedTag) return `${state.unpushedTag} is tagged on this PC but not pushed yet. Push it before cutting another.`;
  return null;
}

/**
 * Bring this branch's remote-tracking branch up to date, so "behind" means
 * behind the remote now, not as of the last fetch. Offline, the last fetch it is.
 */
async function fetchUpstream(root, { git, env = () => ({}) }) {
  const up = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { timeout: READ_MS });
  const [remote, ...rest] = up.ok ? up.out.trim().split('/') : [];
  const branch = rest.join('/');
  if (!remote || !REMOTE_RE.test(remote) || !BRANCH_RE.test(branch)) return;
  await git(root, [...NO_HOOKS, 'fetch', '--quiet', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { timeout: PUSH_MS, env: env() || {} });
}

/** Write a file, keeping what was there to put back. */
function writeKeeping(file, text, kept) {
  if (isLink(file)) throw new Error(`${path.basename(file)} is a link, so Shellby won't write through it`);
  kept.push({ file, was: readText(file) });
  fs.writeFileSync(file, text, 'utf8');
}

function putBack(kept) {
  for (const { file, was } of kept.reverse()) {
    try { if (was === null) fs.rmSync(file, { force: true }); else if (!isLink(file)) fs.writeFileSync(file, was, 'utf8'); } catch { /* the error that brought us here says more */ }
  }
}

/**
 * Cut a release. opts: { version, title, notes, head, push }
 *   head: the commit the draft was read at; a clone that has moved since isn't released.
 * deps: { git, env?(), now?() }
 * -> { ok: true, version, tag, commit, pushed, pushError? } | { ok: false, error, stale? }
 */
async function cutRelease(root, opts, deps) {
  const { git } = deps;
  await fetchUpstream(root, deps);
  const state = await readRelease(root, deps);
  const blocked = blocker(state);
  if (blocked) return fail(blocked);
  if (opts.head !== state.head) return { ok: false, stale: true, error: 'Something has changed in this clone since the draft. Look again.' };
  const version = String(opts.version || '').trim();
  if (!R.isVersion(version)) return fail('That isn\'t a version number like 1.2.3.');
  if (state.last && R.compareVersions(version, state.last.version) <= 0) return fail(`Pick a version after ${state.last.version}.`);
  if (!state.total && !state.next.prepared) return fail(`Nothing has been committed since ${state.last?.tag || 'the start'}.`);
  const tag = `${state.prefix}${version}`;
  const taken = await git(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { timeout: READ_MS });
  if (taken.ok) return fail(`There's already a tag called ${tag}.`);

  // The entry is capped, and the notes go once it's written: nothing of them may be cut off.
  if (String(opts.notes || '').trim().length > R.NOTES_MAX) return fail(`The CHANGELOG entry is longer than ${R.NOTES_MAX} characters. Shorten it first.`);
  const title = R.cleanTitle(opts.title);
  const kept = [];
  const files = [];
  try {
    if (state.file && state.file.version !== version) {
      const text = R.setPackageVersion(readText(path.join(root, PKG)) || '', version);
      if (text === null) return fail('Couldn\'t find the version in package.json to change it.');
      writeKeeping(path.join(root, PKG), text, kept);
      files.push(PKG);
    }
    const lockText = state.lock ? readText(path.join(root, LOCK)) : null;
    if (lockText !== null) {
      const text = R.setLockVersion(lockText, version);
      if (text !== null && text !== lockText) { writeKeeping(path.join(root, LOCK), text, kept); files.push(LOCK); }
    }
    const clFile = path.join(root, state.changelog.name);
    const clText = readText(clFile) || '';
    if (!R.hasEntry(clText, version)) {
      if (!String(opts.notes || '').trim()) { putBack(kept); return fail('Write something for the CHANGELOG first.'); }
      const style = state.changelog.exists ? state.changelog.style : 'keepachangelog';
      const entry = R.entryText({ style, version, title, date: state.draft.date, notes: opts.notes });
      writeKeeping(clFile, R.insertEntry(clText, entry), kept);
    }
    // A CHANGELOG entry you (or Claude) already wrote goes in as it is.
    if (state.changelog.exists || kept.some(k => k.file === clFile)) files.push(state.changelog.name);
    // The change notes are in the entry now (or in the one you wrote), so this release uses them up.
    for (const name of state.notes) {
      const file = path.join(root, ...name.split('/'));
      const was = readText(file);
      if (was === null) continue;
      kept.push({ file, was });
      fs.rmSync(file);
      files.push(name);
    }
  } catch (e) {
    putBack(kept);
    return fail(`Couldn't write the release files: ${e.message}`);
  }

  // Release files you changed by hand (a bumped package.json, say) go in the commit too.
  for (const f of state.changes.release) if (!files.some(x => x.toLowerCase() === f.toLowerCase())) files.push(f);
  const message = R.commitMessage({ version, tag, title });
  const add = await git(root, ['--literal-pathspecs', 'add', '--', ...files], { timeout: READ_MS });
  if (!add.ok) { putBack(kept); return fail(`Couldn't stage the release files: ${firstLine(add.error)}`); }
  // Everything already committed (a release prepared by hand, never tagged): just tag it.
  const staged = await git(root, ['diff', '--cached', '--quiet'], { timeout: READ_MS });
  if (!staged.ok) {
    const commit = await git(root, [...NO_HOOKS, 'commit', '--quiet', '-m', message], { timeout: 60000 });
    if (!commit.ok) {
      await git(root, ['--literal-pathspecs', 'reset', '--quiet', '--', ...files], { timeout: READ_MS });
      putBack(kept);
      return fail(`Couldn't commit the release: ${firstLine(commit.error) || 'git refused.'}`);
    }
  }
  const shaR = await git(root, ['rev-parse', 'HEAD'], { timeout: READ_MS });
  const sha = shaR.out.trim();
  const tagged = await git(root, [...NO_HOOKS, 'tag', '-a', tag, '-m', message, sha], { timeout: READ_MS });
  if (!tagged.ok) return { ok: false, committed: true, error: `Committed the release, but couldn't tag it: ${firstLine(tagged.error)}` };

  const out = { ok: true, version, tag, commit: sha, pushed: false };
  if (!opts.push) return out;
  const pushed = await pushRelease(root, { tag }, deps);
  return pushed.ok ? { ...out, pushed: true, remote: pushed.remote } : { ...out, pushError: pushed.error };
}

/**
 * Push the branch and its release tag together (--atomic: both or neither).
 * -> { ok: true, remote, branch } | { ok: false, error }
 */
async function pushRelease(root, { tag }, { git, env = () => ({}) }) {
  if (!R.parseTag(tag)) return fail('That isn\'t a release tag.');
  const [branchR, tagR, upR] = await Promise.all([
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: READ_MS }),
    git(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { timeout: READ_MS }),
    git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { timeout: READ_MS }),
  ]);
  const branch = branchR.ok ? branchR.out.trim() : '';
  if (!BRANCH_RE.test(branch)) return fail('This clone isn\'t on a branch.');
  if (!tagR.ok) return fail(`There's no tag called ${tag} here.`);
  const onBranch = await git(root, ['merge-base', '--is-ancestor', tagR.out.trim(), 'HEAD'], { timeout: READ_MS });
  if (!onBranch.ok) return fail(`${tag} isn't on ${branch}.`);
  // Where the branch goes: its upstream, else a branch of the same name on origin.
  const up = upR.ok ? upR.out.trim() : '';
  const remotes = await git(root, ['remote'], { timeout: READ_MS });
  const names = remotes.ok ? remotes.out.split('\n').map(s => s.trim()).filter(Boolean) : [];
  const remote = names.find(r => up.startsWith(`${r}/`)) || (names.includes('origin') ? 'origin' : names[0]);
  if (!remote || !REMOTE_RE.test(remote)) return fail('This clone has no remote to push to.');
  const dest = up.startsWith(`${remote}/`) ? up.slice(remote.length + 1) : branch;
  if (!BRANCH_RE.test(dest)) return fail('This clone\'s upstream branch has an odd name.');
  const push = await git(root, [...NO_HOOKS, 'push', '--atomic', '--quiet', remote, `refs/heads/${branch}:refs/heads/${dest}`, `refs/tags/${tag}:refs/tags/${tag}`],
    { timeout: PUSH_MS, env: env() || {} });
  if (!push.ok) return fail(`The push didn't go through: ${firstLine(push.error) || 'git refused it.'}`);
  if (!up) await git(root, ['branch', '--quiet', `--set-upstream-to=${remote}/${dest}`], { timeout: READ_MS });
  return { ok: true, remote, branch: dest };
}

/**
 * CI on the commit about to be released, from GitHub: 'passing' | 'pending' |
 * 'failing' | 'none', with what failed. null when GitHub couldn't say.
 */
async function ciOf(gh, repo, sha) {
  if (!gh || !repo || !SHA_RE.test(String(sha))) return null;
  const base = `/repos/${repo}/commits/${sha}`;
  const [runs, status] = await Promise.all([
    gh.get(`${base}/check-runs?per_page=100`).catch(() => null),
    gh.get(`${base}/status`).catch(() => null),
  ]);
  if (!runs && !status) return null;
  return verdict(runs?.check_runs, status?.statuses);
}

module.exports = { readRelease, cutRelease, pushRelease, blocker, ciOf, parseChanged, parseLog, MAX_COMMITS };
