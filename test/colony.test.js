const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, tick, react, poke } = require('../src/renderer/floor/colony-brain');

const ROSTER = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, name: id.toUpperCase(), hue: i * 50 }));
const shellby = (over = {}) => ({ x: 500, floor: true, away: null, state: 'idle', half: 40, ...over });
const worldOf = (s = shellby()) => ({ width: 1000, shellby: s });

// A long run needs more than a short sequence: a small seeded generator.
const seeded = (seed = 7) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

function run(pals, world, ticks, rand = seeded(), each = () => {}) {
  let now = 2000;
  for (let i = 0; i < ticks; i++) {
    now += 100;
    pals = tick(pals, world, now, 100, rand);
    each(pals);
  }
  return pals;
}

test('pals start on the strip and outside his body', () => {
  const world = worldOf();
  const pals = spawn(ROSTER, world, () => 0.5);
  assert.equal(pals.length, ROSTER.length);
  for (const p of pals) {
    assert.ok(p.x >= 0 && p.x <= world.width, `${p.id} at ${p.x}`);
    assert.ok(Math.abs(p.x - world.shellby.x) >= world.shellby.half, `${p.id} at ${p.x}`);
    assert.equal(p.mode, 'idle');
  }
  assert.deepEqual(pals.map(p => p.name), ['A', 'B', 'C', 'D', 'E'], 'the roster comes through');
});

test('pals start on both sides of him, and apart', () => {
  const pals = spawn(ROSTER, worldOf(), () => 0.5);
  assert.ok(pals.some(p => p.x < 500) && pals.some(p => p.x > 500));
  assert.equal(new Set(pals.map(p => p.x)).size, pals.length);
});

test('a walking pal heads for its target', () => {
  const pal = { id: 'a', x: 100, dir: 1, mode: 'walk', target: 300, then: 'dig', speed: 40, until: 0 };
  const [out] = tick([pal], worldOf(), 1000, 200, () => 0.5);
  assert.equal(out.x, 108, 'a frame is at most 200 ms');
  assert.equal(out.mode, 'walk');
  assert.equal(out.target, 300);
});

test('a pal that gets there settles into what it came to do', () => {
  const pal = { id: 'a', x: 100, dir: 1, mode: 'walk', target: 105, then: 'dig', speed: 40, until: 0 };
  const [out] = tick([pal], worldOf(), 1000, 200, () => 0.5);
  assert.equal(out.x, 105);
  assert.equal(out.target, null);
  assert.equal(out.mode, 'dig');
  assert.ok(out.until > 1000);
});

test('a pal that came for a chat turns to face him', () => {
  const pal = { id: 'a', x: 700, dir: -1, mode: 'walk', target: 695, then: 'chat', speed: 40, until: 0 };
  const [out] = tick([pal], worldOf(), 1000, 200, () => 0.5);
  assert.equal(out.mode, 'chat');
  assert.equal(out.dir, -1, 'he is to the left');
  const left = { ...pal, x: 300, target: 305, dir: 1 };
  assert.equal(tick([left], worldOf(), 1000, 200, () => 0.5)[0].dir, 1);
});

test('a pal in the middle of something carries on until its time is up', () => {
  const pal = { id: 'a', x: 200, dir: 1, mode: 'dig', target: null, then: null, until: 5000 };
  assert.deepEqual(tick([pal], worldOf(), 4000, 100, () => 0.5), [pal]);
  assert.notDeepEqual(tick([pal], worldOf(), 5000, 100, () => 0.5), [pal]);
});

test('when he naps, they curl up near him and sleep', () => {
  const world = worldOf(shellby({ state: 'sleeping' }));
  let pals = spawn(ROSTER, world, seeded());
  pals = run(pals, world, 3000);
  for (const p of pals) {
    assert.equal(p.mode, 'sleep', p.id);
    assert.ok(Math.abs(p.x - 500) <= 40 + 22 + 140, `${p.id} at ${p.x}`);
  }
});

test('when he is up a wall they gather underneath and look up', () => {
  const world = worldOf(shellby({ floor: false, away: 'climb' }));
  let pals = spawn(ROSTER, world, seeded());
  pals = run(pals, world, 3000);
  for (const p of pals) {
    assert.ok(['look', 'wave'].includes(p.mode), `${p.id} is ${p.mode}`);
    assert.ok(Math.abs(p.x - 500) <= 40 + 22 + 110, `${p.id} at ${p.x}`);
  }
});

