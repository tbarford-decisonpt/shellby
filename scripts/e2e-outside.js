// End-to-end check of the world outside his window, against the dev app over
// CDP (isolated profile, just-the-crab mode):
//   1. rain outside: the sou'wester, cape and umbrella go on, and it rains around him
//   2. switching the weather off takes them off again
//   3. typing anywhere: the little keyboard comes out, his claw taps along, he
//      bobs when you're fast and looks on impressed through a burst, and your
//      best burst is remembered. The "typing" is F24, a key no app uses. He
//      hears the real keyboard too, so leave it alone while this runs.
//   4. Open-Meteo for real: a town search and a weather check (needs the network)
// No Claude account, no usage.
//   node scripts/e2e-outside.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9378;
const HOOK = 47998;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-outside-'));
fs.mkdirSync(OUT, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  const shot = async name => fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  return { send, ev, shot, close: () => ws.close() };
}

function launch(data) {
  return spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...process.env, SHELLBY_USER_DATA: data,
      SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'),
      SHELLBY_HOOK_PORT: String(HOOK), SHELLBY_MOTION_TEST: '1', SHELLBY_FAKE_HEALTH: 'calm',
    },
  });
}

const targets = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; } };

async function windows() {
  let list = [];
  for (let i = 0; i < 40 && !(list.some(t => t.url.endsWith('panel.html')) && list.some(t => t.url.endsWith('critter.html'))); i++) {
    list = await targets();
    await wait(500);
  }
  return {
    panel: await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl),
    critter: await connect(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl),
  };
}

