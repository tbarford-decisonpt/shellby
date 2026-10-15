// reef/prompts.js and reef.fixPrompt: the Fix this prompt per signal, with and
// without detail, and which signal Fix the worst picks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const reef = require('../src/main/reef');
const { promptFor, worstOf, canImprove } = require('../src/main/reef/prompts');

const sig = (last, best = last) => ({ last, best, series: [] });
const proj = (signals, detail = {}) => ({ name: 'app', root: 'C:\\app', signals, detail });

const DETAIL = {
  escapes: { files: [['src/a.ts', 7], ['src/b.ts', 2]], kinds: [['any', 6], ['ts-ignore', 3]] },
  lint: { files: [['src/x.js', 4]], rules: [['no-unused-vars', 3]], cmd: 'npm run lint' },
  coverage: { file: 'coverage/lcov.info', files: [['src/core.js', 40, 60]] },
  ci: { jobs: [['test (windows-latest)', 3]], prs: ['#12 Faster boot'] },
  flaky: { tests: [['saves on quit', 4]] },
  deps: { manager: 'npm', packages: [{ name: 'minimist', severity: 'critical', direct: false, fix: 'major' }] },
  nests: { nests: [{ name: 'Null Mite', species: 'nullbug', count: 5, since: Date.UTC(2026, 8, 1), cleared: 1 }] },
  tests: {},
};
const VALUES = { escapes: sig(9, 8), lint: sig(4), coverage: sig(61.5, 62), ci: sig(70, 80), flaky: sig(1), deps: sig(1), nests: sig(1), tests: sig(120) };
// What each prompt must name from its detail.
const NAMES = {
  escapes: ['src/a.ts (7 escapes)', 'any 6'],
  lint: ['src/x.js (4 problems)', 'no-unused-vars', '`npm run lint`'],
  coverage: ['src/core.js: 40% (60 lines uncovered)', 'coverage/lcov.info', '62.5%'],
  ci: ['test (windows-latest)', '#12 Faster boot'],
  flaky: ['saves on quit (flaked 4 times)'],
  deps: ['minimist: critical (indirect), fix needs a major bump', 'npm audit'],
  nests: ['Null Mite (nullbug): seen 5 times since 2026-09-01, cleared 1 time before'],
  tests: ['add at least 3 tests'],
};

for (const id of reef.signals.SIGNAL_IDS) {
  test(`${id}: the prompt names where, what better means, and how to check`, () => {
    const p = promptFor(proj({ [id]: VALUES[id] }, { [id]: DETAIL[id] }), id);
    assert.ok(p, 'a prompt');
    assert.match(p, /^Help app's reef: /);
    assert.match(p, /better/i);
    assert.match(p, /run/i);
    assert.match(p, /make sure/i);
    for (const s of NAMES[id]) assert.ok(p.includes(s), `names "${s}" in:\n${p}`);
  });

  test(`${id}: without any detail it is still a whole prompt`, () => {
    const p = promptFor(proj({ [id]: VALUES[id] }), id);
    assert.ok(p && p.length > 100);
    assert.ok(!/undefined|null|NaN/.test(p), p);
  });
}

test('tests: points at the least-covered files when coverage has them', () => {
  const p = promptFor(proj({ tests: sig(50) }, { coverage: DETAIL.coverage }), 'tests');
  assert.ok(p.includes('src/core.js: 40%'));
});

test('nothing to fix: no prompt for a signal at zero, at 100%, or not read', () => {
  assert.equal(promptFor(proj({ lint: sig(0) }), 'lint'), null);
  assert.equal(promptFor(proj({ ci: sig(100) }), 'ci'), null);
  assert.equal(promptFor(proj({ coverage: sig(95) }), 'coverage'), null);
  assert.equal(promptFor(proj({}), 'escapes'), null);
  assert.equal(promptFor(proj({ lint: sig(3) }), 'bogus'), null);
  assert.equal(canImprove('deps', sig(0)), false);
});

test('Fix the worst picks the signal with the most room', () => {
  assert.equal(worstOf(proj({ escapes: sig(5), deps: sig(4), coverage: sig(85) })), 'deps');
  assert.equal(worstOf(proj({ escapes: sig(60), deps: sig(1) })), 'escapes');
  assert.equal(worstOf(proj({ coverage: sig(10), tests: sig(5) })), 'coverage');
  assert.equal(worstOf(proj({ lint: sig(0), ci: sig(100) })), null);
  assert.equal(worstOf(null), null);
});

test('reef.fixPrompt and setDetail: stored detail flows into the prompt; the view says what is fixable', () => {
  const now = Date.UTC(2026, 9, 14, 12);
  const id = 'abcdef012345';
  let s = reef.enable({}, id, { name: 'app', root: 'C:\\app' }, true, now).state;
  s = reef.reading(s, id, 'lint', 4, now, { cmd: 'npm run lint' }).state;
  s = reef.reading(s, id, 'deps', 0, now).state;
  s = reef.setDetail(s, id, 'lint', DETAIL.lint);
  const f = reef.fixPrompt(s, id, 'lint');
  assert.equal(f.sig, 'lint');
  assert.ok(f.prompt.includes('src/x.js'));
  assert.equal(reef.fixPrompt(s, id, 'worst').sig, 'lint');
  assert.equal(reef.fixPrompt(s, id, 'deps'), null);
  assert.equal(reef.fixPrompt(s, 'ffffffffffff', 'lint'), null);
  const v = reef.reefView(s, now).projects[0];
  assert.equal(v.worst, 'lint');
  assert.deepEqual(v.signals.map(x => [x.id, x.fixable]), [['lint', true], ['deps', false]]);
  // Cleared by an empty detail; unknown signals ignored; survives normalize.
  assert.equal(reef.normalize(s).projects[id].detail.lint.cmd, 'npm run lint');
  assert.equal(reef.setDetail(s, id, 'lint', {}).projects[id].detail.lint, undefined);
  assert.deepEqual(reef.setDetail(s, id, 'nope', DETAIL.lint), reef.normalize(s));
});
