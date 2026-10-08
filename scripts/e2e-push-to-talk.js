// End-to-end check of push-to-talk, against the dev app over CDP with the fake
// CLI (isolated profile), pressing the real hotkey through Windows (SendInput):
//   1. The Settings switch turns it on, once Windows' recognizer has loaded
//   2. A tap still opens and closes the panel
//   3. A hold puts "listening…" in his bubble
//   4. What was said lands in the box, after anything already typed, unsent
//   5. Switched off, a hold is just a tap again
// No microphone: SHELLBY_DICTATION_WAV feeds the recognizer a sentence Windows'
// own speech synthesizer recorded. No Claude account, no usage.
//   node scripts/e2e-push-to-talk.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const koffi = require('koffi');

const ROOT = path.join(__dirname, '..');
const PORT = 9371;
const HOOK = 47991;
// Not the default: a Shellby you're running yourself already has Ctrl+Alt+Space.
const HOTKEY = 'Control+Alt+F10';
const VK = { CONTROL: 0x11, ALT: 0x12, F10: 0x79 };
const wait = ms => new Promise(r => setTimeout(r, ms));

const user32 = koffi.load('user32.dll');
const keybd = user32.func('void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)');
const KEYUP = 2;
const down = vk => keybd(vk, 0, 0, 0);
const up = vk => keybd(vk, 0, KEYUP, 0);
async function press(holdMs) {
  down(VK.CONTROL); down(VK.ALT); down(VK.F10);
  await wait(holdMs);
  up(VK.F10); up(VK.ALT); up(VK.CONTROL);
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  return { send, ev, close: () => ws.close() };
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

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ onboarded: true, chatter: 'quiet', sounds: false, wander: false, hotkey: HOTKEY }));
  const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));

  const wav = path.join(data, 'say.wav');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}'); $s.Speak('Fix the typo in the read me file.'); $s.Dispose()`]);

  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...process.env, SHELLBY_USER_DATA: data,
      SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'),
      SHELLBY_HOOK_PORT: String(HOOK), SHELLBY_MOTION_TEST: '1', SHELLBY_DICTATION_WAV: wav,
    },
  });
  try {
    const { panel, critter } = await windows();
    const until = async (c, expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.ev(expr)) return true; await wait(100); } return false; };
    await wait(3000);
    await critter.ev("window.__said = []; const bt = document.getElementById('bubbleText'); new MutationObserver(() => window.__said.push(bt.textContent)).observe(bt, { childList: true, characterData: true, subtree: true }); true");
    const visible = () => panel.ev("document.visibilityState === 'visible'");

    // ------------------------------------------------------- 1. switch it on
    await panel.ev("SB.setView('settings')");
    check(await panel.ev("!!document.getElementById('pushToTalkToggle')"), 'Settings has the push-to-talk switch');
    await panel.ev("document.getElementById('pushToTalkToggle').click()");
    check(await until(panel, "document.getElementById('pushToTalkToggle').checked && !document.getElementById('pushToTalkToggle').disabled", 20000), 'the switch stays on once Windows has loaded the recognizer');
    check(saved().pushToTalk === true, 'push-to-talk is saved on');
    await panel.ev("SB.setView('chat')");
    await panel.ev('shellby.hide()');
    check(await until(panel, "document.visibilityState === 'hidden'", 4000), 'panel hidden to start');

    // ------------------------------------------------------- 2. a tap is a tap
    await press(60);
    check(await until(panel, "document.visibilityState === 'visible'", 4000), 'a tap opens the panel');
    await press(60);
    check(await until(panel, "document.visibilityState === 'hidden'", 4000), 'another tap closes it');
    check(!(await critter.ev("window.__said.includes('listening…')")), 'a tap never says it is listening');

    // ------------------------------------------- 3 + 4. a hold is dictation
    await panel.ev("document.getElementById('input').value = 'Please'");
    const holding = press(1500);
    check(await until(critter, "document.getElementById('bubbleText').textContent === 'listening…'", 1200), 'holding: "listening…" in his bubble');
    await holding;
    check(await until(panel, "/typo/i.test(document.getElementById('input').value)", 8000), 'the words land in the box');
    const box = await panel.ev("document.getElementById('input').value");
    check(/^Please \S/.test(box), `...after what was already typed: "${box}"`);
    check(await visible(), 'the panel is open to read it');
    check(await until(critter, "document.getElementById('bubbleText').textContent !== 'listening…'", 3000), 'the bubble stops saying "listening…"');
    check(await panel.ev("!document.querySelector('.turn.user, .item.user')"), 'nothing was sent');

    // ------------------------------------------------------- 5. switched off
    await panel.ev("SB.setView('settings')");
    await panel.ev("document.getElementById('pushToTalkToggle').click()");
    check(await until(panel, '!document.getElementById(\'pushToTalkToggle\').checked', 4000) && saved().pushToTalk === false, 'switched off and saved');
    await panel.ev('shellby.hide()');
    await until(panel, "document.visibilityState === 'hidden'", 4000);
    await critter.ev('window.__said = []; true');
    await press(800);
    check(await until(panel, "document.visibilityState === 'visible'", 4000), 'off: a hold just opens the panel');
    check(!(await critter.ev("window.__said.includes('listening…')")), 'off: it never listens');
  } catch (e) {
    console.error(e);
    fails++;
  } finally {
    up(VK.F10); up(VK.ALT); up(VK.CONTROL);
    app.kill();
    await wait(1000);
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
