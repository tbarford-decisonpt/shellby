const { test } = require('node:test');
const assert = require('node:assert/strict');
const battle = require('../src/main/bugdex/battle');

const T0 = new Date(2026, 9, 6, 12, 0, 0).getTime();
const S = 1000;
const wild = (over = {}) => ({ species: 'nullfish', rarity: 'common', type: 'runtime', ...over });
const fresh = (opts = {}) => battle.start(wild(opts.enc), { id: 'p|fp', now: T0, ...opts });

test('a wild bug appears at full HP, bosses and the league bigger and stronger', () => {
  const b = fresh();
  assert.equal(b.hp, b.max);
  assert.equal(b.max, battle.HP.common);
  assert.equal(b.moves.length, 1);
  assert.equal(b.moves[0].fx, 'appear');
  const boss = fresh({ boss: true });
  assert.ok(boss.max > b.max && boss.level > b.level);
  const champ = fresh({ league: 'champion', enc: { rarity: 'legendary', type: 'ghost', species: 'heisenbug' } });
  assert.equal(champ.league, 'champion');
  assert.ok(champ.max > battle.HP.legendary);
  assert.equal(fresh({ league: 'nonsense' }).league, null);
});

test('scouting and patching wear it down, but never past the floor before a proven fix', () => {
  let b = fresh();
  for (let i = 0; i < 60; i++) b = battle.act(b, { move: i % 2 ? 'patch' : 'scout', at: T0 + i * 30 * S });
  assert.equal(b.hp, battle.floorOf(b));
  assert.ok(b.hp > 0);
  assert.ok(!b.over);
});

test('scouting chips only so much in all', () => {
  let b = fresh();
  for (let i = 0; i < 30; i++) b = battle.act(b, { move: 'scout', at: T0 + i * 60 * S });
  assert.ok(b.max - b.hp <= Math.ceil(b.max * 0.15) + 1);
  assert.equal(b.moves.at(-1).fx, 'miss'); // studied out
});

test('a run of the same move by the same hand is one move done a few times', () => {
  let b = fresh();
  b = battle.act(b, { move: 'patch', at: T0 + S });
  b = battle.act(b, { move: 'patch', at: T0 + 5 * S });
  b = battle.act(b, { move: 'patch', at: T0 + 9 * S });
  assert.equal(b.moves.length, 2);
  assert.equal(b.moves[1].n, 3);
  b = battle.act(b, { move: 'patch', at: T0 + 120 * S }); // too long after: a new move
  assert.equal(b.moves.length, 3);
});

test('a re-run with fewer failing tests takes HP off in proportion; the right tool is super effective', () => {
  let b = fresh({ failed: 10 });
  b = battle.act(b, { move: 'tests', failed: 8, at: T0 + S });
  const m = b.moves.at(-1);
  assert.equal(m.fx, 'super'); // tests against a runtime bug
  assert.ok(m.dmg > 0);
  const floor = battle.floorOf(b);
  assert.equal(b.hp, Math.round(floor + (b.max - floor) * 0.8));
  b = battle.act(b, { move: 'build', failed: 7, at: T0 + 2 * S });
  assert.equal(b.moves.at(-1).fx, 'hit'); // a build isn't the tool for a runtime bug
});

test('clearing half the failures in one go is a critical hit', () => {
  let b = fresh({ failed: 4 });
  b = battle.act(b, { move: 'run', failed: 1, at: T0 + S });
  assert.equal(b.moves.at(-1).fx, 'crit');
});

test('failing just as before misses, failing worse heals it', () => {
  let b = fresh({ failed: 4 });
  b = battle.act(b, { move: 'tests', failed: 2, at: T0 + S });
  const hp = b.hp;
  b = battle.act(b, { move: 'tests', failed: 2, at: T0 + 2 * S });
  assert.equal(b.moves.at(-1).fx, 'miss');
  assert.equal(b.hp, hp);
  b = battle.act(b, { move: 'tests', failed: 3, at: T0 + 3 * S });
  assert.equal(b.moves.at(-1).fx, 'heal');
  assert.ok(b.hp > hp);
});

