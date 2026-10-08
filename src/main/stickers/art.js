// Sticker art: every project Shellby ships gets a sticker, and this draws it.
// The same project id always gives the same sticker (on every PC), so it's
// generated rather than stored: a shape, a pattern and a monogram, coloured by
// the language the repo is mostly written in.
//
// Three sizes from one drawing: `full` (16x16, the Sticker Book and the
// celebration), `small` (7x7, what he holds up in his claw) and `micro` (3x3,
// what actually sits on his shell, where the whole shell is about 13x12).
// Pure: no I/O. See test/stickers.test.js.

const SIZE = 16;
const SMALL = 7;

// Linguist's colours for the languages people mostly ship.
const LANGUAGES = Object.freeze({
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572a5', Rust: '#dea584', Go: '#00add8',
  'C#': '#178600', Java: '#b07219', Kotlin: '#a97bff', Swift: '#f05138', Dart: '#00b4ab',
  C: '#555555', 'C++': '#f34b7d', Ruby: '#701516', PHP: '#4f5d95', Lua: '#000080',
  HTML: '#e34c26', CSS: '#563d7c', Vue: '#41b883', Svelte: '#ff3e00', Shell: '#89e051',
  PowerShell: '#012456', Elixir: '#6e4a7e', Haskell: '#5e5086', Scala: '#c22d40', Zig: '#ec915c',
  'F#': '#b845fc', R: '#198ce7', Julia: '#a270ba', GDScript: '#355570', Nix: '#7e7eff',
});

const EXTENSIONS = Object.freeze({
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript',
  ts: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', tsx: 'TypeScript',
  py: 'Python', rs: 'Rust', go: 'Go', cs: 'C#', java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
  swift: 'Swift', dart: 'Dart', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++',
  rb: 'Ruby', php: 'PHP', lua: 'Lua', html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'CSS',
  vue: 'Vue', svelte: 'Svelte', sh: 'Shell', bash: 'Shell', ps1: 'PowerShell', psm1: 'PowerShell',
  ex: 'Elixir', exs: 'Elixir', hs: 'Haskell', scala: 'Scala', zig: 'Zig', fs: 'F#', r: 'R',
  jl: 'Julia', gd: 'GDScript', nix: 'Nix',
});

