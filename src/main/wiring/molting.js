// Molting at level 99 (progression/molting.js): the 'molt' view the Molt sheet reads
// (renderer molt.js), the molt itself (asked first, then the ceremony on the
// crab: out of his shell, into the tier shell), wearing a tier shell, and the
// quests that belong to it (ninety-nine, molt-or-stay, every-shell).
// Kept out of main.js, which only wires it up.
const { app } = require('electron');
const levels = require('../progression/levels');
const molting = require('../progression/molting');
const shells = require('../progression/shells');
const stickers = require('../stickers');
const { normalizeXp, levelOf } = require('../progression/xp');

const MOLT_MS = 5200;      // as long as the level-up shell change (wiring/progress.js)
const EVERY_SHELL = 10;    // shells worn for the every-shell quest

/** d: what main shares (main.js `shared`). */
function wireMolting(d) {
  // Dev/e2e only: set the XP to a level on the current curve (scripts/e2e-molt.js).
  const DEV = !app.isPackaged && (process.env.SHELLBY_E2E === '1' || process.env.SHELLBY_MOTION_TEST === '1');
  let busy = false;

  const xpNow = () => normalizeXp(d.config?.get('xp'));

  // A molt made on another PC comes over with the XP (sync): its tier shells come with it.
  function reconcileHome() {
    if (!d.config) return;
    const count = xpNow().molt.count;
    const h = shells.normalizeHome(d.config.get('home'));
    if (h.molts < count) d.config.set({ home: shells.withMolts(h, count) });
  }

  function moltView() {
    reconcileHome();
    const xp = xpNow();
    return { ...molting.moltView(xp), worn: shells.normalizeHome(d.config?.get('home')).worn, busy, ...(DEV ? { dev: true } : {}) };
  }

  // The crab's half of the ceremony: out of the old shell, a shiver, into the new one.
  function moveIn(next) {
    const was = d.outfit();
    const h = shells.normalizeHome(d.config.get('home'));
    const carried = stickers.carryOnMolt(d.config.get('stickers'), d.shellIdOf(d.stickerService.wornShellObj()), next.id,
      d.stickerService.shellSpots(d.activeSkin(), next).slots.length, Date.now());
    d.config.set({ home: { ...shells.withMolts(h, next.molt), worn: next.id }, stickers: carried });
    d.flashState('molting', MOLT_MS);
    d.send(d.critter, 'critter:molt', { from: was.home, to: shells.renderShell(next), ms: MOLT_MS, fromStickers: was.stickers, toStickers: d.shellStickers(d.activeSkin(), next) });
    setTimeout(() => {
      d.broadcastSkin();
      d.flashState('levelup', 4000);
      d.send(d.critter, 'critter:burst', d.outfit().confetti);
    }, MOLT_MS);
    d.send(d.panel, 'homes', d.homesView());
    d.send(d.panel, 'stickers', d.stickersView());
  }

  async function doMolt() {
    if (busy) return { ok: false, error: 'He is already molting.', view: moltView() };
    if (!molting.canMolt(xpNow())) return { ok: false, error: 'He molts at level 99.', view: moltView() };
    const next = molting.tierShell(xpNow().molt.count + 1);
    busy = true;
    try {
      const response = await d.askOnce({
        icon: '🐚',
        title: `Molt into the ${next.name}?`,
        message: "He'll be level 1 again and keep everything: every title, shell, decor piece, perk, trophy, bug and his streak.",
        detail: `The climb back is ${Math.round(molting.curveMult(xpNow().molt.count + 1) * 100)}% as long as the first, and ends in another tier shell.`,
        buttons: [{ label: 'Molt', style: 'primary' }, { label: 'Not yet' }], defaultId: 0, cancelId: 1,
      });
      if (response == null) return { ok: false, error: 'Another question from Shellby is open. Answer that one first.', view: moltView() };
      if (response !== 0) return { ok: false, canceled: true, view: moltView() };
      const r = molting.molt(d.config.get('xp'), Date.now());
      if (!r.ok) return { ok: false, error: 'He molts at level 99.', view: moltView() };
      d.config.set({ xp: r.state });
      const shell = molting.tierShell(r.tier);
      if (!d.CAPTURE) moveIn(shell);
      const badge = molting.moltBadge(r.tier);
      d.stat('molted', { n: r.tier });
      d.stat('ever-level', { n: levels.MAX_LEVEL });
      d.questDone?.('molt-or-stay');
      d.life?.remember?.('level', { name: `Molt ${badge.text}, in the ${shell.name}` }); // the journal's "Became …"
      d.levelUpAt = 1;
      d.levelUpMarks = 0;
      d.send(d.panel, 'xp', d.xpView());
      const view = moltView();
      d.gameHub.push('molt', view, { kind: 'molted', tier: r.tier, shell: { ...shells.renderShell(shell), name: shell.name }, badge });
      return { ok: true, tier: r.tier, view };
    } finally {
      busy = false;
    }
  }

  function wear(id) {
    const h = shells.normalizeHome(d.config.get('home'));
    if (typeof id !== 'string' || !shells.moltOf(id) || !shells.unlockedAt(id, levels.MAX_LEVEL, h)) return { ok: false, error: 'He has to molt for that shell first.', view: moltView() };
    d.config.set({ home: { ...h, worn: id } });
    d.broadcastSkin();
    d.send(d.panel, 'homes', d.homesView());
    d.send(d.panel, 'stickers', d.stickersView());
    noteWorn();
    return { ok: true, view: moltView() };
  }

  // Dev/e2e: put him at `level` on this time round's curve, by adding XP to this PC's count.
  function devLevel(payload) {
    const level = Math.max(1, Math.min(levels.MAX_LEVEL, Math.floor(Number(payload?.level) || levels.MAX_LEVEL)));
    const xp = xpNow();
    const want = xp.molt.base + levels.xpForLevel(level, xp.molt.count);
    const add = Math.max(0, want - xp.total);
    const bucket = xp.device || 'local';
    d.config.set({ xp: normalizeXp({ ...xp, byDevice: { ...xp.byDevice, [bucket]: (xp.byDevice[bucket] || 0) + add }, total: xp.total + add }) });
    d.send(d.panel, 'xp', d.xpView());
    d.send(d.panel, 'homes', d.homesView());
    return moltView();
  }

  // every-shell: each shell he has worn, counted on the next XP he earns (and when he wears a tier shell).
  function noteWorn() {
    if (!d.config) return;
    const worn = shells.normalizeHome(d.config.get('home')).worn;
    if (worn === shells.HOME) return;
    const seen = levels.normalizeUnlockSeen(d.config.get('unlockSeen'));
    if (seen.worn.includes(worn)) return;
    const next = { ...seen, worn: [...seen.worn, worn] };
    d.config.set({ unlockSeen: next });
    if (next.worn.length >= EVERY_SHELL) d.questDone?.('every-shell');
  }

  d.onAward?.(e => {
    if (d.CAPTURE || !d.config) return;
    noteWorn();
    // ★1 is the other way to finish molt-or-stay: staying at 99 is a choice too.
    if (e.level === levels.MAX_LEVEL && levelOf(xpNow()).marks >= 1) d.questDone?.('molt-or-stay');
  });

  d.onLevelUp?.(e => {
    if (e.to !== levels.MAX_LEVEL) return;
    d.questDone?.('ninety-nine');
    d.gameHub.push('molt', moltView(), { kind: 'ready' });
  });

  d.gameHub?.register('molt', {
    get: () => (d.config ? moltView() : null),
    act(action, payload) {
      if (!d.config || d.CAPTURE) return null;
      if (action === 'molt') return doMolt();
      if (action === 'wear') return wear(payload?.id);
      if (action === 'dev-level' && DEV) return devLevel(payload);
      return null;
    },
  });

  return { moltView };
}

module.exports = { wireMolting };
