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
//   "editask <file>" -> asks to Edit (or Write) <file>, with the real tool call, and does it when allowed
//   "big <tokens>" -> a reply whose call used <tokens> of a 200k window
//   "mod"        -> a mod's log line, toast and status line, and its slash command (ui_*, commands_changed)
//   "/compact"   -> compacts the conversation (a compact_boundary, then a result)
//   "args"       -> replies with the command line it was started with (JSON)
//   "mcp <tool> <json>" -> calls a tool on the in-app MCP server (see crabmcp.js)
//                   and replies with its result; "mcp tools" lists them
//   "effort"     -> replies with the effort level it was last told (flag or apply_flag_settings)
//   (one-shot) a /btw side question: see SIDE below
//   "... FAKE_JSON:{...}" -> replies with that object in a ```json block
//   "steps <n> <ms> [late <ms>]" -> n tool calls in a row; see below for messages sent meanwhile
//   anything else -> replies "echo: <text>"
const readline = require('readline');

const args = process.argv.slice(2);
const sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : 'fake-session-1';
let mode = args.includes('--permission-mode') ? args[args.indexOf('--permission-mode') + 1] : 'default';
let turn = 0;
let pending = null;   // { requestId, onAnswer }
let slow = null;
const mcpWaiting = new Map(); // our control request id -> what to do with the answer
let mcpTools = null;           // from tools/list, once the in-app server answered
const deferred = [];           // user messages that arrived before it connected

// Like the real CLI: an in-app ("sdk") server named in --mcp-config is
// connected with mcp_message requests once the host's initialize names it.
// The config is JSON on the command line, or a file holding it.
const mcpArg = (() => {
  if (!args.includes('--mcp-config')) return null;
  const v = args[args.indexOf('--mcp-config') + 1];
  try { return JSON.parse(v.trimStart().startsWith('{') ? v : require('fs').readFileSync(v, 'utf8')); } catch { return null; }
})();
const sdkServer = mcpArg && Object.entries(mcpArg.mcpServers || {}).find(([, c]) => c.type === 'sdk')?.[0];
let mcpSeq = 0;
function mcpRequest(message, then) {
  const id = `mcp-${++mcpSeq}`;
  mcpWaiting.set(id, then);
  out({ type: 'control_request', request_id: id, request: { subtype: 'mcp_message', server_name: sdkServer, message } });
}
let workHooks = [];   // PreToolUse hookCallbackIds from an initialize request
let stepHooks = [];   // PostToolUse ones
let inbox = null;     // messages that came in while a "steps" turn runs, not yet read
const REPLAY = args.includes('--replay-user-messages');
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
// Like the real CLI with --replay-user-messages: each message echoed as it's read.
const echo = msg => { if (REPLAY) out({ type: 'user', message: msg.message, isReplay: true, session_id: sessionId }); };
const textOf = msg => (Array.isArray(msg.message.content) ? msg.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : String(msg.message.content));
// Messages left unread when a turn ends: the real CLI runs them next, as a turn of their own.
const runInbox = () => { const rest = inbox || []; inbox = null; for (const m of rest) onLine(JSON.stringify(m)); };

// `claude -p --output-format json --json-schema …` with the prompt on stdin: one
// structured answer, then exit. Workflow drafts get a one-step workflow. The
// editor's chat gets a scripted build: a first version that fails its test, a
// fix, then "it worked", so a screenshot run can watch Claude iterate.
// `claude -p --output-format json --no-session-persistence` with the question on
// stdin: a /btw side question (btw.js). Says which conversation it forked, so a
// test can tell it saw the conversation. "btw fail" -> an error result;
// "btw wait <ms>" -> answers after a delay.
const SIDE = args.includes('--no-session-persistence') && !args.includes('--json-schema');
if (SIDE) {
  let q = '';
  process.stdin.on('data', c => { q += c; });
  process.stdin.on('end', () => {
    const forked = args.includes('--resume') && args.includes('--fork-session') ? sessionId : null;
    const wait = /^btw wait (\d+)/.exec(q);
    setTimeout(() => out(/^btw fail/.test(q)
      ? { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'It went wrong.' }
      : { type: 'result', subtype: 'success', is_error: false, result: `side answer${forked ? ` (fork of ${forked})` : ''}: ${q.trim()}`, session_id: 'fake-btw' }), wait ? Number(wait[1]) : 0);
  });
}

