// away-service.js: noticing you're back, and the "safe to leave?" answer kept
// for the shutdown guard, with fakes for Windows and the windows.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAway, AWAY_POLL_MS } = require('../src/main/away-service');

const NOW = 1_790_000_000_000;
const MIN = 60 * 1000;

function fakeWindow() {
  const handlers = {};
  return {
    handlers,
    isDestroyed: () => false,
    isVisible: () => false,
    isFocused: () => false,
    on: (event, fn) => { handlers[event] = fn; },
  };
}

function setup(over = {}) {
  const data = { recap: true, ...over.data };
  const calls = { send: [], notify: [], every: [], warn: [], power: [] };
  const d = {
    config: { get: k => data[k], set: patch => Object.assign(data, patch) },
    critter: fakeWindow(),
    panel: fakeWindow(),
    manager: null,
    external: null,
    devServers: null,
    CAPTURE: false,
    RECAP_TEST: !!over.recapTest,
    powerMonitor: {
      getSystemIdleTime: () => { if (over.idleThrows) throw new Error('no idle time'); return 0; },
      getSystemIdleState: () => 'active',
      on: event => calls.power.push(event),
    },
    native: over.native || {},
    confirm: { ask: async () => 1 },
    log: { info: () => {}, warn: (...a) => calls.warn.push(a) },
    send: (win, channel, payload) => calls.send.push({ win, channel, payload }),
    every: (fn, ms) => calls.every.push(ms),
    speak: () => {},
    notify: (title, body) => calls.notify.push({ title, body }),
    showPanel: () => {},
    dialogLook: () => ({}),
    limitWait: () => null,
  };
  return { away: createAway(d), d, calls };
}

test('coming back after a long absence gets a wave from the crab', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { away, d, calls } = setup();

  away.checkAway({ idleMs: 5 * MIN });
  t.mock.timers.setTime(NOW + 2 * 60 * MIN);
  away.checkAway({ idleMs: 0 });

  const greet = calls.send.find(s => s.channel === 'critter:greet');
  assert.ok(greet, 'he greets you');
  assert.equal(greet.win, d.critter);
  assert.ok(greet.payload.awayMs >= 60 * MIN);
});

test('a short break earns no greeting', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { away, calls } = setup();

  away.checkAway({ idleMs: 5 * MIN });
  t.mock.timers.setTime(NOW + 10 * MIN);
  away.checkAway({ idleMs: 0 });

  assert.equal(calls.send.length, 0);
});

test('an idle time Windows cannot give is logged, not thrown', () => {
  const { away, calls } = setup({ idleThrows: true });

  assert.doesNotThrow(() => away.checkAway());
  assert.equal(calls.warn.length, 1);
});

test('the recap log keeps what happened, and can be replaced for dev:usage', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { away } = setup();

  away.noteRecap({ kind: 'run', title: 'Fix it', outcome: 'ok' });
  away.noteRecap(null);
  assert.equal(away.recapLog.length, 1);

  away.recapLog = [];
  assert.deepEqual(away.recapLog, []);
});

test('the away poll goes through main\'s every(), so quitting clears it', () => {
  const { away, calls } = setup();

  away.watchAway();

  assert.deepEqual(calls.every, [AWAY_POLL_MS]);
  assert.deepEqual(calls.power.sort(), ['lock-screen', 'resume', 'suspend', 'unlock-screen']);
});

test('the shutdown guard lets Windows go when nothing is at risk', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // the first background check never runs here
  const released = [];
  const native = { hwndOf: () => 1, unblockShutdown: h => released.push(h), blockShutdown: () => true };
  const { away, d } = setup({ native });

  away.watchLeaving();
  let prevented = false;
  d.critter.handlers['query-session-end']({ reasons: [], preventDefault: () => { prevented = true; } });

  assert.equal(prevented, false);
  assert.deepEqual(released, [1]);
});

test('each idle reading is passed on to whoever listens (Keep warm)', () => {
  const readings = [];
  const away = createAway({
    config: { get: () => undefined, set: () => {} }, RECAP_TEST: true, CAPTURE: false,
    log: { info: () => {}, warn: () => {} }, send: () => {},
    onIdleReading: r => readings.push(r),
  });
  away.checkAway({ idleMs: 5000 });
  away.checkAway({ idleMs: 3 * MIN, locked: true });
  assert.deepEqual(readings, [{ idleMs: 5000, locked: false }, { idleMs: 3 * MIN, locked: true }]);
});

test("a keep-warm ping isn't listed as work in flight when you ask if it's safe to leave", () => {
  const tab = (id, extra) => [id, { id, title: id, session: { busy: true, pending: new Map() }, ...extra }];
  const { away, d } = setup();
  d.manager = { tabs: new Map([tab('pinged', { pinging: { resolve() {} } }), tab('working')]) };
  const lines = away.leaveVerdict().lines;
  assert.ok(lines.includes('Still working: working'));
  assert.ok(!lines.some(l => l.includes('pinged')), 'the ping is nobody\'s work');
});
