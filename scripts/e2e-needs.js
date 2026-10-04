// End-to-end check of his needs (src/main/needs.js, care.js), against the dev
// app over CDP with the fake CLI (isolated profile), in just-the-crab mode,
// since none of it needs Claude:
//   1. a neglected crab shows it: mopey, and low on everything, never below the floor
//   2. saying hello for the day puts plankton in the pantry, no tasks needed
//   3. the Us page's "How he's doing": four meters with their sand floor, the
//      intro, the pantry, the buttons
//   4. Feed: a plankton drifts down, he munches, the trophy, the story, XP
//   5. Rinse: suds and shine, then a cooldown
//   6. Tuck in: he says goodnight and naps
//   7. Settings → Snacks and naps off: it all goes; back on, he's full
// No Claude account, no usage.
//   node scripts/e2e-needs.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9381;
const HOOK = 47995;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-needs-'));
fs.mkdirSync(OUT, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  // Screenshots are for a person to look at, not something checked, so one that
  // doesn't come (a hidden or unpainted window on a CI runner) is noted and skipped.
  const shot = async (name, params = {}) => {
    const s = await Promise.race([send('Page.captureScreenshot', { format: 'png', ...params }), wait(10000)]);
    if (s?.data) fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(s.data, 'base64'));
    else console.log(`(no screenshot for ${name}: Page.captureScreenshot got no answer in 10s)`);
  };
  return { send, ev, shot, close: () => ws.close() };
}

