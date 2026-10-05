const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const client = require('../src/main/mcpclient');

const FAKE = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');
const stdio = (mode = '', extra = {}) => ({ command: process.execPath, args: [FAKE], env: { FAKE_MCP_MODE: mode, FAKE_TOKEN: '${TOKEN_SRC:-none}' }, ...extra });
const env = { ...process.env, TOKEN_SRC: 'tok-123' };

test('a stdio server is started, called and shut down', async () => {
  const cwd = os.tmpdir();
  const r = await client.callTool(stdio(), 'create_issue', { title: 'Build broke' }, { cwd, env, timeoutMs: 20000 });
  assert.equal(r.text, 'made Build broke');
  assert.equal(r.isError, false);
  assert.equal(r.json.id, 'ISS-1');
  // ${VAR} in the server's env is filled in, and it starts in the step's folder.
  assert.equal(r.json.env, 'tok-123');
  assert.equal(path.resolve(r.json.cwd).toLowerCase(), path.resolve(cwd).toLowerCase());
});

test('tools are listed across pages', async () => {
  const tools = await client.listTools(stdio(), { env, timeoutMs: 20000 });
  assert.deepEqual(tools.map(t => t.name), ['create_issue', 'second']);
  assert.deepEqual(tools[0].inputSchema.required, ['title']);
});

test('a tool that reports a problem, and a server that refuses, are told apart', async () => {
  const failed = await client.callTool(stdio(), 'fails', {}, { env, timeoutMs: 20000 });
  assert.equal(failed.isError, true);
  assert.equal(failed.text, 'no such project');
  await assert.rejects(client.callTool(stdio(), 'unknown', {}, { env, timeoutMs: 20000 }), /The server said: Unknown tool/);
});

test('a server that crashes says why', async () => {
  await assert.rejects(client.callTool(stdio('crash'), 'create_issue', { title: 'x' }, { env, timeoutMs: 20000 }), /stopped \(exit code 3\):[\s\S]*boom: something broke/);
});

test('a server that never answers runs out of time, and a stop ends it at once', async () => {
  // Generous times: under a full parallel test run, starting node can take a while.
  await assert.rejects(client.callTool(stdio('hang'), 'create_issue', { title: 'x' }, { env, timeoutMs: 3000 }), /took longer than 3 seconds/);
  const ctl = new AbortController();
  const p = client.callTool(stdio('hang'), 'create_issue', { title: 'x' }, { env, timeoutMs: 60000, signal: ctl.signal });
  setTimeout(() => ctl.abort(), 1000);
  await assert.rejects(p, e => e.name === 'AbortError');
});

test('requests from the server get a polite no', async () => {
  const r = await client.callTool(stdio('ask'), 'create_issue', { title: 'x' }, { env, timeoutMs: 20000 });
  assert.equal(r.text, 'refused: -32601');
});

