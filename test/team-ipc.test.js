// Toolbox → Team, end to end with a real repo folder on disk and fake IPC: what
// the panel sees, saying yes to the team's snippets, adds handed to the right
// place, the notice, and writing the file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const teamIpc = require('../src/main/team-ipc');
const tp = require('../src/main/teampack');

function setup({ pack, own = [], hooks = [], rules = [], workflows = null, answer = 0, claude = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-team-'));
  const root = path.join(home, 'code', 'acme');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  if (pack) {
    fs.mkdirSync(path.join(root, '.shellby'));
    fs.writeFileSync(path.join(root, '.shellby', 'team.json'), JSON.stringify({ kind: tp.KIND, version: 1, ...pack }));
  }
  const handlers = new Map();
  const settings = {};
  const sent = [];
  const calls = { hooks: [], rules: [], saves: [], pushed: 0, asked: [], claude: [], warned: [] };
  const deps = {
    ipcMain: { handle: (c, fn) => handlers.set(c, fn), on: (c, fn) => handlers.set(c, fn) },
    config: { get: k => settings[k], set: o => Object.assign(settings, o) },
    shell: { showItemInFolder: () => {} },
    home, panel: () => 'panel', send: (_w, channel, payload) => sent.push({ channel, payload }),
    currentCwd: () => path.join(root, 'src'), stat: () => {},
    ownSnippets: () => own, pushSnippets: () => { calls.pushed++; },
    workflows: () => workflows,
    setupView: () => ({ hooks, permissions: { rules } }),
    saveHook: async (req) => { calls.hooks.push(req); return { ok: true }; },
    saveRule: async (req) => { calls.rules.push(req); return { ok: true }; },
    setupWhere: () => ({ home: path.join(home, 'claude-home'), cwd: root }),
    confirm: async (spec) => { calls.asked.push(spec); return typeof answer === 'function' ? answer(spec) : answer; },
    runClaude: async (args, _t, opts) => { calls.claude.push({ args, cwd: opts?.cwd }); return claude ? claude(args) : { ok: true, stdout: '', stderr: '' }; },
    now: () => 1759500000000,
    log: { warn: (m) => calls.warned.push(m) },
  };
  const api = teamIpc.register(deps);
  const call = (c, ...args) => handlers.get(c)({}, ...args);
  return { home, root, api, call, settings, sent, calls, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

const PACK = {
  name: 'Acme',
  snippets: [{ name: 'ship', text: 'Ship it' }, { name: 'review', text: 'Team review' }],
  hooks: [{ event: 'Stop', command: 'echo done', about: 'Says done' }],
  rules: [{ list: 'deny', rule: 'Bash(rm -rf:*)' }],
};

test('the Team tab sees the pack from a folder inside the repo', async () => {
  const t = setup({ pack: PACK });
  try {
    const v = await t.call('team:get');
    assert.equal(v.hasPack, true);
    assert.equal(v.where.root, t.root);
    assert.equal(v.name, 'Acme');
    assert.equal(v.snippets.state, 'off');
    assert.equal(v.waiting, 3);
  } finally { t.cleanup(); }
});

test('no repo, or a repo without a pack, says so', async () => {
  const t = setup();
  try {
    const v = await t.call('team:get');
    assert.equal(v.hasPack, false);
    assert.equal(v.where.name, 'acme');
  } finally { t.cleanup(); }
});

test('the team\'s snippets are off until you say yes to exactly that list, and yours win', async () => {
  const t = setup({ pack: PACK, own: [{ name: 'review', text: 'Mine' }] });
  try {
    const cwd = path.join(t.root, 'src');
    assert.deepEqual(t.api.snippetsFor(cwd, [{ name: 'review', text: 'Mine' }]), []);
    const stale = await t.call('team:use-snippets', 'not the hash');
    assert.equal(stale.ok, false);
    const v = await t.call('team:get');
    const r = await t.call('team:use-snippets', v.snippets.hash);
    assert.equal(r.ok, true);
    assert.equal(t.calls.pushed, 1);
    assert.deepEqual(t.api.snippetsFor(cwd, [{ name: 'review', text: 'Mine' }]).map(s => s.name), ['ship']);
    // Someone changes the file: off again until you look.
    const file = path.join(t.root, '.shellby', 'team.json');
    fs.writeFileSync(file, JSON.stringify({ kind: tp.KIND, version: 1, snippets: [{ name: 'ship', text: 'Ship it, and push to prod' }] }));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    assert.deepEqual(t.api.snippetsFor(cwd, []), []);
    assert.equal((await t.call('team:get')).snippets.state, 'changed');
    await t.call('team:stop-snippets');
    assert.equal((await t.call('team:get')).snippets.state, 'off');
  } finally { t.cleanup(); }
});

test('hooks and rules are added by what they are, only to your own settings', async () => {
  const t = setup({ pack: PACK });
  try {
    const v = await t.call('team:get');
    const key = v.hooks[0].key;
    assert.equal((await t.call('team:add-hook', { key, scope: 'project' })).ok, false, 'never the shared project settings');
    assert.equal((await t.call('team:add-hook', { key: 'Stop\n\nrm -rf /', scope: 'local' })).ok, false, 'only what is in the pack');
    const r = await t.call('team:add-hook', { key, scope: 'local' });
    assert.equal(r.ok, true);
    assert.deepEqual(t.calls.hooks, [{ scope: 'local', hook: { event: 'Stop', matcher: '', command: 'echo done' } }]);
    await t.call('team:add-rule', { key: v.rules[0].key, scope: 'user' });
    assert.deepEqual(t.calls.rules, [{ scope: 'user', list: 'deny', rule: 'Bash(rm -rf:*)' }]);
  } finally { t.cleanup(); }
});

test('workflows go through the service\'s save as a team pack\'s, with {repo} filled in', async () => {
  const saved = [];
  const service = {
    workflows: [],
    validate: (wf) => ({ ok: true, workflow: { ...wf, id: 'wf-x', createdAt: 1, updatedAt: 1, enabled: true } }),
    byName: () => null,
    save: async (input, opts) => { saved.push({ input, opts }); return { ok: true }; },
  };
  const t = setup({ pack: { workflows: [{ name: 'Test', cwd: '{repo}', steps: [{ id: 's', type: 'run', command: 'npm test' }] }] }, workflows: service });
  try {
    const v = await t.call('team:get');
    assert.equal(v.workflows[0].state, 'new');
    const r = await t.call('team:add-workflow', 'Test');
    assert.equal(r.ok, true);
    assert.equal(saved[0].opts.source, 'team');
    assert.equal(saved[0].input.cwd, t.root);
    assert.equal(saved[0].input.id, undefined, 'a new one gets its own id');
    assert.equal((await t.call('team:add-workflow', 'Not there')).ok, false);
  } finally { t.cleanup(); }
});

test('the notice comes once per version of the file', async () => {
  const t = setup({ pack: PACK });
  try {
    t.api.notice();
    t.api.notice();
    const notices = t.sent.filter(s => s.channel === 'team:notice');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].payload.first, true);
    assert.match(notices[0].payload.contents, /2 snippets, a hook and a rule/);
  } finally { t.cleanup(); }
});

test('writing the pack puts .shellby/team.json at the repo root and leaves out what you did not pick', async () => {
  const own = [{ name: 'ship', text: 'Ship it' }, { name: 'secret', text: 'not picked' }];
  const hooks = [{ source: 'user', type: 'command', known: true, event: 'Stop', matcher: '', command: 'echo done', summary: 'Prints a message' }];
  const t = setup({ own, hooks });
  try {
    const d = await t.call('team:draft');
    assert.equal(d.ok, true);
    assert.equal(d.exists, false);
    const r = await t.call('team:write', { name: 'Acme', snippets: ['ship', '../../evil'], hooks: [d.all.hooks[0].key] });
    assert.equal(r.ok, true, r.error);
    const text = fs.readFileSync(path.join(t.root, '.shellby', 'team.json'), 'utf8');
    const back = tp.parse(text);
    assert.deepEqual(back.pack.snippets.map(s => s.name), ['ship']);
    assert.deepEqual(back.pack.hooks.map(h => h.command), ['echo done']);
    assert.equal(r.view.hasPack, true);
    assert.equal(r.view.snippets.state, 'on', "your own pack's snippets need no yes from you");
    // Your own pack doesn't announce itself to you.
    t.api.notice();
    assert.equal(t.sent.filter(s => s.channel === 'team:notice').length, 0);
  } finally { t.cleanup(); }
});

test("a pack somewhere inside the repo is not the repo's", async () => {
  const t = setup();
  try {
    const vendored = path.join(t.root, 'src', '.shellby');
    fs.mkdirSync(vendored);
    fs.writeFileSync(path.join(vendored, 'team.json'), JSON.stringify({ kind: tp.KIND, version: 1, snippets: [{ name: 'x', text: 'x' }] }));
    assert.equal((await t.call('team:get')).hasPack, false);
  } finally { t.cleanup(); }
});

test('a linked .shellby is never read through, or written through', async () => {
  const t = setup();
  try {
    const elsewhere = path.join(t.home, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'team.json'), JSON.stringify({ kind: tp.KIND, version: 1, snippets: [{ name: 'x', text: 'x' }] }));
    fs.symlinkSync(elsewhere, path.join(t.root, '.shellby'), 'junction');
    const v = await t.call('team:get');
    assert.equal(v.hasPack, true);
    assert.match(v.error, /is a link/);
    assert.deepEqual(t.api.snippetsFor(path.join(t.root, 'src'), []), []);
    const w = await t.call('team:write', { snippets: [] , rules: [] });
    assert.equal(w.ok, false);
  } finally { t.cleanup(); }
});

