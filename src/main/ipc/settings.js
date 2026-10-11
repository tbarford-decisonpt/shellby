// Settings: reading and changing them, the folder Claude works in, and what a
// change has to confirm first. Kept out of main.js, which only wires it up.
const { dialog } = require('electron');
const fs = require('fs');
const attach = require('../attachments');
const { TIMEOUTS_MIN } = require('../checks');
const { setPlanOnly } = require('../claude/cli');
const { SETTINGS: CLIMB_SETTINGS } = require('../climb');
const { MODES } = require('../config');
const confirm = require('../confirm');
const crashReport = require('../crash-report');
const { COLONY_MAX } = require('../floor');
const filelinks = require('../filelinks');
const guard = require('../guard');
const mischief = require('../mischief');
const { isModel } = require('../models');
const outputStyles = require('../outputstyles');
const { SETTINGS: PERCH_SETTINGS } = require('../perch');
const { EFFORTS } = require('../session');
const sounds = require('../sounds');
const shortcuts = require('../../renderer/panel/shortcuts'); // the panel's table: what your own keys are checked against
const syncPrefs = require('../sync-prefs');
const voice = require('../voice');
const workmode = require('../workmode');

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerSettingsIpc(ipcMain, d) {
  // ---- settings
  /**
   * What a saved change sets going: the hotkey's already in place, the rest
   * (sounds, his layer, Work mode, the session's mode...) follows here.
   * allowed: what was saved. asked: what changed as you see it (before Work
   * mode moved it to workOverrides). before: config.data before the save.
   */
  function applied(allowed, asked, before, { taste = false } = {}) {
    const workSwitched = workmode.isOn(before) !== workmode.isOn({ ...before, ...allowed });
    const eff = workmode.effective({ ...before, ...allowed });
    const changed = k => k in asked || (workSwitched && workmode.KEYS.includes(k));
    // Told to stay down, he hops down off any window rather than freezing up there.
    if (allowed.wander === false || (changed('perch') && eff.perch === 'off')) d.perching?.leave('off');
    if (allowed.wander === false || (changed('climb') && eff.climb === 'off')) d.climbing?.leave();
    if (allowed.wander === false && !d.perching?.isAway() && !d.climbing?.isAway()) d.motion?.stop(); // off a wall he lets go instead (above)
    // Snacks and naps on again: he comes back full, not hungry (care.js).
    if ('needsOn' in allowed && allowed.needsOn !== (before.needsOn !== false)) d.life?.needsSwitched(allowed.needsOn);
    if ('bugFollower' in allowed || 'catchBugs' in allowed || 'crabOnly' in allowed) d.bugdex?.sendBuddy(); // his favourite catch, following him
    if (allowed.pushToTalk === false) { d.ptt?.reset(); d.showListening(false); d.dictation?.stop(); }
    // Asked to hush, he stops mid-line rather than finishing it.
    if (changed('chatter') && !voice.hasHabits(eff.chatter)) { d.said = null; d.refreshCritter(); }
    // In or out of Work mode: his needs pick up from now, and his look and the bars follow.
    if (workSwitched) { d.life?.workModeSwitched(); d.refreshCritter(); }
    if (['sounds', 'soundFx', 'ambient', 'soundVolume'].some(k => k in allowed)) {
      d.refreshCritter(); // the new mix goes with his state
      // Switching a sound on, or changing the volume, plays a taste of it
      // (unless he's on guard or you're on a call: the mix says so).
      const m = d.soundMix();
      const tasted = allowed.soundFx === true || allowed.sounds === true || 'soundVolume' in allowed;
      if (taste && tasted && m.fx) d.send(d.critter, 'critter:sound', { cue: 'tada' });
      else if (taste && tasted && m.voice) d.send(d.critter, 'critter:chirp', { occasion: 'success' });
    }
    if ('mode' in allowed) d.manager.setMode(allowed.mode);
    // Always: what's waiting on an answer goes now. Never: it's dropped from the disk now.
    if (allowed.crashReports === 'always' || allowed.crashReports === 'never') d.drainCrashQueue();
    if ('forecast' in allowed) d.sendOutlook();
    if ('clashWarnings' in allowed) d.refreshClashes?.(); // off clears the markers; on looks straight away
    if ('effort' in allowed) d.manager.setEffort(allowed.effort);
    if ('planOnly' in allowed) setPlanOnly(allowed.planOnly);
    if ('openAtLogin' in allowed) d.applyLoginItem(allowed.openAtLogin);
    if ('skin' in allowed) d.broadcastSkin();
    if ('onTop' in allowed) d.applyLayer();
    // Mischief on or off starts or stops its loop; pals and footprints open or close the floor strip.
    if (changed('mischief') || 'mischiefPranks' in allowed) d.pranks?.sync();
    if (changed('mischief') || 'mischiefPranks' in allowed || changed('colony')) d.floor?.sync();
    if ('critterScale' in allowed) {
      const size = d.critterBaseSize();
      const b = d.critter.getBounds();
      const width = size.width + d.crewExtra();
      // Grow/shrink around the critter's feet so it doesn't jump.
      d.critter.setBounds({ x: b.x + b.width - width, y: b.y + b.height - size.height, width, height: size.height });
      d.broadcastSkin();
    }
  }

  // A sync brought settings you changed on another PC (sync-prefs.js). They're
  // saved already; here they take effect, and the panel hears about them.
  d.settingsSynced = before => {
    const now = d.config.data;
    const allowed = Object.fromEntries(syncPrefs.changedKeys(now, before).map(k => [k, now[k]]));
    if (!Object.keys(allowed).length) return;
    if ('hotkey' in allowed && !d.applyHotkey(allowed.hotkey, before.hotkey)) {
      // Taken on this PC: keep the old one, with its old stamp so the next sync tries again.
      d.applyHotkey(before.hotkey);
      const stamps = now.syncStamps || {};
      d.config.set({ hotkey: before.hotkey, syncStamps: { ...stamps, prefs: { ...stamps.prefs, hotkey: before.syncStamps?.prefs?.hotkey || 0 } } });
      delete allowed.hotkey;
    }
    // Work mode's own settings count as changed when its overrides did.
    applied(allowed, { ...allowed, ...(allowed.workOverrides || {}) }, before);
    d.send(d.panel, 'settings', d.panelSettings());
    if ('snippets' in allowed || 'pinnedTools' in allowed) d.send(d.panel, 'snippets', d.snippetsView());
    // One quiet word per sync, so a setting doesn't change under you unexplained.
    if (Object.keys(allowed).length) d.send(d.panel, 'github:error', `Synced from your other PC: ${syncPrefs.describe(Object.keys(allowed))}.`);
  };

  ipcMain.handle('settings:set', async (_e, patch = {}) => {
    const allowed = {};
    for (const k of ['mode', 'hotkey', 'skin', 'critterScale', 'openAtLogin', 'notifications', 'model', 'onboarded', 'firstTour', 'autonomousAcknowledged', 'showCrew', 'crabOnly', 'claudeElsewhere', 'workMode', 'wander', 'onTop', 'perch', 'perchIgnore', 'climb', 'mischief', 'mischiefPranks', 'colony', 'chatter', 'sounds', 'soundFx', 'ambient', 'soundVolume', 'needsOn', 'worktrees', 'clashWarnings', 'recap', 'forecast', 'leaveGuard', 'effort', 'effortPick', 'outputStyle', 'fallbackModel', 'claudeInChrome', 'planOnly', 'pushToTalk', 'flakyTests', 'surprises', 'tideEvents', 'signCommits', 'catchBugs', 'bugBattles', 'bugFollower', 'shareBugdex', 'checkEachTurn', 'checkTimeoutMin', 'turnShots', 'spendGuard', 'spendReserve', 'spendMaxMinutes', 'holdBigTasks', 'crashReports', 'selfAware', 'suggestions', 'editor', 'claudeTricks', 'attachWhatISaw', 'plainCards', 'sshAgent', 'keybindings']) {
      if (k in patch) allowed[k] = patch[k];
    }
    // Turning on Autonomous for the first time needs a confirmation that renderer
    // code can't click through (isolated confirm window; see confirm.js).
    if (allowed.autonomousAcknowledged === true && !d.config.get('autonomousAcknowledged')) {
      const response = await confirm.ask(d.panel, {
        ...d.dialogLook(), icon: '⚠️', danger: true,
        title: 'Enable Autonomous mode?',
        message: 'Let Shellby act without asking?',
        detail: 'Shellby and his helper agents will be able to edit, run or delete anything your Windows account can, including scripts they write for themselves, with no permission prompts.',
        note: 'You can switch back to Ask first any time from the mode menu.',
        buttons: [{ label: 'Enable Autonomous', style: 'danger' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
      });
      if (response !== 0) { delete allowed.autonomousAcknowledged; if (allowed.mode === 'autonomous') delete allowed.mode; }
      else d.autonomousOkThisRun = true;
    }
    // After that, switching into it still asks once each time Shellby runs: the
    // panel alone can't flip a later session to no-prompts.
    if (allowed.mode === 'autonomous' && d.config.get('mode') !== 'autonomous' && d.config.get('autonomousAcknowledged') && !d.autonomousOkThisRun) {
      const response = await confirm.ask(d.panel, {
        ...d.dialogLook(), icon: '⚠️', danger: true,
        title: 'Switch to Autonomous?',
        message: 'Shellby and his helpers will act without asking until you switch back.',
        note: 'Shellby asks this once each time he starts.',
        buttons: [{ label: 'Switch to Autonomous', style: 'danger' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
      });
      if (response === 0) d.autonomousOkThisRun = true; else delete allowed.mode;
    }
    if ('mode' in allowed && !MODES.includes(allowed.mode)) delete allowed.mode;
    if ('skin' in allowed) {
      const sk = d.allSkins().find(x => x.id === allowed.skin);
      if (!sk || sk.locked) delete allowed.skin;
    }
    if (allowed.mode === 'autonomous' && !d.config.get('autonomousAcknowledged') && allowed.autonomousAcknowledged !== true) delete allowed.mode;
    if (allowed.autonomousAcknowledged === false) delete allowed.autonomousAcknowledged; // can't be un-acknowledged silently either
    if ('critterScale' in allowed) allowed.critterScale = [0.75, 1, 1.5, 2].includes(allowed.critterScale) ? allowed.critterScale : 1;
    if ('model' in allowed && !isModel(allowed.model)) delete allowed.model;
    if ('fallbackModel' in allowed && !isModel(allowed.fallbackModel)) delete allowed.fallbackModel;
    if ('effort' in allowed && allowed.effort !== '' && !EFFORTS.includes(allowed.effort)) delete allowed.effort;
    if ('outputStyle' in allowed) allowed.outputStyle = outputStyles.clean(allowed.outputStyle);
    for (const k of ['openAtLogin', 'notifications', 'onboarded', 'firstTour', 'autonomousAcknowledged', 'crabOnly', 'claudeElsewhere', 'workMode', 'wander', 'onTop', 'sounds', 'soundFx', 'needsOn', 'worktrees', 'clashWarnings', 'recap', 'forecast', 'leaveGuard', 'effortPick', 'claudeInChrome', 'planOnly', 'pushToTalk', 'flakyTests', 'surprises', 'tideEvents', 'signCommits', 'catchBugs', 'bugBattles', 'bugFollower', 'shareBugdex', 'checkEachTurn', 'turnShots', 'spendGuard', 'holdBigTasks', 'selfAware', 'suggestions', 'claudeTricks', 'attachWhatISaw', 'plainCards', 'sshAgent']) if (k in allowed) allowed[k] = !!allowed[k];
    if ('checkTimeoutMin' in allowed && !TIMEOUTS_MIN.includes(allowed.checkTimeoutMin)) delete allowed.checkTimeoutMin;
    if ('keybindings' in allowed) allowed.keybindings = shortcuts.sanitizeOverrides(allowed.keybindings);
    if ('spendReserve' in allowed && !guard.RESERVES.includes(allowed.spendReserve)) delete allowed.spendReserve;
    if ('spendMaxMinutes' in allowed && !guard.MAX_MINUTES.includes(allowed.spendMaxMinutes)) delete allowed.spendMaxMinutes;
    if ('chatter' in allowed && !voice.CHATTER.includes(allowed.chatter)) delete allowed.chatter;
    if ('editor' in allowed && !filelinks.CHOICES.includes(allowed.editor)) delete allowed.editor;
    if ('ambient' in allowed && !sounds.AMBIENTS.includes(allowed.ambient)) delete allowed.ambient;
    if ('soundVolume' in allowed && !sounds.VOLUMES.includes(allowed.soundVolume)) delete allowed.soundVolume;
    if ('crashReports' in allowed && !crashReport.CONSENTS.includes(allowed.crashReports)) delete allowed.crashReports;
    if ('perch' in allowed && !PERCH_SETTINGS.includes(allowed.perch)) delete allowed.perch;
    if ('climb' in allowed && !CLIMB_SETTINGS.includes(allowed.climb)) delete allowed.climb;
    if ('mischief' in allowed && !mischief.LEVELS.includes(allowed.mischief)) delete allowed.mischief;
    if ('mischiefPranks' in allowed) allowed.mischiefPranks = mischief.prankSet(allowed.mischiefPranks);
    if ('colony' in allowed) allowed.colony = Number.isInteger(allowed.colony) ? Math.max(0, Math.min(COLONY_MAX, allowed.colony)) : d.config.get('colony');
    // The only edit the panel makes to this list is taking an app back off it.
    if ('perchIgnore' in allowed) {
      const was = new Set(d.config.get('perchIgnore') || []);
      allowed.perchIgnore = Array.isArray(allowed.perchIgnore) ? allowed.perchIgnore.filter(x => d.isStr(x) && was.has(x)) : [...was];
    }
    // Work mode lays its settings over yours rather than writing them (workmode.js):
    // while it's on, a change to one of them is kept as Work mode's, not yours.
    const asked = { ...allowed }; // what changes, as you see it (perch, pals…), wherever it's kept
    const saving = workmode.write(d.config.data, allowed);
    for (const k of Object.keys(allowed)) if (!(k in saving)) delete allowed[k];
    Object.assign(allowed, saving);
    const prevHotkey = d.config.get('hotkey');
    /** @type {string | null} */
    let hotkeyError = null;
    if ('hotkey' in allowed && allowed.hotkey !== prevHotkey) {
      if (typeof allowed.hotkey !== 'string' || !d.applyHotkey(allowed.hotkey, prevHotkey)) {
        hotkeyError = `Couldn't register ${allowed.hotkey}; another app may be using it.`;
        d.applyHotkey(prevHotkey);
        delete allowed.hotkey;
      }
    }
    // Push-to-talk only goes on once Windows has shown it can listen.
    /** @type {string | null} */
    let pushToTalkError = null;
    if (allowed.pushToTalk && !d.config.get('pushToTalk')) {
      const r = await d.dictation.warm();
      if (!r.ok) { pushToTalkError = r.error; delete allowed.pushToTalk; }
    }
    const before = d.config.data;
    d.config.set(allowed);
    applied(allowed, asked, before, { taste: true });
    return { settings: d.panelSettings(), hotkeyError, pushToTalkError };
  });
  ipcMain.handle('folder:pick', async () => {
    const r = await dialog.showOpenDialog(d.panel, { title: 'Where should Shellby work?', defaultPath: d.currentCwd(), properties: ['openDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : d.setFolder(r.filePaths[0]);
  });
  // Only one of your recent folders (the menu's list): a new one comes through
  // the folder picker. The panel can't point Claude at any folder it names.
  // (A development run with its own profile takes any folder: the e2e scripts
  // set up throwaway repositories that way.)
  ipcMain.handle('folder:set', (_e, dir) => {
    const recent = d.isStr(dir) && (d.ISOLATED ? (attach.isLocalPath(dir) && dir)
      : (d.config.get('recentFolders') || []).find(d => d.toLowerCase() === dir.toLowerCase()));
    return recent && fs.existsSync(recent) ? d.setFolder(recent) : null;
  });
  ipcMain.handle('folder:pick-any', async () => {
    const r = await dialog.showOpenDialog(d.panel, { title: 'Choose a folder', defaultPath: d.currentCwd(), properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0] || null;
  });
}

module.exports = { registerSettingsIpc };
