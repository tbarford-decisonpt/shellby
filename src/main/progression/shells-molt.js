// Tier shells: one for each molt (progression/molting.js), hand-made for the first twelve
// (docs/GAMIFICATION-PLAN.md section 2.7). Past twelve, progression/shell-gen.js makes them.
//
// Same 13 x 12 grid and skin mask as progression/shells.js (test/shells.test.js checks every
// frame), so what makes these wild is the render features shared/sprite.js adds:
//   frames:  1-3 more pictures of the same size, played in a loop at `fps` (1-8)
//   cycle:   { keys, fps }: those palette keys pass their colours round, so a
//            band of lava flows or a ring spins
//   aura:    a glow round the shell (a CSS drop-shadow)
//   sparkle: 0-6 twinkling pixels over it
// With reduced motion only the first picture is drawn, with no cycle or sparkle.
// A few are drawn by small helpers below (a disc, a shard, gear teeth); the
// result is plain grids, the same every time. Data only, no I/O.

const W = 13, H = 12;
const blank = () => Array.from({ length: H }, () => '.'.repeat(W));
/** rows with `cells` ([x, y, ch]) painted over them. */
function put(rows, cells) {
  const g = rows.map(r => [...r]);
  for (const [x, y, ch] of cells) if (g[y] && x >= 0 && x < W) g[y][x] = ch;
  return g.map(r => r.join(''));
}

// ---- VI Lava Lamp: two blobs rise and sink in the glass.
const LAMP = [
  '.....mMM.....',
  '....gGGGg....',
  '...gGGGGGg...',
  '..gGGGGGGGg..',
  '..gGGGGGGGg..',
  '.gGGGGGGGGGg.',
  '.gGGGGGGGGGg.',
  '.gGGGGGGGGGg.',
  '.gGGGGGGGGGg.',
  '..gGGGGGGGg..',
  '...mmmmmmM...',
  '....MMMMMM...',
];
const blob = (cx, cy) => [[cx, cy, 'O'], [cx - 1, cy, 'o'], [cx + 1, cy, 'o'], [cx, cy - 1, 'o'], [cx, cy + 1, 'o']];
const lamp = (ay, by) => put(LAMP, [...blob(5, ay), ...blob(8, by), [3, 8, 'o'], [4, 9, 'o'], [3, 9, 'O']]);

// ---- VIII Prism Shard: a diamond whose facets run through the spectrum.
const SHARD_ROWS = [[6, 6], [5, 7], [4, 8], [3, 9], [2, 10], [1, 11], [0, 12], [1, 11], [2, 10], [3, 9], [4, 8], [5, 7]];
const SPECTRUM = ['r', 'o', 'y', 'g', 'c', 'b', 'v'];
function shard() {
  const cells = [];
  SHARD_ROWS.forEach(([a, b], y) => {
    for (let x = a; x <= b; x++) {
      const edgeL = x === a, edgeR = x === b;
      const ch = y === H - 1 ? 'K' : edgeL ? (y <= 6 ? 'W' : 'K') : edgeR ? 'K' : x === 6 && y < 6 ? 'W' : SPECTRUM[(x + y) % 7];
      cells.push([x, y, ch]);
    }
  });
  return put(blank(), cells);
}

// ---- IX Void Pearl: a black disc inside a spinning event horizon.
function voidPearl() {
  const cells = [];
  const cx = 6, cy = 5.5, r = 5.9;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      if (d > r) continue;
      if (d > r - 1.25) {
        // Clockwise round the ring: a, b, c, d twice, so the cycle spins it.
        const turn = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI);
        cells.push([x, y, 'abcd'[Math.floor(turn * 8) % 4]]);
      } else {
        cells.push([x, y, dx < -1 && dy < -1 && d < 3.6 && d > 2.2 ? 'k' : 'K']);
      }
    }
  }
  cells.push([4, 3, 'w']);
  return put(blank(), cells);
}

// ---- X Clockwork Ammonite: a gear whose teeth walk round its rim.
const AMMONITE = [
  '.....oyyyo...',
  '...oyYYYYyyo.',
  '..oyYyooooyyo',
  '.oyYoKKKKKoyo',
  '.yYoKsssssKoy',
  'oyYoKsSSSsKoy',
  'oyYoKsSoSsKoy',
  'oyyoKsSSSsKoy',
  '.oyoKsssssKoy',
  '.ooyoKKKKKoo.',
  '..oooyyyyoo..',
  '...ooooooo...',
];
const RIM = [
  ...[5, 6, 7, 8, 9].map(x => [x, 3]), ...[4, 5, 6, 7, 8].map(y => [10, y]),
  ...[9, 8, 7, 6, 5].map(x => [x, 9]), ...[8, 7, 6, 5, 4].map(y => [4, y]),
];
const gear = step => put(AMMONITE, RIM.filter((_, i) => (i + step) % 4 === 0).map(([x, y]) => [x, y, 'Y']));

