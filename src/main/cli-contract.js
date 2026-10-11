// What Shellby needs from the Claude Code CLI, written down so a new release can
// be checked against it before a user finds out (scripts/cli-compat.js, run
// nightly by .github/workflows/cli-compat.yml).
//
// Pure: no Electron, no I/O, no child processes — see test/cli-contract.test.js.
const { parseLine, KNOWN } = require('./stream');
const { CLI_MODE } = require('./config');

// Effort levels Claude Code takes (--effort). session.js re-exports this.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Every flag ClaudeSession.buildArgs() can emit. hidden: Claude Code accepts it
// but leaves it out of --help, so only launching with it proves it still works.
// test/cli-contract.test.js builds args for every kind of session and fails if
// one of them emits a flag missing here.
const REQUIRED_FLAGS = Object.freeze([
  { flag: '-p' },
  { flag: '--input-format' },
  { flag: '--output-format' },
  { flag: '--verbose' },
  { flag: '--permission-prompt-tool', hidden: true },
  { flag: '--replay-user-messages' },
  { flag: '--permission-mode' },
  { flag: '--allow-dangerously-skip-permissions' },
  { flag: '--model' },
  { flag: '--effort' },
  { flag: '--settings' },
  { flag: '--allowedTools' },
  { flag: '--strict-mcp-config' },
  { flag: '--mcp-config' },
  { flag: '--resume' },
  { flag: '--resume-session-at', hidden: true },
  { flag: '--fork-session' },
  // session.js OPTIONAL_FLAGS: passed only when the installed CLI lists them, but
  // the newest release must still have them.
  { flag: '--include-partial-messages' },
  { flag: '--forward-subagent-text' },
  { flag: '--fallback-model' },
  { flag: '--name' },
  { flag: '--agent' },
  { flag: '--safe-mode' },
  { flag: '--chrome' },
]);

// The --permission-mode values Shellby's modes map to (config.js).
const REQUIRED_MODES = Object.freeze([...new Set(Object.values(CLI_MODE))]);

// What one ordinary turn must produce, or the panel has nothing to show.
const EXPECTED_KINDS = Object.freeze(['init', 'text', 'result']);

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The flag names (no values) in an argument list: '--a=b' counts as '--a'. */
function flagsIn(args) {
  return [...new Set(args.filter(a => typeof a === 'string' && /^-{1,2}[A-Za-z]/.test(a)).map(a => a.split('=')[0]))];
}

/**
 * Is every documented flag Shellby launches with still in `claude --help`?
 * Hidden flags are skipped here: the launch probe covers them.
 * @returns {{ ok: boolean, missing: string[] }}
 */
function checkHelp(helpText) {
  const text = String(helpText ?? '');
  const missing = REQUIRED_FLAGS.filter(f => !f.hidden)
    .map(f => f.flag)
    .filter(flag => !new RegExp(`(?:^|[\\s,])${escapeRe(flag)}(?![\\w-])`, 'm').test(text));
  return { ok: missing.length === 0, missing };
}

/**
 * The CLI's complaint about an argument, if it made one: an unknown flag, a
 * value not among the allowed choices, or an effort level it ignored. null
 * when it took everything.
 */
function flagRejected(output) {
  const text = String(output ?? '');
  const m = text.match(/unknown option[^\n]*|argument [^\n]* is invalid[^\n]*|Unknown --[\w-]+ value[^\n]*/i);
  return m ? m[0].trim() : null;
}

// type, or type/subtype for the events that have one.
function keyOf(ev) {
  if (ev.type === 'system') return `system/${ev.subtype ?? ''}`;
  if (ev.type === 'control_request') return `control_request/${ev.request?.subtype ?? ''}`;
  return String(ev.type);
}

function isKnown(ev) {
  if (!KNOWN.types.has(ev.type)) return false;
  if (ev.type === 'system') return KNOWN.system.has(ev.subtype);
  if (ev.type === 'control_request') return KNOWN.control.has(ev.request?.subtype);
  return true;
}

/**
 * Runs a stream-json transcript (stdout lines) through the same parser the app
 * uses, and says what it couldn't place.
 * @returns {{ ok: boolean, events: number, seen: string[], kinds: string[],
 *   unknown: { type: string, subtype: string|null, count: number }[],
 *   missingKinds: string[], parseErrors: string[] }}
 */
