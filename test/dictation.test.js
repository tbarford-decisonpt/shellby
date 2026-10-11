// Push-to-talk: hold the hotkey, say the task.
//
// The tap-or-hold decision runs on a fake clock and a fake key, and the
// recognizer process is a fake child, so none of this needs a microphone. The
// one test that does touch Windows feeds the real recognizer a recording made
// by Windows' own speech synthesizer, and skips if the PC has no recognizer
// (a bare CI image may not).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  Dictation, PushToTalk, holdKeyOf, joinHeard, parseLine, friendlyError, helperScript,
} = require('../src/main/dictation');

// ------------------------------------------------------------------ the key to watch

test('holdKeyOf reads the key the recorder can set', () => {
  assert.equal(holdKeyOf('Control+Alt+Space'), 0x20);
  assert.equal(holdKeyOf('Control+Shift+K'), 0x4b);
  assert.equal(holdKeyOf('Alt+a'), 0x41);
  assert.equal(holdKeyOf('Control+7'), 0x37);
  assert.equal(holdKeyOf('Super+F1'), 0x70);
  assert.equal(holdKeyOf('Control+F12'), 0x7b);
  assert.equal(holdKeyOf('Control+F24'), 0x87);
});

test('holdKeyOf gives up on anything it cannot watch', () => {
  for (const accel of ['', null, undefined, 42, 'Control+F25', 'Control+F0', 'Control+Tab', 'Control+Plus']) {
    assert.equal(holdKeyOf(accel), null, String(accel));
  }
});

// ------------------------------------------------------------------ what came back

test('joinHeard makes one tidy line from the phrases', () => {
  assert.equal(joinHeard(['Fix the typo', ' in the readme ']), 'Fix the typo in the readme');
  assert.equal(joinHeard(['one\ntwo', '', null, 'three\u0007']), 'one two three');
  assert.equal(joinHeard([]), '');
  assert.equal(joinHeard('nope'), '');
  assert.equal(joinHeard(['x'.repeat(10000)]).length, 4000);
});

test('parseLine reads the helper and shrugs at noise', () => {
  assert.deepEqual(parseLine('{"type":"heard","id":"d1","text":"hello"}'), { type: 'heard', id: 'd1', text: 'hello' });
  assert.deepEqual(parseLine('{"type":"ready","text":"en-US"}'), { type: 'ready', id: null, text: 'en-US' });
  assert.equal(parseLine('not json'), null);
  assert.equal(parseLine('{"id":"d1"}'), null);
  assert.equal(parseLine('null'), null);
});

test('friendlyError says what to do about it', () => {
  assert.match(friendlyError('no-recognizer'), /Time & Language/);
  assert.match(friendlyError('No audio input is supplied to this recognizer.'), /microphone/i);
  assert.match(friendlyError('whatever'), /stopped working/);
});

test('the helper script reads the mic, or a recording for tests', () => {
  assert.match(helperScript(), /SetInputToDefaultAudioDevice/);
  const s = helperScript({ wav: 'C:\\temp\\a "b".wav' });
  assert.match(s, /SetInputToWaveFile\(@"C:\\temp\\a ""b"".wav"\)/);
});

// ------------------------------------------------------------------ tap or hold

/** PushToTalk on a clock and a key the test moves by hand. */
function rig(opts = {}) {
  let t = 1000;
  let down = true;
  const timers = [];
  const calls = [];
  const ptt = new PushToTalk({
    isDown: () => down,
    onPress: () => calls.push('press'),
    onTap: () => calls.push('tap'),
    onHold: () => calls.push('hold'),
    onRelease: () => calls.push('release'),
    holdMs: 300, pollMs: 30, maxMs: 5000,
    now: () => t,
    setTimer: fn => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
    ...opts,
  });
  // Advance the clock one poll and run what was due.
  const step = (ms = 30) => { t += ms; const fn = timers.shift(); fn?.(); };
  return { ptt, calls, step, setDown: v => { down = v; } };
}

