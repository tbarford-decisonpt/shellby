// Searching inside past conversations: every message you and Claude wrote, in
// every conversation History keeps, from this PC and the ones synced over
// (history-sync.js puts those in the same folder). Results come back ranked,
// each with a snippet around the match and the item it's at, so opening one
// lands on that message.
//
// The index lives in memory and is kept up to date incrementally: before each
// search the transcripts are stat'ed (asynchronously), and only the ones whose
// size or time changed are read again, a few at a time, with the event loop
// free in between. Nothing here reads a file synchronously.
// See test/history-search.test.js.
const fs = require('fs');
const path = require('path');

const SEARCHED = new Set(['user', 'text', 'result']);
const MAX_ITEM_TEXT = 20000;          // a pasted log is searched only so far
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const READ_AT_ONCE = 4;
const SNIPPET_AROUND = 60;
const MAX_HITS_PER_CONVERSATION = 3;
const MAX_CONVERSATIONS = 30;
const MAX_TERMS = 8;
const MIN_QUERY = 2;
const DAY = 864e5;
const RECENT_DAYS = 30;               // newer conversations edge ahead on a tie

const fold = s => String(s || '').toLowerCase();

/** The searchable text of one transcript item, or ''. */
function textOf(item) {
  if (!item || !SEARCHED.has(item.kind)) return '';
  const t = item.kind === 'result' ? item.text || item.result : item.text;
  return typeof t === 'string' ? t.slice(0, MAX_ITEM_TEXT) : '';
}

/**
 * A transcript's JSONL -> [{ at, kind, text, low }]. at: the item's index as
 * History.load() numbers them (broken lines dropped), so opening lands on it.
 */
function docsOf(jsonl) {
  const out = [];
  const lines = String(jsonl || '').split('\n');
  let at = 0;
  for (const line of lines) {
    if (!line) continue;
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (!item) continue;
    const text = textOf(item);
    if (text.trim()) out.push({ at, kind: item.kind, text, low: fold(text) });
    at++;
  }
  return out;
}

/** "a \"b c\" d" -> { terms: ['a', 'b c', 'd'], phrase: 'a b c d' } (lowercased). */
function parseQuery(q) {
  const raw = fold(q).trim().slice(0, 300);
  const terms = [];
  for (const m of raw.matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] || m[2] || '').trim();
    if (t && !terms.includes(t)) terms.push(t);
  }
  return { terms: terms.slice(0, MAX_TERMS), phrase: raw.replace(/"/g, '').replace(/\s+/g, ' ') };
}

const isWordChar = c => !!c && /[\p{L}\p{N}_]/u.test(c);

function countOf(low, term) {
  let n = 0, i = low.indexOf(term), whole = 0;
  while (i >= 0 && n < 20) {
    n++;
    if (!isWordChar(low[i - 1]) && !isWordChar(low[i + term.length])) whole++;
    i = low.indexOf(term, i + term.length);
  }
  return { n, whole };
}

/**
 * How well one message matches: 0 when any term is missing. More matches,
 * whole words, the whole query as written, and your own messages score higher.
 */
function scoreDoc(doc, { terms, phrase }) {
  if (!terms.length) return 0;
  let score = 0;
  for (const t of terms) {
    const { n, whole } = countOf(doc.low, t);
    if (!n) return 0;
    score += 1 + Math.log2(n) + whole * 0.5;
  }
  if (terms.length > 1 && phrase && doc.low.includes(phrase)) score += 3;
  if (doc.kind === 'user') score += 0.5;
  return score;
}

/**
 * The text around the first match: { text, marks } where marks are [start, end)
 * ranges of every term in the snippet, for the panel to highlight.
 */
function snippet(text, low, terms, around = SNIPPET_AROUND) {
  let first = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  if (first < 0) first = 0;
  let start = Math.max(0, first - around);
  let end = Math.min(text.length, first + around * 2);
  // Not mid-word, where there's a space close by.
  const sp = text.lastIndexOf(' ', first);
  if (start > 0 && sp > start && sp - start < 15) start = sp + 1;
  const ep = text.indexOf(' ', end);
  if (end < text.length && ep > 0 && ep - end < 15) end = ep;
  const lead = start > 0 ? '…' : '';
  const body = text.slice(start, end).replace(/\s/g, ' ');
  const lowBody = low.slice(start, end);
  const marks = [];
  for (const t of terms) {
    let i = lowBody.indexOf(t);
    while (i >= 0) { marks.push([i + lead.length, i + lead.length + t.length]); i = lowBody.indexOf(t, i + t.length); }
  }
  marks.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]); else merged.push([...m]);
  }
  return { text: `${lead}${body}${end < text.length ? '…' : ''}`, marks: merged };
}

const projectOf = cwd => path.basename(String(cwd || '').replace(/[\\/]+$/, '')) || '';
const pcOf = entry => entry.elsewhere || '';

