// Checks the release workflow runs before it builds and before it publishes,
// so a release can only go out as the version it says it is, with every file
// the auto-updater needs.
//
// Why: in 0.21.1 a tag briefly pointed at the wrong commit. That run built
// 0.21.0 (package.json's version), uploaded it under v0.21.0, then published an
// empty v0.21.1 as "latest". The real 0.21.1 run found the release already
// published, so electron-builder skipped its uploads without failing, and every
// Shellby's update check hit a 404 for latest.yml.
//
// And in 0.63.0 and 0.64.0 the tag went on a commit whose CI on main had
// already failed. Each release built for ten minutes, failed the same e2e
// check, and used up a version number ("0.64.0, delivered" shipped as 0.64.2).
// So a tag has to wait for CI on its own commit to finish green.
//
//   node scripts/release-guard.js ready [vX.Y.Z] [--wait]
//                                             on this PC, before pushing a tag: version,
//                                             CHANGELOG, tag not taken, CI green on the commit
//   node scripts/release-guard.js preflight   before building: tag, commit, release state, CI not red
//   node scripts/release-guard.js verify      before publishing: the draft has everything
//
// preflight and verify read GITHUB_REF_NAME and GITHUB_SHA and talk to GitHub
// through `gh` and `git`. ready needs only `git` and the public API (GH_TOKEN
// or GITHUB_TOKEN is used if set). The decisions are pure functions, tested in
// test/release-guard.test.js.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** The tag has to be exactly v + package.json's version. */
function checkTagMatchesVersion(tag, version) {
  if (tag === `v${version}`) return null;
  return `Tag ${tag} doesn't match package.json's version ${version}. Bump the version and tag that commit, or delete the tag.`;
}

/** `git ls-remote origin refs/tags/X refs/tags/X^{}` -> the commit the tag points at (peeled for annotated tags). */
function commitFromLsRemote(output, tag) {
  const lines = String(output || '').trim().split('\n').map(l => l.trim().split(/\s+/)).filter(p => p.length === 2);
  const peeled = lines.find(([, ref]) => ref === `refs/tags/${tag}^{}`);
  const plain = lines.find(([, ref]) => ref === `refs/tags/${tag}`);
  return (peeled || plain)?.[0] || null;
}

/** The tag must still point at the commit this run is building; a re-tag means a newer run owns it. */
function checkTagStillHere(remoteSha, sha, tag) {
  if (!remoteSha) return `Tag ${tag} no longer exists on GitHub. Not releasing.`;
  if (remoteSha !== sha) return `Tag ${tag} now points at ${remoteSha.slice(0, 7)}, not ${sha.slice(0, 7)} (this run). A newer run owns this tag. Not releasing.`;
  return null;
}

/**
 * Before building: a release for this tag may not exist yet, or may be a
 * draft, but must not be published. electron-builder silently skips uploading
 * to a published release, which is how 0.21.1 went out empty.
 *   release: null (none) | { isDraft }
 */
function checkExistingRelease(release, tag) {
  if (!release || release.isDraft) return null;
  return `Release ${tag} is already published, so electron-builder would skip its uploads. To rebuild it, delete the release (the tag can stay) and re-run.`;
}

/** The files a release needs for download and for auto-update. */
function requiredAssets(version) {
  return [
    'latest.yml',
    `Shellby-Setup-${version}.exe`,
    `Shellby-Setup-${version}.exe.blockmap`,
    `Shellby-Portable-${version}.exe`,
    'SHA256SUMS.txt',
  ];
}

/** Before publishing: every required file is attached. */
function checkAssets(names, version) {
  const have = new Set(names || []);
  const missing = requiredAssets(version).filter(n => !have.has(n));
  return missing.length ? `The draft release is missing ${missing.join(', ')}. Not publishing.` : null;
}

