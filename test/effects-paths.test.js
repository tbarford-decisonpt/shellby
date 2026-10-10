// Effect paths (shared/effects.js): every particle sits on whole art pixels for
// whole ticks of the 12 fps clock, so it steps like he does and framecap only
// presents a frame when one moves.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plan, keyframesOf, stripRows, MOTIONS, TICK } = require('../src/renderer/shared/effects.js');

// A seeded random source, so a failure replays.
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const field = (over = {}) => ({ wc: 80, hc: 70, sw: 5, sh: 5, rc: 20, speed: 1, ...over });
const ticks = holds => holds.reduce((n, h) => n + h.t, 0);

test('every motion holds whole cells for whole ticks', () => {
  for (const motion of MOTIONS) {
    for (let seed = 1; seed <= 20; seed++) {
      const p = plan(motion, field(), { i: seed % 4, n: 4, frames: 4, fps: 8, random: seeded(seed) });
      assert.ok(p.holds.length > 1, `${motion} moves`);
      for (const h of p.holds) {
        assert.ok(Number.isInteger(h.x) && Number.isInteger(h.y), `${motion} sits on a pixel: ${JSON.stringify(h)}`);
        assert.ok(Number.isInteger(h.t) && h.t >= 1, `${motion} holds whole ticks: ${JSON.stringify(h)}`);
      }
      assert.ok(Number.isInteger(p.delay), `${motion} starts on a tick`);
    }
  }
});

test('a hold never repeats the one before it', () => {
  for (const motion of MOTIONS) {
    const { holds } = plan(motion, field(), { random: seeded(7) });
    holds.slice(1).forEach((h, k) => {
      const g = holds[k];
      assert.ok(h.x !== g.x || h.y !== g.y || h.on !== g.on, `${motion} hold ${k + 1} repeats`);
    });
  }
});

test('a slow fall moves one pixel a step; rain moves several and doesn\'t settle', () => {
  const snow = plan('fall', field({ speed: 0.8 }), { random: seeded(3) }).holds;
  const shown = snow.filter(h => h.on);
  for (let k = 1; k < shown.length; k++) {
    const dy = shown[k].y - shown[k - 1].y;
    assert.ok(dy === 1 || dy <= 0, `snow steps a pixel down (or lands, or starts a new lane): ${dy}`);
  }
  assert.ok(snow.some((h, k) => k > 0 && !h.on && snow[k - 1].on && snow[k + 1]?.on), 'snow blinks where it lands');

  const rain = plan('fall', field({ speed: 2.6, hc: 140 }), { random: seeded(3) }).holds;
  assert.ok(rain.some((h, k) => k > 0 && h.y - rain[k - 1].y > 1), 'rain falls more than a pixel a step');
  const lane = rain.slice(0, rain.findIndex(h => !h.on) + 1);
  assert.equal(lane.filter(h => !h.on).length, 1, 'rain ends without blinking');
});

test('orbiting particles are spaced evenly round the loop', () => {
  const n = 4;
  const ps = Array.from({ length: n }, (_, i) => plan('orbit', field(), { i, n, random: () => 0.5 }));
  const total = ticks(ps[0].holds);
  ps.forEach((p, i) => assert.equal(p.delay, -Math.round(total * i / n)));
  const xs = ps[0].holds.map(h => h.x), ys = ps[0].holds.map(h => h.y);
  assert.ok(Math.max(...xs) - Math.min(...xs) > Math.max(...ys) - Math.min(...ys), 'the ring is flattened');
});

test('a twinkle plays its frames there and back, once per showing', () => {
  const p = plan('twinkle', field(), { frames: 4, fps: 6, random: seeded(11) });
  const fpt = 2; // 12 / 6
  assert.deepEqual(p.strip.slice(0, -1).map(s => s.f), [0, 1, 2, 3, 2, 1, 0]);
  assert.ok(p.strip.slice(0, -1).every(s => s.t === fpt));
  const shown = p.holds.filter(h => h.on);
  assert.ok(shown.every(h => h.t === 7 * fpt), 'shown exactly as long as the frames take');
  assert.equal(ticks(p.holds), ticks(p.strip) * shown.length, 'the frames line up with every showing');
  assert.equal(new Set(shown.map(h => `${h.x},${h.y}`)).size > 1, true, 'each showing is somewhere else');
});

test('other motions loop their frames in order at the fps', () => {
  const p = plan('float', field(), { frames: 3, fps: 4, random: seeded(2) });
  assert.deepEqual(p.strip, [{ f: 0, t: 3 }, { f: 1, t: 3 }, { f: 2, t: 3 }]);
  assert.equal(plan('float', field(), { frames: 1, random: seeded(2) }).strip, null);
});

test('a burst plays once, arcs up then down, and ends hidden', () => {
  const p = plan('burst', field(), { i: 0, n: 1, px: 3, random: () => 0.5 });
  assert.equal(p.once, true);
  assert.ok(p.delay >= 0);
  const ys = p.holds.map(h => h.y);
  const top = Math.min(...ys);
  assert.ok(top < ys[0] && top < ys[ys.length - 1], 'it rises before it falls');
  assert.equal(p.holds[p.holds.length - 1].on, false);
});

test('keyframes step from hold to hold over the whole loop', () => {
  const holds = [{ x: 0, y: 0, on: true, t: 2 }, { x: 1, y: 0, on: true, t: 1 }, { x: 1, y: 1, on: false, t: 3 }];
  const { keyframes, duration } = keyframesOf(holds, h => ({ transform: `translate(${h.x}px, ${h.y}px)` }));
  assert.equal(duration, 6 * TICK);
  assert.deepEqual(keyframes.map(k => k.offset), [0, 2 / 6, 3 / 6, 1]);
  assert.ok(keyframes.slice(0, -1).every(k => k.easing === 'step-end'));
  assert.equal(keyframes[3].transform, keyframes[2].transform, 'the last hold lasts to the end');
});

test('a strip lays the frames side by side, with room for the ink line', () => {
  const sprite = { palette: { b: '#111111' }, pixels: ['b.', 'bb'], frames: [['.b', 'b']] };
  assert.deepEqual(stripRows(sprite, false), { rows: ['b..b', 'bbb.'], frames: 2, cw: 2, ch: 2 });
  assert.deepEqual(stripRows(sprite, true), { rows: ['b....b', 'bb..b.'], frames: 2, cw: 4, ch: 4 });
});

test('a faster orbit laps sooner', () => {
  const lap = speed => ticks(plan('orbit', field({ speed }), { random: () => 0.5 }).holds);
  assert.ok(lap(3) < lap(2) && lap(2) < lap(1) && lap(1) < lap(0.25), `${lap(0.25)} ${lap(1)} ${lap(2)} ${lap(3)}`);
});

test('a slow float keeps its keyframes in check', () => {
  const { holds } = plan('float', field({ speed: 0.25 }), { random: seeded(5) });
  assert.ok(holds.length <= 121, `${holds.length} holds`);
});
