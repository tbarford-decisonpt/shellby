// ci: @ context and debug mode: @ another chat attached and inlined, /debug's card through a whole round with real posted lines
// End-to-end check of Shellby's own @ context and Debug mode, against the dev
// app over CDP with the fake CLI (test/fixtures/fake-claude.js echoes what it
// gets, so the reply shows exactly what Claude was sent):
//   1. @ lists another conversation above the files; picking it takes the @word
//      out of the box and attaches a snapshot chip that opens; sending inlines
//      it, fenced, and keeps it out of the file list
//   2. /debug: the card, the receiver's address in what Claude got, lines
//      posted to it while you reproduce (and not before), Send, round two,
//      It's fixed, done, and the address closed afterwards
//   node scripts/e2e-context-debug.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const PORT = 9418;
const HOOK = 47918;
const OUT = process.argv[2] || null;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-ctxdbg-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ tideEvents: false }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_E2E: '1', SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: String(HOOK) },
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
    const until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(120); } return false; };
    const shot = async name => { if (!OUT) return; await ev('SB.clearCelebrations?.()'); await savePng(send, path.join(OUT, `${name}.png`)); };
    const idle = () => until('!SB.activeTab().busy', 10000);
    const lastReply = () => ev("[...SB.activeTab().el.querySelectorAll('.msg.assistant')].pop()?.textContent || ''");
    const typeAt = text => ev(`(i => { i.focus(); i.value = ${JSON.stringify(text)}; i.setSelectionRange(i.value.length, i.value.length); i.dispatchEvent(new Event('input')); })(SB.$('input'))`);
    const card = () => ev("(c => c ? { phase: [...c.classList].find(x => x.startsWith('phase-')), text: c.textContent } : null)([...SB.activeTab().el.querySelectorAll('.debug-card')].pop())");
    const press = label => ev(`(b => { if (b) b.click(); return !!b; })([...[...SB.activeTab().el.querySelectorAll('.debug-card')].pop().querySelectorAll('button')].find(b => b.textContent.startsWith(${JSON.stringify(label)})))`);

    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");

    // ---- 1. @ another conversation
    // (Not "remember...": the fake CLI keeps that as a memory.)
    await ev("SB.send('the cart rounding bug is back')");
    check(await idle(), 'a first conversation, to mention later');
    await ev('SB.newTab({ reuse: false })');
    await wait(500);
    await typeAt('what about @cha');
    check(await until("!!document.querySelector('#pickMenu:not([hidden]) .pick-ctx')"), '@cha lists conversations above the files');
    const row = await ev("document.querySelector('#pickMenu .pick-ctx')?.textContent || ''");
    check(/the cart rounding bug is back/.test(row) && /chat, /.test(row), `the row names it and says it's a chat (${row})`);
    await shot('01-at-menu');
    await ev("document.querySelector('#pickMenu .pick-ctx').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))");
    check(await until("!!document.querySelector('#attachments .att.ctx a.file-link')"), 'picking it attaches a chip that opens');
    check(await ev("SB.$('input').value") === 'what about ', `the @word is gone from the box ("${await ev("SB.$('input').value")}")`);
    const chip = await ev("document.querySelector('#attachments .att.ctx').textContent");
    check(/^chat-the-cart-rounding-bug-is-back\.txt/.test(chip), `the chip is named for it (${chip})`);
    await shot('02-chip');
    // (Not "look...": the fake CLI answers that with what pictures it saw.)
    await ev("SB.send('what about this one')");
    check(await idle(), 'sent');
    const echoed = await lastReply();
    check(/Attached from Shellby, as it was when I picked it/.test(echoed), 'Claude got it inline, labelled as records');
    check(/shellby-context from="Conversation: the cart rounding bug is back"/.test(echoed), 'fenced and named');
    check(/You: the cart rounding bug is back/.test(echoed) && /Claude: echo: the cart rounding bug is back/.test(echoed), 'with what was said in it');
    check(!/Attached files \(given to Shellby\)/.test(echoed), 'and not as a file Claude would have to read');

    // ---- 2. /debug, a whole round
    await ev('SB.newTab({ reuse: false })');
    await wait(500);
    await ev("SB.send('/debug the cart total is off by one')");
    check(await until("!!SB.activeTab().el.querySelector('.debug-card')"), '/debug puts a card in the conversation');
    check(await until("SB.activeTab().el.querySelector('.debug-card')?.classList.contains('phase-recording')", 10000), 'once Claude has added logging, it asks you to reproduce it');
    const startEcho = await lastReply();
    const url = (/http:\/\/127\.0\.0\.1:\d+\/debug\/[0-9a-f]{32}/.exec(startEcho) || [])[0];
    check(!!url, `Claude was told where to send its lines (${url})`);
    check(/SHELLBY-DEBUG/.test(startEcho) && /hypotheses/.test(startEcho), 'and to mark them, after listing hypotheses');
    const post = async body => { try { return (await fetch(url, { method: 'POST', body })).status; } catch { return 'closed'; } };
    check(await post('[H1] total=3.0049\n[H2] items=2') === 204, 'the app posts two lines while you reproduce it');
    check(await until("/2 lines logged/.test([...SB.activeTab().el.querySelectorAll('.debug-card')].pop().textContent)", 4000), 'they show on the card as they arrive');
    check(await ev("[...[...SB.activeTab().el.querySelectorAll('.debug-card')].pop().querySelectorAll('.debug-lines li')].map(l => l.textContent).join('|')") === '[H1] total=3.0049|[H2] items=2', 'the newest lines, word for word');
    await shot('03-recording');
    check(await press('Send what was logged'), 'Send what was logged');
    check(await until("/Reproduced it\\. Here's what was logged \\(2 lines\\)/.test([...SB.activeTab().el.querySelectorAll('.msg.user')].pop()?.textContent || '')"), 'your message says what went');
    check(await idle(), 'Claude reads them');
    const evidence = await lastReply();
    check(/<debug-log>/.test(evidence) && /\+0\.00s \[H1\] total=3\.0049/.test(evidence), `Claude got the lines fenced, with times (${evidence.slice(0, 80)}…)`);
    check(await until("[...SB.activeTab().el.querySelectorAll('.debug-card')].pop().classList.contains('phase-recording')"), 'then you reproduce it again');
    const two = await card();
    check(/try 2/.test(two.text) && /It's fixed/.test(two.text) && /Still broken/.test(two.text), 'try 2: fixed, or still broken');
    check(await press("It's fixed"), "It's fixed");
    check(await until("[...SB.activeTab().el.querySelectorAll('.debug-card')].pop().classList.contains('phase-done')", 10000), 'Claude takes the logging out, and Shellby checks');
    await shot('04-done');
    check(/take out everything you added only for debugging/.test(await lastReply()), 'Claude was asked to take out every marked line');
    const late = await post('late');
    check(late === 404 || late === 'closed', `the address stops answering once it is done (${late})`);
    check(await ev("SB.activeTab().el.querySelectorAll('.debug-card').length") === 1, 'one card, moved along as it went');
  } catch (err) {
    console.log(`FAIL  ${err.stack || err}`);
    fails++;
  } finally {
    app.kill();
  }
  console.log(fails ? `\n${fails} failed` : '\nAll passed');
  process.exit(fails ? 1 : 0);
})();
