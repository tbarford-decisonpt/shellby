// Every IPC handler, registered once at boot behind the window check. Most
// areas have a module of their own here; Lean Shell, skill removal, Mods,
// parity and team packs register themselves, given what they use.
// Kept out of main.js, which only calls it.
const { app, clipboard, dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run: runCli } = require('../claude/cli');
const claudeSetup = require('../claude/setup');
const confirm = require('../confirm');
const editor = require('../editor');
const { guardIpc, windowPolicy } = require('../ipc-guard');
const { createLean } = require('../lean');
const { createModsService } = require('../mods-service');
const parity = require('../parity');
const { createSkillRemover } = require('../skillremove');
const { loadSkins } = require('../skins');
const stickers = require('../stickers');
const teamIpcModule = require('../team-ipc');
const voice = require('../voice');
const { registerHistoryIpc, clearQuestion } = require('./history');
const { registerWardrobeIpc } = require('./wardrobe');
const { registerTankIpc } = require('./tank');
const { registerTankGaugesIpc } = require('./tank-gauges');
const { registerTankLayoutsIpc } = require('./tank-layouts');
const { registerTankTidyIpc } = require('./tank-tidy');
const { registerCritterIpc } = require('./critter');
const { registerLifeIpc } = require('./life');
const { registerPanelIpc } = require('./panel');
const { registerFilesIpc } = require('./files');
const { registerTabsIpc } = require('./tabs');
const { registerHandoffIpc } = require('./handoff');
const { registerRemoteIpc } = require('./remote');
const { registerRepoIpc } = require('./repo');
const { registerSettingsIpc } = require('./settings');
const { registerToolboxIpc } = require('./toolbox');
const { registerRoutinesIpc } = require('./routines');
const { registerGithubIpc } = require('./github');
const { registerGitlabIpc } = require('./gitlab');
const { registerProgressIpc } = require('./progress');
const { registerSurroundingsIpc } = require('./surroundings');
const { registerTriesIpc } = require('./tries');
const { registerCorrectionsIpc } = require('./corrections');
const { registerStartFromIpc } = require('./startfrom');
const { registerBacklogIpc } = require('./backlog');
const { registerProjectToolsIpc } = require('./project-tools');
const { registerNotesIpc } = require('./notes');
const { registerCrewIpc } = require('./crew');
const { registerNativeIpc } = require('./native');
const { registerReleasesIpc } = require('../projects/releases-ipc');

/**
 * electronIpcMain: Electron's own. d: what main shares (main.js `shared`);
 * this sets d.lean, d.parityIpc and d.teamIpc.
 */
