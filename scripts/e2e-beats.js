// End-to-end check of how he moves between moods and what he works with
// (src/renderer/critter/beats.js, src/main/workpose.js). Drives the real app
// over CDP and feeds it real hook events on the real port:
//   1. work starts with a crouch and a spring
//   2. each tool has its pose and the thing in his claw (a scroll for Read...)
//      and every loop on him is one shared/framecap.js can read, so it only
//      draws when the picture changes
//   3. done with a tool, he goes back to his scuttle
//   4. a question: he perks up, taps a claw when it waits, nods when answered
//   5. the turn ends and he lets out a breath
//   6. he nods off in stages, and wakes eyes first
//   node scripts/e2e-beats.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const PORT = 9374;
const HOOK = 47996;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-beats-'));
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connect(url, dir) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  const shot = async name => await savePng(send, path.join(dir, `${name}.png`));
  return { ev, shot, close: () => ws.close() };
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-beats-data-'));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`, '--force-prefers-no-reduced-motion'], {
    stdio: 'ignore',
    env: {
      ...process.env, SHELLBY_USER_DATA: data, SHELLBY_MOTION_TEST: '1',
      SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: String(HOOK),
    },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl, OUT);
    const critter = await connect(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl, OUT);
    const until = async (expr, ms = 8000, every = 150) => { const end = Date.now() + ms; while (Date.now() < end) { if (await critter.ev(expr)) return true; await wait(every); } return false; };
    const has = cls => `document.body.classList.contains('${cls}')`;
    const hook = body => fetch(`http://127.0.0.1:${HOOK}/v1/hook`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'X-Shellby': '1' },
    }).then(r => r.status);
    // Every animation on him that shared/framecap.js can't read (it would draw every tick).
    const unreadable = () => critter.ev(`document.getAnimations()
      .filter(a => a.effect?.target?.closest?.('#self') && a.effect.getComputedTiming().iterations === Infinity)
      .filter(a => !window.ShellbyFrameCap.changesOf(a.effect))
      .map(a => a.animationName || a.transitionProperty || '?')`);
    // What's in his claw, as drawn: his own item (an outfit can have one) or a tool.
    const heldItem = () => critter.ev("[...document.querySelectorAll('#sprite .acc-held')].map(g => g.innerHTML).join('')");
    // How far a part of him is out of his shell (1 out, 0 tucked in).
    const out = part => critter.ev(`Number(getComputedStyle(document.querySelector('#sprite .${part}')).opacity)`);

    await wait(3000);
    await panel.ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; })");
    await panel.ev('shellby.setExternal(true)');
    check(await until("true", 1000) && await panel.ev("new Promise(r => { const t = setInterval(async () => { if ((await shellby.getExternal()).status === 'listening') { clearInterval(t); r(true); } }, 200); setTimeout(() => r(false), 6000); })"), 'Shellby is listening for sessions elsewhere');
    await panel.ev("shellby.dev.life({ what: 'call', on: false })");

    // ---------------------------------------------- idle: the eyes on their long loop
    check(await until("[...document.querySelectorAll('#sprite .part-eyes')].some(e => getComputedStyle(e).animationName === 'idle-eyes')", 6000), 'idle, his eyes run the 24 s loop (uneven blinks, a glance each way)');
    check((await unreadable()).length === 0, `idle, every loop is one framecap can read (${await unreadable()})`);
    const own = await heldItem();

    // ---------------------------------------------- 1. work starts
    const session = { session_id: 'beats-e2e-1', cwd: 'C:\\Users\\you\\code\\tide-pool' };
    await hook({ ...session, hook_event_name: 'UserPromptSubmit' });
    check(await until(has('lead-work'), 3000, 40), 'work starts with a crouch and a spring (lead-work)');
    check(await until(has('state-working') + ` && !${has('lead-work')}`, 3000), '...and then the scuttle');
    await critter.shot('0-scuttle');
    check((await unreadable()).length === 0, `the scuttle is all steps framecap can read (${await unreadable()})`);

    // ---------------------------------------------- 2. a pose for each tool
    const TOOLS = [['Read', 'read', true], ['Edit', 'write', true], ['Bash', 'shell', true], ['WebSearch', 'web', true], ['TodoWrite', 'plan', true], ['Task', 'call', false]];
    let last = null;
    for (const [tool, pose, holds] of TOOLS) {
      if (last) await hook({ ...session, hook_event_name: 'PostToolUse', tool_name: last });
      await hook({ ...session, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {} });
      last = tool;
      check(await until(has(`pose-${pose}`), 4000, 60), `${tool}: his ${pose} pose`);
      await until(`!${has('tool-swap')}`, 1000, 50);
      check((await heldItem() !== own) === holds, `${tool}: ${holds ? 'the tool in his claw' : 'his own claw (and whatever he carries) to wave with'}`);
      const bad = await unreadable();
      check(bad.length === 0, `${tool}: every loop is one framecap can read (${bad})`);
      await critter.shot(`1-${pose}`);
    }

    // ---------------------------------------------- 3. done with the tool
    await hook({ ...session, hook_event_name: 'PostToolUse', tool_name: last });
    check(await until(`![...document.body.classList].some(c => c.startsWith('pose-'))`, 5000), 'between tools, back to his scuttle');
    check(await heldItem() === own, '...with the tool put away and his own things back');

    // ---------------------------------------------- 4. a question
    await hook({ ...session, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
    await hook({ ...session, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
    check(await until(has('lead-ask'), 3000, 40), 'a question: he perks up first (lead-ask)');
    check(await until(has('state-asking'), 3000), '...and puts a claw up');
    check(await until(has('ask-nudge'), 25000, 500), 'left waiting, he taps his claw (ask-nudge, after 20 s)');
    await critter.shot('2-ask-nudge');
    await hook({ ...session, hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    check(await until(has('lead-answer'), 3000, 40), 'answered: a nod (lead-answer)');
    check(!(await critter.ev(has('ask-nudge'))), '...and the tapping stops');

    // ---------------------------------------------- 5. the turn ends
    await hook({ ...session, hook_event_name: 'Stop' });
    check(await until(`${has('after-win')} || ${has('after-work')}`, 12000, 60), 'the turn ends and he lets out a breath');

    // ---------------------------------------------- 6. a nap
    await until(has('state-idle'), 8000);
    await wait(1500);
    check(await panel.ev("shellby.dev.life({ what: 'nap', ms: 4000 })"), 'he takes a nap');
    check(await until(has('dozing'), 3000, 40), 'he nods off in stages (dozing)');
    const early = { legs: await out('part-legs-a'), eyes: await critter.ev("getComputedStyle(document.querySelector('#sprite .part-eyes')).animationName") };
    check(early.legs > 0.9 && early.eyes === 'doze-eyes', `first his eyes droop, legs still out (${JSON.stringify(early)})`);
    await until(`Number(getComputedStyle(document.querySelector('#sprite .part-legs-a')).opacity) < 0.5`, 2000, 40);
    check(await out('part-eyes') > 0.5, '...then his legs tuck in while his eyes are still out');
    await critter.shot('3-dozing');
    check(await until(`${has('state-sleeping')} && !${has('dozing')}`, 4000), '...and is asleep');
    check(await until(has('waking'), 8000, 40), 'the nap ends: he wakes (waking)');
    await until(`Number(getComputedStyle(document.querySelector('#sprite .part-eyes')).opacity) > 0.5`, 1000, 30);
    check(await out('part-legs-a') < 0.5, 'eyes first: they are out while his legs are still tucked in');
    await critter.shot('4-waking');
    check(await until(`!${has('waking')}`, 3000), '...and is up');

    console.log(`\nscreenshots in ${OUT}`);
    panel.close();
    critter.close();
  } catch (e) {
    console.log('FAIL ', e.stack || e.message);
    fails++;
  } finally {
    app.kill();
  }
  process.exit(fails ? 1 : 0);
})();
