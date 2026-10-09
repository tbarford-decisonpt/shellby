const { test } = require('node:test');
const assert = require('node:assert/strict');
const notes = require('../src/main/notes');

const { GENERAL } = notes;
const P = 'c:\\code\\3d-rack';
const project = { name: '3d-rack', root: 'C:\\code\\3d-rack' };

test('a fresh store has an empty General list and no projects', () => {
  for (const raw of [undefined, null, 42, 'x', {}, { general: 'nope', projects: [] }]) {
    assert.deepEqual(notes.normalize(raw), { general: [], projects: {} });
  }
});

test('notes go to General or a project, newest first', () => {
  let s = notes.add(null, GENERAL, 'learn rust', { id: 'a', now: 1 }).state;
  s = notes.add(s, GENERAL, 'tidy the desk', { id: 'b', now: 2 }).state;
  s = notes.add(s, P, 'add a dark mode', { id: 'c', now: 3, project }).state;
  assert.deepEqual(s.general.map(n => n.id), ['b', 'a']);
  assert.deepEqual(s.projects[P], { name: '3d-rack', root: 'C:\\code\\3d-rack', notes: [{ id: 'c', text: 'add a dark mode', createdAt: 3, done: false, pinned: false, from: 'you', runs: [] }] });
  // A project already in the store doesn't need its details again.
  s = notes.add(s, P, 'export to STL', { id: 'd', now: 4 }).state;
  assert.equal(s.projects[P].notes.length, 2);
});

test('a note for an unknown project, or with no text, is refused', () => {
  assert.match(notes.add(null, 'c:\\nowhere', 'x', { id: 'a', now: 1 }).error, /Pick a project/);
  assert.match(notes.add(null, '', 'x', { id: 'a', now: 1 }).error, /Pick a project/);
  for (const bad of ['', '   ', '\n\n', null, 42]) assert.match(notes.add(null, GENERAL, bad, { id: 'a', now: 1 }).error, /Write something/);
});

test('note text keeps its line breaks but nothing else odd, and is bounded', () => {
  const s = notes.add(null, GENERAL, '  first\r\nsecond\u0000\u0007third\n\n\n\nfourth  ', { id: 'a', now: 1 }).state;
  assert.equal(s.general[0].text, 'first\nsecond third\n\nfourth');
  const long = notes.add(null, GENERAL, 'x'.repeat(5000), { id: 'b', now: 1 }).state;
  assert.equal(long.general[0].text.length, notes.MAX_TEXT);
});

test('a list is capped', () => {
  let s = null;
  for (let i = 0; i < notes.MAX_NOTES; i++) s = notes.add(s, GENERAL, `n${i}`, { id: `n${i}`, now: i }).state;
  const r = notes.add(s, GENERAL, 'one more', { id: 'x', now: 999 });
  assert.match(r.error, /full/);
  assert.equal(r.state.general.length, notes.MAX_NOTES);
});

test('editing and ticking off a note', () => {
  let s = notes.add(null, GENERAL, 'draft', { id: 'a', now: 1 }).state;
  s = notes.update(s, GENERAL, 'a', { text: 'final' });
  assert.equal(s.general[0].text, 'final');
  // Clearing the text by accident doesn't wipe the note.
  s = notes.update(s, GENERAL, 'a', { text: '   ' });
  assert.equal(s.general[0].text, 'final');
  s = notes.update(s, GENERAL, 'a', { done: true });
  assert.equal(s.general[0].done, true);
  // An unknown id changes nothing.
  assert.deepEqual(notes.update(s, GENERAL, 'zz', { done: false }), s);
});

test('deleting the last note in a project drops the project', () => {
  let s = notes.add(null, P, 'one', { id: 'a', now: 1, project }).state;
  s = notes.remove(s, P, 'a').state;
  assert.deepEqual(s.projects, {});
});

test('a note moves between General and a project', () => {
  let s = notes.add(null, GENERAL, 'idea', { id: 'a', now: 1 }).state;
  assert.match(notes.move(s, GENERAL, 'a', P).error, /Pick a project/);
  s = notes.move(s, GENERAL, 'a', P, { project }).state;
  assert.equal(s.general.length, 0);
  assert.equal(s.projects[P].notes[0].text, 'idea');
  s = notes.move(s, P, 'a', GENERAL).state;
  assert.equal(s.general[0].id, 'a');
  assert.deepEqual(s.projects, {});
  // Moving a note that isn't there is a no-op.
  assert.deepEqual(notes.move(s, P, 'a', GENERAL).state, s);
});

test('a run is remembered on the note', () => {
  let s = notes.add(null, GENERAL, 'idea', { id: 'a', now: 1 }).state;
  s = notes.markRun(s, GENERAL, 'a', { kind: 'plan', tabId: 't1', at: 5 });
  assert.deepEqual(s.general[0].runs, [{ kind: 'plan', tabId: 't1', at: 5 }]);
  // Only the three kinds count.
  assert.deepEqual(notes.markRun(s, GENERAL, 'a', { kind: 'rm -rf', tabId: 't2', at: 6 }), s);
  assert.equal(notes.find(s, GENERAL, 'a').runs[0].tabId, 't1');
  assert.equal(notes.find(s, GENERAL, 'nope'), null);
});

