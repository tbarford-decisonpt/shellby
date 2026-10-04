const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  PINCH, NUDGE, NOTE, DAILY, GAP, NOTE_LINES,
  levelOf, prankSet, logOf, arm, played, due, blocked, choosePrank, cursorNear, tugPoint, yanked,
  nudgeFor, shoveAt, pickNote,
} = require('../src/main/mischief');

const MINUTE = 60 * 1000;
const NOW = new Date(2026, 5, 10, 12, 0, 0).getTime();
const today = (over = {}) => ({ ...logOf(null, NOW), ...over });

test('mischief is off unless it is asked for', () => {
  assert.equal(levelOf(undefined), 'off');
  assert.equal(levelOf('nonsense'), 'off');
  assert.equal(levelOf('cheeky'), 'cheeky');
  assert.equal(levelOf('gremlin'), 'gremlin');
});

test('every prank is on until it is switched off', () => {
  assert.deepEqual(prankSet(null), { pinch: true, nudge: true, tracks: true, notes: true });
  assert.deepEqual(prankSet({ pinch: false, tracks: true }), { pinch: false, nudge: true, tracks: true, notes: true });
  assert.equal(prankSet('junk').notes, true);
});

test('nothing is due when it is off, before its time, or once the day is used up', () => {
  assert.equal(due(today({ next: NOW - 1 }), 'off', NOW), false);
  assert.equal(due(today({ next: NOW + 1 }), 'cheeky', NOW), false);
  assert.equal(due(today({ next: NOW - 1, count: DAILY.cheeky }), 'cheeky', NOW), false);
  assert.equal(due(today({ next: 0 }), 'cheeky', NOW), false, 'never armed');
});

test('a prank is due once its time has come and there is allowance left', () => {
  assert.equal(due(today({ next: NOW }), 'cheeky', NOW), true);
  assert.equal(due(today({ next: NOW - 5, count: DAILY.cheeky - 1 }), 'cheeky', NOW), true);
  assert.equal(due(today({ next: NOW - 5, count: DAILY.cheeky }), 'gremlin', NOW), true, 'gremlin allows more');
});

test('switching on arms the first prank between 90 seconds and 4 minutes out', () => {
  assert.equal(arm(null, NOW, () => 0).next, NOW + 90 * 1000);
  assert.equal(arm(null, NOW, () => 1).next, NOW + 4 * MINUTE);
});

test('arming leaves a prank already scheduled alone', () => {
  assert.equal(arm(today({ next: NOW + 1000 }), NOW, () => 0).next, NOW + 1000);
  assert.equal(arm(today({ next: NOW - 1000 }), NOW, () => 0).next, NOW + 90 * 1000, 'a stale one is rescheduled');
});

test('a played prank counts and schedules the next within the gap', () => {
  const [lo, hi] = GAP.cheeky;
  const early = played(today({ count: 2 }), 'cheeky', NOW, () => 0);
  assert.equal(early.count, 3);
  assert.equal(early.next, NOW + lo);
  assert.equal(played(today(), 'cheeky', NOW, () => 1).next, NOW + hi);
  const [glo, ghi] = GAP.gremlin;
  const g = played(today(), 'gremlin', NOW, () => 0.5).next - NOW;
  assert.ok(g >= glo && g <= ghi, String(g));
});

test('the count starts over on a new day, the schedule carries on', () => {
  const yesterday = { day: '2000-01-01', count: 5, next: 99 };
  assert.deepEqual(logOf(yesterday, NOW), { day: logOf(null, NOW).day, count: 0, next: 99 });
  assert.equal(logOf({ ...today(), count: 4 }, NOW).count, 4);
  assert.equal(logOf({ ...today(), count: -3 }, NOW).count, 0);
  assert.equal(logOf('junk', NOW).count, 0);
});

test('he behaves in each moment a prank would be unwelcome', () => {
  const calm = { level: 'cheeky', now: NOW };
  assert.equal(blocked(calm), null);
  assert.equal(blocked({ ...calm, level: 'off' }), 'off');
  const reasons = {
    capture: 'capture', guarding: 'focus', onCall: 'call', fullscreen: 'fullscreen', locked: 'locked',
    working: 'working', playing: 'playing', dragging: 'dragging', buttonsDown: 'buttons',
  };
  for (const [key, reason] of Object.entries(reasons)) assert.equal(blocked({ ...calm, [key]: true }), reason, key);
  assert.equal(blocked({ ...calm, pausedUntil: NOW + 1000 }), 'paused');
  assert.equal(blocked({ ...calm, pausedUntil: NOW - 1000 }), null, 'a pause that has run out');
});

test('a pinch is only on offer with the cursor near', () => {
  assert.equal(choosePrank({ cursorNear: true }, () => 0.5), 'pinch');
  assert.equal(choosePrank({ cursorNear: false }, () => 0.5), null);
});

test('a nudge needs him perched on a window', () => {
  assert.equal(choosePrank({ perched: true }, () => 0.5), 'nudge');
  assert.equal(choosePrank({ perched: false }, () => 0.5), null);
});

test('a note needs the floor and room for another', () => {
  assert.equal(choosePrank({ onFloor: true, notesOut: 2 }, () => 0.5), 'note');
  assert.equal(choosePrank({ onFloor: true, notesOut: NOTE.max }, () => 0.5), null);
  assert.equal(choosePrank({ onFloor: false, notesOut: 0 }, () => 0.5), null);
});

test('pranks that are switched off are never chosen', () => {
  const ctx = { cursorNear: true, perched: true, onFloor: true, notesOut: 0 };
  assert.equal(choosePrank({ ...ctx, enabled: prankSet({ pinch: false, nudge: false }) }, () => 0), 'note');
  assert.equal(choosePrank({ ...ctx, enabled: prankSet({ pinch: false, nudge: false, notes: false }) }, () => 0), null);
});

