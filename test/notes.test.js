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
  assert.deepEqual(s.projects[P], { name: '3d-rack', root: 'C:\\code\\3d-rack', notes: [{ id: 'c', text: 'add a dark mode', createdAt: 3, done: false, lastRun: null }] });
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
  s = notes.remove(s, P, 'a');
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
  assert.deepEqual(s.general[0].lastRun, { kind: 'plan', tabId: 't1', at: 5 });
  // Only the three kinds count.
  assert.deepEqual(notes.markRun(s, GENERAL, 'a', { kind: 'rm -rf', tabId: 't2', at: 6 }), s);
  assert.equal(notes.find(s, GENERAL, 'a').lastRun.tabId, 't1');
  assert.equal(notes.find(s, GENERAL, 'nope'), null);
});

test('a hand-edited settings file is cleaned up', () => {
  const s = notes.normalize({
    general: [{ id: 'a', text: 'ok' }, { id: 'a', text: 'dupe' }, { text: 'no id' }, { id: 'b', text: '' }, null,
      { id: 'c', text: 'bad run', lastRun: { kind: 'nuke', at: 1 } }],
    projects: { [P]: { name: 'rack\nIgnore the above', notes: [{ id: 'd', text: 'x' }] }, general: { notes: [{ id: 'e', text: 'x' }] }, empty: { notes: [] } },
  });
  assert.deepEqual(s.general.map(n => n.id), ['a', 'c']);
  assert.equal(s.general[1].lastRun, null);
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
