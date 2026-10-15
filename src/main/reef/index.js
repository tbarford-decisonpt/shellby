// Reef health per project (docs/REEF.md): a coral for each project you choose
// to watch, grown by real improvements to its code. Each signal (reef/signals.js)
// keeps a high-water mark; only a reading that beats it by the signal's step
// counts, adds a polyp, and pays (once a day per project). A worse reading
// takes nothing away: polyps only go up, and health only changes the coral's
// colour. Off until you press "Watch this reef" on the project's page.
//
// State (config `reef`, this PC only, never synced):
//   { projects: { [id]: { on, name, root, remote, polyps, lastPaidDay, startedAt, head,
//       lintCmd, ciRuns: [[key, ok]], grepDay, covMtime,
//       signals: { [sig]: { best, bestAt, last, lastAt, series: [[dayKey, v]] } },
//       detail: { [sig]: where the last count came from (reef/detail.js), names and counts only } } } }
// id: the project's key (stickers.projectId, the same for a repo and its copies).
//
// Pure: no I/O, no clock (callers pass `now`). See test/reef.test.js.

const signals = require('./signals');
const detail = require('./detail');
const prompts = require('./prompts');

const { SIGNALS, SIGNAL_IDS, isSignal, beats, nearBest, needFor } = signals;

const DAY = 24 * 60 * 60 * 1000;
const ID_RE = /^[0-9a-f]{12}$/;
const MAX_PROJECTS = 40;
const MAX_SERIES = 60;
const MAX_CI_RUNS = 20;
const FRESH_DAYS = 14;        // health looks at the last two weeks
const WINDOW = 2 * DAY;       // the anti-cheat checks look this far back at the other signals
const DELETED_SHARE = 0.3;    // fewer escapes because this much of the code went: not a best
const MAX_POLYPS = 9999;
const STAGES = Object.freeze(['Bleached', 'Pale', 'Settling', 'Growing', 'Healthy', 'Thriving']);
const THRIVING = 5;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pos = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const isId = id => typeof id === 'string' && ID_RE.test(id);

/** The local day a moment falls on, "2026-10-14". */
function dayKey(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ state

function normalizeSignal(raw) {
  if (!isObj(raw) || num(raw.best) === null) return null;
  const series = (Array.isArray(raw.series) ? raw.series : [])
    .filter(e => Array.isArray(e) && /^\d{4}-\d{2}-\d{2}$/.test(e[0]) && num(e[1]) !== null)
    .slice(-MAX_SERIES).map(([d, v]) => [d, v]);
  return {
    best: raw.best, bestAt: pos(raw.bestAt),
    last: num(raw.last) ?? raw.best, lastAt: pos(raw.lastAt),
    series,
  };
}

function detailsOf(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const id of SIGNAL_IDS) {
    const d = detail.normalizeDetail(raw[id]);
    if (d) out[id] = d;
  }
  return out;
}

function normalizeProject(raw) {
  if (!isObj(raw)) return null;
  const sigs = {};
  for (const id of SIGNAL_IDS) {
    const s = normalizeSignal(raw.signals?.[id]);
    if (s) sigs[id] = s;
  }
  return {
    on: raw.on === true,
    name: str(raw.name, 80) || 'Project',
    root: str(raw.root, 400),
    remote: str(raw.remote, 200),
    polyps: Math.min(MAX_POLYPS, Math.floor(pos(raw.polyps))),
    lastPaidDay: str(raw.lastPaidDay, 10),
    startedAt: pos(raw.startedAt),
    head: /^[0-9a-f]{40}$/.test(raw.head) ? raw.head : '',
    lintCmd: str(raw.lintCmd, 300),
    ciRuns: (Array.isArray(raw.ciRuns) ? raw.ciRuns : [])
      .filter(r => Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'boolean')
      .slice(-MAX_CI_RUNS).map(([k, ok]) => [k.slice(0, 80), ok]),
    grepDay: str(raw.grepDay, 10),
    covMtime: pos(raw.covMtime),
    signals: sigs,
    detail: detailsOf(raw.detail),
  };
}

/** A stored reef made safe. Never throws. */
function normalize(raw) {
  const projects = {};
  const src = isObj(raw) && isObj(raw.projects) ? raw.projects : {};
  for (const [id, p] of Object.entries(src).slice(0, MAX_PROJECTS)) {
    if (!isId(id)) continue;
    const n = normalizeProject(p);
    if (n) projects[id] = n;
  }
  return { projects };
}

