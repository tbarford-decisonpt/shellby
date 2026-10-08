const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const art = require('../src/main/stickers/art');
const { shellMask, stickerSlots, STICKER } = require('../src/main/stickers/slots');
const st = require('../src/main/stickers');
const { SHELLS } = require('../src/main/shells');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0 = new Date(2026, 3, 14, 13, 0, 0).getTime(); // a Tuesday afternoon
const ID = (n = 1) => String(n).padStart(12, 'a').slice(-12).replace(/[^0-9a-f]/g, 'a');
const proj = (n = 1, extra = {}) => ({ id: ID(n), name: `repo-${n}`, remote: `github.com/me/repo-${n}`, root: `C:\\code\\repo-${n}`, lang: 'JavaScript', ...extra });

// Every skin he can wear: the built-ins and the ones in the built-in packs.
const SKINS = [
  ...fs.readdirSync(path.join(__dirname, '..', 'src', 'skins')).map(f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'skins', f), 'utf8'))),
  ...fs.readdirSync(path.join(__dirname, '..', 'src', 'wardrobe')).filter(f => f.endsWith('.json'))
    .flatMap(f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'wardrobe', f), 'utf8')).skins || []),
];

// ------------------------------------------------------------------ art

const everyCellPainted = d => {
  for (const size of ['full', 'small', 'micro']) {
    for (const row of d[size].pixels) for (const ch of row) assert.ok(ch === '.' || d[size].palette[ch], `${size}: '${ch}' has a colour`);
  }
};

test('a project always gets the same sticker, and different projects differ', () => {
  const a = art.draw(proj(1)), b = art.draw(proj(1)), c = art.draw(proj(2));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.full, c.full);
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(art.draw({ id: `${i}`.padStart(12, '0'), name: 'x', lang: null }).full.pixels.join(''));
  assert.ok(seen.size > 50, `60 projects drew only ${seen.size} different stickers`);
});

test('stickers come in three sizes, every pixel coloured, monogram and die-cut included', () => {
  for (let i = 0; i < 40; i++) {
    const d = art.draw({ id: `${i}`.padStart(12, 'f'), name: i % 2 ? 'shellby' : '3d-rack', lang: i % 3 ? 'TypeScript' : null });
    assert.equal(d.full.pixels.length, 16);
    assert.ok(d.full.pixels.every(r => r.length === 16));
    assert.equal(d.small.pixels.length, 7);
    assert.deepEqual(d.micro.pixels.map(r => r.length), [3, 3, 3]);
    assert.ok(!d.micro.pixels.join('').includes('.'), 'the micro sticker has no holes');
    assert.ok(d.full.pixels.join('').includes('g'), 'the monogram is drawn');
    assert.ok(d.full.pixels.join('').includes('w'), 'the die-cut border is drawn');
    everyCellPainted(d);
  }
});

test('the monogram is the first letter or digit, and the language picks the colour', () => {
  assert.equal(art.monogram('shellby'), 'S');
  assert.equal(art.monogram('3d-rack'), '3');
  assert.equal(art.monogram('.dotfiles'), 'D');
  assert.equal(art.monogram('—'), '*');
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789*') {
    assert.equal(art.FONT[ch].length, 5, ch);
    assert.ok(art.FONT[ch].every(r => r.length === 5), ch);
  }
  assert.equal(art.languageOf(['a.ts', 'b.ts', 'c.js', 'README.md', 'x.tsx']), 'TypeScript');
  assert.equal(art.languageOf(['README.md', 'data.json']), null);
  assert.equal(art.languageOf(null), null);
});

test('a repo can bring its own sticker', () => {
  const custom = st.cleanCustom({ palette: { a: '#ff0000', b: '#00ff00' }, pixels: ['aab', 'abb', 'bbb', 'ab'] });
  assert.ok(custom);
  const d = art.draw({ id: ID(), name: 'x', custom });
  assert.equal(d.shape, 'custom');
  assert.deepEqual(d.full.pixels, ['aab', 'abb', 'bbb', 'ab']);
  assert.ok(!d.micro.pixels.join('').includes('.'));
  everyCellPainted(d);
});

