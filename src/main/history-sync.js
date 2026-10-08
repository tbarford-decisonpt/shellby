// Conversation history, following you between PCs signed in to the same
// GitHub account (github/history-gist.js does the gist). Off unless you turn
// on "Sync conversation history" in Settings → GitHub.
//
// What travels is a trimmed copy of each of your newest conversations
// (MAX_SYNCED, routine runs left out): long tool output clipped, pictures
// dropped, anything that looks like a secret blanked (devservers/output.js
// redact), gzipped. It replays in History on your other PCs. What doesn't
// travel is Claude Code's own record of it, which stays on the PC that ran it:
// carrying one on elsewhere starts Claude afresh with a recap of what was said
// (recap(), sent as the tab's preamble before its next message).
//
// Each conversation follows whichever PC changed it last: work on it
// (updatedAt), or a rename, a tick or a restore (editedAt). One changed on two
// PCs since they last agreed is kept twice: this PC's version moves to a new
// id and the other's takes its place, so neither loses a turn. Deleting one
// leaves a marker (gone), so it goes to Recently deleted on your other PCs
// rather than coming back; one changed after it was deleted wins.
//
// Pure. See test/history-sync.test.js.
const zlib = require('zlib');
const { redact } = require('./devservers/output');
const { PERSISTED, cleanTitle } = require('./history');

const FORMAT = 1;
const INDEX_FILE = 'shellby-history.json';
const MAX_SYNCED = 50;               // the newest this many, across every PC
const MAX_PACKED = 700 * 1024;       // a packed transcript bigger than this stays home (GitHub cuts a gist file at 1 MB)
const MAX_UNPACKED = 32 * 1024 * 1024;
const MAX_GONE = 500;
const GONE_DAYS = 90;                // how long a deletion marker is kept
const DAY_MS = 24 * 60 * 60 * 1000;
// Longest string kept in each kind of item; the rest is cut. Tool output is
// most of a transcript's size and least of its sense.
const CLIP = { tool_result: 600, user: 20000, text: 20000 };
const CLIP_OTHER = 1500;
const MAX_RECAP = 12000;

const ID_RE = /^[\w-]{1,64}$/;
const PC_RE = /^[\w-]{1,64}$/;
const REPO_RE = /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/;
const num = v => (Number.isFinite(v) && v > 0 ? v : 0);
const str = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

const fileFor = id => `c-${id}.gz.b64`;

/** When a conversation last changed in a way worth syncing. */
const changedAt = e => Math.max(num(e?.updatedAt), num(e?.editedAt));

// ------------------------------------------------------------ the index

/** A drive-letter path, never a UNC or device one; '' otherwise. */
function cleanPath(p) {
  const s = str(p, 1024);
  return /^[A-Za-z]:[\\/]/.test(s) && !/[\u0000-\u001f]/.test(s) ? s : '';
}

/** Inside the repository: forward slashes, no '..', or ''. */
function cleanRel(p) {
  const s = str(p, 512).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return s.split('/').some(x => x === '..' || x === '.') || /^[A-Za-z]:/.test(s) ? '' : s;
}

function cleanEntry(e) {
  if (!isObj(e) || typeof e.id !== 'string' || !ID_RE.test(e.id)) return null;
  const pc = typeof e.pc === 'string' && PC_RE.test(e.pc) ? e.pc : null;
  const lastPc = typeof e.lastPc === 'string' && PC_RE.test(e.lastPc) ? e.lastPc : pc;
  return {
    id: e.id,
    title: cleanTitle(e.title) || 'New task',
    createdAt: num(e.createdAt), updatedAt: num(e.updatedAt), editedAt: num(e.editedAt),
    done: e.done === true,
    mode: str(e.mode, 20) || null,
    lastOutcome: ['ok', 'error', 'stopped', 'cut'].includes(e.lastOutcome) ? e.lastOutcome : null,
    cwd: cleanPath(e.cwd),
    repo: typeof e.repo === 'string' && REPO_RE.test(e.repo) ? e.repo : null,
    rel: cleanRel(e.rel),
    pc, pcName: str(e.pcName, 64) || null,
    lastPc, lastPcName: str(e.lastPcName, 64) || null,
  };
}

