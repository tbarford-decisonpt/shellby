// His life between tasks (src/main/life.js) while he's calm: covered by a
// window, hidden under a game, nobody at the desk. Nobody sees his eyes follow
// the cursor, so that 280 ms poll rests; the microphone check doesn't, since a
// call may well be going on under the window that covers him.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLife } = require('../src/main/life');

function rig({ calm = false, locked = false } = {}) {
  const data = {};
  const counts = { cursor: 0, mic: 0 };
  const state = { calm, locked };
  const life = createLife({
    config: { get: k => data[k], set: p => Object.assign(data, p) },
    native: null,
    enabled: () => true,
    temperament: () => 'cheery',
    speak: () => null, say: () => {}, dialogue: () => null,
    toCrab: () => {}, toPanel: () => {}, touch: () => {}, refresh: () => {},
    stat: () => {}, awardXp: () => {}, burst: () => {},
    systemIdleSeconds: () => 0,
    isIdle: () => false, working: () => false, playing: () => false, guarding: () => false, music: () => false,
    seasons: () => [],
    calm: () => state.calm || state.locked,
    locked: () => state.locked,
    eyePoint: () => ({ x: 0, y: 0 }),
    cursor: () => { counts.cursor++; return { x: 10, y: 10 }; },
    throws: () => 0, firstDay: () => null,
    readMic: async () => { counts.mic++; return ''; },
    ownExes: () => [], bootAt: () => null, ownPids: () => [],
    log: () => {},
  });
  return { life, counts, state };
}

test('life: calm (covered, away) rests the cursor poll, and the mic check goes on', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { life, counts, state } = rig({ calm: true });
  life.start();
  t.after(() => life.stop());
  const micAtStart = counts.mic;
  t.mock.timers.tick(25_000);
  assert.equal(counts.cursor, 0, 'no cursor polls while he is calm');
  assert.ok(counts.mic > micAtStart, 'the mic is still checked');

  state.calm = false;
  t.mock.timers.tick(600);
  assert.ok(counts.cursor > 0, 'his eyes follow the cursor again once he can be seen');
});

test('life: a locked screen rests the mic check too', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { life, counts } = rig({ locked: true });
  life.start();
  t.after(() => life.stop());
  t.mock.timers.tick(45_000);
  assert.equal(counts.cursor, 0);
  assert.equal(counts.mic, 0);
});
