const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitArgs, addArgs, removeArgs, parseGet } = require('../src/main/mcpadmin');

test('splitArgs: spaces separate, quotes group, Windows backslashes survive', () => {
  assert.deepEqual(splitArgs('npx -y @scope/server --root "C:\\My Files"'), ['npx', '-y', '@scope/server', '--root', 'C:\\My Files']);
  assert.deepEqual(splitArgs(`node 'a b' ""`), ['node', 'a b', '']);
  assert.equal(splitArgs('node "open'), null);
});

test('addArgs: a program, with its environment', () => {
  const r = addArgs({ name: 'github', transport: 'stdio', scope: 'user', target: 'npx -y @modelcontextprotocol/server-github', env: 'GITHUB_TOKEN=abc\n\nDEBUG=1' }, { platform: 'linux' });
  assert.deepEqual(r.args, ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', '-e', 'GITHUB_TOKEN=abc', '-e', 'DEBUG=1', '--', 'github', 'npx', '-y', '@modelcontextprotocol/server-github']);
  assert.deepEqual(r.summary.env, ['GITHUB_TOKEN', 'DEBUG'], 'the confirm window names variables, never their values');
});

test('addArgs: on Windows, npx and the other .cmd shims run through cmd /c, and the confirm window shows it', () => {
  const win = target => addArgs({ name: 'fs', transport: 'stdio', target }, { platform: 'win32' });
  const r = win('npx -y @modelcontextprotocol/server-filesystem "C:\\My Files"');
  assert.deepEqual(r.args.slice(r.args.indexOf('--')), ['--', 'fs', 'cmd', '/c', 'npx', '-y', '@modelcontextprotocol/server-filesystem', 'C:\\My Files']);
  assert.equal(r.summary.target, 'cmd /c npx -y @modelcontextprotocol/server-filesystem "C:\\My Files"');
  for (const shim of ['pnpm', 'yarn', 'bunx', 'pnpx', 'NPX.cmd', 'C:\\Program Files\\nodejs\\npx.cmd']) {
    assert.deepEqual(win(`"${shim}" dlx some-server`).args.slice(-6), ['fs', 'cmd', '/c', shim, 'dlx', 'some-server'], shim);
  }
  // Already wrapped, or a real program: as typed.
  assert.deepEqual(win('cmd /c npx -y x').args.slice(-6), ['fs', 'cmd', '/c', 'npx', '-y', 'x']);
  assert.deepEqual(win('node server.js').args.slice(-3), ['fs', 'node', 'server.js']);
  assert.deepEqual(win('uvx mcp-server-git').args.slice(-3), ['fs', 'uvx', 'mcp-server-git']);
  assert.equal(win('node server.js').summary.target, 'node server.js');
  // Not on other platforms.
  assert.deepEqual(addArgs({ name: 'fs', target: 'npx -y x' }, { platform: 'darwin' }).args.slice(-4), ['fs', 'npx', '-y', 'x']);
});

test('addArgs: a URL, with headers', () => {
  const r = addArgs({ name: 'sentry', transport: 'http', target: 'https://mcp.sentry.dev/mcp', headers: 'Authorization: Bearer x' });
  assert.deepEqual(r.args, ['mcp', 'add', '--scope', 'local', '--transport', 'http', '--header', 'Authorization: Bearer x', '--', 'sentry', 'https://mcp.sentry.dev/mcp']);
});

test('addArgs: refuses what would be a mistake or a trick', () => {
  assert.ok(addArgs({ name: '', target: 'x' }).error);
  assert.ok(addArgs({ name: '-s user', target: 'x' }).error, 'a name cannot smuggle in a flag');
  assert.ok(addArgs({ name: 'ok', target: '' }).error);
  assert.ok(addArgs({ name: 'ok', target: 'node "x' }).error);
  assert.ok(addArgs({ name: 'ok', target: 'node x\nrm' }).error);
  assert.ok(addArgs({ name: 'ok', transport: 'http', target: 'not a url' }).error);
  assert.ok(addArgs({ name: 'ok', transport: 'http', target: 'file:///c:/x' }).error);
  assert.ok(addArgs({ name: 'ok', transport: 'http', target: 'http://example.com/mcp' }).error, 'plain http only to this PC');
  assert.ok(!addArgs({ name: 'ok', transport: 'http', target: 'http://localhost:3000/mcp' }).error);
  assert.ok(addArgs({ name: 'ok', target: 'node x', env: 'not a pair' }).error);
  assert.ok(addArgs({ name: 'ok', target: 'node x', env: '1BAD=x' }).error);
  assert.ok(addArgs({ name: 'ok', transport: 'http', target: 'https://x.dev', headers: '--scope=user: v' }).error, 'a header name cannot be an option');
});

test('removeArgs: only from the three scopes', () => {
  assert.deepEqual(removeArgs('github', 'project').args, ['mcp', 'remove', '--scope', 'project', 'github']);
  assert.ok(removeArgs('github', null).error);
  assert.ok(removeArgs('--all', 'user').error);
});

test('parseGet: the scope, status and target from `claude mcp get`', () => {
  const r = parseGet(['context7:', '  Scope: User config (available in all your projects)', '  Status: ✔ Connected', '  Type: http', '  URL: https://mcp.context7.com/mcp', '', 'To remove this server, run: claude mcp remove context7 -s user'].join('\n'));
  assert.deepEqual(r, { scope: 'user', status: '✔ Connected', type: 'http', target: 'https://mcp.context7.com/mcp' });
  assert.equal(parseGet('No MCP server found').scope, null);
});

test('findServer: reads the scope from the config files, local before project before user', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { findServer } = require('../src/main/mcpadmin');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-mcp-'));
  try {
    const cwd = path.join(home, 'proj');
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: { web: { type: 'http', url: 'https://x.dev/mcp' }, both: { command: 'user-one' } },
      projects: { [cwd]: { mcpServers: { mine: { command: 'node', args: ['s.js'] } } } },
    }));
    fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { command: 'npx', args: ['srv'] }, both: { command: 'project-one' } } }));
    assert.deepEqual(findServer('mine', { home, cwd }), { scope: 'local', target: 'node s.js' });
    assert.deepEqual(findServer('shared', { home, cwd }), { scope: 'project', target: 'npx srv' });
    assert.deepEqual(findServer('both', { home, cwd }), { scope: 'project', target: 'project-one' });
    assert.deepEqual(findServer('web', { home, cwd }), { scope: 'user', target: 'https://x.dev/mcp' });
    assert.equal(findServer('nope', { home, cwd }), null);
    assert.equal(findServer('mine', { home, cwd: home }), null, 'another folder has no local servers');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
