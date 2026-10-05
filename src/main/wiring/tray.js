// The tray icon and its menu, reporting a problem (crash reports go only
// with your say-so), and updates (updates.js).
// Kept out of main.js, which only wires it up.
const { Menu, Tray, app, clipboard, nativeImage, shell } = require('electron');
const os = require('os');
const path = require('path');
const confirm = require('../confirm');
const crashReport = require('../crash-report');
const focus = require('../focus');
const { Updates, fakeUpdater, installedBy, trayLabel: updateLabel } = require('../updates');

/** d: what main shares (main.js `shared`). */
function wireTray(d) {
  // ---- tray + menu

  // One line in the tray for whatever the updater is up to: the fastest route to
  // "restart and update" without opening the panel at all.
  function updateMenuItem() {
    const view = updateView();
    const label = updateLabel(view);
    if (!label) return null;
    if (view.state === 'ready') return { label, click: () => d.updates.install() };
    if (view.state === 'downloading') return { label, enabled: false };
    return { label, enabled: view.state !== 'checking', click: () => { d.updates.check(); showUpdateSetting(); } };
  }

  // Says what the last check found, so a glance at the menu is often enough.
  function leaveMenuLabel() {
    const v = d.awayService.leaveVerdict();
    return v.safe ? 'Is it safe to leave?' : `Safe to leave? ${v.headline.replace(/\.$/, '')}`.slice(0, 90);
  }

  // Async: whether there's a screenshot to offer is an async clipboard read.
  async function buildMenu() {
    const agg = d.manager?.aggregate;
    const claude = !d.config.get('crabOnly'); // just-the-crab mode has no tasks, toolbox or routines
    const hasShot = claude && await d.clipboardHasImage();
    return Menu.buildFromTemplate([
      { label: 'Open Shellby', click: () => d.showPanel() },
      claude && { label: 'New conversation', click: () => { d.showPanel(); d.send(d.panel, 'tab:new-request'); } },
      hasShot && { label: 'Task from screenshot', click: d.taskFromClipboard },
      { label: 'Wardrobe', click: () => { d.showPanel({ focusInput: false }); d.send(d.panel, 'panel:view', 'wardrobe'); } },
      claude && { label: 'Toolbox', click: () => { d.showPanel({ focusInput: false }); d.send(d.panel, 'panel:view', 'toolbox'); } },
      claude && { label: 'Workflows', click: () => { d.showPanel({ focusInput: false }); d.send(d.panel, 'panel:view', 'workflows'); } },
      claude && { label: 'Routines', click: () => { d.showPanel({ focusInput: false }); d.send(d.panel, 'panel:view', 'routines'); } },
      claude && { label: 'Projects', click: () => { d.showPanel({ focusInput: false }); d.send(d.panel, 'panel:view', 'projects'); } },
      claude && d.devServers?.liveCount() && { label: `Stop all dev servers (${d.devServers.liveCount()})`, click: () => d.devServers.stopAll() },
      { label: leaveMenuLabel(), click: () => d.awayService.leaveCheck() },
      { label: 'Lock the PC', click: () => d.awayService.leaveCheck({ lock: true }) },
      { label: d.healthMood ? `Health: ${d.HEALTH_TIP[d.healthMood.mood]} (${d.healthMood.text})` : 'Health', click: d.showHealth },
      focusMenu(),
      playMenu(),
      ...careMenu(),
      { type: 'separator' },
      ...(agg?.busy ? [{ label: `${agg.busy} task${agg.busy > 1 ? 's' : ''} running`, enabled: false }, { type: 'separator' }] : []),
      updateMenuItem(),
      { label: 'Settings…', click: () => { d.showPanel({ focusInput: false }); d.send(d.panel, 'panel:view', 'settings'); } },
      ...(d.perching?.menuItems() || []),
      ...(d.climbing?.menuItems() || []),
      ...(d.pranks?.menuItems() || []),
      { label: 'Reset position', click: d.resetCritterPos },
      { label: 'Data folder (history, skins)', click: () => shell.openPath(app.getPath('userData')) },
      { label: 'Report a problem…', click: reportProblem },
      { type: 'separator' },
      { label: 'Quit Shellby', click: quit },
    ].filter(Boolean));
  }

  // Open a new GitHub issue with the facts already filled in: version, Windows
  // build, whether Claude Code was found, and the tail of the log (already scrubbed
  // of the home directory and anything token-shaped). It opens in the browser as a
  // draft, so nothing is sent anywhere until the user reads it and presses submit.
  const ISSUES_URL = 'https://github.com/x-salmon/shellby/issues/new';
  const MAX_URL = 7000; // GitHub starts dropping very long query strings

  function reportProblem() {
    const lines = d.log.recent(40);
    const body = [
      '<!-- What were you doing when it went wrong? -->',
      '',
      '',
      '### Shellby',
      `- Version: ${app.getVersion()}${app.isPackaged ? '' : ' (dev build)'}`,
      `- Windows: ${os.release()} (${process.arch})`,
      `- Electron: ${process.versions.electron}`,
      `- Claude Code: ${d.claudeStatus?.installed ? `${d.claudeStatus.version || 'found'}${d.claudeStatus.loggedIn ? ', signed in' : ', not signed in'}` : 'not found'}`,
      `- Mode: ${d.config?.get('crabOnly') ? 'just the crab' : d.config?.get('mode') || 'unknown'}`,
      '',
      '### Log',
      'The last lines before reporting. Paths are shortened to `~` and anything',
      'token-shaped is cut; please still skim it before submitting.',
      '',
      '```',
      ...(lines.length ? lines : ['(nothing logged this run)']),
      '```',
      // The run that closed unexpectedly is the one worth reading, not this one.
      ...(d.lastRun.unclean ? ['', '### Before Shellby last closed unexpectedly', '', '```', ...crashReport.previousLogTail(d.log.file, 20), '```'] : []),
    ].join('\n');

    const url = `${ISSUES_URL}?labels=bug&body=${encodeURIComponent(body)}`;
    // Too long for a URL: open a blank issue and leave the details on the
    // clipboard instead of silently truncating the thing they need to paste.
    if (url.length > MAX_URL) {
      clipboard.writeText(body).catch(e => d.log.warn("couldn't copy the problem report", e?.message));
      d.notify('Report copied', 'The details are on your clipboard — paste them into the issue.');
      shell.openExternal(`${ISSUES_URL}?labels=bug`);
      return;
    }
    shell.openExternal(url);
  }

  // The first time something goes wrong, he asks before any report leaves. The
  // answer is a cut-off in time (crash-report.js makeGate): Send lets everything
  // waiting go, Don't send drops it, and either way the next problem asks again.
  let askingToSend = false;
  async function askToSend(kind) {
    if (!d.sentry || askingToSend || d.crashConsent() !== 'ask') return;
    askingToSend = true;
    // The answer covers what was waiting when the question appeared, not
    // whatever goes wrong while it sits on screen.
    const shownAt = Date.now();
    try {
      const response = await confirm.ask(null, {
        ...d.dialogLook(), icon: '🩹',
        title: 'Send a crash report?',
        message: kind === 'closed' ? 'Shellby closed unexpectedly last time.' : 'Shellby hit a snag.',
        detail: 'A report helps get it fixed. It has the error and where in Shellby it happened, the versions of Shellby, Windows and Electron, basic facts about your PC (memory, graphics card, screen) and the log\'s last lines, with your home folder and anything token-shaped removed. If Shellby crashed outright, it also has a crash dump: where each part of the app was, which can hold fragments of whatever it was working on.',
        note: 'Reports go to Sentry, the crash-report service Shellby uses. Change this any time in Settings → About.',
        buttons: [{ label: 'Send report', style: 'primary' }, { label: 'Always send' }, { label: 'Don\'t send' }], defaultId: 0, cancelId: 2,
      });
      const decisions = crashReport.addDecision(d.config.get('crashReportDecisions'), shownAt, response !== 2);
      d.config.set(response === 1 ? { crashReports: 'always', crashReportDecisions: decisions } : { crashReportDecisions: decisions });
      // What was okayed goes now; what was turned down comes off the disk now,
      // rather than at the next backed-off retry.
      drainCrashQueue();
      d.log.info('crash report', ['sent', 'sent, and from now on always', 'not sent'][response]);
    } catch (e) {
      d.log.warn('crash report question failed', e);
    } finally {
      askingToSend = false;
    }
  }

  // Sentry's queue sends one report per retry and carries on after a success,
  // but a dropped report schedules nothing more. So after an answer (or Never)
  // it's walked once: each flush() takes the next report through the gate.
  // Bounded by the queue's own cap of 30.
  let draining = false;
  async function drainCrashQueue() {
    if (!d.sentry || draining) return;
    draining = true;
    try {
      for (let i = 0; i < 30; i++) {
        await d.sentry.flush().catch(() => {});
        await new Promise(r => setTimeout(r, 250));
      }
    } finally {
      draining = false;
    }
  }

  // Shellby's last run ended without quitting: a native crash, the process being
  // ended from outside, or the power going. Before this he came back as if
  // nothing had happened, and there was nothing to go on.
  function reportUncleanExit() {
    if (!d.lastRun.unclean) return;
    const started = d.lastRun.startedAt ? new Date(d.lastRun.startedAt).toISOString() : 'unknown';
    d.log.warn('the last run ended without quitting', `started ${started}${d.lastRun.version ? `, version ${d.lastRun.version}` : ''}`);
    if (d.sentry && d.crashConsent() !== 'never') {
      d.sentry.captureMessage('Shellby closed unexpectedly', {
        level: 'fatal',
        extra: { lastVersion: d.lastRun.version, lastStartedAt: started, log: crashReport.previousLogTail(d.log.file, 40).join('\n') },
      });
      if (d.crashConsent() === 'ask') setTimeout(() => askToSend('closed'), 4000); // once he's on the desk
    }
    // Without Sentry it stays in the log, and Report a problem picks it up: an
    // installer or Task Manager ending him isn't worth a toast to everyone.
  }

  // Games and digging (playtime.js, life.js): none of it needs Claude.
  function playMenu() {
    if (!d.playtime || !d.life) return null;
    return { label: 'Play', submenu: [...d.playtime.menuItems(), { type: 'separator' }, d.life.digMenuItem(), { label: 'Finds and memories…', click: () => { d.showPanel({ focusInput: false }); d.send(d.panel, 'panel:view', 'us'); } }] };
  }

  // Feeding him and the rest of looking after him (care.js). Gone entirely with
  // Snacks and naps switched off.
  function careMenu() {
    const m = d.life?.needsMenu();
    if (!m) return [];
    const us = { label: 'How he\'s doing…', click: () => { d.showPanel({ focusInput: false }); d.send(d.panel, 'panel:view', 'us'); } };
    return [m.feed, { label: 'Care', submenu: [...m.care, { type: 'separator' }, us] }];
  }

  function focusMenu() {
    const s = focus.normalize(d.config.get('focus'));
    if (s?.phase === 'focus') return { label: `Stop guarding my focus (${focus.shortLeft(s.endsAt - Date.now())} left)`, click: d.stopFocus };
    if (s?.phase === 'break') return { label: `End the break (${focus.shortLeft(s.endsAt - Date.now())} left)`, click: d.stopFocus };
    return { label: 'Guard my focus', submenu: focus.LENGTHS.map(m => ({ label: `${m} minutes`, click: () => d.startFocus(m) })) };
  }

  function createTray() {
    const img = nativeImage.createFromPath(path.join(d.ROOT, 'assets', 'tray.png'));
    d.tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(d.ICON).resize({ width: 16, height: 16 }) : img);
    d.tray.setToolTip('Shellby');
    d.tray.on('click', () => { d.reachedForShellby(); d.showPanel(); });
    d.tray.on('right-click', () => {
      d.reachedForShellby(); // its menu's items open the panel too
      buildMenu()
        .then(menu => d.tray.popUpContextMenu(menu))
        .catch(e => d.log.warn("couldn't open the tray menu", e?.message));
    });
  }

  async function quit() {
    // Dev servers keep running unless you chose otherwise; the first time, he says so.
    await d.serversOnQuit().catch(e => d.log.warn('dev servers on quit', e.message));
    app.isQuitting = true;
    d.manager?.closeAll();
    app.quit();
  }

  // ---- updates

  function setupUpdates() {
    // Dev runs can walk the whole sequence without a release behind it:
    // SHELLBY_FAKE_UPDATE=1 (or =fail, =current) npm start
    const fake = !app.isPackaged && process.env.SHELLBY_FAKE_UPDATE;
    let updater = fake ? fakeUpdater({ mode: fake === '1' ? 'ok' : fake }) : null;
    // Scoop unpacks the app and updates it itself; ours would install a second copy.
    const managedBy = app.isPackaged ? installedBy(process.execPath) : null;
    if (app.isPackaged && !managedBy) {
      try {
        ({ autoUpdater: updater } = require('electron-updater'));
        updater.logger = null;
        updater.autoInstallOnAppQuit = true; // quitting still installs whatever he already fetched
      } catch (e) {
        console.warn('[shellby] updater unavailable:', e.message);
      }
    }
    d.updates = new Updates({
      updater,
      managedBy,
      version: app.getVersion(),
      // Dev servers are stopped first and started again by the new version
      // (devservers/service.js stopForUpdate).
      // The installer relaunches Shellby; the flag has the new version open the
      // panel rather than come back as just the crab (see boot).
      prepare: () => {
        app.isQuitting = true;
        d.config.set({ reopenAfterUpdate: true });
        d.manager?.closeAll();
        d.devServers?.stopForUpdate();
      },
    });
    d.updates.on('changed', view => {
      // Offline, no releases yet, rate-limited: it goes to the log and to the
      // Settings row, never to a dialog you have to dismiss.
      if (view.state === 'error') console.warn('[shellby] update check failed:', view.error);
      d.send(d.panel, 'updates', view);
    });
    d.updates.on('ready', view => d.notify(
      'Shellby update ready',
      `Version ${view.version} is downloaded. Click to install it now, or it installs when you quit.`,
      showUpdateSetting,
    ));
    d.updates.start();
  }

  const updateView = () => {
    if (d.updates) return d.updates.view();
    const off = { state: 'off', version: null, percent: 0, error: null, checkedAt: null, current: app.getVersion(), busy: false };
    // Screenshots show the row as installed users mostly see it, not as a dev run.
    return d.CAPTURE ? { ...off, state: 'current', checkedAt: Date.now() } : off;
  };

  /** Settings, scrolled to the update button: where the tray item and the notification both point. */
  function showUpdateSetting() {
    d.showPanel({ focusInput: false });
    d.send(d.panel, 'panel:view', 'settings');
    d.send(d.panel, 'panel:jump', 'About');
  }

  return {
    askToSend, buildMenu, createTray, drainCrashQueue, reportProblem, reportUncleanExit,
    setupUpdates, updateView,
  };
}

module.exports = { wireTray };
