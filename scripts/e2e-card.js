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
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: { ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47961' } });
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

    // His tank (tank.js): plain sand while it's empty, the real tank once there's something in it.
    const tankBox = "(r => { const d = r.canvas.getContext('2d').getImageData(48, 48, 470, 470).data; let s = 0; for (let i = 0; i < d.length; i += 97) s = (s * 31 + d[i]) >>> 0; return { n: r.data.tankPieces, s }; })";
    const plain = await ev(`SB.crabCard.render().then(${tankBox})`);
    check(plain?.n === 0, 'an empty tank: the card looks as it always has');
    const placed = await ev("shellby.saveTank({ size: 'nano', style: { substrate: 'gravel', backdrop: null, light: 'day' }, placed: [{ ref: 'castle-keep', x: 30, row: 0, z: 0, flip: false }, { ref: 'kelp', x: 6, row: 0, z: 0, flip: false }, { ref: 'rock-round', x: 50, row: 2, z: 0, flip: false }] }).then(r => r.view.pieces.length)");
    check(placed === 3, 'three pieces in his tank');
    const decorated = await ev(`SB.crabCard.render().then(${tankBox})`);
    check(decorated?.n === 3 && decorated.s !== plain.s, `the crab card paints his tank (${decorated?.n} pieces)`);
    const tankPng = path.join(os.tmpdir(), 'shellby-card-tank.png');
    const tankUrl = await ev('SB.crabCard.render().then(r => r.canvas.toDataURL("image/png"))');
    if (typeof tankUrl === 'string') { fs.writeFileSync(tankPng, Buffer.from(tankUrl.split(',')[1], 'base64')); console.log(`card with his tank: ${tankPng}`); }

    // The profile card only shows it once you choose (Tank → On your cards).
    await ev("SB.setView('tank')");
    await wait(1200);
    check(!(await ev("SB.profileCard.build().includes('id=\"tkw\"')")), 'the profile card keeps it off until you choose');
    await ev("document.getElementById('tkShare').click()");
    const svgOk = async () => ev("(s => s.includes('id=\"tkw\"') && s.length < 256 * 1024 && !/<(image|use|script|foreignObject)\\b|href=/.test(s))(SB.profileCard.build())");
    let shows = false;
    for (let i = 0; i < 20 && !shows; i++) { shows = await svgOk(); if (!shows) await wait(250); }
    check(shows, 'then the profile card shows him in it, as plain SVG');
    const svgFile = path.join(os.tmpdir(), 'shellby-profile-tank.svg');
    fs.writeFileSync(svgFile, await ev('SB.profileCard.build()') || '');
    // ...and as GitHub would show it: an image, drawn.
    const drawn = await ev(`new Promise(r => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = 480; c.height = 200;
      c.getContext('2d').drawImage(i, 0, 0); r(c.toDataURL('image/png')); }; i.onerror = () => r(null); i.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(SB.profileCard.build()); })`);
    check(typeof drawn === 'string', 'the profile card with his tank loads as an image');
    if (drawn) fs.writeFileSync(svgFile.replace(/\.svg$/, '.png'), Buffer.from(drawn.split(',')[1], 'base64'));
    console.log(`profile card with his tank: ${svgFile} (and .png)`);
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
