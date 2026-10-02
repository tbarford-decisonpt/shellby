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
//   node scripts/release-guard.js preflight   before building: tag, commit, release state
//   node scripts/release-guard.js verify      before publishing: the draft has everything
//
// Reads GITHUB_REF_NAME and GITHUB_SHA; talks to GitHub through `gh` and `git`.
// The decisions are pure functions, tested in test/release-guard.test.js.
const { execFileSync } = require('child_process');
const fs = require('fs');
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

function main(step) {
  const tag = process.env.GITHUB_REF_NAME;
  const sha = process.env.GITHUB_SHA;
  if (!tag || !sha) throw new Error('GITHUB_REF_NAME and GITHUB_SHA must be set (this runs in the release workflow).');
  const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

  const problems = [checkTagMatchesVersion(tag, version), checkTagStillHere(remoteTagSha(tag), sha, tag)];
  if (step === 'preflight') {
    problems.push(checkExistingRelease(releaseView(tag), tag));
  } else if (step === 'verify') {
    const release = releaseView(tag);
    if (!release) problems.push(`There's no release ${tag} to publish.`);
    else if (!release.isDraft) problems.push(`Release ${tag} was published by something else mid-run. Not touching it.`);
    else {
      const assetProblem = checkAssets(release.assets.map(a => a.name), version);
      problems.push(assetProblem || checkLatestYml(run('gh', ['release', 'download', tag, '--pattern', 'latest.yml', '--output', '-']), version));
    }
  } else {
    throw new Error(`Unknown step "${step}": use preflight or verify.`);
  }

  const found = problems.filter(Boolean);
  for (const p of found) console.log(`::error::${p}`);
  if (found.length) process.exit(1);
  console.log(`${step}: ${tag} is ${version} at ${sha.slice(0, 7)}, all good.`);
}

if (require.main === module) {
  try { main(process.argv[2]); } catch (e) { console.log(`::error::${e.message}`); process.exit(1); }
}

module.exports = { checkTagMatchesVersion, commitFromLsRemote, checkTagStillHere, checkExistingRelease, requiredAssets, checkAssets, checkLatestYml };
