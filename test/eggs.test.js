const { test } = require('node:test');
const assert = require('node:assert/strict');
const eggs = require('../src/main/eggs');
const mail = require('../src/main/github/mail');

const T0 = new Date(2026, 9, 8, 12).getTime();
const DAY = 24 * 3600e3;
const ctx = { level: 12, cardOn: true, login: 'crabfan' };

test('laying: Visiting crabs on, level 5, one a week, three waiting at most', () => {
  assert.equal(eggs.lay(null, 'aaaa1111aaaa1111', { ...ctx, cardOn: false }, T0).ok, false);
  assert.equal(eggs.lay(null, 'aaaa1111aaaa1111', { ...ctx, level: 4 }, T0).ok, false);
  let r = eggs.lay(null, 'aaaa1111aaaa1111', ctx, T0);
  assert.equal(r.ok, true);
  assert.equal(r.egg.code, 'EGG-crabfan-aaaa1111aaaa1111');
  assert.equal(r.egg.link, 'shellby://hatch?egg=EGG-crabfan-aaaa1111aaaa1111');
  assert.equal(eggs.lay(r.state, 'bbbb2222bbbb2222', ctx, T0 + DAY).ok, false, 'one a week');
  r = eggs.lay(r.state, 'bbbb2222bbbb2222', ctx, T0 + 7 * DAY);
  r = eggs.lay(r.state, 'cccc3333cccc3333', ctx, T0 + 14 * DAY);
  assert.equal(eggs.lay(r.state, 'dddd4444dddd4444', ctx, T0 + 21 * DAY).ok, false, 'three waiting already');
});

test('a code or a link, pasted any old way', () => {
  assert.deepEqual(eggs.parseCode('EGG-crabfan-aaaa1111aaaa1111'), { from: 'crabfan', egg: 'aaaa1111aaaa1111' });
  assert.deepEqual(eggs.parseCode('  here you go: EGG-Crab-Fan-AAAA1111AAAA1111 !'), { from: 'Crab-Fan', egg: 'aaaa1111aaaa1111' });
  assert.deepEqual(eggs.parseCode('shellby://hatch?egg=EGG-crabfan-aaaa1111aaaa1111'), { from: 'crabfan', egg: 'aaaa1111aaaa1111' });
  assert.equal(eggs.parseCode('EGG-crabfan-short'), null);
  assert.equal(eggs.parseCode('shellby://install?pack=x'), null);
  assert.equal(eggs.parseCode(null), null);
});

test('the card carries a hash of each open egg, never the id', () => {
  const s = eggs.lay(null, 'aaaa1111aaaa1111', ctx, T0).state;
  const card = eggs.forCard(s, 'crabfan');
  assert.equal(card.length, 1);
  assert.ok(!card[0].includes('aaaa1111aaaa1111'));
  assert.equal(card[0], eggs.hashOf('CrabFan', 'aaaa1111aaaa1111'), 'logins are case-blind');
  assert.deepEqual(eggs.cleanCardEggs(['nope', card[0], card[0], 7]), [card[0]]);
});

test('hatching, both sides: the same baby, one hatch per egg, one egg per crab', () => {
  let parent = eggs.lay(null, 'aaaa1111aaaa1111', ctx, T0).state;
  const parentCard = { login: 'crabfan', eggs: eggs.forCard(parent, 'crabfan'), find: 'pearl' };
  const h = eggs.hatch(null, { from: 'crabfan', egg: 'aaaa1111aaaa1111' }, parentCard, 'newbie', T0 + DAY);
  assert.equal(h.ok, true);
  assert.equal(h.gift, 'pearl');
  assert.equal(h.letter.marker, 'shellby-hatch:aaaa1111aaaa1111');
  // The letter reads back on the parent's side.
  const l = mail.parseLetter({ id: 9, user: { login: 'newbie' }, body: mail.formatLetter(h.letter.marker, 'newbie', h.letter.words) });
  const p = eggs.onHatch(parent, l, T0 + DAY);
  assert.equal(p.baby.name, h.baby.name, 'the same baby');
  assert.deepEqual(p.baby.palette, h.baby.palette);
  parent = p.state;
  assert.equal(eggs.forCard(parent, 'crabfan').length, 0, 'off the card once hatched');
  assert.equal(eggs.onHatch(parent, { ...l, from: 'someone-else' }, T0 + 2 * DAY).baby, null, 'the first one to hatch it is the only one');
  assert.equal(eggs.hatch(h.state, { from: 'crabfan', egg: 'bbbb2222bbbb2222' }, parentCard, 'newbie', T0).ok, false, 'one crab, one egg');
});

