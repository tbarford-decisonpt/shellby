// Shell stickers. Every project you ship (push, deploy, release, merge a pull
// request) earns Shellby a sticker for it, and he slaps it on his shell. Ship
// it again and the sticker gets better (paper, vinyl, holo, foil); leave it
// alone for months and it starts to peel. Each shell he's lived in keeps its
// own stickers, so retired shells read like a scrapbook.
//
// A project is a repository, not a folder: its id comes from the origin
// remote when there is one (the same on every PC, and after a move), else from
// where it lives. Pure: no I/O, no clock (callers pass `now`). The drawing is
// stickers/art.js; where they fit on a shell is stickers/slots.js.
//
// Friends' crabs can leave a sticker of theirs when they visit (a swap): it
// lives here too, marked with who it's `from`, and never peels.
// See test/stickers.test.js.
const crypto = require('crypto');
const art = require('./stickers/art');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const TIERS = Object.freeze([
  { id: 'paper', name: 'Paper', ships: 1 },
  { id: 'vinyl', name: 'Vinyl', ships: 5 },
  { id: 'holo', name: 'Holo', ships: 15 },
  { id: 'foil', name: 'Foil', ships: 40 },
].map(t => Object.freeze(t)));
const TIER_IDS = TIERS.map(t => t.id);

// How much each kind of shipping counts toward the next tier.
const WEIGHT = Object.freeze({ ship: 1, deploy: 2, release: 2, merge: 1 });
const KINDS = Object.freeze(Object.keys(WEIGHT));
const COUNT_GAP = HOUR;          // a flurry of pushes in one hour counts once
const PEEL_AFTER = 60 * DAY;     // a corner starts to lift
const FADE_AFTER = 180 * DAY;    // ...and then the colours go
const MAX_PROJECTS = 300;
const MAX_PLACED = 24;           // per shell
const CARRY = 3;                 // stickers he takes with him when he molts
const HOME = 'home';             // the shell he hatched with (shells.js)

const MARKS = Object.freeze([
  { id: 'live', name: 'Live', icon: '🚀', description: 'Deployed' },
  { id: 'release', name: 'Released', icon: '🏷️', description: 'Cut a release' },
  { id: 'v1', name: 'One-point-oh', icon: '🥇', description: 'Released version 1.0 or later' },
  { id: 'merged', name: 'Merged', icon: '🔀', description: 'A pull request merged on GitHub' },
  { id: 'green', name: 'Green Light', icon: '🟢', description: 'A pull request went from red to green, then merged' },
  { id: 'deps', name: 'Fresh', icon: '🧼', description: 'A dependency audit came back clean' },
  { id: 'moon', name: 'Moonlighter', icon: '🌙', description: 'Shipped between midnight and 5 AM', hidden: true },
  { id: 'friday', name: 'Friday Deploy', icon: '💀', description: 'Deployed on a Friday afternoon', hidden: true },
].map(m => Object.freeze({ hidden: false, ...m })));
const MARK_IDS = new Set(MARKS.map(m => m.id));

const CARD_MODES = ['art', 'names', 'off'];
const MAX_TRADE = 3;             // stickers a calling card offers for swaps
const MAX_GUESTS = 30;           // friends' stickers kept in all...
const MAX_GUESTS_EACH = 3;       // ...and from any one friend
const ID_RE = /^[0-9a-f]{12}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SHELL_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9a-z.]{1,20})?$/i;
const HEX = /^#[0-9a-f]{6}$/i;

const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');
const num = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const time = v => (Number.isFinite(v) && v > 0 ? v : null);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ------------------------------------------------------------------ identity

/**
 * A remote URL in one spelling: "github.com/owner/repo", lower case, no
 * credentials, port, scheme or ".git". Null for anything that isn't a hosted
 * repository (a local path, a file:// URL), which then falls back to the folder.
 */
function normalizeRemote(url) {
  if (typeof url !== 'string') return null;
  let u = url.trim();
  if (!u || u.length > 500) return null;
  // scp style: git@github.com:owner/repo.git
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(u);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else {
    const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+)$/i.exec(u);
    if (!m) return null;
    u = `${m[1]}/${m[2]}`;
  }
  // A query or fragment (a token pasted into a URL, say) is never part of the name.
  u = u.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
  const [host, ...rest] = u.split('/');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || !rest.length || rest.some(p => !/^[a-z0-9_.~-]+$/.test(p) || /^\.+$/.test(p))) return null;
  return [host, ...rest].join('/');
}