function auditEvents(lines, { expect = EXPECTED_KINDS } = {}) {
  const seen = new Set();
  const kinds = new Set();
  const unknown = new Map();
  const parseErrors = [];
  let events = 0;
  for (const line of lines) {
    const { event, items } = parseLine(String(line ?? ''));
    if (!event) {
      for (const i of items) if (i.kind === 'log') parseErrors.push(i.text.slice(0, 200));
      continue;
    }
    if (typeof event !== 'object') { parseErrors.push(String(line).slice(0, 200)); continue; }
    events++;
    const key = keyOf(event);
    seen.add(key);
    for (const i of items) kinds.add(i.kind);
    if (items.length || isKnown(event)) continue;
    const prev = unknown.get(key);
    if (prev) prev.count++;
    else {
      const subtype = event.type === 'control_request' ? event.request?.subtype : event.subtype;
      unknown.set(key, { type: String(event.type), subtype: subtype == null ? null : String(subtype), count: 1 });
    }
  }
  const missingKinds = expect.filter(k => !kinds.has(k));
  return {
    ok: unknown.size === 0 && missingKinds.length === 0 && parseErrors.length === 0,
    events, seen: [...seen].sort(), kinds: [...kinds].sort(), unknown: [...unknown.values()], missingKinds, parseErrors,
  };
}

/** The top-level event type session.js should log once, or null when it's known. */
function unknownType(ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return null;
  return KNOWN.types.has(ev.type) ? null : ev.type.slice(0, 60);
}

// ---------------------------------------------------------------- the badge

const BADGE_LABEL = 'works with Claude Code';
const GOOD = '7fd6c2';
const BAD = 'e05d44';

const BADGE_CACHE_SECONDS = 3600;

/**
 * The shields.io endpoint JSON for the README badge, and the state kept beside
 * it. shields.io refuses keys it doesn't know, so the last version that worked
 * lives in the state, not the badge. previous: the state as it was. Neither
 * holds a time, so a night with nothing new leaves both files as they were.
 * @returns {{ badge: object, state: { version: string, ok: boolean, lastGood: string|null } }}
 */
function badgeFor(report, previous = null) {
  const version = report?.version || 'unknown';
  const ok = !!report?.ok;
  const lastGood = ok ? version : (typeof previous?.lastGood === 'string' ? previous.lastGood : null);
  let message = version;
  if (!ok) message = lastGood ? `${lastGood} (broken since ${version})` : `broken since ${version}`;
  return {
    badge: { schemaVersion: 1, label: BADGE_LABEL, message, color: ok ? GOOD : BAD, cacheSeconds: BADGE_CACHE_SECONDS },
    state: { version, ok, lastGood },
  };
}

/**
 * The report as Markdown: the nightly issue's body and the run summary.
 * report: { version, ok, checks: [{ name, ok, skipped?, detail }], unknown: [] }
 */
function summaryOf(report) {
  const mark = c => (c.skipped ? 'skipped' : c.ok ? 'ok' : '**FAIL**');
  const rows = (report?.checks || []).map(c => `| ${mark(c)} | ${c.name} | ${String(c.detail ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').slice(0, 300)} |`);
  const unknown = report?.unknown || [];
  return [
    `**Claude Code ${report?.version || '(version unknown)'}**: ${report?.ok ? 'works with Shellby' : 'something Shellby relies on changed'}.`,
    '',
    '| | Check | Detail |',
    '|---|---|---|',
    ...rows,
    ...(unknown.length ? ['', 'Events Shellby does not know yet:', '', ...unknown.map(u => `- \`${u.type}${u.subtype ? `/${u.subtype}` : ''}\` ×${u.count}`)] : []),
  ].join('\n');
}

