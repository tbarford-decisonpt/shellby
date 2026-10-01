// End-to-end check of the shareable crab card against the dev app over CDP
// (throwaway profile: the card is saved inside it and the clipboard is left alone).
// Dresses Shellby, clicks "Share" in the Wardrobe, and checks the preview, the saved
// PNG (1200x630) and the Show-Off trophy.
//   node scripts/e2e-card.js [out.png]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9346;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: { ...process.env, SHELLBY_USER_DATA: profile } });
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
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
    await wait(3000);

    // Dress him up first.
    await ev(`(async () => {
      SB.applyWardrobe(await shellby.setWardrobeOptions({ unlockAll: true }));
      const r = await shellby.setOutfit({ hat: 'wizard-hat', held: 'coffee-mug', effect: 'sparkles' });
      SB.applyWardrobe(r.view);
    })()`);
    await wait(800);
    await ev("SB.setView('wardrobe')");
    await wait(600);

    const btn = await ev("!!document.querySelector('#wardrobeView [data-share-card]')");
    check(btn, 'Wardrobe has a Share button');
    await ev("document.querySelector('#wardrobeView [data-share-card]').click()");
    const shown = await (async () => { for (let i = 0; i < 30; i++) { if (await ev("!document.getElementById('cardSheet').hidden")) return true; await wait(200); } return false; })();
    check(shown, 'preview sheet opens');
    const img = JSON.parse(await ev("JSON.stringify((i => ({ w: i.naturalWidth, h: i.naturalHeight }))(document.getElementById('cardImg')))"));
    check(img.w === 1200 && img.h === 630, `preview is 1200x630 (${img.w}x${img.h})`);

    const dir = path.join(profile, 'Shellby');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^shellby-card-.*\.png$/.test(f)) : [];
    check(files.length === 1, `card saved in the test profile (${files.join(', ') || 'none'})`);
    if (files[0]) {
      const buf = fs.readFileSync(path.join(dir, files[0]));
      check(buf.readUInt32BE(16) === 1200 && buf.readUInt32BE(20) === 630, 'saved PNG is 1200x630');
      const out = process.argv[2] || path.join(os.tmpdir(), 'shellby-card.png');
      fs.copyFileSync(path.join(dir, files[0]), out);
      console.log(`card: ${out}`);
    }
    const note = await ev("document.getElementById('cardPath').textContent");
    check(/^Pictures[\\/]Shellby[\\/]shellby-card-/.test(note), `note names the file (${note})`);

    await wait(600);
    const trophy = await ev("(SB.state.wardrobe.achievements.find(a => a.id === 'show-off') || {}).done");
    check(trophy === true, 'sharing earns the Show-Off trophy');

    // Junk sent straight to the bridge is refused.
    const bad = await ev("shellby.saveCard(new Uint8Array([1, 2, 3])).then(r => r.ok)");
    check(bad === false, 'non-PNG bytes are refused');

    await ev("document.getElementById('cardClose').click()");
    await wait(300);
    check(await ev("document.getElementById('cardSheet').hidden"), 'close hides the sheet');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