const blank = (name, root, now) => normalizeProject({ on: false, name, root, startedAt: now });

/**
 * Watch a project's reef, or stop. Stopping keeps everything (the coral, its
 * polyps, every best): watching again carries on from there.
 *   meta: { name, root, remote }   -> { state, first: bool (never watched before) }
 */
function enable(state, id, meta = {}, on = true, now = 0) {
  const s = normalize(state);
  if (!isId(id)) return { state: s, first: false };
  const was = s.projects[id];
  if (!was && !on) return { state: s, first: false };
  if (!was && Object.keys(s.projects).length >= MAX_PROJECTS) return { state: s, first: false, full: true };
  const p = was || blank(meta.name, meta.root, now);
  const next = {
    ...p, on: !!on,
    name: str(meta.name, 80) || p.name,
    root: str(meta.root, 400) || p.root,
    remote: str(meta.remote, 200) || p.remote,
  };
  return { state: { projects: { ...s.projects, [id]: next } }, first: !was };
}

// Did a signal's latest reading, within the last two days, go up (or down) from the day before?
const recentRise = (sig, now) => {
  if (!sig || sig.series.length < 2) return false;
  const [, prev] = sig.series.at(-2);
  return sig.lastAt >= now - WINDOW && sig.last > prev;
};
const recentFall = (sig, now) => {
  if (!sig || sig.series.length < 2) return false;
  const [, prev] = sig.series.at(-2);
  return sig.lastAt >= now - WINDOW && sig.last < prev;
};

function withSeries(series, day, v) {
  const out = series.at(-1)?.[0] === day ? series.slice(0, -1) : [...series];
  out.push([day, v]);
  return out.slice(-MAX_SERIES);
}

/**
 * One reading of a signal for a watched project.
 *   ctx: { cmd } for lint (only the same command as the first reading counts),
 *        { deletedShare, head } for escapes (from git, since the baseline commit)
 * -> { state, best: bool, paid: bool, baseline: bool, reason: string | null }
 * The first reading sets the mark and pays nothing. A new best adds a polyp and
 * pays once a day per project. A worse one only changes `last` (and so health).
 */
function reading(state, id, sig, value, now, ctx = {}) {
  const s = normalize(state);
  const p = s.projects[id];
  const no = reason => ({ state: s, best: false, paid: false, baseline: false, reason });
  if (!p || !p.on) return no('off');
  if (!isSignal(sig)) return no('unknown');
  const v = num(value);
  if (v === null || v < 0) return no('unreadable');
  if (sig === 'lint' && p.lintCmd && str(ctx.cmd, 300) !== p.lintCmd) return no('other-command');
  const day = dayKey(now);
  const was = p.signals[sig];
  const put = (patch, sigPatch) => ({
    projects: { ...s.projects, [id]: { ...p, ...patch, signals: { ...p.signals, [sig]: sigPatch } } },
  });
  if (!was) {
    const patch = sig === 'lint' ? { lintCmd: str(ctx.cmd, 300) } : sig === 'escapes' && ctx.head ? { head: ctx.head } : {};
    return { state: put(patch, { best: v, bestAt: now, last: v, lastAt: now, series: [[day, v]] }), best: false, paid: false, baseline: true, reason: null };
  }
  const moved = { ...was, last: v, lastAt: now, series: withSeries(was.series, day, v) };
  if (!beats(sig, was.best, v)) return { state: put({}, moved), best: false, paid: false, baseline: false, reason: null };
  // Anti-cheat: more tests while escape hatches went up, coverage while tests went down,
  // fewer escapes because a big share of the code was deleted.
  const others = p.signals;
  let reason = null;
  if (sig === 'tests' && recentRise(others.escapes, now)) reason = 'escapes-rose';
  if (sig === 'coverage' && recentFall(others.tests, now)) reason = 'tests-fell';
  if (sig === 'escapes' && Number(ctx.deletedShare) > DELETED_SHARE) {
    // Counted from here on, without paying: the old mark measured code that's gone.
    const reset = { ...moved, best: v, bestAt: now };
    return { state: put(ctx.head ? { head: ctx.head } : {}, reset), best: false, paid: false, baseline: true, reason: 'deleted' };
  }
  if (reason) return { state: put({}, moved), best: false, paid: false, baseline: false, reason };
  const paid = p.lastPaidDay !== day;
  const patch = {
    polyps: Math.min(MAX_POLYPS, p.polyps + 1),
    ...(paid ? { lastPaidDay: day } : {}),
    ...(sig === 'escapes' && ctx.head ? { head: ctx.head } : {}),
  };
  return { state: put(patch, { ...moved, best: v, bestAt: now }), best: true, paid, baseline: false, reason: null };
}

