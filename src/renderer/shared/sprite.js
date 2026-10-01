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
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.overflow = 'visible'; // accessories may poke out of the base grid

    const groups = {};
    const groupFor = (name, cls = `part part-${name}`) => {
      if (!groups[name]) {
        const g = document.createElementNS(SVG_NS, 'g');
        g.setAttribute('class', cls);
        groups[name] = g;
      }
      return groups[name];
    };
    // Bounding box of every part (sprite pixels) to derive animation pivots.
    const box = {};
    const grow = (name, x, y, w) => {
      const b = box[name] || (box[name] = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
      b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x + w); b.y1 = Math.max(b.y1, y + 1);
    };
    const all = { x0: 0, y0: 0, x1: cols, y1: rows };

    // Merge horizontal runs of the same colour into one rect.
    function paintGrid(grid, pal, ox, oy, groupName, partOf) {
      for (let y = 0; y < grid.length; y++) {
        const row = grid[y];
        let x = 0;
        while (x < row.length) {
          const ch = row[x];
          const color = pal[ch];
          if (!color) { x++; continue; }
          const gname = groupName(ch, x, y);
          if (!gname) { x++; continue; }
          let end = x + 1;
          while (end < row.length && row[end] === ch && groupName(row[end], end, y) === gname) end++;
          const r = document.createElementNS(SVG_NS, 'rect');
          r.setAttribute('x', ox + x); r.setAttribute('y', oy + y);
          r.setAttribute('width', end - x); r.setAttribute('height', 1);
          r.setAttribute('fill', color);
          groupFor(gname, partOf ? partOf(gname) : undefined).appendChild(r);
          if (!partOf) grow(gname, ox + x, oy + y, end - x);
          all.x0 = Math.min(all.x0, ox + x); all.y0 = Math.min(all.y0, oy + y);
          all.x1 = Math.max(all.x1, ox + end); all.y1 = Math.max(all.y1, oy + y + 1);
          x = end;
        }
      }
    }

    // opts.shell swaps his home: a shell grid drawn instead of the skin's shell
    // pixels (see src/main/shells.js), or 'none' while he's between shells.
    const home = opts.shell === 'none' ? 'none' : opts.shell && Array.isArray(opts.shell.pixels) ? opts.shell : null;
    paintGrid(pixels, palette, 0, 0, (ch, x, y) => {
      const part = parts[ch] || 'extra';
      if (part === 'shell' && home) return null;
      return part === 'legs' ? `legs-${legGroup[`${x},${y}`] || 'a'}` : part;
    });
    if (home && home !== 'none') paintGrid(home.pixels, home.palette || {}, 0, 0, () => 'shell');

    // Accessories: each joins the animation of the part it follows (same CSS
    // classes) and is painted above the crab, ordered by slot.
    const SLOT_Z = ['shell', 'neck', 'hat', 'face', 'held'];
    const shellTop = home && home !== 'none' && Array.isArray(home.top) ? { shellTop: home.top } : {};
    const anchors = { ...DEFAULT_ANCHORS, ...(skin.anchors || {}), ...shellTop, ...(opts.anchors || {}) };
    const accessories = [...(opts.accessories || [])].sort((a, b) => SLOT_Z.indexOf(a.slot) - SLOT_Z.indexOf(b.slot));
    const accGroups = [];
    for (const acc of accessories) {
      const follows = acc.follows === 'legs' ? 'legs-a' : acc.follows || 'body';
      const [ax, ay] = anchors[acc.anchor] || anchors[SLOT_ANCHOR[acc.slot]] || [0, 0];
      const name = `acc-${acc.slot}-${accGroups.length}`;
      paintGrid(acc.pixels, acc.palette, ax - acc.pivot[0], ay - acc.pivot[1], () => name,
        () => `part part-${follows} acc acc-${acc.slot}`);
      if (groups[name]) accGroups.push({ name, follows });
    }

    // Pivots in sprite pixels, shared by a part and everything that follows it,
    // so a held pumpkin rotates with the claw instead of around itself.
    const pivotOf = name => {
      const b = box[name];
      if (!b) return null;
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      if (name === 'claw') return [b.x0, cy];
      if (name === 'eyes') return [cx, b.y1];
      if (name === 'shell') return [cx, b.y1];
      return [cx, cy];
    };
    const setPivot = (g, p) => {
      if (!g || !p) return;
      g.style.transformBox = 'view-box';
      g.style.transformOrigin = `${p[0]}px ${p[1]}px`;
    };
    for (const name of Object.keys(box)) setPivot(groups[name], pivotOf(name));
    for (const { name, follows } of accGroups) setPivot(groups[name], pivotOf(follows) || [(all.x0 + all.x1) / 2, (all.y0 + all.y1) / 2]);

    // Paint order: legs behind body, shell on top of body, eyes, then outfit.
    for (const name of ['legs-a', 'legs-b', 'stalks', 'body', 'claw', 'extra', 'shell', 'eyes']) {
      if (groups[name]) svg.appendChild(groups[name]);
    }
    for (const { name } of accGroups) svg.appendChild(groups[name]);

    // `fit` frames the whole outfit (for thumbnails and the wardrobe preview);
    // otherwise the view box is the crab alone so he never shifts when dressed.
    const vb = opts.fit ? all : { x0: 0, y0: 0, x1: cols, y1: rows };
    const vw = vb.x1 - vb.x0, vh = vb.y1 - vb.y0;
    svg.setAttribute('viewBox', `${vb.x0} ${vb.y0} ${vw} ${vh}`);
    if (opts.px) { svg.setAttribute('width', vw * opts.px); svg.setAttribute('height', vh * opts.px); }
    svg.dataset.cols = cols;
    svg.dataset.rows = rows;
    return svg;
  }

  // Draws a lone pixel grid (an accessory or effect sprite) as an SVG.
  function grid(pixelsIn, pal, opts = {}) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const w = Math.max(...pixelsIn.map(r => r.length)), hgt = pixelsIn.length;
    svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    if (opts.px) { svg.setAttribute('width', w * opts.px); svg.setAttribute('height', hgt * opts.px); }
    pixelsIn.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        const color = pal[row[x]];
        if (!color) { x++; continue; }
        let end = x + 1;
        while (end < row.length && row[end] === row[x]) end++;
        const r = document.createElementNS(SVG_NS, 'rect');
        r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', end - x); r.setAttribute('height', 1);
        r.setAttribute('fill', color);
        svg.append(r);
        x = end;
      }
    });
    return svg;
  }

  // Must match DEFAULT_ANCHORS / SLOT_ANCHOR in src/main/wardrobe/catalog.js.
  const DEFAULT_ANCHORS = { head: [15, -1], face: [15, 0], neck: [15, 4], claw: [21, 6], shellTop: [7, 0] };
  const SLOT_ANCHOR = { hat: 'head', face: 'face', neck: 'neck', held: 'claw', shell: 'shellTop' };

  root.ShellbySprite = { build, grid, components, DEFAULT_ANCHORS, SLOT_ANCHOR };
})(typeof window !== 'undefined' ? window : globalThis);
