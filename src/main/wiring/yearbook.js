// The yearbook and Shellby Wrapped (yearbook.js, yearbook-slides.js,
// docs/WRAPPED.md). It records the year as it happens through the hooks every
// game package shares (wiring/game-hooks.js): each award paid (d.onAward), each
// achievement stat (d.onStat) and each trophy the wardrobe unlocks. On the first
// launch on or after January 2nd it tells the panel last year's Wrapped is due,
// and answers the panel through the game-hub as `wrapped` and `yearbook`.
// Kept out of main.js, which only wires it up.
const { app } = require('electron');
const yearbook = require('../yearbook');
const { slides, cardTiles } = require('../yearbook-slides');
const bugdex = require('../bugdex');
const { speciesById } = require('../bugdex/species');
const streaks = require('../progression/streaks');
const { normalizeXp } = require('../progression/xp');
const { normalizeStats } = require('../wardrobe/achievements');
const { isTestRun } = require('../test-desktop');

const FIRST_CHECK_MS = 20 * 1000;      // after launch: the panel has had time to load
const CHECK_EVERY_MS = 60 * 60 * 1000; // ...then hourly, for a PC left on over New Year
const DEEP_CUTS_LEVEL = 88;            // the wrapped-extra perk (docs/GAMIFICATION-PLAN.md 2.3)
const FOIL_LEVEL = 77;                 // the card-foil perk
const WARDROBE_LOOK_MS = 2000;         // how often to look for the wardrobe until boot has made it
const YEAR_RE = /^\d{4}$/;