test('custom stickers are checked strictly', () => {
  assert.equal(st.cleanCustom(null), null);
  assert.equal(st.cleanCustom({ palette: { a: 'red' }, pixels: ['a'] }), null);
  assert.equal(st.cleanCustom({ palette: { a: '#ff0000' }, pixels: ['ab'] }), null, 'unknown colour key');
  assert.equal(st.cleanCustom({ palette: { a: '#ff0000' }, pixels: Array(17).fill('a') }), null, 'too tall');
  assert.equal(st.cleanCustom({ palette: { a: '#ff0000' }, pixels: ['a'], micro: ['a.a', 'aaa', 'aaa'] }), null, 'holes in micro');
  const proto = st.cleanCustom(JSON.parse('{"palette":{"__proto__":"#ffffff","a":"#000000"},"pixels":["a"]}'));
  assert.ok(proto);
  assert.equal(({}).polluted, undefined);
});

test('finishes and weather change what sits on the shell', () => {
  const d = art.draw(proj(3));
  const paper = art.onShell(d);
  assert.deepEqual(paper.pixels, d.micro.pixels);
  const foil = art.onShell(d, { tier: 'foil' });
  assert.ok(foil.pixels.join('').includes('y'));
  const peel = art.onShell(d, { weather: 'peeling' });
  assert.equal(peel.pixels[0][2], 'p');
  const faded = art.onShell(d, { weather: 'faded' });
  assert.notEqual(faded.palette.m, d.micro.palette.m);
  const flipped = art.onShell({ micro: { palette: d.micro.palette, pixels: ['abc', 'def', 'ghi'] } }, { flip: true });
  assert.deepEqual(flipped.pixels, ['cba', 'fed', 'ihg']);
});

// ------------------------------------------------------------------ slots

test('every shell has room for stickers on every skin, and they only cover shell', () => {
  assert.ok(SKINS.length >= 10);
  for (const skin of SKINS) {
    const homes = [null, ...SHELLS];
    for (const home of homes) {
      const label = `${skin.id} in ${home ? home.id : 'his own shell'}`;
      const mask = shellMask(skin, home);
      const slots = stickerSlots(mask);
      assert.ok(slots.length >= 3, `${label}: only ${slots.length} spots`);
      slots.forEach(([x, y], i) => {
        for (let dy = 0; dy < STICKER; dy++) for (let dx = 0; dx < STICKER; dx++) assert.ok(mask[y + dy]?.[x + dx], `${label}: spot ${i} hangs off the shell`);
        slots.slice(0, i).forEach(([ox, oy]) => assert.ok(Math.max(Math.abs(ox - x), Math.abs(oy - y)) >= STICKER, `${label}: spots ${i} overlap`));
      });
    }
  }
});

test('a shell with no room has no spots', () => {
  assert.deepEqual(stickerSlots([[true, true], [true, true]]), []);
  assert.deepEqual(stickerSlots([]), []);
});

// ------------------------------------------------------------------ identity

test('remotes in any spelling are the same project', () => {
  const one = 'github.com/x-salmon/shellby';
  for (const u of [
    'git@github.com:x-salmon/shellby.git', 'https://github.com/x-salmon/shellby', 'https://github.com/X-Salmon/Shellby.git/',
    'https://user:tok3n@github.com/x-salmon/shellby.git', 'ssh://git@github.com:22/x-salmon/shellby.git', 'git://github.com/x-salmon/shellby',
  ]) assert.equal(st.normalizeRemote(u), one, u);
  for (const u of ['C:\\repos\\x.git', '/srv/x.git', 'file:///srv/x.git', '', null, 'https://github.com/', 'https://localhost/../x']) assert.equal(st.normalizeRemote(u), null, String(u));
  assert.equal(st.projectId(one, 'C:\\a'), st.projectId(one, 'D:\\b'));
  assert.notEqual(st.projectId(null, 'C:\\a'), st.projectId(null, 'C:\\b'));
  assert.equal(st.projectId(null, 'C:\\A'), st.projectId(null, 'c:\\a'));
  assert.match(st.projectId(one), /^[0-9a-f]{12}$/);
});

// ------------------------------------------------------------------ shipping

test('the first ship mints a sticker and puts it on his shell', () => {
  const r = st.recordShip(null, proj(1), 'ship', T0, {}, { shell: 'home', slots: 5 });
  assert.equal(r.minted, true);
  assert.equal(r.counted, true);
  assert.equal(r.tierUp, null);
  assert.equal(r.project.ships, 1);
  assert.deepEqual(r.state.unseen, [ID(1)]);
  assert.deepEqual(r.state.layouts.home, [{ id: ID(1), slot: 0, z: 1, flip: false, nudge: [0, 0] }]);
  const off = st.recordShip(st.setOptions(null, { auto: false }), proj(1), 'ship', T0, {}, { shell: 'home', slots: 5 });
  assert.equal(off.minted, true);
  assert.equal(off.state.layouts.home, undefined);
});

