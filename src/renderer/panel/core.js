/* Shellby panel — shared state and helpers. Loaded first; everything hangs off `SB`. */
'use strict';

const SB = window.SB = {
  api: window.shellby,
  md: window.ShellbyMarkdown,
  Sprite: window.ShellbySprite,
  state: {
    settings: {}, status: {}, skins: [], skin: null, sessions: [], cwd: '', home: '',
    view: 'chat', version: '', packaged: false,
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
  t.replaceChildren(SB.h('span', { text: msg }), action ? SB.h('button', { class: 'toast-action', type: 'button', onclick: () => { t.hidden = true; onAction(); } }, action) : null);
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
};

SB.sprite = (skin = SB.state.skin, opts = {}) => (skin ? SB.Sprite.build(skin, opts) : document.createElement('span'));

// Helper-crab colours, shared with the desktop critter.
SB.HUES = [0, 145, 250, 60, 300, 200];
SB.helperSprite = index => {
  const svg = SB.sprite();
  svg.style.filter = `hue-rotate(${SB.HUES[index % SB.HUES.length]}deg) saturate(1.1)`;
  return svg;
};

SB.renderMarkdownInto = (el, text) => {
  el.innerHTML = SB.md.render(text); // md escapes all input first; see shared/markdown.js
  return el;
};

// ------------------------------------------------------------------ views

SB.views = {};  // name -> { render?() }

SB.setView = view => {
  const s = SB.state;
  s.view = view;
  document.body.dataset.view = view;
  document.querySelectorAll('[data-view-btn]').forEach(b => b.classList.toggle('active', b.dataset.viewBtn === view));
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
  for (const id of ['modeMenu', 'folderMenu']) SB.$(id).hidden = true;
  for (const id of ['modeChip', 'folderChip']) SB.$(id).setAttribute('aria-expanded', 'false');
  SB.hideSlash?.();
};

document.addEventListener('mousedown', e => {
  if (!e.target.closest('.popover, .mode-chip, .folder-chip, .slash-menu, #input')) SB.closeMenus();
});
