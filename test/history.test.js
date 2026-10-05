// Durability of the conversation history: the index survives a crash mid-write,
// transcripts never outlive their entry, and a disk that refuses a write can't
// take a running task down with it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { History, MAX_ENTRIES, TRASH_DAYS } = require('../src/main/history');

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

test('renaming a conversation survives a restart and leaves its timestamps alone', () => {
  const dir = tmp();
  const h = new History(dir);
  h.create({ id: 'a', title: 'fix the thing', cwd: 'C:/work', mode: 'ask' });
  const { updatedAt } = h.get('a');

  assert.equal(h.rename('a', '  Login\n redirect  ').title, 'Login redirect');
  assert.equal(h.get('a').updatedAt, updatedAt, 'naming a chat is not work on it');
  assert.equal(new History(dir).get('a').title, 'Login redirect');

  assert.equal(h.rename('a', 'x'.repeat(100)).title.length, 68, 'long names are cut like generated ones');
  assert.equal(h.rename('a', '   '), null, 'a blank name changes nothing');
  assert.equal(h.get('a').title.startsWith('xxx'), true);
  assert.equal(h.rename('nobody', 'hi'), null);
});

test('size() reports what the transcripts take up', () => {
  const dir = tmp();
  const h = new History(dir);
  assert.equal(h.size(), 0);
  h.create({ id: 'a', title: 'one', cwd: 'C:/work', mode: 'ask' });
  h.append('a', { kind: 'user', text: 'hi' });
  assert.ok(h.size() > 0);
});

test('rewrite replaces a transcript whole (for rewind), and leaves no temp file', () => {
  const dir = tmp();
  const h = new History(dir);
  h.create({ id: 'c1', title: 'x', cwd: dir, mode: 'ask' });
  for (const text of ['one', 'two', 'three']) h.append('c1', { kind: 'user', text });
  const kept = h.load('c1').slice(0, 1);
  assert.equal(h.rewrite('c1', [...kept, { kind: 'rewound' }]), true);
  assert.deepEqual(h.load('c1').map(i => i.text || i.kind), ['one', 'rewound']);
  assert.ok(!fs.readdirSync(dir).some(f => f.endsWith('.tmp')));
  assert.equal(h.rewrite('c1', []), true);
  assert.deepEqual(h.load('c1'), []);
});

test('! commands and rewinds are kept in the transcript', () => {
  const dir = tmp();
  const h = new History(dir);
  h.create({ id: 'c2', title: 'x', cwd: dir, mode: 'ask' });
  h.append('c2', { kind: 'shell', command: 'git status', output: 'clean', code: 0 });
  h.append('c2', { kind: 'rewound', conversation: true });
  assert.deepEqual(h.load('c2').map(i => i.kind), ['shell', 'rewound']);
});

// ---- Recently deleted

const DAY = 24 * 60 * 60 * 1000;
const seed = (h, id, extra = {}) => {
  h.create({ id, title: id, cwd: 'C:/work', mode: 'ask' });
  if (extra.createdAt) h.get(id).createdAt = extra.createdAt;
  h.append(id, { kind: 'user', text: `hi from ${id}` });
};

test('trash() hides a conversation from list() and get() but keeps its transcript, across a restart', () => {
  const dir = tmp();
  const h = new History(dir);
  seed(h, 'a');
  seed(h, 'b');
  h.trash('a', 1000);

  const after = new History(dir);
  assert.deepEqual(after.list().map(e => e.id), ['b']);
  assert.equal(after.get('a'), null);
  assert.deepEqual(after.trashed().map(e => [e.id, e.deletedAt]), [['a', 1000]]);
  assert.deepEqual(transcripts(dir), ['a.jsonl', 'b.jsonl']);
});

test('restore() puts a conversation back where its start date belongs, transcript intact', () => {
  const dir = tmp();
  const h = new History(dir);
  seed(h, 'old', { createdAt: 1 });
  seed(h, 'mid', { createdAt: 2 });
  seed(h, 'new', { createdAt: 3 });
  h.saveIndex();
  h.trash('mid');
  h.restore('mid');

  assert.deepEqual(h.list().map(e => e.id), ['new', 'mid', 'old']);
  assert.equal(h.get('mid').deletedAt, undefined);
  assert.deepEqual(h.trashed(), []);
  assert.equal(h.load('mid')[0].text, 'hi from mid');
});

