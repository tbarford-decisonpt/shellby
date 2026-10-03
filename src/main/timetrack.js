// Time on each project, for timesheets and invoices. Built from what Shellby
// already sees: the window in front (an editor, a terminal, a repo's page in a
// browser), Claude working in a project, and git moving in it. All of it stays
// on this PC.
//
// A window's title is read to tell which project it shows and is then dropped:
// only "this project, this many seconds, this day" is ever kept. Pure: no I/O,
// no clock (callers pass `now`). See test/timetrack.test.js.

const MIN_MS = 60 * 1000;
const KEEP_DAYS = 400;          // a bit over a year: last year's invoices are still there
const MAX_PROJECTS = 200;
const MAX_A_DAY = 40;           // projects with time on any one day
const MAX_CREDIT_S = 60;        // one tick never credits more (a sleep or a stall isn't work)
const MAX_DAY_S = 24 * 60 * 60;
const NOTE_MAX = 200;
const RATE_MAX = 100000;

const IDLE_CHOICES = Object.freeze([2, 3, 5, 10, 15, 30]);  // minutes away before the clock stops
const ROUND_CHOICES = Object.freeze([0, 6, 10, 15, 30, 60]); // each day's entry, in minutes
const ROUND_MODES = Object.freeze(['nearest', 'up']);
const DEFAULTS = Object.freeze({ enabled: false, idleMinutes: 5, roundMinutes: 15, roundMode: 'nearest', currency: 'USD' });

// How long after the last sign of a project a window that doesn't name one
// (a terminal titled "PowerShell", the docs in a browser) still counts for it.
const STICKY_MS = Object.freeze({ editor: 15 * MIN_MS, terminal: 15 * MIN_MS, tool: 10 * MIN_MS, self: 15 * MIN_MS, browser: 5 * MIN_MS });

// The apps work happens in, by exe. Anything else (chat, music, games, mail)
// never counts, whatever its title says.
const APPS = (() => {
  const kinds = {
    editor: ['code.exe', 'code - insiders.exe', 'cursor.exe', 'windsurf.exe', 'zed.exe', 'positron.exe', 'trae.exe', 'kiro.exe', 'void.exe',
      'idea64.exe', 'idea.exe', 'webstorm64.exe', 'pycharm64.exe', 'phpstorm64.exe', 'rider64.exe', 'goland64.exe', 'clion64.exe', 'rubymine64.exe',
      'rustrover64.exe', 'datagrip64.exe', 'dataspell64.exe', 'aqua64.exe', 'fleet.exe', 'studio64.exe', 'devenv.exe', 'sublime_text.exe',
      'notepad++.exe', 'gvim.exe', 'nvim-qt.exe', 'neovide.exe', 'emacs.exe', 'runemacs.exe', 'lapce.exe', 'helix.exe'],
    terminal: ['windowsterminal.exe', 'wt.exe', 'openconsole.exe', 'conhost.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe', 'mintty.exe', 'alacritty.exe',
      'wezterm-gui.exe', 'tabby.exe', 'hyper.exe', 'warp.exe', 'ghostty.exe', 'kitty.exe', 'conemu64.exe', 'conemu.exe', 'cmder.exe', 'fluent terminal.exe', 'wave.exe'],
    browser: ['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'opera_gx.exe', 'vivaldi.exe', 'arc.exe', 'zen.exe', 'librewolf.exe', 'waterfox.exe', 'floorp.exe', 'thorium.exe'],
    tool: ['githubdesktop.exe', 'sourcetree.exe', 'gitkraken.exe', 'fork.exe', 'smartgit.exe', 'postman.exe', 'insomnia.exe', 'bruno.exe', 'figma.exe',
      'docker desktop.exe', 'tableplus.exe', 'dbeaver.exe', 'heidisql.exe', 'unity.exe', 'unrealeditor.exe', 'godot.exe', 'blender.exe', 'android studio.exe'],
  };
  return new Map(Object.entries(kinds).flatMap(([kind, exes]) => exes.map(e => [e, kind])));
})();

// Folder names too ordinary to trust outside an editor's own title: a terminal
// that mentions "api" is not necessarily in the project called api.
const GENERIC = new Set(['app', 'apps', 'api', 'web', 'www', 'src', 'site', 'docs', 'doc', 'test', 'tests', 'server', 'client', 'backend', 'frontend',
  'project', 'projects', 'code', 'main', 'demo', 'repo', 'home', 'work', 'temp', 'tmp', 'data', 'lib', 'core', 'ui', 'dev', 'build', 'dist', 'scripts']);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

const dayKey = t => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dayStart = key => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const startOfDay = t => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
// Calendar days, not 24-hour steps, so a DST change can't skip or repeat one.
const addDays = (t, n) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); };
// Control characters (C0 and C1, so no terminal escapes in `shellby time`) and
// the invisible bidi and zero-width ones (so a commit message reads the same on
// an invoice as it does in git) all become a space.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g;
const clip = (s, n) => (typeof s === 'string' ? s.replace(UNSAFE_CHARS, ' ').trim().slice(0, n) : '');
const secs = v => (Number.isFinite(v) ? Math.round(v) : 0);
// A project's key is its folder: an absolute path, never "constructor" or the like.
const okKey = k => typeof k === 'string' && k.length <= 400 && /^(?:[A-Za-z]:[\\/]|\/)/.test(k);
// Own entries only: a plain object would find "toString" in any of these maps.
const own = (map, k) => (map && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined);
/** The project on the books under `key`, or null. */
const projectOf = (state, key) => own(state.projects, key) || null;
const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ------------------------------------------------------------------ state

