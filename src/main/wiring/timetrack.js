// Time on each project (timetrack.js), and what the Projects page and the
// Sticker Book show about each one.
// Kept out of main.js, which only wires it up.
const { BrowserWindow, Notification, app, clipboard, dialog, nativeImage, powerMonitor, shell } = require('electron');
const path = require('path');
const attach = require('../attachments');
const beach = require('../beach');
const confirm = require('../confirm');
const ctx = require('../context');
const { DEFAULT_PORT: HOOK_PORT, ExternalSessions } = require('../external');
const flaky = require('../flaky');
const focus = require('../focus');
const gifts = require('../gifts');
const { projectOf } = require('../gitinfo');
const { FAKE_SCENARIOS } = require('../health/fake');
const { HealthService } = require('../health/service');
const native = require('../native-windows');
const processJob = require('../process-job');
const recap = require('../recap');
const shellCmd = require('../shellcmd');
const shells = require('../shells');
const stickers = require('../stickers');
const streaks = require('../streaks');
const timetrack = require('../timetrack');
const { TimeTracker } = require('../timetrack-service');
const toast = require('../toast');

/** d: what main shares (main.js `shared`). */
function wireTimetrack(d) {
  // ---- time on each project (timetrack.js)
  //
  // The window in front, Claude's work and git's reflogs say which project you're
  // on; the seconds add up per day for timesheets and invoices. Off until you
  // turn it on, and it never leaves this PC.

  // Every project Shellby has seen you work in or ship: [{ key, name }], key the
  // repo's folder (case-folded on Windows, as streaks keep it).
  function knownProjects() {
    const out = new Map();
    for (const [key, p] of Object.entries(streaks.normalize(d.config.get('streaks')).projects)) out.set(key, { key, name: p.name });
    for (const p of Object.values(d.stickerState().projects)) {
      if (!p.root || p.from) continue; // a friend's gift has no folder here
      const key = process.platform === 'win32' ? path.resolve(p.root).toLowerCase() : path.resolve(p.root);
      if (!out.has(key)) out.set(key, { key, name: p.name });
    }
    return [...out.values()];
  }

  // `start: false` builds it without the 15-second tick (README screenshots,
  // where the window in front is your real editor, not demo data).
  function createTimeTracker({ start = true } = {}) {
    d.timeTracker = new TimeTracker({
      config: d.config,
      toPanel: (channel, payload) => d.send(d.panel, channel, payload),
      front: () => native.frontWindow(),
      windowsAvailable: () => native.available(),
      idle: () => ({ idleMs: powerMonitor.getSystemIdleTime() * 1000, locked: powerMonitor.getSystemIdleState(60) === 'locked' }),
      selfPid: process.pid,
      known: knownProjects,
      // Where Claude is working right now: Shellby's busy tabs by folder, and
      // sessions elsewhere by the folder name the plugin sends.
      claudeAt: () => ({
        dirs: [...(d.manager?.tabs.values() || [])].filter(t => t.session?.busy).map(t => t.worktree?.originalCwd || t.session?.cwd).filter(Boolean),
        names: (d.external?.summary.sessions || []).filter(s => s.state === 'working' || s.state === 'asking').map(s => s.project),
      }),
      resolve: dir => projectOf(dir),
      electron: { dialog, BrowserWindow, clipboard, shell, app },
      panel: () => d.panel,
    });
    if (start) d.timeTracker.start();
  }

  // Sticker milestones for the trophies (wardrobe/achievements.js).
  function stickerStats(state) {
    const n = stickers.stats(state);
    stat('stickers-earned', { n: n.stickers });
    stat('holo-stickers', { n: n.holo });
    stat('one-point-oh', { n: n.onePointOh });
    stat('stickered-shells', { n: n.shells });
    stat('friend-stickers', { n: n.guests });
  }

  // Every shell he can wear, for the Sticker Book's editor: its spots and what's on it.
  function shellsForBook(state) {
    const skin = d.activeSkin();
    const level = d.currentLevel();
    const worn = d.shellIdOf(d.wornShellObj());
    const all = [null, ...shells.SHELLS.filter(s => level >= s.level)];
    return all.map(sh => {
      const id = d.shellIdOf(sh);
      return {
        id, name: sh ? sh.name : 'His own shell', worn: id === worn,
        render: shells.renderShell(sh), slots: d.shellSpots(skin, sh).slots,
        stickers: d.shellStickers(skin, sh, state),
      };
    });
  }

  /** The Sticker Book: every project shipped, its art, and the shells to put them on. */
  function stickersView() {
    const s = d.stickerState();
    const v = stickers.view(s, Date.now());
    const roots = new Set(Object.values(s.projects).map(p => (p.root || '').toLowerCase()).filter(Boolean));
    const quiet = streaks.normalize(d.config.get('streaks')).projects;
    // Each project's last dependency checkup, by its folder (checkup.js).
    const checked = new Map(d.checkupsView().map(c => [c.key.toLowerCase(), c]));
    return {
      ...v,
      projects: v.projects.map(p => {
        const root = s.projects[p.id].root;
        const c = root && checked.get(root.toLowerCase());
        return { ...p, art: d.drawSticker(s.projects[p.id]).full, deps: c ? { fresh: c.fresh, audit: c.audit, outdated: c.outdated } : null };
      }),
      shells: shellsForBook(s),
      // Projects you work in that haven't shipped yet: silhouettes to earn.
      waiting: Object.entries(quiet).filter(([key]) => !roots.has(key.toLowerCase()))
        .sort((a, b) => b[1].lastSeen - a[1].lastSeen).slice(0, 12).map(([key, p]) => ({ key, name: p.name })),
    };
  }

  /** The beach: a castle per project shipped, the tide, his finds (beach.js). Raises the high-water mark as it goes. */
  function beachView() {
    const now = Date.now();
    const streakState = streaks.normalize(d.config.get('streaks'));
    const before = beach.normalize(d.config.get('beach'));
    const state = beach.observe(before, streaks.streakOf(streakState, now).longest);
    if (state.highWater !== before.highWater) d.config.set({ beach: state });
    return beach.view({ stickerState: d.stickerState(), streakState, findState: gifts.normalize(d.config.get('finds')), state, now });
  }

  /** You've looked at the beach: what's on it now stops rising up as new. */
  function beachSeen() {
    const v = beachView();
    d.config.set({ beach: beach.markSeen(d.config.get('beach'), v.castles, Date.now()) });
    return beachView();
  }

  // What the Projects page shows about each project, from where each part
  // already lives (projects/insights.js joins them up). Time only while it's on.
  function projectInsights() {
    const now = Date.now();
    const s = streaks.normalize(d.config.get('streaks'));
    const tt = timetrack.normalize(d.timeTracker?.state ?? d.config.get('timeTracking'));
    let time = null;
    if (tt.enabled) {
      const sum = timetrack.summarize(tt, timetrack.ranges(now).find(r => r.id === 'week'));
      time = {
        days: sum.days.map(d => d.day),
        projects: sum.projects.map(p => ({ key: p.key, seconds: p.seconds, days: p.days.map(r => ({ day: r.day, seconds: r.total })) })),
      };
    }
    const fl = flaky.normalizeFlaky(d.config.get('flaky'));
    const st = d.stickerState();
    return {
      streaks: s.projects,
      afterDays: s.afterDays,
      time,
      deps: d.depWatch ? d.depWatch.view().results : [],
      flaky: d.flakyOn() ? d.flakyView().map(r => ({ ...r, root: fl.projects[r.key]?.root || null })) : [],
      prs: d.ciView().prs,
      stickers: Object.values(st.projects).filter(p => p.root && !p.from && !p.hidden).map(p => {
        const v = stickers.projectView(st, p, now);
        return { root: p.root, tierName: v.tierName, ships: v.ships, marks: v.marks.map(m => ({ icon: m.icon, name: m.name })), art: d.drawSticker(p).full };
      }),
    };
  }

  // An edit from the Sticker Book. Only shells he can wear right now can be decorated.
  function editStickers(shell, fn) {
    const id = d.isStr(shell) ? shell : d.shellIdOf(d.wornShellObj());
    const sh = id === stickers.HOME ? null : shells.SHELLS.find(s => s.id === id);
    if (id !== stickers.HOME && (!sh || !shells.unlockedAt(id, d.currentLevel()))) return { ok: false, error: 'He has to grow into that shell first.', view: stickersView() };
    const slots = d.shellSpots(d.activeSkin(), sh).slots.length;
    const next = fn(d.config.get('stickers'), id, slots, Date.now());
    d.config.set({ stickers: next });
    stickerStats(next);
    d.broadcastSkin();
    const view = stickersView();
    d.send(d.panel, 'stickers', view);
    return { ok: true, view };
  }

  // Shell commands seen in Shellby's own tabs, so a successful result can be
  // scored (tests passed, pushed, deployed). tool_use id -> { command, project, dir }.
  const pendingCommands = new Map();

  // Feed the achievement system; unlocks celebrate via the wardrobe 'unlocked' event.
  function stat(event, payload) {
    if (d.CAPTURE) return;
    try { d.life?.onStat(event, payload); } catch (e) { d.log.warn('life stat failed', e.message); }
    if (!d.wardrobe) return;
    try { d.wardrobe.record(event, payload); } catch (e) { console.warn('[shellby] stat failed:', e.message); }
  }

  function onPermission(tabId, item, tab) {
    d.wake();
    d.askOnPhone(tabId, item, tab);
    if (d.routineTests.has(tabId)) d.send(d.panel, 'routines:test-run', { id: tabId, status: 'running', waiting: { permission: true } });
    if (d.panel.isVisible() && d.panel.isFocused()) return;
    const who = item.agent ? `${item.agent.description || item.agent.type} (helper)` : tab.title;
    if (item.toolName === 'AskUserQuestion') {
      notify('Shellby has a question', `${who}: ${item.questions?.[0]?.question || item.detail}`.slice(0, 160), () => d.showPanel({ focusInput: false, tabId }), { urgent: true, action: 'Answer' });
      return;
    }
    notify('Shellby needs your OK', `${who}: ${item.label} ${item.detail}`.slice(0, 160), () => d.showPanel({ focusInput: false, tabId }), { urgent: true, action: 'Review' });
  }

  function onResult(tabId, item, tab) {
    d.endTurn(tabId);
    tab.guardRun = null;
    d.noteWorkTime(item.durationMs); // the week's "hours of Claude work", stopped or not
    const fresh = tab.freshWanted;
    tab.freshWanted = false;
    if (tab.copyWanted) {
      if (!item.interrupted) return d.moveIntoCopy(tab);
      tab.copyWanted = false;
    }
    if (fresh && item.ok && !item.interrupted && tab.lastReply) return startFresh(tab, tab.lastReply);
    // A task queued for the reset: the queue is waiting to hear how it went
    // (releaseTask), and says so on the phone itself, with the result.
    const waiting = d.queueWaits.get(tabId);
    if (waiting) {
      d.queueWaits.delete(tabId);
      waiting({ ok: !!item.ok, interrupted: !!item.interrupted, error: item.error || null, reply: tab.lastReply, seconds: Math.round((item.durationMs || 0) / 1000) });
      // Nobody's typing into it overnight: its idle process only holds memory.
      if (!item.waiting?.length) tab.session.stop().catch(() => {});
    } else if (d.queueTabs.has(tabId) && !d.heldList().some(h => h.tabId === tabId)) {
      // A turn of your own in a finished queue tab: it's yours now, never closed to make room.
      d.queueTabs.delete(tabId);
    }
    const routineId = d.routineTabs.get(tabId);
    if (routineId) {
      d.updateRoutine(routineId, { lastStatus: item.interrupted ? 'stopped' : item.ok ? 'ok' : 'error' });
      // Nobody is typing into a routine's tab, so its idle process just holds
      // memory until morning. The conversation stays: a reply resumes it. Not
      // after a good turn that left something running in the background (a
      // failed turn's leftovers go with it).
      if (!item.waiting?.length) tab.session.stop().catch(() => {});
    }
    // Build it with Claude's test run ended: the editor's chat hands it back to Claude.
    if (d.routineTests.has(tabId)) d.send(d.panel, 'routines:test-run', d.routineTestView(tabId));
    d.noteRecap(recap.runEvent(tabId, tab.title, item.interrupted ? 'stopped' : item.ok ? 'ok' : 'error', { routine: !!routineId, error: item.error }));
    // A workflow's Claude step: the workflow carries on and says what it wants
    // said, so no "finished" toast or phone ping for each step.
    const inWorkflow = !!tab.workflowRunId;
    // A "fix this dev server" tab finished: its card offers the restart.
    if (!item.interrupted) d.devServers?.onTabDone(tabId, !!item.ok);
    if (!inWorkflow && !item.interrupted) {
      d.workflows?.event('task', { title: tab.title, outcome: item.ok ? 'ok' : 'error', folder: tab.worktree?.originalCwd || tab.session?.cwd || '', error: item.error || null });
    }
    if (!item.interrupted) d.flashState(item.ok ? 'success' : 'error');
    if (item.ok && !item.interrupted) {
      const fx = d.outfit().effect;
      if (fx?.motion === 'burst') d.send(d.critter, 'critter:burst', fx);
      stat('task-completed');
      d.awardXp('task', { label: tab.title });
      if (!inWorkflow && !routineId) d.roomTaskDone(); // tasks you gave him, not ones that ran by themselves
      d.recordWork(tab.worktree?.originalCwd || tab.session?.cwd);
    }
    if (!item.interrupted && !inWorkflow && !waiting) {
      d.tellChannel({ kind: 'done', project: tab.title, tools: item.tools, seconds: Math.round((item.durationMs || 0) / 1000) });
    }
    if (item.interrupted || inWorkflow || (d.panel.isVisible() && d.panel.isFocused())) return;
    const secs = Math.round((item.durationMs || 0) / 1000);
    if (item.ok && item.waiting?.length) {
      notify(`Shellby is waiting: ${tab.title}`, `Still running in the background: ${item.waiting.join(', ').slice(0, 120)}`, () => d.showPanel({ tabId }));
      return;
    }
    notify(item.ok ?`${routineId ? 'Routine' : 'Shellby'} finished: ${tab.title}` : `Shellby hit a problem: ${tab.title}`,
      item.ok ? `Done in ${secs}s. Click to see what happened.` : (item.error || 'Click for details.'),
      () => d.showPanel({ tabId }), { tone: item.ok ? 'default' : 'problem' });
  }

  // "Start fresh with a summary": the summary turn has ended, so the same tab
  // begins a new Claude conversation (no --resume) with the summary as its first
  // message. The tab keeps its copy, its History entry and its transcript.
  async function startFresh(tab, summary) {
    const session = tab.session;
    session.setBusy(true); // a message typed meanwhile waits for the new conversation
    await session.stop();
    if (!d.manager.tabs.has(tab.id)) return;
    session.sessionId = null;
    session.setContext(0);
    // Until the new conversation reports its id, reopening the tab starts it afresh rather than resuming the old one.
    d.history.update(tab.id, { claudeSessionId: null, context: null });
    d.manager.note(tab.id, { kind: 'fresh' });
    if (tab.freshCrowded) d.awardXp('fresh', { label: tab.title });
    tab.freshCrowded = false;
    session.setBusy(false);
    try { session.send(ctx.handoffPrompt(summary), d.manager.prepareTurn(tab)); } catch (err) { d.log.info(`fresh start: ${err.message}`); }
  }

  // While Shellby guards your focus, notifications that can wait are held back
  // and summed up afterwards. Urgent ones (a task waiting for your OK, a health
  // alert) still come through.
  let toastArt; // undefined until the first notification, null if it couldn't be copied
  // tone picks the banner (toast.TONES); urgent ones default to 'alert'. action
  // adds a button that does what clicking the notification does.
  function notify(title, body, onClick, { urgent = false, tone = urgent ? 'alert' : 'default', action = null } = {}) {
    if (!urgent && d.config && focus.guarding(d.config.get('focus'), Date.now())) {
      d.heldNotices = [...d.heldNotices, title].slice(-20);
      return;
    }
    // Dev, test and screenshot runs never post OS notifications: their toasts
    // outlive the process, and clicking a stale one relaunches bare electron.exe
    // (Electron's default page). SHELLBY_ALLOW_NOTIFY=1 opts a dev run back in.
    if (d.CAPTURE || (!app.isPackaged && process.env.SHELLBY_ALLOW_NOTIFY !== '1')) return;
    if (!d.config.get('notifications') || !Notification.isSupported()) return;
    const plain = () => {
      const n = new Notification({ title: title.slice(0, 80), body, icon: d.ICON });
      if (onClick) n.on('click', onClick);
      n.show();
    };
    if (toastArt === undefined) toastArt = toast.prepareArt(path.join(d.ROOT, 'assets', 'toast'), path.join(app.getPath('userData'), 'toast-art'));
    if (!toastArt) return plain();
    const n = new Notification({ toastXml: toast.xml({ title: title.slice(0, 80), body, tone, action: onClick ? action : null, artDir: toastArt }) });
    if (onClick) n.on('click', onClick);
    // If Windows ever turns the Shellby look down, say it plainly instead.
    n.once('failed', (_e, error) => { d.log.info(`themed notification failed: ${error}`); plain(); });
    n.show();
  }

  function openTab({ tabId = d.randomUUID(), cwd = d.currentCwd(), historyEntry = null, mode = null, routineId = null, workflowRunId = null, title = null } = {}) {
    return d.manager.open({ tabId, cwd, historyEntry, mode, routineId, workflowRunId, title });
  }

  // A task started by Shellby himself (e.g. "look into why the GPU is hot"): opens
  // in its own tab in the foreground, in the current permission mode. opts.cwd
  // runs it somewhere other than the current folder (a project review).
  function startTask(prompt, title, { mode = null, cwd = null } = {}) {
    if (d.config.get('crabOnly') || !d.claudeStatus?.installed || !d.claudeStatus?.loggedIn) return { ok: false, needsClaude: true, error: 'That needs Claude Code: set it up first.' };
    try {
      const tabId = d.randomUUID();
      // His own errands work in your real checkout: a copy would start from the
      // last commit, and "look over my changes" is about what isn't committed yet.
      openTab({ tabId, title, mode, ...(cwd ? { cwd } : {}) }).noCopy = true;
      d.manager.send(tabId, prompt, { kind: 'user', text: prompt, title });
      d.wake();
      d.send(d.panel, 'tab:opened', { tabId, entry: d.history.get(tabId), items: d.history.load(tabId), background: false });
      return { ok: true, tabId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // A message of yours into an open tab: what you type (task:send), or one held
  // for after the usage reset (releaseMessage). Returns { ok, tabId, turnId,
  // item } or { ok: false, error }.
  function sendToTab(tabId, text, files) {
    if (!d.claudeStatus?.installed || !d.claudeStatus?.loggedIn) return { ok: false, error: 'Finish setup first: Claude Code needs to be installed and signed in.' };
    try {
      const tab = d.manager.tabs.get(tabId);
      if (!tab) return { ok: false, error: 'That conversation is closed.' };
      // Nothing typed: the conversation is named for what was attached.
      const title = text ? undefined : files.every(attach.imageType) ? 'Screenshot' : 'Attached files';
      // Commands you ran with ! since your last message go to Claude with this one.
      const ran = shellCmd.contextFor(tab.shellRuns);
      tab.shellRuns = [];
      // !! sends a message that starts with !; Up brings it back as typed, still !!.
      const said = text.startsWith('!!') ? text.slice(1) : text;
      const turnId = d.manager.send(tabId, composePrompt(ran + said, files), { kind: 'user', text: said, attachments: files, title });
      d.rememberPrompt(text);
      d.wake();
      return { ok: true, tabId, turnId, item: { kind: 'user', text: said, attachments: files, turnId } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function showHealth() {
    d.showPanel({ focusInput: false });
    d.send(d.panel, 'panel:view', 'health');
  }

  function createHealth() {
    // Dev runs can fake a scenario (SHELLBY_FAKE_HEALTH=hot|scorching|dizzy|stuffed|calm|nocpu|hotdrive|cluttered);
    // screenshot runs always do. Packaged builds only ever read real sensors.
    const envFake = !app.isPackaged && FAKE_SCENARIOS.includes(process.env.SHELLBY_FAKE_HEALTH) ? process.env.SHELLBY_FAKE_HEALTH : null;
    d.health = new HealthService({
      config: d.config, send: d.send, stat, startTask, showHealth,
      notify: (title, body, onClick) => {
        d.tellChannel({ kind: 'health', title, body });
        notify(title, body, onClick, { urgent: true });
        d.workflows?.event('health', { title, body });
      },
      getPanel: () => d.panel,
      confirm: spec => confirm.ask(d.panel, { ...d.dialogLook(), ...spec }),
      selfPids: () => app.getAppMetrics().map(m => m.pid),
      // His own CPU and memory in Health; screenshot runs leave it out, so the
      // pictures don't carry whatever the capturing PC happened to be doing.
      appMetrics: d.CAPTURE ? null : () => app.getAppMetrics(),
      ownedPids: () => processJob.ownedPids(),
      fakeScenario: d.CAPTURE ? 'calm' : envFake,
      onMood: mood => { d.healthMood = mood; d.refreshCritter(); },
    });
  }

  // Claude Code sessions outside Shellby, reported by the Shellby plugin's hooks.
  function createExternal() {
    // Isolated dev/test runs never take the real port (that's the installed Shellby's).
    const port = (!app.isPackaged && Number(process.env.SHELLBY_HOOK_PORT)) || (d.ISOLATED ? 0 : HOOK_PORT);
    d.external = new ExternalSessions({ port });
    d.external.on('changed', summary => { d.refreshCritter(); d.send(d.panel, 'external', { ...summary, status: d.external.status, port: d.external.port, enabled: !!d.config.get('externalSessions') }); });
    d.external.on('status', () => d.send(d.panel, 'external', externalView()));
    d.external.on('command-ok', e => {
      d.awardXp(e.kind, { project: e.project });
      if (e.cwd && e.ship) d.shipped(e.cwd, e.ship.kind, { version: e.ship.version });
    });
    d.external.on('checkup', e => d.checkedUp(e.dir, e.check, e.result));
    d.external.on('turn-done', e => {
      d.awardXp('task', { project: e.project });
      d.noteWorkTime(e.ms);
      d.tellChannel({ kind: 'done', project: e.project, tools: e.tools });
      d.recordWork(e.cwd);
      d.flashState('success');
      const fx = d.outfit().effect;
      if (fx?.motion === 'burst') d.send(d.critter, 'critter:burst', fx);
      stat('task-completed');
    });
    d.external.on('asking', e => { d.wake(); d.tellChannel({ kind: 'asking', project: e.project, message: e.message }); });
    if (d.config.get('externalSessions')) d.external.start();
  }

  function externalView() {
    return { ...(d.external ? d.external.summary : { sessions: [], status: 'off' }), enabled: !!d.config.get('externalSessions') };
  }

  // Pictures go inline as image blocks; everything attached is listed by path too.
  // See attachments.js.
  const shotsDir = () => path.join(app.getPath('userData'), 'screenshots');
  const composePrompt = (text, files) => attach.composeContent(text, files, f => attach.loadForClaude(f, { nativeImage }));

  // The clipboard's picture (a Win+Shift+S snip) as a new task: from the crab's menu.
  function taskFromClipboard() {
    const saved = attach.saveNative(clipboard.readImage(), shotsDir());
    if (saved.error) return notify('No screenshot', `${saved.error} Press Win+Shift+S to snip one.`);
    stat('files-dropped');
    d.showPanel();
    d.send(d.panel, 'panel:attach', [saved.path]);
  }
  const clipboardHasImage = () => { try { return clipboard.availableFormats().some(t => t.startsWith('image/')); } catch { return false; } };

  return {
    beachSeen, beachView, clipboardHasImage, composePrompt, createExternal, createHealth,
    createTimeTracker, editStickers, externalView, knownProjects, notify, onPermission, onResult,
    openTab, pendingCommands, projectInsights, sendToTab, shotsDir, showHealth, startTask, stat,
    stickerStats, stickersView, taskFromClipboard,
  };
}

module.exports = { wireTimetrack };
