// Mermaid diagrams in a reply, drawn by Shellby rather than the mermaid
// library: that's megabytes to audit, and it needs inline styles the panel's
// Content-Security-Policy doesn't allow. This covers the kinds Claude draws
// most (flowchart/graph, stateDiagram and sequenceDiagram). Anything else, or
// anything too big or that doesn't parse, comes back null and stays a code
// block.
//
// parse() and layout() are pure: text in, a scene of boxes, lines and labels
// out, with every coordinate and size worked out here. mermaid-draw.js turns a
// scene into SVG. Works in the browser and in Node (for tests).
(function (root) {
  const MAX_NODES = 150;
  const MAX_EDGES = 300;
  const MAX_MESSAGES = 200;
  const MAX_TEXT = 20000;
  const LINE_H = 16;
  const charWidth = 7.2;

  const defaultMeasure = s => Math.ceil(String(s).length * charWidth);

  // A label's text: quotes off, <br> as a new line, other tags and entities out.
  function cleanLabel(s) {
    let t = String(s ?? '').trim();
    if (/^".*"$/s.test(t)) t = t.slice(1, -1);
    t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(+n, 0x10ffff)))
      .replace(/^`(.*)`$/s, '$1').replace(/\*\*(.+?)\*\*/g, '$1');
    return t.split('\n').map(l => l.trim()).join('\n').slice(0, 300);
  }

  const lines = text => String(text).split(/\r?\n/).map(l => l.replace(/%%.*$/, '').trim()).filter(Boolean);

  /** What kind of diagram this is: 'flowchart', 'state', 'sequence', or null. */
  function kindOf(text) {
    const first = lines(text).find(l => !/^---/.test(l)) || '';
    if (/^(graph|flowchart)\b/i.test(first)) return 'flowchart';
    if (/^stateDiagram(-v2)?\b/.test(first)) return 'state';
    if (/^sequenceDiagram\b/.test(first)) return 'sequence';
    return null;
  }

  // ------------------------------------------------------------ flowcharts

  // Shapes by their brackets, longest openers first.
  const SHAPES = [
    ['(((', ')))', 'circle'], ['([', '])', 'stadium'], ['[[', ']]', 'subroutine'], ['[(', ')]', 'cylinder'],
    ['((', '))', 'circle'], ['{{', '}}', 'hexagon'], ['[/', '/]', 'para'], ['[\\', '\\]', 'para'],
    ['[/', '\\]', 'trapezoid'], ['[\\', '/]', 'trapezoid'], ['[', ']', 'rect'], ['(', ')', 'round'],
    ['{', '}', 'diamond'], ['>', ']', 'flag'],
  ];

  // A node at the start of `s`: { id, label?, shape?, rest } or null.
  function readNode(s) {
    const m = /^([A-Za-z0-9_À-￿][\w.À-￿-]*?)(?=[\s[({>&;]|-{2,}|={2,}|-\.|~~~|$|:::)/.exec(s);
    if (!m) return null;
    const id = m[1];
    let rest = s.slice(id.length);
    let label, shape;
    for (const [open, close, name] of SHAPES) {
      if (!rest.startsWith(open)) continue;
      const body = rest.slice(open.length);
      let end;
      if (body.startsWith('"')) {
        const q = body.indexOf('"', 1);
        end = q < 0 ? -1 : body.indexOf(close, q + 1);
      } else end = body.indexOf(close);
      if (end < 0) continue;
      label = cleanLabel(body.slice(0, end));
      shape = name;
      rest = rest.slice(open.length + end + close.length);
      break;
    }
    rest = rest.replace(/^:::[\w-]+/, '');
    return { id, label, shape, rest };
  }

  // A link at the start of `s`: { style, arrow, label, rest } or null.
  function readLink(s) {
    const t = s.replace(/^\s+/, '');
    // A -- text --> B, A == text ==> B, A -. text .-> B
    let m = /^(<?)(--|==|-\.)\s+(.+?)\s+(-->|---|==>|===|\.->|\.-|--x|--o)(?=\s|[A-Za-z0-9_"]|$)/.exec(t);
    if (m) {
      const end = m[4];
      return {
        style: m[2] === '==' ? 'thick' : m[2] === '-.' ? 'dotted' : 'solid',
        arrow: /[>xo]$/.test(end) ? end.slice(-1) : null,
        back: !!m[1],
        label: cleanLabel(m[3]),
        rest: t.slice(m[0].length),
      };
    }
    m = /^(<?)(-{2,}|={2,}|-\.+-|~~~)([>xo]?)(?:\|([^|]*)\|)?/.exec(t);
    if (!m) return null;
    return {
      style: m[2] === '~~~' ? 'invisible' : m[2][0] === '=' ? 'thick' : m[2].includes('.') ? 'dotted' : 'solid',
      arrow: m[3] || null,
      back: !!m[1],
      label: m[4] != null ? cleanLabel(m[4]) : '',
      rest: t.slice(m[0].length),
    };
  }

  function splitStatements(text) {
    const out = [];
    for (const l of lines(text)) {
      // Semicolons end statements, but not inside a quoted label.
      let cur = '';
      let inQ = false;
      for (const ch of l) {
        if (ch === '"') inQ = !inQ;
        if (ch === ';' && !inQ) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
      }
      if (cur.trim()) out.push(cur.trim());
    }
    return out;
  }

  function parseFlowchart(text) {
    const stmts = splitStatements(text);
    const head = /^(?:graph|flowchart)\s*(TD|TB|BT|LR|RL)?/i.exec(stmts[0] || '');
    if (!head) return null;
    const dir = (head[1] || 'TD').toUpperCase().replace('TB', 'TD');
    const nodes = new Map();
    const edges = [];
    const groups = [];
    const stack = [];
    const touch = (n) => {
      let node = nodes.get(n.id);
      if (!node) { node = { id: n.id, label: n.id, shape: 'rect' }; nodes.set(n.id, node); }
      if (n.label != null) node.label = n.label;
      if (n.shape) node.shape = n.shape;
      for (const g of stack) if (!g.members.includes(n.id)) g.members.push(n.id);
      return node;
    };
    const rest0 = stmts[0].slice(head[0].length).trim();
    const body = rest0 ? [rest0, ...stmts.slice(1)] : stmts.slice(1);

    for (const st of body) {
      if (/^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/.test(st)) continue;
      const sg = /^subgraph\s+(.*)$/.exec(st);
      if (sg) {
        // subgraph id, subgraph id[Title], subgraph id [Title] or subgraph "Title"
        const m = /^([\w.-]+)\s*\[(.*)\]$/.exec(sg[1].trim());
        const plain = /^[\w.-]+$/.test(sg[1].trim());
        const g = m ? { id: m[1], title: cleanLabel(m[2]), members: [] }
          : { id: plain ? sg[1].trim() : `sg${groups.length}`, title: cleanLabel(sg[1]), members: [] };
        groups.push(g);
        stack.push(g);
        continue;
      }
      if (st === 'end') { stack.pop(); continue; }

      // node group (& node group)*, then (link, node group)*
      let s = st;
      const readGroup = () => {
        const got = [];
        for (;;) {
          s = s.replace(/^\s+/, '');
          const n = readNode(s);
          if (!n) break;
          got.push(touch(n));
          s = n.rest.replace(/^\s+/, '');
          if (s.startsWith('&')) { s = s.slice(1); continue; }
          break;
        }
        return got;
      };
      let from = readGroup();
      if (!from.length) continue;
      for (;;) {
        const link = readLink(s);
        if (!link) break;
        s = link.rest;
        const to = readGroup();
        if (!to.length) break;
        for (const a of from) for (const b of to) {
          edges.push({ from: a.id, to: b.id, label: link.label, style: link.style, arrow: link.arrow, both: link.back });
        }
        from = to;
      }
      if (nodes.size > MAX_NODES || edges.length > MAX_EDGES) return null;
    }
    if (!nodes.size) return null;
    return { kind: 'flowchart', dir, nodes: [...nodes.values()], edges, groups: groups.filter(g => g.members.length) };
  }

  function parseState(text) {
    const ls = lines(text);
    if (!/^stateDiagram/.test(ls[0] || '')) return null;
    let dir = 'TD';
    const nodes = new Map();
    const edges = [];
    let starts = 0;
    let ends = 0;
    const node = (id, label) => {
      let n = nodes.get(id);
      if (!n) { n = { id, label: label ?? id, shape: 'round' }; nodes.set(id, n); }
      else if (label != null) n.label = label;
      return n;
    };
    const depth = [];
    for (const l of ls.slice(1)) {
      const d = /^direction\s+(TB|TD|LR|RL|BT)/.exec(l);
      if (d) { if (!depth.length) dir = d[1].replace('TB', 'TD'); continue; }
      if (/^(classDef|class|style|note\b|end note|\}|--$)/i.test(l)) { if (l === '}') depth.pop(); continue; }
      let m = /^state\s+"([^"]*)"\s+as\s+([\w.-]+)/.exec(l);
      if (m) { node(m[2], cleanLabel(m[1])); continue; }
      m = /^state\s+([\w.-]+)\s*(<<\w+>>)?\s*(\{)?$/.exec(l);
      if (m) {
        const n = node(m[1]);
        if (/choice/.test(m[2] || '')) { n.shape = 'diamond'; n.label = ''; }
        if (/fork|join/.test(m[2] || '')) { n.shape = 'bar'; n.label = ''; }
        if (m[3]) depth.push(m[1]);
        continue;
      }
      m = /^(\[\*\]|[\w.-]+)\s*-->\s*(\[\*\]|[\w.-]+)\s*(?::\s*(.*))?$/.exec(l);
      if (m) {
        const end = (tok, isFrom) => {
          if (tok !== '[*]') return node(tok).id;
          const id = isFrom ? `[*]start${starts++}` : `[*]end${ends++}`;
          nodes.set(id, { id, label: '', shape: isFrom ? 'start' : 'end' });
          return id;
        };
        edges.push({ from: end(m[1], true), to: end(m[2], false), label: cleanLabel(m[3] || ''), style: 'solid', arrow: '>' });
        if (nodes.size > MAX_NODES || edges.length > MAX_EDGES) return null;
        continue;
      }
      m = /^([\w.-]+)\s*:\s*(.+)$/.exec(l);
      if (m) { node(m[1], cleanLabel(m[2])); continue; }
      m = /^([\w.-]+)$/.exec(l);
      if (m) node(m[1]);
    }
    if (!nodes.size) return null;
    return { kind: 'flowchart', dir, nodes: [...nodes.values()], edges, groups: [] };
  }

  // Node sizes by shape, from the label's size.
  function sizeNode(n, measure) {
    const ls = n.label ? n.label.split('\n') : [];
    const tw = ls.reduce((w, l) => Math.max(w, measure(l)), 0);
    const th = ls.length * LINE_H;
    let w = Math.max(tw + 28, 44);
    let h = Math.max(th + 18, 36);
    switch (n.shape) {
      case 'circle': w = h = Math.max(w, h, 44); break;
      case 'diamond': w = Math.max(tw * 1.5 + 30, 50); h = Math.max(th * 1.6 + 26, 50); break;
      case 'hexagon': w += 24; break;
      case 'para': case 'trapezoid': w += 24; break;
      case 'cylinder': h += 12; break;
      case 'start': case 'end': w = h = 20; break;
      case 'bar': w = 70; h = 8; break;
      default:
    }
    if (n.shape === 'diamond' && !n.label) { w = h = 30; }
    n.w = Math.round(w);
    n.h = Math.round(h);
    n.lines = ls;
  }

  /** Layered layout: ranks along the flow, order across it, then coordinates. */
  function layoutFlow(g, measure) {
    const nodes = g.nodes.map(n => ({ ...n }));
    nodes.forEach(n => sizeNode(n, measure));
    const byId = new Map(nodes.map(n => [n.id, n]));
    const horizontal = g.dir === 'LR' || g.dir === 'RL';
    const reverse = g.dir === 'BT' || g.dir === 'RL';
    const mainSize = n => (horizontal ? n.w : n.h);
    const crossSize = n => (horizontal ? n.h : n.w);

    // Break cycles: an edge back to a node still on the DFS stack is ranked as
    // if it ran the other way.
    const out = new Map(nodes.map(n => [n.id, []]));
    g.edges.forEach((e, i) => { if (e.from !== e.to) out.get(e.from).push(i); });
    const flipped = new Set();
    const seen = new Set();
    const onStack = new Set();
    const dfs = (id) => {
      seen.add(id); onStack.add(id);
      for (const i of out.get(id)) {
        const t = g.edges[i].to;
        if (onStack.has(t)) flipped.add(i);
        else if (!seen.has(t)) dfs(t);
      }
      onStack.delete(id);
    };
    nodes.forEach(n => { if (!seen.has(n.id)) dfs(n.id); });
    const dag = g.edges.map((e, i) => (e.from === e.to ? null : flipped.has(i) ? { from: e.to, to: e.from, i } : { from: e.from, to: e.to, i })).filter(Boolean);

    // Rank: longest path from a source.
    const rank = new Map(nodes.map(n => [n.id, 0]));
    const indeg = new Map(nodes.map(n => [n.id, 0]));
    dag.forEach(e => indeg.set(e.to, indeg.get(e.to) + 1));
    const queue = nodes.filter(n => !indeg.get(n.id)).map(n => n.id);
    const dagOut = new Map(nodes.map(n => [n.id, []]));
    dag.forEach(e => dagOut.get(e.from).push(e));
    while (queue.length) {
      const id = queue.shift();
      for (const e of dagOut.get(id)) {
        rank.set(e.to, Math.max(rank.get(e.to), rank.get(id) + 1));
        indeg.set(e.to, indeg.get(e.to) - 1);
        if (!indeg.get(e.to)) queue.push(e.to);
      }
    }

    // Long edges get a dummy point on every rank they pass, so they bend
    // around the nodes in between instead of through them.
    const layers = [];
    const put = (v) => { (layers[v.rank] ||= []).push(v); };
    const verts = nodes.map(n => ({ id: n.id, rank: rank.get(n.id), node: n, cross: crossSize(n), main: mainSize(n) }));
    verts.forEach(put);
    const vById = new Map(verts.map(v => [v.id, v]));
    const chains = new Map(); // dag edge index -> [vert, ...] from its top end to its bottom end
    dag.forEach((e) => {
      const a = vById.get(e.from);
      const b = vById.get(e.to);
      const chain = [a];
      for (let r = a.rank + 1; r < b.rank; r++) {
        const d = { id: `~${e.i}~${r}`, rank: r, dummy: true, cross: 12, main: 0 };
        put(d);
        vById.set(d.id, d);
        chain.push(d);
      }
      chain.push(b);
      chains.set(e.i, chain);
    });
    const ups = new Map();
    const downs = new Map();
    for (const chain of chains.values()) {
      for (let k = 0; k + 1 < chain.length; k++) {
        (downs.get(chain[k].id) || downs.set(chain[k].id, []).get(chain[k].id)).push(chain[k + 1]);
        (ups.get(chain[k + 1].id) || ups.set(chain[k + 1].id, []).get(chain[k + 1].id)).push(chain[k]);
      }
    }
    for (let r = 0; r < layers.length; r++) layers[r] ||= [];

    // Order across each rank: a few barycentre sweeps down and up.
    const index = () => layers.forEach(l => l.forEach((v, k) => { v.pos = k; }));
    index();
    const bary = (v, nbrs) => {
      const ns = nbrs.get(v.id);
      return ns && ns.length ? ns.reduce((s, u) => s + u.pos, 0) / ns.length : v.pos;
    };
    for (let pass = 0; pass < 6; pass++) {
      const down = pass % 2 === 0;
      const order = down ? layers.map((_, k) => k) : layers.map((_, k) => layers.length - 1 - k);
      for (const r of order) {
        const nbrs = down ? ups : downs;
        layers[r].forEach(v => { v.b = bary(v, nbrs); });
        layers[r].sort((a, b) => a.b - b.b || a.pos - b.pos);
        layers[r].forEach((v, k) => { v.pos = k; });
      }
    }

    // Coordinates across: pack each rank, then pull each vertex toward its
    // neighbours a few times, keeping order and spacing.
    const GAP = 28;
    layers.forEach((l) => {
      let x = 0;
      l.forEach((v) => { v.c = x + v.cross / 2; x += v.cross + GAP; });
    });
    // Each vertex where it wants to be, then the overlaps pushed out once to
    // the right and once to the left; the average of the two keeps the
    // spacing and doesn't drift the rank to one side.
    const settle = (l, want) => {
      const wanted = l.map(want);
      const sep = k => (l[k - 1].cross + l[k].cross) / 2 + GAP;
      const right = wanted.slice();
      for (let k = 1; k < l.length; k++) right[k] = Math.max(right[k], right[k - 1] + sep(k));
      const left = wanted.slice();
      for (let k = l.length - 2; k >= 0; k--) left[k] = Math.min(left[k], left[k + 1] - sep(k + 1));
      l.forEach((v, k) => { v.c = (right[k] + left[k]) / 2; });
    };
    const mean = (v, nbrs) => {
      const ns = nbrs.get(v.id);
      return ns && ns.length ? ns.reduce((s, u) => s + u.c, 0) / ns.length : v.c;
    };
    for (let it = 0; it < 8; it++) {
      const down = it % 2 === 0;
      const order = down ? layers.map((_, k) => k) : layers.map((_, k) => layers.length - 1 - k);
      for (const r of order) settle(layers[r], v => mean(v, down ? ups : downs));
    }
    let minC = Infinity;
    let maxC = -Infinity;
    for (const l of layers) for (const v of l) { minC = Math.min(minC, v.c - v.cross / 2); maxC = Math.max(maxC, v.c + v.cross / 2); }

    // Coordinates along: each rank as deep as its biggest node.
    const RANK_GAP = 46;
    const depth = layers.map(l => l.reduce((m, v) => Math.max(m, v.main), 0));
    const at = [];
    let y = 0;
    depth.forEach((d, r) => { at[r] = y + d / 2; y += d + RANK_GAP; });
    const mainTotal = Math.max(0, y - RANK_GAP);

    const PAD = 16;
    const crossTotal = maxC - minC;
    const place = (c, m) => {
      const cc = c - minC + PAD;
      const mm = (reverse ? mainTotal - m : m) + PAD;
      return horizontal ? { x: mm, y: cc } : { x: cc, y: mm };
    };
    for (const l of layers) for (const v of l) Object.assign(v, place(v.c, at[v.rank]));
    nodes.forEach((n) => { const v = vById.get(n.id); n.x = v.x; n.y = v.y; });

    // Edges: through their dummies, clipped to the boxes at either end.
    const edges = [];
    g.edges.forEach((e, i) => {
      const a = byId.get(e.from);
      if (e.from === e.to) {
        const r = Math.min(a.w, a.h) / 2;
        const x0 = a.x + a.w / 2;
        const pts = [[x0, a.y - r / 2], [x0 + 22, a.y - r / 2], [x0 + 22, a.y + r / 2], [x0, a.y + r / 2]];
        edges.push(edgeOut(e, pts, [x0 + 26, a.y]));
        return;
      }
      let chain = chains.get(i).map(v => [v.x, v.y]);
      if (flipped.has(i)) chain = chain.reverse();
      const b = byId.get(e.to);
      chain[0] = clip(a, chain[1]);
      chain[chain.length - 1] = clip(b, chain[chain.length - 2]);
      const mid = Math.floor((chain.length - 1) / 2);
      const p = chain[mid];
      const q = chain[mid + 1];
      edges.push(edgeOut(e, chain, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]));
    });

    // Subgraph boxes, only where one wouldn't swallow a node that isn't in it.
    const groups = [];
    for (const gr of g.groups) {
      const ms = gr.members.map(id => byId.get(id)).filter(Boolean);
      if (!ms.length) continue;
      const x1 = Math.min(...ms.map(n => n.x - n.w / 2)) - 10;
      const x2 = Math.max(...ms.map(n => n.x + n.w / 2)) + 10;
      const y1 = Math.min(...ms.map(n => n.y - n.h / 2)) - 24;
      const y2 = Math.max(...ms.map(n => n.y + n.h / 2)) + 10;
      const intruder = nodes.some(n => !gr.members.includes(n.id) && n.x > x1 && n.x < x2 && n.y > y1 && n.y < y2);
      if (!intruder) groups.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, title: gr.title });
    }

    for (const e of edges) {
      if (!e.label) continue;
      const ls = e.label.split('\n');
      e.labelW = Math.max(...ls.map(measure)) + 10;
      e.labelH = ls.length * LINE_H + 4;
    }

    let width = (horizontal ? mainTotal : crossTotal) + PAD * 2;
    let height = (horizontal ? crossTotal : mainTotal) + PAD * 2;
    // Room for a group's title above the top rank, and self-loops at the side.
    const minY = Math.min(0, ...groups.map(gr => gr.y - 4));
    const maxX = Math.max(width, ...nodes.map(n => n.x + n.w / 2 + 30));
    if (minY < 0) {
      nodes.forEach(n => { n.y -= minY; });
      edges.forEach((e) => {
        e.points.forEach((p) => { p[1] -= minY; });
        e.labelAt[1] -= minY;
        if (e.head) e.head = moveShape(e.head, 0, -minY);
        if (e.tail) e.tail = moveShape(e.tail, 0, -minY);
      });
      groups.forEach(gr => { gr.y -= minY; });
      height -= minY;
    }
    width = Math.max(width, edges.some(e => e.loop) ? maxX : width);

    return {
      kind: 'flowchart',
      width: Math.ceil(width),
      height: Math.ceil(height),
      nodes: nodes.map(n => ({ id: n.id, shape: n.shape, x: n.x, y: n.y, w: n.w, h: n.h, lines: n.lines })),
      edges,
      groups,
    };
  }

  // Where the line from a node's centre toward `p` leaves the node.
  function clip(n, p) {
    const dx = p[0] - n.x;
    const dy = p[1] - n.y;
    if (!dx && !dy) return [n.x, n.y];
    if (n.shape === 'circle' || n.shape === 'start' || n.shape === 'end') {
      const d = Math.hypot(dx, dy);
      return [n.x + (dx / d) * (n.w / 2), n.y + (dy / d) * (n.h / 2)];
    }
    if (n.shape === 'diamond') {
      const t = 1 / (Math.abs(dx) / (n.w / 2) + Math.abs(dy) / (n.h / 2));
      return [n.x + dx * t, n.y + dy * t];
    }
    const t = Math.min(dx ? (n.w / 2) / Math.abs(dx) : Infinity, dy ? (n.h / 2) / Math.abs(dy) : Infinity);
    return [n.x + dx * t, n.y + dy * t];
  }

  function arrowHead(from, to, kind) {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const L = 9;
    const W = 4.5;
    if (kind === 'o') return { circle: [to[0] - ux * 4, to[1] - uy * 4], r: 4 };
    if (kind === 'x') {
      const c = [to[0] - ux * 5, to[1] - uy * 5];
      return { cross: [[c[0] - 4, c[1] - 4], [c[0] + 4, c[1] + 4], [c[0] - 4, c[1] + 4], [c[0] + 4, c[1] - 4]] };
    }
    return { poly: [to, [to[0] - ux * L - uy * W, to[1] - uy * L + ux * W], [to[0] - ux * L + uy * W, to[1] - uy * L - ux * W]] };
  }

  function edgeOut(e, pts, labelAt) {
    const points = pts.map(p => [p[0], p[1]]);
    const n = points.length;
    const out = { style: e.style, points, label: e.label || '', labelAt, loop: e.from === e.to };
    if (e.arrow) out.head = arrowHead(points[n - 2], points[n - 1], e.arrow);
    if (e.both && e.arrow) out.tail = arrowHead(points[1], points[0], e.arrow);
    return out;
  }

  // ------------------------------------------------------------ sequence diagrams

  function parseSequence(text) {
    const ls = lines(text);
    if (!/^sequenceDiagram/.test(ls[0] || '')) return null;
    const parts = new Map();
    const steps = [];
    let auto = false;
    const part = (id, label, actor) => {
      let p = parts.get(id);
      if (!p) { p = { id, label: label ?? id, actor: !!actor }; parts.set(id, p); }
      else if (label != null) p.label = label;
      return p;
    };
    for (const l of ls.slice(1)) {
      if (/^autonumber\b/.test(l)) { auto = true; continue; }
      let m = /^(participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/.exec(l);
      if (m) { part(m[2].trim(), m[3] != null ? cleanLabel(m[3]) : null, m[1] === 'actor'); continue; }
      if (/^(activate|deactivate|create|destroy|box|rect|links?|properties|details|title)\b/.test(l)) continue;
      m = /^(loop|alt|opt|par|critical|break)\b\s*(.*)$/.exec(l);
      if (m) { steps.push({ type: 'open', kind: m[1], label: cleanLabel(m[2]) }); continue; }
      m = /^(else|and|option)\b\s*(.*)$/.exec(l);
      if (m) { steps.push({ type: 'divide', label: cleanLabel(m[2]) }); continue; }
      if (l === 'end') { steps.push({ type: 'close' }); continue; }
      m = /^note\s+(left of|right of|over)\s+([^,:]+?)(?:\s*,\s*([^:]+?))?\s*:\s*(.*)$/i.exec(l);
      if (m) {
        part(m[2].trim()); if (m[3]) part(m[3].trim());
        steps.push({ type: 'note', where: m[1].toLowerCase(), a: m[2].trim(), b: m[3] ? m[3].trim() : null, label: cleanLabel(m[4]) });
        continue;
      }
      m = /^(.+?)\s*(-->>|->>|-->|->|--x|-x|--\)|-\))\s*([+-]?)\s*(.+?)\s*:\s*(.*)$/.exec(l);
      if (m) {
        const from = part(m[1].trim()).id;
        const to = part(m[4].trim()).id;
        steps.push({ type: 'msg', from, to, dashed: m[2].startsWith('--'), arrow: /x$/.test(m[2]) ? 'x' : /\)$/.test(m[2]) ? 'open' : />>$/.test(m[2]) ? '>' : 'line', label: cleanLabel(m[5]) });
        if (steps.length > MAX_MESSAGES) return null;
      }
    }
    if (!parts.size) return null;
    return { kind: 'sequence', parts: [...parts.values()], steps, auto };
  }

  function layoutSequence(sq, measure) {
    const PAD = 16;
    const parts = sq.parts.map(p => ({ ...p, lines: p.label.split('\n') }));
    parts.forEach((p) => {
      p.w = Math.max(80, p.lines.reduce((w, l) => Math.max(w, measure(l)), 0) + 24);
      p.h = p.lines.length * LINE_H + 16;
    });
    const idx = new Map(parts.map((p, k) => [p.id, k]));
    // Columns far enough apart for the widest message between neighbours.
    const need = parts.map(() => 0);
    sq.steps.forEach((s) => {
      if (s.type !== 'msg' || s.from === s.to) return;
      const a = Math.min(idx.get(s.from), idx.get(s.to));
      const b = Math.max(idx.get(s.from), idx.get(s.to));
      const w = s.label.split('\n').reduce((m, l) => Math.max(m, measure(l)), 0) + 30;
      const each = w / (b - a);
      for (let k = a; k < b; k++) need[k] = Math.max(need[k], each);
    });
    let x = PAD;
    parts.forEach((p, k) => {
      if (k) {
        const prev = parts[k - 1];
        x = Math.max(prev.x + prev.w / 2 + 30 + p.w / 2, prev.x + need[k - 1]);
      } else x = PAD + p.w / 2;
      p.x = x;
    });
    const headH = parts.reduce((m, p) => Math.max(m, p.h), 0);
    let y = PAD + headH + 16;
    const msgs = [];
    const notes = [];
    const frames = [];
    const open = [];
    let n = 0;
    const colX = id => parts[idx.get(id)].x;
    for (const s of sq.steps) {
      if (s.type === 'open') {
        open.push({ kind: s.kind, label: s.label, y, dividers: [], lo: Infinity, hi: -Infinity, depth: open.length });
        y += 28;
      } else if (s.type === 'divide') {
        const f = open[open.length - 1];
        if (f) { f.dividers.push({ y: y + 4, label: s.label }); y += 26; }
      } else if (s.type === 'close') {
        const f = open.pop();
        if (f) {
          f.h = y - f.y + 6;
          frames.push(f);
          y += 14;
          const parent = open[open.length - 1];
          if (parent) { parent.lo = Math.min(parent.lo, f.lo); parent.hi = Math.max(parent.hi, f.hi); }
        }
      } else if (s.type === 'note') {
        const ls = s.label.split('\n');
        const w = Math.max(60, ls.reduce((m, l) => Math.max(m, measure(l)), 0) + 20);
        const h = ls.length * LINE_H + 12;
        let nx;
        let nw = w;
        if (s.where === 'over') {
          const xa = colX(s.a);
          const xb = s.b ? colX(s.b) : xa;
          nw = Math.max(w, Math.abs(xb - xa) + 40);
          nx = (xa + xb) / 2 - nw / 2;
        } else if (s.where === 'left of') nx = colX(s.a) - 12 - w;
        else nx = colX(s.a) + 12;
        notes.push({ x: nx, y, w: nw, h, lines: ls });
        for (const f of open) { f.lo = Math.min(f.lo, nx); f.hi = Math.max(f.hi, nx + nw); }
        y += h + 12;
      } else if (s.type === 'msg') {
        const ls = s.label ? s.label.split('\n') : [];
        const textH = ls.length * LINE_H;
        const x1 = colX(s.from);
        const x2 = colX(s.to);
        const label = sq.auto ? [`${++n}. ${ls[0] || ''}`, ...ls.slice(1)] : ls;
        if (s.from === s.to) {
          const top = y + textH + 4;
          msgs.push({ self: true, x: x1, y: top, h: 22, lines: label, labelAt: [x1 + 34, y + 2], dashed: s.dashed, arrow: s.arrow, points: [[x1, top], [x1 + 30, top], [x1 + 30, top + 22], [x1, top + 22]] });
          for (const f of open) { f.lo = Math.min(f.lo, x1); f.hi = Math.max(f.hi, x1 + 40 + label.reduce((m, l) => Math.max(m, measure(l)), 0)); }
          y += textH + 40;
        } else {
          const ly = y + textH + 4;
          msgs.push({ x1, x2, y: ly, lines: label, labelAt: [(x1 + x2) / 2, y], dashed: s.dashed, arrow: s.arrow, points: [[x1, ly], [x2, ly]] });
          for (const f of open) { f.lo = Math.min(f.lo, Math.min(x1, x2)); f.hi = Math.max(f.hi, Math.max(x1, x2)); }
          y += textH + 22;
        }
      }
    }
    // Frames left open at the end still get drawn.
    while (open.length) { const f = open.pop(); f.h = y - f.y; frames.push(f); }
    const lifeEnd = y + 6;
    const left = parts[0].x - parts[0].w / 2;
    const right = parts[parts.length - 1].x + parts[parts.length - 1].w / 2;
    for (const f of frames) {
      if (!Number.isFinite(f.lo)) { f.lo = left; f.hi = right; }
      const inset = 14 - Math.min(f.depth, 3) * 4;
      f.x = f.lo - 16 - inset;
      f.w = f.hi - f.lo + 32 + inset * 2;
    }
    for (const m of msgs) {
      if (m.self) { if (m.arrow !== 'line') m.head = arrowHead([m.x + 30, m.y + 22], [m.x + 1, m.y + 22], m.arrow === 'open' ? '>' : m.arrow); continue; }
      const dir = Math.sign(m.x2 - m.x1);
      const end = [m.x2 - dir, m.y];
      if (m.arrow === '>' || m.arrow === 'open' || m.arrow === 'x') m.head = arrowHead([m.x1, m.y], end, m.arrow === 'x' ? 'x' : '>');
    }
    // Shift everything right if a note or frame starts left of the margin.
    const minX = Math.min(left, ...notes.map(t => t.x), ...frames.map(f => f.x)) - PAD;
    const shift = minX < 0 ? -minX : 0;
    const maxX = Math.max(right, ...notes.map(t => t.x + t.w), ...frames.map(f => f.x + f.w), ...msgs.filter(m => m.self).map(m => m.labelAt[0] + m.lines.reduce((w, l) => Math.max(w, measure(l)), 0))) + PAD;
    const sx = v => v + shift;
    const height = lifeEnd + headH + PAD;
    return {
      kind: 'sequence',
      width: Math.ceil(maxX + shift),
      height: Math.ceil(height),
      parts: parts.map(p => ({ x: sx(p.x), w: p.w, h: p.h, lines: p.lines, actor: p.actor, top: PAD, bottom: lifeEnd, headH })),
      msgs: msgs.map(m => ({
        dashed: m.dashed,
        points: m.points.map(p => [sx(p[0]), p[1]]),
        head: m.head && moveShape(m.head, shift),
        lines: m.lines,
        labelAt: [sx(m.labelAt[0]), m.labelAt[1]],
        self: !!m.self,
      })),
      notes: notes.map(t => ({ ...t, x: sx(t.x) })),
      frames: frames.map(f => ({ kind: f.kind, label: f.label, x: sx(f.x), y: f.y, w: f.w, h: f.h, dividers: f.dividers })),
    };
  }

  function moveShape(s, dx, dy = 0) {
    const mv = p => [p[0] + dx, p[1] + dy];
    if (s.poly) return { poly: s.poly.map(mv) };
    if (s.cross) return { cross: s.cross.map(mv) };
    if (s.circle) return { circle: mv(s.circle), r: s.r };
    return s;
  }

  // ------------------------------------------------------------ public

  /** Parse a diagram: a graph description, or null if it isn't one we draw. */
  function parse(text) {
    const t = String(text ?? '');
    if (!t.trim() || t.length > MAX_TEXT) return null;
    try {
      const kind = kindOf(t);
      if (kind === 'flowchart') return parseFlowchart(t);
      if (kind === 'state') return parseState(t);
      if (kind === 'sequence') return parseSequence(t);
    } catch { /* not one we can read */ }
    return null;
  }

  /** A parsed diagram laid out: { kind, width, height, ... } with every coordinate. */
  function layout(graph, measure = defaultMeasure) {
    if (!graph) return null;
    try {
      return graph.kind === 'sequence' ? layoutSequence(graph, measure) : layoutFlow(graph, measure);
    } catch { return null; }
  }

  const api = { kindOf, parse, layout, cleanLabel, LINE_H, MAX_NODES, MAX_EDGES, MAX_MESSAGES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyMermaid = api;
})(typeof window !== 'undefined' ? window : globalThis);