test('a quick tap is a tap: the panel, as before', () => {
  const { ptt, calls, step, setDown } = rig();
  ptt.press();
  step(); step();
  setDown(false);
  step();
  assert.deepEqual(calls, ['press', 'tap']);
  assert.equal(ptt.active, false);
});

test('a hold is dictation: hold once, release when the key comes up', () => {
  const { ptt, calls, step, setDown } = rig();
  ptt.press();
  for (let i = 0; i < 20; i++) step();      // 600 ms
  assert.deepEqual(calls, ['press', 'hold'], 'hold is reported once');
  setDown(false);
  step();
  assert.deepEqual(calls, ['press', 'hold', 'release']);
  assert.equal(ptt.active, false);
});

test('the repeats of a held key are ignored', () => {
  const { ptt, calls, step } = rig();
  assert.equal(ptt.press(), true);
  step();
  assert.equal(ptt.press(), false);
  assert.equal(ptt.press(), false);
  assert.deepEqual(calls, ['press']);
});

test('a key already up by the first look is a tap', () => {
  const { ptt, calls, setDown } = rig();
  setDown(false);
  ptt.press();
  assert.deepEqual(calls, ['press', 'tap']);
});

test('a key that never comes up stops at the limit', () => {
  const { ptt, calls, step } = rig();
  ptt.press();
  for (let i = 0; i < 1000 && ptt.active; i++) step();
  assert.equal(ptt.active, false, 'it ended without the key coming up');
  assert.deepEqual(calls, ['press', 'hold', 'release']);
});

test('a key reader that throws counts as the key being up', () => {
  const { ptt, calls } = rig({ isDown: () => { throw new Error('koffi'); } });
  ptt.press();
  assert.deepEqual(calls, ['press', 'tap']);
});

test('reset drops a press without calling anything', () => {
  const { ptt, calls, step } = rig();
  ptt.press();
  ptt.reset();
  step();
  assert.deepEqual(calls, ['press']);
  assert.equal(ptt.active, false);
  assert.equal(ptt.press(), true, 'and the next press works');
});

// ------------------------------------------------------------------ the recognizer

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stdin = { lines: [], write(s) { this.lines.push(s.trim()); return true; }, on() {} };
  child.kill = () => { child.emit('exit', 0); };
  return child;
}

function withFake(opts = {}) {
  const children = [];
  const d = new Dictation({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    spawnImpl: () => { const c = fakeChild(); children.push(c); return c; },
    ...opts,
  });
  const say = (obj, i = children.length - 1) => children[i].stdout.emit('data', `${JSON.stringify(obj)}\n`);
  return { d, children, say };
}

test('warm resolves once the engine says it is ready', async () => {
  const { d, children, say } = withFake();
  const p = d.warm();
  assert.equal(d.status, 'starting');
  say({ type: 'ready', text: 'en-US' });
  assert.deepEqual(await p, { ok: true, culture: 'en-US' });
  assert.equal(d.status, 'ready');
  assert.deepEqual(await d.warm(), { ok: true, culture: 'en-US' }, 'already warm: no second process');
  assert.equal(children.length, 1);
  d.stop();
});

test('no recognizer installed: warm says how to get one', async () => {
  const { d, children, say } = withFake();
  const errors = [];
  d.on('error', e => errors.push(e));
  const p = d.warm();
  say({ type: 'error', text: 'no-recognizer' });
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.error, /speech language/);
  assert.equal(d.status, 'unavailable');
  assert.equal(errors.length, 1);
  // One might be installed by the next press: that press tries again.
  assert.equal(d.begin(), true);
  assert.equal(children.length, 2);
  d.stop();
});

test('no microphone when the engine loads: warm says where to look', async () => {
  const { d, say } = withFake();
  d.on('error', () => {});
  const p = d.warm();
  say({ type: 'error', text: 'No audio input is supplied to this recognizer.' });
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.error, /microphone/i);
});

