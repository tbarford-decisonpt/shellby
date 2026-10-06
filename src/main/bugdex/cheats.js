// Was it really fixed? A pass only catches a bug when the change behind it is
// a fix: not a deleted test, a skipped one, an @ts-ignore, a bigger timeout or
// the code put back the way it was before it broke. A refusal leaves the bug
// on the loose (Claude can still do it properly) and says why.
// See docs/plans/bugdex.md §4.4.
//
// Pure: diffs in, a verdict out. See test/bugdex-cheats.test.js.

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|_spec\.rb$|Tests?\.(cs|java|kt)$/i;
const SNAP_PATH = /\.snap$|(^|\/)__snapshots__\//;
const SKIP_ADD = /\.(skip|todo)\(|\bx(it|describe|test)\(|\b(it|test|describe)\.only\(|@pytest\.mark\.(skip|xfail)|\bpytest\.skip\(|\bt\.Skip(Now)?\(|#\[ignore\]|\[(Fact|Test|Theory)\(Skip|@Disabled\b|@Ignore\b|\bskip:\s*true\b/;
const SUPPRESS_ADD = /@ts-ignore|@ts-expect-error|@ts-nocheck|\bas any\b|:\s*any\b|eslint-disable|#\s*type:\s*ignore|#\s*noqa|#!?\[allow\(|\/\/\s*nolint|@SuppressWarnings|pragma warning disable|\/\/\s*@ts-|biome-ignore|# pylint: disable/;
const INSECURE_ADD = /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|verify\s*=\s*False|--insecure\b|\s-k\s|InsecureSkipVerify\s*:\s*true|strict-ssl\s*(=|:)\s*false/;
const UPDATE_SNAPSHOT = /(^|\s)(-u|--update-?snapshots?|--snapshot-update|--updateSnapshot)\b/;
const MEMORY_FLAG = /--max-old-space-size|NODE_OPTIONS|-Xmx\d/;
const MEMORY_FLAG_ARG = /\s*--max-old-space-size[= ]\d+|\s*NODE_OPTIONS=("[^"]*"|\S+)|\s*-Xmx\d+[kmgKMG]?/g;

// Species whose "fix" is too often a suppression: any added suppression refuses.
const SUPPRESSIBLE = new Set(['type-tangle', 'mismatched-mantis', 'missing-fin-pipefish', 'undeclared-urchin', 'anything-anemone', 'optional-oarfish', 'hinted-hermit', 'lint-louse', 'rusty-nautilus', 'borrowing-hermit']);
const TEST_SPECIES = new Set(['red-snapper', 'assertive-lobster', 'mirror-mullet']);

/**
 * Split a unified diff into { path: { added: [lines], removed: [lines] } }.
 * Only what the rules need: the + and - lines of each file.
 */
function splitPatch(patch) {
  const files = {};
  let cur = null;
  for (const line of String(patch || '').split('\n')) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) { cur = files[head[2]] = { added: [], removed: [] }; continue; }
    if (!cur || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) cur.added.push(line.slice(1));
    else if (line.startsWith('-')) cur.removed.push(line.slice(1));
  }
  return files;
}

const isTestFile = p => TEST_PATH.test(String(p).replace(/\\/g, '/'));
const numbersOnly = s => s.replace(/\d+(\.\d+)?(_\d+)*/g, '#').replace(/\s+/g, ' ').trim();

/**
 * Only raised numbers: every changed line pair differs only in its numbers
 * (a timeout of 5000 became 30000), or the change only adds a memory flag.
 */
function onlyBiggerNumbers(parts) {
  const all = Object.values(parts);
  if (!all.length) return false;
  const added = all.flatMap(p => p.added).filter(l => l.trim());
  const removed = all.flatMap(p => p.removed).filter(l => l.trim());
  if (!added.length || added.length !== removed.length) return added.length > 0 && !removed.length && added.every(l => MEMORY_FLAG.test(l));
  const same = (a, b) => numbersOnly(a.replace(MEMORY_FLAG_ARG, '')) === numbersOnly(b.replace(MEMORY_FLAG_ARG, ''));
  return added.every((l, i) => same(l, removed[i]) && l !== removed[i]);
}

/**
 * The verdict on one would-be catch.
 *   files:   [{ path, status: 'A'|'M'|'D' }] changed between the failure and the pass ([] when the tree is the same)
 *   patch:   the unified diff between them ('' when not needed or not read)
 *   species: the encounter's species id
 *   remedy:  whether a remedy command ran in between (a same-tree catch)
 *   revert:  whether the pass tree is one the project had before the failure
 *   passCmd: the command that passed, or passFlags: flagsOf(it) (a reading carries only those)
 *   counts:  { before, after } tests that passed, when the runner said so
 * -> { ok: true } | { ok: false, reason }
 */
function judge({ files = [], patch = '', species, remedy = false, revert = false, passCmd = '', passFlags = null, counts = null } = {}) {
  const flags = passFlags || flagsOf(passCmd);
  if (!files.length) return remedy ? { ok: true } : { ok: false, reason: 'no-change' };
  // What was done to the tests says the most, so it's named first, even when it's also an undo.
  if (files.some(f => f.status === 'D' && isTestFile(f.path))) return { ok: false, reason: 'deleted-tests' };
  const parts = splitPatch(patch);
  const addedIn = pred => Object.entries(parts).some(([p, x]) => pred(p) && x.added.some(l => l));
  const adds = (re, pred = () => true) => Object.entries(parts).some(([p, x]) => pred(p) && x.added.some(l => re.test(l)));
  if (adds(SKIP_ADD, isTestFile)) return { ok: false, reason: 'skipped' };
  if (revert) return { ok: false, reason: 'revert' };
  // Every species is refused when a suppression is the whole change; the type
  // and lint ones whenever one is added at all.
  const codeLines = Object.values(parts).flatMap(x => x.added).filter(l => l.trim());
  if (adds(SUPPRESS_ADD) && (SUPPRESSIBLE.has(species) || codeLines.every(l => SUPPRESS_ADD.test(l)))) return { ok: false, reason: 'suppressed' };
  if (TEST_SPECIES.has(species) && counts && Number.isFinite(counts.before) && Number.isFinite(counts.after) && counts.after < counts.before) return { ok: false, reason: 'fewer-tests' };
  if (species === 'mirror-mullet' && (flags.snapshotUpdate || files.every(f => SNAP_PATH.test(f.path)))) return { ok: false, reason: 'snapshots-only' };
  if ((species === 'slowpoke-snail' || species === 'heap-leviathan') && onlyBiggerNumbers(parts)) return { ok: false, reason: 'bigger-number' };
  if (species === 'cert-cuttlefish' && (adds(INSECURE_ADD) || flags.insecure)) return { ok: false, reason: 'insecure' };
  if (species === 'border-crab' && !addedIn(p => !isTestFile(p))) return { ok: false, reason: 'tests-only' };
  return { ok: true };
}

/** What about the passing command itself matters to the rules: updating snapshots, skipping certificate checks. */
const flagsOf = cmd => ({ snapshotUpdate: UPDATE_SNAPSHOT.test(String(cmd || '')), insecure: INSECURE_ADD.test(` ${String(cmd || '')} `) });

// The panel's words for a refusal ("Not like that: ...").
const REASONS = Object.freeze({
  'no-change': 'the code didn’t change',
  revert: 'that just put the code back how it was',
  'deleted-tests': 'a test was deleted',
  skipped: 'a test was skipped',
  suppressed: 'the error was silenced, not fixed',
  'fewer-tests': 'fewer tests ran',
  'snapshots-only': 'the snapshots were just updated',
  'bigger-number': 'a limit was just raised',
  insecure: 'certificate checks were turned off',
  'tests-only': 'only the tests changed',
});

module.exports = { judge, flagsOf, splitPatch, isTestFile, onlyBiggerNumbers, REASONS, TEST_PATH };
