// Writing a file so that it survives the PC losing power.
//
// A temp file and a rename is not enough on its own: Windows can put the rename
// on disk before the data, and a power cut in between leaves a file of the
// right size full of zero bytes. That wiped a whole settings.json (every
// routine, GitHub choice and screen opened) on a PC that was switched off at
// the wall. Flushing the temp file before the rename means the file afterwards
// is either the old one or the new one, never zeros.
const fs = require('fs');

/** Write `data` to `file` via `file.tmp`, flushed to disk before the rename. */
function writeFileDurable(file, data, { mode, rename = (from, to) => fs.renameSync(from, to) } = {}) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  rename(tmp, file);
}

module.exports = { writeFileDurable };
