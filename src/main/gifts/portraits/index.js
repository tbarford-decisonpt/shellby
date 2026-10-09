// The finds' portraits: each find drawn big (up to 18×18) and shaded, for the
// shelf, its detail card and the sparkly reveal. The little art in gifts.js
// stays for everything at his size (his claw, the tank, the beach, the Us
// page, swap chips and celebrate thumbs), where a portrait would swamp him.
//
// One file per set (strays.js has the finds in no set), so several people can
// draw at once. Each maps a find id to { palette, pixels } in the gifts.js
// format. Draw no outline round the edge: bugdex/art.js inked adds a dark one,
// shaded from the colour it borders, so 18×18 shows at 20×20.
//
// Pure data. See test/gifts.test.js and scripts/finds-sheet.js.

const FILES = ['beach', 'sea-glass', 'junk-drawer', 'toy-box', 'codebase', 'garden', 'dig-site', 'pirate', 'deep', 'night', 'moonlight', 'seasons', 'tides', 'strays'];

const PORTRAITS = Object.freeze(Object.assign({}, ...FILES.map(f => require(`./${f}`))));

module.exports = { PORTRAITS, FILES };
