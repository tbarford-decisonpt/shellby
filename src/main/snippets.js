// Prompt snippets: the things you ask Claude for again and again ("review my
// diff", "write tests for this file"), saved under a short name and run from the
// panel as /review or from a terminal as `shellby do @review`.
//
// A snippet is a name and the prompt it stands for. $ARGUMENTS in the prompt is
// replaced by whatever follows the name (the way Claude Code's own commands do
// it); without one, anything that follows goes on the end, after a blank line.
//
// Pure: settings in, settings out. main.js keeps the list in settings.json, and
// re-checks everything here whether the request came from the panel or the port.

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_TEXT = 4000;
const MAX_SNIPPETS = 100;
const PLACEHOLDER = '$ARGUMENTS';

// Shellby's own slash commands in the panel (composer.js LOCAL_COMMANDS): a
// snippet called /export would never run. And Claude Code's /compact and /clear,
// which the panel's Compact and Start fresh send through the box themselves.
const RESERVED = new Set(['rewind', 'branch', 'export', 'effort', 'permissions', 'mcp', 'model', 'output-style', 'snippets', 'compact', 'clear']);

// What you get before you've saved any of your own. Deleting them all leaves an
// empty list, not these again.
const STARTERS = [
  { name: 'review', text: "Review my uncommitted changes (git diff, staged and unstaged). Point out bugs, risky edits and anything I've forgotten, most serious first. Don't change any files." },
  { name: 'tests', text: 'Write tests for $ARGUMENTS. Match the framework and style of the tests this project already has, cover the edge cases, and run them.' },
  { name: 'explain', text: 'Explain how $ARGUMENTS works: what it is for, the main path through it, and anything surprising. Don\'t change any files.' },
  { name: 'commit', text: "Write a commit message for my staged changes, in this repository's style, and show it to me. Don't commit." },
  { name: 'pr', text: 'Write a pull request description for this branch against the main branch: what changed, why, and how to test it.' },
];

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const cleanText = s => String(s).replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();

/** "  Review " -> "review", or null if it can't be a snippet's name. */
function normalizeName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim().replace(/^[/@]/, '').toLowerCase();
  return NAME.test(n) ? n : null;
}

/** One snippet, checked: { ok: true, snippet: { name, text } } | { ok: false, error } */
function check(input) {
  if (!isObj(input)) return { ok: false, error: 'Expected a snippet.' };
  const name = normalizeName(input.name);
  if (!name) return { ok: false, error: 'Give it a short name: lowercase letters, digits and dashes, up to 32.' };
  if (RESERVED.has(name)) return { ok: false, error: `/${name} is one of Shellby's own commands. Pick another name.` };
  const text = typeof input.text === 'string' ? cleanText(input.text) : '';
  if (!text) return { ok: false, error: 'What should it ask Claude?' };
  if (text.length > MAX_TEXT) return { ok: false, error: `Keep it under ${MAX_TEXT} characters.` };
  return { ok: true, snippet: { name, text } };
}

/**
 * The saved list, as settings.json has it, made safe to use: starters if there's
 * never been one, anything malformed or repeated dropped.
 */
function normalize(stored) {
  if (stored == null) return STARTERS.map(s => ({ ...s }));
  if (!Array.isArray(stored)) return [];
  const seen = new Set();
  const out = [];
  for (const s of stored) {
    const r = check(s);
    if (!r.ok || seen.has(r.snippet.name)) continue;
    seen.add(r.snippet.name);
    out.push(r.snippet);
    if (out.length >= MAX_SNIPPETS) break;
  }
  return out;
}

/**
 * Add a snippet, or change one. `was` is its name before an edit, so renaming
 * keeps its place in the list.
 *   { ok: true, list, name } | { ok: false, error }
 */
function save(list, input, was = null) {
  const r = check(input);
  if (!r.ok) return r;
  const { snippet } = r;
  const before = normalizeName(was);
  const at = before ? list.findIndex(s => s.name === before) : -1;
  if (list.some((s, i) => s.name === snippet.name && i !== at)) return { ok: false, error: `You already have a snippet called ${snippet.name}.` };
  if (at === -1 && list.length >= MAX_SNIPPETS) return { ok: false, error: `That's ${MAX_SNIPPETS} snippets already. Delete one first.` };
  const next = at === -1 ? [...list, snippet] : list.map((s, i) => (i === at ? snippet : s));
  return { ok: true, list: next, name: snippet.name };
}

function remove(list, name) {
  const n = normalizeName(name);
  return list.filter(s => s.name !== n);
}

const find = (list, name) => {
  const n = normalizeName(name);
  return n ? list.find(s => s.name === n) || null : null;
};

const needsInput = snippet => snippet.text.includes(PLACEHOLDER);

/**
 * The prompt a snippet stands for, with what followed its name filled in.
 *   { ok: true, prompt } | { ok: false, error }
 */
function expand(snippet, args = '', { max = MAX_TEXT, sigil = '/' } = {}) {
  const extra = cleanText(args ?? '');
  let prompt;
  if (needsInput(snippet)) {
    if (!extra) return { ok: false, error: `${sigil}${snippet.name} needs something after it, like: ${sigil}${snippet.name} src/app.js` };
    prompt = snippet.text.split(PLACEHOLDER).join(extra);
  } else {
    prompt = extra ? `${snippet.text}\n\n${extra}` : snippet.text;
  }
  if (prompt.length > max) return { ok: false, error: `With that added, ${sigil}${snippet.name} is longer than ${max} characters.` };
  return { ok: true, prompt };
}

/**
 * "/review the auth bits" -> { name: 'review', args: 'the auth bits' }, or null
 * when the text doesn't start with a shortcut. The terminal's @ is strict about
 * case, so `@Makefile` stays a file mention for Claude; the panel's / isn't.
 */
function parseShortcut(text, sigil = '/') {
  if (typeof text !== 'string') return null;
  const flags = sigil === '@' ? '' : 'i';
  const m = new RegExp(`^\\${sigil}([a-z0-9][a-z0-9-]{0,31})(?:\\s+([\\s\\S]*))?$`, flags).exec(text.trim());
  return m ? { name: m[1].toLowerCase(), args: (m[2] || '').trim() } : null;
}

/** First line, for menus and lists. */
function summary(snippet, max = 90) {
  const line = snippet.text.split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** What the panel shows. */
const view = list => list.map(s => ({ ...s, summary: summary(s), needsInput: needsInput(s) }));

/** `shellby snippets` */
function cliText(list) {
  if (!list.length) return 'No snippets yet. Save some in Shellby: Toolbox > Snippets.';
  const width = Math.max(...list.map(s => s.name.length)) + 1;
  return [
    'Your snippets (shellby do @name [more words]):',
    ...list.map(s => `  @${s.name.padEnd(width)} ${summary(s, 70)}`),
  ].join('\n');
}

/** The error for an @name that isn't one, with what there is instead. */
function unknownText(name, list) {
  const names = list.map(s => `@${s.name}`);
  return `No snippet called @${String(name).slice(0, 32)}.${names.length ? ` Yours: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}.` : ''} (shellby snippets lists them.)`;
}

module.exports = {
  normalizeName, check, normalize, save, remove, find, needsInput, expand, parseShortcut, summary, view, cliText, unknownText,
  NAME, MAX_TEXT, MAX_SNIPPETS, PLACEHOLDER, RESERVED, STARTERS,
};
