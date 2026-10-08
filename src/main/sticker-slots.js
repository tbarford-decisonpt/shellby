// Where stickers can go on his shell. Shells come in many shapes (his own,
// whatever a skin draws, the snail shell, the tin can…), so the spots aren't
// placed by hand: a spot is any 3x3 patch that sits on the shell with shell
// all around it, so the shell's outline always stays visible. Then a spread of
// them is picked, the most central first. Pure. See test/stickers.test.js.

const STICKER = 3;   // a sticker on the shell is 3x3 sprite pixels
const MAX_SLOTS = 6;

/**
 * Which sprite cells are shell: a molt shell's own pixels, or the skin's shell
 * part when he wears the shell he hatched with. Returns rows of booleans.
 */
function shellMask(skin, home) {
  if (home && Array.isArray(home.pixels)) return home.pixels.map(r => [...String(r)].map(ch => ch !== '.'));
  const parts = skin?.parts || {};
  return (skin?.pixels || []).map(r => [...String(r)].map(ch => parts[ch] === 'shell'));
}

const on = (mask, x, y) => !!(mask[y] && mask[y][x]);

function fits(mask, x, y, margin) {
  for (let dy = -margin; dy < STICKER + margin; dy++) {
    for (let dx = -margin; dx < STICKER + margin; dx++) if (!on(mask, x + dx, y + dy)) return false;
  }
  return true;
}

function candidates(mask, margin) {
  const out = [];
  const rows = mask.length, cols = Math.max(0, ...mask.map(r => r.length));
  for (let y = 0; y + STICKER <= rows; y++) for (let x = 0; x + STICKER <= cols; x++) if (fits(mask, x, y, margin)) out.push([x, y]);
  return out;
}

/**
 * Up to `max` sticker spots on a shell, as [x, y] of each sticker's top-left
 * cell. The first is nearest the middle; each next one is as far as it can be
 * from those already chosen, and never overlaps them.
 */
function stickerSlots(mask, max = MAX_SLOTS) {
  const roomy = spread(mask, candidates(mask, 1), max);
  if (roomy.length >= 3) return roomy;
  // A small shell: stickers may touch its outline if that fits more of them.
  const snug = spread(mask, candidates(mask, 0), max);
  return snug.length > roomy.length ? snug : roomy;
}

function spread(mask, pool, max) {
  if (!pool.length) return [];
  let n = 0, sx = 0, sy = 0;
  mask.forEach((r, y) => r.forEach((v, x) => { if (v) { n++; sx += x; sy += y; } }));
  const mid = [sx / n - 1, sy / n - 1]; // centre the sticker, not its corner
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const apart = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) >= STICKER;
  const chosen = [pool.reduce((best, c) => (dist(c, mid) < dist(best, mid) ? c : best))];
  while (chosen.length < max) {
    let best = null, bestD = -1;
    for (const c of pool) {
      if (!chosen.every(s => apart(s, c))) continue;
      const d = Math.min(...chosen.map(s => dist(s, c)));
      if (d > bestD) { best = c; bestD = d; }
    }
    if (!best) break;
    chosen.push(best);
  }
  return chosen;
}

module.exports = { STICKER, MAX_SLOTS, shellMask, stickerSlots };
