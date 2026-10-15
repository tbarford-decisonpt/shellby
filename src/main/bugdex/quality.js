// The fix report: what kind of fix caught the bug, read from the change that
// made the failing command pass. It only runs on a fix judge() (cheats.js)
// already let through, so no quality can come from a refused one, and it uses
// the same diff helpers, so a suppression or a raised limit can't count as a
// fix at the root either.
//
//   proof:     new test cases were added (not an edited assertion), and the
//              test count rose or the test file is new
//   firstTry:  the first re-run after it surfaced passed
//   rootCause: real source changed, with no suppression, no raised limit,
//              not just snapshots, config or a lockfile
//   wider:     the passing run covered more tests than the failing ones
//
// Pure: diffs in, a report out. See test/bugdex-quality.test.js.

const { splitPatch, isTestFile, onlyBiggerNumbers, SUPPRESS_ADD } = require('./cheats');

// A test case being declared, in the languages detect.js knows.
const TEST_CASE = /\b(it|test|describe)\s*\(|def test_|#\[test\]|func Test\w+\(|@Test\b|\[(Fact|Test)\]/;
const CONFIG_PATH = /\.(json|ya?ml|toml|lock|ini)$/i;
const SNAP_PATH = /\.snap$|(^|\/)__snapshots__\//;

// The order the letters are written in (bugdex/history.js keeps them per catch).
const LETTERS = Object.freeze({ proof: 'p', firstTry: 'f', rootCause: 'r', wider: 'w' });
const QUALITIES = Object.freeze(Object.keys(LETTERS));

const num = v => (Number.isFinite(v) ? v : null);

/** New test cases: more declarations added than taken away, in test files only. */
function newCases(parts) {
  let net = 0;
  for (const [p, x] of Object.entries(parts)) {
    if (!isTestFile(p)) continue;
    net += x.added.filter(l => TEST_CASE.test(l)).length - x.removed.filter(l => TEST_CASE.test(l)).length;
  }
  return net;
}

function hasProof(files, parts, counts) {
  if (newCases(parts) <= 0) return false;
  const before = num(counts?.before);
  const after = num(counts?.after);
  const rose = before != null && after != null && after > before;
  const newFile = files.some(f => f.status === 'A' && isTestFile(f.path));
  return rose || newFile;
}

function atRoot(files, parts) {
  const src = files.filter(f => !isTestFile(f.path) && f.status !== 'D');
  if (!src.length) return false;
  if (src.every(f => CONFIG_PATH.test(f.path) || SNAP_PATH.test(f.path))) return false;
  const added = Object.values(parts).flatMap(x => x.added);
  if (added.some(l => SUPPRESS_ADD.test(l))) return false;
  if (onlyBiggerNumbers(parts)) return false;
  // The source files have to carry real lines, not only removals or blanks.
  return Object.entries(parts).some(([p, x]) => !isTestFile(p) && !CONFIG_PATH.test(p) && (x.added.some(l => l.trim()) || x.removed.some(l => l.trim())));
}

/**
 * The report on one fix.
 *   files:  [{ path, status }] changed between the failure and the pass
 *   patch:  the unified diff between them
 *   enc:    the encounter ({ reruns })
 *   judged: judge()'s verdict; anything but { ok: true } gives null
 *   counts: { before, after } tests that passed, when the runner said so
 *   failed: how many failed when it surfaced, when known
 *   crew:   how many helpers joined the fight
 * -> { qualities: { proof, firstTry, rootCause, wider }, score, q, crew } | null
 * @param {{ files?: { path: string, status: string }[], patch?: string, enc?: any, judged?: any, counts?: any, failed?: number | null, crew?: number }} [opts]
 */
function fixReport({ files = [], patch = '', enc = null, judged = null, counts = null, failed = null, crew = 0 } = {}) {
  if (!judged || judged.ok !== true) return null;
  const list = Array.isArray(files) ? files.filter(f => f && typeof f.path === 'string') : [];
  const parts = splitPatch(patch);
  const after = num(counts?.after);
  const qualities = {
    proof: hasProof(list, parts, counts),
    firstTry: enc?.reruns === 0,
    rootCause: atRoot(list, parts),
    wider: after != null && after > Math.max(1, typeof failed === 'number' && Number.isInteger(failed) ? failed : 1),
  };
  return {
    qualities,
    score: QUALITIES.filter(k => qualities[k]).length,
    q: lettersOf(qualities),
    crew: Number.isInteger(crew) && crew > 0 ? Math.min(crew, 6) : 0,
  };
}

/** 'pfr': the qualities a report had, as letters. */
const lettersOf = qualities => QUALITIES.filter(k => qualities?.[k]).map(k => LETTERS[k]).join('');

/** Whether the fix earns the cleanfix award: a new test that proves it, at the root. */
const isClean = report => !!(report?.qualities?.proof && report.qualities.rootCause);

module.exports = { fixReport, lettersOf, isClean, newCases, LETTERS, QUALITIES, TEST_CASE };
