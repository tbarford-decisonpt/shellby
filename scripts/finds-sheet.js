// Draws the finds' portraits to a PNG, to look at while drawing them.
//
//   node scripts/finds-sheet.js [ids or sets...] [--out file.png] [--scale 5] [--forms]
//
// With no ids it draws every find ('strays' picks the ones in no set). Each
// tile is the little art on the left, at twice the scale, and the inked
// portrait on the right; --forms adds the sparkly portrait and the silhouette
// the shelf shows before it's found. Prints where the PNG went.
const os = require('os');
const path = require('path');
const { FINDS } = require('../src/main/gifts');
const art = require('../src/main/bugdex/art');
const { canvas, argv } = require('./lib/png');

const { args, opt, flag } = argv();
const out = opt('--out', path.join(os.tmpdir(), 'finds-sheet.png'));
const scale = Number(opt('--scale', 5));
const forms = flag('--forms');
const want = args.length ? FINDS.filter(f => args.includes(f.id) || args.includes(f.set) || (args.includes('strays') && !f.set)) : FINDS;
if (!want.length) { console.error('No finds match', args.join(' ')); process.exit(1); }

const BOX = 22; // a portrait is at most 20×20 once inked
const TILE_W = 2 + 16 + 2 + (BOX + 2) * (forms ? 3 : 1), TILE_H = BOX + 4;
const cols = Math.max(1, Math.min(want.length, Math.floor(1600 / (TILE_W * scale))));
const rows = Math.ceil(want.length / cols);
const sheet = canvas(cols * TILE_W * scale, rows * TILE_H * scale);
const SHELF_LOCKED = '#2b4650'; // together.js draws a find you haven't got in this

want.forEach((f, i) => {
  const tx = (i % cols) * TILE_W * scale, ty = Math.floor(i / cols) * TILE_H * scale;
  sheet.rect(tx + scale, ty + scale, (TILE_W - 2) * scale, (TILE_H - 2) * scale, '#243049');
  sheet.draw(f, tx + 2 * scale, ty + 2 * scale, scale * 2);
  const p = f.portrait;
  if (!p) return;
  const locked = { pixels: p.pixels, palette: Object.fromEntries(Object.keys(p.palette).map(k => [k, SHELF_LOCKED])) };
  const looks = forms ? [p, art.shiny(p), locked] : [p];
  looks.forEach((a, k) => sheet.draw(a,
    tx + (20 + k * (BOX + 2)) * scale + ((BOX - a.pixels[0].length) * scale / 2 | 0),
    ty + 2 * scale + ((BOX - a.pixels.length) * scale / 2 | 0), scale));
});

sheet.save(out);
console.log(out);
console.log(want.map((f, i) => `${i + 1}. ${f.id}${f.portrait ? ` ${f.portrait.pixels[0].length}x${f.portrait.pixels.length}` : ' (no portrait)'}`).join('\n'));
