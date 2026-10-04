// A stand-in for `claude -p --input-format stream-json ...` that speaks the same
// stdin/stdout protocol, so session tests run without a real Claude account.
//
// Behaviour per user message:
//   "tool ..."   -> asks permission for a Write; replies ALLOWED/DENIED
//   "slow ..."   -> starts a long tool call and waits (use with interrupt)
//   "crash"      -> exits with code 3 mid-turn
//   "wait <ms>"  -> replies "echo: ..." after a delay
//   "fail"       -> ends the turn with an error
//   "edit <file> <words>" -> writes <words> into <file> in its working folder
//   "editabs <path> <words>" -> writes to that absolute path, if a work hook allows it
//   "big <tokens>" -> a reply whose call used <tokens> of a 200k window
//   "/compact"   -> compacts the conversation (a compact_boundary, then a result)
//   "args"       -> replies with the command line it was started with (JSON)
//   "effort"     -> replies with the effort level it was last told (flag or apply_flag_settings)
//   "... FAKE_JSON:{...}" -> replies with that object in a ```json block
//   anything else -> replies "echo: <text>"
const readline = require('readline');

const args = process.argv.slice(2);
const sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : 'fake-session-1';
let mode = args.includes('--permission-mode') ? args[args.indexOf('--permission-mode') + 1] : 'default';
let turn = 0;
let pending = null;   // { requestId, onAnswer }
let slow = null;
let workHooks = [];   // PreToolUse hookCallbackIds from an initialize request
let effort = args.includes('--effort') ? args[args.indexOf('--effort') + 1] : '';

// Like the real CLI, it keeps the conversation under <config>/projects/<folder>/<id>.jsonl,
// so Shellby can carry it into a copy and it can carry on there. Only for a
// config folder under temp: a test run never writes into a real ~/.claude.
const transcript = (() => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = process.env.CLAUDE_CONFIG_DIR;
  let tmp;
  try { tmp = fs.realpathSync.native(os.tmpdir()).toLowerCase() + path.sep; } catch { return null; }
  if (!dir || !fs.existsSync(dir) || !(fs.realpathSync.native(dir).toLowerCase() + path.sep).startsWith(tmp)) return null;
  return path.join(dir, 'projects', path.resolve(process.cwd()).replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
})();
const remember = entry => {
  if (!transcript) return;
  require('fs').mkdirSync(require('path').dirname(transcript), { recursive: true });
  require('fs').appendFileSync(transcript, JSON.stringify(entry) + '\n');
};
// The edit a hook held back, if the last thing in the transcript is one. The
// { sessionId, text } lines kept for branching are written as each message
// arrives, so they're skipped: they'd always be last.
const heldEdit = () => {
  try {
    const last = require('fs').readFileSync(transcript, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => !e.sessionId).pop();
    return last?.held || null;
  } catch { return null; }
};

