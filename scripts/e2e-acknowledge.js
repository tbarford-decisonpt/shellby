// End-to-end check of acknowledging new things against the dev app over CDP:
// hovering a new Wardrobe item clears its badge, "Mark all seen" clears the
// rest, closing an unlock card counts as seeing its rewards (letting it time
// out doesn't), and "Dismiss all" clears a queue of cards at once. A fresh
// profile is seeded with new items. No Claude account, no usage.
//   node scripts/e2e-acknowledge.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const PORT = 9361;
const SHOTS = process.argv[2];
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  // stats present: no first-run backfill to add trophies of its own.
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    onboarded: true, stats: { tasksCompleted: 0 },
    wardrobe: { newItems: ['beanie', 'sunglasses', 'sparkles'] },
  }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js') },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const ws = new WebSocket(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const p = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
    const until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
    const isNew = key => ev(`SB.state.wardrobe.accessories.concat(SB.state.wardrobe.effects).find(i => i.key === '${key}').isNew`);
    const stored = () => ev('shellby.wardrobeView().then(v => v.accessories.concat(v.effects).filter(i => i.isNew).map(i => i.key).sort())');
    const shot = async name => { if (SHOTS) await savePng(send, path.join(SHOTS, `${name}.png`)); };
    const hover = async sel => {
      const r = await ev(`(b => b && { x: b.left + b.width / 2, y: b.top + b.height / 2 })(document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect())`);
      if (!r) return false;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
      await wait(400);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
      return true;
    };

    await until('!!SB.state.wardrobe');
    await ev("SB.setView('wardrobe')");
    await wait(600);
    check(await ev("!document.getElementById('wardrobeBadge').hidden"), 'the Shellby dock button shows a dot for new items');
    check(await ev("!document.getElementById('markSeenBtn').hidden"), '"Mark all seen" shows while something is new');
    await shot('ack-wardrobe');

    // 1. Opening a slot tab alone no longer clears its badges.
    await ev("document.querySelector('#wdSlots [data-slot=\"hat\"]').click()");
    await wait(300);
    // (Seasonal items can be new too, depending on the date, so look at the beanie.)
    const BEANIE = '#wdGrid .wd-tile[data-key="beanie"]';
    check(await ev(`!!document.querySelector('${BEANIE}.is-new .new-pill')`), 'the Hats tab shows the beanie as new');
    check(await isNew('beanie'), 'just opening the tab leaves it new');

    // 2. Hovering it acknowledges it.
    check(await hover(BEANIE), 'hovered the beanie');
    await wait(400);
    check(await isNew('beanie') === false, 'hovering the beanie marks it seen');
    check(await ev(`!!document.querySelector('${BEANIE} .new-pill.leaving') && !document.querySelector('${BEANIE}').classList.contains('is-new')`), 'its "new" pill fades out');
    check(await ev("document.querySelector('#wdSlots [data-slot=\"hat\"]').classList.contains('has-new') === SB.state.wardrobe.accessories.some(i => i.slot === 'hat' && i.isNew && !i.locked)"), 'the Hats tab dot only stays for other new hats');
    check(await ev("document.querySelector('#wdSlots [data-slot=\"face\"]').classList.contains('has-new')"), 'the Face tab keeps its dot');
    check(!(await stored()).includes('beanie'), 'main remembers the beanie was seen');

    // 3. Mark all seen clears the rest, and the dock dot.
    await ev("document.getElementById('markSeenBtn').click()");
    await wait(400);
    check(await ev("document.getElementById('wardrobeBadge').hidden"), '"Mark all seen" clears the dock dot');
    check(await ev("document.getElementById('markSeenBtn').hidden"), '…and hides itself');
    check(await ev("!document.querySelector('#wdSlots .has-new')"), '…and every slot tab dot');
    check((await stored()).length === 0, `main has nothing new left (${JSON.stringify(await stored())})`);

    // 4. Unlock cards: a queue of three, with Dismiss all.
    const card = (title, key) => `SB.celebrate({ icon: '🏆', title: '${title}', text: 'test', rewards: [SB.state.wardrobe.accessories.concat(SB.state.wardrobe.effects).find(i => i.key === '${key}')] })`;
    await ev(`(() => { const w = SB.state.wardrobe; const mark = k => ({ ...w, accessories: w.accessories.map(i => i.key === k ? { ...i, isNew: true } : i), effects: w.effects.map(i => i.key === k ? { ...i, isNew: true } : i) }); SB.state.wardrobe = ['beanie', 'sunglasses', 'sparkles'].reduce((acc, k) => (SB.state.wardrobe = mark(k)), w); return true; })()`);
    await ev(`${card('One', 'beanie')}; ${card('Two', 'sunglasses')}; ${card('Three', 'sparkles')}`);
    await wait(500);
    check(await ev("document.querySelector('.celebrate .cel-all')?.textContent") === 'Dismiss all (3)', 'the card offers "Dismiss all (3)"');
    await shot('ack-card');
    await ev("document.querySelector('.celebrate .cel-close').click()");
    await wait(600);
    check(await ev("document.querySelector('.celebrate .cel-title')?.textContent") === 'Two', 'closing one shows the next');
    check(await isNew('beanie') === false, 'closing a card marks its reward seen');
    check(await ev("document.querySelector('.celebrate .cel-all')?.textContent") === 'Dismiss all (2)', 'the count goes down');
    await ev("document.querySelector('.celebrate .cel-close').focus()");
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await wait(600);
    check(await ev("document.querySelector('.celebrate .cel-title')?.textContent") === 'Three', 'Esc closes the focused card');
    check(await ev("document.querySelector('.celebrate .cel-all').hidden"), 'no "Dismiss all" on the last card');
    await ev(`${card('Four', 'beanie')}`);
    await wait(100);
    await ev("document.querySelector('.celebrate .cel-all').click()");
    await wait(600);
    check(await ev("!document.querySelector('.celebrate') && !document.body.classList.contains('celebrating')"), '"Dismiss all" clears the queue');
    check(await isNew('sparkles') === false, '…and marks every reward on it seen');
  } catch (e) {
    console.error('failed:', e.message);
    fails++;
  } finally {
    spawn('taskkill', ['/PID', String(app.pid), '/T', '/F']);
    setTimeout(() => { fs.rmSync(profile, { recursive: true, force: true }); process.exit(fails ? 1 : 0); }, 1200);
  }
})();