/** A finished PR check run for the project: kept (the last 20) for the CI green rate. */
function noteCiRun(state, id, key, ok) {
  const s = normalize(state);
  const p = s.projects[id];
  if (!p || typeof key !== 'string' || typeof ok !== 'boolean' || p.ciRuns.some(r => r[0] === key.slice(0, 80))) return { state: s, changed: false };
  const ciRuns = [...p.ciRuns, [key.slice(0, 80), ok]].slice(-MAX_CI_RUNS);
  return { state: { projects: { ...s.projects, [id]: { ...p, ciRuns } } }, changed: true };
}

/** Bookkeeping the wiring keeps on a project (grepDay, covMtime, head). Unknown keys are ignored. */
function mark(state, id, patch = {}) {
  const s = normalize(state);
  const p = s.projects[id];
  if (!p) return s;
  const keep = {};
  if (typeof patch.grepDay === 'string') keep.grepDay = patch.grepDay.slice(0, 10);
  if (pos(patch.covMtime)) keep.covMtime = patch.covMtime;
  if (/^[0-9a-f]{40}$/.test(patch.head || '')) keep.head = patch.head;
  return { projects: { ...s.projects, [id]: { ...p, ...keep } } };
}

/**
 * Where a signal's last count came from (reef/detail.js), for Fix this. A
 * detail with nothing in it clears what was there. Unknown signals are ignored.
 */
function setDetail(state, id, sig, raw) {
  const s = normalize(state);
  const p = s.projects[id];
  if (!p || !isSignal(sig)) return s;
  const d = detail.normalizeDetail(raw);
  const next = { ...p.detail };
  if (d) next[sig] = d; else delete next[sig];
  return { projects: { ...s.projects, [id]: { ...p, detail: next } } };
}

/**
 * The Fix this prompt for one signal of a project, or for its worst one
 * (sig 'worst'): -> { sig, prompt } or null when there's nothing to fix.
 */
function fixPrompt(state, id, sig) {
  const p = normalize(state).projects[id];
  if (!p) return null;
  const which = sig === 'worst' ? prompts.worstOf(p) : sig;
  const prompt = which ? prompts.promptFor(p, which) : null;
  return prompt ? { sig: which, prompt } : null;
}

// ------------------------------------------------------------------ health

const freshOf = (p, now) => Object.entries(p.signals).filter(([, s]) => s.lastAt >= now - FRESH_DAYS * DAY);

/** Which way a signal went over the last two weeks: 'up' (better), 'down' (worse) or 'flat'. */
function trendOf(sig, s, now) {
  const since = dayKey(now - FRESH_DAYS * DAY);
  const recent = s.series.filter(([d]) => d >= since);
  if (recent.length < 2) return 'flat';
  const first = recent[0][1];
  const last = recent.at(-1)[1];
  if (first === last) return 'flat';
  const better = SIGNALS[sig].better === 'lower' ? last < first : last > first;
  return better ? 'up' : 'down';
}

/**
 * The reef's health, 0 (bleached) to 5 (thriving): the share of the last two
 * weeks' signals at or near their best, with credit for a better trend and for
 * bug nests cleared. A young reef is still settling: it can't pass stage 2
 * before three days of readings, 3 before its first best, 4 before its third.
 * Visual only: health never takes a polyp back.
 */
