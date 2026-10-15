// wiring/reef.js and wiring/review.js against a stand-in `d`: what a reading or
// a review pays, and that nothing reaches git or Electron.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const gitinfo = require('../src/main/gitinfo');
const probe = require('../src/main/reef/probe');
const changes = require('../src/main/changes');
const { createGameHub } = require('../src/main/game-hub');
const { wireReef } = require('../src/main/wiring/reef');
const { wireReview } = require('../src/main/wiring/review');

const ID = 'abcdef012345';
const ROOT = 'C:\\code\\shellby';
const AFTER1 = '1'.repeat(40);
const AFTER2 = '2'.repeat(40);

function fakeD() {
  const store = {};
  const listeners = { cmd: [], reef: [], award: [] };
  const d = {
    FAKE_CLI: 'fake', // a test run: no timers
    log: { warn() {}, info() {}, error() {} },
    config: { get: k => store[k], set: patch => Object.assign(store, patch) },
    panel: {}, sent: [], awards: [], stats: [], quests: [],
    send: (_w, channel, payload) => d.sent.push({ channel, payload }),
    awardXp: (kind, meta) => d.awards.push({ kind, meta }),
    stat: (event, payload) => d.stats.push({ event, payload }),
    questDone: id => d.quests.push(id),
    onCommandResult: fn => listeners.cmd.push(fn),
    onReefNote: fn => listeners.reef.push(fn),
    onAward: fn => listeners.award.push(fn),
    command: r => listeners.cmd.forEach(fn => fn(r)),
    reefNote: (p, s, v) => listeners.reef.forEach(fn => fn(p, s, v)),
  };
  d.gameHub = createGameHub(d);
  return { d, store };
}

const stubs = [];
function stub(obj, key, fn) { stubs.push([obj, key, obj[key]]); obj[key] = fn; }
function restore() { while (stubs.length) { const [o, k, v] = stubs.pop(); o[k] = v; } }
const settle = () => new Promise(r => setTimeout(r, 10));

test('reef: watching resolves the project, starts a first look and completes the quest', async t => {
  t.after(restore);
  stub(gitinfo, 'projectOf', async () => ({ id: ID, root: ROOT, name: 'shellby', remote: 'github.com/x/shellby' }));
  stub(probe, 'coverage', async () => ({ pct: 71.5, mtime: 5, file: 'coverage/lcov.info' }));
  stub(probe, 'escapes', async () => ({ count: 12, head: 'a'.repeat(40) }));
  const { d, store } = fakeD();
  wireReef(d);
  const v = await d.gameHub.act('reef', 'watch', { root: ROOT });
  assert.equal(v.watching, 1);
  assert.deepEqual(d.quests, ['reef-on']);
  await settle();
  const p = store.reef.projects[ID];
  assert.equal(p.signals.coverage.best, 71.5);
  assert.equal(p.signals.escapes.best, 12);
  assert.equal(d.awards.length, 0, 'baselines pay nothing');
});

test('reef: a lint run Claude did is read, and a new best pays and adds a polyp', async t => {
  t.after(restore);
  stub(gitinfo, 'projectOf', async () => ({ id: ID, root: ROOT, name: 'shellby', remote: '' }));
  stub(probe, 'coverage', async () => null);
  stub(probe, 'escapes', async () => ({ skipped: 'too-big' }));
  const { d, store } = fakeD();
  wireReef(d);
  await d.gameHub.act('reef', 'watch', { root: ROOT });
  d.command({ kind: 'lint', command: 'npm run lint', dir: ROOT, ok: false, output: '✖ 5 problems (5 errors, 0 warnings)' });
  await settle();
  d.command({ kind: 'lint', command: 'npm run lint', dir: ROOT, ok: false, output: '✖ 3 problems (3 errors, 0 warnings)' });
  await settle();
  assert.equal(store.reef.projects[ID].signals.lint.best, 3);
  assert.equal(store.reef.projects[ID].polyps, 1);
  assert.deepEqual(d.awards.map(a => a.kind), ['reef']);
  assert.ok(d.stats.some(s => s.event === 'reef-best'));
  const pushed = d.sent.filter(s => s.channel === 'game' && s.payload.event?.kind === 'best');
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].payload.event.sig, 'lint');
});