function launch(data) {
  return spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...process.env, SHELLBY_USER_DATA: data,
      SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'),
      SHELLBY_HOOK_PORT: String(HOOK), SHELLBY_MOTION_TEST: '1',
      SHELLBY_FAKE_HEALTH: 'calm', // a hot GPU would rightly take his bubble off him
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

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  // A crab left a while: low on everything, a couple of snacks put by.
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
    onboarded: true, crabOnly: true, chatter: 'normal', sounds: false, wander: false, perch: 'off',
    needs: { meters: { fullness: 30, tidiness: 33, energy: 34, cheer: 37 }, pantry: { plankton: 1, golden: 1 } },
  }));
  const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));

  const app = launch(data);
  try {
    const { panel, critter } = await windows();
    const until = async (c, expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.ev(expr)) return true; await wait(120); } return false; };
    // Whatever has this PC's microphone, he isn't on a call here: a call hushes him
    // and holds back the new day (and its snacks), rightly, but that's e2e-life's to check.
    await panel.ev("shellby.dev.life({ what: 'call', on: false })");
    await wait(3000);
    await critter.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await critter.ev(`window.__cls = new Set(); window.__said = []; window.__props = new Set();
      new MutationObserver(() => document.body.className.split(' ').forEach(c => window.__cls.add(c))).observe(document.body, { attributes: true, attributeFilter: ['class'] });
      const bt = document.getElementById('bubbleText');
      new MutationObserver(() => window.__said.push(bt.textContent)).observe(bt, { childList: true, characterData: true, subtree: true });
      const pr = document.getElementById('prop');
      new MutationObserver(() => { if (pr.className) window.__props.add(pr.className); }).observe(pr, { attributes: true, attributeFilter: ['class'] });
      true`);
    const needs = () => panel.ev('shellby.getLife().then(v => v.needs)');
    const body = () => critter.ev('document.body.className');

    // ------------------------------------------------------- 1. a neglected crab shows it
    check(await until(critter, "document.body.classList.contains('need-mopey')", 10000), `he's a bit mopey (${await body()})`);
    const b = await body();
    check(['low-fullness', 'low-tidiness', 'low-energy', 'low-cheer'].every(c => b.includes(c)), 'every low meter shows on him');
    const n0 = await needs();
    check(n0?.on && n0.meters.every(m => m.value >= m.floor), 'nothing is below its floor');
    check(n0.meters.every(m => !/starv|sick|sad/i.test(m.word)), `gentle words only (${n0.meters.map(m => m.word).join(', ')})`);
    check(await critter.ev("getComputedStyle(document.getElementById('sprite'), '::after').width !== '0px' && getComputedStyle(document.getElementById('sprite'), '::after').content !== 'none'"), 'a few grains of sand on his shell');
    await critter.shot('1-mopey');
    // ...and up close, where a grain of sand is a pixel you can see.
    const r = await critter.ev("(b => ({ x: b.x, y: b.y, width: b.width, height: b.height }))(document.getElementById('crab').getBoundingClientRect())");
    await critter.shot('1-mopey-zoom', { clip: { ...r, scale: 3 } });

    // ------------------------------------------------------- 2. hello for the day
    check(await until(panel, 'shellby.getLife().then(v => v.needs.pantry.plankton >= 3)', 20000), 'saying hello today put plankton in the pantry, no tasks needed');

    // ------------------------------------------------------- 3. How he's doing
    await panel.ev("SB.setView('us')");
    check(await until(panel, "!document.getElementById('usNeeds').hidden", 4000), 'the Us page shows how he is doing');
    check(await panel.ev("document.querySelectorAll('#usMeters [role=meter]').length === 4"), '...four meters, each a real meter');
    check(await panel.ev("[...document.querySelectorAll('#usMeters .us-meter-cells')].every(m => m.querySelector('i.floor'))"), '...each with its sand floor');
    check(await panel.ev("/missing you/.test(document.getElementById('usNeedsMood').textContent)"), '...and says what is up in words');
    check(await panel.ev("!document.getElementById('usNeedsIntro').hidden && /focus sessions/.test(document.getElementById('usNeedsIntroFrom').textContent)"), 'the first time, a note explains it (crab-only sources)');
    check(await panel.ev("document.querySelectorAll('#usPantry .us-snack svg').length >= 2"), 'the pantry draws his snacks');
    await panel.ev("document.getElementById('usNeeds').scrollIntoView({ block: 'start' }); true");
    await wait(300);
    await panel.shot('3-us-needs');
    await panel.ev("document.getElementById('usNeedsGotIt').click()");
    check(await until(panel, 'shellby.getLife().then(v => v.needs.introduced)', 3000), '"Got it" puts the note away for good');

    // ------------------------------------------------------- 4. Feed
    await critter.ev('window.__cls.clear(); window.__props.clear(); window.__said.length = 0; true');
    const before = (await needs()).pantry.total;
    await panel.ev("document.querySelector('[data-care=feed]').click()");
    check(await until(critter, "window.__props.has('prop-plankton-drop')", 4000), 'a plankton drifts down to him');
    check(await until(critter, "window.__cls.has('bit-munch')", 4000), '...and he munches it');
    await critter.shot('4-munch');
    check(await until(critter, "window.__said.some(t => /nom|snack|plankton|thank|yum|deserved/.test(t))", 6000), `...and says so (${JSON.stringify(await critter.ev('window.__said'))})`);
    const fed = await needs();
    check(fed.pantry.total === before - 1, 'one snack gone from the pantry');
    check(fed.mood !== 'mopey', `he cheers right up (${fed.mood})`);
    check(await until(panel, "shellby.getLife().then(v => v.bond.journal.some(e => e.kind === 'first-snack'))", 3000), 'his first snack goes in the story');
    await wait(1500);
    check(saved().stats?.snacksFed === 1 && saved().wardrobe?.unlocked?.includes('snack-time'), 'and earns Snack Time');
    check((saved().xp?.log || []).some(e => e.kind === 'feed'), '...and a little XP');
    await wait(3000); // let him finish

    // ------------------------------------------------------- 5. Rinse
    await critter.ev('window.__props.clear(); true');
    const r1 = await panel.ev('shellby.needs.rinse()');
    check(r1?.ok, 'a rinse');
    check(await until(critter, "window.__props.has('prop-suds')", 3000), '...suds');
    check(r1.life.needs.meters.find(m => m.id === 'tidiness').value === 100, '...and he is shiny');
    const r2 = await panel.ev('shellby.needs.rinse()');
    check(!r2?.ok && /shiny|again/i.test(r2.error), `a second rinse says why not (${r2?.error})`);
    await wait(4500);

    // ------------------------------------------------------- 6. Tuck in
    const t = await panel.ev('shellby.needs.tuck()');
    check(t?.ok, 'tucked in');
    check(await until(critter, "document.body.classList.contains('state-sleeping')", 6000), '...and he nods off');
    await critter.shot('6-asleep');

    // ------------------------------------------------------- 7. off, and on again
    await panel.ev("SB.setView('settings')");
    await panel.ev("document.getElementById('needsToggle').click()");
    check(await until(panel, 'shellby.getLife().then(v => !v.needs.on)', 3000), 'Snacks and naps switches off');
    check(await until(critter, "!/need-|low-/.test(document.body.className)", 4000), '...and nothing shows on him');
    await panel.ev("SB.setView('us')");
    check(await until(panel, "document.getElementById('usNeeds').hidden", 3000), '...or on the Us page');
    await panel.ev("SB.setView('settings')");
    await panel.ev("document.getElementById('needsToggle').click()");
    check(await until(panel, 'shellby.getLife().then(v => v.needs.on && v.needs.meters.every(m => m.value === 100))', 3000), 'back on, he is full rather than hungry');
    check(saved().bond?.points > 0, 'and the bond only ever went up');

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
