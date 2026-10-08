// The Bugdex's drawing helpers: a species as a silhouette, grown a stage, in
// gold, shiny or spectral, in a jar for him to hold up, or shrunk to a 3×3
// speck for the tide pool. Art is the gifts.js format: rows of characters,
// '.' empty, every other character a palette key.
//
// Pure. See test/bugdex.test.js.

const SILHOUETTE = '#1d2333';
const OUTLINE = { common: '#9fb3c8', uncommon: '#57cc99', rare: '#4ea8ff', legendary: '#ffc15e', special: '#ff8fab' };

const hex = c => {
  const m = /^#([0-9a-f]{6})$/i.exec(c || '');
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = ([r, g, b]) => `#${[r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const lum = c => { const [r, g, b] = hex(c); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
const mix = (a, b, t) => { const x = hex(a), y = hex(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
const mapPalette = (palette, fn) => Object.fromEntries(Object.entries(palette).map(([k, c]) => [k, fn(c)]));

/** Every colour one dark shade: seen, not caught. */
const silhouette = art => ({ pixels: art.pixels, palette: mapPalette(art.palette, () => SILHOUETTE) });

/** Gold, keeping light and dark apart. */
const golden = art => ({ pixels: art.pixels, palette: mapPalette(art.palette, c => mix('#7a5200', '#fff1a8', lum(c))) });

/** Hue turned a third of the way round the wheel. */
function shiny(art) {
  const rot = c => {
    const [r, g, b] = hex(c);
    return toHex([g * 0.9 + b * 0.1, b * 0.9 + r * 0.1, r * 0.9 + g * 0.1]);
  };
  return { pixels: art.pixels, palette: mapPalette(art.palette, rot) };
}

/** Pale and greenish, like the Haunted Shell's wisps. */
const spectral = art => ({ pixels: art.pixels, palette: mapPalette(art.palette, c => mix(c, '#b8ffd9', 0.55)) });

/** A key not already in the palette, for colours the helpers add. */
function freeKey(palette, wanted) {
  for (const k of [wanted, ...'OoQq0123456789'.split('')]) if (!palette[k] && k !== '.') return k;
  return '~';
}

const INK = '#141225';

/**
 * A portrait with a one-pixel line round its edge, each pixel of it the
 * colour it borders sunk almost to ink, so a red crab gets a deep maroon
 * line and a blue fish a navy one. Grows the art by 1 on every side.
 */
function inked(art) {
  const p = art.palette;
  const w = art.pixels[0].length + 2;
  const grid = [Array(w).fill('.'), ...art.pixels.map(r => ['.', ...r.padEnd(w - 2, '.'), '.']), Array(w).fill('.')];
  const palette = { ...p };
  const keyFor = new Map(); // the colour it borders -> its ink's key
  const spare = [...'0123456789!#$%&*+-:;<=>?@^_~|'].filter(k => !p[k]);
  const out = grid.map((row, y) => row.map((ch, x) => {
    if (ch !== '.') return ch;
    const near = [[0, -1], [-1, 0], [1, 0], [0, 1]].map(([dx, dy]) => grid[y + dy]?.[x + dx]).filter(c => c && c !== '.');
    if (!near.length) return '.';
    // The darkest colour it touches decides the line, so it never glows.
    const by = near.sort((a, b) => lum(p[a]) - lum(p[b]))[0];
    if (!keyFor.has(by)) {
      const k = spare.shift() || by;
      keyFor.set(by, k);
      if (k !== by) palette[k] = mix(p[by], INK, 0.78);
    }
    return keyFor.get(by);
  }).join(''));
  return { pixels: out, palette };
}

/**
 * The art for an evolution stage (1-4): stage 2 is outlined in the rarity's
 * colour, stage 3 adds a sparkle above, stage 4 a crown.
 */
function staged(art, stage = 1, rarity = 'common') {
  if (stage < 2) return art;
  const o = freeKey(art.palette, 'O');
  const w = art.pixels[0].length + 2;
  const grid = [Array(w).fill('.'), ...art.pixels.map(r => ['.', ...r, '.']), Array(w).fill('.')];
  const filled = (x, y) => grid[y]?.[x] && grid[y][x] !== '.' && grid[y][x] !== o;
  const out = grid.map((row, y) => row.map((ch, x) => {
    if (ch !== '.') return ch;
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => filled(x + dx, y + dy)) ? o : '.';
  }).join(''));
  const palette = { ...art.palette, [o]: OUTLINE[rarity] || OUTLINE.common };
  if (stage < 3) return { pixels: out, palette };
  const s = freeKey(palette, 'Q');
  const mid = Math.floor(w / 2);
  const top = stage >= 4
    ? ['.'.repeat(mid - 1) + s + s + s + '.'.repeat(w - mid - 2), '.'.repeat(mid - 1) + s + '.' + s + '.'.repeat(w - mid - 2)].map(r => r.slice(0, w))
    : ['.'.repeat(mid) + s + '.'.repeat(w - mid - 1)];
  return { pixels: [...top.reverse(), ...out], palette: { ...palette, [s]: '#ffd23f' } };
}

/**
 * The creature in a corked jar, to hold up: glass round it, a cork on top.
 * Art up to 8×8 makes a jar up to 12×11.
 */
function jarArt(art) {
  const p = art.palette;
  const j = freeKey(p, 'J'), c = freeKey({ ...p, [j]: 1 }, 'C'), h = freeKey({ ...p, [j]: 1, [c]: 1 }, 'H');
  const w = art.pixels[0].length, inner = w + 2;
  const row = mid => `${j}${mid}${j}`;
  const cork = `.${'.'.repeat(Math.floor((inner - 4) / 2))}${c.repeat(4)}${'.'.repeat(Math.ceil((inner - 4) / 2))}.`;
  const neck = `.${j}${'.'.repeat(inner - 2)}${j}.`;
  const body = art.pixels.map((r, i) => row(`${i === 0 ? h : '.'}${r}.`));
  const pixels = [cork, neck, row('.'.repeat(inner)), ...body, `.${j.repeat(inner)}.`];
  return { pixels, palette: { ...p, [j]: '#bfe9ff', [c]: '#b07a4a', [h]: '#ffffff' } };
}

/** A 3×3 speck: the commonest colour in each ninth of the art. */
function micro(art) {
  const H = art.pixels.length, W = art.pixels[0].length;
  const rows = [];
  for (let y = 0; y < 3; y++) {
    let row = '';
    for (let x = 0; x < 3; x++) {
      const counts = {};
      for (let yy = Math.floor(y * H / 3); yy < Math.max(Math.floor((y + 1) * H / 3), Math.floor(y * H / 3) + 1); yy++) {
        for (let xx = Math.floor(x * W / 3); xx < Math.max(Math.floor((x + 1) * W / 3), Math.floor(x * W / 3) + 1); xx++) {
          const ch = art.pixels[yy]?.[xx];
          if (ch && ch !== '.') counts[ch] = (counts[ch] || 0) + 1;
        }
      }
      const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      row += best ? best[0] : '.';
    }
    rows.push(row);
  }
  return { pixels: rows, palette: art.palette };
}

/** The art a catch shows: its form applied (golden beats spectral beats shiny). */
function formed(art, forms = []) {
  const f = new Set(forms);
  if (f.has('golden')) return golden(art);
  if (f.has('spectral')) return spectral(art);
  if (f.has('shiny')) return shiny(art);
  return art;
}

module.exports = { SILHOUETTE, OUTLINE, silhouette, golden, shiny, spectral, staged, jarArt, micro, formed, inked };
