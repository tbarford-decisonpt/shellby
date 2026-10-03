const { test } = require('node:test');
const assert = require('node:assert/strict');
const perch = require('../src/main/perch');

// A Medium Shellby: 160×136 window, feet 18 above its bottom, sprite 88 wide.
const GEO = { width: 160, height: 136, foot: 18, half: 44, headroom: 118 };
const WA = { x: 0, y: 0, width: 1920, height: 1040 };

const win = (over = {}) => ({
  hwnd: 100, pid: 42, exe: 'notepad.exe', cls: 'Notepad', gone: false,
  frame: { x: 400, y: 300, width: 900, height: 600 }, workArea: WA,
  visible: true, minimized: false, maximized: false, cloaked: false, hung: false,
  captioned: true, child: false, tool: false, topmost: false, noActivate: false, clickThrough: false, owned: false,
  ...over,
});
const ctx = (over = {}) => ({ ownPids: new Set([7]), ignore: new Set(), geo: GEO, ...over });

test('perchable: an ordinary window with room above it', () => {
  assert.equal(perch.perchable(win(), ctx()), true);
});

test('perchable: never his own windows, ignored apps, shell chrome or odd windows', () => {
  assert.equal(perch.perchable(win({ pid: 7 }), ctx()), false, 'his own');
  assert.equal(perch.perchable(win(), ctx({ ignore: new Set(['notepad.exe']) })), false, 'told to stay off');
  assert.equal(perch.perchable(win({ cls: 'Shell_TrayWnd' }), ctx()), false, 'the taskbar');
  for (const flag of ['minimized', 'maximized', 'cloaked', 'hung', 'tool', 'topmost', 'noActivate', 'clickThrough', 'owned', 'child']) {
    assert.equal(perch.perchable(win({ [flag]: true }), ctx()), false, flag);
  }
  assert.equal(perch.perchable(win({ visible: false }), ctx()), false, 'hidden');
  assert.equal(perch.perchable(win({ captioned: false }), ctx()), false, 'no title bar');
  assert.equal(perch.perchable(null, ctx()), false);
  assert.equal(perch.perchable(win({ frame: null }), ctx()), false);
});

test('perchable: too small, no room above, or a title bar under the taskbar', () => {
  assert.equal(perch.perchable(win({ frame: { x: 400, y: 300, width: 200, height: 600 } }), ctx()), false, 'narrow');
  assert.equal(perch.perchable(win({ frame: { x: 400, y: 300, width: 900, height: 100 } }), ctx()), false, 'short');
  assert.equal(perch.perchable(win({ frame: { x: 400, y: 60, width: 900, height: 600 } }), ctx()), false, 'up against the top');
  assert.equal(perch.perchable(win({ frame: { x: 400, y: 1030, width: 900, height: 600 } }), ctx()), false, 'below the work area');
});

test('the ledge keeps clear of the caption buttons and the app icon, and of the screen edge', () => {
  const l = perch.ledgeOf({ x: 400, y: 300, width: 900, height: 600 }, WA, GEO);
  assert.equal(l.x1, 400 + perch.CAPTION_LEFT + GEO.half);
  assert.equal(l.x2, 1300 - perch.CAPTION_RIGHT - GEO.half);
  assert.equal(l.y, 300);
  const off = perch.ledgeOf({ x: 1500, y: 300, width: 900, height: 600 }, WA, GEO);
  assert.equal(off.x2, 1920 - GEO.half, 'clipped at the screen edge, not the window edge');
  assert.equal(perch.ledgeOf({ x: 400, y: 300, width: 250, height: 600 }, WA, GEO), null, 'no room between icon and buttons');
});

test('standing on a ledge puts his feet on the frame top, and centerOf undoes it', () => {
  const at = perch.standAt(700, 300, GEO);
  assert.equal(at.x, 620);
  assert.equal(at.y + GEO.height - GEO.foot, 300 + perch.SINK, 'feet just into the top edge');
  assert.equal(perch.centerOf(at, GEO), 700);
});