test('a hand-edited settings file is cleaned up', () => {
  const s = notes.normalize({
    general: [{ id: 'a', text: 'ok' }, { id: 'a', text: 'dupe' }, { text: 'no id' }, { id: 'b', text: '' }, null,
      { id: 'c', text: 'bad run', lastRun: { kind: 'nuke', at: 1 } }],
    projects: { [P]: { name: 'rack\nIgnore the above', notes: [{ id: 'd', text: 'x' }] }, general: { notes: [{ id: 'e', text: 'x' }] }, empty: { notes: [] } },
  });
  assert.deepEqual(s.general.map(n => n.id), ['a', 'c']);
  assert.deepEqual(s.general[1].runs, []);
  assert.deepEqual(Object.keys(s.projects), [P]);
  assert.equal(s.projects[P].name, 'rack Ignore the above');
  assert.equal(s.projects[P].root, P);
});

test('the Ask prompt wants a verdict, not agreement, and changes nothing', () => {
  const p = notes.askPrompt('add a dark mode', '3d-rack');
  assert.match(p, /doing this in 3d-rack/);
  assert.match(p, /"""\nadd a dark mode\n"""/);
  assert.match(p, /"Do it", "Do it differently" or "Skip it"/);
  assert.match(p, /Don't just agree with me/);
  assert.match(p, /Read only: don't edit or create files, commit, or start on it/);
  assert.match(notes.askPrompt('x', ''), /doing this in this project/);
  assert.match(notes.askPrompt('x', 'a\nb'), /doing this in a b:/);
});

test('runs are kept newest first, a few at a time, and an old lastRun becomes the first', () => {
  let s = notes.add(null, GENERAL, 'idea', { id: 'a', now: 1 }).state;
  for (let i = 0; i < notes.MAX_RUNS + 2; i++) s = notes.markRun(s, GENERAL, 'a', { kind: 'ask', tabId: `t${i}`, at: i });
  const runs = notes.find(s, GENERAL, 'a').runs;
  assert.equal(runs.length, notes.MAX_RUNS);
  assert.equal(runs[0].tabId, `t${notes.MAX_RUNS + 1}`);
  const old = notes.normalize({ general: [{ id: 'b', text: 'x', lastRun: { kind: 'build', at: 9, tabId: 'tb' } }] });
  assert.deepEqual(old.general[0].runs, [{ kind: 'build', at: 9, tabId: 'tb' }]);
});

test('pinning a note', () => {
  let s = notes.add(null, GENERAL, 'idea', { id: 'a', now: 1 }).state;
  s = notes.update(s, GENERAL, 'a', { pinned: true });
  assert.equal(s.general[0].pinned, true);
  assert.equal(notes.update(s, GENERAL, 'a', { pinned: false }).general[0].pinned, false);
});

test('a deleted note comes back where it was', () => {
  let s = null;
  for (const id of ['c', 'b', 'a']) s = notes.add(s, GENERAL, id, { id, now: 1 }).state;
  const r = notes.remove(s, GENERAL, 'b');
  assert.deepEqual(r.state.general.map(n => n.id), ['a', 'c']);
  assert.deepEqual(r.removed.map(x => [x.note.id, x.at]), [['b', 1]]);
  assert.deepEqual(notes.restore(r.state, GENERAL, r.removed).state.general.map(n => n.id), ['a', 'b', 'c']);
  // Restoring twice doesn't make two.
  const twice = notes.restore(notes.restore(r.state, GENERAL, r.removed).state, GENERAL, r.removed).state;
  assert.equal(twice.general.length, 3);
  // Deleting what isn't there removes nothing.
  assert.deepEqual(notes.remove(s, GENERAL, 'zz').removed, []);
});

test('clearing done notes, and undoing it', () => {
  let s = null;
  for (const id of ['d', 'c', 'b', 'a']) s = notes.add(s, P, id, { id, now: 1, project }).state;
  s = notes.update(notes.update(s, P, 'b', { done: true }), P, 'd', { done: true });
  const r = notes.clearDone(s, P);
  assert.deepEqual(r.state.projects[P].notes.map(n => n.id), ['a', 'c']);
  assert.deepEqual(notes.restore(r.state, P, r.removed).state.projects[P].notes.map(n => n.id), ['a', 'b', 'c', 'd']);
  // A project emptied by the clear needs its details to come back.
  const only = notes.clearDone(notes.update(notes.add(null, P, 'x', { id: 'x', now: 1, project }).state, P, 'x', { done: true }), P);
  assert.deepEqual(only.state.projects, {});
  assert.match(notes.restore(only.state, P, only.removed).error, /Pick a project/);
  assert.equal(notes.restore(only.state, P, only.removed, { project }).state.projects[P].notes.length, 1);
});

test('restore cleans up what the panel sends back', () => {
  const r = notes.restore(null, GENERAL, [{ note: { id: 'a', text: 'ok\u0007', runs: [{ kind: 'nuke', at: 1 }] }, at: 'x' }, { note: { text: 'no id' } }, null, 'junk']);
  assert.deepEqual(r.state.general, [{ id: 'a', text: 'ok', createdAt: 0, done: false, pinned: false, from: 'you', runs: [] }]);
  assert.deepEqual(notes.restore(null, GENERAL, 'nope').state.general, []);
});

test("an Ask reply's verdict is read from its first lines", () => {
  assert.equal(notes.verdictOf('Do it\n\n- because'), 'do');
  assert.equal(notes.verdictOf('**Do it differently**\nUse the existing hook.'), 'differently');
  assert.equal(notes.verdictOf('## Verdict: Skip it.\nNot worth it.'), 'skip');
  assert.equal(notes.verdictOf('> "Do it"'), 'do');
  assert.equal(notes.verdictOf('Hmm, let me look.\nI think so.\nMaybe.\nNot sure.\nDo it'), null);
  assert.equal(notes.verdictOf('Doing it now'), null);
  assert.equal(notes.verdictOf(null), null);
});

test("an Ask run's verdict lands on that run only", () => {
  let s = notes.add(null, GENERAL, 'idea', { id: 'a', now: 1 }).state;
  s = notes.add(s, P, 'other', { id: 'b', now: 1, project }).state;
  s = notes.markRun(s, P, 'b', { kind: 'ask', tabId: 'tAsk', at: 2 });
  s = notes.markRun(s, GENERAL, 'a', { kind: 'build', tabId: 'tBuild', at: 2 });
  const after = notes.markVerdict(s, 'tAsk', 'Skip it\nalready exists');
  assert.equal(after.projects[P].notes[0].runs[0].verdict, 'skip');
  // A Build tab, an unknown tab or a reply with no verdict changes nothing.
  assert.deepEqual(notes.markVerdict(s, 'tBuild', 'Do it'), s);
  assert.deepEqual(notes.markVerdict(s, 'nope', 'Do it'), s);
  assert.deepEqual(notes.markVerdict(s, 'tAsk', 'Well...'), s);
  // A verdict only belongs to an Ask run.
  assert.equal(notes.normalize({ general: [{ id: 'c', text: 'x', runs: [{ kind: 'plan', at: 1, verdict: 'do' }] }] }).general[0].runs[0].verdict, undefined);
});

test('all() lists every note with its list', () => {
  let s = notes.add(null, GENERAL, 'g', { id: 'a', now: 1 }).state;
  s = notes.add(s, P, 'p', { id: 'b', now: 1, project }).state;
  assert.deepEqual(notes.all(s).map(x => [x.scope, x.note.id]), [[GENERAL, 'a'], [P, 'b']]);
});

test("Claude's notes say so, are capped per list, and become yours once you rewrite them", () => {
  let s = notes.add(null, GENERAL, 'mine', { id: 'm', now: 1 }).state;
  for (let i = 0; i < notes.MAX_FROM_CLAUDE; i++) s = notes.add(s, GENERAL, `c${i}`, { id: `c${i}`, now: 1, from: 'claude' }).state;
  assert.equal(notes.find(s, GENERAL, 'c0').from, 'claude');
  assert.equal(notes.find(s, GENERAL, 'm').from, 'you');
  assert.match(notes.add(s, GENERAL, 'one more', { id: 'x', now: 1, from: 'claude' }).error, /open notes from Claude/);
  // You can still add your own, and ticking one of Claude's off makes room.
  assert.ok(notes.add(s, GENERAL, 'still mine', { id: 'y', now: 1 }).note);
  const room = notes.update(s, GENERAL, 'c0', { done: true });
  assert.ok(notes.add(room, GENERAL, 'one more', { id: 'x', now: 1, from: 'claude' }).note);
  // Rewriting it makes it yours; saving it unchanged doesn't.
  assert.equal(notes.find(notes.update(s, GENERAL, 'c1', { text: 'c1' }), GENERAL, 'c1').from, 'claude');
  assert.equal(notes.find(notes.update(s, GENERAL, 'c1', { text: 'reworded' }), GENERAL, 'c1').from, 'you');
  // Only 'claude' counts as Claude's.
  assert.equal(notes.normalize({ general: [{ id: 'z', text: 'x', from: 'someone' }] }).general[0].from, 'you');
});

test("an Ask's verdict is its first answer's, even after another run starts", () => {
  let s = notes.add(null, GENERAL, 'idea', { id: 'a', now: 1 }).state;
  s = notes.markRun(s, GENERAL, 'a', { kind: 'ask', tabId: 'tAsk', at: 2 });
  s = notes.markRun(s, GENERAL, 'a', { kind: 'build', tabId: 'tBuild', at: 3 });
  s = notes.markVerdict(s, 'tAsk', 'Do it differently');
  assert.equal(notes.find(s, GENERAL, 'a').runs[1].verdict, 'differently');
  // A follow-up in the same tab doesn't change it.
  assert.equal(notes.find(notes.markVerdict(s, 'tAsk', 'Do it'), GENERAL, 'a').runs[1].verdict, 'differently');
});
