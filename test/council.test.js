const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../src/main/council/prompts');
const R = require('../src/main/council/run');
const L = require('../src/main/council/look');
const { gather, MAX_TOTAL } = require('../src/main/council/context');
const { CouncilStore, MAX_SESSIONS, records, cleanOutcome } = require('../src/main/council/store');
const { planPrompt, noteText, priorNote } = require('../src/main/ipc/council');
const { signInWithoutSettings } = require('../src/main/claude/cli');

const opinion = (vote = 'for') => ({ stance: 'Do it', argument: 'Because [F1].', risks: ['a', 'b', 'c', 'd'], vote, condition: 'if it ships', wouldChange: 'a failing test', cites: [1, 9], confidence: 140 });
const verdict = { decision: 'do', verdict: 'Ship it small.', against: 'It may not be needed.', agree: ['x'], split: ['y'], next: ['z'], open: ['Who uses it?'], cites: [1], confidence: 80 };
const reply = (data, cost = 0.01) => ({ stdout: JSON.stringify({ structured_output: data, total_cost_usd: cost }), stderr: '', timedOut: false });
const schemaOf = args => JSON.parse(args[args.indexOf('--json-schema') + 1]);
const flag = (args, name) => args[args.indexOf(name) + 1];
const OFF = { read: false, pick: false };

// A fake CLI that answers by schema, and records each call.
function fakeRun({ fail = () => false, look = null, pick = ['skeptic', 'tester', 'counter'] } = {}) {
  const calls = [];
  const run = async (args, _t, opts) => {
    calls.push({ args, opts });
    const schema = schemaOf(args);
    const system = flag(args, '--system-prompt');
    if (fail(system, schema)) return { stdout: '', stderr: 'boom', timedOut: true };
    if (schema.properties.facts) return reply(look || { facts: [], unknowns: [], ...(schema.properties.seats ? { seats: pick } : {}) });
    if (schema.properties.seats) return reply({ seats: pick });
    if (schema.properties.opinions) return reply({ opinions: Object.fromEntries(Object.keys(schema.properties.opinions.properties).map(id => [id, opinion()])), chair: verdict });
    if (schema.properties.stance) return reply(opinion(/Skeptic/.test(system) ? 'against' : 'for'));
    if (schema.properties.rebuttals) return reply({ rebuttals: [{ seat: 'skeptic', to: 'builder', reply: 'Fine, conditionally.', vote: 'conditional' }, { seat: 'builder', to: 'builder', reply: 'Still for.', vote: 'for' }, { seat: 'nobody', to: 'x', reply: 'x', vote: 'for' }] });
    return reply(verdict);
  };
  return { run, calls };
}

const tmpProject = () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'council-proj-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# hi\n');
  return root;
};

// ---- settings and seats

test('normalize falls back to the five default seats, Quick on Sonnet, reading and picking on', () => {
  const s = P.normalize(null);
  assert.deepEqual(s.seated, P.DEFAULT_IDS);
  assert.deepEqual([s.mode, s.model, s.read, s.pick], ['quick', 'sonnet', true, true]);
});

test('normalize folds the old Full mode into Debate, and keeps reading and picking off when turned off', () => {
  const s = P.normalize({ mode: 'full', read: false, pick: false });
  assert.deepEqual([s.mode, s.read, s.pick], ['debate', false, false]);
});

test('normalize drops unknown seats, bad custom seats and extra custom seats, and keeps bench seats', () => {
  const custom = [1, 2, 3, 4].map(i => ({ id: `c-a${i}`, name: `N${i}`, brief: 'b', hue: 99 }));
  const s = P.normalize({ seated: ['skeptic', 'ghost', 'c-a1', 'tester'], custom: [...custom, { id: 'bad id', name: 'x', brief: 'y' }], mode: 'loud' });
  assert.deepEqual(s.seated, ['skeptic', 'c-a1', 'tester']);
  assert.equal(s.custom.length, P.MAX_CUSTOM);
  assert.ok(s.custom.every(c => c.hue < P.HUE_COUNT));
  assert.equal(s.mode, 'quick');
});

test('normalize seats the defaults when fewer than the minimum are left', () => {
  assert.deepEqual(P.normalize({ seated: ['skeptic'] }).seated, P.DEFAULT_IDS);
});