// ------------------------------------------------------------ a new hire: set it all up

const FULL = {
  ...PACK,
  mcpServers: [{ name: 'github', command: 'npx -y server-github', env: ['GITHUB_TOKEN'] }, { name: 'docs', url: 'https://docs.example.com/mcp' }],
};
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

test('set it all up: one window with every part, then all of it goes in', async () => {
  const t = setup({ pack: FULL });
  try {
    const v = await t.call('team:get');
    assert.equal(v.plan.count, 5, 'snippets, a hook, a rule and two servers');
    assert.equal(v.accepted, null);
    assert.equal(v.changed, null);
    const r = await t.call('team:setup-all', { values: { github: { env: { GITHUB_TOKEN: 'ghp_typed_by_me' } } } });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.added, 5);
    assert.equal(t.calls.asked.length, 1, 'one window, not five');
    const asked = t.calls.asked[0];
    for (const part of ['/ship', 'echo done', 'Bash(rm -rf:*)', 'npx -y server-github', 'https://docs.example.com/mcp']) assert.ok(asked.detail.includes(part), part);
    assert.equal(asked.detail.includes('ghp_typed_by_me'), false, 'what you typed is never shown');
    // Each part where it belongs: hooks and rules in your own settings for this project.
    const local = readJson(path.join(t.root, '.claude', 'settings.local.json'));
    assert.deepEqual(local.permissions.deny, ['Bash(rm -rf:*)']);
    assert.equal(local.hooks.Stop[0].hooks[0].command, 'echo done');
    assert.deepEqual(t.calls.hooks, [], 'not one confirm window per hook');
    // The servers through `claude mcp add`, just you, in the repo, with your value.
    assert.equal(t.calls.claude.length, 2);
    assert.ok(t.calls.claude.every(c => c.cwd === t.root && c.args.includes('local')));
    assert.ok(t.calls.claude[0].args.includes('GITHUB_TOKEN=ghp_typed_by_me'));
    assert.equal(JSON.stringify(t.settings).includes('ghp_typed_by_me'), false, 'and it is never kept');
    assert.equal(r.view.snippets.state, 'on');
    assert.equal(r.view.accepted, 1759500000000);
  } finally { t.cleanup(); }
});

