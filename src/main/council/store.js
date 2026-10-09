// The Council's minutes: the last sessions, kept in <userData>/council.json so
// reading an old one back costs nothing. Read and written whole (a few KB each).
const fs = require('fs');
const path = require('path');

const MAX_SESSIONS = 20;
const MAX_BYTES = 1024 * 1024;

class CouncilStore {
  /** dir: Shellby's userData folder. */
  constructor({ dir }) {
    this.file = path.join(dir, 'council.json');
  }

  /** Newest first. */
  list() {
    try {
      if (fs.statSync(this.file).size > MAX_BYTES) return [];
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(data?.sessions) ? data.sessions.filter(s => s && typeof s.id === 'string') : [];
    } catch {
      return [];
    }
  }

  get(id) {
    return this.list().find(s => s.id === id) || null;
  }

  /** Adds a session at the top, dropping the oldest past MAX_SESSIONS. */
  add(session) {
    return this.write([session, ...this.list().filter(s => s.id !== session.id)].slice(0, MAX_SESSIONS));
  }

  remove(id) {
    return this.write(this.list().filter(s => s.id !== id));
  }

  /** Via a temp file, so a crash mid-write can't leave half a file. */
  write(sessions) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sessions }));
    fs.renameSync(tmp, this.file);
    return sessions;
  }
}

/** What the history drawer lists: no full minutes. */
const summary = s => ({ id: s.id, at: s.at, question: s.question, mode: s.mode, verdict: s.chair?.verdict || '', tally: s.tally });

module.exports = { CouncilStore, summary, MAX_SESSIONS };