test('pushing over and over within an hour counts once', () => {
  let s = st.recordShip(null, proj(1), 'ship', T0).state;
  const again = st.recordShip(s, proj(1), 'ship', T0 + 10 * 60 * 1000);
  assert.equal(again.counted, false);
  assert.equal(again.project.ships, 1);
  assert.equal(again.minted, false);
  s = st.recordShip(again.state, proj(1), 'ship', T0 + HOUR + 1).state;
  assert.equal(s.projects[ID(1)].ships, 2);
});

test('a new release or a merged pull request counts even right after a push', () => {
  let r = st.recordShip(null, proj(1), 'ship', T0);
  r = st.recordShip(r.state, proj(1), 'release', T0 + 60 * 1000, { version: '1.0.0' });
  assert.equal(r.counted, true);
  assert.equal(r.project.ships, 3);
  r = st.recordShip(r.state, proj(1), 'release', T0 + 2 * 60 * 1000, { version: '1.0.0' });
  assert.equal(r.counted, false, 'the same version again does not');
  r = st.recordShip(r.state, proj(1), 'release', T0 + 3 * 60 * 1000);
  assert.equal(r.counted, false, 'nor does a release that does not say which');
  r = st.recordShip(r.state, proj(1), 'merge', T0 + 4 * 60 * 1000);
  assert.equal(r.counted, true);
  assert.equal(r.project.ships, 4);
});

test('tiers climb with shipping and report the tier-up once', () => {
  let s = null;
  const ups = [];
  for (let i = 0; i < 45; i++) {
    const r = st.recordShip(s, proj(1), 'ship', T0 + i * 2 * HOUR);
    if (r.tierUp) ups.push([i + 1, r.tierUp.id]);
    s = r.state;
  }
  assert.deepEqual(ups, [[5, 'vinyl'], [15, 'holo'], [40, 'foil']]);
  assert.equal(st.nextTier(40), null);
  assert.deepEqual(st.nextTier(3), { id: 'vinyl', name: 'Vinyl', ships: 5, left: 2 });
});

test('deploys, releases and merges count double or add marks', () => {
  let r = st.recordShip(null, proj(1), 'deploy', T0);
  assert.equal(r.project.ships, 2);
  assert.deepEqual(r.newMarks, ['live']);
  r = st.recordShip(r.state, proj(1), 'release', T0 + 2 * HOUR, { version: '1.0.0' });
  assert.deepEqual(r.newMarks, ['release', 'v1']);
  assert.equal(r.project.lastVersion, '1.0.0');
  r = st.recordShip(r.state, proj(1), 'release', T0 + 4 * HOUR, { version: '0.9.0' });
  assert.deepEqual(r.newMarks, []);
  r = st.recordShip(r.state, proj(1), 'merge', T0 + 6 * HOUR, { fixed: true });
  assert.deepEqual(r.newMarks, ['merged', 'green']);
  assert.deepEqual([r.project.deploys, r.project.releases, r.project.merges], [1, 2, 1]);
});

test('night ships and Friday deploys earn their secret marks', () => {
  const night = new Date(2026, 3, 14, 2, 30).getTime();
  assert.deepEqual(st.recordShip(null, proj(1), 'ship', night).newMarks, ['moon']);
  const friday = new Date(2026, 3, 17, 16, 0).getTime();
  assert.deepEqual(st.recordShip(null, proj(1), 'deploy', friday).newMarks, ['live', 'friday']);
  assert.deepEqual(st.recordShip(null, proj(1), 'ship', friday).newMarks, []);
});

test('bad input changes nothing', () => {
  const s = st.recordShip(null, proj(1), 'ship', T0).state;
  for (const [p, k] of [[null, 'ship'], [{ id: 'nope' }, 'ship'], [proj(2), 'yeet']]) {
    const r = st.recordShip(s, p, k, T0);
    assert.equal(r.minted, false);
    assert.deepEqual(r.state, st.normalize(s));
  }
});

test('stickers peel after two months and fade after six; anniversaries count years', () => {
  const p = { lastShipAt: T0, firstShipAt: T0 };
  assert.equal(st.weathering(p, T0 + 59 * DAY), 'fresh');
  assert.equal(st.weathering(p, T0 + 61 * DAY), 'peeling');
  assert.equal(st.weathering(p, T0 + 181 * DAY), 'faded');
  assert.equal(st.yearsOf(p, T0 + 364 * DAY), 0);
  assert.equal(st.yearsOf(p, new Date(2028, 3, 14, 12).getTime()), 2);
});

