/* Shellby panel — shared state and helpers. Loaded first; everything hangs off `SB`. */
'use strict';

const SB = window.SB = {
  api: window.shellby,
  md: window.ShellbyMarkdown,
  Sprite: window.ShellbySprite,
  MiniShell: window.ShellbyMiniShell,
  state: {
    settings: {}, status: {}, skins: [], skin: null, sessions: [], cwd: '', home: '',
    view: 'chat', version: '', packaged: false, updates: null,
    toolbox: null, pinned: [], learned: [], routines: [],
    tabs: new Map(),      // tabId -> Tab (see feed.js)
    activeTab: null,
  },
};

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

SB.tildify = p => {
  const home = SB.state.home;
  if (!p) return '~';
  return home && p.toLowerCase().startsWith(home.toLowerCase()) ? '~' + p.slice(home.length) : p;
};

// Keep the end of long paths visible: C:\…\projects\shellby
SB.shortPath = (p, max = 34) => {
  const t = SB.tildify(p);
  if (t.length <= max) return t;
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

SB.compact = n => (n == null ? '' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

SB.prettyAccel = a => String(a || '').replace(/Control/g, 'Ctrl').replace(/\+/g, ' + ');

let toastTimer;
SB.toast = (msg, { action, onAction, ms = 2800 } = {}) => {
  const t = SB.$('toast');
  // (replaceChildren would print a literal "null" for a missing button, so filter it out)
  t.replaceChildren(...[SB.h('span', { text: msg }), action ? SB.h('button', { class: 'toast-action', type: 'button', onclick: () => { t.hidden = true; onAction(); } }, action) : null].filter(Boolean));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? ms + 2500 : ms);
};

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
};

// Shellby as he's dressed right now (fit: the view box frames the whole outfit).
// Pass { plain: true } for an undressed crab, e.g. skin swatches.
SB.sprite = (skin = SB.state.skin, opts = {}) => {
  if (!skin) return document.createElement('span');
  const accessories = opts.plain ? [] : opts.accessories ?? SB.state.outfit?.accessories ?? [];
  const shell = opts.plain ? null : opts.shell ?? SB.state.outfit?.home ?? null; // the shell he lives in (shells.js)
  return SB.Sprite.build(skin, { fit: accessories.length > 0, ...opts, accessories, shell });
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

// Which navigation item a screen lives under (Trophies is a tab of the Shellby screen),
// and which screens sit one level down, so Back/Esc go up to their parent.
SB.NAV_SECTION = { shop: 'toolbox', trophies: 'wardrobe' };
SB.PARENT_VIEW = { shop: 'toolbox' };
SB.homeView = () => (SB.state.settings.crabOnly ? 'health' : 'chat');

SB.setView = view => {
  const s = SB.state;
  // Just-the-crab mode has no chat: Health is home.
  if (view === 'chat' && s.settings.crabOnly) view = 'health';
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

SB.openMenu = (menu, anchor, build) => {
  const wasOpen = !menu.hidden;
  SB.closeMenus();
  if (wasOpen) return;
  menu.replaceChildren(...build().filter(Boolean));
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  anchor.setAttribute('aria-expanded', 'true');
  menu.querySelector('button')?.focus();
};

SB.closeMenus = () => {
  for (const id of ['modeMenu', 'folderMenu', 'branchMenu', 'ctxMenu', 'usageMenu']) SB.$(id).hidden = true;
  for (const id of ['modeChip', 'folderChip', 'branchChip', 'ctxChip', 'usage']) SB.$(id).setAttribute('aria-expanded', 'false');
  SB.hideSlash?.();
};

document.addEventListener('mousedown', e => {
  if (!e.target.closest('.popover, .mode-chip, .folder-chip, .ctx-chip, .usage, .slash-menu, #input')) SB.closeMenus();
});

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
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);
  let target = null;
  let timer = null;

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
  };
  const hide = () => { clearTimeout(timer); target = null; tip.hidden = true; };

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
