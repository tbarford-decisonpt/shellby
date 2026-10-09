const { test } = require('node:test');
const assert = require('node:assert/strict');
const crabmcp = require('../src/main/crabmcp');

const tools = crabmcp.toolsFor();
const calls = [];
const call = async (name, args) => { calls.push([name, args]); return name === 'status' ? { text: 'Shellby: idle.' } : { text: 'nope', isError: true }; };
const ask = message => crabmcp.handle(message, { tools, call });

test('answers the handshake with the client\'s protocol version', async () => {
  const r = await ask({ method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} }, jsonrpc: '2.0', id: 0 });
  assert.deepEqual(r, { jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'shellby', version: '1.0.0' } } });
});

test('notifications get the empty result Claude Code expects', async () => {
  assert.deepEqual(await ask({ jsonrpc: '2.0', method: 'notifications/initialized' }), { jsonrpc: '2.0', id: 0, result: {} });
});

test('lists the crab\'s tools, with suggest only when suggestions are on', async () => {
  const r = await ask({ method: 'tools/list', jsonrpc: '2.0', id: 1 });
  assert.deepEqual(r.result.tools.map(t => t.name), ['say', 'celebrate', 'wear', 'status', 'note', 'suggest']);
  assert.deepEqual(crabmcp.toolsFor({ suggestions: false }).map(t => t.name), ['say', 'celebrate', 'wear', 'status', 'note']);
  for (const t of r.result.tools) assert.equal(t.inputSchema.additionalProperties, false, t.name);
});

test('tool calls go to the callback and come back as MCP content', async () => {
  const ok = await ask({ method: 'tools/call', params: { name: 'status', arguments: {} }, jsonrpc: '2.0', id: 5 });
  assert.deepEqual(ok, { jsonrpc: '2.0', id: 5, result: { content: [{ type: 'text', text: 'Shellby: idle.' }] } });
  const bad = await ask({ method: 'tools/call', params: { name: 'wear', arguments: { item: 'crown' } }, jsonrpc: '2.0', id: 6 });
  assert.equal(bad.result.isError, true);
  assert.deepEqual(calls.at(-1), ['wear', { item: 'crown' }]);
});

test('unlisted tools never reach the callback', async () => {
  const before = calls.length;
  const r = await ask({ method: 'tools/call', params: { name: 'run_task', arguments: {} }, jsonrpc: '2.0', id: 7 });
  assert.equal(r.result.isError, true);
  assert.equal(calls.length, before);
  const off = await crabmcp.handle({ method: 'tools/call', params: { name: 'suggest', arguments: {} }, id: 8 }, { tools: crabmcp.toolsFor({ suggestions: false }), call });
  assert.equal(off.result.isError, true);
  assert.equal(calls.length, before);
});

test('a callback that throws is a tool error, not a crash', async () => {
  const r = await crabmcp.handle({ method: 'tools/call', params: { name: 'say', arguments: { text: 'hi' } }, id: 9 }, { tools, call: async () => { throw new Error('boom'); } });
  assert.deepEqual(r.result, { content: [{ type: 'text', text: "Shellby couldn't do that: boom" }], isError: true });
});

test('unknown methods are a JSON-RPC error', async () => {
  const r = await ask({ method: 'resources/list', id: 10 });
  assert.equal(r.error.code, -32601);
});

test('the config names one in-app server', () => {
  assert.deepEqual(crabmcp.servers(), { shellby: { type: 'sdk', name: 'shellby' } });
});
