const { test } = require('node:test');
const assert = require('node:assert/strict');
const { keepPainting, watchesDesktop, isTestRun, SWITCHES } = require('../src/main/test-desktop');

const fakeApp = isPackaged => { const added = []; return { isPackaged, added, commandLine: { appendSwitch: (...a) => added.push(a) } }; };

test('a fake-CLI or motion-test dev run keeps its windows painting' , () => {
  for (const env of [{ SHELLBY_FAKE_CLAUDE: 'fake.js' }, { SHELLBY_MOTION_TEST: '1' }]) {
    const app = fakeApp(false);
    assert.equal(keepPainting(app, env), true);
    assert.deepEqual(app.added, SWITCHES);
  }
});

test('a dev run you are using, or a packaged app, keeps Chromium\'s savings', () => {
  const dev = fakeApp(false);
  assert.equal(keepPainting(dev, {}), false);
  assert.equal(keepPainting(dev, { SHELLBY_MOTION_TEST: '0' }), false);
  const packaged = fakeApp(true);
  assert.equal(keepPainting(packaged, { SHELLBY_FAKE_CLAUDE: 'fake.js', SHELLBY_MOTION_TEST: '1' }), false);
  assert.deepEqual([...dev.added, ...packaged.added], []);
  assert.equal(isTestRun({}, false), false);
});

test('a test run does not watch what covers the crab, unless it asks to', () => {
  assert.equal(watchesDesktop({ SHELLBY_FAKE_CLAUDE: 'fake.js' }, false), false);
  assert.equal(watchesDesktop({ SHELLBY_MOTION_TEST: '1' }, false), false);
  assert.equal(watchesDesktop({ SHELLBY_FAKE_CLAUDE: 'fake.js', SHELLBY_COVER_POLL: '1' }, false), true);
  assert.equal(watchesDesktop({}, false), true);
  assert.equal(watchesDesktop({ SHELLBY_FAKE_CLAUDE: 'fake.js' }, true), true);
});

test('a run measuring his real cost gets the real desktop, fake CLI or not', () => {
  const env = { SHELLBY_FAKE_CLAUDE: 'fake.js', SHELLBY_REAL_DESKTOP: '1' };
  const app = fakeApp(false);
  assert.equal(isTestRun(env, false), false);
  assert.equal(keepPainting(app, env), false);
  assert.deepEqual(app.added, []);
  assert.equal(watchesDesktop(env, false), true);
});
