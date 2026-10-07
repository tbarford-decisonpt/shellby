// What Claude Code has actually used lately, read from its own transcripts
// (<config dir>/projects/<folder>/*.jsonl), so the Lean tab's "idle" covers
// the terminal too, not just Shellby's tabs. Read-only and async, line by
// line, and only lines that could hold a tool call or a slash command are
// parsed (efficiency.usedIn). Files that haven't changed since the last scan
// are skipped, so a rescan only reads what's new.
//
// How many times each thing was used is kept per file (counts: { file: { key: n } })
// and replaced whenever a file is read again: a transcript that grew is read from
// the top, so adding to one running total would count its old uses twice.
//
// `from` is how far back the scan can vouch for: something is only ever called
// idle inside it (efficiency.leanReport). When a scan stops short (too many
// bytes, a file it couldn't read), anything in the files it left out may have
// been used, so `from` never reaches back past the newest of those.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { usedIn, recordUse } = require('./efficiency');

const MAX_DEPTH = 3;                     // projects/<folder>/<session>/subagents/*.jsonl
const MAX_FILES = 20000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024; // per scan, newest files first (a heavy month is ~1 GB)
const MAX_COUNTED = 1500;                // transcripts whose use counts are kept (they live in config.json)

async function listTranscripts(dir, since, depth = 0, out = { files: [], full: false }) {
  if (depth > MAX_DEPTH) return out;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.files.length >= MAX_FILES) { out.full = true; return out; }
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await listTranscripts(full, since, depth + 1, out);
    else if (e.isFile() && /\.jsonl$/i.test(e.name)) {
      try {
        const st = await fs.promises.stat(full);
        if (st.mtimeMs >= since) out.files.push({ file: full, mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* gone since the listing */ }
    }
  }
  return out;
}

async function scanFile(file, used, from, since) {
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let next = used;
  let oldest = from;
  const counts = {};
  for await (const line of lines) {
    const hit = usedIn(line);
    if (!hit) continue;
    next = recordUse(next, hit.keys, hit.at);
    if (!Number.isFinite(oldest) || hit.at < oldest) oldest = hit.at;
    if (hit.at >= since) for (const k of hit.keys) counts[k] = (counts[k] || 0) + 1;
  }
  return { used: next, from: oldest, counts };
}

/** Add up per-file counts: { file: { key: n } } -> { key: n }. */
function totalUses(counts) {
  const out = {};
  for (const per of Object.values(counts && typeof counts === 'object' ? counts : {})) {
    if (!per || typeof per !== 'object') continue;
    for (const [k, n] of Object.entries(per)) if (Number.isFinite(n) && n > 0) out[k] = (out[k] || 0) + n;
  }
  return out;
}

/**
 * Scan transcripts changed since `since`. seen ({ file: 'mtimeMs:size' }) lists
 * files already read, unchanged ones are skipped. The size is in it because a
 * transcript can grow within one tick of its modified time; an older seen with
 * only the time just means one more read. Returns { used, from, seen, counts }
 * where from is the oldest moment the scan can vouch for (null when it can't)
 * and counts holds each file's uses since `since` (totalUses adds them up).
 */
async function scanTranscripts({ configDir, since, used = {}, from = null, seen = {}, counts = {}, now = Date.now(), maxBytes = MAX_BYTES }) {
  const listing = await listTranscripts(path.join(configDir, 'projects'), since);
  // Too many files to list them all: which were left out is anyone's guess.
  if (listing.full) return { used, from: now, seen, counts };
  const files = listing.files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let state = { used, from };
  const nextSeen = { ...seen };
  // Files that fell out of the window (or were deleted) take their counts with them.
  const listed = new Set(files.map(f => f.file));
  const nextCounts = Object.fromEntries(Object.entries(counts && typeof counts === 'object' ? counts : {}).filter(([file]) => listed.has(file)));
  let bytes = 0;
  let missedUpTo = null;   // the newest file left unread
  const stamp = f => `${f.mtimeMs}:${f.size}`;
  for (const f of files) {
    if (nextSeen[f.file] === stamp(f)) continue;
    if (bytes + f.size > maxBytes) { missedUpTo = Math.max(missedUpTo ?? -Infinity, f.mtimeMs); continue; }
    bytes += f.size;
    try {
      const r = await scanFile(f.file, state.used, state.from, since);
      state = r;
      nextSeen[f.file] = stamp(f);
      if (Object.keys(r.counts).length) nextCounts[f.file] = r.counts;
      else delete nextCounts[f.file];
    } catch { missedUpTo = Math.max(missedUpTo ?? -Infinity, f.mtimeMs); }
  }
  // The oldest transcript read (or read before) bounds how far back "unused" can be judged.
  const read = files.filter(f => nextSeen[f.file] === stamp(f)).map(f => f.mtimeMs);
  const covered = [state.from, ...read].filter(Number.isFinite);
  let reach = covered.length ? Math.min(...covered) : null;
  if (reach !== null && missedUpTo !== null) reach = Math.max(reach, missedUpTo);
  const kept = files.map(f => f.file).filter(file => nextCounts[file]).slice(0, MAX_COUNTED);
  return { used: state.used, from: reach, seen: nextSeen, counts: Object.fromEntries(kept.map(file => [file, nextCounts[file]])) };
}

module.exports = { scanTranscripts, listTranscripts, totalUses };
