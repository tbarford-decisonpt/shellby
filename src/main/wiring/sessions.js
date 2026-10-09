// Claude Code conversations: the session manager behind the tabs, and the
// snapshot either side of each turn that says what it changed (changes.js).
// Kept out of main.js, which only wires it up.
const { app, powerMonitor } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const changes = require('../changes');
const checkup = require('../checkup');
const ctx = require('../context');
const fileIndex = require('../fileindex');
const prBadges = require('../github/pr-badge');
const outputStyles = require('../outputstyles');
const recap = require('../recap');
const selfaware = require('../selfaware');
const { SessionManager } = require('../sessions');
const stickers = require('../stickers');
const toolPictures = require('../tool-pictures');
const { detailOf } = require('../trouble');
const usage = require('../usage');
const accounts = require('../usage/accounts');
const voice = require('../voice');
const { classifyCommand, markRed } = require('../xp');

/** d: what main shares (main.js `shared`). */
function wireSessions(d) {
  // ---- sessions

  // Pictures a tool handed Claude (a screenshot it read), shown under that step (tool-pictures.js).
  const picturesDir = () => path.join(app.getPath('userData'), 'tool-pictures');
  function savePictures(tabId, toolId, images) {
    const ids = toolPictures.save(picturesDir(), tabId, toolId, images);
    if (ids.length) toolPictures.prune(picturesDir(), tabId);
    return ids;
  }
  const toolPicture = (tabId, id) => toolPictures.read(picturesDir(), tabId, id);

  // A project's code when its tests last failed (by project, as xp.js marks red).
  const redTrees = new Map();

  // A command that went well pays its XP, and he says so. A test pass on code
  // that changed since the failure is a fix ('fixed', with its own line); on
  // the very same code it was a flake, and stays an ordinary pass.
  async function awardCommand(kind, c) {
    let sameCode = false;
    if (kind === 'tests' && c.project && redTrees.has(c.project)) {
      const snap = await c.tree?.catch(() => null);
      sameCode = !!snap?.tree && snap.tree === redTrees.get(c.project);
    }
    const r = d.awardXp(kind, { project: c.project, sameCode });
    if (r?.kind === 'fixed') redTrees.delete(c.project);
    d.speak(r?.kind === 'fixed' ? 'fixed' : voice.occasionForCommand(kind));
  }

  function currentCwd() {
    const cwd = d.config.get('cwd');
    return cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  }

  function createManager() {
    d.manager = new SessionManager({
      argsPrefix: d.FAKE_CLI ? [d.FAKE_CLI] : [],
      history: d.history,
      getExe: () => (d.FAKE_CLI ? process.env.SHELLBY_NODE || 'node' : d.claudeExe()),
      getMode: () => d.config.get('mode'),
      getModel: () => d.config.get('model'),
      getEffort: () => d.config.get('effort'),
      getEffortPick: () => d.config.get('effortPick') !== false,
      getOutputStyle: () => outputStyles.clean(d.config.get('outputStyle')),
      getEnv: () => d.github?.claudeEnv() || {},
      // A folder on another computer: Claude Code runs there, over ssh (remote/service.js).
      getRemote: cwd => {
        const place = d.remoteService?.placeOf(cwd);
        if (!place) return null;
        // Another account's meter fills in before its first turn reports anything.
        const other = accountOfCwd(cwd);
        if (other) setImmediate(() => probeOther(other));
        return d.remoteService.launch(place);
      },
      compose: (text, files) => d.composePrompt(text, files),
      prepareTurn: async tab => {
        d.usageService.armGuard(tab);
        try { d.usagePlan?.beginTurn(tab); } catch (err) { d.log.info(`usage plan: ${err.message}`); }
        // Checks never run while Claude works in that folder: a new turn stops them (wiring/checks.js).
        d.cancelChecks?.(tab.id);
        tab.lastReply = null;
        // Only the summary turn itself may start a conversation fresh (tab:fresh
        // sets it after this runs): a summary turn that died without a result
        // must not take the next ordinary turn with it.
        tab.freshWanted = false;
        await d.copyService.armCopy(tab);
        await beginTurn(tab);
      },
      windowShare: weight => d.windowShare({ weight }),
      // Claude knowing it's in Shellby: the note and the crab's tools (wiring/crab-api.js),
      // and a line about the plan's usage once it runs high. A /command goes as typed.
      getSelfAware: () => d.getSelfAware(),
      onTool: (tab, name, args) => d.crabTool(tab, name, args),
      decorate: (tab, prompt) => {
        if (!d.config.get('selfAware') || selfaware.isSlashCommand(prompt)) return prompt;
        const other = accountOfCwd(tab.session?.cwd);
        const reading = other ? accounts.readingFor(d.config.get('usageByHost'), other) : d.config.get('lastUsage');
        const u = selfaware.usageNote(reading, tab.usageTold, Date.now());
        tab.usageTold = u.told;
        return selfaware.withUsageNote(prompt, u.text);
      },
      savePictures,
    });

    d.manager.on('spend', (_tabId, s, tab) => d.usageService.onSpend(s, tab));
    d.manager.on('call', (_tabId, c, tab) => { if (!d.CAPTURE) d.lean?.onCall(c, tab); });
    // A conversation past the crowded mark: he says so, and the panel offers to make room.
    d.manager.on('context', (_tabId, now, before, tab) => {
      if (ctx.crossed(before, now) && !tab.routineId && !tab.workflowRunId) d.sayText('Getting crowded in here.', 'crowded');
    });

    // Queued messages just handed to Claude mid-turn: their chips can't be edited now.
    d.manager.on('steering', (tabId, ids) => { const win = d.tabWindow(tabId); d.send(win, 'tab:steering', { tabId, ids }); });

    const nudgedSignIn = new Set(); // MCP servers already offered a sign-in this run
    d.manager.on('item', (tabId, item, tab, tail) => {
      if (item.kind === 'usage') {
        // Another Claude account's plan, over ssh: its own meter, never this PC's.
        // Until this PC's own sign-in is known, a reading from over there can't be placed.
        if (!d.claudeStatus && d.remoteService?.placeOf(tab.session?.cwd)) return;
        const other = accountOfCwd(tab.session?.cwd);
        if (other) return applyOtherUsage(other, item);
        d.usagePlan?.onUsage(tabId, item); // before lastUsage moves on: the rise is measured from it
        applyUsage(item);
        d.noteRecap(recap.usageEvent(tabId, tab.title, item));
        return;
      }
      if (item.kind === 'init') {
        d.lastInit = item.toolbox;
        d.toolbox?.setInit(item.toolbox);
        // A server waiting for sign-in: offer it once per server per run, so
        // nobody has to find /mcp in a terminal (parity.js mcp:signin).
        const waiting = item.toolbox.mcp_servers.filter(s => s.status === 'needs-auth' && !nudgedSignIn.has(s.name)).map(s => s.name);
        for (const n of waiting) nudgedSignIn.add(n);
        if (waiting.length) d.send(d.panel, 'mcp:needs-auth', { tabId, names: waiting });
        return; // toolbox lists are large; the panel doesn't need them per tab
      }
      if (item.kind === 'commands') {
        d.toolbox?.setCommands(item.commands); // a mod's slash commands, for the / menu
        return;
      }
      const win = d.tabWindow(tabId); // the panel, or the conversation's own window (wiring/popouts.js)
      d.send(win, 'tab:item', { tabId, item });
      d.workflows?.onTabItem(tabId, item);
      if (item.kind === 'text' && !item.sub) tab.lastReply = item.text;
      if (item.kind === 'decision') d.remote?.settle(item.requestId, item.decision);
      // A test run's "waiting for you" ends once you've answered.
      if (item.kind === 'decision' && d.routineTests.has(tabId)) d.send(d.panel, 'routines:test-run', d.routineTestView(tabId));
      if (item.kind === 'permission') d.onPermission(tabId, item, tab);
      if (item.kind === 'result') {
        d.onResult(tabId, item, tab);
        // Its project's handoff note, once its turns settle (wiring/journal.js).
        d.journal?.touched({ sessionId: tab.session?.sessionId, cwd: tab.session?.cwd, root: tab.worktree?.root || null });
      }
      // The panel shows a sentence (trouble.js); what the program really said goes in the log too.
      // (Not having a copy of the repo isn't a failed turn: main logs that itself.)
      const failed = item.trouble && item.trouble.kind !== 'no-copy';
      if (failed) d.log.warn(`turn failed (${item.trouble.kind})`, detailOf(item.kind === 'error' ? item.text : item.error));
      // Claude Code stopping mid-turn sends no result: a routine's row still has to say it failed
      // (and offer Fix with Claude), not "started 2h ago" for ever.
      if (failed && item.kind === 'error' && d.routineTabs.has(tabId)) d.routineService.updateRoutine(d.routineTabs.get(tabId), { lastStatus: 'error' });
      if (item.kind === 'task' && item.phase === 'started' && !tab.session?.jobs?.byId.has(item.taskId)) d.stat('helper-spawned'); // a command left running isn't a helper (jobs.js)
      d.crewRoster?.onItem(tabId, item, tab); // each helper's run goes on its crew member's record (wiring/crew.js)
      d.native?.onItem(tabId, item, tab); // a skill's first use, a memory written down (wiring/native.js)
      d.stepUndo?.onItem(tabId, item, tab); // a checkpoint before each step that changes files (wiring/step-undo.js)
      if (item.kind === 'tool' && (item.name === 'Bash' || item.name === 'PowerShell') && item.id) {
        const dir = tab.session?.cwd || '';
        // On another computer the folder here is only a stand-in: nothing to compare runs in.
        const inProject = dir && path.resolve(dir) !== path.resolve(os.homedir()) && !d.remoteService?.placeOf(dir);
        // A test run: the code as it was when it started, so a later run can be compared (flaky.js).
        const tree = inProject && !item.background ? d.flakyTree(item.detail, dir) : null;
        // ...and for a command that could catch a bug still on the loose (wiring/bugdex.js).
        const bugTree = inProject && !item.background ? d.bugdex?.commandStart({ command: item.detail, dir }) : null;
        d.pendingCommands.set(item.id, { command: item.detail, project: inProject ? path.basename(dir) : null, dir: inProject ? dir : null, cwd: dir || null, tree, bugTree, tabId, background: !!item.background });
        if (d.pendingCommands.size > 200) d.pendingCommands.delete(d.pendingCommands.keys().next().value);
      }
      if (item.kind === 'tool') d.onToolSpoken(item);
      // Claude writing code (or reading round): whatever bug is on the loose in that project is being worked on, and fought.
      if (item.kind === 'tool') d.bugdex?.tool(tabId, item);
      if (item.kind === 'tool_result' && d.pendingCommands.has(item.id)) {
        const c = d.pendingCommands.get(item.id);
        d.pendingCommands.delete(item.id);
        const meant = classifyCommand(c.command);
        if (item.isError && meant === 'tests' && c.project && d.config && !d.CAPTURE) {
          d.config.set({ xp: markRed(d.config.get('xp'), c.project, Date.now()) });
          d.noteRed(`t:${c.project}`);
          // The code as it failed: a pass on the very same tree is a flake, not a fix.
          c.tree?.then(s => { if (s?.tree) redTrees.set(c.project, s.tree); }).catch(() => {});
        }
        if (c.tree) d.noteTestRun(c, item, tail);
        d.bugdex?.commandResult(c, item, tail); // a bug seen, or one caught (wiring/bugdex.js)
        const kind = !item.isError && meant;
        if (kind) awardCommand(kind, c);
        // A push, deploy or release ships the project: its sticker (stickers.js).
        const ship = c.dir && stickers.shipOf(kind, c.command);
        if (ship) d.shipped(c.dir, ship.kind, ship.meta);
        // gh pr create: the tab's work is a pull request now, so it gets the badge (github/pr-badge.js).
        // And the week's card counts it, once gh has printed the new pull request's address.
        if (!item.isError && prBadges.isPrCreate(c.command)) {
          const out = `${item.text || ''}\n${tail || ''}`;
          if (/\/pull\/\d+\s*$/m.test(out)) d.noteWeek('pr');
          d.badgePr(out);
        }
        // npm audit, pip-audit, cargo outdated...: read what it found (checkup.js).
        const check = checkup.checkupOf(c.command);
        if (check && c.cwd) {
          const result = checkup.readCheckup(check, { text: item.text, isError: item.isError, command: c.command });
          d.checkedUp(checkup.commandDir(c.command, c.cwd), check, result);
        }
      }
    });
    // A summary comes with every token count, context, cache and busy change, and
    // config.set rewrites settings.json in full: the list goes there only when it's different.
    let openTabsSaved = null;
    let openIds = new Set();
    d.manager.on('tabs', summary => {
      d.sendTabs(summary); // the panel and any popped-out windows (wiring/popouts.js)
      d.clashTabsChanged?.(); // a copy opened or closed: look for clashes again (wiring/clashes.js)
      const saved = summary.filter(t => t.saved && !t.routineId && !t.workflowRunId).map(t => t.id);
      if (!d.CAPTURE) {
        openTabsSaved ??= JSON.stringify(d.config.get('openTabs') || []);
        const json = JSON.stringify(saved);
        if (json !== openTabsSaved) { openTabsSaved = json; d.config.set({ openTabs: saved }); }
      }
      // A conversation closed: its transcript lines still on their way go down now (history.js).
      const open = new Set(summary.map(t => t.id));
      for (const id of openIds) if (!open.has(id)) d.history?.flush?.(id);
      openIds = open;
    });
    d.manager.on('aggregate', agg => {
      d.refreshCritter();
      const s = d.wardrobe?.stats;
      if (s && agg.crew.length > s.maxCrew) d.stat('crew-size', { n: agg.crew.length });
      if (s && agg.busy > s.maxParallel) d.stat('parallel', { n: agg.busy });
    });
    d.native?.attach(d.manager); // to-dos ticked off, background commands finishing (wiring/native.js)
    setInterval(() => {
      const stopped = d.manager.stopIdle(d.TAB_IDLE_STOP_MS);
      if (stopped.length) d.log.info('Stopped idle tabs', `${stopped.length} quiet for ${d.TAB_IDLE_STOP_MS / 60000} min`);
    }, d.TAB_IDLE_CHECK_MS).unref?.();
  }

  // ---- what each turn changed (changes.js)

  // tabId -> the folder as it was when the turn began
  const turnStarts = new Map();
  // A big repo's first snapshot can take a while. Past this the turn goes ahead
  // without one rather than keep you waiting, and simply has no diff.
  const SNAPSHOT_WAIT_MS = 10000;

  function beginTurn(tab) {
    turnStarts.delete(tab.id);
    const cwd = tab.session?.cwd;
    // The files of a folder on another computer are over there: no picture of them here.
    if (!cwd || d.CAPTURE || d.remoteService?.placeOf(cwd)) return null;
    // A picture of the dev server as it is, alongside and never in the way (wiring/shots.js).
    try { d.shotsBeforeTurn?.(tab); } catch (err) { d.log.info(`shots: ${err.message}`); }
    let late = false;
    const turnId = tab.turnId;
    const info = {};
    const taken = changes.snapshot(cwd, info).then(snap => {
      if (info.skipped) d.log.info(`changes: ${info.skipped}`, cwd); // the turn has no diff or Undo, and this is why
      if (snap) d.bugdex?.treeSeen(snap.root, snap.tree); // the code before: a later "fix" back to it is an undo
      if (snap && !late) turnStarts.set(tab.id, { ...snap, turnId });
    });
    return Promise.race([taken, new Promise(r => setTimeout(() => { late = true; r(); }, SNAPSHOT_WAIT_MS))]);
  }

  // tabId -> the promise of its last turn's diff being noted, for rewind to wait on.
  const turnEnds = new Map();

  function endTurn(tabId) {
    const p = noteTurnChanges(tabId).finally(() => { if (turnEnds.get(tabId) === p) turnEnds.delete(tabId); });
    turnEnds.set(tabId, p);
    return p;
  }

  async function noteTurnChanges(tabId) {
    const start = turnStarts.get(tabId);
    turnStarts.delete(tabId);
    const cwd = d.manager.tabs.get(tabId)?.session.cwd;
    if (cwd) fileIndex.forget(cwd); // what it created can be @-mentioned straight away
    if (!start) { d.shotsAfterTurn?.(tabId, null); return; }
    try {
      const end = await changes.snapshot(start.root);
      const summary = await changes.summarize(start, end);
      // Tagged with its turn: the diff is worked out after the turn ends, by which
      // time the next message may already be in the transcript (rewind.js).
      const turn = start.turnId ? { turnId: start.turnId } : {};
      if (summary) d.manager.note(tabId, { kind: 'changes', ...summary, ...turn });
      if (summary) d.bugdex?.changed(start.root);
      if (end) d.bugdex?.treeSeen(end.root, end.tree);
      // Where the files stood at both ends of the turn, changed or not: a branch
      // from any turn starts its copy from exactly there (branch.js). Not shown.
      if (end && end.root === start.root) d.manager.note(tabId, { kind: 'checkpoint', root: start.root, head: start.head, start: start.tree, endHead: end.head, end: end.tree, ...turn });
      afterChanges(tabId, summary);
    } catch (err) {
      d.log.info(`changes: ${err.message}`);
      afterChanges(tabId, null);
    }
  }

  // Then what Shellby checks about a turn: the after picture and the tests
  // (wiring/shots.js, checks.js). Neither may get in the way of the rest.
  function afterChanges(tabId, summary) {
    try {
      d.shotsAfterTurn?.(tabId, summary)?.catch?.(err => d.log.info(`shots: ${err.message}`));
      if (summary) d.surprises?.noteTurn(tabId, summary); // before its checks, which may be the green that proves it
      if (summary) d.afterTurnChecks?.(tabId, summary);
    } catch (err) {
      d.log.info(`checks: ${err.message}`);
    }
  }

  // ---- the usage meter

  function applyUsage(item) {
    d.config.set({ lastUsage: { ...item, at: Date.now() } });
    d.sendEveryWindow('usage', item); // a popped-out conversation's meter too (wiring/popouts.js)
    d.onUsage(item);
    d.refreshOutlook();
    d.tankGauges?.usage(); // the tank's tide gauge
    d.usageService.checkGuards();
  }

  // At most this often a reading is asked for, here or on another computer.
  const USAGE_REFRESH_MS = 2 * 60 * 1000;

  // ---- other computers on another Claude account (usage/accounts.js)

  function accountOfCwd(cwd) {
    const place = d.remoteService?.placeOf(cwd);
    if (!place) return null;
    const list = d.config.get('remoteComputers');
    const computer = (Array.isArray(list) ? list : []).find(c => accounts.hostKey(c?.alias) === accounts.hostKey(place.host)) || null;
    return accounts.accountFor({ place, computer, local: d.claudeStatus });
  }

  const otherUsage = () => accounts.othersView(d.config.get('remoteComputers'), d.config.get('usageByHost'), d.claudeStatus);

  function applyOtherUsage(account, item) {
    if (!item.fiveHour && !item.sevenDay) return; // nothing a meter could show
    d.config.set({ usageByHost: accounts.withReading(d.config.get('usageByHost'), account, item, Date.now()) });
    d.sendEveryWindow('usage:other', otherUsage());
  }

  // get_usage over ssh, as refreshUsage does here: at most every couple of minutes a computer.
  const otherProbes = new Map(); // host key -> its probe while one runs
  const otherProbedAt = new Map(); // host key -> when it was last asked, answered or not
  function probeOther(account) {
    const key = accounts.hostKey(account.host);
    const last = Math.max(accounts.readingFor(d.config.get('usageByHost'), account)?.at || 0, otherProbedAt.get(key) || 0);
    if (otherProbes.has(key) || d.config.get('crabOnly') || Date.now() - last < USAGE_REFRESH_MS) return;
    const cmd = d.remoteService?.probeCommand(account.host, usage.PROBE_ARGS);
    if (!cmd) return;
    const started = Date.now();
    otherProbedAt.set(key, started);
    otherProbes.set(key, usage.probe({ exe: cmd.exe, args: cmd.args, env: cmd.env, cwd: os.homedir(), timeout: 45_000 }).then(u => {
      // A turn there may have reported fresher numbers while we waited.
      const now = accounts.readingFor(d.config.get('usageByHost'), account)?.at || 0;
      if (u && now < started) applyOtherUsage(account, u);
    }).catch(err => d.log.info(`usage on ${account.host}: ${err.message}`)).finally(() => otherProbes.delete(key)));
  }

  // The computers you have a conversation open on.
  function refreshOtherUsage() {
    const seen = new Set();
    for (const tab of d.manager?.tabs?.values() || []) {
      const other = accountOfCwd(tab.session?.cwd);
      if (!other || seen.has(accounts.hostKey(other.host))) continue;
      seen.add(accounts.hostKey(other.host));
      probeOther(other);
    }
  }

  // The meter only moves when a turn reports usage, so usage spent elsewhere
  // (another device, the terminal) would wait for your next prompt. Ask Claude
  // Code directly (usage.js: no message is sent, so it costs nothing) when the
  // panel comes up, after the PC wakes and at startup, at most every couple of
  // minutes. Not counted against a tab: no turn of Shellby's spent it.
  let usageProbe = null;
  function refreshUsage() {
    refreshOtherUsage();
    const last = d.config.get('lastUsage')?.at || 0;
    if (usageProbe || d.config.get('crabOnly') || Date.now() - last < USAGE_REFRESH_MS) return;
    const exe = d.FAKE_CLI ? process.env.SHELLBY_NODE || 'node' : d.claudeExe();
    if (!exe) return;
    const started = Date.now();
    usageProbe = usage.probe({ exe, argsPrefix: d.FAKE_CLI ? [d.FAKE_CLI] : [], cwd: os.homedir() }).then(u => {
      usageProbe = null;
      // A turn may have reported fresher numbers while we waited.
      if (u && (d.config.get('lastUsage')?.at || 0) < started) applyUsage(u);
    });
  }

  function watchUsage() {
    d.panel.on('show', refreshUsage);
    d.panel.on('focus', refreshUsage);
    powerMonitor.on('resume', refreshUsage);
    refreshUsage();
  }

  return { SNAPSHOT_WAIT_MS, createManager, currentCwd, endTurn, otherUsage, refreshUsage, toolPicture, turnEnds, turnStarts, watchUsage };
}

module.exports = { wireSessions };
