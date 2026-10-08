const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  edgesOf, footIn, centerIn, reorient, windowAt, alongOf, rangeOf, localDir, chooseWall, wantsToClimb,
  routeFrom, routeOnCeiling, climbStep, startRoute, leapFrom, wallNear, REACH,
} = require('../src/main/climb');

const G = { width: 160, height: 136, foot: 18, half: 44, body: 52 };
const WA = { x: 0, y: 0, width: 1920, height: 1040 };
const ALL = { left: true, right: true, ceiling: true };

const seq = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

const disp = (id, x, y, workArea) => ({
  id,
  bounds: { x, y, width: 1920, height: 1080 },
  workArea: workArea || { x, y, width: 1920, height: 1040 },
});

test('a lone screen has a left, right and ceiling to climb', () => {
  assert.deepEqual(edgesOf(disp(1, 0, 0), [disp(1, 0, 0)]), ALL);
});

test('a screen to the right makes that edge a doorway, not a wall', () => {
  const a = disp(1, 0, 0), b = disp(2, 1920, 0);
  assert.deepEqual(edgesOf(a, [a, b]), { left: true, right: false, ceiling: true });
  assert.deepEqual(edgesOf(b, [a, b]), { left: false, right: true, ceiling: true });
});

test('a screen above makes the ceiling a doorway', () => {
  const a = disp(1, 0, 1080), b = disp(2, 0, 0);
  assert.equal(edgesOf(a, [a, b]).ceiling, false);
  assert.equal(edgesOf(b, [a, b]).ceiling, true);
});

test('a screen that only touches at a corner is no doorway', () => {
  const a = disp(1, 0, 0), b = disp(2, 1920, 1080);
  assert.deepEqual(edgesOf(a, [a, b]), ALL);
});

test('a taskbar down the left side is a wall even with a screen beyond it', () => {
  const a = disp(1, 0, 0, { x: 48, y: 0, width: 1872, height: 1040 }), b = disp(2, -1920, 0);
  assert.equal(edgesOf(a, [a, b]).left, true);
  assert.equal(edgesOf(disp(1, 0, 0), [disp(1, 0, 0), b]).left, false, 'without the taskbar it is a doorway');
});

test('on the floor his window sits where motion.js puts it', () => {
  assert.equal(windowAt('floor', 900, WA, G).y, WA.y + WA.height - G.height);
});

test('his feet land exactly on the wall or ceiling he is on', () => {
  const left = windowAt('left', 500, WA, G);
  assert.equal(left.x + footIn('left', G).x, WA.x);
  assert.equal(left.y + footIn('left', G).y, 500);
  const right = windowAt('right', 500, WA, G);
  assert.equal(right.x + footIn('right', G).x, WA.x + WA.width);
  const roof = windowAt('ceiling', 700, WA, G);
  assert.equal(roof.y + footIn('ceiling', G).y, WA.y);
  assert.equal(roof.x + footIn('ceiling', G).x, 700);
});

test('alongOf undoes windowAt on every surface', () => {
  for (const s of ['floor', 'left', 'right', 'ceiling']) {
    assert.equal(alongOf(s, windowAt(s, 640, WA, G), G), 640, s);
  }
});

test('turning round keeps his body where it is on the screen', () => {
  const pos = { x: 300, y: 200 };
  for (const from of ['ceiling', 'left', 'right']) {
    const turned = reorient(pos, from, 'floor', G);
    const before = { x: pos.x + centerIn(from, G).x, y: pos.y + centerIn(from, G).y };
    const after = { x: turned.x + centerIn('floor', G).x, y: turned.y + centerIn('floor', G).y };
    assert.deepEqual(after, before, from);
  }
});

test('his whole body stays on the surface', () => {
  assert.deepEqual(rangeOf('floor', WA, G), { lo: 44, hi: 1876 });
  assert.deepEqual(rangeOf('ceiling', WA, G), { lo: 44, hi: 1876 });
  assert.deepEqual(rangeOf('left', WA, G), { lo: 44, hi: 996 });
  const shifted = { x: 100, y: 50, width: 800, height: 600 };
  assert.deepEqual(rangeOf('right', shifted, G), { lo: 94, hi: 606 });
  assert.deepEqual(rangeOf('floor', shifted, G), { lo: 144, hi: 856 });
});

test('his sprite faces the way his turned body is going', () => {
  assert.equal(localDir('left', -10), -1);
  assert.equal(localDir('right', -10), 1);
  assert.equal(localDir('ceiling', 10), -1);
  assert.equal(localDir('floor', 10), 1);
  assert.equal(localDir('floor', 0), 1, 'no movement still faces somewhere');
});

test('he goes for the nearer climbable wall', () => {
  assert.equal(chooseWall({ edges: ALL, wa: WA, g: G, fromX: 300 }, () => 0.9).side, 'left');
  assert.equal(chooseWall({ edges: ALL, wa: WA, g: G, fromX: 1700 }, () => 0.9).side, 'right');
});

