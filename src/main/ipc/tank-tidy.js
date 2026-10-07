// Tidying up (tank-tidy.js): asked when you open his tank, never on a timer.
// His move goes through the tank's own keep() (tank.sanitize) like any edit.
const tidy = require('../tank-tidy');

/**
 * d: {
 *   config        settings
 *   tank          { view(), keep(draft), lib() } from registerTankIpc
 *   ready()       whether the wardrobe (his decor) is loaded
 *   now(), rand() optional, for tests
 * }
 */
function registerTankTidyIpc(ipcMain, d) {
  const now = () => (d.now ? d.now() : Date.now());
  const rand = () => (d.rand ? d.rand() : Math.random());
  const get = () => tidy.normalize(d.config.get('tankTidy'));
  const nameOf = ref => d.tank.lib().get(ref)?.name || 'a find';

  // Opening the tank: maybe he's tidied. { moved: { name } | null, view, on }
  ipcMain.handle('tank:tidy', () => {
    const t = get();
    if (!d.ready()) return { moved: null, view: null, on: t.on };
    const move = tidy.pick(d.config.get('tank'), { lib: d.tank.lib(), tidy: t, now: now(), rand });
    if (!move) return { moved: null, view: null, on: t.on };
    const r = d.tank.keep(tidy.apply(d.config.get('tank'), move));
    d.config.set({ tankTidy: { ...t, at: now(), last: move } });
    return { moved: { name: nameOf(move.ref), uid: move.uid }, view: r.view, on: t.on };
  });

  // Put it back where you had it.
  ipcMain.handle('tank:tidy-undo', () => {
    const t = get();
    const back = t.last && tidy.undo(d.config.get('tank'), t.last);
    d.config.set({ tankTidy: { ...t, last: null } });
    if (!back) return { ok: false, view: null };
    return { ok: true, view: d.tank.keep(back).view };
  });

  ipcMain.handle('tank:tidy-set', (_e, on) => {
    if (typeof on !== 'boolean') return { ok: false, on: get().on };
    d.config.set({ tankTidy: { ...get(), on } });
    return { ok: true, on };
  });
}

module.exports = { registerTankTidyIpc };
