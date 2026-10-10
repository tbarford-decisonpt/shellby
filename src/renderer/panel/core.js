/* Shellby panel — shared state and helpers. Loaded first; everything hangs off `SB`. */
'use strict';

const SB = window.SB = {
  api: window.shellby,
  md: window.ShellbyMarkdown,
  Sprite: window.ShellbySprite,
  MiniShell: window.ShellbyMiniShell,
  shortcuts: window.ShellbyShortcuts, // every shortcut, for the handlers, the palette and the cheat sheet
  panes: window.ShellbyPanes,         // conversations side by side (shared/panes.js)
  // Set in a popped-out conversation's window: the one tab it shows. That
  // window is this same page with the chat alone (main's wiring/popouts.js).
  solo: new URLSearchParams(location.search).get('popout'),
  state: {
    settings: {}, status: {}, skins: [], skin: null, sessions: [], cwd: '', home: '',
    view: 'chat', version: '', packaged: false, updates: null,
    toolbox: null, pinned: [], learned: [], routines: [], notes: null,
    snippets: [],         // saved prompts: /name in the box, @name from a terminal (toolbox.js)
    workflows: null,      // the workflows View (docs/plans/workflows.md), fetched on first visit
    tabs: new Map(),      // tabId -> Tab (see feed.js)
    activeTab: null,      // the focused pane: where the box sends
    grid: [],             // the tabs on screen, as columns of ids (see shared/panes.js)
    popped: new Set(),    // tabs out in windows of their own (main's 'tabs' says which)
    clashes: [],          // copies that changed the same files (clashes.js; src/main/clash.js has the shape)
  },
};
if (SB.solo) document.body.classList.add('solo');
// The shortcuts you changed (Ctrl+/ → Change): every handler that asks shortcuts.js gets them.
SB.shortcuts?.useOverrides(() => SB.state.settings.keybindings);

SB.$ = id => document.getElementById(id);

SB.MODES = [
  { id: 'ask', chip: 'Ask', title: 'Ask first', sub: 'Reads freely. Asks before editing files or running commands.', tag: 'Recommended' },
  { id: 'smart', chip: 'Smart', title: 'Smart', sub: "Claude Code's auto mode: a safety check approves routine steps and stops risky ones." },
  { id: 'acceptEdits', chip: 'Auto-edit', title: 'Auto-edit', sub: 'Edits files on its own. Still asks before running commands.' },
  { id: 'plan', chip: 'Plan', title: 'Plan only', sub: 'Looks around and proposes a plan. Nothing changes until you approve it.' },
  { id: 'autonomous', chip: 'Autonomous', title: 'Autonomous', sub: 'Never asks. Can change or delete anything your Windows account can.', tag: 'Risky', danger: true },
];
SB.MODE_HINTS = {
  ask: "I'll ask before changing anything",
  smart: 'Auto mode: a safety check approves routine steps',
  acceptEdits: 'I edit files freely, ask before commands',
  plan: "Plan only: I won't change anything",
  autonomous: "⚠ Autonomous: I won't ask before acting",
};

// Tiny hyperscript: h('div', { class, text, onclick, dataset }, ...children)
SB.h = function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

// A folder on another computer is named for where it really is: "sandbox: ~/code/app".
SB.remotePlace = p => window.ShellbyRemoteLogic?.placeName(SB.state.settings?.remoteFolders, p) || null;

SB.tildify = p => {
  const home = SB.state.home;
  if (!p) return '~';
  const there = SB.remotePlace(p);
  if (there) return there;
  return home && p.toLowerCase().startsWith(home.toLowerCase()) ? '~' + p.slice(home.length) : p;
};

// Keep the end of long paths visible: C:\…\projects\shellby
SB.shortPath = (p, max = 34) => {
  const t = SB.tildify(p);
  if (t.length <= max) return t;
  if (SB.remotePlace(p)) return `…${t.slice(-(max - 1))}`;
  const sep = '\\';
  const parts = t.split(/[\\/]/).filter(Boolean);
  const head = parts.shift();
  let tail = parts.pop();
  while (parts.length && parts[parts.length - 1].length + tail.length + head.length + 4 <= max) tail = parts.pop() + sep + tail;
  return [head, '…', tail].join(sep);
};

