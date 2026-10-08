// Work mode: the tools up front and a quiet crab. The mirror image of just the
// crab: for developers who want Claude Code, Projects and the rest, with
// Shellby keeping himself to himself on the wallpaper.
//
// Pure: one place decides what Work mode changes, so config.js, the settings
// IPC and the panel all agree. See test/workmode.test.js.
//
// Three rules:
//   1. It's an overlay. Turning it on never writes over your own settings;
//      what you see in Work mode is worked out from them, and turning it off
//      gives you back exactly what you had.
//   2. Change one of its settings while it's on (pals, how much he talks) and
//      your choice wins over Work mode's. It's kept in `workOverrides`, so Work
//      mode remembers it next time too, and your everyday setting is untouched.
//   3. Nothing stops counting. XP, trophies, streaks and snacks still come in;
//      his needs rest instead of dropping, so he's the same crab when you're back.

// What Work mode sets, over your own settings.
const PRESET = Object.freeze({
  chatter: 'work', // only what needs you: done, failed, a dev server down (voice.js WORK_OCCASIONS)
  mischief: 'off', // no pranks
  colony: 0,       // no pals on the floor
  perch: 'off',    // off your windows
  climb: 'off',    // and off the edges of the screen
});
const KEYS = Object.freeze(Object.keys(PRESET));

// The bottom bar in Work mode, left to right: the tools first, Shellby's own
// screens last (and in Ctrl+K), never gone.
const DOCK = Object.freeze(['chat', 'projects', 'notes', 'history', 'toolbox', 'workflows', 'health', 'wardrobe']);

/** On, and not overruled by just the crab (which has no tools to put first). */
const isOn = settings => !!settings?.workMode && !settings?.crabOnly;

/** Your own choices made while in Work mode, for its keys only. */
function overridesOf(settings) {
  const raw = settings?.workOverrides;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(KEYS.filter(k => k in raw && raw[k] !== undefined).map(k => [k, raw[k]]));
}

/** Settings as they apply right now: your own, with Work mode over them when it's on. */
function effective(settings) {
  const s = settings || {};
  return isOn(s) ? { ...s, ...PRESET, ...overridesOf(s) } : s;
}

/** One setting as it applies right now (config.js get). */
function valueOf(settings, key) {
  return isOn(settings) && KEYS.includes(key) ? effective(settings)[key] : settings?.[key];
}

/**
 * What to save for a change from the panel. Work mode and just the crab rule
 * each other out; while Work mode is on, its keys go to `workOverrides`
 * instead of your own settings. Picking Work mode's own value drops the
 * override, so the list only holds what you really changed. Returns a new patch.
 */
function write(settings, patch) {
  const s = settings || {};
  const out = { ...(patch || {}) };
  if (out.workMode === true) out.crabOnly = false;
  if (out.crabOnly === true) out.workMode = false;
  if (!isOn({ ...s, ...out })) return out;
  const touched = KEYS.filter(k => k in out);
  if (!touched.length) return out;
  const overrides = { ...overridesOf(s) };
  for (const k of touched) {
    if (out[k] === PRESET[k]) delete overrides[k];
    else overrides[k] = out[k];
    delete out[k];
  }
  return { ...out, workOverrides: overrides };
}

/**
 * Everything else Work mode changes, that isn't a setting of its own:
 *   needsRest:  his needs pause instead of dropping (care.js)
 *   dropIns:    friends' crabs may drop in on their own (friends.js); an invite still works
 *   confetti:   bursts on the desktop; off, a celebration is just his little hop
 *   petToasts:  Windows notifications for trophies, level-ups and stickers
 *   dock:       the bottom bar's order, or null for the usual one
 */
function behaviour(settings) {
  const on = isOn(settings);
  return { on, needsRest: on, dropIns: !on, confetti: !on, petToasts: !on, dock: on ? DOCK : null };
}

/** behaviour() for anything holding a config (or a stand-in with get). */
const behaviourOf = config => behaviour({ workMode: config?.get('workMode'), crabOnly: config?.get('crabOnly') });

// Shellby's three modes, for the one switch between them (his right-click
// menu, the tray, Ctrl+K and Settings): Claude Code with a lively crab, Work
// mode, or just the crab.
const MODE_IDS = Object.freeze(['claude', 'work', 'crab']);

/** Which of the three is on. */
function modeOf(settings) {
  if (settings?.crabOnly) return 'crab';
  return isOn(settings) ? 'work' : 'claude';
}

/**
 * Leaving just the crab for a mode with tasks needs Claude Code first: here
 * and signed in, or on another computer. status: the Claude status (installed, loggedIn).
 */
function needsSetup(settings, status, id) {
  if (id === 'crab' || !settings?.crabOnly || settings?.claudeElsewhere) return false;
  return !(status?.installed && status?.loggedIn);
}

module.exports = { PRESET, KEYS, DOCK, MODE_IDS, modeOf, needsSetup, isOn, overridesOf, effective, valueOf, write, behaviour, behaviourOf };
