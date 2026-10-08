// Conversation history through a private gist of yours ("Shellby history"),
// apart from the progress gist (sync.js) so a sync that changes neither costs
// one 304. Its own gist too because it's far bigger: an index
// (history-sync.js INDEX_FILE) and one packed transcript per conversation.
// What to send, take and set aside is decided in history-sync.js; this only
// moves it. The gist is yours but is still treated as untrusted input.
const path = require('path');
const { randomUUID } = require('crypto');
const hs = require('../history-sync');
const { findGist } = require('./gists');

const MAX_PATCH = 3 * 1024 * 1024;  // per request: a big first sync goes in several
const caseKey = p => path.resolve(p).toLowerCase();

/**
 * Where folders are on this PC, from Projects' clones ([{ root, remote }],
 * remote "owner/name"). exists(path) -> bool. ->
 * { exists, home, join, rootOf(repo), placeOf(dir) -> { repo, rel } | null }
 */
function whereFrom(repos, { exists, home }) {
  const withRemote = (repos || []).filter(r => r && typeof r.root === 'string' && typeof r.remote === 'string');
  return {
    exists, home, join: path.join,
    rootOf: repo => withRemote.find(r => r.remote.toLowerCase() === repo && exists(r.root))?.root || null,
    placeOf: dir => {
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) return null;
      const d = caseKey(dir);
      const hit = withRemote.filter(r => d === caseKey(r.root) || d.startsWith(caseKey(r.root) + path.sep))
        .sort((a, b) => b.root.length - a.root.length)[0];
      return hit ? { repo: hit.remote.toLowerCase(), rel: path.relative(hit.root, dir).split(path.sep).join('/') } : null;
    },
  };
}

function readGist(g) {
  const files = g?.files || {};
  const idx = files[hs.INDEX_FILE];
  if (!idx || idx.truncated) throw new Error("The history gist's index couldn't be read.");
  let raw;
  try { raw = JSON.parse(idx.content || '{}'); } catch { throw new Error("The history gist's index couldn't be read."); }
  const out = {};
  for (const [name, f] of Object.entries(files)) if (name !== hs.INDEX_FILE && !f?.truncated && typeof f?.content === 'string') out[name] = f.content;
  return { remote: hs.cleanIndex(raw), files: out };
}

const indexContent = index => JSON.stringify({ ...index, note: 'Shellby history sync: your newest conversations, trimmed and gzipped, for your other PCs. Safe to delete; Shellby makes a new one.' });

// The gist's files in requests of at most MAX_PATCH, the index in the last.
function chunks(files, index) {
  const out = [];
  let cur = {}, size = 0;
  for (const [name, v] of Object.entries(files)) {
    const n = (v?.content?.length || 0) + name.length;
    if (size && size + n > MAX_PATCH) { out.push(cur); cur = {}; size = 0; }
    cur[name] = v; size += n;
  }
  cur[hs.INDEX_FILE] = { content: indexContent(index) };
  out.push(cur);
  return out;
}

const copyTitle = t => `${String(t || 'New task').slice(0, 60)} (this PC)`;

/**
 * One history sync. gh: GitHubApi. history: History. state: { load(), save(s) }
 * over history-sync's own file ({ gistId, etag, index, gone }). me: { pc, name }.
 * open: ids open in a tab. where: whereFrom().
 * -> { gistId, pushed, pulled, trashed, forked, tooBig, synced }
 */