test('releases are read from the commands that make them', () => {
  assert.deepEqual(st.releaseOf('gh release create v1.2.0 --notes x'), { version: '1.2.0' });
  assert.deepEqual(st.releaseOf('gh release create 0.3.1'), { version: '0.3.1' });
  assert.deepEqual(st.releaseOf('git push origin v0.41.0'), { version: '0.41.0' });
  assert.deepEqual(st.releaseOf('git push origin refs/tags/v2.0.0-beta.1'), { version: '2.0.0-beta.1' });
  assert.deepEqual(st.releaseOf('git push --follow-tags'), { version: null });
  assert.deepEqual(st.releaseOf('npm publish'), { version: null });
  assert.deepEqual(st.releaseOf('cargo publish'), { version: null });
  assert.equal(st.releaseOf('git push origin main'), null);
  assert.equal(st.releaseOf('npm publish --dry-run'), null);
  assert.equal(st.releaseOf('gh release create v1.0.0 --draft'), null);
  assert.equal(st.releaseOf(42), null);
  assert.equal(st.isOnePointOh('1.0.0'), true);
  assert.equal(st.isOnePointOh('1.0.0-rc.1'), false);
  assert.equal(st.isOnePointOh('0.99.0'), false);
});

// ------------------------------------------------------------------ the shell

function shipMany(n, slots = 3) {
  let s = null;
  for (let i = 1; i <= n; i++) s = st.recordShip(s, proj(i), 'ship', T0 + i, {}, { shell: 'home', slots }).state;
  return s;
}

test('once every spot is taken, new stickers go on top, a pixel off', () => {
  const s = shipMany(5, 3);
  const l = s.layouts.home;
  assert.deepEqual(l.map(e => e.slot), [0, 1, 2, 0, 1]);
  assert.deepEqual(l.map(e => e.nudge), [[0, 0], [0, 0], [0, 0], [1, 1], [1, 1]]);
  assert.deepEqual(l.map(e => e.z), [1, 2, 3, 4, 5]);
});

test('placing, peeling, restacking and flipping', () => {
  let s = shipMany(3, 3);
  s = st.place(s, 'home', ID(1), 2, T0);
  const l = s.layouts.home;
  assert.equal(l.find(e => e.id === ID(1)).slot, 2);
  assert.deepEqual(l.find(e => e.id === ID(1)).nudge, [1, 1], 'stacked on the one already there');
  assert.equal(l[l.length - 1].id, ID(1), 'on top');
  s = st.restack(s, 'home', ID(1), 'down', T0);
  assert.equal(s.layouts.home[0].id, ID(1));
  s = st.flip(s, 'home', ID(2), T0);
  assert.equal(s.layouts.home.find(e => e.id === ID(2)).flip, true);
  s = st.remove(s, 'home', ID(2), T0);
  assert.ok(!s.layouts.home.some(e => e.id === ID(2)));
  assert.ok(s.projects[ID(2)], 'peeling it off keeps it in the book');
  assert.equal(s.layoutsAt, T0);
  assert.deepEqual(st.place(s, 'home', ID(9), 0, T0), st.normalize(s), 'unknown sticker');
  assert.deepEqual(st.place(s, 'BAD shell', ID(1), 0, T0), st.normalize(s));
});

test('arrange puts the most shipped in the middle and on top', () => {
  let s = shipMany(4, 3);
  for (let i = 0; i < 3; i++) s = st.recordShip(s, proj(3), 'ship', T0 + (i + 1) * 2 * HOUR).state;
  s = st.arrange(s, 'home', 3, T0);
  const l = s.layouts.home;
  const top = l[l.length - 1];
  assert.equal(top.id, ID(3));
  assert.equal(top.slot, 0);
  const bare = st.arrange(st.remove(st.remove(st.remove(st.remove(s, 'home', ID(1)), 'home', ID(2)), 'home', ID(3)), 'home', ID(4)), 'snail', 3, T0);
  assert.equal(bare.layouts.snail.length, 4, 'a bare shell is filled with the most shipped');
});

