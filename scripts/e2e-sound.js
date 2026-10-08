// End-to-end check of Shellby's sounds, against the dev app over CDP with the
// fake CLI (isolated profile):
//   1. All off by default, and no audio device is even opened
//   2. Effects on: switching them on plays a ta-da
//   3. A throw bumps and lands with a sound; a walk scuttles, and stops with him
//   4. The background plays, and changes from surf to rock pool
//   5. Guarding your focus or a call silences all of it, background included, and it comes back after
//   6. Settings the app doesn't know are refused
//   7. With animations off, the bumps go quiet but the background keeps playing
// Everything really runs through WebAudio (so a bad call would throw), into a
// muted output: the test machine stays silent. No Claude account, no usage.
//   node scripts/e2e-sound.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9380;
const HOOK = 47981;
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  return { send, ev, close: () => ws.close() };
}

function launch(data) {
  return spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...process.env, SHELLBY_USER_DATA: data,
      SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'),
      SHELLBY_HOOK_PORT: String(HOOK), SHELLBY_MOTION_TEST: '1',
    },
  });
}

async function windows() {
  let list = [];
  for (let i = 0; i < 40 && !(list.some(t => t.url.endsWith('panel.html')) && list.some(t => t.url.endsWith('critter.html'))); i++) {
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
    await wait(500);
  }
  return {
    panel: await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl),
    critter: await connect(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl),
  };
}

