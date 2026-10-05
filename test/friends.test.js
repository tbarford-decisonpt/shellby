const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanCard, findCard, publishCard, deleteCard, CARD_FILE } = require('../src/main/github/card');
const { parseWave, formatWave, checkWaves, WAVES } = require('../src/main/github/mail');
const { Friends, normalize, pickVisitor, souvenirFor, VISIT_GAP_MS, SAME_FRIEND_GAP_MS, FRESH_MS, SOUVENIRS, TOGETHER_FIRST_MS } = require('../src/main/friends');
const { recordStat, ACHIEVEMENTS } = require('../src/main/wardrobe/achievements');

class MemConfig {
  constructor(data = {}) { this.data = { ...data }; }
  get(k) { return this.data[k]; }
  set(p) { this.data = { ...this.data, ...p }; return this.data; }
}

// Just enough of GitHub's gist API, in memory, for one signed-in user.
function fakeGitHub(me) {
  const gists = new Map(); // id -> { id, owner, public, files, comments: [] }
  let next = 1, nextComment = 100;
  const calls = [];
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
  const shape = g => ({ id: g.id, owner: { login: g.owner }, public: g.public, files: Object.fromEntries(Object.entries(g.files).map(([n, f]) => [n, { filename: n, size: f.content.length, content: f.content, truncated: false }])) });
  const gh = {
    as: login => ({ ...gh, me: login }),
    me,
    async get(path) {
      calls.push(['GET', path]);
      let m;
      if ((m = /^\/gists\/([^/?]+)\/comments\?per_page=(\d+)&page=(\d+)$/.exec(path))) {
        const g = gists.get(m[1]); if (!g) throw notFound();
        const per = +m[2], page = +m[3];
        return g.comments.slice((page - 1) * per, page * per);
      }
      if ((m = /^\/gists\/([^/?]+)$/.exec(path))) { const g = gists.get(m[1]); if (!g) throw notFound(); return shape(g); }
      if ((m = /^\/users\/([^/]+)\/gists/.exec(path))) return [...gists.values()].filter(g => g.owner.toLowerCase() === m[1].toLowerCase() && g.public).map(shape);
      if (path.startsWith('/gists?')) return [...gists.values()].filter(g => g.owner === this.me).map(shape);
      throw notFound();
    },
    async post(path, body) {
      calls.push(['POST', path]);
      if (path === '/gists') {
        const id = `abc${next++}`;
        gists.set(id, { id, owner: this.me, public: body.public, files: { ...body.files }, comments: [] });
        return { id };
      }
      const m = /^\/gists\/([^/]+)\/comments$/.exec(path);
      const g = m && gists.get(m[1]); if (!g) throw notFound();
      g.comments.push({ id: nextComment++, body: body.body, user: { login: this.me }, created_at: new Date(1000).toISOString() });
      return {};
    },
    async patch(path, body) {
      calls.push(['PATCH', path]);
      const g = gists.get(/^\/gists\/([^/]+)$/.exec(path)[1]); if (!g) throw notFound();
      g.files = { ...g.files, ...body.files };
      return {};
    },
    async delete(path) {
      calls.push(['DELETE', path]);
      const id = /^\/gists\/([^/]+)$/.exec(path)[1];
      if (!gists.delete(id)) throw notFound();
      return null;
    },
  };
  return { gh, gists, calls };
}

const looks = (outfit = {}) => ({ name: 'Sam', skin: 'classic', home: null, level: 4, outfit: { hat: 'beanie', ...outfit } });

function service({ me = 'sam', world = fakeGitHub(me), config = new MemConfig(), now = () => 1e12, rand = () => 0, canVisit = () => true, myCard = () => looks() } = {}) {
  const github = { can: () => true, signedIn: true, gh: () => world.gh.as(me), view: () => ({ login: me, name: 'Sam' }) };
  return { f: new Friends({ config, github, myCard, canVisit, now, rand }), world, config };
}

// ------------------------------------------------------------------ the card