function cleanProject(p) {
  const src = p && typeof p === 'object' ? p : {};
  const rate = Number(src.rate);
  return {
    name: clip(src.name, 60) || 'project',
    client: clip(src.client, 60),
    rate: Number.isFinite(rate) && rate > 0 ? Math.min(RATE_MAX, Math.round(rate * 100) / 100) : null,
    billable: src.billable === undefined ? true : !!src.billable,
    ignored: !!src.ignored,
    added: !!src.added,   // added by hand on the Time page, not just seen
  };
}

// { 'YYYY-MM-DD': { key: n } } kept to the newest KEEP_DAYS days, with `ok` deciding which n stay.
function cleanDays(raw, value) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const day of Object.keys(src).filter(k => DAY_RE.test(k)).sort().slice(-KEEP_DAYS)) {
    const d = src[day] && typeof src[day] === 'object' ? src[day] : {};
    const entries = Object.entries(d).map(([k, v]) => [k, value(v)]).filter(([k, v]) => okKey(k) && v !== null).slice(0, MAX_A_DAY);
    if (entries.length) out[day] = Object.fromEntries(entries);
  }
  return out;
}

/** Tolerate anything read from disk. */
function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const projects = Object.fromEntries(Object.entries(src.projects && typeof src.projects === 'object' ? src.projects : {})
    .filter(([k]) => okKey(k)).slice(0, MAX_PROJECTS).map(([k, p]) => [k, cleanProject(p)]));
  const currency = typeof src.currency === 'string' ? src.currency.trim().toUpperCase() : '';
  return {
    enabled: !!src.enabled,
    idleMinutes: pick(Number(src.idleMinutes), IDLE_CHOICES, DEFAULTS.idleMinutes),
    roundMinutes: pick(Number(src.roundMinutes), ROUND_CHOICES, DEFAULTS.roundMinutes),
    roundMode: pick(src.roundMode, ROUND_MODES, DEFAULTS.roundMode),
    currency: CURRENCY_RE.test(currency) ? currency : DEFAULTS.currency,
    projects,
    // Seconds the tracker counted.
    days: cleanDays(src.days, v => { const n = secs(v); return n > 0 ? Math.min(n, MAX_DAY_S) : null; }),
    // Seconds added (or taken off) by hand.
    manual: cleanDays(src.manual, v => { const n = secs(v); return n !== 0 ? Math.max(-MAX_DAY_S, Math.min(n, MAX_DAY_S)) : null; }),
    // What the day was for, for the invoice line.
    notes: cleanDays(src.notes, v => clip(v, NOTE_MAX) || null),
  };
}

