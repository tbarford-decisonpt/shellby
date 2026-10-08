const { test } = require('node:test');
const assert = require('node:assert/strict');
const ev = require('../src/main/events');
const { KNOWN_SEASONS } = require('../src/main/wardrobe/seasons');

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h);

test('every event is well formed: a season, four goals, a drawable medal', () => {
  const ids = new Set();
  for (const e of ev.EVENTS) {
    assert.ok(/^[a-z0-9-]+$/.test(e.id) && !ids.has(e.id), e.id);
    ids.add(e.id);
    assert.ok(KNOWN_SEASONS.has(e.season), `${e.id} season`);
    assert.equal(e.goals.length, 4, `${e.id} goals`);
    assert.equal(new Set(e.goals.map(g => g.id)).size, 4, `${e.id} goal ids`);
    assert.ok(e.goals.some(g => g.on === 'event-bug'), `${e.id} has its bug as a goal`);
    assert.equal(e.finds.length, 2, `${e.id} finds`);
    assert.ok(e.name.length <= 20 && e.blurb.length <= 100 && e.twist.length <= 100, `${e.id} text`);
    assert.equal(e.medal.pixels.length, 7);
    for (const row of e.medal.pixels) {
      assert.equal(row.length, 7, `${e.id} medal row`);
      for (const ch of row) assert.ok(ch === '.' || /^#[0-9a-f]{6}$/i.test(e.medal.palette[ch] || ''), `${e.id} medal colour ${ch}`);
    }
  }
});

test('no two events are ever on at once, north or south', () => {
  for (const south of [false, true]) {
    for (let t = at(2026, 1, 1).getTime(); t < at(2027, 1, 1).getTime(); t += 24 * 3600e3) {
      const d = new Date(t);
      const on = ev.EVENTS.filter(e => ev.runAt(e, d, { south }));
      assert.ok(on.length <= 1, `${d.toDateString()} south=${south}: ${on.map(e => e.id)}`);
    }
  }
});

test('windows are inclusive local days, and Frostbite wraps the new year', () => {
  const h = ev.eventById('haunting');
  assert.equal(ev.runAt(h, at(2026, 10, 23, 23)), null);
  assert.equal(ev.runAt(h, at(2026, 10, 24, 0)).key, 'haunting@2026');
  assert.equal(ev.runAt(h, at(2026, 11, 1, 23)).key, 'haunting@2026');
  assert.equal(ev.runAt(h, at(2026, 11, 2, 0)), null);
  const f = ev.eventById('frostbite');
  assert.equal(ev.runAt(f, at(2027, 1, 1, 22)).key, 'frostbite@2026', 'New Year\'s Day belongs to the run that started in December');
  assert.equal(ev.runAt(f, at(2027, 1, 2)), null);
});

test('nature events move south; the holidays keep their dates', () => {
  const low = ev.eventById('low-tide');
  assert.ok(ev.runAt(low, at(2026, 7, 15)));
  assert.equal(ev.runAt(low, at(2026, 7, 15), { south: true }), null);
  assert.ok(ev.runAt(low, at(2027, 1, 15), { south: true }));
  assert.ok(ev.runAt(ev.eventById('haunting'), at(2026, 10, 28), { south: true }));
});

test('the next event, and when a missed one is back', () => {
  const up = ev.upcoming(at(2026, 10, 10));
  assert.equal(up.ev.id, 'haunting');
  assert.equal(ev.backOn('haunting', at(2026, 11, 5)).getFullYear(), 2027);
  assert.equal(ev.backOn('haunting', at(2026, 10, 28)).getDate(), 24, 'on now: back is the start of this run');
});

test('boosts only while their event is on', () => {
  const tide = ev.boostsAt(at(2026, 7, 12));
  assert.equal(tide.event, 'low-tide');
  assert.equal(tide.dig, 2);
  assert.equal(tide.shinyFor('shallows'), 2);
  const haunt = ev.boostsAt(at(2026, 10, 30));
  assert.equal(haunt.shinyFor('wreck'), 2);
  assert.equal(haunt.shinyFor('shallows'), 1);
  assert.equal(ev.boostsAt(at(2026, 10, 5)).xp, 1.5);
  const none = ev.boostsAt(at(2026, 6, 1));
  assert.equal(none.event, null);
  assert.equal(none.xp, 1);
  assert.equal(none.shinyFor('wreck'), 1);
});

test('each event bug comes along only with its kind of fix', () => {
  assert.equal(ev.bugComesAlong('haunting', { hour: 22 }), true);
  assert.equal(ev.bugComesAlong('haunting', { hour: 3 }), true);
  assert.equal(ev.bugComesAlong('haunting', { hour: 14 }), false);
  assert.equal(ev.bugComesAlong('harvest', { forms: ['first-try'] }), true);
  assert.equal(ev.bugComesAlong('harvest', { forms: ['swift'] }), false);
  assert.equal(ev.bugComesAlong('frostbite', { todayCount: 3 }), true);
  assert.equal(ev.bugComesAlong('frostbite', { todayCount: 2 }), false);
  assert.equal(ev.bugComesAlong('penpal', { party: 1 }), true);
  assert.equal(ev.bugComesAlong('penpal', { party: 0 }), false);
  assert.equal(ev.bugComesAlong('spring-clean', { trimmed: true }), true);
  assert.equal(ev.bugComesAlong('spring-clean', { trimmed: 'yes' }), false);
  assert.equal(ev.bugComesAlong('low-tide', { habitat: 'shallows' }), true);
  assert.equal(ev.bugComesAlong('nope', { hour: 22 }), false);
});

test('goals count only what they ask for, and only while the event is on', () => {
  const d = at(2026, 10, 25);
  let s = ev.record(null, 'bug-caught', { habitat: 'shallows' }, at(2026, 10, 20)).state;
  assert.deepEqual(s.runs, {}, 'before it starts, nothing counts');
  let r = ev.record(s, 'bug-caught', { habitat: 'shallows' }, d);
  assert.deepEqual(r.moved, ['bugs']);
  r = ev.record(r.state, 'bug-caught', { habitat: 'wreck' }, d);
  assert.deepEqual(r.moved, ['bugs', 'ghost']);
  r = ev.record(r.state, 'find-made', { id: 'pebble' }, d);
  assert.deepEqual(r.moved, [], 'not one of its finds');
  r = ev.record(r.state, 'find-made', { id: 'ghost-lantern', event: 'haunting' }, d);
  r = ev.record(r.state, 'find-made', { id: 'ghost-lantern', event: 'haunting' }, d);
  assert.deepEqual(r.moved, [], 'the same find twice is one of the two');
  const v = ev.view(r.state, d);
  assert.deepEqual(v.active.goals.map(g => [g.id, g.n]), [['bugs', 2], ['ghost', 1], ['wisp', 0], ['finds', 1]]);
});

test('finishing every goal gives the year\'s medal, once', () => {
  const d = at(2026, 10, 30);
  let s = null;
  for (const [e, p] of [['bug-caught', { habitat: 'wreck' }], ['bug-caught', {}], ['bug-caught', {}], ['event-bug', {}],
    ['find-made', { id: 'ghost-lantern', event: 'haunting' }]]) s = ev.record(s, e, p, d).state;
  const r = ev.record(s, 'find-made', { id: 'cursed-doubloon', event: 'haunting' }, d);
  assert.equal(r.finished, true);
  assert.deepEqual(r.state.medals, ['haunting@2026']);
  const again = ev.record(r.state, 'bug-caught', {}, d);
  assert.equal(again.finished, false);
  assert.deepEqual(again.state.medals, ['haunting@2026']);
  const v = ev.view(again.state, d);
  assert.equal(v.active.done, true);
  assert.equal(v.medals[0].name, 'The Haunting 2026');
});

test('it says so on the first day and on the last, once each', () => {
  let r = ev.announce(null, at(2026, 10, 24, 9));
  assert.equal(r.say, 'start');
  r = ev.announce(r.state, at(2026, 10, 26));
  assert.equal(r.say, null);
  r = ev.announce(r.state, at(2026, 11, 1, 10));
  assert.equal(r.say, 'last-call');
  r = ev.announce(r.state, at(2026, 11, 1, 18));
  assert.equal(r.say, null);
  assert.equal(ev.announce(null, at(2026, 6, 1)).say, null);
});

test('the countdown reads like a person would say it', () => {
  const v = ev.view(null, at(2026, 10, 29, 12));
  assert.equal(v.active.left, '3 days left');
  assert.equal(ev.view(null, at(2026, 11, 1, 20)).active.left, 'ends tonight');
  assert.equal(ev.view(null, at(2026, 11, 1, 20)).active.lastDay, true);
  const off = ev.view(null, at(2026, 6, 1));
  assert.equal(off.active, null);
  assert.equal(off.next.id, 'low-tide');
  assert.match(off.next.when, /^starts in \d+ days$/);
});

test('junk on disk or on a card never gets through', () => {
  const s = ev.normalize({ runs: { 'nope@2026': { goals: { a: 9 } }, 'haunting@2026': { goals: { bugs: 1e9, wisp: -4 }, ids: { finds: ['<img>', 'ghost-lantern'] } } }, medals: ['haunting@2026', 'x@1', 7, 'frostbite@20261'] });
  assert.deepEqual(Object.keys(s.runs), ['haunting@2026']);
  assert.deepEqual(s.runs['haunting@2026'].goals, { bugs: 3 });
  assert.deepEqual(s.runs['haunting@2026'].ids, { finds: ['ghost-lantern'] });
  assert.deepEqual(s.medals, ['haunting@2026']);
  assert.deepEqual(ev.cleanMedals(['low-tide@2026', 'low-tide@2026', '../x']), ['low-tide@2026']);
});