// ---- XI Aurora Spire: a tall spire with the northern lights in its whorls.
const SPIRE_ROWS = [[6, 6], [5, 7], [5, 7], [4, 8], [4, 8], [3, 9], [3, 9], [2, 10], [1, 11], [1, 11], [3, 9], [4, 8]];
function spire() {
  const cells = [];
  SPIRE_ROWS.forEach(([a, b], y) => {
    for (let x = a; x <= b; x++) {
      const seam = y % 3 === 2 && x > a && x < b;
      const ch = x === b || y === H - 1 ? 'K' : x === a ? 'w' : seam ? 'N' : 'abcd'[(x + 2 * y) % 4];
      cells.push([x, y, ch]);
    }
  });
  return put(blank(), [...cells, [6, 0, 'w']]);
}

// ---- XII Leviathan Crown: three flames dance on its points.
const CROWN = [
  '.............',
  '.............',
  '.............',
  '.GWG.GWG.GWG.',
  '.GRGGGRGGGRGo',
  'oGGgGGGGgGGGo',
  'oGrRgGRrGgRgo',
  'oGRWgGRWGgRgo',
  'ogGGgGGGgGGoo',
  '.ooGgGGGgGoo.',
  '..oogggggoo..',
  '...ooooooo...',
];
// A flame over point cx, leaning -1, 0 or 1, short or tall.
function flame(cx, lean, tall) {
  const cells = [[cx - 1, 2, 'f'], [cx, 2, 'F'], [cx + 1, 2, 'f'], [cx + lean, 1, 'y']];
  if (tall) cells.push([cx + lean, 0, 'f']);
  return cells;
}
const crown = pose => put(CROWN, [2, 6, 10].flatMap((cx, i) => flame(cx, pose[i][0], pose[i][1])));

