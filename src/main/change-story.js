// A turn's changes told as a story: its files grouped by what Claude was doing
// when it wrote them, in the order it did, instead of one flat list.
//
// The turn's transcript says it. Claude explains, then edits a run of files,
// then reads or runs something (a test, a build), then explains the next step
// and edits again. Each run of writes is one step, titled by what Claude said
// just before it. Files the diff shows but no edit of Claude's wrote (a script,
// an install, a formatter) close the story as their own step.
//
// story() is pure — see test/change-story.test.js.

const path = require('path');

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const TITLE_MAX = 90;
const MAX_STEPS = 12;           // past this the rest fold into the last step
const FROM_COMMANDS = 'Changed by commands it ran';

/** The first sentence of what Claude said, as a step's title. '' for none. */
function titleOf(text) {
  const flat = String(text || '').replace(/[`*_#>]+/g, '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const first = /^(.+?[.!?:])(\s|$)/.exec(flat)?.[1] || flat;
  const line = first.replace(/[:.]$/, '');
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

/** A written path as the diff names it (relative to the root, forward slashes), or null outside it. */
function relativeTo(root, file) {
  if (typeof file !== 'string' || !file || typeof root !== 'string' || !root) return null;
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * The turn's items, from your message (turnId) to the end of what it did.
 * An item list without that message gives [].
 */
function turnItems(items, turnId) {
  const list = Array.isArray(items) ? items : [];
  const at = list.findIndex(i => i?.kind === 'user' && i.turnId === turnId && typeof turnId === 'string');
  if (at < 0) return [];
  const next = list.findIndex((i, n) => n > at && i?.kind === 'user');
  return list.slice(at + 1, next < 0 ? list.length : next);
}

/**
 * items: one turn's transcript (turnItems). root: the repo. files: the diff's
 * files ([{ path, ... }], changes.summarize).
 *   -> [{ title, files: [path] }] in the order they happened, or null when
 *      there is no story worth telling (fewer than two steps).
 *
 * A file written in more than one step belongs to the first: that's where the
 * work on it began. Every file in the diff lands in exactly one step.
 */
function story(items, root, files) {
  const inDiff = new Set((Array.isArray(files) ? files : []).map(f => f?.path).filter(p => typeof p === 'string'));
  if (inDiff.size < 2) return null;
  const steps = [];
  const claimed = new Set();
  let said = '';      // the last thing Claude said
  let open = null;    // the step being written
  for (const i of Array.isArray(items) ? items : []) {
    if (i?.kind === 'text' && !i.sub) { said = i.text; open = null; continue; }
    if (i?.kind !== 'tool') continue;
    if (!WRITE_TOOLS.has(i.name)) { if (!i.sub) open = null; continue; }
    const rel = relativeTo(root, i.filePath);
    if (!rel || !inDiff.has(rel) || claimed.has(rel)) continue;
    if (!open) {
      open = { title: titleOf(said), files: [] };
      steps.push(open);
    }
    open.files.push(rel);
    claimed.add(rel);
  }
  const rest = [...inDiff].filter(p => !claimed.has(p));
  if (rest.length) steps.push({ title: FROM_COMMANDS, files: rest });
  if (steps.length < 2) return null;
  const kept = steps.slice(0, MAX_STEPS);
  for (const s of steps.slice(MAX_STEPS)) kept[kept.length - 1].files.push(...s.files);
  return kept.map((s, n) => ({ title: s.title || `Step ${n + 1}`, files: s.files }));
}

module.exports = { story, turnItems, titleOf, relativeTo, FROM_COMMANDS, MAX_STEPS };
