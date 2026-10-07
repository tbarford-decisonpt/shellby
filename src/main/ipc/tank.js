// His tank's IPC (src/main/tank.js): what's in it, saving a layout from the
// panel's editor, and clearing the "new" dots on decor. Kept out of main.js,
// which only wires it up.
//
// The editor works on a draft of its own and sends the whole tank when you're
// done; tank.sanitize decides what of it he can really have, so nothing the
// panel sends goes into settings unchecked.
const tank = require('../tank');
const tankShare = require('../tank-share');
const tankLife = require('../tank-life');
const gifts = require('../gifts');
const friends = require('../friends');
const { LOGIN_RE, sameLogin } = require('../github/card');

const isRef = v => typeof v === 'string' && tank.REF_RE.test(v);
const MAX_SEEN = 200;
const LIVED_GAP_MS = 5000;

/**
 * d: {
 *   config         settings
 *   wardrobe()     the Wardrobe (made at boot), for decor and its unlocks
 *   level()        his XP level
 *   shipped()      projects shipped (stickers.js), for the reef tank
 *   stat(event, payload)   feeds the achievements
 *   cardChanged()  optional: what's on your calling card changed, publish it soon
 *   speak(occasion, opts)  optional: a word on the desktop (voice.js; chatter applies)
 *   life()         optional: his life (life.js), for moments in the bond journal (bond.js MEMORIES)
 * }
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d
 */
