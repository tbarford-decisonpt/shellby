// The tank's live decor (tank/gauges.js): main hears the Health monitor and
// the dev servers as they change and tells the panel, only when what the tank
// would show is different and only while the panel is open. The panel never
// asks on a timer; it asks once (tank:gauges) when the tank comes into view.
//
// Which gauges are on is `tankLive` in settings: per PC, never synced, never
// on a card.
const gaugesOf = require('../tank/gauges');

/**
 * deps: {
 *   config         settings
 *   toPanel(channel, payload)   sends only while the panel is showing
 *   health()       the HealthService, or null (its monitor's latest snapshot is read on ask)
 *   moodsOn()      whether Health moods are on
 *   servers()      DevServers#summary(), or null
 *   usage()        config.lastUsage, or null
 *   now()          the time (ms), Date.now unless a test says otherwise
 * }
 * Returns the feed main.js wires the monitor and the dev servers into.
 */
function registerTankGaugesIpc(ipcMain, deps) {
  let snap = null;      // the Health monitor's last sample
  let mood = null;      // its mood
  /** @type {ReturnType<typeof gaugesOf.gauges> | null} */
  let last = null;      // what was last sent
  let mergedAt = null;  // when a PR of yours last merged (the chest's glint)
  /** @type {ReturnType<typeof setTimeout> | null} */
  let glintTimer = null;
  const unread = new Set(); // 'recap' / 'week' cards still waiting (the bottle)
  const now = () => (deps.now ? deps.now() : Date.now());

  const latestHealth = () => snap || deps.health()?.monitor?.snapshot?.({ withHistory: false }) || null;
  const current = () => gaugesOf.gauges({
    health: latestHealth(),
    mood: deps.moodsOn() ? (mood ?? deps.health()?.monitor?.mood ?? null) : null,
    servers: deps.servers(),
    usage: deps.usage?.() ?? null,
    mergedAt,
    unread: [...unread],
    now: now(),
    live: deps.config.get('tankLive'),
  });
  const push = () => {
    const next = current();
    if (last && gaugesOf.same(next, last)) return;
    last = next;
    deps.toPanel('tank:gauges', next);
  };

  ipcMain.handle('tank:gauges', () => { last = current(); return last; });

  // One gauge on or off: { key, on }.
  ipcMain.handle('tank:live', (_e, arg) => {
    if (!arg || typeof arg !== 'object' || !gaugesOf.KEYS.includes(arg.key) || typeof arg.on !== 'boolean') return { ok: false, gauges: current() };
    const live = gaugesOf.normalizeLive(deps.config.get('tankLive'));
    deps.config.set({ tankLive: { ...live, [arg.key]: arg.on } });
    last = current();
    return { ok: true, gauges: last };
  });

  // The card the bottle brought was read: { kind: 'recap' | 'week' }.
  ipcMain.handle('tank:bottle-read', (_e, arg) => {
    if (gaugesOf.UNREAD.includes(arg?.kind) && unread.delete(arg.kind)) push();
    return { ok: true };
  });

  return {
    health(s) { snap = s && typeof s === 'object' ? s : null; push(); },
    mood(m) { mood = m || null; push(); },
    servers() { push(); },
    usage() { push(); },
    /** A PR of yours merged: the chest glints for a minute, then main says it stopped. */
    merged() {
      mergedAt = now();
      push();
      if (glintTimer) clearTimeout(glintTimer);
      const timer = setTimeout(() => { glintTimer = null; push(); }, gaugesOf.GLINT_MS + 50);
      timer.unref?.();
      glintTimer = timer;
    },
    /** A recap or weekly card is waiting for you: the bottle bobs up. */
    unread(kind) {
      if (!gaugesOf.UNREAD.includes(kind)) return;
      unread.add(kind);
      push();
    },
  };
}

module.exports = { registerTankGaugesIpc };
