const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanToolbox, parseFrontmatter, mergeInit, ToolboxWatcher } = require('../src/main/toolbox');

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-toolbox-')); dirs.push(d); return d; };
process.on('exit', () => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const md = (name, description) => `---\n${name ? `name: ${name}\n` : ''}description: ${description}\n---\n\nBody.\n`;
const names = list => list.map(t => t.name);

// ---- parseFrontmatter
test('frontmatter: plain and quoted scalars', () => {
  const fm = parseFrontmatter('---\nname: my-skill\ndescription: "Say \\"hi\\" nicely"\ntitle: \'It\'\'s fine\'\nmodel: sonnet # comment\n---\nbody');
  assert.deepEqual(fm, { name: 'my-skill', description: 'Say "hi" nicely', title: "It's fine", model: 'sonnet' });
});
test('frontmatter: folded > and >- join with spaces, literal | keeps newlines', () => {
  const fm = parseFrontmatter('---\ndescription: >\n  first line\n  second line\nnotes: |\n  one\n  two\nshort: >-\n  a\n  b\n---\n');
  assert.equal(fm.description, 'first line second line');
  assert.equal(fm.notes, 'one\ntwo');
  assert.equal(fm.short, 'a b');
});
test('frontmatter: CRLF, BOM, nested maps/lists ignored', () => {
  const fm = parseFrontmatter('﻿---\r\nname: x\r\ntools:\r\n  - Read\r\n  - Bash\r\nmeta:\r\n  a: 1\r\ndescription: y\r\n---\r\n');
  assert.deepEqual(fm, { name: 'x', description: 'y' });
});
test('frontmatter: missing or unterminated block returns {}', () => {
  assert.deepEqual(parseFrontmatter('# just markdown\nname: nope'), {});
  assert.deepEqual(parseFrontmatter('---\nname: never closed\n'), {});
  assert.deepEqual(parseFrontmatter(''), {});
  assert.deepEqual(parseFrontmatter(null), {});
});

// ---- scanToolbox
test('scan: user + project + plugin sources, overrides, namespacing, limits', () => {
  const home = tmp(), cwd = tmp(), plug = tmp();
  put(path.join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), md('', 'user alpha'));
  put(path.join(home, '.claude', 'skills', 'shared', 'SKILL.md'), md('shared', 'from user'));
  put(path.join(cwd, '.claude', 'skills', 'shared-dir', 'SKILL.md'), md('shared', 'from project'));
  put(path.join(home, '.claude', 'skills', 'big', 'SKILL.md'), md('big', 'x') + 'x'.repeat(300 * 1024));
  put(path.join(home, '.claude', 'skills', 'long', 'SKILL.md'), md('long', 'word  '.repeat(100)));
  put(path.join(home, '.claude', 'skills', 'nofile', 'README.md'), 'no skill here');
  put(path.join(home, '.claude', 'agents', 'team', 'reviewer.md'), md('', 'reviews code'));
  put(path.join(home, '.claude', 'commands', 'git', 'ship.md'), 'no frontmatter at all');
  put(path.join(home, '.claude', 'commands', 'Top.md'), md('', 'top'));
  put(path.join(plug, 'skills', 'pdf', 'SKILL.md'), md('', 'plugin pdf'));
  put(path.join(plug, 'skills', 'alpha', 'SKILL.md'), md('', 'plugin alpha'));

  const tb = scanToolbox({ home, cwd, plugins: [{ name: 'docs', path: plug }, { name: 'ghost', path: path.join(plug, 'missing') }, null] });
  assert.deepEqual(names(tb.skills), ['alpha', 'docs:alpha', 'docs:pdf', 'long', 'shared']);
  const shared = tb.skills.find(t => t.name === 'shared');
  assert.equal(shared.source, 'project');
  assert.equal(shared.description, 'from project');
  const pdf = tb.skills.find(t => t.name === 'docs:pdf');
  assert.equal(pdf.source, 'plugin:docs');
  assert.equal(pdf.kind, 'skill');
  assert.equal(pdf.path, path.join(plug, 'skills', 'pdf', 'SKILL.md'));
  assert.equal(tb.skills.find(t => t.name === 'alpha').source, 'user');
  const long = tb.skills.find(t => t.name === 'long').description;
  assert.equal(long.length, 240);
  assert.ok(long.endsWith('…'));
  assert.ok(!/\s{2}/.test(long));
  assert.deepEqual(tb.agents.map(t => [t.name, t.kind, t.source, t.description]), [['reviewer', 'agent', 'user', 'reviews code']]);
  assert.deepEqual(names(tb.commands), ['git:ship', 'Top']);
  assert.equal(tb.commands[0].description, '');
  assert.deepEqual(tb.mcp, []);
  assert.equal(typeof tb.scannedAt, 'number');
});
test('scan: user beats plugin for an un-prefixed clash; cwd === home is not double-counted', () => {
  const home = tmp();
  put(path.join(home, '.claude', 'agents', 'a.md'), md('', 'one'));
  const tb = scanToolbox({ home, cwd: home });
  assert.equal(tb.agents.length, 1);
  assert.equal(tb.agents[0].source, 'user');
});
test('scan: missing dirs and no arguments are fine', () => {
  const empty = { skills: [], agents: [], commands: [], mcp: [] };
  const tb = scanToolbox({ home: path.join(tmp(), 'nope'), cwd: path.join(tmp(), 'nada') });
  assert.deepEqual({ ...tb, scannedAt: undefined }, { ...empty, scannedAt: undefined });
  assert.deepEqual(scanToolbox().skills, []);
});