/** Settings from the Time page, on top of the current state. */
function setSettings(stateIn, patch = {}) {
  const s = normalize(stateIn);
  const p = patch && typeof patch === 'object' ? patch : {};
  return normalize({
    ...s,
    ...('enabled' in p ? { enabled: !!p.enabled } : {}),
    ...('idleMinutes' in p ? { idleMinutes: p.idleMinutes } : {}),
    ...('roundMinutes' in p ? { roundMinutes: p.roundMinutes } : {}),
    ...('roundMode' in p ? { roundMode: p.roundMode } : {}),
    ...('currency' in p && CURRENCY_RE.test(String(p.currency).trim().toUpperCase()) ? { currency: String(p.currency).trim().toUpperCase() } : {}),
  });
}

/** Make sure a project is on the books (the first time it gets time, or added by hand). */
function ensureProject(stateIn, key, name, { added = false } = {}) {
  const s = normalize(stateIn);
  if (!okKey(key)) return s;
  const prev = projectOf(s, key);
  if (prev && (!added || prev.added)) return s;
  let projects = { ...s.projects, [key]: cleanProject({ ...(prev || { name }), added: added || prev?.added }) };
  // Over the limit: make room by dropping one with no rate, client or time on
  // the books. With none to spare it doesn't go on (and gets no time) rather
  // than pushing out one that matters.
  if (Object.keys(projects).length > MAX_PROJECTS) {
    const used = new Set(Object.values(s.days).flatMap(d => Object.keys(d)));
    const spare = Object.keys(projects).find(k => k !== key && !used.has(k) && !projects[k].rate && !projects[k].client);
    if (!spare) return s;
    projects = Object.fromEntries(Object.entries(projects).filter(([k]) => k !== spare));
  }
  return normalize({ ...s, projects });
}

/** A project's client, rate, billable flag, display name or ignored flag. */
function setProject(stateIn, key, patch = {}) {
  const s = normalize(stateIn);
  if (!projectOf(s, key)) return s;
  const p = patch && typeof patch === 'object' ? patch : {};
  const allowed = ['name', 'client', 'rate', 'billable', 'ignored'].filter(k => k in p);
  const next = { ...projectOf(s, key), ...Object.fromEntries(allowed.map(k => [k, p[k]])) };
  if ('rate' in p && (p.rate === null || p.rate === '')) next.rate = null;
  return normalize({ ...s, projects: { ...s.projects, [key]: next } });
}

/** Forget a project and all its time. */
function removeProject(stateIn, key) {
  const s = normalize(stateIn);
  const without = days => Object.fromEntries(Object.entries(days).map(([d, m]) => [d, Object.fromEntries(Object.entries(m).filter(([k]) => k !== key))]));
  const projects = Object.fromEntries(Object.entries(s.projects).filter(([k]) => k !== key));
  return normalize({ ...s, projects, days: without(s.days), manual: without(s.manual), notes: without(s.notes) });
}

/** Count `seconds` of work on a project (one on the books), on the day of `now`. */
function credit(stateIn, key, seconds, now) {
  const s = normalize(stateIn);
  const n = Math.min(MAX_CREDIT_S, secs(seconds));
  const p = projectOf(s, key);
  if (!p || p.ignored || n <= 0 || !Number.isFinite(now)) return s;
  const day = dayKey(now);
  const d = s.days[day] || {};
  return { ...s, days: { ...s.days, [day]: { ...d, [key]: Math.min(MAX_DAY_S, (d[key] || 0) + n) } } };
}

/**
 * Add (or with a negative delta, take off) time by hand. A day's total never
 * goes below zero: taking off more than was there just clears it.
 */
