const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../src/main/council/prompts');
const R = require('../src/main/council/run');
const { gather, MAX_TOTAL } = require('../src/main/council/context');
const { CouncilStore, MAX_SESSIONS } = require('../src/main/council/store');

const opinion = (vote = 'for') => ({ stance: 'Do it', argument: 'Because.', risks: ['a', 'b', 'c', 'd'], vote, confidence: 140 });
const verdict = { verdict: 'Ship it small.', agree: ['x'], split: ['y'], next: ['z'], confidence: 80 };
const reply = (data, cost = 0.01) => ({ stdout: JSON.stringify({ structured_output: data, total_cost_usd: cost }), stderr: '', timedOut: false });
const schemaOf = args => JSON.parse(args[args.indexOf('--json-schema') + 1]);

// A fake CLI that answers by schema, and records each call.
function fakeRun({ fail = () => false } = {}) {
  const calls = [];
  const run = async (args, _t, opts) => {
    calls.push({ args, opts });
    const schema = schemaOf(args);
    const system = args[args.indexOf('--system-prompt') + 1];
    if (fail(system, schema)) return { stdout: '', stderr: 'boom', timedOut: true };
    if (schema.properties.opinions) return reply({ opinions: Object.fromEntries(Object.keys(schema.properties.opinions.properties).map(id => [id, opinion()])), chair: verdict });
    if (schema.properties.stance) return reply(opinion(/Skeptic/.test(system) ? 'against' : 'for'));
    if (schema.properties.rebuttals) return reply({ rebuttals: [{ seat: 'skeptic', reply: 'Fine, conditionally.', vote: 'conditional' }, { seat: 'nobody', reply: 'x', vote: 'for' }] });
    return reply(verdict);
  };
  return { run, calls };
}

test('normalize falls back to the five default seats and quick on Sonnet', () => {
  const s = P.normalize(null);
  assert.deepEqual(s.seated, P.DEFAULT_SEATS.map(x => x.id));
  assert.equal(s.mode, 'quick');
  assert.equal(s.model, 'sonnet');
});

test('normalize drops unknown seats, bad custom seats and extra custom seats', () => {
  const custom = [1, 2, 3, 4].map(i => ({ id: `c-a${i}`, name: `N${i}`, brief: 'b', hue: 99 }));
  const s = P.normalize({ seated: ['skeptic', 'ghost', 'c-a1', 'builder'], custom: [...custom, { id: 'bad id', name: 'x', brief: 'y' }], mode: 'loud' });
  assert.deepEqual(s.seated, ['skeptic', 'c-a1', 'builder']);
  assert.equal(s.custom.length, P.MAX_CUSTOM);
  assert.ok(s.custom.every(c => c.hue < P.HUE_COUNT));
  assert.equal(s.mode, 'quick');
});

test('normalize seats the defaults when fewer than the minimum are left', () => {
  assert.deepEqual(P.normalize({ seated: ['skeptic'] }).seated, P.DEFAULT_SEATS.map(x => x.id));
});

test('quick mode makes one call and fills every seat and the chair', async () => {
  const { run, calls } = fakeRun();
  const r = await R.convene({ question: 'Use SQLite?', settings: { mode: 'quick' } }, run);
  assert.equal(r.ok, true);
  assert.equal(calls.length, R.callsFor('quick', P.DEFAULT_SEATS.length));
  assert.equal(Object.values(r.opinions).filter(Boolean).length, P.DEFAULT_SEATS.length);
  assert.equal(r.chair.verdict, 'Ship it small.');
  assert.equal(r.tally.for, P.DEFAULT_SEATS.length);
});

test('every call runs with no tools, no MCP and no session, the question on stdin', async () => {
  const { run, calls } = fakeRun();
  await R.convene({ question: 'Use SQLite?', settings: { mode: 'full' }, lean: ['--setting-sources', ''] }, run);
  for (const { args, opts } of calls) {
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-session-persistence'));
    assert.ok(args.includes('--setting-sources'));
    assert.match(opts.input, /Question:\nUse SQLite\?$/);
  }
  // The shared stdin is the same for every call, so the CLI can cache it.
  assert.equal(new Set(calls.map(c => c.opts.input)).size, 1);
});