const out = obj => process.stdout.write(JSON.stringify(obj) + '\n');
let messages = 0;
// Real replies carry an id, model and token counts (the usage-by-project ledger reads them).
const text = t => out({ type: 'assistant', message: { id: `msg_fake_${++messages}`, model: 'claude-sonnet-5-5', usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 9000 }, content: [{ type: 'text', text: t }] }, parent_tool_use_id: null, session_id: sessionId, uuid: `uuid-${sessionId}-${messages}` });
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
    } else if (sub === 'initialize') {
      workHooks = msg.request.hooks?.PreToolUse?.flatMap(m => m.hookCallbackIds) || [];
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    } else if (sub === 'set_permission_mode') {
      mode = msg.request.mode;
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mode } } });
    } else if (sub === 'apply_flag_settings') {
      effort = msg.request.settings?.effortLevel || '';
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    } else if (sub === 'mcp_status') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mcpServers: [{ name: 'github', status: 'connected' }, { name: 'broken', status: 'failed' }] } } });
    } else {
      out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `Unsupported: ${sub}` } });
    }
    return;
  }

  if (msg.type !== 'user') return;
  turn++;
  // A message with pictures in it is a list of blocks: the text is in the text one(s).
  // A note from Shellby about where a branch now is comes first, as a block of
  // its own: it's acknowledged on its own line, and the message itself is what
  // the behaviours below act on.
  let blocks = Array.isArray(msg.message.content) ? msg.message.content : null;
  const note = blocks?.[0]?.type === 'text' && blocks.length > 1 && blocks[0].text.startsWith('Shellby has branched') ? blocks[0].text : null;
  if (note) blocks = blocks.slice(1);
  const content = blocks ? blocks.filter(b => b.type === 'text').map(b => b.text).join('\n') : String(msg.message.content);
  const images = blocks ? blocks.filter(b => b.type === 'image') : [];
  // Like the real CLI, keep the conversation where it would be resumed from
  // (only when told where: CLAUDE_CONFIG_DIR), so branching can find it.
  if (process.env.CLAUDE_CONFIG_DIR) {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', path.resolve(process.cwd()).replace(/[^a-zA-Z0-9]/g, '-'));
    try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ sessionId, text: content })}\n`); } catch { /* best effort */ }
  }
  out({ type: 'system', subtype: 'hook_started' });
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', cwd: process.cwd(), permissionMode: mode, args });
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1790000000 }, seven_day: { utilization: 0.5, resetsAt: 1790500000 } } } });

  if (note) text(`noted: ${note}`);
  if (content === 'crash') { process.exit(3); }
  // "editabs <absolute path> <words...>" -> a Write to that exact path, asked of
  // a registered PreToolUse hook first (a branch's fence); refused, it says why.
  if (content.startsWith('editabs ')) {
    const [, file, ...words] = content.split(' ');
    const write = () => { require('fs').writeFileSync(file, `${words.join(' ')}\n`); text(`wrote ${file}`); result(true); };
    if (!workHooks.length) return write();
    const requestId = `req-hook-${turn}`;
    out({ type: 'control_request', request_id: requestId, request: { subtype: 'hook_callback', callback_id: workHooks[0], input: { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: words.join(' ') } } } });
    pending = {
      requestId,
      onAnswer: r => {
        if (r?.hookSpecificOutput?.permissionDecision !== 'deny') return write();
        text(`fenced: ${r.hookSpecificOutput.permissionDecisionReason}`);
        result(true);
      },
    };
    return;
  }
  // "edit <file> <words...>" -> writes <words> into <file> in the working folder,
  // the way a real turn changes code (for the turn's diff and worktrees). A
  // registered PreToolUse hook is asked first; held back, it answers
  // "Branch: add-greeting" instead, and makes the edit when told to carry on.
  const carried = /carry on/i.test(content) && heldEdit();
  if (content.startsWith('edit ') || carried) {
    const [, file, ...words] = (carried || content).split(' ');
    remember({ user: content });
    const write = () => {
      require('fs').writeFileSync(require('path').join(process.cwd(), file), `${words.join(' ')}\n`);
      remember({ edited: file });
      text(`edited ${file}`);
      result(true);
    };
    if (!workHooks.length) return write();
    const requestId = `req-hook-${turn}`;
    out({ type: 'control_request', request_id: requestId, request: { subtype: 'hook_callback', callback_id: workHooks[0], input: { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: words.join(' ') } } } });
    pending = {
      requestId,
      onAnswer: r => {
        if (r?.hookSpecificOutput?.permissionDecision !== 'deny') return write();
        remember({ held: carried || content });
        text('Branch: add-greeting');
        result(true);
      },
    };
    return;
  }
  // "limit <seconds>" -> the plan's 5-hour limit is reached and resets in <seconds>
  if (content.startsWith('limit')) {
    const resetsAt = Math.round(Date.now() / 1000) + (parseInt(content.split(' ')[1], 10) || 60);
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', unifiedWindows: { five_hour: { utilization: 1, resetsAt }, seven_day: { utilization: 0.6, resetsAt: resetsAt + 86400 } } } });
    result(false, { result: 'Claude AI usage limit reached' });
    return;
  }

  // "big <tokens>" -> the conversation now fills <tokens> of a 200k context window
  if (content.startsWith('big ')) {
    const tokens = parseInt(content.split(' ')[1], 10) || 1000;
    out({ type: 'assistant', message: { id: `msg_fake_${++messages}`, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 110, output_tokens: 100 }, content: [{ type: 'text', text: `big: ${tokens}` }] }, parent_tool_use_id: null, session_id: sessionId });
    result(true, { modelUsage: { 'claude-sonnet-5-5': { inputTokens: 10, outputTokens: 100, contextWindow: 200000 } } });
    return;
  }
  if (content === '/compact') {
    out({ type: 'system', subtype: 'compact_boundary', session_id: sessionId, compact_metadata: { trigger: 'manual', pre_tokens: 170000 } });
    result(true);
    return;
  }

  // "... FAKE_JSON:{...}" anywhere -> replies with that object in a ```json
  // block, the way a workflow's Claude step asks for its output fields.
  const fakeJson = /FAKE_JSON:(\{[^\n]*\})/.exec(content);
  if (fakeJson) { text(`Here you go.\n\`\`\`json\n${fakeJson[1]}\n\`\`\``); result(true); return; }
  // "look ..." -> says how many pictures came with the message, and what kind
  if (content.startsWith('look')) { text(`saw ${images.length}: ${images.map(i => i.source.media_type).join(',')}`); result(true); return; }
  // "gitenv" -> reports whether Shellby gave this process GitHub access
  if (content === 'args') { text(JSON.stringify(args)); result(true); return; }
  if (content === 'effort') { text(`effort:${effort || 'default'}`); result(true); return; }
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

  // "jest pass" / "jest fail <test>" -> `npm test 2>&1 | tail -40` printing a Jest summary.
  // Piped like that it always exits 0: only the summary says whether it passed (flaky.js).
  if (content === 'jest pass' || content.startsWith('jest fail ')) {
    const failing = content.startsWith('jest fail ') ? content.slice(10) : null;
    const output = failing
      ? `FAIL src/auth.spec.js\n  auth\n    ✕ ${failing} (5004 ms)\n\n  ● auth › ${failing}\n\n    thrown: "Exceeded timeout of 5000 ms for a test."\n\nTest Suites: 1 failed, 1 total\nTests:       1 failed, 3 passed, 4 total`
      : 'PASS src/auth.spec.js\n\nTest Suites: 1 passed, 1 total\nTests:       4 passed, 4 total';
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu_jest_${turn}`, name: 'Bash', input: { command: 'npm test 2>&1 | tail -40' } }] }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu_jest_${turn}`, is_error: false, content: output }] }, parent_tool_use_id: null, session_id: sessionId });
    text(failing ? `1 test failed: ${failing}` : 'all tests passed');
    result(true);
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
