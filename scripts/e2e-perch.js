// End-to-end check of perching, against the dev app over CDP and a real
// Notepad window (so it needs a desktop session; it's a manual check, not CI):
//   1. he hops up onto Notepad's title bar, owned by it from take-off (so he
//      never flashes over windows covering it), lets clicks through, and lands
//      with his feet on the frame
//   2. dragging Notepad slowly carries him along, gripping
//   3. shaking it throws him off, dizzy, and he's back on the desktop
//   4. closing Notepad under him: the "!" beat, a fall to the floor, the walk home
//   5. "Hop down" from up there takes him home, still Notepad's on the way down
// Screenshots of the critter window at each beat go to the given folder. It
// never takes the focus, so it can run beside other things; if a fullscreen
// window covers his usual screen, give him a home on another one:
//   SHELLBY_E2E_HOME=4260,950 node scripts/e2e-perch.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');
const native = require('../src/main/native-windows');

native.dpiAware(); // see the same physical pixels the app does

const ROOT = path.join(__dirname, '..');
const PORT = 9367;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-perch-'));
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  const shot = async name => await savePng(send, path.join(OUT, `${name}.png`));
  return { send, ev, shot, close: () => ws.close() };
}

// A Notepad on his screen, to his left with room above it. `at` is in
// physical pixels (native.move); see toPhys below.
async function openNotepad(at) {
  const pad = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    const h = native.topLevelWindows().find(w => native.describe(w)?.pid === pad.pid);
    if (h) {
      native.move(h, at.x, at.y);
      await wait(300);
      return { pid: pad.pid, hwnd: h, at };
    }
    await wait(100);
  }
  throw new Error('notepad never showed a window');
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  // Just the crab: perching is the whole point for people without Claude.
  const [hx, hy] = (process.env.SHELLBY_E2E_HOME || '').split(',').map(Number);
  const critterPos = Number.isFinite(hx) && Number.isFinite(hy) ? { x: hx, y: hy } : null;
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ onboarded: true, crabOnly: true, perch: 'sometimes', chatter: 'chatty', critterPos }));
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
    const state = () => panel.ev('shellby.dev.perchState()');
    const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(80); } return false; };
    await wait(2500);
    await critter.ev("window.__cls = new Set(); new MutationObserver(() => document.body.className.split(' ').forEach(c => window.__cls.add(c))).observe(document.body, { attributes: true, attributeFilter: ['class'] }); true");
    const seen = cls => critter.ev(`window.__cls.has(${JSON.stringify(cls)})`);
    const forget = () => critter.ev('window.__cls.clear(); true');
    const home = await panel.ev('shellby.dev.perchState({ debug: true })');
    // His screen in DIPs and in physical pixels, to put Notepad where we mean.
    const { dip, phys } = home.debug.display;
    const k = phys.width / dip.width;
    const toPhys = p => ({ x: Math.round(phys.x + (p.x - dip.x) * k), y: Math.round(phys.y + (p.y - dip.y) * k) });
    const spot = toPhys({ x: Math.max(home.debug.box.minX + 60, home.bounds.x - 900), y: home.debug.box.floorY - 420 });
    const step = Math.max(1, Math.round(4 * k)); // ~4 DIP per frame: a slow drag
    console.log(`home ${home.bounds.x},${home.bounds.y} DIP at ${Math.round(k * 100)}%; Notepad at ${spot.x},${spot.y} px`);

    // ------------------------------------------------------------ 1. up he goes
    pad = await openNotepad(spot);
    check(await panel.ev(`shellby.dev.perch({ hwnd: ${pad.hwnd} })`), 'he goes for the Notepad window');
    check(await until(async () => (await state()).motion === 'hop', 3000), 'hopping up');
    check((await state()).owner === pad.hwnd, "in the air he is already Notepad's, not over every app");
    check(await until(async () => (await state()).up), 'and lands on it');
    await critter.shot('1-perched');
    let s = await state();
    check(s.hwnd === pad.hwnd, 'perched on the right window');
    check(s.clickThrough, 'the rest of his window lets clicks through to the title bar');
    check(s.owner === pad.hwnd, 'owned by Notepad, so he sits just above it');
    check(await seen('hopping') && await seen('landed'), 'hopped and landed (with the squash and dust)');
    check(await seen('on-perch'), 'the renderer knows he is up');
    const feet = s.bounds.y + s.bounds.height - 18;
    check(s.frame && Math.abs(feet - s.frame.y) <= 4, `feet on the title bar (feet ${feet}, frame top ${Math.round(s.frame?.y)})`);

    // ------------------------------------------------------------ 2. a slow drag
    await forget();
    const x0 = s.bounds.x;
    for (let i = 1; i <= 40; i++) { native.move(pad.hwnd, spot.x + i * step, spot.y); await wait(16); }
    await wait(500);
    s = await state();
    check(s.up, 'a slow drag keeps him on');
    check(s.bounds.x - x0 >= 100, `and carries him along (${s.bounds.x - x0} DIP)`);
    check(await seen('cling'), 'gripping while it moved');
    await critter.shot('2-ridden');
    // A snap (Win+←) moves the window in one jump: he holds on through it.
    native.move(pad.hwnd, spot.x + 60 * step, spot.y);
    await wait(700);
    native.move(pad.hwnd, spot.x + 40 * step, spot.y);
    await wait(700);
    check((await state()).up, 'a window snapped across in one jump keeps him on');

    // ------------------------------------------------------------ 3. shake it
    await forget();
    for (let i = 0; i < 24; i++) { native.move(pad.hwnd, spot.x + 40 * step + (i % 2 ? 1 : -1) * 22 * step, spot.y); await wait(30); }
    check(await until(async () => !(await state()).up, 3000), 'shaking the window throws him off');
    check(await seen('fly-fling'), 'flung, spinning');
    await critter.shot('3-flung');
    check(await until(async () => (await state()).motion === null, 5000), 'and he lands');
    check(await seen('dizzy'), 'dizzy after a shaking');
    await critter.shot('3-dizzy');
    check(!(await state()).floating, 'back down on the desktop layer');

    // ------------------------------------------------------------ 4. the window closes under him
    await wait(4000); // let him walk home
    native.move(pad.hwnd, spot.x, spot.y);
    await wait(300);
    await panel.ev(`shellby.dev.perch({ hwnd: ${pad.hwnd} })`);
    check(await until(async () => (await state()).up), 'back up on it');
    await forget();
    native.close(pad.hwnd);
    check(await until(() => seen('coyote'), 3000), 'the floor goes: he hangs there a beat, "!"');
    await critter.shot('4-coyote');
    check(await until(() => seen('fly-fall'), 3000), 'then falls, flailing');
    check(await until(async () => { const v = await state(); return !v.up && v.motion !== 'flight'; }, 6000), 'and lands');
    s = await panel.ev('shellby.dev.perchState({ debug: true })');
    check(s.bounds.y === s.debug.box.floorY, `on the floor (y ${s.bounds.y}, floor ${s.debug.box.floorY})`);
    check(await until(async () => (await state()).bounds.x === home.bounds.x, 15000), 'and walks home');
    pad = null;

    // ------------------------------------------------------------ 5. hop down when asked
    pad = await openNotepad(spot);
    await panel.ev(`shellby.dev.perch({ hwnd: ${pad.hwnd} })`);
    check(await until(async () => (await state()).up), 'up again');
    await panel.ev('shellby.dev.perch({ leave: true })');
    check(await until(async () => (await state()).motion === 'hop', 3000), 'hopping down');
    check((await state()).owner === pad.hwnd, "still Notepad's on the way down");
    check(await until(async () => { const v = await state(); return !v.up && v.motion === null; }, 5000), '"Hop down" brings him down');
    s = await state();
    check(Math.abs(s.bounds.x - home.bounds.x) <= 4 && Math.abs(s.bounds.y - home.bounds.y) <= 4, 'right back to his spot');
    check(!s.clickThrough, 'and his window takes clicks again');
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
