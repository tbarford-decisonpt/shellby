// First steps (src/main/first-run.js): done by the real thing, skippable,
// resumable, and already finished for anyone who was here before.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/main/first-run');

const NOW = 1_800_000_000_000;
const fresh = () => F.initialFirstRun(false);
const ids = F.STEPS.map(s => s.id);
const doAll = (s, how = F.markStep) => ids.reduce((v, id, i) => how(v, id, NOW + i), s);

test('the path is hello, a project, a task, his changes, then the crab', () => {
  assert.deepEqual(ids, ['welcome', 'project', 'message', 'result', 'crab']);
  assert.ok(F.STEPS.every(s => s.title && s.text), 'each says what it is');
  assert.ok(F.STEPS.filter(s => s.id !== 'welcome').every(s => s.action), 'each after hello has one action to get going');
});

test('someone new sees the card with hello already done once onboarded', () => {
  const v = F.firstRunView(fresh(), { onboarded: true, level: 1 });
  assert.equal(v.shows, true);
  assert.equal(v.current, 'project');
  assert.equal(v.doneCount, 1);
  assert.equal(v.total, ids.length);
  assert.equal(v.complete, false);
  assert.equal(v.core, false);
});

test('before onboarding even hello is still to do', () => {
  assert.equal(F.firstRunView(fresh(), { onboarded: false }).current, 'welcome');
});

test('a step is done once: the second time hands back the same value', () => {
  const s = F.markStep(fresh(), 'project', NOW);
  assert.equal(s.done.project, NOW);
  assert.deepEqual(F.markStep(s, 'project', NOW + 5), s);
});

test('unknown steps change nothing', () => {
  const s = fresh();
  assert.deepEqual(F.markStep(s, 'nope', NOW), s);
  assert.deepEqual(F.skipStep(s, '__proto__', NOW), s);
});

test('a skipped step counts toward finishing, and doing it later changes nothing', () => {
  const s = F.skipStep(fresh(), 'result', NOW);
  assert.equal(F.firstRunView(s).steps.find(x => x.id === 'result').state, 'skipped');
  assert.deepEqual(F.markStep(s, 'result', NOW), s);
});

test('steps can happen in any order; the card points at the first one left', () => {
  const s = F.markStep(F.markStep(fresh(), 'crab', NOW), 'message', NOW);
  assert.equal(F.firstRunView(s, { onboarded: true }).current, 'project');
});

test('every step done finishes it, and finishing is the core loop', () => {
  const s = doAll(fresh());
  assert.equal(F.isComplete(s), true);
  assert.equal(F.coreLoopDone(s, 1), true);
  const v = F.firstRunView(s);
  assert.equal(v.shows, false);
  assert.equal(v.current, null);
});

test('skipping everything finishes it too, so nobody is stuck behind it', () => {
  assert.equal(F.isComplete(doAll(fresh(), F.skipStep)), true);
});

test('reaching the core-loop level counts without touching the card', () => {
  assert.equal(F.coreLoopDone(fresh(), F.CORE_LOOP_LEVEL - 1), false);
  assert.equal(F.coreLoopDone(fresh(), F.CORE_LOOP_LEVEL), true);
  assert.equal(F.firstRunView(fresh(), { level: F.CORE_LOOP_LEVEL }).core, true);
});

test('hiding keeps the progress, and it comes back where it was', () => {
  const s = F.markStep(fresh(), 'project', NOW);
  const hidden = F.setHidden(s, true);
  assert.equal(F.firstRunView(hidden, { onboarded: true }).shows, false);
  assert.equal(F.isComplete(hidden), false, 'hidden is not finished: the game rooms still wait');
  const back = F.setHidden(hidden, false);
  assert.equal(F.firstRunView(back, { onboarded: true }).current, 'message');
});

// ---- existing users

test('someone who was here before starts with it finished: no card, core loop done', () => {
  const s = F.initialFirstRun(true);
  assert.equal(F.isComplete(s), true);
  assert.equal(F.coreLoopDone(s, 1), true);
  const v = F.firstRunView(s, { onboarded: true, level: 1 });
  assert.equal(v.shows, false);
  assert.ok(v.steps.every(x => x.state === 'done'));
  assert.deepEqual(F.markStep(s, 'project', NOW), s, 'nothing more is recorded');
});

test('an undecided value (null) never hides anything', () => {
  assert.equal(F.isComplete(null), true);
  assert.equal(F.coreLoopDone(null, 1), true);
  assert.equal(F.firstRunView(null).shows, false);
});

test('a corrupt stored value is cleaned up, not trusted', () => {
  const s = F.normalizeFirstRun({ done: { project: 'x', crab: NOW, evil: NOW }, skipped: [1], hidden: 'yes', legacy: 0 });
  assert.deepEqual(s, { done: { crab: NOW }, skipped: {}, hidden: true, legacy: false });
  assert.equal(F.normalizeFirstRun('garbage'), null);
  assert.equal(F.normalizeFirstRun([]), null);
});
