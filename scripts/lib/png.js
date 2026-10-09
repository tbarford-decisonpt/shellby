// A plain RGB canvas that saves as a PNG, for the art contact sheets
// (bugdex-sheet.js, finds-sheet.js). Art is the gifts.js format: rows of
// characters, '.' empty, every other character a palette key; a key missing
// from the palette draws magenta so it stands out.
const fs = require('fs');
const zlib = require('zlib');
const { crc32 } = require('../../src/main/deck-pack');

const hex = c => { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const MISSING = hex('#ff00ff');

function canvas(W, H, bg = '#1b2335') {
  const img = Buffer.alloc(W * H * 3);
  const put = (x, y, rgb) => { if (x < 0 || y < 0 || x >= W || y >= H) return; img.set(rgb, (y * W + x) * 3); };
  const rect = (x, y, w, h, colour) => { const rgb = hex(colour); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, rgb); };
  rect(0, 0, W, H, bg);

  /** Draws art with its top-left at (ox, oy), each pixel s×s. */
  function draw(a, ox, oy, s) {
    a.pixels.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === '.') return;
      const rgb = a.palette[ch] ? hex(a.palette[ch]) : MISSING;
      for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) put(ox + x * s + i, oy + y * s + j, rgb);
    }));
  }

  function save(file) {
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
    fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  }

  return { rect, draw, save };
}

/** Pulls `--name value` and `--flag` out of argv; what's left is the positional args. */
function argv(list = process.argv.slice(2)) {
  const args = [...list];
  const opt = (name, dflt) => { const i = args.indexOf(name); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, 2); return v; };
  const flag = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  return { args, opt, flag };
}

module.exports = { canvas, argv };
