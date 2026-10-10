// Undo to here: a checkpoint before each step of a turn that changes files.
//
// A turn already has a snapshot at each end (changes.js). This adds one before
// each Edit, Write, MultiEdit, NotebookEdit or command, so "Undo to here" on
// that step puts the files back the way they were just before it, taking every
// later step of the turn back with it. The conversation is left alone.
//
// Shellby sees a tool call when Claude asks for it, and a snapshot takes a
// moment, so one taken then could catch the step half done. Instead the
// checkpoint before a step is the snapshot taken after the step before it
// finished (or the turn's own start): nothing runs in between but Claude
// thinking. A step only gets one when that holds: no other step still running
// (Claude's parallel calls), no command left running in the background, and
// the snapshot finished before the step was asked for.
//
// Cheap on purpose: read-only tools and read-only commands take no snapshot,
// results that land together share one, and a turn has at most MAX_POINTS.
//
// Notes in the transcript:
//   { kind: 'step-point', turnId, toolId, root, tree }   a step's checkpoint
//   { kind: 'undone-step', turnId, toolId, to, after, restored }   undone to it
// After an undone-step, the turn's work stands at `to`, not at its 'changes'
// item's `after`: effectiveAfter() is what per-turn Undo and Rewind go back from.

const MAX_POINTS = 40;
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']);
// Tools that never change files: no snapshot after them, and they never spoil one.
const READ_ONLY = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'ExitPlanMode', 'EnterPlanMode',
  'AskUserQuestion', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'BashOutput', 'TaskOutput', 'ToolSearch', 'Skill',
]);
// A command that only looks: one plain program, no redirects, pipes, chains or substitutions.
const LOOKS_ONLY = /^\s*(?:git\s+(?:status|log|diff|show|branch|rev-parse|ls-files|remote)|ls|dir|pwd|cat|type|head|tail|wc|echo|which|where|whoami|rg|grep|Get-ChildItem|Get-Content|Get-Location|Select-String|Test-Path|node\s+(?:-v|--version)|npm\s+(?:-v|--version|ls|view))(?:\s|$)/i;
const SHELL_SYNTAX = /[<>|;&`$(){}\n]/;
// Flags that make a looking command write or run something: git diff --output, rg --pre, -o.
const WRITES_ANYWAY = /(?:^|\s)(?:--output\b|--pre\b|-o\b|-Out)/i;

/** Does this command only read? Pure. */
function readOnlyCommand(cmd) {
  return typeof cmd === 'string' && LOOKS_ONLY.test(cmd) && !SHELL_SYNTAX.test(cmd) && !WRITES_ANYWAY.test(cmd);
}

/** What a tool item is for checkpoints: 'step' (gets one), 'read' (ignored) or 'other' (may change files). Pure. */
function classify(item) {
  if (!item || item.kind !== 'tool' || item.parent || item.sub || typeof item.id !== 'string') return 'read';
  if (READ_ONLY.has(item.name)) return 'read';
  if ((item.name === 'Bash' || item.name === 'PowerShell') && readOnlyCommand(item.detail)) return 'read';
  return FILE_TOOLS.has(item.name) ? 'step' : 'other';
}

/**
 * One tab's checkpoints through a turn. deps:
 *   snapshot(root) -> Promise<{ root, tree } | null>
 *   start() -> the turn's starting snapshot { root, tree, turnId } | null
 *   note(item)  a 'step-point' for the transcript
 *   log?(msg)
 */
function createTracker(deps) {
  let turn = null;

  function fresh(turnId) {
    return { turnId, last: null, busy: false, again: false, pending: new Set(), seen: new Set(), stepsAsked: 0, points: 0, spoilt: false, lastStale: false };
  }

  function lastOf(t) {
    if (t.last) return t.last;
    const s = deps.start();
    return s && s.turnId === t.turnId ? { root: s.root, tree: s.tree } : null;
  }

  // After the steps running have all finished: where the files stand now.
  function settle(t) {
    if (t.busy) { t.again = true; return; }
    const root = lastOf(t)?.root;
    if (!root) return;
    t.busy = true;
    const asked = t.stepsAsked;
    t.last = null; // until this one lands, nothing before the next step is known
    t.lastStale = true;
    Promise.resolve(deps.snapshot(root)).catch(() => null).then(snap => {
      t.busy = false;
      if (turn !== t) return;
      // A step asked for while it was being taken may already be in it.
      if (snap && asked === t.stepsAsked && !t.again) { t.last = { root: snap.root, tree: snap.tree }; t.lastStale = false; }
      if (t.again) { t.again = false; if (!t.pending.size) settle(t); }
    });
  }

  /** Every item of the tab, with the turn it belongs to. */
  function onItem(item, turnId) {
    if (!turnId) return;
    if (!turn || turn.turnId !== turnId) turn = fresh(turnId);
    const t = turn;
    if (item?.kind === 'tool') {
      const what = classify(item);
      if (what === 'read' || t.seen.has(item.id)) return;
      t.seen.add(item.id);
      t.stepsAsked += 1;
      const base = t.lastStale ? null : lastOf(t);
      if (what === 'step' && base && !t.busy && !t.pending.size && !t.spoilt && t.points < MAX_POINTS) {
        t.points += 1;
        deps.note({ kind: 'step-point', turnId, toolId: item.id, root: base.root, tree: base.tree });
      }
      t.pending.add(item.id);
      // A command left running carries on changing files after its result.
      if (item.background) t.spoilt = true;
      return;
    }
    if (item?.kind === 'tool_result' && t.pending.delete(item.id) && !t.pending.size && !t.spoilt && t.points < MAX_POINTS) settle(t);
  }

  return { onItem, get turn() { return turn; } };
}

// ---- reading a transcript (pure)

/** The step-point items of a turn, in order. */
const pointsOf = (items, turnId) => items.filter(i => i?.kind === 'step-point' && i.turnId === turnId);

/** The last step a turn was undone to, else null. */
function lastUndoneStep(items, turnId) {
  return [...items].reverse().find(i => i?.kind === 'undone-step' && i.turnId === turnId) || null;
}

/** Where a turn's work stands: the newest step or hunk of it taken back, else null (its own end). */
function lastTakenBack(items, turnId, after) {
  return [...items].reverse().find(i => (i?.kind === 'undone-step' && i.turnId === turnId)
    || (i?.kind === 'undone-hunk' && i.after === after)) || null;
}

/** A per-turn change ref with its `after` moved to where an "Undo to here" or a hunk's undo left that turn. */
function effectiveAfter(items, ref) {
  const list = Array.isArray(items) ? items : [];
  const ch = list.find(i => i?.kind === 'changes' && i.after === ref.after && i.before === ref.before);
  if (!ch) return ref;
  const last = lastTakenBack(list, ch.turnId ?? null, ref.after);
  return last && last.after === ref.after ? { ...ref, after: last.to } : ref;
}

/**
 * What "Undo to here" on a step would do, or why it can't.
 * -> { ok: true, point, root, to, from, after } | { ok: false, error }
 */
function planStep(items, turnId, toolId) {
  const list = Array.isArray(items) ? items : [];
  const points = pointsOf(list, turnId);
  const at = points.findIndex(p => p.toolId === toolId);
  if (at < 0) return { ok: false, error: "That step has no checkpoint any more." };
  const point = points[at];
  const end = list.find(i => i?.kind === 'checkpoint' && i.turnId === turnId);
  if (!end || end.root !== point.root) return { ok: false, error: "That turn's end wasn't recorded, so its steps can't be undone one by one." };
  const changed = list.find(i => i?.kind === 'changes' && i.turnId === turnId);
  if (changed && list.some(i => i?.kind === 'undone' && i.after === changed.after)) return { ok: false, error: 'That whole turn has been undone already.' };
  const last = lastUndoneStep(list, turnId);
  if (last) {
    const lastAt = points.findIndex(p => p.toolId === last.toolId);
    if (lastAt >= 0 && lastAt <= at) return { ok: false, error: 'That step has been undone already.' };
  }
  // A turn whose diff was cut to its own files (changes.scope) undoes only those.
  const paths = changed?.scoped && Array.isArray(changed.files) ? changed.files.map(f => f.path) : undefined;
  // Where the work stands now: a hunk taken back since the last step counts.
  const stands = lastTakenBack(list, turnId, changed?.after);
  return { ok: true, point, root: point.root, to: point.tree, from: stands ? stands.to : end.end, after: changed?.after || end.end, ...(paths ? { paths } : {}) };
}

module.exports = { MAX_POINTS, readOnlyCommand, classify, createTracker, effectiveAfter, planStep, pointsOf };
