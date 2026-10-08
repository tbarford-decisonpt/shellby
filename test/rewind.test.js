// "Rewind files": Claude Code's file checkpoints, driven through the session
// and the tab manager against the fake CLI (which keeps real snapshots).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeSession, placeEdit } = require('../src/main/session');
const { SessionManager } = require('../src/main/sessions');
const { History } = require('../src/main/history');
const { toItems } = require('../src/main/stream');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-rewind-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

// Windows won't delete a folder a process is running in, so wait for each fake CLI to be gone.
async function closeAll(mgr) {
  const exits = [...mgr.tabs.values()].map(t => t.session).filter(s => s.proc)
    .map(s => new Promise(r => { s.proc.once('close', r); s.kill(); }));
  mgr.closeAll();
  await Promise.all(exits);
}

function until(emitter, pred, ms = 8000) {
  return new Promise((resolve, reject) => {
    if (pred()) return resolve();
    const t = setTimeout(() => { emitter.off('item', h); reject(new Error('timed out')); }, ms);
    function h() { if (pred()) { clearTimeout(t); emitter.off('item', h); resolve(); } }
    emitter.on('item', h);
  });
}

test('a replayed message of yours becomes a checkpoint; anything else does not', () => {
  assert.deepEqual(toItems({ type: 'user', isReplay: true, uuid: 'abc-123', parent_tool_use_id: null, message: { content: 'hi' } }), [{ kind: 'checkpoint', uuid: 'abc-123' }]);
  assert.deepEqual(toItems({ type: 'user', uuid: 'abc-123', message: { content: 'hi' } }), []);
  assert.deepEqual(toItems({ type: 'user', isReplay: true, uuid: 'x', parent_tool_use_id: 'tu_agent', message: { content: 'hi' } }), []);
});

test('the CLI is asked to replay messages and keep file checkpoints', () => {
  const s = new ClaudeSession({ exe: 'claude', cwd: os.tmpdir(), mode: 'ask' });
  assert.ok(s.buildArgs().includes('--replay-user-messages'));
});

test('edit tool items carry their diff and where in the file it lands', async () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'first\nsecond\n');
  const s = new ClaudeSession({ exe: process.execPath, argsPrefix: [FAKE], cwd, mode: 'ask' });
  const items = [];
  s.on('item', i => items.push(i));
  try {
    s.send('edit notes.txt');
    await until(s, () => items.some(i => i.kind === 'permission'));
    const tool = items.find(i => i.kind === 'tool');
    const ask = items.find(i => i.kind === 'permission');
    assert.deepEqual(tool.edits, [{ old: 'first', new: 'changed in turn 1' }]);
    assert.equal(tool.line, 1);
    assert.deepEqual(ask.edits, tool.edits);
    assert.equal(ask.line, 1);
  } finally {
    await new Promise(r => { s.proc.once('close', r); s.kill(); });
  }
});

test('a Write over an existing file is diffed against what it replaces; a new file is all additions', () => {
  const cwd = tmp();
  const file = path.join(cwd, 'old.txt');
  fs.writeFileSync(file, 'keep\r\ndrop\r\n');
  const over = { kind: 'tool', name: 'Write', filePath: file, edits: [{ old: null, new: 'keep\nadd\n' }] };
  placeEdit(over);
  assert.deepEqual(over.edits, [{ old: 'keep\ndrop\n', new: 'keep\nadd\n' }]);
  assert.equal(over.line, 1);
  const fresh = { kind: 'permission', toolName: 'Write', filePath: path.join(cwd, 'new.txt'), edits: [{ old: null, new: 'x' }] };
  placeEdit(fresh);
  assert.deepEqual(fresh.edits, [{ old: null, new: 'x' }]);
  assert.equal(fresh.line, undefined);
});

