// `npm run tricks` films the README's "Things to try" GIFs on the real desktop:
// a plain backdrop over the primary screen (scripts/tricks-stage.js), the dev
// app kept on top of it in a throwaway profile, a real Notepad to ride, and
// ffmpeg recording one patch of the screen per clip. It moves windows and the
// cursor and types into its own Notepad, so leave the mouse alone while it runs.
//   node scripts/record-tricks.js [clip ...]   (no names: every clip)
// Writes docs/img/tricks-<clip>.gif; the README uses ride, close, wall, pals,
// typing and pounce. Needs imageio-ffmpeg (pip install imageio-ffmpeg).
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const koffi = require('koffi');
const native = require('../src/main/native-windows');

native.dpiAware(); // physical pixels, like ffmpeg's gdigrab

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9371;
const FPS = 30;
const GIF_FPS = 20;
const GIF_SCALE = 0.75; // GIF pixels per DIP, the same in every clip
const OUT = path.join(ROOT, 'docs', 'img');
const RAW = process.env.SHELLBY_TRICKS_RAW || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-tricks-'));
const wait = ms => new Promise(r => setTimeout(r, ms));

const user32 = koffi.load('user32.dll');
const keybdEvent = user32.func('void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr extra)');
const KEYUP = 2;

const ffmpegExe = () => execFileSync('python', ['-c', 'import imageio_ffmpeg as f; print(f.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim();

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  return { ev, close: () => ws.close() };
}

async function windowOf(pid, tries = 50) {
  for (let i = 0; i < tries; i++) {
    const h = native.topLevelWindows().find(w => native.describe(w)?.pid === pid && native.isVisible(w));
    if (h) return h;
    await wait(100);
  }
  throw new Error(`pid ${pid} never showed a window`);
}

// ------------------------------------------------------------------ the scene
// Everything below is in DIPs on the primary screen; `px` turns them into the
// physical pixels windows, the cursor and gdigrab use.
let k = 1;
const px = n => Math.round(n * k);
let FEET = 0;   // the floor: where his feet stand, the work area's bottom
let FLOOR = 0;  // his window's top when he stands on it
let WIDTH = 0;  // the primary screen's width

async function openNotepad({ x, y, width, height }) {
  const pad = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
  const hwnd = await windowOf(pad.pid);
  // Windows opens it behind the stage (which has the focus): put it on top, unfocused.
  native.load().SetWindowPos(hwnd, 0 /* HWND_TOP */, px(x), px(y), px(width), px(height), 0x10 /* NOACTIVATE */);
  await wait(400);
  return hwnd;
}
const movePad = (hwnd, x, y) => native.move(hwnd, px(x), px(y));

/** Type into `hwnd` only while it's in front, about `kps` keys a second. */
async function typeInto(hwnd, text, kps) {
  for (const ch of text.toUpperCase()) {
    if (native.foreground() !== hwnd) throw new Error('Notepad lost the focus; stopped typing');
    const vk = ch === ' ' ? 0x20 : ch === '.' ? 0xbe : ch === ',' ? 0xbc : ch.charCodeAt(0);
    keybdEvent(vk, 0, 0, 0);
    keybdEvent(vk, 0, KEYUP, 0);
    await wait(1000 / kps * (0.7 + Math.random() * 0.6));
  }
}

const settings = extra => ({
  onboarded: true, crabOnly: true, onTop: true, perch: 'off', climb: 'off', chatter: 'chatty',
  wardrobe: { seasonalAuto: false }, needsOn: false, ...extra, // no snack chatter over the clip
});

const press = vk => { keybdEvent(vk, 0, 0, 0); keybdEvent(vk, 0, KEYUP, 0); };
const perchOn = async ({ dev, until }, pad) => {
  await dev(`perch({ hwnd: ${pad} })`);
  await until(async () => (await dev('perchState()')).up, 6000);
};
const settled = ({ dev, until }, ms) => until(async () => { const s = await dev('perchState()'); return !s.up && s.motion === null; }, ms);

/**
 * One clip each: its settings, the patch of screen it films (DIP, about 16:10
 * so he comes out the same size in every GIF), what's set up before the camera
 * rolls, and what happens. `home` is where he stands (his window's left, DIP).
 */
const CLIPS = {
  // Up on a window, ridden, shaken off.
  ride: {
    home: 760,
    perch: 'sometimes',
    rect: () => ({ x: 300, y: FEET - 420, width: 680, height: 420 }),
    // He only climbs windows of 320x160 and up.
    setup: () => openNotepad({ x: 330, y: FEET - 260, width: 340, height: 180 }),
    async act(run, pad) {
      await wait(400);
      await perchOn(run, pad);
      await wait(1800);
      for (let i = 1; i <= 50; i++) { movePad(pad, 330 + i * 3, FEET - 260); await wait(16); }
      await wait(1000);
      for (let i = 0; i < 24; i++) { movePad(pad, 480 + (i % 2 ? 1 : -1) * 30, FEET - 260); await wait(30); }
      await settled(run, 5000);
      await wait(2500);
    },
  },
  // The window closes under him: a beat in mid-air, then down he goes.
  close: {
    home: 780,
    perch: 'sometimes',
    rect: () => ({ x: 340, y: FEET - 440, width: 700, height: 440 }),
    setup: () => openNotepad({ x: 400, y: FEET - 290, width: 340, height: 180 }),
    async act(run, pad) {
      await wait(400);
      await perchOn(run, pad);
      await wait(1800);
      native.close(pad);
      await wait(1000);
      await settled(run, 8000);
      await wait(2000);
    },
  },
  // Thrown hard at the side of the screen, he sticks and climbs.
  wall: {
    home: 320,
    climb: 'often',
    rect: () => ({ x: 0, y: FEET - 440, width: 700, height: 440 }),
    async act({ dev }) {
      await wait(800);
      await dev('throw({ vx: -1800, vy: -700 })');
      await wait(9000);
    },
  },
  // Your cursor wanders too close.
  pounce: {
    home: 700,
    mouse: true,
    // In front of his face (he faces right), close enough to tempt him.
    rect: () => ({ x: 560, y: FEET - 300, width: 480, height: 300 }),
    setup: () => native.setCursor(px(920), px(FEET - 30)),
    async act({ dev }) {
      await wait(400);
      await dev("scene('pounce')");
      await wait(6000);
    },
  },
  // Typing along, then how fast that was: a best of 60 to beat, so he says so.
  typing: {
    home: 800,
    typing: { enabled: true, remarks: true },
    best: 60,
    rect: () => ({ x: 300, y: FEET - 420, width: 680, height: 420 }),
    async setup() {
      const pad = await openNotepad({ x: 330, y: FEET - 380, width: 440, height: 170 });
      // A tap of Alt lets a background process hand the focus over; Escape
      // takes Notepad back out of the menu that tap opened.
      press(0x12);
      native.focus(pad);
      await wait(300);
      press(0x1b);
      return pad;
    },
    async act(run, pad) {
      await wait(600);
      await typeInto(pad, 'shellby is the best crab on my desktop and he knows it. he types along with me, claw for claw, and he keeps score.', 10);
      await wait(6000);
    },
    teardown(pad) {
      native.close(pad);
      return wait(600).then(() => { if (native.describe(native.foreground())?.pid === native.describe(pad)?.pid) press(0x4e); }); // Don't save
    },
  },
  // His pals on the floor, and what they think of you throwing him about.
  pals: {
    home: 720,
    colony: 4,
    rect: () => ({ x: 360, y: FEET - 440, width: 700, height: 440 }),
    async act({ dev }) {
      await wait(3500);
      await dev('throw({ vx: 0, vy: -1200 })');
      await wait(5000);
    },
  },
  // A dig, and what turned up.
  dig: {
    home: 700,
    rect: () => ({ x: 560, y: FEET - 300, width: 480, height: 300 }),
    async act({ dev }) {
      await wait(500);
      await dev("life({ what: 'dig' })");
      await wait(7000);
    },
  },
};

/** Record a physical-pixel rect of the screen while `act` runs. */
async function film(ffmpeg, name, rect, act, mouse = false) {
  const mp4 = path.join(RAW, `${name}.mp4`);
  const even = n => Math.floor(n / 2) * 2;
  const rec = spawn(ffmpeg, ['-y', '-f', 'gdigrab', '-framerate', String(FPS), '-draw_mouse', mouse ? '1' : '0',
    '-offset_x', String(px(rect.x)), '-offset_y', String(px(rect.y)), '-video_size', `${even(px(rect.width))}x${even(px(rect.height))}`,
    '-i', 'desktop', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', mp4], { stdio: ['pipe', 'ignore', 'ignore'] });
  await wait(1000); // gdigrab warms up
  try {
    await act();
  } finally {
    rec.stdin.write('q');
    await new Promise(r => rec.on('exit', r));
  }
  return mp4;
}

function toGif(ffmpeg, name, mp4, rect) {
  const gif = path.join(OUT, `tricks-${name}.gif`);
  const filter = `fps=${GIF_FPS},scale=${Math.round(rect.width * GIF_SCALE / 2) * 2}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  execFileSync(ffmpeg, ['-y', '-i', mp4, '-vf', filter, '-loop', '0', gif], { stdio: 'ignore' });
  console.log(`${name}: ${path.relative(ROOT, gif)} (${Math.round(fs.statSync(gif).size / 1024)} KB)`);
}

async function launch(clip) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-tricks-data-'));
  const extra = { critterPos: FLOOR ? { x: clip.home, y: FLOOR } : null };
  if (clip.colony) extra.colony = clip.colony;
  if (clip.climb) extra.climb = clip.climb;
  if (clip.perch) extra.perch = clip.perch;
  if (clip.typing) extra.typing = clip.typing;
  if (clip.best) extra.typingBest = clip.best;
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(settings(extra)));
  const app = spawn(ELECTRON, [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_MOTION_TEST: '1', SHELLBY_FOREGROUND: '1' },
  });
  let list = [];
  for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
    await wait(500);
  }
  const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
  const dev = call => panel.ev(`shellby.dev.${call}`);
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(80); } return false; };
  await wait(2500);
  await dev("life({ what: 'call', on: false })"); // a mic in use elsewhere would hush him
  return { app, panel, dev, until };
}

(async () => {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CLIPS);
  const unknown = names.filter(n => !CLIPS[n]);
  if (unknown.length) throw new Error(`no such clip: ${unknown.join(', ')} (have ${Object.keys(CLIPS).join(', ')})`);
  const ffmpeg = ffmpegExe();
  const stage = spawn(ELECTRON, [path.join(__dirname, 'tricks-stage.js')], { stdio: 'ignore' });
  let run = null;
  try {
    const backdrop = await windowOf(stage.pid, 100);
    for (const name of names) {
      const clip = CLIPS[name];
      // The stage has to be in front, or the clip films whatever you had open.
      press(0x12);
      native.focus(backdrop);
      await wait(300);
      if (native.foreground() !== backdrop) throw new Error('the backdrop could not come to the front; close or minimize what is on the primary screen');
      run = await launch(clip);
      if (!FLOOR) {
        // First run: learn the screen, then start over with him in place.
        const s = await run.dev('perchState({ debug: true })');
        k = s.debug.display.phys.width / s.debug.display.dip.width;
        FLOOR = s.debug.box.floorY;
        FEET = FLOOR + s.bounds.height - (await run.dev('edges()')).geo.foot;
        WIDTH = s.debug.display.dip.width;
        run.panel.close(); run.app.kill(); await wait(1500);
        run = await launch(clip);
      }
      const ctx = await clip.setup?.();
      const mp4 = await film(ffmpeg, name, clip.rect(), () => clip.act(run, ctx), clip.mouse);
      await clip.teardown?.(ctx);
      if (ctx && !clip.teardown && native.isWindow(ctx)) native.close(ctx);
      run.panel.close(); run.app.kill(); run = null;
      await wait(1500);
      toGif(ffmpeg, name, mp4, clip.rect());
    }
    console.log(`raw clips in ${RAW} (screen ${WIDTH} DIP at ${Math.round(k * 100)}%)`);
  } finally {
    if (run) run.app.kill();
    stage.kill();
  }
})().catch(e => { console.error(e); process.exit(1); });
