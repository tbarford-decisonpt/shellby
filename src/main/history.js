// Local conversation history: an index plus one JSONL transcript of UI items per
// conversation, in %APPDATA%/Shellby/sessions. Never leaves the machine.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Items worth replaying later. Transient ones (thinking, usage, raw logs) are skipped.
const PERSISTED = new Set(['user', 'text', 'tool', 'tool_result', 'result', 'error', 'decision', 'permission', 'task']);

// How many conversations the index remembers. Transcripts past this are deleted
// with their entry, rather than being left in the folder with nothing listing them.
const MAX_ENTRIES = 200;

class History {
  // onError: called with (what, err) when the disk refuses a write. History is a
  // convenience, never worth taking the app down for; see append().
  constructor(dir, { onError = () => {} } = {}) {
    this.dir = dir;
    this.indexFile = path.join(dir, 'index.json');
    this.onError = onError;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { this.onError('history dir', e); }
    const read = readIndex(this.indexFile);
    this.index = read.index;
    // A damaged index is never a licence to delete transcripts: see sweep().
    this.indexIntact = read.intact;
  }

  // The index is the only thing mapping an id to a conversation, so it's written
  // the way settings are (config.js): a temp file and a rename, never a partial
  // file in place. A crash mid-write used to leave truncated JSON, which parses
  // as nothing and empties the whole History list.
  saveIndex() {
    const tmp = `${this.indexFile}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.index, null, 2));
      fs.renameSync(tmp, this.indexFile);
      this.indexIntact = true;
    } catch (e) {
      this.onError('history index', e);
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
  }

  create({ id, title, cwd, mode, routineId = null }) {
    const now = Date.now();
    const entryId = typeof id === 'string' && /^[\w-]{1,64}$/.test(id) ? id : randomUUID();
    this.index = this.index.filter(e => e.id !== entryId);
    const entry = { id: entryId, title: titleFrom(title), cwd, mode, routineId, claudeSessionId: null, createdAt: now, updatedAt: now };
    this.index.unshift(entry);
    const dropped = this.index.slice(MAX_ENTRIES);
    this.index = this.index.slice(0, MAX_ENTRIES);
    this.saveIndex();
    // Their transcripts would otherwise sit in the folder forever, with nothing
    // left to list or delete them.
    for (const e of dropped) this.discard(e.id);
    return entry;
  }

  get(id) { return this.index.find(e => e.id === id) || null; }

  update(id, patch) {
    const e = this.get(id);
    if (!e) return;
    Object.assign(e, patch, { updatedAt: Date.now() });
    this.saveIndex();
  }

  append(id, item) {
    if (!PERSISTED.has(item.kind)) return;
    if (item.kind === 'task' && (item.phase === 'progress' || item.phase === 'updated')) return; // start + finish are enough to replay
    const rec = item.kind === 'permission' ? { ...item, input: undefined } : item;
    // Guarded: a full disk, or a file locked by antivirus or a cloud-sync folder,
    // used to throw from here straight into the session's item handler, in the
    // middle of a running task. Losing a transcript line is the lesser problem.
    try {
      fs.appendFileSync(this.file(id), JSON.stringify({ t: Date.now(), ...rec }) + '\n');
    } catch (e) {
      this.onError('transcript', e);
    }
  }

  load(id) {
    try {
      return fs.readFileSync(this.file(id), 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean); // a half-written last line (power loss mid-append) drops, the rest still replays
    } catch { return []; }
  }

  remove(id) {
    this.index = this.index.filter(e => e.id !== id);
    this.saveIndex();
    this.discard(id);
  }

  /** Delete one transcript, if the id is one we'd ever have written. */
  discard(id) {
    let file;
    try { file = this.file(id); } catch { return; }
    try { fs.rmSync(file, { force: true }); } catch (e) { this.onError('transcript delete', e); }
  }

  /**
   * Delete transcripts with no entry in the index: ones orphaned when an older
   * build trimmed the index, or left behind by an interrupted remove().
   * Returns how many went.
   *
   * Skipped entirely unless the index loaded cleanly, because for an unreadable
   * index "not listed" would mean "all of them".
   */
  sweep() {
    if (!this.indexIntact) return 0;
    const keep = new Set(this.index.map(e => e.id));
    let gone = 0;
    let names;
    try { names = fs.readdirSync(this.dir); } catch (e) { this.onError('history dir', e); return 0; }
    for (const name of names) {
      const m = /^([\w-]+)\.jsonl$/.exec(name);
      if (!m || keep.has(m[1])) continue;
      try { fs.rmSync(path.join(this.dir, name)); gone++; } catch { /* in use; next time */ }
    }
    return gone;
  }

  /** Bytes the transcripts take up, for Settings to show. */
  size() {
    let bytes = 0;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!/\.jsonl$/.test(name)) continue;
        try { bytes += fs.statSync(path.join(this.dir, name)).size; } catch { /* gone */ }
      }
    } catch { return 0; }
    return bytes;
  }

  list() { return this.index; }

  file(id) {
    if (!/^[\w-]+$/.test(id)) throw new Error('bad session id');
    return path.join(this.dir, `${id}.jsonl`);
  }
}

// { index, intact }: intact is false only when there IS an index file and it
// couldn't be read, which is what sweep() must not act on.
function readIndex(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { index: [], intact: e.code === 'ENOENT' }; // no file yet is a clean slate
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return { index: [], intact: false };
    return { index: parsed.filter(e => e && typeof e === 'object' && typeof e.id === 'string' && /^[\w-]+$/.test(e.id)), intact: true };
  } catch {
    return { index: [], intact: false };
  }
}

function titleFrom(text) {
  const t = String(text || 'New task').replace(/\s+/g, ' ').trim();
  return t.length > 70 ? t.slice(0, 67) + '…' : t;
}

module.exports = { History, titleFrom, MAX_ENTRIES };
