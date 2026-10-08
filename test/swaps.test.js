const { test } = require('node:test');
const assert = require('node:assert/strict');
const sw = require('../src/main/swaps');
const gifts = require('../src/main/gifts');
const mail = require('../src/main/github/mail');

const T0 = new Date(2026, 9, 8, 12).getTime();
const DAY = 24 * 3600e3;
const shelf = items => gifts.normalize({ items: Object.fromEntries(Object.entries(items).map(([id, x]) => [id, { first: T0, last: T0, ...x }])) });
const theirs = sw.cleanCardSwap({ offers: ['red-leaf', 'pearl*'], wants: ['pebble'] });

test('a spare copy only: you always keep one of everything', () => {
  assert.equal(gifts.spare(shelf({ pebble: { n: 1 } }), 'pebble'), false);
  assert.equal(gifts.spare(shelf({ pebble: { n: 2 } }), 'pebble'), true);
  assert.equal(gifts.spare(shelf({ pebble: { n: 2, held: 1 } }), 'pebble'), false);
  assert.equal(gifts.spare(shelf({ pebble: { n: 2, shiny: 1 } }), 'pebble', true), true, 'the sparkly can go, the plain one stays');
  assert.equal(gifts.spare(shelf({ pebble: { n: 1, shiny: 1 } }), 'pebble', true), false);
  assert.equal(gifts.spare(shelf({ pebble: { n: 2, shiny: 2 } }), 'pebble', false), false, 'no plain copy to give');
});

test('offering sets your copy aside and writes the letter', () => {
  const finds = shelf({ pebble: { n: 3 } });
  const r = sw.offer(null, finds, { sid: 'aaaa1111', to: 'ana', give: { id: 'pebble' }, get: { id: 'red-leaf' }, theirCard: theirs }, T0);
  assert.equal(r.ok, true);
  assert.equal(r.finds.items.pebble.held, 1);
  assert.equal(r.letter.marker, 'shellby-swap:offer:aaaa1111:give=pebble:get=red-leaf');
  const parsed = mail.parseLetter({ id: 1, user: { login: 'me' }, body: mail.formatLetter(r.letter.marker, 'me', r.letter.words) });
  assert.deepEqual([parsed.act, parsed.give, parsed.get], ['offer', { id: 'pebble', shiny: false }, { id: 'red-leaf', shiny: false }], 'the letter reads back');
});

test('you can\'t offer what isn\'t spare, ask for what they don\'t offer, or flood them', () => {
  const finds = shelf({ pebble: { n: 3 } });
  const base = { sid: 'aaaa1111', to: 'ana', give: { id: 'pebble' }, get: { id: 'red-leaf' }, theirCard: theirs };
  assert.equal(sw.offer(null, shelf({ pebble: { n: 1 } }), base, T0).ok, false);
  assert.equal(sw.offer(null, finds, { ...base, get: { id: 'gold-doubloon' } }, T0).ok, false);
  assert.equal(sw.offer(null, finds, { ...base, give: { id: 'cake-slice' } }, T0).ok, false, 'keepsakes never change hands');
  let s = sw.offer(null, finds, base, T0).swaps;
  assert.equal(sw.offer(s, finds, { ...base, sid: 'bbbb2222' }, T0).ok, false, 'one waiting per friend');
  s = sw.normalize({ ...s, week: { key: Math.floor(T0 / (7 * DAY)), n: sw.WEEK_CAP } });
  assert.equal(sw.offer(s, finds, { ...base, sid: 'cccc3333', to: 'bo' }, T0).ok, false, 'a week\'s cap');
});

test('a swap from start to finish, both sides', () => {
  // Me: pebbles to spare. Ana: red leaves to spare.
  let mine = shelf({ pebble: { n: 3 } });
  let hers = shelf({ 'red-leaf': { n: 2 } });
  const o = sw.offer(null, mine, { sid: 'aaaa1111', to: 'ana', give: { id: 'pebble' }, get: { id: 'red-leaf' }, theirCard: theirs }, T0);
  let mySwaps = o.swaps;
  mine = o.finds;
  // Ana's Shellby reads my letter: an offer from a friend, about something my card offers.
  const letter = { from: 'me', at: T0, ...mail.parseLetter({ id: 1, user: { login: 'me' }, body: mail.formatLetter(o.letter.marker, 'me', o.letter.words) }) };
  const myCard = sw.cleanCardSwap({ offers: ['pebble'] });
  let r = sw.onLetter(null, hers, letter, { friend: true, theirCard: myCard }, T0);
  assert.equal(r.news, 'offer');
  // She says yes: her red leaf goes, my pebble arrives.
  const a = sw.answer(r.swaps, hers, 'aaaa1111', true, T0 + 1000);
  assert.equal(a.ok, true);
  hers = a.finds;
  assert.equal(hers.items['red-leaf'].n, 1);
  assert.equal(hers.items.pebble.n, 1);
  assert.equal(a.letter.marker, 'shellby-swap:accept:aaaa1111');
  // Her answer comes back to me: my pebble goes, her red leaf arrives.
  r = sw.onLetter(mySwaps, mine, { from: 'ana', at: T0 + 2000, act: 'accept', sid: 'aaaa1111' }, { friend: true }, T0 + 2000);
  mySwaps = r.swaps;
  mine = r.finds;
  assert.equal(mine.items.pebble.n, 2);
  assert.equal(mine.items.pebble.held, undefined);
  assert.equal(mine.items['red-leaf'].n, 1);
  assert.equal(r.done.isNew, true);
  assert.equal(mySwaps.out.length, 0);
  assert.equal(mySwaps.done[0].with, 'ana');
});

