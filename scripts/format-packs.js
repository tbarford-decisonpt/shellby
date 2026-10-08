#!/usr/bin/env node
// Rewrite the built-in packs in src/wardrobe/ in a house style: pivot and palette stay on one line,
// pixel rows stay one-per-line so the art is readable in a diff.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'wardrobe');
// Hand-maintained, not ours to reflow. voices.json keeps each occasion's lines on one line.
const SKIP = new Set(['base.pack.json', 'voices.json']);
const inline = new Set(['pivot', 'palette', 'parts', 'anchors', 'unlock']);

function fmt(value, indent, key) {
  const pad = '  '.repeat(indent);
  const inner = '  '.repeat(indent + 1);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (inline.has(key) || value.every(v => typeof v === 'number')) return `[${value.map(v => JSON.stringify(v)).join(', ')}]`;
    return `[\n${value.map(v => inner + fmt(v, indent + 1)).join(',\n')}\n${pad}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    const body = keys.map(k => `${JSON.stringify(k)}: ${fmt(value[k], indent + 1, k)}`);
    if (inline.has(key)) return `{ ${body.join(', ')} }`;
    return `{\n${body.map(b => inner + b).join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json') && !SKIP.has(n))) {
  const file = path.join(dir, f);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, fmt(json, 0) + '\n');
  console.log(`formatted ${f}`);
}
