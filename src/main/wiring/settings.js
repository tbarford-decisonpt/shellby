// Settings' side effects outside the settings file: what the panel is shown of
// them, the global hotkey, opening at login, and the folder your own skins go in.
// Kept out of main.js, which only wires it up; the panel's channels are ipc/settings.js.
const { app, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');
const workmode = require('../workmode');

/** d: what main shares (main.js `shared`). */
function wireSettings(d) {
  // Settings as the panel sees them: the spend ledger stays in main (usage/service.js usageBreakdown),
  // and Work mode's settings show as they apply, over your own (workmode.js).
  function panelSettings() {
    const { spendLedger: _ledger, cacheDays: _c, setupWeights: _s, leanUsed: _u, pluginCosts: _p, mcpSeen: _m, pluginEnabledAt: _e, turnCosts: _t, phoneTasksSecret: _pt, usageByHost: _ub, ...rest } = workmode.effective(d.config.data);
    // otherUsage: computers signed in to another Claude account, and how full their plans are (wiring/sessions.js).
    return { ...rest, dockOrder: workmode.behaviour(d.config.data).dock, crashReportsAvailable: !!d.sentry, otherUsage: d.otherUsage?.() || [] }; // no DSN in this build: the Settings row stays hidden
  }

  // -> whether the new hotkey is registered (no hotkey at all counts as yes).
  function applyHotkey(accel, previous) {
    if (previous) { try { globalShortcut.unregister(previous); } catch (err) { d.log.warn('old hotkey could not be released', err?.message); } }
    if (!accel) return true;
    try { return globalShortcut.register(accel, d.onHotkey); } catch (err) { d.log.warn('hotkey could not be registered', err?.message); return false; }
  }

  function applyLoginItem(open) {
    if (!app.isPackaged) return; // dev runs would register electron.exe itself
    app.setLoginItemSettings({ openAtLogin: !!open });
  }

  function userSkinsDir() {
    const dir = path.join(app.getPath('userData'), 'skins');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  return { applyHotkey, applyLoginItem, panelSettings, userSkinsDir };
}

module.exports = { wireSettings };