/** d: what main shares (main.js `shared`): config, log, stat, gameHub, onAward, onStat, everLevel, wardrobe. */
function wireYearbook(d) {
  const testRun = isTestRun(process.env, app.isPackaged);
  let clockOffset = 0; // e2e only: dev-clock moves "now" to a January 2nd
  const now = () => new Date(Date.now() + clockOffset);

  const read = () => yearbook.normalize(d.config?.get('yearbook'));
  const write = next => {
    if (JSON.stringify(next) !== JSON.stringify(read())) d.config.set({ yearbook: next });
  };

  // Once: this year so far, from what Shellby already kept (streak days, XP for 30
  // days, the Bugdex's months and first catches). The year is marked partial.
  function backfillOnce() {
    const s = read();
    if (s.backfilled || !d.config) return s;
    const xp = normalizeXp(d.config.get('xp'));
    const bugs = bugdex.normalize(d.config.get('bugdex'));
    const stats = normalizeStats(d.config.get('stats'));
    const next = yearbook.backfill(s, {
      days: [...streaks.normalize(d.config.get('streaks')).days, ...stats.activeDays],
      medals: stats.eventMedals,
      molts: stats.molts,
      xpDaily: xp.daily,
      xpDailyKinds: xp.dailyKinds,
      bugMonths: bugs.months,
      bugFirsts: Object.values(bugs.species).filter(e => bugdex.caughtOf(e) > 0).map(e => e.first),
      level: d.everLevel?.() || 0,
    }, now());
    write(next);
    return next;
  }

  // Before any hook can fire: an award is saved (xp.daily, the Bugdex) before its
  // listeners hear it, so a backfill run from inside one would count it twice.
  try {
    if (!d.CAPTURE) backfillOnce();
  } catch (e) {
    d.log.warn('yearbook backfill failed', e?.message || String(e));
  }

  function note(event, payload) {
    if (d.CAPTURE || !d.config) return;
    hearWardrobe();
    try {
      write(yearbook.note(read(), event, payload, now()));
    } catch (e) {
      d.log.warn('yearbook note failed', e?.message || String(e));
    }
  }

  // A catch is "fresh" when it's the first of its kind ever: the Bugdex has it once.
  function freshCatch(species) {
    const entry = bugdex.normalize(d.config.get('bugdex')).species[species];
    return !!entry && bugdex.caughtOf(entry) === 1;
  }

  // Trophies come from the wardrobe, made at boot after the wiring: listen once it's there.
  let wardrobeHeard = null;
  function hearWardrobe() {
    const w = d.wardrobe;
    if (!w || wardrobeHeard === w || typeof w.on !== 'function') return;
    wardrobeHeard = w;
    w.on('unlocked', e => note('trophy', {
      id: e?.achievement?.id,
      pieces: (e?.rewards || []).filter(r => r?.kind === 'decor').map(r => r.key),
    }));
  }

  // ...and until it's there, look every couple of seconds, so an early trophy isn't missed.
  const lookForWardrobe = setInterval(() => {
    hearWardrobe();
    if (wardrobeHeard) clearInterval(lookForWardrobe);
  }, WARDROBE_LOOK_MS);
  lookForWardrobe.unref?.();

  d.onAward?.(r => note('xp', { kind: r?.kind, gained: r?.gained, project: r?.meta?.project }));
  d.onStat?.((event, payload) => {
    if (typeof event !== 'string' || event === 'wrapped-seen') return;
    const p = payload && typeof payload === 'object' ? payload : {};
    const extra = event === 'bug-caught' && typeof p.species === 'string' ? { fresh: freshCatch(p.species) } : {};
    note('stat', { event, payload: { ...p, ...extra } });
  });

  // ---------------------------------------------------------------- the views

  const level = () => d.everLevel?.() || 1;
  const listView = () => {
    const s = backfillOnce();
    return { due: yearbook.wrappedDue(s, now()), available: yearbook.available(s, now()) };
  };

  // The nemesis as the Bugdex draws it, for the slide and the card.
  function bugArt(id) {
    const sp = speciesById(id);
    if (!sp) return null;
    try {
      const entry = bugdex.normalize(d.config.get('bugdex')).species[id];
      const a = bugdex.artFor(sp, entry);
      return { pixels: [...a.pixels], palette: { ...a.palette } };
    } catch (e) {
      d.log.warn('yearbook nemesis art failed', e?.message || String(e));
      return null;
    }
  }

  const decorName = key => d.wardrobe?.item?.(key)?.name || null;
  const decorArt = key => {
    const it = d.wardrobe?.item?.(key);
    return it?.pixels ? { pixels: [...it.pixels], palette: { ...it.palette } } : null;
  };

  function yearView(year) {
    const s = backfillOnce();
    const key = String(year);
    if (!YEAR_RE.test(key) || !yearbook.available(s, now()).some(a => String(a.year) === key)) return null;
    const sum = yearbook.summary(s, key);
    const deepCuts = level() >= DEEP_CUTS_LEVEL;
    const list = slides(sum, {
      speciesName: id => speciesById(id)?.name || null,
      pieceName: decorName,
      deepCuts,
      reef: null, // the reef's biggest improvement, once reef/index.js keeps a history of readings
    }).map(sl => (sl.id === 'bugdex' && sl.nemesis ? { ...sl, nemesis: { ...sl.nemesis, art: bugArt(sl.nemesis.id) } } : sl))
      .map(sl => (sl.id === 'pieces' ? { ...sl, pieces: sl.pieces.slice(0, 12).map(p => ({ ...p, art: decorArt(p.key) })) } : sl));
    return {
      year: sum.year, since: sum.since, partial: sum.partial, shown: s.shown.includes(key),
      slides: list,
      card: {
        tiles: cardTiles(sum),
        nemesis: sum.nemesis ? { name: speciesById(sum.nemesis.id)?.name || sum.nemesis.id, art: bugArt(sum.nemesis.id) } : null,
        molts: sum.molts, foil: level() >= FOIL_LEVEL, level: sum.endLevel,
      },
    };
  }

  // Only a year that has a Wrapped, and only the first time: wrapped-seen counts years.
  function markShown(year) {
    const s = read();
    if (!yearbook.available(s, now()).some(a => String(a.year) === String(year))) return listView();
    const next = yearbook.markShown(s, year);
    if (next.shown.length === s.shown.length) return listView();
    write(next);
    d.stat?.('wrapped-seen', { n: next.shown.length });
    return listView();
  }

  // e2e only (docs/WRAPPED.md): move the clock, and fill a year to show.
  function devAct(action, payload) {
    if (!testRun) return null;
    if (action === 'dev-clock' && Number.isFinite(payload?.at)) {
      clockOffset = payload.at - Date.now();
      toldFor = null;
      checkDue(); // as the hourly check would, without the hour
      return listView();
    }
    if (action === 'dev-seed' && YEAR_RE.test(String(payload?.year))) {
      const y = Number(payload.year);
      let s = read();
      const at = (m, day, h) => new Date(y, m, day, h);
      for (let i = 0; i < 12; i++) s = yearbook.note(s, 'stat', { event: 'task-completed' }, at(i, 3 + i, 10 + (i % 8)));
      for (let i = 0; i < 6; i++) s = yearbook.note(s, 'xp', { kind: 'ship', gained: 40, project: i % 3 ? 'shellby' : 'rack-builder' }, at(i, 4, 15));
      for (const species of ['nullfish', 'nullfish', 'off-by-one']) s = yearbook.note(s, 'stat', { event: 'bug-caught', payload: { species } }, at(5, 9, 11));
      s = yearbook.note(s, 'stat', { event: 'fix-held' }, at(6, 1, 12));
      write(s);
      return listView();
    }
    return null;
  }

  d.gameHub?.register('wrapped', {
    get: arg => (arg === undefined || arg === null ? listView() : yearView(arg)),
    act: (action, payload) => {
      if (action === 'shown') return markShown(payload?.year);
      if (action === 'share') return listView(); // the card itself goes through card:save (which counts show-off)
      return devAct(action, payload);
    },
  });
  // For the Logbook: is a Wrapped waiting, and how this year is going.
  d.gameHub?.register('yearbook', {
    get: () => {
      const s = backfillOnce();
      const sum = yearbook.summary(s, now().getFullYear());
      return { ...listView(), current: sum && { year: sum.year, xp: sum.xp, activeDays: sum.activeDays, since: sum.since, partial: sum.partial } };
    },
  });

  // ---------------------------------------------------------------- January 2nd

  let toldFor = null;
  function checkDue() {
    if (d.CAPTURE || !d.config) return;
    hearWardrobe();
    const v = listView();
    if (v.due === null || v.due === toldFor) return;
    toldFor = v.due;
    d.gameHub?.push('wrapped', v, 'due');
  }
  setTimeout(checkDue, FIRST_CHECK_MS).unref?.();
  setInterval(checkDue, CHECK_EVERY_MS).unref?.();

  return { yearbookNote: note, wrappedCheck: checkDue };
}

module.exports = { wireYearbook };
