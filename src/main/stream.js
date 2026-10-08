// Turns Claude Code stream-json events into a small set of UI items.
// Pure functions: no Electron, no I/O — see test/stream.test.js.

const { clean } = require('./mods');
const { editsOf } = require('../renderer/shared/diff');
const plainWords = require('./plain-words');

const MAX_RESULT_CHARS = 8000;

const TOOL_VERBS = {
  Bash: 'Ran', PowerShell: 'Ran', Read: 'Read', Write: 'Created', Edit: 'Edited',
  MultiEdit: 'Edited', NotebookEdit: 'Edited', Glob: 'Searched files', Grep: 'Searched for',
  WebFetch: 'Fetched', WebSearch: 'Searched the web', Task: 'Delegated', Agent: 'Delegated',
  TodoWrite: 'Updated plan', ExitPlanMode: 'Proposed a plan', Skill: 'Used skill',
  AskUserQuestion: 'Asked you',
};

// The crab's own tools, as served to Shellby's conversations (crabmcp.js):
// verb, and which input field is worth showing.
const SHELLBY_TOOLS = {
  say: ['Shellby said', 'text'], celebrate: ['Celebrated', 'reason'], wear: ['Dressed Shellby', 'item'],
  status: ['Checked on Shellby', null], suggest: ['Suggested', 'feature'],
};

/**
 * Claude's AskUserQuestion input, cleaned up for the question card:
 * [{ question, header, multiSelect, options: [{ label, description }] }]
 */
function questionsOf(input) {
  const list = Array.isArray(input?.questions) ? input.questions : [];
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  return list.slice(0, 6).filter(q => q && typeof q.question === 'string' && q.question.trim()).map(q => ({
    question: str(q.question, 500),
    header: str(q.header, 40),
    multiSelect: !!q.multiSelect,
    options: (Array.isArray(q.options) ? q.options : []).slice(0, 8)
      .filter(o => o && typeof o.label === 'string' && o.label.trim())
      .map(o => ({ label: str(o.label, 120), description: str(o.description, 300) })),
  }));
}

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s;
}

function describeTool(name = '', input = {}) {
  const i = input || {};
  if (name === 'AskUserQuestion') {
    const qs = questionsOf(i);
    return { label: TOOL_VERBS.AskUserQuestion, detail: qs.map(q => q.question).join(' · ').slice(0, 400) || 'a question' };
  }
  const own = /^mcp__shellby__(\w+)$/.exec(name);
  if (own && SHELLBY_TOOLS[own[1]]) {
    const [label, field] = SHELLBY_TOOLS[own[1]];
    return { label, detail: field && typeof i[field] === 'string' ? i[field].replace(/\s+/g, ' ').trim().slice(0, 400) : '' };
  }
  let detail =
    i.command ?? i.file_path ?? i.notebook_path ??
    (i.pattern != null ? `${i.pattern}${i.path ? ` in ${i.path}` : ''}` : null) ??
    i.path ?? i.url ?? i.query ?? i.description ?? i.skill ?? i.prompt ?? null;
  if (detail == null) {
    const json = JSON.stringify(i);
    detail = json === '{}' ? '' : json;
  }
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  const label = TOOL_VERBS[name] || (mcp ? `${mcp[2]} (${mcp[1]})` : name);
  return { label, detail: String(detail).replace(/\s+/g, ' ').trim().slice(0, 400) };
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : '')).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function usageFrom(ev) {
  const info = ev.rate_limit_info || {};
  const w = info.unifiedWindows || {};
  const win = x => (x && typeof x.utilization === 'number'
    ? { pct: Math.round(x.utilization * 100), resetsAt: x.resetsAt ? x.resetsAt * 1000 : null }
    : null);
  return { kind: 'usage', status: info.status || null, fiveHour: win(w.five_hour), sevenDay: win(w.seven_day) };
}

// A result's token counts for the whole turn, or null when it has none.
function tokensOf(u) {
  if (!u || typeof u !== 'object') return null;
  const n = v => (Number.isFinite(v) && v > 0 ? v : 0);
  const t = { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) };
  return t.input + t.output + t.cacheRead + t.cacheWrite ? t : null;
}

// What one API call cost, for the usage-by-project ledger (spend.js). Claude Code
// sends one assistant event per content block, each repeating the message's id
// and usage, so callers count each id once (session.js).
function spendFrom(ev) {
  const m = ev?.type === 'assistant' ? ev.message : null;
  if (!m || typeof m.id !== 'string' || !m.usage || typeof m.usage !== 'object') return null;
  return { messageId: m.id, model: typeof m.model === 'string' ? m.model : null, usage: m.usage };
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);

const strings = a => (Array.isArray(a) ? a.filter(s => typeof s === 'string') : []);

function writtenPath(name, input) {
  if (!WRITE_TOOLS.has(name) || !input) return null;
  const p = input.file_path ?? input.notebook_path;
  return typeof p === 'string' ? p : null;
}

