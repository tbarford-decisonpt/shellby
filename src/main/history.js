// Local conversation history: an index plus one JSONL transcript of UI items per
// conversation, in %APPDATA%/Shellby/sessions. It stays on this PC unless you
// turn on "Sync conversation history" (history-sync.js), which sends a trimmed
// copy of the newest ones to a private gist of yours.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { writeFileDurable } = require('./durable');

// Items worth replaying later. Transient ones (thinking, usage, raw logs) are skipped.
const PERSISTED = new Set(['user', 'text', 'tool', 'tool_result', 'result', 'error', 'decision', 'permission', 'task', 'changes', 'undone', 'home', 'pushed', 'moved', 'phone', 'checks', 'shots', 'tries', 'compacted', 'fresh', 'cleared', 'rewound', 'shell', 'checkpoint', 'branched', 'branched-off', 'handoff', 'modlog', 'surprise', 'suggest', 'cutoff', 'step-point', 'undone-step', 'debug']);

// How many conversations the index remembers. Transcripts past this are deleted
// with their entry, rather than being left in the folder with nothing listing them.
const MAX_ENTRIES = 200;

// How long a deleted conversation waits in Recently deleted before it goes for good.
const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Every result, init and review mark used to rewrite the whole index there and
// then, and every item was its own append: a busy turn was a stream of small
// synchronous writes on the main thread. Bookkeeping now waits this long and
// goes in one write; anything that reads the file, and quitting, flushes first.
const INDEX_SAVE_MS = 1000;
const APPEND_MS = 100;

class History {
  // onError: called with (what, err) when the disk refuses a write. History is a
  // convenience, never worth taking the app down for; see append().
  // onGone: called with the ids of conversations you deleted (trash, clear),
  // so history sync can tell your other PCs (history-sync.js).
  constructor(dir, { onError = () => {}, onGone = () => {}, indexSaveMs = INDEX_SAVE_MS, appendMs = APPEND_MS } = {}) {
    this.dir = dir;
    this.indexSaveMs = indexSaveMs;
    this.appendMs = appendMs;
    this.indexTimer = null;
    this.pending = new Map(); // id -> transcript lines not written yet, in order
    this.appendTimer = null;
    this.indexFile = path.join(dir, 'index.json');
    // Deleted conversations, kept apart from the index so nothing that reads
    // list() or get() ever sees one. Their transcripts stay where they were.
    this.trashFile = path.join(dir, 'trash.json');
    this.onError = onError;
    this.onGone = onGone;
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
    clearTimeout(this.indexTimer);
    this.indexTimer = null;
    if (writeJson(this.indexFile, this.index, e => this.onError('history index', e))) this.indexIntact = true;
  }

  // For the frequent, small changes (update, setReady): one write in a moment.
  saveIndexSoon() {
    if (this.indexTimer) return;
    this.indexTimer = setTimeout(() => this.saveIndex(), this.indexSaveMs);
    this.indexTimer.unref?.();
  }

  /**
   * Write whatever is waiting: the index, and the transcript lines of one
   * conversation (id) or of all of them. On quit, and before anything reads.
   */
  flush(id = null) {
    if (id == null && this.indexTimer) this.saveIndex();
    for (const key of id == null ? [...this.pending.keys()] : [id]) {
      const lines = this.pending.get(key);
      if (!lines) continue;
      this.pending.delete(key);
      // Guarded: a full disk, or a file locked by antivirus or a cloud-sync folder,
      // used to throw from here straight into the session's item handler, in the
      // middle of a running task. Losing a transcript line is the lesser problem.
      try {
        fs.appendFileSync(this.file(key), lines.join(''));
      } catch (e) {
        this.onError('transcript', e);
      }
    }
    if (!this.pending.size) { clearTimeout(this.appendTimer); this.appendTimer = null; }
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
    this.saveIndexSoon();
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
    e.editedAt = Date.now(); // for history sync: a change, though not work
    this.saveIndex();
    return e;
  }

  /**
   * Where its latest changes stand in the review inbox (review-inbox.js), or null.
   * Not update() either: reviewing isn't work on the conversation.
   */
  setReady(id, ready) {
    const e = this.get(id);
    if (!e) return null;
    if (ready) e.ready = ready; else delete e.ready;
    this.saveIndexSoon();
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
    e.editedAt = Date.now();
    this.saveIndex();
    return e;
  }

  /**
   * A turn has started (turn: { turnId, at }) or ended (null). Written at once,
   * index and transcript both: if the PC loses power mid-turn, the next start
   * still knows this conversation was cut off (takeCutOff). Not update(): the
   * message itself already counts as work.
   */
  markTurn(id, turn) {
    const e = this.get(id);
    if (!e || (!turn && !e.turnOpen)) return;
    if (turn) e.turnOpen = { turnId: turn.turnId || null, at: turn.at || Date.now() }; else delete e.turnOpen;
    this.flush(id);
    this.saveIndex();
  }

  /**
   * At boot, before any tab is open: every conversation whose turn never
   * ended. Each gets a 'cutoff' line after the message it was on, and is
   * marked lastOutcome 'cut' until a turn there finishes. crashed: the last
   * run ended without quitting (crash-report.js), so the PC or Shellby went
   * down; otherwise Shellby was quit mid-turn. -> the entries, newest first.
   */
  takeCutOff({ crashed = false } = {}) {
    const cut = this.index.filter(e => e.turnOpen);
    if (!cut.length) return [];
    for (const e of cut) {
      this.append(e.id, { kind: 'cutoff', turnId: e.turnOpen.turnId, since: e.turnOpen.at, crashed });
      e.lastOutcome = 'cut';
      delete e.turnOpen;
    }
    this.flush();
    this.saveIndex();
    return cut;
  }

