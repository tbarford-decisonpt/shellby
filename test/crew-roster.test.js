const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/main/crew-roster');

const T = 1_790_000_000_000;
const run = (type, extra = {}) => ({ type, taskId: `t-${Math.random()}`, ok: true, what: 'Look around', tokens: 100, toolUses: 3, durationMs: 2000, ...extra });

test('the first run of an agent type signs up a named crew member', () => {
  const s = R.recordRun(null, run('code-reviewer'), T);
  const m = s.members['code-reviewer'];
  assert.equal(m.runs, 1);
  assert.equal(m.completed, 1);
  assert.ok(m.name, 'gets a name');
  assert.equal(m.joinedAt, T);
  assert.equal(m.hat, 'auto');
  assert.equal(R.nameFor('code-reviewer'), R.nameFor('code-reviewer'), 'names are stable per type');
});

test('a new type enlists when first sent out, with no runs yet; enlisting again changes nothing', () => {
  const s = R.enlist(null, 'Explore', T);
  assert.deepEqual([s.members.Explore.runs, s.members.Explore.joinedAt], [0, T]);
  assert.ok(s.members.Explore.name);
  assert.equal(R.enlist(s, 'Explore', T + 5), s);
  assert.equal(R.recordRun(s, run('Explore'), T + 9).members.Explore.name, s.members.Explore.name, 'keeps its name');
});

test('two agent types never share a name', () => {
  let s = null;
  for (let i = 0; i < 30; i++) s = R.recordRun(s, run(`agent-${i}`), T);
  const names = Object.values(s.members).map(m => m.name);
  assert.equal(new Set(names).size, names.length);
});

test('runs add up usage, failures count apart, and recent runs are bounded', () => {
  let s = null;
  for (let i = 0; i < 8; i++) s = R.recordRun(s, run('Explore', { what: `job ${i}` }), T + i);
  s = R.recordRun(s, run('Explore', { ok: false }), T + 9);
  const m = s.members.Explore;
  assert.deepEqual([m.runs, m.completed, m.failed, m.tokens, m.toolUses], [9, 8, 1, 900, 27]);
  assert.equal(m.recent.length, R.RECENT_KEPT);
  assert.equal(m.recent[0].ok, false, 'newest first');
  assert.equal(m.lastAt, T + 9);
});

test('acting on a run credits it once', () => {
  const r = run('code-reviewer', { taskId: 'a1' });
  let s = R.recordRun(null, r, T);
  s = R.actedOn(s, [{ type: 'code-reviewer', taskId: 'a1' }], T + 1);
  s = R.actedOn(s, [{ type: 'code-reviewer', taskId: 'a1' }], T + 2);
  assert.equal(s.members['code-reviewer'].actedOn, 1);
  assert.equal(s.members['code-reviewer'].recent[0].actedOn, true);
  assert.equal(R.actedOn(s, [{ type: 'nobody', taskId: 'x' }], T), s, 'unknown members change nothing');
});

test('XP and levels: completed runs, failures and acted-on findings', () => {
  assert.equal(R.xpOf({ completed: 0, failed: 0, actedOn: 0 }), 0);
  assert.equal(R.levelForXp(0).level, 1);
  const lv = R.levelForXp(R.xpOf({ completed: 212, failed: 0, actedOn: 38 }));
  assert.ok(lv.level >= 13 && lv.level <= 16, `a seasoned reviewer is in the teens (got ${lv.level})`);
  assert.ok(lv.progress >= 0 && lv.progress < 1);
  assert.equal(R.levelForXp(1e12).level, R.MAX_LEVEL);
});

test('hats: auto wears the best one earned; a picked hat must be earned', () => {
  assert.equal(R.hatFor({ hat: 'auto' }, 1), R.HAT_LADDER[0][1]);
  assert.equal(R.hatFor({ hat: 'auto' }, 99), R.HAT_LADDER.at(-1)[1]);
  assert.equal(R.hatFor({ hat: 'none' }, 30), null);
  assert.equal(R.hatFor({ hat: 'match' }, 30), 'match');
  const top = R.HAT_LADDER.at(-1)[1];
  assert.equal(R.hatFor({ hat: top }, 1), R.HAT_LADDER[0][1], 'an unearned pick falls back to auto');
  assert.deepEqual(R.hatsEarned(1), [R.HAT_LADDER[0][1]]);
});

