// End-to-end check of outfit codes against the dev app over CDP (throwaway
// profile). Dress up -> read the code -> undress -> paste it back -> same look.
// Also: locked items, an item from a community pack you don't have (looked up in
// the live gallery), a typo, and the code on the crab card.
//   node scripts/e2e-outfit-code.js [screenshot.png]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encodeOutfit } = require('../src/main/wardrobe/codes');

const ROOT = path.join(__dirname, '..');
const PORT = 9351;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`],
    { stdio: 'ignore', env: { ...process.env, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')), SHELLBY_HOOK_PORT: '47995' } });
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
    const paste = async code => { await ev(`(i => { i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input')); })(SB.$('codeInput'))`); await wait(700); };
    await wait(3000);

    // 1. Dress up and read the code.
    await ev(`(async () => {
      SB.applyWardrobe(await shellby.setWardrobeOptions({ unlockAll: true }));
      SB.applyWardrobe((await shellby.setOutfit({ hat: 'wizard-hat', held: 'coffee-mug', effect: 'sparkles', face: null, neck: null, shell: null })).view);
      SB.setView('wardrobe');
    })()`);
    await wait(800);
    const look = encodeOutfit({ hat: 'wizard-hat', held: 'coffee-mug', effect: 'sparkles' });
    check(await until(`document.getElementById('outfitCode').textContent === ${JSON.stringify(look)}`), `Wardrobe shows the code (${look})`);

    // 2. Undress, then wear the code again.
    await ev("(async () => SB.applyWardrobe((await shellby.setOutfit({ hat: null, held: null, effect: null })).view))()");
    check(await until(`document.getElementById('outfitCode').textContent !== ${JSON.stringify(look)}`), 'code changes when the outfit does');
    await ev("document.getElementById('wearCodeBtn').click()");
    check(await ev("!document.getElementById('codeSheet').hidden"), '"Wear a code…" opens the sheet');
    await paste(look.toLowerCase().replace(/-/g, ' '));
    check(await ev("document.querySelectorAll('#codeItems .code-row.ok').length") === 3, 'preview lists 3 wearable items (sloppy input accepted)');
    check(await ev("!!document.querySelector('#codeCrab svg')"), 'preview shows the crab wearing it');
    if (process.argv[2]) {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.argv[2], Buffer.from(s.data, 'base64'));
    }
    await ev("document.getElementById('codeWear').click()");
    check(await until(`document.getElementById('outfitCode').textContent === ${JSON.stringify(look)}`), 'wearing it brings the exact look back');
    const outfit = JSON.parse(await ev('JSON.stringify(SB.state.wardrobe.outfit)'));
    check(outfit.hat === 'wizard-hat' && outfit.held === 'coffee-mug' && outfit.effect === 'sparkles', 'outfit really changed');

    // 3. Locked items show how to earn them and can't be worn.
    await ev("(async () => SB.applyWardrobe(await shellby.setWardrobeOptions({ unlockAll: false })))()");
    await ev("document.getElementById('wearCodeBtn').click()");
    await paste(encodeOutfit({ hat: 'crown' }));
    const lockedText = await ev("document.querySelector('#codeItems .code-row.locked .code-state')?.textContent || ''");
    check(/🔒/.test(lockedText), `locked item says how to earn it ("${lockedText}")`);
    check(await ev("document.getElementById('codeWear').disabled"), "can't wear a look that's all locked");

    // 4. An item from a community pack you don't have: found in the live gallery.
    await paste(encodeOutfit({ hat: 'tiny-hats/fez' }));
    check(await until("!!document.querySelector('#codeItems .code-row.pack')", 15000), 'missing community item is traced to its pack');
    const packText = await ev("document.querySelector('#codeItems .code-row.pack')?.textContent || ''");
    check(/Fez/.test(packText) && /Tiny Hats/.test(packText) && /Get pack/.test(packText), `...with "Get pack" (${packText.replace(/\s+/g, ' ').trim()})`);

    // 5. Typos are caught.
    const typo = look.slice(0, 6) + (look[6] === 'Z' ? 'Y' : 'Z') + look.slice(7);
    await paste(typo);
    check(/typo|short|look like/i.test(await ev("document.getElementById('codeError').textContent")), 'a typo shows a friendly error');
    await ev("document.getElementById('codeCancel').click()");

    // 6. The crab card carries the code.
    await ev("(async () => SB.applyWardrobe(await shellby.setWardrobeOptions({ unlockAll: true })))()");
    await wait(400);
    const cardCode = await ev('SB.crabCard.render().then(r => r.data.code)');
    check(cardCode === look, `crab card includes the code (${cardCode})`);
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
