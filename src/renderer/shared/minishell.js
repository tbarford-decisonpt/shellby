// The gutter mark on Shellby's messages: a 10x10 pixel mini of the shell he
// lives in right now. One per home in src/main/shells.js, hand-drawn at this
// size rather than scaled down from the 13x12 grids — pixel art does not
// survive resampling, and at 10px only the silhouette and the colours read.
//
// Rendered to a data-URI SVG and handed to CSS as --home-mark, so the mark
// costs one pseudo-element and no per-message DOM. Pure: no I/O, no document.
(function (root) {
  const SIZE = 10;

  // Keyed by shell id; 'home' is the shell he hatched with. Keep in step with
  // SHELLS in src/main/shells.js (test/minishell.test.js checks every id).
  const MARKS = Object.freeze({
    // His own shell, in his own coral — the mark the panel has always had,
    // now shaped like a shell instead of a square.
    home: {
      palette: { D: '#7a2518', m: '#c9482f', l: '#ff7a5c', h: '#ffc9b2' },
      pixels: [
        '..DDD.....',
        '.DllmDD...',
        'DlhhllmD..',
        'DlhDDhlmD.',
        'DlhmmDhlmD',
        'DllhDDhlmD',
        'DllhhhlmD.',
        '.DllllmD..',
        '..DDDDD...',
        '..........',
      ],
    },
    snail: {
      palette: { D: '#5b3a1e', m: '#b5793f', l: '#e8b878', h: '#fbe3b5' },
      pixels: [
        '.....DDD..',
        '...DDmllD.',
        '..DmllhhlD',
        '.DmlhDDhlD',
        'DmlhDmmhlD',
        'DmlhDDhllD',
        '.DmlhhhllD',
        '..DmllllD.',
        '...DDDDD..',
        '..........',
      ],
    },
    'tin-can': {
      palette: { K: '#3d4a52', g: '#aab7bf', G: '#dfe7ec', r: '#d62839', R: '#9e1b2a', w: '#fff4e4' },
      pixels: [
        '..........',
        '.KKKKKKKK.',
        'KgGGGGGGgK',
        'KgrrrrrrgK',
        'KgrwwwwrgK',
        'KgrrrrrrgK',
        'KgRRRRRRgK',
        'KgGGGGGGgK',
        '.KKKKKKKK.',
        '..........',
      ],
    },
    teacup: {
      palette: { K: '#6d4c5e', w: '#fdf6f0', p: '#f4a6b8', P: '#d9667f', g: '#e9c46a' },
      pixels: [
        '..........',
        '.gggggggg.',
        '.KwwwwwwK.',
        '.KwpPpwKKK',
        '.KwPPPwK.K',
        '.KwwpwwKKK',
        '..KwwwwK..',
        '...KwwK...',
        '..PPPPPP..',
        '...KKKK...',
      ],
    },
    'toy-brick': {
      palette: { K: '#7a1020', r: '#e63946', R: '#b52a37', h: '#ff8a8a' },
      pixels: [
        '..........',
        '.hr.hr.hr.',
        '.rR.rR.rR.',
        'KKKKKKKKKK',
        'KhrrrrrrrK',
        'KrrrrrrrRK',
        'KrrrrrrrRK',
        'KRRRRRRRRK',
        '.KKKKKKKK.',
        '..........',
      ],
    },
    'golden-conch': {
      palette: { D: '#7a5200', y: '#ffd23f', Y: '#fff4c2', o: '#e0a800', p: '#ff9ec4' },
      pixels: [
        '....D.....',
        '...DyD....',
        '..DyYyD...',
        '..DyYyoD..',
        '.DyYyoyD..',
        '.DyYyoypD.',
        'DyYyoyppD.',
        'DyyoyppppD',
        '.DoyyppppD',
        '..DDDDDDD.',
      ],
    },
    coconut: {
      palette: { K: '#3b2412', b: '#6b4226', B: '#8b5a2b', f: '#c9a27a', w: '#fffaf0' },
      pixels: [
        '..........',
        '..........',
        '...KKKK...',
        '.KKbBbBKK.',
        'KbBfbBfbBK',
        'KBbbBbbBbK',
        'KbBfbBbfBK',
        '.KwwwwwwK.',
        '..KKKKKK..',
        '..........',
      ],
    },
    'lantern-jar': {
      palette: { K: '#2b3a4a', c: '#7fb8d8', C: '#bfe3f5', y: '#ffe066', Y: '#fff7c2', l: '#8a6a3a' },
      pixels: [
        '..llllll..',
        '..KKKKKK..',
        '.KCcccccK.',
        '.KCcyyccK.',
        '.KCyYYycK.',
        '.KCyYYycK.',
        '.KCcyyccK.',
        '.KCcccccK.',
        '..KKKKKK..',
        '..........',
      ],
    },
    'diving-helmet': {
      palette: { K: '#4a2f0f', o: '#c8872e', O: '#e9b25a', h: '#ffe0a0', g: '#5fa8c9', G: '#a9dcef' },
      pixels: [
        '...KKKK...',
        '.KKoOOoKK.',
        '.KoOhOooK.',
        'KoKKKKKKoK',
        'KoKgGggKoK',
        'KoKgggGKoK',
        'KoKKKKKKoK',
        '.KoOoOoOK.',
        '.KKKKKKKK.',
        '..........',
      ],
    },
    geode: {
      palette: { K: '#2d1b4e', r: '#6b4a2b', R: '#8c6a48', a: '#9b5de5', A: '#c77dff', w: '#f1e4ff' },
      pixels: [
        '..........',
        '...KKKK...',
        '.KKRrRrKK.',
        '.KrKKKKrK.',
        'KRKaAwaKRK',
        'KrKAwAaKrK',
        'KRKaAAwKRK',
        '.KrKKKKrK.',
        '..KKKKKK..',
        '..........',
      ],
    },
    'treasure-chest': {
      palette: { K: '#3a2210', w: '#8b5a2b', W: '#a8743f', g: '#ffd23f', G: '#fff1a8', j: '#e63946' },
      pixels: [
        '..........',
        '..KKKKKK..',
        '.KWwWwWwK.',
        'KWwgggwWwK',
        'KgggGjGggK',
        'KwWwgggWwK',
        'KWwWwWwWwK',
        'KggggggggK',
        '.KKKKKKKK.',
        '..........',
      ],
    },
    'rainbow-nautilus': {
      palette: { K: '#1d1d3a', r: '#ff5e5b', o: '#ffb347', y: '#ffe66d', g: '#7bd389', b: '#5bc0eb', v: '#b28dff', w: '#ffffff' },
      pixels: [
        '.....KKK..',
        '...KKryyK.',
        '..KoggwwgK',
        '.KybwKKwbK',
        'KgvwKggwvK',
        'KbrwKKwrrK',
        '.KvowwwooK',
        '..KvyyyyK.',
        '...KKKKK..',
        '..........',
      ],
    },
  });

  const HEX = /^#[0-9a-f]{6}$/i;
  const lum = hex => { const n = parseInt(hex.slice(1), 16); return 0.299 * (n >> 16) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255); };
  const mix = (a, b, t) => '#' + [16, 8, 0].map(s => {
    const x = parseInt(a.slice(1), 16) >> s & 255, y = parseInt(b.slice(1), 16) >> s & 255;
    return Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  }).join('');

  // His own shell wears the skin's shell colours, so the mark matches the crab
  // you picked. The skin's 'shell' tones, darkest first, fill the mark's
  // outline (D), shade (m), body (l) and highlight (h); missing ones are mixed.
  // Null when the skin has no usable shell colours (keep the coral mark).
  function skinPalette(skin) {
    const tones = [...new Set(Object.entries(skin?.parts || {})
      .filter(([, part]) => part === 'shell')
      .map(([ch]) => String(skin.palette?.[ch] || '').toLowerCase())
      .filter(c => HEX.test(c)))]
      .sort((a, b) => lum(a) - lum(b));
    const [t0, t1, t2] = tones;
    switch (tones.length) {
      case 0: return null;
      case 1: return { D: mix(t0, '#000000', 0.5), m: mix(t0, '#000000', 0.2), l: t0, h: mix(t0, '#ffffff', 0.5) };
      case 2: return { D: t0, m: mix(t0, t1, 0.5), l: t1, h: mix(t1, '#ffffff', 0.5) };
      case 3: return { D: t0, m: mix(t0, t1, 0.5), l: t1, h: t2 };
      default: return { D: t0, m: tones[1], l: tones[tones.length - 2], h: tones[tones.length - 1] };
    }
  }

  // One <path> per colour, horizontal runs merged — keeps the data URI short
  // enough to live in a CSS custom property.
  function svg(id, skin) {
    const drawn = MARKS[id] || MARKS.home;
    const own = drawn === MARKS.home && skinPalette(skin);
    const mark = own ? { ...drawn, palette: own } : drawn;
    const runs = new Map();
    mark.pixels.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        const colour = mark.palette[row[x]];
        if (!colour) { x++; continue; }
        let end = x + 1;
        while (end < row.length && row[end] === row[x]) end++;
        if (!runs.has(colour)) runs.set(colour, []);
        runs.get(colour).push(`M${x} ${y}h${end - x}v1H${x}z`);
        x = end;
      }
    });
    const paths = [...runs].map(([colour, d]) => `<path fill='${colour}' d='${d.join('')}'/>`).join('');
    return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${SIZE} ${SIZE}' shape-rendering='crispEdges'>${paths}</svg>`;
  }

  const ESCAPE = { '<': '%3C', '>': '%3E', '#': '%23' };

  /** A CSS url() for one shell's mark. Unknown ids fall back to his own shell,
   *  which is painted in `skin`'s shell colours when given. */
  const markUrl = (id, skin) => `url("data:image/svg+xml,${svg(id, skin).replace(/[<>#]/g, c => ESCAPE[c])}")`;

  const api = { SIZE, MARKS, svg, markUrl, skinPalette };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyMiniShell = api;
})(typeof window !== 'undefined' ? window : globalThis);
