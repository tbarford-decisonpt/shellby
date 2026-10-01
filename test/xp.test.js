const { test } = require('node:test');
const assert = require('node:assert/strict');
const { xpForLevel, levelFor, award, classifyCommand, normalizeXp, AWARDS } = require('../src/main/xp');

const T0 = new Date(2026, 9, 1, 12, 0, 0).getTime();
const MIN = 60 * 1000;

test('level curve: 0, 100, 250, 450, 700 ... and titles', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 10].map(xpForLevel), [0, 100, 250, 450, 700, 2700]);
  assert.deepEqual(levelFor(0), { level: 1, title: 'Hatchling', xp: 0, floor: 0, next: 100, into: 0, needed: 100, progress: 0 });
  const l = levelFor(320);
  assert.deepEqual([l.level, l.title, l.into, l.needed], [3, 'Shell Seeker', 70, 200]);
  assert.equal(levelFor(2700).title, 'Coral Commander');
  assert.equal(levelFor(1e9).level, 99);
  assert.equal(levelFor(-5).level, 1);
});

test('award adds XP, logs it, and reports level-ups', () => {
  let s = normalizeXp(null);
  for (let i = 0; i < 9; i++) s = award(s, 'task', T0 + i * MIN).state;
  assert.equal(s.total, 90);
  const r = award(s, 'task', T0 + 10 * MIN, { label: 'Tidy Downloads', project: '3d-rack' });
  assert.equal(r.gained, 10);
  assert.equal(r.levelUp, true);
  assert.deepEqual([r.before.level, r.after.level], [1, 2]);
  assert.deepEqual(r.state.log[0], { at: T0 + 10 * MIN, kind: 'task', xp: 10, label: 'Tidy Downloads', project: '3d-rack' });
});

test('a new self-written trick is the biggest award', () => {
  const r = award(null, 'trick', T0, { label: 'rename-screenshots' });
  assert.equal(r.gained, 150);
  assert.ok(Object.values(AWARDS).every(a => a.xp <= AWARDS.trick.xp));
  assert.equal(r.after.level, 2);
});

test('hourly caps stop farming (tests: 6 an hour), and reset after an hour', () => {
  let s = null, got = 0;
  for (let i = 0; i < 20; i++) { const r = award(s, 'tests', T0 + i * MIN); s = r.state; got += r.gained; }
  assert.equal(got, 6 * 25);
  assert.equal(award(s, 'tests', T0 + 61 * MIN).gained, 25);
});

test('"day" counts once per calendar day', () => {
  let r = award(null, 'day', T0);
  assert.equal(r.gained, 5);
  r = award(r.state, 'day', T0 + 5 * 60 * MIN);
  assert.equal(r.gained, 0);
  assert.equal(award(r.state, 'day', T0 + 24 * 60 * MIN).gained, 5);
});

test('unknown kinds, bad clocks and junk state award nothing and never throw', () => {
  assert.equal(award(null, 'nope', T0).gained, 0);
  assert.equal(award(null, 'task', NaN).gained, 0);
  const s = normalizeXp({ total: -40, recent: { task: 'x' }, log: [{ kind: 'evil', at: 1 }, null] });
  assert.deepEqual([s.total, s.recent.task, s.log], [0, [], []]);
});

test('award never mutates the state it was given', () => {
  const s = normalizeXp({ total: 50 });
  const copy = JSON.stringify(s);
  award(s, 'deploy', T0);
  assert.equal(JSON.stringify(s), copy);
});

test('classifyCommand: tests, pushes and deploys across ecosystems', () => {
  const cases = {
    'npm test': 'tests', 'npm run test:unit': 'tests', 'pnpm test -- --watch=false': 'tests', 'node --test test/': 'tests',
    'pytest -q': 'tests', 'python -m pytest tests': 'tests', 'go test ./...': 'tests', 'cargo test': 'tests',
    'dotnet test': 'tests', 'npx vitest run': 'tests', 'npx playwright test': 'tests', './gradlew test': 'tests',
    'git push': 'ship', 'git push -u origin feat/x': 'ship',
    'vercel --prod': 'deploy', 'vercel deploy --prod': 'deploy', 'npx wrangler deploy': 'deploy', 'fly deploy': 'deploy',
    'gh release create v1.2.0': 'deploy', 'npm publish': 'deploy', 'kubectl apply -f k8s/': 'deploy', 'terraform apply -auto-approve': 'deploy',
    'cd app && npm test && git push': 'ship',
    'ls -la': null, 'echo test': null, 'cat test.txt': null, 'git status': null, 'npm install': null, '': null,
    'git push --dry-run': null, 'npm publish --dry-run': null,
  };
  for (const [cmd, want] of Object.entries(cases)) assert.equal(classifyCommand(cmd), want, cmd);
  assert.equal(classifyCommand(null), null);
});
