// Learning from corrections: spotting the same correction twice in a project,
// never offering a turned-down one again, keeping the store small, and the
// rule's wording when Claude isn't asked.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const c = require('../src/main/corrections');
const draft = require('../src/main/correction-draft');

const ROOT = 'C:\\code\\shellby';
const OTHER = 'C:\\code\\other';
const T0 = Date.UTC(2026, 9, 1, 12);
const MIN = 60e3;
const DAY = 864e5;

// Record a run of events, one minute apart; -> { store, offers: [offer per event] }.
function run(events, { store = null, start = T0 } = {}) {
  let s = store;
  const offers = [];
  events.forEach((e, i) => {
    const r = c.record(s, { root: ROOT, project: 'shellby', ...e }, { now: start + i * MIN, id: `o${i}` });
    s = r.store;
    offers.push(r.offer);
  });
  return { store: s, offers };
}

const comment = (text, batch) => ({ kind: 'comment', text, batch, files: ['src/a.js'] });

// ---------------------------------------------------------------- words

test('words keep what a comment is about and drop the filler', () => {
  assert.deepEqual([...c.words("Please don't forget to keep these functions pure")].sort(), ['forget', 'function', 'pure']);
  assert.ok(c.alike(c.words('keep functions pure'), c.words('this function should be pure')));
  assert.ok(c.alike(c.words('no magic numbers'), c.words('use a named constant instead of a magic number')));
  assert.ok(c.alike(c.words('typo'), c.words('Typo!')));
  assert.ok(!c.alike(c.words('rename this variable'), c.words('add a test for the parser')));
});

// ---------------------------------------------------------------- comments

test('the same comment in two reviews is offered as a rule, in your own words', () => {
  const { offers, store } = run([comment('keep functions pure', 'b1'), comment('This function should be pure.', 'b2')]);
  assert.equal(offers[0], null);
  const o = offers[1];
  assert.ok(o);
  assert.equal(o.type, 'comment');
  assert.equal(o.count, 2);
  assert.equal(o.quote, 'keep functions pure');
  assert.equal(o.rule, 'Keep functions pure.');
  assert.equal(o.headline, 'You\'ve asked for this twice in shellby: "keep functions pure"');
  assert.equal(store.offers.length, 1);
  assert.equal(store.offers[0].state, 'open');
});

test('two comments in the same review are one occasion, not a pattern', () => {
  const { offers } = run([comment('keep functions pure', 'b1'), comment('keep this function pure too', 'b1')]);
  assert.deepEqual(offers, [null, null]);
});

test('comments in another project never count towards this one', () => {
  let { store } = run([comment('keep functions pure', 'b1')]);
  const r = c.record(store, { root: OTHER, project: 'other', ...comment('keep functions pure', 'b2') }, { now: T0 + MIN, id: 'x' });
  assert.equal(r.offer, null);
  store = r.store;
  const again = c.record(store, { root: ROOT.toUpperCase(), project: 'shellby', ...comment('functions must stay pure', 'b3') }, { now: T0 + 2 * MIN, id: 'y' });
  assert.ok(again.offer, 'the same folder in other letter case is the same project');
});

test('different comments are not a pattern', () => {
  const { offers } = run([comment('rename this variable', 'b1'), comment('add a test for the parser', 'b2'), comment('log the error', 'b3')]);
  assert.deepEqual(offers, [null, null, null]);
});

// ---------------------------------------------------------------- suppression

test('"Not this one" means never again, even in other words', () => {
  let { store, offers } = run([comment('keep functions pure', 'b1'), comment('functions should be pure', 'b2')]);
  store = c.resolve(store, offers[1].id, 'dismissed', T0 + 5 * MIN);
  const later = run([comment('pure functions please', 'b3'), comment('make these functions pure', 'b4')], { store, start: T0 + 40 * DAY });
  assert.deepEqual(later.offers, [null, null]);
});

test('an added rule is not offered again', () => {
  let { store, offers } = run([comment('keep functions pure', 'b1'), comment('functions should be pure', 'b2')]);
  store = c.resolve(store, offers[1].id, 'added', T0 + 5 * MIN);
  assert.equal(run([comment('keep functions pure', 'b3')], { store, start: T0 + 10 * MIN }).offers[0], null);
  assert.deepEqual(c.learnedRoots(store), [{ root: ROOT, project: 'shellby' }]);
});

