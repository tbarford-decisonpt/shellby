// Draws Bugdex portraits to a PNG, to look at while drawing them.
//
//   node scripts/bugdex-sheet.js [ids or habitats...] [--out file.png] [--scale 5] [--forms]
//
// With no ids it draws every species. Each tile is the desk sprite (8×8) on
// the left and the inked portrait on the right; --forms adds the shiny, golden
// and silhouette portraits too. Prints where the PNG went.
const os = require('os');
const path = require('path');
const { SPECIES } = require('../src/main/bugdex/species');
const art = require('../src/main/bugdex/art');
const { canvas, argv } = require('./lib/png');

const { args, opt, flag } = argv();
const out = opt('--out', path.join(os.tmpdir(), 'bugdex-sheet.png'));
const scale = Number(opt('--scale', 5));
const forms = flag('--forms');
const want = args.length ? SPECIES.filter(s => args.includes(s.id) || args.includes(s.habitat) || (args.includes('events') && !s.habitat)) : SPECIES;
if (!want.length) { console.error('No species match', args.join(' ')); process.exit(1); }

const TILE_W = 26 + 10 + 26 * (forms ? 4 : 1), TILE_H = 30;
const cols = Math.max(1, Math.min(want.length, Math.floor(1600 / (TILE_W * scale))));
const rows = Math.ceil(want.length / cols);
const sheet = canvas(cols * TILE_W * scale, rows * TILE_H * scale);

want.forEach((sp, i) => {
  const tx = (i % cols) * TILE_W * scale, ty = Math.floor(i / cols) * TILE_H * scale;
  sheet.rect(tx + scale, ty + scale, (TILE_W - 2) * scale, (TILE_H - 2) * scale, '#243049');
  sheet.draw(sp, tx + 2 * scale, ty + 2 * scale, scale * 2);
  const p = sp.portrait;
  if (!p) return;
  const looks = forms ? [p, art.shiny(p), art.golden(p), art.silhouette(p)] : [p];
  looks.forEach((a, k) => sheet.draw(a, tx + (20 + k * 26) * scale + (26 - a.pixels[0].length) * scale / 2 | 0, ty + 2 * scale + (26 - a.pixels.length) * scale, scale));
});

sheet.save(out);
console.log(out);
console.log(want.map((s, i) => `${i + 1}. ${s.id}${s.portrait ? ` ${s.portrait.pixels[0].length}x${s.portrait.pixels.length}` : ' (no portrait)'}`).join('\n'));
