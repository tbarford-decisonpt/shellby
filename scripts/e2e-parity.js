// End-to-end check of the Claude Code terminal's conveniences in Shellby, against
// the dev app over CDP with the fake Claude CLI (test/fixtures/fake-claude.js):
// rewind (conversation and code), ! commands, @ file mentions, Up and Ctrl+R
// through what you've sent, the effort chip and /effort, /export, the Rules tab,
// MCP statuses, and the output style setting.
//   node scripts/e2e-parity.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9371;
const wait = ms => new Promise(r => setTimeout(r, ms));

// A small git project for the conversation to change, so each turn has a diff.
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-parity-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'start\n');
  fs.writeFileSync(path.join(dir, 'notes with space.md'), '# notes\n');
  git('add', '.');
  git('commit', '-qm', 'start');
  return dir;
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const repo = makeRepo();
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47971' },
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
    const setBox = async text => ev(`(i => { i.focus(); i.value = ${JSON.stringify(text)}; i.setSelectionRange(i.value.length, i.value.length); i.dispatchEvent(new Event('input')); })(SB.$('input'))`);
    const key = async (k, opts = {}) => ev(`SB.$('input').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ...${JSON.stringify(opts)} }))`);
    const type = async text => { await setBox(text); await key('Enter'); };
    const idle = () => until('!SB.activeTab().busy', 15000);
    const users = () => ev("JSON.stringify([...SB.activeTab().el.querySelectorAll('.msg.user')].map(e => e.textContent.trim()))").then(JSON.parse);
    const lastReply = () => ev("[...SB.activeTab().el.querySelectorAll('.msg.assistant')].at(-1)?.textContent || ''");
    const file = name => fs.readFileSync(path.join(repo, name), 'utf8').trim();

    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await ev(`shellby.setFolder(${JSON.stringify(repo)}).then(r => SB.folderChanged(r))`);
    await wait(800);

    // 1. Two turns that each change a file.
    await type('edit a.txt first');
    await idle();
    await type('edit a.txt second');
    await idle();
    check(await until("SB.activeTab().el.querySelectorAll('.changes').length === 2"), 'each turn shows what it changed');
    check(file('a.txt') === 'second', 'the file has the second turn\'s text');
    check(await ev("SB.activeTab().el.querySelectorAll('.msg.user .msg-rewind').length") === 2, 'each message has a way back');
    check(JSON.stringify(await users()) === JSON.stringify(['edit a.txt first', 'edit a.txt second']), 'the rewind button adds nothing to the message text');

    // 2. /rewind: pick the second message, take back the conversation and the code.
    await type('/rewind');
    check(await until("!SB.$('rewindMenu').hidden && SB.$('rewindMenu').querySelectorAll('.rewind-point').length === 2"), '/rewind lists your two messages');
    await ev("SB.$('rewindMenu').querySelector('.rewind-point').click()");
    check(await until("[...SB.$('rewindMenu').querySelectorAll('.menu-item')].some(b => b.textContent.includes('Conversation and code') && !b.disabled)"), 'the newest offers conversation and code');
    await ev("[...SB.$('rewindMenu').querySelectorAll('.menu-item')].find(b => b.textContent.includes('Conversation and code')).click()");
    check(await until("SB.activeTab().el.querySelectorAll('.msg.user').length === 1"), 'the conversation is cut back to the first message');
    check(file('a.txt') === 'first', `the code is back to the first turn's (${file('a.txt')})`);
    check(await ev("SB.$('input').value") === 'edit a.txt second', 'your message is back in the box');
    check(await ev("!!SB.activeTab().el.querySelector('.home-mark')?.textContent.includes('Rewound')"), 'the transcript marks the rewind');

    // 3. The next message resumes Claude Code only that far, as a fork.
    await type('args');
    await idle();
    const args = await lastReply();
    check(/--resume-session-at=uuid-/.test(args) && args.includes('--fork-session'), 'Claude Code resumes up to the kept turn, as a fork');

    // 4. Esc Esc in an empty box opens the picker too.
    await setBox('');
    await key('Escape');
    await key('Escape');
    check(await until("!SB.$('rewindMenu').hidden"), 'Esc Esc opens rewind');
    await ev('SB.closeMenus()');
    await ev("SB.$('input').focus()");

    // 5. ! runs a command yourself (asked once, in the confirm window); the output
    // goes to Claude with the next message.
    await type('!Write-Output parity-check');
    let dlgTarget = null;
    for (let i = 0; i < 40 && !dlgTarget; i++) {
      dlgTarget = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.url.endsWith('dialog.html'));
      if (!dlgTarget) await wait(250);
    }
    check(!!dlgTarget, 'the first ! command asks first');
    if (dlgTarget) {
      const dws = new WebSocket(dlgTarget.webSocketDebuggerUrl);
      await new Promise(r => { dws.onopen = r; });
      let did = 0; const dp = new Map();
      dws.onmessage = e => { const m = JSON.parse(e.data); dp.get(m.id)?.(m); };
      const dev = expr => new Promise(r => { const i = ++did; dp.set(i, m => r(m.result?.result?.value)); dws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
      for (let i = 0; i < 40 && !(await dev("document.activeElement?.tagName === 'BUTTON'")); i++) await wait(150);
      check(await dev("document.activeElement.textContent") === 'Cancel', '...with Cancel as the default');
      await dev("[...document.querySelectorAll('#actions button')].find(b => b.textContent === 'Let ! run commands').click()");
      dws.close();
    }
    check(await until("[...SB.activeTab().el.querySelectorAll('.shell-run:not(.pending) .t-result')].some(e => e.textContent.includes('parity-check'))", 20000), '! command output shows in the conversation');
    await type('hello again');
    await idle();
    check((await lastReply()).includes('<bash-input>Write-Output parity-check</bash-input>'), 'Claude got the command and its output with the next message');
    await type('!!important, not a command');
    await idle();
    check((await lastReply()).startsWith('echo: !important, not a command'), '!! sends Claude a message starting with !');
    check((await users()).at(-1) === '!important, not a command', '...and shows it with one !');

    // 6. @ mentions: fuzzy files from the project, quoted when they have spaces.
    await setBox('look at @a.t');
    check(await until("!SB.$('pickMenu').hidden && SB.$('pickMenu').textContent.includes('a.txt')"), '@ lists matching files');
    await key('Tab');
    check(await ev("SB.$('input').value") === 'look at @a.txt ', 'Tab puts the mention in');
    await setBox('@notes');
    await until("!SB.$('pickMenu').hidden");
    await key('Enter');
    check(await ev("SB.$('input').value") === '@"notes with space.md" ', 'a path with spaces is quoted');

    // 7. Up and Ctrl+R through what you've sent.
    await setBox('');
    await key('ArrowUp');
    check(await ev("SB.$('input').value") === '!!important, not a command', 'Up brings back the last thing you sent, as you typed it');
    await key('ArrowUp');
    check(await ev("SB.$('input').value") === 'hello again', '...and Up again the one before');
    await key('ArrowDown');
    await key('ArrowDown');
    check(await ev("SB.$('input').value") === '', 'Down past the newest gives you your draft back');
    await key('r', { ctrlKey: true });
    await setBox('first');
    check(await until("!SB.$('pickMenu').hidden && SB.$('pickMenu').textContent.includes('edit a.txt first')"), 'Ctrl+R searches what you sent');
    await key('Enter');
    check(await ev("SB.$('input').value") === 'edit a.txt first', 'Enter puts the match in the box');
    await setBox('');

    // 8. Effort: the chip and /effort, told to the running conversation.
    await ev("SB.$('effortChip').click()");
    check(await until("!SB.$('effortMenu').hidden"), 'the effort chip opens its menu');
    await ev("[...SB.$('effortMenu').querySelectorAll('.menu-item')].find(b => b.textContent.startsWith('High')).click()");
    check(await until("SB.state.settings.effort === 'high' && SB.$('effortLabel').textContent === 'high'"), 'picking High saves it and shows it');
    await type('effort');
    await idle();
    check((await lastReply()).includes('effort:high'), 'the running conversation thinks at the new effort');
    await type('/effort low');
    check(await until("SB.state.settings.effort === 'low'"), '/effort low works too');

    // 9. /export, the Rules tab, MCP statuses, output styles.
    check((await ev(`shellby.exportSession(SB.activeTab().id, 'clipboard')`))?.ok === true, '/export clipboard exports the conversation');
    await ev("SB.showToolbox('rule')");
    check(await until("!!document.querySelector('#setupPane .rule-form')"), 'Toolbox → Rules shows the rule form');
    await ev(`(async () => { const r = await shellby.saveRule('user', 'ask', 'Bash(git push:*)'); SB.state.setup = r.setup; SB.views.toolbox.render(); })()`);
    check(await until("[...document.querySelectorAll('.rule-row code')].some(c => c.textContent === 'Bash(git push:*)')"), 'a new ask rule is listed');
    await ev("SB.showToolbox('mcp')");
    check(await until("!!document.querySelector('#setupPane .mcp-bar')"), 'Toolbox → MCP has Add server and Refresh');
    check((await ev('shellby.refreshMcp(SB.state.activeTab)'))?.ok === true, 'statuses come from the running conversation');
    await ev('shellby.getToolbox().then(t => { SB.state.toolbox = t; SB.views.toolbox.render(); })');
    check(await until("[...document.querySelectorAll('#toolList .tool-row')].some(r => r.textContent.includes('broken') && r.textContent.includes('Reconnect'))"), 'a failed server offers Reconnect');
    await ev("SB.showSetting('styleSelect')");
    check(await until("[...SB.$('styleSelect').options].some(o => o.value === 'Explanatory')"), 'output styles are listed in Settings');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* still in use */ }
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