/** The language most of these files are written in (by count), or null. Pure. */
function languageOf(files) {
  const counts = new Map();
  for (const f of Array.isArray(files) ? files : []) {
    if (typeof f !== 'string') continue;
    const m = /\.([a-z0-9+#]+)$/i.exec(f);
    const lang = m && EXTENSIONS[m[1].toLowerCase()];
    if (lang) counts.set(lang, (counts.get(lang) || 0) + 1);
  }
  /** @type {[string, number] | null} */
  let best = null;
  for (const [lang, n] of counts) if (!best || n > best[1]) best = [lang, n];
  return best ? best[0] : null;
}

// ------------------------------------------------------------------ colour

const hexToRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const rgbToHex = rgb => `#${rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (hex, toward, t) => { const a = hexToRgb(hex), b = hexToRgb(toward); return rgbToHex(a.map((v, i) => v + (b[i] - v) * t)); };
const luminance = hex => { const [r, g, b] = hexToRgb(hex).map(v => v / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

function hslToHex(h, s, l) {
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex([f(0), f(8), f(4)].map(v => v * 255));
}

function hueOf(hex) {
  const [r, g, b] = hexToRgb(hex).map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

// ------------------------------------------------------------------ seed

/** A small, fast PRNG (mulberry32) from a project id. */
function rng(id) {
  let h = 2166136261;
  for (const ch of String(id || 'shellby')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ shapes

// Each shape is "is this point on the sticker?" in a 16x16 box, inset so a
// white die-cut border fits around it. Points are pixel centres.
const C = 7.5;
const SHAPES = Object.freeze({
  circle: (x, y) => (x - C) ** 2 + (y - C) ** 2 <= 6.2 ** 2,
  square: (x, y) => Math.abs(x - C) <= 5.6 && Math.abs(y - C) <= 5.6 && Math.abs(x - C) + Math.abs(y - C) <= 10,
  hexagon: (x, y) => Math.abs(x - C) <= 5.6 && Math.abs(x - C) * 0.58 + Math.abs(y - C) <= 6.6,
  shield: (x, y) => y >= 1.5 && y <= 13.5 && Math.abs(x - C) <= (y <= 8 ? 5.6 : 5.6 - (y - 8) * 0.95),
  diamond: (x, y) => Math.abs(x - C) + Math.abs(y - C) <= 7.1,
  burst: (x, y) => {
    const a = Math.atan2(y - C, x - C);
    return Math.hypot(x - C, y - C) <= 5.5 + 1 * Math.max(0, Math.cos(a * 12));
  },
  pill: (x, y) => Math.abs(y - C) <= 4.6 && (Math.abs(x - C) <= 2.5 || (Math.abs(x - C) - 2.5) ** 2 + (y - C) ** 2 <= 4.6 ** 2),
});
const SHAPE_IDS = Object.freeze(Object.keys(SHAPES));
const ROUND = new Set(['circle', 'burst', 'pill', 'blob']);

function blob(rand) {
  const p1 = rand() * Math.PI * 2, p2 = rand() * Math.PI * 2;
  return (x, y) => {
    const a = Math.atan2(y - C, x - C);
    return Math.hypot(x - C, y - C) <= 5.6 + 0.6 * Math.sin(3 * a + p1) + 0.4 * Math.sin(5 * a + p2);
  };
}

// ------------------------------------------------------------------ patterns

const PATTERNS = Object.freeze({
  solid: () => false,
  stripes: (x, y) => (x + y) % 4 < 2,
  dots: (x, y) => x % 3 === 1 && y % 3 === 1,
  checker: (x, y) => ((x >> 1) + (y >> 1)) % 2 === 0,
  waves: (x, y) => (y + Math.round(Math.sin(x / 1.4) * 1.2)) % 4 === 0,
  rings: (x, y) => Math.floor(Math.hypot(x - C, y - C)) % 3 === 0,
  split: (x, y) => y < C,
});
const PATTERN_IDS = Object.freeze(Object.keys(PATTERNS));

// ------------------------------------------------------------------ the monogram

// A 5x5 pixel font: the first letter or digit of the project's name.
const FONT = Object.freeze({
  A: ['.###.', '#...#', '#####', '#...#', '#...#'], B: ['####.', '#...#', '####.', '#...#', '####.'],
  C: ['.####', '#....', '#....', '#....', '.####'], D: ['####.', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '####.', '#....', '#####'], F: ['#####', '#....', '####.', '#....', '#....'],
  G: ['.####', '#....', '#.###', '#...#', '.###.'], H: ['#...#', '#...#', '#####', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '#####'], J: ['..###', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#..#.', '#.#..', '##...', '#.#..', '#..#.'], L: ['#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'], N: ['#...#', '##..#', '#.#.#', '#..##', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '.###.'], P: ['####.', '#...#', '####.', '#....', '#....'],
  Q: ['.###.', '#...#', '#.#.#', '#..#.', '.##.#'], R: ['####.', '#...#', '####.', '#..#.', '#...#'],
  S: ['.####', '#....', '.###.', '....#', '####.'], T: ['#####', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '.###.'], V: ['#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'], X: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  Y: ['#...#', '.#.#.', '..#..', '..#..', '..#..'], Z: ['#####', '...#.', '..#..', '.#...', '#####'],
  0: ['.###.', '#..##', '#.#.#', '##..#', '.###.'], 1: ['..#..', '.##..', '..#..', '..#..', '.###.'],
  2: ['####.', '....#', '.###.', '#....', '#####'], 3: ['####.', '....#', '.###.', '....#', '####.'],
  4: ['#..#.', '#..#.', '#####', '...#.', '...#.'], 5: ['#####', '#....', '####.', '....#', '####.'],
  6: ['.###.', '#....', '####.', '#...#', '.###.'], 7: ['#####', '....#', '...#.', '..#..', '..#..'],
  8: ['.###.', '#...#', '.###.', '#...#', '.###.'], 9: ['.###.', '#...#', '.####', '....#', '.###.'],
  '*': ['#.#.#', '.###.', '#####', '.###.', '#.#.#'],
});

/** The character a project's sticker shows: its first letter or digit. */
function monogram(name) {
  const m = /[a-z0-9]/i.exec(String(name || ''));
  return m ? m[0].toUpperCase() : '*';
}

// ------------------------------------------------------------------ drawing

// Palette keys: w die-cut, K outline, m main, l light, d dark, g glyph, a accent.
function paletteFor(base, rand) {
  const main = base;
  const accentHue = (hueOf(base) + 150 + Math.floor(rand() * 60)) % 360;
  return {
    w: '#fffaf0',
    K: mix(main, '#10161a', 0.62),
    m: main,
    l: mix(main, '#ffffff', 0.38),
    d: mix(main, '#10161a', 0.3),
    g: luminance(main) > 0.55 ? '#16201f' : '#fffaf0',
    a: hslToHex(accentHue, 0.75, 0.58),
  };
}

function baseColour(project, rand) {
  const lang = LANGUAGES[project.lang];
  if (!lang) return hslToHex(Math.floor(rand() * 360), 0.62, 0.52);
  // Two JavaScript repos shouldn't come out identical: nudge the shade a little.
  const t = (rand() - 0.5) * 0.3;
  return t < 0 ? mix(lang, '#10161a', -t) : mix(lang, '#ffffff', t);
}

/** Draws a project's sticker: { full, small, micro, shape, pattern, glyph, round }. Pure. */
function draw(project) {
  if (project?.custom) return fromCustom(project.custom);
  const rand = rng(project?.id);
  const shapeId = SHAPE_IDS.concat('blob')[Math.floor(rand() * (SHAPE_IDS.length + 1))];
  const inside = shapeId === 'blob' ? blob(rand) : SHAPES[shapeId];
  const patternId = PATTERN_IDS[Math.floor(rand() * PATTERN_IDS.length)];
  const pattern = PATTERNS[patternId];
  const palette = paletteFor(baseColour(project || {}, rand), rand);
  const glyph = FONT[monogram(project?.name)];

  const body = (x, y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE && inside(x, y);
  const near = (x, y, test) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => test(x + dx, y + dy));
  const rows = [];
  for (let y = 0; y < SIZE; y++) {
    let row = '';
    for (let x = 0; x < SIZE; x++) {
      if (!body(x, y)) {
        // The die-cut: a white border hugging the shape, one pixel wide (diagonals too).
        const ring = near(x, y, body) || [[1, 1], [-1, 1], [1, -1], [-1, -1]].some(([dx, dy]) => body(x + dx, y + dy));
        row += ring ? 'w' : '.';
        continue;
      }
      if (near(x, y, (a, b) => !body(a, b))) { row += 'K'; continue; }
      const gx = x - 5, gy = y - 5;
      if (gx >= 0 && gx < 5 && gy >= 0 && gy < 5 && glyph[gy][gx] === '#') { row += 'g'; continue; }
      // A clean plate behind the monogram so it reads over any pattern.
      if (gx >= -1 && gx <= 5 && gy >= -1 && gy <= 5) { row += gy === 5 || gx === 5 ? 'd' : 'm'; continue; }
      row += pattern(x, y) ? 'l' : 'm';
    }
    rows.push(row);
  }
  // A spark of the accent colour, so siblings in the same language still differ.
  const open = [];
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    const inPlate = x >= 4 && x <= 10 && y >= 4 && y <= 10;
    if ('ml'.includes(ch) && !inPlate) open.push([x, y]);
  }));
  if (open.length) {
    const [x, y] = open[Math.floor(rand() * open.length)];
    rows[y] = rows[y].slice(0, x) + 'a' + rows[y].slice(x + 1);
  }

  const round = ROUND.has(shapeId);
  return {
    shape: shapeId, pattern: patternId, glyph: monogram(project?.name), round,
    full: { palette, pixels: rows },
    small: { palette, pixels: shrink(rows, SMALL) },
    micro: { palette, pixels: round ? ['wmw', 'mam', 'wdw'] : ['lmm', 'mam', 'mmd'] },
  };
}

// Nearest-neighbour shrink of the full drawing (pixel centres), for the claw.
function shrink(rows, n) {
  const out = [];
  for (let y = 0; y < n; y++) {
    let row = '';
    for (let x = 0; x < n; x++) row += rows[Math.floor((y + 0.5) * SIZE / n)][Math.floor((x + 0.5) * SIZE / n)];
    out.push(row);
  }
  return out;
}

// A repo's own sticker (.shellby/sticker.json), already validated by stickers.js.
function fromCustom(c) {
  const full = { palette: { ...c.palette }, pixels: [...c.pixels] };
  const h = full.pixels.length, w = Math.max(...full.pixels.map(r => r.length));
  const n = Math.max(w, h);
  const square = full.pixels.map(r => r.padEnd(n, '.'));
  while (square.length < n) square.push('.'.repeat(n));
  const micro = c.micro ? { palette: full.palette, pixels: [...c.micro] } : { palette: full.palette, pixels: shrink3(square) };
  return {
    shape: 'custom', pattern: 'custom', glyph: '', round: false,
    full, small: { palette: full.palette, pixels: n <= SMALL ? square : shrinkAny(square, SMALL) }, micro,
  };
}
const shrinkAny = (rows, n) => {
  const s = rows.length;
  const out = [];
  for (let y = 0; y < n; y++) {
    let row = '';
    for (let x = 0; x < n; x++) row += rows[Math.floor((y + 0.5) * s / n)][Math.floor((x + 0.5) * s / n)];
    out.push(row);
  }
  return out;
};
// The micro of a custom drawing: its 3x3 shrink, with holes filled by the most
// common colour so it never has gaps on his shell.
function shrink3(rows) {
  const small = shrinkAny(rows, 3);
  const counts = new Map();
  for (const ch of rows.join('')) if (ch !== '.') counts.set(ch, (counts.get(ch) || 0) + 1);
  const fill = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || 'w';
  return small.map(r => r.replace(/\./g, fill));
}

// ------------------------------------------------------------------ finishes

const TIER_FINISH = Object.freeze({
  paper: null,
  vinyl: { l: 0.18 },             // a little shinier
  holo: { l: 0.25 },              // the shimmer itself is CSS (it moves)
  foil: { border: '#e9c46a', l: 0.3 },
});

/**
 * What goes on his shell: the micro drawing with its tier finish and its age.
 * weather: 'fresh' | 'peeling' (a corner lifts) | 'faded'. flip mirrors it.
 */
function onShell(art, { tier = 'paper', weather = 'fresh', flip = false } = {}) {
  const palette = { ...art.micro.palette };
  const finish = TIER_FINISH[tier];
  if (finish?.l && palette.l) palette.l = mix(palette.l, '#ffffff', finish.l);
  let pixels = [...art.micro.pixels];
  if (finish?.border) {
    palette.y = finish.border;
    pixels = pixels.map((r, y) => [...r].map((ch, x) => ((x !== 1 || y !== 1) && (x + y) % 2 === 0 ? 'y' : ch)).join(''));
  }
  if (weather !== 'fresh') {
    // The backing paper shows where the corner has lifted.
    palette.p = '#f4ecd8';
    pixels[0] = pixels[0].slice(0, 2) + 'p';
    if (weather === 'faded') for (const k of Object.keys(palette)) if (k !== 'p') palette[k] = mix(palette[k], '#d9d2c3', 0.45);
  }
  if (flip) pixels = pixels.map(r => [...r].reverse().join(''));
  return { palette, pixels };
}

module.exports = {
  LANGUAGES, EXTENSIONS, SHAPE_IDS, PATTERN_IDS, FONT, SIZE,
  languageOf, monogram, draw, onShell, rng, luminance,
};