// Runs in the critter window before anything opens an AudioContext: every
// context made from here on plays into a gain of 0. Each cue, scuttle and
// background change is recorded on the way through, along with anything thrown.
const RIG = `(() => {
  class Muted extends AudioContext {
    get destination() {
      if (!this.__mute) { this.__mute = this.createGain(); this.__mute.gain.value = 0; this.__mute.connect(super.destination); }
      return this.__mute;
    }
  }
  window.AudioContext = Muted;
  window.__cues = []; window.__steps = []; window.__seas = []; window.__chirps = []; window.__errs = [];
  addEventListener('error', e => window.__errs.push(String(e.message)));
  const S = window.ShellbySound, A = window.ShellbyAmbient;
  const watch = (obj, name, log) => {
    const real = obj[name];
    obj[name] = (...args) => {
      try { const r = real(...args); log(args, r); return r; } catch (e) { window.__errs.push(name + ': ' + e.message); throw e; }
    };
  };
  watch(S, 'cue', ([n], played) => window.__cues.push([n, played]));
  watch(S, 'scuttle', ([speed]) => window.__steps.push(speed || 0));
  watch(A, 'set', ([kind]) => window.__seas.push(kind));
  watch(window.ShellbyChirp, 'play', ([occasion]) => window.__chirps.push(occasion));
  return true;
})()`;

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ onboarded: true, chatter: 'quiet', wander: false }));
  const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));

  const app = launch(data);
  try {
    const { panel, critter } = await windows();
    const until = async (c, expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.ev(expr)) return true; await wait(120); } return false; };
    const played = name => `window.__cues.some(([n, ok]) => n === ${JSON.stringify(name)} && ok)`;
    await wait(3000);
    // His moves follow Windows' animation setting, and any app holding the microphone
    // (Discord, a game recorder) reads as a call; pin both so the run doesn't depend on the PC.
    await panel.ev("shellby.dev.life({ what: 'call', on: false })");
    await critter.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

    // ------------------------------------------------------- 1. off by default
    const mix0 = await critter.ev('window.ShellbySound.mix');
    check(mix0 && !mix0.voice && !mix0.fx && mix0.ambient === 'off', `every sound is off on a fresh install (${JSON.stringify(mix0)})`);
    check(await critter.ev('window.ShellbySound.opened') === false, '...and no audio device is opened');
    check(await critter.ev(RIG), 'the muted rig is in');

    // ------------------------------------------------------- 2. effects on
    await panel.ev("shellby.setSettings({ soundFx: true, soundVolume: 25 })");
    check(await until(critter, 'window.ShellbySound.mix.fx && window.ShellbySound.mix.volume === 25'), 'switching effects on reaches the crab, at the soft volume');
    check(await until(critter, played('tada'), 3000), '...with a ta-da to say so');
    check(await critter.ev('window.ShellbySound.opened'), '...and now the audio device is open');

    // ------------------------------------------------------- 3. his body
    check(await panel.ev('shellby.dev.throw({ vx: -1800, vy: -1400 })'), 'a fast flick is a throw');
    check(await until(critter, played('bounce'), 6000), '...he bumps on the way');
    check(await until(critter, played('land'), 6000), '...and thumps down when he lands');
    await wait(1200);
    check(await panel.ev('shellby.dev.stroll()'), 'he goes for a stroll');
    check(await until(critter, 'window.__steps.some(s => s > 0)', 3000), '...and his feet patter');
    check(await until(critter, 'window.__steps.length > 1 && window.__steps.at(-1) === 0', 10000), '...and go quiet when he stops');

    // ------------------------------------------------------- 4. the background
    await panel.ev("shellby.setSettings({ ambient: 'surf' })");
    check(await until(critter, "window.ShellbyAmbient.kind === 'surf'"), 'the surf rolls in');
    await wait(1500);
    check(await critter.ev("window.ShellbySound.audio().state") === 'running', '...and the audio is actually running');
    await panel.ev("shellby.setSettings({ ambient: 'tidepool' })");
    check(await until(critter, "window.ShellbyAmbient.kind === 'tidepool'"), '...and gives way to the rock pool');

    // ------------------------------------------------------- 5. on guard
    await panel.ev('shellby.startFocus(25)');
    check(await until(critter, "!window.ShellbySound.mix.fx && window.ShellbyAmbient.kind === 'off'"), 'guarding your focus: effects and background go silent');
    const cuesBefore = await critter.ev('window.__cues.filter(([, ok]) => ok).length');
    await panel.ev("shellby.dev.say('deploy')");
    await wait(600);
    check(await critter.ev('window.__cues.filter(([, ok]) => ok).length') === cuesBefore, '...and a deploy gets no ta-da');
    await panel.ev("shellby.setSettings({ sounds: true })");
    await wait(600);
    check(await critter.ev('window.__chirps.length') === 0 && await critter.ev('window.__cues.filter(([, ok]) => ok).length') === cuesBefore,
      '...and switching his chirp on plays no taste of it');
    await panel.ev('shellby.stopFocus()');
    check(await until(critter, "window.ShellbySound.mix.fx && window.ShellbyAmbient.kind === 'tidepool'"), 'off guard, the sea comes back');
    await panel.ev("shellby.dev.life({ what: 'call', on: true })");
    check(await until(critter, "!window.ShellbySound.mix.fx && window.ShellbyAmbient.kind === 'off'"), 'on a call, he goes silent too');
    await panel.ev("shellby.dev.life({ what: 'call', on: false })");
    check(await until(critter, "window.ShellbyAmbient.kind === 'tidepool'"), '...and the sea comes back after');

    // ------------------------------------------------------- 6. bad settings
    await panel.ev("shellby.setSettings({ soundVolume: 9000, ambient: 'jackhammer' })");
    await wait(400);
    const s = saved();
    check(s.soundVolume === 25 && s.ambient === 'tidepool', `unknown volume and background are refused (${s.soundVolume}, ${s.ambient})`);

    // ------------------------------------------------------- 7. animations off
    await critter.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    check(await critter.ev("window.ShellbySound.cue('hop')") === true, 'with animations off, the effects still play (sound isn\'t motion)');
    check(await critter.ev("window.ShellbyAmbient.kind") === 'tidepool', '...but the background plays on');

    const errs = await critter.ev('window.__errs');
    check(Array.isArray(errs) && errs.length === 0, `nothing threw along the way (${JSON.stringify(errs)})`);
    panel.close(); critter.close();
  } finally {
    app.kill();
  }
  console.log(`\n${fails ? `${fails} FAILED` : 'all good'}`);
  process.exit(fails ? 1 : 0);
})();