SB.basename = p => String(p).split(/[\\/]/).filter(Boolean).pop() || p;

SB.relTime = t => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
};

SB.untilTime = t => {
  if (!t) return 'not scheduled';
  const d = new Date(t);
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
};

SB.duration = ms => {
  if (ms == null) return '';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
};

// A running clock, whole seconds so it ticks steadily: 7s, 1m 05s, 1h 02m.
SB.clock = ms => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

SB.compact = n => (n == null ? '' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

SB.prettyAccel = a => String(a || '').replace(/Control/g, 'Ctrl').replace(/\+/g, ' + ');

// "1 file", "3 files", "2 children". format writes the number (n => n.toLocaleString()
// for counts that can run into the thousands).
SB.plural = (n, one, many = `${one}s`, format = String) => `${format(n)} ${n === 1 ? one : many}`;
// "1st", "2nd", "3rd", "11th" (src/main/board.js ordinal, for places on the friends' board).
SB.ordinal = k => { const t = k % 100; return t >= 11 && t <= 13 ? `${k}th` : `${k}${['th', 'st', 'nd', 'rd'][k % 10] || 'th'}`; };

// A preference kept on this PC. Storage can refuse (then it lasts this session),
// and an empty value reads as no value.
SB.pref = (key, fallback = null) => { try { return window.localStorage.getItem(key) || fallback; } catch { return fallback; } };
SB.pref.set = (key, value) => { try { window.localStorage.setItem(key, String(value)); } catch { /* storage refused: it lasts this session */ } };

// Redraw part of a screen without losing your place: draw(), then focus goes back
// to the control with the same data-<attr> (data-keep unless told otherwise),
// and `scroller` keeps its scroll position.
SB.focusKept = (box, key, { attr = 'keep', preventScroll = false } = {}) => {
  const el = [...box.querySelectorAll(`[data-${attr}]`)].find(e => e.dataset[attr] === key);
  if (!el) return false;
  el.focus({ preventScroll });
  return document.activeElement === el;
};
SB.keepFocus = (box, draw, { attr = 'keep', scroller = null, preventScroll = false } = {}) => {
  const a = document.activeElement;
  const key = a && box.contains(a) ? a.dataset[attr] : null;
  const top = scroller ? scroller.scrollTop : 0;
  draw();
  if (scroller) scroller.scrollTop = top;
  if (key) SB.focusKept(box, key, { attr, preventScroll });
};

// ------------------------------------------------------------------ announcements
// One polite status line for screen readers, so lists and feeds that redraw all
// the time don't have to be live regions themselves. Emptied first, so saying
// the same thing twice is still heard twice.
let announceTimer;
SB.announce = text => {
  const el = SB.$('announcer');
  if (!el) return;
  el.textContent = '';
  clearTimeout(announceTimer);
  if (text) announceTimer = setTimeout(() => { el.textContent = text; }, 60);
};

// The toast stays in the page (a status region that is always there gets read
// out; one that appears with its words already in it often doesn't), and is
// emptied rather than hidden.
//
// A toast with a button holds the slot: anything that comes in while it's up
// waits its turn (and is dropped if it has gone stale by then), so a clash or a
// catch can't snatch "Ask him to sort it out" from under the pointer. It stops
// holding once you click or press Enter anywhere else: you've moved on, and
// what you did next should answer straight away.
const TOAST_MS = 2800;
const TOAST_OFFER_EXTRA_MS = 2500; // time to reach for the button
const TOAST_LINGER_MS = 3000;      // after the pointer or focus leaves it
const TOAST_STALE_MS = 4000;       // how much longer than its own time a waiting toast stays worth saying
const TOAST_WAITING_MAX = 3;
let toastTimer;
let toastHolds = false;
let toastWaiting = []; // [{ msg, opts, until }]
let toastWired = false;

function toastSlot() {
  const t = SB.$('toast');
  if (toastWired) return t;
  toastWired = true;
  const linger = () => { if (t.children.length) armToast(TOAST_LINGER_MS); };
  t.addEventListener('pointerenter', () => clearTimeout(toastTimer));
  t.addEventListener('focusin', () => clearTimeout(toastTimer));
  t.addEventListener('pointerleave', linger);
  t.addEventListener('focusout', linger);
  t.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); dismissToasts(); } });
  const movedOn = e => { if (toastHolds && !t.contains(e.target)) toastHolds = false; };
  document.addEventListener('pointerdown', movedOn, true);
  document.addEventListener('keydown', e => { if (e.key === 'Enter') movedOn(e); }, true);
  return t;
}

