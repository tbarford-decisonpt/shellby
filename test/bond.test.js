const { test } = require('node:test');
const assert = require('node:assert/strict');
const b = require('../src/main/bond');

const T0 = new Date(2026, 9, 3, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

test('levels climb with points and never come back down', () => {
  assert.equal(b.levelFor(0).name, 'New friends');
  assert.equal(b.levelFor(25).name, 'Pals');
  assert.equal(b.levelFor(24).index, 0);
  assert.equal(b.levelFor(99999).name, 'Inseparable');
  assert.equal(b.levelFor(99999).progress, 1);
  assert.ok(b.levelFor(60).progress > 0 && b.levelFor(60).progress < 1);
  for (let i = 1; i < b.LEVELS.length; i++) assert.ok(b.LEVELS[i].at > b.LEVELS[i - 1].at);
});

test('petting counts up to a daily cap, then stops until tomorrow', () => {
  let s = null;
  let gained = 0;
  for (let i = 0; i < 20; i++) { const r = b.earn(s, 'pet', T0 + i * 1000); s = r.state; gained += r.gained; }
  assert.equal(gained, b.EARN.pet.perDay);
  const tomorrow = b.earn(s, 'pet', T0 + DAY);
  assert.equal(tomorrow.gained, 1);
});

test('each day together counts once, and the milestones get written down', () => {
  let s = b.hatch(null, T0);
  let milestone = null;
  for (let d = 0; d < 7; d++) {
    const r = b.earn(s, 'day', T0 + d * DAY);
    s = r.state;
    milestone = r.milestone || milestone;
    assert.equal(b.earn(s, 'day', T0 + d * DAY + 1000).gained, 0, 'twice in a day counts once');
  }
  assert.equal(s.days, 7);
  assert.equal(milestone, 7);
  assert.ok(s.journal.some(e => e.kind === 'days' && e.data.n === 7));
});

test('a level-up is reported once and goes in the journal', () => {
  const r = b.earn({ points: 24 }, 'play', T0);
  assert.equal(r.levelUp.name, 'Pals');
  assert.ok(r.state.journal.some(e => e.kind === 'level' && e.data.name === 'Pals'));
  const again = b.earn(r.state, 'play', T0 + 1000);
  assert.equal(again.levelUp, null);
});

test('firsts are written once; other moments every time', () => {
  let s = b.remember(null, 'first-pet', T0).state;
  const dup = b.remember(s, 'first-pet', T0 + 1000);
  assert.equal(dup.added, false);
  s = b.remember(s, 'shaken', T0, { app: 'Chrome' }).state;
  s = b.remember(s, 'shaken', T0 + 5, { app: 'Edge' }).state;
  assert.equal(s.journal.filter(e => e.kind === 'shaken').length, 2);
  assert.equal(b.remember(s, 'not-a-thing', T0).added, false);
  const v = b.view(s, T0);
  assert.equal(v.journal[0].text, 'You shook him off Edge');
  assert.ok(v.journal.every(e => e.icon && e.text));
});

test('a full journal lets old moments go but never a first, and never writes one twice', () => {
  let s = b.remember(null, 'first-snack', T0).state;
  s = b.remember(s, 'first-pet', T0 + 1).state;
  for (let i = 0; i < b.JOURNAL_MAX + 20; i++) s = b.remember(s, 'shaken', T0 + 10 + i, { app: 'Chrome' }).state;
  assert.equal(s.journal.filter(e => e.kind === 'shaken').length, b.JOURNAL_MAX);
  const snack = s.journal.find(e => e.kind === 'first-snack');
  assert.equal(snack?.at, T0, 'his first snack keeps its real day');
  assert.equal(b.remember(s, 'first-snack', T0 + 9 * DAY).added, false, 'feeding him again isn’t his first snack');
  assert.equal(s.journal.filter(e => e.kind === 'first-snack').length, 1);
});

test('a first an older journal already lost is still never written twice', () => {
  // A journal saved before firsts were kept: first-snack was trimmed off, then
  // written again with a later date. The oldest copy is kept, and the set remembers it.
  const old = { journal: [{ kind: 'first-snack', at: T0 + 5 * DAY }, { kind: 'shaken', at: T0 + DAY }, { kind: 'first-snack', at: T0 }] };
  const s = b.normalize(old);
  assert.deepEqual(s.journal.filter(e => e.kind === 'first-snack').map(e => e.at), [T0]);
  assert.deepEqual(s.firsts, ['first-snack']);
  // Once it's in the set, it stays there even if the entry is somehow gone.
  const kept = b.normalize({ firsts: ['first-pet', 'shaken', 'nope'], journal: [] });
  assert.deepEqual(kept.firsts, ['first-pet']);
  assert.equal(b.remember(kept, 'first-pet', T0).added, false);
});

test('he moves in once, backdated to when you started if that was earlier', () => {
  const since = T0 - 30 * DAY;
  const s = b.hatch(null, T0, { since });
  assert.equal(s.hatchedAt, since);
  assert.equal(s.journal[0].kind, 'hatched');
  assert.equal(b.hatch(s, T0 + DAY).hatchedAt, since);
});

test('birthdays: set, found on the day, once a year; 29 Feb moves to the 28th', () => {
  let s = b.setBirthday(null, { m: 10, d: 3 });
  assert.deepEqual(s.birthday, { m: 10, d: 3 });
  assert.equal(b.specialDay(s, T0), 'birthday');
  s = b.celebrate(s, 'birthday', T0);
  assert.equal(b.specialDay(s, T0 + 1000), null);
  assert.equal(b.specialDay(s, new Date(2027, 9, 3, 9).getTime()), 'birthday');
  assert.equal(b.setBirthday(s, { m: 2, d: 30 }).birthday.d, 3, 'an impossible date is ignored');
  const leap = b.setBirthday(null, { m: 2, d: 29 });
  assert.equal(b.specialDay(leap, new Date(2027, 1, 28, 9).getTime()), 'birthday');
  assert.equal(b.specialDay(leap, new Date(2028, 1, 28, 9).getTime()), null);
  assert.equal(b.specialDay(leap, new Date(2028, 1, 29, 9).getTime()), 'birthday');
  assert.equal(b.setBirthday(s, null).birthday, null);
});

test('hatch day comes round a year after he moved in', () => {
  const s = b.hatch(null, new Date(2025, 9, 3, 9).getTime());
  assert.equal(b.specialDay(s, new Date(2025, 9, 3, 18).getTime()), null, 'not on the day itself');
  assert.equal(b.specialDay(s, T0), 'hatchday');
  const done = b.celebrate(s, 'hatchday', T0);
  assert.equal(done.journal[0].data.years, 1);
  assert.equal(b.celebrationLine('hatchday', { years: 1 }), 'happy hatch day!');
  assert.equal(b.celebrationLine('hatchday', { years: 3 }), '3 years together!');
  assert.equal(b.celebrationLine('days', { days: 100 }), '100 days together!');
});

test('memories come back once they are a couple of days old, and fit the bubble', () => {
  let s = { points: 30 };
  s = b.remember(s, 'shaken', T0, { app: 'Chrome' }).state;
  assert.equal(b.recall(s, T0 + DAY, () => 0), null, 'too fresh');
  const r = b.recall(s, T0 + 3 * DAY, () => 0);
  assert.equal(r.text, 'remember Chrome?');
  // Not the same one again straight away.
  const again = b.recall(r.state, T0 + 3 * DAY, () => 0);
  assert.equal(again, null);
  for (const text of ['remember Chrome?']) assert.ok(text.length <= 24);
});

test('a new friendship has nothing to remember yet', () => {
  const s = b.remember({ points: 0 }, 'shaken', T0, { app: 'Chrome' }).state;
  assert.equal(b.recall(s, T0 + 10 * DAY, () => 0), null);
});

test('lines that would overflow the bubble are skipped', () => {
  const s = b.remember({ points: 30 }, 'visitor', T0, { login: 'a-very-long-github-login-name' }).state;
  const r = b.recall(s, T0 + 3 * DAY, () => 0);
  assert.ok(r.text.length <= 24);
  assert.equal(r.text, "when's the next visit?");
});

test('the Us page shows unlocks against the current level', () => {
  const v = b.view({ points: 120, days: 12 }, T0);
  assert.equal(v.level.name, 'Buddies');
  assert.deepEqual(v.unlocks.map(u => u.open), [true, true, false, false, false]);
  assert.equal(v.nextMilestone, 30);
});

test('junk from disk is tolerated', () => {
  const s = b.normalize({ points: -5, level: 99, journal: [{ kind: 'nope', at: 1 }, { kind: 'shaken', at: T0, data: { app: 'X'.repeat(200), f: () => 1 } }], birthday: { m: 13, d: 1 } });
  assert.equal(s.points, 0);
  assert.equal(s.level, b.LEVELS.length - 1);
  assert.equal(s.journal.length, 1);
  assert.equal(s.journal[0].data.app.length, 40);
  assert.equal(s.birthday, null);
});
