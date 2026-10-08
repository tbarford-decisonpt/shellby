// What you use: how often you open each of the panel's screens, counted on
// this PC and never sent anywhere (it isn't one of the settings Sync carries).
// Settings → General → What you use reads it back: the screens you live in,
// and the ones you've never opened, each with a line on what it's for. Only
// known screens count, a visit at a time. Pure: no I/O. See
// test/feature-use.test.js.
const { ROOMS } = require('./rooms');

// Every screen worth counting: the rooms, plus the ones that are always there
// or sit one level down. Settings and onboarding aren't features.
const SCREENS = Object.freeze([
  { id: 'chat', name: 'Chat', text: 'Where you and Claude work.' },
  ...ROOMS.map(({ id, name, text, in: inside }) => ({ id, name, text, ...(inside ? { in: inside } : {}) })),
  { id: 'wardrobe', name: 'Outfits', text: 'His wardrobe: hats, shells and colours, more as he levels up.' },
  { id: 'shop', in: 'toolbox', name: 'Skill Shop', text: 'Plugins with skills, agents and tools to add to Claude Code.' },
  { id: 'routines', in: 'workflows', name: 'Routines', text: 'A prompt that runs on a schedule, or Claude cloud routines.' },
  { id: 'time', in: 'history', name: 'Time', text: 'Hours per project from your conversations, for a timesheet.' },
]);
const BY_ID = new Map(SCREENS.map(s => [s.id, s]));
// Opened in the last this-many days counts as still in use.
const DORMANT_DAYS = 30;
const DAY = 86400000;

const count = n => Math.max(0, Math.floor(Number(n) || 0));
const time = t => (Number.isFinite(t) && t > 0 ? t : 0);

/** A stored value made safe: { since, views: { id: { n, last } } }. */
function normalize(v) {
  const views = {};
  const raw = v && typeof v === 'object' && v.views && typeof v.views === 'object' ? v.views : {};
  for (const id of Object.keys(raw)) {
    if (!BY_ID.has(id)) continue;
    const n = count(raw[id]?.n);
    if (n) views[id] = { n, last: time(raw[id]?.last) };
  }
  return { since: time(v?.since), views };
}

/** A visit to screen `id` at `now`. Unknown screens leave it as it was. */
function record(v, id, now) {
  const s = normalize(v);
  if (!BY_ID.has(id)) return s;
  const was = s.views[id];
  return { since: s.since || now, views: { ...s.views, [id]: { n: (was?.n || 0) + 1, last: now } } };
}

/**
 * What Settings shows: `used` most-opened first, `quiet` opened but not for
 * DORMANT_DAYS, `never` not opened since counting began. Each has id, name and
 * text (and `in`, the screen it's a tab of); used and quiet also n and last.
 */
function report(v, now) {
  const s = normalize(v);
  const visited = SCREENS.filter(x => s.views[x.id]).map(x => ({ ...x, ...s.views[x.id] }));
  const isQuiet = x => now - x.last > DORMANT_DAYS * DAY;
  return {
    since: s.since || null,
    used: visited.filter(x => !isQuiet(x)).sort((a, b) => b.n - a.n || b.last - a.last),
    quiet: visited.filter(isQuiet).sort((a, b) => b.last - a.last),
    never: SCREENS.filter(x => !s.views[x.id]),
  };
}

module.exports = { SCREENS, DORMANT_DAYS, normalize, record, report };
