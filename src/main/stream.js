// Turns Claude Code stream-json events into a small set of UI items.
// Pure functions: no Electron, no I/O — see test/stream.test.js.

const MAX_RESULT_CHARS = 8000;

const TOOL_VERBS = {
  Bash: 'Ran', PowerShell: 'Ran', Read: 'Read', Write: 'Created', Edit: 'Edited',
  MultiEdit: 'Edited', NotebookEdit: 'Edited', Glob: 'Searched files', Grep: 'Searched for',
  WebFetch: 'Fetched', WebSearch: 'Searched the web', Task: 'Delegated', Agent: 'Delegated',
  TodoWrite: 'Updated plan', ExitPlanMode: 'Proposed a plan', Skill: 'Used skill',
};

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s;
}

function describeTool(name = '', input = {}) {
  const i = input || {};
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

// Returns an array of UI items for one parsed stream-json event.
function toItems(ev) {
  if (!ev || typeof ev !== 'object') return [];
  const sub = ev.parent_tool_use_id ? { sub: true } : {};
  switch (ev.type) {
    case 'system':
      return ev.subtype === 'init'
        ? [{ kind: 'init', sessionId: ev.session_id, model: ev.model || null, cwd: ev.cwd || null }]
        : [];
    case 'assistant': {
      const out = [];
      for (const b of ev.message?.content || []) {
        if (b.type === 'text' && b.text?.trim()) out.push({ kind: 'text', text: b.text.trim(), ...sub });
        else if (b.type === 'thinking') out.push({ kind: 'thinking', ...sub });
        else if (b.type === 'tool_use') {
          out.push({ kind: 'tool', id: b.id, name: b.name, ...describeTool(b.name, b.input),
                     plan: b.name === 'ExitPlanMode' ? b.input?.plan : undefined, ...sub });
        }
      }
      return out;
    }
    case 'user': {
      const content = ev.message?.content;
      if (!Array.isArray(content)) return [];
      return content.filter(b => b.type === 'tool_result').map(b => ({
        kind: 'tool_result', id: b.tool_use_id, isError: !!b.is_error,
        text: truncate(resultText(b.content), MAX_RESULT_CHARS), ...sub,
      }));
    }
    case 'result':
      return [{
        kind: 'result', ok: !ev.is_error, subtype: ev.subtype || null,
        durationMs: ev.duration_ms ?? null, turns: ev.num_turns ?? null,
        error: ev.is_error ? (ev.result || (ev.errors || []).join('\n') || null) : null,
        sessionId: ev.session_id || null,
      }];
    case 'rate_limit_event':
      return [usageFrom(ev)];
    case 'control_request':
      if (ev.request?.subtype === 'can_use_tool') {
        const r = ev.request;
        return [{
          kind: 'permission', requestId: ev.request_id, toolName: r.tool_name, toolUseId: r.tool_use_id,
          input: r.input, description: r.description || null,
          suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
          ...describeTool(r.tool_name, r.input),
          plan: r.tool_name === 'ExitPlanMode' ? r.input?.plan : undefined,
        }];
      }
      return [];
    default:
      return [];
  }
}

// Line-oriented parser: feed raw stdout lines, get items back.
function parseLine(line) {
  const t = line.trim();
  if (!t) return { event: null, items: [] };
  let ev;
  try { ev = JSON.parse(t); } catch { return { event: null, items: [{ kind: 'log', text: t }] }; }
  return { event: ev, items: toItems(ev) };
}

module.exports = { toItems, parseLine, describeTool, resultText, truncate, usageFrom };