test('visible ledges: a window on top hides the part of the title bar it covers', () => {
  const below = { hwnd: 1, ok: true, frame: { x: 0, y: 400, width: 1600, height: 500 }, workArea: WA };
  const above = { hwnd: 2, ok: false, frame: { x: 500, y: 300, width: 400, height: 400 }, workArea: WA };
  const segs = perch.visibleLedges([above, below], GEO);
  assert.equal(segs.length, 2, 'split in two around the window on top');
  assert.ok(segs.every(s => s.hwnd === 1));
  assert.ok(segs[0].x2 <= 500 - GEO.half && segs[1].x1 >= 900 + GEO.half, JSON.stringify(segs));
  // A window above that sits well away from the title bar hides nothing.
  const far = { hwnd: 3, ok: false, frame: { x: 500, y: 700, width: 400, height: 100 }, workArea: WA };
  assert.equal(perch.visibleLedges([far, below], GEO).length, 1);
  // Not-ok windows block but are never landed on.
  assert.equal(perch.visibleLedges([above], GEO).length, 0);
});

test('flight ledges are in window coordinates, and ledgeUnder finds a drop near a title bar', () => {
  const seg = { hwnd: 9, x1: 500, x2: 900, y: 300 };
  const [l] = perch.flightLedges([seg], GEO);
  assert.equal(l.id, 9);
  assert.deepEqual([l.x1, l.x2, l.y], [500 - 80, 900 - 80, perch.standAt(500, 300, GEO).y]);
  const on = perch.standAt(700, 300, GEO);
  assert.equal(perch.ledgeUnder({ x: on.x, y: on.y - 10 }, [seg], GEO), seg, 'just above it counts');
  assert.equal(perch.ledgeUnder({ x: on.x, y: on.y - 80 }, [seg], GEO), null, 'well above it does not');
  assert.equal(perch.ledgeUnder({ x: 2000, y: on.y }, [seg], GEO), null, 'off the end');
});

test('pickSpot lands a little way in from the end he comes from', () => {
  const seg = { x1: 500, x2: 900 };
  const fromLeft = perch.pickSpot(seg, 100, () => 0.5);
  assert.ok(fromLeft > 500 && fromLeft < 700, String(fromLeft));
  const fromRight = perch.pickSpot(seg, 1500, () => 0.5);
  assert.ok(fromRight < 900 && fromRight > 700, String(fromRight));
  const within = perch.pickSpot(seg, 650, () => 0);
  assert.ok(within >= 500 && within <= 900);
});

test('a hop arcs above both ends, follows a moving target, and lands exactly', () => {
  const from = { x: 1000, y: 900 }, to = { x: 600, y: 300 };
  let top = Infinity;
  for (let t = 0; t <= 1; t += 0.02) top = Math.min(top, perch.hopPoint(from, to, t).y);
  assert.ok(top < to.y - 20, `apex ${top} clears the target ${to.y}`);
  assert.deepEqual(perch.hopPoint(from, to, 0), from);
  assert.deepEqual(perch.hopPoint(from, to, 1), to);
  assert.deepEqual(perch.hopPoint(from, { x: 650, y: 320 }, 1), { x: 650, y: 320 }, 'lands where the target is now');
  assert.ok(perch.hopDuration(from, to) >= 480 && perch.hopDuration(from, to) <= 1100);
  assert.equal(perch.hopFlips({ x: 0, y: 0 }, { x: 100, y: 0 }), false);
  assert.equal(perch.hopFlips({ x: 0, y: 0 }, { x: 900, y: 0 }), true);
});

test('the spring settles on its target without running away', () => {
  let s = { p: 0, v: 0 };
  for (let i = 0; i < 120; i++) s = perch.spring(s.p, s.v, 100, 16, { k: 520, zeta: 0.32 });
  assert.ok(Math.abs(s.p - 100) < 1 && Math.abs(s.v) < 10, JSON.stringify(s));
});

const drag = (points, t0 = 0, every = 16) => points.map((x, i) => ({ x, y: 300, t: t0 + i * every }));

test('judgeRide: a gentle drag keeps him on', () => {
  const r = perch.judgeRide(drag([0, 4, 8, 12, 16, 20, 24]), 96);
  assert.equal(r.off, false);
});

test('judgeRide: a hard yank flings him off', () => {
  const r = perch.judgeRide(drag([0, 60, 120, 180, 240, 300]), 80);
  assert.equal(r.off, true);
  assert.equal(r.why, 'yank');
  assert.ok(r.vx > 0 && r.vy < 0, 'onward and up');
});

