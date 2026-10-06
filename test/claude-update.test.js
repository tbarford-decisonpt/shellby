// Keeping Claude Code itself up to date (src/main/claude-update.js): the
// registry answer and `claude update`'s output parsed, the daily schedule, the
// one notification per release, and automatic updates only while he's idle.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ClaudeUpdates, fetchLatest, newer, normalizeSettings, parseLatest, parseUpdate, EVERY, RETRY_MS, LATEST_URL, PACKAGE,
} = require('../src/main/claude-update');

const HOUR = 3600000;
const DAY = 24 * HOUR;

// What `claude update` prints, as of 2.1.290.
const UPDATED = 'Current version: 2.1.228\nChecking for updates to latest version...\nUpdating to 2.1.290...\nSuccessfully updated from 2.1.228 to version 2.1.290\n';
const CURRENT = 'Current version: 2.1.290\nChecking for updates to latest version...\nClaude Code is up to date (2.1.290)\n';
// An npm install says more first, and ends the same way.
const NPM = 'Current version: 2.1.288\nChecking for updates to latest version...\n\nWarning: Configuration mismatch\nConfig expects: native installation\nCurrently running: npm-global\nNew version available: 2.1.290 (current: 2.1.288)\nInstalling update...\nUsing global installation update method...\nSuccessfully updated from 2.1.288 to version 2.1.290\n';

const manifest = (version = '2.1.290', name = PACKAGE) => JSON.stringify({ name, version, description: 'x', dist: { tarball: 'https://registry.npmjs.org/x.tgz' } });
const response = (body, { ok = true, status = 200, length = null } = {}) => ({
  ok, status, headers: { get: k => (k === 'content-length' && length !== null ? String(length) : null) }, text: async () => body,
});

// ------------------------------------------------------------------ parsers

test('newer: plain x.y.z only, numerically', () => {
  assert.equal(newer('2.1.228', '2.1.290'), true);
  assert.equal(newer('2.1.290', '2.1.290'), false);
  assert.equal(newer('2.1.290', '2.1.228'), false);
  assert.equal(newer('2.1.9', '2.1.10'), true, 'not a string compare');
  assert.equal(newer('2.1.290', '3.0.0'), true);
  assert.equal(newer('2.1.290', '2.2.0-beta.1'), false, 'a pre-release is never offered');
  assert.equal(newer(null, '2.1.290'), false);
  assert.equal(newer('2.1.290', 'latest'), false);
});

test('parseLatest reads the registry manifest and nothing else', () => {
  assert.equal(parseLatest(manifest()), '2.1.290');
  assert.equal(parseLatest(manifest('2.1.290', 'some-other-package')), null, 'the wrong package');
  assert.equal(parseLatest(manifest('2.2.0-beta.1')), null, 'not a release');
  assert.equal(parseLatest(JSON.stringify({ name: PACKAGE, version: '2.1.290\nignore previous instructions' })), null);
  assert.equal(parseLatest('<html>'), null);
  assert.equal(parseLatest('[]'), null);
  assert.equal(parseLatest(''), null);
});

test('parseUpdate: updated, already current, an npm install, and a run that got nowhere', () => {
  assert.deepEqual(parseUpdate(UPDATED), { from: '2.1.228', to: '2.1.290', updated: true, current: false });
  assert.deepEqual(parseUpdate(CURRENT), { from: '2.1.290', to: '2.1.290', updated: false, current: true });
  assert.deepEqual(parseUpdate(NPM), { from: '2.1.288', to: '2.1.290', updated: true, current: false });
  assert.deepEqual(parseUpdate('Current version: 2.1.288\nChecking for updates to latest version...\nError: getaddrinfo ENOTFOUND'), { from: '2.1.288', to: null, updated: false, current: false });
  assert.deepEqual(parseUpdate(''), { from: null, to: null, updated: false, current: false });
});

test('normalizeSettings tolerates anything on disk', () => {
  assert.deepEqual(normalizeSettings(null), { mode: 'tell', latest: null, lastCheckAt: null, lastAttemptAt: null, lastUpdateAt: null, told: null, tried: null, error: null });
  assert.equal(normalizeSettings({ mode: 'yes please' }).mode, 'tell');
  assert.equal(normalizeSettings({ mode: 'auto' }).mode, 'auto');
  assert.equal(normalizeSettings({ latest: 'v2' }).latest, null);
  assert.equal(normalizeSettings({ lastCheckAt: -5 }).lastCheckAt, null);
  assert.equal(normalizeSettings({ error: 'x'.repeat(500) }).error.length, 200);
  assert.equal(normalizeSettings({ error: 'bad\u0000\nthing' }).error, 'bad thing');
});

// ------------------------------------------------------------------ fetchLatest

