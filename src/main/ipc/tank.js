// His tank's IPC (src/main/tank.js): what's in it, saving a layout from the
// panel's editor, and clearing the "new" dots on decor. Kept out of main.js,
// which only wires it up.
//
// The editor works on a draft of its own and sends the whole tank when you're
// done; tank.sanitize decides what of it he can really have, so nothing the
// panel sends goes into settings unchecked.
const tank = require('../tank');
const gifts = require('../gifts');

const isRef = v => typeof v === 'string' && tank.REF_RE.test(v);
const MAX_SEEN = 200;

/**
 * d: {
 *   config         settings
 *   wardrobe()     the Wardrobe (made at boot), for decor and its unlocks
 *   level()        his XP level
 *   shipped()      projects shipped (stickers.js), for the reef tank
 *   stat(event, payload)   feeds the achievements
 * }
 */
function registerTankIpc(ipcMain, d) {
  const lib = () => tank.library({
    decor: d.wardrobe()?.decorView() || [],
    findState: gifts.normalize(d.config.get('finds')),
    finds: gifts.FINDS,
  });
  const view = (l = lib()) => tank.view({ state: d.config.get('tank'), lib: l, level: d.level(), shipped: d.shipped() });

  ipcMain.handle('tank:get', () => view());

  ipcMain.handle('tank:save', (_e, draft) => {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return { ok: false, error: 'That isn’t a tank.', view: view() };
    const l = lib();
    const previous = d.config.get('tank');
    const { state, dropped } = tank.sanitize(draft, { lib: l, level: d.level(), shipped: d.shipped(), previous, now: Date.now() });
    // Done with nothing changed doesn't need to touch the settings file.
    const same = JSON.stringify({ ...state, editedAt: 0 }) === JSON.stringify({ ...tank.normalize(previous), editedAt: 0 });
    if (!same) d.config.set({ tank: state });
    const v = view(l);
    d.stat('tank-pieces', { n: v.pieces.length });
    return { ok: true, dropped, view: v };
  });

  // Decor you've seen in the tray stops being new (the wardrobe keeps the dots).
  ipcMain.on('tank:seen', (_e, refs) => {
    if (!Array.isArray(refs)) return;
    const keys = refs.slice(0, MAX_SEEN).filter(r => isRef(r) && !r.startsWith('find:'));
    if (keys.length) d.wardrobe()?.markSeen(keys);
  });
}

module.exports = { registerTankIpc };
