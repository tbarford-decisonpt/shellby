// Team packs: a repo's committed .shellby/team.json, read, checked, compared with
// what you already have, and written from what you pick.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const tp = require('../src/main/teampack');

const ROOT = 'C:\\code\\acme';
const pack = (extra = {}) => JSON.stringify({ kind: tp.KIND, version: 1, name: 'Acme', ...extra });
const parsed = (extra) => { const r = tp.parse(pack(extra)); assert.ok(r.ok, r.error); return r; };

const WF = {
  name: 'Nightly tests', description: 'Runs the tests', cwd: ROOT, concurrency: 'skip', inputs: [],
  when: [{ type: 'webhook', token: 'a'.repeat(40) }],
  steps: [{ id: 'run', type: 'run', command: 'npm test', cwd: `${ROOT}\\web` }],
  id: 'wf-1', createdAt: 1, updatedAt: 2, enabled: true,
};

// ------------------------------------------------------------ locate

test('locate finds the pack at the repo root, from a folder inside it', () => {
  const files = new Set([path.join(ROOT, '.git'), path.join(ROOT, '.shellby', 'team.json')]);
  const r = tp.locate(path.join(ROOT, 'src', 'app'), { home: 'C:\\Users\\me', exists: f => files.has(f) });
  assert.deepEqual(r, { root: ROOT, file: path.join(ROOT, '.shellby', 'team.json'), hasPack: true });
});

test('locate looks for the pack at the repo root only', () => {
  const nested = new Set([path.join(ROOT, '.git'), path.join(ROOT, 'vendor', 'x', '.shellby', 'team.json')]);
  assert.equal(tp.locate(path.join(ROOT, 'vendor', 'x'), { home: 'C:\\Users\\me', exists: f => nested.has(f) }).hasPack, false);
});

test('locate stops at the repo: a pack above the .git is not this repo\'s', () => {
  const files = new Set([path.join(ROOT, '.git'), path.join('C:\\code', '.shellby', 'team.json')]);
  const r = tp.locate(ROOT, { home: 'C:\\Users\\me', exists: f => files.has(f) });
  assert.equal(r.hasPack, false);
  assert.equal(r.root, ROOT);
});

test('locate never treats the home folder or a drive root as a project', () => {
  const home = 'C:\\Users\\me';
  const files = new Set([path.join(home, '.shellby', 'team.json'), path.join(home, '.git')]);
  assert.equal(tp.locate(path.join(home, 'Downloads'), { home, exists: f => files.has(f) }), null);
  assert.equal(tp.locate('C:\\', { home, exists: () => true }), null);
  assert.equal(tp.locate('', { home, exists: () => true }), null);
});

// ------------------------------------------------------------ parse

test('parse refuses what is not a team pack', () => {
  assert.equal(tp.parse('{').ok, false);
  assert.equal(tp.parse('{"kind":"shellby-snippets"}').ok, false);
  assert.match(tp.parse(JSON.stringify({ kind: tp.KIND, version: 2 })).error, /newer Shellby/);
  assert.match(tp.parse(' '.repeat(tp.MAX_BYTES + 1)).error, /too big/);
});

