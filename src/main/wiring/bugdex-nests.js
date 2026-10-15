'use strict';

// Bug history, fix reports and nests (docs/GAMIFICATION-PLAN.md 2.5): what a
// catch leaves behind. wireBugdex (wiring/bugdex.js) tells it when a bug
// surfaces (opened) and the battle asks it for the fix report (report);
// bugdex-reward.js hands it each catch that counted (caught). It pays the
// cleanfix, held and nest awards, emits the stats the tank pieces and
// trophies read, notes nests for the reef, and serves the 'nests' game view.
//
// State lives in config bugNests ({ history, nests }), local and not synced.
// The modules it leans on are pure (bugdex/quality.js, bugdex/history.js, nests.js).

const bugdex = require('../bugdex');
const lifecycle = require('../bugdex/lifecycle');
const { speciesById } = require('../bugdex/species');
const { fixReport, isClean } = require('../bugdex/quality');
const history = require('../bugdex/history');
const nests = require('../bugdex/nests');

const SWEEP_MS = 60 * 60 * 1000;     // held fixes and clearing nests are checked hourly
const FIRST_SWEEP_MS = 90 * 1000;    // and once soon after start
const MAX_REPORTS = 40;              // fix reports kept between the battle's end and the reward
const NESTS_FOR_QUEST = 3;

