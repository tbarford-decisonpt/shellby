// New tricks (src/main/claude-tricks.js and wiring/claude-tricks.js): Claude
// Code's changelog read, the releases between two versions picked out, a few
// highlights chosen with a prompt to try each new feature, and the version
// remembered so each update is announced once.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tricks = require('../src/main/claude-tricks');
const { wireClaudeTricks } = require('../src/main/wiring/claude-tricks');

// The changelog's shape, as of 2.1.293.
const CHANGELOG = `# Changelog

## 2.1.293

- Added \`agentType\` to the \`subagentStatusLine\` payload, so scripts can tell custom subagent types apart
- Fixed a memory leak where an HTTP MCP connection kept every request it had sent
- [Claude Tag] Fixed Claude in Slack stopping mid-task in a channel
- Improved Claude in Chrome: fewer page actions are refused
- Windows: Fixed stopping a status line terminating an unrelated process

## 2.1.292

- Added \`/recap\` to sum up a long session
- macOS: Added a menu bar item
- Reverted the auto mode denial message change from 2.1.281
- Changed claude.ai skill syncing to check every 40 minutes

## 2.1.291

- Fixed vim mode \`>>\` on a line of only spaces

## 2.1.290

- Added something you already had
`;

const response = (body, { ok = true, status = 200, length = null } = {}) => ({
  ok, status, headers: { get: k => (k === 'content-length' && length !== null ? String(length) : null) }, text: async () => body,
});

// ------------------------------------------------------------------ the pure parts

test('parseChangelog: one section per release, its bullets in order', () => {
  const s = tricks.parseChangelog(CHANGELOG);
  assert.deepEqual(s.map(x => x.version), ['2.1.293', '2.1.292', '2.1.291', '2.1.290']);
  assert.equal(s[0].items.length, 5);
  assert.match(s[1].items[0], /^Added `\/recap`/);
  assert.deepEqual(tricks.parseChangelog('not a changelog'), []);
  assert.deepEqual(tricks.parseChangelog('## 2.1.x\n- Added a thing\n'), [], 'a heading that is not a version starts nothing');
});

test('between: after the old version, up to and including the new one, numerically', () => {
  const s = tricks.parseChangelog(CHANGELOG);
  assert.deepEqual(tricks.between(s, '2.1.290', '2.1.293').map(x => x.version), ['2.1.293', '2.1.292', '2.1.291']);
  assert.deepEqual(tricks.between(s, '2.1.292', '2.1.292'), []);
  assert.deepEqual(tricks.between(s, '2.1.9', '2.1.291').map(x => x.version), ['2.1.291', '2.1.290'], 'not a string compare');
  assert.deepEqual(tricks.between(s, null, '2.1.293'), []);
});

test('classify: what kind of change, and lines about other products or systems left out', () => {
  assert.equal(tricks.classify('Added `/recap`').kind, 'added');
  assert.equal(tricks.classify('Improved startup').kind, 'improved');
  assert.equal(tricks.classify('Changed the order').kind, 'changed');
  assert.equal(tricks.classify('Fixed a leak').kind, 'fixed');
  assert.equal(tricks.classify('Something else').kind, 'other');
  assert.equal(tricks.classify('[Claude Tag] Fixed Slack'), null);
  assert.equal(tricks.classify('macOS: Added a menu bar item'), null);
  assert.equal(tricks.classify('Linux: Fixed a thing'), null);
  assert.equal(tricks.classify('Reverted the 2.1.290 fix'), null);
  assert.deepEqual(tricks.classify('Windows: Fixed a hang'), { text: 'Fixed a hang', kind: 'fixed' }, 'Shellby runs on Windows: kept, without the prefix');
  assert.equal(tricks.classify(''), null);
});

