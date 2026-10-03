// Templates ({{ path | filter }}) and conditions (a.b == "x" and not c) for
// workflows. Hand-written tokenizer and parser, no eval and no regex built from
// user text: a workflow file is untrusted input, and so is everything a run
// reads back (a webhook body, a PR title, Claude's reply).

const MAX_TEMPLATE = 20000;
const MAX_SUBSTITUTIONS = 100;
const MAX_RENDERED = 200000;
const MAX_CONDITION = 1000;
const MAX_DEPTH = 32;

// Where a path may start. Anything else is read as a step id (`diagnose.cause`
// means `steps.diagnose.cause`).
const ROOTS = ['trigger', 'inputs', 'vars', 'steps', 'loop', 'run', 'now', 'today', 'secrets'];
const SEGMENT = /^[A-Za-z_][\w-]{0,63}$/;
const FILTERS = ['json', 'upper', 'lower', 'trim', 'length', 'first', 'last', 'join', 'default', 'lines', 'slice'];

// ---------------------------------------------------------------- paths

/** "a.b[2].c" -> ['a', 'b', 2, 'c'], or null if it isn't a path. */
function parsePath(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 300) return null;
  const out = [];
  for (const part of t.split('.')) {
    const m = /^([A-Za-z_][\w-]{0,63})((?:\[\d{1,4}\])*)$/.exec(part);
    if (!m) return null;
    out.push(m[1]);
    for (const idx of m[2].match(/\d+/g) || []) out.push(Number(idx));
  }
  return out;
}

const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

/** Value at a parsed path, or undefined. Only own properties: never a prototype. */
function lookup(ctx, segs) {
  if (!segs || !segs.length) return undefined;
  let cur;
  let rest;
  if (ROOTS.includes(segs[0]) || own(ctx, segs[0])) {
    cur = ctx[segs[0]];
    rest = segs.slice(1);
  } else {
    cur = ctx.steps?.[segs[0]];
    rest = segs.slice(1);
  }
  for (const s of rest) {
    if (typeof s === 'number') cur = Array.isArray(cur) ? cur[s] : undefined;
    else cur = own(cur, s) ? cur[s] : undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

function getPath(ctx, text) { return lookup(ctx, parsePath(text)); }

// ---------------------------------------------------------------- values

function toText(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return ''; }
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim() !== '' && v.trim().toLowerCase() !== 'false';
  return !!v;
}

const numeric = v => (typeof v === 'number' && Number.isFinite(v))
  || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));

// ---------------------------------------------------------------- filters

// A filter's arguments: "text", 'text' or numbers, space separated.
function parseArgs(text) {
  const args = [];
  let i = 0;
  const s = String(text);
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '"' || c === "'") {
      const end = s.indexOf(c, i + 1);
      if (end < 0) return null;
      args.push(s.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    const m = /^-?\d+(\.\d+)?/.exec(s.slice(i));
    if (!m) return null;
    args.push(Number(m[0]));
    i += m[0].length;
  }
  return args;
}

function applyFilter(value, name, args) {
  switch (name) {
    case 'json': return JSON.stringify(value ?? null, null, 2);
    case 'upper': return toText(value).toUpperCase();
    case 'lower': return toText(value).toLowerCase();
    case 'trim': return toText(value).trim();
    case 'length': return Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : toText(value).length;
    case 'first': return Array.isArray(value) ? value[0] : toText(value).slice(0, 1);
    case 'last': return Array.isArray(value) ? value[value.length - 1] : toText(value).slice(-1);
    case 'join': return Array.isArray(value) ? value.map(toText).join(args[0] === undefined ? ', ' : String(args[0])) : toText(value);
    case 'default': return value === undefined || value === null || value === '' ? args[0] ?? '' : value;
    case 'lines': return toText(value).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    case 'slice': {
      const a = Number.isInteger(args[0]) ? args[0] : 0;
      const b = Number.isInteger(args[1]) ? args[1] : undefined;
      return Array.isArray(value) ? value.slice(a, b) : toText(value).slice(a, b);
    }
    default: return value;
  }
}

