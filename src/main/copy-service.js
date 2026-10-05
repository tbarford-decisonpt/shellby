// A copy of the repo per tab (worktrees.js). A conversation in a git project
// starts in your checkout, and moves into a copy of its own the first time it
// goes to change something: a question makes no branch, and by then Claude
// knows enough to name one.
// Moved out of main.js.
const fs = require('fs');
const path = require('path');
const branch = require('./branch');
const changes = require('./changes');
const worktrees = require('./worktrees');

const NAME_THE_BRANCH = 'Not yet: before anything changes, Shellby moves this conversation into its own copy of the repository, on a new branch. '
  + 'Run no more tools this turn. Reply with one line, "Branch: <name>", where <name> is 2 to 5 lowercase words joined by hyphens that say what this work is '
  + '(for example "Branch: fix-login-redirect"). You will carry on from where you were, in the copy.';

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * d: what this needs from main, read when it's used.
 *   config, manager, history, remote: getters
 *   CAPTURE, log, isStr, worktreeHome, claudeConfigDir,
 *   routineTabs, queueTabs, queueWaits, turnStarts (the tab maps a closed copy leaves)
 */
function createCopies(d) {
  // Before each turn: while the tab has no copy, a hook on the tools that
  // change files sees each call first. The first real change is held back,
  // Claude is asked for a branch name, and when that turn ends moveIntoCopy
  // makes the copy, carries the conversation across and lets Claude carry on there.
  async function armCopy(tab) {
    // A branch (branch.js) already has its copy, but Claude remembers the
    // original's paths: the same hook keeps its changes out of them. Only while
    // that copy is the one it works in: once it's gone, so is the fence.
    if (tab.fence && tab.worktree && !d.CAPTURE && samePath(tab.fence.home || '', tab.worktree.path)) {
      tab.session.beforeWork = input => {
        const why = branch.fenceDenies(tab.fence, input.tool_name, input.tool_input);
        return why ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } } : {};
      };
      return;
    }
    if (!d.config.get('worktrees') || d.CAPTURE || tab.noCopy || tab.routineId || tab.workflowRunId || tab.worktree) {
      tab.session.beforeWork = null;
      return;
    }
    if (tab.session.beforeWork) return;
    const root = await changes.rootOf(tab.session.cwd);
    const home = path.resolve(d.worktreeHome()).toLowerCase() + path.sep;
    // Not a repo, already one of our copies, or a conversation that has already
    // changed files here: it stays where it is.
    if (!root || (path.resolve(root) + path.sep).toLowerCase().startsWith(home)) return;
    if (tab.saved && d.history.load(tab.id).some(i => i.kind === 'changes')) return;
    tab.session.beforeWork = input => {
      if (tab.worktree || tab.noCopy || !d.config.get('worktrees')) return {};
      if (!worktrees.startsWork(input.tool_name, input.tool_input)) return {};
      tab.copyWanted = true;
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NAME_THE_BRANCH } };
    };
  }

  async function moveIntoCopy(tab) {
    const { manager, history } = d;
    tab.copyWanted = false;
    const session = tab.session;
    const from = session.cwd;
    // Busy throughout, so a message typed meanwhile waits for the move.
    session.setBusy(true);
    const carryOn = text => {
      session.setBusy(false);
      if (!manager.tabs.has(tab.id)) return;
      try { session.send(text, manager.prepareTurn(tab)); } catch (err) { d.log.info(`worktree: ${err.message}`); }
    };
    // why: a sentence; detail: what git said, for Copy details and the log.
    const stayHere = (why, detail = '') => {
      tab.noCopy = true;
      if (detail) d.log.warn('worktree', detail);
      const message = `${why.replace(/\.$/, '')}, so this conversation works in your checkout instead.`;
      manager.note(tab.id, { kind: 'error', text: detail || why, trouble: { kind: 'no-copy', message, action: detail ? { id: 'copy', label: 'Copy details' } : null } });
      carryOn('Shellby could not make a copy, so this conversation stays in this folder. Carry on with what you were about to do, here.');
    };

    const made = await worktrees.create(from, { home: d.worktreeHome(), title: worktrees.suggestedName(tab.lastReply) || tab.title });
    if (!manager.tabs.has(tab.id)) { // closed while the copy was being made
      if (made?.ok) worktrees.remove(made.worktree, { force: true });
      return;
    }
    if (!made?.ok) return stayHere(made?.error || "Couldn't make a copy: this folder isn't in a git repository.", made?.detail);
    const w = made.worktree;
    await session.stop();
    if (!worktrees.carryTranscript({ configDir: d.claudeConfigDir(), sessionId: session.sessionId, from, to: w.cwd })) {
      await worktrees.remove(w, { force: true });
      return stayHere("Claude Code's record of this conversation couldn't be carried into the copy");
    }
    tab.worktree = w;
    session.cwd = w.cwd;
    session.beforeWork = null;
    history.update(tab.id, { cwd: w.cwd, worktree: w });
    d.log.info(`worktree: ${w.branch} for ${path.basename(w.root)}`);
    manager.note(tab.id, { kind: 'moved', branch: w.branch, base: w.base });
    manager.changed();
    carryOn(`Shellby has moved this conversation into its own copy of the repository, at ${w.path}, on branch ${w.branch}, started from ${w.base} at its last commit. `
      + `Work there from now on: the project that was at ${w.root} is at ${w.path} in this copy, so use paths under it. `
      + "It has every committed file; anything uncommitted or ignored in the original (node_modules, build output) isn't in it. "
      + 'Carry on with what you were about to do.');
  }

  // Done with the copy: the tab closes (its process has to be gone before
  // Windows lets the folder go), and its History entry points home again.
  async function retireWorktree(tabId, w, { force }) {
    d.remote?.settleTab(tabId);
    await d.manager.closeAndWait(tabId);
    d.routineTabs.delete(tabId);
    d.queueTabs.delete(tabId);
    d.queueWaits.get(tabId)?.({ ok: false, interrupted: true, closed: true });
    d.queueWaits.delete(tabId);
    d.turnStarts.delete(tabId);
    const removed = await worktrees.remove(w, { force });
    // The conversation was Claude's in the copy's folder, and can't be resumed
    // from another one: History keeps the transcript and starts afresh there.
    // The copy's diffs were snapshots in the repository's shared object store,
    // so they still read from your checkout once the folder is gone.
    const copies = (d.history.get(tabId)?.copies || []).filter(c => c.path !== w.path);
    // A branch's fence and note were about its copy (branch.js): with the copy
    // gone it works in your checkout like any conversation, so they go too.
    d.history.update(tabId, { cwd: w.originalCwd, worktree: null, claudeSessionId: null, fence: null, preamble: null, copies: [...copies, { path: w.path, root: w.root }] });
    return removed;
  }

  // What the renderer hands back about a diff block, and nothing else. It has to
  // be a change main reported in that tab's transcript (and, for one file's diff,
  // one of its files): the renderer can't point git at any repo or tree it likes.
  // A change made in a copy that has since been tidied away reads from the repo
  // the copy came from (retired: there's no copy left to undo it in).
  function changeRef(r) {
    const { history, isStr } = d;
    const tabId = isStr(r?.tabId) ? r.tabId : null;
    if (!tabId) return null;
    const reported = history.load(tabId).find(i => i.kind === 'changes' && i.root === r.root && i.before === r.before && i.after === r.after);
    if (!reported) return null;
    if (r.file != null && !reported.files?.some(f => f.path === r.file)) return null;
    const copy = !fs.existsSync(reported.root) && (history.get(tabId)?.copies || []).find(c => isStr(c?.path) && isStr(c?.root) && samePath(c.path, reported.root));
    return {
      tabId, root: copy ? copy.root : reported.root, before: reported.before, after: reported.after,
      ...(copy ? { retired: true } : {}), ...(r.file != null ? { file: r.file } : {}),
    };
  }

  return { armCopy, changeRef, moveIntoCopy, retireWorktree };
}

module.exports = { createCopies, NAME_THE_BRANCH };
