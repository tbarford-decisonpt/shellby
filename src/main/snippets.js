// Prompt snippets: the things you ask Claude for again and again ("review my
// diff", "write tests for this file"), saved under a short name and run from the
// panel as /review or from a terminal as `shellby do @review`.
//
// A snippet is a name and the prompt it stands for. $ARGUMENTS in the prompt is
// replaced by whatever follows the name (the way Claude Code's own commands do
// it), and $1 to $9 by the words that follow it one at a time; the last one used
// takes everything left over, so `/fix 12 the login page` fills "Fix #$1: $2"
// sensibly. Without any of them, anything that follows goes on the end, after a
// blank line. $$1 is a $1 sent as it is, for an awk '{print $$1}'.
//
// Optional, per snippet: a hint for what goes after the name ("a file or folder",
// shown in the slash menu and `shellby snippets`), and newTab, to run it in a
// conversation of its own rather than the one you're in.
//
// Pure: settings in, settings out. main.js keeps the list in settings.json, and
// re-checks everything here whether the request came from the panel or the port.

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_TEXT = 4000;
const MAX_HINT = 60;
const MAX_SNIPPETS = 100;
const PLACEHOLDER = '$ARGUMENTS';
// $ARGUMENTS, or $1 to $9 on their own: not $10, $1x, or a price like $5.00 or US$5.
const SLOT = /\$ARGUMENTS|(?<![\w$])\$([1-9])(?!\w|[.,]\d)/g;
// The same, plus $$1, which is a $1 that's sent as it is (awk '{print $$1}').
const FILL = /(?<![\w$])\$\$([1-9])(?!\w|[.,]\d)|\$ARGUMENTS|(?<![\w$])\$([1-9])(?!\w|[.,]\d)/g;
// 2: $1 to $9 are blanks. Snippets saved before that had them escaped once (migrate).
const FORMAT = 2;
const EXPORT_KIND = 'shellby-snippets';

// Shellby's own slash commands in the panel (composer.js LOCAL_COMMANDS): a
// snippet called /export would never run. And Claude Code's /compact and /clear,
// which the panel's Compact and Start fresh send through the box themselves.
const RESERVED = new Set(['rewind', 'branch', 'btw', 'export', 'effort', 'permissions', 'mcp', 'model', 'output-style', 'snippets', 'compact', 'clear']);

// What you get before you've saved any of your own. Deleting them all leaves an
// empty list, not these again (Toolbox > Snippets can add them back).
const STARTERS = [
  { name: 'review', text: "Review my uncommitted changes (git diff, staged and unstaged). Point out bugs, risky edits and anything I've forgotten, most serious first. Don't change any files." },
  { name: 'tests', text: 'Write tests for $ARGUMENTS. Match the framework and style of the tests this project already has, cover the edge cases, and run them.', hint: 'a file or function' },
  { name: 'explain', text: 'Explain how $ARGUMENTS works: what it is for, the main path through it, and anything surprising. Don\'t change any files.', hint: 'a file, folder or feature' },
  { name: 'commit', text: "Write a commit message for my staged changes, in this repository's style, and show it to me. Don't commit." },
  { name: 'pr', text: 'Write a pull request description for this branch against the main branch: what changed, why, and how to test it.' },
];

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const cleanText = s => String(s).replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
const cleanHint = s => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().replace(/^<(.*)>$/, '$1').trim() : '');

/** "  Review " -> "review", or null if it can't be a snippet's name. */
function normalizeName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim().replace(/^[/@]/, '').toLowerCase();
  return NAME.test(n) ? n : null;
}

/**
 * The blanks in a prompt: whether it has $ARGUMENTS, and the highest $N.
 *   "Fix #$1: $2" -> { all: false, count: 2 }
 */
function slots(text) {
  let all = false;
  let count = 0;
  for (const m of String(text).matchAll(SLOT)) {
    if (m[1]) count = Math.max(count, Number(m[1]));
    else all = true;
  }
  return { all, count };
}

const needsInput = snippet => { const s = slots(snippet.text); return s.all || s.count > 0; };

