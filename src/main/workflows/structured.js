// A Claude step that declares output fields gets them back as data. Claude is
// asked to end its reply with a fenced ```json block holding exactly those
// fields; the engine reads the last such block, checks each field's type, and
// asks once more in the same conversation if it's missing or wrong. This works
// inside an ordinary Shellby tab (permission prompts and all), which a
// one-shot --json-schema call can't.

const MAX_FIELD_TEXT = 20000;

const TYPE_WORDS = {
  string: 'text',
  number: 'a number',
  boolean: 'true or false',
  list: 'a JSON array',
  object: 'a JSON object',
};

/** The paragraph appended to a step's prompt. */
function instruction(fields) {
  const lines = Object.entries(fields).map(([name, f]) => `- "${name}": ${TYPE_WORDS[f.type]}${f.description ? `. ${f.description}` : ''}`);
  return [
    'When you have finished, end your reply with a fenced ```json code block holding one JSON object with exactly these keys:',
    ...lines,
    'Nothing after the code block.',
  ].join('\n');
}

/** The follow-up sent when the first reply didn't have them. */
function retryPrompt(fields, problem) {
  return `${problem} Reply with only a fenced \`\`\`json block holding one object with the keys ${Object.keys(fields).map(k => `"${k}"`).join(', ')}, using what you found.`;
}

// The last ```json (or bare ```) block whose body is a JSON object; failing
// that, the last {...} spanning to the end of the reply.
function extract(reply) {
  const text = String(reply ?? '');
  const blocks = [...text.matchAll(/```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/g)].map(m => m[1].trim());
  for (const b of blocks.reverse()) {
    try {
      const v = JSON.parse(b);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* try the next one */ }
  }
  const end = text.trimEnd();
  if (end.endsWith('}')) {
    for (let i = end.lastIndexOf('{'); i >= 0; i = end.lastIndexOf('{', i - 1)) {
      try {
        const v = JSON.parse(end.slice(i));
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      } catch { /* widen */ }
      if (i === 0) break;
    }
  }
  return null;
}

// Lenient where it's unambiguous ("3" is a number, "yes" is true), strict otherwise.
function coerce(value, type) {
  switch (type) {
    case 'string':
      if (typeof value === 'string') return { ok: true, value: value.slice(0, MAX_FIELD_TEXT) };
      if (typeof value === 'number' || typeof value === 'boolean') return { ok: true, value: String(value) };
      return { ok: false };
    case 'number': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    }
    case 'boolean':
      if (typeof value === 'boolean') return { ok: true, value };
      if (typeof value === 'string' && /^(true|yes)$/i.test(value.trim())) return { ok: true, value: true };
      if (typeof value === 'string' && /^(false|no)$/i.test(value.trim())) return { ok: true, value: false };
      return { ok: false };
    case 'list':
      return Array.isArray(value) ? { ok: true, value: value.slice(0, 500) } : { ok: false };
    case 'object':
      return value && typeof value === 'object' && !Array.isArray(value) ? { ok: true, value } : { ok: false };
    default:
      return { ok: false };
  }
}

/**
 * Claude's reply -> { ok, data } with every declared field present and of its
 * type, or { ok: false, problem } saying what was wrong (sent back to Claude).
 */
function read(reply, fields) {
  const obj = extract(reply);
  if (!obj) return { ok: false, problem: 'Your reply didn\'t end with the JSON block I need.' };
  const data = {};
  const wrong = [];
  for (const [name, f] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(obj, name)) { wrong.push(`"${name}" is missing`); continue; }
    const c = coerce(obj[name], f.type);
    if (!c.ok) wrong.push(`"${name}" should be ${TYPE_WORDS[f.type]}`);
    else data[name] = c.value;
  }
  if (wrong.length) return { ok: false, problem: `In the JSON block, ${wrong.join(' and ')}.` };
  return { ok: true, data };
}

module.exports = { instruction, retryPrompt, extract, read, coerce };