test('only the friend it went to can answer, and strangers can\'t offer', () => {
  const o = sw.offer(null, shelf({ pebble: { n: 3 } }), { sid: 'aaaa1111', to: 'ana', give: { id: 'pebble' }, get: { id: 'red-leaf' }, theirCard: theirs }, T0);
  const r = sw.onLetter(o.swaps, o.finds, { from: 'mallory', act: 'accept', sid: 'aaaa1111' }, { friend: true }, T0);
  assert.equal(r.done, null);
  assert.equal(r.swaps.out.length, 1);
  const stranger = sw.onLetter(null, shelf({}), { from: 'mallory', act: 'offer', sid: 'aaaa1111', give: { id: 'gold-doubloon', shiny: false }, get: { id: 'pebble', shiny: false } }, { friend: false, theirCard: sw.cleanCardSwap({ offers: ['gold-doubloon'] }) }, T0);
  assert.equal(stranger.news, null);
  const unlisted = sw.onLetter(null, shelf({}), { from: 'ana', act: 'offer', sid: 'aaaa1111', give: { id: 'gold-doubloon', shiny: false }, get: { id: 'pebble', shiny: false } }, { friend: true, theirCard: theirs }, T0);
  assert.equal(unlisted.news, null, 'an offer of something their card doesn\'t list is ignored');
});

test('declined, called off or a week old: your copy comes back', () => {
  const o = sw.offer(null, shelf({ pebble: { n: 3 } }), { sid: 'aaaa1111', to: 'ana', give: { id: 'pebble' }, get: { id: 'red-leaf' }, theirCard: theirs }, T0);
  const d = sw.onLetter(o.swaps, o.finds, { from: 'ana', act: 'decline', sid: 'aaaa1111' }, { friend: true }, T0);
  assert.equal(d.news, 'declined');
  assert.equal(d.finds.items.pebble.held, undefined);
  const c = sw.cancel(o.swaps, o.finds, 'aaaa1111');
  assert.equal(c.finds.items.pebble.held, undefined);
  assert.equal(c.letter.to, 'ana');
  const e = sw.expire(o.swaps, o.finds, T0 + 8 * DAY);
  assert.equal(e.expired, 1);
  assert.equal(e.finds.items.pebble.held, undefined);
});

test('accepting checks you can still spare what they asked for', () => {
  const r = sw.onLetter(null, shelf({ 'red-leaf': { n: 1 } }), { from: 'ana', at: T0, act: 'offer', sid: 'aaaa1111', give: { id: 'pebble', shiny: false }, get: { id: 'red-leaf', shiny: false } }, { friend: true, theirCard: sw.cleanCardSwap({ offers: ['pebble'] }) }, T0);
  const a = sw.answer(r.swaps, shelf({ 'red-leaf': { n: 1 } }), 'aaaa1111', true, T0);
  assert.equal(a.ok, false);
});

test('a sparkly swap moves the sparkle with it', () => {
  const mine = shelf({ pearl: { n: 2, shiny: 1 } });
  const o = sw.offer(null, mine, { sid: 'aaaa1111', to: 'ana', give: { id: 'pearl', shiny: true }, get: { id: 'red-leaf' }, theirCard: theirs }, T0);
  assert.equal(o.ok, true);
  const r = sw.onLetter(o.swaps, o.finds, { from: 'ana', act: 'accept', sid: 'aaaa1111' }, { friend: true }, T0);
  assert.equal(r.finds.items.pearl.n, 1);
  assert.equal(r.finds.items.pearl.shiny, undefined);
});

test('your card\'s lists, and what a swap would finish', () => {
  const lists = gifts.swapLists(shelf({ pebble: { n: 3 }, pearl: { n: 2, shiny: 1 }, 'sea-glass-green': { n: 1 }, 'sea-glass-blue': { n: 1 }, 'sea-glass-amber': { n: 1 } }));
  assert.ok(lists.offers.includes('pebble') && lists.offers.includes('pearl*'));
  assert.ok(!lists.offers.includes('sea-glass-green'));
  assert.equal(lists.wants[0], 'sea-glass-red', 'the set you\'re closest to comes first');
  assert.equal(gifts.finishes(shelf({ 'sea-glass-green': { n: 1 }, 'sea-glass-blue': { n: 1 }, 'sea-glass-amber': { n: 1 } }), 'sea-glass-red'), 'Sea glass rainbow');
  assert.deepEqual(sw.cleanCardSwap({ offers: ['pebble', 'pebble', '<img>', 'cake-slice', 'pearl*'], wants: ['nope', 'pebble'] }), { offers: [{ id: 'pebble', shiny: false }, { id: 'pearl', shiny: true }], wants: ['pebble'] });
});

test('a card cleaned once still reads back the same', () => {
  const card = require('../src/main/github/card');
  const once = card.cleanCard({ swap: { offers: ['pebble', 'pearl*'], wants: ['red-leaf'] } });
  assert.deepEqual(card.cleanCard(once).swap, once.swap);
  assert.deepEqual(once.swap.offers, [{ id: 'pebble', shiny: false }, { id: 'pearl', shiny: true }]);
  assert.notEqual(card.lookOf({ swap: { offers: ['pebble'] } }), card.lookOf({ swap: { offers: [] } }), 'a change to what you swap republishes the card');
});
