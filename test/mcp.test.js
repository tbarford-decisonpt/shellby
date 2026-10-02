// Shellby as an MCP server. The protocol half is tested by running the real
// server as a child process and talking JSON-RPC to it over stdio, because that
// is exactly how Claude Code will use it: a handshake that answers the wrong
// shape, or a stray line on stdout, breaks the connection with no clue why.
//
// The app half (src/main/crabtools.js) is pure and tested directly. A test at
// the bottom pins the two together, since the tool list lives in the plugin
// (which ships separately) and the actions live in the app.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  parseRequest, matchItem, wearReply, statusReply, ackReply, ACTIONS, MAX_TEXT,
} = require('../src/main/crabtools');

const SERVER = path.join(__dirname, '..', 'claude-plugin', 'mcp', 'server.js');
const GB = 1024 ** 3;

// ------------------------------------------------------------------ the protocol

/**
 * Drive the real server over stdio. Sends each message, collects the replies,
 * and returns them in order. The port is set to one nothing listens on, and the
 * marker file is absent, so tool calls take the "Shellby is not running" path
 * without ever touching the network.
 */
function talk(messages, { timeoutMs = 10000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SHELLBY_PORT: '1', TEMP: path.join(__dirname, 'no-shellby-here'), TMPDIR: path.join(__dirname, 'no-shellby-here'), ...env },
    });
    const replies = [];
    let out = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`the server went quiet; got ${replies.length} replies, stderr: ${stderr}`)); }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      out += chunk;
      let cut;
      while ((cut = out.indexOf('\n')) !== -1) {
        const line = out.slice(0, cut).trim();
        out = out.slice(cut + 1);
        if (!line) continue;
        try { replies.push(JSON.parse(line)); } catch { reject(new Error(`not JSON on stdout: ${line.slice(0, 200)}`)); return; }
      }
    });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', () => { clearTimeout(timer); resolve({ replies, stderr }); });

    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
    child.stdin.end();   // closing stdin is how Claude Code stops it
  });
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };

test('the handshake answers with a protocol version, tools capability and a name', async () => {
  const { replies } = await talk([INIT]);
  assert.equal(replies.length, 1);
  const r = replies[0].result;
  assert.equal(replies[0].jsonrpc, '2.0');
  assert.equal(replies[0].id, 1);
  assert.equal(r.protocolVersion, '2025-06-18', 'echoes the version the client asked for');
  assert.deepEqual(r.capabilities, { tools: {} });
  assert.equal(r.serverInfo.name, 'shellby');
  assert.ok(r.instructions.length > 20, 'tells the model what the crab is for');
});

test('an unknown protocol version gets ours, rather than an error', async () => {
  const { replies } = await talk([{ ...INIT, params: { protocolVersion: '1999-01-01' } }]);
  assert.equal(replies[0].result.protocolVersion, '2025-06-18');
});

