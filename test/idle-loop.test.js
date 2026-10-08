// His idle loop (wiring/windows.js createMotion): every 15 s an idle crab may
// stroll, climb, hop onto a window, do a habit or say something. Not while he's
// calm (covered, under a game, nobody at the desk, the screen locked), and with
// Windows' animation effects off his window doesn't stroll unless you switched
// strolling on yourself. Also the bridge his page reports reduced motion on.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeElectron, createFakeIpc, fakeConfig } = require('./helpers/fake-ipc');

installFakeElectron();
process.env.SHELLBY_REDUCED_MOTION = '1'; // honoured even if this runs inside a test-run environment
const { wireWindows } = require('../src/main/wiring/windows');
const { registerCritterIpc } = require('../src/main/ipc/critter');

function rig(t, settings = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const sent = [];
  const config = fakeConfig({ chatter: 'normal', critterPos: { x: 600, y: 900 }, perch: 'off', climb: 'off', ...settings });
  const d = {
    config, BASE_PX: 4, crewShown: 0, guestShown: false, CAPTURE: false, IDLE_BIT_CHANCE: 1,
    lastStatus: { state: 'idle' }, calmReason: null,
    critter: { getPosition: () => [600, 900], getBounds: () => ({ x: 600, y: 900, width: 160, height: 136 }), setBounds() {}, isDestroyed: () => false },
    send: (_win, channel, payload) => sent.push([channel, payload]),
    speak: occasion => sent.push(['speak', occasion]),
    stat: () => {},
  };
  Object.assign(d, wireWindows(d));
  d.createMotion();
  const strolls = [];
  d.motion.stroll = x => { strolls.push(x); return true; };
  return { d, sent, strolls, config, idle: () => t.mock.timers.tick(15000) };
}

test('idle loop: an idle crab strolls or does a habit now and then', t => {
  const { sent, strolls, idle } = rig(t);
  for (let i = 0; i < 20; i++) idle();
  assert.ok(strolls.length > 0, 'he strolls');
  assert.ok(sent.some(([c]) => c === 'critter:bit'), 'and does his habits');
});

test('idle loop: calm, he holds still and says nothing', t => {
  const { d, sent, strolls, idle } = rig(t);
  d.calmReason = 'locked';
  for (let i = 0; i < 20; i++) idle();
  assert.deepEqual(strolls, []);
  assert.deepEqual(sent.filter(([c]) => c === 'critter:bit' || c === 'speak'), []);
});

test('idle loop: animations off, the default stops strolling; switched on yourself, he strolls', t => {
  const { d, sent, strolls, idle, config } = rig(t);
  d.setReducedMotion(true);
  assert.equal(d.wanders(), false);
  for (let i = 0; i < 20; i++) idle();
  assert.deepEqual(strolls, [], 'no strolls');
  assert.ok(sent.some(([c]) => c === 'critter:bit'), '...but his habits (which don\'t move his window) go on');
  config.set({ wander: true, wanderChosen: true });
  assert.equal(d.wanders(), true);
  for (let i = 0; i < 20; i++) idle();
  assert.ok(strolls.length > 0, 'switched on in Settings, he strolls');
  d.setReducedMotion(false);
  config.set({ wanderChosen: false });
  assert.equal(d.wanders(), true, 'animations back on: the default strolls');
});

test('critter:reduced-motion: only the crab\'s page tells main, and only a true is reduced', () => {
  const ipc = createFakeIpc();
  const told = [];
  registerCritterIpc(ipc.ipcMain, { setReducedMotion: on => told.push(on) });
  ipc.sendAs(ipc.senders.critter, 'critter:reduced-motion', true);
  ipc.sendAs(ipc.senders.critter, 'critter:reduced-motion', 'yes');
  assert.deepEqual(told, [true, false]);
  ipc.sendAs(ipc.senders.stranger, 'critter:reduced-motion', true);
  assert.deepEqual(told, [true, false], 'a stranger is refused');
});