// ---- mergeInit
test('mergeInit: adds cli-only items, no skill duplicates from slash_commands, maps mcp', () => {
  const base = {
    skills: [{ kind: 'skill', name: 'pdf', description: 'd', source: 'user', path: 'p' }],
    agents: [], commands: [{ kind: 'command', name: 'mine', description: '', source: 'user', path: 'q' }], mcp: [], scannedAt: 1,
  };
  const snapshot = JSON.parse(JSON.stringify(base));
  const init = {
    skills: ['pdf', 'web-search'],
    agents: ['general-purpose', 'Explore'],
    slash_commands: ['compact', 'pdf', 'web-search', 'mine', 'review'],
    mcp_servers: [{ name: 'figma', status: 'needs-auth', source: 'plugin:figma' }, { name: 'local', status: 'connected' }, { bogus: true }],
    plugins: [],
  };
  const tb = mergeInit(base, init);
  assert.deepEqual(base, snapshot);
  assert.deepEqual(names(tb.skills), ['pdf', 'web-search']);
  assert.equal(tb.skills[1].source, 'cli');
  assert.equal(tb.skills[1].path, null);
  assert.deepEqual(names(tb.agents), ['Explore', 'general-purpose']);
  // compact is Claude Code's own: it's in builtins, from the catalogue.
  assert.deepEqual(names(tb.commands), ['mine', 'review']);
  assert.ok(tb.builtins.some(t => t.name === 'compact' && t.builtin));
  assert.equal(tb.commands.find(t => t.name === 'mine').source, 'user');
  assert.deepEqual(tb.mcp, [
    { kind: 'mcp', name: 'figma', description: '', source: 'plugin:figma', path: null, status: 'needs-auth' },
    { kind: 'mcp', name: 'local', description: '', source: 'cli', path: null, status: 'connected' },
  ]);
});
test('mergeInit tolerates null / partial input', () => {
  const tb = mergeInit({ skills: [], agents: [], commands: [], mcp: [], scannedAt: 1 }, null);
  assert.deepEqual(tb.skills, []);
  assert.deepEqual(mergeInit(null, { skills: 'nope', mcp_servers: null }).skills, []);
  assert.deepEqual(names(mergeInit(undefined, { agents: ['x', 5] }).agents), ['x']);
});

// ---- ToolboxWatcher
function waitFor(emitter, event, ms, nudge) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.off(event, on); reject(new Error(`no ${event} within ${ms}ms`)); }, ms);
    // If fs.watch is slow or silent, a manual rescan keeps the test deterministic.
    const kick = setTimeout(nudge, Math.min(1500, ms / 2));
    function on(v) { clearTimeout(timer); clearTimeout(kick); resolve(v); }
    emitter.once(event, on);
  });
}