test('digest: new features first, each with a prompt to try it; fixes counted but not shown', () => {
  const dg = tricks.digest(tricks.parseChangelog(CHANGELOG), '2.1.290', '2.1.293');
  assert.equal(dg.from, '2.1.290');
  assert.equal(dg.to, '2.1.293');
  assert.equal(dg.releases, 3);
  assert.equal(dg.added, 2);
  assert.equal(dg.total, 7, 'the Claude Tag, macOS and Reverted lines are not counted');
  assert.deepEqual(dg.highlights.map(x => x.kind), ['added', 'added', 'improved', 'changed']);
  assert.match(dg.highlights[0].text, /agentType/, 'newest first within a kind');
  assert.ok(dg.highlights[0].tryIt && dg.highlights[1].tryIt);
  assert.equal(dg.highlights[2].tryIt, undefined, 'only a new feature is offered to try');
  assert.ok(!dg.highlights.some(x => x.kind === 'fixed'));
});

test('digest: nothing to show is null', () => {
  const s = tricks.parseChangelog(CHANGELOG);
  assert.equal(tricks.digest(s, '2.1.290', '2.1.291'), null, 'only a fix');
  assert.equal(tricks.digest(s, '2.1.293', '2.1.293'), null);
  assert.equal(tricks.digest([], '2.1.290', '2.1.293'), null);
});

test('tryPrompt asks about the feature and changes nothing', () => {
  const p = tricks.tryPrompt('Added `/recap` to sum up a long session');
  assert.match(p, /"Added \/recap to sum up a long session"/, 'backticks dropped');
  assert.match(p, /rather than change anything/);
});

test('normalizeState tolerates anything read from disk', () => {
  assert.deepEqual(tricks.normalizeState(null), { lastSeen: null, pending: null });
  assert.deepEqual(tricks.normalizeState({ lastSeen: 'latest', pending: 'x' }), { lastSeen: null, pending: null });
  const dg = tricks.digest(tricks.parseChangelog(CHANGELOG), '2.1.290', '2.1.293');
  assert.deepEqual(tricks.normalizeState({ lastSeen: '2.1.293', pending: dg }), { lastSeen: '2.1.293', pending: dg });
  assert.equal(tricks.normalizeState({ pending: { ...dg, highlights: [] } }).pending, null);
});