test('a missing command is reported plainly', async () => {
  await assert.rejects(client.callTool({ command: 'definitely-not-a-real-mcp-server' }, 't', {}, { env, timeoutMs: 5000 }), /Couldn't find “definitely-not-a-real-mcp-server”/);
  await assert.rejects(client.callTool({ type: 'sse', url: 'https://x' }, 't', {}, { env }), /older SSE/);
});

test('commands are found on PATH only, and a .cmd goes through cmd.exe quoted', () => {
  const files = new Set([path.join('C:\\tools', 'npx.cmd'), path.join('C:\\bin', 'uvx.exe')]);
  const exists = f => files.has(f);
  const e = { PATH: ['relative', 'C:\\tools', 'C:\\bin'].join(path.delimiter), PATHEXT: '.EXE;.CMD' };
  if (process.platform === 'win32') {
    assert.equal(client.findCommand('npx', e, exists), path.join('C:\\tools', 'npx.cmd'));
    assert.equal(client.findCommand('uvx', e, exists), path.join('C:\\bin', 'uvx.exe'));
    const plan = client.launchPlan({ command: 'npx', args: ['-y', 'a & b'] }, e, c => client.findCommand(c, e, exists));
    assert.match(plan.file, /cmd\.exe$/i);
    assert.equal(plan.verbatim, true);
    assert.equal(plan.args.at(-1), `""${path.join('C:\\tools', 'npx.cmd')}" "-y" "a & b""`);
  }
  // A path with a folder in it, but not a full one, is never looked up.
  assert.equal(client.findCommand('.\\npx', e, exists), null);
  assert.equal(client.findCommand('nothing', e, exists), null);
  if (process.platform === 'win32') {
    // A dot in the name isn't a program extension.
    const py = path.join('C:\\bin', 'python3.11.exe');
    assert.equal(client.findCommand('python3.11', e, f => f === py), py);
  }
});

test('an event stream the server keeps open is read only until the answer arrives', async () => {
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (init.method === 'DELETE' || !body.id) return new Response(null, { status: 202 });
    const answer = { jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: 'quick' }] } };
    // Sends the answer, then never ends the stream.
    const stream = new globalThis.ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(answer)}\n\n`)); } });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  };
  const started = Date.now();
  const r = await client.callTool({ url: 'https://x/mcp' }, 'go', {}, { env, fetchImpl, timeoutMs: 5000 });
  assert.equal(r.text, 'quick');
  assert.ok(Date.now() - started < 2000, 'it did not wait for the stream to end');
});

// ---------------------------------------------------------------- HTTP

function fakeHttp({ status = 200, sse = true } = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    seen.push({ url, method: init.method, headers: init.headers, body });
    if (status !== 200) return new Response('no', { status });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (!body.id) return new Response(null, { status: 202 });
    if (body.method === 'initialize') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-9' } });
    }
    const answer = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"done":true}' }] } };
    if (!sse) return new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } });
    const stream = `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: ${JSON.stringify(answer)}\n\n`;
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetchImpl, seen };
}

test('an HTTP server is called over streamable HTTP, session and all', async () => {
  const { fetchImpl, seen } = fakeHttp();
  const def = { type: 'http', url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer ${TOKEN_SRC}' } };
  const r = await client.callTool(def, 'go', { a: 1 }, { env, fetchImpl, timeoutMs: 5000 });
  assert.deepEqual(r.json, { done: true });
  const call = seen.find(s => s.body?.method === 'tools/call');
  assert.equal(call.headers.Authorization, 'Bearer tok-123');
  assert.equal(call.headers['Mcp-Session-Id'], 'sess-9');
  assert.equal(call.headers['MCP-Protocol-Version'], '2025-03-26');
  assert.deepEqual(call.body.params, { name: 'go', arguments: { a: 1 } });
  await new Promise(r2 => setTimeout(r2, 10));
  assert.ok(seen.some(s => s.method === 'DELETE' && s.headers['Mcp-Session-Id'] === 'sess-9'), 'the session is ended');
});

test('plain JSON answers work too, and a sign-in wall is explained', async () => {
  const plain = fakeHttp({ sse: false });
  assert.deepEqual((await client.callTool({ url: 'https://x/mcp' }, 'go', {}, { env, fetchImpl: plain.fetchImpl })).json, { done: true });
  const locked = fakeHttp({ status: 401 });
  await assert.rejects(client.callTool({ url: 'https://x/mcp' }, 'go', {}, { env, fetchImpl: locked.fetchImpl }), /needs you to sign in/);
});

test('tool results are read into text and data', () => {
  assert.deepEqual(client.readResult({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }] }), { text: 'a\nb', json: null, isError: false });
  assert.deepEqual(client.readResult({ content: [{ type: 'text', text: '[1,2]' }] }).json, [1, 2]);
  assert.deepEqual(client.readResult({ structuredContent: { n: 1 }, isError: true }), { text: '', json: { n: 1 }, isError: true });
  assert.deepEqual(client.sseMessages('data: {"a":1}\n\ndata: nope\n\n: comment\n\ndata: {"b":\ndata: 2}\n\n'), [{ a: 1 }, { b: 2 }]);
});