test('watcher: initial scan is quiet, a new SKILL.md is "learned", stop() cleans up', async () => {
  const home = tmp(), cwd = tmp();
  put(path.join(home, '.claude', 'skills', 'old', 'SKILL.md'), md('', 'already here'));
  fs.mkdirSync(path.join(cwd, '.claude', 'agents'), { recursive: true });

  const w = new ToolboxWatcher({ home, getCwd: () => cwd, getPlugins: () => [], debounceMs: 50, pollMs: 60000 });
  const learned = [];
  let changed = 0;
  w.on('learned', l => learned.push(l));
  w.on('changed', () => changed++);
  w.start();
  try {
    assert.deepEqual(learned, []);
    assert.deepEqual(names(w.current.skills), ['old']);
    assert.equal(w.watchers.length, 2); // home skills + project agents

    const got = waitFor(w, 'learned', 5000, () => w.rescan());
    put(path.join(home, '.claude', 'skills', 'fresh', 'SKILL.md'), md('fresh', 'a new trick'));
    const l = await got;
    assert.deepEqual(l, { kind: 'skill', name: 'fresh', description: 'a new trick', path: path.join(home, '.claude', 'skills', 'fresh', 'SKILL.md'), source: 'user' });
    assert.ok(changed >= 2);

    // A second rescan with nothing new: no more learned events, no spurious change.
    const before = [learned.length, changed];
    w.rescan();
    assert.deepEqual([learned.length, changed], before);

    // setInit re-emits changed and merges CLI-only items, which are never "learned".
    w.setInit({ skills: ['builtin-thing'], mcp_servers: [{ name: 'm', status: 'failed' }] });
    assert.ok(w.current.skills.some(t => t.name === 'builtin-thing' && t.source === 'cli'));
    assert.equal(w.current.mcp[0].status, 'failed');
    assert.equal(learned.length, before[0]);
  } finally {
    w.stop();
  }
  assert.equal(w.watchers.length, 0);
  assert.equal(w.poll, null);
  assert.equal(w.debounce, null);
});

test('watcher: init plugins feed later scans without flooding "learned"', () => {
  const home = tmp(), plug = tmp();
  put(path.join(plug, 'skills', 'pdf', 'SKILL.md'), md('', 'plugin pdf'));
  const w = new ToolboxWatcher({ home, getCwd: () => null, pollMs: 0 });
  const learned = [];
  w.on('learned', l => learned.push(l));
  w.start();
  try {
    w.setInit({ plugins: [{ name: 'docs', path: plug }] });
    assert.deepEqual(names(w.current.skills), ['docs:pdf']);
    assert.deepEqual(learned, []);
    put(path.join(plug, 'skills', 'xlsx', 'SKILL.md'), md('', 'sheets'));
    w.rescan();
    assert.deepEqual(learned.map(l => [l.name, l.source]), [['docs:xlsx', 'plugin:docs']]);
  } finally {
    w.stop();
  }
});

test('watcher: another cached version of a plugin is never "learned", launch after launch', () => {
  // Claude Code sessions can report two cached versions of the same plugin
  // (installed_plugins.json says 0.2.2, the auto-updated cache has 0.2.6).
  // seen starts empty each launch, so this has to hold for a fresh watcher too.
  const home = tmp(), v1 = tmp(), v2 = tmp();
  put(path.join(v1, 'skills', 'doctor', 'SKILL.md'), md('', 'old'));
  put(path.join(v2, 'skills', 'doctor', 'SKILL.md'), md('', 'old'));
  put(path.join(v2, 'skills', 'status', 'SKILL.md'), md('', 'new in v2'));
  for (let launch = 0; launch < 2; launch++) {
    const w = new ToolboxWatcher({ home, getCwd: () => null, pollMs: 0 });
    const learned = [];
    w.on('learned', l => learned.push(l.name));
    w.start();
    try {
      w.setInit({ plugins: [{ name: 'ruflo', path: v1 }] });
      w.setInit({ plugins: [{ name: 'ruflo', path: v2 }] });
      w.setInit({ plugins: [{ name: 'ruflo', path: v1 }] });
      w.setInit({ plugins: [{ name: 'ruflo', path: v2 }] });
      assert.deepEqual(learned, []);
    } finally {
      w.stop();
    }
  }
});