test('with no test counts to go on, a failing re-run is a miss', () => {
  let b = fresh();
  b = battle.act(b, { move: 'run', failed: null, at: T0 + S });
  assert.equal(b.moves.at(-1).fx, 'miss');
  assert.equal(b.hp, b.max);
});

test('a helper joins the party; on its specialty it is super effective', () => {
  let b = fresh();
  b = battle.act(b, { move: 'assist', by: { type: 'Explore', name: 'Pinchy', hue: 145 }, at: T0 + S });
  const plain = b.max - b.hp;
  assert.equal(b.moves.at(-1).fx, 'hit');
  assert.equal(b.party[0].name, 'Pinchy');
  b = battle.act(b, { move: 'assist', by: { type: 'code-reviewer', name: 'Clawdia', special: true }, at: T0 + 2 * S });
  assert.equal(b.moves.at(-1).fx, 'super');
  assert.equal(b.max - b.hp - plain, plain * 2);
  assert.deepEqual(b.party.map(p => p.name), ['Clawdia', 'Pinchy']);
  assert.equal(battle.act(b, { move: 'assist', by: null, at: T0 + 3 * S }), b);
});

test('a fix that did not count is not very effective, and gives it some back', () => {
  let b = fresh();
  for (let i = 0; i < 4; i++) b = battle.act(b, { move: 'patch', at: T0 + i * 60 * S });
  const hp = b.hp;
  b = battle.resist(b, { at: T0 + 300 * S, reason: 'skipped' });
  assert.equal(b.moves.at(-1).fx, 'resist');
  assert.equal(b.moves.at(-1).reason, 'skipped');
  assert.ok(b.hp > hp);
});

test('a catch knocks it out, then jars it; nothing moves after', () => {
  let b = fresh({ failed: 3 });
  b = battle.finish(b, { at: T0 + S, outcome: 'caught', jar: { wobbles: 3, isNew: true, forms: ['golden'], badge: 'kelp' } });
  assert.equal(b.over, 'caught');
  assert.deepEqual(b.moves.slice(-2).map(m => m.fx), ['ko', 'caught']);
  assert.equal(b.hp, 0);
  assert.equal(b.moves.at(-1).jar.wobbles, 3);
  assert.equal(b.moves.at(-1).jar.badge, 'kelp');
  assert.equal(battle.act(b, { move: 'patch', at: T0 + 2 * S }), b);
  assert.equal(battle.finish(b, { at: T0 + 3 * S, outcome: 'fled' }), b);
});

test('one that slipped away flees', () => {
  const b = battle.finish(fresh(), { at: T0 + S, outcome: 'fled' });
  assert.equal(b.over, 'fled');
  assert.equal(b.moves.at(-1).fx, 'fled');
});

test('the move list stays short', () => {
  let b = fresh({ failed: 1000 });
  for (let i = 0; i < 200; i++) b = battle.act(b, { move: 'tests', failed: 1000 - i, at: T0 + i * 60 * S });
  assert.equal(b.moves.length, battle.MAX_MOVES);
  assert.equal(b.moves.at(-1).seq, b.seq);
});

test('the view gives every move its line', () => {
  let b = fresh({ failed: 2 });
  b = battle.act(b, { move: 'tests', failed: 1, at: T0 + S });
  b = battle.act(b, { move: 'assist', by: { type: 'Explore', name: 'Pinchy' }, at: T0 + 2 * S });
  b = battle.finish(b, { at: T0 + 3 * S, outcome: 'caught' });
  const v = battle.view(b, 'Nullfish');
  assert.deepEqual(v.moves.map(m => m.line), [
    'A wild Nullfish appeared!',
    'Claude used Test Run! A critical hit!',
    'Pinchy jumped in to help!',
    'The wild Nullfish fainted!',
    'Gotcha! Nullfish was caught!',
  ]);
  assert.match(battle.view(fresh({ boss: true }), 'Knotted Eels').moves[0].line, /habitat boss/);
  assert.equal(battle.view(null), null);
});

test('every type has a super-effective move, and every one of them is a move', () => {
  const { TYPES } = require('../src/main/bugdex/species');
  for (const t of Object.keys(TYPES)) {
    assert.ok(battle.SUPER[t]?.length, t);
    for (const m of battle.SUPER[t]) assert.ok(battle.MOVES[m], m);
  }
});
