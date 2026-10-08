// The rules Shellby learned from your corrections (corrections.js), as they
// sit in a project's CLAUDE.md: one bullet each under their own heading, at
// the end of the file. The text half is pure (what gets appended, edited or
// removed); the file half reads and writes through claude-setup's memory
// helpers, so a symlinked CLAUDE.md, a BOM, Windows line endings and a change
// made on disk in the meantime are all handled the way Toolbox → Memory does.
// Nothing is written unless the panel was shown exactly what goes in.
// See test/learned-rules.test.js.
const fs = require('fs');
const path = require('path');
const claudeSetup = require('./claude/setup');
const { cleanRule } = require('./corrections');

const HEADING = '## Learned from your corrections';
// Only top-level bullets are rules; an indented one is a note under the rule above it.
const BULLET = /^[-*]\s+(.*\S)\s*$/;
const isHeading = line => /^#{1,2}\s/.test(line);
const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// ------------------------------------------------------------ the text

/** Where the section is: { at, end } (line indexes, end exclusive), or null. */
function section(lines) {
  const at = lines.findIndex(l => same(l, HEADING));
  if (at < 0) return null;
  let end = at + 1;
  while (end < lines.length && !isHeading(lines[end])) end++;
  return { at, end };
}

/** The learned rules in a CLAUDE.md, in order. */
function rulesIn(md) {
  const lines = String(md || '').split('\n');
  const s = section(lines);
  if (!s) return [];
  return lines.slice(s.at + 1, s.end).map(l => BULLET.exec(l)?.[1]).filter(Boolean);
}

/**
 * Adding a rule -> { ok, text, added, fresh } or { ok: false, error }.
 * added: exactly the characters that go in (what the card shows). fresh: the
 * heading is new too, so it all goes at the end of the file.
 */
function appendPlan(md, rule) {
  const r = cleanRule(rule);
  if (!r) return { ok: false, error: 'Write the rule on one line, in under 300 characters.' };
  const text = String(md || '');
  if (rulesIn(text).some(x => same(x, r))) return { ok: false, error: 'That rule is already in CLAUDE.md.' };
  const lines = text.split('\n');
  const s = section(lines);
  if (!s) {
    const gap = !text ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    const added = `${gap}${HEADING}\n\n- ${r}\n`;
    return { ok: true, text: text + added, added, fresh: true };
  }
  // After the last rule already there (or under the heading, with a blank line).
  let last = s.at;
  for (let i = s.at + 1; i < s.end; i++) if (BULLET.test(lines[i])) last = i;
  const insert = last === s.at ? ['', `- ${r}`] : [`- ${r}`];
  // A heading with nothing after it, at the very end of the file, still ends on a newline.
  const next = [...lines.slice(0, last + 1), ...insert, ...lines.slice(last + 1)];
  const out = next.join('\n');
  return { ok: true, text: out.endsWith('\n') ? out : `${out}\n`, added: `- ${r}\n`, fresh: false };
}

/**
 * The rule at `index` changed to `text` (already clean), or removed when text
 * is null. Everything else in the file stays exactly as it was, other rules and
 * any note written into the section included. The last rule out takes the
 * heading with it, and the file ends as it did before the section was added.
 */
function editRule(md, index, text) {
  const lines = String(md || '').split('\n');
  const s = section(lines);
  if (!s) return String(md || '');
  const at = [];
  for (let i = s.at + 1; i < s.end; i++) if (BULLET.test(lines[i])) at.push(i);
  if (!Number.isInteger(index) || index < 0 || index >= at.length) return String(md || '');
  if (text != null) return lines.map((l, i) => (i === at[index] ? `- ${text}` : l)).join('\n');
  const next = lines.filter((_, i) => i !== at[index]);
  const end = s.end - 1;
  if (next.slice(s.at + 1, end).some(l => l.trim())) return next.join('\n');
  // Nothing left in the section: it goes, heading and all.
  const before = next.slice(0, s.at);
  while (before.length && !before[before.length - 1].trim()) before.pop();
  const after = next.slice(end);
  const head = before.join('\n');
  if (!after.some(l => l.trim())) return head ? `${head}\n` : '';
  return `${head ? `${head}\n\n` : ''}${after.join('\n')}`;
}

// ------------------------------------------------------------ the file

/** The project's CLAUDE.md: the root one, or .claude/CLAUDE.md when only that exists. */
function fileFor(root) {
  const top = path.join(root, 'CLAUDE.md');
  const inner = path.join(root, '.claude', 'CLAUDE.md');
  if (!fs.existsSync(top) && fs.existsSync(inner)) return inner;
  return top;
}

function readFor(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !fs.existsSync(root)) return { ok: false, error: "That project's folder isn't there any more." };
  const file = fileFor(root);
  const r = claudeSetup.readMemory(file);
  return r.ok ? { ...r, file, exists: r.mtimeMs !== 0 } : r;
}

/** What adding `rule` would write, for the card to show: { ok, file, exists, added, fresh } or { ok: false, error }. */
function preview(root, rule) {
  const r = readFor(root);
  if (!r.ok) return r;
  const plan = appendPlan(r.text, rule);
  return plan.ok ? { ok: true, file: r.file, exists: r.exists, added: plan.added, fresh: plan.fresh } : plan;
}

const write = (r, text) => {
  try { return claudeSetup.writeMemory(r.file, text, r.mtimeMs); } catch { return { ok: false, error: "Couldn't save CLAUDE.md." }; }
};

/**
 * Add `rule`, but only if what goes in is still exactly `shown` (the preview the
 * card showed). If CLAUDE.md changed so that it isn't, nothing is written and
 * the new preview comes back to be shown instead.
 */
function add(root, rule, shown) {
  const r = readFor(root);
  if (!r.ok) return r;
  const plan = appendPlan(r.text, rule);
  if (!plan.ok) return plan;
  if (plan.added !== shown) return { ok: false, changed: true, error: 'CLAUDE.md changed since this was shown. Check what goes in now.', preview: { ok: true, file: r.file, exists: r.exists, added: plan.added, fresh: plan.fresh } };
  const w = write(r, plan.text);
  return w.ok ? { ok: true, file: r.file, rule: cleanRule(rule) } : w;
}

/** The learned rules in a project: { ok, file, exists, rules } . */
function list(root) {
  const r = readFor(root);
  return r.ok ? { ok: true, file: r.file, exists: r.exists, rules: rulesIn(r.text) } : r;
}

/**
 * Change or remove the rule at `index`, which must still read `was` (the list
 * the panel showed). text: the new wording, or null to remove it.
 */
function change(root, index, was, text) {
  const r = readFor(root);
  if (!r.ok) return r;
  const rules = rulesIn(r.text);
  if (!Number.isInteger(index) || rules[index] !== was) return { ok: false, error: 'CLAUDE.md changed since this list was made. Have another look.' };
  let t = null;
  if (text != null) {
    t = cleanRule(text);
    if (!t) return { ok: false, error: 'Write the rule on one line, in under 300 characters.' };
    if (rules.some((x, i) => i !== index && same(x, t))) return { ok: false, error: 'That rule is already in CLAUDE.md.' };
  }
  const out = editRule(r.text, index, t);
  const w = write(r, out);
  return w.ok ? { ok: true, file: r.file, rules: rulesIn(out) } : w;
}

module.exports = { HEADING, rulesIn, appendPlan, editRule, fileFor, preview, add, list, change };
