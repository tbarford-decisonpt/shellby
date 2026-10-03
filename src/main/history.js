// Local conversation history: an index plus one JSONL transcript of UI items per
// conversation, in %APPDATA%/Shellby/sessions. Never leaves the machine.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Items worth replaying later. Transient ones (thinking, usage, raw logs) are skipped.
const PERSISTED = new Set(['user', 'text', 'tool', 'tool_result', 'result', 'error', 'decision', 'permission', 'task', 'changes', 'undone', 'home', 'pushed', 'moved', 'compacted', 'fresh', 'rewound', 'shell', 'checkpoint', 'branched', 'branched-off']);

// How many conversations the index remembers. Transcripts past this are deleted
// with their entry, rather than being left in the folder with nothing listing them.
const MAX_ENTRIES = 200;

// How long a deleted conversation waits in Recently deleted before it goes for good.
const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

class History {
  // onError: called with (what, err) when the disk refuses a write. History is a
  // convenience, never worth taking the app down for; see append().
  constructor(dir, { onError = () => {} } = {}) {
    this.dir = dir;
    this.indexFile = path.join(dir, 'index.json');
    // Deleted conversations, kept apart from the index so nothing that reads
    // list() or get() ever sees one. Their transcripts stay where they were.
    this.trashFile = path.join(dir, 'trash.json');
    this.onError = onError;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { this.onError('history dir', e); }
    const read = readIndex(this.indexFile);
    this.index = read.index;
    // A damaged index is never a licence to delete transcripts: see sweep().
    this.indexIntact = read.intact;
    const bin = readIndex(this.trashFile);
    this.bin = bin.index;
    this.trashIntact = bin.intact;
  }

  // The index is the only thing mapping an id to a conversation, so it's written
  // the way settings are (config.js): a temp file and a rename, never a partial
  // file in place. A crash mid-write used to leave truncated JSON, which parses
  // as nothing and empties the whole History list.
  saveIndex() {
    if (writeJson(this.indexFile, this.index, e => this.onError('history index', e))) this.indexIntact = true;
  }

  saveTrash() {
    if (writeJson(this.trashFile, this.bin, e => this.onError('history trash', e))) this.trashIntact = true;
  }

  create({ id, title, cwd, mode, routineId = null }) {
    const now = Date.now();
    const entryId = typeof id === 'string' && /^[\w-]{1,64}$/.test(id) ? id : randomUUID();
    this.index = this.index.filter(e => e.id !== entryId);
    // A fresh start under a binned id would share its transcript file.
    if (this.bin.some(b => b.id === entryId)) { this.bin = this.bin.filter(b => b.id !== entryId); this.saveTrash(); }
    const entry ={ id: entryId, title: titleFrom(title), cwd, mode, routineId, claudeSessionId: null, createdAt: now, updatedAt: now };
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

  /**
   * Tick a conversation off, or put it back. Deliberately not update(): ticking
   * something off is not work on it, and bumping updatedAt would relabel a chat
   * from last Tuesday as "just now" in the History list.
   */
  setDone(id, done) {
    const e = this.get(id);
    if (!e) return null;
    if (done) e.done = true; else delete e.done;
    this.saveIndex();
    return e;
  }

  /**
   * Give a conversation a name of your own. Not update(), for the same reason as
   * setDone(): naming a chat isn't work on it. A blank name changes nothing.
   */
  rename(id, title) {
    const e = this.get(id);
    const t = cleanTitle(title);
    if (!e || !t) return null;
    e.title = t;
    this.saveIndex();
    return e;
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

  /**
   * Replace a transcript with `items` (already-loaded records, kept as they
   * are). Used by rewind, which cuts a conversation back to an earlier message.
   * Written the way the index is: a temp file and a rename, never half a file.
   */
  rewrite(id, items) {
    const file = this.file(id);
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, items.map(i => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      this.onError('transcript rewrite', e);
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      return false;
    }
  }

  /**
   * Gone for good, transcript and all. For tidying up after Shellby itself
   * (a branch that failed to start, a copy that no longer exists); a person
   * deleting a chat goes through trash() instead.
   */
  remove(id) {
    this.index = this.index.filter(e => e.id !== id);
    this.saveIndex();
    this.discard(id);
  }

  /**
   * Move a conversation to Recently deleted. The transcript stays on disk so
   * restore() can bring it back as it was. Returns the binned entry, or null.
   */
  trash(id, now = Date.now()) {
    const e = this.get(id);
    if (!e) return null;
    const binned = { ...e, deletedAt: now };
    this.bin = [binned, ...this.bin.filter(b => b.id !== id)];
    this.saveTrash();
    this.index = this.index.filter(x => x.id !== id);
    this.saveIndex();
    return binned;
  }

  /**
   * Put a deleted conversation back in History, in the place its start date
   * gives it (the index is newest first). Returns the entry, or null.
   */
  restore(id) {
    const b = this.bin.find(x => x.id === id);
    if (!b) return null;
    const { deletedAt: _gone, ...entry } = b;
    const rest = this.index.filter(x => x.id !== id);
    const at = rest.findIndex(x => (x.createdAt || 0) < (entry.createdAt || 0));
    this.index = at < 0 ? [...rest, entry] : [...rest.slice(0, at), entry, ...rest.slice(at)];
    this.saveIndex();
    this.bin = this.bin.filter(x => x.id !== id);
    this.saveTrash();
    return entry;
  }

  /** Recently deleted, newest deletion first, each with the time it'll be purged. */
  trashed() { return this.bin.map(b => ({ ...b, purgeAt: (b.deletedAt || 0) + TRASH_DAYS * DAY_MS })); }

  /** Delete binned conversations for good: these ids, or every one. Returns how many went. */
  purge(ids = null) {
    const go = ids ? new Set(ids) : null;
    const leaving = this.bin.filter(b => !go || go.has(b.id));
    if (!leaving.length) return 0;
    this.bin = this.bin.filter(b => go && !go.has(b.id));
    this.saveTrash();
    for (const b of leaving) this.discard(b.id);
    return leaving.length;
  }

  /** Purge whatever has sat in the bin longer than TRASH_DAYS. Returns how many went. */
  purgeExpired(now = Date.now()) {
    const cutoff = now - TRASH_DAYS * DAY_MS;
    return this.purge(this.bin.filter(b => !(b.deletedAt > cutoff)).map(b => b.id));
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
   * Skipped entirely unless the index and the bin both loaded cleanly, because
   * for an unreadable file "not listed" would mean "all of them".
   */
  sweep() {
    if (!this.indexIntact || !this.trashIntact) return 0;
    const keep = new Set([...this.index, ...this.bin].map(e => e.id));
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

// A temp file and a rename, never half a file. True if it landed.
function writeJson(file, value, onError) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    onError(e);
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return false;
  }
}

function titleFrom(text) {
  return cleanTitle(text) || 'New task';
}

// One line, at most 70 characters; '' when there's nothing left after trimming.
function cleanTitle(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 70 ? t.slice(0, 67) + '…' : t;
}

module.exports = { History, titleFrom, cleanTitle, MAX_ENTRIES, TRASH_DAYS };
