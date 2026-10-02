// Durability of the conversation history: the index survives a crash mid-write,
// transcripts never outlive their entry, and a disk that refuses a write can't
// take a running task down with it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { History, MAX_ENTRIES } = require('../src/main/history');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
const transcripts = dir => fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();

test('the index is written through a temp file, so a crash mid-write cannot truncate it', () => {
  const dir = tmp();
  const h = new History(dir);
  h.create({ id: 'a', title: 'one', cwd: 'C:/work', mode: 'ask' });
  // The real file is only ever replaced by a rename; nothing is left behind.
  assert.equal(fs.existsSync(path.join(dir, 'index.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'index.json.tmp')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).map(e => e.id), ['a']);
});

test('a truncated index loads as empty but is NOT treated as "delete every transcript"', () => {
  const dir = tmp();
  const h = new History(dir);
  h.create({ id: 'keep', title: 'one', cwd: 'C:/work', mode: 'ask' });
  h.append('keep', { kind: 'user', text: 'hi' });

  // Simulate the old in-place write losing power halfway.
  fs.writeFileSync(path.join(dir, 'index.json'), '[{"id":"keep","tit');

  const after = new History(dir);
  assert.deepEqual(after.list(), []);
  assert.equal(after.indexIntact, false);
  assert.equal(after.sweep(), 0, 'a damaged index must not authorise deletions');
  assert.deepEqual(transcripts(dir), ['keep.jsonl'], 'the transcript is still on disk to recover');
});

test('trimming the index to its limit deletes the transcripts it drops', () => {
  const dir = tmp();
  const h = new History(dir);
  for (let i = 0; i < MAX_ENTRIES + 3; i++) {
    const id = `s${i}`;
    h.create({ id, title: `task ${i}`, cwd: 'C:/work', mode: 'ask' });
    h.append(id, { kind: 'user', text: 'x' });
  }
  assert.equal(h.list().length, MAX_ENTRIES);
  assert.equal(transcripts(dir).length, MAX_ENTRIES, 'no transcript outlives its index entry');
  // The three oldest went with their entries.
  for (const gone of ['s0', 's1', 's2']) assert.equal(fs.existsSync(path.join(dir, `${gone}.jsonl`)), false);
});

test('sweep clears transcripts orphaned by an older build, and keeps listed ones', () => {
  const dir = tmp();
  const h = new History(dir);
  h.create({ id: 'listed', title: 'one', cwd: 'C:/work', mode: 'ask' });
  h.append('listed', { kind: 'user', text: 'hi' });
  // What an older build left behind when it trimmed the index without deleting files.
  fs.writeFileSync(path.join(dir, 'orphan-one.jsonl'), '{"kind":"user"}\n');
  fs.writeFileSync(path.join(dir, 'orphan-two.jsonl'), '{"kind":"user"}\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ours');

  assert.equal(new History(dir).sweep(), 2);
  assert.deepEqual(transcripts(dir), ['listed.jsonl']);
  assert.equal(fs.existsSync(path.join(dir, 'notes.txt')), true, 'only our own .jsonl files');
});

test('a disk that refuses the write reports it instead of throwing into the task', () => {
  const dir = tmp();
  const errors = [];
  const h = new History(dir, { onError: (what, err) => errors.push([what, err.code || err.message]) });
  h.create({ id: 'a', title: 'one', cwd: 'C:/work', mode: 'ask' });

  // A directory where the transcript should go: every append fails, like a
  // locked or full disk does.
  fs.rmSync(path.join(dir, 'a.jsonl'), { force: true });
  fs.mkdirSync(path.join(dir, 'a.jsonl'));

  assert.doesNotThrow(() => h.append('a', { kind: 'user', text: 'hi' }));
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 'transcript');
  assert.deepEqual(h.load('a'), [], 'and reading it back is empty, not a throw');
});

test('a half-written last line drops without losing the rest of the transcript', () => {
  const dir = tmp();
  const h = new History(dir);
  h.create({ id: 'a', title: 'one', cwd: 'C:/work', mode: 'ask' });
  h.append('a', { kind: 'user', text: 'first' });
  h.append('a', { kind: 'text', text: 'second' });
  fs.appendFileSync(path.join(dir, 'a.jsonl'), '{"kind":"text","text":"cut off'); // power loss mid-append

  const items = h.load('a');
  assert.deepEqual(items.map(i => i.text), ['first', 'second']);
});

test('hand-edited junk in the index is dropped entry by entry', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify([
    { id: 'good', title: 'fine' },
    { id: '../evil', title: 'traversal' },
    { nope: true },
    'string',
    null,
  ]));
  const h = new History(dir);
  assert.deepEqual(h.list().map(e => e.id), ['good']);
  assert.equal(h.indexIntact, true);
});

test('marking a conversation done survives a restart and leaves its timestamps alone', () => {
  const dir = tmp();
  const h = new History(dir);
  h.create({ id: 'a', title: 'one', cwd: 'C:/work', mode: 'ask' });
  const { updatedAt } = h.get('a');

  h.setDone('a', true);
  assert.equal(h.get('a').done, true);
  // Ticking it off is not activity: a chat from last week must not say "just now".
  assert.equal(h.get('a').updatedAt, updatedAt);
  // The flag is part of the index, not a separate file to lose.
  assert.equal(new History(dir).get('a').done, true);

  h.setDone('a', false);
  assert.equal('done' in h.get('a'), false, 'un-ticking clears the field rather than storing false');
  assert.equal(new History(dir).get('a').done, undefined);
  assert.equal(h.setDone('nobody', true), null);
});

test('size() reports what the transcripts take up', () => {
  const dir = tmp();
  const h = new History(dir);
  assert.equal(h.size(), 0);
  h.create({ id: 'a', title: 'one', cwd: 'C:/work', mode: 'ask' });
  h.append('a', { kind: 'user', text: 'hi' });
  assert.ok(h.size() > 0);
});