test('tools/list describes every tool with a schema', async () => {
  const { replies } = await talk([INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  const tools = replies[1].result.tools;
  assert.deepEqual(tools.map(t => t.name).sort(), ['celebrate', 'say', 'status', 'wear']);
  for (const t of tools) {
    assert.ok(t.description.length > 40, `${t.name} explains itself`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} refuses stray arguments`);
  }
  const say = tools.find(t => t.name === 'say');
  assert.deepEqual(say.inputSchema.required, ['text']);
  assert.equal(say.inputSchema.properties.text.maxLength, MAX_TEXT);
});

test('a tool call with no Shellby running comes back as a tool error, not a crash', async () => {
  const { replies, stderr } = await talk([INIT,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'say', arguments: { text: 'all green' } } }]);
  const r = replies[1].result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Shellby is not running/);
  assert.equal(stderr, '', 'nothing is written to stderr on the normal path');
});

test('a bad tool call is refused before it reaches the app', async () => {
  const { replies } = await talk([INIT,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'say', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wear', arguments: { item: '  ' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } }]);
  assert.match(replies[1].result.content[0].text, /needs some text/);
  assert.match(replies[2].result.content[0].text, /needs the name of an accessory/);
  assert.match(replies[3].result.content[0].text, /Unknown tool: nope/);
  for (const r of replies.slice(1)) assert.equal(r.result.isError, true);
});

test('ping, notifications and unknown methods behave', async () => {
  const { replies } = await talk([INIT,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
    { jsonrpc: '2.0', id: 3, method: 'resources/list' }]);
  assert.equal(replies.length, 3, 'the notification is not answered');
  assert.deepEqual(replies[1], { jsonrpc: '2.0', id: 2, result: {} });
  assert.equal(replies[2].error.code, -32601);
});

test('a malformed line gets -32700 and does not stop the server', async () => {
  // Written by hand, because JSON.stringify can't produce invalid JSON, and a
  // broken line between two good ones must not take the rest of the stream down.
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SHELLBY_PORT: '1' },
  });
  const lines = [];
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', c => {
    out += c;
    let cut;
    while ((cut = out.indexOf('\n')) !== -1) {
      const l = out.slice(0, cut).trim();
      out = out.slice(cut + 1);
      if (l) lines.push(JSON.parse(l));
    }
  });
  child.stdin.write('{ this is not json }\n');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`);
  child.stdin.end();
  await new Promise(r => child.on('close', r));
  assert.equal(lines[0].error.code, -32700);
  assert.deepEqual(lines[1], { jsonrpc: '2.0', id: 7, result: {} });
});

test('several messages in one chunk are all handled', async () => {
  // talk() writes them separately, which may still coalesce; this asserts the
  // buffering works either way.
  const { replies } = await talk([INIT,
    { jsonrpc: '2.0', id: 2, method: 'ping' },
    { jsonrpc: '2.0', id: 3, method: 'ping' },
    { jsonrpc: '2.0', id: 4, method: 'tools/list' }]);
  assert.deepEqual(replies.map(r => r.id), [1, 2, 3, 4]);
});

// ------------------------------------------------------------------ the app side

test('parseRequest accepts the four actions and normalises them', () => {
  assert.deepEqual(parseRequest({ action: 'say', args: { text: 'hello' } }),
    { ok: true, intent: { action: 'say', text: 'hello', mood: 'happy' } });
  assert.equal(parseRequest({ action: 'say', args: { text: 'x', mood: 'proud' } }).intent.mood, 'proud');
  assert.equal(parseRequest({ action: 'say', args: { text: 'x', mood: 'evil' } }).intent.mood, 'happy');
  assert.deepEqual(parseRequest({ action: 'status' }), { ok: true, intent: { action: 'status' } });
  assert.deepEqual(parseRequest({ action: 'celebrate' }), { ok: true, intent: { action: 'celebrate', reason: '' } });
});

test('parseRequest flattens and caps the text that reaches the bubble', () => {
  const nasty = parseRequest({ action: 'say', args: { text: `line one\nline two\u0000\u007f   spaced   ${'x'.repeat(300)}` } });
  assert.equal(nasty.intent.text.length, MAX_TEXT);
  assert.ok(!/[\n\u0000\u007f]/.test(nasty.intent.text), 'no newlines or control characters');
  assert.match(nasty.intent.text, /^line one line two spaced x+$/);
});

test('parseRequest refuses anything it does not recognise', () => {
  for (const body of [null, 'string', [], 42, {}, { action: 'exec' }, { action: 'say' }, { action: 'say', args: { text: '   ' } }]) {
    const r = parseRequest(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.ok(r.error.length > 4);
  }
  // Notably: there is no action that can start a Claude Code task.
  assert.equal(parseRequest({ action: 'task', args: { prompt: 'rm -rf' } }).ok, false);
  assert.ok(!ACTIONS.includes('task'));
});

// ------------------------------------------------------------------ wear

const ITEMS = [
  { id: 'hat-party', name: 'Party Hat', slot: 'hat', owned: true },
  { id: 'hat-hard', name: 'Hard Hat', slot: 'hat', owned: true },
  { id: 'hat-wizard', name: 'Wizard Hat', slot: 'hat', owned: false },
  { id: 'face-shades', name: 'Sunglasses', slot: 'face', owned: true },
  { id: 'neck-scarf', name: 'Striped Scarf', slot: 'neck', owned: true },
];

test('matchItem finds an item by id, exact name or words', () => {
  assert.equal(matchItem('hat-party', ITEMS).item.id, 'hat-party');
  assert.equal(matchItem('Party Hat', ITEMS).item.id, 'hat-party');
  assert.equal(matchItem('party hat', ITEMS).item.id, 'hat-party');
  assert.equal(matchItem('  PARTY   HAT  ', ITEMS).item.id, 'hat-party');
  assert.equal(matchItem('scarf', ITEMS).item.id, 'neck-scarf');
  assert.equal(matchItem('shades', ITEMS).suggestions.length, 0, 'not a word in any name');
});

test('matchItem picks the plainest option when several match', () => {
  // "hat" matches both owned hats; the shorter name is the less surprising one.
  assert.equal(matchItem('hat', ITEMS).item.name, 'Hard Hat');
});

test('matchItem says when the item exists but is locked', () => {
  const m = matchItem('wizard hat', ITEMS);
  assert.equal(m.item, undefined);
  assert.equal(m.locked, 'Wizard Hat');
  assert.match(wearReply(m, 'wizard hat'), /has not unlocked the Wizard Hat/);
});

test('matchItem suggests what he does have', () => {
  const m = matchItem('cowboy hat', ITEMS);
  assert.deepEqual(m.suggestions, ['Hard Hat', 'Party Hat']);
  assert.match(wearReply(m, 'cowboy hat'), /No "cowboy hat" in his wardrobe\. He does have: Hard Hat, Party Hat\./);
});

test('matchItem survives an empty or junk wardrobe', () => {
  assert.deepEqual(matchItem('hat', []).suggestions, []);
  assert.deepEqual(matchItem('hat', null).suggestions, []);
  assert.deepEqual(matchItem('', ITEMS).suggestions, []);
  assert.equal(matchItem('hat', [null, { id: 'x' }]).suggestions.length, 0);
});

// ------------------------------------------------------------------ replies

test('statusReply covers the crab and the machine in a short paragraph', () => {
  const text = statusReply({
    level: 7, title: 'Claw Coder', xp: 1420, state: 'working', busy: 2,
    sample: {
      cpu: { temp: 61, load: 35 },
      gpus: [{ temp: 84, load: 97 }],
      ram: { pct: 72 },
      disks: [{ id: 'C:', free: 12 * GB }, { id: 'S:', free: 900 * GB }],
    },
    mood: { mood: 'hot', text: '84°' },
  });
  assert.match(text, /Level 7 Claw Coder, 1420 XP/);
  assert.match(text, /2 tasks running/);
  assert.match(text, /CPU 61°C/);
  assert.match(text, /GPU 84°C at 97%/);
  assert.match(text, /memory 72% used/);
  assert.match(text, /C: 12 GB free/);
  assert.ok(!text.includes('S:'), 'a roomy drive is not worth mentioning');
  assert.match(text, /sweating, something is running hot \(84°\)/);
  assert.ok(text.length < 400, 'short: this goes into a model context every call');
});

test('statusReply with Health off says so instead of inventing readings', () => {
  const text = statusReply({ level: 1, title: 'Hatchling', xp: 0, state: 'idle', busy: 0 });
  assert.match(text, /Level 1 Hatchling, 0 XP/);
  assert.match(text, /idle/);
  assert.match(text, /Health monitoring is off/);
});

test('statusReply mentions a usage-limit nap and a focus session', () => {
  const resetsAt = new Date('2026-10-02T15:30:00').getTime();
  assert.match(statusReply({ busy: 0, limit: { resetsAt } }), /napping until the usage limit resets at 15:30/);
  assert.match(statusReply({ busy: 0, focus: { phase: 'focus' } }), /guarding the user's focus/);
  assert.match(statusReply({ state: 'asking', busy: 0 }), /waiting on a permission prompt/);
});

test('statusReply survives an empty view', () => {
  assert.equal(typeof statusReply(), 'string');
  assert.equal(typeof statusReply({}), 'string');
});

test('ackReply reads back what happened', () => {
  assert.equal(ackReply({ action: 'say' }), 'Shellby said it.');
  assert.equal(ackReply({ action: 'celebrate', reason: '0.19.0 is out' }), 'Shellby is celebrating: 0.19.0 is out');
  assert.equal(ackReply({ action: 'celebrate', reason: '' }), 'Shellby is celebrating.');
});

// ------------------------------------------------------------------ the two sides

test('the plugin\'s tools and the app\'s actions are the same set', () => {
  // The MCP server ships inside the plugin and the actions live in the app, so
  // nothing but this test stops them drifting apart.
  const { TOOLS, toAction, MOODS: serverMoods, MAX_TEXT: serverMax } = require(SERVER);
  assert.deepEqual(TOOLS.map(t => t.name).sort(), [...ACTIONS].sort());
  assert.deepEqual(serverMoods, require('../src/main/crabtools').MOODS);
  assert.equal(serverMax, MAX_TEXT);
  // Every tool the server offers must survive the app's own validation.
  for (const t of TOOLS) {
    const sample = { say: { text: 'hi' }, celebrate: {}, wear: { item: 'Party Hat' }, status: {} }[t.name];
    const { action, args, error } = toAction(t.name, sample);
    assert.equal(error, undefined, `${t.name}: ${error}`);
    const checked = parseRequest({ action, args });
    assert.equal(checked.ok, true, `the app refused the server's own ${t.name} call`);
  }
});

test('the plugin declares the MCP server so Claude Code starts it', () => {
  const root = path.join(__dirname, '..', 'claude-plugin');
  const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['shellby']);
  assert.equal(mcp.mcpServers.shellby.command, 'node');
  assert.match(mcp.mcpServers.shellby.args[0], /\$\{CLAUDE_PLUGIN_ROOT\}\/mcp\/server\.js$/);
  const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(plugin.mcpServers, './.mcp.json');
  // The file the manifest points at has to be the one that exists.
  assert.ok(fs.existsSync(path.join(root, 'mcp', 'server.js')));
});