function adjust(stateIn, day, key, deltaSeconds) {
  const s = normalize(stateIn);
  if (!DAY_RE.test(day) || !projectOf(s, key)) return s;
  const tracked = s.days[day]?.[key] || 0;
  const was = s.manual[day]?.[key] || 0;
  const next = Math.max(-tracked, Math.min(MAX_DAY_S - tracked, was + secs(deltaSeconds)));
  const m = { ...(s.manual[day] || {}), [key]: next };
  if (!next) delete m[key];
  return normalize({ ...s, manual: { ...s.manual, [day]: m } });
}

/** The line that goes on the invoice for that day's work. Empty clears it. */
function setNote(stateIn, day, key, text) {
  const s = normalize(stateIn);
  if (!DAY_RE.test(day) || !projectOf(s, key)) return s;
  const n = { ...(s.notes[day] || {}), [key]: clip(text, NOTE_MAX) };
  if (!n[key]) delete n[key];
  return normalize({ ...s, notes: { ...s.notes, [day]: n } });
}

// ------------------------------------------------------------------ which project is in front

/** 'editor' | 'terminal' | 'browser' | 'tool' | null for an exe name. */
const appKind = exe => APPS.get(String(exe || '').toLowerCase()) || null;

// Git Bash and WSL write /c/Users/... ; make it look like C:\Users\... so a
// project's folder can be found in it.
const windowsPaths = title => title.replace(/(^|[\s:])\/([a-z])\//gi, '$1$2:\\').replace(/\//g, '\\');

// Bounded by anything that can't be part of a folder name, so "shellby" is not
// found in "shellby-api" and "api" not in "rapid".
const mentions = (text, name) => new RegExp(`(^|[^a-z0-9_.-])${escapeRe(name)}($|[^a-z0-9_.-])`, 'i').test(text);
// A browser tab counts only on a code host's own page: any site can set its title.
const CODE_HOST = /\b(GitHub|GitLab|Bitbucket|Codeberg|Gitea|Forgejo|SourceHut|Azure DevOps)\b/i;
const repoPath = (text, name) => new RegExp(`[a-z0-9_.-]+/${escapeRe(name)}($|[^a-z0-9_.-])`, 'i').test(text);

/**
 * Which known project a window's title shows, or null.
 *   projects: [{ key, name, root? }] (key: the repo's folder, case-folded)
 *   rank: key -> when it last had time (ties go to the most recent)
 * A folder in the title beats a name; a longer name beats a shorter one. In a
 * browser only a code host's repository page counts ("owner/name · GitHub").
 */
function matchTitle(title, kind, projects, rank = {}) {
  const raw = clip(title, 400);
  if (!raw || !kind) return null;
  const asPath = windowsPaths(raw).toLowerCase();
  let best = null;
  const consider = (key, score) => {
    if (!best || score > best.score || (score === best.score && (rank[key] || 0) > (rank[best.key] || 0))) best = { key, score };
  };
  for (const p of projects || []) {
    const name = clip(p.name, 60).toLowerCase();
    const root = String(p.root || p.key || '').toLowerCase().replace(/[\\/]+$/, '');
    if (kind !== 'browser' && root.length > 3 && /^[a-z]:\\/.test(root) && (asPath === root || asPath.includes(root + '\\') || new RegExp(`${escapeRe(root)}($|[^a-z0-9_.-])`).test(asPath))) {
      consider(p.key, 1000 + root.length);
      continue;
    }
    if (name.length < 2) continue;
    if (kind === 'browser') { if (name.length >= 3 && CODE_HOST.test(raw) && repoPath(raw, name)) consider(p.key, 100 + name.length); continue; }
    if (GENERIC.has(name) && kind !== 'editor') continue;
    if (name.length < 3 && kind !== 'editor') continue;
    if (mentions(raw, name) || mentions(asPath, name)) consider(p.key, 100 + name.length);
  }
  return best ? best.key : null;
}

/**
 * Who gets this moment. Returns { key, why }:
 *   why 'window'  the window in front names the project
 *       'shellby' Shellby's own window, with Claude working in one project
 *       'claude'  a work app that names no project, with Claude working in one
 *       'recent'  a work app that names no project, soon after one did
 *       'idle'    away from the keyboard, or locked
 *       'other'   an app that isn't for work
 *       'none'    a work app, but nothing to pin it on
 * input: {
 *   win: { exe, title, self } | null   self: one of Shellby's own windows
 *   idleMs, locked, now, idleMinutes
 *   projects, rank                     as for matchTitle
 *   recent: { key, at } | null         the last sure sign of a project
 *   claude: key | null                 the one project Claude is working in right now, if just one
 * }
 */
function attribute(input) {
  const { win, idleMs = 0, locked = false, now, idleMinutes = DEFAULTS.idleMinutes, projects = [], rank = {}, recent = null, claude = null } = input || {};
  if (locked || idleMs >= idleMinutes * MIN_MS) return { key: null, why: 'idle' };
  if (!win) return { key: null, why: 'none' };
  const kind = win.self ? 'self' : appKind(win.exe);
  if (!kind) return { key: null, why: 'other' };
  if (kind !== 'self') {
    const key = matchTitle(win.title, kind, projects, rank);
    if (key) return { key, why: 'window' };
  }
  if (claude) return { key: claude, why: kind === 'self' ? 'shellby' : 'claude' };
  if (recent?.key && now - recent.at <= STICKY_MS[kind]) return { key: recent.key, why: 'recent' };
  return { key: null, why: 'none' };
}

// ------------------------------------------------------------------ ranges and totals

/**
 * The ranges the Time page offers, as day keys (both ends included).
 * Weeks start on Monday, the way timesheets usually do.
 */
function ranges(now) {
  const today = startOfDay(now);
  const dow = (new Date(today).getDay() + 6) % 7; // 0 = Monday
  const weekFrom = addDays(today, -dow);
  const d = new Date(today);
  const monthFrom = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const lastMonthFrom = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
  const r = (id, label, from, to) => ({ id, label, from: dayKey(from), to: dayKey(to) });
  return [
    r('today', 'Today', today, today),
    r('week', 'This week', weekFrom, today),
    r('last-week', 'Last week', addDays(weekFrom, -7), addDays(weekFrom, -1)),
    r('month', 'This month', monthFrom, today),
    r('last-month', 'Last month', lastMonthFrom, addDays(monthFrom, -1)),
  ];
}

/** Every day key from `from` to `to`, both included (at most KEEP_DAYS of them). */
function daysBetween(from, to) {
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) return [];
  const out = [];
  for (let t = dayStart(from); dayKey(t) <= to && out.length < KEEP_DAYS; t = addDays(t, 1)) out.push(dayKey(t));
  return out;
}