test('judgeRide: shaking it back and forth throws him off dizzy', () => {
  const xs = [0, 30, 60, 30, 0, 30, 60, 30, 0, 30, 60];
  const samples = xs.map((x, i) => ({ x, y: 300, t: i * 40 }));
  assert.ok(perch.reversals(samples, 400) >= perch.SHAKE_REVERSALS);
  const r = perch.judgeRide(samples, 400);
  assert.equal(r.off, true);
  assert.equal(r.why, 'shake');
  assert.equal(r.dizzy, true);
});

test('judgeRide: a fast drag that stops dead sends him on ahead', () => {
  const moving = drag([0, 30, 60, 90, 120, 150]);
  const stopped = [...moving, ...[0, 1, 2, 3, 4, 5, 6].map(i => ({ x: 150, y: 300, t: 96 + i * 16 }))];
  const r = perch.judgeRide(stopped, 192);
  assert.equal(r.off, true);
  assert.equal(r.why, 'brake');
  assert.ok(r.vx > 0);
});

test('reversals ignore wobbles smaller than a real swing', () => {
  const xs = [0, 3, 0, 3, 0, 3, 0, 3, 0];
  assert.equal(perch.reversals(xs.map((x, i) => ({ x, y: 0, t: i * 30 })), 300), 0);
});

test('classify: what became of the window', () => {
  const read = (over = {}) => ({ gone: false, visible: true, frame: { x: 0, y: 300, width: 900, height: 600 }, workArea: WA, ...over });
  assert.equal(perch.classify(read(), GEO), 'ok');
  assert.equal(perch.classify({ gone: true }, GEO), 'gone');
  assert.equal(perch.classify(null, GEO), 'gone');
  assert.equal(perch.classify(read({ minimized: true }), GEO), 'minimized');
  assert.equal(perch.classify(read({ visible: false }), GEO), 'hidden');
  assert.equal(perch.classify(read({ cloaked: true }), GEO), 'hidden');
  assert.equal(perch.classify(read({ maximized: true }), GEO), 'maxed');
  assert.equal(perch.classify(read({ frame: { x: 0, y: 5, width: 900, height: 600 } }), GEO), 'maxed');
});

// A ride on a window whose frame we move by hand, one 16 ms frame at a time.
function rig(frame = { x: 400, y: 300, width: 900, height: 600 }) {
  let now = 1000;
  const cx = 700;
  const at = perch.standAt(cx, frame.y, GEO);
  let state = perch.startRide({ hwnd: 1, frame, cx, now, at });
  let read = { gone: false, visible: true, frame, workArea: WA };
  const out = { events: [], place: at, release: null };
  return {
    get state() { return state; },
    set: patch => { read = { ...read, ...patch }; },
    move: (dx, dy = 0) => { read = { ...read, frame: { ...read.frame, x: read.frame.x + dx, y: read.frame.y + dy } }; },
    step: (n = 1) => {
      for (let i = 0; i < n; i++) {
        now += 16;
        const r = perch.rideStep(state, read, now, 16, GEO);
        state = r.state;
        out.events.push(...r.events);
        out.place = r.place;
        if (r.release) { out.release = r.release; break; }
      }
      return out;
    },
    out,
    get read() { return read; },
    advance: ms => { now += ms; },
  };
}

test('riding: sitting still stays put; a slow drag carries him along, gripping', () => {
  const r = rig();
  const start = r.step(10).place;
  assert.deepEqual(start, perch.standAt(700, 300, GEO));
  for (let i = 0; i < 40; i++) { r.move(3); r.step(); }
  assert.ok(r.out.events.includes('cling'), 'grips when it moves');
  assert.equal(r.out.release, null, 'a slow drag keeps him on');
  r.step(60);
  assert.ok(r.out.events.includes('settle'), 'lets go of the grip once it stops');
  const expected = perch.standAt(700 + 120, 300, GEO);
  assert.ok(Math.abs(r.out.place.x - expected.x) <= 1 && Math.abs(r.out.place.y - expected.y) <= 1, JSON.stringify(r.out.place));
  assert.ok(r.state.distance >= 119, 'counts how far he rode');
});

test('riding: the window closing leaves him hanging a beat, then he falls', () => {
  const r = rig();
  r.step(3);
  r.set({ gone: true });
  r.step();
  assert.ok(r.out.events.includes('coyote:gone'));
  assert.equal(r.out.release, null, 'not straight away');
  r.step(Math.ceil(perch.COYOTE_MS / 16) + 2);
  assert.ok(r.out.events.includes('fall'));
  assert.equal(r.out.release.style, 'fall');
});