test('a pick is used only when it names enough real advisors', () => {
  assert.deepEqual(P.seats({}, ['tester', 'ghost', 'keeper', 'counter']).map(s => s.id), ['tester', 'keeper', 'counter']);
  assert.deepEqual(P.seats({}, ['tester', 'ghost']).map(s => s.id), P.DEFAULT_IDS);
  assert.equal(P.pickedIds({}, ['tester', 'keeper', 'counter', 'elder', 'guard', 'player']).length, P.MAX_PICK);
});

// ---- sittings

test('quick mode makes one call and fills every seat and the chair', async () => {
  const { run, calls } = fakeRun();
  const r = await R.convene({ question: 'Use SQLite?', settings: { mode: 'quick', ...OFF } }, run);
  assert.equal(r.ok, true);
  assert.equal(calls.length, R.callsFor('quick', P.DEFAULT_SEATS.length));
  assert.equal(Object.values(r.opinions).filter(Boolean).length, P.DEFAULT_SEATS.length);
  assert.equal(r.chair.decision, 'do');
  assert.deepEqual(r.chair.open, ['Who uses it?']);
  assert.equal(r.tally.for, P.DEFAULT_SEATS.length);
});

test('every advisor and chair call runs with no tools, no MCP and no session, the question on stdin', async () => {
  const { run, calls } = fakeRun();
  await R.convene({ question: 'Use SQLite?', settings: { mode: 'debate', ...OFF }, lean: ['--setting-sources', ''] }, run);
  for (const { args, opts } of calls) {
    assert.equal(flag(args, '--tools'), '');
    assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-session-persistence'));
    assert.ok(args.includes('--setting-sources'));
    assert.match(opts.input, /Question:\nUse SQLite\?$/);
  }
  // The shared stdin is the same for every call, so the CLI can cache it.
  assert.equal(new Set(calls.map(c => c.opts.input)).size, 1);
});

test('debate runs each seat on the smaller model, a rebuttal round, then the chair', async () => {
  const { run, calls } = fakeRun();
  const r = await R.convene({ question: 'q', settings: { mode: 'debate', model: 'sonnet', ...OFF } }, run);
  assert.equal(calls.length, R.callsFor('debate', P.DEFAULT_SEATS.length));
  const models = calls.map(c => flag(c.args, '--model'));
  assert.deepEqual(models.slice(0, -1), [...P.DEFAULT_SEATS.map(() => 'haiku'), 'haiku']);
  assert.equal(models.at(-1), 'sonnet');
  assert.equal(r.cost.toFixed(2), (calls.length * 0.01).toFixed(2));
});

test('rebuttals keep known seats once, say who they answer, and mark a changed vote', async () => {
  const { run, calls } = fakeRun();
  const r = await R.convene({ question: 'q', settings: { mode: 'debate', ...OFF } }, run);
  assert.deepEqual(Object.keys(r.rebuttals).sort(), ['builder', 'skeptic']);
  assert.deepEqual(r.rebuttals.skeptic, { reply: 'Fine, conditionally.', vote: 'conditional', to: 'builder', changed: true });
  assert.equal(r.rebuttals.builder.to, null); // can't answer yourself
  assert.equal(r.rebuttals.builder.changed, false);
  assert.equal(r.tally.conditional, 1);
  assert.equal(r.tally.against, 0);
  // The chair read the rebuttal, and who it was to.
  assert.match(flag(calls.at(-1).args, '--system-prompt'), /After hearing the others \[conditional\] \(to Builder\)/);
});

test('a seat that times out is left empty and the chair still rules', async () => {
  const { run } = fakeRun({ fail: system => /You are the Guard/.test(system) });
  const events = [];
  const r = await R.convene({ question: 'q', settings: { mode: 'debate', ...OFF } }, run, e => events.push(e));
  assert.equal(r.ok, true);
  assert.equal(r.opinions.guard, null);
  assert.ok(r.chair);
  assert.ok(events.some(e => e.kind === 'spoke' && e.seat === 'guard' && e.opinion === null));
  assert.ok(events.some(e => e.kind === 'thinking' && e.seat === 'chair'));
});

test('no answers at all is an error, not an empty council', async () => {
  const { run } = fakeRun({ fail: () => true });
  const r = await R.convene({ question: 'q', settings: { mode: 'debate', ...OFF } }, run);
  assert.equal(r.ok, false);
});

