// Cloning (src/main/projects/clone.js): nothing happens without a folder you
// chose, nothing is cloned over, git's arguments are fixed, and a failed or
// cancelled clone takes away only the folder it made.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const clone = require('../src/main/projects/clone');

function base() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-clone-')));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// A git that writes some progress, makes the folder, then ends with `code`.
function fakeSpawn({ code = 0, stderr = 'Receiving objects:  45% (45/100)\rReceiving objects: 100% (100/100), done.\n', calls = [] } = {}) {
  return (cmd, args, opts) => {
    // The folder is already there, empty, made by clone() itself.
    calls.push({ cmd, args, opts, claimed: fs.existsSync(args[args.length - 1]) && !fs.readdirSync(args[args.length - 1]).length });
    const child = new EventEmitter();
    child.pid = 4242;
    child.stderr = new EventEmitter();
    setImmediate(() => {
      fs.mkdirSync(args[args.length - 1], { recursive: true });
      child.stderr.emit('data', Buffer.from(stderr));
      if (code !== null) child.emit('close', code);
    });
    child.finish = c => child.emit('close', c);
    calls.at(-1).child = child;
    return child;
  };
}

test('no folder chosen, or a folder that is not there: nothing runs', async () => {
  const calls = [];
  assert.match((await clone.clone('me/site', null, { spawnImpl: fakeSpawn({ calls }) })).error, /Choose a folder/);
  assert.match((await clone.clone('me/site', 'C:\\definitely\\not\\here', { spawnImpl: fakeSpawn({ calls }) })).error, /isn't there/);
  assert.match((await clone.clone('../evil', os.tmpdir(), { spawnImpl: fakeSpawn({ calls }) })).error, /isn't a GitHub repository/);
  assert.equal(calls.length, 0);
});

test('an existing folder is never cloned over', async () => {
  const b = base();
  try {
    fs.mkdirSync(path.join(b.dir, 'site'));
    const calls = [];
    const r = await clone.clone('me/site', b.dir, { spawnImpl: fakeSpawn({ calls }) });
    assert.match(r.error, /already exists/);
    assert.equal(calls.length, 0);
  } finally { b.done(); }
});

test('git gets fixed arguments, the URL after --, and no prompts', async () => {
  const b = base();
  try {
    const calls = [];
    const progress = [];
    const r = await clone.clone('me/site', b.dir, { spawnImpl: fakeSpawn({ calls }), onProgress: p => progress.push(p), env: { GIT_CONFIG_COUNT: '1' } });
    assert.deepEqual(r, { ok: true, root: path.join(b.dir, 'site') });
    assert.equal(calls[0].cmd, 'git');
    assert.deepEqual(calls[0].args, ['-c', 'core.fsmonitor=false', 'clone', '--progress', '--', 'https://github.com/me/site.git', path.join(b.dir, 'site')]);
    assert.equal(calls[0].opts.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(calls[0].opts.env.GIT_CONFIG_COUNT, '1');
    assert.equal(calls[0].opts.shell, undefined);
    assert.equal(calls[0].claimed, true, 'the folder was claimed before git ran');
    assert.deepEqual(progress.map(p => p.percent), [45, 100]);
  } finally { b.done(); }
});

test('a failed clone removes the folder it made, and says why', async () => {
  const b = base();
  try {
    const r = await clone.clone('me/private', b.dir, { spawnImpl: fakeSpawn({ code: 128, stderr: "remote: Repository not found.\nfatal: repository 'x' not found\n" }) });
    assert.equal(r.ok, false);
    assert.match(r.error, /GitHub wouldn't let Shellby clone it/);
    assert.ok(!fs.existsSync(path.join(b.dir, 'private')));
    assert.ok(fs.existsSync(b.dir), 'the folder you chose stays');
  } finally { b.done(); }
});

test('cancel kills git and cleans up', async () => {
  const b = base();
  try {
    const calls = [];
    const killed = [];
    const ac = new AbortController();
    const pending = clone.clone('me/big', b.dir, { spawnImpl: fakeSpawn({ code: null, calls }), signal: ac.signal, killTree: pid => { killed.push(pid); calls[0].child.finish(1); } });
    await new Promise(r => setImmediate(r));
    ac.abort();
    const r = await pending;
    assert.equal(r.cancelled, true);
    assert.deepEqual(killed, [4242]);
    assert.ok(!fs.existsSync(path.join(b.dir, 'big')));
  } finally { b.done(); }
});

test('Windows-reserved names are refused before anything runs', () => {
  assert.match(clone.target('me/con', os.tmpdir()).error, /can't make a folder/);
  assert.match(clone.target('me/nul.txt', os.tmpdir()).error, /can't make a folder/);
});

test('progress lines', () => {
  assert.deepEqual(clone.parseProgress('Receiving objects:  45% (450/1000)'), { phase: 'Receiving objects', percent: 45 });
  assert.deepEqual(clone.parseProgress('remote: Counting objects: 100% (5/5), done.'), { phase: 'Counting objects', percent: 100 });
  assert.equal(clone.parseProgress('Cloning into x...'), null);
});
