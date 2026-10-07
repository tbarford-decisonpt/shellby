// Opening the profile at boot (wiring/profile.js): settings and history are
// there for everything after, rooms are decided once, and a settings file that
// couldn't be read is written down rather than lost quietly.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installFakeElectron } = require('./helpers/fake-ipc');

const userData = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-profile-')));
after(() => fs.rmSync(userData, { recursive: true, force: true }));
installFakeElectron({ userData });
const { wireProfile } = require('../src/main/wiring/profile');

function open() {
  const errors = [];
  const d = { log: { error: (...a) => errors.push(a), info: () => {}, warn: () => {} } };
  wireProfile(d).openProfile();
  return { d, errors };
}

test('settings and history are open for everything after', () => {
  const { d, errors } = open();
  assert.equal(typeof d.config.get, 'function');
  assert.ok(Array.isArray(d.history.list()));
  assert.equal(errors.length, 0);
});

test('rooms are decided once and kept', () => {
  const first = open().d.config.get('rooms');
  assert.ok(first != null);
  const { d } = open();
  assert.deepEqual(d.config.get('rooms'), first);
});

test('a settings file that could not be read is logged with where the old copy went', () => {
  fs.writeFileSync(path.join(userData, 'settings.json'), '{ not json');
  const { d, errors } = open();
  assert.ok(d.config.recoveredFrom);
  assert.match(errors[0][0], /could not be read/);
});
