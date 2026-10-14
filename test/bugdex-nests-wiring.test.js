const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wireNests } = require('../src/main/wiring/bugdex-nests');

const T0 = new Date(2026, 9, 6, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function fakeD() {
  const cfg = {};
  const log = { stats: [], awards: [], quests: [], reef: [], pushes: [], registered: {} };
  const d = {
    config: { get: k => cfg[k], set: o => Object.assign(cfg, JSON.parse(JSON.stringify(o))) },
    stat: (event, payload) => log.stats.push(payload ? [event, payload] : [event]),
    awardXp: (kind, meta) => log.awards.push([kind, meta]),
    questDone: id => log.quests.push(id),
    reefNote: (project, sig, v) => log.reef.push([project, sig, v]),
    notify: () => {},
    log: { info: () => {}, warn: () => {} },
    gameHub: { register: (what, part) => { log.registered[what] = part; }, push: (what, view, event) => log.pushes.push({ what, view, event }) },
  };
  return { d, cfg, log };
}

const enc = (over = {}) => ({ species: 'nullfish', fp: 'abc', project: 'p1', name: 'Shellby', source: 'bash', reruns: 0, ...over });
const diff = (file, added) => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, ...added.map(l => `+${l}`)].join('\n');
const cleanFix = {
  files: [{ path: 'src/a.js', status: 'M' }, { path: 'test/a.test.js', status: 'A' }],
  patch: `${diff('src/a.js', ['return 1;'])}\n${diff('test/a.test.js', ["test('a', () => {})"])}`,
  judged: { ok: true }, counts: { before: 3, after: 4 },
};

test('registers the nests view and returns its hooks', () => {
  const { d, log } = fakeD();
  const { bugNests } = wireNests(d);
  assert.ok(log.registered.nests);
  for (const k of ['opened', 'rematchFor', 'report', 'caught', 'sweep', 'view']) assert.equal(typeof bugNests[k], 'function');
  assert.deepEqual(log.registered.nests.get().open, []);
  assert.equal(log.registered.nests.act('nonsense'), null);
});

test('three sightings form a nest and tell the reef', () => {
  const { d, log } = fakeD();
  const { bugNests } = wireNests(d);
  for (let i = 0; i < 3; i++) bugNests.opened(enc(), T0 + i * DAY);
  assert.equal(log.reef.length, 1);
  assert.deepEqual(log.reef[0], ['p1', 'nest', { open: 1, cleared: 0 }]);
  assert.equal(bugNests.view(T0 + 3 * DAY).open[0].project, 'Shellby');
});

test('a clean fix pays cleanfix; a refused or missing diff pays nothing extra', () => {
  const { d, log } = fakeD();
  const { bugNests } = wireNests(d);
  bugNests.opened(enc(), T0);
  const e = enc({ fix: cleanFix });
  const rep = bugNests.report(e, { crew: 1 });
  assert.equal(rep.q, 'pfrw');
  bugNests.caught(e, { state: { species: {} } }, T0 + 1000);
  assert.deepEqual(log.awards.map(a => a[0]), ['cleanfix']);
  assert.ok(log.stats.some(s => s[0] === 'clean-fix'));
  assert.ok(log.stats.some(s => s[0] === 'bugs-caught-total'));
  assert.ok(log.quests.includes('proof'));

  const { d: d2, log: log2 } = fakeD();
  const two = wireNests(d2).bugNests;
  assert.equal(two.report(enc({ fix: { ...cleanFix, judged: { ok: false, reason: 'skipped' } } })), null);
  two.caught(enc({ fix: { ...cleanFix, judged: { ok: false } } }), null, T0);
  assert.deepEqual(log2.awards, []);
});

test('a rematch won with a proof is sealed and clears the nest in 7 days', () => {
  const { d, log } = fakeD();
  const { bugNests } = wireNests(d);
  bugNests.opened(enc(), T0);
  bugNests.caught(enc(), null, T0 + 1000); // no diff: no report
  assert.equal(bugNests.rematchFor(enc(), T0 + DAY).n, 1);
  bugNests.opened(enc(), T0 + DAY);
  bugNests.opened(enc(), T0 + 2 * DAY); // the third sighting: a nest
  bugNests.caught(enc({ fix: cleanFix }), null, T0 + 2 * DAY + 1000);
  assert.ok(log.stats.some(s => s[0] === 'rematch-won'));
  assert.ok(log.quests.includes('rematch'));
  bugNests.sweep(T0 + 9 * DAY + 2000);
  assert.ok(log.awards.some(a => a[0] === 'nest'));
  assert.ok(log.stats.some(s => s[0] === 'nest-cleared'));
  assert.ok(log.quests.includes('nest'));
  assert.equal(bugNests.view(T0 + 10 * DAY).clearedTotal, 1);
});

test('a fix that held 14 days pays once', () => {
  const { d, log } = fakeD();
  const { bugNests } = wireNests(d);
  bugNests.opened(enc(), T0);
  bugNests.caught(enc(), null, T0 + 1000);
  bugNests.sweep(T0 + 15 * DAY);
  bugNests.sweep(T0 + 16 * DAY);
  assert.equal(log.awards.filter(a => a[0] === 'held').length, 1);
  assert.equal(log.stats.filter(s => s[0] === 'fix-held').length, 1);
});
