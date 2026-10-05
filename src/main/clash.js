// Clash warnings across copies (pure). Two copies of the same repository that
// will be merged into the same branch, and have both changed the same file,
// are going to clash when they're brought home. So is a copy that changed a
// file you have uncommitted changes to in your own checkout: git won't merge
// over them. Said as soon as it happens, not when Bring it home stops.
//
// The git side (what each copy has changed) is clash-scan.js; this only
// compares lists of paths, so it's all testable without a repository.

// A clash lists this many files at most; the rest is a count.
const MAX_FILES = 12;

// Lockfiles clash all the time and are regenerated rather than merged by
// hand, so they're listed after the files someone actually wrote.
const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock',
  'cargo.lock', 'poetry.lock', 'pipfile.lock', 'uv.lock', 'gemfile.lock', 'composer.lock', 'go.sum',
  'pubspec.lock', 'mix.lock', 'flake.lock', 'packages.lock.json',
]);

const isLockfile = p => LOCKFILES.has(String(p).split('/').pop().toLowerCase());

/** Deduped, written files first, then lockfiles; alphabetical within each. */
function sortFiles(files) {
  const uniq = [...new Set((files || []).filter(f => typeof f === 'string' && f))];
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return uniq.sort((a, b) => (isLockfile(a) - isLockfile(b)) || cmp(a, b));
}

// Windows paths: one spelling per folder, whatever the case or slashes.
const rootKey = root => String(root || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const memberId = m => (m.checkout ? 'checkout' : `tab:${m.tabId}`);

/**
 * `git status --porcelain -z` -> the paths it names. A rename names both ends
 * (the old path is changed too: it's gone). Ignored entries are left out.
 */
function parseStatusZ(out) {
  const parts = String(out || '').split('\0');
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4 || e.startsWith('!!')) continue;
    paths.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') { if (parts[i + 1]) paths.push(parts[i + 1]); i++; }
  }
  return paths;
}

/** `git diff --name-only -z` -> the paths. */
const parseNamesZ = out => String(out || '').split('\0').map(s => s.trim()).filter(Boolean);

function validMember(m) {
  if (!m || typeof m !== 'object' || typeof m.root !== 'string' || !m.root || !Array.isArray(m.files)) return false;
  return m.checkout ? true : typeof m.tabId === 'string' && !!m.tabId && typeof m.base === 'string' && !!m.base;
}

const shownMember = m => (m.checkout
  ? { checkout: true, tabId: null, title: 'your checkout', branch: typeof m.branch === 'string' ? m.branch : null }
  : { tabId: m.tabId, title: typeof m.title === 'string' && m.title ? m.title : m.branch || 'a tab', branch: typeof m.branch === 'string' ? m.branch : null });

/**
 * Who changed the same files as whom.
 *   copies: [{ tabId, title, branch, base, root, files: [path] }], plus at most
 *     one { checkout: true, root, branch, files } per repository: uncommitted
 *     changes in your own checkout, which clash with a copy of any base.
 *   -> [{ key, root, base, files, more, copies: [{ tabId, title, branch, checkout? }] }]
 * Copies only clash with copies going home to the same branch of the same
 * repository. Files changed by the same set of copies make one clash, so three
 * copies on one file is one clash, not three pairs. Ordered by repository,
 * branch, then who's in it, so the same input always reads the same.
 */
function findClashes(copies) {
  const groups = new Map();  // rootKey|base -> [copy]
  const checkouts = new Map(); // rootKey -> checkout entry
  const seen = new Set();
  for (const m of copies || []) {
    if (!validMember(m)) continue;
    const rk = rootKey(m.root);
    if (m.checkout) { if (!checkouts.has(rk)) checkouts.set(rk, m); continue; }
    if (seen.has(m.tabId)) continue;
    seen.add(m.tabId);
    const gk = `${rk}|${m.base}`;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(m);
  }

  const out = [];
  for (const [gk, members] of groups) {
    const rk = gk.slice(0, gk.lastIndexOf('|'));
    const base = members[0].base;
    const all = checkouts.has(rk) ? [...members, checkouts.get(rk)] : members;
    if (all.length < 2) continue;
    const byFile = new Map(); // path -> member indexes
    all.forEach((m, i) => {
      for (const f of new Set(m.files)) {
        if (typeof f !== 'string' || !f) continue;
        if (!byFile.has(f)) byFile.set(f, []);
        byFile.get(f).push(i);
      }
    });
    const bySet = new Map(); // "0,2" -> [path]
    for (const [f, idx] of byFile) {
      if (idx.length < 2) continue;
      const k = idx.join(',');
      if (!bySet.has(k)) bySet.set(k, []);
      bySet.get(k).push(f);
    }
    for (const [k, files] of bySet) {
      const who = k.split(',').map(Number).map(i => all[i]);
      const sorted = sortFiles(files);
      out.push({
        key: `${rk}|${base}|${who.map(memberId).sort().join('+')}`,
        root: members[0].root, base,
        files: sorted.slice(0, MAX_FILES), more: Math.max(0, sorted.length - MAX_FILES),
        copies: who.map(shownMember),
      });
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// Every pair of members that clash, across a list: "rootKey|a+b".
function pairsOf(clashes) {
  const pairs = new Set();
  for (const c of clashes || []) {
    const rk = rootKey(c.root);
    const ids = (c.copies || []).map(memberId).sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.add(`${rk}|${ids[i]}+${ids[j]}`);
  }
  return pairs;
}

/**
 * The clashes in next that are news: two copies (or a copy and your checkout)
 * that didn't clash at all before. More files on a pair that already clashed
 * isn't, so the toast comes once, not every time one of them saves a file.
 */
function freshClashes(prev, next) {
  const before = pairsOf(prev);
  return (next || []).filter(c => [...pairsOf([c])].some(p => !before.has(p)));
}

module.exports = { MAX_FILES, isLockfile, sortFiles, rootKey, parseStatusZ, parseNamesZ, findClashes, freshClashes, pairsOf };
