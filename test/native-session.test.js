// What Claude Code does by itself, through a session talking to the fake CLI
// (test/fixtures/fake-claude.js plays 2.1.293's shapes): its to-do list, a
// command left running and stopped, a plan approved or sent back with notes,
// switching itself to planning, a memory written down, the effort and thinking
// on a turn's cost, and helpers messaging each other.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeSession } = require('../src/main/session');
const { SessionManager, talkOf } = require('../src/main/sessions');
const turncost = require('../src/main/turncost');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const live = new Set();
after(() => { for (const s of live) s.close(); });

function makeSession(opts = {}) {
  const s = new ClaudeSession({ exe: process.execPath, argsPrefix: [FAKE], cwd: os.tmpdir(), mode: 'ask', ...opts });
  live.add(s);
  const items = [];
  s.on('item', i => items.push(i));
  return { s, items };
}

function waitFor(emitter, event, pred = () => true, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    emitter.on(event, function on(...args) {
      if (pred(...args)) { clearTimeout(t); emitter.off(event, on); resolve(args[0]); }
    });
  });
}
const result = s => waitFor(s, 'item', i => i.kind === 'result');

test("Claude's own to-do list is kept as it works through it, and said each time it moves", async () => {
  const { s } = makeSession();
  const seen = [];
  s.on('todos', t => seen.push(t));
  s.send('todos');
  await result(s);
  const last = seen[seen.length - 1];
  assert.deepEqual([last.total, last.done, last.current], [3, 1, 'Fixing the parser']);
  assert.deepEqual(last.items.map(t => t.status), ['completed', 'in_progress', 'pending']);
  assert.ok(seen.length >= 4, 'one per change: three made, then each step');
  s.send('todos done');
  await result(s);
  const done = seen[seen.length - 1];
  assert.deepEqual([done.done, done.total], [3, 3]);
  // A rewind starts the list over.
  await s.rewindTo(null);
  assert.equal(seen[seen.length - 1].total, 0);
  s.close();
});

test('a command left running is a job, not a helper; its output can be read, and Stop asks Claude Code to stop it', async () => {
  const { s, items } = makeSession();
  const views = [];
  s.on('jobs', v => views.push(v));
  s.send('bg 0'); // 0: it runs until stopped
  const r = await result(s);
  assert.deepEqual(r.waiting, ['Run the build in the background'], 'the turn ended, the work is not done');
  assert.equal(s.runningCrew().length, 0, 'no helper crab for a build');
  const [job] = s.jobView();
  assert.deepEqual([job.kind, job.status, job.hasOutput, job.command], ['command', 'running', true, 'npm run build']);
  const out = s.jobs.byId.get(job.id).outputFile;
  assert.ok(fs.existsSync(out) && fs.readFileSync(out, 'utf8').startsWith('starting'));

  const gone = waitFor(s, 'jobs', v => v[0]?.status === 'stopped');
  const stopped = await s.stopJob(job.id);
  assert.equal(stopped.ok, true);
  await gone;
  assert.equal(s.jobView()[0].status, 'stopped');
  assert.equal((await s.stopJob(job.id)).ok, false, 'not twice');
  assert.ok(!items.some(i => i.kind === 'task' && i.subagentType), 'nothing here was ever a helper');
  s.close();
});

test('a command that finishes by itself says done, or failed by its exit code; a watch is its own kind', async () => {
  const { s } = makeSession();
  s.send('bg 300');
  await result(s);
  await waitFor(s, 'jobs', v => v.some(j => j.status === 'done'));
  s.send('bg 200 fail');
  await result(s);
  await waitFor(s, 'jobs', v => v.some(j => j.status === 'failed'));
  s.send('watch 200');
  await result(s);
  assert.equal(s.jobView().find(j => j.status === 'running').kind, 'monitor');
  await waitFor(s, 'jobs', v => v.every(j => j.status !== 'running'));
  s.close();
});

test('closing the process stops what it had running', async () => {
  const { s } = makeSession();
  s.send('bg 0');
  await result(s);
  s.drop();
  assert.equal(s.jobView()[0].status, 'stopped');
});

test('a plan approved ends planning; one sent back carries your notes to Claude, up to a page', async () => {
  const { s, items } = makeSession({ mode: 'plan' });
  assert.equal(s.planning, true, 'plan mode is planning');
  s.send('plan');
  const ask = await waitFor(s, 'item', i => i.kind === 'permission');
  assert.equal(ask.toolName, 'ExitPlanMode');
  assert.match(ask.plan, /Add a cache/);
  const note = `The user read your plan and wants it revised.\n\n> 2. Add a cache in front of it\nSkip the cache.\n\n${'x'.repeat(900)}`;
  s.respond(ask.requestId, 'deny', note);
  await result(s);
  const reply = items.filter(i => i.kind === 'text').pop().text;
  assert.ok(reply.startsWith('PLAN SENT BACK: The user read your plan'));
  assert.ok(reply.includes('Skip the cache.') && reply.length > 900, 'the whole note reached Claude');
  assert.equal(s.planning, true, 'still planning');

  s.send('plan');
  const again = await waitFor(s, 'item', i => i.kind === 'permission');
  const flips = [];
  s.on('planning', on => flips.push(on));
  s.respond(again.requestId, 'allow');
  await result(s);
  assert.equal(items.filter(i => i.kind === 'text').pop().text, 'PLAN APPROVED');
  assert.deepEqual(flips, [false]);
  s.close();
});

