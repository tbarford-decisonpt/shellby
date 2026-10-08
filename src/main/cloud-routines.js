// Claude Code's cloud routines (/schedule): agents that run in Anthropic's
// cloud on a schedule, made and kept by Claude Code itself. Shellby doesn't
// schedule anything here and never sees your sign-in: it asks a short-lived
// `claude -p` to call Claude Code's own RemoteTrigger tool, and reads the
// tool's result out of the stream. One Haiku call with no other tools, no MCP
// servers and no settings (hooks, plugins) costs a fraction of a cent.
//
// What RemoteTrigger answers (Claude Code 2.1.293): the tool result's data is
// { status, json } where json is the API's body as text:
//   list      -> { data: [routine], has_more }
//   list_runs -> { data: [run], ... }
//   run       -> the run it started
// and a routine is { id, name, enabled, cron_expression | run_once_at,
// next_run_at, job_config: { ccr: { session_context: { model, sources:
// [{ git_repository: { url } }] }, events: [{ data: { message: { content } } }] } } }.
// Anything missing reads as unknown, never as an error.
//
// The pure half (args, readOutput, parseRoutines, parseRuns, cronWords) is
// tested in test/cloud-routines.test.js; ask() runs the CLI.
const { run } = require('./claude/cli');

const ACTIONS = new Set(['list', 'run', 'list_runs']);
const TIMEOUT_MS = 60_000;
const MAX_BUDGET_USD = '0.05';
const ID = /^[\w-]{1,120}$/;
const MAX_ROUTINES = 100;
const MAX_RUNS = 10;
const TEXT = 300;

const ROUTINES_URL = 'https://claude.ai/code/routines';
const routineUrl = id => (ID.test(id || '') ? `${ROUTINES_URL}/${id}` : ROUTINES_URL);

const str = (v, n = TEXT) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const when = v => {
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** The command line for one call: Haiku, RemoteTrigger and nothing else. */
function args(input) {
  const prompt = `Call the RemoteTrigger tool exactly once with this input, then reply with the single word: done.\n${JSON.stringify(input)}`;
  return [
    '-p', prompt,
    '--model', 'haiku',
    '--tools', 'RemoteTrigger', '--allowedTools', 'RemoteTrigger',
    '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '',
    '--no-session-persistence',
    '--max-budget-usd', MAX_BUDGET_USD,
  ];
}

/**
 * The RemoteTrigger result in a stream-json transcript:
 * { ok: true, status, body } | { ok: false, error, signedOut? }.
 */
function readOutput(stdout) {
  let result = null, final = null;
  for (const line of String(stdout || '').split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const r = ev?.type === 'user' ? ev.tool_use_result : null;
    if (r && typeof r === 'object' && 'json' in r) result = r;
    if (ev?.type === 'result') final = ev;
  }
  if (!result) {
    const said = str(final?.result || (final?.errors || []).join(' '), 400);
    const signedOut = /log ?in|sign ?in|auth|claude\.ai account/i.test(said);
    return { ok: false, signedOut, error: signedOut ? 'Cloud routines need Claude Code signed in with your claude.ai account.' : said || "Claude Code didn't say." };
  }
  let body = null;
  try { body = typeof result.json === 'string' ? JSON.parse(result.json) : result.json; } catch { /* not JSON: the status says enough */ }
  const status = Number(result.status);
  if (!(status >= 200 && status < 300)) {
    const why = str(body?.error?.message || body?.message || (typeof result.json === 'string' ? result.json : ''), 300);
    return { ok: false, status, error: status === 401 || status === 403 ? 'Cloud routines need Claude Code signed in with your claude.ai account.' : why || `Claude's cloud said ${status || 'no'}.` };
  }
  return { ok: true, status, body };
}

/** A routine as the panel shows it, or null. */
function routineOf(r) {
  if (!r || typeof r !== 'object' || !ID.test(r.id || '')) return null;
  const ccr = r.job_config?.ccr || {};
  const ctx = ccr.session_context || {};
  const repos = (Array.isArray(ctx.sources) ? ctx.sources : []).map(s => str(s?.git_repository?.url, 200)).filter(Boolean);
  const first = Array.isArray(ccr.events) ? ccr.events.find(e => e?.data?.message) : null;
  const content = first?.data?.message?.content;
  const prompt = typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => (typeof b?.text === 'string' ? b.text : '')).join(' ') : '';
  return {
    id: r.id,
    name: str(r.name, 120) || 'Untitled routine',
    enabled: r.enabled !== false,
    cron: str(r.cron_expression, 80) || null,
    schedule: cronWords(r.cron_expression), // in words, when it's a common one
    runOnceAt: when(r.run_once_at),
    nextRunAt: when(r.next_run_at),
    model: str(ctx.model, 60) || null,
    repos: repos.slice(0, 5),
    prompt: str(prompt, 400),
    url: routineUrl(r.id),
  };
}