test('set it all up: Cancel adds nothing, and a server left blank waits for later', async () => {
  const t = setup({ pack: FULL, answer: 1 });
  try {
    const no = await t.call('team:setup-all', {});
    assert.equal(no.cancelled, true);
    assert.equal(fs.existsSync(path.join(t.root, '.claude', 'settings.local.json')), false);
    assert.equal(t.calls.claude.length, 0);
    assert.match(t.calls.asked[0].note, /Left for later.*github/);
    assert.equal(t.calls.asked[0].detail.includes('server-github'), false, 'a server you left blank is not in the window');
  } finally { t.cleanup(); }
});

test('set it all up: half-filled values are a slip, not a skip', async () => {
  const t = setup({ pack: { mcpServers: [{ name: 'x', command: 'node x.js', env: ['A', 'B'] }] } });
  try {
    const r = await t.call('team:setup-all', { values: { x: { env: { A: 'one' } } } });
    assert.equal(r.ok, false);
    assert.match(r.error, /Fill in B/);
    assert.equal(t.calls.asked.length, 0);
  } finally { t.cleanup(); }
});

test('set it all up: a pack that changes while the window is up adds nothing', async () => {
  const file = () => path.join(t.root, '.shellby', 'team.json');
  const t = setup({
    pack: PACK,
    answer: () => { fs.writeFileSync(file(), JSON.stringify({ kind: tp.KIND, version: 1, ...PACK, hooks: [{ event: 'Stop', command: 'curl evil.example' }] })); return 0; },
  });
  try {
    const r = await t.call('team:setup-all', {});
    assert.equal(r.ok, false);
    assert.match(r.error, /changed while you were deciding/);
    assert.equal(fs.existsSync(path.join(t.root, '.claude', 'settings.local.json')), false);
  } finally { t.cleanup(); }
});

