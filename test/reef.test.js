const { test } = require('node:test');
const assert = require('node:assert/strict');
const reef = require('../src/main/reef');
const tank = require('../src/main/tank');

const ID = 'abcdef012345';
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date(2026, 9, 1, 12).getTime();
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

const watched = (now = T0) => reef.enable(null, ID, { name: 'shellby', root: 'C:\\code\\shellby', remote: 'github.com/x/shellby' }, true, now).state;
// A run of readings, each a day apart from T0: [[sig, value, ctx?], ...] -> the last result.
function run(state, readings, start = T0) {
  let s = state;
  let r = null;
  readings.forEach(([sig, v, ctx], i) => { r = reef.reading(s, ID, sig, v, start + i * DAY, ctx); s = r.state; });
  return { state: s, last: r };
}

test('the reef is off until you watch it, and watching starts it fresh', () => {
  assert.equal(reef.reading(null, ID, 'lint', 3, T0).reason, 'off');
  const r = reef.enable(null, ID, { name: 'shellby', root: 'C:\\code\\shellby' }, true, T0);
  assert.equal(r.first, true);
  assert.equal(r.state.projects[ID].on, true);
  assert.equal(reef.enable(r.state, ID, {}, true, T0).first, false);
  assert.equal(reef.enable(null, 'not-an-id', {}, true, T0).state.projects['not-an-id'], undefined);
});

test('the baseline reading pays nothing', () => {
  const r = reef.reading(watched(), ID, 'escapes', 20, T0, { head: HEAD_A });
  assert.equal(r.baseline, true);
  assert.equal(r.best, false);
  assert.equal(r.paid, false);
  assert.equal(r.state.projects[ID].polyps, 0);
  assert.equal(r.state.projects[ID].head, HEAD_A);
});

test('a new best adds a polyp and pays once a day', () => {
  let s = reef.reading(watched(), ID, 'escapes', 20, T0).state;
  const a = reef.reading(s, ID, 'escapes', 19, T0 + DAY);
  assert.equal(a.best, true);
  assert.equal(a.paid, true);
  s = a.state;
  const b = reef.reading(s, ID, 'escapes', 18, T0 + DAY + 1000);
  assert.equal(b.best, true);
  assert.equal(b.paid, false, 'the same day pays once');
  assert.equal(b.state.projects[ID].polyps, 2, 'but still grows');
  const c = reef.reading(b.state, ID, 'lint', 3, T0 + 2 * DAY, { cmd: 'npm run lint' });
  assert.equal(c.baseline, true);
  const d = reef.reading(c.state, ID, 'lint', 2, T0 + 2 * DAY + 5, { cmd: 'npm run lint' });
  assert.equal(d.best && d.paid, true, 'a new day pays again');
});

test('a smaller change than the step is not a best', () => {
  let s = reef.reading(watched(), ID, 'coverage', 80, T0).state;
  const r = reef.reading(s, ID, 'coverage', 80.3, T0 + DAY);
  assert.equal(r.best, false);
  s = r.state;
  assert.equal(s.projects[ID].signals.coverage.best, 80);
  assert.equal(s.projects[ID].signals.coverage.last, 80.3);
});

test('a regression lowers the stage but never the polyps', () => {
  const good = run(watched(), [['escapes', 10], ['escapes', 9], ['escapes', 8], ['escapes', 7], ['lint', 4, { cmd: 'x' }], ['lint', 3, { cmd: 'x' }]]);
  const p = good.state.projects[ID];
  const now = T0 + 6 * DAY;
  const before = reef.healthOf(p, now);
  assert.equal(p.polyps, 4);
  const bad = run(good.state, [['escapes', 30], ['lint', 40, { cmd: 'x' }]], now);
  const after = bad.state.projects[ID];
  assert.equal(after.polyps, 4);
  assert.equal(after.signals.escapes.best, 7, 'the mark stays');
  assert.ok(reef.healthOf(after, now + DAY) < before, `stage fell (${before} -> ${reef.healthOf(after, now + DAY)})`);
});

