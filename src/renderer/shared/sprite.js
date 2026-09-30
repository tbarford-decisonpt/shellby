// Builds an animatable SVG from a skin's pixel grid.
// Each part (shell, body, claw, eyes, stalks, legs) becomes its own <g> so CSS
// can animate it; legs are split into alternating groups so they can scuttle.
(function (root) {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Connected components (8-neighbour) of all pixels belonging to `part`.
  function components(pixels, parts, part) {
    const seen = new Set();
    const out = [];
    const isPart = (x, y) => parts[(pixels[y] || '')[x]] === part;
    for (let y = 0; y < pixels.length; y++) {
      for (let x = 0; x < pixels[y].length; x++) {
        const key = `${x},${y}`;
        if (seen.has(key) || !isPart(x, y)) continue;
        const comp = [];
        const stack = [[x, y]];
        seen.add(key);
        while (stack.length) {
          const [cx, cy] = stack.pop();
          comp.push([cx, cy]);
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy, k = `${nx},${ny}`;
            if (!seen.has(k) && isPart(nx, ny)) { seen.add(k); stack.push([nx, ny]); }
          }
        }
        out.push(comp);
      }
    }
    return out.sort((a, b) => Math.min(...a.map(p => p[0])) - Math.min(...b.map(p => p[0])));
  }

  function build(skin, opts = {}) {
    const { pixels, palette } = skin;
    const parts = skin.parts || {};
    const cols = Math.max(...pixels.map(r => r.length));
    const rows = pixels.length;

    // Which leg group (a/b) each leg pixel belongs to.
    const legGroup = {};
    components(pixels, parts, 'legs').forEach((comp, i) => {
      for (const [x, y] of comp) legGroup[`${x},${y}`] = i % 2 ? 'b' : 'a';
    });

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${cols} ${rows}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    if (opts.px) { svg.setAttribute('width', cols * opts.px); svg.setAttribute('height', rows * opts.px); }

    const groups = {};
    const groupFor = name => {
      if (!groups[name]) {
        const g = document.createElementNS(SVG_NS, 'g');
        g.setAttribute('class', `part part-${name}`);
        groups[name] = g;
      }
      return groups[name];
    };

    // Merge horizontal runs of the same colour + group into one rect.
    for (let y = 0; y < rows; y++) {
      const row = pixels[y];
      let x = 0;
      while (x < row.length) {
        const ch = row[x];
        const color = palette[ch];
        if (!color) { x++; continue; }
        const part = parts[ch] || 'extra';
        const gname = part === 'legs' ? `legs-${legGroup[`${x},${y}`] || 'a'}` : part;
        let end = x + 1;
        while (end < row.length && row[end] === ch &&
               (part !== 'legs' || legGroup[`${end},${y}`] === legGroup[`${x},${y}`])) end++;
        const r = document.createElementNS(SVG_NS, 'rect');
        r.setAttribute('x', x); r.setAttribute('y', y);
        r.setAttribute('width', end - x); r.setAttribute('height', 1);
        r.setAttribute('fill', color);
        groupFor(gname).appendChild(r);
        x = end;
      }
    }

    // Paint order: legs behind body, shell on top of body, eyes last.
    for (const name of ['legs-a', 'legs-b', 'stalks', 'body', 'claw', 'extra', 'shell', 'eyes']) {
      if (groups[name]) svg.appendChild(groups[name]);
    }
    svg.dataset.cols = cols;
    svg.dataset.rows = rows;
    return svg;
  }

  root.ShellbySprite = { build, components };
})(typeof window !== 'undefined' ? window : globalThis);