test('full mode runs each seat on the smaller model, then the chair', async () => {
  const { run, calls } = fakeRun();
  const r = await R.convene({ question: 'q', settings: { mode: 'full', model: 'sonnet' } }, run);
  assert.equal(calls.length, R.callsFor('full', P.DEFAULT_SEATS.length));
  const models = calls.map(c => c.args[c.args.indexOf('--model') + 1]);
  assert.deepEqual(models.slice(0, -1), P.DEFAULT_SEATS.map(() => 'haiku'));
  assert.equal(models.at(-1), 'sonnet');
  assert.equal(r.opinions.skeptic.vote, 'against');
  assert.equal(r.cost.toFixed(2), (calls.length * 0.01).toFixed(2));
});

test('debate adds one rebuttal call, ignores unknown seats and recounts the votes', async () => {
  const { run, calls } = fakeRun();
  const r = await R.convene({ question: 'q', settings: { mode: 'debate' } }, run);
  assert.equal(calls.length, R.callsFor('debate', P.DEFAULT_SEATS.length));
  assert.deepEqual(Object.keys(r.rebuttals), ['skeptic']);
  assert.equal(r.tally.conditional, 1);
  assert.equal(r.tally.against, 0);
  // The chair read the rebuttal.
  assert.match(calls.at(-1).args[calls.at(-1).args.indexOf('--system-prompt') + 1], /After hearing the others \[conditional\]/);
});

test('a seat that times out is left empty and the chair still rules', async () => {
  const { run } = fakeRun({ fail: system => /You are the Guard/.test(system) });
  const events = [];
  const r = await R.convene({ question: 'q', settings: { mode: 'full' } }, run, e => events.push(e));
  assert.equal(r.ok, true);
  assert.equal(r.opinions.guard, null);
  assert.ok(r.chair);
  assert.ok(events.some(e => e.kind === 'spoke' && e.seat === 'guard' && e.opinion === null));
  assert.ok(events.some(e => e.kind === 'thinking' && e.seat === 'chair'));
});

test('no answers at all is an error, not an empty council', async () => {
  const { run } = fakeRun({ fail: () => true });
  const r = await R.convene({ question: 'q', settings: { mode: 'full' } }, run);
  assert.equal(r.ok, false);
});

test('a question that is empty or too long is refused before any call', async () => {
  const { run, calls } = fakeRun();
  assert.equal((await R.convene({ question: '  ' }, run)).ok, false);
  assert.equal((await R.convene({ question: 'x'.repeat(P.MAX_QUESTION + 1) }, run)).ok, false);
  assert.equal(calls.length, 0);
});

test('answers are clipped and cleaned: risks capped, confidence clamped, bad votes made conditional', () => {
  const o = R.cleanOpinion({ ...opinion('maybe'), stance: `a\u0007b${'x'.repeat(500)}` });
  assert.equal(o.risks.length, 3);
  assert.equal(o.confidence, 100);
  assert.equal(o.vote, 'conditional');
  assert.ok(!o.stance.includes('\u0007') && o.stance.length <= 120);
  assert.equal(R.cleanOpinion({ stance: '' }), null);
});

test('parse reports a sign-in problem and bad JSON plainly', () => {
  assert.match(R.parse(JSON.stringify({ is_error: true, result: 'Not logged in' })).error, /Sign in/);
  assert.equal(R.parse('nope').ok, false);
});

test('gather keeps the project context under its cap and survives git failing', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'council-')));
  fs.writeFileSync(path.join(root, 'README.md'), 'r'.repeat(10000));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# One\ntext\n## Two\n');
  const text = await gather(root, { read: f => fs.readFileSync(f, 'utf8'), git: async () => { throw new Error('no git'); } });
  assert.ok(text.length <= MAX_TOTAL + 2);
  assert.match(text, /CLAUDE.md sections:\n# One\n## Two/);
  assert.equal(await gather('relative/path', { read: () => '', git: async () => ({}) }), '');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the store keeps the newest sessions, up to its limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-store-'));
  const store = new CouncilStore({ dir });
  for (let i = 0; i < MAX_SESSIONS + 3; i++) store.add({ id: `s${i}`, question: `q${i}` });
  const list = store.list();
  assert.equal(list.length, MAX_SESSIONS);
  assert.equal(list[0].id, `s${MAX_SESSIONS + 2}`);
  store.remove(list[0].id);
  assert.equal(store.get(list[0].id), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
