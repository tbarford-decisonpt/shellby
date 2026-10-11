// What a test run does about the desktop it happens to be on. Two kinds of thing make the
// e2e checks depend on what's open that minute, and CI's empty desktop has neither:
//
//  1. Chromium stops painting a window it thinks is covered, and the crab sits in
//     the desktop layer behind your apps, so his page goes `hidden` and
//     Page.captureScreenshot waits for a frame that never comes (keepPainting).
//  2. Shellby itself hides or quiets the crab when a game, or any window you're
//     in, covers him (wiring/windows.js checkCovered), and he hushes when something
//     holds the microphone (life.js). A check that expects him to
//     speak or be seen then fails for want of an empty corner (watchesDesktop).
//  3. A check that maximizes the panel covers the screen you're using, and your
//     mouse moving anywhere on it reaches the page in the middle of a scripted
//     drag: the dragged tab or pane line follows your pointer instead
//     (e2e-panes). The scripts press and move over CDP, which Windows'
//     hit-testing never sees, so in an e2e run the panel and a conversation's
//     own window let the real mouse through (ignoresRealMouse).
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
 * Should the panel and a conversation's own window let the real mouse through?
 * Only in an e2e run (SHELLBY_E2E=1): a dev run with the fake CLI is one you click in.
 */
function ignoresRealMouse(env = process.env, isPackaged = false) {
  return isTestRun(env, isPackaged) && env.SHELLBY_E2E === '1';
}

module.exports = { keepPainting, watchesDesktop, ignoresRealMouse, isTestRun, SWITCHES };
