// Streaks and nudges as main runs them (wiring/streaks.js): what the panel is
// shown, a finished task keeping the streak, and the hourly check.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installFakeElectron, fakeConfig } = require('./helpers/fake-ipc');

installFakeElectron();
const streaks = require('../src/main/streaks');
const { wireStreaks } = require('../src/main/wiring/streaks');

const DAY = 24 * 60 * 60 * 1000;

function setup(initial = {}) {
  const config = fakeConfig(initial);
  const sent = [];
  const calls = { touched: [], leaving: 0, status: 0, notified: [] };
  const d = {
    CAPTURE: false, config, panel: { isVisible: () => false, isFocused: () => false },
    send: (_win, channel, payload) => sent.push([channel, payload]),
    refreshStatusLine: () => { calls.status++; },
    timeTracker: { touch: dir => calls.touched.push(dir) },
    checkLeavingSoon: () => { calls.leaving++; },
    flashState: () => {},
    notify: (...args) => calls.notified.push(args),
    showPanel: () => {},
    journal: { draftFor: () => '' },
  };
  return { d, config, sent, calls, ...wireStreaks(d) };
}

// A folder git won't call a repository, so asking it about one takes a real round trip.
const made = [];
const notARepo = () => { const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-streaks-'))); made.push(dir); return dir; };
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

test('the panel sees projects newest first, with how long each has been quiet', () => {
  const now = Date.now();
  const s = setup({
    streaks: {
      projects: {
        'c:\\old': { name: 'old', lastSeen: now - 5 * DAY, lastCommitAt: now - 3 * DAY },
        'c:\\new': { name: 'new', lastSeen: now - DAY, lastCommitAt: null },
      },
    },
  });
  const v = s.streaksView();
  assert.deepEqual(v.projects.map(p => p.name), ['new', 'old']);
  assert.equal(v.projects[0].quietDays, null, 'no commit known: not quiet');
  assert.equal(v.projects[1].quietDays, 3);
});

test('saving tells the panel and the status line', () => {
  const s = setup();
  s.saveStreaks(streaks.recordWorkDay(null, Date.now()));
  assert.equal(s.sent.at(-1)[0], 'streaks');
  assert.equal(s.sent.at(-1)[1].today, true);
  assert.equal(s.calls.status, 1);
});

test('a task finished outside a repository still keeps the streak', async () => {
  const s = setup();
  const dir = notARepo();
  await s.recordWork(dir);
  assert.equal(streaks.normalize(s.config.get('streaks')).days.length, 1);
  assert.deepEqual(s.calls.touched, [dir], 'the time tracker hears where you worked');
  assert.equal(s.calls.leaving, 1);
  assert.equal(s.config.get('weekly'), undefined, 'no repository, no top project');
});

test('screenshot runs leave streaks alone', async () => {
  const s = setup();
  s.d.CAPTURE = true;
  await s.recordWork(notARepo());
  await s.checkNudges();
  assert.equal(s.config.get('streaks'), undefined);
  assert.equal(s.sent.length, 0);
});

// The hourly check asks git about every project, one after another, which can
// take seconds. What changed in the meantime must not be written over.
test('a project muted while the hourly check asks git stays muted', async () => {
  const now = Date.now();
  const a = notARepo();
  const b = notARepo();
  const s = setup({ streaks: { projects: { [a]: { name: 'a', lastSeen: now }, [b]: { name: 'b', lastSeen: now } } } });
  const checking = s.checkNudges();
  s.config.set({ streaks: streaks.setMuted(s.config.get('streaks'), b, true) }); // the panel's Mute, mid-check
  await checking;
  assert.equal(streaks.normalize(s.config.get('streaks')).projects[b].muted, true);
});

test('a task finished while the hourly check asks git still counts', async () => {
  const now = Date.now();
  const s = setup({ streaks: { projects: { [notARepo()]: { name: 'a', lastSeen: now } } } });
  const checking = s.checkNudges();
  s.saveStreaks(streaks.recordProject(streaks.recordWorkDay(s.config.get('streaks'), now), 'c:\\elsewhere', 'elsewhere', now));
  await checking;
  const kept = streaks.normalize(s.config.get('streaks'));
  assert.ok(kept.projects['c:\\elsewhere'], 'the project it ran in is remembered');
  assert.equal(kept.days.length, 1, 'and the day it worked');
});
