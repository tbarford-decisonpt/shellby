'use strict';

const fs = require('fs');
const { lineOf, MAX_TEXT } = require('../../renderer/shared/diff');

const PLACE_MAX_BYTES = 2 * 1024 * 1024;

// Where an Edit lands in its file, so its diff can show real line numbers and
// a link can open the file at that line; and for a Write over a file that's
// already there, what it's replacing, so that's a diff too rather than a wall
// of green. Read before the edit runs: the CLI reports a tool call before it
// executes it. Off the main thread, which a 2 MB file would hold up: the
// session keeps the items after it waiting meanwhile (inOrder()).
async function placeEdit(item) {
  const first = item.edits?.[0];
  if (!item.filePath || !first) return;
  let text;
  try {
    if ((await fs.promises.stat(item.filePath)).size > PLACE_MAX_BYTES) return;
    text = (await fs.promises.readFile(item.filePath, 'utf8')).replace(/\r\n/g, '\n');
  } catch { return; } // a new file: nothing to compare with
  if (item.name === 'Write' || item.toolName === 'Write') {
    item.edits = [{ old: text.slice(0, MAX_TEXT), new: first.new }];
    item.line = 1;
  } else if (first.old) {
    item.line = lineOf(text, first.old.replace(/\r\n/g, '\n'));
  }
}

module.exports = { placeEdit };
