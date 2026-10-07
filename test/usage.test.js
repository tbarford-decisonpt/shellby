const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const { fromGetUsage, probe } = require('../src/main/usage');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');

test('get_usage is read into the same shape a turn reports (percent, ms timestamps)', () => {
  const r = {
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 42.4, resets_at: '2026-10-08T04:00:00+00:00' }, seven_day: { utilization: 7.6, resets_at: null } },
  };
  assert.deepEqual(fromGetUsage(r), {
    kind: 'usage', status: null,
    fiveHour: { pct: 42, resetsAt: Date.parse('2026-10-08T04:00:00Z') },
    sevenDay: { pct: 8, resetsAt: null },
  });
});

test('no plan limits (API key, missing scope) or an unexpected shape is null', () => {
  assert.equal(fromGetUsage(null), null);
  assert.equal(fromGetUsage({ rate_limits_available: false, rate_limits: null }), null);
  assert.equal(fromGetUsage({ rate_limits_available: true, rate_limits: { five_hour: null } }), null);
  assert.equal(fromGetUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 'lots' } } }), null);
});

test('probe asks a CLI for usage without sending a message', async () => {
  const u = await probe({ exe: process.execPath, argsPrefix: [FAKE], cwd: os.tmpdir() });
  assert.equal(u.fiveHour.pct, 42);
  assert.equal(u.sevenDay.pct, 8);
});

test('probe gives up quietly when the CLI never answers or won\'t start', async () => {
  const silent = ['-e', 'setInterval(() => {}, 1000)', '--'];
  assert.equal(await probe({ exe: process.execPath, argsPrefix: silent, cwd: os.tmpdir(), timeout: 500 }), null);
  assert.equal(await probe({ exe: path.join(os.tmpdir(), 'no-such-claude.exe'), cwd: os.tmpdir() }), null);
});
