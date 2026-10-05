// Sorting open conversations by what they need from you (tab-overview.js draws
// it): where each one stands, the list grouped and filtered, which can be closed
// in one go, and what's scrolled out of sight at each end of the strip. Pure, no
// DOM. Works in the browser and in Node (for tests).
(function (root) {
  // Most urgent first. The list and the strip's edge markers both follow it.
  const STANDINGS = ['asking', 'finished', 'working', 'quiet'];
  const TITLES = { asking: 'Waiting for your OK', finished: 'Finished', working: 'Working', quiet: 'Quiet' };

  // An error ending is "finished" until you've looked; after that it's quiet. A
  // queue paused by an error is waiting on you too.
  function standing(t) {
    if (t.pending) return 'asking';
    if (t.busy || t.crew) return 'working';
    if (t.unread || (t.queuePaused && t.queue?.length)) return 'finished';
    return 'quiet';
  }

  // What a working tab is up to: 'turn' while Claude is mid-reply, 'background'
  // once the turn has ended but something it started (a backgrounded command, a
  // background agent) is still running, null when nothing is.
  function activity(t) {
    if (t.busy) return 'turn';
    if (t.crew) return 'background';
    return null;
  }

  const rank = s => STANDINGS.indexOf(s);

  // Every word has to appear in the title or the folder.
  function matches(t, query) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const hay = `${t.title || ''} ${t.cwd || ''}`.toLowerCase();
    return words.every(w => hay.includes(w));
  }

  // [{ standing, title, tabs }] in urgency order, strip order inside each group;
  // empty groups left out.
  function groups(tabs, query = '') {
    const shown = tabs.filter(t => matches(t, query));
    return STANDINGS
      .map(s => ({ standing: s, title: TITLES[s], tabs: shown.filter(t => standing(t) === s) }))
      .filter(g => g.tabs.length);
  }

  // Safe to close without asking: quiet, not the one you're in, and nothing of
  // yours would go with it (a queued message, an unsent draft or attachment).
  const closable = (t, activeId) => standing(t) === 'quiet' && t.id !== activeId
    && !t.queue?.length && !t.attachments?.length && !String(t.draft || '').trim();

  // What's out of sight at each end of the strip. items: [{ id, left, width,
  // standing }] in strip order, positions in the strip's scrolled content; view:
  // { scrollLeft, width }. A tab less than half in view counts as hidden. Each
  // side: { count, standing (its most urgent), target (the nearest hidden tab
  // of that standing, to jump to) } or null when nothing is hidden there.
  function edges(items, view) {
    const lo = view.scrollLeft;
    const hi = view.scrollLeft + view.width;
    const mid = it => it.left + it.width / 2;
    const side = (hidden) => {
      if (!hidden.length) return null;
      const top = hidden.reduce((best, it) => (rank(it.standing) < rank(best) ? it.standing : best), 'quiet');
      return { count: hidden.length, standing: top, target: hidden.find(it => it.standing === top).id };
    };
    // Nearest first on each side, so the target is the closest one to scroll to.
    return {
      left: side(items.filter(it => mid(it) < lo).reverse()),
      right: side(items.filter(it => mid(it) > hi)),
    };
  }

  const api = { STANDINGS, TITLES, standing, activity, matches, groups, closable, edges };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyTabSort = api;
})(typeof window !== 'undefined' ? window : globalThis);
