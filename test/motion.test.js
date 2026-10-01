const { test } = require('node:test');
const assert = require('node:assert/strict');
const { releaseVelocity, isThrow, stepFlight, planStroll, stepStroll, CritterMotion, STROLL_RANGE } = require('../src/main/motion');

const BOX = { minX: 0, maxX: 1700, minY: 0, floorY: 900 };

test('release velocity comes from the last ~90 ms of the drag', () => {
  const slow = [{ x: 0, y: 0, t: 0 }, { x: 5, y: 0, t: 100 }, { x: 10, y: 0, t: 200 }];
  assert.ok(!isThrow(releaseVelocity(slow)));
  const flick = [{ x: 0, y: 0, t: 0 }, { x: 10, y: 0, t: 400 }, { x: 60, y: -40, t: 440 }, { x: 140, y: -90, t: 480 }];
  const v = releaseVelocity(flick);
  assert.ok(v.vx > 1500 && v.vy < -900, JSON.stringify(v));
  assert.ok(isThrow(v));
  assert.deepEqual(releaseVelocity([]), { vx: 0, vy: 0 });
  assert.deepEqual(releaseVelocity([{ x: 0, y: 0, t: 5 }, { x: 900, y: 0, t: 5 }]), { vx: 0, vy: 0 });
  const wild = releaseVelocity([{ x: 0, y: 0, t: 0 }, { x: 5000, y: 0, t: 20 }]);
  assert.ok(Math.hypot(wild.vx, wild.vy) <= 3600.001);
});

test('a thrown crab falls, bounces off walls and the floor, and lands', () => {
  let body = { x: 800, y: 300, vx: 2500, vy: -1200 };
  let landedAt = null, wall = false, steps = 0;
  for (; steps < 400; steps++) {
    const r = stepFlight(body, 16, BOX);
    if (r.body.x === BOX.maxX) wall = true;
    body = r.body;
    assert.ok(body.x >= BOX.minX && body.x <= BOX.maxX && body.y <= BOX.floorY);
    if (r.landed) { landedAt = steps; break; }
  }
  assert.ok(wall, 'hit the right edge');
  assert.ok(landedAt !== null, 'came to rest');
  assert.equal(body.y, BOX.floorY);
});

test('strolls stay near his spot and on screen', () => {
  const seq = [0.5, 0.1, 0.9, 0.3, 0.7, 0.2];
  let i = 0;
  const rand = () => seq[i++ % seq.length];
  for (let k = 0; k < 30; k++) {
    const x = 400 + (k % 7) * 30;
    const t = planStroll(x, 500, BOX, rand);
    if (t == null) continue;
    assert.ok(Math.abs(t - 500) <= STROLL_RANGE, `target ${t}`);
    assert.ok(Math.abs(t - x) >= 30);
  }
  assert.equal(planStroll(10, 10, { minX: 0, maxX: 20, minY: 0, floorY: 0 }, rand), null, 'no room, no stroll');
  assert.deepEqual(stepStroll(100, 101, 1000), { x: 101, done: true });
  assert.equal(stepStroll(100, 200, 1000).done, false);
});

test('CritterMotion flies a throw to the floor and settles', () => {
  let pos = { x: 500, y: 400 };
  let tick = null, t = 0;
  const states = [];
  let settled = null;
  const m = new CritterMotion({
    getPos: () => pos, place: (x, y) => { pos = { x, y }; }, box: () => BOX,
    onState: s => states.push(s), onSettled: k => { settled = k; },
    setTimer: fn => { tick = fn; return 1; }, clearTimer: () => { tick = null; }, now: () => t,
  });
  assert.equal(m.release([{ x: 0, y: 0, t: 0 }, { x: 2, y: 0, t: 200 }]), false, 'a slow drop is not a throw');
  assert.equal(m.release([{ x: 0, y: 0, t: 0 }, { x: 150, y: -60, t: 60 }]), true);
  for (let i = 0; i < 500 && tick; i++) { t += 16; tick(); }
  assert.equal(settled, 'flight');
  assert.equal(pos.y, BOX.floorY);
  assert.deepEqual(states, ['flying', null, 'landed']);
  assert.equal(m.busy, false);
});

test('CritterMotion strolls and can be interrupted', () => {
  let pos = { x: 500, y: 700 };
  let tick = null, t = 0;
  const m = new CritterMotion({
    getPos: () => pos, place: (x, y) => { pos = { x, y }; }, box: () => BOX,
    setTimer: fn => { tick = fn; return 1; }, clearTimer: () => { tick = null; }, now: () => t,
  });
  assert.equal(m.stroll(500, () => 0.5), true);
  assert.equal(m.stroll(500, () => 0.5), false, 'one move at a time');
  t += 500; tick();
  assert.notEqual(pos.x, 500);
  assert.equal(pos.y, 700);
  assert.equal(m.stop(), 'stroll');
  assert.equal(m.busy, false);
});
