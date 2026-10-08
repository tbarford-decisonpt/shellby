// Room for helper crabs in his window (wiring/crew-slots.js): it widens to the
// left at once, shrinks only after they've walked home, keeps him where he
// stands, and waits for him to come down off a window first.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wireCrewSlots } = require('../src/main/wiring/crew-slots');

const BASE = { width: 100, height: 80 };
const SLOT = 30;

function setup({ perching = null, climbing = null } = {}) {
  let bounds = { x: 500, y: 400, ...BASE };
  const store = {};
  const stops = [];
  const d = {
    MAX_CREW_SHOWN: 5, crewShown: 0, guestShown: false, visitor: null, perching, climbing,
    motion: { stop: () => stops.push(1) },
    critter: { getBounds: () => ({ ...bounds }), setBounds: b => { bounds = { ...b }; } },
    critterBaseSize: () => BASE,
    crewExtra: (slots = d.crewShown, guest = d.guestShown) => slots * SLOT + (guest ? 50 : 0),
    workAreas: () => [{ x: 0, y: 0, width: 1920, height: 1040 }],
    placeCritter: (x, y) => { bounds = { ...bounds, x, y }; },
    config: { set: patch => Object.assign(store, patch) },
  };
  return { d, ...wireCrewSlots(d), bounds: () => bounds, store, stops };
}

test('helpers arriving widen the window to the left at once, his right edge fixed', () => {
  const s = setup();
  s.setCrewSlots(2);
  assert.equal(s.d.crewShown, 2);
  assert.equal(s.bounds().width, BASE.width + 2 * SLOT);
  assert.equal(s.bounds().x + s.bounds().width, 500 + BASE.width, 'he stays where he is');
});

test('never more slots than are drawn', () => {
  const s = setup();
  s.setCrewSlots(9);
  assert.equal(s.d.crewShown, 5);
});

test('helpers leaving shrink the window only after they walk home', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  s.setCrewSlots(3);
  s.setCrewSlots(1);
  assert.equal(s.d.crewShown, 3, 'not yet');
  t.mock.timers.tick(1100);
  assert.equal(s.d.crewShown, 1);
  assert.equal(s.bounds().width, BASE.width + SLOT);
});

test('a newcomer cancels a shrink that was still pending', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  s.setCrewSlots(3);
  s.setCrewSlots(0);
  s.setCrewSlots(3);
  t.mock.timers.tick(5000);
  assert.equal(s.d.crewShown, 3);
});

test('a visiting crab gets room of its own', () => {
  const s = setup();
  s.d.visitor = { login: 'pal' };
  s.setCrewSlots(0);
  assert.equal(s.d.guestShown, true);
  assert.equal(s.bounds().width, BASE.width + 50);
});

test('perched on a window, he comes down first and the window stays as it is', () => {
  const left = [];
  const s = setup({ perching: { isAway: () => true, leave: why => left.push(why) } });
  s.setCrewSlots(2);
  assert.deepEqual(left, ['crew']);
  assert.equal(s.d.crewShown, 0);
  assert.equal(s.bounds().width, BASE.width);
});

test('up a wall, he lets go first', () => {
  let left = 0;
  const s = setup({ climbing: { isAway: () => true, leave: () => { left++; } } });
  s.setCrewSlots(1);
  assert.equal(left, 1);
  assert.equal(s.d.crewShown, 0);
});

test('nothing changes when the count is the same', () => {
  const s = setup();
  s.setCrewSlots(0);
  assert.equal(s.stops.length, 0, 'a stroll is not interrupted for nothing');
});

test('his saved spot is his own, not the widened window\'s left edge', () => {
  const s = setup();
  s.setCrewSlots(2);
  s.saveCritterPos();
  assert.deepEqual(s.store.critterPos, { x: 500, y: 400 });
});
