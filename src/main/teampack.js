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
//   MCP        servers the team uses, added for you in that project with
//   servers    `claude mcp add`. The pack never carries a value for their
//              environment variables or headers, only the names: each teammate
//              types their own token in, and it goes straight to Claude Code.
//
// Set it all up: a new hire can take everything that's waiting in one go,
// after one confirm window that lists every part of it in full (setupPlan,
// setupDetail). The pack they said yes to is remembered, so the Team tab can
// say when the repo's pack has changed since.
//
// Workflows keep full paths; the repo's own folder is written as {repo}, so the
// same file works in everyone's clone.
//
// Pure (no Electron): fs is only touched through the injected `exists`.
const crypto = require('crypto');
const path = require('path');
const snippets = require('./snippets');
const claudeSetup = require('./claude-setup');
const mcpAdmin = require('./mcpadmin');
const { lineSecret } = require('./secretscan');

const KIND = 'shellby-team-pack';
const VERSION = 1;
const DIR = '.shellby';
const FILE = 'team.json';
const REPO = '{repo}';
const MAX_BYTES = 512 * 1024;
const MAX_DEPTH = 40;
const LIMITS = { snippets: 50, workflows: 20, hooks: 20, rules: 50, mcpServers: 10 };
const MAX_NAME = 60;
const MAX_ABOUT = 300;
const MAX_HOOK_ABOUT = 200;
const MAX_BLANKS = 20;               // environment variables or headers per server
const MAX_VALUE = 4000;              // one value a teammate types in
const MAX_SETUP_DETAIL = 20000;      // what one "set it all up" window shows in full
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const HIDDEN = /[\p{Cf}\p{Zs}]/u;     // format characters and odd spaces (claude-setup's rule for hooks)

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

// The names a server needs filled in: a list of names, or an object whose
// values are ignored (a value in a repo's file is either a secret that
// shouldn't be there, or something a teammate didn't choose).
function blankNames(raw, re, what) {
  if (raw === undefined || raw === null) return { names: [], dropped: false };
  const names = Array.isArray(raw) ? raw : isObj(raw) ? Object.keys(raw) : null;
  if (!names) return { error: `its ${what} should be a list of names` };
  if (names.length > MAX_BLANKS) return { error: `has more than ${MAX_BLANKS} ${what}` };
  const bad = names.find(n => typeof n !== 'string' || !re.test(n));
  if (bad !== undefined) return { error: `"${String(bad).slice(0, 40)}" isn't a ${what === 'headers' ? 'header' : 'variable'} name` };
  const dropped = isObj(raw) && Object.values(raw).some(v => v !== '' && v !== null && v !== undefined);
  return { names: [...new Set(names)], dropped };
}

/**
 * An MCP server as the pack has it:
 *   { name, transport, command | url, env: [name], headers: [name], about? } | { error }
 * env and headers are only names: the values are each teammate's own. `dropped`
 * says values were in the file and were left out.
 */
