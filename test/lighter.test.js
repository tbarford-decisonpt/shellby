// Fewer processes (src/main/lighter.js): the network service runs inside main.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lighten } = require('../src/main/lighter');

const fakeApp = () => { const added = []; return { added, commandLine: { appendSwitch: (...a) => added.push(a) } }; };

test('the network service runs inside main', () => {
  const app = fakeApp();
  assert.equal(lighten(app, {}), true);
  assert.deepEqual(app.added, [['enable-features', 'NetworkServiceInProcess2']]);
});

test('SHELLBY_NETWORK_PROCESS=1 leaves it in its own process, to compare', () => {
  const app = fakeApp();
  assert.equal(lighten(app, { SHELLBY_NETWORK_PROCESS: '1' }), false);
  assert.deepEqual(app.added, []);
});

test('main asks for it before the app is ready, which is the only time switches count', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const at = main.indexOf("require('./lighter').lighten(app)");
  assert.ok(at > 0, 'main.js calls lighten');
  assert.ok(at < main.indexOf('app.whenReady()'), 'before whenReady');
});