const TIER_SHELLS = [
  {
    molt: 1, id: 'molt-1', name: 'Ember Conch', top: [6, 0],
    description: 'Black basalt with the lava still moving underneath. Warm to the touch, forever.',
    palette: { K: '#120c0e', k: '#2a2226', g: '#4d4247', r: '#ff3b1f', o: '#ff8c1a', y: '#ffe14d', h: '#6e5f66' },
    pixels: [
      '......y......',
      '.....kgK.....',
      '....kgrkK....',
      '...kgkoykK...',
      '..khrkkkrkK..',
      '.kgkoyrkkoK..',
      'kgkkkkoyrkkK.',
      'kgrykkkkkyrkK',
      '.KkkorkyrkkK.',
      '..KKkkrokKK..',
      '...KoyroKK...',
      '....KKKKK....',
    ],
    cycle: { keys: ['r', 'o', 'y'], fps: 4 }, aura: '#ff6a1a', sparkle: 3,
  },
  {
    molt: 2, id: 'molt-2', name: 'Glacier Geode', top: [6, 0],
    description: 'Cracked open on the second time round: ice outside, amethyst humming inside.',
    palette: { W: '#ffffff', i: '#d6f3ff', I: '#8fd0f5', b: '#3a7fb8', v: '#5a2d91', a: '#9b5de5', A: '#c77dff', p: '#f1dcff' },
    pixels: [
      '......WiI....',
      '....WiiiIIb..',
      '...WiIbbbIIb.',
      '..WiIbvavbIIb',
      '..iIbvApAvbIb',
      '.WiIvApWpAvIb',
      '.iIbaApApAabb',
      '.iIbvaAAavbIb',
      '.IIbbvaavbbIb',
      '..bIIbbbbIIb.',
      '...bbIIIIbb..',
      '....bbbbbb...',
    ],
    cycle: { keys: ['a', 'A', 'p'], fps: 3 }, aura: '#9ad8ff', sparkle: 4,
  },
  {
    molt: 3, id: 'molt-3', name: 'Circuit Nautilus', top: [6, 0],
    description: 'A spiral of copper traces. A pulse runs round it every time he has a thought.',
    palette: { K: '#04140f', G: '#0b3d2e', g: '#14593f', a: '#fff3a0', b: '#b8892f', c: '#7a5d1e', d: '#5a4416', L: '#39ff88' },
    pixels: [
      '.....KGGGK...',
      '...KGgggggGK.',
      '..KGgabcdagGK',
      '.KGgdKKKKbgGK',
      '.KGcKGgggKcgK',
      'KGgbKgdabKdgK',
      'KGgaKgcLcKagK',
      'KGgdKgbaKKbgK',
      '.KGcKKKKKcgK.',
      '.KGgbadcbgGK.',
      '..KGGgggGGK..',
      '...KKKKKKK...',
    ],
    cycle: { keys: ['a', 'b', 'c', 'd'], fps: 6 }, aura: '#39ff88', sparkle: 2,
  },
  {
    molt: 4, id: 'molt-4', name: 'Nebula Whorl', top: [6, 0],
    description: 'Deep violet, full of stars that take turns being awake.',
    palette: { V: '#12072e', v: '#2e1466', u: '#4b2391', m: '#c13fd1', n: '#ff6fb5', w: '#ffffff', s: '#9fd8ff', t: '#5b3bb0' },
    pixels: [
      '......vuu....',
      '....vumnuuv..',
      '...vuwnmmsuv.',
      '..vumnnVVmuuv',
      '..umnVVtVVmuv',
      '.vunVsVVVwVuv',
      '.umVVVwVsVVmv',
      '.unVtVVVVtnuv',
      '.vumVVsVVnmuv',
      '..vumnVVnmuv.',
      '...vvumnuvv..',
      '....vvvvvv...',
    ],
    cycle: { keys: ['w', 's', 't'], fps: 2 }, aura: '#b06bff', sparkle: 5,
  },
  {
    molt: 5, id: 'molt-5', name: "Kraken's Eye", top: [6, 0],
    description: 'Barnacled, ancient, and it looks back at you. It blinks when you do.',
    palette: { B: '#2c3b37', b: '#5f7a6e', c: '#8fae9a', n: '#e2dccb', E: '#fff6e0', I: '#ffb000', P: '#120808', W: '#ffffff' },
    pixels: [
      '.....nbbb....',
      '...bcbbnbBB..',
      '..bcnbbbbbBB.',
      '.bcbBBBBBbbBB',
      '.cbBEEEEEBbnB',
      'bcBEEIWIEEBbB',
      'bbBEIIPIIEBbB',
      'bnBEEIIIEEBbB',
      '.bbBEEEEEBbB.',
      '.BbbBBBBBbBB.',
      '..BBnbbbnBB..',
      '...BBBBBBB...',
    ],
    frames: [
      put([
        '.....nbbb....', '...bcbbnbBB..', '..bcnbbbbbBB.', '.bcbBBBBBbbBB', '.cbBEEEEEBbnB', 'bcBEEIWIEEBbB',
        'bbBEIIPIIEBbB', 'bnBEEIIIEEBbB', '.bbBEEEEEBbB.', '.BbbBBBBBbBB.', '..BBnbbbnBB..', '...BBBBBBB...',
      ], [[6, 6, 'I'], [5, 6, 'P'], [6, 5, 'I'], [5, 5, 'W']]),
      put([
        '.....nbbb....', '...bcbbnbBB..', '..bcnbbbbbBB.', '.bcbBBBBBbbBB', '.cbBEEEEEBbnB', 'bcBEEIWIEEBbB',
        'bbBEIIPIIEBbB', 'bnBEEIIIEEBbB', '.bbBEEEEEBbB.', '.BbbBBBBBbBB.', '..BBnbbbnBB..', '...BBBBBBB...',
      ], [[6, 6, 'I'], [7, 6, 'P'], [6, 5, 'I'], [7, 5, 'W']]),
      [
        '.....nbbb....', '...bcbbnbBB..', '..bcnbbbbbBB.', '.bcbBBBBBbbBB', '.cbBbbbbbBbnB', 'bcBbbbbbbbBbB',
        'bbBBBBBBBBBbB', 'bnBbbbbbbbBbB', '.bbBbbbbbBbB.', '.BbbBBBBBbBB.', '..BBnbbbnBB..', '...BBBBBBB...',
      ],
    ],
    fps: 2, aura: '#ffb000', sparkle: 0,
  },
  {
    molt: 6, id: 'molt-6', name: 'Lava Lamp', top: [6, 0],
    description: 'A glass shell with slow pink blobs that never quite meet. Very calming.',
    palette: { m: '#d4d4e2', M: '#7a7a90', g: '#2b2140', G: '#3b2a66', o: '#ff5fa2', O: '#ffb1d3' },
    pixels: lamp(3, 7),
    frames: [lamp(4, 6), lamp(5, 5), lamp(4, 6)],
    fps: 2, aura: '#ff5fa2', sparkle: 0,
  },
  {
    molt: 7, id: 'molt-7', name: 'Bone Cathedral', top: [6, 0],
    description: 'Ivory ribs and gothic arches. Something kind lives in the windows.',
    palette: { I: '#f3ead2', i: '#cfc3a0', d: '#8f8466', K: '#2a2620', e: '#3fd98a', E: '#c8ffe0' },
    pixels: [
      '......I......',
      '.....IiI.....',
      '....IiKiI....',
      '...IiKeKiI...',
      '..IiKeEeKiId.',
      '.IiIKeEeKIiId',
      '.IiKKKIKKKiId',
      'IiKeKIiIKeKid',
      'IiKEKiIiKEKid',
      '.dIiIdIdIiId.',
      '..dIdIdIdId..',
      '...ddddddd...',
    ],
    cycle: { keys: ['e', 'E'], fps: 1 }, aura: '#7dffb2', sparkle: 2,
  },
  {
    molt: 8, id: 'molt-8', name: 'Prism Shard', top: [6, 0],
    description: 'Faceted crystal that throws the whole spectrum round and round.',
    palette: { W: '#ffffff', K: '#1b1430', r: '#ff4d5e', o: '#ff9a3c', y: '#ffe14d', g: '#4dff88', c: '#4de6ff', b: '#4d7dff', v: '#b04dff' },
    pixels: shard(),
    cycle: { keys: SPECTRUM, fps: 6 }, aura: '#ffffff', sparkle: 4,
  },
  {
    molt: 9, id: 'molt-9', name: 'Void Pearl', top: [6, 0],
    description: 'Pure black. Light falls in round the edge and never comes back out.',
    palette: { K: '#000000', k: '#1a1626', w: '#3a3550', a: '#ffffff', b: '#b48cff', c: '#5a2fd0', d: '#1a0f40' },
    pixels: voidPearl(),
    cycle: { keys: ['a', 'b', 'c', 'd'], fps: 5 }, aura: '#7b4dff', sparkle: 6,
  },
  {
    molt: 10, id: 'molt-10', name: 'Clockwork Ammonite', top: [6, 0],
    description: 'Brass and steel, wound once a molt. The gear has never stopped.',
    palette: { Y: '#fff0a8', y: '#d9a441', o: '#8c5e18', K: '#3b2508', s: '#8fa3b8', S: '#c9d6e3' },
    pixels: gear(0),
    frames: [gear(1), gear(2), gear(3)],
    fps: 4, aura: '#ffd76a', sparkle: 1,
  },
  {
    molt: 11, id: 'molt-11', name: 'Aurora Spire', top: [6, 0],
    description: 'A tall spire with the northern lights rolling green to pink up its whorls.',
    palette: { K: '#050b14', N: '#0d1a2b', w: '#e8fff6', a: '#3dffa8', b: '#3de0ff', c: '#8a6bff', d: '#ff6bd6' },
    pixels: spire(),
    cycle: { keys: ['a', 'b', 'c', 'd'], fps: 3 }, aura: '#3dffa8', sparkle: 3,
  },
  {
    molt: 12, id: 'molt-12', name: 'Leviathan Crown', top: [6, 0],
    description: 'Gold, rubies and three flames that never go out. Twelve molts, and it shows.',
    palette: { G: '#ffd23f', g: '#e0a800', o: '#8c5a00', W: '#fff6c2', R: '#ff1f6b', r: '#8c0a3a', f: '#ff5a1f', F: '#fff27a', y: '#ffb21f' },
    pixels: crown([[0, 1], [0, 1], [0, 1]]),
    frames: [crown([[-1, 0], [1, 1], [-1, 1]]), crown([[0, 1], [0, 0], [0, 1]]), crown([[1, 1], [-1, 1], [1, 0]])],
    fps: 5, aura: '#ffd23f', sparkle: 6,
  },
];

module.exports = { TIER_SHELLS, HAND_MADE: TIER_SHELLS.length };
