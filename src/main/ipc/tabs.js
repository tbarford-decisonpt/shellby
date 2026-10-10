// Conversation tabs: opening, ordering, compacting, and what each turn changed
// (changes.js). Kept out of main.js, which only wires it up.
const fs = require('fs');
const os = require('os');
const changes = require('../changes');
const { effectiveAfter } = require('../step-undo');
const ctx = require('../context');
const editor = require('../editor');
const quiz = require('../quiz');
const { run: runCli, skipSettings } = require('../claude/cli');

// The most queued messages that go in at once, and files across all of them (as one task:send).
const MAX_STEERS = 20;
const MAX_STEER_FILES = 20;
// What Claude is told when you say no: a reason, or your notes on its plan.
const MAX_DENY_MESSAGE = 4000;

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerTabsIpc(ipcMain, d) {
  // ---- tabs
  ipcMain.handle('tab:new', (_e, opts = {}) => {
    // A folder is only accepted if it's a project Shellby already tracks (e.g. a nudge's "pick up where you left off").
    const known = d.isStr(opts?.cwd) && d.knownFolder(opts.cwd) && fs.existsSync(opts.cwd);
    try { return { ok: true, tabId: d.openTab(known ? { cwd: opts.cwd } : {}).id }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('tab:close', (_e, tabId) => {
    if (!d.isStr(tabId)) return false;
    // Its held messages go with it, the way its queue does.
    const list = d.heldList();
    if (list.some(h => h.kind === 'message' && h.tabId === tabId)) d.saveHeld(list.filter(h => !(h.kind === 'message' && h.tabId === tabId)));
    d.manager.interrupt(tabId);
    d.cancelChecks(tabId); // its tests stop with it
    const tab = d.manager.tabs.get(tabId);
    d.closePopout(tabId); // in a window of its own: that goes too
    d.manager.close(tabId);
    // A Next up draft closed unsent: its empty copy goes with it (wiring/projects.js).
    if (tab?.unsentCopy) d.dropUnsentCopy?.(tab).then(gone => { if (gone) d.backlogTabClosed?.(tabId); }).catch(e => d.log.info(`unsent copy: ${e.message}`));
    d.routineTabs.delete(tabId);
    d.queueTabs.delete(tabId);
    // A queued task you closed mid-run: the queue moves on to the next one.
    d.queueWaits.get(tabId)?.({ ok: false, interrupted: true, closed: true });
    d.queueWaits.delete(tabId);
    d.workflows?.onTabClosed(tabId);
    d.debugMode?.tabClosed(tabId); // its debug receiver stops listening
    d.remote?.settleTab(tabId);
    return true;
  });
  // Dragging a tab along the strip. The order lives in the manager, and the
  // `tabs` listener in main.js writes it back to `openTabs`, so it survives a restart.
  ipcMain.handle('tab:reorder', (_e, { tabId, beforeId } = {}) =>
    d.isStr(tabId) && d.manager.reorder(tabId, d.isStr(beforeId) ? beforeId : null));
  ipcMain.on('tab:seen', (_e, tabId) => { if (d.isStr(tabId)) d.manager.markRead(tabId); });
  // The conversation on screen: the Stream Deck's Stop and Bring it home follow it (deck.js).
  ipcMain.on('tab:shown', (_e, tabId) => { if (d.isStr(tabId) && d.manager.tabs.has(tabId)) d.deckShownTab(tabId); });
  // A conversation in a window of its own (wiring/popouts.js). x, y: where it was
  // dropped, in screen pixels; carry: what was typed in the panel but not sent.
  ipcMain.handle('tab:pop-out', (_e, { tabId, x, y, carry } = {}) => {
    if (!d.isStr(tabId) || !d.manager.tabs.has(tabId)) return { ok: false, error: 'That conversation is closed.' };
    d.setCarry(tabId, carry);
    return { ok: d.popOut(tabId, { x, y }) };
  });
  // Its window's own ×: back into the panel, with whatever was typed there.
  ipcMain.on('tab:pop-in', (e, { tabId, carry } = {}) => {
    if (!d.isStr(tabId) || d.popoutTabOf(e.sender) !== tabId) return;
    d.setCarry(tabId, carry);
    d.popIn(tabId);
  });
  // The review inbox (review-inbox.js): you've looked at its latest changes, or want them back in the list.
  // after: the changes you looked at. Newer ones that landed meanwhile stay unreviewed.
  ipcMain.handle('tab:reviewed', (_e, { tabId, reviewed = true, after = null } = {}) =>
    d.isStr(tabId) && d.manager.setReviewed(tabId, reviewed !== false, d.isStr(after) ? after : null));

  // The effort chip: this conversation's own effort ('' is Auto).
  ipcMain.handle('tab:effort', (_e, { tabId, effort } = {}) => {
    try { d.isStr(tabId) && d.manager.setTabEffort(tabId, effort); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('task:send', (_e, { tabId, text, attachments } = {}) => {
    text = String(text || '').trim().slice(0, d.PANEL_MAX_TEXT);
    const files = (Array.isArray(attachments) ? attachments : []).filter(d.isStr).slice(0, 20);
    if (!text && !files.length) return { ok: false, error: 'Type a task first.' };
    try {
      // A folder on another computer runs Claude Code there, so this PC needn't have it.
      const ready = (d.claudeStatus?.installed && d.claudeStatus?.loggedIn) || !!d.remoteService?.placeOf(d.currentCwd());
      if (ready && (!d.isStr(tabId) || !d.manager.tabs.has(tabId))) tabId = d.openTab({ tabId: d.isStr(tabId) ? tabId : undefined }).id;
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const r = d.sendToTab(tabId, text, files);
    return r.ok ? { ok: true, tabId: r.tabId, turnId: r.turnId } : r;
  });
  // What's queued behind the turn that's running, to go in at Claude's next step
  // (sessions.js steer). A /command can't go in mid-turn: it, and all after it, wait.
  ipcMain.on('task:steer', (_e, { tabId, turnId, items } = {}) => {
    if (!d.isStr(tabId) || !d.isStr(turnId) || !Array.isArray(items)) return;
    const list = [];
    let filesLeft = MAX_STEER_FILES;
    for (const m of items.slice(0, MAX_STEERS)) {
      const text = typeof m?.text === 'string' ? m.text.trim().slice(0, d.PANEL_MAX_TEXT) : '';
      const files = (Array.isArray(m?.attachments) ? m.attachments : []).filter(d.isStr);
      // Past the cap, the rest wait for the turn to end and go the usual way.
      if (!d.isStr(m?.id) || m.id.length > 64 || text.startsWith('/') || (!text && !files.length) || files.length > filesLeft) break;
      filesLeft -= files.length;
      // !! sends a message that starts with !, as task:send does.
      list.push({ id: m.id, text: text.startsWith('!!') ? text.slice(1) : text, attachments: files });
    }
    d.manager.steer(tabId, turnId, list);
  });
  // A queued message taken back: by its id, so one Claude already has can't be. -> { ok } | { ok: false, taken: true }.
  ipcMain.handle('task:unsteer', (_e, { tabId, id } = {}) => {
    if (!d.isStr(tabId) || !d.isStr(id)) return { ok: false };
    return d.manager.unsteer(tabId, id) ? { ok: true } : { ok: false, taken: true };
  });
  ipcMain.on('task:stop', (_e, tabId) => { if (d.isStr(tabId)) d.manager.interrupt(tabId); });
  // A crowded conversation: Claude writes a summary, then onResult starts it fresh.
  ipcMain.handle('tab:fresh', (_e, tabId) => {
    const tab = d.isStr(tabId) && d.manager.tabs.get(tabId);
    if (!tab?.saved) return { ok: false, error: 'That conversation has nothing to sum up yet.' };
    if (tab.session.busy) return { ok: false, error: 'Let him finish first.' };
    try {
      d.manager.send(tabId, ctx.HANDOFF_ASK, { kind: 'user', text: 'Start fresh with a summary' });
      tab.freshWanted = true; // after send: its prepareTurn clears the flag
      // XP only past the crowded mark: starting fresh sooner throws away context for nothing.
      tab.freshCrowded = (tab.session.context?.pct ?? 0) >= ctx.CROWDED_PCT;
      d.wake();
      return { ok: true, text: 'Start fresh with a summary' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  // What this conversation has cost so far, for the context chip's menu (turncost.js).
  ipcMain.handle('tab:cost', (_e, tabId) => (d.isStr(tabId) ? d.tabCost(tabId) : null));
  ipcMain.handle('task:permission', (_e, { tabId, requestId, decision, message, answers } = {}) => {
    if (!d.isStr(tabId) || !d.isStr(requestId) || !['allow', 'always', 'deny'].includes(decision)) return false;
    // AskUserQuestion answers: a small plain object of question -> answer strings.
    const clean = answers && typeof answers === 'object' && !Array.isArray(answers)
      ? Object.fromEntries(Object.entries(answers).slice(0, 10).filter(([q, a]) => d.isStr(q) && typeof a === 'string'))
      : undefined;
    // Up to a page: notes on a plan go back to Claude as the reason it wasn't approved (feed-logic.js planNotesMessage).
    return d.answerPermission(tabId, requestId, decision, { message: typeof message === 'string' ? message.slice(0, MAX_DENY_MESSAGE) : undefined, answers: clean });
  });

  // ---- what a turn changed
  ipcMain.handle('changes:diff', (_e, raw) => {
    const ref = d.changeRef(raw);
    return ref ? changes.patchFor(ref) : { error: "That isn't a change from this conversation." };
  });
  // "Quiz me" on a turn's changes (quiz.js): Claude writes the questions from the
  // diff, and the answers stay here until each one is picked.
  ipcMain.handle('quiz:start', async (_e, raw) => {
    const ref = d.changeRef(raw);
    const tab = ref && d.manager.tabs.get(ref.tabId);
    if (!ref || !tab) return { ok: false, error: "That isn't a change from this conversation." };
    const item = d.history.load(ref.tabId).find(i => i.kind === 'changes' && i.after === ref.after && i.before === ref.before);
    if (!quiz.worthIt(item?.added, item?.removed)) return { ok: false, error: 'That change is too small for a quiz.' };
    if (tab.quizAsking) return { ok: false, error: 'One quiz at a time: the last one is still being written.' };
    const p = await changes.patchFor(ref);
    if (p.error) return { ok: false, error: p.error };
    const s = tab.session;
    tab.quizAsking = true;
    let r;
    try {
      r = await quiz.ask({ patch: p.patch, truncated: p.truncated, cwd: s.cwd, lean: skipSettings(os.homedir()) },
        (args, timeout, opts) => runCli(s.exePath(), [...(s.argsPrefix || []), ...args], timeout, opts));
    } finally { tab.quizAsking = false; }
    if (r.detail) d.log.warn(`quiz: ${r.detail}`);
    if (!r.ok) return { ok: false, error: r.error };
    tab.quiz = { after: ref.after, ...quiz.start(r.questions) };
    return { ok: true, questions: quiz.view(r.questions) };
  });
  ipcMain.handle('quiz:pick', (_e, { tabId, after, question, choice } = {}) => {
    const tab = d.isStr(tabId) && d.manager.tabs.get(tabId);
    if (!tab?.quiz || tab.quiz.after !== after) return { error: 'That quiz has gone. Ask for a new one.' };
    const r = quiz.pick(tab.quiz, question, choice);
    if (r.error) return { error: r.error };
    tab.quiz = r.state;
    if (r.done) {
      if (quiz.passed(r.state)) d.awardXp('quiz', { label: tab.title });
      tab.quiz = null;
    }
    return { right: r.right, answer: r.answer, why: r.why, done: r.done, score: r.score };
  });
  ipcMain.handle('changes:undo', async (_e, raw) => {
    const ref = d.changeRef(raw);
    if (!ref) return { ok: false, error: "That isn't a change from this conversation." };
    if (ref.retired) return { ok: false, error: 'That copy has been tidied away, and its work is in your checkout now. Undo it there with git.' };
    if (d.manager.isBusy(ref.tabId)) return { ok: false, error: 'Let him finish first, then undo.' };
    if (d.manager.tabs.get(ref.tabId)?.undoingStep) return { ok: false, error: 'Already undoing.' };
    // Read before the undo is noted: what that turn changed and what you'd asked for.
    const lesson = d.correctionFromTurns?.(ref.tabId, 'undo', { afters: [ref.after] });
    // After an Undo to here, the turn's work stands at that step, not at its end (step-undo.js).
    const r = await changes.undo(effectiveAfter(d.history.load(ref.tabId), ref));
    if (r.ok) {
      d.manager.note(ref.tabId, { kind: 'undone', after: ref.after, restored: r.restored });
      d.noteCorrection?.(ref.tabId, lesson); // a correction: twice in one place and he offers a rule (corrections.js)
    }
    return r;
  });
  // Undo to here: the files back to a checkpoint before one step of a turn (wiring/step-undo.js).
  ipcMain.handle('changes:undo-step', (_e, raw) => d.stepUndo.undoStep(raw));
  // The project's own tests, on demand, whatever the setting says (wiring/checks.js).
  ipcMain.handle('checks:run', async (_e, raw) => {
    const ref = d.changeRef(raw);
    if (!ref) return { ok: false, error: "That isn't a change from this conversation." };
    return d.runChecksFor(ref);
  });
  // One file of a turn in VS Code's diff (editor.js): both sides come out of git, never a path from here.
  ipcMain.handle('changes:open-editor', async (_e, raw) => {
    const ref = d.isStr(raw?.file) ? d.changeRef(raw) : null;
    if (!ref) return { ok: false, error: "That isn't a file from this conversation's changes." };
    return editor.open(ref);
  });
  // A before/after picture of the dev server, by an id a 'shots' item in that tab names (wiring/shots.js).
  ipcMain.handle('shots:image', (_e, { tabId, id } = {}) => {
    const url = d.isStr(tabId) && d.isStr(id) ? d.shotImage(tabId, id) : null;
    return url ? { ok: true, url } : { ok: false, error: 'That picture has been tidied away.' };
  });
  // A picture a tool handed Claude, by the id its tool_result names (tool-pictures.js).
  ipcMain.handle('pictures:tool', (_e, { tabId, id } = {}) => {
    const url = d.isStr(tabId) && d.isStr(id) ? d.toolPicture(tabId, id) : null;
    return url ? { ok: true, url } : { ok: false, error: 'That picture has been tidied away.' };
  });
}

module.exports = { registerTabsIpc };
