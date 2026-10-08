/* Shellby panel — Ctrl+F: find in this conversation. Matches are painted with
   the CSS Custom Highlight API, so nothing in the feed is rewrapped or moved,
   and only the conversation is searched (never the find box itself). */
'use strict';
(function () {
  const { $, state } = SB;
  const bar = $('findBar');
  const input = $('findInput');
  const count = $('findCount');
  const MAX_MATCHES = 2000;

  let ranges = [];
  let current = -1;
  let observer = null;
  let timer = null;

  const feed = () => SB.activeTab()?.el || null;

  function collect(q) {
    const root = feed();
    if (!root || !q) return [];
    const needle = q.toLowerCase();
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentElement?.closest('.empty, .en') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    while (walker.nextNode() && out.length < MAX_MATCHES) {
      const node = walker.currentNode;
      const text = node.data.toLowerCase();
      for (let i = text.indexOf(needle); i !== -1 && out.length < MAX_MATCHES; i = text.indexOf(needle, i + needle.length)) {
        const r = new Range();
        r.setStart(node, i);
        r.setEnd(node, i + needle.length);
        out.push(r);
      }
    }
    return out;
  }

  function paint() {
    CSS.highlights.set('shellby-find', new Highlight(...ranges));
    if (ranges[current]) CSS.highlights.set('shellby-find-current', new Highlight(ranges[current]));
    else CSS.highlights.delete('shellby-find-current');
    const q = input.value;
    count.textContent = !q ? '' : ranges.length ? `${current + 1} of ${ranges.length}${ranges.length >= MAX_MATCHES ? '+' : ''}` : 'No results';
    bar.classList.toggle('none', !!q && !ranges.length);
  }

  function reveal(r) {
    // A match inside a folded tool row or helper lane opens it.
    for (let d = r.startContainer.parentElement?.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
    r.startContainer.parentElement?.scrollIntoView({ block: 'center' });
  }

  // keep: re-run after the feed changed, holding on to roughly the same match.
  function search({ keep = false } = {}) {
    const was = current;
    ranges = collect(input.value);
    if (!ranges.length) current = -1;
    else if (keep && was >= 0) current = Math.min(was, ranges.length - 1);
    else {
      // The first match at or below the top of what you're looking at.
      const top = feed().getBoundingClientRect().top;
      current = ranges.findIndex(r => r.getBoundingClientRect().bottom >= top);
      if (current < 0) current = ranges.length - 1;
      reveal(ranges[current]);
    }
    paint();
  }

  function go(step) {
    if (!ranges.length) return;
    if (!ranges[current]?.startContainer.isConnected) search({ keep: true });
    current = (current + step + ranges.length) % ranges.length;
    reveal(ranges[current]);
    paint();
  }

  function watch() {
    observer?.disconnect();
    const root = feed();
    if (!root) return;
    observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => search({ keep: true }), 250); });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  }

  SB.find = {
    open() {
      if (state.view !== 'chat') SB.setView('chat');
      bar.hidden = false;
      input.focus();
      input.select();
      watch();
      if (input.value) search();
    },
    close() {
      if (bar.hidden) return;
      bar.hidden = true;
      observer?.disconnect();
      clearTimeout(timer);
      CSS.highlights.delete('shellby-find');
      CSS.highlights.delete('shellby-find-current');
      ranges = [];
      current = -1;
      $('input').focus();
    },
    // The conversation underneath changed (another tab).
    refresh() { if (!bar.hidden) { watch(); search(); } },
    next: () => go(1),
    prev: () => go(-1),
    get isOpen() { return !bar.hidden; },
  };

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 120); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); SB.find.close(); }
  });
  $('findPrev').addEventListener('click', () => go(-1));
  $('findNext').addEventListener('click', () => go(1));
  $('findClose').addEventListener('click', () => SB.find.close());

  document.addEventListener('keydown', e => {
    if (state.view === 'onboarding' || SB.isCrabOnly?.()) return;
    if (SB.shortcuts.matches(e, 'find')) { e.preventDefault(); SB.find.open(); return; }
    if (e.key === 'F3' && !bar.hidden) { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
  });
})();
