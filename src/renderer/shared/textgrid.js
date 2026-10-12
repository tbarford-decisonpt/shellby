// Drawings made of text: boxes, trees and mockups in box-drawing characters,
// the way Claude sketches a layout in a code block. They only line up when
// every character takes its own column (two for an emoji or a CJK character),
// as in a terminal. A glyph the font lacks falls back to another font with a
// different width and pushes the rest of its line over, so the panel puts each
// such character in a cell of a fixed width. This says which blocks are
// drawings and how wide each character is. Pure, no DOM; works in Node for tests.
(function (root) {
  const BOX = /[─-▟]/;               // box drawing and block elements
  const MIN_BOX_LINES = 2;                      // one rule under a heading isn't a drawing
  const MAX_CHARS = 40000;                      // past this a block stays as it is
  // Fences that name no language of their own: what a drawing is fenced as.
  const PLAIN = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'ascii', 'diagram', 'tree', 'console', 'output']);

  // East Asian wide and fullwidth ranges: CJK, kana, Hangul, fullwidth forms.
  const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3fffd}]/u;
  const EMOJI = /\p{Emoji_Presentation}|️/u;
  // Plain ASCII and the box glyphs the drawing font has keep their own width.
  const OWN = /^[\x20-\x7e─-▟]+$/;

  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const graphemes = s => (segmenter ? [...segmenter.segment(s)].map(g => g.segment) : Array.from(s));

  /** True for a block that is a drawing: box characters on a few lines, in a fence that isn't code. */
  function isDrawing(source, lang) {
    const text = String(source ?? '');
    if (text.length > MAX_CHARS || !PLAIN.has(String(lang ?? '').trim().toLowerCase())) return false;
    let n = 0;
    for (const line of text.split('\n')) if (BOX.test(line) && ++n >= MIN_BOX_LINES) return true;
    return false;
  }

  /** How many columns a terminal gives one character (a grapheme): 0, 1 or 2. */
  function width(g) {
    if (!g) return 0;
    if (EMOJI.test(g) || WIDE.test(g)) return 2;
    if (/^[\p{M}​-‏⁠]+$/u.test(g)) return 0;
    return 1;
  }

  /**
   * A line in pieces: runs of text that keep their own width ({ s }), and each
   * other character with the columns it should take ({ s, w }).
   */
  function cells(line) {
    const out = [];
    let run = '';
    for (const g of graphemes(String(line ?? ''))) {
      if (OWN.test(g)) { run += g; continue; }
      if (run) { out.push({ s: run }); run = ''; }
      out.push({ s: g, w: width(g) });
    }
    if (run) out.push({ s: run });
    return out;
  }

  const api = { isDrawing, width, cells, PLAIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyTextGrid = api;
})(typeof window !== 'undefined' ? window : globalThis);
