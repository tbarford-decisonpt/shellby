// Tidying up (tank-tidy.js): asked when you open his tank, never on a timer.
// His move goes through the tank's own keep() (tank.sanitize) like any edit.
const tidy = require('../tank-tidy');

/**
 * deps: {
 *   config        settings
 *   tank          { view(), keep(draft), lib() } from registerTankIpc
 *   ready()       whether the wardrobe (his decor) is loaded
 *   now(), rand() optional, for tests
 * }
 */
function registerTankTidyIpc(ipcMain, deps) {
  const now = () => (deps.now ? deps.now() : Date.now());
  const rand = () => (deps.rand ? deps.rand() : Math.random());
  const get = () => tidy.normalize(deps.config.get('tankTidy'));
  const nameOf = ref => deps.tank.lib().get(ref)?.name || 'a find';

  // Opening the tank: maybe he's tidied. { moved: { name } | null, view, on }
  ipcMain.handle('tank:tidy', () => {
    const t = get();
    if (!deps.ready()) return { moved: null, view: null, on: t.on };
    const move = tidy.pick(deps.config.get('tank'), { lib: deps.tank.lib(), tidy: t, now: now(), rand });
    if (!move) return { moved: null, view: null, on: t.on };
    const r = deps.tank.keep(tidy.apply(deps.config.get('tank'), move));
    deps.config.set({ tankTidy: { ...t, at: now(), last: move } });
    return { moved: { name: nameOf(move.ref), uid: move.uid }, view: r.view, on: t.on };
  });

  // Put it back where you had it.
  ipcMain.handle('tank:tidy-undo', () => {
    const t = get();
    const back = t.last && tidy.undo(deps.config.get('tank'), t.last);
    deps.config.set({ tankTidy: { ...t, last: null } });
    if (!back) return { ok: false, view: null };
    return { ok: true, view: deps.tank.keep(back).view };
  });

  ipcMain.handle('tank:tidy-set', (_e, on) => {
    if (typeof on !== 'boolean') return { ok: false, on: get().on };
    deps.config.set({ tankTidy: { ...get(), on } });
    return { ok: true, on };
  });
}

module.exports = { registerTankTidyIpc };
