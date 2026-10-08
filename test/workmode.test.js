const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const workmode = require('../src/main/workmode');
const { Config } = require('../src/main/config');

// Someone's own settings: a lively crab with pals, pranks and climbing.
const MINE = Object.freeze({ chatter: 'chatty', mischief: 'gremlin', colony: 3, perch: 'often', climb: 'often', needsOn: true, sounds: true, mode: 'ask' });

test('off, the settings are exactly your own', () => {
  assert.deepEqual(workmode.effective(MINE), MINE);
  assert.deepEqual(workmode.effective({ ...MINE, workMode: false }), { ...MINE, workMode: false });
  assert.equal(workmode.valueOf(MINE, 'chatter'), 'chatty');
});

test('on, he is quiet: no pals, pranks or climbing, and a voice only for work', () => {
  const s = workmode.effective({ ...MINE, workMode: true });
  assert.equal(s.chatter, 'work');
  assert.equal(s.mischief, 'off');
  assert.equal(s.colony, 0);
  assert.equal(s.perch, 'off');
  assert.equal(s.climb, 'off');
});

test('on, everything that is not Work mode\'s stays yours', () => {
  const s = workmode.effective({ ...MINE, workMode: true });
  assert.equal(s.sounds, true);
  assert.equal(s.needsOn, true, 'his needs rest rather than being switched off');
  assert.equal(s.mode, 'ask');
});

test('the overlay never writes over your own settings, so leaving gives them back', () => {
  const mine = { ...MINE };
  const on = { ...mine, ...workmode.write(mine, { workMode: true }) };
  assert.equal(workmode.effective(on).colony, 0);
  for (const k of workmode.KEYS) assert.equal(on[k], MINE[k], `${k} is still yours underneath`);
  const off = { ...on, ...workmode.write(on, { workMode: false }) };
  for (const k of workmode.KEYS) assert.equal(workmode.effective(off)[k], MINE[k], `${k} is back as it was`);
  assert.deepEqual(mine, MINE, 'the input is never changed');
});

test('a change while in Work mode wins over its own, and is kept apart from yours', () => {
  const on = { ...MINE, workMode: true };
  const patch = workmode.write(on, { colony: 2, sounds: false });
  assert.equal('colony' in patch, false, 'your own pals setting is left alone');
  assert.deepEqual(patch.workOverrides, { colony: 2 });
  assert.equal(patch.sounds, false, 'settings Work mode does not touch save as usual');
  const after = { ...on, ...patch };
  assert.equal(workmode.effective(after).colony, 2);
  assert.equal(after.colony, 3);
  // Off and on again: Work mode remembers you wanted the pals.
  const later = { ...after, workMode: false };
  assert.equal(workmode.effective(later).colony, 3);
  assert.equal(workmode.effective({ ...later, workMode: true }).colony, 2);
});

test('choosing Work mode\'s own value again drops the override', () => {
  const on = { ...MINE, workMode: true, workOverrides: { colony: 2, chatter: 'normal' } };
  const patch = workmode.write(on, { colony: 0 });
  assert.deepEqual(patch.workOverrides, { chatter: 'normal' });
});

test('turning it on and changing a setting in one go keeps the change as Work mode\'s', () => {
  const patch = workmode.write(MINE, { workMode: true, chatter: 'normal' });
  assert.equal('chatter' in patch, false);
  assert.deepEqual(patch.workOverrides, { chatter: 'normal' });
});

test('just the crab and Work mode rule each other out', () => {
  assert.equal(workmode.write({ crabOnly: true }, { workMode: true }).crabOnly, false);
  assert.equal(workmode.write({ workMode: true }, { crabOnly: true }).workMode, false);
  // Somehow both on: just the crab wins, and nothing is laid over it.
  const both = { ...MINE, workMode: true, crabOnly: true };
  assert.equal(workmode.isOn(both), false);
  assert.equal(workmode.effective(both).colony, 3);
});

test('overrides read from disk are tolerated and limited to Work mode\'s own keys', () => {
  assert.deepEqual(workmode.overridesOf({ workOverrides: 'junk' }), {});
  assert.deepEqual(workmode.overridesOf({ workOverrides: [1, 2] }), {});
  assert.deepEqual(workmode.overridesOf({ workOverrides: { colony: 1, mode: 'autonomous' } }), { colony: 1 });
  assert.equal(workmode.effective({ workMode: true, mode: 'ask', workOverrides: { mode: 'autonomous' } }).mode, 'ask');
});

test('behaviour: needs rest, drop-ins wait for an invite, a small beat instead of confetti, tools first', () => {
  const on = workmode.behaviour({ workMode: true });
  assert.deepEqual(on, { on: true, needsRest: true, dropIns: false, confetti: false, petToasts: false, dock: workmode.DOCK });
  assert.deepEqual(workmode.DOCK.slice(0, 7), ['chat', 'projects', 'notes', 'history', 'toolbox', 'workflows', 'health']);
  assert.equal(workmode.DOCK.at(-1), 'wardrobe', "Shellby's own screens are still on the bar");
  const off = workmode.behaviour({});
  assert.deepEqual(off, { on: false, needsRest: false, dropIns: true, confetti: true, petToasts: true, dock: null });
  assert.equal(workmode.behaviourOf({ get: k => ({ workMode: true })[k] }).on, true);
  assert.equal(workmode.behaviourOf(undefined).on, false);
});

test('config: get() sees Work mode, the file keeps your own', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-work-'));
  try {
    const config = new Config(dir);
    config.set({ colony: 3, chatter: 'chatty' });
    config.set(workmode.write(config.data, { workMode: true }));
    assert.equal(config.get('colony'), 0);
    assert.equal(config.get('chatter'), 'work');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.equal(saved.colony, 3);
    assert.equal(saved.chatter, 'chatty');
    config.set(workmode.write(config.data, { workMode: false }));
    assert.equal(config.get('colony'), 3);
    assert.equal(config.get('chatter'), 'chatty');
    // A fresh start reads it back the same way.
    config.set(workmode.write(config.data, { workMode: true }));
    assert.equal(new Config(dir).get('perch'), 'off');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the three modes, and when leaving just the crab needs Claude Code set up first', () => {
  assert.equal(workmode.modeOf({}), 'claude');
  assert.equal(workmode.modeOf({ workMode: true }), 'work');
  assert.equal(workmode.modeOf({ workMode: true, crabOnly: true }), 'crab');
  const ready = { installed: true, loggedIn: true };
  assert.equal(workmode.needsSetup({ crabOnly: true }, {}, 'work'), true);
  assert.equal(workmode.needsSetup({ crabOnly: true }, ready, 'claude'), false);
  assert.equal(workmode.needsSetup({ crabOnly: true, claudeElsewhere: true }, {}, 'claude'), false);
  assert.equal(workmode.needsSetup({ crabOnly: true }, {}, 'crab'), false);
  assert.equal(workmode.needsSetup({}, {}, 'work'), false);
});
