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
  });

  // One <path> per colour, horizontal runs merged — keeps the data URI short
  // enough to live in a CSS custom property.
  function svg(id) {
    const mark = MARKS[id] || MARKS.home;
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

  /** A CSS url() for one shell's mark. Unknown ids fall back to his own shell. */
  const markUrl = id => `url("data:image/svg+xml,${svg(id).replace(/[<>#]/g, c => ESCAPE[c])}")`;

  const api = { SIZE, MARKS, svg, markUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyMiniShell = api;
})(typeof window !== 'undefined' ? window : globalThis);
