// End-to-end check of Shellby's voice and his little habits, against the dev
// app over CDP with the fake CLI (isolated profile):
//   1. Quiet: a finished task shows the bare glyph, exactly as before he spoke
//   2. Normal: he says a few words, in his own bubble, and it clears itself
//   3. The bubble stays inside his window, however long the line (no clipping)
//   4. He reacts to what the work is: a test run, then the tests passing
//   5. Anything that matters outranks him: a health warning wins the bubble
//   6. Idle habits: he digs, polishes, peeks, stretches, flops
//   7. On guard he says nothing at all, and chirps stay silent
//   8. His temperament is the same crab after a restart
// No Claude account, no usage.
//   node scripts/e2e-voice.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');
const { BITS } = require('../src/main/voice');

const ROOT = path.join(__dirname, '..');
const PORT = 9363;
const HOOK = 47998;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-voice-'));
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

function launch(data, extra = {}) {
  return spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...process.env, SHELLBY_USER_DATA: data,
      SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'),
      SHELLBY_HOOK_PORT: String(HOOK), SHELLBY_MOTION_TEST: '1', SHELLBY_LONG_TASK_MS: '4000', ...extra,
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

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const settings = { onboarded: true, chatter: 'quiet', sounds: false, wander: false };
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(settings));

  const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));

  let app = launch(data);
  try {
    const { panel, critter } = await windows();
    const until = async (c, expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.ev(expr)) return true; await wait(120); } return false; };
    const bubble = () => critter.ev("document.getElementById('bubbleText').textContent");
    await wait(3000);
    // Any app holding the microphone (Discord, a game recorder) reads as a call,
    // and on a call he says nothing; pin it off so the run doesn't depend on the PC.
    await panel.ev("shellby.dev.life({ what: 'call', on: false })");
    // Record every class the critter shows, so short beats aren't missed.
    await critter.ev("window.__cls = new Set(); new MutationObserver(() => document.body.className.split(' ').forEach(c => window.__cls.add(c))).observe(document.body, { attributes: true, attributeFilter: ['class'] }); true");
    const seen = cls => critter.ev(`window.__cls.has(${JSON.stringify(cls)})`);
    // Count the chirps he plays, without making any noise on the test machine.
    await critter.ev("window.__chirps = []; window.ShellbyChirp.play = o => window.__chirps.push(o); true");
    const chirps = () => critter.ev('window.__chirps.length');
    // Every text the bubble has shown. A trophy or a new mood can replace a line
    // within a frame, so the run is judged on this rather than on one instant.
    await critter.ev("window.__said = []; const bt = document.getElementById('bubbleText'); new MutationObserver(() => window.__said.push(bt.textContent)).observe(bt, { childList: true, characterData: true, subtree: true }); true");
    const saidTexts = () => critter.ev('window.__said');

    // ------------------------------------------------------- 1. quiet says nothing
    const ready = await until(panel, 'shellby.claudeStatus().then(s => s.installed && s.loggedIn)', 20000);
    check(ready, 'Claude Code is found and signed in (the fake CLI stands in for it)');
    await panel.ev("SB.setView('chat')");
    check(await until(panel, '!!SB.activeTab()', 8000), 'a conversation tab is ready');
    await panel.ev("SB.send('hello')");
    // His first task also earns his first trophy, which takes the bubble over
    // within a frame, so look at what he showed rather than what he shows.
    check(await until(critter, "window.__cls.has('state-success')", 12000), 'quiet: a task finishes');
    const quietTexts = await saidTexts();
    check(quietTexts.includes('✓'), `quiet: the bubble was the bare glyph (showed ${JSON.stringify(quietTexts)})`);
    check(!quietTexts.some(t => /[a-z]{2,}/.test(t)), 'quiet: not one word, all run long');
    check(!(await seen('saying')), 'quiet: he never said anything');
    check(await panel.ev('shellby.dev.say("success").then(s => s === null)'), 'quiet: even asked directly, he has no line');
    await critter.shot('1-quiet');

    // ------------------------------------------------------- 2. he speaks
    await panel.ev("shellby.setSettings({ chatter: 'normal' })");
    await wait(7500); // let the previous success flash end
    await panel.ev("SB.send('hello again')");
    check(await until(critter, "document.body.classList.contains('saying')", 8000), 'normal: he says something');
    const line = await bubble();
    check(line.length > 1 && /[a-z]/i.test(line), `...in words: "${line}"`);
    await critter.shot('2-saying');
    check(await until(critter, "!document.body.classList.contains('saying')", 12000), '...and the line clears itself');
    check(await bubble() !== line, 'the bubble goes back to his mood');

    // ------------------------------------------------- 3. the bubble never clips
    const fits = await critter.ev(`(() => {
      const b = document.getElementById('bubble').getBoundingClientRect();
      return { left: b.left, right: b.right, bottom: b.bottom, w: innerWidth, h: innerHeight,
               crabTop: document.getElementById('crab').getBoundingClientRect().top };
    })()`);
    await panel.ev('shellby.dev.say("back")'); // one of his longest lines
    await wait(400);
    const widest = await critter.ev(`(() => {
      const b = document.getElementById('bubble').getBoundingClientRect();
      return { left: b.left, right: b.right, bottom: b.bottom, text: document.getElementById('bubbleText').textContent,
               crabTop: document.getElementById('crab').getBoundingClientRect().top, w: innerWidth };
    })()`);
    check(widest.left >= 0 && widest.right <= widest.w + 1, `his longest line stays in the window ("${widest.text}": ${Math.round(widest.left)}-${Math.round(widest.right)} of ${widest.w})`);
    check(widest.bottom <= widest.crabTop + 1, `...and never reaches the crab (bubble ends ${Math.round(widest.bottom)}, crab starts ${Math.round(widest.crabTop)})`);
    check(fits.w === widest.w, 'the window never resized to fit a line');
    await critter.shot('3-longest-line');

    // ------------------------------------- 4. he reacts to what the work is
    // The gap between any two lines is the anti-chatter guardrail doing its job,
    // so each beat below waits it out (12s on 'chatty').
    await panel.ev("shellby.setSettings({ chatter: 'chatty' })");
    const spoke = async (key, ms = 12000) => {
      for (let i = 0; i < ms / 140; i++) { if (saved().voice?.said?.[key]) return true; await wait(140); }
      return false;
    };
    // He only ever says one thing at a time, so a musing while we wait can take
    // the turn. Try a few times rather than assume the first one gets through.
    let remarked = false;
    for (let attempt = 0; attempt < 3 && !remarked; attempt++) {
      await wait(13000);
      await panel.ev("SB.send('run npm test')");
      remarked = (await spoke('tests', 9000)) || !!saved().voice?.said?.passed;
    }
    check(await seen('saying'), 'a test run gets a remark');
    check(remarked, `...about the tests themselves (said: ${Object.keys(saved().voice?.said || {}).join(', ') || 'nothing'})`);
    await wait(13000);
    await panel.ev("SB.send('run git push')");
    check(await spoke('push'), 'a push that lands gets its own line');

    // A task that keeps running earns a "bear with me". The clock is armed once
    // when the task starts: a busy task refreshes many times a second, and
    // re-arming it there would mean this could only ever fire for a silent task.
    await wait(13000);
    await panel.ev("SB.send('slow')");
    check(await until(critter, "document.body.classList.contains('state-working')", 5000), 'a long task keeps him working');
    check(await spoke('longTask', 15000), '...and after a while he says so, even while it streams');
    await panel.ev('SB.stop?.() ?? shellby.stopTask(SB.activeTab().id)');
    await wait(1500);

    // ------------------------------------------------------- 6. idle habits
    for (const bit of ['dig', 'polish', 'peek', 'stretch', 'flop']) {
      await panel.ev(`shellby.dev.bit('${bit}')`);
      const on = await until(critter, `document.body.classList.contains('bit-${bit}')`, 2000);
      check(on, `idle habit: ${bit}`);
      if (on) await critter.shot(`5-bit-${bit}`);
    }
    check(await until(critter, "!/\\bbit-/.test(document.body.className)", 4000), '...and each one ends on its own');
    check(await panel.ev(`shellby.dev.bit('nonsense').then(b => ${JSON.stringify(BITS)}.includes(b))`), 'an unknown habit falls back to a real one');

    // --------------------------------------------- 7. on guard he keeps quiet
    await panel.ev("shellby.setSettings({ sounds: true })");
    await wait(400); // switching sounds on plays a taste of the chirp; count from after it
    const chirpsBefore = await chirps();
    await panel.ev('shellby.startFocus(25)');
    await wait(800);
    check(await panel.ev('shellby.dev.say("success").then(s => s === null)'), 'guarding your focus: he says nothing');
    check(await chirps() === chirpsBefore, '...and chirps nothing either');
    await critter.shot('6-on-guard');
    await panel.ev('shellby.stopFocus()');
    await wait(600);
    check(!!(await panel.ev('shellby.dev.say("success")')), 'off guard, he speaks again');
    check(await until(critter, `window.__chirps.length > ${chirpsBefore}`, 2000), '...and chirps with it when sounds are on');

    // ------------------------------------------- 8. the same crab next time
    const temperament = await panel.ev('shellby.dev.temperament()');
    const seed = saved().voice?.seed;
    check(!!seed && !!temperament, `he has a seed and a temperament (${temperament})`);
    panel.close(); critter.close();
    app.kill();
    await wait(2500);

    app = launch(data, { SHELLBY_FAKE_HEALTH: 'hot' });
    const again = await windows();
    await wait(4000);
    check(await again.panel.ev('shellby.dev.temperament()') === temperament, `still the same ${temperament} crab after a restart`);
    check(saved().voice?.seed === seed, '...with the same seed');

    // A health warning outranks anything he has to say. A reading has to hold for
    // about 20 seconds before it counts, so wait for the mood to actually land.
    const untilAgain = async (expr, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await again.critter.ev(expr)) return true; await wait(500); } return false; };
    const hot = await untilAgain("document.body.className.includes('health-')", 60000);
    check(hot, 'the fake hot GPU settles into a health mood (SHELLBY_FAKE_HEALTH=hot)');
    const warned = await again.critter.ev("document.getElementById('bubbleText').textContent");
    const line2 = await again.panel.ev("shellby.dev.say('idle')");
    await wait(400);
    const now2 = await again.critter.ev("document.getElementById('bubbleText').textContent");
    check(!!line2, `...he still has a line to say ("${line2 && line2.text}")`);
    check(now2 === warned && now2 !== line2?.text, `...but the health warning keeps the bubble (${JSON.stringify(now2)}, not ${JSON.stringify(line2 && line2.text)})`);
    await again.critter.shot('7-health-wins');
    again.panel.close(); again.critter.close();
  } finally {
    app.kill();
  }
  console.log(`\n${fails ? `${fails} FAILED` : 'all good'} — screenshots in ${OUT}`);
  process.exit(fails ? 1 : 0);
})();
