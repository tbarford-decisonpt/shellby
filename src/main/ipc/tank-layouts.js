// Saved layouts for his tank (tank/layouts.js): keep the tank under a name,
// put one up, tag one to a season, forget one. Putting one up goes through
// the tank's own keep() (tank.sanitize), so it's checked like any edit.
//
// Putting one up, saving over one with the same name and removing one each
// keep what they replaced as one undo step (tank:layout-undo), like his tidying
// does. It's held here, not in settings: it belongs to this run of the app.
//
// The seasons are looked at whenever the Tank tab asks for its layouts (each
// time you open it): nothing runs on a timer for them.
const layouts = require('../tank/layouts');
const { activeSeasons } = require('../wardrobe/seasons');

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isId = v => typeof v === 'string' && /^[a-z0-9]{1,12}$/.test(v);

/**
 * deps: {
 *   config        settings
 *   tank          { view(), keep(draft) } from registerTankIpc
 *   where()       { south } for the seasons (wiring/critter.js seasonsWhere)
 *   ready()       whether the wardrobe (his decor) is loaded
 *   now()         optional clock, Date.now by default
 * }
 */
function registerTankLayoutsIpc(ipcMain, deps) {
  const now = () => (deps.now ? deps.now() : Date.now());
  const get = () => layouts.normalize(deps.config.get('tankLayouts'));
  const set = state => deps.config.set({ tankLayouts: state });
  const activeNow = () => activeSeasons(new Date(now()), deps.where?.() || {}).map(s => s.id);
  const shape = () => JSON.stringify(layouts.shapeOf(deps.config.get('tank')));
  // The one thing you can take back: { kind: 'use', before, after } (tanks) or
  // { kind: 'remove' | 'replace', layout, at, seasonal, editedAt } (a layout).
  /** @type {null | { kind: string, before?: object, after?: string, layout?: any, at?: number, seasonal?: object | null, editedAt?: number }} */
  let undo = null;
  const reply = (extra = {}) => ({ ok: true, layouts: { ...layouts.view(get()), active: activeNow() }, ...extra });

  // A season starting or ending puts a layout up or takes it down. Returns whether the tank changed.
  function checkSeason() {
    if (!deps.ready()) return false; // without the wardrobe, every piece of decor would look unknown
    const active = activeNow();
    const before = get();
    const { put, state } = layouts.seasonStep(before, { tank: deps.config.get('tank'), active });
    if (JSON.stringify(state) !== JSON.stringify(before)) set(state);
    if (!put) return false;
    undo = null; // the season changed the tank: what you'd have put back is gone
    deps.tank.keep(put);
    return true;
  }

  ipcMain.handle('tank:layouts', () => {
    const changed = checkSeason();
    return reply({ changed, view: changed ? deps.tank.view() : null });
  });

  ipcMain.handle('tank:layout-save', (_e, arg) => {
    if (!isObj(arg)) return { ok: false, error: 'That isn’t a layout.', layouts: layouts.view(get()) };
    const r = layouts.save(get(), { name: arg.name, season: arg.season, tank: deps.config.get('tank'), now: now() });
    if (!r.ok) return { ok: false, error: r.error, layouts: layouts.view(get()) };
    set(r.state);
    if (r.replaced) undo = { kind: 'replace', layout: r.replaced, at: 0, seasonal: null, editedAt: r.state.editedAt };
    else if (undo?.kind !== 'use') undo = null; // the list moved on from what undo would put back
    return reply({ replaced: !!r.replaced });
  });

  ipcMain.handle('tank:layout-use', (_e, id) => {
    const l = isId(id) && get().list.find(x => x.id === id);
    if (!l) return { ok: false, error: 'That layout’s gone.', layouts: layouts.view(get()) };
    const before = layouts.shapeOf(deps.config.get('tank'));
    const r = deps.tank.keep(layouts.asTank(l));
    undo = { kind: 'use', before, after: shape() };
    return reply({ dropped: r.dropped, view: r.view });
  });

  ipcMain.handle('tank:layout-remove', (_e, id) => {
    if (!isId(id)) return { ok: false, layouts: layouts.view(get()) };
    const s = get();
    const at = s.list.findIndex(l => l.id === id);
    const next = layouts.remove(s, id, now());
    set(next);
    undo = at < 0 ? undo : { kind: 'remove', layout: s.list[at], at, seasonal: s.seasonal?.id === id ? s.seasonal : null, editedAt: next.editedAt };
    return reply();
  });

  ipcMain.handle('tank:layout-season', (_e, arg) => {
    if (!isObj(arg) || !isId(arg.id)) return { ok: false, layouts: layouts.view(get()) };
    set(layouts.tag(get(), arg.id, arg.season, now()));
    if (undo?.kind !== 'use') undo = null; // the list moved on from what undo would put back
    return reply();
  });

  // Take back the last put up, replace or remove. Refused once things have
  // changed since (you redecorated, or the list changed here or by sync), so
  // it never undoes more than what you did. An undone layout syncs as a change.
  ipcMain.handle('tank:layout-undo', () => {
    const u = undo;
    undo = null;
    if (!u) return { ok: false, error: 'Nothing to put back.', layouts: layouts.view(get()) };
    if (u.kind === 'use') {
      if (shape() !== u.after) return { ok: false, error: 'The tank’s changed since, so it stays as it is.', layouts: layouts.view(get()) };
      const r = deps.tank.keep(u.before);
      return reply({ undid: 'use', view: r.view });
    }
    const s = get();
    /** @type {any} */
    const r = s.editedAt === u.editedAt && layouts.restore(s, u.layout, { at: u.at, seasonal: u.seasonal, now: now() });
    if (!r?.ok) return { ok: false, error: 'The layouts have changed since, so they stay as they are.', layouts: layouts.view(get()) };
    set(r.state);
    return reply({ undid: u.kind, name: u.layout.name });
  });

}

module.exports = { registerTankLayoutsIpc };
