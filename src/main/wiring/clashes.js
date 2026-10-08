// Clash warnings across copies: when two copies of a repository (or a copy and
// your own checkout) have changed the same file, the panel hears about it as
// soon as it happens, not when Bring it home stops on a conflict.
//
// Rechecked for a repository after a turn in it ends, after a copy is brought
// home, when copies open or close, and every couple of minutes while a
// repository has two copies or more. Debounced, git on a timeout, and never in
// the way of a turn: nothing waits on it. The comparing is clash.js, the git
// is clash-scan.js.
// Kept out of main.js, which only wires it up.
const path = require('path');
const { findClashes, freshClashes, rootKey } = require('../clash');
const clashScan = require('../clash-scan');
const worktrees = require('../worktrees');

const DEBOUNCE_MS = 1500;
const REFRESH_MS = 2 * 60 * 1000;

/**
 * The watch itself, with what it needs passed in (so it's testable):
 *   tabs()     -> the session manager's Map of open tabs
 *   home()     -> Shellby's worktree folder; only copies in it count
 *   enabled()  -> the setting
 *   push(view) -> to the panel: { clashes, fresh: [key] }
 */
function createClashWatch({ tabs, home, enabled, push, log, scan = clashScan, debounceMs = DEBOUNCE_MS }) {
  let current = [];
  const byRoot = new Map(); // rootKey -> [entry] as last scanned
  let pending = null;       // 'all' | Set(rootKey)
  let timer = null;
  let running = null;       // the run in progress
  let copySig = '';

  function openCopies() {
    const dir = path.resolve(home()).toLowerCase() + path.sep;
    const out = [];
    for (const [tabId, t] of tabs() || []) {
      const w = t?.worktree;
      if (!w || typeof w.path !== 'string' || worktrees.checkWorktree(w)) continue;
      if (!path.resolve(w.path).toLowerCase().startsWith(dir)) continue;
      out.push({ tabId, title: t.title, w });
    }
    return out;
  }

  async function scanRoot(root, copies) {
    const [mine, ...theirs] = await Promise.all([scan.changedInCheckout(root), ...copies.map(c => scan.changedInCopy(c.w))]);
    const entries = [];
    copies.forEach((c, i) => {
      if (theirs[i]) entries.push({ tabId: c.tabId, title: c.title, branch: c.w.branch, base: c.w.base, root: c.w.root, files: theirs[i] });
    });
    if (mine) entries.push({ checkout: true, root, branch: mine.branch, files: mine.files });
    return entries;
  }

  function publish(next) {
    const fresh = freshClashes(current, next).map(c => c.key);
    const same = JSON.stringify(next) === JSON.stringify(current);
    current = next;
    if (!same || fresh.length) push({ clashes: next, fresh });
  }

  async function run() {
    const want = pending;
    pending = null;
    if (!enabled()) { byRoot.clear(); publish([]); return; }
    const groups = new Map(); // rootKey -> { root, copies }
    for (const c of openCopies()) {
      const rk = rootKey(c.w.root);
      if (!groups.has(rk)) groups.set(rk, { root: c.w.root, copies: [] });
      groups.get(rk).copies.push(c);
    }
    for (const rk of [...byRoot.keys()]) if (!groups.has(rk)) byRoot.delete(rk);
    const todo = [...groups].filter(([rk]) => want === 'all' || want?.has(rk) || !byRoot.has(rk));
    await Promise.all(todo.map(async ([rk, g]) => byRoot.set(rk, await scanRoot(g.root, g.copies))));
    const open = tabs();
    // A tab closed while its repository was being looked at is no clash any more.
    const entries = [...byRoot.values()].flat().filter(e => e.checkout || open?.has(e.tabId))
      .map(e => (e.checkout ? e : { ...e, title: open.get(e.tabId)?.title || e.title }));
    publish(findClashes(entries));
  }

  function kick() {
    if (running) return; // it looks again when it's done
    running = run()
      .catch(err => log?.info?.(`clashes: ${err.message}`))
      .finally(() => { running = null; if (pending) schedule(); });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(kick, debounceMs);
    timer.unref?.();
  }

  /** Look again: at one repository, or (no root) all of them. */
  function refresh(root) {
    if (pending !== 'all') {
      if (typeof root === 'string' && root) (pending ??= new Set()).add(rootKey(root));
      else pending = 'all';
    }
    schedule();
  }

  /** A turn ended in this tab: its repository, if any copy is of it. */
  function turnEnded(tab) {
    if (!tab) return;
    if (tab.worktree?.root) return refresh(tab.worktree.root);
    // A conversation in your checkout changes what a copy would merge over.
    const cwd = tab.session?.cwd;
    if (typeof cwd !== 'string') return;
    const here = rootKey(cwd) + '/';
    const root = openCopies().map(c => c.w.root).find(r => here.startsWith(rootKey(r) + '/'));
    if (root) refresh(root);
  }

  /** The open tabs changed: a copy opened, closed or moved, so look again. */
  function tabsChanged() {
    const sig = openCopies().map(c => `${c.tabId}>${c.w.path}`).sort().join('|');
    if (sig === copySig) return;
    copySig = sig;
    refresh();
  }

  /** The slow timer: only repositories with two copies or more. */
  function tick() {
    if (!enabled()) return;
    const n = new Map();
    for (const c of openCopies()) n.set(rootKey(c.w.root), [...(n.get(rootKey(c.w.root)) || []), c.w.root]);
    for (const roots of n.values()) if (roots.length >= 2) refresh(roots[0]);
  }

  return {
    refresh, turnEnded, tabsChanged, tick,
    view: () => current,
    settled: () => running || Promise.resolve(), // for tests
  };
}

/** d: what main shares (main.js `shared`). */
function wireClashes(d) {
  const watch = createClashWatch({
    tabs: () => d.manager?.tabs,
    home: () => d.worktreeHome(),
    enabled: () => d.config.get('clashWarnings') !== false && !d.CAPTURE,
    push: view => d.send(d.panel, 'clashes', view),
    log: d.log,
  });
  let ticking = null;
  function watchClashes() {
    if (ticking) return;
    ticking = setInterval(watch.tick, REFRESH_MS);
    ticking.unref?.();
  }
  return {
    clashesView: watch.view,
    clashTabsChanged: watch.tabsChanged,
    clashTurnEnded: tabId => watch.turnEnded(d.manager?.tabs.get(tabId)),
    refreshClashes: watch.refresh,
    watchClashes,
  };
}

module.exports = { wireClashes, createClashWatch, DEBOUNCE_MS, REFRESH_MS };
