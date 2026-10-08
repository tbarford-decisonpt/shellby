// Which GitLab project a git remote points at, and the names Shellby gives a
// merge request. Pure.
//
// GitLab projects live under groups that nest ("group/sub/project"), so a
// project's path has two or more segments, unlike GitHub's owner/name. A
// remote is read in the shapes git itself writes:
//   https://host/group/project(.git)
//   git@host:group/project(.git)
//   ssh://git@host(:port)/group/project(.git)
// Whether the host is a GitLab at all is the caller's to say (isGitLabHost):
// a remote on GitHub never is, and a token in the URL never parses.
const { checkHost } = require('./glab');

// GitLab's own grammar for a path segment: letters, digits, _ . - and +, not
// starting with - or ., not ending in .git or .atom.
const SEGMENT_RE = /^(?![-.])[A-Za-z0-9_.+-]{1,255}$/;
const MAX_SEGMENTS = 20;
const KEY_RE = /^(.+)!(\d{1,9})$/;

/** "group/sub/project" if every segment is one GitLab allows, else null. */
function checkPath(p) {
  if (typeof p !== 'string' || p.length > 1000) return null;
  const parts = p.split('/');
  if (parts.length < 2 || parts.length > MAX_SEGMENTS) return null;
  if (!parts.every(s => SEGMENT_RE.test(s) && !/\.(git|atom)$/i.test(s) && s !== '.' && s !== '..')) return null;
  return parts.join('/');
}

/** A remote URL -> { host, path } for any host but GitHub's, or null. */
function forgeRepoOf(url) {
  const u = String(url ?? '').trim();
  if (!u || u.length > 600 || /\s/.test(u)) return null;
  let host, rest;
  let m = /^https:\/\/([^/@?#]+)\/([^?#]+)$/i.exec(u);
  if (m) { host = m[1]; rest = m[2]; }
  m = m || /^(?:[A-Za-z0-9._-]+)@([^:/]+):(?!\/)([^?#]+)$/.exec(u);
  if (m && !host) { host = m[1]; rest = m[2]; }
  m = m || /^ssh:\/\/(?:[A-Za-z0-9._-]+@)?([^/@?#]+?)(?::\d{1,5})?\/([^?#]+)$/i.exec(u);
  if (m && !host) { host = m[1]; rest = m[2]; }
  if (!host) return null;
  const h = checkHost(host);
  if (!h || h === 'github.com' || h.endsWith('.github.com')) return null;
  const p = checkPath(String(rest).replace(/\/+$/, '').replace(/\.git$/i, ''));
  return p ? { host: h, path: p } : null;
}

/**
 * Is this a GitLab host? gitlab.com, any host you listed in Settings, and any
 * whose name says so (gitlab.example.org). glab is what settles it: a host it
 * isn't signed in to just never answers.
 */
function isGitLabHost(host, listed = []) {
  const h = checkHost(host);
  if (!h) return false;
  if (h === 'gitlab.com' || listed.map(checkHost).includes(h)) return true;
  return /(^|[.-])gitlab([.-]|$)/.test(h.replace(/:\d+$/, ''));
}

/** A remote URL -> { host, path } on a GitLab, or null. */
function gitlabRepoOf(url, listed = []) {
  const r = forgeRepoOf(url);
  return r && isGitLabHost(r.host, listed) ? r : null;
}

/**
 * A merge request's key: "group/project!12" on gitlab.com, "host/group/project!12"
 * elsewhere, so two hosts' projects never share one. GitLab writes merge
 * requests with "!", where GitHub writes "#".
 */
function mrKey(host, path, iid) {
  return host === 'gitlab.com' ? `${path}!${iid}` : `${host}/${path}!${iid}`;
}

/** Is this one of mrKey's? GitHub's keys use "#", never "!". */
const isMrKey = key => typeof key === 'string' && KEY_RE.test(key);

/** The merge request's page, built here rather than taken from an answer. */
const mrUrl = (host, path, iid) => `https://${host}/${path}/-/merge_requests/${iid}`;

/** The project's tags page, where a tag the Releases card pushed shows up. */
const tagsUrl = (host, path) => `https://${host}/${path}/-/tags`;

module.exports = { checkPath, forgeRepoOf, isGitLabHost, gitlabRepoOf, mrKey, isMrKey, mrUrl, tagsUrl };
