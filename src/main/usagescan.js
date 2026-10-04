// What Claude Code has actually used lately, read from its own transcripts
// (<config dir>/projects/<folder>/*.jsonl), so the Lean tab's "idle" covers
// the terminal too, not just Shellby's tabs. Read-only and async, line by
// line, and only lines that could hold a tool call or a slash command are
// parsed (efficiency.usedIn). Files that haven't changed since the last scan
// are skipped, so a rescan only reads what's new.
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

async function scanFile(file, used, from) {
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let next = used;
  let oldest = from;
  for await (const line of lines) {
    const hit = usedIn(line);
    if (!hit) continue;
    next = recordUse(next, hit.keys, hit.at);
    if (!Number.isFinite(oldest) || hit.at < oldest) oldest = hit.at;
  }
  return { used: next, from: oldest };
}

/**
 * Scan transcripts changed since `since`. seen ({ file: mtimeMs }) lists files
 * already read, unchanged ones are skipped. Returns { used, from, seen } where
 * from is the oldest moment the scan can vouch for (null when it can't).
 */
async function scanTranscripts({ configDir, since, used = {}, from = null, seen = {}, now = Date.now(), maxBytes = MAX_BYTES }) {
  const listing = await listTranscripts(path.join(configDir, 'projects'), since);
  // Too many files to list them all: which were left out is anyone's guess.
  if (listing.full) return { used, from: now, seen };
  const files = listing.files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let state = { used, from };
  const nextSeen = { ...seen };
  let bytes = 0;
  let missedUpTo = null;   // the newest file left unread
  for (const f of files) {
    if (nextSeen[f.file] === f.mtimeMs) continue;
    if (bytes + f.size > maxBytes) { missedUpTo = Math.max(missedUpTo ?? -Infinity, f.mtimeMs); continue; }
    bytes += f.size;
    try {
      state = await scanFile(f.file, state.used, state.from);
      nextSeen[f.file] = f.mtimeMs;
    } catch { missedUpTo = Math.max(missedUpTo ?? -Infinity, f.mtimeMs); }
  }
  // The oldest transcript read (or read before) bounds how far back "unused" can be judged.
  const read = files.filter(f => nextSeen[f.file] === f.mtimeMs).map(f => f.mtimeMs);
  const covered = [state.from, ...read].filter(Number.isFinite);
  let reach = covered.length ? Math.min(...covered) : null;
  if (reach !== null && missedUpTo !== null) reach = Math.max(reach, missedUpTo);
  return { used: state.used, from: reach, seen: nextSeen };
}

module.exports = { scanTranscripts, listTranscripts };