/** Does an index entry pass the filters? { project, pc ('' = this PC), from, to } */
function passes(entry, { project, pc, from, to } = {}) {
  if (project && fold(projectOf(entry.cwd)) !== fold(project)) return false;
  if (typeof pc === 'string' && pc !== '*' && fold(pcOf(entry)) !== fold(pc)) return false;
  const at = entry.updatedAt || entry.createdAt || 0;
  if (Number.isFinite(from) && at < from) return false;
  if (Number.isFinite(to) && at > to) return false;
  return true;
}

/**
 * Rank everything: entries is History's index, docsFor(id) the messages.
 * -> [{ id, title, cwd, project, pc, updatedAt, score, hits: [{ at, kind, snippet }] }]
 */
function rank(entries, docsFor, query, filters = {}, now = Date.now()) {
  const q = parseQuery(query);
  if (q.phrase.length < MIN_QUERY || !q.terms.length) return [];
  const out = [];
  for (const e of entries) {
    if (!passes(e, filters)) continue;
    const scored = [];
    for (const d of docsFor(e.id) || []) {
      const s = scoreDoc(d, q);
      if (s) scored.push({ d, s });
    }
    const titleHit = q.terms.every(t => fold(e.title).includes(t));
    if (!scored.length && !titleHit) continue;
    scored.sort((a, b) => b.s - a.s || a.d.at - b.d.at);
    const age = (now - (e.updatedAt || 0)) / DAY;
    const fresh = age < RECENT_DAYS ? (RECENT_DAYS - age) / RECENT_DAYS : 0;
    const score = (scored[0]?.s || 0) + Math.log2(1 + scored.length) * 0.5 + (titleHit ? 2 : 0) + fresh;
    out.push({
      id: e.id, title: e.title, cwd: e.cwd, project: projectOf(e.cwd), pc: pcOf(e), updatedAt: e.updatedAt || 0,
      score, count: scored.length,
      hits: scored.slice(0, MAX_HITS_PER_CONVERSATION).map(({ d }) => ({ at: d.at, kind: d.kind, snippet: snippet(d.text, d.low, q.terms) })),
    });
  }
  return out.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS);
}

/** The projects and PCs there are to filter by, from History's index. */
function facets(entries) {
  const projects = new Set(), pcs = new Set();
  for (const e of entries) {
    const p = projectOf(e.cwd);
    if (p) projects.add(p);
    if (e.elsewhere) pcs.add(e.elsewhere);
  }
  const byName = (a, b) => a.localeCompare(b);
  return { projects: [...projects].sort(byName), pcs: [...pcs].sort(byName) };
}

/**
 * The index over a History store. history: { list(), file(id), flush() }.
 * fsp: fs.promises (tests pass their own).
 */
class HistorySearch {
  constructor(history, { fsp = fs.promises, onError = () => {} } = {}) {
    this.history = history;
    this.fsp = fsp;
    this.onError = onError;
    this.cache = new Map(); // id -> { size, mtimeMs, docs }
    this.refreshing = null;
  }

  /** Bring the index up to date. Concurrent calls share one pass. */
  refresh() {
    if (!this.refreshing) this.refreshing = this.update().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async update() {
    try { this.history.flush?.(); } catch (e) { this.onError('flush', e); }
    const entries = this.history.list();
    const live = new Set(entries.map(e => e.id));
    for (const id of [...this.cache.keys()]) if (!live.has(id)) this.cache.delete(id);
    const queue = [...entries];
    const worker = async () => {
      for (let e = queue.shift(); e; e = queue.shift()) await this.updateOne(e.id);
    };
    await Promise.all(Array.from({ length: READ_AT_ONCE }, worker));
  }

  async updateOne(id) {
    let file;
    try { file = this.history.file(id); } catch { return; }
    let st;
    try { st = await this.fsp.stat(file); } catch { this.cache.set(id, { size: 0, mtimeMs: 0, docs: [] }); return; }
    const had = this.cache.get(id);
    if (had && had.size === st.size && had.mtimeMs === st.mtimeMs) return;
    if (st.size > MAX_FILE_BYTES) { this.cache.set(id, { size: st.size, mtimeMs: st.mtimeMs, docs: [] }); return; }
    try {
      const text = await this.fsp.readFile(file, 'utf8');
      this.cache.set(id, { size: st.size, mtimeMs: st.mtimeMs, docs: docsOf(text) });
    } catch (e) { this.onError('read', e); }
  }

  /** query: text; filters: { project, pc, from, to }. -> { results, facets } */
  async search(query, filters = {}) {
    await this.refresh();
    const entries = this.history.list();
    return { results: rank(entries, id => this.cache.get(id)?.docs, query, filters), facets: facets(entries) };
  }
}

module.exports = { HistorySearch, textOf, docsOf, parseQuery, scoreDoc, snippet, passes, rank, facets, MAX_CONVERSATIONS };
