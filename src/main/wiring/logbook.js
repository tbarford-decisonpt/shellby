// The Logbook (logbook.js), wired up: it gathers the views every game system
// already makes (XP and bounties, quests, the tide event, battles, and the
// game-hub's nests, reef, review, unlocks, molt and Wrapped), composes them
// into cards, and registers the `logbook` game view. Any part that isn't there
// (a package not built yet, a system turned off) reads as null and its card
// says "not yet". A refresh is pushed, a second after things settle, when an
// award, a level-up, a stat or another game view changes. Local only: the
// pins and folds aren't synced. Kept out of main.js, which only wires it up.
const path = require('path');
const logbook = require('../logbook');

const REFRESH_MS = 1000;
const HUB_PARTS = Object.freeze(['nests', 'reef', 'review', 'unlocks', 'molt', 'wrapped']);

/** d: what main shares (main.js `shared`). */
function wireLogbook(d) {
  // One part, or null when it isn't there or throws: never the Logbook's problem.
  function part(name, fn) {
    try { return fn() ?? null; } catch (e) { d.log?.warn?.(`logbook: ${name} unreadable`, e?.message || String(e)); return null; }
  }

  function activeProject() {
    const cwd = part('cwd', () => d.currentCwd?.());
    return typeof cwd === 'string' && cwd ? path.basename(cwd) : '';
  }

  function parts() {
    const hub = d.gameHub;
    const fromHub = Object.fromEntries(HUB_PARTS.map(n => [n, part(n, () => hub?.get(n))]));
    return {
      ...fromHub,
      xp: part('xp', () => d.xpView?.()),
      quests: part('quests', () => d.questsPanelView?.()), // a pure read: chapters open on level-ups and on `open`
      event: part('event', () => d.eventsView?.()),
      battles: part('battles', () => (d.config.get('bugBattles') === false ? null : d.bugdex?.battles?.())),
      week: part('week', () => d.weekView?.()),
      streak: part('streak', () => d.streaksView?.()),
      activeProject: activeProject(),
      state: part('state', () => d.config.get('logbook')),
    };
  }

  function view() {
    if (d.CAPTURE) return logbook.logbookView({}, Date.now());
    return logbook.logbookView(parts(), Date.now());
  }

  const save = next => { if (!d.CAPTURE) d.config.set({ logbook: next }); return view(); };

  function act(action, payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const id = typeof p.id === 'string' ? p.id : '';
    if (action === 'pin') return save(logbook.setPinned(d.config.get('logbook'), id, p.on !== false));
    if (action === 'collapse') return save(logbook.setCollapsed(d.config.get('logbook'), id, p.on !== false));
    if (action === 'open') {
      d.stat('logbook-opened');
      d.unlockQuestChapters?.();
      return save(logbook.opened(d.config.get('logbook'), Date.now()));
    }
    return null;
  }

  // A refresh a second after the last change, and only while someone could see it.
  let timer = null;
  function schedule() {
    if (timer || d.CAPTURE) return;
    timer = setTimeout(() => {
      timer = null;
      if (!d.panel || d.panel.isDestroyed?.() || !d.panel.isVisible?.()) return;
      d.gameHub?.push('logbook', view());
    }, REFRESH_MS);
    timer.unref?.();
  }

  d.gameHub?.register('logbook', { get: view, act });
  d.onAward?.(schedule);
  d.onLevelUp?.(schedule);
  d.onStat?.(event => { if (event !== 'logbook-opened') schedule(); });

  // Another game view changed (the reef, review, nests...): the Logbook reads it too.
  const hub = d.gameHub;
  if (hub && typeof hub.push === 'function') {
    const push = hub.push;
    hub.push = (what, v, event) => {
      const sent = push(what, v, event);
      if (what !== 'logbook') schedule();
      return sent;
    };
  }

  return { logbookView: view, refreshLogbook: schedule };
}

module.exports = { wireLogbook };
