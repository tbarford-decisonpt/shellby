// The crew (crew-roster.js): one lasting helper crab per agent type, with a
// record that grows every time Claude sends that agent out. Fed from each tab's
// items (wiring/sessions.js), kept in settings.json, shown on the Crew page and
// worn by the helper crabs on the desktop.
// Kept out of main.js, which only wires it up.
const roster = require('../crew-roster');
const { publicItem } = require('../wardrobe/service');

// Tools that change files: Claude using one after a helper reported back is the
// helper's finding being acted on.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COUNTED_KEPT = 500;
const AWAITING_TABS = 50;
// How a helper's run ended (task_notification / task_updated). Anything else
// that isn't 'running' (stopped, killed: you or Claude called it off) isn't the
// helper's doing, so it's no run at all, like the helpers a closed tab leaves.
const FAILED = new Set(['failed', 'error']);

/** d: what main shares (main.js `shared`). */
function wireCrew(d) {
  // Task ids already counted: a run is recorded once, however many events say it ended.
  const counted = new Set();
  // tabId -> [{ type, taskId, carried }]: finished runs that may yet be acted on.
  // A run is open for the rest of the turn it ended in; one that ended while the
  // tab was idle (a background helper) stays open through the next turn too.
  const awaiting = new Map();

  const state = () => d.config?.get('crew') || null;

  function save(next, before) {
    if (next === before) return;
    d.config.set({ crew: next });
    d.send(d.panel, 'crew', view());
    for (const up of roster.levelUps(before, next)) d.sayText?.(`${up.name} made level ${up.level}!`, 'crew-level');
    d.refreshCritter?.(); // a new level or hat shows on the helper straight away
  }

  function finished(tabId, tab, item) {
    const t = tab?.session?.tasks?.get(item.taskId);
    if (t?.status === 'running' && item.phase === 'started' && t.subagentType) {
      const before = state();
      return save(roster.enlist(before, t.subagentType, Date.now()), before); // named from its first trip out
    }
    if (!t || t.status === 'running' || counted.has(item.taskId)) return;
    counted.add(item.taskId);
    if (counted.size > COUNTED_KEPT) counted.delete(counted.values().next().value);
    const ok = t.status === 'completed';
    if (!ok && !FAILED.has(t.status)) return;
    const before = state();
    save(roster.recordRun(before, {
      type: t.subagentType, taskId: t.taskId, ok,
      what: t.description,
      tokens: t.usage?.tokens, toolUses: t.usage?.toolUses, durationMs: t.usage?.durationMs ?? (Date.now() - t.startedAt),
    }, Date.now()), before);
    if (!ok) return;
    const list = awaiting.get(tabId) || [];
    awaiting.delete(tabId); // re-added last: the oldest tabs go first past the limit
    awaiting.set(tabId, [...list, { type: t.subagentType, taskId: t.taskId, carried: !tab.session.busy }].slice(-20));
    if (awaiting.size > AWAITING_TABS) awaiting.delete(awaiting.keys().next().value);
  }

  function edited(tabId) {
    const list = awaiting.get(tabId);
    if (!list?.length) return;
    awaiting.delete(tabId);
    const before = state();
    save(roster.actedOn(before, list), before);
  }

  // The turn ended: runs from it close; a background run gets one more turn.
  function turnEnded(tabId) {
    const left = (awaiting.get(tabId) || []).filter(e => e.carried).map(e => ({ ...e, carried: false }));
    if (left.length) awaiting.set(tabId, left);
    else awaiting.delete(tabId);
  }

  /** wiring/sessions.js: every item of every tab. Shellby's own tabs only. */
  function onItem(tabId, item, tab) {
    if (d.CAPTURE || !d.config) return;
    try {
      if (item.kind === 'task' && item.taskId) finished(tabId, tab, item);
      else if (item.kind === 'tool' && !item.parent && EDIT_TOOLS.has(item.name)) edited(tabId);
      else if (item.kind === 'result') turnEnded(tabId);
    } catch (err) {
      d.log?.info(`crew: ${err.message}`);
    }
  }

  // ---- the look on the desktop

  // The critter refreshes often (every helper's progress): each member's level
  // and look are worked out once per roster, and each hat copied once per item.
  let members = { of: undefined, byType: null };
  const membersNow = () => {
    const s = state();
    if (members.of !== s) members = { of: s, byType: new Map(roster.view(s).members.map(m => [m.type, m])) };
    return members.byType;
  };
  const hatCopies = new WeakMap();
  function hatCopy(id) {
    const item = d.wardrobe?.item(id);
    if (!item) return null;
    if (!hatCopies.has(item)) hatCopies.set(item, publicItem(item));
    return hatCopies.get(item);
  }

  const shellbyHats = () => (d.wardrobe ? d.wardrobe.render().accessories.filter(a => a.slot === 'hat') : []);

  // A wardrobe hat as the sprite wants it, or Shellby's own for 'match'.
  function hatItem(wears, mine) {
    if (!wears) return [];
    if (wears === 'match') return mine();
    const it = hatCopy(wears);
    return it ? [it] : [];
  }

  /**
   * The crew as the critter window draws it: each running helper with its crew
   * member's name, level, colour and hat. Helpers from other apps (no member)
   * pass through as they were.
   */
  function dress(crew) {
    const byType = membersNow();
    const hats = d.wardrobe?.data?.crewOutfits !== false;
    let mine = null; // Shellby's hats, only if someone wears them
    const his = () => (mine ??= shellbyHats());
    return crew.map(c => {
      const m = c.tabId ? byType.get(roster.typeKey(c.type)) : null;
      if (!m) return c;
      return { ...c, name: m.name, level: m.level, hue: m.hue, accessories: hats ? hatItem(m.wears, his) : [] };
    });
  }

  /** The Crew page: the roster, each member's hat as drawn, and the hat ladder. */
  function view() {
    const v = roster.view(state());
    let mine = null;
    const his = () => (mine ??= shellbyHats());
    const hatsOn = d.wardrobe?.data?.crewOutfits !== false;
    const list = v.members.map(m => ({ ...m, accessories: hatsOn ? hatItem(m.wears, his) : [] }));
    const ladder = roster.HAT_LADDER.map(([level, id]) => ({ level, id, item: publicItem(d.wardrobe?.item(id)) }));
    return { ...v, members: list, ladder, hatsOn };
  }

  function rename(type, name) {
    const before = state();
    save(roster.rename(before, type, name), before);
    return view();
  }

  function setHat(type, hat) {
    const before = state();
    save(roster.setHat(before, type, hat), before);
    return view();
  }

  return { dress, onItem, rename, setHat, view };
}

module.exports = { wireCrew };
