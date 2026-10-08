// Knowing what was cut off: a turn in progress is on disk the moment it starts,
// so if the PC loses power (or Shellby is quit) mid-turn, the next start marks
// that conversation unfinished and leaves the finished ones alone
// (history.markTurn / takeCutOff, sessions.js, feed-logic.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { History } = require('../src/main/history');
const { SessionManager } = require('../src/main/sessions');
const F = require('../src/renderer/panel/feed-logic');

const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-cut-')));
const onDisk = dir => JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
const waitFor = async (check, ms = 10000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 25));
  }
};

test('a turn mark is written at once, not with the batched index', () => {
  const dir = tmp();
  const h = new History(dir, { indexSaveMs: 60000, appendMs: 60000 });
  h.create({ id: 'a', title: 'Fix it', cwd: dir, mode: 'ask' });
  h.append('a', { kind: 'user', text: 'fix it', turnId: 't1' });
  h.markTurn('a', { turnId: 't1', at: 5 });
  // Pulled out from under it right now (power cut): both are already there.
  assert.deepEqual(onDisk(dir)[0].turnOpen, { turnId: 't1', at: 5 });
  assert.equal(new History(dir).load('a')[0].text, 'fix it', 'the message it was on is on disk too');
  h.markTurn('a', null);
  assert.equal(onDisk(dir)[0].turnOpen, undefined);
});

test('the next start marks only the unfinished conversations cut off, once', () => {
  const dir = tmp();
  const h = new History(dir);
  for (const id of ['done', 'cut']) h.create({ id, title: id, cwd: dir, mode: 'ask' });
  h.update('done', { lastOutcome: 'ok' });
  h.markTurn('cut', { turnId: 't9', at: 42 });
  h.flush();

  const after = new History(dir);
  const cut = after.takeCutOff({ crashed: true });
  assert.deepEqual(cut.map(e => e.id), ['cut']);
  assert.equal(after.get('cut').lastOutcome, 'cut');
  assert.equal(after.get('cut').turnOpen, undefined);
  assert.equal(after.get('done').lastOutcome, 'ok', 'a finished one is left as it was');
  const last = after.load('cut').pop();
  assert.equal(last.kind, 'cutoff');
  assert.equal(last.turnId, 't9');
  assert.equal(last.since, 42);
  assert.equal(last.crashed, true);
  assert.equal(onDisk(dir).find(e => e.id === 'cut').lastOutcome, 'cut', 'saved, so a second crash keeps it');

  assert.deepEqual(new History(dir).takeCutOff(), [], 'and only said once');
});

test('the session manager marks a turn as it starts and clears it when it finishes', async () => {
  const dir = tmp();
  const history = new History(dir);
  const mgr = new SessionManager({ getExe: () => process.execPath, argsPrefix: [path.join(__dirname, 'fixtures', 'fake-claude.js')], history, getMode: () => 'ask', getModel: () => '' });
  try {
    mgr.open({ tabId: 'quick', cwd: dir });
    mgr.open({ tabId: 'long', cwd: dir });
    mgr.send('quick', 'hello', { kind: 'user', text: 'hello' });
    mgr.send('long', 'wait 30000', { kind: 'user', text: 'wait 30000' });
    assert.ok(onDisk(dir).find(e => e.id === 'long').turnOpen, 'on disk as the turn starts');
    await waitFor(() => mgr.tabs.get('quick').outcome === 'ok');
    assert.equal(onDisk(dir).find(e => e.id === 'quick').turnOpen, undefined, 'a finished turn is cleared on disk');
    assert.ok(onDisk(dir).find(e => e.id === 'long').turnOpen, 'the running one is still marked');
  } finally {
    mgr.closeAll({ kill: true }); // quitting mid-turn: the mark stays for the next start
  }
  assert.ok(onDisk(dir).find(e => e.id === 'long').turnOpen);

  // The next start: the cut-off tab comes back marked, the finished one doesn't.
  const again = new History(dir);
  assert.deepEqual(again.takeCutOff().map(e => e.id), ['long']);
  const next = new SessionManager({ getExe: () => process.execPath, argsPrefix: [path.join(__dirname, 'fixtures', 'fake-claude.js')], history: again, getMode: () => 'ask', getModel: () => '' });
  try {
    next.open({ tabId: 'long', historyEntry: again.get('long') });
    next.open({ tabId: 'quick', historyEntry: again.get('quick') });
    const by = Object.fromEntries(next.summary.map(t => [t.id, t.outcome]));
    assert.equal(by.long, 'cut');
    assert.equal(by.quick, null);
  } finally {
    next.closeAll({ kill: true });
  }
});

test('closing a tab by hand mid-turn is not a cut-off', async () => {
  const dir = tmp();
  const history = new History(dir);
  const mgr = new SessionManager({ getExe: () => process.execPath, argsPrefix: [path.join(__dirname, 'fixtures', 'fake-claude.js')], history, getMode: () => 'ask', getModel: () => '' });
  try {
    mgr.open({ tabId: 'x', cwd: dir });
    mgr.send('x', 'wait 30000', { kind: 'user', text: 'wait 30000' });
    mgr.close('x');
    assert.equal(onDisk(dir)[0].turnOpen, undefined);
  } finally {
    mgr.closeAll({ kill: true });
  }
});

test('the cut-off words say why, and the toast says how many', () => {
  assert.match(F.cutOffLine({ crashed: true }), /closed unexpectedly/);
  assert.match(F.cutOffLine({ crashed: false }), /was quit/);
  assert.equal(F.cutOffToast([{ title: 'Fix login', crashed: true }]),
    '"Fix login" didn\'t finish: Shellby closed unexpectedly while Claude was working. It\'s marked cut off, and everything else had finished.');
  assert.match(F.cutOffToast([{ title: 'a', crashed: false }, { title: 'b', crashed: false }]), /^2 conversations didn't finish: Shellby was quit .* They're marked/);
  assert.ok(F.CARRY_ON.length > 20);
});