  append(id, item) {
    if (!PERSISTED.has(item.kind)) return;
    if (item.kind === 'task' && (item.phase === 'progress' || item.phase === 'updated')) return; // start + finish are enough to replay
    // A permission card's edit text is the tool's input too; the tool row keeps the diff.
    const rec = item.kind === 'permission' ? { ...item, input: undefined, edits: undefined } : item;
    try { this.file(id); } catch (e) { this.onError('transcript', e); return; }
    // Held a moment and written with whatever else arrives meanwhile (flush()).
    const line = JSON.stringify({ t: Date.now(), ...rec }) + '\n';
    const lines = this.pending.get(id);
    if (lines) lines.push(line); else this.pending.set(id, [line]);
    if (!this.appendTimer) {
      this.appendTimer = setTimeout(() => { this.appendTimer = null; this.flush(); }, this.appendMs);
      this.appendTimer.unref?.();
    }
  }

  load(id) {
    this.flush(id);
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
    this.flush(id); // lines still on their way were written before the cut, not after it
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
  trash(id, now = Date.now(), { quiet = false } = {}) {
    const e = this.get(id);
    if (!e) return null;
    // quiet: history sync binning one you deleted on another PC, which knows already.
    if (!quiet) this.onGone([id], now);
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
    // Newer than its deletion, so history sync brings it back on your other PCs too.
    entry.editedAt = Date.now();
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

  /**
   * Every conversation gone for good: the list, Recently deleted, and every
   * transcript in the folder, listed or not. Unlike sweep(), this is a person
   * asking for a clean slate, so a damaged index doesn't hold it back.
   * Returns how many conversations went.
   */
  clear() {
    const gone = this.index.length + this.bin.length;
    if (gone) this.onGone([...this.index, ...this.bin].map(e => e.id), Date.now());
    this.index = [];
    this.bin = [];
    this.pending.clear();
    this.saveIndex();
    this.saveTrash();
    let names;
    try { names = fs.readdirSync(this.dir); } catch (e) { this.onError('history dir', e); return gone; }
    for (const name of names) {
      const m = /^([\w-]+)\.jsonl$/.exec(name);
      if (m) this.discard(m[1]);
    }
    return gone;
  }

  /** Delete one transcript, if the id is one we'd ever have written. */
  discard(id) {
    let file;
    try { file = this.file(id); } catch { return; }
    this.pending.delete(id); // lines on their way to a file that's going
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
    this.flush();
    let bytes = 0;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!/\.jsonl$/.test(name)) continue;
        try { bytes += fs.statSync(path.join(this.dir, name)).size; } catch { /* gone */ }
      }
    } catch { return 0; }
    return bytes;
  }

  // ---------------------------------------------------------- history sync
  // Bookkeeping for history-sync.js. None of it is update(): bringing a
  // conversation over from another PC isn't work on it here.

  /**
   * Put in a conversation from another PC, or replace this PC's copy with a
   * newer one: the entry as given, the transcript as given. Its place is the
   * one its start date gives it. A copy in Recently deleted makes way.
   */
  putSynced(entry, items) {
    if (!entry || typeof entry.id !== 'string' || !/^[\w-]{1,64}$/.test(entry.id)) return null;
    this.pending.delete(entry.id); // replaced wholesale
    if (!this.rewrite(entry.id, items)) return null;
    if (this.bin.some(b => b.id === entry.id)) { this.bin = this.bin.filter(b => b.id !== entry.id); this.saveTrash(); }
    const rest = this.index.filter(x => x.id !== entry.id);
    const at = rest.findIndex(x => (x.createdAt || 0) < (entry.createdAt || 0));
    this.index = at < 0 ? [...rest, entry] : [...rest.slice(0, at), entry, ...rest.slice(at)];
    const dropped = this.index.slice(MAX_ENTRIES);
    this.index = this.index.slice(0, MAX_ENTRIES);
    this.saveIndex();
    for (const e of dropped) this.discard(e.id);
    return entry;
  }

  /** Fields only history sync keeps (syncedAt, pc, …), without counting as a change. */
  markSynced(id, patch) {
    const e = this.get(id);
    if (!e) return null;
    Object.assign(e, patch);
    this.saveIndexSoon();
    return e;
  }

  /**
   * Give a conversation a new id, transcript and all: when it changed on two
   * PCs at once, this PC's version moves aside so the other's can take its
   * place (history-sync.js plan). Returns the entry, or null.
   */
  rekey(id, newId, patch = {}) {
    const e = this.get(id);
    if (!e || this.get(newId) || !/^[\w-]{1,64}$/.test(newId)) return null;
    this.flush(id);
    try { fs.renameSync(this.file(id), this.file(newId)); } catch (err) {
      if (err.code !== 'ENOENT') { this.onError('transcript rename', err); return null; }
    }
    Object.assign(e, patch, { id: newId });
    this.saveIndex();
    return e;
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

// A temp file flushed to disk and a rename (durable.js): never half a file, nor
// one of zeros after a power cut. True if it landed.
function writeJson(file, value, onError) {
  const tmp = `${file}.tmp`;
  try {
    writeFileDurable(file, JSON.stringify(value, null, 2));
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

module.exports = { History, titleFrom, cleanTitle, MAX_ENTRIES, TRASH_DAYS, PERSISTED };