// ---------------------------------------------------------------- recording

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
// Keys that could end up in a transcript (an echoed environment, an error).
const SECRETS = [
  [/\bsk-ant-[\w-]+/g, 'sk-ant-…'],
  [/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1…'],
];
// Per-user setup the init event and initialize answer list: kept as empty
// lists, so the shape survives without saying what this machine has installed.
const PERSONAL_LISTS = ['mcp_servers', 'plugins', 'skills', 'slash_commands', 'agents', 'commands', 'models', 'account'];
// Hook events carry whatever the user's own hooks printed.
const HOOK_TEXT = ['output', 'stdout', 'stderr'];

function emptyLike(v) {
  if (Array.isArray(v)) return [];
  if (v && typeof v === 'object') return {};
  return typeof v === 'string' ? '' : v;
}

// A user folder in its 8.3 short form: one segment under Users ending in ~ and a number.
const SHORT_USER_DIR = /([\\/])Users([\\/]+)[^\\/]+~\d+(?=[\\/]|$)/gi;

/**
 * Makes a recorded transcript safe to commit: the home folder, user name and
 * any email become placeholders, ids become stable fakes, and the lists that
 * describe this machine's own setup are emptied.
 * @param {string[]} lines stdout lines
 * @param {{ home?: string, user?: string }} who
 * @returns {string[]} JSON lines
 */
function scrubTranscript(lines, { home = '', user = '' } = {}) {
  const ids = new Map();
  const fakeId = id => {
    const k = id.toLowerCase();
    if (!ids.has(k)) ids.set(k, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`);
    return ids.get(k);
  };
  // Either separator, any number of them: paths arrive both ways, and doubled
  // inside JSON that was itself a string.
  const parts = String(home).split(/[\\/]+/).filter(Boolean);
  const homeRe = parts.length ? new RegExp(parts.map(escapeRe).join('[\\\\/]+'), 'gi') : null;
  // The user name, and the home folder's own name when it differs (a renamed
  // or domain account): both turn up in Claude's dash-encoded project folders.
  const names = [...new Set([user, parts[parts.length - 1]].filter(n => n && n.length > 1 && !/^user$/i.test(n)))]
    .sort((a, b) => b.length - a.length); // the longer name first, so it goes whole
  const userRe = names.length ? new RegExp(`\\b(?:${names.map(escapeRe).join('|')})\\b`, 'gi') : null;
  const text = s => {
    let t = s;
    if (homeRe) t = t.replace(homeRe, 'C:\\Users\\user');
    // Windows' short names (C:\Users\TYLERB~1, how os.tmpdir() and the CLI's
    // scratchpad paths spell the home folder) never match the long one above.
    t = t.replace(SHORT_USER_DIR, '$1Users$2user');
    if (userRe) t = t.replace(userRe, 'user');
    for (const [re, to] of SECRETS) t = t.replace(re, to);
    return t.replace(EMAIL, 'user@example.com').replace(UUID, fakeId);
  };
  const field = (k, x, parent) => {
    if (parent === 'input' || parent === 'tool_input') return walk(x, k);
    if (PERSONAL_LISTS.includes(k)) return emptyLike(x);
    // The user's own MCP servers' tools; the built-in ones stay.
    if (k === 'tools' && Array.isArray(x)) return x.filter(t => !(typeof t === 'string' && t.startsWith('mcp__'))).map(t => walk(t));
    // An opaque blob that only bloats the file.
    if (k === 'signature' && typeof x === 'string') return '';
    return walk(x, k);
  };
  const walk = (v, key = null) => {
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map(x => walk(x));
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) out[text(k)] = field(k, x, key);
    return out;
  };
  const out = [];
  for (const line of lines) {
    const t = String(line ?? '').trim();
    if (!t) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    if (ev?.type === 'system' && /^hook_/.test(ev.subtype || '')) for (const k of HOOK_TEXT) if (k in ev) ev[k] = '';
    if (ev?.type === 'control_response' && ev.response?.response && typeof ev.response.response === 'object') {
      ev.response.response = Object.fromEntries(Object.entries(ev.response.response).map(([k, x]) => [k, emptyLike(x)]));
    }
    out.push(JSON.stringify(walk(ev)));
  }
  return out;
}

module.exports = {
  EFFORTS, REQUIRED_FLAGS, REQUIRED_MODES, EXPECTED_KINDS,
  flagsIn, checkHelp, flagRejected, auditEvents, unknownType, badgeFor, summaryOf, scrubTranscript,
};
