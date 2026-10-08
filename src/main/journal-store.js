// Where the project journal (journal.js) lives: one small JSON file per
// project in Shellby's profile, named by a hash of the project's folder so
// nothing about the folder is in the file name. A book is a few KB at most
// (journal.MAX_NOTES notes), so each one is read and written whole.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const journal = require('./journal');
const { caseKey } = require('./projects/merge');

const MAX_UP = 8;            // find(): how many folders up to look for a project's book
const MAX_BYTES = 512 * 1024; // a book bigger than this isn't one of ours

class JournalStore {
  /** dir: the folder the books go in (<userData>/journal). */
  constructor({ dir }) {
    this.dir = dir;
  }

  fileFor(root) {
    const id = crypto.createHash('sha1').update(caseKey(root)).digest('hex').slice(0, 20);
    return path.join(this.dir, `${id}.json`);
  }

  /** One project's book, or an empty one. */
  read(root) {
    try {
      const file = this.fileFor(root);
      if (fs.statSync(file).size > MAX_BYTES) return journal.normalize(null);
      return journal.normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return journal.normalize(null);
    }
  }

  /** Via a temp file, so a crash mid-write can't leave half a book. */
  write(root, book) {
    const file = this.fileFor(root);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...book, root }));
    fs.renameSync(tmp, file);
    return book;
  }

  /** Read, change, write. change(book) -> book. */
  update(root, name, change) {
    const before = this.read(root);
    const after = change({ ...before, name: name || before.name });
    return this.write(root, after);
  }

  /**
   * The book for a folder: its own, or the nearest folder above it that has
   * one (a subfolder of a project, a session that started deeper in).
   * -> { root, book } | null
   */
  find(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return null;
    let at = path.resolve(dir);
    for (let i = 0; i <= MAX_UP; i++) {
      if (fs.existsSync(this.fileFor(at))) {
        const book = this.read(at);
        if (book.notes.length || book.pins.length) return { root: book.root || at, book };
      }
      const up = path.dirname(at);
      if (up === at) break;
      at = up;
    }
    return null;
  }
}

module.exports = { JournalStore };
