// Crash reports only leave with the user's say-so, so the gate is the part that
// matters most: what waits, what goes and what's dropped. Also the marker that
// tells a crash from a quit, and the scrub every event gets.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cr = require('../src/main/crash-report');
const { Log } = require('../src/main/log');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
// An envelope as Sentry's offline transport hands it over: [header, [[itemHeader, payload]]].
const envelopeAt = ms => [{ event_id: 'abc', sent_at: new Date().toISOString() }, [[{ type: 'event' }, { timestamp: ms / 1000 }]]];
const sessionEnvelope = [{}, [[{ type: 'session' }, { sid: 'x' }]]];

// ---------------------------------------------------------------- the marker

test('a first start is clean, and a start after a clean quit is too', () => {
  const dir = tmp();
  assert.deepEqual(cr.startRun(dir, { version: '1.0.0' }), { unclean: false });
  cr.endRun(dir);
  assert.deepEqual(cr.startRun(dir, { version: '1.0.0' }), { unclean: false });
});

test('a run that never quit is reported by the next start', () => {
  const dir = tmp();
  cr.startRun(dir, { version: '0.63.1', now: () => 1000 });
  const next = cr.startRun(dir, { version: '0.63.2', now: () => 2000 });
  assert.deepEqual(next, { unclean: true, startedAt: 1000, version: '0.63.1', cause: null });
});

test('a run Windows was shutting down is blamed on the shutdown, not him', () => {
  const dir = tmp();
  cr.startRun(dir, { version: '0.63.1', now: () => 1000 });
  cr.markEnding(dir, true, { now: () => 1500 });
  const next = cr.startRun(dir, { version: '0.63.1', now: () => 2000, bootedAt: 500 });
  assert.equal(next.unclean, true);
  assert.equal(next.cause, 'shutdown');
});

test('a cancelled shutdown takes the excuse back', () => {
  const dir = tmp();
  cr.startRun(dir, { now: () => 1000 });
  cr.markEnding(dir, true, { now: () => 1500 });
  cr.markEnding(dir, false);
  assert.equal(cr.startRun(dir, { now: () => 2000, bootedAt: 500 }).cause, null);
});

test('a PC that booted since the run started is a restart or power loss', () => {
  const dir = tmp();
  cr.startRun(dir, { now: () => 1000 });
  assert.equal(cr.startRun(dir, { now: () => 9000, bootedAt: 5000 }).cause, 'restart');
});

test('a shutdown question after a clean quit leaves no marker behind', () => {
  const dir = tmp();
  cr.startRun(dir);
  cr.endRun(dir);
  cr.markEnding(dir);
  assert.equal(fs.existsSync(cr.markerFile(dir)), false);
});

test('a folder it cannot write to does not throw', () => {
  const file = path.join(tmp(), 'not-a-folder');
  fs.writeFileSync(file, 'x');
  assert.doesNotThrow(() => cr.startRun(file));
  assert.doesNotThrow(() => cr.endRun(file));
});

test('the previous run\'s log tail stops at this run\'s starting line', () => {
  const dir = tmp();
  const file = path.join(dir, 'shellby.log');
  fs.writeFileSync(file, [
    '2026-10-04 04:27:47 info  Shellby 0.63.1 starting — win32',
    '2026-10-04 04:30:49 info  worktree: a',
    '2026-10-04 04:37:19 info  worktree: b',
    '2026-10-04 04:37:54 info  Shellby 0.63.1 starting — win32',
    '2026-10-04 04:38:00 info  this run',
  ].join('\n') + '\n');
  assert.deepEqual(cr.previousLogTail(file, 2), ['2026-10-04 04:30:49 info  worktree: a', '2026-10-04 04:37:19 info  worktree: b']);
  assert.deepEqual(cr.previousLogTail(path.join(dir, 'missing.log')), []);
});

