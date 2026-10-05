// Claude Code conversations: the session manager behind the tabs, and the
// snapshot either side of each turn that says what it changed (changes.js).
// Kept out of main.js, which only wires it up.
const fs = require('fs');
const os = require('os');
const path = require('path');
const changes = require('../changes');
const checkup = require('../checkup');
const { findClaude } = require('../claude-cli');
const ctx = require('../context');
const fileIndex = require('../fileindex');
const prBadges = require('../github/pr-badge');
const outputStyles = require('../outputstyles');
const recap = require('../recap');
const { SessionManager } = require('../sessions');
const stickers = require('../stickers');
const { detailOf } = require('../trouble');
const voice = require('../voice');
const { classifyCommand, markRed } = require('../xp');

/** d: what main shares (main.js `shared`). */
function wireSessions(d) {
  // ---- sessions

  function currentCwd() {
    const cwd = d.config.get('cwd');
    return cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  }

  function createManager() {
    d.manager = new SessionManager({
      argsPrefix: d.FAKE_CLI ? [d.FAKE_CLI] : [],
      history: d.history,
      getExe: () => (d.FAKE_CLI ? process.env.SHELLBY_NODE || 'node' : d.claudeStatus?.exe || findClaude(process.env, d.claudePath())),
      getMode: () => d.config.get('mode'),
      getModel: () => d.config.get('model'),
      getEffort: () => d.config.get('effort'),
      getOutputStyle: () => outputStyles.clean(d.config.get('outputStyle')),
      getEnv: () => d.github?.claudeEnv() || {},
      compose: (text, files) => d.composePrompt(text, files),
      prepareTurn: async tab => {
        d.armGuard(tab);
        tab.lastReply = null;
        // Only the summary turn itself may start a conversation fresh (tab:fresh
        // sets it after this runs): a summary turn that died without a result
        // must not take the next ordinary turn with it.
        tab.freshWanted = false;
        await d.armCopy(tab);
        await beginTurn(tab);
      },
      windowShare: weight => d.windowShare({ weight }),
    });

    d.manager.on('spend', (_tabId, s, tab) => d.onSpend(s, tab));
    d.manager.on('call', (_tabId, c, tab) => { if (!d.CAPTURE) d.lean?.onCall(c, tab); });
    // A conversation past the crowded mark: he says so, and the panel offers to make room.
    d.manager.on('context', (_tabId, now, before, tab) => {
      if (ctx.crossed(before, now) && !tab.routineId && !tab.workflowRunId) d.sayText('Getting crowded in here.', 'crowded');
    });

    // Queued messages just handed to Claude mid-turn: their chips can't be edited now.
    d.manager.on('steering', (tabId, ids) => d.send(d.panel, 'tab:steering', { tabId, ids }));

    d.manager.on('item', (tabId, item, tab, tail) => {
      if (item.kind === 'usage') {
        d.config.set({ lastUsage: { ...item, at: Date.now() } });
        d.noteRecap(recap.usageEvent(tabId, tab.title, item));
        d.send(d.panel, 'usage', item);
        d.onUsage(item);
        d.refreshOutlook();
        d.checkGuards();
        return;
      }
      if (item.kind === 'init') {
        d.lastInit = item.toolbox;
        d.toolbox?.setInit(item.toolbox);
        return; // toolbox lists are large; the panel doesn't need them per tab
      }
      d.send(d.panel, 'tab:item', { tabId, item });
      d.workflows?.onTabItem(tabId, item);
      if (item.kind === 'text' && !item.sub) tab.lastReply = item.text;
      if (item.kind === 'decision') d.remote?.settle(item.requestId, item.decision);
      // A test run's "waiting for you" ends once you've answered.
      if (item.kind === 'decision' && d.routineTests.has(tabId)) d.send(d.panel, 'routines:test-run', d.routineTestView(tabId));
      if (item.kind === 'permission') d.onPermission(tabId, item, tab);
      if (item.kind === 'result') d.onResult(tabId, item, tab);
      // The panel shows a sentence (trouble.js); what the program really said goes in the log too.
      // (Not having a copy of the repo isn't a failed turn: main logs that itself.)
      const failed = item.trouble && item.trouble.kind !== 'no-copy';
      if (failed) d.log.warn(`turn failed (${item.trouble.kind})`, detailOf(item.kind === 'error' ? item.text : item.error));
      // Claude Code stopping mid-turn sends no result: a routine's row still has to say it failed
      // (and offer Fix with Claude), not "started 2h ago" for ever.
      if (failed && item.kind === 'error' && d.routineTabs.has(tabId)) d.updateRoutine(d.routineTabs.get(tabId), { lastStatus: 'error' });
      if (item.kind === 'task' && item.phase === 'started') d.stat('helper-spawned');
      if (item.kind === 'tool' && (item.name === 'Bash' || item.name === 'PowerShell') && item.id) {
        const dir = tab.session?.cwd || '';
        const inProject = dir && path.resolve(dir) !== path.resolve(os.homedir());
        // A test run: the code as it was when it started, so a later run can be compared (flaky.js).
        const tree = inProject && !item.background ? d.flakyTree(item.detail, dir) : null;
        d.pendingCommands.set(item.id, { command: item.detail, project: inProject ? path.basename(dir) : null, dir: inProject ? dir : null, cwd: dir || null, tree });
        if (d.pendingCommands.size > 200) d.pendingCommands.delete(d.pendingCommands.keys().next().value);
      }
      if (item.kind === 'tool') d.onToolSpoken(item);
      if (item.kind === 'tool_result' && d.pendingCommands.has(item.id)) {
        const c = d.pendingCommands.get(item.id);
        d.pendingCommands.delete(item.id);
        const meant = classifyCommand(c.command);
        if (item.isError && meant === 'tests' && c.project && d.config && !d.CAPTURE) {
          d.config.set({ xp: markRed(d.config.get('xp'), c.project, Date.now()) });
          d.noteRed(`t:${c.project}`);
        }
        if (c.tree) d.noteTestRun(c, item, tail);
        const kind = !item.isError && meant;
        if (kind) {
          d.awardXp(kind, { project: c.project });
          d.speak(voice.occasionForCommand(kind));
        }
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
    d.manager.on('tabs', summary => {
      d.send(d.panel, 'tabs', summary);
      const saved = summary.filter(t => t.saved && !t.routineId && !t.workflowRunId).map(t => t.id);
      if (!d.CAPTURE) d.config.set({ openTabs: saved });
    });
    d.manager.on('aggregate', agg => {
      d.refreshCritter();
      const s = d.wardrobe?.stats;
      if (s && agg.crew.length > s.maxCrew) d.stat('crew-size', { n: agg.crew.length });
      if (s && agg.busy > s.maxParallel) d.stat('parallel', { n: agg.busy });
    });
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
    if (!cwd || d.CAPTURE) return null;
    let late = false;
    const turnId = tab.turnId;
    const taken = changes.snapshot(cwd).then(snap => { if (snap && !late) turnStarts.set(tab.id, { ...snap, turnId }); });
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
    if (!start) return;
    try {
      const end = await changes.snapshot(start.root);
      const summary = await changes.summarize(start, end);
      // Tagged with its turn: the diff is worked out after the turn ends, by which
      // time the next message may already be in the transcript (rewind.js).
      const turn = start.turnId ? { turnId: start.turnId } : {};
      if (summary) d.manager.note(tabId, { kind: 'changes', ...summary, ...turn });
      // Where the files stood at both ends of the turn, changed or not: a branch
      // from any turn starts its copy from exactly there (branch.js). Not shown.
      if (end && end.root === start.root) d.manager.note(tabId, { kind: 'checkpoint', root: start.root, head: start.head, start: start.tree, endHead: end.head, end: end.tree, ...turn });
    } catch (err) {
      d.log.info(`changes: ${err.message}`);
    }
  }

  return { SNAPSHOT_WAIT_MS, createManager, currentCwd, endTurn, turnEnds, turnStarts };
}

module.exports = { wireSessions };
