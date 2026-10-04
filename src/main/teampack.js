// Team packs: a repository's own Shellby setup, committed as .shellby/team.json,
// so a teammate who opens the repo in Shellby gets the same snippets, workflows,
// hooks and permission rules straight away.
//
// Community packs (registry.js) are public and cosmetic; a team pack is private
// to whoever can clone the repo, and it's about work. That makes it content from
// a repository, which might be anyone's: nothing in it runs or loads on its own.
//   Snippets   live, read from the file each time, once you've said "use them"
//              for that repo. A change to them waits for another yes. Your own
//              snippet of the same name always wins.
//   Workflows  copied into yours through the workflow service's Save, which
//              always shows the confirm window for anything that isn't the
//              panel's own (and signs the approval as usual).
//   Hooks and  suggestions you add, one at a time, through the same confirm
//   rules      windows as Toolbox → Hooks and Rules, to your own settings for
//              that project ("just me, here") or everywhere. A hook the whole
//              team must run belongs in .claude/settings.json, which Claude Code
//              already shares through the repo.
//
// Workflows keep full paths; the repo's own folder is written as {repo}, so the
// same file works in everyone's clone.
//
// Pure (no Electron): fs is only touched through the injected `exists`.
const crypto = require('crypto');
const path = require('path');
const snippets = require('./snippets');
const claudeSetup = require('./claude-setup');
const { lineSecret } = require('./secretscan');

const KIND = 'shellby-team-pack';
const VERSION = 1;
const DIR = '.shellby';
const FILE = 'team.json';
const REPO = '{repo}';
const MAX_BYTES = 512 * 1024;
const MAX_DEPTH = 40;
const LIMITS = { snippets: 50, workflows: 20, hooks: 20, rules: 50 };
const MAX_NAME = 60;
const MAX_ABOUT = 300;
const MAX_HOOK_ABOUT = 200;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const oneLine = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

// ------------------------------------------------------------ finding it

/**
 * The repository a folder is in, and its team pack if it has one: the nearest
 * folder above (or at) `cwd` with a .git, and .shellby/team.json there (only
 * there: a vendored folder's own pack isn't the repo's). Never the home folder
 * or a drive's root, which aren't a project. `exists` mustn't follow links
 * (team-ipc.js uses lstat), so a linked pack is never touched.
 *   { root, file, hasPack } | null
 */
function locate(cwd, { home, exists }) {
  if (typeof cwd !== 'string' || !cwd) return null;
  let dir = path.resolve(cwd);
  const stop = home ? path.resolve(home).toLowerCase() : null;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const parent = path.dirname(dir);
    if (parent === dir || dir.toLowerCase() === stop) return null;
    if (exists(path.join(dir, '.git'))) {
      const file = path.join(dir, DIR, FILE);
      return { root: dir, file, hasPack: exists(file) };
    }
    dir = parent;
  }
  return null;
}

// ------------------------------------------------------------ reading it

/** Same value, same hash: object keys in order, so a reformatted file isn't a change. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const hashOf = v => crypto.createHash('sha256').update(canonical(v)).digest('hex');

/** A hook as the pack has it: { event, matcher, command, timeout?, about? } | { error } */
function checkHook(input) {
  const v = claudeSetup.validateHook(input);
  if (v.error) return v;
  const hook = { event: v.hook.event, matcher: v.hook.matcher || '', command: v.hook.command };
  if (Number.isFinite(v.hook.timeout)) hook.timeout = v.hook.timeout;
  const about = oneLine(input?.about, MAX_HOOK_ABOUT);
  if (about) hook.about = about;
  return { hook };
}

// Workflows are checked properly when one is added (the workflow service);
// here, only enough to list it.
function checkWorkflow(input) {
  if (!isObj(input)) return { error: "isn't a workflow" };
  const name = oneLine(input.name, 80);
  if (!name) return { error: 'has no name' };
  if (!Array.isArray(input.steps) || !input.steps.length) return { error: `"${name}" has no steps` };
  const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = input;
  return { workflow: { ...rest, name } };
}

