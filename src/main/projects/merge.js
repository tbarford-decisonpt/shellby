// One list of projects from two sources: the git repositories on this PC
// (local.js) and your repositories on GitHub (github.js). A clone whose origin
// is on GitHub and that repository are one project; several clones of one
// repository are one project with several clones. Pure.
const path = require('path');
const { checkRepo } = require('./remote');

const caseKey = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const repoKey = repo => `github:${repo.toLowerCase()}`;
const localKey = root => `local:${caseKey(root)}`;

/**
 * local:  [{ root, name, remote: "owner/name" | null, branch }]
 * github: [{ repo, private, url, description, pushedAt, archived, fork }]
 * opts:   { hidden: Set(project key), lastWorked: Map(caseKey(root) -> ms), running: Set(caseKey(root)) }
 * -> [{ key, name, github | null, local: [{ root, branch, main }], lastWorkedAt, running }], sorted.
 */
function merge(local = [], github = [], { hidden = new Set(), lastWorked = new Map(), running = new Set() } = {}) {
  const byKey = new Map();
  const project = key => {
    let p = byKey.get(key);
    if (!p) { p = { key, name: '', github: null, local: [], lastWorkedAt: 0, running: false }; byKey.set(key, p); }
    return p;
  };

  for (const g of github) {
    const repo = checkRepo(g?.repo);
    if (!repo) continue;
    const p = project(repoKey(repo));
    p.github = { ...g, repo };
    p.name = repo.split('/')[1];
  }

  const seenRoots = new Set();
  for (const l of local) {
    if (!l?.root || seenRoots.has(caseKey(l.root))) continue;
    seenRoots.add(caseKey(l.root));
    const repo = checkRepo(l.remote);
    const p = project(repo ? repoKey(repo) : localKey(l.root));
    if (!p.name) p.name = l.name || path.basename(l.root);
    p.local.push({ root: l.root, branch: l.branch || null, main: false });
    p.lastWorkedAt = Math.max(p.lastWorkedAt, lastWorked.get(caseKey(l.root)) || 0);
    if (running.has(caseKey(l.root))) p.running = true;
  }

  const out = [];
  for (const p of byKey.values()) {
    if (hidden.has(p.key)) continue;
    // The clone you work in most comes first, and is "the" checkout.
    p.local.sort((a, b) => (lastWorked.get(caseKey(b.root)) || 0) - (lastWorked.get(caseKey(a.root)) || 0) || a.root.localeCompare(b.root));
    if (p.local[0]) p.local[0].main = true;
    out.push(p);
  }
  return out.sort(byInterest);
}

// Worked on lately, then has a server running, then on this PC, then GitHub's
// last push, then by name.
function byInterest(a, b) {
  return (b.lastWorkedAt - a.lastWorkedAt)
    || (Number(b.running) - Number(a.running))
    || (Number(b.local.length > 0) - Number(a.local.length > 0))
    || ((b.github?.pushedAt || 0) - (a.github?.pushedAt || 0))
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

module.exports = { merge, repoKey, localKey, caseKey };