/** How much text a write tool is about to put on disk (0 for anything else). */
function writeChars(name, input) {
  if (!WRITE_TOOLS.has(name) || !input) return 0;
  if (name === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return edits.reduce((n, e) => n + String(e?.new_string ?? '').length, 0);
  }
  const text = input.content ?? input.new_string ?? input.new_source;
  return typeof text === 'string' ? text.length : 0;
}

function toolItem(b, sub) {
  const input = b.input || {};
  const item = { kind: 'tool', id: b.id, name: b.name, ...describeTool(b.name, input), ...sub };
  if (b.name === 'ExitPlanMode') item.plan = input.plan;
  // What it's doing, in plain words, for the Working bar (plain-words.js).
  const plain = plainWords.describe(b.name, input);
  if (plain) item.doing = plain.doing;
  // Its result only says it started: not a finished run (flaky.js).
  if ((b.name === 'Bash' || b.name === 'PowerShell') && input.run_in_background === true) item.background = true;
  const fp = writtenPath(b.name, input);
  if (fp) { item.filePath = fp; item.writeChars = writeChars(b.name, input); item.edits = editsOf(b.name, input); }
  if (AGENT_TOOLS.has(b.name)) {
    item.agent = {
      type: typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose',
      description: typeof input.description === 'string' ? input.description : '',
      background: !!input.run_in_background,
    };
  }
  return item;
}

// task_* system events describe subagent lifecycles. task_id is the id that
// permission requests from that subagent carry as agent_id; tool_use_id is the
// Agent tool call it belongs to (= parent_tool_use_id of its messages).
function taskItem(ev) {
  const phase = { task_started: 'started', task_progress: 'progress', task_updated: 'updated', task_notification: 'done' }[ev.subtype];
  const u = ev.usage || {};
  const item = { kind: 'task', phase, taskId: ev.task_id || null, toolUseId: ev.tool_use_id || null };
  if (ev.description) item.description = String(ev.description).slice(0, 200);
  if (ev.subagent_type) item.subagentType = ev.subagent_type;
  if (phase === 'started') { item.background = !!ev.is_backgrounded; item.depth = ev.spawn_depth ?? 1; }
  if (ev.last_tool_name) item.lastTool = ev.last_tool_name;
  if (ev.usage) item.usage = { tokens: u.total_tokens ?? null, toolUses: u.tool_uses ?? null, durationMs: u.duration_ms ?? null };
  const status = ev.status ?? ev.patch?.status;
  if (status) item.status = status;
  if (ev.summary) item.summary = truncate(ev.summary, 4000);
  return item;
}

// What a mod shows (mods.js): $.ui.log is a line in the conversation, $.ui.toast
// a toast, $.ui.status its line under the box (empty clears it). Claude Code
// sends each with the plugin's name, which is shown with it, so a mod can't
// pass its words off as Claude's or Shellby's.
const MOD_UI = { ui_log: 'modlog', ui_toast: 'modtoast', ui_status: 'modstatus' };
const MAX_MOD_TEXT = 500;
const MAX_COMMANDS = 1000;
// What the / menu can show as a command: no spaces, no line breaks, nothing that hides.
const COMMAND_NAME = /^[\w:.-]{1,120}$/;
// One line: no control, bidi-override or zero-width characters (mods.js).
const oneLine = clean;

function modItem(ev) {
  const plugin = oneLine(ev.plugin, 80);
  if (!plugin) return [];
  const text = oneLine(ev.text, MAX_MOD_TEXT);
  const kind = MOD_UI[ev.subtype];
  if (kind === 'modstatus') return [{ kind, plugin, text: text || null }];
  if (!text) return [];
  if (kind === 'modtoast') return [{ kind, plugin, text, ms: Number.isFinite(ev.timeout_ms) ? Math.min(Math.max(ev.timeout_ms, 1500), 15000) : 4000 }];
  return [{ kind, plugin, text }];
}