test('a young reef is settling: no higher than stage 2 before three days of readings', () => {
  const s = reef.reading(watched(), ID, 'lint', 0, T0, { cmd: 'x' }).state;
  assert.equal(reef.healthOf(s.projects[ID], T0), 2);
  assert.equal(reef.reefView(s, T0).projects[0].stageName, 'Settling');
});

test('a reef that has gone quiet pales but keeps its coral', () => {
  const { state } = run(watched(), [['escapes', 10], ['escapes', 9], ['escapes', 8]]);
  const later = T0 + 60 * DAY;
  assert.equal(reef.healthOf(state.projects[ID], later), 1);
  assert.equal(reef.corals(state, later)[0].polyps, 2);
});

test('a thriving reef needs sustained bests', () => {
  const { state } = run(watched(), [['escapes', 10], ['escapes', 9], ['escapes', 8], ['escapes', 7]]);
  const p = state.projects[ID];
  assert.equal(reef.healthOf(p, T0 + 3 * DAY), 5);
  assert.equal(reef.thrivingCount(state, T0 + 3 * DAY), 1);
});

test('the deleted-file guard: fewer escapes because the code went is a new baseline, not a best', () => {
  let s = reef.reading(watched(), ID, 'escapes', 50, T0, { head: HEAD_A }).state;
  const r = reef.reading(s, ID, 'escapes', 10, T0 + DAY, { head: HEAD_B, deletedShare: 0.6 });
  assert.equal(r.best, false);
  assert.equal(r.paid, false);
  assert.equal(r.reason, 'deleted');
  assert.equal(r.state.projects[ID].polyps, 0);
  assert.equal(r.state.projects[ID].signals.escapes.best, 10);
  assert.equal(r.state.projects[ID].head, HEAD_B);
  s = r.state;
  assert.equal(reef.reading(s, ID, 'escapes', 9, T0 + 2 * DAY, { deletedShare: 0.01 }).best, true);
});

test('the coverage-needs-tests guard: coverage up while tests fell is not a best', () => {
  const { state } = run(watched(), [['coverage', 70], ['tests', 100], ['tests', 80]]);
  const r = reef.reading(state, ID, 'coverage', 90, T0 + 2 * DAY + 1000);
  assert.equal(r.best, false);
  assert.equal(r.reason, 'tests-fell');
  assert.equal(reef.reading(state, ID, 'coverage', 90, T0 + 10 * DAY).best, true, 'once the window has passed it counts');
});

test('more tests while escape hatches rose is not a best', () => {
  const { state } = run(watched(), [['tests', 100], ['escapes', 5], ['escapes', 9]]);
  const r = reef.reading(state, ID, 'tests', 200, T0 + 2 * DAY + 1000);
  assert.equal(r.reason, 'escapes-rose');
  assert.equal(r.best, false);
});

test('lint only counts the same command as its first reading', () => {
  const s = reef.reading(watched(), ID, 'lint', 10, T0, { cmd: 'npm run lint' }).state;
  const r = reef.reading(s, ID, 'lint', 0, T0 + DAY, { cmd: 'eslint one-file.js' });
  assert.equal(r.reason, 'other-command');
  assert.equal(r.state.projects[ID].signals.lint.last, 10);
});

test('stopping keeps everything, and watching again carries on', () => {
  const { state } = run(watched(), [['escapes', 10], ['escapes', 9]]);
  const off = reef.enable(state, ID, {}, false, T0).state;
  assert.equal(off.projects[ID].on, false);
  assert.equal(off.projects[ID].polyps, 1);
  assert.equal(reef.reading(off, ID, 'escapes', 1, T0 + 5 * DAY).reason, 'off');
  const on = reef.enable(off, ID, {}, true, T0).state;
  assert.equal(on.projects[ID].signals.escapes.best, 9);
});

test('CI runs are kept once each, the last 20', () => {
  let s = watched();
  for (let i = 0; i < 25; i++) s = reef.noteCiRun(s, ID, `sha${i}`, i % 2 === 0).state;
  assert.equal(reef.noteCiRun(s, ID, 'sha24', true).changed, false);
  assert.equal(s.projects[ID].ciRuns.length, 20);
  assert.equal(reef.signals.ciRate(s.projects[ID].ciRuns), 50);
});

