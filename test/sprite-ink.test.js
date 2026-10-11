// His ink line (src/renderer/shared/sprite.js): each part and accessory gets a
// one-pixel line round it, in the colour it borders sunk almost to ink (like
// the Bugdex's portraits, bugdex/art.js inked), drawn inside its own group so
// it moves with it, and only where nothing else is drawn.
const { test } = require('node:test');
const assert = require('node:assert/strict');

function element(tag) {
  return {
    tag, attrs: {}, children: [], style: {}, dataset: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
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
const { build, grid } = globalThis.ShellbySprite;

const groupOf = (svg, cls) => svg.children.find(g => (g.attrs.class || '').split(' ').includes(cls));
const inkOf = g => g.children.find(c => c.attrs.class === 'ink');
// Every pixel an element draws, as "x,y" -> fill (rects are runs one pixel high).
function pixelsOf(el, out = new Map()) {
  if (el.tag === 'rect') for (let i = 0; i < Number(el.attrs.width); i++) out.set(`${Number(el.attrs.x) + i},${el.attrs.y}`, el.attrs.fill);
  for (const c of el.children || []) pixelsOf(c, out);
  return out;
}

const RED = '#ff7a5c';
const TEAL = '#3fb8a3';

test('a part gets a dark line of its own colour on every open side, inside its own group', () => {
  const svg = withDocument(() => build({ pixels: ['b'], palette: { b: RED }, parts: { b: 'body' } }));
  const body = groupOf(svg, 'part-body');
  const ink = inkOf(body);
  assert.ok(ink, 'the body has an ink group');
  assert.equal(body.children[0], ink, '...drawn first, under the body itself');
  const line = pixelsOf(ink);
  assert.deepEqual([...line.keys()].sort(), ['-1,0', '0,-1', '0,1', '1,0']);
  const [colour] = new Set(line.values());
  assert.match(colour, /^#[0-9a-f]{6}$/);
  assert.notEqual(colour, RED);
  const [r, g, b] = [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16));
  assert.ok(r > g && r > b && r < 0x70, `a deep red, not black or grey (${colour})`);
});

test('the line never covers another part', () => {
  const svg = withDocument(() => build({ pixels: ['sb'], palette: { s: TEAL, b: RED }, parts: { s: 'shell', b: 'body' } }));
  const shellInk = pixelsOf(inkOf(groupOf(svg, 'part-shell')));
  const bodyInk = pixelsOf(inkOf(groupOf(svg, 'part-body')));
  assert.ok(!shellInk.has('1,0'), 'the shell\'s line stops at his body');
  assert.ok(!bodyInk.has('0,0'), 'the body\'s line stops at his shell');
  assert.ok(shellInk.has('-1,0') && bodyInk.has('2,0'));
});

test('a one-pixel gap stays open, so his legs and eye stalks stay apart', () => {
  const svg = withDocument(() => build({ pixels: ['l.l', 'l..'], palette: { l: RED }, parts: { l: 'legs' } }));
  const ink = new Map([...pixelsOf(inkOf(groupOf(svg, 'part-legs-a'))), ...pixelsOf(inkOf(groupOf(svg, 'part-legs-b')) || element('g'))]);
  assert.ok(!ink.has('1,0'), 'the gap between two legs');
  assert.ok(ink.has('1,1'), 'an open corner is still lined');
});

test('accessories are lined too, round the outside of everything he wears', () => {
  const hat = { slot: 'hat', pixels: ['hh'], palette: { h: '#2b4a7a' }, pivot: [0, 1], anchor: 'head' };
  const svg = withDocument(() => build({ pixels: ['b'], palette: { b: RED }, parts: { b: 'body' }, anchors: { head: [0, 0] } }, { accessories: [hat] }));
  const acc = svg.children.find(g => (g.attrs.class || '').includes('acc-hat'));
  const line = pixelsOf(inkOf(acc));
  assert.ok(line.has('0,-2') && line.has('2,-1'), 'above and beside the hat');
  assert.ok(!line.has('0,0'), 'not over his body under it');
});

test('a colour that is not plain hex is never drawn, and lines nothing', () => {
  const svg = withDocument(() => build({ pixels: ['ab'], palette: { a: RED, b: 'url(x)' }, parts: { a: 'body', b: 'shell' } }));
  assert.equal(groupOf(svg, 'part-shell'), undefined);
  for (const fill of pixelsOf(svg).values()) assert.match(fill, /^#[0-9a-f]{6}$/i);
});

test('a shell he moved into is lined, and a sticker on it is lined only where it overhangs', () => {
  const skin = { pixels: ['ss', 'ss'], palette: { s: TEAL }, parts: { s: 'shell' } };
  const shell = { pixels: ['DD', 'DD'], palette: { D: '#b5793f' } };
  const sticker = { pixels: ['kk'], palette: { k: '#ffd23f' }, x: 1, y: 0 };
  const svg = withDocument(() => build(skin, { shell, stickers: [sticker] }));
  const [home, stuck] = svg.children.filter(g => (g.attrs.class || '').includes('part-shell'));
  const homeLine = pixelsOf(inkOf(home));
  assert.ok(homeLine.has('-1,0') && homeLine.has('0,2'), 'round the shell');
  assert.ok(![...homeLine.values()].some(c => c === TEAL), 'in the new shell\'s colours, not the skin\'s');
  const stuckLine = [...pixelsOf(inkOf(stuck)).keys()];
  assert.ok(stuckLine.includes('3,0'), 'where it hangs off the shell');
  const onShell = ([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1;
  assert.ok(!stuckLine.map(k => k.split(',').map(Number)).some(onShell), 'never over the shell itself');
});

test('two parts beside one gap both line it, so each keeps its line when the other moves', () => {
  // The body and claw both touch (1,1); the claw's line there stays when the body's is covered and vice versa.
  const svg = withDocument(() => build({ pixels: ['bc', '.c'], palette: { b: RED, c: '#ff9b7d' }, parts: { b: 'body', c: 'claw' } }));
  assert.ok(pixelsOf(inkOf(groupOf(svg, 'part-body'))).has('0,1'));
  assert.ok(pixelsOf(inkOf(groupOf(svg, 'part-claw'))).has('0,1'));
});

test('his line is the Bugdex portraits\' line', () => {
  const art = require('../src/main/bugdex/art');
  const { INK, INK_DEPTH } = globalThis.ShellbySprite;
  assert.equal(INK, art.INK);
  assert.equal(INK_DEPTH, art.INK_DEPTH);
  const portrait = art.inked({ pixels: ['a'], palette: { a: RED } });
  const lined = withDocument(() => grid(['a'], { a: RED }, { ink: true }));
  const fromPortrait = Object.values(portrait.palette).find(c => c !== RED);
  assert.ok([...pixelsOf(lined).values()].includes(fromPortrait), 'the same colour for the same edge');
});

test('ink: false draws no line', () => {
  const svg = withDocument(() => build({ pixels: ['b'], palette: { b: RED }, parts: { b: 'body' } }, { ink: false }));
  assert.equal(inkOf(groupOf(svg, 'part-body')), undefined);
});

test('a fitted frame takes the line in, so a picture of him never cuts it off', () => {
  const svg = withDocument(() => build({ pixels: ['b'], palette: { b: RED }, parts: { b: 'body' } }, { fit: true }));
  assert.equal(svg.attrs.viewBox, '-1 -1 3 3');
  const plain = withDocument(() => build({ pixels: ['b'], palette: { b: RED }, parts: { b: 'body' } }));
  assert.equal(plain.attrs.viewBox, '0 0 1 1', 'unfitted, the box is the crab alone, so he never shifts');
});

test('a lone grid is lined only when asked', () => {
  const plain = withDocument(() => grid(['a'], { a: RED }));
  assert.equal(pixelsOf(plain).size, 1);
  const inked = withDocument(() => grid(['a'], { a: RED }, { ink: true }));
  assert.equal(pixelsOf(inked).size, 5);
  assert.equal(inked.attrs.viewBox, '-1 -1 3 3');
});

test('his stalks run on behind his body, so lifting his eyes a pixel never shows a gap', () => {
  const skin = require('../src/skins/classic.json');
  const svg = withDocument(() => build(skin));
  const stalks = groupOf(svg, 'part-stalks');
  const roots = stalks.children.filter(c => c.attrs.class === 'stalk-root');
  const tops = new Set();
  skin.pixels.forEach((row, y) => [...row].forEach((ch, x) => {
    if (skin.parts[ch] === 'stalks' && skin.parts[(skin.pixels[y + 1] || '')[x]] === 'body') tops.add(`${x},${y + 1}`);
  }));
  assert.ok(tops.size > 0, 'the classic crab\'s stalks stand on his body');
  assert.deepEqual(new Set(roots.map(r => `${r.attrs.x},${r.attrs.y}`)), tops, 'a root under each stalk');
  for (const r of roots) {
    for (let i = 0; i < Number(r.attrs.height); i++) {
      assert.equal(skin.parts[skin.pixels[Number(r.attrs.y) + i][Number(r.attrs.x)]], 'body', 'only ever behind his body');
    }
  }
  assert.ok(svg.children.indexOf(stalks) < svg.children.indexOf(groupOf(svg, 'part-body')), 'drawn under the body');
});