function registerIpc(electronIpcMain, d) {
  // Every handler (here, in ipc/, and parity's and branching's) checks which
  // window is asking: the crab's gets only its own channels, other windows nothing.
  const ipcMain = guardIpc(electronIpcMain, windowPolicy(() => ({
    panel: d.panel && !d.panel.isDestroyed() ? d.panel.webContents : null,
    critter: d.critter && !d.critter.isDestroyed() ? d.critter.webContents : null,
    isPopout: wc => !!d.isPopout?.(wc),
    isToy: wc => !!d.playtime?.isToy(wc),
    isFloor: wc => !!d.floor?.isFloor(wc),
    isNote: wc => !!d.pranks?.isNote(wc),
  })), { onRefused: channel => d.log.warn('IPC refused', channel) });
  const { config, log } = d;
  // Claude Code's own CLI, for parity and team packs: the one in use now (main.js claudeExe).
  const runClaude = (args, timeout, opts) => {
    const exe = d.claudeExe();
    return exe ? runCli(exe, args, timeout, opts) : Promise.resolve({ ok: false, notInstalled: true, stdout: '', stderr: '' });
  };
  const lean = d.lean = createLean({
    config, shop: () => d.shop, shopBlocked: d.shopBlocked, askOnce: d.askOnce, toolbox: () => d.toolbox, setupWhere: d.setupWhere, configDir: d.claudeConfigDir, awardXp: d.awardXp, log,
    memory: () => claudeSetup.scanMemory(d.setupWhere()),
    projectOf: tab => { const s = d.spendSource(tab); return s.pk ? { key: s.pk, name: s.project } : null; },
    currentProject: () => path.resolve(d.currentCwd()).toLowerCase(),
  });
  lean.register(ipcMain);
  createSkillRemover({
    toolbox: () => d.toolbox, askOnce: d.askOnce, log, stat: d.stat,
    // The folders the Toolbox scans (ToolboxWatcher's home and getCwd).
    where: () => ({ home: os.homedir(), cwd: d.currentCwd() }),
    trash: p => shell.trashItem(p),
    usage: () => lean.usage(),
    unpin: (kind, name) => config.set({ pinnedTools: (config.get('pinnedTools') || []).filter(p => !(p?.kind === kind && p?.name === name)) }),
  }).register(ipcMain);
  // Toolbox → Mods (mods-service.js): the CLI runs in the shop's empty folder.
  createModsService({
    toolbox: () => d.toolbox, shop: () => d.shop, askOnce: d.askOnce, home: os.homedir(), log,
    // Just-the-crab mode leaves Claude Code alone, mods' checks and tests included.
    blocked: () => (config.get('crabOnly') ? { ok: false, error: 'Mods need Claude Code. Turn it on in Settings.' } : null),
    runClaude: (args, timeout) => {
      const exe = d.claudeExe();
      if (!exe) return Promise.resolve({ ok: false, notInstalled: true, stdout: '', stderr: '' });
      const cwd = path.join(app.getPath('userData'), 'plugin-cli');
      try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* execFile reports it */ }
      return runCli(exe, args, timeout, { cwd });
    },
    uninstallPlugin: id => d.confirmAndUninstallPlugin(id),
    trash: p => shell.trashItem(p),
    openFolder: dir => editor.openFolder(dir),
    reveal: dir => { shell.openPath(dir); },
  }).register(ipcMain);
  d.parityIpc = parity.register({
    ipcMain, manager: d.manager, history: d.history, config, confirm, dialog, clipboard, app,
    panel: () => d.panel, dialogLook: d.dialogLook, changeRef: d.changeRef, setupWhere: d.setupWhere, setupView: d.setupView, currentCwd: d.currentCwd,
    toolbox: () => d.toolbox, lastInit: () => d.lastInit, stat: d.stat, correctionFromTurns: d.correctionFromTurns, noteCorrection: d.noteCorrection,
    noteUndone: n => d.noteWeek('undone', null, n),
    turnEnding: tabId => d.turnEnds.get(tabId) || Promise.resolve(),
    dataDir: app.getPath('userData'),
    runClaude, log,
  });
  d.teamIpc = teamIpcModule.register({
    ipcMain, config, shell, home: os.homedir(), panel: () => d.panel, send: d.send, currentCwd: d.currentCwd, stat: d.stat,
    ownSnippets: d.snippetList, pushSnippets: () => d.send(d.panel, 'snippets', d.snippetsView()),
    workflows: () => (config.get('crabOnly') ? null : d.workflows),
    setupView: d.setupView, setupWhere: d.setupWhere, saveHook: req => d.confirmAndChangeHook(req, false), saveRule: req => d.parityIpc.changeRule(req),
    confirm: spec => confirm.ask(d.panel, { ...d.dialogLook(), ...spec }),
    runClaude,
    log: { warn: msg => log.warn('team pack', msg) },
  });
  // ---- history (ipc/history.js)
  registerHistoryIpc(ipcMain, {
    history: d.history, manager: d.manager, openTab: d.openTab, log,
    isPoppedOut: id => d.isPoppedOut(id), showPopout: id => d.showPopout(id),
    onCleared: () => d.usagePlan.clear(), // what each turn cost goes with the conversations
    confirmClear: async (count, openCount) => {
      const r = await dialog.showMessageBox(d.panel, {
        type: 'warning', buttons: ['Clear all history', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
        ...clearQuestion(count, openCount),
      });
      return r.response === 0;
    },
  });

  // ---- skins, the wardrobe and outfit codes (ipc/wardrobe.js)
  registerWardrobeIpc(ipcMain, {
    wardrobe: () => d.wardrobe,
    builtinSkins: () => d.skins.map(s => ({ id: s.id, name: s.name })),
    allSkins: d.allSkins, activeSkin: d.activeSkin, config, voice, confirmAndInstallPackText: d.confirmAndInstallPackText, installFromRegistry: d.installFromRegistry,
    registryUrl: d.registryUrl, broadcastSkin: d.broadcastSkin, userSkinsDir: d.userSkinsDir,
    reloadSkins: () => { d.skins = loadSkins(d.userSkinsDir()); d.wardrobe?.load(); d.broadcastWardrobe(); return d.allSkins(); },
    clearBackground: () => { d.external?.clearBackground(); return d.externalView(); },
    pickPackFile: async () => {
      const r = await dialog.showOpenDialog(d.panel, { title: 'Install a Shellby wardrobe pack', filters: [{ name: 'Shellby pack', extensions: ['json'] }], properties: ['openFile'] });
      return r.canceled ? null : r.filePaths[0] || null;
    },
    openPath: p => shell.openPath(p),
  });

  // ---- his tank (tank.js, ipc/tank.js): decor from the wardrobe, his finds, where they stand
  const tankIpc = registerTankIpc(ipcMain, {
    config, stat: d.stat,
    speak: (occasion, opts) => d.speak?.(occasion, opts),
    life: () => d.life,
    wardrobe: () => d.wardrobe,
    level: () => d.currentLevel(),
    shipped: () => stickers.stats(d.stickerState()).stickers,
    cardChanged: () => d.friends?.republish().catch(() => {}),
  });
  d.tankRemark = tankIpc.remark; // a word about his tank for the desktop (life.js)
  // ...its saved layouts, and switching with the seasons (tank-layouts.js)
  registerTankLayoutsIpc(ipcMain, { config, tank: tankIpc, where: () => d.seasonsWhere?.() || {}, ready: () => !!d.wardrobe, now: () => d.today().getTime() });
  // ...him tidying his finds now and then (tank-tidy.js)
  registerTankTidyIpc(ipcMain, { config, tank: tankIpc, ready: () => !!d.wardrobe });
  // ...and its live decor: Health and the dev servers, pushed as they change (tank-gauges.js)
  d.tankGauges = registerTankGaugesIpc(ipcMain, {
    config,
    toPanel: (channel, payload) => { if (d.panel && !d.panel.isDestroyed() && d.panel.isVisible()) d.send(d.panel, channel, payload); },
    health: () => d.health,
    moodsOn: () => d.health?.settings?.moods !== false,
    servers: () => d.devServers?.summary() || null,
  });

  // The rest, one area per module in ipc/.
  registerCritterIpc(ipcMain, d);
  registerLifeIpc(ipcMain, d);
  registerPanelIpc(ipcMain, d);
  registerFilesIpc(ipcMain, d);
  registerTabsIpc(ipcMain, d);
  registerHandoffIpc(ipcMain, d);
  registerRemoteIpc(ipcMain, d);
  registerRepoIpc(ipcMain, d);
  registerSettingsIpc(ipcMain, d);
  registerToolboxIpc(ipcMain, d);
  registerRoutinesIpc(ipcMain, d);
  registerGithubIpc(ipcMain, d);
  registerGitlabIpc(ipcMain, d);
  registerProgressIpc(ipcMain, d);
  registerSurroundingsIpc(ipcMain, d);
  registerTriesIpc(ipcMain, d);
  registerCorrectionsIpc(ipcMain, d);
  registerStartFromIpc(ipcMain, d);
  registerBacklogIpc(ipcMain, d);
  registerProjectToolsIpc(ipcMain, d);
  registerNotesIpc(ipcMain, d);
  registerCrewIpc(ipcMain, d);
  registerNativeIpc(ipcMain, d);
  registerReleasesIpc(ipcMain, d);
}

module.exports = { registerIpc };