/** Tolerate anything (the gist especially): { entries, gone }. */
function cleanIndex(raw) {
  const r = isObj(raw) ? raw : {};
  const seen = new Set();
  const entries = (Array.isArray(r.entries) ? r.entries : []).map(cleanEntry)
    .filter(e => e && !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => changedAt(b) - changedAt(a)).slice(0, MAX_SYNCED);
  return { format: FORMAT, entries, gone: cleanGone(r.gone) };
}

/** Deletion markers { id: at }: the newest MAX_GONE, none older than GONE_DAYS. */
function cleanGone(raw, now = Date.now()) {
  const floor = now - GONE_DAYS * DAY_MS;
  const list = Object.entries(isObj(raw) ? raw : {})
    .filter(([id, at]) => ID_RE.test(id) && num(at) > floor)
    .sort((a, b) => b[1] - a[1]).slice(0, MAX_GONE);
  return Object.fromEntries(list);
}

function mergeGone(a, b, now) {
  const out = { ...cleanGone(a, now) };
  for (const [id, at] of Object.entries(cleanGone(b, now))) out[id] = Math.max(out[id] || 0, at);
  return cleanGone(out, now);
}

/** Which local conversations may travel: not routine runs, newest first. */
function eligible(list) {
  return (list || []).filter(e => e && ID_RE.test(e.id || '') && !e.routineId)
    .sort((a, b) => changedAt(b) - changedAt(a)).slice(0, MAX_SYNCED);
}

// ------------------------------------------------------------ the plan

/**
 * What one sync does. local: History's list (with syncedAt from earlier
 * syncs); bin: Recently deleted; remote: cleanIndex of the gist; gone: this
 * PC's deletion markers; open: ids open in a tab (left alone until closed).
 * -> {
 *   push: [id]      local conversations the gist gets
 *   pull: [id]      gist conversations this PC takes
 *   fork: [id]      changed on both sides: this PC's moves to a new id (and is pushed), the gist's takes its place
 *   trash: [id]     deleted on another PC: to Recently deleted here
 *   drop: [id]      leaving the gist (deleted here, or past MAX_SYNCED)
 *   settle: [id]    already the same on both sides: just noted as synced
 *   gone            the merged deletion markers
 * }
 */
function plan({ local = [], bin = [], remote, gone = {}, open = new Set(), now = Date.now() }) {
  const r = cleanIndex(remote);
  const marks = mergeGone(r.gone, gone, now);
  const out = { push: [], pull: [], fork: [], trash: [], drop: [], settle: [], gone: marks };
  const L = new Map(local.filter(e => e && ID_RE.test(e.id || '')).map(e => [e.id, e]));
  const B = new Map(bin.filter(e => e && ID_RE.test(e.id || '')).map(e => [e.id, e]));
  const R = new Map(r.entries.map(e => [e.id, e]));
  const mine = new Set(eligible(local).map(e => e.id));

  for (const [id, re] of R) {
    const rc = changedAt(re);
    const le = L.get(id);
    if (marks[id] >= rc) { out.drop.push(id); if (le && changedAt(le) <= marks[id] && !open.has(id)) out.trash.push(id); continue; }
    if (!le) {
      const binned = B.get(id);
      if (binned && num(binned.deletedAt) >= rc) { out.drop.push(id); out.gone[id] = Math.max(out.gone[id] || 0, binned.deletedAt); continue; }
      out.pull.push(id);
      continue;
    }
    const lc = changedAt(le), since = num(le.syncedAt);
    if (lc === rc) { if (since !== rc) out.settle.push(id); continue; }
    if (open.has(id)) { if (lc > rc) out.push.push(id); continue; } // an open one only ever sends
    if (lc > since && rc > since) out.fork.push(id);
    else if (rc > lc) out.pull.push(id);
    else out.push.push(id);
  }
  // Ones the gist hasn't got: new here, or changed since another PC trimmed them off.
  const rest = r.entries.map(changedAt).sort((a, b) => b - a);
  const room = rest.length < MAX_SYNCED ? 0 : rest[MAX_SYNCED - 1];
  for (const id of mine) {
    if (R.has(id)) continue;
    const le = L.get(id);
    const lc = changedAt(le);
    if (marks[id] >= lc) { if (!open.has(id)) out.trash.push(id); continue; }
    // Already traded and since trimmed off the gist, and nothing new: it stays off.
    if (num(le.syncedAt) >= lc && lc <= room) continue;
    out.push.push(id);
  }
  // A deletion marker for something no longer anywhere is dropped once it's old (cleanGone).
  return out;
}