test('reef: Fix this keeps where the lint problems are and writes a prompt naming them', async t => {
  t.after(restore);
  stub(gitinfo, 'projectOf', async () => ({ id: ID, root: ROOT, name: 'shellby', remote: '' }));
  stub(probe, 'coverage', async () => null);
  stub(probe, 'escapes', async () => ({ skipped: 'too-big' }));
  const { d, store } = fakeD();
  wireReef(d);
  await d.gameHub.act('reef', 'watch', { root: ROOT });
  const output = `${ROOT}\\src\\a.js\n  3:5  error  'x' is never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)`;
  d.command({ kind: 'lint', command: 'npm run lint', dir: ROOT, ok: false, output });
  await settle();
  assert.deepEqual(store.reef.projects[ID].detail.lint.files, [['src/a.js', 1]]);
  // Another lint command's output doesn't replace it.
  d.command({ kind: 'lint', command: 'npx eslint other', dir: ROOT, ok: false, output: `${ROOT}\\b.js\n  1:1  error  x  semi\n\n✖ 1 problem` });
  await settle();
  assert.deepEqual(store.reef.projects[ID].detail.lint.files, [['src/a.js', 1]]);
  const f = await d.gameHub.act('reef', 'fix', { id: ID, sig: 'lint' });
  assert.equal(f.root, ROOT);
  assert.match(f.prompt, /src\/a\.js \(1 problem\)/);
  assert.equal((await d.gameHub.act('reef', 'fix', { id: ID, sig: 'worst' })).sig, 'lint');
  assert.ok((await d.gameHub.act('reef', 'fix', { id: ID, sig: 'escapes' })).error);
  assert.ok((await d.gameHub.act('reef', 'fix', { id: 'nope', sig: 'lint' })).error);
});

test('reef: the Bugdex sends nest with { open, cleared }; it reads as nests with the nests named', async t => {
  t.after(restore);
  stub(gitinfo, 'projectOf', async () => ({ id: ID, root: ROOT, name: 'shellby', remote: '' }));
  stub(probe, 'coverage', async () => null);
  stub(probe, 'escapes', async () => ({ skipped: 'no-repo' }));
  const { d, store } = fakeD();
  store.bugNests = { nests: { [`${ID}|nosuchspecies`]: { project: ID, species: 'nosuchspecies', seen: [1], nest: { since: 1, count: 3 }, cleared: [] } } };
  wireReef(d);
  await d.gameHub.act('reef', 'watch', { root: ROOT });
  d.reefNote(ID, 'nest', { open: 1, cleared: 0 });
  assert.equal(store.reef.projects[ID].signals.nests.best, 1);
  assert.equal(store.reef.projects[ID].detail.nests.nests[0].count, 3);
  assert.match((await d.gameHub.act('reef', 'fix', { id: ID, sig: 'nests' })).prompt, /nosuchspecies: seen 3 times/);
});

test('reef: notes from the Bugdex by project id, and corals for the tank', async t => {
  t.after(restore);
  stub(gitinfo, 'projectOf', async () => ({ id: ID, root: ROOT, name: 'shellby', remote: '' }));
  stub(probe, 'coverage', async () => null);
  stub(probe, 'escapes', async () => ({ skipped: 'no-repo' }));
  const { d, store } = fakeD();
  const { reefCorals } = wireReef(d);
  d.reefNote(ID, 'nests', 2); // not watched yet: ignored
  assert.equal(store.reef, undefined);
  await d.gameHub.act('reef', 'watch', { root: ROOT });
  d.reefNote(ID, 'nests', 2);
  d.reefNote({ id: ID }, 'nests', 1);
  assert.equal(store.reef.projects[ID].signals.nests.best, 1);
  const corals = reefCorals();
  assert.equal(corals.length, 1);
  assert.equal(corals[0].polyps, 1);
  assert.ok(corals[0].art.pixels.length > 0);
});

