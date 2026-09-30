// Manual end-to-end check against the real Claude Code CLI (uses your subscription).
//   node scripts/smoke-real.js
// Asks Claude to write a temp file in Ask mode, auto-approves the prompt, then
// checks the follow-up turn remembers the conversation.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { ClaudeSession } = require('../src/main/session');
const { checkStatus } = require('../src/main/claude-cli');

(async () => {
  const status = await checkStatus();
  console.log('claude:', status.version, '| auth:', status.authMethod, '| plan:', status.subscriptionType);
  if (!status.loggedIn) process.exit(1);

  const target = path.join(os.tmpdir(), `shellby-smoke-${Date.now()}.txt`);
  const s = new ClaudeSession({ exe: status.exe, cwd: os.tmpdir(), mode: 'ask' });
  let turn = 0;
  s.on('item', item => {
    if (item.kind === 'permission') {
      console.log(`permission: ${item.label} ${item.detail} -> allow`);
      s.respond(item.requestId, 'allow');
    } else if (item.kind === 'tool') console.log(`tool: ${item.label} ${item.detail}`);
    else if (item.kind === 'text') console.log(`text: ${item.text.slice(0, 120)}`);
    else if (item.kind === 'usage') console.log(`usage: 5h ${item.fiveHour?.pct}% / 7d ${item.sevenDay?.pct}%`);
    else if (item.kind === 'result') {
      console.log(`result: ok=${item.ok} ${item.durationMs}ms`);
      if (++turn === 1) s.send('What exact file path did you just write? Reply with only the path.');
      else {
        console.log('file exists:', fs.existsSync(target));
        fs.rmSync(target, { force: true });
        s.close();
        setTimeout(() => process.exit(0), 500);
      }
    }
  });
  s.send(`Use the Write tool to create ${target} containing the word hermit. Do nothing else.`);
})();
