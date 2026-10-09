// The areas with state of their own: your plan's usage, work held for after
// the reset, routines, noticing you're away, stickers and the copies tabs work
// in. Each is given exactly what it uses. Most of that only exists once
// Shellby has booted (or is another area's export, wired after this one), so
// it goes as a getter, read when it's used.
// Kept out of main.js, which only wires it up.
const { app, powerMonitor, powerSaveBlocker } = require('electron');
const { createUsage } = require('../usage/service');
const { createHeldQueue } = require('../held-service');
const { createRoutines } = require('../routines/service');
const { createAway } = require('../away-service');
const { createStickers } = require('../stickers/service');
const { createCopies } = require('../copy-service');
const confirm = require('../confirm');
const native = require('../native-windows');

/** d: what main shares (main.js `shared`). */
function wireServices(d) {
  const { CAPTURE, isFolder, isStr, log, randomUUID } = d;
  // Dev/e2e only: 5-hour readings from dev:usage, backdated so a pace builds up
  // without an hour's wait, and held work going a second after the reset.
  const FORECAST_TEST = !app.isPackaged && process.env.SHELLBY_FORECAST_TEST === '1';
  // Held work goes a minute after the reset, so the server has rolled over too.
  const HELD_GRACE_MS = FORECAST_TEST ? 1000 : 60 * 1000;
  // Dev/e2e only: the idle readings come from dev:away instead of Windows.
  const RECAP_TEST = !app.isPackaged && process.env.SHELLBY_RECAP_TEST === '1';

  // main's own helpers, and the panel's (wiring/panel.js), whenever that is wired.
  const send = (...a) => d.send(...a);
  const showPanel = (...a) => d.showPanel(...a);
  const every = (...a) => d.every(...a);

  const usageService = createUsage({
    log, send, showPanel, every, powerMonitor,
    get config() { return d.config; },
    get panel() { return d.panel; },
    get manager() { return d.manager; },
    get workflows() { return d.workflows; },
    get recapLog() { return awayService.recapLog; },
    get history() { return d.history; },
    get usagePlan() { return d.usagePlan; },
    get notify() { return d.notify; },
    get refreshCritter() { return d.refreshCritter; },
    get flashState() { return d.flashState; },
    get tellChannel() { return d.tellChannel; },
    get sayText() { return d.sayText; },
    get sendEveryWindow() { return d.sendEveryWindow; },
    markActive: () => { d.lastActivity = Date.now(); },
    routines: () => routineService.routines(),
    heldViews: () => heldService.heldViews(),
  });
  const heldService = createHeldQueue({
    log, send, showPanel, isFolder, isStr, randomUUID, confirm, powerSaveBlocker, CAPTURE, graceMs: HELD_GRACE_MS,
    get config() { return d.config; },
    get panel() { return d.panel; },
    get tabWindow() { return d.tabWindow; },
    get manager() { return d.manager; },
    get history() { return d.history; },
    get claudeStatus() { return d.claudeStatus; },
    get notify() { return d.notify; },
    get tellChannel() { return d.tellChannel; },
    get noteRecap() { return d.noteRecap; },
    get wake() { return d.wake; },
    get openTab() { return d.openTab; },
    get sendToTab() { return d.sendToTab; },
    get currentCwd() { return d.currentCwd; },
    get dialogLook() { return d.dialogLook; },
    get adoptPhoneTab() { return d.adoptPhoneTab; },
    worktreeHome: () => d.worktreeHome(),
    limitWait: usageService.limitWait, resetTarget: usageService.resetTarget,
    clockTime: usageService.clockTime, sendOutlook: usageService.sendOutlook,
    routines: () => routineService.routines(),
    routinesView: () => routineService.routinesView(),
    runRoutine: (r, opts) => routineService.runRoutine(r, opts),
    makeRoomForRoutine: () => routineService.makeRoomForRoutine(),
  });
  const routineService = createRoutines({
    log, send, showPanel, isFolder, randomUUID, confirm,
    get config() { return d.config; },
    get panel() { return d.panel; },
    get manager() { return d.manager; },
    get history() { return d.history; },
    get usagePlan() { return d.usagePlan; },
    get claudeStatus() { return d.claudeStatus; },
    get remote() { return d.remote; },
    get notify() { return d.notify; },
    get sayText() { return d.sayText; },
    get wake() { return d.wake; },
    get openTab() { return d.openTab; },
    get currentCwd() { return d.currentCwd; },
    get stat() { return d.stat; },
    get dialogLook() { return d.dialogLook; },
    get runClaudeOnce() { return d.runClaudeOnce; },
    get knownProjects() { return d.knownProjects; },
    limitWait: usageService.limitWait, guardSettings: usageService.guardSettings, clockTime: usageService.clockTime,
    heldList: heldService.heldList, holdForReset: heldService.holdForReset, scheduleHeld: heldService.scheduleHeld,
    syncKeepAwake: heldService.syncKeepAwake, queueTabs: heldService.queueTabs,
  });
  const awayService = createAway({
    log, send, showPanel, every, powerMonitor, native, confirm, CAPTURE, RECAP_TEST,
    get config() { return d.config; },
    get critter() { return d.critter; },
    get panel() { return d.panel; },
    get manager() { return d.manager; },
    get external() { return d.external; },
    get devServers() { return d.devServers; },
    get speak() { return d.speak; },
    get notify() { return d.notify; },
    get dialogLook() { return d.dialogLook; },
    get tankGauges() { return d.tankGauges; },
    limitWait: usageService.limitWait,
  });
  const stickerService = createStickers({
    log, send, showPanel, CAPTURE,
    get config() { return d.config; },
    get critter() { return d.critter; },
    get panel() { return d.panel; },
    get workflows() { return d.workflows; },
    get notify() { return d.notify; },
    get flashState() { return d.flashState; },
    get sayText() { return d.sayText; },
    get broadcastSkin() { return d.broadcastSkin; },
    get currentLevel() { return d.currentLevel; },
    get activeSkin() { return d.activeSkin; },
    get githubEndpoints() { return d.githubEndpoints; },
    get noteWeek() { return d.noteWeek; },
    get stickersView() { return d.stickersView; },
    get stickerStats() { return d.stickerStats; },
  });
  const copyService = createCopies({
    log, isStr, CAPTURE, worktreeHome: () => d.worktreeHome(), claudeConfigDir: () => d.claudeConfigDir(),
    routineTabs: routineService.routineTabs, queueTabs: heldService.queueTabs, queueWaits: heldService.queueWaits,
    get config() { return d.config; },
    get manager() { return d.manager; },
    get history() { return d.history; },
    get remote() { return d.remote; },
    get turnStarts() { return d.turnStarts; },
  });

  // wiring/ reaches the services whole (d.usageService.limitWait()); the flat
  // names are what ipc/ and main read.
  const { checkLimit, onUsage, outlookView, projectKeyOf, refreshOutlook, saveSpend, sendOutlook, spendSource, tabCost, usageBreakdown, watchGuards, watchOutlook, windowShare } = usageService;
  const { heldList, holdForReset, queueTabs, queueTask, queueWaits, reopenForHeld, saveHeld, scheduleHeld, syncKeepAwake } = heldService;
  const { chatRoutine, draftRoutine, repairRoutine, routineTabs, routineTestView, routineTests, routines, routinesView, runRoutine, saveRoutines, startScheduler, testRoutine } = routineService;
  const { checkAway, checkLeavingSoon, isAway, noteRecap, watchAway, watchLeaving } = awayService;
  const { shellIdOf, shellStickers, shipped, stickerState } = stickerService;
  const { changeRef, retireWorktree } = copyService;
  return {
    FORECAST_TEST, RECAP_TEST, awayService, copyService, heldService, routineService, stickerService, usageService,
    checkLimit, onUsage, outlookView, projectKeyOf, refreshOutlook, saveSpend, sendOutlook, spendSource, tabCost, usageBreakdown, watchGuards, watchOutlook, windowShare,
    heldList, holdForReset, queueTabs, queueTask, queueWaits, reopenForHeld, saveHeld, scheduleHeld, syncKeepAwake,
    chatRoutine, draftRoutine, repairRoutine, routineTabs, routineTestView, routineTests, routines, routinesView, runRoutine, saveRoutines, startScheduler, testRoutine,
    checkAway, checkLeavingSoon, isAway, noteRecap, watchAway, watchLeaving,
    shellIdOf, shellStickers, shipped, stickerState,
    changeRef, retireWorktree,
  };
}

module.exports = { wireServices };
