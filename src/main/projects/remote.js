// Which GitHub repository a git remote points at, so a clone on this PC and the
// repository on GitHub come together as one project (merge.js). Pure.
//
// Only github.com, and only the shapes git itself writes:
//   https://github.com/owner/name(.git)
//   git@github.com:owner/name(.git)
//   ssh://git@github.com/owner/name(.git)
// Anything else (another host, a local path, a token in the URL) is not GitHub.

// GitHub's own grammar: owners are letters, digits and single hyphens; names
// add dots and underscores. "." and ".." are never names.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** "owner/name" if it is a valid GitHub repository name, else null. */
function checkRepo(repo) {
  if (typeof repo !== 'string') return null;
  const [owner, name, ...rest] = repo.split('/');
  if (rest.length || !OWNER_RE.test(owner || '') || !NAME_RE.test(name || '') || name === '.' || name === '..') return null;
  return `${owner}/${name}`;
}

/** A remote URL -> "owner/name" on github.com, or null. */
function githubRepoOf(url) {
  const u = String(url ?? '').trim();
  if (!u || u.length > 400) return null;
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/)([^/?#\s]+\/[^/?#\s]+?)(?:\.git)?\/?$/i.exec(u);
  return m ? checkRepo(m[1]) : null;
}

/** The URL Shellby clones from: built here, never taken from an API answer. */
function cloneUrl(repo) {
  const r = checkRepo(repo);
  return r ? `https://github.com/${r}.git` : null;
}

module.exports = { githubRepoOf, checkRepo, cloneUrl };