test('set it all up never writes through a linked .claude folder', async () => {
  const t = setup({ pack: { hooks: PACK.hooks } });
  try {
    const elsewhere = path.join(t.home, 'global-claude');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(t.root, '.claude'), 'junction');
    const r = await t.call('team:setup-all', {});
    assert.equal(r.ok, false);
    assert.match(r.error, /link to somewhere else/);
    assert.equal(fs.existsSync(path.join(elsewhere, 'settings.local.json')), false);
  } finally { t.cleanup(); }
});

test('after you set it up, a change to the pack is shown as a change', async () => {
  const t = setup({ pack: { snippets: PACK.snippets } });
  try {
    await t.call('team:setup-all', {});
    assert.equal((await t.call('team:get')).changed, null);
    const file = path.join(t.root, '.shellby', 'team.json');
    fs.writeFileSync(file, JSON.stringify({ kind: tp.KIND, version: 1, snippets: [...PACK.snippets, { name: 'deploy', text: 'Deploy it' }] }));
    const v = await t.call('team:get');
    assert.deepEqual(v.changed, { at: 1759500000000 });
    assert.equal(v.snippets.state, 'changed');
    assert.equal(v.plan.count, 1, 'only the changed snippets are waiting');
  } finally { t.cleanup(); }
});

test("Claude Code's refusal to add a server is passed on without what you typed", async () => {
  const t = setup({ pack: { mcpServers: [FULL.mcpServers[0]] }, claude: () => ({ ok: false, stderr: 'Error: bad value ghp_typed_by_me for GITHUB_TOKEN' }) });
  try {
    const r = await t.call('team:add-mcp', { name: 'github', values: { env: { GITHUB_TOKEN: 'ghp_typed_by_me' } } });
    assert.equal(r.ok, false);
    assert.equal(r.error.includes('ghp_typed_by_me'), false);
    assert.equal(t.calls.warned.join('').includes('ghp_typed_by_me'), false);
    assert.match(t.calls.asked[0].detail, /npx -y server-github/);
  } finally { t.cleanup(); }
});

test('the Team tab lists what the repo already shares through Claude Code', async () => {
  const t = setup({ pack: PACK });
  try {
    fs.writeFileSync(path.join(t.root, 'CLAUDE.md'), '# Rules');
    fs.mkdirSync(path.join(t.root, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(t.root, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\n---');
    fs.mkdirSync(path.join(t.root, '.claude', 'skills', 'deploy'), { recursive: true });
    fs.writeFileSync(path.join(t.root, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---');
    fs.writeFileSync(path.join(t.root, '.mcp.json'), JSON.stringify({ mcpServers: { sentry: { url: 'https://x' } } }));
    const v = await t.call('team:get');
    assert.deepEqual(v.shared, { memory: ['CLAUDE.md'], agents: ['reviewer'], skills: ['deploy'], commands: [], mcp: ['sentry'] });
  } finally { t.cleanup(); }
});

test('writing a pack shares your own MCP servers by name, never their values', async () => {
  const t = setup();
  try {
    const claudeHome = path.join(t.home, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(path.join(claudeHome, '.claude.json'), JSON.stringify({
      mcpServers: { github: { command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: 'ghp_mine_only' } } },
    }));
    const d = await t.call('team:draft');
    assert.deepEqual(d.all.mcpServers.map(s => [s.name, s.blanks]), [['github', ['GITHUB_TOKEN']]]);
    const r = await t.call('team:write', { mcpServers: ['github'] });
    assert.equal(r.ok, true, r.error);
    const text = fs.readFileSync(path.join(t.root, '.shellby', 'team.json'), 'utf8');
    assert.equal(text.includes('ghp_mine_only'), false);
    assert.deepEqual(JSON.parse(text).mcpServers, [{ name: 'github', transport: 'stdio', command: 'npx -y server-github', env: ['GITHUB_TOKEN'], headers: [] }]);
  } finally { t.cleanup(); }
});
