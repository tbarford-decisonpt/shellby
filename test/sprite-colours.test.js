// A pack's palette reaches the page as SVG fill attributes (src/renderer/shared/sprite.js),
// so only plain #rrggbb colours are drawn; anything else leaves its pixels empty.
const { test } = require('node:test');
const assert = require('node:assert/strict');

function element(tag) {
  return {
    tag, attrs: {}, children: [], style: {}, dataset: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    append(...kids) { this.children.push(...kids); },
    appendChild(kid) { this.children.push(kid); return kid; },
  };
}

function withDocument(fn) {
  const before = globalThis.document;
  globalThis.document = { createElementNS: (_ns, tag) => element(tag) };
  try { return fn(); } finally { globalThis.document = before; }
}

require('../src/renderer/shared/sprite');
const { grid, build } = globalThis.ShellbySprite;
const fills = svg => {
  const out = [];
  (function walk(el) { if (el.attrs?.fill) out.push(el.attrs.fill); for (const c of el.children || []) walk(c); })(svg);
  return out;
};

test('a grid draws its #rrggbb colours', () => {
  const svg = withDocument(() => grid(['ab', 'ba'], { a: '#ff7a5c', b: '#7FD6C2' }));
  assert.deepEqual(fills(svg).sort(), ['#7FD6C2', '#7FD6C2', '#ff7a5c', '#ff7a5c'].sort());
});

test('a grid leaves out colours that are not plain hex', () => {
  const pal = { a: 'url(https://example.com/x)', b: '#fff', c: 'red', d: '#12345g', e: '#123456" onload="x', f: '#2a9d8f' };
  const svg = withDocument(() => grid(['abcdef'], pal));
  assert.deepEqual(fills(svg), ['#2a9d8f']);
});

test('a skin drawn with a bad colour keeps its other parts', () => {
  const skin = { pixels: ['aab', 'bba'], palette: { a: '#ff7a5c', b: 'javascript:alert(1)' }, parts: { a: 'body', b: 'shell' } };
  const svg = withDocument(() => build(skin, { ink: false })); // its line is test/sprite-ink.test.js's
  assert.deepEqual(fills(svg), ['#ff7a5c', '#ff7a5c']);
});
