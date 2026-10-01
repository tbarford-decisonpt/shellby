// End-to-end over the Chrome DevTools Protocol against the REAL Claude Code CLI,
// read-only: opens the Skill Shop, checks the plugin list, search and filters,
// then clicks Install and cancels it in the isolated confirm window, so nothing
// is ever installed. Screenshots go to the temp profile.
//   node scripts/e2e-shop.js
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 9336;
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

(async () => {
  const profile = process.env.SHELLBY_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const app = spawn(electron, [ROOT, `--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: { ...process.env, SHELLBY_USER_DATA: profile } });
  let ok = false;
  try {
    const panel = await cdp((await target('panel.html')).webSocketDebuggerUrl);
    await until(() => panel.evaluate('!!window.SB && !!SB.state.version'), 'panel boot');
    await panel.evaluate(`(async () => { await shellby.setSettings({ onboarded: true, crabOnly: false }); SB.state.settings.onboarded = true; shellby.claudeStatus(); })()`);
    await panel.evaluate(`document.body.dataset.view = 'chat'; SB.setView('toolbox'); document.getElementById('shopBtn').click()`);
    await until(() => panel.evaluate(`document.querySelectorAll('#shopList .shop-row').length > 0 || /Couldn|not installed/.test(document.getElementById('shopList').textContent)`), 'plugin list', 60000);

    const info = await panel.evaluate(`({
      view: document.body.dataset.view,
      rows: document.querySelectorAll('#shopList .shop-row').length,
      first: document.querySelector('#shopList .shop-row strong')?.textContent,
      counts: [...document.querySelectorAll('#shopTabs .n')].map(n => n.textContent),
      empty: document.querySelector('#shopList .history-empty')?.textContent || null,
    })`);
    console.log('shop:', JSON.stringify(info));
    if (info.view !== 'shop' || info.rows < 1) throw new Error('shop did not list plugins');
    await panel.shot(path.join(profile, 'shop-browse.png'));

    await panel.evaluate(`const s = document.getElementById('shopSearch'); s.value = 'code-review'; s.dispatchEvent(new Event('input'))`);
    const searched = await panel.evaluate(`[...document.querySelectorAll('#shopList .shop-row strong')].map(e => e.textContent)`);
    console.log('search code-review ->', searched.slice(0, 5).join(', '));
    if (!searched.some(n => n.includes('code-review'))) throw new Error('search found nothing');

    await panel.evaluate(`document.getElementById('shopSearch').value = ''; document.querySelector('#shopTabs [data-filter="installed"]').click()`);
    const inst = await panel.evaluate(`({ rows: document.querySelectorAll('#shopList .shop-row').length, allInstalled: [...document.querySelectorAll('#shopList .shop-row')].every(r => r.classList.contains('is-installed')) })`);
    console.log('installed filter:', JSON.stringify(inst));
    if (!inst.allInstalled) throw new Error('installed filter shows uninstalled plugins');
    await panel.shot(path.join(profile, 'shop-installed.png'));

    // Install -> the isolated confirm window must appear, focused on Cancel; cancel it there.
    // Once for Anthropic's marketplace (calm) and once for a third-party one (red warning).
    await panel.evaluate(`document.querySelector('#shopTabs [data-filter="all"]').click()`);
    const tryCancel = async (official, shotName) => {
      await panel.evaluate(`(() => { const sel = document.getElementById('shopMarket'); sel.value = ${official} ? 'claude-plugins-official' : ([...sel.options].map(o => o.value).find(v => v && !['claude-plugins-official', 'anthropic-agent-skills'].includes(v)) || ''); sel.dispatchEvent(new Event('change')); })()`);
      const pick = await panel.evaluate(`(() => {
        const r = [...document.querySelectorAll('#shopList .shop-row')].find(r => !r.classList.contains('is-installed'));
        if (!r) return null;
        r.querySelector('.tool-actions button').click();
        return r.querySelector('strong').textContent;
      })()`);
      if (!pick) { console.log(`(no ${official ? 'official' : 'third-party'} plugin to try)`); return; }
      const dlg = await cdp((await target('dialog.html', 20)).webSocketDebuggerUrl);
      await until(() => dlg.evaluate(`(document.getElementById('title')?.textContent || '').length > 0`).catch(() => false), 'confirm content');
      const d = await dlg.evaluate(`({ title: document.getElementById('title').textContent, message: document.getElementById('message').textContent, note: document.getElementById('note').textContent, danger: document.getElementById('dialog').classList.contains('danger'), focused: document.activeElement?.textContent })`);
      console.log('confirm:', JSON.stringify(d));
      if (d.title !== 'Install plugin?' || !d.message.includes(pick) || !/hooks or MCP servers/.test(d.note)) throw new Error('confirm window content wrong');
      if (d.danger === official) throw new Error(`danger styling should be ${!official}`);
      if (d.focused !== 'Cancel') throw new Error('Cancel must be the default button');
      await dlg.shot(path.join(profile, shotName));
      await dlg.evaluate(`[...document.querySelectorAll('#actions button')].find(b => b.textContent === 'Cancel').click()`);
      dlg.close();
      await until(() => panel.evaluate(`!document.querySelector('#shopList .shop-row.is-busy')`), 'install to cancel');
      const still = await panel.evaluate(`[...document.querySelectorAll('#shopList .shop-row')].find(r => r.querySelector('strong').textContent === ${JSON.stringify(pick)})?.classList.contains('is-installed')`);
      if (still) throw new Error('plugin was installed despite Cancel');
      console.log(`cancel ok: ${pick} not installed`);
    };
    await tryCancel(true, 'shop-confirm.png');
    await tryCancel(false, 'shop-confirm-thirdparty.png');

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
