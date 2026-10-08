// Stickers on the glass of his tank (docs/plans/tank-decor.md §4, Phase 3):
// every project in the Sticker Book can go on the front glass, once, as its
// small drawing (stickers/art.js). They're pieces like any other, kept as
// `sticker:<projectId>` refs, which the tank keeps and syncs with its layout.
//
// They never go on the calling card: tank/share.js only lets built-in decor
// and finds out, and a sticker's id would say which projects you have.
// A project you hid in the Sticker Book doesn't come up in the tray.
// Pure: see test/tank-glass.test.js.

const stickers = require('../stickers');
const stickerArt = require('../stickers/art');

const PREFIX = 'sticker:';
const CATEGORY = 'sticker';
const isSticker = ref => typeof ref === 'string' && ref.startsWith(PREFIX);

/**
 * The tank's library (tank.library) with his stickers added, a new Map.
 * stickerState: config `stickers` (stickers.normalize cleans it).
 */
function withStickers(lib, stickerState) {
  const out = new Map(lib);
  const s = stickers.normalize(stickerState);
  for (const p of Object.values(s.projects)) {
    if (p.hidden) continue;
    const small = stickerArt.draw(p).small;
    const pixels = [...small.pixels];
    out.set(`${PREFIX}${p.id}`, {
      ref: `${PREFIX}${p.id}`, kind: 'sticker', name: `${p.name} sticker`, description: 'From the Sticker Book, on the front glass.', rarity: 'common',
      category: CATEGORY, layer: 'float',
      palette: { ...small.palette }, pixels, frames: [], fps: 0, spots: [],
      w: Math.max(...pixels.map(r => r.length)), h: pixels.length, max: 1, locked: null, isNew: false,
      unlock: null,
    });
  }
  return out;
}

module.exports = { PREFIX, CATEGORY, isSticker, withStickers };