function armToast(ms) {
  clearTimeout(toastTimer);
  toastTimer = setTimeout(endToast, ms);
}

// The slot empties, and the next one still worth saying takes it.
function endToast() {
  clearTimeout(toastTimer);
  SB.$('toast').replaceChildren();
  toastHolds = false;
  const now = Date.now();
  toastWaiting = toastWaiting.filter(w => w.until > now);
  const next = toastWaiting.shift();
  if (next) showToast(next.msg, { ...next.opts, ms: Math.min(next.opts.ms ?? TOAST_MS, next.until - now) });
}

function dismissToasts() {
  toastWaiting = [];
  endToast();
}

function showToast(msg, { title, note, action, onAction, actions, tone = null, ms = TOAST_MS } = {}) {
  const t = toastSlot();
  t.classList.toggle('urgent', tone === 'urgent');
  t.classList.toggle('danger', tone === 'danger');
  const offers = (actions || (action ? [{ label: action, onAction }] : [])).filter(a => a?.label);
  const body = title || note
    ? SB.h('span', { class: 'toast-body' },
      title ? SB.h('strong', { class: 'toast-title', text: title }) : null,
      SB.h('span', { class: 'toast-text', text: msg }),
      note ? SB.h('span', { class: 'toast-note', text: note }) : null)
    : SB.h('span', { text: msg });
  // What the button itself has to say comes first; the waiting ones after.
  const pick = a => {
    clearTimeout(toastTimer);
    t.replaceChildren();
    toastHolds = false;
    a.onAction();
    if (!t.children.length) endToast();
  };
  // ✕ clears it and whatever was waiting behind it: you want them out of the way.
  const dismiss = SB.h('button', { class: 'toast-close', type: 'button', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: dismissToasts },
    SB.icon('M4.5 4.5l7 7M11.5 4.5l-7 7', { width: 1.6 }));
  t.replaceChildren(body,
    ...offers.map(a => SB.h('button', { class: 'toast-action', type: 'button', onclick: () => pick(a) }, a.label)),
    dismiss);
  toastHolds = offers.length > 0;
  armToast(offers.length ? ms + TOAST_OFFER_EXTRA_MS : ms);
}

// actions: [{ label, onAction }] when there's more than one thing to offer.
// title / note: a bold headline above msg and a quiet line under it, for
// toasts with more to say than one sentence. tone: 'urgent' (amber) or
// 'danger' (red) for its edge; sea-glass otherwise.
SB.toast =(msg, opts = {}) => {
  if (!toastHolds) return showToast(msg, opts);
  const until = Date.now() + (opts.ms ?? TOAST_MS) + TOAST_STALE_MS;
  toastWaiting = [...toastWaiting, { msg, opts, until }].slice(-TOAST_WAITING_MAX);
};

// A model picker's options, grouped by family, from the list main accepts
// (src/main/models.js). '' is the default; a saved model that has since left
// the list still shows rather than a blank.
SB.fillModels = (select, current = '', defaultText = 'Default') => {
  const models = SB.state.models || [];
  const groups = [...new Set(models.map(m => m.group))];
  const known = current === '' || models.some(m => m.id === current);
  select.replaceChildren(...[
    SB.h('option', { value: '', text: defaultText }),
    ...groups.map(g => SB.h('optgroup', { label: g }, models.filter(m => m.group === g).map(m => SB.h('option', { value: m.id, text: m.label })))),
    known ? null : SB.h('option', { value: current, text: current }),
  ].filter(Boolean));
  select.value = current;
};
SB.modelLabel = id => (SB.state.models || []).find(m => m.id === id)?.label || id;