async function syncHistory(gh, { history, state, me, open = new Set(), where, now = () => Date.now() }) {
  const st = state.load() || {};
  history.flush();
  const result = { gistId: null, pushed: 0, pulled: 0, trashed: 0, forked: 0, tooBig: 0, synced: 0 };

  // The gist as it stands. A 304 brings only the index kept from last time.
  let id = st.gistId || null;
  let remote = hs.cleanIndex({}), files = {}, etag = null, full = false;
  const fetchGist = async useEtag => {
    const r = await gh.getFresh(`/gists/${encodeURIComponent(id)}`, useEtag && st.index ? st.etag : null);
    if (r.notModified) { remote = hs.cleanIndex(st.index); etag = st.etag; return; }
    ({ remote, files } = readGist(r.data));
    etag = r.etag || null; full = true;
  };
  if (id) {
    try { await fetchGist(true); } catch (e) { if (e.status !== 404) throw e; id = null; }
  }
  if (!id) {
    id = await findGist(gh, null, hs.INDEX_FILE);
    if (id) await fetchGist(false);
  }

  let p = hs.plan({ local: history.list(), bin: history.trashed(), remote, gone: st.gone, open, now: now() });
  // Taking anything needs its transcript, which a 304 didn't bring.
  if (id && !full && (p.pull.length || p.fork.length)) {
    await fetchGist(false);
    p = hs.plan({ local: history.list(), bin: history.trashed(), remote, gone: st.gone, open, now: now() });
  }
  const R = new Map(remote.entries.map(e => [e.id, e]));
  const pushIds = [...p.push];
  const pullIds = [...p.pull];

  // Changed on both sides: this PC's version steps aside, under a new id.
  for (const fid of p.fork) {
    const le = history.get(fid);
    if (!le || typeof files[hs.fileFor(fid)] !== 'string') continue;
    const newId = randomUUID();
    if (!history.rekey(fid, newId, { title: copyTitle(le.title), syncedAt: 0, editedAt: now() })) continue;
    pushIds.push(newId); pullIds.push(fid); result.forked++;
  }

  for (const tid of p.trash) if (history.trash(tid, p.gone[tid] || now(), { quiet: true })) result.trashed++;

  for (const pid of pullIds) {
    const re = R.get(pid);
    if (!re) continue;
    const le = history.get(pid);
    // Only renamed, ticked off or restored there: the transcript here is the same.
    if (le && le.updatedAt === re.updatedAt) {
      history.markSynced(pid, { title: re.title, done: re.done || undefined, editedAt: re.editedAt, syncedAt: hs.changedAt(re) });
      result.pulled++;
      continue;
    }
    const packed = files[hs.fileFor(pid)];
    if (typeof packed !== 'string') continue; // not there (yet): next time
    const items = hs.unpack(packed);
    const at = le?.cwd && where.exists(le.cwd) ? { cwd: le.cwd, moved: false } : hs.place(re, where);
    const recapText = hs.recap(items, { from: re.lastPcName, cwd: re.cwd, moved: at.moved });
    if (history.putSynced(hs.entryIn(re, le, { me, cwd: at.cwd, recapText }), items)) result.pulled++;
  }

  for (const sid of p.settle) history.markSynced(sid, { syncedAt: hs.changedAt(R.get(sid)) });

  // What goes up.
  const outEntries = [], put = {}, stamps = new Map();
  for (const pid of new Set(pushIds)) {
    const le = history.get(pid);
    if (!le) continue;
    const packed = hs.pack(hs.travel(history.load(pid)));
    if (packed.length > hs.MAX_PACKED) { result.tooBig++; continue; }
    const out = hs.entryOut(le, R.get(pid), me, where.placeOf(le.worktree?.originalCwd || le.cwd) || {});
    if (!out) continue;
    outEntries.push(out);
    put[hs.fileFor(pid)] = { content: packed };
    stamps.set(pid, { syncedAt: hs.changedAt(le), pc: out.pc, pcName: out.pcName, lastPc: out.lastPc, lastPcName: out.lastPcName, repo: out.repo, rel: out.rel });
  }
  const { index, removed } = hs.nextIndex(remote, outEntries, p.drop, p.gone);
  const had = new Set(remote.entries.map(e => e.id));
  for (const rid of removed) {
    if (put[hs.fileFor(rid)]) delete put[hs.fileFor(rid)];
    else if (had.has(rid)) put[hs.fileFor(rid)] = null;
  }
  const indexChanged = JSON.stringify(index) !== JSON.stringify(hs.cleanIndex(remote));
  if (Object.keys(put).length || indexChanged) {
    if (!id) {
      const created = await gh.post('/gists', { public: false, description: 'Shellby history', files: { [hs.INDEX_FILE]: { content: indexContent(hs.cleanIndex({})) } } });
      id = created.id;
    }
    for (const part of chunks(put, index)) await gh.patch(`/gists/${encodeURIComponent(id)}`, { files: part });
    for (const [sid, s] of stamps) history.markSynced(sid, s);
    result.pushed = stamps.size;
    // The gist changed under the tag, so the next sync reads it whole once.
    state.save({ gistId: id, etag: null, index: null, gone: p.gone });
  } else {
    state.save({ gistId: id, etag, index: etag ? index : null, gone: p.gone });
  }
  result.gistId = id;
  result.synced = index.entries.length;
  return result;
}

module.exports = { syncHistory, whereFrom, readGist, chunks };
