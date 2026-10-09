// ci: what Claude Code does by itself: its to-dos, background commands, plans, skills, memories, effort, helpers messaging, cloud routines
// End-to-end check of what Claude Code does by itself, made visible, against
// the dev app over CDP with the fake CLI (test/fixtures/fake-claude.js plays
// Claude Code 2.1.293's shapes) and a throwaway Claude config folder:
//   1. its to-do list above the box, ticking over, gone once it's all done
//   2. a command left running: the tray, its output, Stop, and the crab's badge
//   3. a plan: a note on one line sent back whole, then approved; the crab's "plan?"
//   4. Claude switching itself to planning
//   5. a skill's first use, and what it's for
//   6. a memory written down, listed in Toolbox → Memory, then forgotten
//   7. the effort and thinking beside a turn's cost
//   8. a helper sent another message: the lane picks up again, and on the desktop it says so
//   9. cloud routines on the Routines page, asked of (fake) Claude Code
//   node scripts/e2e-native.js [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const PORT = 9394;
const HOOK = 47964;
const OUT = process.argv[2] || null;
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  // Celebrations (a first trophy) would cover what the shot is of.
  const shot = async name => { if (!OUT) return; await ev('SB.clearCelebrations?.()'); await savePng(send, path.join(OUT, `${name}.png`)); };
  return { ev, shot };
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-native-'));
  // Claude Code's own folder, for its memories: under temp, so the fake CLI writes into it.
  const config = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-native-cfg-')));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...process.env, SHELLBY_E2E: '1', SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'),
      SHELLBY_HOOK_PORT: String(HOOK), CLAUDE_CONFIG_DIR: config, SHELLBY_FAKE_TODO_MS: '900', SHELLBY_FAKE_TEAM_MS: '2500',
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
    const until = async (c, expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.ev(expr)) return true; await wait(120); } return false; };
    const ev = panel.ev;
    const idle = () => until(panel, '!SB.activeTab().busy', 10000);
    const lastReply = () => ev("[...SB.activeTab().el.querySelectorAll('.msg.assistant')].pop()?.textContent || ''");
    const fresh = async () => { await ev('SB.newTab({ reuse: false })'); await wait(400); };

    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");

    // ---- 1. its to-do list
    await ev("SB.send('todos')");
    check(await until(panel, "!document.getElementById('todos').hidden"), 'the to-do list shows above the box as Claude makes it');
    check(await until(panel, "/1 of 3 done/.test(document.getElementById('todos').textContent)", 6000), 'it ticks over: 1 of 3 done');
    const strip = await ev("document.getElementById('todos').textContent");
    check(/Fixing the parser/.test(strip), `what Claude is doing now, worded as it does it (${strip.slice(0, 80)})`);
    check(await ev("document.getElementById('statusText').textContent") === 'Fixing the parser…', 'and the Working bar says it too');
    check(await ev("[...document.querySelectorAll('#todos .todo')].map(li => li.className.replace('todo ', '')).join() === 'completed,in_progress,pending'"), 'each to-do marked done, now or to do');
    check(await ev("[...SB.activeTab().el.querySelectorAll('.tool.quiet-tool')].length >= 5"), 'its to-do calls step back in the feed');
    await panel.shot('1-todos');
    await idle();
    await ev("document.querySelector('#todos .todo-head').click()");
    check(await ev("!document.querySelector('#todos .todo-list') && !/null/.test(document.getElementById('todos').textContent)"), 'the list folds to one line');
    await ev("SB.send('todos done')");
    await idle();
    check(await until(panel, "document.getElementById('todos').hidden"), 'all done and idle: the strip goes');

    // ---- 2. a command left running
    await fresh();
    await ev("SB.send('bg 0')");
    check(await until(panel, "!document.getElementById('jobs').hidden"), 'the background tray shows what it left running');
    check(await until(panel, "/Run the build in the background/.test(document.getElementById('jobs').textContent) && /Running in the background \\(1\\)/.test(document.getElementById('jobs').textContent)"), 'with its name and the count');
    check(await until(critter, "!document.getElementById('bgBadge').hidden && document.getElementById('bgBadge').textContent === '1'"), "the crab wears the badge for it, though he's idle");
    check(await ev("!SB.activeTab().el.querySelector('.lane')"), 'no helper lane for a build');
    check(await until(critter, "document.querySelectorAll('#crew .helper:not(.visitor)').length === 0", 2000), 'and no helper crab on the desktop');
    await until(panel, "[...document.querySelectorAll('#jobs button')].some(b => b.textContent === 'Output')");
    await ev("[...document.querySelectorAll('#jobs button')].find(b => b.textContent === 'Output').click()");
    check(await until(panel, "/starting/.test(document.querySelector('#jobs .job-out')?.textContent || '')"), 'Output shows what it printed');
    check(await until(panel, "/line \\d+/.test(document.querySelector('#jobs .job-out')?.textContent || '')", 5000), 'and keeps up while it runs');
    await panel.shot('2-jobs');
    await ev("[...document.querySelectorAll('#jobs button')].find(b => b.textContent === 'Stop').click()");
    check(await until(panel, "document.querySelector('#jobs .job')?.classList.contains('stopped')"), 'Stop asks Claude Code to stop it, and it says stopped');
    check(await until(critter, "document.getElementById('bgBadge').hidden"), 'the badge goes with it');
    await ev("SB.send('bg 700')");
    check(await until(panel, "document.querySelector('#jobs .job.done')", 6000), 'one that finishes by itself says done');
    await ev("SB.send('bg 500 fail')");
    check(await until(panel, "document.querySelector('#jobs .job.failed')", 6000), 'one that exits non-zero says failed');
    await ev("SB.send('bg 300')");
    check(await until(panel, "!document.querySelector('#jobs .job') && /4 finished/.test(document.querySelector('#jobs .job-fold')?.textContent || '')", 6000), 'past three finished, they fold into one line');
    await ev("document.querySelector('#jobs .job-fold').click()");
    check(await until(panel, "document.querySelectorAll('#jobs .job').length === 4"), 'which opens them all');

    // ---- 3. a plan
    await fresh();
    await ev("SB.send('plan')");
    const card = "[...SB.activeTab().el.querySelectorAll('.plan-card')].pop()";
    check(await until(panel, `!!${card}`), 'the plan gets a card of its own');
    const planSaid = await until(critter, "document.body.classList.contains('plan-ready') && document.getElementById('bubbleText').textContent === 'plan?'");
    check(planSaid, `the crab says there is a plan to read${planSaid ? '' : ` (${JSON.stringify(await critter.ev("({ body: document.body.className, bubble: document.getElementById('bubbleText').textContent })"))})`}`);
    await ev(`[...${card}.querySelectorAll('li.plan-line')].find(l => /cache/.test(l.textContent)).querySelector('.plan-line-note').click()`);
    check(await ev("document.activeElement?.classList.contains('plan-note-box')"), "💬 opens a note on that line, ready to type");
    await ev("(() => { const b = document.activeElement; b.value = 'Skip the cache, it is fast enough.'; b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()");
    check(await ev(`${card}.querySelectorAll('.plan-note').length === 1 && !!${card}.querySelector('li.plan-line.noted')`), 'the note is kept, and the line marked');
    check(await ev(`[...${card}.querySelectorAll('button')].some(b => b.textContent === 'Send 1 note')`), 'Send 1 note');
    await panel.shot('3-plan');
    await ev(`[...${card}.querySelectorAll('button')].find(b => b.textContent === 'Send 1 note').click()`);
    await idle();
    const sent = await lastReply();
    check(/^PLAN SENT BACK: The user read your plan/.test(sent) && /> Add a cache in front of it/.test(sent) && /Skip the cache, it is fast enough\./.test(sent), 'Claude gets the line and the note');
    check(/Sent back with 1 note/.test(await ev(`${card}.textContent`)), 'the card says it went back');
    await ev("SB.send('plan')");
    await until(panel, `!${card}.classList.contains('decided')`);
    await ev(`${card}.querySelector('.btn.allow').click()`);
    await idle();
    check((await lastReply()) === 'PLAN APPROVED', 'Approve plan approves it');
    check(/Plan approved/.test(await ev(`${card}.textContent`)), 'and the card says so');

    // ---- 4. switching itself to planning
    await ev("SB.send('enterplan')");
    await idle();
    check(await ev("!!SB.activeTab().el.querySelector('.plan-mark')"), 'Claude switching to planning is said in the feed');

    // ---- 5. a skill
    await fresh();
    await ev("SB.send('skill code-review')");
    await idle();
    check(await ev("!!SB.activeTab().el.querySelector('.tool.skill-use .skill-why')"), 'a skill Claude reached for says what it is for');
    check(await until(panel, "!!SB.activeTab().el.querySelector('.tool.skill-use .first-badge')", 4000), 'the first time, it says so');
    await ev("SB.send('skill code-review')");
    await idle();
    check(await ev("SB.activeTab().el.querySelectorAll('.first-badge').length === 1"), 'only the first time');

    // ---- 6. a memory
    await ev("SB.send('remember use pnpm here, never npm')");
    await idle();
    check(await ev("[...SB.activeTab().el.querySelectorAll('.tool.memory-write .t-label')].some(l => l.textContent === 'Remembered')"), 'a memory written down reads "Remembered"');
    await ev("[...SB.activeTab().el.querySelectorAll('.memory-why .link-btn')].pop().click()");
    check(await until(panel, "/use pnpm here, never npm/.test(document.getElementById('autoMemory')?.textContent || '')"), 'Toolbox → Memory lists what Claude remembers');
    check(await ev("/How you like it done/.test(document.getElementById('autoMemory').textContent)"), 'grouped by its kind');
    check(!(await ev("/null/.test(document.getElementById('autoMemory').textContent)")), 'and nothing reads "null" where a kind has none');
    await panel.shot('6-memory');
    await ev("[...document.querySelectorAll('#autoMemory button')].find(b => b.textContent === 'Forget').click()");
    check(await until(panel, "[...document.querySelectorAll('#autoMemory button')].some(b => b.textContent === 'Forget it?')"), 'Forget asks once more');
    await ev("[...document.querySelectorAll('#autoMemory button')].find(b => b.textContent === 'Forget it?').click()");
    check(await until(panel, "document.getElementById('autoMemory') && !document.querySelector('#autoMemory .am-item')"), 'and it is gone');
    const memDir = path.join(config, 'projects');
    const left = fs.readdirSync(memDir, { recursive: true }).map(String);
    check(!left.some(f => f.endsWith('use-pnpm.md')), "gone from Claude Code's folder too");
    await ev("SB.setView('chat')");

    // ---- 7. effort and thinking
    await fresh();
    await ev("SB.send('think')");
    await idle();
    check(await until(panel, "/2\\.1k thinking/.test([...SB.activeTab().el.querySelectorAll('.effort-badge')].pop()?.textContent || '')", 3000), 'the turn says how much it thought, beside what it cost');

    // ---- 8. a helper messaged again
    await fresh();
    await ev("SB.send('team')");
    check(await until(panel, "/@scout/.test(SB.activeTab().el.querySelector('.lane')?.textContent || '')"), "the helper's lane carries the name others write to it by");
    check(await until(panel, "!!SB.activeTab().el.querySelector('.agent-msg')", 6000), 'Claude writing to it shows as a message');
    check(/Claude → @scout/.test(await ev("SB.activeTab().el.querySelector('.agent-msg').textContent")), 'from Claude to @scout');
    check(await until(critter, "/📨 Count the tests/.test(document.querySelector('#crew .helper.talking .tag')?.textContent || '')", 4000), 'on the desktop, the helper shows what it was told');
    await critter.shot('8-team-crab');
    await idle();
    check(await until(panel, "SB.activeTab().el.querySelector('.lane').querySelectorAll('.lane-summary:not([hidden])').length === 2", 6000), 'one lane, both of its answers');
    check(await ev("SB.activeTab().el.querySelectorAll('.lane').length === 1"), 'still one lane');
    // What the helper spent: split out on the turn's cost line, and on its own lane.
    check(await until(panel, "/\\(helpers 5k\\)/.test([...SB.activeTab().el.querySelectorAll('.turn-cost-line')].at(-1)?.textContent || '')", 4000), "the turn's cost says what its helper spent");
    const laneCost = await ev("(m => [m.textContent, m.title])(SB.activeTab().el.querySelector('.lane .lane-meta'))");
    check(/5\.0k tok/.test(laneCost[0]) && /This helper sent and wrote 5\.0k new tokens/.test(laneCost[1]), `and so does its lane (${laneCost[0]})`);

    // ---- 9. cloud routines
    await ev("SB.setView('routines')");
    check(await until(panel, "/Show my cloud routines/.test(document.getElementById('cloudActions').textContent)"), "In Claude's cloud waits to be asked");
    await ev("[...document.querySelectorAll('#cloudActions button')].find(b => /Show my cloud routines/.test(b.textContent)).click()");
    check(await until(panel, "/Morning issue sweep/.test(document.getElementById('cloudList').textContent)", 10000), 'the routines Claude Code keeps are listed');
    const cloudText = await ev("document.getElementById('cloudList').textContent");
    check(/weekdays at 08:00 UTC/.test(cloudText) && /paused/.test(cloudText), 'when each runs, in words, and which are paused');
    await ev("[...document.querySelectorAll('#cloudList button')].find(b => b.textContent === 'Runs').click()");
    check(await until(panel, "/completed/.test(document.querySelector('#cloudList .cr-runs')?.textContent || '')", 10000), "a routine's recent runs");
    await ev("document.getElementById('cloudRoutines').scrollIntoView()");
    check(!(await ev("/null/.test(document.getElementById('cloudRoutines').textContent)")), 'nothing reads "null"');
    await panel.shot('9-cloud');
  } catch (e) {
    check(false, e.stack || e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