// Stroke icon from path data (built with DOM APIs, never innerHTML).
SB.icon = (d, { size = 16, width = 1.4 } = {}) => {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', width);
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
};
SB.ICONS = {
  folder: 'M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.5H13c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z',
  play: 'M5 3.5v9l7-4.5z',
  edit: 'M10.5 2.8l2.7 2.7-7.4 7.4H3.1v-2.7z',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5',
  shield: 'M8 2.6L3.4 4.3v4c0 2.5 1.8 4.3 4.6 5.3 2.8-1 4.6-2.8 4.6-5.3v-4z',
  clock: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 1 0 0-11zM8 5v3.2l2.1 1.3',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
};

// Shellby as he's dressed right now (fit: the view box frames the whole outfit).
// Pass { plain: true } for an undressed crab, e.g. skin swatches.
SB.sprite = (skin = SB.state.skin, opts = {}) => {
  if (!skin) return document.createElement('span');
  const accessories = opts.plain ? [] : opts.accessories ?? SB.state.outfit?.accessories ?? [];
  const shell = opts.plain ? null : opts.shell ?? SB.state.outfit?.home ?? null; // the shell he lives in (shells.js)
  // His stickers belong to the shell he's wearing, so a different shell goes bare.
  const stickers = opts.plain || opts.shell !== undefined ? opts.stickers || [] : SB.state.outfit?.stickers || [];
  return SB.Sprite.build(skin, { fit: accessories.length > 0, ...opts, accessories, shell, stickers });
};

// Helper-crab colours, shared with the desktop critter.
SB.HUES = [0, 145, 250, 60, 300, 200];
SB.helperSprite = index => {
  const svg = SB.sprite(SB.state.skin, { accessories: SB.state.outfit?.crewAccessories ?? [] });
  svg.style.filter = `hue-rotate(${SB.HUES[index % SB.HUES.length]}deg) saturate(1.1)`;
  return svg;
};

SB.renderMarkdownInto = (el, text) => {
  el.innerHTML = SB.md.render(text); // md escapes all input first; see shared/markdown.js
  SB.enhanceCode?.(el);               // colours, Copy, Mermaid (code.js): spans and SVG made with textContent
  return el;
};

// Links are inert <a data-href> (the window blocks navigation and popups), in
// rendered markdown and in panel.html alike; main only opens https.
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-href]');
  if (a) { e.preventDefault(); SB.api.openExternal(a.dataset.href); }
});

// ------------------------------------------------------------------ views

SB.views = {};  // name -> { render?() }

// Which navigation item a screen lives under (Trophies, Crew, Council, Stickers, Finds, Tank, Us and Beach are
// tabs of the Shellby screen, Routines sits beside Workflows under Automate), and
// which screens sit one level down, so Back/Esc go up to their parent.
SB.NAV_SECTION = { shop: 'toolbox', trophies: 'wardrobe', crew: 'wardrobe', council: 'wardrobe', stickers: 'wardrobe', finds: 'wardrobe', tank: 'wardrobe', us: 'wardrobe', beach: 'wardrobe', routines: 'workflows' };
SB.PARENT_VIEW = { shop: 'toolbox' };
SB.homeView = () => (SB.state.settings.crabOnly ? 'health' : 'chat');

