// Molting: the optional prestige at level 99 (docs/GAMIFICATION-PLAN.md
// section 2.7). In the UI it's "Molt"; the level-up shell change keeps its own
// name ("moves into a new shell", wiring/progress.js).
//
// A molt starts the level number again at 1 and keeps everything else: total
// XP, XP by kind, every title, badge, shell, decor piece, effect and perk
// (progression/levels.js everLevel is 99 after any molt), the Bugdex, the tank, trophies,
// stickers, quests and the streak. Each molt earns a tier shell of his own
// (progression/shells.js tierShell) and a badge ring round his level. The k-th time round
// the curve is progression/levels.js curveMult(k): quicker the first replay, steeper later.
// Marks (★) only start again on reaching 99 again.
//
// State lives in the XP state as xp.molt = { count, base, at } (progression/xp.js), so it
// syncs with it. Pure: no I/O, no clock (callers pass `now`). See test/molting.test.js.
const { curveMult, xpForLevel, MAX_LEVEL } = require('./levels');
const { normalizeXp, levelOf } = require('./xp');
const shells = require('./shells');

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const MAX_TIERS_SHOWN = 30;

/** Has he reached 99 on this time round? */
const canMolt = xp => levelOf(normalizeXp(xp)).level === MAX_LEVEL;

/**
 * Molt: -> { state, tier, ok }. tier: the new molt count (its tier shell is
 * shells.tierShell(tier)). Not at 99: { state unchanged, tier: null, ok: false }.
 */
function molt(xpIn, now) {
  const s = normalizeXp(xpIn);
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!canMolt(s) || !Number.isFinite(t)) return { state: s, tier: null, ok: false };
  const tier = s.molt.count + 1;
  return { state: { ...s, molt: { count: tier, base: s.total, at: [...s.molt.at, t].slice(-50) } }, tier, ok: true };
}

/** The tier shell for molt k: hand-made up to twelve, then generated (progression/shell-gen.js). */
const tierShell = k => shells.tierShell(k);

/** The ring round his level badge: roman numerals up to XII, then plain numbers, in the tier shell's glow. */
function moltBadge(kIn) {
  const k = Math.max(0, Math.floor(Number(kIn) || 0));
  if (!k) return null;
  const s = tierShell(k);
  return { text: k <= 12 ? ROMAN[k] : String(k), color: s.aura || s.palette.a || '#ffd23f', tier: k };
}

/** A shell for the panel: what the sprite builder needs, with its name. */
const shellCard = s => ({ ...shells.renderShell(s), name: s.name, description: s.description, molt: s.molt });

/** Everything the Molt sheet and the level badge need. */
function moltView(xpIn) {
  const s = normalizeXp(xpIn);
  const v = levelOf(s);
  const k = s.molt.count;
  const into = Math.max(0, s.total - s.molt.base);
  return {
    count: k,
    canMolt: v.level === MAX_LEVEL,
    level: v.level,
    badge: moltBadge(k),
    current: k ? shellCard(tierShell(k)) : null,
    next: shellCard(tierShell(k + 1)),
    nextBadge: moltBadge(k + 1),
    // The tier shells he has earned, newest last (the last MAX_TIERS_SHOWN of them).
    tiers: Array.from({ length: Math.min(k, MAX_TIERS_SHOWN) }, (_, i) => shellCard(tierShell(k - Math.min(k, MAX_TIERS_SHOWN) + i + 1))),
    xpTo99: Math.max(0, xpForLevel(MAX_LEVEL, k) - into),
    curve: curveMult(k),
    nextCurve: curveMult(k + 1),
    at: [...s.molt.at],
  };
}

module.exports = { canMolt, molt, curveMult, tierShell, moltBadge, moltView, ROMAN };
