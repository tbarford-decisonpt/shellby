// Usage that plans itself: each turn's cost goes in a small ledger as it ends
// (turncost.js), and the panel asks what a message usually costs while you
// type it. Kept out of main.js, which only wires it up. Nothing here leaves
// the PC, and the prompt itself is never kept, only its category.
const guard = require('../guard');
const turncost = require('../turncost');

const SAVE_DELAY_MS = 5000;   // turns end in bursts (a workflow's steps); one write when they settle

/** d: what main shares (main.js `shared`). */
function wireUsagePlan(d) {
  let ledger = null;
  let saveTimer = null;
  // tabId -> the turn being measured: { turnId, startedAt, category, size, weight, rise, sawUsage }
  const open = new Map();
  // The last 5-hour reading from any conversation: each new one's rise is put
  // down to the conversation that reported it (as recap.js does).
  let lastReading;

  const rows = () => (ledger ??= turncost.normalize(d.config.get('turnCosts'), Date.now()));

  /** A turn is starting (sessions prepareTurn): note what kind of ask it is. */
  function beginTurn(tab) {
    if (d.CAPTURE || !tab?.turnId) return;
    const text = typeof tab.turnText === 'string' ? tab.turnText : '';
    tab.turnText = null; // the category is all that's kept
    // "Start fresh with a summary" goes on under the turn that asked for it, which has been counted.
    if (tab.costedTurn === tab.turnId || open.get(tab.id)?.turnId === tab.turnId) return;
    open.set(tab.id, {
      turnId: tab.turnId, startedAt: Date.now(),
      category: turncost.classify(text), size: turncost.sizeOf(text),
      weight: 0, rise: 0, sawUsage: false,
    });
  }

  /** One API call's model-weighted spend (spend.js weightOf). */
  function onSpend(tab, weight) {
    const t = tab && open.get(tab.id);
    if (t && Number.isFinite(weight) && weight > 0) t.weight += weight;
  }

  /** A usage reading from a conversation (stream.js usageFrom). */
  function onUsage(tabId, item) {
    const w = item?.fiveHour;
    if (!w || !Number.isFinite(w.pct)) return;
    if (lastReading === undefined) lastReading = d.config.get('lastUsage')?.fiveHour || null;
    const rise = turncost.riseOf(lastReading, w);
    lastReading = { pct: w.pct, resetsAt: w.resetsAt };
    const t = open.get(tabId);
    if (t && rise !== null) {
      t.rise += rise;
      t.sawUsage = true;
    }
  }

  /** The turn ended (timetrack onResult): its row goes in the ledger. A stopped turn is left out. */
  function endTurn(tab, result) {
    const t = open.get(tab.id);
    open.delete(tab.id);
    if (!t || t.turnId !== tab.turnId) return;
    tab.costedTurn = t.turnId;
    if (result?.interrupted || d.CAPTURE) return;
    const src = d.spendSource(tab);
    ledger = turncost.record(rows(), {
      pk: src.pk, project: src.project, kind: src.kind, rid: tab.routineId || null,
      model: tab.session?.lastModel || tab.session?.model || d.config.get('model') || '',
      category: t.category, size: t.size,
      weight: t.weight, pctRise: t.sawUsage ? t.rise : null,
      durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : Date.now() - t.startedAt,
      turns: result?.turns, tokens: result?.tokens, ok: !!result?.ok,
    }, Date.now());
    if (!saveTimer) saveTimer = setTimeout(save, SAVE_DELAY_MS);
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (ledger && d.config) d.config.set({ turnCosts: ledger });
  }

  /** Clear all history: the ledger goes with it. */
  function clear() {
    clearTimeout(saveTimer);
    saveTimer = null;
    ledger = [];
    open.clear();
    d.config.set({ turnCosts: [] });
  }

  /**
   * What a message usually costs, for the composer: the estimate (turncost.js)
   * plus whether it would cross the line and whether to hold it for you.
   * -> { pct, low, high, samples, basis, category, project, over, line, nowPct,
   *      left, guardOn, resetsAt, hold }
   */
  function estimateFor(tabId, text) {
    const now = Date.now();
    const tab = tabId ? d.manager?.tabs.get(tabId) : null;
    const src = tab ? d.spendSource(tab) : d.projectKeyOf(d.currentCwd());
    const model = tab?.session?.lastModel || tab?.session?.model || d.config.get('model') || '';
    const category = turncost.classify(text);
    const est = turncost.estimate(rows(), { pk: src.pk, category, model, now });
    const settings = guard.settingsOf(k => d.config.get(k));
    const advice = turncost.advise(est, d.config.get('lastUsage'), settings, now);
    const kind = tab?.routineId ? 'routine' : tab?.workflowRunId ? 'workflow' : 'tab';
    return {
      ...est, category, project: src.project,
      over: advice.over, line: advice.line, nowPct: advice.now, left: advice.left, guardOn: settings.on, resetsAt: advice.resetsAt,
      hold: turncost.shouldHold({ enabled: d.config.get('holdBigTasks') === true, estimate: est, advice, kind }),
    };
  }

  /** A suggestion for the routine editor: 'sonnet' when its runs are small for the model it's on, else null. */
  function routineSuggestion(routine) {
    return turncost.routineSuggestion(rows(), routine, d.config.get('model') || '', Date.now());
  }

  return { beginTurn, onSpend, onUsage, endTurn, save, clear, estimateFor, routineSuggestion };
}

module.exports = { wireUsagePlan };
