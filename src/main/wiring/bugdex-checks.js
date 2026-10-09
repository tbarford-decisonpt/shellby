'use strict';

// Pure checks wireBugdex (wiring/bugdex.js) leans on.

const fs = require('fs');
const path = require('path');

// Which bug a red build was, from the names of the checks that failed.
function ciSpecies(pr) {
  const names = (pr.failing || []).map(String);
  if (names.length >= 3) return 'the-kraken';
  if (pr.timedOut) return 'stalled-galleon';
  if (names.length === 1 && /\b(windows|macos|ubuntu|linux|win|mac|osx)\b/i.test(names[0])) return 'matrix-hydra';
  if (names.some(n => /deploy|vercel|netlify|pages/i.test(n))) return 'sunken-deploy';
  if (names.length && names.every(n => /lint|eslint|ruff|clippy|prettier|format/i.test(n))) return 'lint-louse';
  if (names.length && names.every(n => /type|tsc|mypy|pyright/i.test(n))) return 'type-tangle';
  return 'red-tide';
}

// Conflict markers still in a file git named. Read here rather than with
// `git grep`, whose "nothing found" and "couldn't look" both come back as a
// failure; a file that can't be read counts as still marked (no catch).
const MARKER = /^(<{7}|>{7})( |$)/m;
const MAX_MARKED_BYTES = 2 * 1024 * 1024;
function markersLeft(root, file) {
  const full = path.resolve(root, file);
  if (!(full.toLowerCase() + path.sep).startsWith(path.resolve(root).toLowerCase() + path.sep)) return true; // outside the repo
  try {
    const st = fs.statSync(full);
    if (!st.isFile()) return false; // deleted to settle it
    if (st.size > MAX_MARKED_BYTES) return true;
    return MARKER.test(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    return e.code !== 'ENOENT';
  }
}

module.exports = { ciSpecies, markersLeft };
