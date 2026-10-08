// /btw: a quick side question about the conversation, as in Claude Code's
// terminal. Claude Code only offers /btw interactively (it's not among a -p
// session's slash_commands), so Shellby asks it the same way the terminal does:
// a one-off `claude -p` that resumes a fork of the conversation, with no tools,
// and saves nothing. The conversation itself never sees the question or the
// answer, and it can be asked while Claude is still working.
//
// Pure apart from ask(), which runs the CLI it's handed.

const MAX_QUESTION = 4000;
const TIMEOUT_MS = 120000;

const NOTE = [
  'The user is asking a quick side question with /btw while this conversation carries on separately.',
  'Answer it briefly, from what you already know from the conversation.',
  "You have no tools here, so don't offer to run, read or change anything.",
  'Neither the question nor your answer is added to the conversation.',
].join(' ');

/**
 * The CLI's arguments; the question goes on stdin.
 * sessionId: the conversation's Claude Code session, or null before its first
 * message (then it's an ordinary question). resumeAt: a rewound conversation's
 * anchor, which its next message would fork from.
 * --fork-session and --no-session-persistence leave the conversation's
 * transcript as it was and write no new one; --strict-mcp-config with no
 * --mcp-config and --tools "" leave Claude no tools at all.
 */
function args({ sessionId = null, resumeAt = null, model = null, lean = [] } = {}) {
  const a = ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--append-system-prompt', NOTE];
  if (model) a.push('--model', model);
  if (sessionId) {
    a.push('--resume', sessionId, '--fork-session');
    if (resumeAt) a.push(`--resume-session-at=${resumeAt}`);
  }
  return [...a, ...lean];
}

/** The question as it's sent, or null when there isn't one. */
function cleanQuestion(text) {
  const q = typeof text === 'string' ? text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim() : '';
  return q && q.length <= MAX_QUESTION ? q : null;
}

/** The CLI's reply -> { ok, answer } or { ok: false, error }. */
function parse(stdout) {
  let reply;
  try { reply = JSON.parse(String(stdout).trim()); } catch { return { ok: false, error: "Claude's answer didn't come through. Try again." }; }
  if (!reply || typeof reply !== 'object') return { ok: false, error: "Claude's answer didn't come through. Try again." };
  const text = typeof reply.result === 'string' ? reply.result.trim() : '';
  if (reply.is_error) {
    const why = /log(?:ged)? ?in|sign(?:ed)? ?in|auth/i.test(text) ? ' Sign in to Claude Code in Settings first.' : '';
    return { ok: false, error: `Claude couldn't answer that.${why}` };
  }
  return text ? { ok: true, answer: text } : { ok: false, error: "Claude didn't answer. Try asking another way." };
}

/** run(args, timeoutMs, { cwd, input }) -> the CLI's { stdout, stderr, timedOut }. */
async function ask({ question, sessionId, resumeAt, model, cwd, lean }, run) {
  const q = cleanQuestion(question);
  if (!q) return { ok: false, error: 'Ask something after /btw, like: /btw what was that file called?' };
  const res = await run(args({ sessionId, resumeAt, model, lean }), TIMEOUT_MS, { cwd, input: q });
  if (res.timedOut) return { ok: false, error: 'Claude took too long to answer. Try again.' };
  if (!String(res.stdout || '').trim()) return { ok: false, error: "Claude Code didn't answer. Check it's signed in, in Settings.", detail: String(res.stderr || res.err?.message || '').trim().split('\n').slice(-3).join(' ') };
  return parse(res.stdout);
}

module.exports = { args, parse, ask, cleanQuestion, NOTE, MAX_QUESTION, TIMEOUT_MS };
