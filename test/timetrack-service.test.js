const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TimeTracker } = require('../src/main/timetrack-service');
const tt = require('../src/main/timetrack');

const SHELLBY = 'c:\\users\\jacob\\documents\\github\\shellby';
const RACK = 'c:\\users\\jacob\\documents\\github\\3d-rack';

// A tracker with everything it reaches for faked; `world` is what it sees.
function make(world = {}, saved = { timeTracking: { enabled: true } }) {
  let now = new Date(2026, 9, 3, 10, 0).getTime();
  const sent = [];
  const config = { get: k => saved[k], set: p => Object.assign(saved, p) };
  const t = new TimeTracker({
    config, now: () => now,
    toPanel: (ch, p) => sent.push([ch, p]),
    front: () => world.front ?? null,
    idle: () => world.idle ?? { idleMs: 0, locked: false },
    selfPid: 42,
    known: () => [{ key: SHELLBY, name: 'shellby' }, { key: RACK, name: '3d-rack' }],
    claudeAt: () => world.claude ?? { dirs: [], names: [] },
    resolve: async () => null,
  });
  t.lastGit = Infinity; // no git in unit tests
  const step = (ms = 15000) => { now += ms; t.tick(); };
  return { t, step, sent, saved, today: () => tt.dayKey(now) };
}

test('the window in front gets the time', () => {
  const world = { front: { pid: 1, exe: 'code.exe', title: 'main.js - shellby - Visual Studio Code' } };
  const { t, step, today } = make(world);
  step(); step();
  assert.equal(t.state.days[today()][SHELLBY], 30);
  world.front = { pid: 1, exe: 'spotify.exe', title: 'shellby' };
  step();
  assert.equal(t.state.days[today()][SHELLBY], 30, "music isn't work");
  assert.equal(t.nowView().key, null);
});

test('nothing counts while off, idle or locked', () => {
  const world = { front: { pid: 1, exe: 'code.exe', title: 'shellby - Visual Studio Code' }, idle: { idleMs: 10 * 60 * 1000, locked: false } };
  const off = make(world, { timeTracking: { enabled: false } });
  off.step();
  assert.deepEqual(off.t.state.days, {});
  const away = make(world);
  away.step();
  assert.deepEqual(away.t.state.days, {});
  world.idle = { idleMs: 0, locked: true };
  away.step();
  assert.deepEqual(away.t.state.days, {});
});

test('Claude in one project carries a window that names none; two projects carry nothing', () => {
  const world = { front: { pid: 1, exe: 'chrome.exe', title: 'MDN - Google Chrome' }, claude: { dirs: [], names: ['3d-rack'] } };
  const { t, step, today } = make(world);
  step();
  assert.equal(t.state.days[today()][RACK], 15);
  world.claude = { dirs: [], names: ['3d-rack', 'shellby'] };
  world.front = { pid: 1, exe: 'chrome.exe', title: 'Hacker News - Google Chrome' };
  // The 3d-rack signal from a moment ago still holds a browser for a few minutes...
  step();
  assert.equal(t.state.days[today()][RACK], 30);
  // ...and then lets go.
  step(6 * 60 * 1000);
  assert.equal(t.state.days[today()][RACK], 30);
});

test("Shellby's own window counts for the project Claude is working in", () => {
  const world = { front: { pid: 42, exe: 'shellby.exe', title: 'Shellby' }, claude: { dirs: [], names: ['shellby'] } };
  const { t, step, today } = make(world);
  step();
  assert.equal(t.state.days[today()][SHELLBY], 15);
  assert.equal(t.nowView().why, 'shellby');
});

test('a sleep or a stall counts one tick, not the gap', () => {
  const { t, step, today } = make({ front: { pid: 1, exe: 'code.exe', title: 'shellby - Visual Studio Code' } });
  step(3 * 60 * 60 * 1000);
  assert.equal(t.state.days[today()][SHELLBY], 15);
  step(20 * 1000); // a slightly late tick still counts what passed
  assert.equal(t.state.days[today()][SHELLBY], 35);
});

test('a project you stopped tracking is never timed, not even through Claude', () => {
  const world = { front: { pid: 1, exe: 'code.exe', title: 'shellby - Visual Studio Code' }, claude: { dirs: [], names: [] } };
  const { t, step, today, sent } = make(world);
  step();
  t.setProject(SHELLBY, { ignored: true });
  step();
  assert.equal(t.state.days[today()][SHELLBY], 15, 'nothing more after it was ignored');
  assert.equal(t.nowView().key, null);
  world.front = { pid: 1, exe: 'chrome.exe', title: 'Docs - Google Chrome' };
  world.claude = { dirs: [], names: ['shellby'] };
  step();
  assert.equal(t.nowView().key, null);
  assert.ok(sent.length, 'the header hears about it');
});

test('a folder git could not place is asked about again later', async () => {
  const answers = [null, { root: 'C:\\Users\\jacob\\Documents\\GitHub\\3d-rack', name: '3d-rack' }];
  const { t } = make();
  t.deps.resolve = async () => answers.shift();
  assert.equal(t.keyOf('C:\\Users\\jacob\\Documents\\GitHub\\3d-rack\\src'), null);
  await new Promise(r => setImmediate(r));
  assert.equal(t.keyOf('C:\\Users\\jacob\\Documents\\GitHub\\3d-rack\\src'), null, 'a miss is remembered for a while');
  const later = t.now() + 2 * 60 * 1000;
  t.now = () => later;
  assert.equal(t.keyOf('C:\\Users\\jacob\\Documents\\GitHub\\3d-rack\\src'), null);
  await new Promise(r => setImmediate(r));
  assert.equal(t.keyOf('C:\\Users\\jacob\\Documents\\GitHub\\3d-rack\\src'), RACK);
});

test('writes to settings every couple of minutes and on stop, not every tick', () => {
  const { t, step, saved } = make({ front: { pid: 1, exe: 'code.exe', title: 'shellby - Visual Studio Code' } });
  step();
  assert.equal(saved.timeTracking.days, undefined, 'not yet');
  for (let i = 0; i < 8; i++) step();
  assert.ok(saved.timeTracking.days, 'after two minutes');
  step();
  t.stop();
  assert.equal(Object.values(saved.timeTracking.days)[0][SHELLBY], t.state.days[Object.keys(t.state.days)[0]][SHELLBY]);
});

test('time by hand is checked', () => {
  const { t, today } = make();
  assert.equal(t.addTime({ key: 'c:\\nope', day: today(), minutes: 30 }).ok, false);
  assert.equal(t.addTime({ key: SHELLBY, day: '2099-01-01', minutes: 30 }).ok, false, 'not in the future');
  assert.equal(t.addTime({ key: SHELLBY, day: today(), minutes: 99999 }).ok, false);
  assert.equal(t.addTime({ key: SHELLBY, day: today(), minutes: 45, note: 'Kickoff call' }).ok, true);
  assert.equal(t.state.manual[today()][SHELLBY], 45 * 60);
  assert.equal(t.state.notes[today()][SHELLBY], 'Kickoff call');
  assert.equal(t.setProject(SHELLBY, { rate: 90, client: 'Harbor Tree' }).ok, true);
  assert.equal(t.state.projects[SHELLBY].rate, 90);
  assert.equal(t.setProject('c:\\nope', { rate: 90 }).ok, false);
});
