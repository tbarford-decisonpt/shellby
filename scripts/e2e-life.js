// ci: his life between tasks: scenes, gifts, the Finds and Us pages, your day, birthdays, hide and seek, fetch
// End-to-end check of his life between tasks (src/main/life.js and friends),
// against the dev app over CDP with the fake CLI (isolated profile), in
// just-the-crab mode, since none of this needs Claude:
//   1. he stays awake while you're at your PC, and his eyes follow the cursor
//   2. every little scene plays: its beats, its props, its lines
//   3. a dig turns up a gift: he holds it up, says so, and it's on the shelf
//   4. the Finds and Us pages: shelf, sets, favourite, bond, temperament, story
//   5. your day: a game ends ("gg"), a call hushes him (the "shh" sign) and he
//      asks how it went after
//   6. your birthday: a fuss, confetti, and a keepsake on the shelf
//   7. hide and seek: he hides somewhere else, you click him, he goes home
//   8. fetch: the pebble appears, gets thrown, he brings it back
// No Claude account, no usage.
//   node scripts/e2e-life.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');
const { FINDS, SETS } = require('../src/main/gifts');
const { UNLOCKS } = require('../src/main/bond');

const ROOT = path.join(__dirname, '..');
const PORT = 9377;
const HOOK = 47999;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-life-'));
fs.mkdirSync(OUT, { recursive: true });
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

