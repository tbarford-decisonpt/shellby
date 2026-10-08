/* Shellby panel — keyboard plumbing every view shares: groups that are one Tab
   stop with arrow keys inside (tab lists, radio groups, the item grids), focus
   that survives a group being redrawn, and dialogs that keep the keyboard
   while open and hand it back when they close. */
'use strict';
(function () {
  // ------------------------------------------------------------ roving groups

  // Opt in with data-roving on the container. Tabs and radios follow the arrow
  // keys (moving is choosing, as everywhere else); a listbox only moves focus,
  // so walking the Wardrobe tries things on without wearing them.
  const ITEM = '[role="tab"], [role="radio"], [role="option"]';
  const shown = el => !el.disabled && el.getClientRects().length > 0;
  const itemsOf = group => [...group.querySelectorAll(ITEM)].filter(shown);
  // An item is the same item after a redraw if its first data-* says so (data-key,
  // data-id…). Only the first: the tooltip adds data-tip later, to some of them.
  const idOf = el => { const [k] = Object.keys(el.dataset); return k ? `${k}=${el.dataset[k]}` : null; };
  const chosen = el => el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-checked') === 'true';

  let owner = null;   // the group the keyboard was last in
  let lastId = null;  // and the item it was on

  function sync(group) {
    // A group in a screen that isn't showing yet still needs its one Tab stop.
    const all = [...group.querySelectorAll(ITEM)];
    const visible = itemsOf(group);
    const items = visible.length ? visible : all;
    const stop = items.find(el => el === document.activeElement) || items.find(chosen) || items[0];
    for (const el of all) el.tabIndex = el === stop ? 0 : -1;
  }

  // The next item in a grid: the nearest one on the row above or below.
  function vertical(items, from, dir) {
    const r = from.getBoundingClientRect();
    const rows = items.filter(el => (el.getBoundingClientRect().top - r.top) * dir > 1);
    if (!rows.length) return null;
    const rowTop = dir > 0 ? Math.min(...rows.map(el => el.getBoundingClientRect().top)) : Math.max(...rows.map(el => el.getBoundingClientRect().top));
    const cx = r.left + r.width / 2;
    const dist = el => { const b = el.getBoundingClientRect(); return Math.abs(b.left + b.width / 2 - cx); };
    return rows.filter(el => Math.abs(el.getBoundingClientRect().top - rowTop) < 2).sort((a, b) => dist(a) - dist(b))[0];
  }

  function onKey(e, group) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const from = e.target.closest(ITEM);
    if (!from || !group.contains(from)) return;
    const items = itemsOf(group);
    const i = items.indexOf(from);
    const grid = group.getAttribute('role') === 'listbox';
    let to;
    if (e.key === 'Home') to = items[0];
    else if (e.key === 'End') to = items[items.length - 1];
    else if (e.key === 'ArrowRight' || (!grid && e.key === 'ArrowDown')) to = items[(i + 1) % items.length];
    else if (e.key === 'ArrowLeft' || (!grid && e.key === 'ArrowUp')) to = items[(i - 1 + items.length) % items.length];
    else if (grid && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) to = vertical(items, from, e.key === 'ArrowDown' ? 1 : -1);
    else return;
    e.preventDefault();
    if (!to || to === from) return;
    to.focus();
    if (!grid) to.click();
  }

  function rove(group) {
    group.addEventListener('keydown', e => onKey(e, group));
    group.addEventListener('focusin', e => {
      const item = e.target.closest(ITEM);
      if (item) { owner = group; lastId = idOf(item); }
      sync(group);
    });
    // Clicking somewhere blank lets go of the group; a redraw taking the button away doesn't.
    group.addEventListener('focusout', e => {
      if (e.relatedTarget) return;
      queueMicrotask(() => { if (e.target.isConnected && owner === group) owner = null; });
    });
    // Choosing something redraws the group, and the focused button goes with it.
    // Put the keyboard back on the same item rather than at the top of the page.
    new MutationObserver(() => {
      const lost = !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected;
      if (owner === group && lost && lastId) {
        const again = itemsOf(group).find(el => idOf(el) === lastId);
        if (again) again.focus({ preventScroll: true });
      }
      sync(group);
    }).observe(group, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected', 'aria-checked', 'hidden'] });
    sync(group);
  }

  // Leaving a group for anywhere else means it shouldn't pull focus back later.
  document.addEventListener('focusin', e => { if (owner && !owner.contains(e.target)) owner = null; });

  SB.rove = rove;  document.querySelectorAll('[data-roving]').forEach(rove);

  // ------------------------------------------------------------ dialogs

  // The share card, the upsell, "Wear a code" and any sheet a view adds later
  // (Import a workflow) are modal: Tab stays inside them, and closing one of the
  // page's own goes back to whatever opened it.
  const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
  const sheets = [...document.querySelectorAll('.card-sheet')];
  // Looked up on every key press: sheets come and go.
  const openSheet = () => document.querySelector('.card-sheet:not([hidden])');
  let returnTo = null;

  document.addEventListener('focusin', e => { if (!e.target.closest('.card-sheet')) returnTo = e.target; });

  document.addEventListener('keydown', e => {
    const sheet = e.key === 'Tab' && openSheet();
    if (!sheet) return;
    const stops = [...sheet.querySelectorAll(FOCUSABLE)].filter(shown);
    if (!stops.length) return;
    const first = stops[0], last = stops[stops.length - 1];
    const inside = sheet.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
  });

  for (const sheet of sheets) {
    new MutationObserver(() => {
      if (!sheet.hidden) return;
      const active = document.activeElement;
      const stranded = !active || active === document.body || sheet.contains(active);
      if (stranded && returnTo?.isConnected && !openSheet()) returnTo.focus();
    }).observe(sheet, { attributes: true, attributeFilter: ['hidden'] });
  }
})();