SB.setView = view => {
  const s = SB.state;
  // Just-the-crab mode has no chat: Health is home. A popped-out window has nothing but.
  if (view === 'chat' && s.settings.crabOnly) view = 'health';
  if (SB.solo) view = 'chat';
  if (view !== 'onboarding') SB.views.onboarding?.leave?.(); // gives back what first run borrowed
  s.view = view;
  document.body.dataset.view = view;
  const section = SB.NAV_SECTION[view] || view;
  document.querySelectorAll('[data-view-btn]').forEach(b => {
    const on = b.dataset.viewBtn === section;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  SB.closeMenus();
  SB.views[view]?.render?.();
  if (view === 'chat') setTimeout(() => SB.$('input').focus(), 30);
};

// ------------------------------------------------------------------ popovers

// Where the keyboard goes back to when a menu it was in closes: whatever had it
// before the menu opened (the box, a chip), so Esc or a choice never strands it.
let menuReturn = null;

const MENU_MIN_HEIGHT = 120; // a menu squeezed by a tiny window still shows a few rows
SB.openMenu = (menu, anchor, build) => {
  const wasOpen = !menu.hidden;
  SB.closeMenus();
  if (wasOpen) return;
  const from = document.activeElement;
  menuReturn = from && from !== document.body && !from.closest('.popover') ? from : anchor;
  menu.replaceChildren(...build().filter(Boolean));
  menu.style.maxHeight = '';
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  // Below the button, or above it when there isn't room (a row near the bottom of the list).
  // Never past the window's edge: a menu taller than the room it has scrolls, so
  // its last items (the branch menu under a long clash list) stay reachable.
  const roomBelow = window.innerHeight - 8 - (r.bottom + 6);
  const roomAbove = r.top - 6 - 8;
  const below = menu.offsetHeight <= roomBelow || roomBelow >= roomAbove;
  const cssMax = parseFloat(getComputedStyle(menu).maxHeight) || Infinity; // 'none' is NaN
  menu.style.maxHeight = `${Math.max(MENU_MIN_HEIGHT, Math.min(cssMax, below ? roomBelow : roomAbove))}px`;
  menu.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - menu.offsetHeight)}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  anchor.setAttribute('aria-expanded', 'true');
  menuAnchor = anchor;
  menu.querySelector('button')?.focus();
};

// Every floating menu is a .popover, or the composer's .slash-menu (slash
// commands, @-picker): asking the page beats keeping a list of ids in step.
const OPEN_MENUS = '.popover:not([hidden]), .slash-menu:not([hidden])';
let menuAnchor = null; // the button that opened the current menu: its aria-expanded goes back to false

SB.anyMenuOpen = () => !!document.querySelector(OPEN_MENUS);

// refocus: send the keyboard back where it was before the menu opened (Esc, a
// pick from it), as it does anyway when focus was in the menu. A click
// elsewhere leaves focus where the click put it.
SB.closeMenus = ({ refocus = false } = {}) => {
  const held = !!document.activeElement?.closest(OPEN_MENUS);
  for (const menu of document.querySelectorAll('.popover')) menu.hidden = true;
  for (const id of ['modeChip', 'folderChip', 'branchChip', 'ctxChip', 'usage', 'effortChip', 'tabAllBtn', 'reviewBtn']) SB.$(id).setAttribute('aria-expanded', 'false');
  SB.hideSlash?.();
  SB.hidePick?.();
  menuAnchor?.setAttribute('aria-expanded', 'false');
  menuAnchor = null;
  if ((refocus || held) && menuReturn?.isConnected && menuReturn.getClientRects().length) menuReturn.focus({ preventScroll: true });
  menuReturn = null;
};

document.addEventListener('mousedown', e => {
  if (!e.target.closest('.popover, .mode-chip, .folder-chip, .ctx-chip, .usage, .tab-all, .tab-review, .slash-menu, .snip-more, .note-more, #input')) SB.closeMenus();
});

// Up/Down walk a menu's items (wrapping round), Home/End jump to either end.
// Every .popover with role=menu gets this; Esc is tabs.js's (SB.closeMenus). A
// menu with keys of its own handles them first and says so (defaultPrevented).
const MENU_ITEMS = 'button:not(:disabled), [role^="menuitem"]:not(:disabled)';
document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const menu = e.target.closest?.('.popover[role="menu"]');
  if (!menu) return;
  const items = [...menu.querySelectorAll(MENU_ITEMS)].filter(el => el.getClientRects().length > 0);
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement);
  const n = items.length;
  const next = { ArrowDown: i + 1, ArrowUp: i < 0 ? n - 1 : i - 1, Home: 0, End: n - 1 }[e.key];
  items[(next + n) % n].focus();
});