// Returns an array of UI items for one parsed stream-json event.
function toItems(ev) {
  if (!ev || typeof ev !== 'object') return [];
  // Messages produced inside a subagent point at the Agent tool call that spawned it.
  const sub = ev.parent_tool_use_id ? { sub: true, parent: ev.parent_tool_use_id } : {};
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') {
        return [{
          kind: 'init', sessionId: ev.session_id, model: ev.model || null, cwd: ev.cwd || null,
          toolbox: {
            skills: strings(ev.skills), agents: strings(ev.agents), slash_commands: strings(ev.slash_commands),
            mcp_servers: Array.isArray(ev.mcp_servers) ? ev.mcp_servers.filter(s => s && typeof s.name === 'string') : [],
            plugins: Array.isArray(ev.plugins) ? ev.plugins.filter(p => p && typeof p.name === 'string' && typeof p.path === 'string') : [],
          },
        }];
      }
      if (/^task_(started|progress|updated|notification)$/.test(ev.subtype)) return [taskItem(ev)];
      // /compact, or Claude Code doing it by itself when the window is nearly full.
      if (ev.subtype === 'compact_boundary') {
        const m = ev.compact_metadata || {};
        return [{ kind: 'compacted', trigger: m.trigger === 'auto' ? 'auto' : 'manual', preTokens: Number.isFinite(m.pre_tokens) ? m.pre_tokens : null }];
      }
      if (MOD_UI[ev.subtype]) return modItem(ev);
      // Every command the conversation has now, with what each one does: how a
      // command a mod registers after the session started becomes known.
      if (ev.subtype === 'commands_changed') {
        const commands = (Array.isArray(ev.commands) ? ev.commands : []).slice(0, MAX_COMMANDS)
          .filter(c => c && typeof c.name === 'string' && COMMAND_NAME.test(c.name))
          .map(c => ({ name: c.name, description: oneLine(c.description, 300) }));
        return [{ kind: 'commands', commands }];
      }
      return [];
    case 'assistant': {
      const out = [];
      for (const b of ev.message?.content || []) {
        if (b.type === 'text' && b.text?.trim()) out.push({ kind: 'text', text: b.text.trim(), ...sub });
        else if (b.type === 'thinking') out.push({ kind: 'thinking', ...sub });
        else if (b.type === 'tool_use') out.push(toolItem(b, sub));
      }
      return out;
    }
    case 'user': {
      const content = ev.message?.content;
      if (!Array.isArray(content)) return [];
      return content.filter(b => b.type === 'tool_result').map(b => {
        const full = resultText(b.content);
        const item = {
          kind: 'tool_result', id: b.tool_use_id, isError: !!b.is_error,
          text: truncate(full, MAX_RESULT_CHARS), ...sub,
        };
        // Test runners print their failures last: main reads the end of a
        // long result for the flaky test detective (flaky.js), then drops it.
        if (full.length > MAX_RESULT_CHARS) item.tail = full.slice(-MAX_RESULT_CHARS);
        // Subagent results carry run stats alongside the text.
        const r = ev.tool_use_result;
        if (r && typeof r === 'object' && r.agentId) {
          item.agentStats = { durationMs: r.totalDurationMs ?? null, tokens: r.totalTokens ?? null, toolUses: r.totalToolUseCount ?? null };
        }
        return item;
      });
    }
    case 'result':
      return [{
        kind: 'result', ok: !ev.is_error, subtype: ev.subtype || null,
        durationMs: ev.duration_ms ?? null, turns: ev.num_turns ?? null,
        error: ev.is_error ? (ev.result || (ev.errors || []).join('\n') || null) : null,
        sessionId: ev.session_id || null,
        // What the whole turn used, for the per-turn ledger (usage-ledger.js).
        tokens: tokensOf(ev.usage),
        costUsd: Number.isFinite(ev.total_cost_usd) ? ev.total_cost_usd : null,
      }];
    case 'rate_limit_event':
      return [usageFrom(ev)];
    case 'control_request':
      if (ev.request?.subtype === 'can_use_tool') {
        const r = ev.request;
        return [{
          kind: 'permission', requestId: ev.request_id, toolName: r.tool_name, toolUseId: r.tool_use_id,
          agentId: r.agent_id || null, filePath: writtenPath(r.tool_name, r.input), edits: editsOf(r.tool_name, r.input),
          input: r.input, description: r.description || null,
          suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
          ...describeTool(r.tool_name, r.input),
          plan: r.tool_name === 'ExitPlanMode' ? r.input?.plan : undefined,
          questions: r.tool_name === 'AskUserQuestion' ? questionsOf(r.input) : undefined,
        }];
      }
      return [];
    default:
      return [];
  }
}

// The events Shellby knows, including the ones it reads past on purpose. Anything
// else is new from Claude Code: session.js logs it once, and the nightly CLI
// check (cli-contract.js, scripts/cli-compat.js) flags it before a user meets it.
const KNOWN = Object.freeze({
  // control_response is read by session.js (answers to Shellby's own requests).
  types: new Set(['system', 'assistant', 'user', 'result', 'rate_limit_event', 'control_request', 'control_response']),
  // init, task_*, compact_boundary, a mod's ui_* and commands_changed become items; the rest is progress chatter.
  system: new Set(['init', 'task_started', 'task_progress', 'task_updated', 'task_notification', 'compact_boundary',
    'ui_log', 'ui_toast', 'ui_status', 'commands_changed',
    'hook_started', 'hook_progress', 'hook_response', 'status', 'api_retry', 'thinking_tokens']),
  // can_use_tool becomes a permission card; hook_callback is answered by session.js.
  control: new Set(['can_use_tool', 'hook_callback']),
});

// Line-oriented parser: feed raw stdout lines, get items back.
function parseLine(line) {
  const t = line.trim();
  if (!t) return { event: null, items: [] };
  let ev;
  try { ev = JSON.parse(t); } catch { return { event: null, items: [{ kind: 'log', text: t }] }; }
  return { event: ev, items: toItems(ev) };
}

module.exports = { questionsOf, toItems, parseLine, describeTool, resultText, truncate, usageFrom, spendFrom, writtenPath, writeChars, WRITE_TOOLS, AGENT_TOOLS, KNOWN };