test('watcher: a skill that flickers in and out is only "learned" once', () => {
  const home = tmp(), plug = tmp();
  const w = new ToolboxWatcher({ home, getCwd: () => null, pollMs: 0 });
  const learned = [];
  w.on('learned', l => learned.push(l.name));
  w.start();
  try {
    w.setInit({ plugins: [{ name: 'ruflo', path: plug }] });
    const status = path.join(plug, 'skills', 'status', 'SKILL.md');
    put(status, md('', 'new'));
    w.rescan();
    fs.rmSync(path.dirname(status), { recursive: true });
    w.rescan();
    put(status, md('', 'new'));
    w.rescan();
    assert.deepEqual(learned, ['ruflo:status']);

    // Same for a user skill that's deleted and put back.
    const file = path.join(home, '.claude', 'skills', 'mine', 'SKILL.md');
    put(file, md('', 'mine'));
    w.rescan();
    fs.rmSync(path.dirname(file), { recursive: true });
    w.rescan();
    put(file, md('', 'mine'));
    w.rescan();
    assert.deepEqual(learned, ['ruflo:status', 'mine']);
  } finally {
    w.stop();
  }
});

test('watcher: fs.watch failures never throw', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  const fsImpl = { ...fs, watch: () => { throw new Error('EMFILE'); } };
  const w = new ToolboxWatcher({ home, getCwd: () => { throw new Error('boom'); }, fsImpl, pollMs: 0 });
  assert.doesNotThrow(() => w.start());
  assert.equal(w.watchers.length, 0);
  w.stop();
});

test('scan: what each item costs, its listing and the body read when called', () => {
  const home = tmp();
  put(path.join(home, '.claude', 'skills', 'sized', 'SKILL.md'), '---\nname: sized\ndescription: Twelve chars\n---\n0123456789');
  put(path.join(home, '.claude', 'agents', 'bare.md'), 'No frontmatter at all.');
  const tb = scanToolbox({ home });
  const s = tb.skills.find(t => t.name === 'sized');
  assert.equal(s.listChars, 'sized'.length + 'Twelve chars'.length);
  assert.equal(s.bodyChars, 10);
  const a = tb.agents.find(t => t.name === 'bare');
  assert.equal(a.bodyChars, 'No frontmatter at all.'.length);
});

// ---- caches (the scan runs on the main process)
test('scan: metaCache skips unchanged files, rereads changed ones and drops deleted ones', () => {
  const home = tmp();
  const a = path.join(home, '.claude', 'skills', 'a', 'SKILL.md');
  const b = path.join(home, '.claude', 'skills', 'b', 'SKILL.md');
  put(a, md('', 'first'));
  put(b, md('', 'bee'));
  const metaCache = new Map();
  scanToolbox({ home, metaCache });
  assert.deepEqual([...metaCache.keys()].sort(), [a, b].sort());

  // Unchanged: served from the cache, even if the entry says something else.
  metaCache.set(a, { ...metaCache.get(a), meta: { description: 'cached', bodyChars: 1 } });
  assert.equal(scanToolbox({ home, metaCache }).skills.find(t => t.name === 'a').description, 'cached');

  // Changed size: read again.
  put(a, md('', 'second, longer'));
  assert.equal(scanToolbox({ home, metaCache }).skills.find(t => t.name === 'a').description, 'second, longer');

  fs.rmSync(path.dirname(b), { recursive: true });
  scanToolbox({ home, metaCache });
  assert.deepEqual([...metaCache.keys()], [a]);
});

test('scan: pluginCache reuses a plugin dir until cleared, and forgets plugins that went away', () => {
  const home = tmp(), plug = tmp(), other = tmp();
  put(path.join(plug, 'skills', 'pdf', 'SKILL.md'), md('', 'pdf'));
  put(path.join(other, 'skills', 'xlsx', 'SKILL.md'), md('', 'xlsx'));
  const pluginCache = new Map();
  const metaCache = new Map();
  const plugins = [{ name: 'docs', path: plug }, { name: 'sheets', path: other }];
  scanToolbox({ home, plugins, pluginCache, metaCache });
  assert.equal(pluginCache.size, 2);

  put(path.join(plug, 'skills', 'docx', 'SKILL.md'), md('', 'docx'));
  assert.deepEqual(names(scanToolbox({ home, plugins, pluginCache, metaCache }).skills), ['docs:pdf', 'sheets:xlsx']);
  // Reused dirs keep their file entries, so a cleared pluginCache doesn't mean rereading everything.
  assert.ok(metaCache.has(path.join(plug, 'skills', 'pdf', 'SKILL.md')));

  pluginCache.clear();
  assert.deepEqual(names(scanToolbox({ home, plugins, pluginCache, metaCache }).skills), ['docs:docx', 'docs:pdf', 'sheets:xlsx']);

  scanToolbox({ home, plugins: [plugins[0]], pluginCache, metaCache });
  assert.deepEqual([...pluginCache.keys()], [`docs=${plug}`]);

  // An empty dir may be an install still being written, so it isn't kept.
  const fresh = tmp();
  scanToolbox({ home, plugins: [{ name: 'later', path: fresh }], pluginCache, metaCache });
  assert.equal(pluginCache.size, 0);
  put(path.join(fresh, 'skills', 'ready', 'SKILL.md'), md('', 'ready'));
  assert.deepEqual(names(scanToolbox({ home, plugins: [{ name: 'later', path: fresh }], pluginCache, metaCache }).skills), ['later:ready']);
});