function registerTankIpc(ipcMain, d) {
  const lib = () => tank.library({
    decor: d.wardrobe()?.decorView() || [],
    findState: gifts.normalize(d.config.get('finds')),
    finds: gifts.FINDS,
    bugState: d.config.get('bugdex'),
  });
  // The Health porthole looks at his favourite piece, once he has one (tank-life.js).
  const view = (l = lib()) => {
    const v = tank.view({ state: d.config.get('tank'), lib: l, level: d.level(), shipped: d.shipped() });
    const fav = tankLife.favourite(d.config.get('tankLife'), v.layout.placed);
    const p = fav && v.pieces.find(x => x.uid === fav && x.layer !== 'float');
    return p ? { ...v, focusX: p.x + Math.round(p.w / 2), favourite: fav } : { ...v, favourite: null };
  };

  ipcMain.handle('tank:get', () => view());

  ipcMain.handle('tank:save', (_e, draft) => {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return { ok: false, error: 'That isn’t a tank.', view: view() };
    const l = lib();
    const previous = d.config.get('tank');
    const { state, dropped } = tank.sanitize(draft, { lib: l, level: d.level(), shipped: d.shipped(), previous, now: Date.now() });
    // Done with nothing changed doesn't need to touch the settings file.
    const same = JSON.stringify({ ...state, editedAt: 0 }) === JSON.stringify({ ...tank.normalize(previous), editedAt: 0 });
    if (!same) d.config.set({ tank: state });
    if (!same && state.shareCard) d.cardChanged?.(); // friends see the new layout soon, not in a quarter of an hour
    const v = view(l);
    d.stat('tank-pieces', { n: v.pieces.length });
    const life = lived(tank.normalize(previous), state, l);
    return { ok: true, dropped, view: v, life };
  });

  // ---- his life in it (tank-life.js): kept apart from the layout, per PC, never synced

  // What a saved tank means to him: a look at what's new, moving day, sets on display.
  function lived(before, after, l) {
    const r = tankLife.afterSave(d.config.get('tankLife'), { before, after, lib: l, sizes: tank.SIZES, sets: gifts.SETS });
    if (JSON.stringify(r.state) !== JSON.stringify(tankLife.normalize(d.config.get('tankLife')))) d.config.set({ tankLife: r.state });
    d.stat('tank-plants', { n: r.plants });
    d.stat('sets-shown', { n: r.shownCount });
    d.stat('tank-size', { n: tank.SIZES.findIndex(s => s.id === after.size) + 1 });
    const first = r.news.find(n => n.category !== 'find' && n.category !== 'jar') || r.news[0];
    if (first) d.life?.()?.remember('tank-gift', { item: first.name });
    if (r.movedTo) d.life?.()?.remember('moving-day', { size: r.movedTo.name.toLowerCase() });
    for (const s of r.newSets) d.life?.()?.remember('set-shown', { set: s.name });
    const line = r.movedTo ? tankLife.movingLine(r.movedTo) : first ? tankLife.reactionLine(first) : null;
    if (line) d.speak?.('tankNew', { text: line });
    return {
      news: r.news.map(n => n.uid),
      movedTo: r.movedTo ? r.movedTo.id : null,
      line,
      sets: r.newSets.map(s => s.name),
    };
  }

  const lifeView = (st = tank.normalize(d.config.get('tank'))) => {
    const life = tankLife.normalize(d.config.get('tankLife'));
    const showing = tankLife.setsOnDisplay(st.placed, gifts.SETS);
    return {
      favourite: tankLife.favourite(life, st.placed),
      sets: gifts.SETS.filter(s => showing.includes(s.id)).map(s => ({ id: s.id, name: s.name, icon: s.icon })),
    };
  };
  ipcMain.handle('tank:life', () => lifeView());

  // What he got up to while you watched: { uses: { uid: n }, napped }. The panel sends it
  // now and then (not every frame), so the settings file isn't written all the time.
  // At most one report every few seconds (the panel sends one per six activities,
  // each seconds long), and a nap only counts with a real use beside it.
  let livedAt = 0;
  ipcMain.handle('tank:lived', (_e, report) => {
    if (!report || typeof report !== 'object' || Array.isArray(report)) return lifeView();
    const t = Date.now();
    if (t - livedAt < LIVED_GAP_MS) return lifeView();
    livedAt = t;
    const st = tank.normalize(d.config.get('tank'));
    const before = tankLife.normalize(d.config.get('tankLife'));
    const next = tankLife.addUses(before, report.uses, st.placed);
    const used = Object.entries(next.uses).some(([k, n]) => n > (before.uses[k] || 0));
    if (report.napped === true && used) {
      d.stat('tank-nap');
      next.naps = Math.min(tankLife.MAX_USES, next.naps + 1);
    }
    if (JSON.stringify(next) !== JSON.stringify(before)) d.config.set({ tankLife: next });
    return lifeView(st);
  });

  // A word about his tank for the desktop (life.js asks now and then), or null.
  function remark() {
    const st = tank.normalize(d.config.get('tank'));
    if (!st.placed.length) return null;
    const l = lib();
    const pieces = st.placed.map(p => l.get(p.ref)).filter(Boolean);
    const favUid = tankLife.favourite(d.config.get('tankLife'), st.placed);
    const fav = favUid ? l.get(st.placed.find(p => p.uid === favUid)?.ref) : null;
    return tankLife.remark({ pieces, fav });
  };

  // His tank on your calling card, or off it (tank-share.js). The card catches up on the next refresh, started now.
  ipcMain.handle('tank:share', (_e, on) => {
    if (typeof on !== 'boolean') return { ok: false, view: view() };
    const current = tank.normalize(d.config.get('tank'));
    if (current.shareCard !== on) {
      d.config.set({ tank: { ...current, shareCard: on } });
      d.cardChanged?.();
    }
    return { ok: true, view: view() };
  });

  // A friend's tank, from the calling card fetched last time, drawn with this PC's art.
  ipcMain.handle('tank:peek', (_e, login) => {
    if (typeof login !== 'string' || !LOGIN_RE.test(login)) return { ok: false, error: 'No such friend.' };
    const f = friends.normalize(d.config.get('friends')).list.find(x => sameLogin(x.login, login));
    if (!f) return { ok: false, error: 'No such friend.' };
    const peek = f.card?.tank && tankShare.peekView(f.card.tank, { decor: d.wardrobe()?.decorView() || [], finds: gifts.FINDS });
    return peek ? { ok: true, login: f.login, view: peek } : { ok: false, error: `@${f.login} isn’t sharing their tank.` };
  });

  // Decor you've seen in the tray stops being new (the wardrobe keeps the dots).
  ipcMain.on('tank:seen', (_e, refs) => {
    if (!Array.isArray(refs)) return;
    const keys = refs.slice(0, MAX_SEEN).filter(r => isRef(r) && !r.startsWith('find:') && !r.startsWith('jar:'));
    if (keys.length) d.wardrobe()?.markSeen(keys);
  });

  return remark;
}

module.exports = { registerTankIpc };