/** list's body -> [routine], soonest next run first, paused ones last. */
function parseRoutines(body) {
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  return list.slice(0, MAX_ROUTINES).map(routineOf).filter(Boolean)
    .sort((a, b) => (b.enabled - a.enabled) || ((a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)) || a.name.localeCompare(b.name));
}

/** list_runs' body -> [{ id, status, at, title }], newest first. Unknown fields stay null. */
function parseRuns(body) {
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.runs) ? body.runs : Array.isArray(body) ? body : [];
  return list.slice(0, MAX_RUNS).map(r => ({
    id: str(r?.id || r?.session_id, 120) || null,
    status: str(r?.status || r?.session_status || r?.state, 40) || null,
    at: when(r?.updated_at || r?.last_activity_at || r?.created_at || r?.started_at),
    title: str(r?.title || r?.name, 160) || null,
  })).filter(r => r.id || r.at);
}

const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const pad = n => String(n).padStart(2, '0');

/**
 * A cron line in words, for the common ones ("every day at 09:00 UTC",
 * "weekdays at 08:30 UTC", "every hour"), or null for the rest (the panel
 * shows the cron itself then). Routines run on UTC.
 */
function cronWords(cron) {
  const f = String(cron || '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f;
  const num = v => (/^\d+$/.test(v) ? Number(v) : null);
  const m = num(min), h = num(hour);
  if (m !== null && hour === '*' && dom === '*' && mon === '*' && dow === '*') return m === 0 ? 'every hour' : `every hour at :${pad(m)}`;
  const every = /^\*\/(\d+)$/.exec(hour);
  if (m !== null && every && dom === '*' && mon === '*' && dow === '*') return `every ${every[1]} hours`;
  if (m === null || h === null || h > 23 || m > 59 || mon !== '*') return null;
  const at = `${pad(h)}:${pad(m)} UTC`;
  if (dom === '*' && dow === '*') return `every day at ${at}`;
  if (dom === '*' && (dow === '1-5' || dow === 'MON-FRI')) return `weekdays at ${at}`;
  if (dom === '*' && /^[0-6]$/.test(dow)) return `${DAYS[Number(dow)]} at ${at}`;
  if (dow === '*' && /^\d{1,2}$/.test(dom)) return `day ${Number(dom)} of each month at ${at}`;
  return null;
}

/**
 * Ask Claude Code. exe: its path. -> what readOutput says, plus { routines }
 * for list and { runs } for list_runs.
 */
async function ask(exe, input, { runner = run, cwd } = {}) {
  if (!exe) return { ok: false, error: "Claude Code isn't installed." };
  if (!ACTIONS.has(input?.action)) return { ok: false, error: 'Shellby only lists and runs routines.' };
  if (input.action !== 'list' && !ID.test(input.trigger_id || '')) return { ok: false, error: "That isn't a routine." };
  const r = await runner(exe, args(input), TIMEOUT_MS, { cwd });
  if (r.timedOut) return { ok: false, error: "Claude Code took too long to answer. Try again in a moment." };
  const out = readOutput(r.stdout);
  if (!out.ok) return out;
  if (input.action === 'list') return { ...out, routines: parseRoutines(out.body), more: !!out.body?.has_more };
  if (input.action === 'list_runs') return { ...out, runs: parseRuns(out.body) };
  return out;
}

module.exports = { args, readOutput, routineOf, parseRoutines, parseRuns, cronWords, ask, routineUrl, ROUTINES_URL, TIMEOUT_MS };