/**
 * The file's text -> { ok: true, pack, problems } | { ok: false, error }.
 * A part that doesn't fit is left out and said so (problems), never fatal: one
 * bad snippet shouldn't cost the team the rest.
 */
function parse(text) {
  if (typeof text !== 'string') return { ok: false, error: "The team pack couldn't be read." };
  if (Buffer.byteLength(text) > MAX_BYTES) return { ok: false, error: `The team pack is too big (over ${MAX_BYTES / 1024} KB).` };
  let data;
  try { data = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { return { ok: false, error: `The team pack isn't valid JSON: ${String(e.message).slice(0, 120)}` }; }
  if (!isObj(data) || data.kind !== KIND) return { ok: false, error: `That file isn't a Shellby team pack (it needs "kind": "${KIND}").` };
  if (data.version !== VERSION) return { ok: false, error: 'The team pack was made by a newer Shellby. Update Shellby to use it.' };

  const problems = [];
  const take = (key, keyOf) => {
    const raw = data[key];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) { problems.push(`"${key}" should be a list.`); return []; }
    if (raw.length > LIMITS[key]) problems.push(`Only the first ${LIMITS[key]} ${key} are used.`);
    const out = [];
    const seen = new Set();
    raw.slice(0, LIMITS[key]).forEach((item, i) => {
      const r = CHECK[key](item);
      if (r.error) { problems.push(`${key} #${i + 1}: ${r.error}`); return; }
      const k = keyOf(r.value);
      if (seen.has(k)) { problems.push(`${key} #${i + 1} is there twice.`); return; }
      seen.add(k);
      out.push(r.value);
    });
    return out;
  };

  const pack = {
    name: oneLine(data.name, MAX_NAME),
    about: oneLine(data.about, MAX_ABOUT),
    snippets: take('snippets', s => s.name),
    workflows: take('workflows', w => w.name.toLowerCase()),
    hooks: take('hooks', hookKey),
    rules: take('rules', ruleKey),
  };
  return { ok: true, pack, problems };
}

// Each part of a pack, checked: { value } | { error }.
const CHECK = {
  snippets(s) {
    if (isObj(s) && snippets.RESERVED.has(snippets.normalizeName(s.name))) return { error: `/${snippets.normalizeName(s.name)} is one of Shellby's own commands` };
    const r = snippets.check(s);
    return r.ok ? { value: r.snippet } : { error: r.error };
  },
  workflows: w => { const r = checkWorkflow(w); return r.error ? r : { value: r.workflow }; },
  hooks: h => { const r = checkHook(h); return r.error ? r : { value: r.hook }; },
  rules(r) {
    const v = isObj(r) ? claudeSetup.validateRule(r.list, r.rule) : { error: "isn't a rule" };
    return v.error ? v : { value: { list: v.list, rule: v.rule } };
  },
};

// ------------------------------------------------------------ paths: {repo}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every string in a value, changed by fn. */
function mapStrings(v, fn) {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map(x => mapStrings(x, fn));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]));
  return v;
}

/** {repo} -> this clone's folder, in every string of a workflow. */
function localize(workflow, root) {
  return mapStrings(workflow, s => s.split(REPO).join(root));
}

/**
 * A saved workflow, ready for the pack: no id, dates or hook tokens, and the
 * repo's folder written as {repo} (either slash, any case: it's Windows).
 * `outside` lists other full paths in it, which teammates won't have.
 */