test('parse keeps the good parts and says what it left out', () => {
  const r = parsed({
    snippets: [{ name: 'Ship', text: 'Ship $ARGUMENTS', hint: 'a branch' }, { name: 'export', text: 'x' }, { name: 'ship', text: 'again' }, { name: '', text: 'no name' }],
    workflows: [WF, { name: 'No steps', steps: [] }],
    hooks: [{ event: 'Stop', command: 'echo done', about: 'Says done' }, { event: 'Nope', command: 'x' }, { event: 'Stop', command: 'echo\nmore' }],
    rules: [{ list: 'deny', rule: 'Bash(rm -rf:*)' }, { list: 'maybe', rule: 'Bash' }, { list: 'deny', rule: 'Bash(rm -rf:*)' }],
  });
  assert.deepEqual(r.pack.snippets, [{ name: 'ship', text: 'Ship $ARGUMENTS', hint: 'a branch' }]);
  assert.deepEqual(r.pack.workflows.map(w => w.name), ['Nightly tests']);
  assert.equal(r.pack.workflows[0].id, undefined, 'ids are never taken from a pack');
  assert.deepEqual(r.pack.hooks, [{ event: 'Stop', matcher: '', command: 'echo done', about: 'Says done' }]);
  assert.deepEqual(r.pack.rules, [{ list: 'deny', rule: 'Bash(rm -rf:*)' }]);
  assert.equal(r.problems.length, 8, r.problems.join('\n'));
  assert.ok(r.problems.some(p => /Shellby's own commands/.test(p)));
  assert.ok(r.problems.some(p => /twice/.test(p)));
});

test('parse caps each list', () => {
  const many = Array.from({ length: tp.LIMITS.snippets + 5 }, (_, i) => ({ name: `s${i}`, text: `t${i}` }));
  const r = parsed({ snippets: many });
  assert.equal(r.pack.snippets.length, tp.LIMITS.snippets);
  assert.ok(r.problems.some(p => /Only the first/.test(p)));
});

// ------------------------------------------------------------ {repo}

test('portable writes the repo folder as {repo}, whatever the case or slashes', () => {
  const wf = { ...WF, steps: [{ id: 'run', type: 'run', command: 'node C:/CODE/acme/tools/x.js', cwd: `${ROOT}\\web` }] };
  const p = tp.portable(wf, ROOT);
  assert.equal(p.workflow.cwd, '{repo}');
  assert.equal(p.workflow.steps[0].cwd, '{repo}\\web');
  assert.equal(p.workflow.steps[0].command, 'node {repo}/tools/x.js');
  assert.deepEqual(p.outside, []);
  for (const k of ['id', 'createdAt', 'updatedAt', 'enabled']) assert.equal(p.workflow[k], undefined, k);
  assert.deepEqual(p.workflow.when, [{ type: 'webhook' }], 'web hook tokens stay on your PC');
});

test('portable leaves a lookalike folder alone and lists paths outside the repo', () => {
  const wf = { ...WF, cwd: 'C:\\code\\acme-old', steps: [{ id: 'r', type: 'run', command: 'type D:\\notes\\todo.txt' }] };
  const p = tp.portable(wf, ROOT);
  assert.equal(p.workflow.cwd, 'C:\\code\\acme-old');
  assert.deepEqual(p.outside.sort(), ['C:\\code\\acme-old', 'D:\\notes\\todo.txt']);
});

test('localize puts this clone\'s folder back', () => {
  const back = tp.localize(tp.portable(WF, ROOT).workflow, 'D:\\work\\acme');
  assert.equal(back.cwd, 'D:\\work\\acme');
  assert.equal(back.steps[0].cwd, 'D:\\work\\acme\\web');
});

// ------------------------------------------------------------ snippets and status

test('team snippets are on only for the exact list you said yes to, and yours win', () => {
  const { pack: p } = parsed({ snippets: [{ name: 'review', text: 'Team review' }, { name: 'ship', text: 'Ship it' }] });
  const own = [{ name: 'review', text: 'My review' }];
  assert.deepEqual(tp.liveSnippets(p, own, null), []);
  const yes = tp.hashOf(p.snippets);
  assert.deepEqual(tp.liveSnippets(p, own, yes), [{ name: 'ship', text: 'Ship it', team: true }]);
  const changed = parsed({ snippets: [{ name: 'ship', text: 'Ship it now' }] }).pack;
  assert.deepEqual(tp.liveSnippets(changed, own, yes), [], 'a change waits for another yes');
});

test('hashOf ignores key order, so reformatting the file is not a change', () => {
  assert.equal(tp.hashOf([{ name: 'a', text: 'b' }]), tp.hashOf([{ text: 'b', name: 'a' }]));
  assert.notEqual(tp.hashOf([{ name: 'a', text: 'b' }]), tp.hashOf([{ name: 'a', text: 'c' }]));
});

test('status says what you have and what is waiting', () => {
  const { pack: p } = parsed({
    snippets: [{ name: 'ship', text: 'Ship it' }],
    workflows: [WF, { ...WF, name: 'Deploy' }, { ...WF, name: 'Lint' }],
    hooks: [{ event: 'Stop', command: 'echo done' }, { event: 'PreToolUse', matcher: 'Bash', command: 'echo pre' }],
    rules: [{ list: 'deny', rule: 'Bash(rm -rf:*)' }, { list: 'allow', rule: 'Bash(npm test:*)' }],
  });
  const v = tp.status(p, {
    snippets: [], trusted: 'something older',
    workflows: [{ name: 'nightly tests', same: true }, { name: 'Deploy', same: false }],
    hooks: [{ event: 'Stop', matcher: '', command: 'echo done', source: 'user' }],
    rules: [{ scope: 'local', list: 'deny', rule: 'Bash(rm -rf:*)' }],
  });
  assert.equal(v.snippets.state, 'changed');
  assert.deepEqual(v.workflows.map(w => w.state), ['added', 'different', 'new']);
  assert.deepEqual(v.hooks.map(h => [h.state, h.where]), [['added', 'user'], ['new', null]]);
  assert.match(v.hooks[1].describe, /before Claude uses a tool \(matching Bash\)/);
  assert.deepEqual(v.rules.map(r => r.state), ['added', 'new']);
  assert.equal(v.waiting, 1 + 2 + 1 + 1);
});

test('contents reads naturally', () => {
  assert.equal(tp.contents(parsed({ snippets: [{ name: 'a', text: 'a' }, { name: 'b', text: 'b' }], hooks: [{ event: 'Stop', command: 'echo' }] }).pack), '2 snippets and a hook');
  assert.equal(tp.contents(parsed({}).pack), 'nothing yet');
});

// ------------------------------------------------------------ build

test('build writes a file parse reads back the same', () => {
  const r = tp.build({
    name: 'Acme', about: 'Our setup',
    snippets: [{ name: 'ship', text: 'Ship $ARGUMENTS', hint: 'a branch' }],
    workflows: [WF],
    hooks: [{ event: 'Stop', matcher: '', command: 'echo done' }],
    rules: [{ list: 'ask', rule: 'Bash(git push:*)' }],
  }, ROOT);
  assert.ok(r.ok, r.error);
  assert.ok(r.text.endsWith('\n'));
  assert.ok(!r.text.includes('acme\\\\web'), 'no full repo path in the file');
  assert.ok(r.notes.some(n => /web hook/.test(n)));
  const back = tp.parse(r.text);
  assert.ok(back.ok);
  assert.deepEqual(back.problems, []);
  assert.equal(back.pack.name, 'Acme');
  assert.equal(back.pack.workflows[0].cwd, '{repo}');
  assert.deepEqual(back.pack.rules, [{ list: 'ask', rule: 'Bash(git push:*)' }]);
});

test('build refuses an empty pack and anything carrying a secret', () => {
  assert.match(tp.build({}, ROOT).error, /at least one/);
  const token = `ghp_${'A1b2'.repeat(9)}`;
  assert.match(tp.build({ snippets: [{ name: 'gh', text: `Use the token\n${token} to call the API` }] }, ROOT).error, /\/gh looks like it has a secret/);
  assert.match(tp.build({ hooks: [{ event: 'Stop', command: `curl -H "Authorization: ${token}" x` }] }, ROOT).error, /A hook looks like/);
  assert.match(tp.build({ rules: [{ list: 'allow', rule: `Bash(curl -H ${token}:*)` }] }, ROOT).error, /The rule .* looks like/);
  assert.match(tp.build({ name: token, rules: [{ list: 'deny', rule: 'Bash' }] }, ROOT).error, /name or description/);
  const wf = { ...WF, steps: [{ id: 'r', type: 'run', command: `echo ${token}` }] };
  assert.match(tp.build({ workflows: [wf] }, ROOT).error, /"Nightly tests" looks like/);
});

test('build notes paths teammates will not have', () => {
  const r = tp.build({ workflows: [{ ...WF, when: [], cwd: 'C:\\Users\\me\\scratch' }] }, ROOT);
  assert.ok(r.ok);
  assert.ok(r.notes.some(n => /outside this repo/.test(n)), r.notes.join('\n'));
});

// ------------------------------------------------------------ MCP servers

const GH_SERVER = { name: 'github', command: 'npx -y @modelcontextprotocol/server-github', env: ['GITHUB_TOKEN'], about: 'Issues and PRs' };

test('an MCP server in the pack is a command or a url, and only names for its values', () => {
  const r = parsed({ mcpServers: [GH_SERVER, { name: 'linear', url: 'https://mcp.linear.app/sse', transport: 'sse', headers: ['Authorization'] }] });
  assert.deepEqual(r.pack.mcpServers, [
    { name: 'github', transport: 'stdio', command: 'npx -y @modelcontextprotocol/server-github', env: ['GITHUB_TOKEN'], headers: [], about: 'Issues and PRs' },
    { name: 'linear', transport: 'sse', url: 'https://mcp.linear.app/sse', env: [], headers: ['Authorization'] },
  ]);
  assert.deepEqual(r.problems, []);
});

test("values in the pack's file are never kept: each teammate types their own", () => {
  const r = parsed({ mcpServers: [{ name: 'github', command: 'npx server-github', env: { GITHUB_TOKEN: 'ghp_from_the_repo', NODE_ENV: '' } }] });
  assert.deepEqual(r.pack.mcpServers[0].env, ['GITHUB_TOKEN', 'NODE_ENV']);
  assert.equal(JSON.stringify(r.pack).includes('ghp_from_the_repo'), false);
  assert.match(r.problems[0], /left out: each teammate fills in their own/);
});

test('MCP servers that do not fit are left out and said so', () => {
  const r = parsed({ mcpServers: [
    { name: 'both', command: 'x', url: 'https://x.dev' },
    { name: 'plain-http', url: 'http://example.com/mcp' },
    { name: 'bad-env', command: 'x', env: ['1BAD'] },
    { name: 'quote', command: 'node "unclosed' },
    { name: 'ok', command: 'node server.js' },
    { name: 'OK', command: 'node other.js' },
  ] });
  assert.deepEqual(r.pack.mcpServers.map(s => s.name), ['ok']);
  assert.equal(r.problems.length, 5, r.problems.join('\n'));
});

test('portableMcp keeps the command and the names, never the values', () => {
  const r = tp.portableMcp('github', { command: 'npx', args: ['-y', '@mcp/github', 'C:\\Program Files\\x'], env: { GITHUB_TOKEN: 'ghp_secret' } });
  assert.equal(r.ok, true);
  assert.equal(r.server.command, 'npx -y @mcp/github "C:\\Program Files\\x"');
  assert.deepEqual(r.server.env, ['GITHUB_TOKEN']);
  assert.deepEqual(r.blanks, ['GITHUB_TOKEN']);
  assert.equal(JSON.stringify(r).includes('ghp_secret'), false);
  const url = tp.portableMcp('linear', { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer abc' } });
  assert.deepEqual(url.server, { name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp', env: [], headers: ['Authorization'] });
  assert.equal(tp.portableMcp('odd', { command: 'x', args: [`it's "both"`] }).ok, false);
});

test('build refuses an MCP server with a secret in its command, and notes the blanks', () => {
  const token = `ghp_${'a'.repeat(36)}`;
  const bad = tp.build({ mcpServers: [{ name: 'gh', command: `npx server --token ${token}` }] }, ROOT);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /secret/);
  const withValues = tp.build({ mcpServers: [{ name: 'gh', command: 'npx server', env: { GITHUB_TOKEN: 'x' } }] }, ROOT);
  assert.equal(withValues.ok, false);
  const ok = tp.build({ mcpServers: [GH_SERVER] }, ROOT);
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(JSON.parse(ok.text).mcpServers[0].env, ['GITHUB_TOKEN']);
  assert.ok(ok.notes.some(n => /GITHUB_TOKEN.*fills in their own/.test(n)), ok.notes.join('\n'));
});

test('mcpInput fills the blanks with what you typed, one line each', () => {
  const s = parsed({ mcpServers: [GH_SERVER] }).pack.mcpServers[0];
  const missing = tp.mcpInput(s, {});
  assert.deepEqual(missing.missing, ['GITHUB_TOKEN']);
  assert.match(missing.error, /Fill in GITHUB_TOKEN/);
  assert.match(tp.mcpInput(s, { env: { GITHUB_TOKEN: 'a\nNODE_OPTIONS=--require evil' } }).error, /one line/);
  const r = tp.mcpInput(s, { env: { GITHUB_TOKEN: ' ghp_mine ', EXTRA: 'ignored' } });
  assert.deepEqual(r.input, { name: 'github', transport: 'stdio', scope: 'local', target: 'npx -y @modelcontextprotocol/server-github', env: 'GITHUB_TOKEN=ghp_mine', headers: '' });
});

test('status and contents count MCP servers, by name', () => {
  const p = parsed({ mcpServers: [GH_SERVER, { name: 'docs', url: 'https://docs.example.com/mcp' }] }).pack;
  const v = tp.status(p, { snippets: [], trusted: null, workflows: [], hooks: [], rules: [], mcp: [{ name: 'GitHub', scope: 'user' }] });
  assert.deepEqual(v.mcp.map(s => [s.name, s.state]), [['github', 'added'], ['docs', 'new']]);
  assert.equal(v.waiting, 1);
  assert.equal(tp.contents(p), '2 MCP servers');
  assert.equal(tp.contents({ ...p, mcpServers: [GH_SERVER] }), 'an MCP server');
});

// ------------------------------------------------------------ set it all up

test('the set-up plan is everything waiting, and its window shows every part in full', () => {
  const p = parsed({
    snippets: [{ name: 'ship', text: 'Get it ready\nand write the PR' }],
    hooks: [{ event: 'Stop', command: 'echo done' }],
    rules: [{ list: 'deny', rule: 'Bash(rm -rf:*)' }, { list: 'allow', rule: 'Bash(npm test)' }],
    mcpServers: [GH_SERVER],
  }).pack;
  const v = tp.status(p, { snippets: [], trusted: null, workflows: [], hooks: [], rules: [{ scope: 'local', list: 'allow', rule: 'Bash(npm test)' }], mcp: [] });
  const plan = tp.setupPlan(v);
  assert.equal(plan.snippets, true);
  assert.equal(plan.rules.length, 1, 'a rule you have already is left alone');
  assert.equal(plan.count, 4);
  const w = tp.setupDetail(p, plan, { repo: 'acme' });
  assert.equal(w.title, 'Set up Acme?');
  assert.equal(w.danger, true, 'a hook or a program to start is the dangerous kind');
  for (const part of ['/ship', 'and write the PR', 'echo done', 'deny: Bash(rm -rf:*)', 'npx -y @modelcontextprotocol/server-github', 'GITHUB_TOKEN (not shown)']) {
    assert.ok(w.detail.includes(part), `missing ${part}`);
  }
  assert.equal(w.detail.includes('Bash(npm test)'), false);
});

test('nothing in the set-up window can hide: invisible characters are spelled out or refused', () => {
  const zw = String.fromCodePoint(0x200b);
  assert.equal(parsed({ mcpServers: [{ name: 'x', command: `node x.js${zw}--evil` }] }).pack.mcpServers.length, 0);
  const p = parsed({ snippets: [{ name: 'ship', text: `Ship it${zw} quietly` }], rules: [{ list: 'allow', rule: 'Bash(npm test)' }] }).pack;
  const v = tp.status(p, { snippets: [], trusted: null, workflows: [], hooks: [], rules: [] });
  const w = tp.setupDetail(p, tp.setupPlan(v));
  assert.ok(w.detail.includes('Ship it[U+200B] quietly'), w.detail);
  assert.equal(w.danger, true, 'an allow rule loosens what Claude may do');
});

test('a pack too big to show in one window is set up a part at a time', () => {
  const p = parsed({ snippets: Array.from({ length: 50 }, (_, i) => ({ name: `s${i}`, text: 'x'.repeat(500) })) }).pack;
  const v = tp.status(p, { snippets: [], trusted: null, workflows: [], hooks: [], rules: [] });
  assert.match(tp.setupDetail(p, tp.setupPlan(v)).error, /too much/);
});

test('changed since you set it up: only when the file differs and something is waiting', () => {
  assert.equal(tp.changedSince(null, 'h2', 3), null);
  assert.equal(tp.changedSince({ hash: 'h1', at: 5 }, 'h1', 3), null);
  assert.equal(tp.changedSince({ hash: 'h1', at: 5 }, 'h2', 0), null, 'a change you already have is no news');
  assert.deepEqual(tp.changedSince({ hash: 'h1', at: 5 }, 'h2', 2), { at: 5 });
  assert.equal(tp.changedSince({ hash: 'h1' }, 'h2', 2), null);
});