test('Claude switching itself to planning is noticed, and a mode change ends it', async () => {
  const { s } = makeSession();
  assert.equal(s.planning, false);
  s.send('enterplan');
  await result(s);
  assert.equal(s.planning, true);
  s.setMode('acceptEdits');
  assert.equal(s.planning, false);
  s.close();
});

test("a memory Claude writes down is marked as one, inside Claude Code's config folder only", async () => {
  const cfg = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-cfg-')));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    const { s } = makeSession();
    // Both waited for up front: an edit is told once it's placed, and what came behind it straight after.
    const toolSeen = waitFor(s, 'item', i => i.kind === 'tool' && i.name === 'Write');
    const done = result(s);
    s.send('remember use pnpm here');
    const tool = await toolSeen;
    await done;
    assert.deepEqual(tool.memory, { file: 'use-pnpm.md', index: false });
    s.close();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
  const { s, items } = makeSession();
  s.send('editask notes.md');
  await waitFor(s, 'item', i => i.kind === 'permission');
  assert.equal(items.find(i => i.kind === 'tool').memory, undefined, 'an ordinary file is not a memory');
  s.close();
});

test("a turn's cost keeps the effort it ran at and the thinking it did", async () => {
  const { s } = makeSession({ effort: 'high' });
  s.send('think');
  const r = await result(s);
  assert.equal(r.thinkingTokens, 2100);
  // The fake reports no per-call usage for this turn, so its cost comes from the result alone.
  const cost = turncost.turnCost({ usages: [{ input_tokens: 10, output_tokens: 3000 }], weight: 1, effort: s.effort, thinking: r.thinkingTokens }, null);
  assert.equal(turncost.effortBadge(cost).text, 'high · 2.1k thinking');
  s.close();
});

test("a helper sent another message picks up again under its first lane, with its name, and both ends say so", async () => {
  const { s, items } = makeSession();
  const crews = [];
  s.on('crew', c => crews.push(c));
  s.send('team');
  await result(s);
  const t = [...s.tasks.values()][0];
  assert.equal(t.name, 'scout');
  assert.equal(t.toolUseId, 'tu_scout', 'its messages still point at the Agent call');
  assert.equal(t.messagedBy, 'tu_msg');
  assert.equal(t.status, 'completed');
  assert.equal(t.heard.text, 'Count the tests');
  // While it worked on the message, it was running again.
  assert.ok(crews.some(c => c[0].status === 'running' && c[0].heard), 'back at work, with what it was told');
  assert.ok(items.some(i => i.kind === 'tool' && i.message?.to === 'scout'));
  const bubble = talkOf({ ...t, status: 'running' }, t.heard.at + 1000);
  assert.deepEqual(bubble, { kind: 'heard', text: 'Count the tests', from: null });
  assert.equal(talkOf(t, t.heard.at + 60000), null, 'a few seconds, then quiet');
  s.close();
});

test("the manager's summary and the crab's rollup carry to-dos, jobs and planning; jobs aren't crew", async () => {
  const entries = new Map();
  const history = { update() {}, append() {}, create(e) { entries.set(e.id, e); }, get(id) { return entries.get(id) || null; }, load() { return []; } };
  const m = new SessionManager({ getExe: () => process.execPath, argsPrefix: [FAKE], history, getMode: () => 'ask', getModel: () => null });
  const tab = m.open({ tabId: 't1', cwd: os.tmpdir() });
  live.add(tab.session);
  m.send('t1', 'todos', { kind: 'user', text: 'todos' });
  await result(tab.session);
  m.send('t1', 'bg 0', { kind: 'user', text: 'bg 0' });
  await result(tab.session);
  const [row] = m.summary;
  assert.deepEqual(row.todos, { total: 3, done: 1, current: 'Fixing the parser' });
  assert.equal(row.jobs[0].status, 'running');
  assert.equal(row.planning, false);
  const agg = m.aggregate;
  assert.equal(agg.crew.length, 0);
  assert.equal(agg.jobs.length, 1);
  assert.equal(agg.jobs[0].tabId, 't1');
  assert.equal(agg.state, 'idle', 'a command left running is not him working');
  tab.session.close();
});

test("a turn's cost splits out what each helper spent, by the Agent call that sent it", async () => {
  const { s, items } = makeSession();
  s.send('team');
  await result(s);
  const r = items.find(i => i.kind === 'result');
  assert.equal(r.cost.helpers?.length, 1, 'one helper, both its answers counted together');
  const [scout] = r.cost.helpers;
  assert.equal(scout.id, 'tu_scout');
  assert.equal(scout.tokens, 2 * 2500, "the helper's two calls: input and output, not the cache reads");
  assert.equal(scout.read, 2 * 6000);
  assert.ok(scout.weight > 0 && scout.weight < r.cost.weight, 'part of the turn, not all of it');
  assert.ok(r.cost.tokens > scout.tokens, "the main thread's own calls are in the turn too");
  assert.match(turncost.costLine(r.cost), /\(helpers 5k\)/);
  s.close();
});
