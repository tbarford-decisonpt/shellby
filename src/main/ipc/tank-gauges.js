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
 * }
 * Returns the feed main.js wires the monitor and the dev servers into.
 */
function registerTankGaugesIpc(ipcMain, deps) {
  let snap = null;      // the Health monitor's last sample
  let mood = null;      // its mood
  let last = null;      // what was last sent

  const latestHealth = () => snap || deps.health()?.monitor?.snapshot?.({ withHistory: false }) || null;
  const current = () => gaugesOf.gauges({
    health: latestHealth(),
    mood: deps.moodsOn() ? (mood ?? deps.health()?.monitor?.mood ?? null) : null,
    servers: deps.servers(),
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

  return {
    health(s) { snap = s && typeof s === 'object' ? s : null; push(); },
    mood(m) { mood = m || null; push(); },
    servers() { push(); },
  };
}

module.exports = { registerTankGaugesIpc };