test('rewinding puts files back, says which, and tells Claude with the next message', async () => {
  const cwd = tmp();
  const history = new History(tmp());
  const mgr = new SessionManager({ getExe: () => process.execPath, argsPrefix: [FAKE], history, getMode: () => 'ask', getModel: () => '' });
  const items = [];
  mgr.on('item', (_tab, item) => items.push(item));
  const results = () => items.filter(i => i.kind === 'result').length;
  const answer = async () => {
    await until(mgr, () => mgr.tabs.get('t1').session.pending.size === 1);
    const [id] = mgr.tabs.get('t1').session.pending.keys();
    mgr.respond('t1', id, 'allow');
  };
  try {
    mgr.open({ tabId: 't1', cwd });
    const file = path.join(cwd, 'made.txt');

    mgr.send('t1', 'edit made.txt', { kind: 'user', text: 'edit made.txt' });
    await answer();
    await until(mgr, () => results() === 1);
    mgr.send('t1', 'edit made.txt', { kind: 'user', text: 'edit made.txt' });
    await answer();
    await until(mgr, () => results() === 2);
    assert.equal(fs.readFileSync(file, 'utf8'), 'changed in turn 2\nworld\n');

    const [first, second] = items.filter(i => i.kind === 'checkpoint').map(i => i.uuid);
    assert.ok(first && second, 'each message got a checkpoint');
    assert.ok(history.load('t1').some(i => i.kind === 'checkpoint' && i.uuid === first), 'checkpoints are in the transcript');

    // Dry run: what would change, nothing touched.
    const preview = await mgr.rewind('t1', second, true);
    assert.deepEqual(preview.filesChanged, [file]);
    assert.equal(fs.readFileSync(file, 'utf8'), 'changed in turn 2\nworld\n');

    // Back to before the second message, then before the first: the file is gone.
    const r = await mgr.rewind('t1', second, false);
    assert.equal(r.canRewind, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'hello\nworld\n');
    await mgr.rewind('t1', first, false);
    assert.equal(fs.existsSync(file), false);
    const rewound = history.load('t1').filter(i => i.kind === 'rewound');
    assert.equal(rewound.length, 2);
    assert.deepEqual(rewound[1].files, [file]);

    // Nothing left to undo since the first message.
    assert.deepEqual((await mgr.rewind('t1', first, true)).filesChanged, []);

    // Claude hears about it once, at the top of the next message.
    let sent = null;
    const session = mgr.tabs.get('t1').session;
    const realSend = session.send.bind(session);
    session.send = text => { sent = text; realSend(text); };
    mgr.send('t1', 'hello', { kind: 'user', text: 'hello' });
    assert.match(sent, /^\[Shellby: the user rewound file changes/);
    assert.ok(sent.includes(file));
    assert.ok(sent.endsWith('\n\nhello'));
    await until(mgr, () => results() === 3);
    mgr.send('t1', 'again', { kind: 'user', text: 'again' });
    assert.equal(sent, 'again');
    await until(mgr, () => results() === 4);
  } finally {
    await closeAll(mgr);
  }
});

test('no rewinding while a turn is running, and an unknown checkpoint says so', async () => {
  const mgr = new SessionManager({ getExe: () => process.execPath, argsPrefix: [FAKE], history: new History(tmp()), getMode: () => 'ask', getModel: () => '' });
  const items = [];
  mgr.on('item', (_t, i) => items.push(i));
  try {
    mgr.open({ tabId: 't2', cwd: tmp() });
    mgr.send('t2', 'wait 800', { kind: 'user', text: 'wait 800' });
    await assert.rejects(mgr.rewind('t2', '00000000-0000-0000-0000-000000000000', true), /finished/);
    await until(mgr, () => items.some(i => i.kind === 'result'));
    const r = await mgr.rewind('t2', '00000000-0000-0000-0000-000000000000', true);
    assert.equal(r.canRewind, false);
    assert.match(r.error, /checkpoint/);
    await assert.rejects(mgr.rewind('t2', 'not a uuid!', true), /no checkpoint/);
  } finally {
    await closeAll(mgr);
  }
});