const ONE_SHOT = args.includes('--json-schema') || SIDE;
if (args.includes('--json-schema')) {
  let prompt = '';
  process.stdin.on('data', c => { prompt += c; });
  process.stdin.on('end', () => {
    const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
    const hello = (extra = []) => JSON.stringify({
      name: 'Morning hello', description: 'Says good morning.',
      when: [{ type: 'schedule', schedule: { type: 'daily', time: '09:00' } }],
      steps: [{ id: 'hello', type: 'tell', to: 'crab', text: 'Good morning!' }, ...extra],
    });
    // The routine editor's chat: a draft to test, then "it worked".
    const morning = { name: 'Morning summary', prompt: 'List the files in this folder that changed since yesterday and sum them up in three bullets.', schedule: { type: 'weekly', time: '08:30', days: [1, 2, 3, 4, 5] }, mode: 'plan', folder: '', catchUp: true };
    // Describe it (a routine draft: "build fails" makes it a workflow's job) and Fix with Claude.
    // A draft's description comes as -p's argument, the rest on stdin.
    if (args[args.indexOf('-p') + 1] && !args[args.indexOf('-p') + 1].startsWith('--')) prompt += args[args.indexOf('-p') + 1];
    const job = { needs_workflow: /build fails/.test(prompt), why: /build fails/.test(prompt) ? 'It should start when a build fails, not on a clock.' : '' };
    let answer;
    if (schema.properties.schedule) answer = { ...morning, ...job };
    else if (schema.properties.routine && schema.properties.note) answer = { routine: { ...morning, prompt: 'List the files in Documents that changed since yesterday and sum them up in three bullets.' }, note: 'It looked in a folder that isn\'t there. I pointed it at Documents.' };
    else if (schema.properties.routine) {
      answer = prompt.includes('test run that just finished')
        ? { reply: 'The test run worked: it listed what changed and summed it up. Press Save to switch it on.', changed: false, routine: morning, test: false, needs_workflow: false, why: '' }
        : { reply: 'Set it for weekdays at 8:30, looking only, never changing anything. Let me test it.', changed: true, routine: morning, test: true, needs_workflow: false, why: '' };
    } else if (schema.properties.command && schema.properties.event) {
      // Toolbox → Hooks, Ask Claude: a hook that says when Claude finishes.
      answer = { event: 'Stop', matcher: '', command: "bash -c 'echo done'", timeout: 0, scope: 'user', title: 'Say done', note: 'Prints "done" each time Claude finishes replying.' };
    } else if (schema.properties.tickets) {
      // Next up reading Linear through an MCP server (backlog/trackers.js): one issue, only if it was asked through reading tools.
      const reading = /mcp__\w+__list_issues/.test(args[args.indexOf('--allowedTools') + 1] || '') && args[args.indexOf('--tools') + 1] === '';
      answer = reading
        ? { error: '', tickets: [{ key: 'ENG-7', title: 'Crab walks sideways', url: 'https://linear.app/crab/issue/ENG-7', status: 'Todo', priority: 'urgent', assignee: '', mine: false, labels: ['Bug'], due: '', current: true, updated: '', description: 'He should walk forwards when asked.' }] }
        : { error: 'Not asked through reading tools only.', tickets: [] };
    } else if (!schema.properties.reply) answer = { workflow_json: hello(), note: 'Says good morning every day at nine.' };
    else if (!prompt.includes('The test run that just finished')) {
      answer = { reply: 'Added a daily 9:00 trigger and a step where Shellby says good morning. Let me test it.', workflow_json: hello([{ id: 'check', type: 'stop', status: 'error', message: 'not finished yet' }]), test: true };
    } else if (/Status: error/.test(prompt)) {
      answer = { reply: 'The leftover Stop step failed the run. I took it out; testing again.', workflow_json: hello(), test: true };
    } else answer = { reply: 'The test run worked: Shellby said good morning. Press Save to switch it on.', workflow_json: '', test: false };
    out({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: answer });
  });
}

