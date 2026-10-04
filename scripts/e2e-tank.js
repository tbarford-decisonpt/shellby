// End-to-end for his tank (Shellby's screen → Tank) over the Chrome DevTools
// Protocol: decorating with the keyboard alone (tray, arrow keys, flip, undo),
// what's locked staying locked, Done keeping it (and earning Moving In), main
// refusing a layout it shouldn't keep, the porthole on the Health view, and
// the tank still being there after a restart. Screenshots go to the temp
// profile (or E2E_SHOTS). Checks state, never animation, so it passes with the
// motion turned down (as on CI's runners).
//   node scripts/e2e-tank.js
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 9378;
const ROOT = path.join(__dirname, '..');
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function list() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; }
}

async function target(suffix, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const t = (await list()).find(x => x.url.endsWith(suffix));
    if (t) return t;
    await wait(500);
  }
  throw new Error(`${suffix} never appeared`);
}

async function cdp(wsUrl, shots) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise(r => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || `eval failed: ${expr}`);
    return r.result?.result?.value;
  };
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  };
  // A real key press, so the panel's own keydown handlers run.
  const key = async (k, mods = 0) => {
    const code = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Delete: 46, f: 70 }[k] || 0;
    const text = k.length === 1 ? k : k === 'Enter' ? '\r' : undefined;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, windowsVirtualKeyCode: code, modifiers: mods, text });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: code, modifiers: mods });
  };
  return { ev, shot, key, close: () => ws.close() };
}

function check(cond, what) {
  if (!cond) throw new Error(what);
  console.log(`  ✓ ${what}`);
}

