// "Undo to here" on a step of a turn (step-undo.js): the checkpoints taken
// while each turn runs, and changes:undo-step, which puts the files back to one.
// Kept out of main.js, which only wires it up.
const fs = require('fs');
const changes = require('../changes');
const confirm = require('../confirm');
const fileIndex = require('../fileindex');
const stepUndo = require('../step-undo');

const MAX_LISTED = 4; // changed files named in the question

/** d: what main shares (main.js `shared`). */
function wireStepUndo(d) {
  const trackers = new Map(); // tabId -> its tracker

  function trackerOf(tabId) {
    let t = trackers.get(tabId);
    if (!t) {
      t = stepUndo.createTracker({
        snapshot: root => changes.snapshot(root),
        start: () => d.turnStarts?.get(tabId) || null,
        note: item => d.manager.note(tabId, item),
      });
      trackers.set(tabId, t);
    }
    return t;
  }

  /** wiring/sessions.js: every item of every tab. Never throws. */
  function onItem(tabId, item, tab) {
    if (item?.kind !== 'tool' && item?.kind !== 'tool_result') return;
    if (!tab || !d.manager.tabs.has(tabId)) { trackers.delete(tabId); return; }
    try { trackerOf(tabId).onItem(item, tab.turnId); } catch (err) { d.log.info(`step undo: ${err.message}`); }
  }

  // Files that changed after the turn (by you, or a later turn) go too: ask first.
  async function askToDiscard(list) {
    const named = list.slice(0, MAX_LISTED).join(', ') + (list.length > MAX_LISTED ? ` and ${list.length - MAX_LISTED} more` : '');
    const pick = await confirm.ask(d.panel, {
      ...d.dialogLook?.(), icon: '↩',
      title: 'Undo to here?',
      message: `${list.length === 1 ? 'A file this turn changed has' : `${list.length} files this turn changed have`} changed again since: ${named}.`,
      detail: 'Undoing to here puts them back too, and those later changes are lost.',
      buttons: [{ label: 'Undo anyway', style: 'danger' }, { label: 'Keep them' }], defaultId: 1, cancelId: 1,
    });
    return pick === 0;
  }

  /** changes:undo-step { tabId, turnId, toolId } -> { ok, restored } | { ok: false, error, cancelled? } */
  async function undoStep(raw) {
    const tabId = d.isStr(raw?.tabId) ? raw.tabId : null;
    const tab = tabId && d.manager.tabs.get(tabId);
    if (!tab || !d.isStr(raw.turnId) || !d.isStr(raw.toolId)) return { ok: false, error: "That isn't a step from this conversation." };
    if (d.manager.isBusy(tabId)) return { ok: false, error: 'Let him finish first, then undo.' };
    if (tab.undoingStep) return { ok: false, error: 'Already undoing.' };
    tab.undoingStep = true;
    try {
      await (d.turnEnds?.get(tabId) || Promise.resolve()); // the turn's end checkpoint, if it's still being noted
      const plan = stepUndo.planStep(d.history.load(tabId), raw.turnId, raw.toolId);
      if (!plan.ok) return plan;
      if (!fs.existsSync(plan.root)) return { ok: false, error: 'That copy has been tidied away, and its work is in your checkout now. Undo it there with git.' };
      const ref = { root: plan.root, to: plan.to, from: plan.from, ...(plan.paths ? { paths: plan.paths } : {}) };
      let r = await changes.restoreTo(ref);
      if (!r.ok && r.changedSince?.length) {
        if (!(await askToDiscard(r.changedSince))) return { ok: false, cancelled: true, error: 'Left as it was.' };
        // A queued message may have started a turn while the question was open.
        if (d.manager.isBusy(tabId)) return { ok: false, error: 'He started working again while you decided. Let him finish, then undo.' };
        r = await changes.restoreTo(ref, { force: true });
      }
      if (!r.ok) return r;
      d.manager.note(tabId, { kind: 'undone-step', turnId: raw.turnId, toolId: raw.toolId, to: plan.to, after: plan.after, restored: r.restored });
      fileIndex.forget(tab.session?.cwd);
      d.noteWeek?.('undone', null, 1);
      return r;
    } finally {
      tab.undoingStep = false;
    }
  }

  return { stepUndo: { onItem, undoStep } };
}

module.exports = { wireStepUndo };