/** d: what main shares (main.js `shared`). */
function wireNests(d) {
  const reports = new Map(); // encounter id -> its fix report, from the battle's end to the reward

  function load() {
    const raw = d.config?.get('bugNests');
    return { history: history.normalizeHistory(raw?.history), nests: nests.normalizeNests(raw?.nests) };
  }

  function save(s) {
    if (d.CAPTURE || !d.config) return;
    d.config.set({ bugNests: { history: s.history, nests: s.nests } });
  }

  const projectNames = new Map(); // project id -> name, as encounters bring them
  const projectName = id => projectNames.get(id) || null;
  const learn = e => { if (e?.project && typeof e.name === 'string' && e.name) projectNames.set(e.project, e.name.slice(0, 80)); };
  const speciesName = id => speciesById(id)?.name || id;

  function noteReef(s, project) {
    if (project) d.reefNote?.(project, 'nest', nests.nestSignal(s.nests, project));
  }

  function view(now = Date.now()) {
    const s = load();
    const v = nests.nestsView(s.nests, { project: projectName, species: speciesName }, now);
    // Rematch history: each species fought more than once, with its past report letters.
    const rivals = Object.entries(s.history)
      .filter(([, e]) => e.n > 1 || e.catches.length > 1)
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 20)
      .map(([key, e]) => {
        const { project, species } = history.splitKey(key);
        return { key, species, name: speciesName(species), project: projectName(project) || s.nests[key]?.name || '', seen: e.n, catches: history.lettersFor(s.history, key) };
      });
    return { ...v, rivals };
  }

  const pushView = event => d.gameHub?.push('nests', view(), event);

  /** A bug surfaced (a new encounter, not a re-run of one already loose). e: { project, species } */
  function opened(e, now = Date.now()) {
    if (!e?.project || !e.species) return;
    learn(e);
    const s = load();
    const key = history.keyOf(e.project, e.species);
    const r = nests.observe(s.nests, e, now);
    const next = { history: history.recordSeen(s.history, key, now), nests: r.nests };
    save(next);
    if (r.formed) {
      d.log?.info?.(`bugdex: a ${e.species} nest formed`);
      noteReef(next, e.project);
      pushView({ kind: 'formed', species: e.species, name: speciesName(e.species) });
    }
  }

  /** Is this a rematch? For the battle's start (bugdex-battles.js). */
  function rematchFor(e, now = Date.now()) {
    if (!e?.project || !e.species) return null;
    return history.rematchOf(load().history, history.keyOf(e.project, e.species), now);
  }

  /**
   * The fix report for a catch, worked out once from the diff judge() passed
   * (e.fix, set in wiring/bugdex.js tryCatch) and kept for the reward.
   *   opts: { crew (helpers in the fight), failed (failing when it surfaced) }
   */
  function report(e, { crew = 0, failed = null } = {}) {
    const fix = e?.fix;
    if (!fix) return null;
    const r = fixReport({ files: fix.files, patch: fix.patch, judged: fix.judged, counts: fix.counts, enc: e, failed, crew });
    if (r && e.source) {
      reports.set(lifecycle.encId(e), r);
      while (reports.size > MAX_REPORTS) reports.delete(reports.keys().next().value);
    }
    return r;
  }

  /** A catch that counted (bugdex-reward.js): history, nests, and what it pays. r: bugdex.recordCatch's result. */
  function caught(e, r, now = Date.now()) {
    if (!e?.species) return;
    learn(e);
    const id = e.source ? lifecycle.encId(e) : null;
    const rep = (id && reports.get(id)) || report(e);
    if (id) reports.delete(id);
    const s = load();
    const key = history.keyOf(e.project, e.species);
    const again = history.rematchOf(s.history, key, now);
    const sealed = !!(again && rep?.qualities.proof);
    const next = {
      history: history.recordCatch(s.history, key, rep, now, { sealed }),
      nests: nests.onCatch(s.nests, key, rep, now, { sealed }),
    };
    save(next);
    const name = speciesName(e.species);
    const project = e.name || projectName(e.project) || null;
    if (r?.state) d.stat('bugs-caught-total', { n: bugdex.summary(r.state).caught });
    d.questDone?.('first-catch');
    if (rep?.qualities.proof) d.questDone?.('proof');
    if (isClean(rep)) {
      d.stat('clean-fix');
      d.awardXp('cleanfix', { project, label: `A clean fix: ${name}, proven by a new test` });
    }
    if (sealed) {
      d.stat('rematch-won');
      d.questDone?.('rematch');
    }
    if (next.nests[key]?.nest) noteReef(next, e.project);
    pushView(sealed ? { kind: 'sealed', species: e.species, name } : undefined);
  }

  /** Fixes that held, nests that cleared: paid once each. */
  function sweep(now = Date.now()) {
    const s = load();
    const due = history.heldDue(s.history, now);
    const out = nests.sweep(s.nests, now);
    if (!due.length && !out.cleared.length) return;
    save({ history: history.markHeld(s.history, due), nests: out.nests });
    for (const h of due) {
      const { project, species } = history.splitKey(h.key);
      d.stat('fix-held');
      d.awardXp('held', { project: projectName(project), label: `Still fixed after ${history.HELD_DAYS} days: ${speciesName(species)}` });
    }
    for (const c of out.cleared) {
      d.stat('nest-cleared');
      d.awardXp('nest', { project: projectName(c.project), label: `Cleared the ${speciesName(c.species)} nest` });
      d.questDone?.('nest');
      noteReef({ nests: out.nests }, c.project);
    }
    if (out.cleared.length && nests.totalCleared(out.nests) >= NESTS_FOR_QUEST) d.questDone?.('nests3');
    if (out.cleared.length) {
      const first = out.cleared[0];
      pushView({ kind: 'cleared', species: first.species, name: speciesName(first.species), n: out.cleared.length });
      d.notify?.(`Bugdex: the ${speciesName(first.species)} nest is cleared!`, out.cleared.length > 1 ? `And ${out.cleared.length - 1} more.` : 'It stayed fixed.', () => d.bugdex?.openPage?.(), { tone: 'celebrate', pet: true });
    } else pushView();
  }

  const guard = fn => (...args) => {
    try { return fn(...args); } catch (err) { d.log?.warn?.('bug nests', err?.message || String(err)); return null; }
  };

  d.gameHub?.register('nests', {
    get: () => view(),
    act: action => (action === 'refresh' ? view() : null),
  });

  if (!d.CAPTURE) {
    const timer = setInterval(guard(() => sweep()), SWEEP_MS);
    timer.unref?.();
    setTimeout(guard(() => sweep()), FIRST_SWEEP_MS).unref?.();
  }

  return {
    bugNests: {
      opened: guard(opened), rematchFor: guard(rematchFor), report: guard(report), caught: guard(caught),
      sweep: guard(sweep), view: guard(view),
    },
  };
}

module.exports = { wireNests };
