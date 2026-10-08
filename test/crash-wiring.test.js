// Snags (wiring/crash.js): every one is logged, only the first few are said
// out loud, nothing is shown before settings load, and a build with crash
// reports asks before sending.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeElectron, fakeConfig } = require('./helpers/fake-ipc');

const electron = installFakeElectron();
electron.app.getVersion = () => '0.0.0';
const { wireCrash } = require('../src/main/wiring/crash');

function setup({ config = fakeConfig(), sentry = null } = {}) {
  const logged = [];
  const notes = [];
  const asked = [];
  const d = {
    config, sentry, CAPTURE: true,
    log: { error: (...a) => logged.push(a), warn: () => {} },
    notify: (title, body, onClick, opts) => notes.push({ title, body, onClick, opts }),
    askToSend: why => asked.push(why),
    reportProblem: () => {},
  };
  return { d, logged, notes, asked, ...wireCrash(d) };
}

test('every snag is logged, but only the first three are said', () => {
  const s = setup();
  for (let i = 0; i < 5; i++) s.snag('uncaught exception', new Error(`boom ${i}`));
  assert.equal(s.logged.length, 5);
  assert.equal(s.notes.length, 3, 'a loop must not become a storm of toasts');
});

test('a snag before settings load is only logged', () => {
  const s = setup({ config: null });
  s.snag('uncaught exception', new Error('early'));
  assert.equal(s.logged.length, 1);
  assert.equal(s.notes.length, 0);
});

test('without crash reports, the toast offers Report a problem', () => {
  const s = setup();
  s.snag('unhandled rejection', 'nope');
  assert.equal(s.notes[0].opts.action, 'Report it');
  assert.equal(s.notes[0].onClick, s.d.reportProblem);
});

test('with crash reports on "ask", the error goes to Sentry held and the toast asks', () => {
  const captured = [];
  const sentry = { captureException: (e, ctx) => captured.push([e.message, ctx.tags.snag]), captureMessage: () => {} };
  const s = setup({ sentry, config: fakeConfig({ crashReports: 'ask' }) });
  s.snag('a window died', new Error('gone'));
  assert.deepEqual(captured, [['gone', 'a window died']]);
  assert.equal(s.notes[0].opts.action, 'Send report');
  s.notes[0].onClick();
  assert.deepEqual(s.asked, ['snag']);
});

test('a second launch bowing out starts no crash reports', () => {
  const s = setup();
  assert.deepEqual(s.startCrashReports(false), { lastRun: { unclean: false }, sentry: null });
});