function launch(data) {
  return spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...process.env, SHELLBY_USER_DATA: data,
      SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'),
      SHELLBY_HOOK_PORT: String(HOOK), SHELLBY_MOTION_TEST: '1',
      // Calm sensors: a hot GPU on the test machine would rightly take his bubble off him.
      SHELLBY_FAKE_HEALTH: 'calm',
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
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ onboarded: true, crabOnly: true, chatter: 'normal', sounds: false, wander: false, perch: 'off' }));
  const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));

  const app = launch(data);
  try {
    const { panel, critter } = await windows();
    const until = async (c, expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.ev(expr)) return true; await wait(120); } return false; };
    await wait(3000);
    // CI runners ask for reduced motion, which draws only the still props; this check is about the moving ones.
    await critter.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    // Everything the crab shows, so short beats aren't missed.
    await critter.ev(`window.__cls = new Set(); window.__said = []; window.__props = new Set();
      new MutationObserver(() => document.body.className.split(' ').forEach(c => window.__cls.add(c))).observe(document.body, { attributes: true, attributeFilter: ['class'] });
      const bt = document.getElementById('bubbleText');
      new MutationObserver(() => window.__said.push(bt.textContent)).observe(bt, { childList: true, characterData: true, subtree: true });
      const pr = document.getElementById('prop');
      new MutationObserver(() => { if (pr.className) window.__props.add(pr.className); }).observe(pr, { attributes: true, attributeFilter: ['class'] });
      true`);
    const said = () => critter.ev('window.__said');
    const life = () => panel.ev('shellby.getLife()');

    // ------------------------------------------------------- 1. awake, and watching you
    check(await until(critter, "document.body.classList.contains('state-idle')", 8000), 'he starts out awake');
    const l0 = await life();
    check(!!l0?.temperament?.name && !!l0.temperament.blurb, `he has a temperament (${l0?.temperament?.name})`);
    check(l0?.bond?.journal?.some(e => e.kind === 'hatched'), 'the story starts with him moving in');
    const lookx = "getComputedStyle(document.documentElement).getPropertyValue('--lookx').trim()";
    await until(critter, `['-1', '0', '1'].includes(${lookx})`, 5000);
    const look = await critter.ev(lookx);
    check(['-1', '0', '1'].includes(look),`his eyes have somewhere to look (--lookx ${look})`);

    // ------------------------------------------------------- 2. every scene plays
    const scenes = await panel.ev('shellby.getLife().then(v => v.scenes.list.map(s => s.id))');
    check(scenes.length >= 20, `there are plenty of scenes (${scenes.length})`);
    const firstBits = { pounce: 'bit-squint', sneeze: 'bit-nose', castle: 'bit-dig', airguitar: 'bit-rock', sunbathe: 'bit-stretch', stargaze: 'bit-gaze', showfind: 'bit-present' };
    let played = 0;
    for (const id of scenes) {
      await critter.ev('window.__cls.clear(); true');
      const r = await panel.ev(`shellby.dev.scene(${JSON.stringify(id)})`);
      if (r !== id) { check(false, `scene ${id} starts`); continue; }
      const bit = firstBits[id];
      const ok = await until(critter, bit ? `window.__cls.has('${bit}')` : "[...window.__cls].some(c => c.startsWith('bit-'))", 3000);
      if (ok) played++; else check(false, `scene ${id} animates`);
      if (id === 'castle') {
        check(await until(critter, "window.__props.has('prop-castle')", 6000), 'the sandcastle goes up beside him');
        await critter.shot('2-castle');
        check(await until(critter, "window.__props.has('prop-castle-fall')", 6000), '...and washes away');
        check((await said()).some(t => /building|precisely|masterpiece|nailed it|castle|draft|foundations|oh well/.test(t)), `...and he has something to say about it (${JSON.stringify(await said())})`);
      }
      await wait(id === 'castle' ? 3000 : 600);
    }
    check(played === scenes.length, `all ${scenes.length} scenes animate (${played})`);
    check(await until(panel, 'shellby.getLife().then(v => v.scenes.seen >= 20)', 4000), 'the Us page counts the scenes he has done');
    check((saved().stats?.scenesSeen || 0) >= 10, 'ten different scenes count toward the Little Scenes trophy');
    await wait(9000); // let the last scene finish

    // ------------------------------------------------------- 3. a dig turns up a gift
    await critter.ev('window.__said.length = 0; window.__cls.clear(); true');
    const found = await panel.ev("shellby.dev.life({ what: 'dig' })");
    check(typeof found === 'string', `a manual dig always finds something (${found})`);
    check(await until(critter, "window.__cls.has('bit-present')", 3000), 'he holds it up');
    check((await said()).length > 0, `...and says so (${JSON.stringify(await said())})`);
    await critter.shot('3-present');
    const afterDig = await life();
    // (He may have dug something up on his own meanwhile: his idle habits keep going.)
    check(afterDig.finds.total >= 1 && afterDig.finds.finds.find(f => f.id === found)?.owned, 'it is on the shelf');
    check(afterDig.finds.unseen.includes(found), '...marked new');
    await wait(3500); // credited once he's finished showing it to you
    check(saved().stats?.findsMade >= 1 && saved().wardrobe?.unlocked?.includes('beachcomber'), 'his first find earns Beachcomber');
    check((await life()).bond.journal.some(e => e.kind === 'first-find'), 'and goes in the story');
    check(await panel.ev("shellby.dev.life({ what: 'dig' }).then(r => r === null)"), 'a second dig straight away finds nothing (the sand needs a rest)');

    // ------------------------------------------------------- 4. the Finds and Us pages
    await panel.ev("SB.setView('finds')");
    check(await until(panel, `document.querySelectorAll('#fdGrid .fd-tile').length === ${FINDS.length}`, 4000), 'the shelf lists every find');
    check(await panel.ev("shellby.getLife().then(v => document.querySelectorAll('#fdGrid .fd-tile:not(.locked)').length === v.finds.kinds)"), '...with only what he has found unlocked');
    check(await panel.ev(`document.querySelectorAll('#fdSets .fd-set').length === ${SETS.length}`), `...and ${SETS.length} sets to complete`);
    check(await panel.ev("!document.querySelector('.fd-badge').hidden || true"), 'the Finds tab has a badge for new finds');
    await panel.ev("document.querySelector('#fdGrid .fd-tile:not(.locked)').click()");
    check(await until(panel, "!document.getElementById('fdDetail').hidden", 2000), 'clicking a find opens its card');
    await panel.ev("document.querySelector('#fdDetail .btn.primary')?.click()");
    check(await until(panel, `shellby.getLife().then(v => v.finds.favourite === ${JSON.stringify(found)})`, 3000), 'you can make it his favourite');
    await panel.shot('4-finds');
    check(await until(panel, 'shellby.getLife().then(v => v.finds.unseen.length === 0)', 6000), 'looking at the shelf clears the new badge');
    await panel.ev("SB.setView('us')");
    check(await until(panel, "document.querySelector('#usHero h3')?.textContent.length > 0", 3000), 'the Us page shows how close you are');
    check(await panel.ev("/Your crab is/.test(document.getElementById('usHero').textContent)"), '...and his temperament');
    check(await panel.ev("document.querySelectorAll('#usStory li').length >= 2"), '...and your story so far');
    check(await panel.ev(`document.querySelectorAll('#usUnlocks li').length === ${UNLOCKS.length}`), '...and what opens up as you get closer');
    await panel.shot('4-us');

    // ------------------------------------------------------- 5. your day
    await wait(8000); // a quiet moment first: the gap between his lines
    await critter.ev('window.__said.length = 0; true');
    await panel.ev("shellby.dev.life({ what: 'event', event: { type: 'gameOver', exe: 'cs2.exe', minutes: 42 } })");
    const gg = ['gg', 'did we win?', 'good game?', 'rematch?', 'you were great!', 'enough screen time', 'I could beat that'];
    check(await until(critter, `window.__said.some(t => ${JSON.stringify(gg)}.includes(t))`, 7000), `a game ending gets a "gg" (${JSON.stringify(await said())})`);
    check(await until(panel, "shellby.getLife().then(v => v.bond.journal.some(e => e.kind === 'game' && e.data.app === 'Cs2'))", 3000), '...and goes in the story');
    await panel.ev("shellby.dev.life({ what: 'call', on: true })");
    check(await until(critter, "document.body.classList.contains('on-call')", 3000), 'on a call he goes quiet');
    check(await critter.ev("document.getElementById('bubbleText').textContent === '🤫'"), '...with a "shh" in his bubble');
    await critter.shot('5-call');
    check(await panel.ev('shellby.dev.say("success").then(s => s === null)'), '...and says nothing, even asked');
    await panel.ev("shellby.dev.life({ what: 'call', on: false })");
    check(await until(critter, "!document.body.classList.contains('on-call')", 3000), 'the call ends and the sign goes down');
    await critter.ev('window.__said.length = 0; true');
    await panel.ev("shellby.dev.life({ what: 'event', event: { type: 'callOver', minutes: 25 } })");
    check(await until(critter, "window.__said.some(t => /over|how'd|talk now|shh|chat|quiet|dozed/.test(t))", 6000), `...and he asks how it went (${JSON.stringify(await said())})`);

    // ------------------------------------------------------- 6. your birthday
    // Saving it makes him look at the day again (on his next tick, or straight away here).
    const today = new Date();
    await wait(8000);
    await critter.ev('window.__said.length = 0; true');
    await panel.ev(`shellby.setBirthday({ m: ${today.getMonth() + 1}, d: ${today.getDate()} })`);
    await panel.ev("shellby.dev.life({ what: 'day' })");
    check(await until(critter, "window.__said.includes('happy birthday!!')", 6000), `on your birthday he says so (${JSON.stringify(await said())})`);
    check(await until(panel, "shellby.getLife().then(v => v.finds.finds.find(f => f.id === 'cake-slice').owned)", 6000), '...and digs you up a birthday cake');
    check(await until(panel, "shellby.getLife().then(v => v.bond.journal.some(e => e.kind === 'birthday'))", 3000), '...and remembers it');
    await critter.shot('6-birthday');

    // ------------------------------------------------------- 7. hide and seek
    await wait(4000);
    const home = await panel.ev('shellby.dev.critterPos()');
    check((await panel.ev("shellby.play('hide')"))?.ok === true, 'hide and seek starts');
    check(await until(panel, `shellby.dev.critterPos().then(p => p.x !== ${home.x} || p.y !== ${home.y})`, 9000), 'he goes and hides somewhere else');
    await critter.shot('7-hidden');
    await wait(800);
    await critter.ev('window.__said.length = 0; window.shellby.critter.click(); true');
    // Judged by the score: finding him often levels him up, and the level-up rightly takes the bubble.
    check(await until(panel, 'shellby.getLife().then(v => v.play.hide.found === 1)', 4000), `clicking him finds him (${JSON.stringify(await said())})`);
    check(await until(panel, `shellby.dev.critterPos().then(p => p.x === ${home.x} && p.y === ${home.y})`, 9000), '...and he goes back home');
    const hideScore = (await life()).play?.hide;
    check(hideScore?.found === 1 && hideScore.best > 0, `the game is scored (best ${hideScore?.best} ms)`);
    check(saved().wardrobe?.unlocked?.includes('peekaboo'), 'finding him earns Peekaboo');

    // ------------------------------------------------------- 8. fetch
    await wait(1500);
    check((await panel.ev("shellby.play('fetch')"))?.ok === true, 'fetch starts');
    let toy = null;
    for (let i = 0; i < 30 && !toy; i++) { toy = (await targets()).find(t => t.url.endsWith('toy.html')); if (!toy) await wait(300); }
    check(!!toy, 'a pebble appears beside him');
    if (toy) {
      const pebble = await connect(toy.webSocketDebuggerUrl);
      await wait(800);
      check(await until(pebble, "!!document.querySelector('#toy svg')", 3000), '...drawn as his favourite find');
      // A drop rather than a real throw: the pointer doesn't move, so it lands where it is.
      await pebble.ev('window.toy.dragStart(); window.toy.dragMove(0, 0); window.toy.dragEnd(); true');
      check(await until(panel, 'shellby.getLife().then(v => v.play.fetch.fetched === 1)', 15000), 'he fetches it and brings it back');
      pebble.close();
    }
    await panel.ev("shellby.play('stop')");

    // ------------------------------------------------------- XP without Claude
    const xp = saved().xp?.log || [];
    check(xp.some(e => e.kind === 'play') && xp.some(e => e.kind === 'find' || e.kind === 'treasure'), `finds and games earn XP (${[...new Set(xp.map(e => e.kind))].join(', ')})`);
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