test('a task going well has them all cheer', () => {
  const pals = spawn(ROSTER, worldOf(), () => 0.5);
  const out = react(pals, 'success', worldOf(), 1000, () => 0.5);
  assert.deepEqual(out.map(p => p.mode), Array(5).fill('cheer'));
  assert.ok(out.every(p => p.until > 1000));
});

test('a task going wrong has them all say oof', () => {
  const out = react(spawn(ROSTER, worldOf(), () => 0.5), 'error', worldOf(), 1000, () => 0.5);
  assert.deepEqual(out.map(p => p.mode), Array(5).fill('oof'));
});

test('when he lands with a thump they scurry away from him', () => {
  const world = worldOf();
  const pals = [
    { id: 'a', x: 400, dir: 1, mode: 'idle', target: null, then: null, until: 0 },
    { id: 'b', x: 620, dir: -1, mode: 'idle', target: null, then: null, until: 0 },
  ];
  const [l, r] = react(pals, 'landed', world, 1000, () => 0.5);
  assert.equal(l.mode, 'scurry');
  assert.ok(l.target < 400 && l.dir === -1, `left pal heads to ${l.target}`);
  assert.equal(r.mode, 'scurry');
  assert.ok(r.target > 620 && r.dir === 1, `right pal heads to ${r.target}`);
});

test('an event they have no reaction to changes nothing', () => {
  const pals = spawn(ROSTER, worldOf(), () => 0.5);
  assert.deepEqual(react(pals, 'petted', worldOf(), 1000, () => 0.5), pals);
});

test('poking one pal pokes only that pal', () => {
  const pals = spawn(ROSTER, worldOf(), () => 0.5);
  const out = poke(pals, 'c', 1000, () => 0.5);
  assert.equal(out[2].mode, 'poked');
  assert.deepEqual(out.filter(p => p.id !== 'c'), pals.filter(p => p.id !== 'c'));
  assert.deepEqual(poke(pals, 'nobody', 1000, () => 0.5), pals);
});

test('pals never leave the strip, whatever he is up to', () => {
  const states = [shellby(), shellby({ state: 'working' }), shellby({ state: 'sleeping' }), shellby({ floor: false, away: 'perch' }), shellby({ x: 10 }), shellby({ x: 990 })];
  for (const s of states) {
    const world = worldOf(s);
    run(spawn(ROSTER, world, seeded(3)), world, 1500, seeded(11), pals => {
      for (const p of pals) {
        assert.ok(p.x >= 0 && p.x <= world.width, `${p.id} at ${p.x} with ${JSON.stringify(s)}`);
        if (p.target != null) assert.ok(p.target >= 0 && p.target <= world.width, `${p.id} bound for ${p.target}`);
      }
    });
  }
});

// Moving a spot off one pal used to shove it back into his body (562 -> 532).
test('none of them sets out for a spot inside his body while he is on the floor', () => {
  for (const state of ['idle', 'working']) {
    const world = worldOf(shellby({ state }));
    run(spawn(ROSTER, world, seeded(5)), world, 2000, seeded(17), pals => {
      for (const p of pals) {
        if (p.target != null) assert.ok(Math.abs(p.target - 500) >= 40, `${p.id} bound for ${p.target} while ${state}`);
      }
    });
  }
});

// Near the strip's end, the clamp back onto the strip used to land inside him.
test('a pal does not set out for a spot inside his body when he stands near the strip end', () => {
  const world = worldOf(shellby({ x: 20 }));
  run(spawn(ROSTER, world, seeded(5)), world, 2000, seeded(17), pals => {
    for (const p of pals) {
      if (p.target != null) assert.ok(Math.abs(p.target - 20) >= 40, `${p.id} bound for ${p.target}`);
    }
  });
});

test('pals set out for spots at least their own width apart when the strip has room', () => {
  const world = { width: 2400, shellby: shellby({ x: 1200 }), gap: 56 };
  const roster = ROSTER.slice(0, 3);
  run(spawn(roster, world, seeded(3)), world, 1500, seeded(11), pals => {
    const spots = pals.filter(p => p.target != null).map(p => p.target);
    for (const a of spots) for (const b of spots) if (a !== b) assert.ok(Math.abs(a - b) >= 56 - 0.001, `targets ${a} and ${b} overlap`);
  });
});