test('card: a friend\'s card is cleaned, whatever is in it', () => {
  const c = cleanCard({ login: 'x"><script>', name: 'A\u0000<b>B</b>', skin: '../../evil', level: 9999, outfit: { hat: 'beanie', face: 'UPPER', held: 42 }, extra: 'nope' });
  assert.equal(c.login, null);
  assert.equal('name' in c, false, 'no display name goes public');
  assert.equal(c.skin, null);
  assert.equal(c.level, 99);
  assert.deepEqual(c.outfit, { hat: 'beanie', face: null, neck: null, held: null, shell: null, effect: null });
  assert.equal('extra' in c, false);
});

test('card: the temperament and favourite find the crabs chat about are checked too', () => {
  const ok = cleanCard({ temperament: 'cocky', find: 'black-pearl' });
  assert.equal(ok.temperament, 'cocky');
  assert.equal(ok.find, 'black-pearl');
  const bad = cleanCard({ temperament: '<b>evil</b>', find: '../../etc/passwd' });
  assert.equal(bad.temperament, null);
  assert.equal(bad.find, null);
});

test('card: published as a public gist, found by username, and only believed from its owner', async () => {
  const world = fakeGitHub('alex');
  const id = await publishCard(world.gh, { ...looks(), login: 'alex', updatedAt: 5 }, null);
  assert.equal(world.gists.get(id).public, true, 'friends must be able to find it');
  const hit = await findCard(world.gh.as('sam'), 'Alex', null);
  assert.equal(hit.id, id);
  assert.equal(hit.card.login, 'alex', 'the owner GitHub reports, not what the file says');
  assert.equal(hit.card.outfit.hat, 'beanie');

  // A card gist id that belongs to someone else isn't alex's card.
  const otherId = await publishCard(world.gh.as('mallory'), { ...looks(), login: 'alex' }, null);
  const fromStale = await findCard(world.gh.as('sam'), 'alex', otherId);
  assert.equal(fromStale.id, id, 'falls back to listing alex\'s own gists');
  assert.equal(await findCard(world.gh.as('sam'), 'nobody', null), null);
});

test('card: republishing edits the same gist, and turning off deletes it', async () => {
  const world = fakeGitHub('sam');
  const id = await publishCard(world.gh, looks(), null);
  assert.equal(await publishCard(world.gh, looks({ hat: 'crown' }), id), id);
  assert.match(world.gists.get(id).files[CARD_FILE].content, /crown/);
  assert.equal(await deleteCard(world.gh, id), true);
  assert.equal(world.gists.size, 0);
  assert.equal(await deleteCard(world.gh, id), false, 'already gone is fine');
});

// ------------------------------------------------------------------ waves

