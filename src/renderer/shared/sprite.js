// Builds an animatable SVG from a skin's pixel grid.
// Each part (shell, body, claw, eyes, stalks, legs) becomes its own <g> so CSS
// can animate it; legs are split into alternating groups so they can scuttle.
// Each part and accessory is inked: a one-pixel line round it in the colour it
// borders sunk almost to ink, the Bugdex portraits' line (bugdex/art.js inked).
(function (root) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // A pack's colours become fill attributes: only plain #rrggbb ones are used
  // (the same check minishell.js makes); anything else leaves the pixel empty.
  const HEX = /^#[0-9a-f]{6}$/i;
  const colourOf = (pal, ch) => { const c = pal?.[ch]; return typeof c === 'string' && HEX.test(c) ? c : null; };

  // ------------------------------------------------------------ ink
  // Kept equal to bugdex/art.js's, so he's lined like the portraits (test/sprite-ink.test.js).
  const INK = '#141225';
  const INK_DEPTH = 0.78; // how far the line sinks toward INK
  const N4 = [[0, -1], [-1, 0], [1, 0], [0, 1]];
  const rgb = c => { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const lum = c => { const [r, g, b] = rgb(c); return 0.299 * r + 0.587 * g + 0.114 * b; };
  const sink = c => '#' + rgb(c).map((v, i) => Math.round(v + (rgb(INK)[i] - v) * INK_DEPTH).toString(16).padStart(2, '0')).join('');

  /**
   * The line round each layer: the empty cells beside its pixels, each in the
   * darkest colour of the layer it touches, sunk. A cell any layer fills gets
   * none, so a part's line never covers another part, and a one-pixel gap
   * stays open (between his legs, his eye stalks). Two layers that border the
   * same empty cell both line it, on purpose: when his eyes tuck in or his
   * claw snaps away, the part left behind is still lined.
   * @param {{ name: string, cells: [number, number, string][] }[]} layers
   * @returns {Map<string, [number, number, string][]>} layer name -> its line
   */
  function inkRings(layers) {
    const filled = new Set();
    for (const l of layers) for (const [x, y] of l.cells) filled.add(x + ',' + y);
    const has = (x, y) => filled.has(x + ',' + y);
    const out = new Map();
    for (const l of layers) {
      const own = new Map(l.cells.map(([x, y, c]) => [x + ',' + y, c]));
      const ring = new Map();
      for (const [x, y] of l.cells) {
        for (const [dx, dy] of N4) {
          const nx = x + dx, ny = y + dy, k = nx + ',' + ny;
          if (has(nx, ny) || ring.has(k)) continue;
          if ((has(nx - 1, ny) && has(nx + 1, ny)) || (has(nx, ny - 1) && has(nx, ny + 1))) continue;
          const near = N4.map(([ex, ey]) => own.get((nx + ex) + ',' + (ny + ey))).filter(Boolean);
          const darkest = near.reduce((a, b) => (lum(b) < lum(a) ? b : a));
          ring.set(k, [nx, ny, sink(darkest)]);
        }
      }
      out.set(l.name, [...ring.values()]);
    }
    return out;
  }

  // Cells as one-pixel-high rects, a run of one colour merged into one rect.
  function rectsOf(cells) {
    const rows = new Map();
    for (const c of cells) { if (!rows.has(c[1])) rows.set(c[1], []); rows.get(c[1]).push(c); }
    const out = [];
    for (const [y, row] of rows) {
      row.sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < row.length;) {
        let j = i + 1;
        while (j < row.length && row[j][0] === row[j - 1][0] + 1 && row[j][2] === row[i][2]) j++;
        const r = document.createElementNS(SVG_NS, 'rect');
        r.setAttribute('x', row[i][0]); r.setAttribute('y', y);
        r.setAttribute('width', j - i); r.setAttribute('height', 1);
        r.setAttribute('fill', row[i][2]);
        out.push(r);
        i = j;
      }
    }
    return out;
  }

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

  // opts: px (size of a pixel), fit (frame the whole outfit), shell, stickers,
  // accessories, anchors, and ink: false to leave his line off.
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
    const cellsOf = {}; // group name -> its pixels, for its ink line
    const inkOf = {};   // group name -> the <g> its line goes in
    const inked = opts.ink !== false;
    const groupFor = (name, cls = `part part-${name}`) => {
      if (!groups[name]) {
        const g = document.createElementNS(SVG_NS, 'g');
        g.setAttribute('class', cls);
        if (inked) {
          // Its line goes first, under it, and moves with it.
          const ink = document.createElementNS(SVG_NS, 'g');
          ink.setAttribute('class', 'ink');
          g.appendChild(ink);
          inkOf[name] = ink;
        }
        groups[name] = g;
        cellsOf[name] = [];
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
          const color = colourOf(pal, ch);
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
          for (let i = x; i < end; i++) cellsOf[gname].push([ox + i, oy + y, color]);
          if (!partOf) grow(gname, ox + x, oy + y, end - x);
          all.x0 = Math.min(all.x0, ox + x); all.y0 = Math.min(all.y0, oy + y);
          all.x1 = Math.max(all.x1, ox + end); all.y1 = Math.max(all.y1, oy + y + 1);
          x = end;
        }
      }
    }

    // opts.shell swaps his home: a shell grid drawn instead of the skin's shell
    // pixels (see src/main/progression/shells.js), or 'none' while he's between shells.
    const home = opts.shell === 'none' ? 'none' : opts.shell && Array.isArray(opts.shell.pixels) ? opts.shell : null;
    paintGrid(pixels, palette, 0, 0, (ch, x, y) => {
      const part = parts[ch] || 'extra';
      if (part === 'shell' && home) return null;
      return part === 'legs' ? `legs-${legGroup[`${x},${y}`] || 'a'}` : part;
    });
    if (home && home !== 'none') paintGrid(home.pixels, home.palette || {}, 0, 0, () => 'shell');
    const shellFx = home && home !== 'none' && groups.shell ? shellEffects(home, groups.shell, inked) : null;

    // Each stalk runs on down behind his body, out of sight, so a pose that
    // lifts his eyes (and the stalks and hat with them) by a pixel or two, or
    // bobs his body, never opens a gap between them. Neither lined nor boxed:
    // only the stalks he shows count for his line and his pivots.
    if (groups.stalks) {
      const ROOT = 2;
      const isBody = (x, y) => parts[(pixels[y] || '')[x]] === 'body';
      for (const [x, y, colour] of cellsOf.stalks) {
        if (parts[(pixels[y + 1] || '')[x]] === 'stalks') continue;
        let depth = 0;
        while (depth < ROOT && isBody(x, y + 1 + depth)) depth++;
        if (!depth) continue;
        const r = document.createElementNS(SVG_NS, 'rect');
        r.setAttribute('x', x); r.setAttribute('y', y + 1);
        r.setAttribute('width', 1); r.setAttribute('height', depth);
        r.setAttribute('fill', colour);
        r.setAttribute('class', 'stalk-root');
        groups.stalks.appendChild(r);
      }
    }

    // Stickers for the projects he's shipped (src/main/stickers/index.js), already
    // placed by main in stacking order. They move with the shell, and there's
    // nowhere to put them while he's between shells.
    const stickerGroups = [];
    if (home !== 'none') {
      for (const st of opts.stickers || []) {
        if (!st || !Array.isArray(st.pixels) || !st.palette) continue;
        const name = `sticker-${stickerGroups.length}`;
        const cls = ['part part-shell sticker', `tier-${st.tier || 'paper'}`, st.weather && st.weather !== 'fresh' ? `weather-${st.weather}` : ''].filter(Boolean).join(' ');
        paintGrid(st.pixels, st.palette, st.x, st.y, () => name, () => cls);
        if (groups[name]) {
          if (st.id) groups[name].dataset.sticker = st.id;
          stickerGroups.push(name);
        }
      }
    }

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

    if (inked) {
      const rings = inkRings(Object.keys(groups).map(name => ({ name, cells: cellsOf[name] })));
      for (const [name, ring] of rings) {
        inkOf[name].append(...rectsOf(ring));
        for (const [x, y] of ring) {
          all.x0 = Math.min(all.x0, x); all.y0 = Math.min(all.y0, y);
          all.x1 = Math.max(all.x1, x + 1); all.y1 = Math.max(all.y1, y + 1);
        }
      }
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
    for (const name of stickerGroups) setPivot(groups[name], pivotOf('shell'));

    // Paint order: legs behind body, shell on top of body, its stickers, eyes, then outfit.
    for (const name of ['legs-a', 'legs-b', 'stalks', 'body', 'claw', 'extra', 'shell', ...stickerGroups, 'eyes']) {
      if (groups[name]) svg.appendChild(groups[name]);
    }
    for (const { name } of accGroups) svg.appendChild(groups[name]);
    if (shellFx) svg.prepend(shellFx);

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

  // ------------------------------------------------------------ shell effects
  // A shell may carry frames, a colour cycle, an aura and sparkles (src/main/progression/shells-molt.js).
  // Frames are painted as stacked groups shown one at a time; a cycle paints its
  // keys' pixels with a class each and steps their fill; both run on CSS
  // keyframes in a <style> made for this shell, which reduced motion turns off,
  // leaving the first picture. Returns that <style>, or null for a plain shell.
  const SHELL_ID_RE = /^[a-z0-9-]{1,40}$/i;
  let fxSeq = 0;

  function rectsFor(grid, pal, cls) {
    const out = [];
    grid.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        const ch = row[x];
        const color = colourOf(pal, ch);
        if (!color) { x++; continue; }
        let end = x + 1;
        while (end < row.length && row[end] === ch) end++;
        const r = document.createElementNS(SVG_NS, 'rect');
        r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', end - x); r.setAttribute('height', 1);
        r.setAttribute('fill', color);
        const c = cls(ch);
        if (c) r.setAttribute('class', c);
        out.push(r);
        x = end;
      }
    });
    return out;
  }

  function shellEffects(home, g, inked) {
    const frames = Array.isArray(home.frames) ? home.frames.filter(f => Array.isArray(f)).slice(0, 3) : [];
    const keys = Array.isArray(home.cycle?.keys) ? home.cycle.keys.filter(k => typeof k === 'string' && colourOf(home.palette, k)).slice(0, 7) : [];
    const cycle = keys.length > 1 ? keys : [];
    const sparkle = Math.max(0, Math.min(6, Math.floor(Number(home.sparkle) || 0)));
    const aura = typeof home.aura === 'string' && HEX.test(home.aura) ? home.aura : null;
    if (!frames.length && !cycle.length && !sparkle && !aura) return null;
    const id = `sfx${++fxSeq}${SHELL_ID_RE.test(home.id || '') ? '-' + home.id.replace(/[^a-z0-9-]/gi, '') : ''}`;
    g.classList.add('shell-fx', id);
    if (aura) g.style.filter = `drop-shadow(0 0 1px ${aura}) drop-shadow(0 0 2px ${aura}88)`;
    const css = [];
    const motionCss = [];
    const keyClass = ch => (cycle.includes(ch) ? `${id}-c${cycle.indexOf(ch)}` : '');
    if (frames.length || cycle.length) {
      // Repaint the shell (frame 0 and the rest) with its cycle classes, keeping the ink line first.
      const ink = inked ? g.firstChild : null;
      [...g.childNodes].forEach(n => { if (n !== ink) n.remove(); });
      const pics = [home.pixels, ...frames];
      pics.forEach((grid, i) => {
        const fg = document.createElementNS(SVG_NS, 'g');
        fg.setAttribute('class', `${id}-f ${id}-f${i}`);
        fg.append(...rectsFor(grid, home.palette, keyClass));
        g.appendChild(fg);
      });
      if (frames.length) {
        const n = pics.length;
        const fps = Math.max(1, Math.min(8, Math.floor(Number(home.fps) || 2)));
        css.push(`.${id}-f{opacity:0}.${id}-f0{opacity:1}`);
        for (let i = 0; i < n; i++) {
          const a = (100 * i / n).toFixed(2), b = (100 * (i + 1) / n).toFixed(2);
          motionCss.push(`@keyframes ${id}-k${i}{0%,${a}%{opacity:0}${a}%,${b}%{opacity:1}${b}%,100%{opacity:0}}`);
          motionCss.push(`.${id}-f${i}{animation:${id}-k${i} ${(n / fps).toFixed(3)}s step-end infinite}`);
        }
      }
      if (cycle.length) {
        const fps = Math.max(1, Math.min(8, Math.floor(Number(home.cycle.fps) || 3)));
        const colours = cycle.map(k => colourOf(home.palette, k));
        const n = cycle.length;
        cycle.forEach((_, i) => {
          const steps = colours.map((_, s) => `${(100 * s / n).toFixed(2)}%{fill:${colours[(i + s) % n]}}`).join('');
          motionCss.push(`@keyframes ${id}-y${i}{${steps}100%{fill:${colours[i]}}}`);
          motionCss.push(`.${id}-c${i}{animation:${id}-y${i} ${(n / fps).toFixed(3)}s step-end infinite}`);
        });
      }
    }
    if (sparkle) {
      // Over the shell's own pixels, spread out: the same places every time for the same shell.
      const cells = [];
      home.pixels.forEach((row, y) => [...row].forEach((ch, x) => { if (colourOf(home.palette, ch)) cells.push([x, y]); }));
      for (let i = 0; i < sparkle && cells.length; i++) {
        const [x, y] = cells[Math.floor(((i * 0.618034 + 0.31) % 1) * cells.length)];
        const r = document.createElementNS(SVG_NS, 'rect');
        r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', 1); r.setAttribute('height', 1);
        r.setAttribute('fill', '#ffffff');
        r.setAttribute('class', `${id}-s`);
        r.style.animationDelay = `${(i * 0.37).toFixed(2)}s`;
        g.appendChild(r);
      }
      css.push(`.${id}-s{opacity:0}`);
      motionCss.push(`@keyframes ${id}-tw{0%,70%,100%{opacity:0}80%{opacity:1}90%{opacity:.4}}`);
      motionCss.push(`.${id}-s{animation:${id}-tw 2.2s linear infinite}`);
    }
    const style = document.createElementNS(SVG_NS, 'style');
    style.textContent = `${css.join('')}@media (prefers-reduced-motion: no-preference){${motionCss.join('')}}`;
    return style;
  }

  // Draws a lone pixel grid (an accessory or effect sprite) as an SVG.
  // `ink: true` lines it like he's lined, one pixel bigger all round.
  function grid(pixelsIn, pal, opts = {}) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const pad = opts.ink ? 1 : 0;
    const w = Math.max(...pixelsIn.map(r => r.length)) + 2 * pad, hgt = pixelsIn.length + 2 * pad;
    svg.setAttribute('viewBox', `${-pad} ${-pad} ${w} ${hgt}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    if (opts.px) { svg.setAttribute('width', w * opts.px); svg.setAttribute('height', hgt * opts.px); }
    if (opts.ink) {
      const cells = [];
      pixelsIn.forEach((row, y) => [...row].forEach((ch, x) => { const c = colourOf(pal, ch); if (c) cells.push([x, y, c]); }));
      svg.append(...rectsOf(inkRings([{ name: 'all', cells }]).get('all')));
    }
    pixelsIn.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        const color = colourOf(pal, row[x]);
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

  // An effect's fullest picture: of every sprite and frame, the one with the
  // most pixels drawn (a twinkle's peak, not the dot it starts as). For thumbnails.
  function poster(sprites) {
    let best = null, most = -1;
    for (const s of sprites || []) {
      for (const pixels of [s.pixels, ...(s.frames || [])]) {
        const n = [...pixels.join('')].filter(ch => colourOf(s.palette, ch)).length;
        if (n > most) { most = n; best = { pixels, palette: s.palette }; }
      }
    }
    return best;
  }

  // Must match DEFAULT_ANCHORS / SLOT_ANCHOR in src/main/wardrobe/catalog.js.
  const DEFAULT_ANCHORS = { head: [15, -1], face: [15, 0], neck: [15, 4], claw: [21, 6], shellTop: [7, 0] };
  const SLOT_ANCHOR = { hat: 'head', face: 'face', neck: 'neck', held: 'claw', shell: 'shellTop' };

  root.ShellbySprite = { build, grid, poster, components, inkRings, INK, INK_DEPTH, DEFAULT_ANCHORS, SLOT_ANCHOR };
})(typeof window !== 'undefined' ? window : globalThis);
