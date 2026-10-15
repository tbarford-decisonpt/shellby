// Tier shells past the hand-made twelve (progression/shells-molt.js): made from the molt
// number, the same every time and on every PC (docs/GAMIFICATION-PLAN.md
// section 2.7).
//   silhouette: a hand-made shell's (k % 12), so it always fits the skin mask
//   pattern:    floor(k / 12) % 6: spiral, bands, scales, circuit, spots or cracks
//   palette:    the golden angle round the colour wheel, 4 shades and an accent
//               at the opposite hue
//   effects:    a cycle, a sparkle or an aura, picked by the seed; from molt 50, all three
//   name:       an adjective and a noun from the sea and the sky: "Howling Volute"
// Pure: no I/O. See test/shell-gen.test.js.
const { TIER_SHELLS } = require('./shells-molt');

const W = 13, H = 12;
const PATTERNS = ['spiral', 'bands', 'scales', 'circuit', 'spots', 'cracks'];
const ALL_EFFECTS_FROM = 50;

const ADJ = [
  'Howling', 'Gilded', 'Drowned', 'Starlit', 'Molten', 'Hollow', 'Thundering', 'Silent', 'Feral', 'Radiant',
  'Abyssal', 'Frostbitten', 'Ancient', 'Electric', 'Weeping', 'Burning', 'Velvet', 'Shattered', 'Lunar', 'Solar',
  'Venomous', 'Phantom', 'Crowned', 'Tidal', 'Obsidian', 'Opaline', 'Cursed', 'Blessed', 'Spiralling', 'Restless',
  'Dreaming', 'Glacial', 'Volcanic', 'Coral', 'Midnight', 'Stormborn', 'Hexed', 'Iridescent', 'Sunken', 'Eternal',
];
const NOUN = [
  'Volute', 'Whelk', 'Conch', 'Nautilus', 'Cowrie', 'Murex', 'Turban', 'Periwinkle', 'Abalone', 'Cone',
  'Spire', 'Helmet', 'Auger', 'Triton', 'Limpet', 'Scallop', 'Cockle', 'Olive', 'Harp', 'Moon Snail',
  'Comet', 'Nebula', 'Quasar', 'Eclipse', 'Maelstrom', 'Leviathan', 'Kraken', 'Siren', 'Lantern', 'Reliquary',
  'Citadel', 'Chalice', 'Oracle', 'Tempest', 'Geode', 'Pharos', 'Monolith', 'Wyrm', 'Halo', 'Crown',
];

/** A small seeded random: the same seed gives the same numbers in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** HSL (h in degrees, s and l in 0..1) as #rrggbb. */
function hsl(h, s, l) {
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

function paletteFor(k) {
  const hue = (k * 137.508) % 360;
  const opp = (hue + 180) % 360;
  return {
    K: hsl(hue, 0.55, 0.1), d: hsl(hue, 0.6, 0.28), m: hsl(hue, 0.65, 0.45), l: hsl(hue, 0.7, 0.66),
    a: hsl(opp, 0.85, 0.55), A: hsl(opp, 0.95, 0.78), w: '#ffffff',
  };
}

// Each pattern picks a shade for an inside cell. r: this shell's random numbers, drawn once.
const FILL = {
  spiral: (x, y, r) => { const a = Math.atan2(y - 5.5, x - 6) + Math.hypot(x - 6, y - 5.5) * (0.7 + r[0] * 0.5); const v = Math.floor(((a / Math.PI) + 4) * 2) % 4; return 'dmla'[v]; },
  bands: (x, y, r) => { const v = Math.floor((y + x * (r[0] - 0.5)) / (1.5 + r[1])); return 'mldmaA'[((v % 6) + 6) % 6]; },
  scales: (x, y) => ((x + (y % 2 ? 1 : 0)) % 3 === 0 ? 'd' : (y % 2 ? 'm' : 'l')),
  circuit: (x, y, r) => (x % 3 === Math.floor(r[0] * 3) || y % 4 === 1 ? ((x * 7 + y * 3) % 5 === 0 ? 'A' : 'a') : 'd'),
  spots: (x, y, r) => { const sx = (x + Math.floor(r[0] * 4)) % 4, sy = (y + Math.floor(r[1] * 3)) % 3; return sx === 1 && sy === 1 ? 'a' : sx === 2 && sy === 1 ? 'A' : (x + y) % 2 ? 'm' : 'l'; },
  cracks: (x, y, r) => (Math.abs(((x * (1 + r[0]) + y * (1.5 - r[1])) % 4) - 2) < 0.6 ? 'a' : (x + y) % 3 === 0 ? 'd' : 'm'),
};

/**
 * The tier shell for molt k (k > 12; any k >= 1 works): the same shell format
 * as progression/shells-molt.js, with `generated: true`.
 */
function shellGen(kIn) {
  const k = Math.max(1, Math.floor(Number(kIn) || 1));
  const rand = mulberry32(k);
  const base = TIER_SHELLS[k % TIER_SHELLS.length];
  const pattern = PATTERNS[Math.floor(k / TIER_SHELLS.length) % PATTERNS.length];
  const r = [rand(), rand(), rand()];
  const filled = (x, y) => x >= 0 && x < W && y >= 0 && y < H && base.pixels[y][x] !== '.';
  const pixels = base.pixels.map((row, y) => [...row].map((ch, x) => {
    if (ch === '.') return '.';
    // Lit from the top left, like every shell: a highlight on that edge, ink on the other.
    if (!filled(x + 1, y) || !filled(x, y + 1)) return 'K';
    if (!filled(x - 1, y) || !filled(x, y - 1)) return 'l';
    return FILL[pattern](x, y, r);
  }).join(''));
  // A glint where the light lands first.
  const glint = pixels.findIndex(row => /[dmla]/.test(row));
  if (glint >= 0) pixels[glint] = pixels[glint].replace(/[dmla]/, 'w');
  const pick = rand();
  const all = k >= ALL_EFFECTS_FROM;
  const palette = paletteFor(k);
  const shell = {
    molt: k, id: `molt-${k}`, name: `${ADJ[Math.floor(rand() * ADJ.length)]} ${NOUN[Math.floor(rand() * NOUN.length)]}`,
    description: `Molt ${k}. A ${pattern} shell nobody has ever worn before.`,
    top: [...base.top], palette, pixels, generated: true, pattern,
  };
  if (all || pick < 1 / 3) shell.cycle = { keys: ['a', 'A', 'l'], fps: 2 + Math.floor(rand() * 4) };
  if (all || (pick >= 1 / 3 && pick < 2 / 3)) shell.sparkle = 2 + Math.floor(rand() * 5);
  if (all || pick >= 2 / 3) shell.aura = palette.A;
  return shell;
}

module.exports = { shellGen, mulberry32, hsl, PATTERNS, ADJ, NOUN };