function checkMcp(input) {
  if (!isObj(input)) return { error: "isn't an MCP server" };
  const hasCommand = typeof input.command === 'string' && input.command.trim();
  const hasUrl = typeof input.url === 'string' && input.url.trim();
  if (!hasCommand === !hasUrl) return { error: `"${oneLine(input.name, 40) || 'a server'}" needs a command or a url (one of them)` };
  const transport = hasUrl ? (input.transport === 'sse' ? 'sse' : 'http') : 'stdio';
  const env = blankNames(hasUrl ? undefined : input.env, ENV_NAME, 'environment variables');
  if (env.error) return env;
  const headers = blankNames(hasUrl ? input.headers : undefined, HEADER_NAME, 'headers');
  if (headers.error) return headers;
  // What `claude mcp add` would make of it, with stand-in values.
  const target = (hasUrl ? input.url : input.command).trim();
  // What the confirm window shows has to be what runs: no invisible characters.
  if (HIDDEN.test(target.replace(/ /g, ''))) return { error: `${oneLine(input.name, 40) || 'a server'}: its command has an invisible or unusual character in it` };
  const tried = mcpAdmin.addArgs({
    name: input.name, transport, target, scope: 'local',
    env: env.names.map(n => `${n}=x`).join('\n'), headers: headers.names.map(n => `${n}: x`).join('\n'),
  });
  if (tried.error) return { error: `${oneLine(input.name, 40) || 'a server'}: ${tried.error}` };
  const server = { name: tried.summary.name, transport, ...(hasUrl ? { url: tried.summary.target } : { command: target }), env: env.names, headers: headers.names };
  const about = oneLine(input.about, MAX_HOOK_ABOUT);
  if (about) server.about = about;
  return { server, dropped: env.dropped || headers.dropped };
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
      if (r.note) problems.push(r.note);
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
    mcpServers: take('mcpServers', s => s.name.toLowerCase()),
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
  mcpServers(s) {
    const r = checkMcp(s);
    if (r.error) return r;
    return { value: r.server, note: r.dropped ? `The MCP server "${r.server.name}" had values in the file. They were left out: each teammate fills in their own.` : null };
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

// ------------------------------------------------------------ MCP servers: names, never values

// One word of a command line, quoted the way mcpadmin.splitArgs reads it back.
function quoteArg(a) {
  if (a && !/[\s"']/.test(a)) return a;
  if (!a.includes('"')) return `"${a}"`;
  if (!a.includes("'")) return `'${a}'`;
  return null;
}

/**
 * One of your servers (Claude Code's definition, mcpservers.resolveServer),
 * ready for the pack: its command or URL, and only the *names* of its
 * environment variables and headers. -> { ok, server, blanks } | { ok: false, error }
 */
function portableMcp(name, def) {
  if (!isObj(def)) return { ok: false, error: `"${name}" can't be shared from here.` };
  const url = typeof def.url === 'string' ? def.url : '';
  let input;
  if (url) {
    input = { name, transport: def.type === 'sse' ? 'sse' : 'http', url, headers: Object.keys(isObj(def.headers) ? def.headers : {}) };
  } else {
    const words = [def.command, ...(Array.isArray(def.args) ? def.args : [])].map(w => (typeof w === 'string' ? quoteArg(w) : null));
    if (!def.command || words.some(w => w === null)) return { ok: false, error: `"${name}" has a command Shellby can't write on one line.` };
    input = { name, command: words.join(' '), env: Object.keys(isObj(def.env) ? def.env : {}) };
  }
  const r = checkMcp(input);
  if (r.error) return { ok: false, error: r.error };
  return { ok: true, server: r.server, blanks: [...r.server.env, ...r.server.headers] };
}

/**
 * What a teammate typed in for a pack server -> the input for mcpadmin.addArgs
 * (just them, in this project), or { error, missing } naming what's still blank.
 *   values: { env: { NAME: value }, headers: { Name: value } }
 */
function mcpInput(server, values = {}) {
  const pick = (names, from) => names.map(n => [n, typeof from?.[n] === 'string' ? from[n].trim() : '']);
  const env = pick(server.env || [], values.env);
  const headers = pick(server.headers || [], values.headers);
  const missing = [...env, ...headers].filter(([, v]) => !v).map(([n]) => n);
  if (missing.length) return { error: `Fill in ${missing.join(', ')} for "${server.name}".`, missing };
  // One line each: a line break would make a second variable nobody saw.
  const odd = [...env, ...headers].find(([, v]) => v.length > MAX_VALUE || /[\u0000-\u001f\u007f]/.test(v));
  if (odd) return { error: `${odd[0]} for "${server.name}" needs to be one line, under ${MAX_VALUE} characters.` };
  return {
    input: {
      name: server.name, transport: server.transport, scope: 'local',
      target: server.transport === 'stdio' ? server.command : server.url,
      env: env.map(([n, v]) => `${n}=${v}`).join('\n'),
      headers: headers.map(([n, v]) => `${n}: ${v}`).join('\n'),
    },
  };
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
 *   hooks: [{ event, matcher, command, source }], rules: [{ scope, list, rule }],
 *   mcp: [{ name, scope }] (the servers Claude Code has for this folder) }
 */
function status(pack, have) {
  const snipHash = hashOf(pack.snippets);
  const trusted = have.trusted === snipHash;
  const mine = new Set(have.snippets.map(s => s.name));
  const hookAt = new Map(have.hooks.map(h => [hookKey(h), h.source]));
  const ruleAt = new Map(have.rules.map(r => [ruleKey(r), r.scope]));
  const wfs = new Map(have.workflows.map(w => [w.name.toLowerCase(), w]));
  const mcpAt = new Map((have.mcp || []).map(s => [s.name.toLowerCase(), s.scope]));

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
    // By name: one you already have under that name is yours, and is left alone.
    mcp: (pack.mcpServers || []).map(s => ({ ...s, state: mcpAt.has(s.name.toLowerCase()) ? 'added' : 'new', where: mcpAt.get(s.name.toLowerCase()) || null })),
  };
  view.waiting = (view.snippets.state === 'off' || view.snippets.state === 'changed' ? 1 : 0)
    + view.workflows.filter(w => w.state !== 'added').length
    + view.hooks.filter(h => h.state === 'new').length
    + view.rules.filter(r => r.state === 'new').length
    + view.mcp.filter(s => s.state === 'new').length;
  return view;
}

/**
 * What "Set it all up" would do: everything still waiting that can be added
 * as it is. A workflow that doesn't fit, or is off, is left for its own row.
 *   -> { snippets: bool, workflows: [name], hooks: [key], rules: [key], mcp: [name], count }
 */
function setupPlan(view) {
  const plan = {
    snippets: view.snippets.state === 'off' || view.snippets.state === 'changed',
    workflows: view.workflows.filter(w => w.state === 'new' || w.state === 'different').map(w => w.name),
    hooks: view.hooks.filter(h => h.state === 'new').map(h => h.key),
    rules: view.rules.filter(r => r.state === 'new').map(r => r.key),
    mcp: (view.mcp || []).filter(s => s.state === 'new').map(s => s.name),
  };
  plan.count = (plan.snippets ? 1 : 0) + plan.workflows.length + plan.hooks.length + plan.rules.length + plan.mcp.length;
  return plan;
}

// Nothing in the window can hide: invisible characters are spelled out, and so
// are long runs of spaces (the window folds them).
const visible = s => String(s)
  .replace(/\p{Cf}/gu, c => `[U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}]`)
  .replace(/ {3,}/g, m => ` [${m.length} spaces] `);
const indent = (s, by = '    ') => visible(s).split('\n').map(l => `${by}${l}`).join('\n');

/**
 * The one confirm window's words for a plan: every part in full, nothing
 * summarised away. workflowDetail: name -> what the workflow's own window
 * would show (workflows/service.js). -> { title, message, detail, danger } |
 * { error } when it's too much to show in one window.
 */
function setupDetail(pack, plan, { repo, workflowDetail = {} } = {}) {
  const parts = [];
  const hooks = pack.hooks.filter(h => plan.hooks.includes(hookKey(h)));
  const rules = pack.rules.filter(r => plan.rules.includes(ruleKey(r)));
  const servers = (pack.mcpServers || []).filter(s => plan.mcp.includes(s.name));
  const wfs = pack.workflows.filter(w => plan.workflows.includes(w.name));
  if (plan.snippets && pack.snippets.length) {
    parts.push(`SNIPPETS (${pack.snippets.length}), on in this repo. Each goes to Claude as written, only when you use it:\n`
      + pack.snippets.map(s => `  /${s.name}\n${indent(s.text)}`).join('\n'));
  }
  if (hooks.length) {
    parts.push(`HOOKS (${hooks.length}), in your own settings for this project. Claude Code runs these by itself, with your Windows account, without asking:\n`
      + hooks.map(h => `  ${describeHook(h)}:\n${indent(h.command)}`).join('\n'));
  }
  if (rules.length) {
    parts.push(`RULES (${rules.length}), in your own settings for this project. An allow rule lets Claude do that without asking:\n${rules.map(r => `  ${r.list}: ${visible(r.rule)}`).join('\n')}`);
  }
  if (servers.length) {
    parts.push(`MCP SERVERS (${servers.length}), for just you in this project. Claude Code ${servers.some(s => s.transport === 'stdio') ? 'starts or connects to' : 'connects to'} these by itself in every session:\n`
      + servers.map((s) => {
        const blanks = [...s.env, ...s.headers];
        return `  ${s.name}: ${visible(s.transport === 'stdio' ? s.command : s.url)}${blanks.length ? `\n    with your own ${blanks.join(', ')} (not shown)` : ''}`;
      }).join('\n'));
  }
  if (wfs.length) {
    parts.push(`WORKFLOWS (${wfs.length}), on your Automate page:\n`
      + wfs.map(w => `  "${w.name}"\n${indent(workflowDetail[w.name] || `${w.steps.length} steps`)}`).join('\n'));
  }
  const detail = parts.join('\n\n');
  if (detail.length > MAX_SETUP_DETAIL) return { error: "There's too much in this team pack to show in one window. Add the parts one at a time below." };
  const danger = hooks.length > 0 || rules.some(r => r.list === 'allow') || servers.some(s => s.transport === 'stdio') || wfs.some(w => JSON.stringify(w.steps).includes('"mode":"autonomous"'));
  return {
    title: `Set up ${pack.name || repo || 'the team pack'}?`,
    message: `Everything below comes from ${repo ? `${repo}'s` : 'the repo\'s'} team pack (.shellby/team.json), and is added in one go. Read it first: a pack is only as trustworthy as whoever can push to the repo.`,
    detail, danger,
  };
}

/** "Changed since you set it up": the yes you gave and the file now. */
function changedSince(accepted, fileHash, waiting) {
  if (!accepted || typeof accepted.hash !== 'string' || !Number.isFinite(accepted.at)) return null;
  return accepted.hash !== fileHash && waiting > 0 ? { at: accepted.at } : null;
}

function describeHook(h) {
  const when = claudeSetup.HOOK_EVENTS.find(e => e.name === h.event)?.when || `on ${h.event}`;
  return `Runs ${when}${h.matcher ? ` (matching ${h.matcher})` : ''}`;
}

/** "4 snippets, 2 workflows and a hook": for the notice. */
function contents(pack) {
  const parts = [['snippet', pack.snippets.length], ['workflow', pack.workflows.length], ['hook', pack.hooks.length], ['rule', pack.rules.length],
    ['MCP server', (pack.mcpServers || []).length, 'an']]
    .filter(([, n]) => n)
    .map(([w, n, a = 'a']) => (n === 1 ? `${a} ${w}` : `${n} ${w}s`));
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

  // Servers come as portableMcp made them: names for their values, never the values.
  const servers = [];
  for (const s of picked.mcpServers || []) {
    const r = checkMcp(s);
    if (r.error) return { ok: false, error: `An MCP server: ${r.error}` };
    if (r.dropped) return { ok: false, error: `The MCP server "${r.server.name}" still has values in it. Only the names go in a team pack.` };
    const bad = secretIn(`The MCP server "${r.server.name}"`, r.server);
    if (bad) return { ok: false, error: bad };
    const blanks = [...r.server.env, ...r.server.headers];
    if (blanks.length) notes.push(`"${r.server.name}" goes in without ${blanks.join(', ')}: each teammate fills in their own when they add it.`);
    if (!servers.some(x => x.name.toLowerCase() === r.server.name.toLowerCase())) servers.push(r.server);
  }

  for (const [k, list] of Object.entries({ snippets: snips, workflows: wfs, hooks, rules, mcpServers: servers })) {
    if (list.length > LIMITS[k]) return { ok: false, error: `A team pack holds up to ${LIMITS[k]} ${k === 'mcpServers' ? 'MCP servers' : k}.` };
  }
  if (!snips.length && !wfs.length && !hooks.length && !rules.length && !servers.length) return { ok: false, error: 'Pick at least one thing to share.' };

  const name = oneLine(picked.name, MAX_NAME);
  const about = oneLine(picked.about, MAX_ABOUT);
  const badText = secretIn("The pack's name or description", [name, about]);
  if (badText) return { ok: false, error: badText };
  const file = {
    kind: KIND, version: VERSION,
    ...(name ? { name } : {}), ...(about ? { about } : {}),
    snippets: snips, workflows: wfs, hooks, rules,
    ...(servers.length ? { mcpServers: servers } : {}),
  };
  const text = `${JSON.stringify(file, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_BYTES) return { ok: false, error: `That's too much for one team pack (over ${MAX_BYTES / 1024} KB). Leave something out.` };
  return { ok: true, text, notes };
}

module.exports = {
  KIND, VERSION, DIR, FILE, REPO, LIMITS, MAX_BYTES,
  locate, parse, hashOf, canonical, localize, portable, liveSnippets, status, contents, build, hookKey, ruleKey,
  portableMcp, mcpInput, setupPlan, setupDetail, changedSince,
};