function healthOf(p, now) {
  if (!p) return 0;
  const fresh = freshOf(p, now);
  if (!fresh.length) return Object.keys(p.signals).length ? 1 : 2; // gone quiet: pales, never vanishes
  let score = 0;
  for (const [sig, s] of fresh) {
    const t = trendOf(sig, s, now);
    score += nearBest(sig, s.best, s.last) ? 1 : t === 'up' ? 0.5 : 0;
  }
  let share = score / fresh.length;
  const nests = p.signals.nests;
  if (nests) {
    const since = dayKey(now - FRESH_DAYS * DAY);
    const drops = nests.series.filter(([d], i, a) => d >= since && i > 0 && a[i][1] < a[i - 1][1]).length;
    share += Math.min(0.2, drops * 0.1);
  }
  const stage = share >= 0.9 ? 5 : share >= 0.7 ? 4 : share >= 0.45 ? 3 : share >= 0.25 ? 2 : share > 0 ? 1 : 0;
  const days = new Set(Object.values(p.signals).flatMap(s => s.series.map(([d]) => d))).size;
  const cap = days < 3 ? 2 : p.polyps < 1 ? 3 : p.polyps < 3 ? 4 : 5;
  return Math.min(stage, cap);
}

const thrivingCount = (state, now) => Object.values(normalize(state).projects).filter(p => p.on && healthOf(p, now) >= THRIVING).length;

/** The one thing that would grow this reef next: { sig, text } or null (nothing read yet). */
function nextImprovement(p) {
  if (!p) return null;
  const order = ['escapes', 'lint', 'tests', 'flaky', 'nests', 'coverage', 'deps', 'ci'];
  const options = order.filter(sig => p.signals[sig]).map(sig => {
    const s = p.signals[sig];
    const need = needFor(sig, s.best, s.last);
    if (need === null || need <= 0) return null;
    // A lower signal already at 0 can't get better: nothing to do there.
    if (SIGNALS[sig].better === 'lower' && s.best - SIGNALS[sig].step(s.best) < 0) return null;
    if (sig === 'ci' && s.best >= 100) return null;
    if (sig === 'coverage' && s.best >= 100) return null;
    return { sig, need, text: SIGNALS[sig].next(Math.ceil(need), s.best) };
  }).filter(Boolean);
  if (!options.length) return null;
  // The smallest step first, in the order above when they tie.
  const small = options.filter(o => SIGNALS[o.sig].unit === '' && o.need <= 3);
  const pick = small[0] || options[0];
  return { sig: pick.sig, text: pick.text };
}

// ------------------------------------------------------------------ coral

