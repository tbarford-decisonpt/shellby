// The panel itself: opening and closing it, Claude Code's sign-in and status,
// pictures and files for the composer (attachments.js), and updates.
// Kept out of main.js, which only wires it up.
const { app, dialog, nativeImage } = require('electron');
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const attach = require('../attachments');
const { checkStatus, run: runCli, verifyClaude } = require('../claude-cli');
const { MODELS } = require('../models');
const processJob = require('../process-job');
const snippets = require('../snippets');
const { TASKKILL } = require('../system32');

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerPanelIpc(ipcMain, d) {
  // ---- pictures and files for the composer (see attachments.js)
  // A pasted snip, or a picture dropped with no file behind it: saved, then attached by path.
  ipcMain.handle('attach:image', (_e, bytes) => {
    if (!(bytes instanceof Uint8Array)) return { error: 'That clipboard item is empty.' };
    const r = attach.saveImage(bytes, d.shotsDir(), { nativeImage });
    if (r.path) d.stat('files-dropped');
    return r;
  });
  ipcMain.handle('attach:thumb', (_e, file) => (d.isStr(file) ? attach.thumbnail(file, { nativeImage }) : null));
  ipcMain.handle('attach:pick', async () => {
    const r = await dialog.showOpenDialog(d.panel, {
      title: 'Attach files', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'All files', extensions: ['*'] }, { name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
    return r.canceled ? [] : r.filePaths.slice(0, 20);
  });

  // ---- panel lifecycle
  ipcMain.on('panel:hide', () => d.panel.hide());
  ipcMain.on('panel:minimize', () => d.panel.minimize());
  ipcMain.handle('panel:roomy', (_e, on) => d.setPanelRoomy(on === true));

  ipcMain.handle('app:bootstrap', async () => {
    d.claudeStatus = d.CAPTURE || d.FAKE_CLI ? require('../capture').FAKE_STATUS : await checkStatus({ configured: d.claudePath() });
    const demoHome = 'C:\\Users\\you';
    // Restore the tabs that were open last time (idle until you send something).
    if (!d.CAPTURE && !d.manager.tabs.size) {
      for (const id of d.config.get('openTabs') || []) {
        const entry = d.history.get(id);
        if (entry) { try { d.openTab({ tabId: id, historyEntry: entry }); } catch { /* limit reached */ } }
      }
      // A message held for the reset keeps its tab open, so it can still be
      // seen and cancelled (one typed into a tab never sent anything isn't in openTabs).
      for (const h of d.heldList()) {
        if (h.kind === 'message' && !d.manager.tabs.has(h.tabId)) { try { d.reopenForHeld(h); } catch { /* limit reached */ } }
      }
    }
    return {
      version: app.getVersion(),
      settings: d.CAPTURE ? { ...d.panelSettings(), onboarded: true, mode: 'ask', recentFolders: [], lastUsage: null } : d.panelSettings(),
      status: d.claudeStatus,
      skin: d.activeSkin(),
      skins: d.allSkins(),
      outfit: d.outfit(),
      xp: d.xpView(),
      homes: d.homesView(),
      stickers: d.stickersView(),
      wardrobe: d.wardrobe.view(),
      welcomeTrophies: d.welcomeTrophies.splice(0),
      sessions: d.CAPTURE ? [] : d.history.list(),
      tabs: d.manager.summary,
      tabItems: Object.fromEntries(d.manager.summary.map(t => [t.id, d.history.load(t.id)])),
      toolbox: d.CAPTURE ? null : d.toolbox.current,
      pinned: d.pinnedTools(),
      snippets: snippets.view(d.snippetList(), d.config.get('snippetUse')),
      learned: d.CAPTURE ? [] : d.config.get('learnedTricks') || [],
      routines: d.CAPTURE ? [] : d.routinesView(),
      outlook: d.CAPTURE ? null : d.outlookView(),
      cwd: d.CAPTURE ? `${demoHome}\\Downloads` : d.currentCwd(),
      home: d.CAPTURE ? demoHome : os.homedir(),
      packaged: app.isPackaged,
      models: MODELS,
      updates: d.updateView(),
      claudeUpdate: d.claudeUpdateView(),
      registryUrl: d.registryUrl(),
      startView: (() => { const v = d.startView; d.startView = null; return v; })(),
    };
  });
  // FAKE_CLI here too, like the bootstrap and startup paths: without it, a dev or
  // e2e run driving the fake CLI had its faked status replaced by a real check the
  // first time the panel asked, so the same run behaved differently depending on
  // whether the machine happened to have Claude Code installed.
  ipcMain.handle('claude:status', async () => (d.claudeStatus = d.CAPTURE || d.FAKE_CLI ? require('../capture').FAKE_STATUS : await checkStatus({ configured: d.claudePath() })));
  // Checks again and tells the panel, so Settings and onboarding follow a
  // sign-in or sign-out without a "Check again" press.
  async function recheckClaude() {
    d.claudeStatus = d.CAPTURE || d.FAKE_CLI ? require('../capture').FAKE_STATUS : await checkStatus({ configured: d.claudePath() });
    d.refreshStatusLine();
    d.send(d.panel, 'claude:status', d.claudeStatus);
    return d.claudeStatus;
  }
  // The CLI walks the user through the browser sign-in. When it ends (signed in,
  // or given up), check again. One at a time, and never left waiting: each press
  // used to start another, and every sign-in not finished in the browser waited
  // for its callback for good (eight of them, 1.8 GB, after an account switch).
  const LOGIN_GIVE_UP_MS = 10 * 60 * 1000;
  /** @type {{ child: import('child_process').ChildProcess, job: { handle: number } | null, timer: NodeJS.Timeout } | null} */
  let login = null;
  function endClaudeLogin() {
    if (!login) return;
    const { child, job, timer } = login;
    login = null;
    clearTimeout(timer);
    if (processJob.sweep(job)) return;
    if (child.pid && child.exitCode === null) execFile(TASKKILL, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  }
  app.on('will-quit', endClaudeLogin);
  function startClaudeLogin() {
    const exe = d.claudeExe();
    if (!exe) return false;
    endClaudeLogin(); // pressed again: this one replaces the last
    try {
      const child = require('child_process').spawn(exe, ['auth', 'login'], { detached: true, stdio: 'ignore', windowsHide: false });
      const mine = { child, job: child.pid ? processJob.adopt(child.pid) : null, timer: setTimeout(() => endClaudeLogin(), LOGIN_GIVE_UP_MS) };
      login = mine;
      child.on('error', err => d.log.warn('claude auth login failed to start', err.message));
      child.on('exit', () => {
        if (login === mine) { clearTimeout(mine.timer); processJob.sweep(mine.job); login = null; }
        recheckClaude().catch(() => { /* the next check will tell */ });
      });
      child.unref();
      return true;
    } catch (err) {
      d.log.warn('claude auth login failed to start', err.message);
      return false;
    }
  }
  // "Find it myself…": for installs in places the search can't guess — a
  // portable copy, another drive, a company image. The file is run once to prove
  // it really is Claude Code before the path is kept, so a wrong pick is
  // answered here rather than becoming a task that won't start.
  ipcMain.handle('claude:locate', async () => {
    const r = await dialog.showOpenDialog(d.panel, {
      title: 'Where is Claude Code?',
      defaultPath: d.claudePath() || path.join(os.homedir(), '.local', 'bin'),
      properties: ['openFile'],
      // .exe only: a .cmd or .bat can't be started without a shell, which Shellby never uses.
      filters: [{ name: 'Claude Code', extensions: ['exe'] }, { name: 'Any file', extensions: ['*'] }],
      buttonLabel: 'Use this',
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true, status: d.claudeStatus };
    const check = await verifyClaude(r.filePaths[0]);
    if (!check.ok) {
      d.log.warn('rejected a hand-picked Claude Code', `${r.filePaths[0]}: ${check.error}`);
      return { ok: false, error: check.error, status: d.claudeStatus };
    }
    d.config.set({ claudePath: check.exe });
    d.log.info('Claude Code set by hand', `${check.exe} (v${check.version})`);
    d.claudeStatus = await checkStatus({ configured: check.exe });
    d.refreshStatusLine();
    return { ok: true, status: d.claudeStatus };
  });
  ipcMain.handle('claude:login', () => startClaudeLogin());
  // Signing out (and "Switch account", which signs straight back in) runs
  // Claude Code's own `auth logout`: the sign-in is Claude Code's, not ours.
  ipcMain.handle('claude:logout', async (_e, { thenSignIn = false } = {}) => {
    const exe = d.claudeExe();
    if (!exe) return { ok: false, error: 'Claude Code not found.', status: d.claudeStatus };
    const busy = d.manager?.aggregate?.busy || 0;
    if (busy) {
      const r = await dialog.showMessageBox(d.panel, {
        type: 'warning', buttons: [thenSignIn ? 'Switch anyway' : 'Sign out anyway', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
        message: `${busy === 1 ? 'A task is' : `${busy} tasks are`} still running.`,
        detail: 'Signing out of Claude Code can stop it partway. Let it finish first if you can.',
      });
      if (r.response !== 0) return { ok: false, cancelled: true, status: d.claudeStatus };
    }
    const out = await runCli(exe, ['auth', 'logout'], 30000);
    await recheckClaude();
    if (d.claudeStatus?.loggedIn && d.claudeStatus.billingEnv?.length) {
      // An API key in the environment signs Claude Code in by itself; logout can't remove it.
      return { ok: false, error: `Still signed in through ${d.claudeStatus.billingEnv.join(', ')}. Turn on "Always use my Claude plan" to ignore it.`, status: d.claudeStatus };
    }
    if (!out.ok && d.claudeStatus?.loggedIn) {
      d.log.warn('claude auth logout failed', (out.stderr || out.err?.message || '').slice(0, 300));
      return { ok: false, error: "Claude Code didn't sign out. Try `claude auth logout` in a terminal.", status: d.claudeStatus };
    }
    d.log.info('signed out of Claude Code', thenSignIn ? '(switching account)' : '');
    if (thenSignIn) startClaudeLogin();
    return { ok: true, status: d.claudeStatus };
  });

  // ---- updates
  ipcMain.handle('updates:check', () => (d.updates ? d.updates.check() : d.updateView()));
  ipcMain.handle('updates:install', () => !!d.updates?.install());

  // ---- keeping Claude Code itself up to date (claude-update.js)
  ipcMain.handle('claude:update-check', async () => (d.claudeUpdates ? d.claudeUpdates.check() : null));
  ipcMain.handle('claude:update-mode', (_e, mode) => (d.claudeUpdates ? d.claudeUpdates.setMode(mode) : null));
  // Runs Claude Code's own `claude update`. A conversation mid-turn keeps the
  // copy it started with, so it isn't stopped, but you're told before it's swapped.
  ipcMain.handle('claude:update', async () => {
    if (!d.claudeUpdates) return { ok: false, error: 'Not available in this run.' };
    const busy = d.manager?.aggregate?.busy || 0;
    if (busy) {
      const r = await dialog.showMessageBox(d.panel, {
        type: 'warning', buttons: ['Update anyway', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
        message: `${busy === 1 ? 'A task is' : `${busy} tasks are`} still running.`,
        detail: 'They carry on with the version they started with; new conversations get the update. Let them finish first if you can.',
      });
      if (r.response !== 0) return { ok: false, cancelled: true };
    }
    return d.claudeUpdates.update();
  });
}

module.exports = { registerPanelIpc };