test('when several fit, the pinch is likeliest', () => {
  const ctx = { cursorNear: true, perched: true, onFloor: true, notesOut: 0 };
  assert.equal(choosePrank(ctx, () => 0), 'pinch');
  assert.equal(choosePrank(ctx, () => 0.5), 'nudge');
  assert.equal(choosePrank(ctx, () => 0.99), 'note');
});

test('the cursor is near when it is within reach of his claw', () => {
  assert.equal(cursorNear({ x: 100, y: 100 }, { x: 100 + PINCH.near, y: 100 }), true);
  assert.equal(cursorNear({ x: 100, y: 100 }, { x: 100 + PINCH.near + 1, y: 100 }), false);
  assert.equal(cursorNear(null, { x: 0, y: 0 }), false);
});

test('a pinch starts where he caught the cursor and never pulls it past the tug', () => {
  const start = { x: 200, y: 300 }, claw = { x: 500, y: 700 };
  assert.deepEqual(tugPoint(start, claw, 0), start);
  for (const u of [0, 0.25, 0.5, 0.75, 1, 2]) {
    const p = tugPoint(start, claw, u);
    assert.ok(Math.hypot(p.x - start.x, p.y - start.y) <= PINCH.tug + 1, `u=${u}`);
  }
  const end = tugPoint(start, claw, 1);
  assert.ok(Math.hypot(end.x - start.x, end.y - start.y) >= PINCH.tug - 1, 'a full pull');
});

test('a claw closer than the tug is never overshot', () => {
  const start = { x: 0, y: 0 }, claw = { x: 10, y: 0 };
  assert.deepEqual(tugPoint(start, claw, 1), { x: 10, y: 0 });
  assert.deepEqual(tugPoint(start, { x: 0.2, y: 0 }, 1), { x: 0, y: 0 }, 'already there');
});

test('yanking the cursor too far from his grip breaks it', () => {
  const held = { x: 400, y: 400 };
  assert.equal(yanked(held, { x: 400 + PINCH.breakPx, y: 400 }), false);
  assert.equal(yanked(held, { x: 400 + PINCH.breakPx + 1, y: 400 }), true);
  assert.equal(yanked(held, { x: 400, y: 400 - PINCH.breakPx - 1 }), true);
});

test('a shove keeps the window wholly inside its work area', () => {
  const wa = { x: 0, y: 0, width: 1000, height: 800 };
  for (const x of [0, 5, 400, 795, 800]) {
    for (const dir of [-1, 1]) {
      for (const r of [0, 0.5, 1]) {
        const frame = { x, y: 100, width: 200, height: 100 };
        const d = nudgeFor(frame, wa, dir, () => r);
        assert.ok(frame.x + d >= wa.x && frame.x + d + frame.width <= wa.x + wa.width, `x=${x} dir=${dir} r=${r} d=${d}`);
        assert.ok(Math.abs(d) <= NUDGE.max);
      }
    }
  }
});

test('a shove goes the way asked, by 24 to 56 DIPs', () => {
  const wa = { x: 0, y: 0, width: 1000, height: 800 };
  const frame = { x: 400, y: 100, width: 200, height: 100 };
  assert.equal(nudgeFor(frame, wa, 1, () => 0), NUDGE.min);
  assert.equal(nudgeFor(frame, wa, -1, () => 1), -NUDGE.max);
});

test('with no room that way a shove goes the other, and with none either way it does not happen', () => {
  const wa = { x: 0, y: 0, width: 1000, height: 800 };
  assert.equal(nudgeFor({ x: 800, y: 0, width: 200, height: 100 }, wa, 1, () => 0), -NUDGE.min, 'flush right');
  assert.equal(nudgeFor({ x: 0, y: 0, width: 200, height: 100 }, wa, -1, () => 0), NUDGE.min, 'flush left');
  assert.equal(nudgeFor({ x: 0, y: 0, width: 1000, height: 100 }, wa, 1, () => 0), 0, 'wall to wall');
});

test('a little room is enough for a shorter shove', () => {
  const wa = { x: 0, y: 0, width: 1000, height: 800 };
  assert.equal(nudgeFor({ x: 780, y: 0, width: 200, height: 100 }, wa, 1, () => 1), 20);
});

test('the shove starts at nothing and ends settled at everything', () => {
  assert.equal(shoveAt(0), 0);
  assert.equal(shoveAt(1), 1);
  assert.ok(shoveAt(0.7) > 1, 'a little overshoot on the way');
});

test('a note is a line from his list', () => {
  const all = Object.values(NOTE_LINES).flat();
  for (const r of [0, 0.3, 0.99]) assert.ok(all.includes(pickNote(NOW, () => r).text), String(r));
});

test('a note avoids lines he has just used', () => {
  const recent = NOTE_LINES.any.filter(x => x !== 'snip snip');
  assert.equal(pickNote(NOW, () => 0, recent).text, 'snip snip');
  assert.ok(NOTE_LINES.any.includes(pickNote(NOW, () => 0, NOTE_LINES.any).text), 'all used: any will do');
});

test('late at night the notes can be about going to bed', () => {
  const late = new Date(2026, 5, 10, 23, 30).getTime();
  const pick = pickNote(late, () => 16.5 / 24).text;
  assert.ok(NOTE_LINES.late.includes(pick), pick);
  const noon = pickNote(NOW, () => 0.99).text;
  assert.ok(!NOTE_LINES.late.includes(noon), 'not at noon');
});
