// ci: a very long conversation stops growing the DOM
// Regression check: a very long conversation can't grow the panel without
// bound. The oldest blocks are dropped once there are more than MAX_BLOCKS of
// them, the tool and lane maps let go with the elements, a notice says what
// happened, and the newest output is still there and still in view.
// No Claude account needed — items are rendered straight into the feed.
//   node scripts/e2e-feed-cap.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9356;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-')), SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47991' },
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
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");

    // What an overnight autonomous run looks like: a few thousand blocks, a
    // mix of replies, tool calls with results, and helper lanes.
    const produced = await ev(`(() => {
      const t = SB.activeTab();
      for (let i = 0; i < 1200; i++) {
        t.render({ kind: 'text', text: 'reply number ' + i });
        t.render({ kind: 'tool', id: 'tool-' + i, label: 'Bash', detail: 'echo ' + i });
        t.render({ kind: 'tool_result', id: 'tool-' + i, text: 'ok ' + i });
        if (i % 100 === 0) t.render({ kind: 'tool', id: 'lane-' + i, label: 'Agent', detail: 'helper', agent: { description: 'helper ' + i, type: 'general' } });
      }
      t.render({ kind: 'text', text: 'THE VERY LAST REPLY' });
      return { blocks: t.el.children.length, trimmed: t.trimmed, tools: t.tools.size, lanes: t.lanes.size };
    })()`);

    // 400 blocks + the "earlier steps hidden" notice + the (hidden) empty state.
    check(produced.blocks <= 402, `feed is capped at ~400 blocks, not 3600 (${produced.blocks})`);
    check(produced.trimmed > 2000, `the dropped blocks are counted (${produced.trimmed})`);
    check(produced.tools <= 402, `the tool map let go with the elements (${produced.tools} entries, not 2400)`);
    check(produced.lanes <= 13, `the lane map let go with the elements (${produced.lanes} entries, not 12+)`);

    const notice = await ev("document.querySelector('.feed-trimmed')?.textContent || ''");
    check(/earlier steps hidden/.test(notice), `a notice explains the gap ("${notice.slice(0, 60)}")`);
    check(await ev("!!document.querySelector('.feed-trimmed')?.parentElement?.firstElementChild?.classList?.contains('feed-trimmed')"), 'the notice sits at the top of the feed');

    // The newest output survived, and the feed is still pinned to it.
    check(await ev("[...SB.activeTab().el.querySelectorAll('.msg.assistant')].slice(-1)[0]?.textContent.includes('THE VERY LAST REPLY')"), 'the newest reply is still rendered');
    check(await ev('SB.activeTab().distanceFromEnd() < 60'), 'the feed is still scrolled to the newest block');

    // A result arriving for a tool that's been trimmed away must not throw.
    const late = await ev(`(() => { try { SB.activeTab().render({ kind: 'tool_result', id: 'tool-0', text: 'late' }); return 'ok'; } catch (e) { return e.message; } })()`);
    check(late === 'ok', `a result for a long-trimmed tool is ignored quietly (${late})`);

    // Replaying a huge transcript from History is capped the same way.
    const replayed = await ev(`(() => {
      const t = SB.activeTab();
      for (let i = 0; i < 900; i++) t.render({ kind: 'text', text: 'replayed ' + i }, { replay: true });
      return t.el.children.length;
    })()`);
    check(replayed <= 402, `replaying a long transcript is capped too (${replayed})`);
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