// One item for a popover menu: picking it closes the menu (focus goes back to the
// button that opened it), then runs onPick. Two shapes:
//   SB.menuItem(title, onPick)
//   SB.menuItem(title, sub, onPick, { glyph, disabled, mono, tone })
// glyph: a check column (pass '' for an empty one, so the titles line up).
SB.menuItem = (title, sub, onPick, opts = {}) => {
  if (typeof sub === 'function') return SB.menuItem(title, null, sub, onPick || {});
  const { glyph, disabled = false, mono = false, tone = '' } = opts;
  const h = SB.h;
  return h('button', {
    class: tone ? `menu-item ${tone}` : 'menu-item', type: 'button', role: 'menuitem', disabled: !!disabled,
    onclick: () => { SB.closeMenus({ refocus: true }); onPick(); },
  },
  glyph === undefined ? null : h('span', { class: 'mi-check', 'aria-hidden': 'true' }, glyph || ''),
  h('span', {}, h('div', { class: mono ? 'mi-title wf-mono' : 'mi-title', text: title }), sub ? h('div', { class: 'mi-sub', text: sub }) : null));
};

// ------------------------------------------------------------------ page never scrolls
// Only the views scroll. If anything ever scrolls the page itself (e.g. a
// scrollIntoView that runs out of room), snap it back so the title bar stays put.
for (const target of [window, document.body]) {
  target.addEventListener('scroll', () => {
    if (document.scrollingElement.scrollTop || document.body.scrollTop) {
      document.scrollingElement.scrollTop = 0;
      document.body.scrollTop = 0;
    }
  });
}

// ------------------------------------------------------------------ themed tooltips
// Any element with a `title` gets a styled tooltip instead of the unstyled OS
// one: the text moves to data-tip on first hover (so the native tip never
// shows) and is re-read each time, so code can keep setting `title` freely.
(function tooltips() {
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.id = 'sbTip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);
  let target = null;
  let timer = null;
  // The element the tip is showing for: it's described by the tip while it shows
  // (the title it came from is gone), and gets back what it had before.
  let described = null;
  let describedBefore = null;
  const undescribe = () => {
    if (!described) return;
    if (describedBefore == null) described.removeAttribute('aria-describedby');
    else described.setAttribute('aria-describedby', describedBefore);
    described = null;
  };
  const describe = el => {
    undescribe();
    described = el;
    describedBefore = el.getAttribute('aria-describedby');
    el.setAttribute('aria-describedby', describedBefore ? `${describedBefore} ${tip.id}` : tip.id);
  };

  const claim = el => {
    const t = el.getAttribute('title');
    if (t != null) {
      el.removeAttribute('title');
      if (t) el.dataset.tip = t; else delete el.dataset.tip;
      if (t && !el.hasAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', t);
    }
    return el.dataset.tip;
  };

  const place = el => {
    const r = el.getBoundingClientRect();
    tip.style.left = '0px';
    tip.style.top = '0px';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let top = r.bottom + 8;
    tip.classList.toggle('above', top + th > window.innerHeight - 6);
    if (tip.classList.contains('above')) top = r.top - th - 8;
    const left = Math.max(6, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 6));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(Math.max(6, top))}px`;
    tip.style.setProperty('--arrow-x', `${Math.round(r.left + r.width / 2 - left)}px`);
  };

  const show = el => {
    const text = claim(el);
    if (!text || !el.isConnected) return;
    tip.textContent = text;
    tip.hidden = false;
    place(el);
    if (el.getAttribute('aria-label') !== text) describe(el); // else it would be read out twice
  };
  const hide = () => { clearTimeout(timer); target = null; tip.hidden = true; undescribe(); };

  document.addEventListener('mouseover', e => {
    const el = e.target.closest?.('[title], [data-tip]');
    if (!el || el === target) return;
    claim(el);
    target = el;
    clearTimeout(timer);
    timer = setTimeout(() => { if (target === el) show(el); }, 450);
  });
  document.addEventListener('mouseout', e => { if (target && !target.contains(e.relatedTarget)) hide(); });
  document.addEventListener('focusin', e => {
    const el = e.target.closest?.('[title], [data-tip]');
    if (el && el.matches(':focus-visible')) { target = el; show(el); }
  });
  document.addEventListener('focusout', hide);
  for (const ev of ['mousedown', 'keydown']) document.addEventListener(ev, hide, true);
  // Programmatic scrolls happen all the time (tab strip, live feeds); only a
  // scroll while a tip is actually showing should dismiss it.
  for (const ev of ['scroll', 'wheel']) document.addEventListener(ev, () => { if (!tip.hidden) hide(); }, true);
  window.addEventListener('blur', hide);
})();
