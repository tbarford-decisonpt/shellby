// Saved layouts for his tank (tank-layouts.js): keep the tank under a name,
// put one up, tag one to a season, forget one. Putting one up goes through
// the tank's own keep() (tank.sanitize), so it's checked like any edit.
//
// The seasons are looked at whenever the Tank tab asks for its layouts (each
// time you open it): nothing runs on a timer for them.
const layouts = require('../tank-layouts');
const { activeSeasons } = require('../wardrobe/seasons');

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isId = v => typeof v === 'string' && /^[a-z0-9]{1,12}$/.test(v);

/**
 * d: {
 *   config        settings
 *   tank          { view(), keep(draft) } from registerTankIpc
 *   where()       { south } for the seasons (wiring/critter.js seasonsWhere)
 *   ready()       whether the wardrobe (his decor) is loaded
 *   now()         optional clock, Date.now by default
 * }
 */
function registerTankLayoutsIpc(ipcMain, d) {
  const now = () => (d.now ? d.now() : Date.now());
  const get = () => layouts.normalize(d.config.get('tankLayouts'));
  const set = state => d.config.set({ tankLayouts: state });
  const reply = (extra = {}) => ({ ok: true, layouts: layouts.view(get()), ...extra });

  // A season starting or ending puts a layout up or takes it down. Returns whether the tank changed.
  function checkSeason() {
    if (!d.ready()) return false; // without the wardrobe, every piece of decor would look unknown
    const active = activeSeasons(new Date(now()), d.where?.() || {}).map(s => s.id);
    const before = get();
    const { put, state } = layouts.seasonStep(before, { tank: d.config.get('tank'), active });
    if (JSON.stringify(state) !== JSON.stringify(before)) set(state);
    if (!put) return false;
    d.tank.keep(put);
    return true;
  }

  ipcMain.handle('tank:layouts', () => {
    const changed = checkSeason();
    return reply({ changed, view: changed ? d.tank.view() : null });
  });

  ipcMain.handle('tank:layout-save', (_e, arg) => {
    if (!isObj(arg)) return { ok: false, error: 'That isn’t a layout.', layouts: layouts.view(get()) };
    const r = layouts.save(get(), { name: arg.name, season: arg.season, tank: d.config.get('tank'), now: now() });
    if (!r.ok) return { ok: false, error: r.error, layouts: layouts.view(get()) };
    set(r.state);
    return reply();
  });

  ipcMain.handle('tank:layout-use', (_e, id) => {
    const l = isId(id) && get().list.find(x => x.id === id);
    if (!l) return { ok: false, error: 'That layout’s gone.', layouts: layouts.view(get()) };
    const r = d.tank.keep(layouts.asTank(l));
    return reply({ dropped: r.dropped, view: r.view });
  });

  ipcMain.handle('tank:layout-remove', (_e, id) => {
    if (!isId(id)) return { ok: false, layouts: layouts.view(get()) };
    set(layouts.remove(get(), id, now()));
    return reply();
  });

  ipcMain.handle('tank:layout-season', (_e, arg) => {
    if (!isObj(arg) || !isId(arg.id)) return { ok: false, layouts: layouts.view(get()) };
    set(layouts.tag(get(), arg.id, arg.season, now()));
    return reply();
  });

}

module.exports = { registerTankLayoutsIpc };