function onLine(line) {
  const msg = JSON.parse(line);

  // The real CLI connects its MCP servers before the first turn runs.
  if (msg.type === 'user' && sdkServer && mcpTools === null) { deferred.push(line); return; }
  if (msg.type === 'control_response' && mcpWaiting.has(msg.response.request_id)) {
    const then = mcpWaiting.get(msg.response.request_id);
    mcpWaiting.delete(msg.response.request_id);
    then(msg.response.response?.mcp_response);
    return;
  }

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
      runInbox();
    } else if (sub === 'initialize') {
      workHooks = msg.request.hooks?.PreToolUse?.flatMap(m => m.hookCallbackIds) || [];
      stepHooks = msg.request.hooks?.PostToolUse?.flatMap(m => m.hookCallbackIds) || [];
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
      if (sdkServer && (msg.request.sdkMcpServers || []).includes(sdkServer)) {
        mcpRequest({ method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} }, jsonrpc: '2.0', id: 0 }, () => {
          mcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, () => {});
          mcpRequest({ method: 'tools/list', jsonrpc: '2.0', id: 1 }, r => {
            mcpTools = r?.result?.tools || [];
            for (const l of deferred.splice(0)) onLine(l);
          });
        });
      }
    } else if (sub === 'set_permission_mode') {
      mode = msg.request.mode;
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mode } } });
    } else if (sub === 'apply_flag_settings') {
      effort = msg.request.settings?.effortLevel || '';
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    } else if (sub === 'mcp_status') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mcpServers: [{ name: 'github', status: 'connected' }, { name: 'broken', status: 'failed' }] } } });
    } else if (sub === 'get_usage') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {
        subscription_type: 'max', rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 42, resets_at: '2026-10-08T04:00:00+00:00' }, seven_day: { utilization: 7.6, resets_at: '2026-10-14T23:00:00+00:00' } },
      } } });
    } else {
      out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `Unsupported: ${sub}` } });
    }
    return;
  }

  if (msg.type !== 'user') return;
  if (inbox) { inbox.push(msg); return; } // read at the next step (see "steps")
  turn++;
  echo(msg);
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
  // "editask <file>" -> an Edit (or a Write, if the file is new) that asks first,
  // with the real tool call, and does it when allowed: the edit card's diff.
  if (content.startsWith('editask ')) {
    const fsx = require('fs');
    const file = require('path').join(process.cwd(), content.slice(8).trim());
    const before = fsx.existsSync(file) ? fsx.readFileSync(file, 'utf8') : null;
    const name = before == null ? 'Write' : 'Edit';
    const after = before == null ? 'hello\nworld\n' : before.replace(/^.*$/m, `changed in turn ${turn}`);
    const input = before == null ? { file_path: file, content: after } : { file_path: file, old_string: before.split('\n')[0], new_string: `changed in turn ${turn}` };
    const id = `tu_editask_${turn}`;
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null, session_id: sessionId });
    const requestId = `req-editask-${turn}`;
    out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: name, input, tool_use_id: id, permission_suggestions: [] } });
    pending = { requestId, onAnswer: r => {
      const ok = r.behavior === 'allow';
      if (ok) fsx.writeFileSync(file, after);
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !ok, content: ok ? `The file ${file} has been updated.` : r.message }] }, parent_tool_use_id: null, session_id: sessionId });
      text(ok ? 'EDITED' : 'NOT EDITED');
      result(true);
    } };
    return;
  }

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
  // What a mod says, as Claude Code 2.1.288 sends it: a log line, a toast, a
  // status line and the command list with the command it registered.
  if (content === 'mod') {
    const ui = (subtype, extra) => out({ type: 'system', subtype, plugin: 'e2e-mod', ...extra, uuid: `ui-${subtype}-${turn}`, session_id: sessionId });
    ui('ui_log', { text: 'saw the turn start' });
    ui('ui_toast', { text: 'hello from a mod', timeout_ms: 4000 });
    ui('ui_status', { text: 'watching 1 turn' });
    out({ type: 'system', subtype: 'commands_changed', commands: [{ name: 'e2e-hello', description: 'Says hello from the e2e mod.', argumentHint: '' }], uuid: `cmds-${turn}`, session_id: sessionId });
    text('echo: mod');
    result(true);
    return;
  }
  if (content.startsWith('look')) { text(`saw ${images.length}: ${images.map(i => i.source.media_type).join(',')}`); result(true); return; }
  // "gitenv" -> reports whether Shellby gave this process GitHub access
  if (content === 'args') { text(JSON.stringify(args)); result(true); return; }
  if (content.startsWith('mcp ')) {
    const [, tool, ...rest] = content.split(' ');
    if (tool === 'tools') { text(`tools: ${(mcpTools || []).map(t => t.name).join(',')}`); result(true); return; }
    mcpRequest({ method: 'tools/call', params: { name: tool, arguments: rest.length ? JSON.parse(rest.join(' ')) : {} }, jsonrpc: '2.0', id: 100 + turn }, r => {
      const res = r?.result || {};
      text(`mcp${res.isError ? ' error' : ''}: ${(res.content || []).map(c => c.text).join(' ')}`);
      result(true);
    });
    return;
  }
  // "novel <type>" -> an event type no Shellby knows, twice, then a normal reply
  if (content.startsWith('novel ')) {
    const type = content.split(' ')[1];
    out({ type, session_id: sessionId });
    out({ type, session_id: sessionId });
    text('still here');
    result(true);
    return;
  }
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
  // "crit <n> <file> <words...>" -> one turn that fixes a red suite: Jest with
  // <n> failing, then <words> written into <file>, then Jest all green. Paced so
  // Shellby's snapshot of each run sees the code it ran on (surprises.js).
  if (content.startsWith('crit ')) {
    const [, nText, file, ...words] = content.split(' ');
    const n = Math.max(1, Math.min(20, parseInt(nText, 10) || 1));
    const names = Array.from({ length: n }, (_, i) => `case ${i + 1}`);
    const red = `FAIL src/auth.spec.js\n  auth\n${names.map(t => `    ✕ ${t} (12 ms)`).join('\n')}\n\n${names.map(t => `  ● auth › ${t}\n\n    expected true, got false\n`).join('\n')}\nTest Suites: 1 failed, 1 total\nTests:       ${n} failed, 3 passed, ${n + 3} total`;
    const green = `PASS src/auth.spec.js\n\nTest Suites: 1 passed, 1 total\nTests:       ${n + 3} passed, ${n + 3} total`;
    const jest = (id, output) => {
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test 2>&1 | tail -40' } }] }, parent_tool_use_id: null, session_id: sessionId });
      setTimeout(() => out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: output }] }, parent_tool_use_id: null, session_id: sessionId }), 1200);
    };
    jest(`tu_crit_red_${turn}`, red);
    setTimeout(() => require('fs').writeFileSync(require('path').join(process.cwd(), file), `${words.join(' ')}\n`), 3000);
    setTimeout(() => jest(`tu_crit_green_${turn}`, green), 4500);
    setTimeout(() => { text(`fixed ${n}: all green`); result(true); }, 7500);
    return;
  }
  // "suite <n>" -> `npx jest` with <n> failing tests (0: all green), exiting as
  // Jest would: a bug battle's HP follows the failing count (bugdex/battle.js).
  if (content.startsWith('suite ')) {
    const n = Math.max(0, Math.min(20, parseInt(content.slice(6), 10) || 0));
    const names = Array.from({ length: n }, (_, i) => `case ${i + 1}`);
    const output = n
      ? `FAIL src/cart.spec.js\n  cart\n${names.map(t => `    ✕ ${t} (4 ms)`).join('\n')}\n\n  ● cart › case 1\n\n    expect(received).toBe(expected)\n\nTest Suites: 1 failed, 1 total\nTests:       ${n} failed, 3 passed, ${n + 3} total`
      : 'PASS src/cart.spec.js\n\nTest Suites: 1 passed, 1 total\nTests:       7 passed, 7 total';
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu_suite_${turn}`, name: 'Bash', input: { command: 'npx jest' } }] }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu_suite_${turn}`, is_error: n > 0, content: output }] }, parent_tool_use_id: null, session_id: sessionId });
    text(n ? `${n} failing` : 'all green');
    result(true);
    return;
  }
  // "patch <file> <words...>" -> an Edit tool call that writes <words> into <file> (a bug battle's Patch).
  if (content.startsWith('patch ')) {
    const [, file, ...words] = content.split(' ');
    const full = require('path').join(process.cwd(), file);
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu_patch_${turn}`, name: 'Edit', input: { file_path: full, old_string: 'x', new_string: words.join(' ') } }] }, parent_tool_use_id: null, session_id: sessionId });
    require('fs').writeFileSync(full, `${words.join(' ')}\n`);
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu_patch_${turn}`, content: 'edited' }] }, parent_tool_use_id: null, session_id: sessionId });
    text(`patched ${file}`);
    result(true);
    return;
  }
  // "read <file>" -> a Read of a file (a bug battle's Scout).
  if (content.startsWith('read ')) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu_read_${turn}`, name: 'Read', input: { file_path: content.slice(5).trim() } }] }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu_read_${turn}`, content: '1\tbroken' }] }, parent_tool_use_id: null, session_id: sessionId });
    text('read it');
    result(true);
    return;
  }
  // "bug <fixture>" -> a Bash call whose command, output and error flag come from
  // test/fixtures/bugdex/<fixture>.json (the Bugdex's e2e).
  if (content.startsWith('bug ')) {
    const name = content.slice(4).trim();
    const fx = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'bugdex', `${name.replace(/[^a-z0-9-]/g, '')}.json`), 'utf8'));
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu_bug_${turn}`, name: 'Bash', input: { command: fx.command } }] }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu_bug_${turn}`, is_error: !!fx.isError, content: fx.output }] }, parent_tool_use_id: null, session_id: sessionId });
    text(`ran: ${fx.command}`);
    result(true);
    return;
  }
  // "delete <file>" -> removes a file from the working folder
  if (content.startsWith('delete ')) {
    require('fs').rmSync(require('path').join(process.cwd(), content.slice(7).trim()), { force: true });
    text(`deleted ${content.slice(7).trim()}`);
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

  // "steps <n> <ms>" -> n Bash calls in a row, <ms> each, each followed by a
  // registered PostToolUse hook. A message that comes in meanwhile is read
  // after the next step's result, like the real CLI (echoed, then the reply
  // says what it read); one in after the last step runs as a turn of its own.
  // "... late <ms>" waits that long between a step's hook and its result: a
  // window for Stop to land in before Claude reads what the hook let in.
  if (content.startsWith('steps ')) {
    const [, n, ms, , late] = content.split(' ');
    inbox = [];
    let k = 0;
    const end = t => { slow = null; text(t); result(true); runInbox(); };
    const step = () => {
      const id = `tu_step_${turn}_${++k}`;
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `step ${k}` } }] }, parent_tool_use_id: null, session_id: sessionId });
      const finish = () => {
        slow = setTimeout(() => {
          out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: `step ${k} ok` }] }, parent_tool_use_id: null, session_id: sessionId });
          const read = inbox.splice(0);
          read.forEach(echo);
          if (read.length) return end(`steered: ${read.map(textOf).join(' | ')}`);
          if (k < Number(n)) return step();
          end('steps done');
        }, Number(late) || 0);
      };
      slow = setTimeout(() => {
        if (!stepHooks.length) return finish();
        const requestId = `req-step-${turn}-${k}`;
        out({ type: 'control_request', request_id: requestId, request: { subtype: 'hook_callback', callback_id: stepHooks[0], input: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: id } } });
        pending = { requestId, onAnswer: finish };
      }, Number(ms) || 200);
    };
    step();
    return;
  }

  if (content.startsWith('slow')) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_slow', name: 'Bash', input: { command: 'sleep 999' } }] } });
    slow = setTimeout(() => { text('never'); result(true); }, 60000);
    return;
  }

  if (content.startsWith('review crew')) {
    // A code-reviewer helper that reports back, then Claude acts on it with an
    // edit of its own: the crew member's run, and a finding acted on (crew-roster.js).
    out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu_rev', name: 'Agent', input: { subagent_type: 'code-reviewer', description: 'Review the diff', prompt: 'review it' } }] } });
    out({ type: 'system', subtype: 'task_started', task_id: `rev-${turn}`, tool_use_id: 'tu_rev', description: 'Review the diff', subagent_type: 'code-reviewer', is_backgrounded: false, spawn_depth: 1 });
    setTimeout(() => {
      out({ type: 'system', subtype: 'task_notification', task_id: `rev-${turn}`, tool_use_id: 'tu_rev', status: 'completed', summary: 'one bug on line 3', usage: { total_tokens: 1800, tool_uses: 4, duration_ms: 900 } });
      out({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu_rev', content: [{ type: 'text', text: 'one bug on line 3' }] }] } });
      out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu_fix', name: 'Edit', input: { file_path: 'C:\\tmp\\a.js', old_string: 'a', new_string: 'b' } }] } });
      out({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu_fix', content: 'edited' }] } });
      text('REVIEW FIXED');
      result(true);
    }, Number(process.env.SHELLBY_FAKE_REVIEW_MS || 400));
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

  if (content.startsWith('askdelete')) {
    // Asks to delete a file outside the project: plain words and a warning on the card (plain-words.js).
    const input = { command: 'Remove-Item C:\\Users\\someone\\notes.txt', description: 'Remove the old notes' };
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_del', name: 'PowerShell', input }] } });
    out({ type: 'control_request', request_id: `req-del-${turn}`, request: { subtype: 'can_use_tool', tool_name: 'PowerShell', input, tool_use_id: 'tu_del', permission_suggestions: [] } });
    pending = { requestId: `req-del-${turn}`, onAnswer: r => {
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_del', is_error: r.behavior !== 'allow', content: 'done' }] } });
      text(r.behavior === 'allow' ? 'DELETED' : 'KEPT');
      result(true);
    } };
    return;
  }

  if (content.startsWith('askplan')) {
    // Plan mode's ExitPlanMode: the plan card and its size.
    const input = { plan: '## Plan\n1. Add `src/a.js`\n2. Change `src/b.js`\n3. Run the tests' };
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_plan', name: 'ExitPlanMode', input }] } });
    out({ type: 'control_request', request_id: `req-plan-${turn}`, request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input, tool_use_id: 'tu_plan', permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } });
    pending = { requestId: `req-plan-${turn}`, onAnswer: r => {
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_plan', is_error: r.behavior !== 'allow', content: 'ok' }] } });
      text(r.behavior === 'allow' ? 'PLAN APPROVED' : 'STILL PLANNING');
      result(true);
    } };
    return;
  }

  if (content.startsWith('longtests')) {
    // A test run that takes a while: the Working bar says what it's doing meanwhile.
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_lt', name: 'Bash', input: { command: 'npm test', description: 'Run the test suite' } }] } });
    setTimeout(() => {
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_lt', content: 'all passed' }] } });
      text('TESTS DONE');
      result(true);
    }, 2500);
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
}

if (!ONE_SHOT) readline.createInterface({ input: process.stdin }).on('line', onLine);