/**
 * Seconds -> seconds on the invoice, to the nearest (or next) `minutes`. Real
 * work is at least one step, but a glance isn't work: under two minutes rounds
 * to nothing (under one when rounding up).
 */
function roundSeconds(seconds, minutes, mode = 'nearest') {
  const s = Math.max(0, secs(seconds));
  if (!s || !minutes) return s;
  if (s < (mode === 'up' ? 60 : 120)) return 0;
  const step = minutes * 60;
  const steps = mode === 'up' ? Math.ceil(s / step) : Math.round(s / step);
  return Math.max(1, steps) * step;
}

/**
 * Roughly how long went into a day of commits, the way git-hours does it:
 * commits less than two hours apart are one sitting, and each sitting gets half
 * an hour for the work before its first commit. times: commit times in ms.
 */
function estimateFromCommits(times, { gapMs = 2 * 60 * MIN_MS, firstMs = 30 * MIN_MS } = {}) {
  const t = [...new Set((times || []).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!t.length) return 0;
  let ms = firstMs;
  for (let i = 1; i < t.length; i++) {
    const gap = t[i] - t[i - 1];
    ms += gap <= gapMs ? gap : firstMs;
  }
  return Math.round(ms / 1000);
}

/**
 * Everything the Time page, the exports and `shellby time` show for a range.
 *   range: { from, to } day keys
 *   opts.commits: key -> [{ at, subject }] (your commits in the range, from git)
 *   opts.estimates: fill days with commits but no time from them (git-hours)
 *   opts.only: { client } | { key } to narrow it to one client or project
 *   opts.names: key -> name for projects Shellby knows but has no time for yet,
 *     so their commits can still show (and fill in days from before tracking)
 */
function summarize(stateIn, range, { commits = {}, estimates = false, only = null, names = {} } = {}) {
  const s = normalize(stateIn);
  const days = daysBetween(range?.from, range?.to);
  const keys = new Set();
  for (const day of days) for (const src of [s.days, s.manual, s.notes]) for (const k of Object.keys(src[day] || {})) keys.add(k);
  for (const [k, list] of Object.entries(commits || {})) if (okKey(k) && Array.isArray(list) && list.length && (projectOf(s, k) || own(names, k))) keys.add(k);

  const projects = [];
  for (const key of keys) {
    const p = projectOf(s, key) || cleanProject({ name: own(names, key) || key.split(/[\\/]/).pop() });
    if (p.ignored) continue;
    if (only?.key && only.key !== key) continue;
    if (only && 'client' in only && !only.key && p.client !== only.client) continue;
    const byDay = new Map();
    const list = own(commits, key);
    for (const c of Array.isArray(list) ? list : []) {
      if (!Number.isFinite(c?.at)) continue;
      const day = dayKey(c.at);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({ at: c.at, subject: clip(c.subject, 120) });
    }
    const rows = [];
    for (const day of days) {
      const tracked = own(s.days[day], key) || 0;
      const manual = own(s.manual[day], key) || 0;
      const note = own(s.notes[day], key) || '';
      const dayCommits = (byDay.get(day) || []).sort((a, b) => a.at - b.at);
      // A day with any time, or one you set by hand (even to nothing), is never guessed at.
      const decided = tracked > 0 || manual !== 0;
      const estimate = decided ? 0 : estimateFromCommits(dayCommits.map(c => c.at));
      const estimated = estimates && estimate > 0;
      const total = estimated ? estimate : Math.max(0, tracked + manual);
      if (!total && !note && !dayCommits.length && !estimate) continue;
      rows.push({
        day, tracked, manual, estimate, total, note, estimated,
        billed: roundSeconds(total, s.roundMinutes, s.roundMode),
        commits: dayCommits.slice(0, 30),
        commitCount: dayCommits.length,
      });
    }
    if (!rows.length) continue;
    const seconds = rows.reduce((n, r) => n + r.total, 0);
    const billed = rows.reduce((n, r) => n + r.billed, 0);
    const amount = p.billable && p.rate ? Math.round((billed / 3600) * p.rate * 100) / 100 : 0;
    projects.push({
      key, name: p.name, client: p.client, rate: p.rate, billable: p.billable, added: p.added, onBooks: !!projectOf(s, key),
      seconds, billed, amount, days: rows,
      tracked: rows.reduce((n, r) => n + r.tracked, 0),
      manual: rows.reduce((n, r) => n + r.manual, 0),
      estimate: rows.reduce((n, r) => n + (r.estimated ? r.estimate : 0), 0),
      unfilled: rows.reduce((n, r) => n + (!r.total ? r.estimate : 0), 0),
      commitCount: rows.reduce((n, r) => n + r.commitCount, 0),
    });
  }
  projects.sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));

  const perDay = days.map(day => ({ day, seconds: projects.reduce((n, p) => n + (p.days.find(r => r.day === day)?.total || 0), 0) }));
  return {
    from: range?.from, to: range?.to, currency: s.currency, roundMinutes: s.roundMinutes, roundMode: s.roundMode, estimates: !!estimates,
    projects,
    days: perDay,
    totals: {
      seconds: projects.reduce((n, p) => n + p.seconds, 0),
      billed: projects.reduce((n, p) => n + (p.billable ? p.billed : 0), 0),
      amount: Math.round(projects.reduce((n, p) => n + p.amount, 0) * 100) / 100,
      unfilled: projects.reduce((n, p) => n + p.unfilled, 0),
    },
    clients: [...new Set(projects.map(p => p.client).filter(Boolean))].sort(),
  };
}

