// A tiny stdio MCP server for test/mcpclient.test.js. Newline-delimited
// JSON-RPC on stdin/stdout. FAKE_MCP_MODE picks a misbehaviour:
//   crash  - exits as soon as it's initialized
//   hang   - never answers tools/call
//   ask    - asks the client for roots before answering (Shellby says no)
const readline = require('readline');

const mode = process.env.FAKE_MCP_MODE || '';
const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`);
let pendingCall = null;

process.stderr.write('fake server starting\n');
// A stray log line on stdout must not break the client.
process.stdout.write('not json, just noise\n');

readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
    return;
  }
  if (msg.method === 'notifications/initialized') {
    if (mode === 'crash') { process.stderr.write('boom: something broke\n'); process.exit(3); }
    return;
  }
  if (msg.method === 'tools/list') {
    const page = msg.params?.cursor === 'p2'
      ? { tools: [{ name: 'second', description: 'On page two', inputSchema: { type: 'object' } }] }
      : { tools: [{ name: 'create_issue', description: 'Files an issue', inputSchema: { type: 'object', properties: { title: { type: 'string' }, labels: { type: 'array' } }, required: ['title'] } }], nextCursor: 'p2' };
    send({ jsonrpc: '2.0', id: msg.id, result: page });
    return;
  }
  if (msg.id !== undefined && pendingCall && msg.id === 'roots-1') {
    // The client's answer to our roots request.
    const call = pendingCall;
    pendingCall = null;
    send({ jsonrpc: '2.0', id: call.id, result: { content: [{ type: 'text', text: `refused: ${msg.error?.code}` }] } });
    return;
  }
  if (msg.method === 'tools/call') {
    if (mode === 'hang') return;
    if (mode === 'ask') { pendingCall = msg; send({ jsonrpc: '2.0', id: 'roots-1', method: 'roots/list' }); return; }
    const { name, arguments: args } = msg.params;
    if (name === 'fails') { send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'no such project' }] } }); return; }
    if (name === 'unknown') { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool: unknown' } }); return; }
    send({ jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text: `made ${args.title}` }],
      structuredContent: { id: 'ISS-1', title: args.title, env: process.env.FAKE_TOKEN || null, cwd: process.cwd() },
    } });
  }
});
