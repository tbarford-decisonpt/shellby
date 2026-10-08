// The project journal (journal.js decides what a note says; this decides when
// to write one, and hands the notes to whoever asks): after a conversation's
// turns settle, and at once when a terminal session ends, its note is read
// out of Claude Code's own file for it and filed under its project.
// Kept out of main.js, which only wires it up.
const fs = require('fs');
const path = require('path');
const journal = require('../journal');
const leaving = require('../leaving');
const worktrees = require('../worktrees');
const { JournalStore } = require('../journal-store');

const SETTLE_MS = 45 * 1000;          // a note waits this long after a turn, in case another follows
const MAX_READ = 8 * 1024 * 1024;     // more of a transcript than this: only its end is read
const MAX_PENDING = 32;
const MAX_RUNNING = 2;                // notes written at once; the rest wait their turn
const MAX_QUEUED = 64;
const SESSION_ID = /^[\w-]{8,64}$/;

/** d: what main shares (main.js `shared`). */
function wireJournal(d) {
  let store = null;
  const pending = new Map(); // sessionId -> { cwd, root, strict, timer }: settling
  const queued = new Map();  // sessionId -> { cwd, root, strict }: due, waiting for a free slot
  const running = new Set(); // sessionIds being written now
  let rerun = new Map();     // sessionId -> job, touched again while being written

  const off = () => !d.config || d.CAPTURE || !!d.config.get('crabOnly');
  const books = () => {
    // electron only when it's first needed: the tests hand in a folder of their own.
    store ??= new JournalStore({ dir: d.journalDir?.() || path.join(require('electron').app.getPath('userData'), 'journal') });
    return store;
  };

  // The end of a big transcript is where the session left off; past MAX_READ
  // its start is lost, and the note is named after the first prompt it can see.
  async function readTranscript(file) {
    const { size } = await fs.promises.stat(file);
    if (size <= MAX_READ) return fs.promises.readFile(file, 'utf8');
    const fh = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_READ);
      const { bytesRead } = await fh.read(buf, 0, MAX_READ, size - MAX_READ);
      const text = buf.subarray(0, bytesRead).toString('utf8');
      return text.slice(text.indexOf('\n') + 1); // the first line is cut in half
    } finally {
      await fh.close();
    }
  }

  async function gitFacts(cwd, since) {
    if (!leaving.okDir(cwd)) return null;
    const [branch, status, log] = await Promise.all([
      leaving.git(['-C', cwd, 'branch', '--show-current']),
      leaving.git(['-C', cwd, 'status', '--porcelain']),
      since ? leaving.git(['-C', cwd, 'log', `--since=${new Date(since).toISOString()}`, '--no-merges', '--format=%s', '-n', '5']) : null,
    ]);
    if (branch === null && status === null) return null; // not a repository (any more)
    const lines = s => String(s || '').split('\n').map(l => l.trim()).filter(Boolean);
    return { branch: branch?.trim() || null, dirty: status === null ? null : lines(status).length, commits: lines(log) };
  }

  // Where Claude Code keeps this conversation. strict (a terminal's hook, which
  // anything on this PC can post): only under the folder the hook named, so a
  // real session id can't be filed under some other project.
  function transcriptOf(sessionId, cwd, strict) {
    const configDir = d.claudeConfigDir();
    if (!strict) return worktrees.findSession({ configDir, sessionId, prefer: [cwd] });
    const file = path.join(configDir, 'projects', worktrees.projectDirName(cwd), `${sessionId}.jsonl`);
    return fs.existsSync(file) ? file : null;
  }

  /** Write (or rewrite) one session's note. Never throws. */
  async function write(sessionId, { cwd, root: rootHint = null, strict = false }) {
    try {
      if (off()) return;
      const file = transcriptOf(sessionId, cwd, strict);
      if (!file) return;
      const entries = journal.parseLines(await readTranscript(file));
      const workedIn = fs.existsSync(cwd || '') ? cwd : null;
      // Only a git repository gets a journal: a book for a plain folder
      // (Documents, say) would be read as every project's below it. A copy
      // Shellby made files under the repository it was copied from; one that
      // has been removed since, under the root its tab remembered.
      const root = (workedIn && await leaving.mainRoot(workedIn)) || (!strict && rootHint) || null;
      if (!root) return;
      const startedAt = entries.map(e => Date.parse(e?.timestamp)).find(Number.isFinite) || null;
      const git = workedIn ? await gitFacts(workedIn, startedAt) : null;
      const note = journal.noteFrom(entries, { sessionId, cwd: workedIn || root, git });
      if (!note) return;
      books().update(root, path.basename(root), book => journal.record(book, note));
      d.send(d.panel, 'projects:changed');
    } catch (err) {
      d.log.info(`journal: couldn't write a note: ${err.message}`);
    }
  }

  // One write per session at a time (a late one could otherwise land after a
  // newer one), and at most MAX_RUNNING at all: a flood of SessionEnds on the
  // port queues up instead of reading transcripts side by side.
  function pump() {
    for (const [sessionId, job] of queued) {
      if (running.size >= MAX_RUNNING) return;
      if (running.has(sessionId)) continue;
      queued.delete(sessionId);
      running.add(sessionId);
      write(sessionId, job).finally(() => {
        running.delete(sessionId);
        const again = rerun.get(sessionId);
        if (again) { rerun.delete(sessionId); due(sessionId, again); }
        pump();
      });
    }
  }

  function due(sessionId, job) {
    if (running.has(sessionId)) { rerun.set(sessionId, job); return; }
    queued.delete(sessionId); // re-queued at the back, with the newest folder
    queued.set(sessionId, job);
    while (queued.size > MAX_QUEUED) queued.delete(queued.keys().next().value);
    pump();
  }

  /**
   * A conversation did something worth a note. now: write it straight away
   * (the session ended); otherwise once its turns have settled.
   * root: the repository, when the folder may be gone by then (a Shellby copy).
   * strict: it came from a terminal's hook (see transcriptOf).
   */
  function touched({ sessionId, cwd, root = null, now = false, strict = false }) {
    if (off() || !SESSION_ID.test(sessionId || '') || typeof cwd !== 'string') return;
    const job = { cwd, root: typeof root === 'string' ? root : null, strict: !!strict };
    clearTimeout(pending.get(sessionId)?.timer);
    pending.delete(sessionId); // re-inserted below: the newest is last to be evicted
    if (now) { due(sessionId, job); return; }
    const timer = setTimeout(() => { pending.delete(sessionId); due(sessionId, job); }, SETTLE_MS);
    timer.unref?.();
    pending.set(sessionId, { ...job, timer });
    while (pending.size > MAX_PENDING) {
      const [oldest, p] = pending.entries().next().value;
      clearTimeout(p.timer);
      pending.delete(oldest);
      due(oldest, { cwd: p.cwd, root: p.root, strict: p.strict });
    }
  }

  /** Quitting: whatever was still settling or waiting is written on the next start instead. */
  function savePending() {
    if (!d.config) return;
    const jobs = new Map([...queued, ...rerun, ...[...pending].map(([id, p]) => [id, p])]);
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    queued.clear();
    rerun = new Map();
    d.config.set({ journalPending: [...jobs].slice(0, MAX_PENDING).map(([sessionId, j]) => ({ sessionId, cwd: j.cwd, root: j.root, strict: !!j.strict })) });
  }

  function resumePending() {
    const list = d.config.get('journalPending');
    if (!Array.isArray(list) || !list.length) return;
    d.config.set({ journalPending: [] });
    for (const p of list.slice(0, MAX_PENDING)) {
      touched({ sessionId: p?.sessionId, cwd: p?.cwd, root: typeof p?.root === 'string' ? p.root : null, strict: p?.strict !== false });
    }
  }

  // ---- reading it back

  /** The notes for the first of these folders that has any. -> { root, book } | null */
  function bookFor(folders) {
    for (const f of folders || []) {
      const found = typeof f === 'string' ? books().find(f) : null;
      if (found) return found;
    }
    return null;
  }

  /** For a project's page: the notes and pins, as they're stored. -> { root, notes, pins } | null */
  function view(roots) {
    const found = bookFor(roots);
    return found ? { root: found.root, notes: found.book.notes, pins: found.book.pins } : null;
  }

  /**
   * What "Where did we leave off?" sends in a project: its notes, so Claude
   * starts from them, or, with none yet, the ask to look for itself.
   */
  function draftFor(folder, name, { since = 'recently' } = {}) {
    const found = bookFor([folder]);
    return (found && journal.draft(found.book, { name, now: Date.now() }))
      || `Where did we leave off in ${name}? Summarize what changed ${since}, what's unfinished, and suggest the next step.`;
  }

  /** For Claude Code (the MCP `journal` tool): the brief for the project a folder is in. */
  async function briefFor(cwd) {
    const root = (leaving.okDir(cwd) && await leaving.mainRoot(cwd)) || cwd;
    const found = bookFor([root, cwd]);
    const name = path.basename(String(root || ''));
    const text = found && journal.brief(found.book, { name, now: Date.now() });
    return text ? `${journal.UNTRUSTED_NOTE}\n\n${text}`
      : `Shellby has no notes for ${name || 'this folder'} yet. They're written after each Claude Code session here.`;
  }

  /**
   * A pin. From the project's page (fromPanel) on any listed project; from
   * Claude Code (the MCP tool, which anything on this PC can reach) only on a
   * repository Shellby already keeps notes for.
   * -> { ok, id } | { ok: false, error }
   */
  async function pinFor(cwd, { kind, text }, { fromPanel = false } = {}) {
    if (off()) return { ok: false, error: 'The journal is off in just-the-crab mode.' };
    const root = (leaving.okDir(cwd) && await leaving.mainRoot(cwd)) || null;
    if (!root) return { ok: false, error: "That folder isn't in a git repository, so there's no project to pin it to." };
    if (!fromPanel && !books().read(root).notes.length) {
      return { ok: false, error: "Shellby has no notes for this project yet, so it won't start a journal from a pin. Pins can be added on the project's page in Shellby." };
    }
    let result = null;
    books().update(root, path.basename(root), book => {
      result = journal.pin(book, { kind, text }, Date.now());
      return result.book;
    });
    if (result?.error) return { ok: false, error: result.error };
    d.send(d.panel, 'projects:changed');
    return { ok: true, id: result.id };
  }

  /** Take a pin or a session's note off a project's page. root: a folder the page was shown. */
  function remove(root, { pinId = null, sessionId = null } = {}) {
    const found = bookFor([root]);
    if (!found) return { ok: false };
    books().write(found.root, pinId ? journal.unpin(found.book, pinId) : journal.forget(found.book, sessionId));
    d.send(d.panel, 'projects:changed');
    return { ok: true };
  }

  return { touched, savePending, resumePending, view, draftFor, briefFor, pinFor, remove };
}

module.exports = { wireJournal };