// ------------------------------------------------------------------ words and exports

const hours = s => Math.round((s / 3600) * 100) / 100;
/** "2h 05m", "45m", "0m" */
function duration(seconds) {
  const m = Math.round(Math.max(0, secs(seconds)) / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

function money(amount, currency) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** The description that goes on an invoice line: the note, else the commits. */
function lineText(row) {
  if (row.note) return row.note;
  const subjects = [...new Set(row.commits.map(c => c.subject).filter(Boolean))];
  if (!subjects.length) return '';
  const shown = subjects.slice(0, 6).join('; ');
  return subjects.length > 6 ? `${shown}; and ${subjects.length - 6} more` : shown;
}

// A spreadsheet runs a cell that starts with = + - @ (or a tab or return) as a
// formula; commit messages come from anyone with push access, so never let them.
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per project per day, ready for a spreadsheet or an invoicing tool. */
function toCsv(summary) {
  const head = ['Date', 'Client', 'Project', 'Hours', 'Billed hours', 'Rate', 'Amount', 'Currency', 'Billable', 'Source', 'Description'];
  const lines = [head.join(',')];
  for (const p of summary.projects) {
    for (const r of p.days) {
      if (!r.total) continue;
      const amount = p.billable && p.rate ? Math.round((r.billed / 3600) * p.rate * 100) / 100 : '';
      const source = r.estimated ? 'git estimate' : r.manual && r.tracked ? 'tracked + manual' : r.manual ? 'manual' : 'tracked';
      lines.push([r.day, p.client, p.name, hours(r.total).toFixed(2), hours(r.billed).toFixed(2), p.rate ?? '', amount === '' ? '' : amount.toFixed(2),
        summary.currency, p.billable ? 'yes' : 'no', source, lineText(r)].map(csvCell).join(','));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** A short plain-text summary, for pasting into an email or an invoice tool. */
function toText(summary, label = '') {
  const lines = [`Time${label ? `, ${label.toLowerCase()}` : ''} (${summary.from} to ${summary.to})`, ''];
  for (const p of summary.projects) {
    if (!p.seconds) continue;
    const pay = p.billable && p.rate ? ` x ${money(p.rate, summary.currency)}/h = ${money(p.amount, summary.currency)}` : p.billable ? '' : ' (not billable)';
    lines.push(`${p.client ? `${p.client}: ` : ''}${p.name}: ${hours(p.billed).toFixed(2)} h${pay}`);
    for (const r of p.days) if (r.total) lines.push(`  ${r.day}  ${hours(r.billed).toFixed(2)} h${lineText(r) ? `  ${lineText(r)}` : ''}${r.estimated ? '  (from commits)' : ''}`);
  }
  lines.push('', `Total: ${hours(summary.totals.billed).toFixed(2)} billable hours${summary.totals.amount ? `, ${money(summary.totals.amount, summary.currency)}` : ''}`);
  if (summary.roundMinutes) lines.push(`Each day rounded ${summary.roundMode === 'up' ? 'up ' : ''}to ${summary.roundMinutes} minutes.`);
  return lines.join('\n');
}

module.exports = {
  DEFAULTS, IDLE_CHOICES, ROUND_CHOICES, ROUND_MODES, STICKY_MS, MAX_CREDIT_S, KEEP_DAYS,
  normalize, setSettings, ensureProject, setProject, removeProject, credit, adjust, setNote,
  projectOf, appKind, matchTitle, attribute,
  ranges, daysBetween, roundSeconds, estimateFromCommits, summarize,
  duration, hours, money, lineText, csvCell, toCsv, toText, dayKey,
};
