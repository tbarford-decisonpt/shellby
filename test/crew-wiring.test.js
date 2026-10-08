const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wireCrew } = require('../src/main/wiring/crew');

// What wiring/crew.js reads from main, faked: settings, the panel, a tab whose
// session keeps merged task records the way session.js trackTask does.
function setup() {
  const store = {};
  const sent = [];
  const said = [];
  const awarded = [];
  const d = {
    awardXp: (kind, meta) => awarded.push([kind, meta]),
    config: { get: k => store[k], set: patch => Object.assign(store, patch) },
    send: (_win, channel, payload) => sent.push([channel, payload]),
    sayText: text => said.push(text),
    refreshCritter: () => {},
    panel: {},
  };
  const crew = wireCrew(d);
  const tab = { session: { busy: true, tasks: new Map() } };
  const task = (id, type, status = 'completed', extra = {}) => {
    tab.session.tasks.set(id, { taskId: id, subagentType: type, status, description: `job ${id}`, startedAt: Date.now() - 1000, usage: { tokens: 50, toolUses: 2, durationMs: 900 }, ...extra });
    crew.onItem('tab1', { kind: 'task', phase: 'done', taskId: id }, tab);
  };
  const tool = (name, parent) => crew.onItem('tab1', { kind: 'tool', name, ...(parent ? { parent } : {}) }, tab);
  const result = () => crew.onItem('tab1', { kind: 'result' }, tab);
  const member = type => store.crew?.members?.[type];
  return { d, crew, tab, task, tool, result, member, sent, said, store, awarded };
}

test('a finished helper is recorded once, however many events say so', () => {
  const s = setup();
  s.task('a1', 'code-reviewer');
  s.crew.onItem('tab1', { kind: 'task', phase: 'updated', taskId: 'a1' }, s.tab);
  assert.equal(s.member('code-reviewer').runs, 1);
  assert.equal(s.member('code-reviewer').tokens, 50);
  assert.equal(s.sent.at(-1)[0], 'crew', 'the panel hears about it');
});

test('a running helper is not a run yet, but a new type already has its name', () => {
  const s = setup();
  s.task('a1', 'Explore', 'running');
  assert.equal(s.member('Explore'), undefined, 'a progress event signs nobody up');
  s.crew.onItem('tab1', { kind: 'task', phase: 'started', taskId: 'a1' }, s.tab);
  assert.equal(s.member('Explore').runs, 0);
  const [dressed] = s.crew.dress([{ id: 'a1', tabId: 'tab1', type: 'Explore', label: 'Look' }]);
  assert.equal(dressed.name, s.member('Explore').name, 'its first trip out wears the name');
});

test('Claude editing a file after the helper reported back credits it', () => {
  const s = setup();
  s.task('a1', 'code-reviewer');
  s.tool('Read');
  assert.equal(s.member('code-reviewer').actedOn, 0, 'reading is not acting');
  s.tool('Edit', 'some-subagent-call');
  assert.equal(s.member('code-reviewer').actedOn, 0, "a helper's own edits don't count");
  s.tool('Edit');
  s.tool('Write');
  assert.equal(s.member('code-reviewer').actedOn, 1, 'credited once');
});

test('a find put to use: the helper is named out loud and Shellby earns XP, once', () => {
  const s = setup();
  s.task('a1', 'code-reviewer');
  s.tool('Edit');
  const name = s.member('code-reviewer').name;
  assert.ok(s.said.includes(`${name} found it!`), s.said.join(' | '));
  assert.deepEqual(s.awarded, [['helped', { label: `Put ${name}'s find to use` }]]);
  s.tool('Edit');
  assert.equal(s.awarded.length, 1, 'not again for the same find');
});

test('a failed helper is never acted on', () => {
  const s = setup();
  s.task('a1', 'Explore', 'failed');
  s.tool('Edit');
  assert.deepEqual([s.member('Explore').failed, s.member('Explore').actedOn], [1, 0]);
});

test("the credit window closes with the turn; a background helper's lasts one more", () => {
  const s = setup();
  s.task('a1', 'Explore');
  s.result();
  s.tool('Edit');
  assert.equal(s.member('Explore').actedOn, 0, 'too late: next turn');

  s.tab.session.busy = false; // finished while the tab was idle
  s.task('b1', 'Plan');
  s.result();
  s.tool('Edit');
  assert.equal(s.member('Plan').actedOn, 1, 'carried into the next turn');
});

test('rename and setHat go through and reach the panel', () => {
  const s = setup();
  s.task('a1', 'Explore');
  const v = s.crew.rename('Explore', 'Scout');
  assert.equal(v.members[0].name, 'Scout');
  assert.equal(s.crew.setHat('Explore', 'none').members[0].hat, 'none');
  assert.equal(s.crew.setHat('Explore', 'nonsense').members[0].hat, 'none', 'refused');
});

test('dress gives Shellby-tab helpers their crew look, others pass through', () => {
  const s = setup();
  s.task('a1', 'Explore');
  const [mine, other] = s.crew.dress([{ id: 'x', tabId: 'tab1', type: 'Explore', label: 'Look' }, { id: 'y', tabId: null, type: 'Claude Code', label: 'proj' }]);
  assert.equal(mine.name, s.member('Explore').name);
  assert.equal(mine.level, 1);
  assert.ok(Number.isFinite(mine.hue));
  assert.equal(other.name, undefined);
});

test('a level up is said out loud', () => {
  const s = setup();
  for (let i = 0; i < 6; i++) s.task(`t${i}`, 'Explore');
  assert.ok(s.said.some(t => /made level 2/.test(t)), s.said.join(' | '));
});

test('a run you or Claude called off is no run at all; a failed one is', () => {
  const s = setup();
  s.task('a1', 'Explore', 'stopped');
  s.task('a2', 'Explore', 'killed');
  assert.equal(s.member('Explore'), undefined);
  s.task('a3', 'Explore', 'failed');
  assert.deepEqual([s.member('Explore').runs, s.member('Explore').failed], [1, 1]);
});

test('an untyped helper is a general-purpose crew member, on the desktop too', () => {
  const s = setup();
  s.tab.session.tasks.set('u1', { taskId: 'u1', status: 'running', startedAt: Date.now() });
  s.crew.onItem('tab1', { kind: 'task', phase: 'started', taskId: 'u1' }, s.tab);
  assert.equal(s.store.crew, undefined, 'no type yet: nobody is signed up by guess');
  s.task('u2', undefined);
  const [dressed] = s.crew.dress([{ id: 'u3', tabId: 'tab1', type: 'general-purpose', label: 'x' }]);
  assert.equal(dressed.name, s.member('general-purpose').name);
});

test('dress works the roster out once per change, not once per refresh', () => {
  const s = setup();
  s.task('a1', 'Explore');
  const crew = [{ id: 'x', tabId: 'tab1', type: 'Explore', label: 'Look' }];
  const a = s.crew.dress(crew)[0];
  const b = s.crew.dress(crew)[0];
  assert.equal(a.name, b.name);
  s.crew.rename('Explore', 'Scout');
  assert.equal(s.crew.dress(crew)[0].name, 'Scout', 'a new roster is picked up');
});
