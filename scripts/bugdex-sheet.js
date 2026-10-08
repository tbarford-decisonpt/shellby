// Draws Bugdex portraits to a PNG, to look at while drawing them.
//
//   node scripts/bugdex-sheet.js [ids or habitats...] [--out file.png] [--scale 5] [--forms]
//
// With no ids it draws every species. Each tile is the desk sprite (8×8) on
// the left and the inked portrait on the right; --forms adds the shiny, golden
// and silhouette portraits too. Prints where the PNG went.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { SPECIES } = require('../src/main/bugdex/species');
const art = require('../src/main/bugdex/art');
const { crc32 } = require('../src/main/deck-pack');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const out = opt('--out', path.join(os.tmpdir(), 'bugdex-sheet.png'));
const scale = Number(opt('--scale', 5));
const forms = flag('--forms');
const want = args.length ? SPECIES.filter(s => args.includes(s.id) || args.includes(s.habitat) || (args.includes('events') && !s.habitat)) : SPECIES;
if (!want.length) { console.error('No species match', args.join(' ')); process.exit(1); }

const hex = c => { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const BG = hex('#1b2335'), TILE = hex('#243049'), MISSING = hex('#ff00ff');

const TILE_W = 26 + 10 + 26 * (forms ? 4 : 1), TILE_H = 30;
const cols = Math.max(1, Math.min(want.length, Math.floor(1600 / (TILE_W * scale))));
const rows = Math.ceil(want.length / cols);
const W = cols * TILE_W * scale, H = rows * TILE_H * scale;
const img = Buffer.alloc(W * H * 3);
const put = (x, y, rgb) => { if (x < 0 || y < 0 || x >= W || y >= H) return; img.set(rgb, (y * W + x) * 3); };
const rect = (x, y, w, h, rgb) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, rgb); };
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, BG);

function draw(a, ox, oy, s = scale) {
  a.pixels.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '.') return;
    rect(ox + x * s, oy + y * s, s, s, a.palette[ch] ? hex(a.palette[ch]) : MISSING);
  }));
}

want.forEach((sp, i) => {
  const tx = (i % cols) * TILE_W * scale, ty = Math.floor(i / cols) * TILE_H * scale;
  rect(tx + scale, ty + scale, (TILE_W - 2) * scale, (TILE_H - 2) * scale, TILE);
  draw(sp, tx + 2 * scale, ty + 2 * scale, scale * 2);
  const p = sp.portrait;
  if (!p) return;
  const looks = forms ? [p, art.shiny(p), art.golden(p), art.silhouette(p)] : [p];
  looks.forEach((a, k) => draw(a, tx + (20 + k * 26) * scale + (26 - a.pixels[0].length) * scale / 2 | 0, ty + 2 * scale + (26 - a.pixels.length) * scale));
});

const chunk = (type, body) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type), body]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb) >>> 0);
  return Buffer.concat([len, tb, crc]);
};
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) img.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(out);
console.log(want.map((s, i) => `${i + 1}. ${s.id}${s.portrait ? ` ${s.portrait.pixels[0].length}x${s.portrait.pixels.length}` : ' (no portrait)'}`).join('\n'));