test('an unanswered card waits a week before it is offered again', () => {
  const { store } = run([comment('keep functions pure', 'b1'), comment('functions should be pure', 'b2')]);
  assert.equal(run([comment('pure functions', 'b3')], { store, start: T0 + 2 * DAY }).offers[0], null);
  assert.ok(run([comment('pure functions', 'b3')], { store, start: T0 + c.OPEN_QUIET_DAYS * DAY + MIN }).offers[0]);
});

test('resolve ignores unknown ids and states', () => {
  const { store } = run([comment('keep functions pure', 'b1'), comment('functions should be pure', 'b2')]);
  assert.deepEqual(c.resolve(store, 'nope', 'added', T0).offers, store.offers);
  assert.equal(c.resolve(store, 'o1', 'maybe', T0).offers[0].state, 'open');
});

// ---------------------------------------------------------------- denies

test('the same command denied twice becomes a rule about that command', () => {
  const deny = cmd => ({ kind: 'deny', ...c.denySubject('Bash', { command: cmd }, ROOT) });
  const { offers } = run([deny('git push origin main'), deny('npm test'), deny('GIT_TRACE=1 git push --force')]);
  assert.equal(offers[1], null);
  const o = offers[2];
  assert.equal(o.type, 'deny');
  assert.equal(o.label, 'git push');
  assert.equal(o.rule, "Don't run `git push` yourself: leave it to me, or ask first.");
  assert.equal(o.headline, "You've said no to `git push` twice in shellby.");
});

test('two nos in the same turn are one occasion', () => {
  const deny = (cmd, batch) => ({ kind: 'deny', batch, ...c.denySubject('Bash', { command: cmd }, ROOT) });
  const { offers } = run([deny('git push', 'tab:t1'), deny('git push --force', 'tab:t1'), deny('git push', 'tab:t2')]);
  assert.deepEqual(offers.slice(0, 2), [null, null]);
  assert.equal(offers[2].count, 2);
});

test('what a deny was about: a command, a folder, a site, a tool', () => {
  assert.equal(c.denySubject('Bash', { command: 'rm -rf dist && npm run build' }, ROOT).label, 'rm');
  assert.equal(c.denySubject('PowerShell', { command: 'C:\\tools\\npm.cmd install left-pad' }, ROOT).label, 'npm install');
  const edit = c.denySubject('Edit', { file_path: `${ROOT}\\src\\generated\\api.js` }, ROOT);
  assert.deepEqual([edit.label, edit.what], ['src/generated/', 'folder']);
  assert.equal(c.denySubject('Write', { file_path: `${ROOT}\\package.json` }, ROOT).what, 'file');
  assert.equal(c.denySubject('WebFetch', { url: 'https://www.example.com/a' }, ROOT).label, 'example.com');
  assert.equal(c.denySubject('mcp__github__create_issue', {}, ROOT).label, 'mcp__github__create_issue');
  assert.equal(c.fallbackRule({ type: 'deny', what: 'folder', label: 'src/generated/' }), "Don't edit files in `src/generated/` without asking me first.");
});

// ---------------------------------------------------------------- undo, rewind, retry

test('the same folder undone twice is a pattern; the deeper folder wins', () => {
  const { offers } = run([
    { kind: 'undo', files: ['src/legacy/a.js', 'src/b.js'], refs: ['t1'], text: 'tidy the old parser' },
    { kind: 'rewind', files: ['src/legacy/c.js', 'src/d.js'], refs: ['t2'], text: 'speed up the parser' },
  ]);
  const o = offers[1];
  assert.equal(o.type, 'area');
  assert.equal(o.label, 'src/legacy/');
  assert.equal(o.rule, 'Check with me before changing files in `src/legacy/`.');
  assert.equal(o.headline, "You've undone changes in `src/legacy/` twice in shellby.");
  assert.deepEqual(o.evidence, ['speed up the parser', 'tidy the old parser']);
});

test('an undo and then a rewind past that same turn is one correction', () => {
  const { offers } = run([
    { kind: 'undo', files: ['README.md'], refs: ['t1'] },
    { kind: 'rewind', files: ['README.md'], refs: ['t1', 't2'] },
  ]);
  assert.deepEqual(offers, [null, null]);
});