test('molting carries the three most shipped and leaves the rest on the old shell', () => {
  let s = shipMany(5, 5);
  for (let i = 0; i < 4; i++) s = st.recordShip(s, proj(5), 'ship', T0 + (i + 1) * 2 * HOUR).state;
  for (let i = 0; i < 2; i++) s = st.recordShip(s, proj(2), 'ship', T0 + (i + 1) * 2 * HOUR).state;
  const m = st.carryOnMolt(s, 'home', 'snail', 5, T0);
  assert.deepEqual(m.layouts.snail.map(e => e.id).sort(), [ID(5), ID(2), m.layouts.snail.find(e => ![ID(5), ID(2)].includes(e.id)).id].sort());
  assert.equal(m.layouts.snail.length, 3);
  assert.equal(m.layouts.home.length, 5, 'the old shell keeps all of its stickers');
  const again = st.carryOnMolt(st.remove(m, 'snail', ID(5)), 'home', 'snail', 5, T0);
  assert.equal(again.layouts.snail.length, 2, "a shell that already has stickers isn't redone");
});

test('normalize tolerates junk', () => {
  const s = st.normalize({
    projects: { [ID(1)]: { firstShipAt: T0, ships: -4, name: 'x\u0007y', marks: ['live', 'bogus', 'live'], remote: 'git@github.com:A/B.git' }, nope: { firstShipAt: T0 }, [ID(2)]: { ships: 3 } },
    layouts: { home: [{ id: ID(1), slot: 0 }, { id: ID(1), slot: 1 }, { id: ID(2), slot: 0 }], 'BAD!': [{ id: ID(1), slot: 0 }] },
    card: 'everyone', unseen: [ID(1), ID(3)], auto: 0,
  });
  assert.deepEqual(Object.keys(s.projects), [ID(1)]);
  assert.equal(s.projects[ID(1)].ships, 1);
  assert.equal(s.projects[ID(1)].name, 'x y');
  assert.deepEqual(s.projects[ID(1)].marks, ['live']);
  assert.equal(s.projects[ID(1)].remote, 'github.com/a/b');
  assert.deepEqual(Object.keys(s.layouts), ['home']);
  assert.equal(s.layouts.home.length, 1);
  assert.equal(s.card, 'off', 'nothing goes on the public card until you choose');
  assert.equal(s.auto, false);
  assert.deepEqual(s.unseen, [ID(1)]);
  assert.deepEqual(st.normalize('junk').projects, {});
});

test('the view lists newest first with tiers, marks and badges', () => {
  let s = shipMany(2, 3);
  s = st.recordShip(s, proj(1), 'deploy', T0 + 2 * HOUR).state;
  const v = st.view(s, T0 + 3 * HOUR);
  assert.deepEqual(v.projects.map(p => p.id), [ID(1), ID(2)]);
  assert.equal(v.projects[0].tierName, 'Paper');
  assert.deepEqual(v.projects[0].marks.map(m => m.id), ['live']);
  assert.equal(v.projects[0].isNew, true);
  assert.deepEqual(v.projects[0].shells, ['home']);
  assert.equal(v.totals.projects, 2);
  assert.equal(v.totals.ships, 4);
  assert.equal(st.view(st.markSeen(s, [ID(1)]), T0).projects.find(p => p.id === ID(1)).isNew, false);
  assert.deepEqual(st.stats(s), { stickers: 2, holo: 0, onePointOh: 0, shells: 1, guests: 0 });
});

// ------------------------------------------------------------------ calling cards and swaps

test('the calling card shows nothing until asked, then colours only, then names', () => {
  let s = shipMany(3, 3);
  assert.equal(st.forCard(s, 'home', T0), null, 'off until you choose');
  s = st.setOptions(st.setHidden(s, ID(2), true, T0), { card: 'art' });
  const art = st.forCard(s, 'home', T0);
  assert.equal(art.shell.length, 2, 'a hidden project stays off the card');
  assert.deepEqual(art.trade, []);
  assert.ok(art.shell.every(e => e.pixels.length === 3 && e.pixels.every(r => r.length === 3)), 'just the 3x3 patches');
  const text = JSON.stringify(art);
  assert.ok(!text.includes('repo-'), 'no names');
  assert.ok(!text.includes('github.com'), 'no remotes');
  const names = st.forCard(st.setOptions(s, { card: 'names' }), 'home', T0);
  assert.deepEqual(names.trade.map(t => t.name).sort(), ['repo-1', 'repo-3']);
  assert.equal(names.trade[0].pixels.length, 16);
  assert.equal(st.forCard(st.setOptions(s, { card: 'off' }), 'home', T0), null);
});

