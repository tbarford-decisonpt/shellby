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

test('stepFlight says what he bumped into', () => {
  assert.equal(stepFlight({ x: 1690, y: 500, vx: 2000, vy: 0 }, 16, BOX).hit, 'wall');
  assert.equal(stepFlight({ x: 500, y: 5, vx: 0, vy: -2000 }, 16, BOX).hit, 'ceiling');
  assert.equal(stepFlight({ x: 500, y: 895, vx: 0, vy: 1500 }, 16, BOX).hit, 'floor');
  assert.equal(stepFlight({ x: 500, y: 899, vx: 0, vy: 100 }, 16, BOX).hit, null, 'a soft touchdown is a landing, not a bump');
  assert.equal(stepFlight({ x: 500, y: 400, vx: 100, vy: 0 }, 16, BOX).hit, null);
});

test('CritterMotion reports each bounce of a throw, hardest first', () => {
  let pos = { x: 1500, y: 400 };
  let tick = null, t = 0;
  const bounces = [];
  const states = [];
  const m = new CritterMotion({
    getPos: () => pos, place: (x, y) => { pos = { x, y }; }, box: () => BOX,
    onState: s => states.push(s), onBounce: b => bounces.push(b),
    setTimer: fn => { tick = fn; return 1; }, clearTimer: () => { tick = null; }, now: () => t,
  });
  m.launch({ vx: 3000, vy: -500 });
  for (let i = 0; i < 500 && tick; i++) { t += 16; tick(); }
  assert.ok(bounces.some(b => b.hit === 'wall'), JSON.stringify(bounces));
  const floors = bounces.filter(b => b.hit === 'floor');
  assert.ok(floors.length >= 1);
  assert.ok(floors[0].speed > floors.at(-1).speed || floors.length === 1, 'each floor bounce is softer');
  assert.deepEqual(states, ['flying', null, 'landed'], 'bounces stay out of the state sequence');
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

// A CritterMotion on a fake clock: tick() runs one frame.
function rigMotion(start = { x: 500, y: 400 }, extra = {}) {
  let pos = { ...start };
  let tick = null;
  const clock = { t: 0 };
  const states = [];
  const settled = [];
  const interrupted = [];
  const m = new CritterMotion({
    getPos: () => pos, place: (x, y) => { pos = { x, y }; }, box: () => BOX,
    onState: (s, info) => states.push([s, info]), onSettled: (k, info) => settled.push([k, info]),
    onInterrupted: k => interrupted.push(k),
    setTimer: fn => { tick = fn; return 1; }, clearTimer: () => { tick = null; }, now: () => clock.t,
    ...extra,
  });
  const run = (n = 1, ms = 16) => { for (let i = 0; i < n && tick; i++) { clock.t += ms; tick(); } };
  return { m, run, get pos() { return pos; }, states, settled, interrupted, clock, get ticking() { return !!tick; } };
}

test('a falling crab catches a ledge in his path, and says which', () => {
  const r = rigMotion({ x: 500, y: 100 }, { ledges: () => [{ id: 77, x1: 400, x2: 700, y: 300 }] });
  r.m.launch({ vx: 0, vy: 0 }, { style: 'fall', why: 'fell' });
  r.run(200);
  assert.equal(r.pos.y, 300, 'stopped on the ledge, not the floor');
  const [kind, info] = r.settled.at(-1);
  assert.equal(kind, 'flight');
  assert.equal(info.ledge, 77);
  assert.equal(info.why, 'fell');
});

test('stepFlight: a ledge only catches him on the way down, and only over it', () => {
  const box = { ...BOX, ledges: [{ id: 1, x1: 400, x2: 700, y: 300 }] };
  const up = stepFlight({ x: 500, y: 310, vx: 0, vy: -900 }, 16, box);
  assert.equal(up.ledge, null, 'rising through it');
  const beside = stepFlight({ x: 800, y: 295, vx: 0, vy: 900 }, 16, box);
  assert.equal(beside.ledge, null, 'not over it');
  const onto = stepFlight({ x: 500, y: 295, vx: 0, vy: 900 }, 16, box);
  assert.equal(onto.ledge, 1);
  assert.equal(onto.body.y, 300);
  assert.equal(onto.landed, true);
});

test('a hop crouches, arcs, follows a moving target and lands on it', () => {
  const r = rigMotion({ x: 500, y: 900 });
  let target = { x: 300, y: 300 };
  let landed = false;
  const path = (from, to, u) => ({ x: Math.round(from.x + (to.x - from.x) * u), y: Math.round(from.y + (to.y - from.y) * u - 200 * u * (1 - u)) });
  assert.equal(r.m.hop(() => target, { path, ms: 500, crouchMs: 100, onLand: () => { landed = true; } }), true);
  assert.equal(r.states[0][0], 'crouch');
  r.run(5);
  assert.equal(r.pos.x, 500, 'still crouched');
  r.run(10);
  assert.ok(r.states.some(([s]) => s === 'hopping'));
  target = { x: 350, y: 320 }; // the window moved mid-hop
  r.run(60);
  assert.equal(landed, true);
  assert.deepEqual(r.pos, { x: 350, y: 320 });
  assert.deepEqual(r.settled.at(-1), ['hop', undefined]);
  assert.equal(r.m.busy, false);
});

test('a hop whose target vanishes mid-air turns into a fall', () => {
  const r = rigMotion({ x: 500, y: 700 });
  let target = { x: 300, y: 300 };
  const path = (from, to, u) => ({ x: Math.round(from.x + (to.x - from.x) * u), y: Math.round(from.y + (to.y - from.y) * u) });
  r.m.hop(() => target, { path, ms: 600, crouchMs: 0 });
  r.run(10);
  target = null;
  r.run(1);
  assert.equal(r.m.kind, 'flight');
  r.run(400);
  const [, info] = r.settled.at(-1);
  assert.equal(info.why, 'missed');
  assert.equal(r.pos.y, BOX.floorY);
});

test('ride hands every frame to its step, moves only on change, and can launch', () => {
  const r = rigMotion({ x: 100, y: 100 });
  let places = 0;
  const m = new CritterMotion({
    getPos: () => r.pos, place: () => { places++; }, box: () => BOX,
    setTimer: fn => { r.tickFn = fn; return 1; }, clearTimer: () => { r.tickFn = null; }, now: () => r.clock.t,
  });
  let n = 0;
  m.ride(() => {
    n++;
    if (n < 5) return { place: { x: 100, y: 100 } }; // where he already is
    if (n < 8) return { place: { x: 100 + n, y: 100 } };
    return { launch: { vx: 0, vy: -100, style: 'fling', why: 'flung', dizzy: true } };
  });
  for (let i = 0; i < 9 && r.tickFn; i++) { r.clock.t += 16; r.tickFn(); }
  assert.equal(places >= 3, true);
  assert.ok(places < 8, 'no moves to where he already is');
  assert.equal(m.kind, 'flight');
});

test('stop() mid-ride tells whoever started it; halt() does not', () => {
  const r = rigMotion();
  r.m.ride(() => null);
  assert.equal(r.m.stop(), 'ride');
  assert.deepEqual(r.interrupted, ['ride']);
  r.m.ride(() => null);
  r.m.halt();
  assert.deepEqual(r.interrupted, ['ride'], 'halt is the move ending itself');
});

test('walkTo walks at the speed asked and reports its own kind', () => {
  const r = rigMotion({ x: 100, y: 700 });
  assert.equal(r.m.walkTo(400, 100, { kind: 'walk-home' }), true);
  assert.equal(r.m.walkTo(200), false, 'one move at a time');
  r.run(20, 50);
  assert.ok(r.pos.x > 150 && r.pos.x < 300, `about 100 DIP/s: ${r.pos.x}`);
  r.run(100, 50);
  assert.equal(r.pos.x, 400);
  assert.deepEqual(r.settled.at(-1), ['walk-home', undefined]);
  assert.equal(r.m.walkTo(400), false, 'already there');
});

test('a calm ride slows to a few frames a second, and speeds up the moment it is not', () => {
  const periods = [];
  let tick = null, t = 0;
  const m = new CritterMotion({
    getPos: () => ({ x: 0, y: 0 }), place: () => {}, box: () => BOX,
    setTimer: (fn, every) => { tick = fn; periods.push(every); return periods.length; }, clearTimer: () => { tick = null; }, now: () => t,
  });
  let calm = true;
  m.ride(() => ({ calm }));
  t += 16; tick();
  assert.deepEqual(periods, [16, 100], 'settled: slows down');
  t += 100; tick();
  assert.equal(periods.length, 2, 'stays slow while calm');
  calm = false;
  t += 100; tick();
  assert.deepEqual(periods, [16, 100, 16], 'the window moved: full speed again');
  assert.equal(m.kind, 'ride');
});
