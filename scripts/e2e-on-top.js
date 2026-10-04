// End-to-end check of "Keep him on top of your apps", against the dev app over
// CDP and a real Notepad window (so it needs a desktop session; a manual check,
// not CI):
// (with Notepad in front: behind a game he rightly steps back down)
//   1. on top: his window is topmost, nobody's owned window, and lets clicks
//      through to the app under it except over the crab himself
//   2. a Notepad dropped right over him doesn't cover him
//   3. switched off in Settings: back on the desktop (owned by the desktop
//      host, not topmost) and taking clicks again
//   4. switched on again: lifted again
// Screenshots of the critter window at each beat go to the given folder.
//   node scripts/e2e-on-top.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const native = require('../src/main/native-windows');

native.dpiAware(); // see the same physical pixels the app does

const ROOT = path.join(__dirname, '..');
const PORT = 9368;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-on-top-'));
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

async function openNotepad() {
  const pad = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    const h = native.topLevelWindows().find(w => native.describe(w)?.pid === pad.pid);
    if (h) return { pid: pad.pid, hwnd: h };
    await wait(100);
  }
  throw new Error('notepad never showed a window');
}

// Is `a` above `b` in the z-order? topLevelWindows() is top-first.
function above(a, b) {
  const order = native.topLevelWindows();
  return order.indexOf(a) !== -1 && order.indexOf(a) < order.indexOf(b);
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  // Staying put (no strolls or perches) so nothing but the setting moves him.
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ onboarded: true, crabOnly: true, onTop: true, wander: false, chatter: 'quiet' }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_MOTION_TEST: '1' },
  });
  let pad = null;
  try {
    let list = [];
    for (let i = 0; i < 40 && !(list.some(t => t.url.endsWith('panel.html')) && list.some(t => t.url.endsWith('critter.html'))); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    const critter = await connect(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl);
    await wait(2500);
    const state = await panel.ev('shellby.dev.perchState()');
    const me = state.self;
    const look = () => native.describe(me);
    const host = native.desktopHost();
    // Notepad in front first: with a game in front he'd rightly be back down.
    pad = await openNotepad();
    native.focus(pad.hwnd);
    await wait(2500); // a cover poll (main.js COVER_POLL_MS)
    if (native.foreground() !== pad.hwnd) throw new Error('Notepad couldn\'t come to the front (a game or another app holds the foreground); run this with the desktop free');

    // 1. On top from the start.
    let d = look();
    check(d.topmost, 'on top: his window is topmost');
    check(!d.owned, 'on top: nobody owns his window (not the desktop host)');
    check(d.clickThrough, 'on top: clicks go through his window to the app under it');
    await critter.shot('1-on-top');

    // 2. The Notepad right over him.
    const b = d.rect;
    native.move(pad.hwnd, b.left - 40, b.top - 40);
    native.focus(pad.hwnd);
    await wait(600);
    check(above(me, pad.hwnd), 'on top: a Notepad dropped over him is under him');

    // 3. Off in Settings.
    await panel.ev('shellby.setSettings({ onTop: false }).then(() => true)');
    await wait(500);
    d = look();
    check(!d.topmost, 'off: no longer topmost');
    check(native.ownerOf(me) === host, 'off: owned by the desktop host again');
    check(!d.clickThrough, 'off: his window takes clicks again');
    check(above(pad.hwnd, me), 'off: the Notepad covers him');
    await critter.shot('3-desktop');

    // 4. On again.
    await panel.ev('shellby.setSettings({ onTop: true }).then(() => true)');
    await wait(500);
    d = look();
    check(d.topmost && !d.owned && d.clickThrough, 'on again: lifted, unowned, click-through');
    check(above(me, pad.hwnd), 'on again: above the Notepad');
    await critter.shot('4-on-top-again');
    panel.close();
    critter.close();
  } catch (e) {
    console.error(e);
    fails++;
  } finally {
    if (pad) native.close(pad.hwnd);
    app.kill();
  }
  console.log(`\n${fails ? `${fails} FAILED` : 'all passed'} · screenshots in ${OUT}`);
  process.exit(fails ? 1 : 0);
})();
