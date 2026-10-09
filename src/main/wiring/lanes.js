// Running many conversations at once: the board of lanes, the merge order with
// "Line them up" (merge-train.js), and answering identical permission prompts
// across conversations in one go. The deciding is lanes.js; this is the git,
// the asking and the answering. Kept out of main.js, which only wires it up.
//
// Nothing here runs on its own: the board is worked out when the panel asks,
// and lining copies up only ever starts after you've said yes to it.
const confirm = require('../confirm');
const lanesLib = require('../lanes');
const { runTrain, trainLine } = require('../merge-train');
const worktrees = require('../worktrees');

const DIFF_TIMEOUT_MS = 15000;
const OPTS = { timeout: DIFF_TIMEOUT_MS, env: { GIT_OPTIONAL_LOCKS: '0' } };
const DECISIONS = new Set(['allow', 'deny']);

/** A copy's change against where it left its base: committed and not. -> { files, added, removed } | null */
async function diffOf(w) {
  if (!w || worktrees.checkWorktree(w)) return null;
  const mb = await worktrees.git(w.path, ['merge-base', w.base, 'HEAD'], OPTS);
  if (!mb.ok) return null;
  const r = await worktrees.git(w.path, ['diff', '--numstat', '--no-renames', mb.out.trim(), '--'], OPTS);
  return r.ok ? lanesLib.parseNumstat(r.out) : null;
}

/** d: what main shares (main.js `shared`). */
function wireLanes(d) {
  let training = false;

  // Every waiting prompt: tab by tab, each tab's in the order they came.
  function allPrompts() {
    if (!d.manager) return [];
    const out = [];
    for (const [tabId, tab] of d.manager.tabs) {
      for (const item of tab.session.pending.values()) out.push({ ...item, tabId });
    }
    return out;
  }

  async function lanesView() {
    if (!d.manager) return { lanes: [], order: [], prompts: [], training };
    const diffs = new Map(), roots = new Map();
    await Promise.all([...d.manager.tabs].map(async ([tabId, tab]) => {
      if (!tab.worktree) return;
      roots.set(tabId, tab.worktree.root);
      const diff = await diffOf(tab.worktree).catch(() => null);
      if (diff) diffs.set(tabId, diff);
    }));
    const lanes = lanesLib.lanes({ tabs: d.manager.summary, diffs, clashes: d.clashesView?.() || [], roots });
    return { lanes, order: lanesLib.mergeOrder(lanes), prompts: lanesLib.groupPrompts(allPrompts()), training };
  }

  /** One answer to every prompt in a group. -> { ok, answered } */
  function answerGroup(key, decision) {
    if (typeof key !== 'string' || !DECISIONS.has(decision)) return { ok: false, error: 'That answer is not one Shellby knows.' };
    const group = lanesLib.groupPrompts(allPrompts()).find(g => g.key === key);
    if (!group) return { ok: false, error: 'Those have already been answered.' };
    if (group.look && group.count === 1) {
      const p = group.prompts[0];
      return { ok: !!d.answerPermission(p.tabId, p.requestId, decision), answered: 1 };
    }
    let answered = 0;
    for (const p of group.prompts) if (d.answerPermission(p.tabId, p.requestId, decision)) answered++;
    d.log?.info(`lanes: ${decision} for ${answered} prompts at once (${group.toolName})`);
    return { ok: answered > 0, answered };
  }

  /**
   * Line up the ready copies of one repository (in tabIds' order, which the
   * panel takes from mergeOrder): ask first, then rebase each onto the one
   * before and run the checks between. -> { ok, line, done, at?, reason? }
   */
  async function lineUp(tabIds) {
    if (training) return { ok: false, error: 'Already lining some up.' };
    if (!Array.isArray(tabIds) || tabIds.length < 2 || tabIds.length > 20 || !tabIds.every(id => typeof id === 'string')) {
      return { ok: false, error: 'Pick two copies or more.' };
    }
    const steps = [];
    for (const id of new Set(tabIds)) {
      const tab = d.manager?.tabs.get(id);
      const w = tab?.worktree;
      if (!w || worktrees.checkWorktree(w)) return { ok: false, error: 'One of them has no copy of its own any more.' };
      if (tab.session.busy || tab.session.pending.size) return { ok: false, error: `"${tab.title}" is still working. Let it finish first.` };
      steps.push({ tabId: id, title: tab.title, path: w.path, branch: w.branch, base: w.base, root: w.root });
    }
    const first = steps[0];
    if (steps.some(s => s.base !== first.base || String(s.root).toLowerCase() !== String(first.root).toLowerCase())) {
      return { ok: false, error: 'They have to be copies of the same project, going home to the same branch.' };
    }
    const answer = await confirm.ask(d.panel, {
      ...d.dialogLook(), icon: '🚂', danger: true,
      title: `Line up ${steps.length} copies?`,
      message: `Each branch is rebased onto the one before it (the first onto ${first.base}), and the project's checks run in it before the next. That rewrites their history.`,
      detail: steps.map((s, i) => `${i + 1}. ${s.title}  (${s.branch})`).join('\n'),
      note: 'It stops at the first conflict and undoes that rebase, or at the first red check. Copies with uncommitted work are left alone.',
      buttons: [{ label: 'Line them up' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    }).catch(() => 1);
    if (answer !== 0) return { ok: false, cancelled: true };
    training = true;
    try {
      const result = await runTrain(steps, {
        git: worktrees.git,
        check: s => d.checkCopy(s.tabId, s.path),
        onStep: p => d.send(d.panel, 'lanes:train', { tabId: p.step.tabId, index: p.index, phase: p.phase, of: steps.length }),
      });
      const titleOf = id => steps.find(s => s.tabId === id)?.title || 'a copy';
      d.refreshClashes?.(first.root);
      return { ...result, line: trainLine(result, titleOf) };
    } finally {
      training = false;
      d.send(d.panel, 'lanes:train', { done: true });
    }
  }

  return { lanesView, answerPromptGroup: answerGroup, lineUpCopies: lineUp };
}

module.exports = { wireLanes, diffOf };
