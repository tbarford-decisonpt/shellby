// What went wrong, in one plain sentence, and the one thing to do about it.
//
// Claude Code, git and GitHub fail in their own words: "API Error: Connection
// error.", "No conversation found with session ID: …", "Invalid API key ·
// Please run /login", a Node stack. Those words are kept (the transcript, the
// log, Copy details), but what the panel shows is the sentence here, with a
// button for the next step where there is one. The panel knows each action by
// its id (feed.js troubleBlock):
//   retry      send the last message again
//   sign-in    run Claude Code's own sign-in
//   setup      the Claude Code part of setup (install it, or point at it)
//   fresh-tab  a new tab in the same folder, with the last message in the box
//   hold       hold the last message until the usage limit resets
//   remote     Settings, Other computers: a conversation on another computer couldn't start
//   copy       copy what the program said, for a bug report or a search
//
// Pure: no Electron, no I/O. See test/trouble.test.js.

const MAX_DETAIL_LINES = 12;
const MAX_DETAIL = 4000;

const ACTIONS = {
  retry: 'Try again',
  'sign-in': 'Sign in again',
  setup: 'Set up Claude Code',
  'fresh-tab': 'Open in a fresh tab',
  hold: 'Send it after the reset',
  remote: 'Open Other computers',
  copy: 'Copy details',
};

// Most specific first: a signed-out CLI also says "API Error", and a resume
// that fails also exits. A sign-in that lapsed is a signed-out one: the CLI
// says "Failed to authenticate: OAuth session expired and could not be
// refreshed" (or "OAuth token revoked"), and the next step is the same sign-in.
const KINDS = [
  {
    kind: 'cli-missing',
    test: /spawn .+ ENOENT|\bENOENT\b.*claude|is not recognized as an internal or external command|claude: (command )?not found/i,
    message: "Shellby can't find Claude Code on this PC, so nothing was sent.",
    action: 'setup',
  },
  {
    kind: 'signed-out',
    test: /invalid api key|please run \/login|run \/login|not logged in|(log|sign) ?in again|failed to authenticate(?:[:.]|$)|oauth session (has )?expired|oauth token (has )?(expired|(been )?revoked)|token (has )?expired|re-login required|authentication_error|invalid bearer token|\b401\b.{0,40}unauthori[sz]ed|unauthori[sz]ed.{0,40}\b401\b/im,
    message: 'Claude Code is signed out, so it couldn\'t take that turn.',
    action: 'sign-in',
  },
  {
    kind: 'resume-failed',
    test: /no conversation found|conversation .* (not found|could not be found)|session id .* not found|(could not|couldn't|failed to) resume/i,
    message: "Claude Code couldn't pick this conversation back up, so it won't remember what came before.",
    action: 'fresh-tab',
  },
  {
    kind: 'usage-limit',
    test: /usage limit|limit reached|limit will reset|out of (extra )?usage|\b5-hour limit\b|weekly limit/i,
    message: "You've reached your Claude usage limit for now.",
    action: 'hold',
  },
  {
    kind: 'too-long',
    test: /prompt is too long|context (window|length) (exceeded|is full)|exceeds? the (model's )?(maximum )?context|too many tokens/i,
    message: 'This conversation has grown too long for Claude to take another turn in it.',
    action: 'fresh-tab',
  },
  {
    kind: 'busy',
    test: /overloaded|\b529\b|api error: 5\d\d|internal server error|service unavailable|bad gateway/i,
    message: "Claude's servers are busy at the moment. It usually passes in a minute or two.",
    action: 'retry',
  },
  {
    kind: 'network',
    test: /connection error|\bENOTFOUND\b|\bEAI_AGAIN\b|\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b|\bENETUNREACH\b|network (is )?unreachable|fetch failed|socket hang up|getaddrinfo|request timed out|unable to connect/i,
    message: "Couldn't reach Claude: this PC looks to be offline, or the connection dropped.",
    action: 'retry',
  },
];

const NO_START = {
  kind: 'no-start',
  message: "Claude Code wouldn't start on this PC, so nothing was sent.",
  action: 'setup',
};
const EXITED = {
  kind: 'stopped',
  message: 'Claude Code stopped partway through that turn.',
  action: 'retry',
};
const UNKNOWN = { kind: 'unknown', message: null, action: 'copy' };

const text = v => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * What the program said, tidied for Copy details and the log: no stack frames,
 * the last few lines, never more than MAX_DETAIL characters.
 */
function detailOf(raw) {
  const lines = text(raw).replace(/\r\n?/g, '\n').split('\n')
    .filter(l => l.trim() && !/^\s+at\s/.test(l));
  return lines.slice(-MAX_DETAIL_LINES).join('\n').slice(-MAX_DETAIL);
}

// The program's own first line, when nothing better is known: a stack frame or
// a bare exit code says nothing useful, so those make way for a plain sentence.
function firstWords(raw) {
  const line = detailOf(raw).split('\n').find(l => !/^(Error|TypeError|RangeError)?:?\s*$/.test(l)) || '';
  const said = line.replace(/^(?:Error|API Error):\s*/i, '').trim();
  if (!said || /^Claude Code exited \(code -?\d+\)\.?$/.test(said)) return null;
  return said.length > 200 ? `${said.slice(0, 199)}…` : said;
}

/**
 * Error text (and how it came about) -> { kind, message, action: { id, label } | null }.
 *   exited: the process ended mid-turn (a crash, or a resume that failed)
 *   start:  the process couldn't be started at all
 */
function troubleOf(raw, { exited = false, start = false } = {}) {
  const said = text(raw);
  const found = KINDS.find(k => k.test.test(said));
  const base = found || (start ? NO_START : exited ? EXITED : UNKNOWN);
  const message = base.message || (firstWords(said) ? `Something went wrong: ${firstWords(said)}` : 'Something went wrong, and Claude Code didn\'t say what.');
  const id = base.action;
  return { kind: base.kind, message, action: id ? { id, label: ACTIONS[id] } : null };
}

/**
 * The same for a conversation running on another computer: what ssh or the
 * other end said first (remote/ssh.js), with Settings' Other computers as the
 * next step; anything else is Claude Code's own trouble, as above.
 */
function remoteTroubleOf(raw, opts = {}, remoteKind = () => null) {
  const hit = remoteKind(text(raw));
  if (!hit) return troubleOf(raw, opts);
  return { kind: hit.kind, message: hit.message, action: { id: 'remote', label: ACTIONS.remote } };
}

module.exports = { troubleOf, remoteTroubleOf, detailOf, ACTIONS };