test("a friend's card stickers are cleaned before use", () => {
  const ok = { slot: 1, nudge: [1, 0], tier: 'holo', palette: { a: '#112233' }, pixels: ['aaa', 'aaa', 'aaa'] };
  const c = st.cleanCardStickers({
    shell: [ok, { ...ok, slot: -1 }, { ...ok, pixels: ['aa', 'aaa', 'aaa'] }, { ...ok, palette: { a: 'javascript:' } }, { ...ok, tier: 'mythic', nudge: [5, 5] }, null],
    trade: [{ name: 'reef', tier: 'foil', palette: { a: '#ffffff' }, pixels: ['a'] }, { name: '', palette: { a: '#ffffff' }, pixels: ['a'] }, { name: 'x', palette: {}, pixels: ['a'] }],
  });
  assert.equal(c.shell.length, 2);
  assert.deepEqual(c.shell[1].nudge, [0, 0]);
  assert.equal(c.shell[1].tier, 'paper');
  assert.deepEqual(c.trade.map(t => t.name), ['reef']);
  assert.equal(st.cleanCardStickers('nope'), null);
  assert.deepEqual(st.cleanCardStickers({ shell: Array(99).fill(ok) }).shell.length, st.MAX_PLACED);
});

test('a visit leaves the same sticker all day, and it goes in the book as theirs', () => {
  const trade = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  assert.equal(st.pickTrade(trade, 'Pal', T0), st.pickTrade(trade, 'pal', T0 + HOUR));
  assert.equal(st.pickTrade([], 'pal', T0), null);
  const gift = { name: 'reef', tier: 'holo', palette: { a: '#ff0000', b: '#00ff00' }, pixels: ['ab', 'ba'] };
  const r = st.receiveGuest(null, 'pal', gift, T0);
  assert.equal(r.fresh, true);
  assert.equal(r.project.from, 'pal');
  assert.equal(st.tierFor(r.project.ships).id, 'holo');
  assert.deepEqual(r.state.layouts, {}, 'not stuck on the shell without asking');
  assert.deepEqual(r.state.unseen, [r.project.id]);
  assert.equal(st.weathering(r.project, T0 + 400 * DAY), 'fresh', "a friend's sticker never peels");
  const again = st.receiveGuest(r.state, 'pal', { ...gift, tier: 'paper' }, T0 + DAY);
  assert.equal(again.fresh, false);
  assert.equal(st.tierFor(again.project.ships).id, 'holo', 'keeps the best tier it came with');
  assert.equal(st.stats(again.state).guests, 1);
  assert.equal(st.stats(again.state).stickers, 0, 'gifts are not your own shipping');
  assert.equal(st.view(again.state, T0).projects[0].canOpen, false);
  assert.equal(st.receiveGuest(null, 'not a login!', gift, T0).project, null);
  assert.equal(st.receiveGuest(null, 'pal', { ...gift, palette: { a: 'red' } }, T0).project, null);
  const custom = st.normalize(r.state).projects[r.project.id].custom;
  assert.ok(custom && custom.pixels.length === 2, 'its drawing comes with it');
});

test('sync keeps every PC’s progress and drops local folders', () => {
  const a = shipMany(2, 3);
  let b = st.recordShip(null, proj(2), 'deploy', T0 - DAY).state;
  b = st.recordShip(b, proj(7), 'ship', T0 + DAY).state;
  b = st.arrange(b, 'snail', 3, T0 + 2 * DAY);
  const up = st.syncable(b);
  assert.ok(Object.values(up.projects).every(p => p.root === null));
  assert.equal(up.unseen, undefined);
  const m = st.merge(a, up);
  assert.deepEqual(Object.keys(m.projects).sort(), [ID(1), ID(2), ID(7)].sort());
  assert.equal(m.projects[ID(2)].firstShipAt, T0 - DAY, 'the earliest first ship');
  assert.equal(m.projects[ID(2)].ships, 2);
  assert.deepEqual(m.projects[ID(2)].marks, ['live']);
  assert.equal(m.projects[ID(2)].root, 'C:\\code\\repo-2', 'this PC keeps its own folder');
  assert.equal(m.projects[ID(7)].root, null);
  assert.ok(m.layouts.snail, 'the newer layouts win');
  assert.deepEqual(st.merge(m, st.syncable(m)), m, 'merging is stable');
});

// ------------------------------------------------------------------ the repo itself (real git)

