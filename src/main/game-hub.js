// One bridge for the game screens (docs/GAMIFICATION-PLAN.md section 1.2): the
// Logbook, quest chapters, the reef, review mastery, bug nests, molting, Wrapped,
// level unlocks and the yearbook each register a view here, and the panel reaches
// them all through game:get / game:act (ipc/game.js) and the 'game' event.
// Names outside GAME_VIEWS are refused, so a typo can't open a new channel.

const GAME_VIEWS = Object.freeze(['logbook', 'quests', 'reef', 'review', 'nests', 'molt', 'wrapped', 'unlocks', 'yearbook']);
const ACTION_RE = /^[a-z][a-z0-9-]{0,31}$/;

const isView = what => typeof what === 'string' && GAME_VIEWS.includes(what);

/**
 * d: { send(win, channel, payload), panel } (main.js `shared`), read when a view
 * is pushed, so the panel may be made after the hub.
 */
function createGameHub(d) {
  const parts = new Map();

  /** what: one of GAME_VIEWS. part: { get(arg) -> view, act?(action, payload) -> view }. */
  function register(what, part) {
    if (!isView(what)) throw new Error(`game-hub: unknown view "${what}"`);
    if (!part || typeof part.get !== 'function') throw new Error(`game-hub: "${what}" needs a get()`);
    if (parts.has(what)) throw new Error(`game-hub: "${what}" is registered twice`);
    parts.set(what, part);
  }

  // A view no package has registered yet reads as null: the Logbook shows "not yet".
  function get(what, arg) {
    if (!isView(what)) return null;
    const part = parts.get(what);
    return part ? part.get(arg) ?? null : null;
  }

  function act(what, action, payload) {
    if (!isView(what) || typeof action !== 'string' || !ACTION_RE.test(action)) return null;
    const part = parts.get(what);
    if (!part || typeof part.act !== 'function') return null;
    return part.act(action, payload) ?? null;
  }

  /** Tell the panel a view changed; event: an optional moment to celebrate. */
  function push(what, view, event) {
    if (!isView(what)) return false;
    d.send(d.panel, 'game', event === undefined ? { what, view } : { what, view, event });
    return true;
  }

  const has = what => parts.has(what);

  return { register, get, act, push, has };
}

module.exports = { GAME_VIEWS, ACTION_RE, isView, createGameHub };
