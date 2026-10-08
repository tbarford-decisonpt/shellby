// The real moon: its phase tonight, worked out from the clock alone. The phase
// is the same everywhere on Earth, so this needs no location and nothing
// leaves your PC. Some finds only turn up under a full or a new moon
// (gifts.js), and the beach's night sky shows the moon as it really is.
//
// Pure: no I/O, no clock (callers pass `now`). See test/moon.test.js.

const DAY = 24 * 60 * 60 * 1000;
const SYNODIC = 29.530588853;             // days from one new moon to the next, on average
const KNOWN_NEW = Date.UTC(2000, 0, 6, 18, 14); // a new moon to count from
// How close to the exact moment still counts. The real orbit drifts up to about
// half a day from this average, so a day either side keeps it honest.
const WINDOW_DAYS = 1;

const NAMES = Object.freeze(['new moon', 'waxing crescent', 'first quarter', 'waxing gibbous', 'full moon', 'waning gibbous', 'last quarter', 'waning crescent']);

/**
 * The moon at `now`: { age (days since new), fraction (0 new, 0.5 full, back to 1),
 * lit (0..1 of the face lit), waxing, name, special: 'full' | 'new' | null }.
 */
function phase(now) {
  const t = Number(now);
  const days = Number.isFinite(t) ? (t - KNOWN_NEW) / DAY : 0;
  const age = ((days % SYNODIC) + SYNODIC) % SYNODIC;
  const fraction = age / SYNODIC;
  const lit = (1 - Math.cos(2 * Math.PI * fraction)) / 2;
  const half = SYNODIC / 2;
  const special = Math.abs(age - half) <= WINDOW_DAYS ? 'full' : age <= WINDOW_DAYS || SYNODIC - age <= WINDOW_DAYS ? 'new' : null;
  return { age, fraction, lit, waxing: fraction < 0.5, name: NAMES[Math.round(fraction * 8) % 8], special };
}

/** 'full', 'new' or null: whether tonight is a full or a new moon. */
const special = now => phase(now).special;

module.exports = { phase, special, SYNODIC, KNOWN_NEW, WINDOW_DAYS, NAMES };
