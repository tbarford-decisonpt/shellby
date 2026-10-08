// Copies coming home into the same checkout work together (ipc/repo.js).
//
// Merges take turns: "Bring it home" on a second copy while the first is
// still merging (or pushing) waits for it, instead of two gits fighting over
// your checkout's index. So you can start the next one straight away.
//
// Clashes are sorted out in turn too. When several copies clash with their
// base at once and each sorts it out against the base as it is now, the first
// one home moves the base and the others clash all over again. So only the
// copy at the front of the line merges the base in; once it has, Shellby brings
// it home itself, and the next one starts on a base that already has it.
//
// The git and the conversations are passed in, so it's testable:
//   isOpen(tabId), isBusy(tabId)
//   send(tabId, prompt)              a message into the conversation; throws if it can't
//   bringHome(tabId, opts)           ipc/repo.js bringTabHome: the tests, the merge, the push
//   caughtUp(w)                      worktrees.caughtUp: the base merged in, nothing half done
//   tell(event)                      to the panel: { tabId, title, base, status, ... }
const path = require('path');

const MAX_TRIES = 3; // the base moving on under it this many times: over to you

const keyOf = root => path.resolve(root).toLowerCase();

function sortPrompt(w, { landed = [], again = false } = {}) {
  const base = w.base;
  const start = again
    ? `${base} moved on while you were sorting this out, so it clashes again. Merge ${base} into this branch again (git merge ${base})`
    : `Merge ${base} into this branch (git merge ${base})`;
  const before = landed.length
    ? ` ${base} already has ${landed.map(t => `"${t}"`).join(', ')}, which came home just before this: keep ${landed.length === 1 ? 'its' : 'their'} work as well as this branch's.`
    : '';
  return `${start}, resolve the conflicts so both sides' intent survives, run the tests if there are any, and commit.${before} Don't merge into ${base} yourself: Shellby brings it home as soon as you've finished, and other copies are waiting their turn behind it.`;
}

function createHomeLine({ isOpen, isBusy, send, bringHome, caughtUp, tell = () => {}, log = { info: () => {} }, maxTries = MAX_TRIES }) {
  // ---- merges into one checkout, one at a time
  const lanes = new Map(); // root key -> the tail of what's queued there

  /** Run fn once everything queued before it for this checkout is done. -> fn's result */
  function turn(root, fn) {
    const key = keyOf(root);
    const run = (lanes.get(key) || Promise.resolve()).then(() => fn());
    const tail = run.then(() => {}, () => {});
    lanes.set(key, tail);
    tail.then(() => { if (lanes.get(key) === tail) lanes.delete(key); });
    return run;
  }
  /** Is something merging into (or pushing from) this checkout right now? */
  const busy = root => lanes.has(keyOf(root));

  // ---- clashes, sorted out one copy at a time
  const lines = new Map();  // root key -> [entry], the front one sorting it out
  const landed = new Map(); // root key -> titles home since the line last emptied

  const find = tabId => {
    for (const [key, line] of lines) {
      const i = line.findIndex(e => e.tabId === tabId);
      if (i >= 0) return { key, line, i, entry: line[i] };
    }
    return null;
  };
  const titleOf = e => e.title || e.w.branch;
  const event = (e, status, extra = {}) => tell({ tabId: e.tabId, title: titleOf(e), base: e.w.base, branch: e.w.branch, status, ...extra });

  /**
   * Line this copy up to sort out its clash and come home.
   * opts: what "Bring it home" was asked for ({ push, check, force }).
   *   -> { ok: true, position, ahead: title | null, already? } | { ok: false, error }
   */
  function sortOut(tabId, w, title, opts = {}) {
    const there = find(tabId);
    if (there) return { ok: true, already: true, position: there.i, ahead: there.i ? titleOf(there.line[0]) : null };
    if (!isOpen(tabId)) return { ok: false, error: 'Open the conversation first.' };
    const key = keyOf(w.root);
    if (!lines.has(key)) { lines.set(key, []); landed.delete(key); }
    const line = lines.get(key);
    const entry = { tabId, w, title, opts: { push: !!opts.push, check: opts.check, force: !!opts.force }, tries: 0, sorting: false, settling: false };
    line.push(entry);
    const position = line.length - 1;
    if (position === 0) begin(key, entry);
    return { ok: true, position, ahead: position ? titleOf(line[0]) : null };
  }

  function begin(key, e, { again = false } = {}) {
    if (!isOpen(e.tabId)) return done(key, e);
    // You're talking to it right now: it starts when that turn ends (turnEnded).
    if (isBusy(e.tabId)) { e.wanted = true; return; }
    e.wanted = false;
    try {
      send(e.tabId, sortPrompt(e.w, { landed: again ? [] : landed.get(key) || [], again }));
    } catch (err) {
      event(e, 'stuck', { error: `Couldn't ask him to sort it out: ${err.message}` });
      return done(key, e);
    }
    e.sorting = true;
    event(e, 'sorting', { again });
  }

  /** A turn ended in a conversation: maybe the front copy finished sorting it out. */
  async function turnEnded(tabId) {
    const at = find(tabId);
    if (!at || at.i !== 0) return; // not in line, or still waiting its turn
    const { key, entry: e } = at;
    if (e.wanted && !e.sorting) return begin(key, e);
    if (!e.sorting || e.settling) return;
    e.sorting = false;
    e.settling = true;
    try { await settle(key, e); } catch (err) {
      log.info(`home line: ${err.message}`);
      event(e, 'stuck', { error: err.message });
      done(key, e);
    } finally { e.settling = false; }
  }

  async function settle(key, e) {
    if (!(await caughtUp(e.w))) {
      // Stopped short: a question for you, stopped, or it went another way.
      event(e, 'stuck', { error: `He stopped before ${e.w.base} was merged in, so it stayed in its copy. Bring it home once it's sorted.` });
      return done(key, e);
    }
    const r = await bringHome(e.tabId, { ...e.opts, finish: false });
    if (r?.ok) {
      landed.set(key, [...landed.get(key) || [], titleOf(e)]);
      event(e, 'home', { merged: !!r.merged, commits: r.commits || 0, push: r.push || null });
      return done(key, e);
    }
    // The base moved on again (something that wasn't in line): once more, a few times.
    if (r?.conflict && ++e.tries < maxTries) return begin(key, e, { again: true });
    event(e, 'stuck', { error: r?.error || "Couldn't bring it home.", red: !!r?.red, fix: r?.fix || null });
    return done(key, e);
  }

  // Off the front (or out of the line), and the next one starts.
  function done(key, e) {
    const line = lines.get(key);
    if (!line) return;
    const i = line.indexOf(e);
    if (i >= 0) line.splice(i, 1);
    if (!line.length) { lines.delete(key); return; }
    if (i === 0) begin(key, line[0]);
  }

  /** Conversations that closed leave the line. openIds: a Set of the open tab ids. */
  function prune(openIds) {
    for (const [key, line] of [...lines]) {
      for (const e of [...line]) if (!openIds.has(e.tabId) && !e.settling) done(key, e);
    }
  }

  /** Where a copy stands: { position, ahead } or null when it isn't in line. */
  function placeOf(tabId) {
    const at = find(tabId);
    return at ? { position: at.i, ahead: at.i ? titleOf(at.line[0]) : null, sorting: at.entry.sorting } : null;
  }

  return { turn, busy, sortOut, turnEnded, prune, placeOf };
}

module.exports = { createHomeLine, sortPrompt, MAX_TRIES };