test('watcher: the poll reads plugin dirs again every tenth time', async () => {
  const home = tmp(), plug = tmp();
  put(path.join(plug, 'skills', 'pdf', 'SKILL.md'), md('', 'pdf'));
  const w = new ToolboxWatcher({ home, getCwd: () => null, pollMs: 5, getPlugins: () => [{ name: 'docs', path: plug }] });
  w.start();
  try {
    put(path.join(plug, 'skills', 'docx', 'SKILL.md'), md('', 'docx'));
    const end = Date.now() + 5000;
    while (Date.now() < end && !w.current.skills.some(t => t.name === 'docs:docx')) await new Promise(r => setTimeout(r, 10));
    assert.ok(w.current.skills.some(t => t.name === 'docs:docx'));
  } finally {
    w.stop();
  }
});

test('watcher: the poll reuses plugin dirs, Rescan reads them again, your own are always fresh', () => {
  const home = tmp(), plug = tmp();
  put(path.join(plug, 'skills', 'pdf', 'SKILL.md'), md('', 'pdf'));
  const w = new ToolboxWatcher({ home, getCwd: () => null, pollMs: 0, getPlugins: () => [{ name: 'docs', path: plug }] });
  w.start();
  try {
    put(path.join(plug, 'skills', 'docx', 'SKILL.md'), md('', 'docx'));
    put(path.join(home, '.claude', 'skills', 'mine', 'SKILL.md'), md('', 'mine'));
    w.rescan({ plugins: false });
    assert.deepEqual(names(w.current.skills), ['docs:pdf', 'mine']);
    w.rescan();
    assert.deepEqual(names(w.current.skills), ['docs:docx', 'docs:pdf', 'mine']);
  } finally {
    w.stop();
  }
});

// ---- what's been seen, across launches
test('watcher: a skill written while Shellby was closed is news at the next launch', () => {
  const home = tmp(), cwd = tmp(), data = tmp();
  const seenFile = path.join(data, 'toolbox-seen.json');
  put(path.join(home, '.claude', 'skills', 'old', 'SKILL.md'), md('', 'old'));
  const launch = () => {
    const w = new ToolboxWatcher({ home, getCwd: () => cwd, pollMs: 0, seenFile });
    const learned = [];
    w.on('learned', l => learned.push(l.name));
    w.start();
    w.stop();
    return learned;
  };
  // The first launch ever has nothing to compare with.
  assert.deepEqual(launch(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(seenFile, 'utf8')), ['skill:old', 'mod:*']);

  put(path.join(home, '.claude', 'skills', 'new', 'SKILL.md'), md('', 'new'));
  put(path.join(home, '.claude', 'agents', 'helper.md'), md('', 'helps'));
  // A project's own aren't news at launch: Shellby may never have looked in that folder.
  put(path.join(cwd, '.claude', 'skills', 'proj', 'SKILL.md'), md('', 'project'));
  assert.deepEqual(launch().sort(), ['helper', 'new']);
  assert.deepEqual(launch(), []);
});

test('watcher: at most a few announcements at launch, and a bad seen file is a first launch', () => {
  const home = tmp(), data = tmp();
  const seenFile = path.join(data, 'toolbox-seen.json');
  fs.writeFileSync(seenFile, '{not json');
  const w0 = new ToolboxWatcher({ home, getCwd: () => null, pollMs: 0, seenFile });
  assert.equal(w0.restored, false);

  fs.writeFileSync(seenFile, JSON.stringify(['skill:gone', 42]));
  for (const n of ['a', 'b', 'c', 'd', 'e']) put(path.join(home, '.claude', 'skills', n, 'SKILL.md'), md('', n));
  const w = new ToolboxWatcher({ home, getCwd: () => null, pollMs: 0, seenFile });
  const learned = [];
  w.on('learned', l => learned.push(l.name));
  w.start();
  w.stop();
  assert.equal(learned.length, 3);
  // All five are remembered, so the rest don't come up next time either.
  const saved = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
  assert.ok(['a', 'b', 'c', 'd', 'e'].every(n => saved.includes(`skill:${n}`)));
});

