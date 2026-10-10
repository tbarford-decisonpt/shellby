const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Config, DEFAULTS } = require('../src/main/config');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-config-'));

test('a fresh profile starts from the defaults', () => {
  const c = new Config(tempDir());
  assert.equal(c.get('mode'), DEFAULTS.mode);
  assert.equal(c.recoveredFrom, null);
});

test('saved settings survive a restart', () => {
  const dir = tempDir();
  new Config(dir).set({ routines: [{ id: 'r1' }] });
  assert.deepEqual(new Config(dir).get('routines'), [{ id: 'r1' }]);
});

test('an unreadable settings file is set aside, not overwritten by the next save', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"routines": [{"id": "r1"}');  // cut off mid-write
  const c = new Config(dir);
  assert.ok(c.recoveredFrom, 'says where the damaged copy went');
  assert.equal(fs.readFileSync(c.recoveredFrom, 'utf8'), '{"routines": [{"id": "r1"}');
  c.set({ mode: DEFAULTS.mode });
  assert.equal(fs.readFileSync(c.recoveredFrom, 'utf8'), '{"routines": [{"id": "r1"}', 'the old copy is still there to rescue');
});

test('settings that parse but are not an object are set aside too', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), '[1, 2]');
  const c = new Config(dir);
  assert.ok(c.recoveredFrom);
  assert.equal(c.get('mode'), DEFAULTS.mode);
});

test('a settings file that stays locked: defaults for now, and the real file is never overwritten', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"routines": [{"id": "r1"}]}');
  const realRead = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    if (p === file) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return realRead(p, ...rest);
  };
  let c;
  try { c = new Config(dir); } finally { fs.readFileSync = realRead; }
  assert.match(c.unreadable, /locked/);
  assert.equal(c.get('mode'), DEFAULTS.mode);
  c.set({ routines: [] });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"routines": [{"id": "r1"}]}');
});

test('a read blocked for a moment is retried', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"routines": [{"id": "r1"}]}');
  const realRead = fs.readFileSync;
  let blocked = 2;
  fs.readFileSync = (p, ...rest) => {
    if (p === file && blocked-- > 0) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    return realRead(p, ...rest);
  };
  let c;
  try { c = new Config(dir); } finally { fs.readFileSync = realRead; }
  assert.equal(c.unreadable, null);
  assert.deepEqual(c.get('routines'), [{ id: 'r1' }]);
});

test('a rename blocked for a moment (antivirus) is retried', () => {
  const dir = tempDir();
  const c = new Config(dir);
  const realRename = fs.renameSync;
  let blocked = 2;
  fs.renameSync = (...args) => {
    if (blocked-- > 0) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    return realRename(...args);
  };
  try { c.set({ routines: [{ id: 'r2' }] }); } finally { fs.renameSync = realRename; }
  assert.deepEqual(new Config(dir).get('routines'), [{ id: 'r2' }]);
});

test('a rename that stays blocked still saves, by writing in place', () => {
  const dir = tempDir();
  const c = new Config(dir);
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  try { c.set({ routines: [{ id: 'r3' }] }); } finally { fs.renameSync = realRename; }
  assert.deepEqual(new Config(dir).get('routines'), [{ id: 'r3' }]);
});

// With Windows' animation effects off he only strolls if you switched it on
// yourself (motion.js wanders), and every save writes wander: true by default.
test('setting wander yourself is remembered apart from the default', () => {
  const dir = tempDir();
  const c = new Config(dir);
  c.set({ mode: 'plan' });
  assert.equal(new Config(dir).get('wander'), true);
  assert.equal(new Config(dir).get('wanderChosen'), false, 'the default saved is not a choice');
  c.set({ wander: true });
  assert.equal(new Config(dir).get('wanderChosen'), true);
});

// A PC switched off at the wall left settings.json the right size and all zero
// bytes: the rename reached the disk, the data didn't.
test('a settings file of zeros (a power cut) comes back from the backup', () => {
  const dir = tempDir();
  new Config(dir).set({ routines: [{ id: 'r1' }], onboarded: true });
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size));
  const c = new Config(dir);
  assert.ok(c.recoveredFrom, 'the zeros are set aside');
  assert.equal(c.restoredFrom, path.join(dir, 'settings.backup.json'));
  assert.equal(c.lost, false);
  assert.deepEqual(c.get('routines'), [{ id: 'r1' }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).routines, [{ id: 'r1' }], 'and settings.json is whole again');
});

test('a missing settings file with a backup beside it is not a fresh profile', () => {
  const dir = tempDir();
  new Config(dir).set({ routines: [{ id: 'r1' }] });
  new Config(dir); // a boot that read them fine leaves the backup
  fs.rmSync(path.join(dir, 'settings.json'));
  const c = new Config(dir);
  assert.equal(c.recoveredFrom, null);
  assert.ok(c.restoredFrom);
  assert.deepEqual(c.get('routines'), [{ id: 'r1' }]);
});

test('settings damaged with no backup are lost, and say so', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), Buffer.alloc(64));
  const c = new Config(dir);
  assert.equal(c.lost, true);
  assert.equal(c.restoredFrom, null);
  assert.equal(new Config(tempDir()).lost, false, 'a fresh profile is not a lost one');
});

test('the backup is the last copy read fine, refreshed hourly while he runs', () => {
  const dir = tempDir();
  const backup = path.join(dir, 'settings.backup.json');
  new Config(dir).set({ routines: [{ id: 'r1' }] });
  let now = 1000;
  const c = new Config(dir, { now: () => now });
  assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')).routines, [{ id: 'r1' }]);
  c.set({ routines: [{ id: 'r2' }] });
  assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')).routines, [{ id: 'r1' }], 'not on every save');
  now += 60 * 60 * 1000;
  c.set({ routines: [{ id: 'r3' }] });
  assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')).routines, [{ id: 'r3' }]);
});

test('a damaged file never becomes the backup', () => {
  const dir = tempDir();
  new Config(dir).set({ routines: [{ id: 'r1' }] });
  new Config(dir);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"routines": [');
  new Config(dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.backup.json'), 'utf8')).routines, [{ id: 'r1' }]);
});

test('each save is flushed to disk before it replaces settings.json', () => {
  const dir = tempDir();
  const c = new Config(dir);
  const realFsync = fs.fsyncSync;
  const realRename = fs.renameSync;
  const order = [];
  fs.fsyncSync = fd => { order.push('fsync'); return realFsync(fd); };
  fs.renameSync = (...a) => { order.push('rename'); return realRename(...a); };
  try { c.set({ mode: 'plan' }); } finally { fs.fsyncSync = realFsync; fs.renameSync = realRename; }
  assert.deepEqual(order.slice(0, 2), ['fsync', 'rename']);
  assert.equal(fs.existsSync(path.join(dir, 'settings.json.tmp')), false);
});
