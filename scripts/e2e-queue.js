// End-to-end check of queued messages against the dev app over CDP, driven by
// the fake Claude CLI (test/fixtures/fake-claude.js): no account, no usage.
// Type while Shellby works -> messages queue -> they send one by one when each
// turn ends. Stop hands the queue back; an error pauses it.
//   node scripts/e2e-queue.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9350;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47996' },
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
    const ev = expr => new Promise(r => { const i = ++id; p.set(i, m => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
    const until = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
    const type = async text => ev(`(i => { i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(SB.$('input'))`);
    const users = () => ev("JSON.stringify([...SB.activeTab().el.querySelectorAll('.msg.user')].map(e => e.textContent.trim()))").then(JSON.parse);
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await wait(500);

    // 1. Queue two messages behind a slow turn.
    await type('wait 2500 first');
    check(await until('SB.activeTab().busy'), 'first message is running');
    check(await ev("!document.getElementById('sendBtn').disabled"), 'send button stays usable while busy');
    check(/queue/i.test(await ev("document.getElementById('sendHint').textContent")), `hint says Enter queues ("${await ev("document.getElementById('sendHint').textContent")}")`);
    await type('wait 300 second');
    await type('wait 300 third');
    check(await ev('SB.activeTab().queue.length') === 2, 'two messages queued');
    check(await ev("document.querySelectorAll('#queued .queue-item').length") === 2, 'two queue chips shown');
    check(/2 queued/.test(await ev("document.getElementById('statusText').textContent")), 'status shows "2 queued"');
    check(await ev("SB.$('input').value") === '', 'the box is cleared after queueing');

    // 2. Up arrow pulls the last one back for editing; Enter re-queues it.
    await ev("SB.$('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))");
    check(await ev("SB.$('input').value") === 'wait 300 third', 'Up arrow pulls back the last queued message');
    check(await ev('SB.activeTab().queue.length') === 1, '...and takes it out of the queue');
    await type('wait 300 third (edited)');
    check(await ev('SB.activeTab().queue.length') === 2, 'edited message re-queued');

    // 3. They drain in order, one turn at a time.
    check(await until("!SB.activeTab().busy && SB.activeTab().queue.length === 0 && document.querySelectorAll('.msg.user').length === 3", 15000), 'queue drained after the first turn');
    const sent = await users();
    check(JSON.stringify(sent) === JSON.stringify(['wait 2500 first', 'wait 300 second', 'wait 300 third (edited)']), `sent in order: ${sent.join(' | ')}`);
    check(await ev("document.getElementById('queued').hidden"), 'queue chips gone');

    // 4. Stop hands the queue back instead of firing it.
    await type('slow job');
    await until('SB.activeTab().busy');
    await type('after stop');
    await ev("document.getElementById('stopBtn').click()");
    check(await until('!SB.activeTab().busy'), 'Stop ends the turn');
    await wait(500);
    check(await ev("SB.$('input').value") === 'after stop', 'queued message is back in the box');
    check(await ev('SB.activeTab().queue.length') === 0, 'nothing was sent automatically');

    // 5. An error pauses the queue until you say so.
    await ev("SB.$('input').value = ''");
    await type('fail 1500');
    await until('SB.activeTab().busy');
    await type('wait 100 after error');
    check(await until("!SB.activeTab().busy && SB.activeTab().queuePaused"), 'error pauses the queue');
    check(await ev("!!document.querySelector('#queued .queue-paused')"), 'paused notice with a "Send next now" button');
    await ev("document.querySelector('#queued .queue-paused button').click()");
    check(await until("SB.activeTab().queue.length === 0 && [...document.querySelectorAll('.msg.user')].some(e => e.textContent.includes('after error'))"), '"Send next now" sends it');

    // 6. Steering: queued while a tool runs, it goes in at Claude's next step,
    // in the same turn, like Claude Code. A /command waits for the turn to end.
    await until('!SB.activeTab().busy');
    await type('steps 6 500');
    await until('SB.activeTab().busy');
    await type('use tabs');
    await type('/compact');
    check(await ev('SB.activeTab().queue.length') === 2, 'both queued, as chips');
    check(await until("[...document.querySelectorAll('.msg.assistant')].some(e => e.textContent.includes('steered: use tabs'))"), 'Claude read it in the same turn');
    check(await until("!SB.activeTab().busy && SB.activeTab().queue.length === 0"), 'the /command waited, and went once the turn ended');
    // The feed from the prompt on: the steer sits inside the turn (no "done" line
    // before it), right after the step it went in at, with Claude's reply next.
    const turn = JSON.parse(await ev(`JSON.stringify((els => els.slice(els.findIndex(e => e.textContent.trim() === 'steps 6 500')))([...SB.activeTab().el.querySelectorAll('.msg.user, .msg.assistant, .meta, details.tool')]).map(e => e.matches('.meta') ? 'meta' : e.matches('details.tool') ? 'tool' : e.textContent.trim()))`));
    check(JSON.stringify(turn.slice(0, 4)) === JSON.stringify(['steps 6 500', 'tool', 'use tabs', 'steered: use tabs']) && turn[4] === 'meta', `the steer went in mid-turn: ${turn.slice(0, 5).join(' | ')}`);
    const tail = (await users()).slice(-3);
    check(JSON.stringify(tail) === JSON.stringify(['steps 6 500', 'use tabs', '/compact']), `in order: ${tail.join(' | ')}`);
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