/**
 * The gist's index after a sync: what it had, minus what's dropped, with what's
 * pushed laid over, the newest MAX_SYNCED. -> { index, removed: [id] }
 */
function nextIndex(remote, pushed, dropped, gone) {
  const r = cleanIndex(remote);
  const out = new Map(r.entries.filter(e => !dropped.includes(e.id)).map(e => [e.id, e]));
  for (const e of pushed) { const c = cleanEntry(e); if (c) out.set(c.id, c); }
  const all = [...out.values()].sort((a, b) => changedAt(b) - changedAt(a));
  const kept = all.slice(0, MAX_SYNCED);
  const keptIds = new Set(kept.map(e => e.id));
  const removed = [...new Set([...r.entries.map(e => e.id), ...pushed.map(e => e.id)])].filter(id => !keptIds.has(id));
  return { index: { format: FORMAT, entries: kept, gone: cleanGone(gone) }, removed };
}

/**
 * The gist's entry for a local conversation. me: { pc, name } (this PC).
 * place: { repo, rel } when its folder is in a GitHub repository here.
 * Work done since the gist's copy (updatedAt) makes this PC the last to work on it.
 */
function entryOut(le, re, me, place = {}) {
  const worked = num(le.updatedAt) > num(re?.updatedAt);
  return cleanEntry({
    id: le.id, title: le.title, createdAt: le.createdAt, updatedAt: le.updatedAt, editedAt: le.editedAt,
    done: !!le.done, mode: le.mode, lastOutcome: le.lastOutcome,
    cwd: le.syncCwd || le.worktree?.originalCwd || le.cwd, repo: place.repo || le.repo, rel: place.rel ?? le.rel,
    pc: le.pc || re?.pc || me.pc, pcName: le.pcName || re?.pcName || me.name,
    lastPc: worked ? me.pc : re?.lastPc || le.lastPc || me.pc,
    lastPcName: worked ? me.name : re?.lastPcName || le.lastPcName || me.name,
  });
}

/**
 * This PC's entry for a conversation from the gist. le: this PC's copy, if
 * any. cwd: where it works here (place()). moved: its folder isn't on this PC.
 * Claude Code's record of it is only good if this PC was the last to work on
 * it; otherwise it starts afresh, with the recap.
 */
function entryIn(re, le, { me, cwd, recapText }) {
  const fresh = re.lastPc !== me.pc;
  const ownWork = le && !fresh;
  const base = ownWork ? { ...le } : {
    ...(le ? { done: le.done } : {}),
    routineId: null, claudeSessionId: null, resumeAt: null, context: null,
    worktree: null, fence: null, branchOf: null, copies: undefined,
  };
  const entry = {
    ...base,
    id: re.id, title: re.title, cwd, mode: re.mode || base.mode || 'ask',
    createdAt: re.createdAt, updatedAt: re.updatedAt, editedAt: re.editedAt,
    lastOutcome: re.lastOutcome,
    repo: re.repo, rel: re.rel, syncCwd: re.cwd || null,
    pc: re.pc, pcName: re.pcName, lastPc: re.lastPc, lastPcName: re.lastPcName,
    // Shown in History: where it started, when that's not here.
    elsewhere: re.pc && re.pc !== me.pc ? re.pcName || 'another PC' : null,
    syncedAt: changedAt(re),
  };
  if (re.done) entry.done = true; else delete entry.done;
  if (!ownWork) entry.preamble = recapText || null;
  for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
  return entry;
}