test('riding: minimized and hidden windows drop him too, maximized pops him off', () => {
  const a = rig();
  a.set({ minimized: true });
  a.step();
  assert.ok(a.out.events.includes('coyote:minimized'));
  const b = rig();
  b.set({ maximized: true });
  b.step();
  assert.ok(b.out.events.includes('pop'));
  assert.ok(b.out.release.vy < -500);
  assert.equal(b.out.release.style, 'pop');
});

test('riding: a hard yank flings him off with the window\'s speed', () => {
  const r = rig();
  r.step(2);
  for (let i = 0; i < 8 && !r.out.release; i++) { r.move(60); r.step(); }
  assert.ok(r.out.release, 'let go');
  assert.equal(r.out.release.style, 'fling');
  assert.ok(r.out.release.vx > 1000);
  assert.ok(r.out.events.some(e => e.startsWith('letgo:')));
});

test('riding: the bar shrinking under him sends him scrambling; vanishing under him, falling', () => {
  const r = rig();
  r.step(2);
  // Resized from the right so his spot is now among the caption buttons.
  r.set({ frame: { x: 400, y: 300, width: 420, height: 600 } });
  r.step(40);
  assert.ok(r.out.events.includes('scramble'));
  const l = perch.ledgeOf(r.read.frame, WA, GEO);
  assert.ok(r.state.offset + 400 <= l.x2 + 0.5, 'back on the walkable part');
  // Resized again, so narrow that there's no bar left between icon and buttons.
  r.set({ frame: { x: 400, y: 300, width: 240, height: 600 } });
  r.step(2);
  assert.ok(r.out.events.includes('coyote:edge'));
});

test('a stroll along the bar walks to a spot and settles there', () => {
  const r = rig();
  r.step(2);
  const walking = perch.strollOnLedge(r.state, r.read, GEO, () => 0.9);
  assert.equal(walking.mode, 'walk');
  assert.notEqual(walking.walkTo, walking.offset);
  // Hand the walking state back to the rig and let him get there.
  let state = walking;
  let now = 5000;
  let walked = false;
  for (let i = 0; i < 400 && !walked; i++) {
    now += 16;
    const res = perch.rideStep(state, r.read, now, 16, GEO);
    state = res.state;
    walked = res.events.includes('walked');
  }
  assert.ok(walked);
  assert.equal(state.mode, 'sit');
  const clinging = { ...state, mode: 'cling' };
  assert.equal(perch.strollOnLedge(clinging, r.read, GEO), clinging, 'no strolling mid-ride');
});

test('rideStep never mutates the state it is given', () => {
  const r = rig();
  r.step(2);
  const before = JSON.stringify(r.state);
  const frozen = JSON.parse(before);
  perch.rideStep(frozen, { ...r.read, frame: { ...r.read.frame, x: r.read.frame.x + 20 } }, 99999, 16, GEO);
  assert.equal(JSON.stringify(frozen), before);
});

test('wantsToPerch: off never, cooldown respected, temperament matters', () => {
  assert.equal(perch.wantsToPerch({ setting: 'off', temperament: 'cocky', sinceLast: Infinity }, () => 0), false);
  assert.equal(perch.wantsToPerch({ setting: 'often', temperament: 'cocky', sinceLast: 1000 }, () => 0), false, 'too soon');
  assert.equal(perch.wantsToPerch({ setting: 'often', temperament: 'cocky', sinceLast: 10 * 60000 }, () => 0.35), true);
  assert.equal(perch.wantsToPerch({ setting: 'often', temperament: 'fussy', sinceLast: 10 * 60000 }, () => 0.35), false, 'a fussy crab is less keen');
  assert.equal(perch.wantsToPerch({ setting: 'garbage', temperament: 'chipper', sinceLast: 10 * 60000 }, () => 0), true, 'unknown setting reads as sometimes');
  assert.equal(perch.settingOf('nope'), 'sometimes');
});

test('stayFor: minutes, longer for a sleepy crab', () => {
  const chipper = perch.stayFor('chipper', () => 0.5);
  assert.ok(chipper >= 2 * 60000 && chipper <= 6 * 60000);
  assert.ok(perch.stayFor('sleepy', () => 0.5) > chipper);
  assert.ok(perch.stayFor('fussy', () => 0.5) < chipper);
});