test('sweep() leaves binned transcripts alone', () => {
  const dir = tmp();
  const h = new History(dir);
  seed(h, 'a');
  h.trash('a');
  assert.equal(h.sweep(), 0);
  assert.deepEqual(transcripts(dir), ['a.jsonl']);
});

test('a damaged trash file stops sweep() rather than letting it delete binned transcripts', () => {
  const dir = tmp();
  const h = new History(dir);
  seed(h, 'a');
  h.trash('a');
  fs.writeFileSync(path.join(dir, 'trash.json'), '[{"id":"a","ti');

  const after = new History(dir);
  assert.equal(after.trashIntact, false);
  assert.equal(after.sweep(), 0);
  assert.deepEqual(transcripts(dir), ['a.jsonl']);
});

test('purge() deletes one binned conversation for good, or all of them', () => {
  const dir = tmp();
  const h = new History(dir);
  for (const id of ['a', 'b', 'c']) { seed(h, id); h.trash(id); }

  assert.equal(h.purge(['b']), 1);
  assert.deepEqual(h.trashed().map(e => e.id).sort(), ['a', 'c']);
  assert.deepEqual(transcripts(dir), ['a.jsonl', 'c.jsonl']);

  assert.equal(h.purge(), 2);
  assert.deepEqual(new History(dir).trashed(), []);
  assert.deepEqual(transcripts(dir), []);
});

test(`purgeExpired() empties only what has waited ${TRASH_DAYS} days`, () => {
  const dir = tmp();
  const h = new History(dir);
  const now = 100 * DAY;
  seed(h, 'stale'); h.trash('stale', now - TRASH_DAYS * DAY - 1);
  seed(h, 'fresh'); h.trash('fresh', now - DAY);

  assert.equal(h.purgeExpired(now), 1);
  assert.deepEqual(h.trashed().map(e => e.id), ['fresh']);
  assert.equal(h.trashed()[0].purgeAt, now - DAY + TRASH_DAYS * DAY);
  assert.deepEqual(transcripts(dir), ['fresh.jsonl']);
});

test('remove() is still a hard delete, for Shellby tidying up after itself', () => {
  const dir = tmp();
  const h = new History(dir);
  seed(h, 'a');
  h.remove('a');
  assert.deepEqual(h.trashed(), []);
  assert.deepEqual(transcripts(dir), []);
});

test('clear() empties the list and the bin and deletes every transcript, listed or not', () => {
  const dir = tmp();
  const h = new History(dir);
  for (const id of ['a', 'b', 'c']) { h.create({ id, title: id, cwd: 'C:/work', mode: 'ask' }); h.append(id, { kind: 'user', text: 'hi' }); }
  h.trash('c');
  fs.writeFileSync(path.join(dir, 'orphan.jsonl'), '{}\n');

  assert.equal(h.clear(), 3);
  assert.deepEqual(h.list(), []);
  assert.deepEqual(h.trashed(), []);
  assert.deepEqual(transcripts(dir), []);

  // And it sticks: a fresh load sees the same clean slate.
  const after = new History(dir);
  assert.deepEqual(after.list(), []);
  assert.deepEqual(after.trashed(), []);
});

test('clear() still clears when the index was damaged, since a person asked for it', () => {
  const dir = tmp();
  const h = new History(dir);
  h.create({ id: 'keep', title: 'one', cwd: 'C:/work', mode: 'ask' });
  h.append('keep', { kind: 'user', text: 'hi' });
  fs.writeFileSync(path.join(dir, 'index.json'), '[{"id":"keep","tit');

  const after = new History(dir);
  after.clear();
  assert.deepEqual(transcripts(dir), []);
  assert.equal(new History(dir).indexIntact, true, 'the damaged index is replaced by a clean one');
});

test('turn check verdicts and before/after pictures are kept, so they replay and their images load later', () => {
  const dir = tmp();
  const h = new History(dir);
  h.create({ id: 'c', title: 'one', cwd: 'C:/work', mode: 'ask' });
  h.append('c', { kind: 'checks', after: 'abc', status: 'pass', commands: [] });
  h.append('c', { kind: 'shots', after: 'abc', url: 'http://localhost:3000/', shots: { before: 'b1', after: 'a1' } });
  assert.deepEqual(new History(dir).load('c').map(i => i.kind), ['checks', 'shots']);
});