test('a question that is empty or too long is refused before any call', async () => {
  const { run, calls } = fakeRun();
  assert.equal((await R.convene({ question: '  ' }, run)).ok, false);
  assert.equal((await R.convene({ question: 'x'.repeat(P.MAX_QUESTION + 1) }, run)).ok, false);
  assert.equal(calls.length, 0);
});

// ---- reading the project first

test('the read may only read: three reading tools, unasked, confined to the folder, with a spending cap', () => {
  const args = L.lookArgs({ model: 'opus' });
  assert.ok(args.includes('--restricted') && args.includes('--strict-mcp-config') && args.includes('--no-session-persistence'));
  assert.equal(flag(args, '--tools'), 'Read,Grep,Glob');
  assert.equal(flag(args, '--allowedTools'), 'Read,Grep,Glob');
  assert.equal(flag(args, '--permission-mode'), 'dontAsk');
  assert.equal(flag(args, '--max-budget-usd'), String(L.LOOK_BUDGET_USD));
  assert.equal(flag(args, '--model'), 'sonnet');
});

test('a sitting that reads first runs the read in the project, then argues from the checked facts', async () => {
  const root = tmpProject();
  const look = { facts: [{ claim: 'A is three lines', file: 'src/a.js', line: 2 }, { claim: 'Made up', file: 'nope.js', line: 1 }], unknowns: ['Who uses it'], seats: ['skeptic', 'tester', 'counter'] };
  const { run, calls } = fakeRun({ look });
  const events = [];
  const r = await R.convene({ question: 'Keep A?', settings: { mode: 'quick' }, root, cwd: os.homedir() }, run, e => events.push(e));
  assert.equal(calls.length, R.callsFor('quick', 3, { read: true, pick: true }));
  assert.equal(calls[0].opts.cwd, root);
  assert.ok(calls[0].args.includes('--restricted'));
  assert.deepEqual(r.facts, [{ claim: 'A is three lines', file: 'src/a.js', line: 2 }]);
  assert.equal(r.dropped, 1);
  assert.deepEqual(r.seats.map(s => s.id), ['skeptic', 'tester', 'counter']);
  assert.equal(r.picked, true);
  // Advisors see the facts numbered, and can't cite one that isn't there.
  assert.match(calls[1].opts.input, /\[F1\] A is three lines \(src\/a\.js:2\)/);
  assert.equal(calls[1].opts.cwd, os.homedir());
  assert.deepEqual(r.opinions.skeptic.cites, [1]);
  assert.deepEqual(events.map(e => e.kind).slice(0, 3), ['reading', 'read', 'seated']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a read that fails says why and the council still sits, picking in a call of its own', async () => {
  const root = tmpProject();
  const { run, calls } = fakeRun({ fail: (_s, schema) => !!schema.properties.facts });
  const r = await R.convene({ question: 'q', settings: { mode: 'quick' }, root }, run);
  assert.equal(r.ok, true);
  assert.match(r.readError, /too long/);
  assert.deepEqual(r.facts, []);
  const pick = calls.find(c => schemaOf(c.args).properties.seats && !schemaOf(c.args).properties.facts);
  assert.equal(flag(pick.args, '--tools'), '');
  assert.equal(flag(pick.args, '--model'), 'haiku');
  fs.rmSync(root, { recursive: true, force: true });
});

test('without a project, nothing is read; with picking off, nothing is picked', async () => {
  const { run, calls } = fakeRun();
  const r = await R.convene({ question: 'q', settings: { mode: 'quick', pick: false } }, run);
  assert.equal(calls.length, 1);
  assert.equal(r.picked, false);
  assert.deepEqual(r.seats.map(s => s.id), P.DEFAULT_IDS);
});

test('a pick that names too few real advisors falls back to the saved seating', async () => {
  const { run } = fakeRun({ pick: ['tester', 'ghost'] });
  const r = await R.convene({ question: 'q', settings: { mode: 'quick', read: false } }, run);
  assert.equal(r.picked, false);
  assert.deepEqual(r.seats.map(s => s.id), P.DEFAULT_IDS);
});

test('the read is refused files that hold secrets, and a fact from one is left out', () => {
  const denied = flag(L.lookArgs({ model: 'sonnet' }), '--disallowedTools');
  for (const rule of ['Read(**/.env*)', 'Read(**/*.pem)', 'Read(**/.git/config)']) assert.ok(denied.split(',').includes(rule), rule);
  const root = tmpProject();
  fs.writeFileSync(path.join(root, '.env.local'), 'KEY=1\n');
  const r = L.cleanLook({ facts: [{ claim: 'The key is set', file: '.env.local', line: 1 }, { claim: 'A has a token sk-ant-api03-abcdefghijklmnopqrstuv', file: 'src/a.js', line: 1 }] }, root);
  assert.equal(r.hidden, 1);
  assert.equal(r.facts.length, 1);
  assert.doesNotMatch(r.facts[0].claim, /abcdefghijklmnop/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a read that picks too few advisors is followed by a pick of its own', async () => {
  const root = tmpProject();
  const { run, calls } = fakeRun({ look: { facts: [], unknowns: [], seats: ['tester', 'ghost'] } });
  const r = await R.convene({ question: 'q', settings: { mode: 'quick' }, root }, run);
  assert.equal(calls.length, 3);
  assert.equal(r.picked, true);
  assert.deepEqual(r.seats.map(s => s.id), ['skeptic', 'tester', 'counter']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('characters you can\'t see are taken out of everything the council says', () => {
  const hide = String.fromCodePoint(0x202e) + 'evil' + String.fromCodePoint(0x200b) + String.fromCodePoint(0xe0041);
  assert.equal(P.clip(`Ship ${hide} it`, 100), 'Ship evil it');
  assert.equal(P.cleanQuestion(`Keep${String.fromCodePoint(0x2066)} it?\nYes`), 'Keep it?\nYes');
});

test('the read runs only when Claude Code can sign in without your settings files', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'council-home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const settings = s => fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(s));
  assert.equal(signInWithoutSettings(home), true);
  settings({ env: { MY_HOOK_PROFILE: 'x' }, hooks: {} });
  assert.equal(signInWithoutSettings(home), true);
  for (const s of [{ env: { ANTHROPIC_API_KEY: 'x' } }, { env: { HTTPS_PROXY: 'x' } }, { apiKeyHelper: 'x' }, { forceLoginMethod: 'console' }]) {
    settings(s);
    assert.equal(signInWithoutSettings(home), false, JSON.stringify(s));
  }
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ not json');
  assert.equal(signInWithoutSettings(home), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('checkSource keeps files inside the project and the lines they have', () => {
  const root = tmpProject();
  assert.deepEqual(L.checkSource(root, 'src/a.js', 3), { file: 'src/a.js', line: 3 });
  assert.deepEqual(L.checkSource(root, './src\\a.js', 99), { file: 'src/a.js', line: 0 });
  for (const bad of ['../outside.js', path.join(root, 'README.md'), 'C:/Windows/win.ini', 'src', 'missing.js', '']) assert.equal(L.checkSource(root, bad, 1), null, bad);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a fact through a junction out of the project is dropped', { skip: process.platform !== 'win32' }, () => {
  const root = tmpProject();
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'council-out-')));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
  assert.equal(L.checkSource(root, 'link/secret.txt', 1), null);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

// ---- cleaning answers

test('answers are clipped and cleaned: risks capped, confidence clamped, bad votes made conditional', () => {
  const o = R.cleanOpinion({ ...opinion('maybe'), stance: `a\u0007b${'x'.repeat(500)}` }, 2);
  assert.equal(o.risks.length, 3);
  assert.equal(o.confidence, 100);
  assert.equal(o.vote, 'conditional');
  assert.equal(o.condition, 'if it ships');
  assert.deepEqual(o.cites, [1]);
  assert.ok(!o.stance.includes('\u0007') && o.stance.length <= 120);
  assert.equal(R.cleanOpinion({ stance: '' }), null);
  // A condition only belongs to a conditional vote.
  assert.equal(R.cleanOpinion(opinion('for')).condition, '');
});

test('a verdict with an unknown decision keeps its words but no decision', () => {
  const v = R.cleanVerdict({ ...verdict, decision: 'maybe', cites: [1, 2] }, 1);
  assert.equal(v.decision, null);
  assert.equal(v.verdict, 'Ship it small.');
  assert.deepEqual(v.cites, [1]);
});

test('parse reports a sign-in problem, the spending cap and bad JSON plainly', () => {
  assert.match(R.parse(JSON.stringify({ is_error: true, result: 'Not logged in' })).error, /Sign in/);
  assert.match(R.parse(JSON.stringify({ is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 0.3 })).error, /spending cap/);
  assert.equal(R.parse('nope').ok, false);
});

// ---- the record

const sat = (decision, result, votes, rebut = {}) => ({
  chair: { decision }, outcome: result ? { result } : null,
  opinions: Object.fromEntries(Object.entries(votes).map(([id, vote]) => [id, { vote }])),
  rebuttals: Object.fromEntries(Object.entries(rebut).map(([id, vote]) => [id, { vote }])),
});

test('records count only followed verdicts with a clear result, by each advisor\'s last vote', () => {
  const r = records([
    sat('do', 'worked', { skeptic: 'against', builder: 'for' }),
    sat('do', 'failed', { skeptic: 'against', builder: 'for' }, { builder: 'against' }),
    sat('dont', 'worked', { skeptic: 'against' }),
    sat('do', 'skipped', { skeptic: 'for' }),
    sat('do', null, { skeptic: 'for' }),
    sat(null, 'worked', { skeptic: 'for' }),
    sat('first', 'worked', { skeptic: 'conditional' }),
    sat('do', 'worked', { builder: 'conditional' }),
  ]);
  assert.deepEqual(r.skeptic, { right: 2, of: 3 });
  assert.deepEqual(r.builder, { right: 2, of: 2 });
});

test('the chair is told the record only once there are two verdicts to go on', () => {
  const table = P.seats({});
  assert.doesNotMatch(P.SYSTEM.chair(table, { skeptic: { right: 1, of: 1 } }), /right 1 of 1/);
  assert.match(P.SYSTEM.chair(table, { skeptic: { right: 2, of: 3 } }), /Skeptic: right 2 of 3 times/);
  assert.match(P.SYSTEM.quick(table, { guard: { right: 4, of: 4 } }), /Guard: right 4 of 4/);
});

test('an outcome is one of three, or cleared', () => {
  assert.deepEqual(cleanOutcome({ result: 'worked' }, 5), { result: 'worked', at: 5 });
  assert.deepEqual(cleanOutcome('skipped', 6), { result: 'skipped', at: 6 });
  assert.equal(cleanOutcome({ result: 'great' }, 7), null);
  assert.equal(cleanOutcome(null, 7), null);
});

// ---- turning it into work

test('the plan prompt carries the decision, the case against, the steps, the facts and what is open', () => {
  const s = { question: 'Keep A?', chair: verdict, facts: [{ claim: 'A is short', file: 'src/a.js', line: 2 }] };
  const p = planPrompt(s);
  assert.match(p, /Their decision: Do it\. Ship it small\./);
  assert.match(p, /The strongest case against: It may not be needed\./);
  assert.match(p, /\[F1\] A is short \(src\/a\.js:2\)/);
  assert.match(p, /Still open:\n- Who uses it\?/);
  assert.match(p, /Don't change anything until I approve the plan\./);
  assert.equal(noteText(s), 'Council on "Keep A?": Do it. Ship it small.\n- z');
  assert.equal(priorNote({ ...s, chair: { ...verdict } }), 'Keep A? -> Ship it small. Still open: Who uses it?');
  assert.equal(priorNote(null), '');
});

// ---- context and store

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

test('the store keeps the newest sessions, up to its limit, and updates one in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-store-'));
  const store = new CouncilStore({ dir });
  for (let i = 0; i < MAX_SESSIONS + 3; i++) store.add({ id: `s${i}`, question: `q${i}` });
  const list = store.list();
  assert.equal(list.length, MAX_SESSIONS);
  assert.equal(list[0].id, `s${MAX_SESSIONS + 2}`);
  assert.deepEqual(store.update(list[1].id, { outcome: { result: 'worked', at: 1 } }).outcome, { result: 'worked', at: 1 });
  assert.equal(store.list()[1].outcome.result, 'worked');
  assert.equal(store.update('gone', {}), null);
  store.remove(list[0].id);
  assert.equal(store.get(list[0].id), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