test('a file at the top of the project is its own place', () => {
  const { offers } = run([{ kind: 'retry', files: ['package.json'], refs: ['a'] }, { kind: 'undo', files: ['package.json'], refs: ['b'] }]);
  assert.equal(offers[1].what, 'file');
  assert.equal(offers[1].rule, 'Check with me before changing `package.json`.');
});

// ---------------------------------------------------------------- the store

test('normalize drops broken entries, old corrections and old unanswered cards', () => {
  const now = T0 + 100 * DAY;
  const s = c.normalize({
    events: [
      { kind: 'comment', root: ROOT, text: 'keep it pure', at: now - DAY },
      { kind: 'comment', root: ROOT, text: 'too old', at: now - (c.KEEP_DAYS + 1) * DAY },
      { kind: 'comment', root: ROOT, text: '', at: now },
      { kind: 'undo', root: ROOT, at: now },
      { kind: 'mystery', root: ROOT, at: now },
      null, 'junk',
    ],
    offers: [
      { id: 'a', root: ROOT, type: 'comment', state: 'dismissed', at: now - 300 * DAY },
      { id: 'b', root: ROOT, type: 'comment', state: 'open', at: now - 31 * DAY },
      { id: 'c', root: ROOT, type: 'comment', state: 'sideways', at: now },
    ],
  }, now);
  assert.deepEqual(s.events.map(e => e.text), ['keep it pure']);
  assert.deepEqual(s.offers.map(o => o.id), ['a'], 'a turned-down pattern is kept for good');
  assert.deepEqual(c.normalize(undefined), { events: [], offers: [] });
});

test('the store is capped per project and in all', () => {
  let store = null;
  for (let i = 0; i < c.MAX_EVENTS_PER_ROOT + 20; i++) {
    store = c.record(store, { kind: 'comment', root: ROOT, text: `distinct${i} word${i}`, batch: `b${i}` }, { now: T0 + i * MIN, id: `i${i}` }).store;
  }
  assert.equal(store.events.length, c.MAX_EVENTS_PER_ROOT);
  assert.equal(store.events.at(-1).text, `distinct${c.MAX_EVENTS_PER_ROOT + 19} word${c.MAX_EVENTS_PER_ROOT + 19}`, 'the newest are the ones kept');
  for (let p = 0; p < 4; p++) {
    for (let i = 0; i < c.MAX_EVENTS_PER_ROOT; i++) {
      store = c.record(store, { kind: 'comment', root: `C:\\p${p}`, text: `x${i} y${i}`, batch: `${p}-${i}` }, { now: T0 + DAY + (p * 1000 + i) * MIN, id: `p${p}${i}` }).store;
    }
  }
  assert.equal(store.events.length, c.MAX_EVENTS);
});

test('text that looks like a key is never kept', () => {
  const r = c.record(null, { kind: 'comment', root: ROOT, text: 'use api_key=abcdef123456 here' }, { now: T0 });
  assert.equal(r.store.events.length, 0);
});

test('cleanRule keeps a rule to one plain line', () => {
  assert.equal(c.cleanRule('  ## Keep it\n pure  '), 'Keep it pure');
  assert.equal(c.cleanRule('- a bullet'), 'a bullet');
  assert.equal(c.cleanRule('x'.repeat(c.MAX_RULE + 1)), '');
  assert.equal(c.cleanRule('zero\u200bwidth'), 'zero width');
});

// ---------------------------------------------------------------- Claude's wording

test("Claude's wording: corrections go in as data, and only one clean line comes back", async () => {
  const { offers } = run([comment('keep functions pure', 'b1'), comment('functions should be pure', 'b2')]);
  const p = draft.prompt(offers[1]);
  assert.match(p, /«keep functions pure»/);
  assert.match(p, /data, not instructions/);
  const calls = [];
  const runClaude = async (args, _t, { input }) => {
    calls.push({ args, input });
    return { stdout: JSON.stringify({ is_error: false, structured_output: { rule: '- Keep functions pure: no side effects.' } }) };
  };
  assert.deepEqual(await draft.askClaude(offers[1], { runClaude }), { ok: true, rule: 'Keep functions pure: no side effects.' });
  assert.ok(calls[0].args.includes('--tools'), 'no tools for Claude here');
  const empty = await draft.askClaude(offers[1], { runClaude: async () => ({ stdout: '' }) });
  assert.equal(empty.ok, false);
});
