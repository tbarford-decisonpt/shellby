// Shellby's homes. Hermit crabs move into bigger shells as they grow, and so
// does he: certain levels unlock a new shell, and the level-up that crosses one
// plays a molt (out of the old shell, a shiver, into the new one).
//
// Each shell is a pixel grid in the crab's own 22x13 sprite space, drawn in
// place of the skin's shell pixels (see shared/sprite.js). It may only use
// cells that are the shell or empty in every built-in skin, never the body,
// claw, eyes or legs (test/shells.test.js checks). `top` is where shell items
// (a flag, bat wings) sit on it. Pure: no I/O.

const HOME = 'home'; // the shell he hatched with (the skin's own)

const SHELLS = Object.freeze([
  {
    id: 'snail', name: 'Snail Shell', level: 3, top: [6, 0],
    description: 'An old spiral shell a snail left on the beach.',
    palette: { D: '#5b3a1e', m: '#b5793f', l: '#e8b878', h: '#fbe3b5', N: '#3d2226', s: '#86492f', b: '#d39a58', w: '#fffbea' },
    pixels: [
      '.....llbm....',
      '...mlwhllbm..',
      '..mlhhllbbms.',
      '.mlhDDDDDDbms',
      '.mlbDbllbmDms',
      'blmDlbDDDmDms',
      'mlmDlbDhDsDsN',
      'mbmDbmlbDsDsN',
      'smmDbmmssDssN',
      '.smbDDDDNssN.',
      '..smbbbmmsN..',
      '...ssssNNN...',
    ],
  },
  {
    id: 'tin-can', name: 'Tin Can', level: 5, top: [6, 2],
    description: 'Soup can, rinsed out. Roomy, a bit echoey.',
    palette: { K: '#3d4a52', g: '#aab7bf', G: '#dfe7ec', r: '#d62839', R: '#9e1b2a', w: '#fff4e4', q: '#7b8a99', k: '#55606f', S: '#ffffff', p: '#f2564a', P: '#ff9c86', d: '#6b1532', e: '#e0c6bb' },
    pixels: [
      '.............',
      '.............',
      '..qgggqqqqkK.',
      '.qGSSGGGGggqK',
      'qGgpPpprrrRqK',
      'qgpRwwwwRrRqK',
      'qgrrrrrrrrRkK',
      'kgrRwweRrRRkK',
      'kqRRRRdddddkK',
      '.kqgggqqqqkK.',
      '..kKKKKKKKK..',
      '.............',
    ],
  },
  {
    id: 'teacup', name: 'Teacup', level: 8, top: [6, 2],
    description: 'Fine porcelain, still smells of chamomile.',
    palette: { K: '#6d4c5e', w: '#fdf6f0', p: '#f4a6b8', P: '#d9667f', t: '#8a5a2b', g: '#e9c46a', G: '#fff2b8', o: '#b9822e', T: '#b8834a', u: '#5c3518', W: '#ffffff', v: '#eadbe0', V: '#c4a9bb', q: '#ffd3de', Q: '#a94765' },
    pixels: [
      '.............',
      '.............',
      '..gGGggggoo..',
      '..VutTTtttK..',
      'vwvwWwwwwvvV.',
      'w.VWqPpwpPvV.',
      'v.VwpPPwPQvV.',
      'VVVwwPwvvQVV.',
      '...vwwvvVVK..',
      '....VvvVVK...',
      '.pqqpPQQPPQ..',
      '..QKKKKKKK...',
    ],
  },
  {
    id: 'toy-brick', name: 'Toy Brick', level: 12, top: [6, 1],
    description: 'Hollowed out a toy brick. Hurts to step on, safe to live in.',
    palette: { K: '#7a1020', r: '#e63946', R: '#b52a37', h: '#ff8a8a', L: '#f75f55', W: '#fff0e6', D: '#4e0c27' },
    pixels: [
      '.............',
      '..hr..hr..hr.',
      '..rR..rR..rR.',
      '.hhhLhhhLhhLR',
      'LWLrrrrrrrrRK',
      'LLrrrrrrrrrRK',
      'LrrrrrrrrrrRK',
      'rrrrrrrrrrRRK',
      'rrrrrrrrrRRDK',
      'RRRRRRRRRDDK.',
      '.KKKKKDDDDD..',
      '.............',
    ],
  },
  {
    id: 'golden-conch', name: 'Golden Conch', level: 20, top: [6, 0],
    description: 'Legend of the Tides. The shell every crab dreams about.',
    palette: { D: '#7a5200', y: '#ffd23f', Y: '#fff4c2', o: '#e0a800', p: '#ff9ec4', L: '#ffe680', W: '#ffffff', O: '#b8730a', N: '#5a2f0c', q: '#ffd3e4', P: '#e86aa3', R: '#a33a72' },
    pixels: [
      '......L......',
      '.....yYO.....',
      '....yLYyO....',
      '...yLWyoyO...',
      '..yLYyoYLqP..',
      '.yLYyoYLqpP..',
      'oyYyOLyyqpPR.',
      'oyyOLyoqppPPR',
      '.OOyyooqpPRD.',
      '..OOOoyooOD..',
      '...ODDDDNN...',
      '.............',
    ],
  },
  {
    id: 'coconut', name: 'Coconut Half', level: 30, top: [6, 2],
    description: 'Fell off a palm, cracked just right. Smells like summer.',
    palette: { K: '#3b2412', b: '#6b4226', B: '#8b5a2b', f: '#c9a27a', w: '#fffaf0', d: '#4a2a1e', L: '#a87444', F: '#e6c79c', c: '#e8d9c4', e: '#c4ab8e' },
    pixels: [
      '.............',
      '.............',
      '....BLLBb....',
      '..bBBLbBbbd..',
      '.bBLFbBfbBbd.',
      '.BLBbBbbBbbd.',
      'bBBfbBbLbbddK',
      'bBbbBbBbdbdbK',
      'dbBbLbBdBdbdK',
      '.cwwwwwwcceK.',
      '..dKKKKKKKK..',
      '.............',
    ],
  },
  {
    id: 'lantern-jar', name: 'Lantern Jar', level: 40, top: [6, 1],
    description: 'A glass jar with a firefly who agreed to stay. Good for night shifts.',
    palette: { K: '#2b3a4a', c: '#7fb8d8', C: '#bfe3f5', y: '#ffe066', Y: '#fff7c2', l: '#8a6a3a', n: '#4a7391', W: '#ffffff', a: '#d2eab4', L: '#b8904f', H: '#e2c07e', k: '#5c4426' },
    pixels: [
      '.............',
      '...LHLlLlkk..',
      '...nCCcccnK..',
      '..nCCcccccnK.',
      '.nCWcayyacnK.',
      '.nCWayYYyacK.',
      '.nCCyYWYYyaK.',
      '.nCcayYYyanK.',
      '.nCccayyacnK.',
      '.nCcccacnnK..',
      '..nncnnKKKK..',
      '.............',
    ],
  },
  {
    id: 'diving-helmet', name: 'Diving Helmet', level: 50, top: [6, 1],
    description: 'Brass, bolted, and very serious about the deep end.',
    palette: { K: '#4a2f0f', o: '#c8872e', O: '#e9b25a', h: '#ffe0a0', g: '#5fa8c9', G: '#a9dcef', d: '#7d4a1e', W: '#fffaf0', b: '#2f6489', S: '#eefbff' },
    pixels: [
      '.............',
      '.....OhO.....',
      '...oOhOOod...',
      '..oOhWhOOod..',
      '.oOOddddKodK.',
      '.oOdbgGSgKod.',
      'oOOdbGSggKodK',
      'oOodgGggGKddK',
      '.doKKKKKKKdK.',
      '.ohdOhdoOdK..',
      '.ddKKKKKKKK..',
      '.............',
    ],
  },
  {
    id: 'geode', name: 'Crystal Geode', level: 65, top: [6, 1],
    description: 'Plain rock outside, all amethyst inside. Like a good codebase.',
    palette: { K: '#2d1b4e', r: '#6b4a2b', R: '#8c6a48', a: '#9b5de5', A: '#c77dff', w: '#f1e4ff', x: '#45302f', T: '#ad8b66', U: '#cbb090', v: '#5a2d91', P: '#e0b0ff', W: '#ffffff', q: '#e4dcef', Q: '#9f8fb4' },
    pixels: [
      '.............',
      '....RTTRR....',
      '..RTUTRTRrr..',
      '.RTRKKKKQrrx.',
      '.TRKvavaAQrx.',
      'RTKvaPaAwAqrx',
      'RRKaAwvPWPqrx',
      'rRQaPAawPAqrx',
      '.rRQAwPAPqxx.',
      '.xrRQqqqQxx..',
      '..rxxxxxxxx..',
      '.............',
    ],
  },
  {
    id: 'treasure-chest', name: 'Treasure Chest', level: 80, top: [6, 2],
    description: 'Found it at the bottom of the trench. Kept the ruby, left the curse.',
    palette: { K: '#3a2210', w: '#8b5a2b', W: '#a8743f', g: '#ffd23f', G: '#fff1a8', j: '#e63946', k: '#5e3820', L: '#c8945a', o: '#c08a10', S: '#ffffff', J: '#8c1230' },
    pixels: [
      '.............',
      '.............',
      '...WLLLWWw...',
      '..WLLwLWWwk..',
      '.WLWGSggowwk.',
      '.gGGgGjGgooK.',
      '.wLWWgJoWWwk.',
      '.wWLWWgwWwwk.',
      '.kwWWwwWwwkk.',
      '.oGgggggoooK.',
      '.KKKKKKKKKK..',
      '.............',
    ],
  },
  {
    id: 'rainbow-nautilus', name: 'Rainbow Nautilus', level: 99, top: [6, 0],
    description: 'Shellby Supreme. Every colour of the reef in one spiral.',
    palette: { K: '#1d1d3a', r: '#ff5e5b', o: '#ffb347', y: '#ffe66d', g: '#7bd389', b: '#5bc0eb', v: '#b28dff', w: '#ffffff', R: '#d23a6a', O: '#e0703e', Y: '#d9a441', G: '#3aa38a', B: '#3a7ad0', V: '#7a52c8', p: '#fff2fa' },
    pixels: [
      '.....rrrR....',
      '...orprrrRR..',
      '..opoggggoOO.',
      '.oogKKKKKKgoO',
      '.pybKpyyyYKbB',
      'yybKybKKKYKbB',
      'ggvKgvKwKGKvV',
      'GgvKgVwpKGKvV',
      'BbrKbbrRBKRbB',
      '.BbRKKKKKRbB.',
      '..VvvooOOVV..',
      '...VVOOOOV...',
    ],
  },
].map(s => Object.freeze({ ...s, pixels: Object.freeze([...s.pixels]), palette: Object.freeze({ ...s.palette }), top: Object.freeze([...s.top]) })));