test('the tail reaches into the rotated log when it has to', () => {
  const dir = tmp();
  const file = path.join(dir, 'shellby.log');
  fs.writeFileSync(`${file}.1`, '2026-10-04 04:00:00 info  Shellby 1.0.0 starting — x\n2026-10-04 04:10:00 info  last words\n');
  fs.writeFileSync(file, '2026-10-04 04:20:00 info  Shellby 1.0.0 starting — x\n');
  assert.deepEqual(cr.previousLogTail(file), ['2026-10-04 04:00:00 info  Shellby 1.0.0 starting — x', '2026-10-04 04:10:00 info  last words']);
  assert.deepEqual(cr.previousLogTail(null), []);
});

test('the tail matches what log.js actually writes', () => {
  const dir = tmp();
  const log = new Log(dir);
  log.info('Shellby 1.0.0 starting', 'win32');
  log.info('last words');
  log.info('Shellby 1.0.0 starting', 'win32');
  assert.equal(cr.previousLogTail(log.file).length, 2);
  assert.match(cr.previousLogTail(log.file)[1], /last words$/);
});

// ---------------------------------------------------------------- the gate

test('asking: a report waits until the user decides', () => {
  const gate = cr.makeGate(() => ({ consent: 'ask' }));
  assert.equal(gate.shouldSend(envelopeAt(5000)), false);
  assert.equal(gate.shouldStore(envelopeAt(5000)), true);
});

test('"Send" approves what happened before it, and nothing after', () => {
  const gate = cr.makeGate(() => ({ consent: 'ask', decisions: cr.addDecision([], 10_000, true) }));
  assert.equal(gate.shouldSend(envelopeAt(9_000)), true);
  assert.equal(gate.shouldSend(envelopeAt(11_000)), false);
  assert.equal(gate.shouldStore(envelopeAt(11_000)), true);
});

test('"Don\'t send" drops what happened before it, and keeps asking after', () => {
  const gate = cr.makeGate(() => ({ consent: 'ask', decisions: cr.addDecision([], 10_000, false) }));
  assert.equal(gate.decide(envelopeAt(9_000)), 'drop');
  assert.equal(gate.shouldStore(envelopeAt(9_000)), false);
  assert.equal(gate.decide(envelopeAt(11_000)), 'hold');
});

test('a report turned down stays turned down after a later "Send"', () => {
  // Snag A, Don't send; snag B, Send. A must not ride out with B.
  const decisions = cr.addDecision(cr.addDecision([], 10_000, false), 20_000, true);
  const gate = cr.makeGate(() => ({ consent: 'ask', decisions }));
  assert.equal(gate.decide(envelopeAt(9_000)), 'drop');
  assert.equal(gate.decide(envelopeAt(15_000)), 'send');
  assert.equal(gate.decide(envelopeAt(25_000)), 'hold');
});

test('...and after switching to always', () => {
  const decisions = cr.addDecision([], 10_000, false);
  const gate = cr.makeGate(() => ({ consent: 'always', decisions }));
  assert.equal(gate.decide(envelopeAt(9_000)), 'drop');
  assert.equal(gate.decide(envelopeAt(11_000)), 'send');
});

test('a report sent stays sendable after a later "Don\'t send" (offline at the time)', () => {
  const decisions = cr.addDecision(cr.addDecision([], 10_000, true), 20_000, false);
  const gate = cr.makeGate(() => ({ consent: 'ask', decisions }));
  assert.equal(gate.decide(envelopeAt(9_000)), 'send');
  assert.equal(gate.decide(envelopeAt(15_000)), 'drop');
});

test('the answers kept are bounded, oldest going first', () => {
  let list = [];
  for (let i = 1; i <= 25; i++) list = cr.addDecision(list, i * 1000, i % 2 === 0);
  assert.equal(list.length, 20);
  assert.equal(list[0].until, 6000);
  assert.deepEqual(cr.addDecision('junk', 5, true), [{ until: 5, send: true }]);
});

test('always sends; never sends nothing and keeps nothing', () => {
  const always = cr.makeGate(() => ({ consent: 'always' }));
  assert.equal(always.shouldSend(envelopeAt(1)), true);
  const never = cr.makeGate(() => ({ consent: 'never', decisions: cr.addDecision([], Infinity, true) }));
  assert.equal(never.shouldSend(envelopeAt(1)), false);
  assert.equal(never.shouldStore(envelopeAt(1)), false);
});