test('now and then he picks the farther wall when both are in reach', () => {
  const narrow = { x: 0, y: 0, width: 1000, height: 800 };
  assert.equal(chooseWall({ edges: ALL, wa: narrow, g: G, fromX: 400 }, () => 0.5).side, 'left');
  assert.equal(chooseWall({ edges: ALL, wa: narrow, g: G, fromX: 400 }, () => 0.1).side, 'right');
});

test('no wall within reach means no climb', () => {
  const fromX = 960; // 916 from either side of a wide screen
  assert.ok(916 > REACH);
  assert.equal(chooseWall({ edges: ALL, wa: WA, g: G, fromX }, () => 0), null);
});

test('a wall that is a doorway is skipped, even when it is the nearer', () => {
  assert.equal(chooseWall({ edges: { left: false, right: true, ceiling: true }, wa: WA, g: G, fromX: 100 }, () => 0.9), null);
  const narrow = { x: 0, y: 0, width: 1000, height: 800 };
  assert.equal(chooseWall({ edges: { left: false, right: true, ceiling: true }, wa: narrow, g: G, fromX: 300 }, () => 0).side, 'right');
});

test('he never climbs when it is off, and waits out the cooldown', () => {
  const idle = { setting: 'sometimes', temperament: 'chipper', sinceLast: 10 * 60 * 1000 };
  assert.equal(wantsToClimb({ ...idle, setting: 'off' }, () => 0), false);
  assert.equal(wantsToClimb({ ...idle, sinceLast: 1000 }, () => 0), false);
  assert.equal(wantsToClimb({ ...idle, setting: 'often', sinceLast: 60 * 1000 }, () => 0), false);
});

test('off the cooldown the dice decide', () => {
  const idle = { setting: 'sometimes', temperament: 'chipper', sinceLast: 10 * 60 * 1000 };
  assert.equal(wantsToClimb(idle, () => 0), true);
  assert.equal(wantsToClimb(idle, () => 0.99), false);
});

test('every route ends with a way down', () => {
  for (const r of [0, 0.5, 0.9]) {
    const legs = routeFrom({ side: 'left', along: 500, edges: ALL, wa: WA, g: G }, () => r);
    const end = legs.at(-1);
    assert.equal(end.kind, 'end');
    assert.ok(['drop', 'leap', 'down'].includes(end.how), end.how);
    assert.equal(legs.filter(l => l.kind === 'end').length, 1);
  }
});

test('with no ceiling to cross he never goes onto it', () => {
  const edges = { left: true, right: true, ceiling: false };
  for (const side of ['left', 'right']) {
    for (const r of [0, 0.1, 0.3, 0.5, 0.7, 0.99]) {
      const legs = routeFrom({ side, along: 500, edges, wa: WA, g: G }, () => r);
      assert.ok(!legs.some(l => l.surface === 'ceiling'), `${side} ${r}`);
      assert.notEqual(legs.at(-1).how, 'drop');
    }
  }
});

test('a keen climber goes up to the top, across the ceiling and drops', () => {
  const legs = routeFrom({ side: 'left', along: 500, edges: ALL, wa: WA, g: G }, () => 0);
  const roof = legs.find(l => l.surface === 'ceiling');
  assert.ok(roof);
  assert.equal(legs.at(-1).how, 'drop');
  assert.equal(legs.find(l => l.kind === 'move').to, rangeOf('left', WA, G).lo, 'all the way up the wall');
});

test('a climb down walks the wall and ends on the floor', () => {
  const legs = routeFrom({ side: 'right', along: 500, edges: ALL, wa: WA, g: G }, () => 0.9);
  const moves = legs.filter(l => l.kind === 'move');
  assert.equal(legs.at(-1).how, 'down');
  assert.equal(moves.at(-1).surface, 'floor');
  assert.equal(moves.at(-2).surface, 'right');
});

test('thrown onto a wall he grips first', () => {
  const grabbed = routeFrom({ side: 'left', along: 500, edges: ALL, wa: WA, g: G, grabbed: true }, () => 0.9);
  assert.equal(grabbed[0].kind, 'pause');
  assert.equal(grabbed[0].bit, 'grip');
  const walked = routeFrom({ side: 'left', along: 500, edges: ALL, wa: WA, g: G }, () => 0.9);
  assert.notEqual(walked[0].bit, 'grip');
});

test('on the ceiling he shuffles along within it and lets go', () => {
  const roof = rangeOf('ceiling', WA, G);
  for (const along of [-50, 44, 900, 1900, 3000]) {
    for (const r of [0, 0.5, 1]) {
      const legs = routeOnCeiling({ along, wa: WA, g: G }, () => r);
      assert.equal(legs[0].bit, 'grip');
      assert.equal(legs.at(-1).how, 'drop');
      for (const l of legs.filter(x => x.kind === 'move')) {
        assert.equal(l.surface, 'ceiling');
        assert.ok(l.from >= roof.lo && l.from <= roof.hi && l.to >= roof.lo && l.to <= roof.hi, `${along} ${JSON.stringify(l)}`);
      }
    }
  }
});

