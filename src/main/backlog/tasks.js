// Your own tasks for a project, kept in the repository as .shellby/tasks.md
// (docs/plans/next-up.md). Plain Markdown task lists, so the file reads fine on
// GitHub and in any editor:
//
//   ## Now
//   - [ ] Panel flickers on the second monitor
//     Only on the second monitor.        <- notes: lines indented under it
//   ## Next
//   - [ ] #42 start with the parser      <- a reference to issue #42
//   - [ ] ENG-123                        <- or to a Linear or Jira issue
//   ## Done
//   - [x] Rename the branch prefix (2026-10-05)
//
// Edits are line-level: everything else in the file (prose, other headings,
// tables, its line endings) is kept byte for byte. Each edit names an item by
// its id and the line it was on, and is refused if that line no longer says
// it, the way a loose end's "Do this" is (wiring/startfrom.js).
//
// Pure: text in, text out. test/backlog-tasks.test.js.
const crypto = require('crypto');
const { clip } = require('../github/issues');

const FILE = '.shellby/tasks.md';
const MAX_ITEMS = 200;
const MAX_TITLE = 200;
const MAX_NOTES = 40;      // lines of notes kept per item
const MAX_NOTE = 400;

const ITEM = /^( {0,3})([-*]) \[( |x|X)\][ \t]+(.*\S)\s*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const REF = /^(?:([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}))?#(\d{1,9})(?![\w-])[\s:.\-–—]*(.*)$/;
// ENG-123 (Linear), SHB-42 (Jira): only a reference when Next up lists that issue (rank.js).
const TICKET_REF = /^([A-Z][A-Z0-9_]{0,9}-\d{1,7})(?![\w-])[\s:.\-–—]*(.*)$/;
const FROM_SUFFIX = / \(from (Claude Code|the terminal)\)$/;
const FROM_TEXT = { claude: 'Claude Code', terminal: 'the terminal' };
const DATE_SUFFIX =/ \(\d{4}-\d\d-\d\d\)$/;

// Shown in the panel and in a prompt: no control, bidi or invisible characters.
const clean = (s, n) => clip(String(s ?? ''), n);

const TEMPLATE = [
  '# Tasks',
  '',
  'Shellby\'s Next up list reads this file. Higher up means sooner.',
  '',
  '## Now',
  '',
  '## Next',
  '',
].join('\n');

/** A heading's name -> which part of the list it's for. */
function sectionOf(name) {
  const n = String(name || '').trim().toLowerCase();
  if (n === 'now') return 'now';
  if (n === 'later' || n === 'someday') return 'later';
  if (n === 'done') return 'done';
  return 'next';
}

const indentOf = l => /** @type {RegExpExecArray} */ (/^[ \t]*/.exec(l))[0].replace(/\t/g, '    ').length;

function splitLines(text) {
  const s = String(text ?? '');
  return {
    lines: s.length ? s.replace(/\r?\n$/, '').split(/\r?\n/) : [],
    eol: s.includes('\r\n') ? '\r\n' : '\n',
    // An empty or new file ends with a newline, like an editor would leave it.
    trailing: !s.length || /\n$/.test(s),
  };
}

function joinLines({ lines, eol, trailing }) {
  return lines.join(eol) + (trailing && lines.length ? eol : '');
}

/**
 * Where an item's block ends: the item line plus the lines indented under it
 * (blank lines only when more of it follows). -> index past its last line.
 */
function blockEnd(lines, start) {
  const base = indentOf(lines[start]);
  let end = start + 1;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    // Anything indented deeper is the item's, a "# install" line in a pasted snippet included.
    if (indentOf(l) <= base) break;
    end = i + 1;
  }
  return end;
}

/**
 * The file -> its tasks.
 * -> { items: [{ id, line, title, notes, section, heading, done, ref, ticket }], done, more }
 *   line: 1-based. ref: { repo|null, number, note } for "#42 …". ticket: { key, note } for "ENG-123 …". done: how many
 *   are ticked off (they aren't in items). more: items past the cap.
 */
