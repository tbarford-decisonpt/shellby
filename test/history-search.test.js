// Searching inside past conversations: what's searched, ranking, snippets,
// filters by project, PC and date, and the index only reading what changed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hs = require('../src/main/history-search');
const { History } = require('../src/main/history');

const NOW = Date.UTC(2026, 9, 9);
const DAY = 864e5;
const doc = (text, kind = 'text', at = 0) => ({ at, kind, text, low: text.toLowerCase() });

test('only your messages, Claude\'s replies and results are searched, numbered as load() does', () => {
  const jsonl = [
    JSON.stringify({ kind: 'user', text: 'Fix the login bug' }),
    '{broken',
    JSON.stringify({ kind: 'tool', name: 'Bash', input: { command: 'login' } }),
    '',
    JSON.stringify({ kind: 'text', text: 'The login form now validates.' }),
  ].join('\n');
  const docs = hs.docsOf(jsonl);
  assert.deepEqual(docs.map(d => [d.at, d.kind]), [[0, 'user'], [2, 'text']]);
});

test('queries split into terms, with quoted phrases kept whole', () => {
  assert.deepEqual(hs.parseQuery('Login "rate limit" login').terms, ['login', 'rate limit']);
});

test('every term must be there; whole words and the whole phrase score higher', () => {
  const q = hs.parseQuery('rate limit');
  assert.equal(hs.scoreDoc(doc('the rate is fine'), q), 0);
  const phrase = hs.scoreDoc(doc('add a rate limit here'), q);
  const apart = hs.scoreDoc(doc('limit the rate here'), q);
  const partial = hs.scoreDoc(doc('limitless rates'), q);
  assert.ok(phrase > apart && apart > partial && partial > 0);
  assert.ok(hs.scoreDoc(doc('rate limit', 'user'), q) > hs.scoreDoc(doc('rate limit'), q));
});

test('the snippet is cut around the first match, with every match marked', () => {
  const text = `${'word '.repeat(40)}the Login page and login again ${'tail '.repeat(40)}`;
  const s = hs.snippet(text, text.toLowerCase(), ['login']);
  assert.ok(s.text.startsWith('…') && s.text.endsWith('…'));
  assert.equal(s.marks.length, 2);
  for (const [a, b] of s.marks) assert.equal(s.text.slice(a, b).toLowerCase(), 'login');
  const short = hs.snippet('login', 'login', ['login']);
  assert.deepEqual(short, { text: 'login', marks: [[0, 5]] });
});

test('ranking: the best match first, then newer; filters by project, PC and date', () => {
  const entries = [
    { id: 'a', title: 'Old chat', cwd: 'C:\\code\\shellby', updatedAt: NOW - 200 * DAY },
    { id: 'b', title: 'Deploy', cwd: 'C:\\code\\site', updatedAt: NOW - DAY, elsewhere: 'LAPTOP' },
    { id: 'c', title: 'Nothing here', cwd: 'C:\\code\\site', updatedAt: NOW },
  ];
  const docs = {
    a: [doc('deploy the deploy script with vercel deploy', 'user', 3)],
    b: [doc('deploy it', 'text', 1)],
    c: [doc('unrelated', 'text', 0)],
  };
  const all = hs.rank(entries, id => docs[id], 'deploy', {}, NOW);
  assert.deepEqual(all.map(r => r.id), ['a', 'b']); // a says it three times, in your own words
  assert.equal(all[0].hits[0].at, 3);
  const twins = [{ id: 'old', title: 't', cwd: '', updatedAt: NOW - 90 * DAY }, { id: 'new', title: 't', cwd: '', updatedAt: NOW - DAY }];
  assert.deepEqual(hs.rank(twins, () => [doc('same words')], 'words', {}, NOW).map(r => r.id), ['new', 'old']);
  assert.equal(hs.rank(entries, id => docs[id], 'deploy', { project: 'shellby' }, NOW)[0].id, 'a');
  assert.deepEqual(hs.rank(entries, id => docs[id], 'deploy', { pc: '' }, NOW).map(r => r.id), ['a']);
  assert.deepEqual(hs.rank(entries, id => docs[id], 'deploy', { pc: 'laptop' }, NOW).map(r => r.id), ['b']);
  assert.deepEqual(hs.rank(entries, id => docs[id], 'deploy', { from: NOW - 30 * DAY }, NOW).map(r => r.id), ['b']);
  assert.deepEqual(hs.rank(entries, id => docs[id], 'x', {}, NOW), []);
  assert.deepEqual(hs.facets(entries), { projects: ['shellby', 'site'], pcs: ['LAPTOP'] });
});

test('the index reads a transcript again only once it has changed', async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-hsearch-')));
  try {
    const history = new History(dir, { indexSaveMs: 0, appendMs: 0 });
    const e = history.create({ title: 'Chat', cwd: dir, mode: 'default' });
    history.append(e.id, { kind: 'user', text: 'make the crab dance' });
    let reads = 0;
    const fsp = { stat: f => fs.promises.stat(f), readFile: (f, enc) => { reads++; return fs.promises.readFile(f, enc); } };
    const search = new hs.HistorySearch(history, { fsp });
    const first = await search.search('dance');
    assert.equal(first.results[0].id, e.id);
    assert.equal(first.results[0].hits[0].at, 0);
    await search.search('crab');
    assert.equal(reads, 1);
    history.append(e.id, { kind: 'text', text: 'He dances a jig now.' });
    const again = await search.search('jig');
    assert.equal(reads, 2);
    assert.equal(again.results[0].hits[0].at, history.load(e.id).length - 1);
    history.flush();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