test('watcher: a first launch with nothing at all still counts as one', () => {
  const home = tmp(), data = tmp();
  const seenFile = path.join(data, 'toolbox-seen.json');
  const launch = () => {
    const w = new ToolboxWatcher({ home, getCwd: () => null, pollMs: 0, seenFile });
    const learned = [];
    w.on('learned', l => learned.push(l.name));
    w.start();
    w.stop();
    return learned;
  };
  assert.deepEqual(launch(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(seenFile, 'utf8')), ['mod:*']);
  put(path.join(home, '.claude', 'skills', 'first', 'SKILL.md'), md('', 'first'));
  assert.deepEqual(launch(), ['first']);
});

// ---- built-in commands
test('mergeInit: Claude Code built-in commands get a description, unknown ones none', () => {
  const tb = mergeInit({ skills: [], agents: [], commands: [] }, { slash_commands: ['compact', 'brand-new-thing', 'constructor'] });
  const by = Object.fromEntries([...tb.commands, ...tb.builtins].map(t => [t.name, t.description]));
  assert.match(by.compact, /Summarize/);
  assert.equal(by['brand-new-thing'], '');
  assert.equal(by.constructor, '');
});

// ---- mods in the Toolbox

const putMod = (home, name, extra = {}) => {
  const dir = path.join(home, '.claude', 'skills', name);
  put(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: `${name} mod`, ...extra }));
  put(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }));
  return dir;
};

test('mergeInit: init.commands adds commands with their descriptions, once each', () => {
  const out = mergeInit({ skills: [], agents: [], commands: [], mcp: [] }, {
    slash_commands: ['probe', 'compact'],
    commands: [{ name: 'probe', description: 'Says hello from the probe mod.' }, { name: 'later', description: 'Added after start' }, { name: 'later', description: 'dupe' }, { name: '' }, null],
  });
  const byName = Object.fromEntries(out.commands.map(c => [c.name, c]));
  assert.deepEqual(Object.keys(byName).sort(), ['later', 'probe']);
  assert.equal(out.commands.length, 2);
  byName.compact = out.builtins.find(c => c.name === 'compact');
  assert.equal(byName.probe.description, 'Says hello from the probe mod.');
  assert.equal(byName.later.description, 'Added after start');
  assert.equal(byName.probe.source, 'cli');
  assert.ok(byName.compact.description, 'a built-in command keeps its own description');
});

test('mergeInit: a command already in the Toolbox, or named like a skill, is not added again', () => {
  const tb = { skills: [{ kind: 'skill', name: 'plan' }], agents: [], commands: [{ kind: 'command', name: 'deploy', description: 'mine', source: 'user', path: 'p' }], mcp: [] };
  const out = mergeInit(tb, { commands: [{ name: 'deploy', description: 'other' }, { name: 'plan', description: 'x' }] });
  assert.deepEqual(names(out.commands), ['deploy']);
  assert.equal(out.commands[0].description, 'mine');
});

test('mergeInit: the result carries the mods it was given, as copies', () => {
  const mods = [{ kind: 'mod', id: 'a@skills-dir', name: 'a' }];
  const out = mergeInit({ skills: [], agents: [], commands: [], mcp: [], mods }, null);
  assert.deepEqual(out.mods, mods);
  assert.notEqual(out.mods[0], mods[0]);
  assert.deepEqual(mergeInit({}, {}).mods, []);
});

test('watcher: a mod written later is "learned" and listed in current.mods', () => {
  const home = tmp();
  putMod(home, 'old');
  const w = new ToolboxWatcher({ home, getCwd: () => null, pollMs: 0 });
  const learned = [];
  w.on('learned', l => learned.push(l));
  w.start();
  try {
    assert.deepEqual(names(w.current.mods), ['old']);
    assert.deepEqual(learned, [], 'the first scan is quiet');
    const dir = putMod(home, 'fresh');
    w.rescan();
    assert.deepEqual(names(w.current.mods), ['fresh', 'old']);
    assert.equal(learned.length, 1);
    assert.deepEqual(learned[0], { kind: 'mod', id: 'fresh@skills-dir', name: 'fresh', description: 'fresh mod', path: dir, source: 'user', enabled: true });
    w.rescan();
    assert.equal(learned.length, 1, 'a second rescan with nothing new says nothing');
  } finally { w.stop(); }
});

