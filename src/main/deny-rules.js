// Saying no to the same thing over and over: once a command (or folder, site,
// tool) has been denied DENY_RULE_REPEATS times, Shellby offers to make it a
// permission deny rule, so Claude Code stops asking. corrections.js notes the
// denials and offers the card; this file says what the rule is, which settings
// file it belongs in, and what writing it changes, shown before anything is.
//
// Which file: a no given in one project goes in that project's
// .claude/settings.local.json (yours, not committed); a no given in two or more
// projects goes in your own ~/.claude/settings.json, which covers them all.
// See test/deny-rules.test.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const claudeSetup = require('./claude/setup');

const DENY_RULE_REPEATS = 5;   // nos, each in a different turn, before the card
const KEEP_DAYS = 60;          // as corrections.js: older nos don't count
const DAY = 864e5;

const rootKey = r => String(r || '').replace(/[\\/]+$/, '').toLowerCase();
const occasion = e => e.batch || `${e.at}`;

/**
 * A deny event (corrections.denySubject's shape) -> the permission rule that
 * blocks it, or '' when there's no narrow one worth writing.
 */
function ruleFor(e) {
  if (!e || typeof e.tool !== 'string' || !e.tool) return '';
  const subject = String(e.label || e.subject || '').replace(/[()\n\r]/g, '').trim();
  if (e.what === 'command' && subject) return `${e.tool}(${subject}:*)`;
  if (e.what === 'folder' && subject) return `${e.tool}(${subject.replace(/\/?$/, '/')}**)`;
  if (e.what === 'file' && subject) return `${e.tool}(${subject})`;
  if (e.what === 'site' && subject) return `WebFetch(domain:${subject})`;
  // A whole tool: only one that isn't how Claude reads or edits anything.
  if (/^(Bash|PowerShell|Read|Edit|Write|MultiEdit|Glob|Grep)$/.test(e.tool)) return '';
  return e.tool;
}

/**
 * The nos for the same thing as `latest`, everywhere: { count, roots }.
 * count: different turns; roots: the projects they were in.
 */
function denials(events, latest, now = Date.now()) {
  if (!latest || latest.kind !== 'deny') return { count: 0, roots: [] };
  const same = events.filter(e => e.kind === 'deny' && e.tool === latest.tool && e.subject === latest.subject && now - e.at <= KEEP_DAYS * DAY);
  if (!same.includes(latest)) same.push(latest);
  const roots = new Map(same.map(e => [rootKey(e.root), e.root]));
  return { count: new Set(same.map(occasion)).size, roots: [...roots.values()] };
}

/** One project: its own local settings. More than one: the user's. */
const scopeFor = roots => (roots.length > 1 ? 'user' : 'local');

/** The pattern a deny completes once it's been said DENY_RULE_REPEATS times, or null. */
function detect(events, latest, now = Date.now()) {
  const { count, roots } = denials(events, latest, now);
  if (count < DENY_RULE_REPEATS) return null;
  const perm = ruleFor(latest);
  if (!perm) return null;
  const scope = scopeFor(roots);
  return {
    type: 'deny-rule', key: `deny-rule:${perm}`, tokens: [], count, quote: '', label: latest.label,
    what: latest.what, perm, scope, evidence: [],
  };
}

/** The settings file a scope means. */
function fileFor(scope, root, home = os.homedir()) {
  return scope === 'user'
    ? path.join(home, '.claude', 'settings.json')
    : path.join(root, '.claude', 'settings.local.json');
}

// ------------------------------------------------------------ the diff

/**
 * The permissions block before and after, as lines, with the changed middle
 * marked: '  ' same, '- ' gone, '+ ' new. Only that block: the rest of the
 * file isn't touched, so it isn't shown.
 */
function diffLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  return [
    ...a.slice(0, start).map(l => `  ${l}`),
    ...a.slice(start, endA).map(l => `- ${l}`),
    ...b.slice(start, endB).map(l => `+ ${l}`),
    ...a.slice(endA).map(l => `  ${l}`),
  ].join('\n');
}

const block = data => JSON.stringify({ permissions: data?.permissions ?? {} }, null, 2);

/**
 * Adding `rule` to `settings` (parsed) -> { ok, next, diff } or { ok: false, error }.
 * Pure: what the card shows is exactly what add() checks against.
 */
function plan(settings, rule) {
  const v = claudeSetup.validateRule('deny', rule);
  if (v.error) return { ok: false, error: v.error };
  const deny = settings?.permissions?.deny;
  if (Array.isArray(deny) && deny.includes(v.rule)) return { ok: false, error: 'That rule is already there.' };
  const next = claudeSetup.withRule(settings || {}, 'deny', v.rule);
  return { ok: true, rule: v.rule, next, diff: diffLines(block(settings), block(next)) };
}

function read(file) {
  const s = claudeSetup.readSettings(file);
  if (s.state === 'unreadable') return { ok: false, error: `Couldn't read ${path.basename(file)}, so Shellby left it alone.` };
  return { ok: true, data: s.data, exists: s.state === 'ok' };
}

/** What adding `rule` to `file` would change: { ok, file, exists, added (the diff), fresh } . */
function preview(file, rule) {
  const r = read(file);
  if (!r.ok) return r;
  const p = plan(r.data, rule);
  return p.ok ? { ok: true, file, exists: r.exists, added: p.diff, fresh: !r.exists } : p;
}

/**
 * Write it, but only if the change is still exactly `shown`. A file changed in
 * between: nothing written, and the new preview comes back to be shown.
 */
function add(file, rule, shown) {
  const r = read(file);
  if (!r.ok) return r;
  const p = plan(r.data, rule);
  if (!p.ok) return p;
  if (p.diff !== shown) return { ok: false, changed: true, error: 'The settings file changed since this was shown. Check what goes in now.', preview: { ok: true, file, exists: r.exists, added: p.diff, fresh: !r.exists } };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const w = claudeSetup.changeSettings(file, data => claudeSetup.withRule(data, 'deny', p.rule));
    return w.ok ? { ok: true, file, rule: p.rule } : w;
  } catch {
    return { ok: false, error: `Couldn't save ${path.basename(file)}.` };
  }
}

module.exports = { DENY_RULE_REPEATS, ruleFor, denials, scopeFor, detect, fileFor, diffLines, plan, preview, add };
