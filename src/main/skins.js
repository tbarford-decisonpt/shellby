// Skins are JSON pixel grids. Built-ins ship in src/skins; users can drop their
// own into %APPDATA%/Shellby/skins. Everything is validated before it reaches
// the renderer.
const fs = require('fs');
const path = require('path');

const BUILTIN_DIR = path.join(__dirname, '..', 'skins');
const PARTS = new Set(['shell', 'body', 'claw', 'eyes', 'stalks', 'legs', 'extra']);
const HEX = /^#[0-9a-f]{6}$/i;

function validate(skin, fallbackId) {
  const errors = [];
  if (!skin || typeof skin !== 'object') return { errors: ['not an object'] };
  const pixels = Array.isArray(skin.pixels) ? skin.pixels.filter(r => typeof r === 'string') : [];
  if (!pixels.length || pixels.length > 32) errors.push('pixels must be 1–32 rows of strings');
  if (pixels.some(r => r.length > 40)) errors.push('rows must be at most 40 characters');
  const palette = {};
  for (const [ch, color] of Object.entries(skin.palette || {})) {
    if (ch.length === 1 && HEX.test(color)) palette[ch] = color;
    else errors.push(`bad palette entry ${JSON.stringify(ch)}`);
  }
  const parts = {};
  for (const [ch, part] of Object.entries(skin.parts || {})) {
    if (ch.length === 1 && PARTS.has(part)) parts[ch] = part;
  }
  const id = String(skin.id || fallbackId || '').replace(/[^\w-]/g, '').slice(0, 40);
  if (!id) errors.push('missing id');
  if (errors.length) return { errors };
  return {
    skin: {
      id, pixels, palette, parts,
      name: String(skin.name || id).slice(0, 40),
      author: String(skin.author || 'unknown').slice(0, 40),
      description: String(skin.description || '').slice(0, 120),
    },
    errors: [],
  };
}

function loadDir(dir, source) {
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const { skin, errors } = validate(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), path.basename(f, '.json'));
      if (skin) out.push({ ...skin, source });
      else console.warn(`[shellby] skipped skin ${f}: ${errors.join('; ')}`);
    } catch (e) {
      console.warn(`[shellby] skipped skin ${f}: ${e.message}`);
    }
  }
  return out;
}

function loadSkins(userDir) {
  const byId = new Map();
  for (const s of loadDir(BUILTIN_DIR, 'builtin')) byId.set(s.id, s);
  for (const s of loadDir(userDir, 'user')) byId.set(s.id, s);
  return [...byId.values()];
}

module.exports = { loadSkins, validate, BUILTIN_DIR };