test('chooseLedge: the window you are using, sometimes his favourite instead', () => {
  const segs = [
    { hwnd: 1, exe: 'code.exe', x1: 100, x2: 400, y: 300 },
    { hwnd: 2, exe: 'spotify.exe', x1: 900, x2: 1300, y: 200 },
  ];
  assert.equal(perch.chooseLedge(segs, { foreground: 1, favourite: null, fromX: 1000 }, () => 0.9).hwnd, 1);
  assert.equal(perch.chooseLedge(segs, { foreground: 1, favourite: 'spotify.exe', fromX: 1000 }, () => 0.1).hwnd, 2);
  assert.equal(perch.chooseLedge(segs, { foreground: 99, favourite: null, fromX: 0 }, () => 0.9), null, 'foreground not visible');
  assert.equal(perch.chooseLedge([], { foreground: 1 }), null);
});

test('recordPerch counts per app, rejects junk, and favouriteOf needs a few visits', () => {
  let s = null;
  s = perch.recordPerch(s, 'spotify.exe');
  s = perch.recordPerch(s, 'spotify.exe');
  assert.equal(perch.favouriteOf(s), null, 'two is not a habit');
  s = perch.recordPerch(s, 'spotify.exe');
  s = perch.recordPerch(s, 'code.exe');
  assert.equal(perch.favouriteOf(s), 'spotify.exe');
  const before = JSON.stringify(s);
  perch.recordPerch(s, 'code.exe');
  assert.equal(JSON.stringify(s), before, 'never mutates');
  assert.deepEqual(perch.recordPerch(s, '../../evil'), s, 'not an exe name');
  assert.deepEqual(perch.recordPerch(s, 42), s);
  let many = null;
  for (let i = 0; i < 50; i++) many = perch.recordPerch(many, `app${i}.exe`);
  assert.ok(Object.keys(many.byExe).length <= 30, 'capped');
});

test('appName makes a menu label from an exe', () => {
  assert.equal(perch.appName('spotify.exe'), 'Spotify');
  assert.equal(perch.appName(''), 'this app');
});

test('judgeRide: big fast swings are a shake, not a run of sudden stops', () => {
  // Jumps of 110 px every other frame, back and forth, as a quick shake looks.
  const samples = [];
  let x = 0;
  for (let i = 0; i < 12; i++) {
    if (i % 2 === 0) x = x === 0 ? 110 : 0;
    samples.push({ x, y: 300, t: i * 16 });
  }
  const mid = samples.slice(0, 5);
  assert.notEqual(perch.judgeRide(mid, mid.at(-1).t).why, 'brake', 'a swing that reverses is not a brake');
  const r = perch.judgeRide(samples, samples.at(-1).t);
  assert.equal(r.why, 'shake');
  assert.equal(r.dizzy, true);
});

test('judgeRide: a window snapped across the screen in one step does not fling him', () => {
  // Win+← : still, then one 900 px jump, then still again.
  const samples = [
    ...[0, 1, 2, 3].map(i => ({ x: 0, y: 300, t: i * 16 })),
    { x: 900, y: 300, t: 64 },
    ...[5, 6, 7].map(i => ({ x: 900, y: 300, t: i * 16 })),
  ];
  for (let n = 5; n <= samples.length; n++) {
    const r = perch.judgeRide(samples.slice(0, n), samples[n - 1].t);
    assert.equal(r.off, false, `held on at step ${n} (${r.why})`);
  }
  assert.deepEqual(perch.movingRuns(samples, 112), { trailing: 0, longest: 1 });
});

test('judgeRide: one clean yank is a fling; a yank mid-swing leaves him dizzy', () => {
  const clean = perch.judgeRide(drag([0, 60, 120, 180, 240, 300]), 80);
  assert.equal(clean.why, 'yank');
  assert.equal(clean.dizzy, false);
  // Swung right, then yanked hard back left.
  const swung = [0, 40, 80, 120, 20, -80, -180, -280].map((x, i) => ({ x, y: 300, t: i * 16 }));
  const r = perch.judgeRide(swung, 112);
  assert.equal(r.off, true);
  assert.equal(r.dizzy, true);
});
