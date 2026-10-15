// What a test run does about the desktop it happens to be on. Three kinds of thing make the
// e2e checks depend on what's open that minute, and CI's empty desktop has neither:
//
//  1. Chromium stops painting a window it thinks is covered, and the crab sits in
//     the desktop layer behind your apps, so his page goes `hidden` and
//     Page.captureScreenshot waits for a frame that never comes (keepPainting).
//  2. Shellby itself hides or quiets the crab when a game, or any window you're
//     in, covers him (wiring/windows.js checkCovered), and he hushes when something
//     holds the microphone (life.js). A check that expects him to
//     speak or be seen then fails for want of an empty corner (watchesDesktop).
//  3. An e2e run's windows would sit on the screen you're using: a check that
//     maximizes the panel covered it, a shown window took the focus from your app,
//     and your mouse over them reached the page mid-drag (e2e-panes). In an e2e run
//     (SHELLBY_E2E=1) every window lives off every screen instead, shows without
//     activating, keeps its focus in Shellby's books, and "maximizes" to the work
//     area's size out there (offscreen-windows.js, keepsOffScreen). The scripts
//     drive them over CDP, which needs no screen. Not with SHELLBY_COVER_POLL=1:
//     e2e-on-top puts a real Notepad over the crab, so his windows stay real.
//
// Only for the fake-CLI, motion-test, fake-health and SHELLBY_E2E=1 runs (e2e-ci.js sets
// the last for every check), never a packaged app or a dev run
// you're using. SHELLBY_COVER_POLL=1 keeps the watching for a check that is about
// it (e2e-on-top, with a real Notepad in front). SHELLBY_REAL_DESKTOP=1 turns all of
// this off for a run that measures him as he really is (idle-cost.js, perf-budget.js):
// covered, away and the mic read are the savings it is there to see.
const SWITCHES = [
  ['disable-features', 'CalculateNativeWinOcclusion'], // stop counting windows as covered
  ['disable-backgrounding-occluded-windows'],
];

function isTestRun(env, isPackaged) {
  if (isPackaged || env.SHELLBY_REAL_DESKTOP === '1') return false;
  return !!(env.SHELLBY_FAKE_CLAUDE || env.SHELLBY_MOTION_TEST === '1' || env.SHELLBY_FAKE_HEALTH || env.SHELLBY_E2E === '1');
}

/** Before the app is ready. -> true if the switches were added. */
function keepPainting(app, env = process.env) {
  if (!isTestRun(env, app.isPackaged)) return false;
  for (const sw of SWITCHES) app.commandLine.appendSwitch(...sw);
  return true;
}

/** Should he keep asking what's in front of him? No, in a test run, unless it asks to. */
function watchesDesktop(env = process.env, isPackaged = false) {
  return !isTestRun(env, isPackaged) || env.SHELLBY_COVER_POLL === '1';
}

/**
 * Should every window live off screen, shown inactive, with focus kept in Shellby's
 * books (offscreen-windows.js)? Only in an e2e run (SHELLBY_E2E=1) that doesn't watch
 * the desktop: a dev run with the fake CLI is one you click in.
 */
function keepsOffScreen(env = process.env, isPackaged = false) {
  return isTestRun(env, isPackaged) && env.SHELLBY_E2E === '1' && env.SHELLBY_COVER_POLL !== '1';
}

module.exports = { keepPainting, watchesDesktop, keepsOffScreen, isTestRun, SWITCHES };