/**
 * Where a conversation from another PC works here: its own folder if this PC
 * has it, else the same place in your clone of its repository, else home.
 * exists(path), rootOf(repo) -> folder | null. -> { cwd, moved }
 */
function place(re, { exists, rootOf, home, join }) {
  if (re.cwd && exists(re.cwd)) return { cwd: re.cwd, moved: false };
  const root = re.repo ? rootOf(re.repo) : null;
  if (root) {
    const there = re.rel ? join(root, ...re.rel.split('/')) : root;
    return { cwd: exists(there) ? there : root, moved: false };
  }
  return { cwd: home, moved: true };
}

// ------------------------------------------------------------ transcripts

function clipDeep(v, n) {
  if (typeof v === 'string') {
    if (/^data:/i.test(v)) return '';
    const s = v.length > n ? `${v.slice(0, n)}… (cut short for sync)` : v;
    return s.split('\n').map(redact).join('\n');
  }
  if (Array.isArray(v)) return v.map(x => clipDeep(x, n));
  if (isObj(v)) { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = clipDeep(x, n); return o; }
  return v;
}

/** The copy that travels: replayable items only, clipped and redacted. */
function travel(items) {
  return (items || []).filter(i => isObj(i) && PERSISTED.has(i.kind))
    .map(i => clipDeep(i, CLIP[i.kind] || CLIP_OTHER));
}

/** items -> gzipped JSONL, base64 (a gist holds text). */
function pack(items) {
  const text = (items || []).map(i => JSON.stringify(i)).join('\n');
  return zlib.gzipSync(Buffer.from(text, 'utf8')).toString('base64');
}

/** The other way, tolerating anything: [] for what won't read. */
function unpack(b64) {
  if (typeof b64 !== 'string' || !b64 || b64.length > MAX_PACKED * 2) return [];
  let text;
  try { text = zlib.gunzipSync(Buffer.from(b64, 'base64'), { maxOutputLength: MAX_UNPACKED }).toString('utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(i => isObj(i) && PERSISTED.has(i.kind));
}

/**
 * What Claude is told before the next message in a conversation that was last
 * worked on elsewhere: where it was, and what was said, newest kept when it's
 * long. Lines open with "[Shellby:", Shellby's mark for words it added.
 */
function recap(items, { from, cwd, moved }) {
  const lines = [];
  for (const i of items || []) {
    const said = typeof i.text === 'string' ? i.text.trim() : '';
    if (!said) continue;
    if (i.kind === 'user') lines.push(`You: ${said}`);
    else if (i.kind === 'text') lines.push(`Claude: ${said}`);
  }
  const head = `[Shellby: this conversation was last worked on on another PC (${from || 'another PC'}), and Claude Code's own record of it stayed there. Here is what was said, from Shellby's history${moved && cwd ? `. It was working in ${cwd} there, which isn't on this PC` : ''}. Carry on from it; files may differ on this PC.]`;
  const kept = [];
  let room = MAX_RECAP - head.length;
  for (let k = lines.length - 1; k >= 0 && room > 0; k--) {
    const line = lines[k].length > room ? `${lines[k].slice(0, Math.max(0, room - 1))}…` : lines[k];
    kept.unshift(line);
    room -= line.length + 2;
  }
  if (kept.length < lines.length) kept.unshift('(earlier messages left out)');
  return kept.length ? `${head}\n\n${kept.join('\n\n')}` : head;
}

module.exports = {
  FORMAT, INDEX_FILE, MAX_SYNCED, MAX_PACKED,
  fileFor, changedAt, cleanIndex, cleanEntry, cleanGone, mergeGone, eligible,
  plan, nextIndex, entryOut, entryIn, place, travel, pack, unpack, recap,
};
