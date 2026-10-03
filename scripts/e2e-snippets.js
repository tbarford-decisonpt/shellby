// End-to-end check of prompt snippets against the dev app over CDP, driven by
// the fake Claude CLI (test/fixtures/fake-claude.js), which echoes what it's
// sent. Toolbox -> Snippets lists the starters and saves a new one; /name in the
// box sends the prompt it stands for; a pinned snippet is a chip on the start
// screen; /snippets save keeps the last message; and `shellby do @name` reaches
// the same snippets over /v1/cli (posted here directly, with a seeded token).
//   node scripts/e2e-snippets.js [screenshot.png]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9353;
const HOOK_PORT = 47997;
const TOKEN = 'e2e-snippets-token';
const wait = ms => new Promise(r => setTimeout(r, ms));

async function cli(body) {
  const res = await fetch(`http://127.0.0.1:${HOOK_PORT}/v1/cli`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shellby': '1', 'X-Shellby-Token': TOKEN }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  // The command switched on, without installing it anywhere: its token is all /v1/cli checks.
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ onboarded: true, cli: { installed: true } }));
  fs.writeFileSync(path.join(profile, 'cli-token'), TOKEN);
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: String(HOOK_PORT) },
  });
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
    const call = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => (await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
    const until = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
    const type = text => ev(`(i => { i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); })(SB.$('input'))`);
    const enter = () => ev("SB.$('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
    const replies = () => ev("JSON.stringify([...SB.activeTab().el.querySelectorAll('.msg.assistant')].map(e => e.textContent.trim()))").then(JSON.parse);
    await wait(3000);

    // 1. The Toolbox tab, with the starters.
    await ev("SB.showToolbox('snippet')");
    check(await until("document.querySelectorAll('#toolList .snippet-row').length === 5"), 'Toolbox -> Snippets lists the five starters');
    check(await ev("document.querySelector('#toolTabs [data-kind=\"snippet\"] .n').textContent") === '5', 'the tab counts them');
    check(/instead of the \/review command/.test(await ev("document.querySelector('#toolList .snippet-row .snip-note')?.textContent || ''")), "/review says it stands in for Claude Code's own");

    // 2. A new one, through the form.
    await ev("[...document.querySelectorAll('#setupPane button')].find(b => b.textContent === 'New snippet').click()");
    await ev(`(() => {
      const f = document.querySelector('#setupPane form');
      const name = f.querySelector('input'), text = f.querySelector('textarea');
      name.value = 'Lint'; name.dispatchEvent(new Event('input'));
      text.value = 'Fix the lint in $ARGUMENTS'; text.dispatchEvent(new Event('input'));
      f.requestSubmit();
    })()`);
    check(await until("SB.state.snippets.some(s => s.name === 'lint' && s.needsInput)"), 'the form saves "Lint" as /lint, needing input');
    check(await until("document.querySelectorAll('#toolList .snippet-row').length === 6"), 'and it is listed');
    // A clash is refused and said so in the form.
    await ev("[...document.querySelectorAll('#setupPane button')].find(b => b.textContent === 'New snippet').click()");
    await ev(`(() => {
      const f = document.querySelector('#setupPane form');
      f.querySelector('input').value = 'export'; f.querySelector('input').dispatchEvent(new Event('input'));
      f.querySelector('textarea').value = 'x'; f.querySelector('textarea').dispatchEvent(new Event('input'));
      f.requestSubmit();
    })()`);
    check(await until("/Shellby's own commands/.test(document.querySelector('#setupPane .setup-status').textContent)"), '/export is refused: it is one of Shellby\'s own');

    const out = process.argv[2] || path.join(os.tmpdir(), 'shellby-snippets.png');
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    if (shot?.data) { fs.writeFileSync(out, Buffer.from(shot.data, 'base64')); console.log(`screenshot: ${out}`); }

    // 3. The slash menu offers them.
    await ev("SB.setView('chat')");
    await type('/rev');
    check(await until("[...document.querySelectorAll('#slashMenu .slash-item')].some(b => /\\/review/.test(b.textContent) && b.querySelector('.k-snippet'))"), 'typing /rev offers the review snippet');
    const menuShot = await call('Page.captureScreenshot', { format: 'png' });
    if (menuShot?.data) fs.writeFileSync(out.replace(/\.png$/, '-menu.png'), Buffer.from(menuShot.data, 'base64'));
    await ev("SB.hideSlash()");

    // 4. /review sends what it stands for.
    await type('/review just the auth bits');
    await enter();
    check(await until("[...SB.activeTab().el.querySelectorAll('.msg.assistant')].some(e => /echo: Review my uncommitted changes/.test(e.textContent))", 15000), 'Claude gets the review prompt, not "/review"');
    check((await replies()).some(r => /just the auth bits/.test(r)), 'with the extra words on the end');
    await until('!SB.activeTab().busy');

    // 5. One that needs input says so and keeps your text.
    await type('/lint');
    await enter();
    await wait(400);
    check(await ev("SB.$('input').value") === '/lint', '/lint with nothing after it stays in the box');
    check(/\/lint needs something after it/.test(await ev("document.getElementById('toast').textContent")), '...with a toast saying what it needs');
    await type('/lint src/app.js');
    await enter();
    check(await until("[...SB.activeTab().el.querySelectorAll('.msg.assistant')].some(e => /echo: Fix the lint in src\\/app\\.js/.test(e.textContent))", 15000), '/lint src/app.js fills in $ARGUMENTS');
    await until('!SB.activeTab().busy');

    // 6. /snippets save keeps the last thing you sent.
    await type('find dead code in the renderer');
    await enter();
    await until("[...SB.activeTab().el.querySelectorAll('.msg.assistant')].some(e => /echo: find dead code/.test(e.textContent))", 15000);
    await until('!SB.activeTab().busy');
    await type('/snippets save dead');
    await enter();
    check(await until("SB.state.snippets.some(s => s.name === 'dead' && s.text === 'find dead code in the renderer')"), '/snippets save dead keeps the last message');

    // 7. Pinned, it's a chip on the start screen, and the chip runs it.
    await ev("SB.showToolbox('snippet')");
    await until("document.querySelector('#toolList .snippet-row')");
    await ev("[...document.querySelectorAll('#toolList .snippet-row')].find(r => r.querySelector('code').textContent === '/dead').querySelector('.pin').click()");
    check(await until("SB.state.pinned.some(p => p.kind === 'snippet' && p.name === 'dead')"), 'a snippet pins');
    await ev('SB.newTab()');
    await until("document.querySelector('.pinned-chips .trick-chip')");
    check(await ev("[...document.querySelectorAll('.pinned-chips .trick-chip')].some(c => c.textContent.includes('dead') && c.querySelector('.k-snippet'))"), 'the pin shows on the start screen');
    await ev("[...document.querySelectorAll('.pinned-chips .trick-chip')].find(c => c.textContent.includes('dead')).click()");
    check(await until("[...SB.activeTab().el.querySelectorAll('.msg.assistant')].some(e => /echo: find dead code in the renderer/.test(e.textContent))", 15000), 'clicking the chip runs it');

    // 8. Renaming carries the pin; deleting drops it, and Undo brings it back.
    const renamed = await ev("shellby.saveSnippet({ name: 'deadcode', text: 'find dead code in the renderer' }, 'dead')");
    check(renamed?.ok && renamed.pinned.some(p => p.name === 'deadcode') && !renamed.pinned.some(p => p.name === 'dead'), 'a rename moves its pin');
    // Deleted from its row: the pin goes, and Undo brings back both.
    await ev("SB.showToolbox('snippet')");
    await until("[...document.querySelectorAll('#toolList .snippet-row code')].some(c => c.textContent === '/deadcode')");
    await ev("[...document.querySelectorAll('#toolList .snippet-row')].find(r => r.querySelector('code').textContent === '/deadcode').querySelector('[aria-label^=\"Delete\"]').click()");
    check(await until("!SB.state.snippets.some(s => s.name === 'deadcode') && !SB.state.pinned.some(p => p.kind === 'snippet')"), 'a delete takes the snippet and its pin');
    await ev("document.querySelector('#toast .toast-action').click()");
    check(await until("SB.state.snippets.some(s => s.name === 'deadcode') && SB.state.pinned.some(p => p.name === 'deadcode')"), 'Undo brings back both');
    const pinGhost = await ev("shellby.pinTool('snippet', 'no-such-snippet', true)");
    check(!pinGhost.some(p => p.name === 'no-such-snippet'), "a snippet that doesn't exist can't be pinned");
    // The panel only sees snippets through main: a forged one is refused there.
    const forged = await ev("shellby.saveSnippet({ name: 'x'.repeat(40), text: 'x' })");
    check(forged?.ok === false, 'main refuses a bad name from the panel too');

    // 9. The terminal: shellby snippets, and shellby do @name.
    const listed = await cli({ action: 'snippets' });
    check(listed.status === 200 && /@review/.test(listed.json?.text) && /@lint/.test(listed.json?.text), '`shellby snippets` lists them');
    const unknown = await cli({ action: 'task', args: { snippet: 'reveiw', prompt: '', cwd: ROOT } });
    check(unknown.status === 404 && /Yours: @review/.test(unknown.json?.error), `an unknown @name names the real ones (${unknown.json?.error})`);
    const bare = await cli({ action: 'task', args: { snippet: 'lint', prompt: '', cwd: ROOT } });
    check(bare.status === 400 && /@lint needs something after it/.test(bare.json?.error), '@lint with nothing after it is refused, in @ terms');
    const tabsBefore = await ev('SB.state.tabs.size');
    const run = await cli({ action: 'task', args: { snippet: 'tests', prompt: 'src/main/snippets.js', cwd: ROOT } });
    check(run.status === 200, `shellby do @tests starts a task (${run.status} ${JSON.stringify(run.json)})`);
    check(await until(`SB.state.tabs.size > ${tabsBefore}`), '...in a tab of its own');
    check(await until("[...SB.activeTab().el.querySelectorAll('.msg.assistant')].some(e => /echo: Write tests for src\\/main\\/snippets\\.js/.test(e.textContent))", 15000), 'Claude gets the tests prompt, filled in');
  } catch (e) {
    check(false, e.stack || e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exitCode = fails ? 1 : 0;
})();