/** latest.yml must describe this version and its installer, or updaters fetch the wrong thing. */
function checkLatestYml(text, version) {
  const s = String(text || '');
  const v = s.match(/^version:\s*['"]?([^'"\s]+)/m)?.[1];
  if (v !== version) return `latest.yml says version ${v || '(none)'}, not ${version}. Not publishing.`;
  if (!s.includes(`Shellby-Setup-${version}.exe`)) return `latest.yml doesn't point at Shellby-Setup-${version}.exe. Not publishing.`;
  return null;
}

/**
 * CI (ci.yml) on the commit being released. The newest run for that exact
 * commit decides: a re-run that went green counts, an older green run under a
 * newer red one doesn't.
 *   runs: the API's workflow_runs ({ head_sha, status, conclusion, created_at, html_url })
 *   jobs: the newest run's jobs ({ name, status, conclusion }), when it's still
 *   going: one red job already decides it, without waiting out the rest.
 *   -> { state: 'green' | 'running' | 'missing' | 'failed', problem: string | null }
 */
function checkCiRuns(runs, sha, jobs = []) {
  const short = String(sha).slice(0, 7);
  const newest = newestRun(runs, sha);
  if (!newest) return { state: 'missing', problem: `CI hasn't run on ${short}. Push it to main, and tag it once CI is green.` };
  const where = newest.html_url ? ` (${newest.html_url})` : '';
  if (newest.status !== 'completed') {
    const red = (jobs || []).filter(j => j?.status === 'completed' && RED.has(j.conclusion));
    if (red.length) {
      return { state: 'failed', conclusion: red[0].conclusion, problem: `${red.map(j => j.name).join(', ')} failed on ${short}${where}, so the release would fail the same way. Fix main first; the fix ships as the next version.` };
    }
    return { state: 'running', problem: `CI is still running on ${short}${where}. Tag it once it's green, or run with --wait.` };
  }
  if (newest.conclusion !== 'success') {
    const why = RED.has(newest.conclusion)
      ? 'so the release would fail the same way. Fix main first; the fix ships as the next version.'
      : 'so it never proved anything. Re-run it, and tag once it\'s green.';
    return { state: 'failed', conclusion: newest.conclusion, problem: `CI ended "${newest.conclusion}" on ${short}${where}, ${why}` };
  }
  return { state: 'green', conclusion: 'success', problem: null };
}

// The conclusions that mean the tests themselves failed, not that the run was
// cut short (cancelled, skipped): only these stop a tag that's already pushed.
const RED = new Set(['failure', 'timed_out']);

// What `release:cut` writes in a release commit: the version, the CHANGELOG, and
// the change notes it gathered (and removed). Nothing CI tests differently.
const PACKAGE_FILES = new Set(['package.json', 'package-lock.json']);
const NOTE = /^changes\/(?!README\.md$)[^/]+\.md$/;
// The commits API lists this many files at most: a list that long may hide more.
const API_FILES_MAX = 300;

/** One file of a commit, as the commits API lists it, could be part of a release cut. */
function releaseFile({ filename, status } = {}) {
  if (PACKAGE_FILES.has(filename)) return status === 'modified'; // and only its version (onlyVersionChanged)
  if (filename === 'CHANGELOG.md') return status === 'modified' || status === 'added';
  return NOTE.test(String(filename)) && (status === 'removed' || status === 'modified');
}

/**
 * A commit that only cuts a release: its parent's green CI vouches for it, so
 * the tag needn't wait for a second run (or the release rerun every check) for
 * a change to a version number. Renames and new files never count (a rename
 * hides what went), and the package files' contents are checked separately.
 *   files: the commits API's files ({ filename, status })
 */
function releaseOnly(files) {
  return Array.isArray(files) && files.length > 0 && files.length < API_FILES_MAX && files.every(releaseFile);
}

/**
 * package.json or package-lock.json before and after, as text: the same once
 * the project's own version is left out. A dependency bump touches these files
 * too, and that is not something a parent's CI has tested. Pure.
 */
function onlyVersionChanged(before, after) {
  const strip = text => {
    const j = JSON.parse(text);
    delete j.version;
    if (j.packages?.['']) delete j.packages[''].version;
    return JSON.stringify(j);
  };
  try { return strip(before) === strip(after); } catch { return false; }
}

/** The CHANGELOG at the release commit has a "## X.Y.Z" heading for it. */
function checkChangelog(text, version) {
  const esc = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^##\\s+${esc}(?![\\d.])`, 'm').test(String(text || ''))) return null;
  return `CHANGELOG.md has no "## ${version}" section at this commit.`;
}

/** A tag already on GitHub has been built (or tried); a failed one gets a new patch, never a moved tag. */
function checkTagFree(remoteSha, tag) {
  if (!remoteSha) return null;
  return `${tag} is already on GitHub (at ${remoteSha.slice(0, 7)}). If that release failed, ship the fix as the next patch, don't move the tag.`;
}

// SignPath signs after electron-builder is done, so like an unsigned build its
// app-update.yml names no publisher, and its installs take any update.
const SIGNPATH_PUBLISHER = 'SignPath Foundation';

/**
 * Who signs this build, from the release workflow's signing settings: a name,
 * or null for unsigned. Azure needs the same five settings as the build step,
 * which quietly builds unsigned if any is missing (an expired secret that's
 * still set fails the build itself instead).
 */
function expectedPublisher(env) {
  if (env.SIGNPATH_ORGANIZATION_ID) return SIGNPATH_PUBLISHER;
  const azure = ['AZURE_CLIENT_SECRET', 'AZURE_SIGN_ENDPOINT', 'AZURE_SIGN_ACCOUNT', 'AZURE_SIGN_PROFILE', 'AZURE_SIGN_PUBLISHER'];
  return azure.every(k => env[k]) ? env.AZURE_SIGN_PUBLISHER : null;
}

/**
 * An installer electron-builder signed with Azure writes its publisher into
 * app-update.yml, and from then on that install refuses any update not signed
 * by exactly that name, unsigned ones included. It fails quietly: Shellby just
 * stops updating. So once a release is Azure-signed, every later one has to be
 * signed by the same name, unless the switch is deliberate (docs/SIGNING.md).
 *   previous: the signer of the latest published installer, or null if unsigned
 *   next: who signs this build, or null if unsigned
 */
function checkPublisherContinuity(previous, next, allowChange) {
  if (!previous || previous === SIGNPATH_PUBLISHER || previous === next || allowChange) return null;
  const now = next ? `would be signed by "${next}"` : 'would be unsigned';
  return `The last release was signed by "${previous}", and this one ${now}. Installs of the last release would refuse the update and stop updating without saying so. Check the signing secrets and variables (docs/SIGNING.md). If changing publisher is deliberate, read "Changing publisher" there first.`;
}

// ------------------------------------------------------------------ running it

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function releaseView(tag) {
  try {
    return JSON.parse(run('gh', ['release', 'view', tag, '--json', 'isDraft,assets']));
  } catch (e) {
    if (/release not found/i.test(String(e.stderr || e.message))) return null;
    throw e;
  }
}

function remoteTagSha(tag) {
  return commitFromLsRemote(run('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]), tag);
}

/** The signer of the latest published release's installer: its name, or null if unsigned or there's none. */
function previousPublisher() {
  let tag;
  try {
    tag = JSON.parse(run('gh', ['release', 'view', '--json', 'tagName'])).tagName;
  } catch (e) {
    if (/release not found|HTTP 404/i.test(String(e.stderr || e.message))) return null;
    throw e;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-signer-'));
  try {
    run('gh', ['release', 'download', tag, '--pattern', 'Shellby-Setup-*.exe', '--dir', dir]);
    const exe = fs.readdirSync(dir).find(f => f.endsWith('.exe'));
    if (!exe) return null;
    // Anything but Valid counts as unsigned: electron-updater wouldn't have
    // been given a publisher for a build whose signature didn't hold up.
    const ps = `$s = Get-AuthenticodeSignature -LiteralPath $env:SIGNED_EXE; if ($s.Status -eq 'Valid') { $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) }`;
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SIGNED_EXE: path.join(dir, exe) },
    }).trim();
    return out || null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** owner/repo: the workflow's own in CI, package.json's repository on this PC. */
function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).repository?.url || '';
  const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  if (!m) throw new Error(`Can't tell the GitHub repo from package.json's repository (${url || 'none'}).`);
  return m[1];
}

/** ci.yml's runs for one commit, through the public API (no `gh` needed). */
async function api(route, sha, { raw = false } = {}) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const res = await fetch(`https://api.github.com/repos/${repoSlug()}/${route}`, {
    headers: { accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json', 'user-agent': 'shellby-release-guard', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} when asked about CI on ${sha.slice(0, 7)}.`);
  return raw ? res.text() : res.json();
}

/** The newest of a commit's runs. */
const newestRun = (runs, sha) => (runs || []).filter(r => r && r.head_sha === sha)
  .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];

/** CI on one commit, with the jobs of a run still going (so a red one counts at once). */
async function ciOnCommit(sha) {
  const runs = (await api(`actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=20`, sha)).workflow_runs || [];
  const ci = checkCiRuns(runs, sha);
  if (ci.state !== 'running') return ci;
  return checkCiRuns(runs, sha, (await api(`actions/runs/${newestRun(runs, sha).id}/jobs?per_page=100`, sha)).jobs);
}

/**
 * CI on the commit being released. A commit that only cuts the release
 * (releaseOnly, and its package files only change the version) goes by its
 * parent's run while its own hasn't finished or was cancelled: the tag needn't
 * wait for CI to test a version number. Its own run carries on, and a red job
 * there after the tag is pushed is too late to stop the build; that's the
 * trade for a commit that can't change what the tests see.
 */
async function ciOn(sha) {
  const own = await ciOnCommit(sha);
  if (own.state === 'green' || (own.state === 'failed' && RED.has(own.conclusion))) return own;
  const commit = await api(`commits/${sha}`, sha);
  const parent = commit.parents?.length === 1 ? commit.parents[0].sha : null;
  if (!parent || !releaseOnly(commit.files)) return own;
  for (const { filename } of commit.files.filter(f => PACKAGE_FILES.has(f.filename))) {
    const [before, after] = await Promise.all([parent, sha].map(ref => api(`contents/${filename}?ref=${ref}`, sha, { raw: true })));
    if (!onlyVersionChanged(before, after)) return own;
  }
  const before = await ciOnCommit(parent);
  if (before.state === 'green') return { ...before, vouchedBy: parent };
  return before.state === 'failed' ? before : own;
}

const WAIT_EVERY_MS = 30_000;
const WAIT_UP_TO_MS = 45 * 60_000;

/** On this PC, before the tag is pushed: is this commit ready to be a release? */
async function ready(args) {
  const wait = args.includes('--wait');
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const tag = args.find(a => !a.startsWith('-')) || `v${version}`;
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // The tag if it's been made here already, otherwise what would be tagged: HEAD.
  let sha;
  try { sha = git('rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`); } catch { sha = git('rev-parse', 'HEAD'); }
  const at = file => { try { return git('show', `${sha}:${file}`); } catch { return ''; } };
  const tagVersion = (() => { try { return JSON.parse(at('package.json')).version; } catch { return '(unreadable)'; } })();

  const problems = [
    checkTagMatchesVersion(tag, tagVersion),
    checkChangelog(at('CHANGELOG.md'), tagVersion),
    checkTagFree(commitFromLsRemote(run('git', ['-C', ROOT, 'ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]), tag), tag),
  ].filter(Boolean);
  if (problems.length) return { ok: false, problems };

  const ci = await waitForCi(sha, { wait });
  if (ci.state !== 'green') return { ok: false, problems: [ci.problem] };
  const on = ci.vouchedBy ? `CI is green on ${ci.vouchedBy.slice(0, 7)} before it (this commit only cuts the release)` : 'CI is green on it';
  return { ok: true, problems: [], note: `${tag} is ${tagVersion} at ${sha.slice(0, 7)}, and ${on}. Ready to tag and push.` };
}

/**
 * CI on a commit, waited for (wait) while it's running or hasn't started, until
 * it's green or anything in it fails. -> ciOn's answer.
 */
async function waitForCi(sha, { wait = false, log = console.log } = {}) {
  const started = Date.now();
  for (;;) {
    const ci = await ciOn(sha);
    const pending = ci.state === 'running' || ci.state === 'missing';
    if (!wait || !pending || Date.now() - started > WAIT_UP_TO_MS) return ci;
    log(`Waiting: ${ci.problem}`);
    await sleep(WAIT_EVERY_MS);
  }
}

async function main(step, args) {
  if (step === 'ready') {
    const { ok, problems, note } = await ready(args);
    for (const p of problems) console.log(`Not ready: ${p}`);
    if (!ok) process.exit(1);
    console.log(note);
    return;
  }
  const tag = process.env.GITHUB_REF_NAME;
  const sha = process.env.GITHUB_SHA;
  if (!tag || !sha) throw new Error('GITHUB_REF_NAME and GITHUB_SHA must be set (this runs in the release workflow).');
  const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

  const problems = [checkTagMatchesVersion(tag, version), checkTagStillHere(remoteTagSha(tag), sha, tag)];
  if (step === 'preflight') {
    problems.push(checkExistingRelease(releaseView(tag), tag));
    // Only a red CI stops it here: one still running is the release's own tests
    // racing it, and they run below anyway. Red means those tests fail too, so
    // stop now, not after ten minutes of building. Anything less certain (a
    // cancelled run, GitHub not answering) lets the release's own tests decide:
    // a tag that fails here can't be moved, so it must only fail for a reason.
    // Green (on this commit, or its parent for a release-only commit) has
    // already run every check on this code: the release skips its own e2e
    // (ci_green, release.yml) instead of spending 20 minutes repeating them.
    try {
      const ci = await ciOn(sha);
      if (ci.state === 'failed' && RED.has(ci.conclusion)) problems.push(ci.problem);
      if (ci.state === 'green' && process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'ci_green=true\n');
    } catch (e) {
      console.log(`::warning::Couldn't check CI on ${sha.slice(0, 7)} (${e.message}); the release's own tests decide.`);
    }
    // Same rule: only a sure mismatch stops the tag. The Check signatures step
    // still confirms this build's own signer before anything is published.
    try {
      const allow = process.env.ALLOW_PUBLISHER_CHANGE === 'true';
      problems.push(checkPublisherContinuity(previousPublisher(), expectedPublisher(process.env), allow));
    } catch (e) {
      console.log(`::warning::Couldn't check who signed the last release (${e.message}).`);
    }
  } else if (step === 'verify') {
    const release = releaseView(tag);
    if (!release) problems.push(`There's no release ${tag} to publish.`);
    else if (!release.isDraft) problems.push(`Release ${tag} was published by something else mid-run. Not touching it.`);
    else {
      const assetProblem = checkAssets(release.assets.map(a => a.name), version);
      problems.push(assetProblem || checkLatestYml(run('gh', ['release', 'download', tag, '--pattern', 'latest.yml', '--output', '-']), version));
    }
  } else {
    throw new Error(`Unknown step "${step}": use ready, preflight or verify.`);
  }

  const found = problems.filter(Boolean);
  for (const p of found) console.log(`::error::${p}`);
  if (found.length) process.exit(1);
  console.log(`${step}: ${tag} is ${version} at ${sha.slice(0, 7)}, all good.`);
}

if (require.main === module) {
  main(process.argv[2], process.argv.slice(3)).catch(e => {
    console.log(process.env.GITHUB_ACTIONS ? `::error::${e.message}` : `Not ready: ${e.message}`);
    process.exit(1);
  });
}

module.exports = {
  checkTagMatchesVersion, commitFromLsRemote, checkTagStillHere, checkExistingRelease, requiredAssets, checkAssets, checkLatestYml,
  checkCiRuns, releaseOnly, onlyVersionChanged, checkChangelog, checkTagFree, expectedPublisher, checkPublisherContinuity, ciOn, waitForCi, repoSlug,
};
