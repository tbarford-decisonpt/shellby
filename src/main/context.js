// How full a conversation's context window is. Claude Code repeats each API
// call's token counts on its assistant events, and everything the model read
// for that call (the prompt, the cache, what it wrote) is the conversation as
// it stands. The window itself comes from the result event's modelUsage; until
// one arrives, the model's name is the best guess.
// Pure functions: no Electron, no I/O — see test/context.test.js.

const DEFAULT_WINDOW = 200000;
const LONG_WINDOW = 1000000;
// Past this, Shellby says it's getting crowded and offers to make room.
const CROWDED_PCT = 80;

const num = v => (Number.isFinite(v) && v > 0 ? v : 0);

/** Tokens in play for one main-thread assistant event, or null. Subagents keep their own context. */
function tokensFrom(ev) {
  if (ev?.type !== 'assistant' || ev.parent_tool_use_id) return null;
  const u = ev.message?.usage;
  if (!u || typeof u !== 'object') return null;
  const tokens = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) + num(u.output_tokens);
  return tokens ? { tokens, model: typeof ev.message.model === 'string' ? ev.message.model : null } : null;
}

/** { model: contextWindow } from a result event's modelUsage, or null. */
function windowsFrom(ev) {
  if (ev?.type !== 'result' || !ev.modelUsage || typeof ev.modelUsage !== 'object') return null;
  const out = {};
  for (const [model, u] of Object.entries(ev.modelUsage)) if (num(u?.contextWindow)) out[model] = u.contextWindow;
  return Object.keys(out).length ? out : null;
}

/**
 * The window for a model: what Claude Code reported for it, else the largest
 * one it reported, else 1M for a "[1m]" model setting and 200k otherwise.
 */
function windowFor(model, windows, setting) {
  const known = windows && typeof windows === 'object' ? windows : {};
  if (model && num(known[model])) return known[model];
  const match = model && Object.keys(known).find(k => k.startsWith(model) || model.startsWith(k));
  if (match) return known[match];
  const sizes = Object.values(known).filter(num);
  if (sizes.length) return Math.max(...sizes);
  return /\[1m\]/i.test(String(setting || '')) ? LONG_WINDOW : DEFAULT_WINDOW;
}

/** { tokens, window, pct } as the panel shows it, or null with nothing to show. */
function view(tokens, window) {
  if (!num(tokens) || !num(window)) return null;
  return { tokens, window, pct: Math.min(100, Math.round((tokens / window) * 100)) };
}

/** Did this reading just go past the crowded mark? */
const crossed = (before, after) => (before?.pct ?? 0) < CROWDED_PCT && (after?.pct ?? 0) >= CROWDED_PCT;

// "Start fresh with a summary": the summary is written in the old conversation,
// then handed to a new one in the same tab.
const HANDOFF_ASK = 'This conversation is getting full, so Shellby is about to start it fresh. '
  + 'Write a handoff summary for whoever picks it up: the goal, what is done, what is left, decisions made and why, '
  + 'the files and commands that matter, and anything that tripped you up. Use no tools. Reply with the summary only.';

const handoffPrompt = summary => 'Shellby started this conversation fresh to make room. Here is the summary from before:\n\n'
  + `${String(summary).trim()}\n\n`
  + 'Pick up from there. If the last task was finished, say in a line or two where things stand and wait for what is next.';

module.exports = { tokensFrom, windowsFrom, windowFor, view, crossed, HANDOFF_ASK, handoffPrompt, CROWDED_PCT, DEFAULT_WINDOW, LONG_WINDOW };
