// A stand-in for `claude -p --input-format stream-json ...` that speaks the same
// stdin/stdout protocol, so session tests run without a real Claude account.
//
// Behaviour per user message:
//   "tool ..."   -> asks permission for a Write; replies ALLOWED/DENIED
//   "slow ..."   -> starts a long tool call and waits (use with interrupt)
//   "crash"      -> exits with code 3 mid-turn
//   "wait <ms>"  -> replies "echo: ..." after a delay
//   "fail"       -> ends the turn with an error
//   anything else -> replies "echo: <text>"
//   "edit <name>" -> asks to edit (or create) <name> in the working folder
// With --replay-user-messages each message is echoed back with a uuid, and
// rewind_files puts files back the way they were before that message.
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const args = process.argv.slice(2);
const replay = args.includes('--replay-user-messages');
const checkpoints = []; // [{ uuid, files: Map(path -> contents before, or null if it didn't exist) }]
const touched = file => {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  for (const c of checkpoints) if (!c.files.has(file)) c.files.set(file, before);
};
const lines = s => (s ? s.split('\n').filter(Boolean).length : 0);
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
    } else if (sub === 'rewind_files') {
      const c = checkpoints.find(x => x.uuid === msg.request.user_message_id);
      const now = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
      const changed = c ? [...c.files].filter(([f, was]) => now(f) !== was) : [];
      let response;
      if (!c) response = { canRewind: false, error: 'No file checkpoint found for this message.' };
      else if (msg.request.dry_run) {
        response = { canRewind: true, filesChanged: changed.map(([f]) => f),
          insertions: changed.reduce((n, [, was]) => n + lines(was), 0), deletions: changed.reduce((n, [f]) => n + lines(now(f)), 0) };
      } else {
        for (const [f, was] of changed) { if (was == null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, was); }
        response = { canRewind: true, skippedLinks: 0 };
      }
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
    } else if (sub === 'get_usage') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {
        subscription_type: 'max', rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 42, resets_at: '2026-10-08T04:00:00+00:00' }, seven_day: { utilization: 7.6, resets_at: '2026-10-14T23:00:00+00:00' } },
      } } });
    }
    return;
  }

  if (msg.type !== 'user') return;
  turn++;
  const content = String(msg.message.content);
  if (replay) {
    const uuid = randomUUID();
    checkpoints.push({ uuid, files: new Map() });
    out({ type: 'user', message: { role: 'user', content: msg.message.content }, session_id: sessionId, parent_tool_use_id: null, uuid, isReplay: true });
  }
  out({ type: 'system', subtype: 'hook_started' });
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', cwd: process.cwd(), permissionMode: mode, args });
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1790000000 }, seven_day: { utilization: 0.5, resetsAt: 1790500000 } } } });

  if (content === 'crash') { process.exit(3); }
  // "limit <seconds>" -> the plan's 5-hour limit is reached and resets in <seconds>
  if (content.startsWith('limit')) {
    const resetsAt = Math.round(Date.now() / 1000) + (parseInt(content.split(' ')[1], 10) || 60);
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', unifiedWindows: { five_hour: { utilization: 1, resetsAt }, seven_day: { utilization: 0.6, resetsAt: resetsAt + 86400 } } } });
    result(false, { result: 'Claude AI usage limit reached' });
    return;
  }

  // "gitenv" -> reports whether Shellby gave this process GitHub access
  if (content === 'gitenv') { text(`gh:${process.env.GH_TOKEN ? 'yes' : 'no'} mcp:${process.env.GITHUB_PERSONAL_ACCESS_TOKEN ? 'yes' : 'no'} helpers:${process.env.GIT_CONFIG_COUNT || 0}`); result(true); return; }
  // "wait <ms> ..." -> replies after a delay (a turn you can queue messages behind)
  if (content.startsWith('wait ')) {
    const ms = Math.min(30000, parseInt(content.split(' ')[1], 10) || 1000);
    setTimeout(() => { text(`echo: ${content}`); result(true); }, ms);
    return;
  }
  // "ask" / "ask2" -> Claude asks one (or two) multiple-choice questions via
  // AskUserQuestion, then repeats back the answers it was given.
  if (content === 'ask' || content === 'ask2') {
    const questions = [{ question: 'Which color do you like?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'Warm and loud' }, { label: 'Blue', description: 'Calm, like the sea' }] }];
    if (content === 'ask2') questions.push({ question: 'Which snacks?', header: 'Snacks', multiSelect: true, options: [{ label: 'Chips', description: '' }, { label: 'Fruit', description: '' }, { label: 'Nuts', description: '' }] });
    const requestId = `req-ask-${turn}`;
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu_ask_${turn}`, name: 'AskUserQuestion', input: { questions } }] }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: `tu_ask_${turn}`, input: { questions }, permission_suggestions: [] } });
    pending = {
      requestId,
      onAnswer: r => {
        text(r.behavior === 'allow' ? `answers: ${JSON.stringify(r.updatedInput?.answers || {})}` : `skipped: ${r.message}`);
        result(true);
      },
    };
    return;
  }

  // "run <command>" -> runs it with the Bash tool; it "fails" if the command contains "FAIL"
  if (content.startsWith('run ')) {
    const command = content.slice(4);
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu_run_${turn}`, name: 'Bash', input: { command } }] }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu_run_${turn}`, is_error: command.includes('FAIL'), content: command.includes('FAIL') ? 'Exit code 1' : 'ok' }] }, parent_tool_use_id: null, session_id: sessionId });
    text(`ran: ${command}`);
    result(true);
    return;
  }
  // "fail [ms]" -> the turn ends with an error (optionally after a delay)
  if (content === 'fail' || content.startsWith('fail ')) {
    const ms = Math.min(30000, parseInt(content.split(' ')[1], 10) || 0);
    setTimeout(() => { text('something broke'); result(false); }, ms);
    return;
  }

  if (content.startsWith('slow')) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_slow', name: 'Bash', input: { command: 'sleep 999' } }] } });
    slow = setTimeout(() => { text('never'); result(true); }, 60000);
    return;
  }

  if (content.startsWith('crew')) {
    // A subagent that needs permission, with the real CLI's event shapes.
    out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu_agent', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Write crew file', prompt: 'write it' } }] } });
    out({ type: 'system', subtype: 'task_started', task_id: 'agent-1', tool_use_id: 'tu_agent', description: 'Write crew file', subagent_type: 'general-purpose', is_backgrounded: false, spawn_depth: 1 });
    out({ type: 'system', subtype: 'task_progress', task_id: 'agent-1', tool_use_id: 'tu_agent', description: 'Writing crew.txt', subagent_type: 'general-purpose', usage: { total_tokens: 100, tool_uses: 1, duration_ms: 50 }, last_tool_name: 'Write' });
    const input = { file_path: 'C:\\tmp\\crew.txt', content: 'crew' };
    out({ type: 'assistant', parent_tool_use_id: 'tu_agent', message: { content: [{ type: 'tool_use', id: 'tu_sub', name: 'Write', input }] } });
    const requestId = `req-crew-${turn}`;
    out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Write', input, tool_use_id: 'tu_sub', agent_id: 'agent-1', permission_suggestions: [] } });
    pending = { requestId, onAnswer: r => {
      const ok = r.behavior === 'allow';
      out({ type: 'user', parent_tool_use_id: 'tu_agent', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_sub', is_error: !ok, content: ok ? 'ok' : r.message }] } });
      out({ type: 'system', subtype: 'task_updated', task_id: 'agent-1', patch: { status: 'completed' } });
      out({ type: 'system', subtype: 'task_notification', task_id: 'agent-1', tool_use_id: 'tu_agent', status: 'completed', summary: ok ? 'wrote it' : 'was denied', usage: { total_tokens: 200, tool_uses: 1, duration_ms: 90 } });
      out({ type: 'user', parent_tool_use_id: null, tool_use_result: { agentId: 'agent-1', totalDurationMs: 90, totalTokens: 200, totalToolUseCount: 1 }, message: { content: [{ type: 'tool_result', tool_use_id: 'tu_agent', content: [{ type: 'text', text: ok ? 'wrote it' : 'was denied' }] }] } });
      text(ok ? 'CREW OK' : 'CREW DENIED');
      result(true);
    } };
    return;
  }

  if (content.startsWith('script')) {
    // Writes a script, then asks to run it: the second prompt should be flagged.
    const writeInput = { file_path: 'C:\\tmp\\tools\\cleanup.ps1', content: 'Remove-Item x' };
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_w', name: 'Write', input: writeInput }] } });
    out({ type: 'control_request', request_id: `req-w-${turn}`, request: { subtype: 'can_use_tool', tool_name: 'Write', input: writeInput, tool_use_id: 'tu_w', permission_suggestions: [] } });
    pending = { requestId: `req-w-${turn}`, onAnswer: () => {
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_w', content: 'written' }] } });
      const runInput = { command: 'powershell -File .\\tools\\cleanup.ps1' };
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_r', name: 'PowerShell', input: runInput }] } });
      out({ type: 'control_request', request_id: `req-r-${turn}`, request: { subtype: 'can_use_tool', tool_name: 'PowerShell', input: runInput, tool_use_id: 'tu_r', permission_suggestions: [] } });
      pending = { requestId: `req-r-${turn}`, onAnswer: r => {
        out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_r', is_error: r.behavior !== 'allow', content: 'ran' }] } });
        text('SCRIPT DONE');
        result(true);
      } };
    } };
    return;
  }

  // "edit <name>" -> asks to Edit (or Write, if it's new) a real file in the
  // working folder, and does it when allowed: something "Rewind files" can undo.
  if (content.startsWith('edit ')) {
    const file = path.join(process.cwd(), content.slice(5).trim());
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const name = before == null ? 'Write' : 'Edit';
    const after = before == null ? 'hello\nworld\n' : before.replace(/^.*$/m, `changed in turn ${turn}`);
    const input = before == null ? { file_path: file, content: after } : { file_path: file, old_string: before.split('\n')[0], new_string: `changed in turn ${turn}` };
    const id = `tu_edit_${turn}`;
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null, session_id: sessionId });
    const requestId = `req-edit-${turn}`;
    out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: name, input, tool_use_id: id, permission_suggestions: [] } });
    pending = { requestId, onAnswer: r => {
      const ok = r.behavior === 'allow';
      if (ok) { touched(file); fs.writeFileSync(file, after); }
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !ok, content: ok ? `The file ${file} has been updated.` : r.message }] }, parent_tool_use_id: null, session_id: sessionId });
      text(ok ? 'EDITED' : 'NOT EDITED');
      result(true);
    } };
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
