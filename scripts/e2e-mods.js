// ci: Toolbox → Mods: what one can do, the confirm before it's on, its lines in a conversation (skips without Claude Code)
// End-to-end check of Toolbox → Mods against the dev app over CDP. A throwaway
// home holds one mod of "yours" in ~/.claude/skills, turned off. The REAL
// Claude Code CLI (on PATH) answers the plugin commands against that home, so
// your own ~/.claude is never touched; conversations use the fake CLI.
//   - the mod is listed, off, and opening it says what it can do (claude plugin validate)
//   - Turn on asks in the isolated confirm window, red, naming what it reaches for;
//     Cancel leaves it off, Turn it on turns it on (the home's settings.json says so)
//   - Turn off doesn't ask
//   - in a conversation, a mod's log line, status line and slash command show up
//   - New mod checks the name, then opens a tab with the request in the box
//   - a mod dropped into ~/.claude/skills is announced
//   node scripts/e2e-mods.js [screenshot.png]   (also writes -confirm.png and -chat.png beside it)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findClaude } = require('../src/main/claude/cli');

const ROOT = path.join(__dirname, '..');
const PORT = 9361;
const MOD = 'e2e-mod';
const ID = `${MOD}@skills-dir`;
const wait = ms => new Promise(r => setTimeout(r, ms));

function writeMod(home, name, description) {
  const dir = path.join(home, '.claude', 'skills', name);
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '0.1.0', description, author: { name: 'e2e' } }, null, 2));
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }));
  fs.writeFileSync(path.join(dir, 'hooks', 'register.ts'), [
    "import type { Register } from 'claude-code'",
    'export const register: Register = (on) => {',
    "  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {",
    "    await $.process.run({ argv: ['git', 'status'] })",
    "    $.ui.log('saw a command')",
    '    return next(e)',
    '  })',
    '}',
    '',
  ].join('\n'));
  return dir;
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0;
  const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const call = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  const until = async (expr, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr).catch(() => false)) return true; await wait(200); } return false; };
  // Screenshots are for a person to look at: one that doesn't come (an unpainted window) is noted and skipped.
  const shoot = async file => {
    const shot = await Promise.race([call('Page.captureScreenshot', { format: 'png' }), wait(10000)]);
    if (shot?.data) { fs.writeFileSync(file, Buffer.from(shot.data, 'base64')); console.log(`screenshot: ${file}`); } else console.log(`(no screenshot for ${path.basename(file)})`);
  };
  return { ev, until, shoot, close: () => ws.close() };
}