/** One snippet, checked: { ok: true, snippet: { name, text, hint?, newTab? } } | { ok: false, error } */
function check(input) {
  if (!isObj(input)) return { ok: false, error: 'Expected a snippet.' };
  const name = normalizeName(input.name);
  if (!name) return { ok: false, error: 'Give it a short name: lowercase letters, digits and dashes, up to 32.' };
  if (RESERVED.has(name)) return { ok: false, error: `/${name} is one of Shellby's own commands. Pick another name.` };
  const text = typeof input.text === 'string' ? cleanText(input.text) : '';
  if (!text) return { ok: false, error: 'What should it ask Claude?' };
  if (text.length > MAX_TEXT) return { ok: false, error: `Keep it under ${MAX_TEXT} characters.` };
  const hint = cleanHint(input.hint);
  if (hint.length > MAX_HINT) return { ok: false, error: `Keep the hint under ${MAX_HINT} characters.` };
  const snippet = { name, text };
  // A hint only means something when there's a blank for it to describe.
  if (hint && needsInput(snippet)) snippet.hint = hint;
  if (input.newTab === true) snippet.newTab = true;
  return { ok: true, snippet };
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

/** A name nothing in the list has yet: review, then review-2, review-3… */
function freeName(list, base) {
  const taken = new Set(list.map(s => s.name));
  const root = normalizeName(base) || 'snippet';
  if (!taken.has(root) && !RESERVED.has(root)) return root;
  for (let i = 2; i < 1000; i++) {
    const tail = `-${i}`;
    const n = `${root.slice(0, 32 - tail.length).replace(/-+$/, '')}${tail}`;
    if (!taken.has(n)) return n;
  }
  return null;
}

/** A copy of one, named review-2 and so on, straight after it in the list. */
function duplicate(list, name) {
  const s = find(list, name);
  if (!s) return { ok: false, error: 'That snippet has gone.' };
  if (list.length >= MAX_SNIPPETS) return { ok: false, error: `That's ${MAX_SNIPPETS} snippets already. Delete one first.` };
  const copy = { ...s, name: freeName(list, s.name) };
  const at = list.indexOf(s);
  return { ok: true, list: [...list.slice(0, at + 1), copy, ...list.slice(at + 1)], name: copy.name };
}

/**
 * What followed the name, split for $1 to $N: a word each, "quoted words"
 * together, and everything left over in the last one.
 */
function splitArgs(extra, count) {
  // Only one quoted thing loses its quotes: "a" "b" left over stays as it is.
  const unquote = t => t.replace(/^"([^"]*)"$|^'([^']*)'$/, '$1$2');
  const parts = [];
  const word = /"[^"]*"|'[^']*'|\S+/g;
  let m;
  while (parts.length < count - 1 && (m = word.exec(extra))) parts.push(unquote(m[0]));
  const rest = extra.slice(parts.length ? word.lastIndex : 0).trim();
  if (rest) parts.push(unquote(rest));
  return parts;
}

/**
 * The blanks filled by `get` ($1 -> get('1'), $ARGUMENTS -> get(undefined)), and
 * each $$1 sent as $1. A function, so a $& or $' you typed is taken as it is, not
 * as a replacement pattern.
 */
const fill = (text, get) => text.replace(FILL, (_m, esc, n) => (esc ? `$${esc}` : get(n)));

/**
 * Snippets saved before $1 to $9 were blanks, kept meaning what they did: an
 * awk '{print $1}' or "costs $1" in one becomes $$1, which still sends as $1.
 * Run once over settings.json's list (main.js, snippetFormat).
 */
function migrate(stored) {
  if (!Array.isArray(stored)) return stored;
  return stored.map(s => (isObj(s) && typeof s.text === 'string'
    ? { ...s, text: s.text.replace(SLOT, (m, n) => (n ? `$$${n}` : m)) }
    : s));
}

/**
 * The prompt a snippet stands for, with what followed its name filled in.
 *   { ok: true, prompt } | { ok: false, error }
 */
