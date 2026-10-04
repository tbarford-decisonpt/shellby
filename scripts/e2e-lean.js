// End-to-end check of Lean Shell against the dev app over CDP, in two runs:
//   1. With the fake Claude CLI (no account, no usage): a reply lights the
//      prompt-cache dot on the context chip and its menu explains it; starting
//      a crowded conversation fresh pays the "fresh" XP.
//   2. With the REAL Claude Code CLI, read-only: Toolbox → Lean lists plugins
//      with Claude Code's own estimates, MCP servers and memory files; "Turn
//      off" on a plugin opens the isolated confirm window, which is cancelled,
//      so nothing is ever turned off. Screenshots go to the temp profile.
//   node scripts/e2e-lean.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  await new Promise(r => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.result?.value;
  };
  const shot = async file => fs.writeFileSync(file, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  return { ev, shot, close: () => ws.close() };
}

async function launch(port, env) {
  const app = spawn(ELECTRON, [ROOT, `--remote-debugging-port=${port}`], { stdio: 'ignore', env: { ...process.env, ...env } });
  const target = async (suffix, tries = 40) => {
    for (let i = 0; i < tries; i++) {
      try {
        const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x => x.url.endsWith(suffix));
        if (t) return t;
      } catch { /* starting */ }
      await wait(500);
    }
    throw new Error(`${suffix} never appeared`);
  };
  return { app, target };
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const poll = async (w, expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await w.ev(expr).catch(() => false)) return true; await wait(200); } return false; };

  // ---- 1. the cache dot and the fresh-start XP, with the fake CLI
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  fs.writeFileSync(path.join(fake, 'settings.json'), JSON.stringify({ onboarded: true, sounds: false, wander: false }));
  let run = await launch(9391, { SHELLBY_USER_DATA: fake, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47988' });
  try {
    const panel = await cdp((await run.target('panel.html')).webSocketDebuggerUrl);
    await wait(3000);
    await panel.ev("SB.setView('chat')");
    const type = text => panel.ev(`(i => { i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(SB.$('input'))`);

    await type('big 60000');
    check(await poll(panel, "SB.activeTab().context?.pct === 30 && !SB.activeTab().busy"), 'a reply fills the context meter');
    check(await poll(panel, "SB.$('ctxChip').dataset.cache === 'warm'"), 'the chip shows a warm prompt cache');
    check(await panel.ev("getComputedStyle(SB.$('ctxChip'), '::after').backgroundColor === 'rgb(127, 214, 194)'"), 'the warm dot is sea-glass, not grey');
    check(await panel.ev("/Prompt cache warm for about 5 more min/.test(SB.$('ctxChip').title)"), 'its tooltip says how long it stays warm');
    await panel.ev("SB.$('ctxChip').click()");
    check(await panel.ev("SB.$('ctxMenu').querySelector('.cache-note')?.textContent.includes('a tenth of the price')"), 'the chip menu explains the cache');
    await panel.shot(path.join(fake, 'lean-cache-menu.png'));
    await panel.ev('SB.closeMenus()');
    // Cooled: pretend the last call was ten minutes ago.
    await panel.ev("SB.activeTab().cache = { ...SB.activeTab().cache, at: Date.now() - 10 * 60 * 1000 }; SB.syncContextUi()");
    check(await panel.ev("SB.$('ctxChip').dataset.cache === 'cold' && /re-reads the whole conversation \\(60k tokens\\) at full price, once/.test(SB.$('ctxChip').title)"), 'a cooled cache says the next message re-reads it once, and nothing more');
    check(await panel.ev("getComputedStyle(SB.$('ctxChip'), '::after').backgroundColor !== 'rgb(127, 214, 194)'"), 'the cold dot is no longer sea-glass');

    // Starting fresh below the crowded mark pays nothing; past it, the fresh-start XP.
    const freshXp = "shellby.getXp().then(x => x.log.filter(e => e.kind === 'fresh').length)";
    await type('big 170000');
    check(await poll(panel, "SB.activeTab().context?.pct === 85 && !SB.activeTab().busy && !SB.$('crowded').hidden"), 'crowded at 85%');
    await panel.ev("[...SB.$('crowded').querySelectorAll('button')].find(b => b.textContent.includes('Start fresh')).click()");
    check(await poll(panel, "!SB.activeTab().busy && [...SB.activeTab().el.querySelectorAll('.msg')].some(m => m.textContent.includes('started this conversation fresh'))", 15000), 'it starts fresh with the summary');
    check(await poll(panel, `${freshXp}.then(n => n === 1)`), 'starting a crowded conversation fresh pays the fresh-start XP');
    panel.close();
  } catch (e) {
    check(false, e.message);
  } finally {
    run.app.kill();
  }

  // ---- 2. the Lean tab, against the real CLI, read-only
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  // Dev runs read memory from a pretend home in the profile: one file for every
  // conversation, one rule that loads only for TypeScript.
  const home = path.join(real, 'claude-home', '.claude');
  fs.mkdirSync(path.join(home, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(home, 'CLAUDE.md'), `# Me\n\n${'Prefer small, focused commits. '.repeat(80)}\n`);
  fs.writeFileSync(path.join(home, 'rules', 'ts.md'), `---\npaths:\n  - "**/*.ts"\n---\n# TypeScript\n\n${'Type the public API. '.repeat(40)}\n`);
  run = await launch(9392, { SHELLBY_USER_DATA: real, SHELLBY_HOOK_PORT: '47989' });
  try {
    const panel = await cdp((await run.target('panel.html')).webSocketDebuggerUrl);
    await poll(panel, '!!window.SB && !!SB.state.version', 20000);
    await panel.ev(`(async () => { await shellby.setSettings({ onboarded: true, crabOnly: false }); SB.state.settings.onboarded = true; await shellby.claudeStatus(); })()`);
    await panel.ev("SB.showToolbox('lean')");
    check(await panel.ev("SB.$('toolList').textContent.includes('Asking Claude Code') || !!SB.state.lean"), 'the Lean tab says it is asking Claude Code');
    check(await poll(panel, '!!SB.state.lean', 120000), 'the report arrives');
    const info = await panel.ev(`({
      head: document.querySelector('.lean-head')?.textContent || '',
      cache: document.querySelector('.lean-cache')?.textContent || '',
      rows: document.querySelectorAll('#toolList .tool-row').length,
      idle: document.querySelectorAll('#toolList .idle-pill').length,
      labels: [...document.querySelectorAll('#toolList .lean-label')].map(l => l.textContent),
      count: document.querySelector('#toolGroups [data-group="lean"] .n').textContent,
      ask: !!document.querySelector('#setupPane .lean-ask button'),
    })`);
    console.log('lean:', JSON.stringify(info));
    check(info.rows > 0 && info.labels.includes('Plugins'), 'plugins are listed');
    check(info.labels.includes('CLAUDE.md and rules, every conversation'), 'CLAUDE.md is listed as carried by every conversation');
    check(info.labels.some(l => l.startsWith('Rules for matching files only')), 'a rule with paths: is listed apart, not counted as always carried');
    check(await panel.ev("SB.state.lean.totals.memory > 0 && SB.state.lean.totals.memoryOnDemand > 0"), 'both are sized');
    check(String(info.idle) === info.count || (info.idle === 0 && info.count === ''), 'the tab count is the idle count');
    check(info.ask, 'there is a button to ask Claude for leaner ways to keep the same features');
    await panel.shot(path.join(real, 'lean-tab.png'));

    // Turn off -> the confirm window, focused on Cancel; cancel it.
    const pick = await panel.ev(`(() => {
      // A plugin's row (its first action is Turn off), an idle one if there is: idle skills offer Remove instead.
      const plugins = [...document.querySelectorAll('#toolList .tool-row')].filter(r => r.querySelector('.tool-actions button')?.textContent === 'Turn off');
      const row = plugins.find(r => r.classList.contains('is-idle')) || plugins[0];
      if (!row) return null;
      row.querySelector('.tool-actions button').click();
      return row.querySelector('code').textContent;
    })()`);
    if (!pick) check(false, 'no plugin to try turning off');
    else {
      const dlg = await cdp((await run.target('dialog.html', 20)).webSocketDebuggerUrl);
      await poll(dlg, "(document.getElementById('title')?.textContent || '').length > 0");
      const d = await dlg.ev("({ title: document.getElementById('title').textContent, message: document.getElementById('message').textContent, focused: document.activeElement?.textContent })");
      console.log('confirm:', JSON.stringify(d));
      check(d.title === `Turn off "${pick}"?` && /stays installed/.test(d.message), 'the confirm window says it stays installed');
      check(d.focused === 'Cancel', 'Cancel is the default');
      await dlg.shot(path.join(real, 'lean-confirm.png'));
      await dlg.ev("[...document.querySelectorAll('#actions button')].find(b => b.textContent === 'Cancel').click()");
      dlg.close();
      check(await poll(panel, `!SB.state.lean.off.some(p => p.name === ${JSON.stringify(pick)}) && SB.state.lean.plugins.some(p => p.name === ${JSON.stringify(pick)})`), `${pick} is still on after Cancel`);
    }
    panel.close();
  } catch (e) {
    check(false, e.message);
  } finally {
    run.app.kill();
  }
  console.log(fails ? `${fails} FAILED` : `all passed (screenshots in ${fake} and ${real})`);
  process.exit(fails ? 1 : 0);
})();