test('a worktree counts as the repository it came from, and the remote names the project', async () => {
  const { execFileSync } = require('child_process');
  const os = require('os');
  const gitinfo = require('../src/main/gitinfo');
  // .native expands 8.3 short names (CI's temp is C:\Users\RUNNER~1\...), so the
  // folder matches the long path git reports and the path-based ids agree.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-st-')));
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  try {
    const dir = path.join(base, 'my-folder');
    fs.mkdirSync(path.join(dir, '.shellby'), { recursive: true });
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, 'config', 'user.email', 't@example.com');
    g(dir, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(dir, 'a.py'), 'x\n');
    fs.writeFileSync(path.join(dir, 'b.py'), 'x\n');
    fs.writeFileSync(path.join(dir, 'c.js'), 'x\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-qm', 'init');

    const local = await gitinfo.projectOf(path.join(dir));
    assert.equal(local.name, 'my-folder');
    assert.equal(local.remote, null);
    assert.equal(local.id, st.projectId(null, dir));

    const copy = path.join(base, 'copy');
    g(dir, 'worktree', 'add', '-q', '-b', 'shellby/x-abc123', copy);
    assert.equal((await gitinfo.projectOf(copy)).id, local.id, 'the copy is the same project');

    g(dir, 'remote', 'add', 'origin', 'git@github.com:Me/Real-Name.git');
    const hosted = await gitinfo.projectOf(copy);
    assert.equal(hosted.name, 'real-name');
    assert.equal(hosted.remote, 'github.com/me/real-name');
    assert.equal(path.resolve(hosted.root), path.resolve(dir));

    assert.equal(art.languageOf(await gitinfo.trackedFiles(dir)), 'Python');
    assert.equal(await gitinfo.stickerFile(dir), null);
    fs.writeFileSync(path.join(dir, '.shellby', 'sticker.json'), JSON.stringify({ palette: { a: '#ff0000' }, pixels: ['a'] }));
    assert.deepEqual(await gitinfo.stickerFile(dir), { palette: { a: '#ff0000' }, pixels: ['a'] });
    fs.writeFileSync(path.join(dir, '.shellby', 'sticker.json'), 'x'.repeat(20000));
    assert.equal(await gitinfo.stickerFile(dir), null, 'too big');
    assert.equal(await gitinfo.projectOf(base), null, 'not a repo');
    assert.equal(await gitinfo.projectOf('relative/path'), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a repo’s own sticker survives being saved and read back', () => {
  const custom = st.cleanCustom({ palette: { a: '#ff0000' }, pixels: ['aa', 'aa'] });
  const s = st.recordShip(null, proj(1, { custom }), 'ship', T0).state;
  const again = st.normalize(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(again.projects[ID(1)].custom, custom);
});

// ------------------------------------------------------------------ review fixes

test('hiding a project syncs, and the latest change wins', () => {
  const a = st.setHidden(shipMany(1, 3), ID(1), true, T0 + 10);
  const b = st.syncable(shipMany(1, 3));
  assert.equal(st.merge(a, b).projects[ID(1)].hidden, true, 'a PC that never hid it does not unhide it');
  assert.equal(st.merge(b, st.syncable(a)).projects[ID(1)].hidden, true, 'and the other PC picks it up');
  const shown = st.setHidden(a, ID(1), false, T0 + 20);
  assert.equal(st.merge(a, st.syncable(shown)).projects[ID(1)].hidden, false, 'showing it again later wins too');
});

test("friends' gifts are capped, and go before your own projects when the book is full", () => {
  const gift = n => ({ name: `g${n}`, tier: 'foil', palette: { a: '#ff0000' }, pixels: ['a'] });
  let s = null;
  for (let i = 0; i < 6; i++) s = st.receiveGuest(s, 'pal', gift(i), T0 + i).state;
  assert.equal(Object.values(s.projects).filter(p => p.from === 'pal').length, st.MAX_GUESTS_EACH);
  for (let f = 0; f < 15; f++) for (let i = 0; i < 3; i++) s = st.receiveGuest(s, `pal${f}`, gift(i), T0 + f * 10 + i).state;
  assert.equal(Object.values(s.projects).filter(p => p.from).length, st.MAX_GUESTS);
  // Fill the book with your own, one past the cap: a gift goes, not one of yours.
  for (let i = 0; i < st.MAX_PROJECTS - st.MAX_GUESTS + 1; i++) s = st.recordShip(s, { id: i.toString(16).padStart(12, '0'), name: `own-${i}` }, 'ship', T0).state;
  const own = Object.values(s.projects).filter(p => !p.from).length;
  assert.equal(own, st.MAX_PROJECTS - st.MAX_GUESTS + 1, 'all of yours kept');
  assert.equal(Object.keys(s.projects).length, st.MAX_PROJECTS);
});

test('a token or query string in a remote never becomes part of its name', () => {
  assert.equal(st.normalizeRemote('https://github.com/o/r?token=abc'), 'github.com/o/r');
  assert.equal(st.normalizeRemote('https://github.com/o/r.git#main'), 'github.com/o/r');
  assert.equal(st.normalizeRemote('https://github.com/o/r<script>'), null);
  assert.equal(st.normalizeRemote('https://github.com/o/..'), null);
});

test('a project that gets a remote keeps its sticker under the new id', () => {
  const pathId = st.projectId(null, 'C:/code/kelp');
  const remoteId = st.projectId('github.com/me/kelp');
  let s = st.recordShip(null, { id: pathId, name: 'kelp', root: 'C:/code/kelp' }, 'ship', T0, {}, { shell: 'home', slots: 3 }).state;
  s = st.recordShip(s, { id: pathId, name: 'kelp' }, 'ship', T0 + 2 * HOUR).state;
  const moved = st.rekey(s, pathId, remoteId);
  assert.equal(moved.projects[pathId], undefined);
  assert.equal(moved.projects[remoteId].ships, 2);
  assert.equal(moved.layouts.home[0].id, remoteId, 'and its spot on the shell');
  assert.deepEqual(moved.unseen, [remoteId]);
  assert.deepEqual(st.rekey(moved, pathId, remoteId), moved, 'nothing to move the second time');
  // Both ids already exist (it shipped from two clones): combined, on the shell once.
  const both = st.place(st.recordShip(s, { id: remoteId, name: 'kelp' }, 'deploy', T0).state, 'home', remoteId, 1, T0);
  const merged = st.rekey(both, pathId, remoteId);
  assert.equal(merged.layouts.home.filter(e => e.id === remoteId).length, 1);
  assert.deepEqual(merged.projects[remoteId].marks, ['live']);
});

test('an edit that changes nothing keeps the sync stamp, so it cannot win a sync by accident', () => {
  const s = shipMany(2, 3);
  const at = s.layoutsAt;
  assert.equal(st.remove(s, 'home', ID(9), T0 + 99).layoutsAt, at);
  assert.equal(st.flip(s, 'snail', ID(1), T0 + 99).layoutsAt, at);
  assert.equal(st.carryOnMolt(s, 'tin-can', 'snail', 3, T0 + 99).layoutsAt, at);
  assert.equal(st.flip(s, 'home', ID(1), T0 + 99).layoutsAt, T0 + 99);
});

test('what a command ships: pushes, deploys, releases, but not a draft or a test run', () => {
  assert.deepEqual(st.shipOf('ship', 'git push origin main'), { kind: 'ship', meta: {} });
  assert.deepEqual(st.shipOf('deploy', 'vercel --prod'), { kind: 'deploy', meta: {} });
  assert.deepEqual(st.shipOf('deploy', 'gh release create v1.0.0'), { kind: 'release', meta: { version: '1.0.0' } });
  assert.deepEqual(st.shipOf('ship', 'git push origin v0.2.0'), { kind: 'release', meta: { version: '0.2.0' } });
  assert.equal(st.shipOf('deploy', 'gh release create v1.0.0 --draft'), null);
  assert.equal(st.shipOf('tests', 'npm test'), null);
});

test('a mark earned without shipping: only on your own sticker, once, and never a ship', () => {
  const p = { id: 'abcdefabcdef', name: 'app' };
  const s = st.recordShip(null, p, 'ship', T0).state;
  const r = st.addMark(s, p.id, 'deps');
  assert.equal(r.added, true);
  assert.deepEqual(r.project.marks, ['deps']);
  assert.equal(r.project.ships, s.projects[p.id].ships, 'no ship counted');
  assert.equal(st.addMark(r.state, p.id, 'deps').added, false, 'once');
  assert.equal(st.addMark(s, '000000000000', 'deps').added, false, 'no sticker, no mark');
  assert.equal(st.addMark(s, p.id, 'made-up').added, false);
  const gift = st.receiveGuest(null, 'octocat', { name: 'theirs', tier: 'paper', palette: { a: '#ff0000' }, pixels: ['a'] }, T0);
  assert.equal(st.addMark(gift.state, gift.project.id, 'deps').added, false, "a friend's sticker isn't yours to mark");
  assert.ok(st.view(r.state, T0).projects[0].marks.some(m => m.id === 'deps' && m.icon === '🧼'));
});
