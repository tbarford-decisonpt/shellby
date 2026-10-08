// End-to-end for his tank's Phase 3 over the Chrome DevTools Protocol: the
// gauges in disguise (a faked hot PC reaching the thermometer and the water,
// a gauge turned off staying off), saved layouts (save, put up, a season's
// layout going up by itself), and the tidying switch. Checks state, never
// animation, so it passes with the motion turned down (as on CI's runners).
// Screenshots go to the temp profile (or E2E_SHOTS).
//   node scripts/e2e-tank-gauges.js
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 9396;
const HOOK_PORT = 47396;
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
    const r = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), wait(10000).then(() => null)]);
    if (r?.result?.data) fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  };
  return { ev, shot, close: () => ws.close() };
}

function check(cond, what) {
  if (!cond) throw new Error(what);
  console.log(`  ✓ ${what}`);
}

const apps = [];

async function launch(profile) {
  const env = { ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_HEALTH: 'hot', SHELLBY_HOOK_PORT: String(HOOK_PORT) };
  const app = spawn(electron, [ROOT, `--remote-debugging-port=${PORT}`], { stdio: 'ignore', env });
  apps.push(app);
  const panel = await cdp((await target('panel.html')).webSocketDebuggerUrl, process.env.E2E_SHOTS || profile);
  const until = async (expr, what, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await panel.ev(expr)) return; await wait(200); }
    throw new Error(`timed out waiting for ${what}`);
  };
  await until('!!window.SB && !!SB.state.version && !!SB.tankPaint && !!SB.tankGauges && !!SB.tankLayouts', 'panel boot');
  return { app, panel, until };
}

async function quit(app, ms = 20000) {
  if (app.exitCode !== null || app.signalCode !== null) return;
  const gone = new Promise(r => app.once('exit', r));
  app.kill();
  await Promise.race([gone, wait(ms)]);
  const end = Date.now() + ms;
  while (Date.now() < end && (await list()).length) await wait(250);
}

(async () => {
  const profile = process.env.SHELLBY_USER_DATA || fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')));
  let ok = false;
  let run = null;
  try {
    run = await launch(profile);
    const { panel, until } = run;
    await panel.ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; })");
    await panel.ev("SB.setView('tank')");
    await until("!!SB.tankView() && document.getElementById('tkSub').textContent.length > 0", 'the tank view');

    console.log('gauges in disguise');
    await until('shellby.getTankGauges().then(g => !!g.thermometer)', 'a thermometer reading from the faked hot PC');
    const g = await panel.ev('shellby.getTankGauges()');
    check(Number.isInteger(g.thermometer.value), `the thermometer reads ${g.thermometer.value}°`);
    check(Object.values(g.live).every(Boolean), 'every gauge starts on');
    await until('shellby.getTankGauges().then(g => g.mood === "hot" || g.mood === "scorching")', 'the hot mood reaching the water');
    check(true, 'the water takes his hot mood');
    check(await panel.ev("document.getElementById('tkLiveNow').textContent.includes('thermometer')"), 'the tank says what the gauges show, in words');
    await panel.shot('tank-gauges-1-hot');
    await panel.ev("(() => { const el = document.querySelector('[data-live=\"thermometer\"]'); el.click(); })()");
    await until('shellby.getTankGauges().then(g => g.thermometer === null && g.live.thermometer === false)', 'the thermometer coming off');
    check(true, 'a gauge turned off stays off');
    check(await panel.ev('shellby.getTankGauges().then(g => g.mood !== null)'), 'and the others stay on');

    console.log('layouts');
    await panel.ev("shellby.saveTank({ size: 'nano', style: { light: 'day' }, placed: [{ ref: 'castle-keep', x: 20, row: 0 }, { ref: 'kelp', x: 60, row: 0 }] })");
    await panel.ev("document.getElementById('tkLayoutName').value = 'Everyday'; document.getElementById('tkLayoutForm').requestSubmit()");
    await until("document.querySelectorAll('#tkLayouts .tk-layout').length === 1", 'the saved layout in the list');
    check(await panel.ev("document.querySelector('#tkLayouts .tk-layout-name').textContent === 'Everyday'"), 'a layout saved under its name');
    await panel.ev("shellby.saveTank({ size: 'nano', style: { light: 'day' }, placed: [] })");
    await panel.ev("SB.tankApply(null); shellby.getTank().then(v => SB.tankApply(v))");
    await until('SB.tankView().count === 0', 'an emptied tank');
    await panel.ev("document.querySelector('#tkLayouts [data-act=\"use\"]').click()");
    await until('SB.tankView().count === 2', 'the layout going up');
    check(true, 'Put up brings the saved layout back');

    const active = await panel.ev('shellby.tankLayouts().then(r => r.layouts.active)');
    if (active.length) {
      const id = await panel.ev('shellby.tankLayouts().then(r => r.layouts.list[0].id)');
      await panel.ev(`shellby.seasonTankLayout({ id: '${id}', season: '${active[0]}' })`);
      await panel.ev("shellby.saveTank({ size: 'nano', style: { light: 'day' }, placed: [{ ref: 'rock-round', x: 5, row: 2 }] })");
      const r = await panel.ev('shellby.tankLayouts()');
      check(r.changed === true && r.view.count === 2, `a layout tagged to ${active[0]} (running now) goes up by itself`);
      check(r.layouts.list[0].up === true, 'and the list says it’s up for the season');
    } else {
      console.log('  - no season running today: the season switch is covered by test/tank-layouts.test.js');
    }
    await panel.shot('tank-gauges-2-layouts');

    console.log('tidying up');
    check(await panel.ev("document.getElementById('tkTidyOn').checked"), 'Let him tidy up starts on');
    await panel.ev("document.getElementById('tkTidyOn').click()");
    await until("shellby.tankTidy().then(r => r.on === false)", 'tidying turned off');
    check(true, 'and it turns off');

    console.log('after a restart');
    run.panel.close();
    await quit(run.app);
    run = await launch(profile);
    await run.panel.ev("SB.setView('tank')");
    await run.until('shellby.getTankGauges().then(g => g.live.thermometer === false)', 'the gauge still off');
    check(true, 'the thermometer is still off');
    await run.until("document.querySelectorAll('#tkLayouts .tk-layout').length === 1", 'the saved layout after a restart');
    check(true, 'the layout is still saved');
    check(await run.panel.ev("shellby.tankTidy().then(r => r.on === false && r.moved === null)"), 'tidying is still off, and he moved nothing');

    ok = true;
    console.log(`\nPASS  (screenshots in ${process.env.E2E_SHOTS || profile})`);
  } catch (e) {
    console.error('\nFAIL:', e.message);
    try { await run?.panel.shot('tank-gauges-fail'); } catch { /* the window may be gone */ }
  } finally {
    for (const app of apps) await quit(app, 5000);
    process.exit(ok ? 0 : 1);
  }
})();
