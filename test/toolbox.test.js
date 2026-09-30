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
  assert.deepEqual(names(tb.commands), ['compact', 'mine', 'review']);
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

test('watcher: fs.watch failures never throw', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  const fsImpl = { ...fs, watch: () => { throw new Error('EMFILE'); } };
  const w = new ToolboxWatcher({ home, getCwd: () => { throw new Error('boom'); }, fsImpl, pollMs: 0 });
  assert.doesNotThrow(() => w.start());
  assert.equal(w.watchers.length, 0);
  w.stop();
});
