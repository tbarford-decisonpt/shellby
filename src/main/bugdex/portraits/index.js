// The Bugdex's portraits: each species drawn big (up to 22×22) and shaded,
// for its page in the book, its card and the battle. The little 8×8 art in
// species.js stays for everything on the desk (the jar he holds, the tank,
// the tide pool), where a portrait would swamp him.
//
// One file per habitat, so two people can draw at once. Each maps a species
// id to { palette, pixels } in the gifts.js format. Draw no outline round the
// edge: art.inked adds a dark one, shaded from the colour it borders.
//
// Pure data. See test/bugdex-species.test.js and scripts/bugdex-sheet.js.

const FILES = ['shallows', 'burrows', 'currents', 'nets', 'lighthouse', 'workshop', 'kelp', 'pypool', 'trench', 'proving', 'vault', 'wreck', 'events'];

const PORTRAITS = Object.freeze(Object.assign({}, ...FILES.map(f => require(`./${f}`))));

module.exports = { PORTRAITS, FILES };