const byId = new Map(SHELLS.map(s => [s.id, s]));

/** Is this shell unlocked at `level`? (His own shell always is.) */
function unlockedAt(id, level) {
  if (id === HOME) return true;
  const s = byId.get(id);
  return !!s && level >= s.level;
}

/** Shells that a level-up from `before` to `after` unlocks, lowest first. */
function unlockedBetween(before, after) {
  return SHELLS.filter(s => s.level > before && s.level <= after);
}

/** The shell he wears: the chosen one if it's still unlocked, else his own. */
function wornShell(state, level) {
  const id = normalizeHome(state).worn;
  return id !== HOME && unlockedAt(id, level) ? byId.get(id) : null;
}

/** Tolerate anything read from disk: { worn, seen: [ids] }. */
function normalizeHome(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    worn: typeof r.worn === 'string' && (r.worn === HOME || byId.has(r.worn)) ? r.worn : HOME,
    seen: [...new Set((Array.isArray(r.seen) ? r.seen : []).filter(id => byId.has(id)))],
  };
}

/** What the sprite builder needs (no names or descriptions). */
const renderShell = s => (s ? { id: s.id, pixels: s.pixels, palette: s.palette, top: s.top } : null);

/** The Homes tab: every shell, with its lock and "new" state. */
function homesView(state, level) {
  const h = normalizeHome(state);
  const worn = wornShell(h, level);
  return {
    worn: worn ? worn.id : HOME,
    shells: SHELLS.map(s => ({
      ...renderShell(s), name: s.name, description: s.description, level: s.level,
      locked: level < s.level, isNew: level >= s.level && !h.seen.includes(s.id),
    })),
  };
}

module.exports = { HOME, SHELLS, unlockedAt, unlockedBetween, wornShell, normalizeHome, renderShell, homesView };
