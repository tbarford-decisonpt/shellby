// End-to-end check of Claude's multiple-choice questions (AskUserQuestion)
// against the dev app over CDP with the fake CLI: a proper question card (no
// JSON), number keys, multi-select + your own words, Skip, and what Claude
// actually receives back.
//   node scripts/e2e-questions.js [screenshot.png]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9355;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47991' },
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
    const lastReply = () => ev("[...SB.activeTab().el.querySelectorAll('.msg.assistant')].pop()?.textContent || ''");
    const card = "[...SB.activeTab().el.querySelectorAll('.ask.question')].pop()";
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");

    // 1. One question: a real card, number keys answer it.
    await ev("SB.send('ask')");
    check(await until(`!!${card}`), 'a question card appears');
    const text = await ev(`${card}.textContent`);
    check(!/[{}]|"question"|"options"/.test(text), 'no JSON in the card');
    check(/Quick question/.test(text) && /Which color do you like\?/.test(text) && /Calm, like the sea/.test(text), 'question, options and descriptions shown');
    check(await ev("document.getElementById('statusText').textContent") === 'Waiting for your answer…', 'status says it is waiting for your answer');
    if (process.argv[2]) fs.writeFileSync(process.argv[2], Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    check(await ev("document.activeElement?.classList.contains('qa-opt')"), 'the first option has focus, so number keys work');
    await ev("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }))");
    check(await until("!SB.activeTab().busy"), 'pressing 2 answers it');
    check((await lastReply()) === 'answers: {"Which color do you like?":"Blue"}', `Claude got "Blue" (${await lastReply()})`);
    check(/→ Blue/.test(await ev(`${card}.textContent`)), 'the card shows the answer');

    // 2. Two questions: pick one, multi-select two, add your own words, Send.
    await ev("SB.send('ask2')");
    await until(`${card} && !${card}.classList.contains('decided')`);
    check(/I have 2 quick questions/.test(await ev(`${card}.textContent`)), 'two questions in one card');
    check(await ev(`${card}.querySelector('.btn.allow').disabled`), 'Send waits until every question is answered');
    await ev(`(() => { const c = ${card}; const btn = l => [...c.querySelectorAll('.qa-opt')].find(b => b.dataset.label === l).click();
      btn('Red'); btn('Chips'); btn('Nuts'); btn('Chips'); btn('Fruit');
      const other = c.querySelectorAll('.qa-other')[1]; other.value = 'also cheese'; other.dispatchEvent(new Event('input')); })()`);
    check(!(await ev(`${card}.querySelector('.btn.allow').disabled`)), 'Send enabled once both are answered');
    await ev(`${card}.querySelector('.btn.allow').click()`);
    await until('!SB.activeTab().busy');
    check((await lastReply()) === 'answers: {"Which color do you like?":"Red","Which snacks?":"Nuts, Fruit, also cheese"}', `multi-select + own words reach Claude (${await lastReply()})`);

    // 3. Skip.
    await ev("SB.send('ask')");
    await until(`${card} && !${card}.classList.contains('decided')`);
    await ev(`[...${card}.querySelectorAll('button')].find(b => b.textContent === 'Skip').click()`);
    await until('!SB.activeTab().busy');
    check(/^skipped: The user skipped the question/.test(await lastReply()), 'Skip tells Claude you skipped');
    check(/→ Skipped/.test(await ev(`${card}.textContent`)), 'the card says Skipped');
    check(await ev("[...SB.activeTab().el.querySelectorAll('.tool .t-detail')].every(e => !e.textContent.includes('{'))"), 'the activity line reads "Asked you: …", not JSON');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