function parse(text) {
  const { lines } = splitLines(text);
  const items = [];
  const seen = new Map();
  let section = 'next';
  let heading = '';
  let done = 0;
  let more = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING.exec(lines[i]);
    if (h) { section = sectionOf(h[2]); heading = clean(h[2], 60); continue; }
    const m = ITEM.exec(lines[i]);
    if (!m) continue;
    const end = blockEnd(lines, i);
    if (m[3] !== ' ') { done++; i = end - 1; continue; }
    if (items.length >= MAX_ITEMS) { more++; i = end - 1; continue; }
    const raw = clean(m[4], MAX_TITLE);
    // "(from Claude Code)" / "(from the terminal)": who added it, when it wasn't you (add_task, shellby next add).
    const by = FROM_SUFFIX.exec(raw);
    const title = by ? raw.slice(0, by.index).trim() : raw;
    const from = by ? (by[1] === 'Claude Code' ? 'claude' : 'terminal') : 'you';
    if (!title) { i = end - 1; continue; }
    const base = indentOf(lines[i]);
    const notes = lines.slice(i + 1, end)
      .map(l => (l.trim() ? l.replace(/\t/g, '    ').slice(Math.min(base + 2, indentOf(l))) : ''))
      // Sub-items keep their indent; the rest is cleaned like a title.
      .map(l => `${/** @type {RegExpExecArray} */ (/^ */.exec(l))[0].slice(0, 12)}${clean(l, MAX_NOTE)}`.trimEnd())
      .slice(0, MAX_NOTES);
    while (notes.length && !notes[notes.length - 1]) notes.pop();
    const r = REF.exec(title);
    const ref = r ? { repo: r[1] || null, number: Number(r[2]), note: clean(r[3], MAX_TITLE) } : null;
    const k = r ? null : TICKET_REF.exec(title);
    const ticket = k ? { key: k[1], note: clean(k[2], MAX_TITLE) } : null;
    // Section and title make the id, so it stays put when lines above it move.
    const key = `${section}\n${raw.toLowerCase()}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    const id = `t:${crypto.createHash('sha1').update(key).digest('hex').slice(0, 10)}${n > 1 ? `~${n}` : ''}`;
    items.push({ id, line: i + 1, title, from, notes, section: section === 'done' ? 'next' : section, heading, done: false, ref, ticket });
    i = end - 1;
  }
  return { items, done, more };
}

// ------------------------------------------------------------------ edits

const stale = () => ({ ok: false, stale: true, error: 'That list has changed since Shellby read it. Look again.' });

/** The item still where the panel saw it, or null. */
function locate(text, { id, line }) {
  const item = parse(text).items.find(i => i.id === id);
  return item && item.line === line ? item : null;
}

/** Headings in the file: [{ index, level, section, name }]. */
function headings(lines) {
  const out = [];
  lines.forEach((l, index) => {
    const h = HEADING.exec(l);
    if (h) out.push({ index, level: h[1].length, section: sectionOf(h[2]), name: h[2].trim().toLowerCase() });
  });
  return out;
}

/** Where a heading's section ends (the next heading at its level or above), less the blank lines before it. */
function sectionEnd(lines, hs, h) {
  const next = hs.find(x => x.index > h.index && x.level <= h.level);
  let end = next ? next.index : lines.length;
  while (end > h.index + 1 && !lines[end - 1].trim()) end--;
  return end;
}

/**
 * Put `block` at the end of the section named `name` (now, next, later, done),
 * making the section if the file has none: Now before the first `##`, Next
 * after Now, Later and Done at the end.
 */
function insertInSection(lines, name, block) {
  const hs = headings(lines);
  const h = hs.find(x => x.name === name) || hs.find(x => x.section === name && name !== 'next' && x.level >= 2);
  if (h) {
    const at = sectionEnd(lines, hs, h);
    // Straight under its heading when the section is empty, after a blank line otherwise only if one was there.
    return [...lines.slice(0, at), ...block, ...lines.slice(at)];
  }
  const title = `## ${name[0].toUpperCase()}${name.slice(1)}`;
  const fresh = [title, ...block];
  const gap = list => (list.length && list[list.length - 1].trim() ? [''] : []);
  if (name === 'now') {
    const first = hs.find(x => x.level >= 2);
    if (first) return [...lines.slice(0, first.index), ...fresh, '', ...lines.slice(first.index)];
  }
  if (name === 'next') {
    const now = hs.find(x => x.name === 'now');
    if (now) {
      const at = sectionEnd(lines, hs, now);
      return [...lines.slice(0, at), '', ...fresh, ...lines.slice(at)];
    }
  }
  if (name === 'later') {
    const doneH = hs.find(x => x.name === 'done');
    if (doneH) return [...lines.slice(0, doneH.index), ...fresh, '', ...lines.slice(doneH.index)];
  }
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  const head = lines.slice(0, end);
  return [...head, ...gap(head), ...fresh];
}

/** An item's block, re-indented to sit at the left of a section. */
function liftBlock(lines, start, end) {
  const base = indentOf(lines[start]);
  return lines.slice(start, end).map(l => (l.trim() ? l.replace(/\t/g, '    ').slice(Math.min(base, indentOf(l))) : l));
}

// A file that mixes CRLF and LF lines would come back all one or the other: not "byte for byte".
const mixed = text => /\r\n/.test(String(text)) && /(^|[^\r])\n/.test(String(text));
const MIXED = { ok: false, error: '.shellby/tasks.md mixes line endings (CRLF and LF), so Shellby won\'t rewrite it. Save it with one kind, then try again.' };

function edit(text, ref, fn) {
  if (mixed(text)) return MIXED;
  const item = locate(text, ref);
  if (!item) return stale();
  const f = splitLines(text);
  const start = item.line - 1;
  const end = blockEnd(f.lines, start);
  const lines = fn(f.lines, start, end, item);
  if (!lines) return stale();
  return { ok: true, text: joinLines({ ...f, lines }) };
}

/** Add a task at the end of `## Next` (or `to`). text: the file, or '' / null for a new one. */
function add(text, title, { to = 'next', from = 'you' } = {}) {
  // Who added it, when it wasn't you, rides along as a suffix parse() reads back.
  const by = FROM_TEXT[from] ? ` (from ${FROM_TEXT[from]})` : '';
  const words = clean(title, MAX_TITLE - by.length);
  const t = words && `${words}${by}`;
  if (!t) return { ok: false, error: 'Write the task first.' };
  if (mixed(text)) return MIXED;
  const f = splitLines(text || TEMPLATE);
  if (parse(text || '').items.length >= MAX_ITEMS) return { ok: false, error: `That list already has ${MAX_ITEMS} tasks. Tick some off first.` };
  return { ok: true, text: joinLines({ ...f, lines: insertInSection(f.lines, to, [`- [ ] ${t}`]) }) };
}

/** Tick it off: [x], today's date, and the item (notes and all) moves under `## Done`. */
function tick(text, ref, date) {
  const day = /^\d{4}-\d\d-\d\d$/.test(String(date)) ? date : new Date().toISOString().slice(0, 10);
  return edit(text, ref, (lines, start, end) => {
    const block = liftBlock(lines, start, end);
    block[0] = block[0].replace(/\[ \]/, '[x]').replace(DATE_SUFFIX, '').replace(/\s*$/, ` (${day})`);
    return insertInSection([...lines.slice(0, start), ...lines.slice(end)], 'done', block);
  });
}

/** A new title; the notes stay. */
function rename(text, ref, title) {
  const t = clean(title, MAX_TITLE);
  if (!t) return { ok: false, error: 'A task needs some words.' };
  return edit(text, ref, (lines, start) => {
    const m = ITEM.exec(lines[start]);
    if (!m) return null;
    const out = [...lines];
    out[start] = `${m[1]}${m[2]} [ ] ${t}`;
    return out;
  });
}

/** The item and its notes, gone. */
function remove(text, ref) {
  return edit(text, ref, (lines, start, end) => [...lines.slice(0, start), ...lines.slice(end)]);
}

/** To the end of `## Now`, `## Next` or `## Later`. */
function move(text, ref, to) {
  if (!['now', 'next', 'later'].includes(to)) return { ok: false, error: 'Move it to Now, Next or Later.' };
  return edit(text, ref, (lines, start, end) => insertInSection([...lines.slice(0, start), ...lines.slice(end)], to, liftBlock(lines, start, end)));
}

module.exports = { parse, add, tick, rename, remove, move, clean, sectionOf, FILE, TEMPLATE, MAX_ITEMS, MAX_TITLE };