function expand(snippet, args = '', { max = MAX_TEXT, sigil = '/' } = {}) {
  const extra = cleanText(args ?? '');
  const call = `${sigil}${snippet.name}`;
  const like = snippet.hint ? `<${snippet.hint}>` : 'src/app.js';
  const { all, count } = slots(snippet.text);
  let prompt;
  if (all || count) {
    if (!extra) return { ok: false, error: `${call} needs something after it, like: ${call} ${like}` };
    const parts = count ? splitArgs(extra, count) : [];
    if (parts.length < count) return { ok: false, error: `${call} needs ${count} things after it${snippet.hint ? `: ${snippet.hint}` : ', with spaces between them'}.` };
    prompt = fill(snippet.text, n => (n ? parts[Number(n) - 1] : extra));
  } else {
    const text = fill(snippet.text, () => '');
    prompt = extra ? `${text}\n\n${extra}` : text;
  }
  if (prompt.length > max) return { ok: false, error: `With that added, ${call} is longer than ${max} characters.` };
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

// ------------------------------------------------------------ how often each is used
// Kept beside the list (settings.json snippetUse), not in it, so a snippet is
// still just what you wrote: { name: { n, at } }.

function noteUse(stats, name, now = Date.now()) {
  const n = normalizeName(name);
  if (!n) return stats || {};
  const was = stats?.[n];
  return { ...stats, [n]: { n: (Number.isFinite(was?.n) ? was.n : 0) + 1, at: now } };
}

/** Stats for the snippets there are, with a rename carried across. */
function keepUse(stats, list, renamed = null) {
  const out = {};
  for (const s of list) {
    const from = renamed && renamed.to === s.name ? renamed.from : s.name;
    const u = stats?.[from] ?? stats?.[s.name];
    if (isObj(u) && Number.isFinite(u.n) && u.n > 0) out[s.name] = { n: u.n, at: Number.isFinite(u.at) ? u.at : null };
  }
  return out;
}

/** What the panel shows. */
const view = (list, stats = {}) => list.map((s) => {
  const { all, count } = slots(s.text);
  const u = stats?.[s.name];
  return { ...s, summary: summary(s), needsInput: all || count > 0, slots: count, uses: u?.n || 0, lastUsed: u?.at ?? null };
});

// ------------------------------------------------------------ sharing them

/** A file someone else can import: Toolbox > Snippets > Export. */
function exportJson(list) {
  return `${JSON.stringify({ kind: EXPORT_KIND, version: 1, snippets: list }, null, 2)}\n`;
}

/** An export file, or a bare array of { name, text }, read: { ok, snippets } | { ok: false, error } */
function parseImport(raw) {
  let data;
  try { data = JSON.parse(String(raw).replace(/^\uFEFF/, '')); } catch { return { ok: false, error: "That file isn't snippets: it isn't JSON." }; }
  const items = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.snippets) ? data.snippets : null;
  if (!items) return { ok: false, error: "That file isn't snippets: there's no list of them in it." };
  return { ok: true, snippets: items };
}

/**
 * Add what came in to the list. One you already have word for word is skipped;
 * one whose name you've used for something else comes in as name-2.
 *   { list, added: [name], renamed: [{ from, to }], skipped }
 */
function merge(list, incoming) {
  let out = [...list];
  const added = [];
  const renamed = [];
  let skipped = 0;
  for (const raw of incoming) {
    const r = check(isObj(raw) && RESERVED.has(normalizeName(raw.name)) ? { ...raw, name: `${normalizeName(raw.name)}-2` } : raw);
    if (!r.ok) { skipped++; continue; }
    const s = r.snippet;
    if (out.some(x => x.text === s.text)) { skipped++; continue; }
    if (out.length >= MAX_SNIPPETS) { skipped++; continue; }
    const name = freeName(out, s.name);
    if (!name) { skipped++; continue; }
    if (name !== s.name) renamed.push({ from: s.name, to: name });
    out = [...out, { ...s, name }];
    added.push(name);
  }
  return { list: out, added, renamed, skipped };
}

// ------------------------------------------------------------ the terminal

/** `shellby snippets` */
function cliText(list) {
  if (!list.length) return 'No snippets yet. Save some in Shellby: Toolbox > Snippets.';
  const label = s => `@${s.name}${s.hint ? ` <${s.hint}>` : ''}`;
  const width = Math.min(Math.max(...list.map(s => label(s).length)) + 1, 40);
  return [
    'Your snippets (shellby do @name [more words]):',
    ...list.map(s => `  ${label(s).padEnd(width)} ${summary(s, 70)}`),
  ].join('\n');
}

/** The error for an @name that isn't one, with what there is instead. */
function unknownText(name, list) {
  const names = list.map(s => `@${s.name}`);
  return `No snippet called @${String(name).slice(0, 32)}.${names.length ? ` Yours: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}.` : ''} (shellby snippets lists them.)`;
}

module.exports = {
  normalizeName, check, normalize, save, remove, find, freeName, duplicate, slots, needsInput, splitArgs, expand, parseShortcut, summary,
  noteUse, keepUse, view, exportJson, parseImport, merge, migrate, cliText, unknownText,
  NAME, MAX_TEXT, MAX_HINT, MAX_SNIPPETS, PLACEHOLDER, RESERVED, STARTERS, EXPORT_KIND, FORMAT,
};
