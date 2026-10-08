// ci: Toolbox → Hooks and Memory: confirm-gated hook edits, CLAUDE.md saves and conflicts
// End-to-end over the Chrome DevTools Protocol: Toolbox → Hooks and Memory.
// Everything happens in a temp profile with a pretend home (isolated runs never
// read or write the real ~/.claude): lists the hooks in plain words, adds one of
// your own through the confirm window (once cancelled, once confirmed), adds one
// from a recipe after a test run, pauses and resumes it, removes one, edits a
// CLAUDE.md, and refuses to overwrite it after an outside edit.
//   node scripts/e2e-setup.js
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 9341;
const ROOT = path.join(__dirname, '..');
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function list() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; }
}

async function target(suffix, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const t = (await list()).find(x => x.url.endsWith(suffix));
    if (t) return t;
    await wait(500);
  }
  throw new Error(`${suffix} never appeared`);
}

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise(r => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.result?.value;
  };
  const shot = async file => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  };
  return { send, evaluate, shot, close: () => ws.close() };
}

async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await wait(250); }
  throw new Error(`timed out waiting for ${what}`);
}

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

// Answer the confirm window: check what it says, then press `label`.
async function answer(label, expect) {
  const t = await target('dialog.html', 20);
  const dlg = await cdp(t.webSocketDebuggerUrl);
  await until(() => dlg.evaluate(`(document.getElementById('title')?.textContent || '').length > 0`).catch(() => false), 'confirm content');
  // The default button is focused a frame after the content goes in.
  await until(() => dlg.evaluate(`document.activeElement?.tagName === 'BUTTON'`).catch(() => false), 'default button focus', 5000);
  const d = await dlg.evaluate(`({ title: document.getElementById('title').textContent, message: document.getElementById('message').textContent, detail: document.getElementById('detail')?.textContent || '', focused: document.activeElement?.textContent })`);
  console.log('confirm:', JSON.stringify(d));
  if (d.title !== expect.title || !d.detail.includes(expect.command)) throw new Error('confirm window content wrong');
  if (d.focused !== 'Cancel') throw new Error('Cancel must be the default button');
  await dlg.evaluate(`[...document.querySelectorAll('#actions button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`);
  dlg.close();
  // Gone before the next one is looked for: a slow CI box still lists this one
  // as it closes, and a connection to it never answers.
  await until(async () => !(await list()).some(x => x.id === t.id), 'confirm window closed', 10000);
}

