// ci: keep warm: a ping just before the cache expires, its dim line, the countdown, and coming back turns it off
// Keep warm (docs/plans/keep-warm.md) end to end against the fake CLI: with
// nothing cached it won't turn on; a reply cached for an hour, the mug pressed,
// a ping that reads the cache and leaves one dim line (no message of yours in
// the feed, the tab not left working); then a pretend absence and return turns
// it off, and so does a message you send. SHELLBY_KEEPWARM_LEAD_MS makes the
// ping due a second after the last reply.
//   node scripts/e2e-keepwarm.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9441;
const HOUR = 60 * 60 * 1000;
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
  return { ev, close: () => ws.close() };
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ onboarded: true, sounds: false, wander: false }));
  const app = spawn(ELECTRON, [ROOT, `--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: {
    ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'),
    SHELLBY_HOOK_PORT: '47957', SHELLBY_RECAP_TEST: '1', SHELLBY_KEEPWARM_LEAD_MS: String(HOUR - 1000),
  } });
  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.url.endsWith('panel.html')); } catch { /* starting */ }
      if (!target) await wait(500);
    }
    if (!target) throw new Error('panel.html never appeared');
    const panel = await cdp(target.webSocketDebuggerUrl);
    const poll = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await panel.ev(expr).catch(() => false)) return true; await wait(200); } return false; };
    const type = text => panel.ev(`(i => { i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(SB.$('input'))`);
    const pressed = "SB.$('keepWarmBtn').getAttribute('aria-pressed') === 'true'";
    await wait(3000);
    await panel.ev("SB.setView('chat')");

    await panel.ev("SB.$('keepWarmBtn').click()");
    check(await poll("SB.$('toast').textContent.includes('Nothing to keep warm')"), 'with nothing cached it says so, and stays off');
    check(!(await panel.ev(pressed)), 'the mug is not pressed');

    await type('warm1h 250000'); // over the 200k floor
    check(await poll('!SB.activeTab().busy && SB.activeTab().cache?.ttlMs === 3600000', 20000), 'a reply cached for an hour');
    await wait(1500); // past the one-second lead: the ping is due as it turns on
    await panel.ev("SB.$('keepWarmBtn').click()");
    check(await poll(`${pressed} && /^Warm · \\d/.test(SB.$('keepWarmLeft').textContent)`), 'pressed, with the time left beside it');
    check(await poll("[...SB.activeTab().el.querySelectorAll('.keepwarm-mark')].some(m => /read 250k from cache/.test(m.textContent))", 15000), 'the ping leaves one dim line with what it read');
    check(!(await panel.ev("[...SB.activeTab().el.querySelectorAll('.msg')].some(m => m.textContent.includes('Keep-warm ping'))")), 'the ping itself is not in the feed');
    check(await poll('!SB.activeTab().busy'), 'the tab is not left working');
    check(await poll("SB.$('keepWarmBtn').title.includes('next ping')"), 'the tooltip says when the next ping goes');

    await panel.ev(`shellby.devAway({ idleMs: ${5 * 60e3} })`);
    check(await poll(pressed), 'still on while you are away');
    await panel.ev('shellby.devAway({ idleMs: 0 })');
    check(await poll(`!(${pressed})`), 'coming back turns it off');

    await panel.ev("SB.$('keepWarmBtn').click()");
    check(await poll(pressed), 'on again');
    await wait(1000);
    await type('hello');
    check(await poll(`!(${pressed})`, 15000), 'a message you send turns it off');
    panel.close();
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