test('reef: unknown actions and a folder that is not a repo say so', async t => {
  t.after(restore);
  stub(gitinfo, 'projectOf', async () => null);
  const { d } = fakeD();
  wireReef(d);
  assert.equal(d.gameHub.act('reef', 'explode', {}), null);
  const v = await d.gameHub.act('reef', 'watch', { root: 'C:\\nope' });
  assert.match(v.error, /isn't a git repository/);
});

function reviewD() {
  const { d, store } = fakeD();
  const manager = new EventEmitter();
  d.manager = manager;
  const items = [{ kind: 'changes', root: ROOT, before: '0'.repeat(40), after: AFTER1, added: 30, removed: 5 }];
  d.history = { load: () => items };
  return { d, store, manager };
}

const COMMENT = { file: 'src/app.js', body: 'This swallows the error: log it before retrying.', start: 10, end: 12, side: 'new', after: AFTER1 };

test('review: a real comment pays a point; a catch on the next turn pays caught', async t => {
  t.after(restore);
  stub(changes, 'patchFor', async () => ({ patch: 'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -11,1 +11,1 @@\n-  retry()\n+  log(e); retry()\n' }));
  const { d, store, manager } = reviewD();
  Object.assign(d, wireReview(d)); // as main.js shares it
  d.reviewComments('tab-1', [COMMENT]);
  assert.equal(store.reviewMastery.points, 1);
  manager.emit('item', 'tab-1', { kind: 'changes', root: ROOT, before: AFTER1, after: AFTER2 });
  await settle();
  assert.equal(store.reviewMastery.caught, 1);
  assert.equal(store.reviewMastery.points, 6);
  assert.deepEqual(d.awards.map(a => a.kind), ['caught']);
  assert.ok(d.stats.some(s => s.event === 'review-caught'));
  assert.deepEqual(d.quests, ['caught']);
});

test('review: a push in between means no catch', async t => {
  t.after(restore);
  stub(changes, 'patchFor', async () => ({ patch: '@@ -11,1 +11,1 @@\n-a\n+b\n' }));
  const { d, store, manager } = reviewD();
  Object.assign(d, wireReview(d)); // as main.js shares it
  d.reviewComments('tab-1', [COMMENT]);
  await new Promise(r => setTimeout(r, 2));
  d.command({ kind: 'git', command: 'git push origin main', dir: ROOT, ok: true });
  manager.emit('item', 'tab-1', { kind: 'changes', root: ROOT, before: AFTER1, after: AFTER2 });
  await settle();
  assert.equal(store.reviewMastery.caught, 0);
});

test('review: comments on a turn the tab never had count for nothing', () => {
  const { d, store } = reviewD();
  Object.assign(d, wireReview(d)); // as main.js shares it
  d.reviewComments('tab-1', [{ ...COMMENT, after: 'f'.repeat(40) }]);
  assert.equal(store.reviewMastery, undefined);
});

test('review: a quiz pass pays points and reports the best run', () => {
  const { d, store } = reviewD();
  Object.assign(d, wireReview(d)); // as main.js shares it
  d.reviewQuiz({ tabId: 'tab-1', after: AFTER1, lines: 40, passed: true });
  assert.equal(store.reviewMastery.points, 3);
  assert.deepEqual(d.stats.filter(s => s.event === 'quiz-streak').map(s => s.payload.n), [1]);
  const v = d.gameHub.get('review');
  assert.equal(v.quizBest, 1);
});

test('review: reaching a tier pays reviewtier and pushes the moment', () => {
  const { d, store } = reviewD();
  store.reviewMastery = { points: 9, caught: 0, quiz: { streak: 0, best: 0 } };
  Object.assign(d, wireReview(d)); // as main.js shares it
  d.reviewComments('tab-1', [COMMENT]);
  assert.deepEqual(d.awards.map(a => a.kind), ['reviewtier']);
  assert.deepEqual(d.stats.filter(s => s.event === 'review-tier').map(s => s.payload.n), [1]);
  const pushed = d.sent.filter(s => s.channel === 'game' && s.payload.what === 'review').at(-1);
  assert.equal(pushed.payload.event.kind, 'tier');
});