test('fetchChangelog: the text on a clean answer, a plain error otherwise', async () => {
  assert.equal(await tricks.fetchChangelog({ fetchImpl: async () => response(CHANGELOG) }), CHANGELOG);
  await assert.rejects(tricks.fetchChangelog({ fetchImpl: async () => response('', { ok: false, status: 404 }) }), /HTTP 404/);
  await assert.rejects(tricks.fetchChangelog({ fetchImpl: async () => { throw new Error('offline'); } }), /Couldn't reach/);
  await assert.rejects(tricks.fetchChangelog({ fetchImpl: async () => response('x', { length: 100 * 1024 * 1024 }) }), /too big/);
  let asked = null;
  await tricks.fetchChangelog({ fetchImpl: async (url, opts) => { asked = { url, opts }; return response(''); } });
  assert.equal(asked.url, tricks.CHANGELOG_URL);
  assert.equal(asked.opts.redirect, 'error');
});

// ------------------------------------------------------------------ when he says it

function setup({ version = '2.1.293', settings = {}, fetch = async () => response(CHANGELOG), focused = false } = {}) {
  const store = { ...settings };
  const sent = [];
  const said = [];
  const notes = [];
  let fetches = 0;
  const d = {
    config: { get: k => store[k], set: patch => Object.assign(store, patch) },
    claudeStatus: { installed: true, version },
    send: (_w, channel, payload) => sent.push([channel, payload]),
    speak: o => said.push(o),
    notify: (title, body) => notes.push({ title, body }),
    showPanel: () => {},
    panel: { isVisible: () => focused, isFocused: () => focused },
    log: { warn: () => {} },
  };
  const w = wireClaudeTricks(d, { fetchImpl: async (...a) => { fetches++; return fetch(...a); } });
  return { d, w, store, sent, said, notes, fetches: () => fetches };
}

test('the first version he ever sees is remembered, not announced', async () => {
  const t = setup();
  await t.w.noteClaudeVersion();
  assert.equal(t.store.claudeTricksState.lastSeen, '2.1.293');
  assert.equal(t.fetches(), 0);
  assert.equal(t.sent.length, 0);
});

test('a newer version: the changelog read once, the card sent, a line, a notification while the panel is away', async () => {
  const t = setup({ settings: { claudeTricksState: { lastSeen: '2.1.290' } } });
  await t.w.noteClaudeVersion();
  assert.equal(t.fetches(), 1);
  const [channel, dg] = t.sent.find(([c]) => c === 'claude:tricks');
  assert.equal(channel, 'claude:tricks');
  assert.equal(dg.to, '2.1.293');
  assert.deepEqual(t.said, ['newTricks']);
  assert.match(t.notes[0].title, /Claude Code 2\.1\.293 can do 2 new things/);
  assert.equal(t.store.claudeTricksState.lastSeen, '2.1.293');
  assert.deepEqual(t.w.claudeTricksPending(), dg, 'waits for the panel until dismissed');

  await t.w.noteClaudeVersion();
  assert.equal(t.fetches(), 1, 'the same version again reads nothing');
  t.w.dismissClaudeTricks();
  assert.equal(t.w.claudeTricksPending(), null);
});

test('no notification while you have the panel in front of you', async () => {
  const t = setup({ settings: { claudeTricksState: { lastSeen: '2.1.290' } }, focused: true });
  await t.w.noteClaudeVersion();
  assert.equal(t.notes.length, 0);
  assert.ok(t.sent.some(([c]) => c === 'claude:tricks'));
});

test('offline: nothing said, and the version not moved on, so the next look tries again', async () => {
  const t = setup({ settings: { claudeTricksState: { lastSeen: '2.1.290' } }, fetch: async () => { throw new Error('offline'); } });
  await t.w.noteClaudeVersion();
  assert.equal(t.store.claudeTricksState?.lastSeen ?? '2.1.290', '2.1.290');
  assert.equal(t.sent.length, 0);
});

test('turned off, or crab only: kept up with quietly, nothing read', async () => {
  for (const settings of [{ claudeTricks: false }, { crabOnly: true }]) {
    const t = setup({ settings: { ...settings, claudeTricksState: { lastSeen: '2.1.290' } } });
    await t.w.noteClaudeVersion();
    assert.equal(t.fetches(), 0);
    assert.equal(t.store.claudeTricksState.lastSeen, '2.1.293');
    assert.equal(t.sent.length, 0);
  }
});

test('an older version (a downgrade) is remembered, not announced', async () => {
  const t = setup({ version: '2.1.290', settings: { claudeTricksState: { lastSeen: '2.1.293' } } });
  await t.w.noteClaudeVersion();
  assert.equal(t.fetches(), 0);
  assert.equal(t.store.claudeTricksState.lastSeen, '2.1.290');
});

test('an update with nothing worth a card moves on without a word', async () => {
  const t = setup({ version: '2.1.291', settings: { claudeTricksState: { lastSeen: '2.1.290' } } });
  await t.w.noteClaudeVersion();
  assert.equal(t.fetches(), 1);
  assert.equal(t.store.claudeTricksState.lastSeen, '2.1.291');
  assert.equal(t.sent.length, 0);
  assert.equal(t.said.length, 0);
});

test('screenshots and the fake CLI read no changelog unless a test points at one', async () => {
  const t = setup({ settings: { claudeTricksState: { lastSeen: '2.1.290' } } });
  t.d.FAKE_CLI = 'fake.js';
  await t.w.noteClaudeVersion();
  assert.equal(t.fetches(), 0);
  t.d.changelogUrl = () => 'http://127.0.0.1:1/CHANGELOG.md';
  await t.w.noteClaudeVersion();
  assert.equal(t.fetches(), 1);
});
