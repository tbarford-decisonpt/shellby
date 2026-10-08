// End-to-end check of the context meter against the dev app over CDP, driven by
// the fake Claude CLI (test/fixtures/fake-claude.js): no account, no usage.
//   1. A reply's token counts fill the hairline under its tab and the chip,
//      and the turn ends with what it cost
//   2. Filling fast: a quieter "filling up" offer before it's crowded
//   3. Past 80% he says it's getting crowded, and the composer offers room
//      even after "filling up" was waved away
//   4. The chip's menu: the running total, and the costliest turns, each a
//      way back to it; "Not now" hides the offer; Compact runs /compact and
//      empties the meter
//   5. "Start fresh with a summary": a summary turn, then a new conversation
//      in the same tab that's handed it
//   node scripts/e2e-context.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9390;
const wait = ms => new Promise(r => setTimeout(r, ms));

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const ev = expr => new Promise(r => { const i = ++id; p.set(i, m => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
  return new Promise(r => { ws.onopen = () => r({ ev }); });
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ onboarded: true, sounds: false, wander: false }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47987' },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !(list.some(t => t.url.endsWith('panel.html')) && list.some(t => t.url.endsWith('critter.html'))); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const { ev } = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    const critter = await connect(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl);
    const poll = async (w, expr, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await w.ev(expr)) return true; await wait(150); } return false; };
    const until = (expr, ms = 10000) => poll({ ev }, expr, ms);
    until.in = (w, expr, ms = 10000) => poll(w, expr, ms);
    const type = async text => ev(`(i => { i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(SB.$('input'))`);
    await wait(3000);
    await ev("SB.setView('chat')");
    await critter.ev("window.__said = []; const bt = document.getElementById('bubbleText'); new MutationObserver(() => window.__said.push(bt.textContent)).observe(bt, { childList: true, characterData: true, subtree: true }); true");

    // 1. A modest reading: the bar and the chip, no offer yet.
    check(await ev("SB.$('ctxChip').hidden"), 'no chip before Claude has said anything');
    await type('big 60000');
    check(await until("SB.activeTab().context?.pct === 30 && !SB.activeTab().busy"), 'the tab knows it is 30% full');
    check(await ev("getComputedStyle(document.querySelector('.tab.active .tab-ctx')).getPropertyValue('--fill').trim() === '0.3'"), 'the hairline under the tab is 30% long');
    check(await ev("!SB.$('ctxChip').hidden && SB.$('ctxLabel').textContent === '30%'"), 'the chip reads 30%');
    check(await ev("SB.$('crowded').hidden"), 'no crowded offer at 30%');
    check(await ev("/^this turn: [\\d.]+k? tokens · .*30% of context$/.test(SB.activeTab().el.querySelector('.turn-cost')?.textContent || '')"), 'the turn ends with what it cost');

    // 2. A big jump: at that pace it'll be crowded in a turn, so a quieter offer first.
    await type('big 140000');
    check(await until("SB.activeTab().context?.pct === 70 && !SB.activeTab().busy"), 'the tab is 70% full');
    check(await until("!SB.$('crowded').hidden && SB.$('crowded').classList.contains('soon') && /Filling up: 70% full, about a turn from crowded/.test(SB.$('crowded').textContent)"), 'the composer says it is filling up, before it is crowded');
    check(await ev("SB.$('crowded').textContent.includes('Compact') && SB.$('crowded').textContent.includes('Start fresh')"), 'and offers the same ways to make room');
    await ev("SB.$('crowded').querySelector('[aria-label=\"Not now\"]').click()");
    check(await ev("SB.$('crowded').hidden"), '"Not now" hides "filling up"');

    // 3. Past the mark.
    await type('big 170000');
    check(await until("SB.activeTab().context?.pct === 85 && !SB.activeTab().busy"), 'the tab is 85% full');
    check(await ev("document.querySelector('.tab.active .tab-ctx').classList.contains('warn') && SB.$('ctxChip').classList.contains('warn')"), 'bar and chip turn amber');
    check(await until("!SB.$('crowded').hidden && /crowded/i.test(SB.$('crowded').textContent) && !SB.$('crowded').classList.contains('soon')"), 'the composer says it is getting crowded, though "filling up" was waved away');
    check(await ev("SB.$('crowded').querySelectorAll('.crowded-text').length === 1"), 'one offer, never two');
    check(await until.in(critter, "window.__said.some(t => /crowded/i.test(t))", 4000), 'he says "Getting crowded in here."');

    // 4. The chip's menu: what the conversation has cost so far, then Not now, then Compact from it.
    await ev("SB.$('ctxChip').click()");
    check(await until("!SB.$('ctxMenu').hidden && /So far: [\\d.]+k? tokens over 3 turns/.test(SB.$('ctxMenu').textContent)"), 'the chip menu has the running total');
    check(await ev("SB.$('ctxMenu').textContent.includes('Costliest turns') && SB.$('ctxMenu').querySelectorAll('.cost-turn').length === 3"), 'and the costliest turns');
    await ev("SB.$('ctxMenu').querySelector('.cost-turn').click()");
    check(await until("SB.$('ctxMenu').hidden && !!SB.activeTab().el.querySelector('.turn-cost.flash')"), 'a costliest turn scrolls back to it');
    await ev("SB.$('crowded').querySelector('[aria-label=\"Not now\"]').click()");
    check(await ev("SB.$('crowded').hidden"), '"Not now" hides the offer');
    await ev("SB.$('ctxChip').click()");
    check(await until("!SB.$('ctxMenu').hidden && SB.$('ctxMenu').textContent.includes('Compact') && SB.$('ctxMenu').textContent.includes('Start fresh')"), 'the chip opens Compact and Start fresh');
    await ev("[...SB.$('ctxMenu').querySelectorAll('.menu-item')].find(b => b.textContent.includes('Compact')).click()");
    check(await until("!SB.activeTab().busy && SB.activeTab().el.textContent.includes('Compacted the conversation (it was 170k tokens)')"), 'Compact runs /compact and the feed marks it');
    check(await until("!SB.activeTab().context && SB.$('ctxChip').hidden && !document.querySelector('.tab.active .tab-ctx')"), 'the meter empties until the next reply');

    // 5. Start fresh with a summary, from the crowded offer.
    await type('big 180000');
    check(await until("!SB.$('crowded').hidden && !SB.activeTab().busy"), 'crowded again after the compacted conversation fills back up');
    const tabId = await ev('SB.activeTab().id');
    await ev("[...SB.$('crowded').querySelectorAll('button')].find(b => b.textContent.includes('Start fresh')).click()");
    check(await until(`SB.activeTab().el.textContent.includes('Started fresh')`, 15000), 'the feed marks the fresh start');
    check(await until("!SB.activeTab().busy && [...SB.activeTab().el.querySelectorAll('.msg')].some(m => m.textContent.includes('started this conversation fresh'))", 15000), 'the new conversation is handed the summary');
    check(await ev(`SB.activeTab().id === ${JSON.stringify(tabId)}`), 'it all happened in the same tab');
    check(await ev("SB.$('crowded').hidden"), 'the offer is gone once it has started fresh');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