// ---------------------------------------------------------------- templates

/**
 * "Hi {{ a.b | upper }}" -> parts: ['Hi ', { path, segs, filters }], or an error.
 * Parsed once and checked by schema.js, so a bad template is caught on save.
 */
function parseTemplate(text) {
  const s = String(text ?? '');
  if (s.length > MAX_TEMPLATE) return { ok: false, error: `Text is too long (over ${MAX_TEMPLATE} characters)` };
  const parts = [];
  let i = 0;
  let subs = 0;
  while (i < s.length) {
    const open = s.indexOf('{{', i);
    if (open < 0) { parts.push(s.slice(i)); break; }
    if (open > i) parts.push(s.slice(i, open));
    const close = s.indexOf('}}', open + 2);
    if (close < 0) return { ok: false, error: 'A {{ has no matching }}' };
    if (++subs > MAX_SUBSTITUTIONS) return { ok: false, error: `Too many {{ }} values (over ${MAX_SUBSTITUTIONS})` };
    const inner = s.slice(open + 2, close);
    const [head, ...pipes] = inner.split('|');
    const segs = parsePath(head);
    if (!segs) return { ok: false, error: `“${head.trim().slice(0, 40)}” isn't a value Shellby knows how to read` };
    const filters = [];
    for (const p of pipes) {
      const m = /^\s*([a-z]+)\s*([\s\S]*)$/.exec(p);
      if (!m || !FILTERS.includes(m[1])) return { ok: false, error: `Unknown filter “${p.trim().slice(0, 20)}”` };
      const args = parseArgs(m[2].trim());
      if (!args) return { ok: false, error: `The filter “${m[1]}” has arguments Shellby can't read` };
      filters.push({ name: m[1], args });
    }
    parts.push({ path: head.trim(), segs, filters });
    i = close + 2;
  }
  return { ok: true, parts };
}

const evalPart = (part, ctx) => part.filters.reduce((v, f) => applyFilter(v, f.name, f.args), lookup(ctx, part.segs));

/**
 * Template -> string. `quote(value, part)` formats each substitution (Claude
 * prompts wrap it «», commands make it a literal). Throws on a bad template:
 * callers validate first.
 */
function render(text, ctx, { quote = toText } = {}) {
  const parsed = parseTemplate(text);
  if (!parsed.ok) throw new Error(parsed.error);
  let out = '';
  for (const part of parsed.parts) {
    out += typeof part === 'string' ? part : quote(evalPart(part, ctx), part);
    if (out.length > MAX_RENDERED) return out.slice(0, MAX_RENDERED);
  }
  return out;
}

/**
 * A template that is nothing but one {{ value }} gives that value as it is (a
 * list stays a list, for `each` and `set`); anything else renders as text.
 */
function resolve(text, ctx) {
  const parsed = parseTemplate(text);
  if (!parsed.ok) throw new Error(parsed.error);
  const p = parsed.parts;
  if (p.length === 1 && typeof p[0] !== 'string') return evalPart(p[0], ctx);
  return render(text, ctx);
}

/** Every path a template reads, as segment arrays (for checks on save). */
function templateRefs(text) {
  const parsed = parseTemplate(text);
  return parsed.ok ? parsed.parts.filter(p => typeof p !== 'string').map(p => p.segs) : [];
}

const hasTemplate = text => typeof text === 'string' && text.includes('{{');

// ---------------------------------------------------------------- conditions