test('watcher: getSettings turning a mod off shows as enabled false in current.mods', () => {
  const home = tmp();
  putMod(home, 'tidy');
  let settings = [];
  const w = new ToolboxWatcher({ home, getCwd: () => null, pollMs: 0, getSettings: () => settings });
  let changed = 0;
  w.on('changed', () => changed++);
  w.start();
  try {
    assert.equal(w.current.mods[0].enabled, true);
    settings = [{ enabledPlugins: { 'tidy@skills-dir': false } }];
    const before = changed;
    w.rescan();
    assert.equal(w.current.mods[0].enabled, false);
    assert.ok(changed > before, 'turning it off is a change');
  } finally { w.stop(); }
});

test('watcher: installed marketplace mods are listed but are not "learned"', () => {
  const home = tmp();
  const root = tmp();
  const dir = path.join(root, 'shopmod');
  put(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'shopmod' }));
  put(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./m.ts'] }));
  let installed = [];
  const w = new ToolboxWatcher({ home, getCwd: () => null, pollMs: 0, getInstalled: () => installed });
  const learned = [];
  w.on('learned', l => learned.push(l));
  w.start();
  try {
    installed = [{ id: 'shopmod@shop', marketplace: 'shop', dir, enabled: true }];
    w.rescan();
    assert.equal(w.current.mods[0].source, 'plugin');
    assert.deepEqual(learned, []);
  } finally { w.stop(); }
});

test('watcher: a getInstalled or getSettings that throws just means no mods from there', () => {
  const home = tmp();
  putMod(home, 'tidy');
  const w = new ToolboxWatcher({ home, getCwd: () => null, pollMs: 0, getInstalled: () => { throw new Error('boom'); }, getSettings: () => { throw new Error('boom'); } });
  w.start();
  try { assert.deepEqual(names(w.current.mods), ['tidy']); } finally { w.stop(); }
});

test('watcher: setCommands emits changed only when the list changes, and shows the commands', () => {
  const home = tmp();
  const w = new ToolboxWatcher({ home, getCwd: () => null, pollMs: 0 });
  w.start();
  try {
    let changed = 0;
    w.on('changed', () => changed++);
    const list = [{ name: 'probe', description: 'Says hello.' }];
    w.setCommands(list);
    assert.equal(changed, 1);
    const probe = w.current.commands.find(c => c.name === 'probe');
    assert.equal(probe.description, 'Says hello.');
    w.setCommands([{ name: 'probe', description: 'Says hello.' }]);
    assert.equal(changed, 1, 'the same list again is not a change');
    w.setCommands([...list, { name: 'second', description: 'More.' }]);
    assert.equal(changed, 2);
    w.setCommands('not a list');
    assert.equal(changed, 2);
  } finally { w.stop(); }
});

test('watcher: a mod written while Shellby was closed is news at the next launch, but ones from before mods were known are not', () => {
  const home = tmp(), data = tmp();
  const seenFile = path.join(data, 'toolbox-seen.json');
  putMod(home, 'before');
  const launch = () => {
    const w = new ToolboxWatcher({ home, getCwd: () => null, pollMs: 0, seenFile });
    const learned = [];
    w.on('learned', l => learned.push(l.kind === 'mod' ? l.name : `other:${l.name}`));
    w.start();
    w.stop();
    return learned;
  };
  assert.deepEqual(launch(), [], 'the first look only takes note');
  assert.ok(JSON.parse(fs.readFileSync(seenFile, 'utf8')).includes('mod:before@skills-dir'));
  putMod(home, 'after');
  assert.deepEqual(launch(), ['after']);
  assert.deepEqual(launch(), []);
});

test('watcher: a seen file from before mods existed treats the mods already installed as seen, not as news', () => {
  const home = tmp(), data = tmp();
  const seenFile = path.join(data, 'toolbox-seen.json');
  fs.writeFileSync(seenFile, JSON.stringify(['skill:old']));
  putMod(home, 'installed');
  const w = new ToolboxWatcher({ home, getCwd: () => null, pollMs: 0, seenFile });
  const learned = [];
  w.on('learned', l => learned.push(l.name));
  w.start();
  w.stop();
  assert.deepEqual(learned, []);
});