test('an engine that fails to load during a press ends that press, with the reason', () => {
  const { d, children, say } = withFake();
  const results = [];
  d.on('error', () => {});
  d.on('result', r => results.push(r));
  assert.equal(d.begin(), true);
  say({ type: 'error', text: 'no-recognizer' });
  assert.equal(results.length, 1);
  assert.equal(results[0].text, '');
  assert.match(results[0].error, /speech language/);
  assert.equal(d.listening, false);
  assert.equal(children.length, 1);
});

test('a session: start, phrases, stop, then the result', () => {
  const { d, children, say } = withFake();
  const results = [];
  d.on('result', r => results.push(r));
  assert.equal(d.begin(), true);
  say({ type: 'ready', text: 'en-US' });
  assert.equal(d.listening, true);
  assert.deepEqual(children[0].stdin.lines, ['start d1']);
  say({ type: 'heard', id: 'd1', text: 'Fix the typo' });
  say({ type: 'heard', id: 'd1', text: 'in the readme' });
  assert.equal(d.finish(), true);
  assert.equal(d.listening, false);
  assert.deepEqual(children[0].stdin.lines, ['start d1', 'stop']);
  assert.deepEqual(results, [], 'not until the last words are in');
  say({ type: 'done', id: 'd1' });
  assert.deepEqual(results, [{ text: 'Fix the typo in the readme', error: null }]);
  d.stop();
});

test('one session at a time', () => {
  const { d } = withFake();
  assert.equal(d.begin(), true);
  assert.equal(d.begin(), false);
  d.stop();
});

test('a cancelled session reports nothing, even if words arrive late', () => {
  const { d, children, say } = withFake();
  const results = [];
  d.on('result', r => results.push(r));
  d.begin();
  assert.equal(d.cancel(), true);
  say({ type: 'heard', id: 'd1', text: 'stray' });
  say({ type: 'done', id: 'd1' });
  assert.deepEqual(results, []);
  assert.deepEqual(children[0].stdin.lines, ['start d1', 'cancel']);
  assert.equal(d.begin(), true, 'the next one can start');
  assert.deepEqual(children[0].stdin.lines.at(-1), 'start d2');
  d.stop();
});

test('words from an older session never leak into a new one', () => {
  const { d, say } = withFake();
  const results = [];
  d.on('result', r => results.push(r));
  d.begin(); d.cancel();
  d.begin();
  say({ type: 'heard', id: 'd1', text: 'old' });
  say({ type: 'heard', id: 'd2', text: 'new' });
  say({ type: 'done', id: 'd2' });
  assert.deepEqual(results, [{ text: 'new', error: null }]);
  d.stop();
});

test('if "done" never comes, what was heard is still delivered, and the mic is let go', async () => {
  const { d, children, say } = withFake({ finishMs: 20 });
  const results = [];
  d.on('result', r => results.push(r));
  d.begin();
  say({ type: 'heard', id: 'd1', text: 'almost' });
  d.finish();
  assert.equal(d.busy, true, 'still waiting for the last words');
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(results, [{ text: 'almost', error: null }]);
  assert.equal(d.busy, false);
  assert.deepEqual(children[0].stdin.lines, ['start d1', 'stop', 'cancel']);
  d.stop();
});

test('a helper that dies mid-session delivers what it had, and restarts on the next press', () => {
  const { d, children, say } = withFake();
  const results = [];
  d.on('result', r => results.push(r));
  d.begin();
  say({ type: 'ready', text: 'en-US' });
  say({ type: 'heard', id: 'd1', text: 'half a thought' });
  children[0].emit('exit', 1);
  assert.deepEqual(results, [{ text: 'half a thought', error: null }]);
  assert.equal(d.status, 'off');
  assert.equal(d.begin(), true);
  assert.equal(children.length, 2);
  d.stop();
});

