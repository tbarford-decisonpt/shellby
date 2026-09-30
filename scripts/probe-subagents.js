// Probe: how do subagent (Agent/Task tool) events look on the stream-json
// protocol, and do their permission prompts reach the host?
// Prints event *shapes* (types, keys, ids), not content.
//   node scripts/probe-subagents.js
const { spawn } = require('child_process');
const readline = require('readline');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { findClaude, subscriptionEnv } = require('../src/main/claude-cli');

const target = path.join(os.tmpdir(), `shellby-probe-${Date.now()}.txt`);
const exe = findClaude();
const p = spawn(exe, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--permission-prompt-tool', 'stdio', '--permission-mode', 'default'], { cwd: os.tmpdir(), env: subscriptionEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
const send = o => p.stdin.write(JSON.stringify(o) + '\n');
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(5), ...a);
const raw = [];

readline.createInterface({ input: p.stdout }).on('line', l => {
  let ev; try { ev = JSON.parse(l); } catch { return; }
  raw.push(ev);
  const parent = ev.parent_tool_use_id ? ` parent=${ev.parent_tool_use_id.slice(-6)}` : '';
  if (ev.type === 'system') {
    if (!/^hook_/.test(ev.subtype)) log('system', ev.subtype, Object.keys(ev).join(','));
    return;
  }
  if (ev.type === 'control_request') {
    const r = ev.request;
    log('CONTROL', r.subtype, r.tool_name, 'keys=', Object.keys(r).join(','), 'agent_id=', r.agent_id ?? r.agentId ?? '-', parent);
    send({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response: { behavior: 'allow', updatedInput: r.input } } });
    return;
  }
  if (ev.type === 'assistant' || ev.type === 'user') {
    const blocks = (ev.message?.content || []).map(c => c.type === 'tool_use' ? `tool_use:${c.name}#${c.id.slice(-6)}` : c.type === 'tool_result' ? `tool_result#${c.tool_use_id.slice(-6)}` : c.type);
    log(ev.type, blocks.join(' '), parent, 'topkeys=', Object.keys(ev).filter(k => !['message', 'type'].includes(k)).join(','));
    return;
  }
  if (ev.type === 'result') { log('RESULT', ev.subtype, 'subagent_stats=', JSON.stringify(ev.subagent_stats)); p.stdin.end(); return; }
  if (ev.type !== 'rate_limit_event') log('other', ev.type, ev.subtype || '', Object.keys(ev).join(','));
});
p.on('close', () => {
  fs.writeFileSync(path.join(os.tmpdir(), 'shellby-probe-raw.json'), JSON.stringify(raw, null, 1));
  fs.rmSync(target, { force: true });
  log('closed; raw events saved to %TEMP%\\shellby-probe-raw.json');
  process.exit(0);
});
send({ type: 'user', message: { role: 'user', content:
  `Use the Agent tool (general-purpose subagent) to delegate this exact job: "Use the Write tool to create ${target} containing the word crew, then reply done." ` +
  'Also, in the same message, launch a second Agent in parallel that uses Glob to count .txt files directly in the current folder. Then summarize both in one sentence.' } });
setTimeout(() => { log('timeout'); p.kill(); }, 240000);
