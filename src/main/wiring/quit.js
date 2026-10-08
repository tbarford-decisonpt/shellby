// Quitting: what has to stop, and in what order, so nothing he started is left
// running and nothing fires into a half-torn-down app. Closing his last window
// isn't quitting: he lives in the tray.
// Kept out of main.js, which only wires it up.
const { app, globalShortcut } = require('electron');
const crashReport = require('../crash-report');
const statusLine = require('../statusline');

/** d: what main shares (main.js `shared`). Registers app's quit events at once. */
function wireQuit(d) {
  app.on('window-all-closed', e => e.preventDefault());
  app.on('will-quit', () => {
    d.typing?.stop(); // lets go of the keyboard (keystrokes.js)
    statusLine.clearStatus(d.statusFile()); // Claude Code's status line goes quiet when Shellby does
    globalShortcut.unregisterAll();
    d.routineService.stop();
    if (d.config) d.saveSpend();
    if (d.config) d.usagePlan.save();
    d.lean?.save();
    d.toolbox?.stop();
    d.health?.stop();
    d.timeTracker?.stop(); // writes the last minutes down
    d.depWatch?.stop();
    d.external?.stop();
    d.github?.stop();
    d.friends?.stop();
    d.life?.stop();
    d.playtime?.stop();
    d.pranks?.dispose();
    d.floor?.dispose();
    d.ci?.stop();
    clearTimeout(d.focusTimer);
    clearInterval(d.focusTick);
    d.usageService.stop(); // the reset tap
    d.repeating.forEach(clearInterval);
    d.remote?.shutdown();
    d.dictation?.stop();
    d.media?.stop(); // its PowerShell loop never reads stdin, so it won't notice we've gone
    if (d.PRIMARY && !d.CAPTURE) crashReport.endRun(d.LOG_DIR); // quit on purpose: nothing to report next time
  });
  // close() gives a process 3 s to finish on its own, which Shellby quitting never
  // waits for: one mid-task would carry on editing with no window to show it.
  // Workflows freeze first: a run cut off by quitting is resumable, not failed.
  app.on('before-quit', () => {
    app.isQuitting = true;
    d.journal.savePending();
    d.remote?.shutdown(); // no task from the phone starts while he's on his way out
    d.presence?.stop();   // Discord clears his activity as the pipe closes
    d.workflows?.shutdown();
    d.manager?.closeAll({ kill: true });
    d.cancelAllChecks(); // a test run Shellby started ends with him
    // Quits that didn't come through quit() (Windows shutting down, say):
    // "Stop them" still holds. taskkill runs on its own, so Shellby exiting
    // can't cut it off halfway down the tree, and the servers are saved as gone.
    const { devServers } = d;
    if (devServers?.view().settings.onQuit === 'stop') devServers.stopAll({ detached: true }).catch(err => d.log.warn('dev servers could not be stopped at quit', err?.message));
    devServers?.shutdown();
  });
}

module.exports = { wireQuit };
