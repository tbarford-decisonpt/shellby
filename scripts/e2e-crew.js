// The crew, end to end in the real app against the fake Claude CLI (no account,
// no usage): a code-reviewer helper goes out, its crab appears on the desktop
// wearing its crew name, Claude acts on what it found, and the Crew page shows
// the lasting record (runs, acted on, level, hat), which a rename and a hat
// change update. Screenshots go to %TEMP%\shellby-e2e-crew.
//   node scripts/e2e-crew.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9361;
const wait = ms => new Promise(r => setTimeout(r, ms));
const OUT = path.join(os.tmpdir(), 'shellby-e2e-crew');

async function connect(match) {
  let list = [];
  for (let i = 0; i < 60 && !list.some(t => t.url.endsWith(match)); i++) {
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
    await wait(500);
  }
  const target = list.find(t => t.url.endsWith(match));
  if (!target) throw new Error(`${match} never appeared`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0;
  const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  const until = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(120); } return false; };
  // A guarded screenshot: an unpainted window can hang captureScreenshot for minutes.
  const shot = async name => {
    const r = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), wait(10000).then(() => null)]);
    if (r?.data) fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
    return !!r?.data;
  };
  return { ev, until, shot };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...process.env,
      SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')),
      SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'),
      SHELLBY_FAKE_REVIEW_MS: '2500', // long enough to see the helper on the desktop
      SHELLBY_HOOK_PORT: '47993',
    },
  });
  try {
    const panel = await connect('panel.html');
    const critter = await connect('critter.html');
    await wait(2500);
    await panel.ev("shellby.setSettings({ onboarded: true, mode: 'autonomous' }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    const type = text => panel.ev(`(i => { i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(SB.$('input'))`);

    // ---- out on the desktop, wearing its crew name (after its first run it has one)
    await type('review crew please');
    check(await critter.until("[...document.querySelectorAll('#crew .helper.fresh .tag')].some(t => / Lv 1 · Review the diff$/.test(t.textContent))", 6000), 'a brand-new agent type is named on its very first trip out');
    check(await panel.until("document.body.textContent.includes('REVIEW FIXED')"), 'the first review turn finishes');
    const first = await panel.ev('shellby.getCrew()');
    const rev = first?.members?.find(m => m.type === 'code-reviewer');
    check(!!rev, 'a code-reviewer crew member signed up');
    check(rev?.runs === 1 && rev?.actedOn === 1, `its run was acted on (runs ${rev?.runs}, acted on ${rev?.actedOn})`);
    check(rev?.tokens === 1800, `tokens counted (${rev?.tokens})`);

    await type('review crew again');
    check(await critter.until("[...document.querySelectorAll('#crew .helper:not(.leaving) .tag')].some(t => t.textContent.startsWith(" + JSON.stringify(`${rev?.name} Lv 2 `) + "))", 6000),
      `the helper crab on the desktop wears its crew name (${rev?.name})`);
    check(await critter.ev("!!document.querySelector('#crew .helper svg')"), 'and is drawn');
    console.log('      on the desktop:', JSON.stringify(await critter.ev("[...document.querySelectorAll('#crew > *')].map(e => e.className + ' | ' + (e.getAttribute('aria-label') || ''))")));
    await critter.shot('desktop-helper');
    check(await panel.until("document.querySelectorAll('.msg.assistant').length >= 2 && [...document.querySelectorAll('.msg.assistant')].pop().textContent.includes('REVIEW FIXED')"), 'the second review turn finishes');

    // ---- the Crew page (the Crew Boss trophy card would cover it)
    for (let i = 0; i < 12 && await panel.ev("!!document.querySelector('.cel-close')"); i++) { await panel.ev("document.querySelector('.cel-close').click()"); await wait(300); }
    await panel.ev("SB.setView('crew')");
    check(await panel.until("document.querySelectorAll('#crewList .cr-row').length === 1"), 'the Crew page lists one member');
    const row = await panel.ev(`(() => { const r = document.querySelector('#crewList .cr-row'); return { name: r.querySelector('h3').textContent, type: r.querySelector('.cr-type code').textContent, lv: r.querySelector('.cr-lv').textContent, stats: [...r.querySelectorAll('.cr-stat b')].map(b => b.textContent) }; })()`);
    check(row.type === 'code-reviewer', `row shows the agent type (${row.type})`);
    check(row.stats[0] === '2' && row.stats[1] === '2', `row shows 2 runs, 2 acted on (${row.stats.join(', ')})`);
    check(Number(row.lv) >= 2, `two runs acted on is level 2 or more (${row.lv})`);
    check(await panel.ev("!document.getElementById('crewDock').hidden && document.querySelectorAll('#crewDock .cr-dock-crab').length === 1"), 'the dock shows the crew');
    check(await panel.ev("document.querySelector('.shellby-tabs [data-goto=\"crew\"][aria-current=\"page\"]') !== null"), 'the Crew tab is current in the Shellby tabs');
    await panel.shot('crew-page');

    // ---- rename and a hat
    await panel.ev("document.querySelector('#crewDock .cr-dock-crab').click()");
    check(await panel.until("document.querySelector('#crewList details.cr-more')?.open === true"), 'clicking a crab on the dock opens its drawer');
    await panel.ev("(i => { i.value = 'Captain Nitpick'; i.dispatchEvent(new Event('change')); })(document.querySelector('.cr-rename'))");
    check(await panel.until("document.querySelector('#crewList h3')?.textContent === 'Captain Nitpick'"), 'renaming sticks');
    await panel.ev("(b => { b.focus(); b.click(); })(document.querySelector('.cr-hats button[aria-label=\"No hat\"]'))");
    check(await panel.until("shellby.getCrew().then(v => v.members[0].hat === 'none' && v.members[0].accessories.length === 0)"), 'picking "No hat" takes the hat off');
    check(await panel.ev("[...document.querySelectorAll('.cr-hats button.locked')].every(b => b.disabled)"), 'hats not yet earned are locked');
    check(await panel.until("document.activeElement?.dataset.focus === 'hat:none' && document.activeElement.getAttribute('aria-pressed') === 'true'", 3000), 'the keyboard stays on the hat just picked');
    await panel.until("document.querySelector('#crewList details.cr-more')?.open === true", 2000);
    await panel.shot('crew-drawer');

    // ---- crab-only mode has no crew tab
    await panel.ev("document.body.classList.add('crab-only')");
    check(await panel.ev("getComputedStyle(document.querySelector('.shellby-tabs [data-goto=\"crew\"]')).display === 'none'"), 'just-the-crab mode hides the Crew tab');
    await panel.ev("document.body.classList.remove('crab-only')");
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(`screenshots: ${OUT}`);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