test('settings that throw when read count as asking (fail closed)', () => {
  const gate = cr.makeGate(() => { throw new ReferenceError('config is not defined'); });
  assert.equal(gate.decide(envelopeAt(1)), 'hold');
});

test('an unknown consent value counts as asking, not as yes', () => {
  const gate = cr.makeGate(() => ({ consent: 'yes please' }));
  assert.equal(gate.decide(envelopeAt(1)), 'hold');
  assert.equal(cr.normalizeConsent(undefined), 'ask');
});

test('envelopes without an event (sessions) are never sent or kept', () => {
  const gate = cr.makeGate(() => ({ consent: 'always' }));
  assert.equal(cr.envelopeTime(sessionEnvelope), null);
  assert.equal(gate.shouldSend(sessionEnvelope), false);
  assert.equal(gate.shouldStore(sessionEnvelope), false);
  assert.equal(cr.envelopeTime(null), null);
});

test('no settings yet (before config loads) means hold', () => {
  const gate = cr.makeGate(() => undefined);
  assert.equal(gate.decide(envelopeAt(1)), 'hold');
});

// ---------------------------------------------------------------- the event

test('every string in an event is scrubbed, and the PC name and user go', () => {
  const log = new Log(null, { home: 'C:\\Users\\jacob' });
  const event = {
    server_name: 'JACOBS-PC',
    user: { ip_address: '1.2.3.4' },
    message: 'failed in C:\\Users\\jacob\\proj with ghp_abcdefghijklmnopqrstuvwxyz',
    exception: { values: [{ stacktrace: { frames: [{ filename: 'C:/Users/jacob/x.js', lineno: 3 }] } }] },
  };
  const clean = cr.scrubEvent(event, s => log.scrub(s));
  assert.equal(clean.server_name, undefined);
  assert.equal(clean.user, undefined);
  assert.equal(clean.message, 'failed in ~\\proj with ghp_abcdef…');
  assert.equal(clean.exception.values[0].stacktrace.frames[0].filename, '~/x.js');
  assert.equal(clean.exception.values[0].stacktrace.frames[0].lineno, 3);
  assert.equal(event.server_name, 'JACOBS-PC', 'the original is left alone');
});

test('nothing gets through unscrubbed by being nested deep, or by being a key', () => {
  const log = new Log(null, { home: 'C:\\Users\\jacob' });
  let deep = { leak: 'C:\\Users\\jacob\\secret' };
  for (let i = 0; i < 20; i++) deep = { deep };
  const clean = cr.scrubEvent({ extra: { deep, 'C:\\Users\\jacob\\a.js': 1 } }, s => log.scrub(s));
  assert.doesNotMatch(JSON.stringify(clean), /jacob/i);
});

// ---------------------------------------------------------------- setup

test('the integrations that collect secrets or usage are left out', () => {
  const names = ['SentryMinidump', 'ElectronBreadcrumbs', 'ElectronNet', 'Console', 'LocalVariablesAsync', 'OnUncaughtException', 'MainProcessSession', 'ChildProcess'];
  const kept = cr.keepIntegrations(names.map(name => ({ name }))).map(i => i.name);
  assert.deepEqual(kept, ['SentryMinidump', 'ElectronBreadcrumbs', 'ChildProcess']);
});

test('dev builds only report when given a DSN; screenshot runs never do', () => {
  assert.equal(cr.dsnFor({ isPackaged: false, env: {} }), null);
  assert.equal(cr.dsnFor({ isPackaged: false, env: { SHELLBY_SENTRY_DSN: 'https://k@o1.ingest.sentry.io/2' } }), 'https://k@o1.ingest.sentry.io/2');
  assert.equal(cr.dsnFor({ isPackaged: false, capture: true, env: { SHELLBY_SENTRY_DSN: 'x' } }), null);
  assert.equal(cr.dsnFor({ isPackaged: true, env: { SHELLBY_SENTRY_DSN: 'x' } }), cr.DSN || null, 'a packaged build ignores the environment');
});
