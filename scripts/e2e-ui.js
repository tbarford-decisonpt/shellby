// End-to-end over the Chrome DevTools Protocol against the REAL Claude Code CLI
// (uses your subscription; two small tasks):
//   • two conversations run in parallel in separate tabs
//   • one delegates to a subagent whose permission prompt must land in its crew lane
//   • helper crabs must appear on the desktop critter while the subagent works
// Restores your permission mode and deletes its test conversations afterwards.
//   node scripts/e2e-ui.js
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 9333;
const ROOT = path.join(__dirname, '..');
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const panel = list.find(x => x.url.endsWith('panel.html'));
      const critter = list.find(x => x.url.endsWith('critter.html'));
      if (panel && critter) return { panel, critter };
    } catch { /* not up yet */ }
    await wait(500);
  }
  throw new Error('windows never appeared');
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
  return { send, evaluate, close: () => ws.close() };
}

(async () => {
  const fileA = path.join(os.tmpdir(), `shellby-e2e-a-${Date.now()}.txt`);
  const fileB = path.join(os.tmpdir(), `shellby-e2e-b-${Date.now()}.txt`);
  const app = spawn(electron, [ROOT, `--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: { ...process.env, SHELLBY_USER_DATA: process.env.SHELLBY_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')) } });
  let ok = false;
  let panel;
  let originalMode = null;
  const created = [];
  try {
    const t = await targets();
    panel = await cdp(t.panel.webSocketDebuggerUrl);
    const critter = await cdp(t.critter.webSocketDebuggerUrl);
    await wait(3000);

    if (await panel.evaluate('document.body.dataset.view') === 'onboarding') {
      await panel.evaluate("document.getElementById('letsGoBtn').click()");
      await wait(500);
    }
    originalMode = await panel.evaluate('SB.state.settings.mode');
    await panel.evaluate("SB.chooseMode('ask', { quiet: true })");
    console.log(`mode: ${originalMode} -> ask (restored at the end)`);

    // Tab 1: a plain task that needs one approval.
    await panel.evaluate('SB.newTab()');
    await wait(300);
    created.push(await panel.evaluate('SB.state.activeTab'));
    await panel.evaluate(`SB.send(${JSON.stringify(`Use the Write tool to create ${fileA} containing the word shell. Do nothing else.`)})`);
    // Tab 2, in parallel: delegate to a subagent that needs approval.
    await panel.evaluate('SB.newTab()');
    await wait(300);
    created.push(await panel.evaluate('SB.state.activeTab'));
    await panel.evaluate(`SB.send(${JSON.stringify(`Use the Agent tool with a general-purpose subagent to do exactly this: "Use the Write tool to create ${fileB} containing the word crew, then reply done." Do nothing else yourself.`)})`);
    console.log('sent two tasks in two tabs');

    const seen = { parallel: false, laneAsk: false, who: false, maxHelpers: 0, answered: 0 };
    const end = Date.now() + 180000;
    while (Date.now() < end) {
      const snap = JSON.parse(await panel.evaluate(`JSON.stringify([...SB.state.tabs.values()].filter(t => ${JSON.stringify(created)}.includes(t.id)).map(t => ({
        id: t.id, busy: t.busy, done: !!t.el.querySelector('.meta'),
        lanes: t.lanes.size, laneDone: [...t.lanes.values()].some(l => l.status === 'done'),
        asks: [...t.asks.entries()].filter(([, c]) => !c.classList.contains('decided')).map(([id, c]) => ({ id, inLane: !!c.closest('.lane'), who: !!c.querySelector('.ask-who') })),
      })))`));
      if (snap.filter(s => s.busy).length === 2) seen.parallel = true;
      seen.maxHelpers = Math.max(seen.maxHelpers, await critter.evaluate("document.querySelectorAll('#crew .helper:not(.leaving)').length"));
      for (const s of snap) {
        for (const a of s.asks) {
          if (a.inLane) seen.laneAsk = true;
          if (a.who) seen.who = true;
          await panel.evaluate(`(() => { const c = SB.state.tabs.get(${JSON.stringify(s.id)}).asks.get(${JSON.stringify(a.id)}); c.querySelector('.btn.allow').click(); })()`);
          seen.answered++;
          console.log(`approved a request in tab ${s.id.slice(0, 8)}${a.inLane ? ' (inside a crew lane, from a helper)' : ''}`);
        }
      }
      if (snap.length === 2 && snap.every(s => s.done)) {
        console.log('both tabs finished; lanes:', snap.map(s => s.lanes).join(','), '| helper lane done:', snap.some(s => s.laneDone));
        break;
      }
      await wait(400);
    }

    await panel.evaluate(`SB.activate(${JSON.stringify(created[1])})`);
    await wait(600);
    const shot = await panel.send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(os.tmpdir(), 'shellby-e2e-crew.png');
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));

    const results = {
      'ran in parallel': seen.parallel,
      'helper prompt shown in its lane': seen.laneAsk,
      'prompt labelled with the helper': seen.who,
      'helper crab appeared on desktop': seen.maxHelpers > 0,
      'file from tab 1 written': fs.existsSync(fileA),
      'file from subagent written': fs.existsSync(fileB),
    };
    for (const [k, v] of Object.entries(results)) console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`);
    console.log('approvals answered:', seen.answered, '| screenshot:', out);
    ok = Object.values(results).every(Boolean);
    critter.close();
  } catch (e) {
    console.error('E2E FAILED:', e.message);
  } finally {
    try {
      if (panel) {
        if (originalMode) await panel.evaluate(`SB.chooseMode(${JSON.stringify(originalMode)}, { quiet: true })`);
        for (const id of created) await panel.evaluate(`window.shellby.deleteSession(${JSON.stringify(id)})`);
        await wait(300);
        panel.close();
      }
    } catch { /* best effort */ }
    for (const f of [fileA, fileB]) fs.rmSync(f, { force: true });
    spawn('taskkill', ['/PID', String(app.pid), '/T', '/F']);
    setTimeout(() => process.exit(ok ? 0 : 1), 800);
  }
})();