// Runs a route to its end at 50 ms a frame; every frame is kept.
function drive(legs, surface = 'left', along = 500) {
  let s = startRoute(surface, along, legs);
  let now = 1000;
  const frames = [];
  for (let i = 0; i < 20000; i++) {
    now += 50;
    const r = climbStep(s, now, 50);
    frames.push({ before: s, ...r, now });
    s = r.state;
    if (r.end) return { frames, end: r.end };
  }
  throw new Error('the route never ended');
}

test('a route plays through to the end it planned', () => {
  for (const r of [0, 0.5, 0.9]) {
    const legs = routeFrom({ side: 'left', along: 500, edges: ALL, wa: WA, g: G }, () => r);
    assert.equal(drive(legs).end, legs.at(-1).how, `rand ${r}`);
  }
});

test('onto a new surface he is told to turn, then to walk', () => {
  const legs = routeFrom({ side: 'left', along: 500, edges: ALL, wa: WA, g: G }, () => 0);
  const { frames } = drive(legs);
  const turn = frames.find(f => f.events.some(e => e.type === 'surface'));
  assert.ok(turn);
  assert.deepEqual(turn.events.map(e => e.type).slice(0, 2), ['surface', 'walk']);
  assert.equal(turn.events[0].surface, 'ceiling');
  assert.equal(turn.state.surface, 'ceiling');
});

test('a pause stands still with a bit, and holds until its time is up', () => {
  const legs = [{ kind: 'pause', ms: 1000, bit: 'peer' }, { kind: 'end', how: 'drop' }];
  const first = climbStep(startRoute('left', 500, legs), 5000, 50);
  assert.deepEqual(first.events, [{ type: 'still' }, { type: 'bit', bit: 'peer', ms: 1000 }]);
  assert.equal(first.state.pauseUntil, 6000);
  const waiting = climbStep(first.state, 5999, 50);
  assert.equal(waiting.state.i, 0);
  assert.deepEqual(waiting.events, []);
  assert.equal(waiting.end, null);
  const over = climbStep(first.state, 6000, 50);
  assert.equal(over.state.i, 1);
  assert.equal(climbStep(over.state, 6050, 50).end, 'drop');
});

test('a pause with no bit only goes still', () => {
  const legs = [{ kind: 'pause', ms: 300 }, { kind: 'end', how: 'leap' }];
  assert.deepEqual(climbStep(startRoute('floor', 100, legs), 10, 50).events, [{ type: 'still' }]);
});

test('along stays on its surface the whole way', () => {
  for (const r of [0, 0.5, 0.9]) {
    const legs = routeFrom({ side: 'right', along: 800, edges: ALL, wa: WA, g: G, grabbed: true }, () => r);
    for (const f of drive(legs, 'right', 800).frames) {
      const range = rangeOf(f.state.surface, WA, G);
      assert.ok(f.state.along >= range.lo && f.state.along <= range.hi, `${f.state.surface} ${f.state.along}`);
    }
  }
});

test('he climbs up a wall at climbing speed', () => {
  const legs = [{ kind: 'move', surface: 'left', from: 800, to: 100, speed: 46 }, { kind: 'end', how: 'leap' }];
  const r = climbStep(startRoute('left', 800, legs), 0, 1000);
  assert.equal(r.state.along, 754);
  assert.deepEqual(r.events, [{ type: 'walk', dir: -1 }]);
});

test('a leap pushes him off the wall and upward', () => {
  const l = leapFrom('left', seq(0.5));
  assert.ok(l.vx > 0 && l.vy < 0, JSON.stringify(l));
  const r = leapFrom('right', seq(0.5));
  assert.ok(r.vx < 0 && r.vy < 0, JSON.stringify(r));
});

test('put down by a climbable wall above the floor, he grabs it', () => {
  assert.equal(wallNear({ x: -40, y: 500 }, WA, G, ALL), 'left');
  assert.equal(wallNear({ x: 1800, y: 500 }, WA, G, ALL), 'right');
  assert.equal(wallNear({ x: 900, y: 500 }, WA, G, ALL), null, 'mid-screen');
});

test('put down on the floor, or by a doorway, he does not grab', () => {
  assert.equal(wallNear({ x: -40, y: WA.height - G.height }, WA, G, ALL), null);
  assert.equal(wallNear({ x: -40, y: 500 }, WA, G, { left: false, right: true, ceiling: true }), null);
  assert.equal(wallNear({ x: 1800, y: 500 }, WA, G, { left: true, right: false, ceiling: true }), null);
});