async function launch(profile) {
  const app = spawn(electron, [ROOT, `--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: { ...process.env, SHELLBY_USER_DATA: profile } });
  const panel = await cdp((await target('panel.html')).webSocketDebuggerUrl, process.env.E2E_SHOTS || profile);
  const until = async (expr, what, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await panel.ev(expr)) return; await wait(150); }
    throw new Error(`timed out waiting for ${what}`);
  };
  await until('!!window.SB && !!SB.state.version && !!SB.tankPaint', 'panel boot');
  return { app, panel, until };
}

(async () => {
  const profile = process.env.SHELLBY_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  let run = await launch(profile);
  let ok = false;
  try {
    const { panel, until } = run;
    await panel.ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; })");

    console.log('the tab');
    check(await panel.ev('document.querySelectorAll(\'.shellby-tabs [data-goto="tank"]\').length === document.querySelectorAll(\'.shellby-tabs\').length'), 'every Shellby tab row has Tank');
    await panel.ev("SB.setView('tank')");
    await until("!!SB.tankView() && document.getElementById('tkSub').textContent.length > 0", 'the tank view');
    check(await panel.ev("document.getElementById('tkSub').textContent") === 'Nano tank · 0 of 10 pieces', 'a new tank is an empty nano tank');
    check(await panel.ev("!document.getElementById('tkEmpty').hidden"), 'an empty tank says how to fill it');
    await panel.shot('tank-1-empty');

    console.log('decorating with the keyboard');
    await panel.ev("document.getElementById('tkDecorate').click()");
    await until("!document.getElementById('tkTray').hidden", 'the tray');
    const castle = '[...document.querySelectorAll(".tk-item")].find(b => b.dataset.ref === "castle-keep")';
    await panel.ev(`${castle}.focus()`);
    await panel.key('Enter');
    await until('document.querySelectorAll(".tk-hit:not(.tk-hit-crab)").length === 1', 'the castle going in');
    check(await panel.ev('document.activeElement.classList.contains("tk-hit") && document.activeElement.getAttribute("aria-label").startsWith("Sandcastle Keep")'), 'the new piece has focus and a name');
    const xOf = 'parseFloat(document.activeElement.style.left)';
    const x0 = await panel.ev(xOf);
    await panel.key('ArrowRight', 8); // Shift
    await panel.key('ArrowRight');
    check(await panel.ev(xOf) > x0, 'the arrow keys move it');
    await panel.key('f');
    check(await panel.ev('document.activeElement.getAttribute("aria-label").includes("flipped")'), 'F flips it');
    // A plant from another shelf, and a rock for the front.
    await panel.ev('document.querySelector(\'#tkShelves [data-shelf="plant"]\').click()');
    await panel.ev('[...document.querySelectorAll(".tk-item")].find(b => b.dataset.ref === "kelp").focus()');
    await panel.key('Enter');
    await panel.ev('document.querySelector(\'#tkShelves [data-shelf="rock"]\').click()');
    await panel.ev('[...document.querySelectorAll(".tk-item")].find(b => b.dataset.ref === "rock-round").focus()');
    await panel.key('Enter');
    await until('document.querySelectorAll(".tk-hit:not(.tk-hit-crab)").length === 3', 'three pieces');
    check(await panel.ev('document.activeElement.getAttribute("aria-label").includes("front row")'), 'a small rock goes in the front row');
    await panel.key('ArrowUp');
    check(await panel.ev('document.activeElement.getAttribute("aria-label").includes("middle row")'), 'Up moves it a row back');
    await panel.ev("document.getElementById('tkUndo').click()");
    check(await panel.ev('document.querySelector(".tk-hit[aria-label*=\\"Round Rock\\"]").getAttribute("aria-label").includes("front row")'), 'Undo puts it back');
    await panel.ev("document.getElementById('tkRedo').click()");
    check(await panel.ev('document.querySelector(".tk-hit[aria-label*=\\"Round Rock\\"]").getAttribute("aria-label").includes("middle row")'), 'Redo moves it again');
    // Send back really is back: the castle and the rock share the middle row
    // now, so sending the rock back puts it behind the castle, and again does nothing.
    await panel.ev('document.querySelector(".tk-hit[aria-label*=\\"Sandcastle\\"]").focus()');
    await panel.key('ArrowDown');
    const order = 'SB.tankPaint.resolve(SB.tankView().layout, SB.tankView()) && [...document.querySelectorAll(".tk-hit:not(.tk-hit-crab)")].map(b => b.getAttribute("aria-label").split(",")[0])';
    await panel.ev('document.querySelector(".tk-hit[aria-label*=\\"Round Rock\\"]").focus()');
    await panel.key(']');
    const front = await panel.ev(order);
    check(front.indexOf('Round Rock') > front.indexOf('Sandcastle Keep'), '] brings it in front of the castle');
    await panel.key('[');
    const back = await panel.ev(order);
    check(back.indexOf('Round Rock') < back.indexOf('Sandcastle Keep'), '[ sends it behind the castle');
    const undos = await panel.ev("document.getElementById('tkUndo').disabled ? 0 : 1");
    await panel.ev('document.querySelector(".tk-hit[aria-label*=\\"Round Rock\\"]").focus()');
    await panel.key('[');
    check(undos === 1 && (await panel.ev('document.activeElement.getAttribute("aria-label")')).startsWith('Round Rock'), 'sending back what is already at the back changes nothing');
    await panel.ev('document.querySelector(\'#tkShelves [data-shelf="treasure"]\').click()');
    check(await panel.ev('[...document.querySelectorAll(".tk-item")].find(b => b.dataset.ref === "sunken-chest").disabled'), 'the chest is locked until Moving In');
    await panel.shot('tank-2-decorating');

    console.log('done');
    await panel.ev("document.getElementById('tkDone').click()");
    await until("document.getElementById('tkTray').hidden", 'leaving the editor');
    check((await panel.ev('shellby.getTank()')).count === 3, 'main kept the three pieces');
    await until("shellby.wardrobeView().then(v => v.achievements.find(a => a.id === 'moving-in').done)", 'Moving In');
    check(true, 'Moving In is earned');
    await until('shellby.getTank().then(v => !v.tray.find(t => t.ref === "sunken-chest").locked)', 'the chest unlocking');
    check(true, 'and the chest is his');
    await panel.ev('SB.clearCelebrations?.()');
    await wait(400);
    await panel.shot('tank-3-watching');

    console.log('main checks what it keeps');
    const hostile = await panel.ev(`shellby.saveTank({
      size: 'grand',
      style: { substrate: 'castle-keep', backdrop: '../../x', light: 'disco' },
      placed: [{ ref: '__proto__' }, { ref: 'find:pearl' }, ...Array.from({ length: 300 }, (_, i) => ({ ref: 'rock-round', x: i, row: 2 }))],
    })`);
    check(hostile.ok && hostile.view.size.id === 'nano', 'a tank he hasn’t grown into is refused');
    check(hostile.view.count === 10, 'the tank holds no more than its room');
    check(hostile.view.layout.style.substrate === null && hostile.view.layout.style.light === 'clock', 'a bad floor and light are dropped');
    check(hostile.dropped.some(d => d.ref === 'find:pearl' && d.reason === 'unknown'), 'a find he hasn’t dug up can’t go in');
    // Put the real one back for the rest.
    await panel.ev(`shellby.saveTank({ size: 'nano', style: { substrate: 'gravel', backdrop: 'rock-wall', light: 'clock' }, placed: [
      { uid: 1, ref: 'castle-keep', x: 8, row: 0, z: 1 }, { uid: 2, ref: 'kelp', x: 70, row: 0 }, { uid: 3, ref: 'rock-round', x: 40, row: 2 },
      { uid: 4, ref: 'sunken-chest', x: 60, row: 2 }, { uid: 5, ref: 'air-stone', x: 86, row: 2 }, { uid: 6, ref: 'java-fern', x: 28, row: 0 } ] })
      .then(r => { document.dispatchEvent(new CustomEvent('sb:tank', { detail: r.view })); return r; })`);

    console.log('the porthole');
    await panel.ev("SB.views.tank.render(); SB.setView('health')");
    await until("!!document.querySelector('#hlHero .hl-porthole')", 'the porthole');
    check(await panel.ev("document.querySelector('#hlHero .hl-tank').classList.contains('has-porthole')"), 'the Health view looks into his tank');
    check(await panel.ev(`(() => { const c = document.querySelector('#hlHero .hl-porthole'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) lit++; return lit > d.length / 8; })()`), 'and it has the tank painted in it');
    await panel.shot('tank-4-health');

    console.log('after a restart');
    run.app.kill();
    await wait(2500);
    run = await launch(profile);
    await run.panel.ev("SB.setView('tank')");
    await run.until("!!SB.tankView() && SB.tankView().count === 6", 'the tank after a restart');
    check(true, 'everything is where he left it');
    check((await run.panel.ev('SB.tankView().layout.style.substrate')) === 'gravel', 'the floor too');
    await run.panel.shot('tank-5-restart');

    ok = true;
    console.log(`\nPASS  (screenshots in ${process.env.E2E_SHOTS || profile})`);
  } catch (e) {
    console.error('\nFAIL:', e.message);
    try { await run.panel.shot('tank-fail'); } catch { /* the window may be gone */ }
  } finally {
    run.app.kill();
    process.exitCode = ok ? 0 : 1;
  }
})();