const KEYWORDS = { and: 'and', or: 'or', not: 'not', contains: 'op', true: 'lit', false: 'lit', null: 'lit' };
const OPS = ['==', '!=', '>=', '<=', '>', '<'];

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')') { toks.push({ t: c }); i++; continue; }
    const op = OPS.find(o => src.startsWith(o, i));
    if (op) { toks.push({ t: 'op', v: op }); i += op.length; continue; }
    if (c === '!' ) { toks.push({ t: 'not' }); i++; continue; }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new Error('A quote is never closed');
      toks.push({ t: 'lit', v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num && (c !== '-' || /\d/.test(src[i + 1] || ''))) { toks.push({ t: 'lit', v: Number(num[0]) }); i += num[0].length; continue; }
    const word = /^[A-Za-z_][\w.[\]-]*/.exec(src.slice(i));
    if (word) {
      const w = word[0];
      const kw = KEYWORDS[w.toLowerCase()];
      if (kw === 'lit') toks.push({ t: 'lit', v: { true: true, false: false, null: null }[w.toLowerCase()] });
      else if (kw === 'op') toks.push({ t: 'op', v: 'contains' });
      else if (kw) toks.push({ t: kw });
      else {
        const segs = parsePath(w);
        if (!segs) throw new Error(`“${w.slice(0, 40)}” isn't a value Shellby knows how to read`);
        toks.push({ t: 'path', v: segs, text: w });
      }
      i += w.length;
      continue;
    }
    throw new Error(`Unexpected “${c}”`);
  }
  return toks;
}