(async () => {
  const profile = process.env.SHELLBY_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const home = path.join(profile, 'claude-home');
  const project = path.join(home, 'projects', 'reef');
  const userSettings = path.join(home, '.claude', 'settings.json');
  const projectSettings = path.join(project, '.claude', 'settings.json');
  const projectMemory = path.join(project, 'CLAUDE.md');
  put(userSettings, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }, null, 2));
  put(projectMemory, '# Reef\r\n\r\nUse pnpm.\r\n');
  put(path.join(home, '.claude', 'rules', 'tone.md'), 'Be brief.\n');

  const app = spawn(electron, [ROOT, `--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: { ...process.env, SHELLBY_USER_DATA: profile } });
  let ok = false;
  try {
    const panel = await cdp((await target('panel.html')).webSocketDebuggerUrl);
    await until(() => panel.evaluate('!!window.SB && !!SB.state.version'), 'panel boot');
    await panel.evaluate(`(async () => { await shellby.setSettings({ onboarded: true, crabOnly: false }); SB.state.settings.onboarded = true; await shellby.setFolder(${JSON.stringify(project)}); })()`);
    await panel.evaluate(`SB.setView('toolbox'); document.querySelector('#toolTabs [data-kind="hook"]').click()`);
    await until(() => panel.evaluate(`document.querySelectorAll('#toolList .hook-row').length > 0`), 'hook list');

    // ---- hooks: listed, in plain words, under the moment they run
    const rows = () => panel.evaluate(`[...document.querySelectorAll('#toolList .hook-row')].map(r => r.querySelector('.hook-title strong').textContent + (r.classList.contains('is-paused') ? ' (paused)' : ''))`);
    const hooks = await panel.evaluate(`({
      groups: [...document.querySelectorAll('#toolList .hook-group-head span')].map(e => e.textContent),
      rows: [...document.querySelectorAll('#toolList .hook-row')].map(r => r.querySelector('.hook-title strong').textContent + ' | ' + r.querySelector('.hook-full').textContent),
      counts: Object.fromEntries([...document.querySelectorAll('#toolTabs [data-kind]')].map(b => [b.dataset.kind, b.querySelector('.n').textContent])),
    })`);
    console.log('hooks:', JSON.stringify(hooks));
    if (hooks.groups.join() !== 'When Claude finishes replying' || hooks.rows.join() !== 'Prints a message | echo done' || hooks.counts.hook !== '1' || hooks.counts.memory !== '2') throw new Error('hooks/memory not listed as expected');
    await panel.shot(path.join(profile, 'setup-hooks.png'));

    // ---- hooks: your own, from "Write my own"; cancelled in the confirm window, then confirmed
    const pick = id => panel.evaluate(`(() => { document.querySelector('.setup-intro .btn').click(); document.querySelector('[data-recipe="${id}"]').click(); })()`);
    await pick('custom');
    await panel.evaluate(`(() => {
      const f = () => document.querySelector('.hook-form');
      const event = f().querySelector('[name=event]');
      event.value = 'PreToolUse'; event.dispatchEvent(new Event('change'));
      f().querySelector('.hook-chip[data-value="Bash"]').click();
      f().querySelector('input[name=where][value=project]').click();
      const c = f().querySelector('[name=command]'); c.value = 'node check.js'; c.dispatchEvent(new Event('input'));
    })()`);
    const form = await panel.evaluate(`({ pattern: document.querySelector('.hook-pattern').value, pressed: [...document.querySelectorAll('.hook-chip[aria-pressed="true"]')].map(c => c.textContent), hint: document.getElementById('hookCanDo').textContent })`);
    console.log('form:', JSON.stringify(form));
    if (form.pattern !== 'Bash' || form.pressed.join() !== 'Shell commands' || !/exit with code 2/.test(form.hint)) throw new Error('form did not explain or fill in as expected');
    await panel.shot(path.join(profile, 'setup-hook-form.png'));
    await panel.evaluate(`document.querySelector('.hook-form').requestSubmit()`);
    await answer('Cancel', { title: 'Add this hook?', command: 'node check.js' });
    await wait(500);
    if (fs.existsSync(projectSettings)) throw new Error('Cancel still wrote the hook');
    await panel.evaluate(`document.querySelector('.hook-form').requestSubmit()`);
    await answer('Add it', { title: 'Add this hook?', command: 'node check.js' });
    await until(() => fs.existsSync(projectSettings), 'project settings written');
    const written = readJson(projectSettings);
    console.log('project settings:', JSON.stringify(written));
    if (written.hooks?.PreToolUse?.[0]?.matcher !== 'Bash' || written.hooks.PreToolUse[0].hooks[0].command !== 'node check.js') throw new Error('hook written wrong');
    await until(async () => (await rows()).length === 2, 'two hooks listed');

    // ---- hooks: from a recipe, tried with Test run first
    await panel.evaluate(`document.querySelector('#toolTabs [data-kind="hook"]').click()`);
    await panel.evaluate(`document.querySelector('.setup-intro .btn').click()`);
    await panel.shot(path.join(profile, 'setup-hook-ideas.png'));
    await panel.evaluate(`document.querySelector('[data-recipe="guard-git"]').click()`);
    await panel.shot(path.join(profile, 'setup-hook-recipe.png'));
    const guard = await panel.evaluate(`document.querySelector('.hook-form [name=command]').value`);
    if (!guard.startsWith('bash -c')) throw new Error('recipe did not fill in the command');
    await panel.evaluate(`[...document.querySelectorAll('.hook-test button')].find(b => b.textContent === 'Test run').click()`);
    await answer('Run it', { title: 'Run this command once?', command: guard });
    await until(() => panel.evaluate(`!!document.querySelector('.hook-test .hook-verdict:not(.busy)')`), 'test verdict');
    const tried = await panel.evaluate(`({ tone: document.querySelector('.hook-test .hook-verdict').className, text: document.querySelector('.hook-test .hook-verdict').textContent })`);
    console.log('test run:', JSON.stringify(tried));
    if (!/\bblock\b/.test(tried.tone) || !/stop Claude from using the tool/.test(tried.text)) throw new Error('the guard recipe did not block its sample force-push');
    await panel.evaluate(`document.querySelector('.hook-test').scrollIntoView({ block: 'center' })`);
    await panel.shot(path.join(profile, 'setup-hook-test.png'));
    await panel.evaluate(`document.querySelector('.hook-form').requestSubmit()`);
    await answer('Add it', { title: 'Add this hook?', command: guard });
    const hasGuard = () => (readJson(userSettings).hooks?.PreToolUse || []).some(g => g.hooks.some(x => x.command === guard));
    await until(hasGuard, 'recipe written to user settings');
    await until(async () => (await rows()).includes('Stop force-pushes and hard resets'), 'recipe listed by its name');

    // ---- hooks: pause, then resume, exactly as it was
    const openRow = name => panel.evaluate(`(() => { const r = [...document.querySelectorAll('#toolList .hook-row')].find(r => r.querySelector('.hook-title strong').textContent === ${JSON.stringify(name)}); r.open = true; return true; })()`);
    const press = (name, label) => panel.evaluate(`[...[...document.querySelectorAll('#toolList .hook-row')].find(r => r.querySelector('.hook-title strong').textContent === ${JSON.stringify(name)}).querySelectorAll('.hook-actions button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`);
    const before = readJson(userSettings).hooks.PreToolUse;
    await openRow('Stop force-pushes and hard resets');
    await press('Stop force-pushes and hard resets', 'Pause');
    await answer('Pause it', { title: 'Pause this hook?', command: 'git +reset' });
    await until(() => !hasGuard(), 'paused hook taken out of the file');
    await until(async () => (await rows()).includes('Stop force-pushes and hard resets (paused)'), 'paused hook still listed');
    await panel.shot(path.join(profile, 'setup-hook-paused.png'));
    await openRow('Stop force-pushes and hard resets');
    await press('Stop force-pushes and hard resets', 'Resume');
    await until(hasGuard, 'resumed hook back in the file');
    if (JSON.stringify(readJson(userSettings).hooks.PreToolUse) !== JSON.stringify(before)) throw new Error('resume did not put the hook back as it was');
    console.log('pause/resume ok:', JSON.stringify(await rows()));

    // ---- hooks: remove the user one
    await openRow('Prints a message');
    await panel.evaluate(`[...document.querySelectorAll('#toolList .hook-row')].find(r => r.textContent.includes('echo done')).querySelector('[aria-label="Remove this hook"]').click()`);
    await answer('Remove it', { title: 'Remove this hook?', command: 'echo done' });
    await until(() => !readJson(userSettings).hooks?.Stop, 'user hook removed');
    if (readJson(userSettings).model !== 'opus') throw new Error('removing a hook lost other settings');
    if (!fs.existsSync(`${userSettings}.shellby-backup`)) throw new Error('no backup kept');
    console.log('remove ok, other settings kept, backup made');

    // ---- memory: list, edit, Ctrl+S, CRLF kept
    await panel.evaluate(`document.querySelector('#toolTabs [data-kind="memory"]').click()`);
    const mem = await panel.evaluate(`[...document.querySelectorAll('#toolList .mem-row')].map(r => r.querySelector('.mem-title').textContent + ' | ' + r.querySelector('.tool-actions .btn').textContent)`);
    console.log('memory:', JSON.stringify(mem));
    if (!mem.includes('Your memory | Create') || !mem.includes('Project memory | Edit') || !mem.includes('Your rule | Edit')) throw new Error('memory files not listed');
    await panel.shot(path.join(profile, 'setup-memory.png'));
    await panel.evaluate(`[...document.querySelectorAll('#toolList .mem-row')].find(r => r.textContent.includes('Project memory')).querySelector('.tool-actions .btn').click()`);
    await until(() => panel.evaluate(`!!document.querySelector('.mem-text')`), 'memory editor');
    const loaded = await panel.evaluate(`document.querySelector('.mem-text').value`);
    if (loaded !== '# Reef\n\nUse pnpm.\n') throw new Error(`editor loaded ${JSON.stringify(loaded)}`);
    const type = text => panel.evaluate(`(() => { const a = document.querySelector('.mem-text'); a.value = ${JSON.stringify(text)}; a.dispatchEvent(new Event('input')); a.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })); })()`);
    await type('# Reef\n\nUse pnpm.\nRun the tests.\n');
    await until(() => fs.readFileSync(projectMemory, 'utf8').includes('Run the tests'), 'memory saved');
    if (fs.readFileSync(projectMemory, 'utf8') !== '# Reef\r\n\r\nUse pnpm.\r\nRun the tests.\r\n') throw new Error('Windows line endings not kept');
    await panel.shot(path.join(profile, 'setup-memory-editor.png'));

    // ---- memory: an outside edit is never overwritten
    await wait(50);
    fs.writeFileSync(projectMemory, 'changed elsewhere\n');
    await type('mine\n');
    await until(() => panel.evaluate(`document.querySelector('.mem-editor .setup-status').classList.contains('err')`), 'conflict message');
    if (fs.readFileSync(projectMemory, 'utf8') !== 'changed elsewhere\n') throw new Error('overwrote an outside edit');
    const conflict = await panel.evaluate(`({ msg: document.querySelector('.mem-editor .setup-status').textContent, reload: !document.querySelector('.mem-editor .setup-actions .btn.ghost').hidden })`);
    console.log('conflict:', JSON.stringify(conflict));
    if (!conflict.reload) throw new Error('no Reload offered');
    await panel.shot(path.join(profile, 'setup-memory-conflict.png'));

    panel.close();
    ok = true;
    console.log(`\nPASS  (screenshots in ${profile})`);
  } catch (e) {
    console.error('\nFAIL:', e.message);
  } finally {
    app.kill();
    process.exitCode = ok ? 0 : 1;
  }
})();
