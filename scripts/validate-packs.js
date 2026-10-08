#!/usr/bin/env node
// Check every built-in wardrobe pack in src/wardrobe/ twice over:
//
//   1. the app's own loader (src/main/wardrobe/catalog.js), which is what
//      decides whether an item reaches the renderer at runtime, and
//   2. docs/addon.schema.json, the stricter contract the community gallery
//      applies to uploads — it rejects unknown fields instead of ignoring them.
//
// A pack has to pass both to be publishable. Usage: node scripts/validate-packs.js
const fs = require('fs');
const path = require('path');

const { validatePack, MAX_FILE_BYTES } = require('../src/main/wardrobe/catalog');
const { KNOWN_ACHIEVEMENTS } = require('../src/main/wardrobe/achievements');
const { KNOWN_SEASONS } = require('../src/main/wardrobe/seasons');

const ROOT = path.join(__dirname, '..');
const PACK_DIR = path.join(ROOT, 'src', 'wardrobe');
const SCHEMA = path.join(ROOT, 'docs', 'addon.schema.json');

// ---- a small JSON Schema (draft 2020-12) checker covering the keywords
// addon.schema.json actually uses. Returns a list of "path: problem" strings.
function checkSchema(value, schema, root, where = '') {
  const out = [];
  const at = p => (p ? p : '(root)');
  const fail = m => out.push(`${at(where)}: ${m}`);

  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], root);
    if (!target) return [`${at(where)}: unresolvable $ref ${schema.$ref}`];
    // Local overrides (e.g. a $ref plus a tighter prefixItems) win over the target.
    const { $ref: _ref, ...rest } = schema;
    return checkSchema(value, { ...target, ...rest }, root, where);
  }
  if (schema.oneOf) {
    const hits = schema.oneOf.filter(s => checkSchema(value, s, root, where).length === 0);
    if (hits.length !== 1) fail(`must match exactly one of ${schema.oneOf.length} alternatives (matched ${hits.length})`);
    return out;
  }
  if (schema.not && checkSchema(value, schema.not, root, where).length === 0) fail('must not match the forbidden schema');
  if (schema.const !== undefined && value !== schema.const) fail(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);

  const type = schema.type;
  const isArr = Array.isArray(value);
  const isObj = value !== null && typeof value === 'object' && !isArr;
  if (type === 'object' && !isObj) { fail('must be an object'); return out; }
  if (type === 'array' && !isArr) { fail('must be an array'); return out; }
  if (type === 'string' && typeof value !== 'string') { fail('must be a string'); return out; }
  if (type === 'integer' && !Number.isInteger(value)) { fail('must be an integer'); return out; }
  if (type === 'number' && typeof value !== 'number') { fail('must be a number'); return out; }

  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`${JSON.stringify(value)} does not match /${schema.pattern}/`);
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(`must be at most ${schema.maxLength} characters (is ${value.length})`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`must be <= ${schema.maximum}`);
  }
  if (isArr) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`needs at least ${schema.minItems} entries`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`allows at most ${schema.maxItems} entries (has ${value.length})`);
    const prefix = schema.prefixItems || [];
    value.forEach((v, i) => {
      if (i < prefix.length) out.push(...checkSchema(v, prefix[i], root, `${where}[${i}]`));
      else if (schema.items === false) fail(`has no schema for entry ${i} (extra items are not allowed)`);
      else if (schema.items) out.push(...checkSchema(v, schema.items, root, `${where}[${i}]`));
    });
  }
  if (isObj) {
    const keys = Object.keys(value);
    for (const k of schema.required || []) if (!keys.includes(k)) fail(`is missing required "${k}"`);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) fail(`needs at least ${schema.minProperties} properties`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) fail(`allows at most ${schema.maxProperties} properties (has ${keys.length})`);
    const props = schema.properties || {};
    for (const k of keys) {
      const sub = `${where}${where ? '.' : ''}${k}`;
      if (schema.propertyNames) out.push(...checkSchema(k, schema.propertyNames, root, `${sub} (key)`));
      if (props[k]) out.push(...checkSchema(value[k], props[k], root, sub));
      else if (schema.additionalProperties === false) fail(`has unknown field "${k}"`);
      else if (schema.additionalProperties) out.push(...checkSchema(value[k], schema.additionalProperties, root, sub));
    }
  }
  return out;
}

const known = { knownAchievements: KNOWN_ACHIEVEMENTS, knownSeasons: KNOWN_SEASONS, source: 'builtin' };

/**
 * Check every pack in src/wardrobe/. Returns one report per file:
 *   { file, name, counts, bytes, problems: string[] }
 * `problems` is empty when the pack passes both the loader and the schema.
 */
function checkPacks(dir = PACK_DIR) {
  const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  const ids = new Map();
  return files.map(f => {
    const file = path.join(dir, f);
    const bytes = fs.statSync(file).size;
    const problems = [];
    let json = null;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { problems.push(`invalid JSON: ${e.message}`); }

    let counts = { accessories: 0, effects: 0, skins: 0, voices: 0, scenes: 0, decor: 0 };
    let name = f;
    if (json) {
      name = json.name || f;
      if (bytes > MAX_FILE_BYTES) problems.push(`file is ${Math.round(bytes / 1024)} KB, over the ${MAX_FILE_BYTES / 1024} KB cap`);
      if (ids.has(json.id)) problems.push(`duplicate pack id ${json.id} (also in ${ids.get(json.id)})`);
      else ids.set(json.id, f);

      const { pack, errors, warnings } = validatePack(json, known);
      problems.push(...errors.map(e => `loader: ${e}`), ...warnings.map(w => `loader: ${w}`));
      problems.push(...checkSchema(json, schema, schema).map(e => `schema: ${e}`));
      if (pack) counts = { accessories: pack.accessories.length, effects: pack.effects.length, skins: pack.skins.length, voices: pack.voices.length, scenes: pack.scenes.length, decor: pack.decor.length };
    }
    return { file: f, name, counts, bytes, problems };
  });
}

function main() {
  const reports = checkPacks();
  const totals = { accessories: 0, effects: 0, skins: 0, voices: 0, scenes: 0, decor: 0 };
  let bad = 0;
  for (const r of reports) {
    for (const k of Object.keys(totals)) totals[k] += r.counts[k];
    const tally = `${r.counts.accessories}a ${r.counts.effects}e ${r.counts.skins}s ${r.counts.voices}v ${r.counts.scenes}sc ${r.counts.decor}d`;
    if (r.problems.length) {
      bad++;
      console.log(`✗ ${r.file}  (${tally}, ${Math.round(r.bytes / 1024)} KB)`);
      for (const p of r.problems) console.log(`    ${p}`);
    } else {
      console.log(`✓ ${r.file.padEnd(22)} ${tally.padEnd(20)} ${String(Math.round(r.bytes / 1024)).padStart(3)} KB  ${r.name}`);
    }
  }
  console.log(`
${reports.length} packs · ${totals.accessories} accessories · ${totals.effects} effects · ${totals.skins} skins · ${totals.voices} voices · ${totals.scenes} scenes · ${totals.decor} decor`);
  if (bad) { console.error(`${bad} pack(s) failed.`); process.exit(1); }
  console.log('All packs pass the app loader and docs/addon.schema.json.');
}

if (require.main === module) main();

module.exports = { checkPacks, checkSchema, PACK_DIR };
