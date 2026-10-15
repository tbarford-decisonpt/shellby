// First steps in main (wiring/first-run.js): a real event marks its step,
// the panel hears, and the core loop finished opens the game's rooms.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const firstRun = require('../src/main/first-run');
const { wireFirstRun } = require('../src/main/wiring/first-run');

function setup(settings = {}) {
  let store = { onboarded: true, firstRun: firstRun.initialFirstRun(false), xp: { total: 0 }, ...settings };
  const sent = [];
  let cored = 0;
  const d = {
    config: { get: k => store[k], set: o => { store = { ...store, ...o }; } },
    panel: {},
    send: (_w, channel, payload) => sent.push({ channel, payload }),
    reachCoreRooms: () => { cored++; },
  };
  return { d, fr: wireFirstRun(d), sent, store: () => store, cored: () => cored };
}

test('a real event marks its step and tells the panel', () => {
  const { fr, sent, store } = setup();
  fr.firstRunStep('project');
  assert.ok(store().firstRun.done.project);
  assert.ok(store().firstRun.done.welcome, 'onboarded: hello is saved as done too');
  assert.equal(sent.at(-1).channel, 'first-run');
  assert.equal(sent.at(-1).payload.current, 'message');
});

test('the same event again sends nothing', () => {
  const { fr, sent } = setup();
  fr.firstRunStep('project');
  const n = sent.length;
  fr.firstRunStep('project');
  assert.equal(sent.length, n);
});

test('the last step opens the game rooms, once the core loop is done', () => {
  const { fr, cored } = setup();
  for (const id of ['project', 'message', 'result']) fr.firstRunStep(id);
  assert.equal(cored(), 0);
  assert.equal(fr.coreLoopNow(), false);
  fr.skipFirstStep('crab');
  assert.equal(cored(), 1);
  assert.equal(fr.coreLoopNow(), true);
});

test('level CORE_LOOP_LEVEL is the core loop even with First steps untouched', () => {
  // Level 3 needs this much XP (progression/xp.js); found rather than hardcoded.
  const { levelFor } = require('../src/main/progression/xp');
  let total = 0;
  while (levelFor(total).level < firstRun.CORE_LOOP_LEVEL) total += 10;
  const { fr } = setup({ xp: { total } });
  assert.equal(fr.coreLoopNow(), true);
});

test('hiding and Skip come back as the panel view', () => {
  const { fr, store } = setup();
  assert.equal(fr.hideFirstRun(true).shows, false);
  assert.equal(store().firstRun.hidden, true);
  assert.equal(fr.hideFirstRun(false).shows, true);
  assert.equal(fr.skipFirstStep('project').current, 'message');
});

test('an existing user: events change nothing and the core loop is done', () => {
  const { fr, sent, cored } = setup({ firstRun: firstRun.initialFirstRun(true) });
  fr.firstRunStep('project');
  assert.equal(sent.length, 0);
  assert.equal(cored(), 0);
  assert.equal(fr.coreLoopNow(), true);
  assert.equal(fr.firstRunPanelView().shows, false);
});

test('the scripted screenshots (CAPTURE) never show the card', () => {
  const { d, fr } = setup();
  d.CAPTURE = true;
  assert.equal(fr.firstRunPanelView().shows, false);
  assert.equal(fr.coreLoopNow(), true);
});
