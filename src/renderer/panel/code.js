/* Shellby panel — code as code: syntax colours in a reply's code blocks and in
   diffs (shared/syntax.js does the reading), a Copy button on each block, and
   Mermaid diagrams drawn as pictures (shared/mermaid.js). Every token becomes a
   span or a text node with textContent: none of it is ever markup. */
'use strict';
(function () {
  const { h, api } = SB;
  const S = window.ShellbySyntax;
  const M = window.ShellbyMermaid;

  const MAX_BLOCK_CHARS = 200000;  // bigger blocks stay plain: colouring them would stall the panel
  const MAX_BLOCK_LINES = 4000;

  /** Tokens from shared/syntax.js into `el`, coloured by class (tok-kw, tok-str…). */
  SB.paintTokens = (el, tokens) => {
    for (const t of tokens) el.append(t.t ? h('span', { class: `tok-${t.t}`, text: t.s }) : document.createTextNode(t.s));
    return el;
  };

  /**
   * Colours for a diff, one line at a time. The old and new sides each keep
   * their place (a comment opened on a removed line stays open only there),
   * and an unchanged line moves both on.
   *   -> (kind, text) => tokens, where kind is 'add', 'del', 'ctx' or 'hunk'
   */
  SB.diffPainter = (file) => {
    const lang = S.langFromPath(file);
    if (!lang) return null;
    const before = S.lineTokenizer(lang);
    const after = S.lineTokenizer(lang);
    return (kind, text) => {
      if (kind === 'hunk') { before.state = {}; after.state = {}; return null; }
      if (kind === 'del') return before.line(text);
      if (kind === 'add') return after.line(text);
      const out = after.line(text);
      before.state = after.state;
      return out;
    };
  };

  // ------------------------------------------------------------ code blocks in replies

  // Label widths for a diagram, in the font its labels are drawn in.
  let ctx2d = null;
  const measure = (s) => {
    if (!ctx2d) {
      ctx2d = document.createElement('canvas').getContext('2d');
      const family = getComputedStyle(document.body).getPropertyValue('--font-body').trim() || 'sans-serif';
      if (ctx2d) ctx2d.font = `12px ${family}`;
    }
    return ctx2d ? Math.ceil(ctx2d.measureText(String(s)).width) : String(s).length * 7.2;
  };

  function copyButton(text, what) {
    return h('button', {
      class: 'code-copy', type: 'button', title: `Copy ${what}`, 'aria-label': `Copy ${what}`,
      onclick: (e) => {
        e.stopPropagation();
        api.copyText(text());
        const b = e.currentTarget;
        b.textContent = 'Copied';
        setTimeout(() => { b.textContent = 'Copy'; }, 1500);
      },
    }, 'Copy');
  }

  function diagram(pre, source) {
    const scene = M.layout(M.parse(source), measure);
    if (!scene) return false;
    const svg = M.draw(scene, document);
    svg.setAttribute('aria-label', `Diagram (${scene.kind === 'sequence' ? 'sequence' : 'flowchart'})`);
    const pic = h('div', { class: 'mm-pic' }, svg);
    const toggle = h('button', { class: 'code-copy', type: 'button', 'aria-expanded': 'false' }, 'Show the code');
    pre.hidden = true;
    toggle.addEventListener('click', () => {
      const showing = pre.hidden;
      pre.hidden = !showing;
      pic.hidden = showing;
      toggle.textContent = showing ? 'Show the diagram' : 'Show the code';
      toggle.setAttribute('aria-expanded', String(showing));
    });
    const fig = h('figure', { class: 'mm-wrap' },
      h('div', { class: 'code-bar' }, h('span', { class: 'code-lang', text: 'mermaid' }), toggle, copyButton(() => source, 'the diagram\'s code')));
    pre.replaceWith(fig);
    fig.append(pic, pre);
    return true;
  }

  function paint(code, source, lang) {
    if (!lang || source.length > MAX_BLOCK_CHARS) return;
    const tk = S.lineTokenizer(lang);
    if (!tk.lang) return;
    const lines = source.split('\n');
    if (lines.length > MAX_BLOCK_LINES) return;
    code.replaceChildren();
    lines.forEach((l, i) => {
      if (i) code.append('\n');
      SB.paintTokens(code, tk.line(l));
    });
  }

  /**
   * Every fenced block markdown.js made in `el` (<pre><code data-lang>): coloured,
   * with a bar that names its language and copies it. A Mermaid block that
   * parses becomes its diagram, with the code a click away.
   */
  SB.enhanceCode = (el) => {
    for (const code of el.querySelectorAll('pre > code')) {
      const pre = code.parentElement;
      if (pre.dataset.enhanced) continue;
      pre.dataset.enhanced = '1';
      const source = code.textContent;
      const lang = (code.dataset.lang || '').toLowerCase();
      if (lang === 'mermaid' && M && diagram(pre, source)) continue;
      paint(code, source, S.langOf(lang));
      const bar = h('div', { class: 'code-bar' },
        lang ? h('span', { class: 'code-lang', text: lang }) : null,
        copyButton(() => source, 'this code'));
      const box = h('div', { class: 'code-block' });
      pre.replaceWith(box);
      box.append(bar, pre);
    }
    return el;
  };
})();
