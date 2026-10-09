// Draws him to a PNG the way the app does (shared/sprite.js build, ink and
// all), to look at while drawing skins, shells and accessories.
//
//   node scripts/crab-sheet.js skins                  every skin, in its own shell
//   node scripts/crab-sheet.js shells [--skin id]     each shell, worn
//   node scripts/crab-sheet.js <pack>... [--skin id]  each accessory in src/wardrobe/<pack>.json, worn
//   ...[--out file.png] [--scale 6] [--no-ink]
//
// Each tile has him on a dark and a light wallpaper (the desk can be either).
// Prints where the PNG went.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { canvas, argv } = require('./lib/png');
const { SHELLS } = require('../src/main/shells');

// Just enough DOM for sprite.js: elements with attributes and children.
function element(tag) {
  return {
    tag, attrs: {}, children: [], style: {}, dataset: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    append(...kids) { this.children.push(...kids); },
    appendChild(kid) { this.children.push(kid); return kid; },
  };
}
globalThis.document = { createElementNS: (_ns, tag) => element(tag) };
require('../src/renderer/shared/sprite');
const { build } = globalThis.ShellbySprite;

const { args, opt, flag } = argv();
const out = opt('--out', path.join(os.tmpdir(), 'crab-sheet.png'));
const scale = Number(opt('--scale', 6));
const skinId = opt('--skin', 'classic');
const ink = !flag('--no-ink');
if (!args.length) { console.error('Say what to draw: skins, shells or a pack name'); process.exit(1); }

const WARDROBE = path.join(__dirname, '..', 'src', 'wardrobe');
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const packFiles = fs.readdirSync(WARDROBE).filter(f => f.endsWith('.json'));
const SKINS = [
  ...fs.readdirSync(path.join(__dirname, '..', 'src', 'skins')).map(f => readJson(path.join(__dirname, '..', 'src', 'skins', f))),
  ...packFiles.flatMap(f => readJson(path.join(WARDROBE, f)).skins || []),
];
const skin = SKINS.find(s => s.id === skinId);
if (!skin) { console.error(`No skin ${skinId}`); process.exit(1); }

// What to draw: [label, skin, build options]
const tiles = [];
for (const what of args) {
  if (what === 'skins') for (const s of SKINS) tiles.push([s.id, s, {}]);
  else if (what === 'shells') for (const sh of SHELLS) tiles.push([sh.id, skin, { shell: sh }]);
  else {
    const file = path.join(WARDROBE, what.endsWith('.json') ? what : `${what}.json`);
    if (!fs.existsSync(file)) { console.error(`No pack ${what}`); process.exit(1); }
    for (const acc of readJson(file).accessories || []) tiles.push([acc.id, skin, { accessories: [acc] }]);
  }
}

// An SVG from build() as [x, y, colour] pixels, in paint order.
function pixelsOf(svg) {
  const px = [];
  (function walk(el) {
    if (el.tag === 'rect') for (let i = 0; i < Number(el.attrs.width); i++) px.push([Number(el.attrs.x) + i, Number(el.attrs.y), el.attrs.fill]);
    for (const c of el.children) walk(c);
  })(svg);
  return px;
}

const drawn = tiles.map(([label, s, o]) => {
  const svg = build(s, { ...o, fit: true, ink });
  const [x0, y0, w, h] = svg.attrs.viewBox.split(' ').map(Number);
  return { label, x0, y0, w, h, px: pixelsOf(svg) };
});
const CW = Math.max(...drawn.map(d => d.w)) + 2, CH = Math.max(...drawn.map(d => d.h)) + 2;
const cols = Math.max(1, Math.min(drawn.length, Math.floor(1800 / (CW * 2 * scale))));
const rows = Math.ceil(drawn.length / cols);
const sheet = canvas(cols * CW * 2 * scale, rows * CH * scale);
drawn.forEach((d, i) => {
  const tx = (i % cols) * CW * 2 * scale, ty = Math.floor(i / cols) * CH * scale;
  sheet.rect(tx + CW * scale, ty, CW * scale, CH * scale, '#c9d6e3'); // a light wallpaper beside the dark one
  for (const half of [0, 1]) {
    const ox = tx + half * CW * scale + ((CW - d.w) * scale >> 1), oy = ty + ((CH - d.h) * scale >> 1);
    for (const [x, y, c] of d.px) sheet.rect(ox + (x - d.x0) * scale, oy + (y - d.y0) * scale, scale, scale, c);
  }
});
sheet.save(out);
console.log(out);
console.log(drawn.map((d, i) => `${i + 1}. ${d.label}`).join('\n'));
