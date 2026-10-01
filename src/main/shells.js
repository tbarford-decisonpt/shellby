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
    palette: { D: '#5b3a1e', m: '#b5793f', l: '#e8b878', h: '#fbe3b5' },
    pixels: [
      '.....DDDD....',
      '...DDmmmmDD..',
      '..DmmllllmmD.',
      '.DmlDDDDDDlmD',
      '.DmlDmmmmmDlD',
      'DmlDmlDDDmDlD',
      'DmlDmlDhDmDlD',
      'DmlDmlhhDmDlD',
      'DmlDmmllmDlmD',
      '.DmlDDDDDlmD.',
      '..DmmllllmD..',
      '...DDDDDDD...',
    ],
  },
  {
    id: 'tin-can', name: 'Tin Can', level: 5, top: [6, 2],
    description: 'Soup can, rinsed out. Roomy, a bit echoey.',
    palette: { K: '#3d4a52', g: '#aab7bf', G: '#dfe7ec', r: '#d62839', R: '#9e1b2a', w: '#fff4e4' },
    pixels: [
      '.............',
      '.............',
      '..KKKKKKKKKK.',
      '.KgGGGGGGGGgK',
      'KgGrrrrrrrrgK',
      'KgrRwwwwRrrgK',
      'KgrrrrrrrrrgK',
      'KgrRwwwRrrrgK',
      'KgRRRRRRRRRgK',
      '.KgGGGGGGGgK.',
      '..KKKKKKKKK..',
      '.............',
    ],
  },
  {
    id: 'teacup', name: 'Teacup', level: 8, top: [6, 2],
    description: 'Fine porcelain, still smells of chamomile.',
    palette: { K: '#6d4c5e', w: '#fdf6f0', p: '#f4a6b8', P: '#d9667f', t: '#8a5a2b', g: '#e9c46a' },
    pixels: [
      '.............',
      '.............',
      '..ggggggggg..',
      '..KtttttttK..',
      'KKKwwwwwwwwK.',
      'K.KwpPpwpPwK.',
      'K.KwPPPwPPwK.',
      'KKKwwpwwwpwK.',
      '...KwwwwwwK..',
      '....KwwwwK...',
      '.PPPPPPPPPP..',
      '..KKKKKKKK...',
    ],
  },
  {
    id: 'toy-brick', name: 'Toy Brick', level: 12, top: [6, 1],
    description: 'Hollowed out a toy brick. Hurts to step on, safe to live in.',
    palette: { K: '#7a1020', r: '#e63946', R: '#b52a37', h: '#ff8a8a' },
    pixels: [
      '.............',
      '..hr..hr..hr.',
      '..rR..rR..rR.',
      '.KKKKKKKKKKKK',
      'KhrrrrrrrrrrK',
      'KrrrrrrrrrrRK',
      'KrrrrrrrrrrRK',
      'KrrrrrrrrrrRK',
      'KrrrrrrrrrrRK',
      'KRRRRRRRRRRK.',
      '.KKKKKKKKKK..',
      '.............',
    ],
  },
  {
    id: 'golden-conch', name: 'Golden Conch', level: 20, top: [6, 0],
    description: 'Legend of the Tides. The shell every crab dreams about.',
    palette: { D: '#7a5200', y: '#ffd23f', Y: '#fff4c2', o: '#e0a800', p: '#ff9ec4' },
    pixels: [
      '......D......',
      '.....DyD.....',
      '....DyYyD....',
      '...DyYyoyD...',
      '..DyYyoyypD..',
      '.DyYyoyyppD..',
      'DyYyoyyypppD.',
      'DyyoyyypppppD',
      '.DoyyyyppppD.',
      '..DooyyyyDD..',
      '...DDDDDDD...',
      '.............',
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
