const { test } = require('node:test');
const assert = require('node:assert/strict');

// Just enough of an AudioContext for sound.js: a state, suspend/resume, and
// nodes that connect to anything.
class FakeAudioContext {
  constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 8000; this.destination = {}; this.calls = []; FakeAudioContext.last = this; }
  suspend() { this.calls.push('suspend'); this.state = 'suspended'; return Promise.resolve(); }
  resume() { this.calls.push('resume'); this.state = 'running'; return Promise.resolve(); }
  node() {
    const param = { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} };
    const n = { gain: param, frequency: { ...param }, Q: { ...param }, connect: x => x || n, start() {}, stop() {} };
    return n;
  }
  createGain() { return this.node(); }
  createOscillator() { return this.node(); }
  createBiquadFilter() { return this.node(); }
  createBufferSource() { return this.node(); }
  createBuffer(_c, len) { return { getChannelData: () => new Float32Array(len) }; }
}

const flush = () => new Promise(r => setImmediate(r)); // the promise callbacks queued so far

function loadSound(t, Ctx) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e6 });
  globalThis.AudioContext = Ctx;
  delete require.cache[require.resolve('../src/renderer/critter/sound.js')];
  require('../src/renderer/critter/sound.js');
  const sound = globalThis.ShellbySound;
  sound.setMix({ fx: true, voice: true, ambient: 'off', volume: 60 });
  t.after(() => { delete globalThis.AudioContext; delete globalThis.ShellbySound; });
  return sound;
}

test('sound: rests the audio device after a quiet spell, and wakes it for the next cue', async t => {
  const sound = loadSound(t, FakeAudioContext);

  assert.equal(sound.cue('hop'), true);
  const ac = FakeAudioContext.last;
  t.mock.timers.tick(2000);
  assert.equal(sound.cue('land'), true); // another sound pushes the rest back
  t.mock.timers.tick(4000);
  assert.equal(ac.state, 'running');
  t.mock.timers.tick(1500);
  assert.equal(ac.state, 'suspended', 'five quiet seconds after the last sound');
  await flush();

  assert.equal(sound.cue('hop'), true);
  assert.equal(ac.state, 'running', 'the next cue resumes it before it plays');
  assert.deepEqual(ac.calls, ['suspend', 'resume']);
});

// A real suspend() reads 'running' until it has gone through.
class SlowSuspendContext extends FakeAudioContext {
  suspend() { this.calls.push('suspend'); return new Promise(r => { this.finishSuspend = () => { this.state = 'suspended'; r(); }; }); }
}

test('sound: a cue in the moment the device is being rested still wakes it', async t => {
  const sound = loadSound(t, SlowSuspendContext);
  sound.cue('hop');
  const ac = SlowSuspendContext.last;
  t.mock.timers.tick(5500);
  assert.deepEqual(ac.calls, ['suspend']);
  assert.equal(ac.state, 'running', 'still going down');

  sound.cue('land');
  ac.finishSuspend();
  await flush();
  assert.equal(ac.state, 'running', 'woken once the rest went through, not left asleep with the cue on it');
  assert.deepEqual(ac.calls, ['suspend', 'resume']);
});
