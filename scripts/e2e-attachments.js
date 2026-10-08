// ci: screenshots as tasks: paste a snip, drop a picture, Claude sees it
// End-to-end check of screenshots as tasks against the dev app over CDP, driven
// by the fake Claude CLI (test/fixtures/fake-claude.js): no account, no usage.
// A Win+Shift+S snip pasted into the composer, or a picture with no file behind
// it dropped on the panel or the crab, is saved, shown as a thumbnail chip, and
// reaches Claude as an image block. The pastes and drops are synthetic events
// carrying real PNG bytes, so the system clipboard is never touched.
//   node scripts/e2e-attachments.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9365;
const wait = ms => new Promise(r => setTimeout(r, ms));

// A real PNG made in the page: `w`x`h`, as a File with no path (what a snip is).
const pngFile = (w, h) => `await new Promise(r => { const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h};
  const g = c.getContext('2d'); g.fillStyle = '#e8583f'; g.fillRect(0, 0, ${w}, ${h}); c.toBlob(b => r(new File([b], 'image.png', { type: 'image/png' })), 'image/png'); })`;

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: userData, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47993' },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !['panel.html', 'critter.html'].every(n => list.some(t => t.url.endsWith(n))); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const connect = async name => {
      const ws = new WebSocket(list.find(t => t.url.endsWith(name)).webSocketDebuggerUrl);
      await new Promise(r => { ws.onopen = r; });
      let id = 0; const p = new Map();
      ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
      return expr => new Promise(r => { const i = ++id; p.set(i, m => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
    };
    const ev = await connect('panel.html');
    const crab = await connect('critter.html');
    const until = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
    const attached = () => ev('JSON.stringify(SB.activeTab().attachments)').then(JSON.parse);
    const paste = (fileExpr, text = '') => ev(`(async () => { const dt = new DataTransfer(); dt.items.add(${fileExpr}); ${text ? `dt.setData('text/plain', ${JSON.stringify(text)});` : ''}
      SB.$('input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
    const drop = (on, fileExpr) => on(`(async () => { const dt = new DataTransfer(); dt.items.add(${fileExpr});
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
    const shots = () => { try { return fs.readdirSync(path.join(userData, 'screenshots')); } catch { return []; } };
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await wait(500);

    // 1. Ctrl+V a snip: saved, shrunk to the long-edge limit, shown as a thumbnail chip.
    await paste(pngFile(2400, 1200));
    check(await until('SB.activeTab().attachments.length === 1'), 'a pasted snip is attached');
    const [shot] = await attached();
    check(/[\\/]screenshots[\\/]screenshot-\d{8}-\d{6}-[0-9a-f]{4}\.png$/.test(shot), `saved under the data folder (${path.basename(shot || '')})`);
    const png = fs.readFileSync(shot);
    check(png.readUInt32BE(16) === 2000 && png.readUInt32BE(20) === 1000, `shrunk to 2000 on the long side (${png.readUInt32BE(16)}x${png.readUInt32BE(20)})`);
    check(await until("(document.querySelector('#attachments .att.pic .att-thumb')?.src || '').startsWith('data:image/png')"), 'the chip shows a thumbnail');

    // 2. A paste that also carries text (a cell out of Excel) stays a text paste.
    await paste(pngFile(10, 10), 'just some text');
    await wait(500);
    check((await attached()).length === 1, 'a picture with text alongside is not attached');

    // 3. Something that only claims to be a picture is refused, with a reason.
    await paste("new File(['nope'], 'image.png', { type: 'image/png' })");
    check(await until("/PNG and JPEG/.test(SB.$('toast').textContent) && !SB.$('toast').hidden"), 'a broken picture says why it was refused');
    check((await attached()).length === 1, '...and attaches nothing');

    // 4. Sent: Claude gets the picture itself, and the message keeps its thumbnail.
    await ev("(i => { i.value = 'look at this'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(SB.$('input'))");
    check(await until("[...SB.activeTab().el.querySelectorAll('.msg')].some(e => e.textContent.includes('saw 1: image/png'))"), 'Claude received one PNG image block');
    check(await until("!!SB.activeTab().el.querySelector('.msg.user .att.pic .att-thumb[src^=\"data:image\"]')"), 'the sent message shows the screenshot');
    check(await until('!SB.activeTab().busy'), 'the turn ends');

    // 5. Dropping a picture with no file behind it (out of a browser) on the panel.
    await ev('SB.newTab()');
    await wait(500);
    await drop(ev, pngFile(300, 200));
    check(await until('SB.activeTab().attachments.length === 1'), 'a pathless picture dropped on the panel is attached');
    await drop(ev, "new File(['hi'], 'note.txt', { type: 'text/plain' })");
    await wait(500);
    check((await attached()).length === 1, 'a pathless non-picture is ignored');

    // 6. A screenshot on its own: a prompt and a tab title of its own.
    await ev("SB.send('')");
    check(await until("[...SB.activeTab().el.querySelectorAll('.msg')].some(e => e.textContent.includes('Take a look at the attached screenshot.'))"), 'a screenshot alone gets its own prompt');
    check(await ev('SB.activeTab().title') === 'Screenshot', `the tab is titled "Screenshot" (${await ev('SB.activeTab().title')})`);
    await until('!SB.activeTab().busy');

    // 7. Dropped on the crab: the panel opens with it attached.
    await ev('SB.newTab()');
    await wait(500);
    await drop(crab, pngFile(640, 480));
    check(await until('SB.activeTab().attachments.length === 1'), 'a picture dropped on the crab is attached in the panel');
    check(shots().length === 3, `three screenshots saved (${shots().length})`);

    // 8. The 📎 button is there for everything else.
    check(await ev("!!document.getElementById('attachBtn') && typeof shellby.pickFiles === 'function'"), 'the attach button is wired');

    // 9. A screenshot a tool hands Claude shows under that step, saved apart from the history.
    await ev('SB.newTab()');
    await wait(500);
    await ev("SB.send('snapshot')");
    check(await until("(SB.activeTab().el.querySelector('.tool + .tool-pics .tool-pic img')?.src || '').startsWith('data:image/png')"), 'a tool\'s screenshot shows under its step');
    check(await ev("!(SB.activeTab().el.querySelector('.tool .t-result')?.textContent || '').includes('[image]')"), '...in place of the "[image]" in its text');
    const tabDirs = (() => { try { return fs.readdirSync(path.join(userData, 'tool-pictures')); } catch { return []; } })();
    check(tabDirs.length === 1 && fs.readdirSync(path.join(userData, 'tool-pictures', tabDirs[0])).length === 1, 'saved once, under tool-pictures');
    await ev("SB.activeTab().el.querySelector('.tool-pic').click()");
    check(await ev("SB.activeTab().el.querySelector('.tool-pic').classList.contains('big')"), 'a click shows it bigger');
    await until('!SB.activeTab().busy');

    // 10. A picture Claude writes shows on its step once it's written.
    const drawn = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-drawn-')), 'card.png');
    fs.writeFileSync(`${drawn}.src`, fs.readFileSync(shot));
    await ev('SB.newTab()');
    await wait(500);
    await ev(`SB.send(${JSON.stringify(`drawpic ${drawn}`)})`);
    check(await until("(SB.activeTab().el.querySelector('.tool + .tool-pics .tool-pic img')?.src || '').startsWith('data:image/png')"), 'a picture Claude wrote shows on its step');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