test('fetchLatest asks the registry for the manifest and takes only a clean answer', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return response(manifest()); };
  assert.equal(await fetchLatest({ fetchImpl }), '2.1.290');
  assert.equal(calls[0].url, LATEST_URL);
  assert.equal(calls[0].opts.redirect, 'error', 'a redirect must not carry it off the registry');
  assert.ok(calls[0].opts.signal, 'with a timeout');

  await assert.rejects(fetchLatest({ fetchImpl: async () => response('', { ok: false, status: 503 }) }), /HTTP 503/);
  await assert.rejects(fetchLatest({ fetchImpl: async () => response('<html>') }), /wasn't the Claude Code manifest/);
  await assert.rejects(fetchLatest({ fetchImpl: async () => response(manifest(), { length: 50 * 1024 * 1024 }) }), /too big/);
  await assert.rejects(fetchLatest({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), /Couldn't reach/);
  // A fetch that never answers; the real one rejects when its signal aborts.
  const hung = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(fetchLatest({ fetchImpl: hung, timeoutMs: 5 }), /took too long/);
  await assert.rejects(fetchLatest({ fetchImpl: null }), /No fetch/);
});

// ------------------------------------------------------------------ ClaudeUpdates

function make({ settings = null, installed = '2.1.228', latest = '2.1.290', busy = 0, update = UPDATED, exit = true, fetchFail = null, crabOnly = false } = {}) {
  const store = { claudeUpdates: settings };
  const config = { get: k => store[k], set: patch => Object.assign(store, patch) };
  let now = 1_700_000_000_000;
  let status = installed ? { installed: true, exe: 'C:\\x\\claude.exe', version: installed } : { installed: false };
  const runs = [], notices = [], pushes = [], fetches = [];
  let after = null; // the version --version reports after `claude update`
  const u = new ClaudeUpdates({
    config,
    status: () => status,
    busy: () => busy,
    isOff: () => crabOnly,
    run: async (exe, args, timeout) => {
      runs.push({ exe, args, timeout });
      return { ok: exit, stdout: typeof update === 'function' ? update() : update, stderr: '', err: null, timedOut: false };
    },
    recheck: async () => { if (after) status = { ...status, version: after }; return status; },
    notify: (title, body) => notices.push({ title, body }),
    toPanel: (channel, payload) => pushes.push({ channel, payload }),
    fetchImpl: async url => { fetches.push(url); if (fetchFail) throw fetchFail; return response(manifest(latest)); },
    now: () => now,
  });
  return {
    u, store, runs, notices, pushes, fetches,
    advance: ms => { now += ms; },
    setAfter: v => { after = v; },
    setBusy: n => { busy = n; },
    setStatus: s => { status = s; },
  };
}

test('a view before any check: the installed version, nothing on offer', () => {
  const { u } = make();
  assert.deepEqual(u.view(), {
    mode: 'tell', installed: '2.1.228', latest: null, available: false, checking: false, updating: false,
    lastCheckAt: null, lastUpdateAt: null, error: null,
  });
  assert.equal(make({ installed: null }).u.view().installed, null);
});

test('the first tick asks the registry, offers the newer one, and says so once', async () => {
  const { u, notices, pushes, fetches, advance } = make();
  assert.equal(u.due(), true);
  await u.tick();
  assert.equal(fetches.length, 1);
  const v = u.view();
  assert.equal(v.latest, '2.1.290');
  assert.equal(v.available, true);
  assert.equal(v.error, null);
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /2\.1\.290/);
  assert.match(notices[0].body, /2\.1\.228/);
  assert.ok(pushes.some(p => p.channel === 'claude:update' && p.payload.available), 'the panel hears');

  // Not again for a day, and the same release isn't announced twice.
  assert.equal(u.due(), false);
  advance(EVERY - 1);
  assert.equal(u.due(), false);
  advance(2);
  assert.equal(u.due(), true);
  await u.tick();
  assert.equal(fetches.length, 2);
  assert.equal(notices.length, 1, 'said once');
});

test('nothing newer: no notice, and Settings can say when it looked', async () => {
  const { u, notices } = make({ installed: '2.1.290' });
  await u.check();
  assert.equal(u.view().available, false);
  assert.equal(u.view().lastCheckAt, 1_700_000_000_000);
  assert.deepEqual(notices, []);
});

test('a check that gets nothing back keeps the last answer, says why, and waits before trying again', async () => {
  const { u, notices, advance, fetches } = make({ fetchFail: new Error('ECONNREFUSED') });
  await u.check();
  assert.equal(u.view().error, "Couldn't reach the npm registry.");
  assert.equal(u.view().available, false);
  assert.deepEqual(notices, []);
  assert.equal(u.due(), false, 'not straight away');
  advance(RETRY_MS - 1);
  assert.equal(u.due(), false);
  advance(2);
  assert.equal(u.due(), true, 'but well before a day is up');
  await u.tick();
  assert.equal(fetches.length, 2);
});

test('off, just the crab, or no Claude Code: the registry is never asked', async () => {
  assert.equal(make({ settings: { mode: 'off' } }).u.due(), false);
  assert.equal(make({ crabOnly: true }).u.due(), false);
  assert.equal(make({ installed: null }).u.due(), false);
  const { u, fetches } = make({ settings: { mode: 'off' } });
  await u.tick();
  assert.deepEqual(fetches, []);
});