function portable(workflow, root) {
  const { id: _i, createdAt: _c, updatedAt: _u, needsApproval: _n, enabled: _e, ...rest } = workflow;
  const r = path.resolve(root).replace(/[\\/]+$/, '');
  const pattern = new RegExp(`${r.split(/[\\/]/).map(escapeRe).join('[\\\\/]')}(?=$|[\\\\/])`, 'gi');
  const outside = new Set();
  const out = mapStrings(rest, (s) => {
    const swapped = s.replace(pattern, REPO);
    for (const m of swapped.matchAll(/\b[a-z]:[\\/][^\s"'<>|]*/gi)) outside.add(m[0]);
    return swapped;
  });
  out.when = (out.when || []).map(t => (t.type === 'webhook' ? { type: 'webhook' } : t));
  return { workflow: out, outside: [...outside] };
}

// ------------------------------------------------------------ what's here, and what you have

const hookKey = h => `${h.event}\n${h.matcher || ''}\n${h.command}`;
const ruleKey = r => `${r.list}\n${r.rule}`;

/**
 * The pack's snippets that are on for you: trusted (the yes was for exactly
 * these) and not one of your own names. Marked team: true.
 */
function liveSnippets(pack, own, trustedHash) {
  if (!pack || !pack.snippets.length || trustedHash !== hashOf(pack.snippets)) return [];
  const mine = new Set(own.map(s => s.name));
  return pack.snippets.filter(s => !mine.has(s.name)).map(s => ({ ...s, team: true }));
}

/**
 * Everything the Team tab shows: each part of the pack, and whether you have it.
 * have: { snippets: own list, trusted: hash or null,
 *   workflows: [{ name, same: bool }] (same: matches the pack's, as Shellby would save it),
 *   hooks: [{ event, matcher, command, source }], rules: [{ scope, list, rule }] }
 */
function status(pack, have) {
  const snipHash = hashOf(pack.snippets);
  const trusted = have.trusted === snipHash;
  const mine = new Set(have.snippets.map(s => s.name));
  const hookAt = new Map(have.hooks.map(h => [hookKey(h), h.source]));
  const ruleAt = new Map(have.rules.map(r => [ruleKey(r), r.scope]));
  const wfs = new Map(have.workflows.map(w => [w.name.toLowerCase(), w]));

  const view = {
    name: pack.name, about: pack.about,
    snippets: {
      hash: snipHash,
      state: !pack.snippets.length ? 'none' : trusted ? 'on' : have.trusted ? 'changed' : 'off',
      list: pack.snippets.map(s => ({ ...s, summary: snippets.summary(s), yours: mine.has(s.name) })),
    },
    workflows: pack.workflows.map((w) => {
      const got = wfs.get(w.name.toLowerCase());
      return { name: w.name, description: oneLine(w.description, 200), steps: w.steps.length, state: !got ? 'new' : got.same ? 'added' : 'different' };
    }),
    hooks: pack.hooks.map(h => ({ ...h, key: hookKey(h), describe: describeHook(h), state: hookAt.has(hookKey(h)) ? 'added' : 'new', where: hookAt.get(hookKey(h)) || null })),
    rules: pack.rules.map(r => ({ ...r, key: ruleKey(r), state: ruleAt.has(ruleKey(r)) ? 'added' : 'new', where: ruleAt.get(ruleKey(r)) || null })),
  };
  view.waiting = (view.snippets.state === 'off' || view.snippets.state === 'changed' ? 1 : 0)
    + view.workflows.filter(w => w.state !== 'added').length
    + view.hooks.filter(h => h.state === 'new').length
    + view.rules.filter(r => r.state === 'new').length;
  return view;
}

function describeHook(h) {
  const when = claudeSetup.HOOK_EVENTS.find(e => e.name === h.event)?.when || `on ${h.event}`;
  return `Runs ${when}${h.matcher ? ` (matching ${h.matcher})` : ''}`;
}

/** "4 snippets, 2 workflows and a hook": for the notice. */
function contents(pack) {
  const parts = [['snippet', pack.snippets.length], ['workflow', pack.workflows.length], ['hook', pack.hooks.length], ['rule', pack.rules.length]]
    .filter(([, n]) => n)
    .map(([w, n]) => (n === 1 ? `a ${w}` : `${n} ${w}s`));
  if (!parts.length) return 'nothing yet';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// ------------------------------------------------------------ writing it

/**
 * The file for what you picked. Refuses anything that looks like it carries a
 * secret: the file is meant to be committed.
 *   picked: { name, about, snippets: [snippet], workflows: [saved workflow], hooks: [hook], rules: [{ list, rule }] }
 *   -> { ok: true, text, notes: [string] } | { ok: false, error }
 */
function build(picked, root) {
  const notes = [];
  const secretIn = (what, value) => {
    let kind = null;
    mapStrings(value, (s) => {
      for (const line of s.split('\n')) kind = kind || lineSecret(line);
      return s;
    });
    return kind ? `${what} looks like it has a secret in it (${kind}). Take it out before sharing it with the team.` : null;
  };

  const snips = [];
  for (const s of picked.snippets || []) {
    const r = snippets.check(s);
    if (!r.ok) return { ok: false, error: `/${s?.name}: ${r.error}` };
    const bad = secretIn(`/${r.snippet.name}`, r.snippet);
    if (bad) return { ok: false, error: bad };
    snips.push(r.snippet);
  }

  const wfs = [];
  for (const w of picked.workflows || []) {
    const p = portable(w, root);
    const bad = secretIn(`The workflow "${w.name}"`, p.workflow);
    if (bad) return { ok: false, error: bad };
    if (p.outside.length) notes.push(`"${w.name}" uses ${p.outside.slice(0, 2).join(' and ')}${p.outside.length > 2 ? ' and more' : ''}, outside this repo. Teammates will need the same folders, or to change it after adding it.`);
    if ((w.when || []).some(t => t.type === 'webhook')) notes.push(`"${w.name}" gets a new web hook address on each teammate's PC.`);
    wfs.push(p.workflow);
  }

  const hooks = [];
  for (const h of picked.hooks || []) {
    const r = checkHook(h);
    if (r.error) return { ok: false, error: `A hook: ${r.error}` };
    const bad = secretIn('A hook', r.hook);
    if (bad) return { ok: false, error: bad };
    hooks.push(r.hook);
  }

  const rules = [];
  for (const r of picked.rules || []) {
    const v = CHECK.rules(r);
    if (v.error) return { ok: false, error: `A rule: ${v.error}` };
    const bad = secretIn(`The rule ${v.value.rule.slice(0, 40)}`, v.value.rule);
    if (bad) return { ok: false, error: bad };
    if (!rules.some(x => ruleKey(x) === ruleKey(v.value))) rules.push(v.value);
  }

  for (const [k, list] of Object.entries({ snippets: snips, workflows: wfs, hooks, rules })) {
    if (list.length > LIMITS[k]) return { ok: false, error: `A team pack holds up to ${LIMITS[k]} ${k}.` };
  }
  if (!snips.length && !wfs.length && !hooks.length && !rules.length) return { ok: false, error: 'Pick at least one thing to share.' };

  const name = oneLine(picked.name, MAX_NAME);
  const about = oneLine(picked.about, MAX_ABOUT);
  const badText = secretIn("The pack's name or description", [name, about]);
  if (badText) return { ok: false, error: badText };
  const file = {
    kind: KIND, version: VERSION,
    ...(name ? { name } : {}), ...(about ? { about } : {}),
    snippets: snips, workflows: wfs, hooks, rules,
  };
  const text = `${JSON.stringify(file, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_BYTES) return { ok: false, error: `That's too much for one team pack (over ${MAX_BYTES / 1024} KB). Leave something out.` };
  return { ok: true, text, notes };
}

module.exports = {
  KIND, VERSION, DIR, FILE, REPO, LIMITS, MAX_BYTES,
  locate, parse, hashOf, canonical, localize, portable, liveSnippets, status, contents, build, hookKey, ruleKey,
};
