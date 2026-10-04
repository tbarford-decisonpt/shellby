// End-to-end check of the edges of the screen, mischief and the colony, against
// the dev app over CDP (it needs a desktop session; a manual check, not CI):
//   1. the floor strip opens with his pals and his footprints on
//   2. he walks to a wall, turns, and climbs it with his feet on the edge
//   3. "Come down" lets go: he falls, lands upright and walks home
//   4. thrown hard at the side of the screen, he sticks to it
//   5. a note prank: off the edge of the screen and back with a note
// Screenshots of the critter window, the floor and the note go to the given
// folder. It never takes the focus and never moves your cursor.
//   SHELLBY_E2E_HOME=4260,950 node scripts/e2e-edges.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const climb = require('../src/main/climb');

const ROOT = path.join(__dirname, '..');
const PORT = 9368;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-edges-'));
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

const targets = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; } };

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const [hx, hy] = (process.env.SHELLBY_E2E_HOME || '').split(',').map(Number);
  const critterPos = Number.isFinite(hx) && Number.isFinite(hy) ? { x: hx, y: hy } : null;
  // Just the crab, a colony of three, and a gremlin with every prank on. Perching
  // off so he doesn't wander up a window mid-check.
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
    onboarded: true, crabOnly: true, perch: 'off', climb: 'sometimes', mischief: 'gremlin', colony: 3, chatter: 'chatty', critterPos,
  }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_MOTION_TEST: '1' },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !(list.some(t => t.url.endsWith('panel.html')) && list.some(t => t.url.endsWith('critter.html')) && list.some(t => t.url.endsWith('floor.html'))); i++) {
      list = await targets();
      await wait(500);
    }
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    const critter = await connect(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl);
    const floorT = list.find(t => t.url.endsWith('floor.html'));
    const state = () => panel.ev('shellby.dev.edges()');
    const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(100); } return false; };
    await wait(2500);
    await critter.ev("window.__cls = new Set(); new MutationObserver(() => document.body.className.split(' ').forEach(c => window.__cls.add(c))).observe(document.body, { attributes: true, attributeFilter: ['class'] }); true");
    const seen = cls => critter.ev(`window.__cls.has(${JSON.stringify(cls)})`);
    const forget = () => critter.ev('window.__cls.clear(); true');
    const s0 = await state();
    const home = s0.bounds;
    console.log(`home ${JSON.stringify(home)}  work area ${JSON.stringify(s0.climb.workArea)}  edges ${JSON.stringify(s0.climb.edges)}`);

    // 1. the floor
    check(!!floorT, 'the floor strip window opened');
    check(s0.floor.open && s0.floor.pals.length === 3, `three pals on the floor (${s0.floor.pals.join(', ')})`);
    check(s0.floor.tracks === true, 'footprints are on with mischief');
    if (floorT) {
      const floor = await connect(floorT.webSocketDebuggerUrl);
      check(await until(() => floor.ev("document.querySelectorAll('.pal').length === 3")), 'the floor draws three pals');
      await wait(2500);
      await floor.shot('1-floor');
      const xs = await floor.ev("[...document.querySelectorAll('.pal')].map(p => p.style.getPropertyValue('--x'))");
      check(Array.isArray(xs) && xs.every(x => /px$/.test(x)), `pals have places on the strip (${xs})`);
      // Passing each other on the way somewhere is fine; standing in each other isn't.
      let worst = Infinity;
      for (let i = 0; i < 40; i++) {
        const rest = await floor.ev("[...document.querySelectorAll('.pal')].filter(p => !/mode-(walk|scurry)/.test(p.className)).map(p => ({ x: parseFloat(p.style.getPropertyValue('--x')), w: p.getBoundingClientRect().width }))");
        for (const a of rest) for (const b of rest) if (a !== b) worst = Math.min(worst, Math.abs(a.x - b.x) - (a.w + b.w) / 2);
        await wait(250);
      }
      check(worst >= -1, `resting pals never stand in each other (closest gap ${worst === Infinity ? 'n/a' : worst.toFixed(1)} px)`);
      floor.close();
    }

    // 2. up a wall
    const wa = s0.climb.workArea, g = s0.geo;
    const cx = home.x + home.width / 2;
    const side = ['right', 'left'].filter(sd => s0.climb.edges[sd]).sort((a, b) => Math.abs(climb.cornerX(a, wa, g) - cx) - Math.abs(climb.cornerX(b, wa, g) - cx))[0];
    if (!side || Math.abs(climb.cornerX(side, wa, g) - cx) > climb.REACH) {
      console.log('SKIP  no climbable wall within reach of his spot; give him a home near one (SHELLBY_E2E_HOME)');
    } else {
      await forget();
      check(await panel.ev(`shellby.dev.climb({ side: '${side}' })`), `he sets off for the ${side} wall`);
      check(await until(async () => (await state()).climb.surface === side, 30000), `he turns onto the ${side} wall`);
      check(await seen(`surface-${side}`), `his body turns (surface-${side})`);
      await wait(1500);
      const on = await state();
      const foot = climb.footIn(side, g);
      const footX = on.bounds.x + foot.x;
      const edgeX = side === 'left' ? wa.x : wa.x + wa.width;
      check(Math.abs(footX - edgeX) <= 2, `his feet are on the edge (${footX} vs ${edgeX})`);
      check(on.bounds.y < home.y, `he's climbed above the floor (y ${on.bounds.y} < ${home.y})`);
      await critter.shot('2-on-the-wall');

      // 3. come down
      await forget();
      check(await panel.ev('shellby.dev.climb({ leave: true })'), 'asked to come down');
      check(await until(async () => (await state()).climb.surface === 'floor' && (await seen('flying'))), 'he lets go and falls');
      check(await until(async () => { const s = await state(); return !s.motion && Math.abs(s.bounds.x - home.x) <= 3 && Math.abs(s.bounds.y - home.y) <= 3; }, 30000), 'he lands and walks home');
      check(!(await critter.ev("document.body.className.includes('surface-')")), 'upright again');
    }

    // 4. thrown at the side of the screen
    const right = s0.climb.edges.right;
    const leftEdge = s0.climb.edges.left;
    if (right || leftEdge) {
      const dir = right ? 1 : -1;
      await forget();
      // Steeply up and at the near wall, so he hits it well clear of the floor (a throw that's about to land anyway doesn't stick).
      await panel.ev(`shellby.dev.throw({ vx: ${dir * 900}, vy: -2400 })`);
      const stuck = await until(async () => ['left', 'right', 'ceiling'].includes((await state()).climb.surface), 6000);
      check(stuck, `a hard throw ${dir > 0 ? 'right' : 'left'} sticks him to an edge (${(await state()).climb.surface})`);
      if (stuck) {
        await wait(700);
        await critter.shot('4-stuck');
        await panel.ev('shellby.dev.climb({ leave: true })');
        await until(async () => { const s = await state(); return !s.motion && s.climb.surface === 'floor' && Math.abs(s.bounds.y - home.y) <= 3; }, 30000);
      }
    }

    // 5. a note
    await until(async () => { const s = await state(); return !s.motion && Math.abs(s.bounds.x - home.x) <= 3; }, 20000);
    const before = await state();
    // Mischief behaves on a call or with something fullscreen in front. If this PC has either going, that's the rail
    // working: say so, then have the test look past it so the prank itself still gets checked.
    const environmental = ['call', 'fullscreen', 'focus'];
    if (environmental.includes(before.mischief.blocked)) console.log(`NOTE  mischief held back for "${before.mischief.blocked}", as it should; the test looks past that`);
    const started = await panel.ev(`shellby.dev.prank({ kind: 'note', ignore: ${JSON.stringify(environmental)} })`);
    check(started, `the note prank starts${started ? '' : ` (blocked: ${before.mischief.blocked}, free: ${before.mischief.free}, motion: ${before.motion})`}`);
    if (started) {
      check(await until(async () => (await state()).mischief.notes === 1, 40000), 'a note arrives on the desktop');
      check(await until(async () => (await state()).mischief.running === null, 20000), "and he's done hauling");
      const noteT = (await targets()).find(t => t.url.endsWith('note.html'));
      if (noteT) {
        const note = await connect(noteT.webSocketDebuggerUrl);
        await wait(600);
        const text = await note.ev("document.getElementById('text').textContent");
        check(typeof text === 'string' && text.length > 2, `the note says something ("${text}")`);
        await note.shot('5-note');
        await note.ev("document.getElementById('note').click(); true");
        note.close();
        check(await until(async () => (await state()).mischief.notes === 0, 4000), 'clicking it throws it away');
      } else check(false, 'the note window is there to look at');
    }

    // 6. called off mid-adventure, he's never left stranded
    const atHome = async () => { const s = await state(); return !s.motion && s.climb.surface === 'floor' && Math.abs(s.bounds.x - home.x) <= 3 && Math.abs(s.bounds.y - home.y) <= 3; };
    await until(atHome, 20000);
    if (await panel.ev("shellby.dev.prank({ kind: 'note', ignore: ['call', 'fullscreen', 'focus'] })")) {
      await wait(1200); // on his way to the edge
      await panel.ev("shellby.setSettings({ mischief: 'off' })");
      check(await until(atHome, 30000), 'mischief switched off mid-note: he comes back home');
      check((await state()).mischief.running === null, '...and the prank is over');
      await panel.ev("shellby.setSettings({ mischief: 'gremlin' })");
    }
    await until(atHome, 20000);
    if (await panel.ev("shellby.dev.climb({})")) {
      check(await until(async () => (await state()).climb.surface !== 'floor', 30000), 'up a wall again');
      await wait(800);
      await panel.ev('shellby.setSettings({ wander: false })');
      check(await until(async () => (await state()).climb.surface === 'floor', 4000), 'strolling switched off on the wall: he lets go');
      check(await until(async () => { const s = await state(); return !s.motion && s.bounds.y >= home.y - 3; }, 30000), "...and lands rather than hanging in mid-air");
      await panel.ev('shellby.setSettings({ wander: true })');
    }
  } catch (e) {
    console.error(e);
    fails++;
  } finally {
    app.kill();
    console.log(`\nscreenshots: ${OUT}`);
    console.log(fails ? `${fails} FAILED` : 'all passed');
    process.exit(fails ? 1 : 0);
  }
})();
