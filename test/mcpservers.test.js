const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mcp = require('../src/main/mcpservers');

// A home folder and a project with servers in all three scopes.
function setup({ global = {}, settings = null, shared = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-mcp-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-mcp-proj-'));
  const g = typeof global === 'function' ? global(cwd) : global;
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(g));
  if (settings) { fs.mkdirSync(path.join(home, '.claude')); fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings)); }
  if (shared) fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: shared }));
  return { home, cwd };
}

test('allow rules cover every tool of a server, with plugin names made safe', () => {
  assert.deepEqual(mcp.allowRules(['linear', 'plugin:github:github', 'linear']), ['mcp__linear__*', 'mcp__plugin_github_github__*']);
  assert.equal(mcp.toolPrefix('my.server'), 'my_server');
});

test('server name lists are checked, kept in order and capped', () => {
  assert.deepEqual(mcp.checkNames(['slack', 'linear', 'slack']).list, ['slack', 'linear']);
  assert.deepEqual(mcp.checkNames(undefined).list, []);
  assert.match(mcp.checkNames('slack').error, /list/);
  assert.match(mcp.checkNames(['ok', 'bad name']).error, /isn't an MCP server name/);
  assert.match(mcp.checkNames(['$(evil)']).error, /isn't/);
  assert.match(mcp.checkNames(Array.from({ length: 11 }, (_, i) => `s${i}`)).error, /at most 10/);
});

test('a server is found the way Claude Code finds it: local, then project, then user', () => {
  const { home, cwd } = setup({
    global: dir => ({
      mcpServers: { linear: { type: 'http', url: 'https://user.example/mcp' }, both: { command: 'user-both' } },
      projects: { [dir]: { mcpServers: { both: { command: 'local-both' } }, enabledMcpjsonServers: ['shared'] } },
    }),
    shared: { shared: { command: 'npx', args: ['shared-server'] } },
  });
  assert.deepEqual(mcp.resolveServer('linear', { home, cwd }), { ok: true, scope: 'user', def: { type: 'http', url: 'https://user.example/mcp' } });
  assert.equal(mcp.resolveServer('both', { home, cwd }).def.command, 'local-both');
  assert.equal(mcp.resolveServer('shared', { home, cwd }).scope, 'project');
  assert.match(mcp.resolveServer('nope', { home, cwd }).error, /no MCP server called “nope”/);
  assert.match(mcp.resolveServer('plugin:github:github', { home, cwd }).error, /comes with a plugin/);
});

test('a project server is only used once it has been approved outside the repository', () => {
  const shared = { evil: { command: 'calc.exe' } };
  const blocked = setup({ shared });
  assert.match(mcp.resolveServer('evil', blocked).error, /hasn't been approved/);
  // The repository's own settings can't approve it: only ~/.claude.json and ~/.claude/settings.json count.
  fs.mkdirSync(path.join(blocked.cwd, '.claude'));
  fs.writeFileSync(path.join(blocked.cwd, '.claude', 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
  assert.equal(mcp.resolveServer('evil', blocked).ok, false);

  // "Allow every project server" isn't enough: Shellby would be starting it with no session around it.
  const allAllowed = setup({ shared, settings: { enableAllProjectMcpServers: true } });
  assert.match(mcp.resolveServer('evil', allAllowed).error, /approved by name/);
  const byName = setup({ shared, settings: { enabledMcpjsonServers: ['evil'] } });
  assert.equal(mcp.resolveServer('evil', byName).ok, true);
  // A refusal anywhere wins.
  const refused = setup({ shared, settings: { enabledMcpjsonServers: ['evil'] }, global: dir => ({ projects: { [dir]: { disabledMcpjsonServers: ['evil'] } } }) });
  assert.equal(mcp.resolveServer('evil', refused).ok, false);
});

test('a network share is never read for its servers', () => {
  const { home } = setup({ global: { mcpServers: { mine: { command: 'x' } } } });
  // Only the user's own servers come back: no .mcp.json is looked for on the share.
  assert.deepEqual(mcp.listServers({ home, cwd: '\\\\attacker\\share' }).map(s => s.name), ['mine']);
  assert.equal(mcp.resolveServer('mine', { home, cwd: '//attacker/share' }).scope, 'user');
});

test('configFor gathers definitions, or says which server can\'t be loaded alone', () => {
  const { home, cwd } = setup({ global: { mcpServers: { a: { command: 'a' }, b: { url: 'https://b' } } } });
  assert.deepEqual(mcp.configFor(['a', 'b'], { home, cwd }), { ok: true, config: { mcpServers: { a: { command: 'a' }, b: { url: 'https://b' } } } });
  const r = mcp.configFor(['a', 'plugin:x:y'], { home, cwd });
  assert.equal(r.ok, false);
  assert.match(r.error, /plugin/);
});

test('the server list merges the config files with the Toolbox\'s live list', () => {
  const { home, cwd } = setup({
    global: dir => ({ mcpServers: { linear: { type: 'http', url: 'https://x' } }, projects: { [dir]: { mcpServers: { db: { command: 'db' } } } } }),
    shared: { unapproved: { command: 'x' } },
  });
  const list = mcp.listServers({ home, cwd, live: [{ name: 'plugin:github:github' }, { name: 'linear' }, { name: 'shellby' }, { name: 'bad name' }] });
  assert.deepEqual(list, [
    { name: 'db', scope: 'local', transport: 'stdio', direct: true },
    { name: 'linear', scope: 'user', transport: 'http', direct: true },
    { name: 'plugin:github:github', scope: 'plugin', transport: null, direct: false },
    { name: 'unapproved', scope: 'project', transport: 'stdio', direct: false },
  ]);
  assert.deepEqual(mcp.listServers({ home: null, cwd: null }), []);
});

test('${VAR} and ${VAR:-default} are filled in like Claude Code does', () => {
  const env = { TOKEN: 'abc', EMPTY: '' };
  assert.deepEqual(mcp.expandEnv({ url: 'https://x/${TOKEN}', args: ['${MISSING:-fallback}', '${EMPTY:-d}', '${MISSING}'], n: 3 }, env),
    { url: 'https://x/abc', args: ['fallback', 'd', ''], n: 3 });
});