test('a mic problem in one session is reported, and the next can still run', () => {
  const { d, say } = withFake();
  const errors = [], results = [];
  d.on('error', e => errors.push(e));
  d.on('result', r => results.push(r));
  d.begin();
  say({ type: 'ready', text: 'en-US' });
  say({ type: 'error', id: 'd1', text: 'No audio input is supplied to this recognizer.' });
  say({ type: 'done', id: 'd1' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /microphone/i);
  assert.equal(results.length, 1);
  assert.equal(results[0].text, '');
  assert.match(results[0].error, /microphone/i, 'the press knows why it heard nothing');
  assert.equal(d.status, 'ready');
  assert.equal(d.begin(), true);
  d.stop();
});

test('a warm that never hears back gives up and leaves no helper running', async () => {
  const { d, children } = withFake({ readyMs: 20 });
  d.on('error', () => {});
  const killed = [];
  const r = d.warm().then(x => { killed.push(children[0].killedAt ?? null); return x; });
  children[0].kill = () => { children[0].killedAt = 'yes'; children[0].emit('exit', 1); };
  assert.equal((await r).ok, false);
  assert.deepEqual(killed, ['yes']);
  assert.equal(d.child, null);
});

test('off Windows it is unavailable and spawns nothing', async () => {
  const spawned = [];
  const d = new Dictation({ platform: 'linux', spawnImpl: () => { spawned.push(1); return fakeChild(); } });
  d.on('error', () => {});
  const r = await d.warm();
  assert.equal(r.ok, false);
  assert.equal(d.begin(), false);
  assert.deepEqual(spawned, []);
});

test('a spawn that throws is handled, not propagated', async () => {
  const d = new Dictation({ platform: 'win32', env: {}, spawnImpl: () => { throw new Error('EPERM'); } });
  d.on('error', () => {});
  assert.equal((await d.warm()).ok, false);
  assert.equal(d.status, 'unavailable');
});

test('turning it off and on again gets a fresh try', async () => {
  const { d, say } = withFake();
  d.on('error', () => {});
  const p = d.warm();
  say({ type: 'error', text: 'no-recognizer' });
  await p;
  d.stop();
  assert.equal(d.status, 'off');
  const again = d.warm();
  say({ type: 'ready', text: 'en-US' });
  assert.equal((await again).ok, true);
  d.stop();
});

// ------------------------------------------------------------------ real Windows

test('Windows really recognises speech with the helper', { skip: process.platform !== 'win32' && 'Windows only', timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-dictation-'));
  const wav = path.join(dir, 'say.wav');
  try {
    // Windows reads a sentence aloud into a file, and the recognizer hears it.
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}'); $s.Speak('Fix the typo in the read me file.'); $s.Dispose()`]);
    const d = new Dictation({ wav });
    d.on('error', () => {});
    const ready = await d.warm();
    if (!ready.ok) { d.stop(); return t.skip(`no recognizer here: ${ready.error}`); }
    const result = new Promise(resolve => d.once('result', resolve));
    assert.equal(d.begin(), true);
    const { text } = await result;
    d.stop();
    assert.match(text, /typo/i);
    assert.match(text, /file/i);

    // A tap (begin, cancel) then a hold straight away: the helper is still
    // winding the tap down, and must start the hold once it has.
    const again = new Dictation({ wav });
    again.on('error', () => {});
    await again.warm();
    const second = new Promise(resolve => again.once('result', resolve));
    assert.equal(again.begin(), true);
    assert.equal(again.cancel(), true);
    assert.equal(again.begin(), true);
    assert.match((await second).text, /typo/i);
    again.stop();
  } finally {
    // PowerShell lets go of the file a moment after it's killed, so this
    // retries. fs.promises.rm, because Node 24's rmSync fails on the first
    // EPERM whatever maxRetries says.
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