test('mail: a wave is a fixed line with a marker; anything else is ignored', () => {
  const body = formatWave('outfit', 'sam');
  assert.match(body, /@sam's Shellby\*\* loves the outfit/);
  assert.deepEqual(parseWave({ id: 7, body, user: { login: 'sam' }, created_at: '2026-10-02T10:00:00Z' }), { id: 7, from: 'sam', wave: 'outfit', at: Date.parse('2026-10-02T10:00:00Z') });
  assert.equal(parseWave({ id: 8, body: 'hi <!-- shellby-wave:pwned -->', user: { login: 'sam' } }), null, 'unknown wave');
  assert.equal(parseWave({ id: 9, body: 'just a comment', user: { login: 'sam' } }), null);
});

test('mail: only friends\' waves arrive, the first look is silent, and the cursor moves on', async () => {
  const world = fakeGitHub('me');
  const id = await publishCard(world.gh, looks(), null);
  await world.gh.as('alex').post(`/gists/${id}/comments`, { body: formatWave('wave', 'alex') });
  const first = await checkWaves(world.gh, id, { cursor: {}, friends: ['alex'], me: 'me' });
  assert.deepEqual(first.waves, [], 'old waves are not news');

  await world.gh.as('alex').post(`/gists/${id}/comments`, { body: formatWave('ship', 'alex') });
  await world.gh.as('stranger').post(`/gists/${id}/comments`, { body: formatWave('sleep', 'stranger') });
  await world.gh.as('me').post(`/gists/${id}/comments`, { body: formatWave('proud', 'me') });
  const second = await checkWaves(world.gh, id, { cursor: first.cursor, friends: ['Alex'], me: 'me' });
  assert.deepEqual(second.waves.map(w => [w.from, w.wave]), [['alex', 'ship']]);

  const third = await checkWaves(world.gh, id, { cursor: second.cursor, friends: ['alex'], me: 'me' });
  assert.deepEqual(third.waves, [], 'nothing twice');
});

// ------------------------------------------------------------------ the service

test('friends: adding checks the username and finds their card', async () => {
  const world = fakeGitHub('sam');
  await publishCard(world.gh.as('alex'), { ...looks(), login: 'alex', updatedAt: 1e12 }, null);
  const { f } = service({ world });
  assert.equal((await f.add('not a name!')).ok, false);
  assert.equal((await f.add('sam')).ok, false, 'not yourself');
  const r = await f.add('https://github.com/alex');
  assert.deepEqual(r, { ok: true, hasCard: true });
  assert.equal((await f.add('@ALEX')).ok, false, 'no duplicates, whatever the case');
  assert.equal((await f.add('jordan')).hasCard, false);
  assert.deepEqual(f.view().friends.map(x => x.login), ['alex', 'jordan']);
  f.remove('Jordan');
  assert.deepEqual(f.view().friends.map(x => x.login), ['alex']);
});

test('friends: a refresh publishes your card once, picks up friends\' looks and their waves', async () => {
  const world = fakeGitHub('sam');
  const alexCard = await publishCard(world.gh.as('alex'), { ...looks(), login: 'alex', updatedAt: 1e12 }, null);
  let t = 1e12;
  const { f } = service({ world, now: () => t });
  await f.add('alex');
  const waves = [];
  f.on('wave', w => waves.push(w));
  world.calls.length = 0; // alex's own card doesn't count
  assert.equal((await f.refresh()).ok, true);
  const mine = f.state.cardId;
  assert.ok(mine);
  assert.equal(world.calls.filter(c => c[0] === 'PATCH' || (c[0] === 'POST' && c[1] === '/gists')).length, 1);

  // Nothing changed: no rewrite of the card.
  t += 60_000;
  await f.refresh();
  assert.equal(world.calls.filter(c => c[0] === 'PATCH').length, 0);

  // Alex changes hats and waves.
  await publishCard(world.gh.as('alex'), { ...looks({ hat: 'crown' }), login: 'alex', updatedAt: t }, alexCard);
  await world.gh.as('alex').post(`/gists/${mine}/comments`, { body: formatWave('coffee', 'alex') });
  await f.refresh();
  assert.equal(f.view().friends[0].card.outfit.hat, 'crown');
  assert.deepEqual(waves.map(w => w.text), [`@alex ${WAVES.coffee}`]);
  assert.equal(f.view().inbox[0].from, 'alex');
});

test('friends: waving needs a friend with a card, and is counted', async () => {
  const world = fakeGitHub('sam');
  const alexCard = await publishCard(world.gh.as('alex'), { ...looks(), login: 'alex', updatedAt: 1e12 }, null);
  const { f } = service({ world });
  const recorded = [];
  f.on('record', e => recorded.push(e));
  assert.equal((await f.wave('alex', 'wave')).ok, false, 'not a friend yet');
  await f.add('alex');
  assert.equal((await f.wave('alex', 'nonsense')).ok, false);
  assert.equal((await f.wave('alex', 'proud')).ok, true);
  assert.match(world.gists.get(alexCard).comments[0].body, /shellby-wave:proud/);
  assert.deepEqual(recorded, ['wave-sent']);
});

test('friends: a visit signs the guestbook, leaves a souvenir, and the visitor leaves again', async () => {
  const world = fakeGitHub('sam');
  await publishCard(world.gh.as('alex'), { ...looks(), login: 'alex', updatedAt: 1e12 }, null);
  let free = false;
  const { f } = service({ world, canVisit: () => free });
  await f.add('alex');
  assert.equal(f.invite('alex').ok, false, 'not while he is busy');
  free = true;
  const visits = [], recorded = [];
  f.on('visit', v => visits.push(v && v.login));
  f.on('record', e => recorded.push(e));
  assert.equal(f.invite('alex').ok, true);
  assert.equal(f.view().visiting.login, 'alex');
  assert.equal(f.view().guestbook[0].login, 'alex');
  assert.ok(SOUVENIRS.some(s => s.id === f.view().guestbook[0].souvenir));
  assert.deepEqual(recorded, ['visitor-hosted']);
  f.leave();
  assert.deepEqual(visits, ['alex', null]);
  f.stop();
});

test('friends: in Work mode nobody drops in on their own, but an invite still works', async () => {
  const world = fakeGitHub('sam');
  await publishCard(world.gh.as('alex'), { ...looks(), login: 'alex', updatedAt: 1e12 }, null);
  const { config } = service({ world });
  const github = { can: () => true, signedIn: true, gh: () => world.gh.as('sam'), view: () => ({ login: 'sam', name: 'Sam' }) };
  let work = true;
  const f = new Friends({ config, github, myCard: () => looks(), now: () => 1e12, rand: () => 0, dropIns: () => !work });
  await f.add('alex');
  await f.tick();
  assert.equal(f.view().visiting, null);
  work = false;
  await f.tick();
  assert.equal(f.view().visiting?.login, 'alex', 'out of Work mode, the drop-in comes');
  f.leave();
  work = true;
  assert.equal(f.invite('alex').ok, true);
  f.stop();
});

test('friends: drop-ins wait their turn and skip stale cards', () => {
  const now = 1e12;
  const card = { ...cleanCard(looks()), updatedAt: now - 1000 };
  const s = normalize({ list: [{ login: 'alex', card }, { login: 'old', card: { ...card, updatedAt: now - FRESH_MS - 1 } }] });
  assert.equal(pickVisitor(s, now, () => 0).login, 'alex');
  assert.equal(pickVisitor(s, now, () => 0.99), null, 'only now and then');
  assert.equal(pickVisitor({ ...s, lastVisitAt: now - VISIT_GAP_MS + 1 }, now, () => 0), null, 'not right after another visit');
  const visited = normalize({ list: [{ login: 'alex', card, visitedAt: now - SAME_FRIEND_GAP_MS + 1 }] });
  assert.equal(pickVisitor(visited, now, () => 0), null, 'the same friend not again so soon');
});

test('friends: souvenirs depend on who and which day, and stay in the set', () => {
  const day = Date.UTC(2026, 9, 2, 12);
  assert.equal(souvenirFor('alex', day).id, souvenirFor('ALEX', day + 3600_000).id);
  const week = Array.from({ length: 14 }, (_, i) => souvenirFor('alex', day + i * 86400_000).id);
  assert.ok(new Set(week).size > 1, 'a regular visitor brings a mix');
});

test('friends: inviting again soon is one guestbook entry, not one per click', async () => {
  const world = fakeGitHub('sam');
  await publishCard(world.gh.as('alex'), { ...looks(), login: 'alex', updatedAt: 1e12 }, null);
  let t = 1e12;
  const { f } = service({ world, now: () => t });
  await f.add('alex');
  const recorded = [];
  f.on('record', e => recorded.push(e));
  f.invite('alex');
  t += 60_000;
  f.invite('alex');
  assert.equal(f.view().guestbook.length, 1);
  assert.deepEqual(recorded, ['visitor-hosted']);
  assert.equal(f.view().visiting.login, 'alex', 'still comes over');
  f.stop();
});

test('friends: a visit during a refresh keeps its visitedAt', async () => {
  const world = fakeGitHub('sam');
  await publishCard(world.gh.as('alex'), { ...looks(), login: 'alex', updatedAt: 1e12 }, null);
  const { f } = service({ world });
  await f.add('alex');
  const slowGet = world.gh.get;
  let release;
  const gate = new Promise(r => { release = r; });
  world.gh.get = async function (path) { if (path.startsWith('/gists/') && !path.includes('comments')) await gate; return slowGet.call(this, path); };
  const pending = f.refresh();
  await new Promise(r => setTimeout(r, 20));
  f.invite('alex');
  const at = f.state.list[0].visitedAt;
  release();
  await pending;
  assert.equal(f.state.list[0].visitedAt, at);
  f.stop();
});

test('friends: turning off mid-refresh still leaves no card behind', async () => {
  const world = fakeGitHub('sam');
  let on = true;
  const { f } = service({ world });
  f.github.can = () => on;
  const pending = f.refresh();
  on = false;
  await f.takeDown();
  await pending;
  assert.equal(world.gists.size, 0);
});

test('friends: a failed delete keeps the card id so it can be tried again', async () => {
  const world = fakeGitHub('sam');
  const { f } = service({ world });
  await f.refresh();
  const id = f.state.cardId;
  const del = world.gh.delete;
  world.gh.delete = async () => { throw Object.assign(new Error('offline'), { status: 500 }); };
  assert.equal((await f.takeDown()).ok, false);
  assert.equal(f.state.cardId, id);
  world.gh.delete = del;
  assert.equal((await f.takeDown()).ok, true);
  assert.equal(world.gists.size, 0);
});

test('friends: turning it off deletes the card', async () => {
  const world = fakeGitHub('sam');
  const { f } = service({ world });
  await f.refresh();
  assert.equal(world.gists.size, 1);
  assert.equal((await f.takeDown()).ok, true);
  assert.equal(world.gists.size, 0);
  assert.equal(f.state.cardId, null);
});

test('friends: state from disk is tolerated', () => {
  const s = normalize({ list: [{ login: 'ok' }, { login: 'OK' }, { login: '<bad>' }, null, {}], guestbook: [{ login: 'ok', at: 5, souvenir: 'nope' }, { at: 5, souvenir: 'pearl' }], inbox: [{ from: 'ok', wave: 'evil', at: 1 }], cardId: '../x' });
  assert.deepEqual(s.list.map(x => x.login), ['ok']);
  assert.deepEqual(s.guestbook, []);
  assert.deepEqual(s.inbox, []);
  assert.equal(s.cardId, null);
});

test('trophies: hosting a visitor and sending waves count towards Open House and Pen Pals', () => {
  let stats = recordStat({}, 'visitor-hosted');
  for (let i = 0; i < 5; i++) stats = recordStat(stats, 'wave-sent');
  assert.equal(stats.visitorsHosted, 1);
  assert.equal(stats.wavesSent, 5);
  assert.ok(ACHIEVEMENTS.find(a => a.id === 'open-house'));
  assert.ok(ACHIEVEMENTS.find(a => a.id === 'pen-pals'));
});

test('together: never the same thing twice in a row, always with a line to say', () => {
  const { pickTogether, TOGETHER } = require('../src/main/friends');
  let last = null;
  for (let i = 0; i < 40; i++) {
    const t = pickTogether(last, Math.random);
    assert.notEqual(t.id, last);
    assert.ok(TOGETHER.find(x => x.id === t.id).lines.includes(t.line));
    last = t.id;
  }
});

test('together: a visit plans a few shared moments, skips them while he is busy, and stops when the visitor leaves', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const world = fakeGitHub('sam');
  await publishCard(world.gh.as('alex'), { ...looks(), login: 'alex', updatedAt: 1e12 }, null);
  let free = true;
  const { f } = service({ world, canVisit: () => free });
  await f.add('alex');
  const did = [];
  f.on('together', x => did.push(x.id));
  f.invite('alex');
  t.mock.timers.tick(TOGETHER_FIRST_MS);
  assert.equal(did.length, 1, 'the first one comes soon after hello');
  free = false; // a task started
  t.mock.timers.tick(45000);
  assert.equal(did.length, 1, 'not while he is working');
  free = true;
  t.mock.timers.tick(45000);
  assert.equal(did.length, 2);
  f.leave();
  t.mock.timers.tick(200000);
  assert.equal(did.length, 2, 'nothing after the visitor has gone');
});
