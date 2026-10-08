// The flaky test detective. A test that fails and then passes with the code
// exactly as it was (same command, same git tree: changes.snapshot) is a
// flake. Shellby reads which tests failed from what the runner printed, keeps
// a small per-project ledger of names and hashes (never the output), and says
// so when one keeps doing it: "auth.spec flaked 3 times this week". The panel
// offers to fix or quarantine it (routine-templates.js, in a copy of the repo).
//
// Strict on purpose: only the same command on the same tree is compared, and
// a run whose outcome can't be told is skipped rather than guessed. A false
// "your test is flaky" teaches people to ignore the whole thing.
//
//
// Pure: no I/O, no clock (callers pass `now`). See test/flaky.test.js and
// docs/plans/flaky-tests.md. The parts: flaky/ids.js (test ids, commands),
// flaky/parsers.js (each runner's output), flaky/store.js (the ledger) and
// flaky/text.js (what he says, the prompts, the issue).
const ids = require('./flaky/ids');
const parsers = require('./flaky/parsers');
const store = require('./flaky/store');
const text = require('./flaky/text');

module.exports = {
  SUITE: ids.SUITE, MAX_FAILED: ids.MAX_FAILED, MANY_FAILED: store.MANY_FAILED, SAY_AT: store.SAY_AT,
  FIXED_RUNS: store.FIXED_RUNS, FIXED_TREES: store.FIXED_TREES, RETRY_AFTER: store.RETRY_AFTER,
  cleanId: ids.cleanId, labelOf: ids.labelOf, normalizeCmd: ids.normalizeCmd, cmdKey: ids.cmdKey, masked: ids.masked,
  frameworkOf: parsers.frameworkOf, parse: parsers.parse, readRun: parsers.readRun,
  normalizeFlaky: store.normalizeFlaky, recordRun: store.recordRun, setStatus: store.setStatus, forget: store.forget,
  flakyView: store.flakyView, findTest: store.findTest, due: store.due, markSaid: store.markSaid, sayLine: text.sayLine,
  fixPrompt: text.fixPrompt, quarantinePrompt: text.quarantinePrompt, unquarantinePrompt: text.unquarantinePrompt,
  setIssue: store.setIssue, issueDraft: text.issueDraft, redactCmd: text.redactCmd,
};