// or > and > not > comparison > primary
function parseCondition(text) {
  let src = String(text ?? '').trim();
  const wrapped = /^\{\{([\s\S]*)\}\}$/.exec(src);
  if (wrapped) src = wrapped[1].trim();
  if (!src) return { ok: false, error: 'The condition is empty' };
  if (src.length > MAX_CONDITION) return { ok: false, error: 'The condition is too long' };
  let toks;
  try { toks = tokenize(src); } catch (e) { return { ok: false, error: e.message }; }
  let pos = 0;
  let depth = 0;
  const peek = () => toks[pos];
  const take = t => (peek()?.t === t ? toks[pos++] : null);
  function or() {
    let left = and();
    while (take('or')) left = { k: 'or', a: left, b: and() };
    return left;
  }
  function and() {
    let left = not();
    while (take('and')) left = { k: 'and', a: left, b: not() };
    return left;
  }
  function not() {
    if (take('not')) return { k: 'not', a: not() };
    return cmp();
  }
  function cmp() {
    const left = primary();
    const op = peek()?.t === 'op' ? toks[pos++].v : null;
    return op ? { k: 'cmp', op, a: left, b: primary() } : left;
  }
  function primary() {
    const tok = toks[pos++];
    if (!tok) throw new Error('The condition stops too soon');
    if (tok.t === '(') {
      if (++depth > MAX_DEPTH) throw new Error('Too many brackets');
      const inner = or();
      depth--;
      if (!take(')')) throw new Error('A bracket is never closed');
      return inner;
    }
    if (tok.t === 'lit') return { k: 'lit', v: tok.v };
    if (tok.t === 'path') return { k: 'path', v: tok.v };
    throw new Error('The condition has something out of place');
  }
  try {
    const ast = or();
    if (pos !== toks.length) throw new Error('The condition has something out of place');
    return { ok: true, ast };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function compare(op, a, b) {
  if (op === 'contains') {
    if (Array.isArray(a)) return a.some(x => toText(x) === toText(b));
    return toText(a).toLowerCase().includes(toText(b).toLowerCase());
  }
  if (numeric(a) && numeric(b)) {
    const x = Number(a), y = Number(b);
    return { '==': x === y, '!=': x !== y, '>': x > y, '>=': x >= y, '<': x < y, '<=': x <= y }[op];
  }
  if (op === '==' || op === '!=') {
    const blank = v => v === null || v === undefined;
    const same = blank(a) || blank(b) ? blank(a) === blank(b)
      : typeof a === 'boolean' || typeof b === 'boolean' ? truthy(a) === truthy(b)
        : toText(a) === toText(b);
    return op === '==' ? same : !same;
  }
  const x = toText(a), y = toText(b);
  return { '>': x > y, '>=': x >= y, '<': x < y, '<=': x <= y }[op];
}

function evaluate(node, ctx) {
  switch (node.k) {
    case 'lit': return node.v;
    case 'path': return lookup(ctx, node.v);
    case 'not': return !truthy(evaluate(node.a, ctx));
    case 'and': return truthy(evaluate(node.a, ctx)) && truthy(evaluate(node.b, ctx));
    case 'or': return truthy(evaluate(node.a, ctx)) || truthy(evaluate(node.b, ctx));
    case 'cmp': return compare(node.op, evaluate(node.a, ctx), evaluate(node.b, ctx));
    default: return false;
  }
}

/** Condition text -> boolean. Throws on a condition that doesn't parse. */
function test(text, ctx) {
  const parsed = parseCondition(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return truthy(evaluate(parsed.ast, ctx));
}

/** Every path a condition reads, as segment arrays. */
function conditionRefs(text) {
  const parsed = parseCondition(text);
  if (!parsed.ok) return [];
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (n.k === 'path') out.push(n.v);
    walk(n.a); walk(n.b);
  })(parsed.ast);
  return out;
}

// ---------------------------------------------------------------- quoting

// For a Claude prompt: the value is clearly data. «» can't be closed early by
// the value itself, since any » inside it is replaced.
const quoteForClaude = v => `«${toText(v).replace(/[«»]/g, '"')}»`;

// For a PowerShell command: a single-quoted literal, where nothing is special
// except the quote itself, which is doubled. The typographic single quotes are
// also quote characters to PowerShell, so they're doubled too.
const quoteForPowerShell = v => `'${toText(v).replace(/[\u0000]/g, '').replace(/['‘’‚‛]/g, q => q + q)}'`;

// ---------------------------------------------------------------- commands

const MAX_ENV_VALUE = 30000;     // Windows allows 32,767 characters per variable
const ENV_PREFIX = 'SHELLBY_VALUE_';

/**
 * A command template for PowerShell, the way a database takes parameters: no
 * value is ever written into the command. Each {{ }} becomes $env:SHELLBY_VALUE_n
 * and its text goes in through the environment, so PowerShell reads it as one
 * string and never as code, whether it stands alone or sits inside "...".
 * (Inside '...' a variable isn't expanded; schema.js refuses that placement.)
 *   -> { command, env: { SHELLBY_VALUE_1: text, ... } }
 */
function renderPowerShell(text, ctx) {
  const parsed = parseTemplate(text);
  if (!parsed.ok) throw new Error(parsed.error);
  const env = {};
  let n = 0;
  let command = '';
  for (const part of parsed.parts) {
    if (typeof part === 'string') { command += part; continue; }
    const name = `${ENV_PREFIX}${++n}`;
    env[name] = toText(evalPart(part, ctx)).replace(/\u0000/g, '').slice(0, MAX_ENV_VALUE);
    // Braced, so text straight after it ("{{ x }}.txt") isn't read as part of the name.
    command += `\${env:${name}}`;
  }
  return { command, env };
}

/**
 * Is any {{ }} inside a single-quoted PowerShell string, where it would stay
 * as the literal text "$env:..."? A lint for the editor only: getting this
 * wrong costs a confusing message, never safety (the value is never in the command).
 */
function valuesInSingleQuotes(text) {
  const parsed = parseTemplate(text);
  if (!parsed.ok) return false;
  let single = false, double = false;
  for (const part of parsed.parts) {
    if (typeof part !== 'string') { if (single) return true; continue; }
    for (let i = 0; i < part.length; i++) {
      const c = part[i];
      if (single) { if ("'‘’‚‛".includes(c)) { if ("'‘’‚‛".includes(part[i + 1] || '')) i++; else single = false; } continue; }
      if (c === '`') { i++; continue; }
      if (double) { if ('"“”„'.includes(c)) double = false; continue; }
      if (c === '#') { const nl = part.indexOf('\n', i); i = nl < 0 ? part.length : nl; continue; }
      if ("'‘’‚‛".includes(c)) single = true;
      else if ('"“”„'.includes(c)) double = true;
    }
  }
  return false;
}

module.exports = {
  renderPowerShell, valuesInSingleQuotes,
  ROOTS, FILTERS, SEGMENT,
  parsePath, getPath, lookup, toText, truthy,
  parseTemplate, render, resolve, templateRefs, hasTemplate,
  parseCondition, evaluate, test, conditionRefs,
  quoteForClaude, quoteForPowerShell,
};
