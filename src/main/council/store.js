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

  /** Changes one session's fields (its outcome). -> the session, or null when it's gone. */
  update(id, patch) {
    const all = this.list();
    const i = all.findIndex(s => s.id === id);
    if (i < 0) return null;
    const next = { ...all[i], ...patch };
    this.write(all.map((s, j) => (j === i ? next : s)));
    return next;
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
const summary = s => ({
  id: s.id, at: s.at, question: s.question, mode: s.mode, verdict: s.chair?.verdict || '', decision: s.chair?.decision || null,
  tally: s.tally, outcome: s.outcome || null,
  cost: Number.isFinite(s.cost) ? s.cost : null, unpriced: Number.isFinite(s.unpriced) ? s.unpriced : 0,
});

const OUTCOMES = ['worked', 'failed', 'skipped'];
// The vote that agrees with each decision. 'First, this' has no clear side, so it isn't scored.
const SIDE = { do: 'for', dont: 'against' };

/** An outcome from the panel, cleaned: { result, at } or null (clears it). */
function cleanOutcome(raw, now) {
  const result = raw && typeof raw === 'object' ? raw.result : raw;
  return OUTCOMES.includes(result) ? { result, at: now } : null;
}

/**
 * How each advisor's votes turned out: { seatId: { right, of } }. Only verdicts
 * you followed count, and only when it's clear how they went: an advisor who
 * voted with the decision was right if it worked, and one who voted against it
 * was right if it didn't. Their last word counts (a rebuttal's vote, if any), and a
 * 'depends' is neither right nor wrong.
 */
function records(sessions) {
  const out = {};
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const result = s?.outcome?.result;
    const side = SIDE[s?.chair?.decision];
    if (!side || (result !== 'worked' && result !== 'failed')) continue;
    for (const [id, o] of Object.entries(s.opinions || {})) {
      const v = s.rebuttals?.[id]?.vote || o?.vote;
      if (v !== 'for' && v !== 'against') continue;
      const r = (out[id] ||= { right: 0, of: 0 });
      r.of++;
      if ((v === side) === (result === 'worked')) r.right++;
    }
  }
  return out;
}

module.exports = { CouncilStore, summary, records, cleanOutcome, OUTCOMES, MAX_SESSIONS };
