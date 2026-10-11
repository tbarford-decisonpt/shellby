// ci: Claude Code features passed through: streaming replies, next prompt, /goal, helpers' words, safe mode, fallback, Chrome, agents
// End-to-end check of the Claude Code features Shellby passes through, against
// the dev app over CDP with the fake CLI (test/fixtures/fake-claude.js):
//   1. a reply shows as it's written, then the finished one takes its place
//   2. what you might ask next shows by the box; Tab puts it in, unsent
//   3. /goal pins the goal above the box; its × clears it
//   4. a helper's words go in its crab's bubble on the desktop
//   5. safe mode from the tab: the 🛟, the note, and --safe-mode on the next start
//   6. Settings' fallback model and Chrome reach a new conversation, and its name goes too
//   7. Toolbox → Chat as: a conversation one of your agents runs
//   node scripts/e2e-cli-features.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const PORT = 9397;
const HOOK = 47967;
const OUT = process.argv[2] || null;
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  const shot = async name => { if (!OUT) return; await ev('SB.clearCelebrations?.()'); await savePng(send, path.join(OUT, `${name}.png`)); };
  return { ev, shot };
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-clifeat-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ tideEvents: false }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...process.env, SHELLBY_E2E: '1', SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'),
      SHELLBY_HOOK_PORT: String(HOOK), SHELLBY_FAKE_AGENTS: 'general-purpose,reviewer', SHELLBY_FAKE_SAY_MS: '2500',
    },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !(list.some(t => t.url.endsWith('panel.html')) && list.some(t => t.url.endsWith('critter.html'))); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    const critter = await connect(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl);
    const until = async (c, expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.ev(expr)) return true; await wait(60); } return false; };
    const ev = panel.ev;
    const idle = () => until(panel, '!SB.activeTab().busy', 10000);
    const lastReply = () => ev("[...SB.activeTab().el.querySelectorAll('.msg.assistant:not(.sub)')].pop()?.textContent || ''");
    const fresh = async () => { await ev('SB.newTab({ reuse: false })'); await wait(400); };
    const argsOf = async () => { await ev("SB.send('args')"); await idle(); try { return JSON.parse(await lastReply()); } catch { return []; } };

    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");

    // ---- 1. the reply as it's written
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    await ev(`SB.send(${JSON.stringify(`stream ${words}`)})`);
    check(await until(panel, "!!SB.activeTab().el.querySelector('.msg.assistant.live')", 5000), 'the reply shows while Claude is still writing it');
    const midway = await ev("SB.activeTab().el.querySelector('.msg.assistant.live')?.textContent || ''");
    check(midway.startsWith('word0') && midway.length < words.length, `part of it, not yet all (${midway.length} of ${words.length} characters)`);
    check(await until(panel, "document.getElementById('statusText').textContent === 'Writing…'", 2000), 'the Working bar says Claude is writing');
    await panel.shot('1-streaming');
    await idle();
    check(await ev("!SB.activeTab().el.querySelector('.msg.assistant.live')"), 'once it is done, the words written so far give way');
    check(await lastReply() === words, 'to the finished reply, whole and once');
    check(await ev("SB.activeTab().el.querySelectorAll('.msg.assistant').length === 1"), 'one reply in the feed, not two');

    // ---- 2. what you might ask next
    check(await until(panel, "!document.getElementById('nextPrompt').hidden && /Now add a test for it/.test(document.getElementById('nextPrompt').textContent)", 4000), 'what you might ask next shows by the box');
    await panel.shot('2-next');
    await ev("document.getElementById('input').focus(); document.getElementById('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))");
    check(await ev("document.getElementById('input').value === 'Now add a test for it'"), 'Tab puts it in the box');
    check(await ev("document.getElementById('nextPrompt').hidden && !SB.activeTab().busy"), 'and nothing was sent');
    await ev("document.getElementById('input').value = ''; SB.autosize()");

    // ---- 3. /goal
    await fresh();
    await ev("SB.send('/goal the tests pass')");
    await idle();
    check(await until(panel, "!document.getElementById('goalPin').hidden && /the tests pass/.test(document.getElementById('goalPin').textContent)"), 'the goal is pinned above the box');
    await panel.shot('3-goal');
    await ev("document.querySelector('#goalPin .goal-clear').click()");
    await idle();
    check(await until(panel, "document.getElementById('goalPin').hidden"), 'its × clears it (/goal clear)');

    // ---- 4. a helper's words
    await fresh();
    await ev("SB.send('helper says Found the bug in auth.js')");
    check(await until(critter, "/💬 Found the bug in auth\\.js/.test(document.querySelector('#crew .helper.talking .tag')?.textContent || '')", 5000), "the helper's crab says what it wrote");
    await critter.shot('4-helper-says');
    check(await until(panel, "/Found the bug in auth\\.js/.test(SB.activeTab().el.querySelector('.lane')?.textContent || '')"), 'and its lane shows it');
    await idle();

    // ---- 5. safe mode
    await fresh();
    await argsOf(); // a conversation to restart
    await ev('SB.setSafeMode(SB.state.activeTab, true)');
    check(await until(panel, "!!document.querySelector('.tab.active .tab-safe')"), 'the tab wears a 🛟');
    check(await until(panel, "/Safe mode:/.test(SB.activeTab().el.textContent)"), 'the conversation says what safe mode leaves out');
    check((await argsOf()).includes('--safe-mode'), 'the next start is in safe mode');
    await panel.shot('5-safe');
    await ev('SB.setSafeMode(SB.state.activeTab, false)');
    check(await until(panel, "!document.querySelector('.tab.active .tab-safe')"), 'turned off, the 🛟 goes');
    check(!(await argsOf()).includes('--safe-mode'), 'and so does --safe-mode');

    // ---- 6. Settings, and the conversation's name
    await ev("shellby.setSettings({ fallbackModel: 'sonnet', claudeInChrome: true }).then(r => { SB.state.settings = r.settings; })");
    await fresh();
    const a = await argsOf();
    check(a[a.indexOf('--fallback-model') + 1] === 'sonnet', 'the fallback model reaches a new conversation');
    check(a.includes('--chrome'), 'and so does Claude in Chrome');
    check(a[a.indexOf('--name') + 1] === 'args', `its title is its name in Claude Code (${a[a.indexOf('--name') + 1]})`);
    check(a.includes('--include-partial-messages') && a.includes('--forward-subagent-text'), 'replies stream and helpers speak');

    // ---- 7. Chat as an agent
    await ev("SB.newTabAs('reviewer')");
    check(await until(panel, "/reviewer/.test(SB.activeTab().el.textContent) && /agent runs this conversation/.test(SB.activeTab().el.textContent)"), 'a new conversation says which agent runs it');
    const b = await argsOf();
    check(b[b.indexOf('--agent') + 1] === 'reviewer', 'and starts with --agent');
    const nope = await ev("shellby.newTab({ agent: 'nobody-here' })");
    check(nope?.ok === false && /doesn't list an agent/.test(nope.error || ''), "an agent Claude Code doesn't have is refused");
  } catch (e) {
    check(false, e.stack || e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