// F24 down and up, through Windows like a real key (it reaches Raw Input).
function keyPresser() {
  const koffi = require('koffi');
  const keybd = koffi.load('user32.dll').func('void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)');
  const VK_F24 = 0x87, KEYEVENTF_KEYUP = 0x2;
  return () => { keybd(VK_F24, 0, 0, 0); keybd(VK_F24, 0, KEYEVENTF_KEYUP, 0); };
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const lisbon = { name: 'Lisbon', region: 'Lisbon', country: 'Portugal', lat: 38.7, lon: -9.1 };
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
    onboarded: true, crabOnly: true, chatter: 'normal', sounds: false, wander: false, perch: 'off',
    // His own outfit empty (no seasonal look), so whatever he has on is the weather's.
    wardrobe: { seasonalAuto: false },
    typing: { enabled: true }, // off by default
    // A fresh reading, so nothing is asked of the network until step 4.
    weather: { enabled: true, place: lisbon, remarks: true },
    weatherNow: { condition: 'rain', code: 63, tempC: 12, windKmh: 10, isDay: true, at: Date.now() },
  }));
  const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));

  const app = launch(data);
  try {
    const { panel, critter } = await windows();
    const until = async (c, expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.ev(expr)) return true; await wait(120); } return false; };
    await wait(3000);
    await critter.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

    // ------------------------------------------------------- rain
    check(await until(critter, `!!document.querySelector('#sprite .acc-hat') && !!document.querySelector('#sprite .acc-held') && !!document.querySelector('#sprite .acc-neck')`),
      "raining: sou'wester, cape and umbrella on");
    check(await critter.ev(`document.querySelector('#fx .fx-layer')?.dataset.motion === 'fall' && document.querySelectorAll('#fx .fx-p').length >= 10`), '...and the rain falls around him');
    await critter.shot('1-rain');
    const settings = await panel.ev('shellby.getWeather()');
    check(settings.summary?.includes('Rain') && settings.label === 'Lisbon, Portugal', `Settings says so: "${settings.summary} in ${settings.label}"`);

    await panel.ev('shellby.setWeather({ enabled: false })');
    check(await until(critter, `!document.querySelector('#sprite .acc-held') && !document.querySelector('#fx .fx-p')`), 'weather off: the gear and the rain go');

    // ------------------------------------------------------- typing along
    await critter.ev(`window.__cls = new Set(); window.__taps = 0;
      new MutationObserver(() => document.body.className.split(' ').forEach(c => window.__cls.add(c))).observe(document.body, { attributes: true, attributeFilter: ['class'] });
      new MutationObserver(() => { if (document.getElementById('crab').classList.contains('tap')) window.__taps++; }).observe(document.getElementById('crab'), { attributes: true, attributeFilter: ['class'] });
      true`);
    const press = keyPresser();
    // A microphone in use on the test PC would put him "on a call", hushed and
    // still; and a trophy's fuss at startup has his claws busy. Neither is this test.
    await panel.ev("shellby.dev.life({ what: 'call', on: false })");
    check(await until(critter, `document.body.classList.contains('state-idle')`, 12000), 'he is idle and free to type along');
    // 4 keys a second for 3 s, then 10 a second for 8 s: typing, fast, and a burst.
    let keyboardOut = false;
    for (let i = 0; i < 12; i++) {
      press();
      await wait(250);
      keyboardOut ||= await critter.ev(`document.body.classList.contains('typing') && getComputedStyle(document.getElementById('keys')).opacity === '1'`);
    }
    check(keyboardOut, 'typing: the little keyboard comes out');
    // Sampled through the burst: no habit or stroll should take his claw off the keys.
    let samples = 0, out = 0;
    for (let i = 0; i < 80; i++) {
      press();
      await wait(100);
      if (i % 8 === 4) { samples++; if (await critter.ev(`document.body.classList.contains('typing') && getComputedStyle(document.getElementById('keys')).opacity === '1'`)) out++; }
      if (i === 78) await critter.shot('2-burst');
    }
    check(out === samples, `...and it stays out the whole way through (${out}/${samples} samples)`);
    check(await critter.ev(`window.__taps >= 40`), `...his claw taps along (${await critter.ev('window.__taps')} taps)`);
    check(await critter.ev(`window.__cls.has('typing-fast')`), '...he bobs to keep up when you are fast');
    check(await critter.ev(`window.__cls.has('impressed')`), '...and looks on impressed through a burst');
    check(await until(critter, `!document.body.classList.contains('typing')`, 8000), 'you stop: the keyboard goes away');
    check(saved().typingBest >= 80, `your best burst is remembered (${saved().typingBest} wpm)`);

    await panel.ev("shellby.dev.life({ what: 'call', on: true })");
    await wait(300);
    await critter.ev('window.__cls.clear(); true');
    for (let i = 0; i < 6; i++) { press(); await wait(150); }
    check(!(await critter.ev(`window.__cls.has('typing')`)), 'on a call: he keeps still behind his shh sign');
    await panel.ev("shellby.dev.life({ what: 'call', on: false })");

    await panel.ev('shellby.setTyping({ enabled: false })');
    await critter.ev('window.__cls.clear(); true');
    for (let i = 0; i < 6; i++) { press(); await wait(150); }
    check(!(await critter.ev(`window.__cls.has('typing')`)), 'typing along off: he leaves your keyboard alone');

    // ------------------------------------------------------- Open-Meteo, for real
    const found = await panel.ev(`shellby.searchWeather('Reykjavik')`);
    check(Array.isArray(found.places) && found.places.some(p => p.country === 'Iceland'), `town search finds Reykjavík (${found.error || found.places.length + ' found'})`);
    if (found.places?.length) {
      await panel.ev(`shellby.setWeather({ enabled: true, place: ${JSON.stringify(found.places[0])} })`);
      const v = await panel.ev('shellby.checkWeather()');
      check(!!v.reading && v.reading.at > Date.now() - 60000, `a real check: ${v.summary || v.error}`);
      check(saved().weather.place.lat === Math.round(found.places[0].lat * 10) / 10, '...with the town stored to one decimal place');
    }
    await critter.shot('3-after');
    panel.close(); critter.close();
  } catch (e) {
    console.error(e);
    fails++;
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED — screenshots in ${OUT}` : `all passed — screenshots in ${OUT}`);
  process.exit(fails ? 1 : 0);
})();