async function targets() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; }
}
async function target(suffix, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const t = (await targets()).find(x => x.url.endsWith(suffix));
    if (t) return t;
    await wait(500);
  }
  return null;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-mods-home-'));
  writeMod(home, MOD, 'Watches commands for the e2e run');
  // Off to start with: turning it on is what asks.
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { [ID]: false } }, null, 2));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ onboarded: true, cwd: home }));
  // With the fake CLI the app calls Claude Code "claude.exe" for plugin commands:
  // the real one's folder goes first on its PATH, so that's the one it finds.
  const real = findClaude(process.env, '');
  if (!real) { console.log('SKIP  Claude Code is not installed here, and this run needs the real CLI'); return; }
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, PATH: `${path.dirname(real)}${path.delimiter}${process.env.PATH || ''}`, USERPROFILE: home, HOME: home, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js') },
  });
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const out = process.argv[2] || path.join(os.tmpdir(), 'shellby-mods.png');
  const settingsSay = () => { try { return JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).enabledPlugins?.[ID]; } catch { return undefined; } };
  try {
    const panelTarget = await target('panel.html');
    if (!panelTarget) throw new Error('the panel never appeared');
    const panel = await connect(panelTarget.webSocketDebuggerUrl);
    const { ev, until } = panel;
    await until('!!window.SB && !!SB.state.version', 20000);
    const row = `[...document.querySelectorAll('#toolList .tool-item')].find(r => r.dataset.key === 'mod:${ID}')`;

    // 1. Listed, off; opening it says what it can do.
    await ev("SB.setView('toolbox'); SB.showToolbox('mod')");
    check(await until(`SB.state.toolbox?.mods?.some(m => m.id === '${ID}' && !m.enabled)`), 'the mod in ~/.claude/skills is listed, and off');
    check(await ev("document.querySelector('#toolTabs [data-kind=\"mod\"] .n').textContent") === '1', 'the Mods chip counts it');
    check(await until(`!!${row}`), 'its row is drawn');
    await ev(`${row}.querySelector('.tool-toggle').click()`);
    check(await until(`/Runs programs on your PC/.test(${row}?.querySelector('.mod-report')?.textContent || '')`, 60000), 'opened, it says "Runs programs on your PC" (from claude plugin validate)');
    check(await ev(`/tool\\.call/.test(${row}.querySelector('.mod-report')?.textContent || '')`), 'and names the hooks');
    await panel.shoot(out);

    // 2. Turn on asks in the confirm window; Cancel leaves it off.
    const askOn = async () => {
      await ev(`${row}.querySelector('.mod-switch').click()`);
      const t = await target('dialog.html', 60);
      if (!t) return null;
      const dlg = await connect(t.webSocketDebuggerUrl);
      await dlg.until("(document.getElementById('title')?.textContent || '').length > 0");
      return dlg;
    };
    let dlg = await askOn();
    check(!!dlg, 'Turn on opens the confirm window');
    if (dlg) {
      const d = await dlg.ev("({ title: title.textContent, detail: detail.textContent, note: note.textContent, danger: document.getElementById('dialog').classList.contains('danger'), focused: document.activeElement?.textContent })");
      check(d.title === `Turn on the mod ${MOD}?`, 'it names the mod');
      check(/⚠ Runs programs on your PC/.test(d.detail), 'it lists what the mod reaches for, worst marked');
      check(d.danger && d.focused === 'Cancel', 'it is red, and Cancel is the default');
      check(/can't show everything/.test(d.note), "it doesn't promise the mod is safe");
      await dlg.shoot(out.replace(/\.png$/, '-confirm.png'));
      await dlg.ev("[...document.querySelectorAll('#actions button')].find(b => b.textContent === 'Cancel').click()");
      dlg.close();
    }
    check(await until(`!${row}?.querySelector('.mod-switch')?.disabled`) && !(await ev(`SB.state.toolbox.mods.find(m => m.id === '${ID}').enabled`)), 'Cancel leaves it off');

    // 3. Turn it on: the real CLI writes it into the home's settings.
    dlg = await askOn();
    if (dlg) {
      await dlg.ev("[...document.querySelectorAll('#actions button')].find(b => b.textContent === 'Turn it on').click()");
      dlg.close();
    }
    check(await until(`SB.state.toolbox.mods.find(m => m.id === '${ID}')?.enabled === true`, 60000), 'Turn it on turns it on');
    // On is a skills-dir mod's default, so Claude Code takes the false out rather than writing true.
    check(settingsSay() !== false, "and Claude Code's settings no longer turn it off");
    check(await until("document.activeElement?.classList.contains('mod-switch')", 5000), 'the keyboard stays on the switch');

    // 4. Turn off doesn't ask.
    await ev(`${row}.querySelector('.mod-switch').click()`);
    check(await until(`SB.state.toolbox.mods.find(m => m.id === '${ID}')?.enabled === false`, 60000), 'Turn off turns it off');
    check(!(await targets()).some(t => t.url.endsWith('dialog.html')), 'without asking');
    check(settingsSay() === false, "and Claude Code's settings say so");

    // 5. In a conversation: its log line in the feed, its status line under the box, its command in the / menu.
    await ev("SB.setView('chat'); SB.send('mod')");
    check(await until("[...document.querySelectorAll('.mod-mark')].some(m => /e2e-mod/.test(m.textContent) && /saw the turn start/.test(m.textContent))"), "a mod's log line shows in the feed, under its name");
    check(await until("!SB.$('modStatus').hidden && /e2e-mod/.test(SB.$('modStatus').textContent) && /watching 1 turn/.test(SB.$('modStatus').textContent)"), 'its status line shows under the box');
    check(await until("SB.state.toolbox?.commands?.some(c => c.name === 'e2e-hello' && /e2e mod/.test(c.description))"), 'its slash command joins the toolbox, with what it does');
    // A first finished task unlocks a trophy, whose card would cover the feed in the picture.
    await ev("[...document.querySelectorAll('button')].find(b => /^Dismiss all/.test(b.textContent))?.click()");
    await wait(400);
    await panel.shoot(out.replace(/\.png$/, '-chat.png'));

    // 6. New mod: a bad name is refused in place; a good one opens a tab with the request.
    await ev("SB.setView('toolbox'); SB.showToolbox('mod')");
    await ev("[...SB.$('setupPane').querySelectorAll('button')].find(b => b.textContent === 'New mod').click()");
    check(await until("!!document.getElementById('modName')"), 'New mod opens its form');
    await ev("(n => { n.value = 'Bad Name'; n.dispatchEvent(new Event('input')); })(document.getElementById('modName')); (i => { i.value = 'counts turns'; i.dispatchEvent(new Event('input')); })(document.getElementById('modIdea')); document.querySelector('.mod-form').requestSubmit()");
    check(await until("/lowercase letters/.test(document.querySelector('.mod-form .setup-status')?.textContent || '')"), 'a bad name is refused in the form');
    await ev("(n => { n.value = 'e2e-new'; n.dispatchEvent(new Event('input')); })(document.getElementById('modName')); document.querySelector('.mod-form').requestSubmit()");
    check(await until("SB.state.view === 'chat' && /e2e-new/.test(SB.$('input').value) && /plugin-authoring/.test(SB.$('input').value)"), 'a good one opens a new conversation with the request in the box, unsent');
    check(await ev("/claude plugin test/.test(SB.$('input').value)"), 'and the request asks for tests');
    await ev("SB.$('input').value = ''");

    // 7. A mod dropped into ~/.claude/skills is announced.
    writeMod(home, 'e2e-dropped', 'Showed up on its own');
    await ev('shellby.rescanToolbox()');
    check(await until("(SB.state.learned || []).some(l => l.kind === 'mod' && l.name === 'e2e-dropped')", 20000), 'a new mod in ~/.claude/skills is announced');
    check(await until("/New mod: e2e-dropped/.test(SB.$('toast').textContent)", 5000), 'with a toast that says it runs in every conversation');
    panel.close();
  } catch (e) {
    console.error('\nERROR:', e.message);
    fails++;
  } finally {
    app.kill();
    await wait(1000);
    for (const d of [profile, home]) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* still in use: temp is cleaned later */ }
  }
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exitCode = fails ? 1 : 0;
})();