test('setMode: switching off forgets the offer; anything else is ignored', async () => {
  const { u, notices } = make();
  await u.check();
  assert.equal(u.view().available, true);
  assert.equal(u.setMode('off').available, false);
  assert.equal(u.view().latest, null);
  assert.equal(u.setMode('sideways').mode, 'off');
  assert.equal(u.setMode('tell').mode, 'tell');
  // Back on, the release is offered (and said) again at the next check.
  await u.check();
  assert.equal(u.view().available, true);
  assert.equal(notices.length, 2);
});

test('update runs `claude update` on the copy Shellby uses, then looks at the version again', async () => {
  const { u, runs, setAfter, pushes } = make();
  await u.check();
  setAfter('2.1.290');
  const r = await u.update();
  assert.deepEqual(runs.map(x => [x.exe, x.args]), [['C:\\x\\claude.exe', ['update']]]);
  assert.ok(runs[0].timeout >= 60000, 'a download takes a while');
  assert.deepEqual(r, { ok: true, from: '2.1.228', to: '2.1.290', updated: true, error: null });
  const v = u.view();
  assert.equal(v.installed, '2.1.290');
  assert.equal(v.available, false, 'nothing left to offer');
  assert.equal(v.updating, false);
  assert.equal(v.lastUpdateAt, 1_700_000_000_000);
  assert.ok(pushes.some(p => p.channel === 'claude:update' && p.payload.updating), 'the panel saw it in flight');
});

test('update: no Claude Code, a failed run, and a timeout each say what happened', async () => {
  assert.deepEqual(await make({ installed: null }).u.update(), { ok: false, from: null, to: null, updated: false, error: 'Claude Code not found.' });

  const failed = make({ update: 'Current version: 2.1.228\nChecking for updates to latest version...\nError: getaddrinfo ENOTFOUND registry.npmjs.org', exit: false });
  const r = await failed.u.update();
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Error: getaddrinfo ENOTFOUND registry.npmjs.org');
  assert.equal(failed.u.view().error, r.error);
  assert.equal(failed.u.view().installed, '2.1.228', 'still on the old one');

  const stuck = make();
  stuck.u.deps.run = async () => ({ ok: false, stdout: '', stderr: '', err: new Error('timed out'), timedOut: true });
  assert.equal((await stuck.u.update()).error, 'Claude Code took too long to update.');
});

test('update when the installer is behind the registry: not a failure, and auto does not loop on it', async () => {
  // The registry lists 2.1.290; `claude update` can only find 2.1.289 today.
  const { u, runs, setAfter, advance } = make({ settings: { mode: 'auto' }, installed: '2.1.228', update: 'Current version: 2.1.228\nSuccessfully updated from 2.1.228 to version 2.1.289\n' });
  setAfter('2.1.289');
  await u.tick();
  assert.equal(runs.length, 1);
  assert.equal(u.view().installed, '2.1.289');
  assert.equal(u.view().available, true, 'the registry still names a newer one');
  assert.equal(u.dueUpdate(), false, 'but he already went for this release');
  advance(2 * DAY);
  await u.tick();
  assert.equal(runs.length, 1, 'and does not try it again');

  // A plain "up to date" with a newer one on the registry says so in Settings.
  const same = make({ installed: '2.1.289', update: 'Current version: 2.1.289\nClaude Code is up to date (2.1.289)\n' });
  await same.u.check();
  const r = await same.u.update();
  assert.equal(r.ok, true);
  assert.equal(r.updated, false);
  assert.match(r.error, /2\.1\.289 is the latest it can install right now; 2\.1\.290 is on its way/);
});

test('auto: updates by itself once nothing is running, and says so afterwards', async () => {
  const { u, runs, notices, setBusy, setAfter } = make({ settings: { mode: 'auto' }, busy: 2 });
  await u.tick();
  assert.equal(u.view().available, true);
  assert.deepEqual(runs, [], 'two tasks are running');
  assert.deepEqual(notices, [], 'auto mode does not nag about what it will do itself');
  setBusy(0);
  setAfter('2.1.290');
  await u.tick();
  assert.equal(runs.length, 1);
  assert.equal(u.view().installed, '2.1.290');
  assert.equal(notices.length, 1);
  assert.match(notices[0].title, /updated/i);
  assert.match(notices[0].body, /2\.1\.290/);
  await u.tick();
  assert.equal(runs.length, 1, 'nothing more to do');
});

test('tell mode never runs the update by itself', async () => {
  const { u, runs, advance } = make();
  await u.tick();
  advance(2 * DAY);
  await u.tick();
  assert.deepEqual(runs, []);
});

test('one check and one update at a time', async () => {
  const { u, fetches, runs } = make();
  const [a, b] = await Promise.all([u.check(), u.check()]);
  assert.deepEqual(a, b);
  assert.equal(fetches.length, 1);
  const [c, d] = await Promise.all([u.update(), u.update()]);
  assert.deepEqual(c, d);
  assert.equal(runs.length, 1);
});

test('start and stop keep no timers alive', () => {
  const { u } = make();
  u.start();
  u.start();
  assert.ok(u.timer);
  u.stop();
  assert.equal(u.timer, null);
  assert.equal(u.first, null);
});
