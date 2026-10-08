const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { wireJournal } = require('../src/main/wiring/journal');
const { projectDirName } = require('../src/main/worktrees');
const { UNTRUSTED_NOTE } = require('../src/main/journal');

const SID = '11111111-2222-3333-4444-555555555555';

// A git repository, Claude Code's folder with one conversation in it, and
// what wiring/journal.js reads from main, faked.
function setup() {
  // The long form: CI's temp folder is an 8.3 path, and git (which finds the repository) gives the long one.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-jw-')));
  const repo = path.join(base, 'app');
  const sub = path.join(repo, 'src');
  fs.mkdirSync(sub, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const configDir = path.join(base, 'claude');
  const store = {};
  const sent = [];
  const d = {
    config: { get: k => store[k], set: patch => Object.assign(store, patch) },
    claudeConfigDir: () => configDir,
    journalDir: () => path.join(base, 'journal'),
    send: (_win, channel) => sent.push(channel),
    log: { info: () => {} },
    panel: {},
  };
  const saveTranscript = (dir, id = SID) => {
    const folder = path.join(configDir, 'projects', projectDirName(dir));
    fs.mkdirSync(folder, { recursive: true });
    const t = new Date().toISOString();
    const lines = [
      { type: 'user', timestamp: t, message: { content: 'Add the cable tray snapping' } },
      { type: 'assistant', timestamp: t, message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'Snap on drop', status: 'in_progress' }] } }] } },
    ];
    fs.writeFileSync(path.join(folder, `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n'));
  };
  const j = wireJournal(d);
  const done = () => fs.rmSync(base, { recursive: true, force: true });
  return { base, repo, sub, d, j, sent, store, saveTranscript, done };
}

async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return false;
}

test('a session that ends is filed under its repository, read from Claude Code\'s own file', async () => {
  const s = setup();
  try {
    s.saveTranscript(s.sub);
    s.j.touched({ sessionId: SID, cwd: s.sub, now: true, strict: true });
    assert.ok(await until(() => s.j.view([s.repo])), 'a note lands');
    const v = s.j.view([s.repo]);
    assert.equal(v.notes[0].title, 'Add the cable tray snapping');
    assert.deepEqual(v.notes[0].open, ['Snap on drop']);
    assert.equal(v.notes[0].branch, 'main');
    assert.ok(s.sent.includes('projects:changed'));
    assert.match(s.j.draftFor(s.repo, 'app'), /^Pick up where we left off in app\./);
    assert.ok((await s.j.briefFor(s.sub)).startsWith(UNTRUSTED_NOTE), 'Claude is told these are notes, not orders');
  } finally { s.done(); }
});

test('from a terminal hook, a transcript kept under some other folder is not filed here', async () => {
  const s = setup();
  try {
    s.saveTranscript(path.join(s.base, 'elsewhere'));
    s.j.touched({ sessionId: SID, cwd: s.sub, now: true, strict: true });
    await new Promise(r => setTimeout(r, 600));
    assert.equal(s.j.view([s.repo]), null);
  } finally { s.done(); }
});

test('a folder that isn\'t a repository gets no journal', async () => {
  const s = setup();
  try {
    const plain = path.join(s.base, 'plain');
    fs.mkdirSync(plain);
    s.saveTranscript(plain);
    s.j.touched({ sessionId: SID, cwd: plain, now: true });
    await new Promise(r => setTimeout(r, 600));
    assert.equal(s.j.view([plain]), null);
    assert.match(s.j.draftFor(plain, 'plain', { since: 'since we last shipped it' }), /changed since we last shipped it/);
  } finally { s.done(); }
});

test('Claude can only pin to a project that already has notes; the panel can always', async () => {
  const s = setup();
  try {
    assert.equal((await s.j.pinFor(s.repo, { kind: 'next', text: 'x' })).ok, false);
    assert.equal((await s.j.pinFor(s.repo, { kind: 'next', text: 'From the panel' }, { fromPanel: true })).ok, true);
    s.saveTranscript(s.repo);
    s.j.touched({ sessionId: SID, cwd: s.repo, now: true });
    assert.ok(await until(() => s.j.view([s.repo])?.notes.length));
    assert.equal((await s.j.pinFor(s.sub, { kind: 'decision', text: 'From Claude' })).ok, true);
    assert.deepEqual(s.j.view([s.repo]).pins.map(p => p.text), ['From Claude', 'From the panel']);
    const id = s.j.view([s.repo]).pins[0].id;
    assert.equal(s.j.view([s.repo]).pins[0].by, 'claude', 'the MCP tool\'s pins say they\'re Claude\'s');
    assert.equal(s.j.view([s.repo]).pins[1].by, 'you');
    s.j.remove(s.repo, { pinId: id });
    assert.equal(s.j.view([s.repo]).pins.length, 1);
    assert.equal(s.j.restore(s.repo, { pinId: 'someother' }).ok, false, 'Undo puts back only the one just taken off');
    assert.equal(s.j.restore(s.repo, { pinId: id }).ok, true);
    assert.deepEqual(s.j.view([s.repo]).pins.map(p => p.text), ['From Claude', 'From the panel']);
    assert.equal(s.j.restore(s.repo, { pinId: id }).ok, false, 'once');
    s.j.remove(s.repo, { sessionId: SID });
    assert.equal(s.j.view([s.repo]).notes.length, 0);
    assert.equal(s.j.restore(s.repo, { sessionId: SID }).ok, true);
    assert.equal(s.j.view([s.repo]).notes.length, 1);
  } finally { s.done(); }
});

test('what is still settling at quit is written on the next start', async () => {
  const s = setup();
  try {
    s.saveTranscript(s.repo);
    s.j.touched({ sessionId: SID, cwd: s.repo });
    s.j.savePending();
    assert.equal(s.store.journalPending.length, 1);
    const again = wireJournal(s.d);
    again.resumePending();
    assert.deepEqual(s.store.journalPending, []);
    again.savePending(); // the settle timer again; nothing is lost across a second quit either
    assert.equal(s.store.journalPending[0].sessionId, SID);
  } finally { s.done(); }
});

test('nothing is written in just-the-crab mode', async () => {
  const s = setup();
  try {
    s.store.crabOnly = true;
    s.saveTranscript(s.repo);
    s.j.touched({ sessionId: SID, cwd: s.repo, now: true });
    await new Promise(r => setTimeout(r, 400));
    assert.equal(s.j.view([s.repo]), null);
    assert.equal((await s.j.pinFor(s.repo, { text: 'x' }, { fromPanel: true })).ok, false);
  } finally { s.done(); }
});