test('rename and setHat validate their input', () => {
  let s = R.recordRun(null, run('Explore'), T);
  s = R.rename(s, 'Explore', '  Captain   Scuttles  ');
  assert.equal(s.members.Explore.name, 'Captain Scuttles');
  assert.equal(R.rename(s, 'Explore', '   '), s, 'blank names are refused');
  assert.equal(R.rename(s, 'Explore', 'x'.repeat(80)).members.Explore.name.length, R.NAME_MAX);
  assert.equal(R.rename(s, 'Nobody', 'Hi'), s);
  s = R.setHat(s, 'Explore', 'none');
  assert.equal(s.members.Explore.hat, 'none');
  assert.equal(R.setHat(s, 'Explore', '<script>'), s, 'unknown hats are refused');
});

test('normalize repairs bad data and keeps the roster bounded', () => {
  assert.deepEqual(R.normalize(null), { members: {} });
  assert.deepEqual(R.normalize({ members: { '': {}, ok: { runs: -4, name: 7 } } }).members.ok.runs, 0);
  let s = null;
  for (let i = 0; i < R.MAX_MEMBERS + 5; i++) s = R.recordRun(s, run(`a${i}`), T + i);
  assert.equal(Object.keys(s.members).length, R.MAX_MEMBERS);
  assert.ok(!s.members.a0, 'the longest-unseen member steps down first');
});

test('types are trimmed and capped; a missing type is a general helper', () => {
  const s = R.recordRun(null, run('  ' + 'z'.repeat(200)), T);
  assert.equal(Object.keys(s.members)[0].length, R.TYPE_MAX);
  assert.ok(R.recordRun(null, run(''), T).members['general-purpose']);
});

test('view sorts by level, then most recent, with level details', () => {
  let s = R.recordRun(null, run('quiet'), T);
  for (let i = 0; i < 20; i++) s = R.recordRun(s, run('busy'), T + i);
  const v = R.view(s);
  assert.deepEqual(v.members.map(m => m.type), ['busy', 'quiet']);
  const busy = v.members[0];
  assert.ok(busy.level > 1);
  assert.equal(typeof busy.title, 'string');
  assert.ok(busy.hats.includes(busy.wears));
  assert.equal(v.totals.runs, 21);
});

test('levelUps names who crossed a level between two states', () => {
  const before = R.recordRun(null, run('Explore'), T);
  let after = before;
  for (let i = 0; i < 10; i++) after = R.recordRun(after, run('Explore'), T + i);
  const ups = R.levelUps(before, after);
  assert.equal(ups.length, 1);
  assert.equal(ups[0].type, 'Explore');
  assert.ok(ups[0].level > 1);
  assert.deepEqual(R.levelUps(after, after), []);
});

test('a run a busy turn pushed out of recent is still credited', () => {
  let s = null;
  for (let i = 0; i < R.RECENT_KEPT + 2; i++) s = R.recordRun(s, run('Explore', { taskId: `e${i}` }), T + i);
  s = R.actedOn(s, Array.from({ length: R.RECENT_KEPT + 2 }, (_, i) => ({ type: 'Explore', taskId: `e${i}` })));
  assert.equal(s.members.Explore.actedOn, R.RECENT_KEPT + 2);
});

test('a name another crew member has is refused, whatever its case', () => {
  let s = R.recordRun(null, run('Explore'), T);
  s = R.recordRun(s, run('Plan'), T);
  const other = s.members.Plan.name;
  assert.equal(R.rename(s, 'Explore', other.toUpperCase()), s);
  assert.equal(R.rename(s, 'Plan', other.toLowerCase()).members.Plan.name, other.toLowerCase(), 'its own name in another case is fine');
});

test('names lose control and invisible format characters', () => {
  const s = R.recordRun(null, run('Explore'), T);
  const sneaky = 'Bob' + String.fromCodePoint(0x202e) + 'evil' + String.fromCodePoint(0x200b) + String.fromCodePoint(7) + 'x';
  assert.equal(R.rename(s, 'Explore', sneaky).members.Explore.name, 'Bob evil x');
});