test('the next improvement is the smallest step', () => {
  const { state } = run(watched(), [['escapes', 4], ['coverage', 60], ['escapes', 5]]);
  const next = reef.nextImprovement(state.projects[ID]);
  assert.equal(next.sig, 'escapes');
  assert.match(next.text, /Remove 2 escape hatches/);
  const zero = run(watched(), [['lint', 0, { cmd: 'x' }]]).state;
  assert.equal(reef.nextImprovement(zero.projects[ID]), null, 'nothing below zero to aim for');
});

test('coralArt is deterministic, grows with polyps and pales with health', () => {
  const a = reef.coralArt(4, 12, ID);
  assert.deepEqual(reef.coralArt(4, 12, ID), a);
  assert.notDeepEqual(reef.coralArt(4, 12, '0123456789ab').pixels, a.pixels);
  const small = reef.coralArt(4, 0, ID);
  const big = reef.coralArt(4, 80, ID);
  assert.ok(big.pixels.length > small.pixels.length && big.pixels[0].length > small.pixels[0].length);
  assert.ok(big.pixels.length <= 32 && big.pixels[0].length <= 32, 'fits the decor grid');
  for (const art of [small, big]) {
    assert.equal(art.frames.length, 1);
    assert.equal(art.frames[0].length, art.pixels.length);
    const keys = new Set(art.pixels.join('').replace(/\./g, ''));
    for (const k of keys) assert.ok(art.palette[k], `palette has ${k}`);
  }
  assert.notEqual(reef.coralArt(0, 12, ID).palette.c, reef.coralArt(5, 12, ID).palette.c);
});

test('normalize survives junk and caps what it keeps', () => {
  assert.deepEqual(reef.normalize('nope'), { projects: {} });
  const s = reef.normalize({ projects: { [ID]: { on: true, polyps: -5, signals: { lint: { best: 'x' }, escapes: { best: 3, series: [['bad', 1], ['2026-10-01', 3]] } } }, '../evil': { on: true } } });
  assert.deepEqual(Object.keys(s.projects), [ID]);
  assert.equal(s.projects[ID].polyps, 0);
  assert.equal(s.projects[ID].signals.lint, undefined);
  assert.deepEqual(s.projects[ID].signals.escapes.series, [['2026-10-01', 3]]);
});

test('reefView lists projects with signals, waiting signals and coral art', () => {
  const { state } = run(watched(), [['escapes', 4], ['escapes', 3]]);
  const v = reef.reefView(state, T0 + DAY);
  assert.equal(v.watching, 1);
  assert.equal(v.polyps, 1);
  const p = v.projects[0];
  assert.equal(p.id, ID);
  assert.equal(p.signals[0].id, 'escapes');
  assert.equal(p.signals[0].atBest, true);
  assert.deepEqual(p.signals[0].series, [4, 3]);
  assert.ok(p.waiting.some(w => w.id === 'coverage'));
  assert.ok(Array.isArray(p.art.pixels));
});

test('coral goes in the tank: a coral: ref, one per project, on the Plants shelf', () => {
  assert.ok(tank.REF_RE.test(`coral:${ID}`));
  assert.ok(!tank.REF_RE.test('coral:../x'));
  const { state } = run(watched(), [['escapes', 4], ['escapes', 3]]);
  const lib = tank.library({ coral: reef.corals(state, T0 + DAY) });
  const e = lib.get(`coral:${ID}`);
  assert.equal(e.kind, 'coral');
  assert.equal(e.category, 'plant');
  assert.equal(e.max, 1);
  assert.equal(e.name, 'shellby coral');
  const v = tank.view({ state: { placed: [{ ref: `coral:${ID}`, x: 10, row: 1 }] }, lib });
  assert.equal(v.pieces.length, 1);
  assert.equal(v.pieces[0].frames.length, 1);
  const { state: saved, dropped } = tank.sanitize({ placed: [{ ref: `coral:${ID}`, x: 1 }, { ref: `coral:${ID}`, x: 5 }] }, { lib });
  assert.equal(saved.placed.length, 1);
  assert.deepEqual(dropped.map(x => x.reason), ['not-enough']);
});