// A tiny seeded generator, so a project's coral always grows the same way.
function rng(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Each project's colour, by its seed: [body, tip, shadow].
const HUES = Object.freeze([
  ['#ff6f91', '#ffc2d1', '#c2456b'], // coral pink
  ['#ff9f43', '#ffd8a8', '#c76d1f'], // orange
  ['#a06cd5', '#dcc6f5', '#6f43a0'], // purple
  ['#2ec4b6', '#b8f2ea', '#1b8a80'], // teal
  ['#f9c74f', '#fff1c1', '#c79a24'], // yellow
  ['#ef476f', '#ffb3c6', '#a8274a'], // red
]);
const BLEACH = '#ece6da';
const ROCK = { r: '#6b6259', R: '#8f857a' };

function mix(hex, toward, t) {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(toward.slice(1), 16);
  const ch = (x, s) => (x >> s) & 255;
  const m = s => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t);
  return `#${[16, 8, 0].map(s => m(s).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A project's coral as pixel art for the tank: { palette, pixels, frames, fps }.
 * Polyps set its size (it only grows); the stage sets its colour, vivid when
 * thriving, pale when it's struggling. Deterministic for the same arguments.
 */
function coralArt(stage, polyps, seed) {
  const r = rng(seed);
  const st = Math.max(0, Math.min(5, Math.floor(Number(stage) || 0)));
  const n = Math.max(0, Math.floor(Number(polyps) || 0));
  const h = Math.min(26, 6 + Math.floor(Math.sqrt(n) * 3));
  const w = Math.min(22, 7 + Math.floor(Math.sqrt(n) * 2.4)) | 1; // odd, so there's a middle
  const grid = Array.from({ length: h }, () => Array(w).fill('.'));
  const set = (x, y, c) => { if (x >= 1 && x < w - 1 && y >= 0 && y < h - 1 && grid[y][x] === '.') grid[y][x] = c; };
  const tips = Math.min(9, 1 + Math.floor(Math.sqrt(n)));
  // Branches grow up from the base, drifting sideways and splitting until there are enough tips.
  const live = [{ x: Math.floor(w / 2), y: h - 2 }];
  let grown = 1;
  for (let y = h - 2; y >= 1 && live.length; y--) {
    for (const b of [...live]) {
      set(b.x, y, b.x <= Math.floor(w / 2) - 2 ? 'd' : 'c');
      if (y <= 1 + Math.floor(r() * 3) || (y < h * 0.45 && r() < 0.12)) { set(b.x, y - 1, 'C'); live.splice(live.indexOf(b), 1); continue; }
      const drift = r();
      if (drift < 0.25 && b.x > 2) b.x -= 1;
      else if (drift > 0.75 && b.x < w - 3) b.x += 1;
      if (grown < tips && y < h - 3 && r() < 0.35) {
        live.push({ x: Math.max(1, Math.min(w - 2, b.x + (r() < 0.5 ? -2 : 2))), y });
        grown++;
      }
    }
  }
  for (const b of live) set(b.x, 0, 'C');
  // The rock it grows on.
  const base = grid[h - 1];
  for (let x = Math.floor(w / 2) - 2; x <= Math.floor(w / 2) + 2; x++) if (x >= 0 && x < w) base[x] = x % 2 ? 'R' : 'r';
  const pixels = grid.map(row => row.join(''));
  // The top half sways a pixel with the current.
  const sway = pixels.map((row, y) => (y < h / 2 ? `.${row.slice(0, -1)}` : row));
  const hue = HUES[Math.floor(r() * HUES.length)];
  const fade = (5 - st) / 5 * 0.85;
  const palette = { c: mix(hue[0], BLEACH, fade), C: mix(hue[1], BLEACH, fade), d: mix(hue[2], BLEACH, fade), ...ROCK };
  return { palette, pixels, frames: [sway], fps: 1 };
}

// ------------------------------------------------------------------ views

function signalView(sig, s, now) {
  const d = SIGNALS[sig];
  return {
    id: sig, label: d.label, hint: d.hint, better: d.better, unit: d.unit,
    last: s.last, best: s.best, lastAt: s.lastAt, bestAt: s.bestAt,
    atBest: s.last === s.best, near: nearBest(sig, s.best, s.last),
    trend: trendOf(sig, s, now),
    series: s.series.slice(-30).map(([, v]) => v),
    fixable: prompts.canImprove(sig, s),
    nextStep: (() => { const need = needFor(sig, s.best, s.last); return need ? d.next(Math.ceil(need), s.best) : null; })(),
  };
}

function projectView(id, p, now) {
  const stage = healthOf(p, now);
  return {
    id, name: p.name, project: p.name, root: p.root, on: p.on,
    stage, stageName: STAGES[stage], polyps: p.polyps, startedAt: p.startedAt,
    signals: SIGNAL_IDS.filter(sig => p.signals[sig]).map(sig => signalView(sig, p.signals[sig], now)),
    waiting: SIGNAL_IDS.filter(sig => !p.signals[sig]).map(sig => ({ id: sig, label: SIGNALS[sig].label, hint: SIGNALS[sig].hint })),
    next: nextImprovement(p),
    worst: prompts.worstOf(p),
    paidToday: p.lastPaidDay === dayKey(now),
    art: coralArt(stage, p.polyps, id),
  };
}

/** Every reef, for the Projects page, the tank and the Logbook. */
function reefView(state, now) {
  const s = normalize(state);
  const projects = Object.entries(s.projects).map(([id, p]) => projectView(id, p, now))
    .sort((a, b) => Number(b.on) - Number(a.on) || b.polyps - a.polyps || a.name.localeCompare(b.name));
  return {
    projects,
    watching: projects.filter(p => p.on).length,
    thriving: projects.filter(p => p.on && p.stage >= THRIVING).length,
    polyps: projects.reduce((n, p) => n + p.polyps, 0),
    stages: [...STAGES],
  };
}

/** Each project's coral, for tank.library({ coral }): [{ id, name, stage, polyps, art }]. */
function corals(state, now) {
  return Object.entries(normalize(state).projects).map(([id, p]) => {
    const stage = healthOf(p, now);
    return { id, name: p.name, stage, stageName: STAGES[stage], polyps: p.polyps, art: coralArt(stage, p.polyps, id) };
  });
}

module.exports = {
  STAGES, THRIVING, DELETED_SHARE, MAX_PROJECTS, FRESH_DAYS, ID_RE,
  dayKey, normalize, enable, reading, noteCiRun, mark, setDetail, fixPrompt, healthOf, trendOf, thrivingCount,
  nextImprovement, coralArt, reefView, corals, signals, detail, prompts,
};
