// Drawing a Mermaid scene (mermaid.js lays it out) as SVG. Every element is
// made with createElementNS, every attribute is a number or a fixed word, and
// every label goes in with textContent: nothing from a reply is ever parsed as
// markup, and no inline style is needed, so the panel's CSP stays as it is.
// The colours are code.css's (.mm-*).
(function (root) {
  const LINE_H = 16;

  const NS = 'http://www.w3.org/2000/svg';
  const f1 = v => Math.round(v * 10) / 10;

  function draw(scene, doc = root.document) {
    const el = (tag, attrs, cls) => {
      const e = doc.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, typeof v === 'number' ? String(f1(v)) : v);
      if (cls) e.setAttribute('class', cls);
      return e;
    };
    const path = pts => pts.map((p, k) => `${k ? 'L' : 'M'}${f1(p[0])} ${f1(p[1])}`).join(' ');
    const text = (lns, x, y, cls, anchor = 'middle') => {
      const t = el('text', { x, y, 'text-anchor': anchor }, cls);
      lns.forEach((l, k) => {
        const s = el('tspan', { x, dy: k ? LINE_H : 0 });
        s.textContent = l;
        t.appendChild(s);
      });
      return t;
    };
    // Text centred on y, whatever its line count.
    const centred = (lns, x, y, cls) => text(lns, x, y - ((lns.length - 1) * LINE_H) / 2 + 4.5, cls);
    const head = (h, cls) => {
      if (!h) return null;
      if (h.poly) return el('path', { d: `${path(h.poly)} Z` }, `${cls} mm-head`);
      if (h.circle) return el('circle', { cx: h.circle[0], cy: h.circle[1], r: h.r }, `${cls} mm-head-open`);
      if (h.cross) return el('path', { d: `${path(h.cross.slice(0, 2))} ${path(h.cross.slice(2))}` }, `${cls} mm-cross`);
      return null;
    };

    const svg = el('svg', { viewBox: `0 0 ${scene.width} ${scene.height}`, width: scene.width, height: scene.height, role: 'img' }, `mm mm-${scene.kind}`);

    if (scene.kind === 'flowchart') {
      for (const gr of scene.groups) {
        svg.appendChild(el('rect', { x: gr.x, y: gr.y, width: gr.w, height: gr.h, rx: 6 }, 'mm-group'));
        if (gr.title) svg.appendChild(text([gr.title.split('\n')[0]], gr.x + 8, gr.y + 15, 'mm-group-title', 'start'));
      }
      for (const e of scene.edges) {
        if (e.style === 'invisible') continue;
        svg.appendChild(el('path', { d: path(e.points), fill: 'none' }, `mm-edge mm-${e.style}`));
        for (const h of [e.head, e.tail]) { const a = head(h, 'mm-edge-end'); if (a) svg.appendChild(a); }
      }
      for (const n of scene.nodes) {
        const g = el('g', {}, `mm-node mm-${n.shape}`);
        const { x, y, w, h } = n;
        const l = x - w / 2;
        const t = y - h / 2;
        let shape;
        switch (n.shape) {
          case 'round': shape = el('rect', { x: l, y: t, width: w, height: h, rx: 8 }); break;
          case 'stadium': shape = el('rect', { x: l, y: t, width: w, height: h, rx: h / 2 }); break;
          case 'circle': shape = el('circle', { cx: x, cy: y, r: w / 2 }); break;
          case 'start': shape = el('circle', { cx: x, cy: y, r: w / 2 }, 'mm-dot'); break;
          case 'end':
            g.appendChild(el('circle', { cx: x, cy: y, r: w / 2 }));
            shape = el('circle', { cx: x, cy: y, r: w / 2 - 4 }, 'mm-dot');
            break;
          case 'bar': shape = el('rect', { x: l, y: t, width: w, height: h, rx: 2 }, 'mm-dot'); break;
          case 'diamond': shape = el('path', { d: `${path([[x, t], [l + w, y], [x, t + h], [l, y]])} Z` }); break;
          case 'hexagon': shape = el('path', { d: `${path([[l + 12, t], [l + w - 12, t], [l + w, y], [l + w - 12, t + h], [l + 12, t + h], [l, y]])} Z` }); break;
          case 'para': shape = el('path', { d: `${path([[l + 12, t], [l + w, t], [l + w - 12, t + h], [l, t + h]])} Z` }); break;
          case 'trapezoid': shape = el('path', { d: `${path([[l + 12, t], [l + w - 12, t], [l + w, t + h], [l, t + h]])} Z` }); break;
          case 'flag': shape = el('path', { d: `${path([[l, t], [l + w, t], [l + w, t + h], [l, t + h], [l + 12, y]])} Z` }); break;
          case 'cylinder': {
            const ry = 6;
            shape = el('path', { d: `M${f1(l)} ${f1(t + ry)} A${f1(w / 2)} ${ry} 0 0 1 ${f1(l + w)} ${f1(t + ry)} L${f1(l + w)} ${f1(t + h - ry)} A${f1(w / 2)} ${ry} 0 0 1 ${f1(l)} ${f1(t + h - ry)} Z M${f1(l)} ${f1(t + ry)} A${f1(w / 2)} ${ry} 0 0 0 ${f1(l + w)} ${f1(t + ry)}` });
            break;
          }
          case 'subroutine':
            shape = el('rect', { x: l, y: t, width: w, height: h });
            g.appendChild(shape);
            g.appendChild(el('path', { d: `M${f1(l + 7)} ${f1(t)} V${f1(t + h)} M${f1(l + w - 7)} ${f1(t)} V${f1(t + h)}` }, 'mm-inner'));
            shape = null;
            break;
          default: shape = el('rect', { x: l, y: t, width: w, height: h, rx: 3 });
        }
        if (shape) g.appendChild(shape);
        if (n.lines.length) g.appendChild(centred(n.lines, x, y, 'mm-text'));
        svg.appendChild(g);
      }
      for (const e of scene.edges) {
        if (!e.label || e.style === 'invisible') continue;
        const ls = e.label.split('\n');
        const [cx, cy] = e.labelAt;
        svg.appendChild(el('rect', { x: cx - e.labelW / 2, y: cy - e.labelH / 2, width: e.labelW, height: e.labelH, rx: 3 }, 'mm-label-bg'));
        svg.appendChild(centred(ls, cx, cy, 'mm-label'));
      }
    } else {
      for (const f of scene.frames) {
        svg.appendChild(el('rect', { x: f.x, y: f.y, width: f.w, height: f.h, rx: 3 }, 'mm-frame'));
        const tag = el('path', { d: `${path([[f.x, f.y], [f.x + 46, f.y], [f.x + 46, f.y + 12], [f.x + 40, f.y + 18], [f.x, f.y + 18]])} Z` }, 'mm-frame-tag');
        svg.appendChild(tag);
        svg.appendChild(text([f.kind], f.x + 22, f.y + 13, 'mm-frame-kind'));
        if (f.label) svg.appendChild(text([`[${f.label.split('\n')[0]}]`], f.x + 54, f.y + 13, 'mm-frame-label', 'start'));
        for (const d of f.dividers) {
          svg.appendChild(el('path', { d: `M${f1(f.x)} ${f1(d.y)} H${f1(f.x + f.w)}` }, 'mm-frame-divider'));
          if (d.label) svg.appendChild(text([`[${d.label.split('\n')[0]}]`], f.x + f.w / 2, d.y + 13, 'mm-frame-label'));
        }
      }
      for (const p of scene.parts) {
        svg.appendChild(el('path', { d: `M${f1(p.x)} ${f1(p.top + p.headH)} V${f1(p.bottom)}` }, 'mm-life'));
        for (const top of [p.top, p.bottom]) {
          svg.appendChild(el('rect', { x: p.x - p.w / 2, y: top, width: p.w, height: p.headH, rx: p.actor ? p.headH / 2 : 3 }, 'mm-part'));
          svg.appendChild(centred(p.lines, p.x, top + p.headH / 2, 'mm-text'));
        }
      }
      for (const t of scene.notes) {
        svg.appendChild(el('rect', { x: t.x, y: t.y, width: t.w, height: t.h, rx: 2 }, 'mm-note'));
        svg.appendChild(centred(t.lines, t.x + t.w / 2, t.y + t.h / 2, 'mm-text'));
      }
      for (const m of scene.msgs) {
        svg.appendChild(el('path', { d: path(m.points), fill: 'none' }, `mm-edge ${m.dashed ? 'mm-dotted' : 'mm-solid'}`));
        const a = head(m.head, 'mm-edge-end');
        if (a) svg.appendChild(a);
        if (m.lines.length) svg.appendChild(text(m.lines, m.labelAt[0], m.labelAt[1] + 11, 'mm-label', m.self ? 'start' : 'middle'));
      }
    }
    return svg;
  }

  const api = { draw };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyMermaid.draw = draw;
})(typeof window !== 'undefined' ? window : globalThis);
