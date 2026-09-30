// A stand-in for `claude -p --input-format stream-json ...` that speaks the same
// stdin/stdout protocol, so session tests run without a real Claude account.
//
// Behaviour per user message:
//   "tool ..."   -> asks permission for a Write; replies ALLOWED/DENIED
//   "slow ..."   -> starts a long tool call and waits (use with interrupt)
//   "crash"      -> exits with code 3 mid-turn
//   anything else -> replies "echo: <text>"
const readline = require('readline');

const args = process.argv.slice(2);
const sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : 'fake-session-1';
let mode = args.includes('--permission-mode') ? args[args.indexOf('--permission-mode') + 1] : 'default';
let turn = 0;
let pending = null;   // { requestId, onAnswer }
let slow = null;

const out = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const text = t => out({ type: 'assistant', message: { content: [{ type: 'text', text: t }] }, parent_tool_use_id: null, session_id: sessionId });
const result = (ok, extra = {}) => out({ type: 'result', subtype: ok ? 'success' : 'error_during_execution', is_error: !ok, duration_ms: 42, num_turns: 1, session_id: sessionId, ...(ok ? { result: 'done' } : {}), ...extra });

readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);

  if (msg.type === 'control_response' && pending && msg.response.request_id === pending.requestId) {
    const p = pending; pending = null;
    p.onAnswer(msg.response.response);
    return;
  }

  if (msg.type === 'control_request') {
    const sub = msg.request.subtype;
    if (sub === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [] } } });
      if (slow) { clearTimeout(slow); slow = null; }
      out({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
      result(false);
    } else if (sub === 'set_permission_mode') {
      mode = msg.request.mode;
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mode } } });
    }
    return;
  }

  if (msg.type !== 'user') return;
  turn++;
  const content = String(msg.message.content);
  out({ type: 'system', subtype: 'hook_started' });
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', cwd: process.cwd(), permissionMode: mode, args });
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1790000000 }, seven_day: { utilization: 0.5, resetsAt: 1790500000 } } } });

  if (content === 'crash') { process.exit(3); }

  if (content.startsWith('slow')) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_slow', name: 'Bash', input: { command: 'sleep 999' } }] } });
    slow = setTimeout(() => { text('never'); result(true); }, 60000);
    return;
  }

  if (content.startsWith('tool')) {
    const input = { file_path: 'C:\\tmp\\x.txt', content: '' };
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Write', input }] } });
    const requestId = `req-${turn}`;
    out({ type: 'control_request', request_id: requestId, request: {
      subtype: 'can_use_tool', tool_name: 'Write', input, description: 'tmp\\x.txt', tool_use_id: 'tu_1',
      permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } });
    pending = { requestId, onAnswer: r => {
      const ok = r.behavior === 'allow';
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: !ok, content: ok ? 'written' : r.message }] } });
      text(ok ? `ALLOWED${r.updatedPermissions ? ' +always' : ''}` : 'DENIED');
      result(true);
    } };
    return;
  }

  text(`echo: ${content} (mode=${mode})`);
  result(true);
});
