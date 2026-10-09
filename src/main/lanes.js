// Running many conversations at once (pure): the board, the merge order, and
// the waiting permission prompts grouped across every conversation.
//
//   lanes()        one lane per open conversation: what it's doing (working,
//                  waiting on you, tests red, ready to merge), how big its
//                  change is, and which other lanes changed the same files
//                  (clash.js does the comparing; wiring/lanes.js the git).
//   mergeOrder()   the lanes that are ready, per repository and branch they go
//                  home to, fewest overlaps first, then smallest.
//   groupPrompts() identical prompts from several conversations as one ("4
//                  want `npm test`"), so one answer can go to all of them.
//
// No I/O, no clock. See test/lanes.test.js.
const { rootKey } = require('./clash');
const { deskOnlyReason } = require('./replies');

const STATES = Object.freeze(['waiting', 'working', 'red', 'ready', 'idle']);
const RED = new Set(['fail', 'error', 'timeout']);
const MAX_WHAT = 200;

const count = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * What one conversation is doing, from its summary (sessions.js `summary`)
 * and its change (diff: { files, added, removed } | null). Asking beats
 * working beats red beats ready.
 */
function laneState(tab, diff = null) {
  if (!tab) return 'idle';
  if (count(tab.pending) > 0) return 'waiting';
  if (tab.busy) return 'working';
  if (RED.has(tab.checks?.status)) return 'red';
  if (tab.worktree && diff && count(diff.files?.length) > 0) return 'ready';
  return 'idle';
}

/** `git diff --numstat` -> { files, added, removed }. Binary files count as changed, 0 lines. */
function parseNumstat(out) {
  const files = [];
  let added = 0, removed = 0;
  for (const line of String(out || '').split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    files.push(m[3]);
    if (m[1] !== '-') added += Number(m[1]);
    if (m[2] !== '-') removed += Number(m[2]);
  }
  return { files, added, removed };
}

/**
 * The board.
 *   tabs:    sessions.js `summary`
 *   diffs:   Map tabId -> { files: [path], added, removed } (copies only)
 *   clashes: clash.js findClashes' output
 *   roots:   Map tabId -> the repository a copy came from (tab.worktree.root)
 * -> [{ tabId, title, branch, base, root, state, files, added, removed, size,
 *       overlaps: [{ tabId, title, checkout, files }] }], in tab order.
 */
function lanes({ tabs = [], diffs = new Map(), clashes = [], roots = new Map() } = {}) {
  const overlapsOf = new Map(); // tabId -> Map(otherId -> { ..., files:Set })
  for (const c of clashes || []) {
    const who = c.copies || [];
    for (const me of who) {
      if (!me.tabId) continue;
      if (!overlapsOf.has(me.tabId)) overlapsOf.set(me.tabId, new Map());
      const mine = overlapsOf.get(me.tabId);
      for (const other of who) {
        if (other === me) continue;
        const id = other.checkout ? 'checkout' : other.tabId;
        if (!mine.has(id)) mine.set(id, { tabId: other.checkout ? null : other.tabId, title: other.title, checkout: !!other.checkout, files: new Set() });
        for (const f of c.files || []) mine.get(id).files.add(f);
      }
    }
  }
  return (tabs || []).filter(t => t && typeof t.id === 'string').map(t => {
    const diff = diffs.get(t.id) || null;
    const added = count(diff?.added), removed = count(diff?.removed);
    return {
      tabId: t.id,
      title: t.title || 'Untitled',
      branch: t.worktree?.branch || null,
      base: t.worktree?.base || null,
      root: roots.get(t.id) || null,
      state: laneState(t, diff),
      pending: count(t.pending),
      checks: t.checks?.status || null,
      files: count(diff?.files?.length),
      added, removed, size: added + removed,
      overlaps: [...(overlapsOf.get(t.id)?.values() || [])].map(o => ({ ...o, files: [...o.files].sort() })),
    };
  });
}

/**
 * The order to bring ready lanes home, per repository and branch: each pick is
 * the lane overlapping the fewest of the ones still to go, then the smallest,
 * then by title, so the ones most likely to conflict go last, onto everything
 * else. -> [{ root, base, lanes: [lane] }] (only groups with a lane in them).
 */
function mergeOrder(all) {
  const groups = new Map();
  for (const l of all || []) {
    if (!l || l.state !== 'ready' || !l.root || !l.base || !l.branch) continue;
    const k = `${rootKey(l.root)}|${l.base}`;
    if (!groups.has(k)) groups.set(k, { root: l.root, base: l.base, lanes: [] });
    groups.get(k).lanes.push(l);
  }
  const out = [];
  for (const g of groups.values()) {
    const left = [...g.lanes];
    const ordered = [];
    while (left.length) {
      const ids = new Set(left.map(l => l.tabId));
      const score = l => l.overlaps.filter(o => o.tabId && o.tabId !== l.tabId && ids.has(o.tabId)).length;
      left.sort((a, b) => score(a) - score(b) || a.size - b.size || a.files - b.files || a.title.localeCompare(b.title) || (a.tabId < b.tabId ? -1 : 1));
      ordered.push(left.shift());
    }
    out.push({ root: g.root, base: g.base, lanes: ordered });
  }
  return out.sort((a, b) => (`${rootKey(a.root)}|${a.base}` < `${rootKey(b.root)}|${b.base}` ? -1 : 1));
}

/** What a prompt wants, as one line to compare and show: the command, the file, or its label. */
function whatOf(p) {
  const v = p.input?.command ?? p.input?.file_path ?? p.input?.url ?? p.label ?? p.detail ?? '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, MAX_WHAT);
}

/**
 * Waiting prompts across every conversation (oldest first), grouped by the
 * same tool wanting the same thing. A prompt that has to be read at the desk
 * (replies.js deskOnlyReason: a question, a plan, a file Claude wrote...) is
 * never answered in bulk: it stays a group of one with `look` set.
 * -> [{ key, toolName, what, count, look, prompts: [{ tabId, requestId }] }],
 *    the biggest group first, then the oldest.
 */
function groupPrompts(prompts) {
  const groups = new Map();
  (prompts || []).forEach((p, i) => {
    if (!p || typeof p.tabId !== 'string' || typeof p.requestId !== 'string') return;
    const look = !!deskOnlyReason(p);
    const what = whatOf(p);
    const key = look ? `look\n${p.tabId}\n${p.requestId}` : `${p.toolName || ''}\n${what}`;
    if (!groups.has(key)) groups.set(key, { key, toolName: p.toolName || '', what, look, first: i, prompts: [] });
    groups.get(key).prompts.push({ tabId: p.tabId, requestId: p.requestId });
  });
  return [...groups.values()]
    .sort((a, b) => b.prompts.length - a.prompts.length || a.first - b.first)
    .map(({ first: _first, ...g }) => ({ ...g, count: g.prompts.length }));
}

module.exports = { STATES, laneState, parseNumstat, lanes, mergeOrder, groupPrompts, whatOf };
