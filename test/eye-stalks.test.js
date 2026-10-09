// His eyes sit on their stalks (src/renderer/critter/*.css). Idle, working and
// walking, the stalks glance about with the eyes on a loop of their own, so a
// pose that takes the eyes' animation over (a squint, a yawn, wide eyes) has to
// take the stalks' too, or the stalks glance off on their own and the eyes float
// beside them. Wherever a pose shifts his eyes, it shifts the stalks the same.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
const SHEETS = [
  ...fs.readdirSync(path.join(ROOT, 'critter')).filter(f => f.endsWith('.css')).map(f => path.join('critter', f)),
  path.join('floor', 'floor.css'),
];

// Every rule and keyframes block in the sheets, comments out.
function parse() {
  const rules = [], keyframes = {};
  const KEYFRAMES = /@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g;
  for (const sheet of SHEETS) {
    const css = fs.readFileSync(path.join(ROOT, sheet), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(KEYFRAMES)) keyframes[m[1]] = [...m[2].matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(f => [f[1].trim(), f[2]]);
    for (const m of css.replace(KEYFRAMES, '').matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      for (const sel of m[1].split(',')) rules.push({ sheet, sel: sel.trim(), body: m[2] });
    }
  }
  return { rules, keyframes };
}

const decl = (body, prop) => (body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+)`)) || [])[1]?.trim();
// Only where a part is moved to, as "x,y": its squash and stretch are its own.
function shifts(transform) {
  let x = 0, y = 0;
  for (const [, fn, args] of (transform || '').matchAll(/translate([XY]?)\(([^)]*)\)/g)) {
    const [a, b = '0'] = args.split(',').map(s => parseFloat(s) || 0);
    if (fn === 'X') x += a; else if (fn === 'Y') y += a; else { x += a; y += Number(b); }
  }
  return x || y ? `${x},${y}` : '';
}
// Where a rule puts a part, step by step (his eye loops all step), with the
// steps that don't move it from the one before left out. Held still, it stays
// where its own transform puts it.
function track(rule, keyframes) {
  const name = decl(rule.body, 'animation').split(/\s+/)[0];
  if (name === 'none') { const s = shifts(decl(rule.body, 'transform')); return s ? [`0%: ${s}`] : []; }
  const steps = (keyframes[name] || []).flatMap(([at, body]) => at.split(',').map(p => [parseFloat(p), shifts(decl(body, 'transform'))]));
  return steps.sort((a, b) => a[0] - b[0])
    .filter(([, s], i) => s !== (i ? steps[i - 1][1] : ''))
    .map(([at, s]) => `${at}%: ${s || 'home'}`);
}

// "<pose> .part-eyes" -> the eyes' and the stalks' rule for that pose.
function poses() {
  const { rules, keyframes } = parse();
  const byPose = new Map();
  for (const r of rules) {
    const m = r.sel.match(/^(.*\S)\s+\.part-(eyes|stalks)$/);
    if (!m) continue;
    if (!byPose.has(m[1])) byPose.set(m[1], {});
    byPose.get(m[1])[m[2]] = r;
  }
  return { byPose, keyframes };
}

test('a pose that takes over his eyes\' animation holds his stalks to it too', () => {
  const { byPose, keyframes } = poses();
  const loose = [];
  for (const [pose, { eyes, stalks }] of byPose) {
    const animation = eyes && decl(eyes.body, 'animation');
    if (!animation) continue;
    const name = animation.split(/\s+/)[0];
    const stalksAnimation = stalks && decl(stalks.body, 'animation');
    if (!stalksAnimation) { loose.push(`${eyes.sheet}: ${pose} (eyes ${name}, stalks left glancing)`); continue; }
    const eyeTrack = track(eyes, keyframes), stalkTrack = track(stalks, keyframes);
    if (eyeTrack.join() !== stalkTrack.join()) loose.push(`${eyes.sheet}: ${pose} (eyes go ${eyeTrack.join(', ') || 'nowhere'}, stalks ${stalkTrack.join(', ') || 'nowhere'})`);
  }
  assert.deepEqual(loose, []);
});

test('a pose that shifts his eyes shifts his stalks the same', () => {
  const { byPose } = poses();
  const loose = [];
  for (const [pose, { eyes, stalks }] of byPose) {
    if (!eyes) continue;
    // A running animation sets his transform itself (the test above).
    const animated = (decl(eyes.body, 'animation') || 'none') !== 'none';
    const eyeShift = animated ? '' : shifts(decl(eyes.body, 'transform')), eyeTranslate = decl(eyes.body, 'translate');
    if (eyeShift && shifts(stalks && decl(stalks.body, 'transform')) !== eyeShift) loose.push(`${eyes.sheet}: ${pose} (transform ${eyeShift})`);
    if (eyeTranslate && (stalks && decl(stalks.body, 'translate')) !== eyeTranslate) loose.push(`${eyes.sheet}: ${pose} (translate ${eyeTranslate})`);
  }
  assert.deepEqual(loose, []);
});