/** A project's id: from its normalized remote if it has one, else from its folder. */
function projectId(remote, root) {
  const key = remote ? `remote:${remote}` : `path:${String(root || '').toLowerCase()}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

// ------------------------------------------------------------------ state

function cleanCustom(c) {
  if (!c || typeof c !== 'object' || !c.palette || typeof c.palette !== 'object') return null;
  const entries = Object.entries(c.palette);
  if (entries.length > 64) return null; // 16 colours is the limit; a huge object isn't even looked at
  const palette = Object.create(null);
  for (const [k, v] of entries) {
    if (k.length === 1 && k !== '.' && typeof v === 'string' && HEX.test(v)) palette[k] = v;
  }
  const keys = Object.keys(palette);
  if (!keys.length || keys.length > 16) return null;
  const grid = (rows, max) => (Array.isArray(rows) && rows.length >= 1 && rows.length <= max
    && rows.every(r => typeof r === 'string' && r.length >= 1 && r.length <= max && [...r].every(ch => ch === '.' || hasOwn(palette, ch))) ? [...rows] : null);
  const pixels = grid(c.pixels, 16);
  if (!pixels) return null;
  const micro = c.micro == null ? null : grid(c.micro, 3);
  if (c.micro != null && (!micro || micro.length !== 3 || micro.some(r => r.length !== 3 || r.includes('.')))) return null;
  return { palette: { ...palette }, pixels, micro };
}

function cleanProject(id, p) {
  if (!ID_RE.test(id) || !p || typeof p !== 'object') return null;
  const firstShipAt = time(p.firstShipAt);
  if (!firstShipAt) return null;
  return {
    id,
    name: clip(p.name, 60) || 'project',
    remote: typeof p.remote === 'string' ? normalizeRemote(p.remote) : null,
    root: typeof p.root === 'string' && p.root.length <= 400 ? p.root : null,
    lang: clip(p.lang, 20) || null,
    firstShipAt,
    lastShipAt: Math.max(firstShipAt, time(p.lastShipAt) || firstShipAt),
    lastCountedAt: time(p.lastCountedAt),
    ships: Math.max(1, num(p.ships)),
    deploys: num(p.deploys), releases: num(p.releases), merges: num(p.merges),
    lastVersion: typeof p.lastVersion === 'string' && VERSION_RE.test(p.lastVersion) ? p.lastVersion : null,
    marks: [...new Set((Array.isArray(p.marks) ? p.marks : []).filter(m => MARK_IDS.has(m)))],
    custom: cleanCustom(p.custom),
    hidden: !!p.hidden,
    hiddenAt: time(p.hiddenAt) || 0, // when it was last hidden or shown, so sync keeps the newest
    from: typeof p.from === 'string' && LOGIN_RE.test(p.from) ? p.from : null,
  };
}

function cleanLayout(list, ids) {
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e !== 'object' || !ids.has(e.id) || seen.has(e.id)) continue;
    if (!Number.isInteger(e.slot) || e.slot < 0 || e.slot > 63) continue;
    seen.add(e.id);
    const nudge = Array.isArray(e.nudge) && e.nudge.length === 2 && e.nudge.every(v => Number.isInteger(v) && v >= -1 && v <= 1) ? [...e.nudge] : [0, 0];
    out.push({ id: e.id, slot: e.slot, z: Number.isFinite(e.z) ? e.z : out.length, flip: !!e.flip, nudge });
  }
  return renumber(out).slice(-MAX_PLACED);
}

// z kept as 1..n in stacking order, so it can't drift.
const renumber = list => [...list].sort((a, b) => a.z - b.z).map((e, i) => ({ ...e, z: i + 1 }));

/** Tolerate anything read from disk (or a sync gist). */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const projects = {};
  // Bounded before anything is cleaned: a hostile gist can't make this slow.
  for (const [id, p] of Object.entries(r.projects && typeof r.projects === 'object' ? r.projects : {}).slice(0, MAX_PROJECTS * 3)) {
    const c = cleanProject(id, p);
    if (c) projects[id] = c;
  }
  const ids = new Set(Object.keys(projects));
  const layouts = {};
  for (const [shell, list] of Object.entries(r.layouts && typeof r.layouts === 'object' ? r.layouts : {})) {
    if (!SHELL_RE.test(shell)) continue;
    const l = cleanLayout(list, ids);
    if (l.length) layouts[shell] = l;
  }
  return {
    projects, layouts,
    layoutsAt: time(r.layoutsAt) || 0,
    auto: r.auto === undefined ? true : !!r.auto,
    // Nothing on the public calling card until you choose (it promised no projects before stickers).
    card: CARD_MODES.includes(r.card) ? r.card : 'off',
    unseen: [...new Set((Array.isArray(r.unseen) ? r.unseen : []).filter(id => ids.has(id)))],
  };
}

// ------------------------------------------------------------------ tiers and age

/** The tier a ship count has reached. */
function tierFor(ships) {
  let t = TIERS[0];
  for (const x of TIERS) if (ships >= x.ships) t = x;
  return t;
}

/** The next tier, and how many more ships it takes; null at the top. */
function nextTier(ships) {
  const t = TIERS.find(x => x.ships > ships);
  return t ? { ...t, left: t.ships - ships } : null;
}

/** 'fresh' | 'peeling' | 'faded': how long since it last shipped. */
function weathering(p, now) {
  if (p?.from) return 'fresh'; // a friend's sticker is a keepsake, not a nudge
  const age = now - (p?.lastShipAt || now);
  if (age >= FADE_AFTER) return 'faded';
  if (age >= PEEL_AFTER) return 'peeling';
  return 'fresh';
}

/** Whole years since the first ship (for the anniversary ribbon). */
function yearsOf(p, now) {
  const a = new Date(p.firstShipAt), b = new Date(now);
  let y = b.getFullYear() - a.getFullYear();
  if (b.getMonth() < a.getMonth() || (b.getMonth() === a.getMonth() && b.getDate() < a.getDate())) y--;
  return Math.max(0, y);
}

// ------------------------------------------------------------------ releases

/**
 * The release a command makes, or null: { version } (version may be null when
 * the command doesn't say, like `npm publish` or `git push --tags`).
 */
function releaseOf(command) {
  if (typeof command !== 'string') return null;
  const c = command.slice(0, 2000);
  if (/--dry-run|--draft/i.test(c)) return null;
  const version = (re) => { const m = re.exec(c); return m && VERSION_RE.test(m[1]) ? m[1] : null; };
  const gh = /\bgh\s+release\s+create\s+v?([0-9][\w.-]*)/i;
  if (/\bgh\s+release\s+create\b/i.test(c)) return { version: version(gh) };
  if (/\b(npm|pnpm|yarn\s+npm|cargo)\s+publish\b|\btwine\s+upload\b/i.test(c)) return { version: null };
  // Pushing a version tag: git push origin v1.2.3 / git push --tags
  const tag = /\bgit\s+push\b[^\n;&|]*?\s(?:refs\/tags\/)?v([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9a-z.]+)?)\b/i;
  if (tag.test(c)) return { version: version(tag) };
  if (/\bgit\s+push\b[^\n;&|]*\s--(follow-)?tags\b/i.test(c)) return { version: null };
  return null;
}

const isOnePointOh = v => typeof v === 'string' && VERSION_RE.test(v) && Number(v.split('.')[0]) >= 1 && !v.includes('-');

/**
 * What a successful command ships, from its meaning (xp.js classifyCommand)
 * and its text: { kind, meta } or null. A release reads its version; a draft
 * release isn't out yet, so it ships nothing.
 */
function shipOf(kind, command) {
  if (kind !== 'ship' && kind !== 'deploy') return null;
  if (typeof command === 'string' && /\bgh\s+release\s+create\b/i.test(command) && /--draft\b/i.test(command)) return null;
  const release = releaseOf(command);
  return release ? { kind: 'release', meta: { version: release.version } } : { kind, meta: {} };
}

// ------------------------------------------------------------------ shipping

/**
 * Something shipped. project: { id, name, remote?, root?, lang?, custom? };
 * kind: 'ship' | 'deploy' | 'release' | 'merge'; meta: { version?, fixed? }.
 * place: { shell, slots } to put a brand-new sticker on that shell (when auto is on).
 * Returns { state, project, minted, tierUp, newMarks, counted }.
 */
function recordShip(stateIn, project, kind, now, meta = {}, place = null) {
  const s = normalize(stateIn);
  if (!project || !ID_RE.test(project.id) || !KINDS.includes(kind)) return { state: s, project: null, minted: false, tierUp: null, newMarks: [], counted: false };
  const before = s.projects[project.id] || null;
  const p = before ? { ...before, marks: [...before.marks] } : {
    id: project.id, name: 'project', remote: null, root: null, lang: null,
    firstShipAt: now, lastShipAt: now, lastCountedAt: null,
    ships: 0, deploys: 0, releases: 0, merges: 0, lastVersion: null, marks: [], custom: null, hidden: false, hiddenAt: 0, from: null,
  };
  if (project.name) p.name = clip(project.name, 60) || p.name;
  if (project.remote !== undefined) p.remote = normalizeRemote(project.remote) || p.remote;
  if (typeof project.root === 'string') p.root = project.root;
  if (project.lang !== undefined) p.lang = clip(project.lang, 20) || p.lang;
  if (project.custom !== undefined) p.custom = cleanCustom(project.custom);

  // A flurry of pushes counts once an hour; a new release or a merged pull
  // request is its own event and always counts.
  const freshRelease = kind === 'release' && typeof meta.version === 'string' && VERSION_RE.test(meta.version) && meta.version !== p.lastVersion;
  const counted = !p.lastCountedAt || now - p.lastCountedAt >= COUNT_GAP || freshRelease || kind === 'merge';
  if (counted) { p.ships += WEIGHT[kind]; p.lastCountedAt = now; }
  p.lastShipAt = Math.max(p.lastShipAt, now);
  const when = new Date(now);
  const mark = id => { if (!p.marks.includes(id)) p.marks.push(id); };
  if (kind === 'deploy') {
    p.deploys += 1;
    mark('live');
    if (when.getDay() === 5 && when.getHours() >= 15) mark('friday');
  }
  if (kind === 'release') {
    p.releases += 1;
    mark('release');
    if (typeof meta.version === 'string' && VERSION_RE.test(meta.version)) p.lastVersion = meta.version;
    if (isOnePointOh(meta.version)) mark('v1');
  }
  if (kind === 'merge') {
    p.merges += 1;
    mark('merged');
    if (meta.fixed) mark('green');
  }
  if (when.getHours() < 5) mark('moon');

  const projects = { ...s.projects, [p.id]: p };
  let next = { ...s, projects };
  const minted = !before;
  if (minted) {
    next.unseen = [...s.unseen.filter(id => id !== p.id), p.id];
    if (s.auto && place && place.slots > 0) next = placeAuto(next, place.shell || HOME, p.id, place.slots, now);
  }
  next = prune(next);
  const tierUp = !minted && tierFor(p.ships).id !== tierFor(before.ships).id ? tierFor(p.ships) : null;
  const newMarks = p.marks.filter(m => !(before?.marks || []).includes(m));
  return { state: next, project: p, minted, tierUp, newMarks, counted };
}

/**
 * A mark earned without shipping (a clean dependency audit earns 🧼 Fresh).
 * Only a sticker you already have can wear it, and it never counts as a ship.
 * Returns { state, project, added }.
 */
function addMark(stateIn, id, markId) {
  const s = normalize(stateIn);
  const p = s.projects[id];
  if (!p || p.from || !MARK_IDS.has(markId) || p.marks.includes(markId)) return { state: s, project: p || null, added: false };
  const next = { ...p, marks: [...p.marks, markId] };
  return { state: { ...s, projects: { ...s.projects, [id]: next } }, project: next, added: true };
}

// Over the cap: forget friends' gifts, then the least-shipped projects, never one on a shell.
function prune(s) {
  const ids = Object.keys(s.projects);
  if (ids.length <= MAX_PROJECTS) return s;
  const placed = new Set(Object.values(s.layouts).flat().map(e => e.id));
  // Friends' gifts go before anything you shipped yourself, then the least shipped.
  const drop = ids.filter(id => !placed.has(id))
    .sort((a, b) => (!!s.projects[b].from - !!s.projects[a].from) || (s.projects[a].ships - s.projects[b].ships) || (s.projects[a].lastShipAt - s.projects[b].lastShipAt))
    .slice(0, ids.length - MAX_PROJECTS);
  const projects = { ...s.projects };
  for (const id of drop) delete projects[id];
  return { ...s, projects, unseen: s.unseen.filter(id => projects[id]) };
}

/**
 * A project that was known by its folder now has a remote: it moves to its
 * remote id, keeping its counts, marks and spots on every shell. If the
 * remote id is already there too, the two are combined.
 */
function rekey(stateIn, fromId, toId) {
  const s = normalize(stateIn);
  const a = s.projects[fromId];
  if (!a || fromId === toId || !ID_RE.test(toId)) return s;
  const b = s.projects[toId];
  const p = b ? {
    ...b,
    firstShipAt: Math.min(a.firstShipAt, b.firstShipAt), lastShipAt: Math.max(a.lastShipAt, b.lastShipAt),
    ships: Math.max(a.ships, b.ships), deploys: Math.max(a.deploys, b.deploys), releases: Math.max(a.releases, b.releases), merges: Math.max(a.merges, b.merges),
    marks: [...new Set([...a.marks, ...b.marks])], root: b.root || a.root, hidden: a.hidden || b.hidden,
  } : { ...a, id: toId };
  const projects = { ...s.projects, [toId]: p };
  delete projects[fromId];
  const layouts = {};
  for (const [shell, list] of Object.entries(s.layouts)) {
    const moved = list.map(e => (e.id === fromId ? { ...e, id: toId } : e));
    layouts[shell] = moved.filter((e, i) => moved.findIndex(x => x.id === e.id) === i); // both were on it: keep one
  }
  const unseen = [...new Set(s.unseen.map(id => (id === fromId ? toId : id)))];
  return normalize({ ...s, projects, layouts, unseen });
}

// ------------------------------------------------------------------ the shell

const layoutOf = (s, shell) => s.layouts[shell] || [];
const withLayout = (s, shell, list, now) => {
  const clean = renumber(list).slice(-MAX_PLACED);
  // Nothing moved: keep the stamp, or sync would let this PC's layouts win for no reason.
  if (JSON.stringify(clean) === JSON.stringify(layoutOf(s, shell))) return s;
  const layouts = { ...s.layouts };
  if (clean.length) layouts[shell] = clean; else delete layouts[shell];
  return { ...s, layouts, layoutsAt: now ?? s.layoutsAt };
};

// Where a sticker goes when it's put on a spot that may be taken: on top, and
// shifted a pixel so the edge of the one underneath still shows.
const NUDGES = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
function nudgeFor(list, slot) {
  const under = list.filter(e => e.slot === slot).length;
  return under ? NUDGES[(under - 1) % NUDGES.length] : [0, 0];
}

/** A new sticker goes on the first empty spot, or on top of the oldest once they're all taken. */
function placeAuto(stateIn, shell, id, slots, now) {
  const s = normalize(stateIn);
  const list = layoutOf(s, shell);
  if (!s.projects[id] || list.some(e => e.id === id) || !(slots > 0)) return s;
  const used = new Set(list.map(e => e.slot));
  let slot = [...Array(slots).keys()].find(i => !used.has(i));
  if (slot === undefined) slot = list.length % slots;
  const z = list.reduce((m, e) => Math.max(m, e.z), 0) + 1;
  return withLayout(s, shell, [...list, { id, slot, z, flip: false, nudge: nudgeFor(list, slot) }], now);
}

/** Put a sticker on a spot (moving it if it was elsewhere on this shell). */
function place(stateIn, shell, id, slot, now) {
  const s = normalize(stateIn);
  if (!s.projects[id] || !SHELL_RE.test(shell) || !Number.isInteger(slot) || slot < 0 || slot > 63) return s;
  const prev = layoutOf(s, shell).find(e => e.id === id);
  const rest = layoutOf(s, shell).filter(e => e.id !== id);
  const z = rest.reduce((m, e) => Math.max(m, e.z), 0) + 1;
  return withLayout(s, shell, [...rest, { id, slot, z, flip: prev?.flip || false, nudge: nudgeFor(rest, slot) }], now);
}

/** Peel a sticker off a shell (it stays in the Sticker Book). */
function remove(stateIn, shell, id, now) {
  const s = normalize(stateIn);
  return withLayout(s, shell, layoutOf(s, shell).filter(e => e.id !== id), now);
}

/** Bring a sticker to the top of the pile ('up') or slip it under the others ('down'). */
function restack(stateIn, shell, id, dir, now) {
  const s = normalize(stateIn);
  const list = layoutOf(s, shell);
  if (!list.some(e => e.id === id)) return s;
  const zs = list.map(e => e.z);
  const z = dir === 'down' ? Math.min(...zs) - 1 : Math.max(...zs) + 1;
  return withLayout(s, shell, list.map(e => (e.id === id ? { ...e, z } : e)), now);
}

/** Mirror a sticker left to right. */
function flip(stateIn, shell, id, now) {
  const s = normalize(stateIn);
  return withLayout(s, shell, layoutOf(s, shell).map(e => (e.id === id ? { ...e, flip: !e.flip } : e)), now);
}

const byShips = s => (a, b) => (s.projects[b].ships - s.projects[a].ships) || (s.projects[b].lastShipAt - s.projects[a].lastShipAt);

/**
 * Tidy a shell: the stickers already on it (or, on a bare shell, the most
 * shipped projects) laid out again, most shipped in the middle.
 */
function arrange(stateIn, shell, slots, now) {
  const s = normalize(stateIn);
  if (!(slots > 0)) return s;
  const onIt = layoutOf(s, shell).map(e => e.id);
  const ids = (onIt.length ? onIt : Object.keys(s.projects).filter(id => !s.projects[id].hidden)).sort(byShips(s)).slice(0, MAX_PLACED);
  const flips = new Map(layoutOf(s, shell).map(e => [e.id, e.flip]));
  // Least shipped first, so the most shipped end up on top of any pile.
  let list = [];
  [...ids].reverse().forEach((id, i, all) => {
    const slot = (all.length - 1 - i) % slots;
    list = [...list, { id, slot, z: i + 1, flip: flips.get(id) || false, nudge: nudgeFor(list, slot) }];
  });
  return withLayout(s, shell, list, now);
}

/**
 * He outgrew a shell and moved into another. The old one keeps its stickers
 * (it goes on the shelf); his CARRY most-shipped come with him, unless the new
 * shell already has stickers of its own from before.
 */
function carryOnMolt(stateIn, from, to, slots, now) {
  const s = normalize(stateIn);
  if (from === to || layoutOf(s, to).length || !(slots > 0)) return s;
  const ids = layoutOf(s, from).map(e => e.id).sort(byShips(s)).slice(0, Math.min(CARRY, slots));
  return withLayout(s, to, ids.map((id, i) => ({ id, slot: i, z: ids.length - i, flip: false, nudge: [0, 0] })), now);
}

/** Hide a project from the calling card (and from "fill my shell"). */
function setHidden(stateIn, id, hidden, now) {
  const s = normalize(stateIn);
  if (!s.projects[id]) return s;
  return { ...s, projects: { ...s.projects, [id]: { ...s.projects[id], hidden: !!hidden, hiddenAt: now || s.projects[id].hiddenAt } } };
}

function markSeen(stateIn, ids) {
  const s = normalize(stateIn);
  const gone = new Set(Array.isArray(ids) ? ids : []);
  return { ...s, unseen: s.unseen.filter(id => !gone.has(id)) };
}

function setOptions(stateIn, { auto, card } = {}) {
  const s = normalize(stateIn);
  return {
    ...s,
    auto: auto === undefined ? s.auto : !!auto,
    card: CARD_MODES.includes(card) ? card : s.card,
  };
}

// ------------------------------------------------------------------ views

/** One project as the Sticker Book shows it. */
function projectView(s, p, now) {
  const tier = tierFor(p.ships);
  const shellsWith = Object.entries(s.layouts).filter(([, l]) => l.some(e => e.id === p.id)).map(([k]) => k);
  return {
    id: p.id, name: p.name, remote: p.remote, lang: p.lang, hidden: p.hidden,
    firstShipAt: p.firstShipAt, lastShipAt: p.lastShipAt,
    ships: p.ships, deploys: p.deploys, releases: p.releases, merges: p.merges, lastVersion: p.lastVersion,
    tier: tier.id, tierName: tier.name, next: nextTier(p.ships),
    weather: weathering(p, now), years: yearsOf(p, now),
    marks: MARKS.filter(m => p.marks.includes(m.id)).map(m => ({ id: m.id, name: m.name, icon: m.icon, description: m.description })),
    shells: shellsWith, isNew: s.unseen.includes(p.id), canOpen: !!p.root && !p.from, custom: !!p.custom, from: p.from,
  };
}

/** Everything the Sticker Book needs except the art and the shell (main adds those). */
function view(stateIn, now) {
  const s = normalize(stateIn);
  const projects = Object.values(s.projects).sort((a, b) => b.lastShipAt - a.lastShipAt).map(p => projectView(s, p, now));
  return {
    projects,
    totals: {
      projects: projects.length,
      ships: projects.reduce((n, p) => n + p.ships, 0),
      byTier: Object.fromEntries(TIER_IDS.map(t => [t, projects.filter(p => p.tier === t).length])),
    },
    layouts: s.layouts,
    auto: s.auto, card: s.card, unseen: s.unseen,
    marks: MARKS.map(m => ({ ...m })),
    tiers: TIERS.map(t => ({ ...t })),
  };
}

/** Numbers for the achievements (wardrobe/achievements.js). */
function stats(stateIn) {
  const s = normalize(stateIn);
  const all = Object.values(s.projects);
  const ps = all.filter(p => !p.from); // your own shipping, not friends' gifts
  return {
    stickers: ps.length,
    holo: ps.filter(p => TIER_IDS.indexOf(tierFor(p.ships).id) >= TIER_IDS.indexOf('holo')).length,
    onePointOh: ps.filter(p => p.marks.includes('v1')).length,
    shells: Object.values(s.layouts).filter(l => l.length).length,
    guests: all.length - ps.length,
  };
}

// ------------------------------------------------------------------ calling cards and swaps

/**
 * What your public calling card says about your stickers (github/card.js).
 * 'art': only what's on the shell he's wearing, as 3x3 colour patches (no
 * names, no letters). 'names': that, plus up to three of your best as full
 * stickers with their names, which a visit can leave behind as a swap.
 * 'off', or a project you hid: nothing.
 */
function forCard(stateIn, shell, now) {
  const s = normalize(stateIn);
  if (s.card === 'off') return null;
  const onShell = (s.layouts[shell] || []).filter(e => !s.projects[e.id].hidden).map(e => {
    const p = s.projects[e.id];
    const tier = tierFor(p.ships).id;
    const m = art.onShell(art.draw(p), { tier, weather: weathering(p, now), flip: e.flip });
    return { slot: e.slot, nudge: e.nudge, tier, palette: m.palette, pixels: m.pixels };
  });
  const out = { shell: onShell, trade: [] };
  if (s.card === 'names') {
    out.trade = Object.values(s.projects).filter(p => !p.hidden && !p.from).sort((a, b) => b.ships - a.ships || b.lastShipAt - a.lastShipAt)
      .slice(0, MAX_TRADE).map(p => {
        const d = art.draw(p);
        return { name: p.name, tier: tierFor(p.ships).id, palette: d.full.palette, pixels: d.full.pixels };
      });
  }
  return out;
}

/** A friend's card's stickers, cleaned (it's somebody else's file). */
function cleanCardStickers(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tier = t => (TIER_IDS.includes(t) ? t : 'paper');
  const shell = (Array.isArray(raw.shell) ? raw.shell : []).slice(0, MAX_PLACED).map(e => {
    if (!e || !Number.isInteger(e.slot) || e.slot < 0 || e.slot > 63) return null;
    const c = cleanCustom({ palette: e.palette, pixels: e.pixels });
    if (!c || c.pixels.length !== 3 || c.pixels.some(r => r.length !== 3)) return null;
    const nudge = Array.isArray(e.nudge) && e.nudge.length === 2 && e.nudge.every(v => Number.isInteger(v) && v >= -1 && v <= 1) ? [...e.nudge] : [0, 0];
    return { slot: e.slot, nudge, tier: tier(e.tier), palette: c.palette, pixels: c.pixels };
  }).filter(Boolean);
  const trade = (Array.isArray(raw.trade) ? raw.trade : []).slice(0, MAX_TRADE).map(t => {
    const name = clip(t?.name, 60);
    const c = t && cleanCustom({ palette: t.palette, pixels: t.pixels });
    return name && c ? { name, tier: tier(t.tier), palette: c.palette, pixels: c.pixels } : null;
  }).filter(Boolean);
  return { shell, trade };
}

/** Which of a friend's stickers a visit leaves: the same one all day. */
function pickTrade(trade, login, at) {
  if (!Array.isArray(trade) || !trade.length) return null;
  const day = new Date(at).toISOString().slice(0, 10);
  const h = crypto.createHash('sha256').update(`${String(login).toLowerCase()}|${day}`).digest();
  return trade[h.readUInt32BE(0) % trade.length];
}

/**
 * A friend's crab left one of their stickers. It goes in the book (not on
 * the shell; that's yours to decide), marked with who it's from, at the tier
 * it had on their shell. Returns { state, project, fresh }.
 */
function receiveGuest(stateIn, from, gift, now) {
  const s = normalize(stateIn);
  const custom = gift && cleanCustom({ palette: gift.palette, pixels: gift.pixels });
  const name = clip(gift?.name, 60);
  if (!LOGIN_RE.test(String(from)) || !custom || !name) return { state: s, project: null, fresh: false };
  const id = projectId(null, `guest:${from.toLowerCase()}:${name.toLowerCase()}`);
  const ships = (TIERS.find(t => t.id === gift.tier) || TIERS[0]).ships;
  const before = s.projects[id];
  const p = {
    ...(before || { id, firstShipAt: now, lastCountedAt: null, deploys: 0, releases: 0, merges: 0, lastVersion: null, marks: [], hidden: false, hiddenAt: 0, root: null, remote: null, lang: null }),
    name, from, custom, lastShipAt: now, ships: Math.max(before?.ships || 0, ships),
  };
  const projects = { ...s.projects, [id]: p };
  // A few per friend and a few dozen in all: the oldest gift not on a shell makes room.
  const placed = new Set(Object.values(s.layouts).flat().map(e => e.id));
  const guests = list => list.filter(x => x.from && x.id !== id && !placed.has(x.id)).sort((x, y) => x.firstShipAt - y.firstShipAt);
  const fromThem = guests(Object.values(projects).filter(x => x.from?.toLowerCase() === from.toLowerCase()));
  for (const x of fromThem.slice(0, Math.max(0, fromThem.length + 1 - MAX_GUESTS_EACH))) delete projects[x.id];
  const all = guests(Object.values(projects));
  for (const x of all.slice(0, Math.max(0, all.length + 1 - MAX_GUESTS))) delete projects[x.id];
  const next = { ...s, projects, unseen: (before ? s.unseen : [...s.unseen, id]).filter(x => projects[x]) };
  return { state: prune(next), project: p, fresh: !before };
}

// ------------------------------------------------------------------ sync

/**
 * What goes in the private sync gist: no local paths, options or "new" badges.
 * Keys in a fixed order, so the same stickers always read as the same.
 */
function syncable(stateIn) {
  const s = normalize(stateIn);
  const projects = {};
  for (const id of Object.keys(s.projects).sort()) projects[id] = { ...s.projects[id], root: null };
  const layouts = {};
  for (const k of Object.keys(s.layouts).sort()) layouts[k] = s.layouts[k];
  return { projects, layouts, layoutsAt: s.layoutsAt };
}

/**
 * Combine this PC's stickers with another's: counts and marks only ever grow,
 * the earliest first ship wins, and the shell layouts follow whichever PC
 * changed them last. Local-only bits (folders, options, badges) stay as they are.
 */
function merge(localIn, remoteIn) {
  const a = normalize(localIn), b = normalize(remoteIn);
  const projects = { ...a.projects };
  for (const [id, q] of Object.entries(b.projects)) {
    const p = projects[id];
    if (!p) { projects[id] = { ...q, root: null }; continue; }
    const newer = q.lastShipAt > p.lastShipAt ? q : p;
    projects[id] = {
      ...p,
      name: newer.name, remote: p.remote || q.remote, lang: p.lang || q.lang, custom: p.custom || q.custom,
      firstShipAt: Math.min(p.firstShipAt, q.firstShipAt),
      lastShipAt: Math.max(p.lastShipAt, q.lastShipAt),
      lastCountedAt: Math.max(p.lastCountedAt || 0, q.lastCountedAt || 0) || null,
      ships: Math.max(p.ships, q.ships), deploys: Math.max(p.deploys, q.deploys),
      releases: Math.max(p.releases, q.releases), merges: Math.max(p.merges, q.merges),
      lastVersion: newer.lastVersion || p.lastVersion || q.lastVersion,
      marks: [...new Set([...p.marks, ...q.marks])],
      // Hidden on one PC is hidden on all of them; the latest change wins.
      ...(q.hiddenAt > p.hiddenAt ? { hidden: q.hidden, hiddenAt: q.hiddenAt } : {}),
    };
  }
  const newerLayouts = b.layoutsAt > a.layoutsAt ? b : a;
  return prune(normalize({ ...a, projects, layouts: newerLayouts.layouts, layoutsAt: newerLayouts.layoutsAt }));
}

module.exports = {
  TIERS, MARKS, WEIGHT, KINDS, COUNT_GAP, PEEL_AFTER, FADE_AFTER, MAX_PROJECTS, MAX_PLACED, CARRY, HOME, CARD_MODES,
  normalizeRemote, projectId, normalize, cleanCustom, rekey,
  tierFor, nextTier, weathering, yearsOf, releaseOf, isOnePointOh, shipOf,
  recordShip, addMark, placeAuto, place, remove, restack, flip, arrange, carryOnMolt, setHidden, markSeen, setOptions,
  view, projectView, stats, syncable, merge, forCard, cleanCardStickers, pickTrade, receiveGuest, MAX_TRADE, MAX_GUESTS, MAX_GUESTS_EACH,
};