test('nothing hatches that wasn\'t laid, or isn\'t on the card, or is your own', () => {
  const parent = eggs.lay(null, 'aaaa1111aaaa1111', ctx, T0).state;
  assert.equal(eggs.onHatch(parent, { from: 'x', egg: 'zzzz9999zzzz9999' }, T0).baby, null);
  const card = { login: 'crabfan', eggs: eggs.forCard(parent, 'crabfan') };
  assert.equal(eggs.hatch(null, { from: 'crabfan', egg: 'zzzz9999zzzz9999' }, card, 'newbie', T0).ok, false);
  assert.equal(eggs.hatch(null, { from: 'crabfan', egg: 'aaaa1111aaaa1111' }, { ...card, login: 'mallory' }, 'newbie', T0).ok, false);
  assert.equal(eggs.hatch(null, { from: 'crabfan', egg: 'aaaa1111aaaa1111' }, card, 'CrabFan', T0).ok, false);
});

test('every hatchling is drawable and every egg too', () => {
  for (const id of ['aaaa1111aaaa1111', 'zzzz9999zzzz9999', '0000aaaa0000aaaa', 'q1w2e3r4q1w2e3r4']) {
    for (const a of [eggs.hatchling(id), eggs.eggArt(id)]) {
      const w = a.pixels[0].length;
      for (const row of a.pixels) {
        assert.equal(row.length, w);
        for (const ch of row) assert.ok(ch === '.' || /^#[0-9a-f]{6}$/i.test(a.palette[ch] || ''), `${id} '${ch}' ${a.palette[ch]}`);
      }
    }
    assert.ok(eggs.hatchling(id).name.length <= 12);
  }
});

test('junk on disk never gets through', () => {
  const s = eggs.normalize({ laid: [{ id: '<img>', laidAt: 1 }, { id: 'aaaa1111aaaa1111', laidAt: T0, hatchedBy: '../x' }], clutch: [{ id: 'aaaa1111aaaa1111', with: 'ana', at: T0 }, { id: 'x' }], follower: 'zzzz', pending: { from: 'ana', egg: 'bad' } });
  assert.equal(s.laid.length, 1);
  assert.equal(s.laid[0].hatchedBy, null);
  assert.equal(s.clutch.length, 1);
  assert.equal(s.follower, null);
  assert.equal(s.pending, null);
});

test('egg ids are long and even: 16 characters, none favoured', () => {
  const id = eggs.newEggId();
  assert.match(id, /^[a-z0-9]{16}$/);
  // Bytes 252-255 are thrown back rather than folded onto the first four letters.
  let calls = 0;
  const fixed = n => { calls++; return calls === 1 ? Buffer.alloc(n, 255) : Buffer.alloc(n, 0); };
  assert.equal(eggs.newEggId(fixed), 'a'.repeat(16));
  assert.equal(eggs.parseCode('EGG-crabfan-aaaa1111'), null, 'the short ids of an early build don\'t parse');
});

test('strangers\' swap letters are dropped while reading; hatches from anyone come through, uncapped', async () => {
  const comments = [];
  for (let i = 1; i <= 40; i++) comments.push({ id: i, user: { login: 'spammer' }, created_at: '2026-10-08T10:00:00Z', body: mail.formatLetter('shellby-swap:accept:abcd1234', 'spammer', 'x') });
  comments.push({ id: 41, user: { login: 'newbie' }, created_at: '2026-10-08T10:00:00Z', body: mail.formatLetter('shellby-hatch:aaaa1111aaaa1111', 'newbie', 'x') });
  for (let i = 42; i <= 80; i++) comments.push({ id: i, user: { login: 'spammer' }, created_at: '2026-10-08T10:00:00Z', body: mail.formatLetter('shellby-hatch:zzzz9999zzzz9999', 'spammer', 'x') });
  const gh = { get: async () => comments };
  const r = await mail.checkWaves(gh, 'card', { cursor: { page: 1, seenId: 0 }, friends: ['ana'], me: 'crabfan' });
  assert.ok(!r.letters.some(l => l.kind === 'swap'), 'no swap letters from a stranger');
  assert.ok(r.letters.some(l => l.from === 'newbie' && l.egg === 'aaaa1111aaaa1111'), 'the real hatch is still there');
});
